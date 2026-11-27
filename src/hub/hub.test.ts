import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAgent } from "./config.js";
import { findAgentAvatars, Hub, ROLL_CALL_PROMPT } from "./hub.js";
import { Store } from "./store.js";
import type { Task } from "./types.js";

/** A hub with one CLI agent that appends to a log file each time its command actually runs. */
function setup(limits = { dailyRequests: 0, dailyTokens: 0, monthlyBudgetUsd: 0 }) {
  const dir = mkdtempSync(join(tmpdir(), "relay-hub-test-"));
  const log = join(dir, "runs.log");
  const agent = normalizeAgent(
    {
      id: "slow",
      name: "Slow",
      model: "m",
      maxConcurrent: 1,
      limits,
      connectors: [
        { kind: "cli", label: "sh", billing: "local", command: "sh", args: ["-c", `cat >/dev/null; echo run >> "${log}"; sleep 0.4; echo done`] },
      ],
    },
    0,
  );
  const hub = new Hub({ lead: "slow", agents: [agent] }, new Store(join(dir, "state.json")));
  const runs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0);
  const task = (id: string) => hub.store.state.tasks.find((t) => t.id === id) as Task;
  const settle = async (ids: string[]) => {
    for (let i = 0; i < 100 && ids.some((id) => ["queued", "running"].includes(task(id).status)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { hub, runs, task, settle };
}

const web = { channel: "web" as const, chatId: "web" };

describe("Hub task queue", () => {
  it("a task cancelled while waiting for a slot never runs", async () => {
    const { hub, runs, task, settle } = setup();
    const first = await hub.handleText("@slow one", web);
    const second = await hub.handleText("@slow two", web);
    await new Promise((r) => setTimeout(r, 100));
    expect(task(second.taskId!).status).toBe("queued");
    expect(hub.cancel(second.taskId!)).toBe(true);
    await settle([first.taskId!, second.taskId!]);
    expect(task(first.taskId!).status).toBe("done");
    expect(task(second.taskId!).status).toBe("cancelled");
    expect(runs()).toBe(1);
  });

  it("re-checks limits after waiting, so a queue can't overshoot a daily cap", async () => {
    // Cap of 2: all three are accepted while only one has run, but the third must not run.
    const { hub, runs, task, settle } = setup({ dailyRequests: 2, dailyTokens: 0, monthlyBudgetUsd: 0 });
    const ids = [];
    for (const t of ["one", "two", "three"]) ids.push((await hub.handleText(`@slow ${t}`, web)).taskId!);
    expect(ids.every(Boolean)).toBe(true);
    await settle(ids);
    expect(ids.map((id) => task(id).status)).toEqual(["done", "done", "blocked"]);
    expect(task(ids[2]).error).toMatch(/daily request limit .* while this was waiting/);
    expect(runs()).toBe(2);
  });

  it("counts running requests toward the cap before a new one is accepted", async () => {
    const { hub, settle, task } = setup({ dailyRequests: 1, dailyTokens: 0, monthlyBudgetUsd: 0 });
    const first = await hub.handleText("@slow one", web);
    await new Promise((r) => setTimeout(r, 150)); // first is now running
    const second = await hub.handleText("@slow two", web);
    expect(second.taskId).toBeUndefined();
    expect(second.reply).toMatch(/daily request limit/);
    await settle([first.taskId!]);
  });
});

describe("Hub team delegation", () => {
  it("fails over a broken text-only subtask to a healthy teammate and skips synthesis for a single-step goal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-team-test-"));
    const lead = normalizeAgent(
      {
        id: "lead",
        name: "Lead",
        model: "m",
        actsInWorld: true,
        skills: ["plan"],
        connectors: [
          {
            kind: "cli",
            label: "sh",
            billing: "local",
            command: "sh",
            args: ["-c", `cat >/dev/null; printf '[{"step":1,"agent":"flaky","task":"review the copy"}]'`],
          },
        ],
      },
      0,
    );
    const flaky = normalizeAgent(
      {
        id: "flaky",
        name: "Flaky",
        model: "m",
        skills: ["review"],
        connectors: [{ kind: "cli", label: "sh", billing: "local", command: "sh", args: ["-c", "echo rate-limited >&2; exit 1"] }],
      },
      1,
    );
    const backup = normalizeAgent(
      {
        id: "backup",
        name: "Backup",
        model: "m",
        skills: ["review"],
        connectors: [{ kind: "cli", label: "sh", billing: "local", command: "sh", args: ["-c", "cat >/dev/null; echo rescued-by-backup"] }],
      },
      2,
    );
    const hub = new Hub({ lead: "lead", agents: [lead, flaky, backup] }, new Store(join(dir, "state.json")));
    const batons: { from: string; to: string; kind: string }[] = [];
    hub.bus.on("event", (e: { type: string; data: { from: string; to: string; kind: string } }) => {
      if (e.type === "baton") batons.push(e.data);
    });
    const res = await hub.handleText("@team review the copy", web);
    for (let i = 0; i < 100; i++) {
      const g = hub.store.state.tasks.find((t) => t.id === res.taskId);
      if (g && !["queued", "running"].includes(g.status)) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    const goal = hub.store.state.tasks.find((t) => t.id === res.taskId)!;
    const kids = hub.store.state.tasks.filter((t) => t.parentId === goal.id);
    expect(goal.status).toBe("done");
    expect(goal.result).toBe("rescued-by-backup");
    expect(kids.find((k) => k.kind === "subtask")).toMatchObject({ agentId: "backup", reroutedFrom: "flaky", status: "done" });
    expect(kids.some((k) => k.kind === "synthesis")).toBe(false);
    expect(batons.some((b) => b.from === "flaky" && b.to === "backup" && b.kind === "reroute")).toBe(true);
  });

  it("prefers an independent reviewer over the upstream draft author when a review step fails over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-indep-test-"));
    const lead = normalizeAgent(
      {
        id: "lead",
        name: "Lead",
        model: "m",
        actsInWorld: true,
        skills: ["plan"],
        connectors: [
          {
            kind: "cli",
            label: "sh",
            billing: "local",
            command: "sh",
            args: [
              "-c",
              `cat >/dev/null; printf '[{"step":1,"agent":"writer","task":"write taglines"},{"step":2,"agent":"flaky","task":"review the taglines","after":[1]}]'`,
            ],
          },
        ],
      },
      0,
    );
    const writer = normalizeAgent(
      {
        id: "writer",
        name: "Writer",
        model: "m",
        skills: ["tagline", "taglines", "write"],
        connectors: [{ kind: "cli", label: "sh", billing: "local", command: "sh", args: ["-c", "cat >/dev/null; echo draft-taglines"] }],
      },
      1,
    );
    const flaky = normalizeAgent(
      {
        id: "flaky",
        name: "Flaky",
        model: "m",
        skills: ["review"],
        connectors: [{ kind: "cli", label: "sh", billing: "local", command: "sh", args: ["-c", "echo disabled >&2; exit 1"] }],
      },
      2,
    );
    const reviewer = normalizeAgent(
      {
        id: "reviewer",
        name: "Reviewer",
        model: "m",
        skills: ["code"],
        connectors: [{ kind: "cli", label: "sh", billing: "local", command: "sh", args: ["-c", "cat >/dev/null; echo independent-review"] }],
      },
      3,
    );
    const hub = new Hub({ lead: "lead", agents: [lead, writer, flaky, reviewer] }, new Store(join(dir, "state.json")));
    const res = await hub.handleText("@team write and review taglines", web);
    for (let i = 0; i < 100; i++) {
      const g = hub.store.state.tasks.find((t) => t.id === res.taskId);
      if (g && !["queued", "running"].includes(g.status)) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    const kids = hub.store.state.tasks.filter((t) => t.parentId === res.taskId);
    expect(kids.find((k) => k.step === 2)).toMatchObject({ agentId: "reviewer", reroutedFrom: "flaky", status: "done" });
  });
});

describe("findAgentAvatars", () => {
  it("finds optional idle and working avatar files preferring animated formats", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-avatar-test-"));
    mkdirSync(join(dir, "avatars"), { recursive: true });
    writeFileSync(join(dir, "avatars", "grok-idle.png"), "x");
    writeFileSync(join(dir, "avatars", "grok-working.gif"), "x");
    writeFileSync(join(dir, "avatars", "grok-working.png"), "x");
    expect(findAgentAvatars("grok", dir)).toEqual({ idle: "/avatars/grok-idle.png", working: "/avatars/grok-working.gif" });
    expect(findAgentAvatars("missing", dir)).toEqual({ idle: undefined, working: undefined });
  });
});

describe("Hub security boundaries & server hardening", () => {
  it("keeps untrusted email context away from actsInWorld agents and isolates Telegram chatIds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-ctx-test-"));
    const echo = { kind: "cli" as const, label: "sh", billing: "local" as const, command: "sh", args: ["-c", "cat"] };
    const world = normalizeAgent({ id: "hermes", name: "Hermes", model: "m", actsInWorld: true, connectors: [echo] }, 0);
    const reader = normalizeAgent({ id: "muse", name: "Muse", model: "m", actsInWorld: false, connectors: [echo] }, 1);
    const hub = new Hub({ lead: "hermes", agents: [world, reader] }, new Store(join(dir, "state.json")));

    // Seed an untrusted email summary task and a separate Telegram chat task
    const now = new Date().toISOString();
    hub.store.state.tasks.push(
      {
        id: "mail1",
        kind: "direct",
        agentId: "muse",
        title: "Inbox summary",
        prompt: "summarize",
        result: "SECRET_EMAIL_INJECTION_RUN_RM",
        status: "done",
        channel: "web",
        replyTo: { channel: "web", chatId: "web" },
        routing: "explicit",
        untrustedData: true,
        createdAt: now,
        finishedAt: now,
      },
      {
        id: "tg-other",
        kind: "direct",
        agentId: "muse",
        title: "Other chat",
        prompt: "other",
        result: "OTHER_CHAT_PRIVATE_DATA",
        status: "done",
        channel: "telegram",
        replyTo: { channel: "telegram", chatId: "chat-2" },
        routing: "explicit",
        createdAt: now,
        finishedAt: now,
      },
    );

    const worldTask = hub.submitDirect("hermes", "expand on that", web, "explicit");
    const readerTask = hub.submitDirect("muse", "expand on that", web, "explicit");
    const tgTask = hub.submitDirect("muse", "expand on that", { channel: "telegram", chatId: "chat-1" }, "explicit");
    for (let i = 0; i < 80; i++) {
      if ([worldTask, readerTask, tgTask].every((t) => !["queued", "running"].includes(t.status))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(worldTask.result).not.toContain("SECRET_EMAIL_INJECTION_RUN_RM");
    expect(readerTask.result).toContain("SECRET_EMAIL_INJECTION_RUN_RM");
    expect(tgTask.result).not.toContain("OTHER_CHAT_PRIVATE_DATA");
  });

  it("validates agent model IDs and server rejects approve=true on questions", async () => {
    const { createHubServer } = await import("./server.js");
    const { hub } = setup();
    expect(() => hub.updateAgent("slow", { model: "bad model with spaces!" })).toThrow(/Invalid model ID/);
    expect(() => hub.updateAgent("slow", { reasoning: "ultra" as never })).toThrow(/auto, off, low, medium, high or max/);

    const server = createHubServer({ hub, token: "" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const { approval } = hub.approvals.ask({
        taskId: "t1",
        agentId: "slow",
        agentName: "Slow",
        source: "agent",
        title: "Q",
        detail: "Which one?",
      });
      const res = await fetch(`${base}/api/approvals/${approval.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approve: true }),
      });
      expect(res.status).toBe(400);
      expect(approval.status).toBe("pending");
      hub.approvals.cancelAll();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("Hub roll call", () => {
  it("asks every ready assistant directly instead of planning a goal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-rollcall-test-"));
    const mk = (id: string, i: number, extra = {}) =>
      normalizeAgent(
        { id, name: id[0].toUpperCase() + id.slice(1), model: "m", connectors: [{ kind: "cli", label: "sh", billing: "local", command: "sh", args: ["-c", `cat >/dev/null; echo hi-from-${id}`] }], ...extra },
        i,
      );
    const agents = [mk("lead", 0, { actsInWorld: true }), mk("alpha", 1), mk("beta", 2), mk("off", 3, { enabled: false })];
    const hub = new Hub({ lead: "lead", agents }, new Store(join(dir, "state.json")));
    const res = await hub.handleText("make sure all bots are responsive, say hello", { channel: "web", chatId: "web" });
    expect(res.reply).toMatch(/Roll call: Lead, Alpha, Beta/);
    const tasks = hub.store.state.tasks;
    expect(tasks.some((t) => t.kind === "goal" || t.kind === "plan")).toBe(false);
    expect(tasks.map((t) => t.agentId).sort()).toEqual(["alpha", "beta", "lead"]);
    for (let i = 0; i < 100 && tasks.some((t) => ["queued", "running"].includes(t.status)); i++) await new Promise((r) => setTimeout(r, 30));
    expect(tasks.every((t) => t.status === "done" && t.prompt === ROLL_CALL_PROMPT)).toBe(true);
    expect(hub.approvals.pending()).toHaveLength(0);
    expect(tasks.find((t) => t.agentId === "alpha")?.result).toBe("hi-from-alpha");
  });
});

/** A crew of local "sh" agents: each prints what it was asked plus a tag, after an optional delay. */
function crew(specs: { id: string; out?: string; delay?: number; acts?: boolean }[], lead = specs[0].id) {
  const dir = mkdtempSync(join(tmpdir(), "relay-crew-test-"));
  const agents = specs.map((s, i) =>
    normalizeAgent(
      {
        id: s.id,
        name: s.id[0].toUpperCase() + s.id.slice(1),
        model: "m",
        tagline: `${s.id} work`,
        skills: [s.id],
        maxConcurrent: 2,
        ...(s.acts ? { actsInWorld: true } : {}),
        connectors: [
          {
            kind: "cli",
            label: "sh",
            billing: "local",
            command: "sh",
            args: ["-c", s.out ?? `sleep ${s.delay ?? 0}; printf 'from-${s.id}: '; head -c 400`],
          },
        ],
      },
      i,
    ),
  );
  const hub = new Hub({ lead, agents }, new Store(join(dir, "state.json")));
  const tasks = () => hub.store.state.tasks;
  const byId = (id: string) => tasks().find((t) => t.id === id) as Task;
  const settle = async (id: string) => {
    for (let i = 0; i < 200 && ["queued", "running"].includes(byId(id).status); i++) await new Promise((r) => setTimeout(r, 25));
  };
  return { hub, tasks, byId, settle };
}

const PLAN_JSON = `[{"step":1,"agent":"alpha","task":"Find the facts","why":"alpha digs"},{"step":2,"agent":"beta","task":"Write it up","after":[1]}]`;

describe("Plan review before launch", () => {
  it("drafts a plan with reasons and waves without running any step", async () => {
    const { hub, tasks } = crew([{ id: "lead", out: `cat >/dev/null; printf '%s' '${PLAN_JSON}'` }, { id: "alpha" }, { id: "beta" }]);
    const draft = await hub.draftPlan("research the market and then write a launch post");
    expect(draft.source).toBe("planner");
    expect(draft.steps.map((s) => [s.agentId, s.wave, s.after])).toEqual([
      ["alpha", 0, []],
      ["beta", 1, [0]],
    ]);
    expect(draft.steps[0].why).toBe("alpha digs");
    expect(draft.steps[1].why).toMatch(/beta work/);
    expect(tasks().some((t) => t.kind === "goal" || t.kind === "subtask")).toBe(false);
  });

  it("launches exactly the plan the owner edited", async () => {
    const { hub, tasks, byId, settle } = crew([{ id: "lead", out: "cat >/dev/null; echo should-not-plan" }, { id: "alpha" }, { id: "beta" }, { id: "gamma" }]);
    const goal = hub.launchGoal(
      "compare two options",
      [
        { agentId: "alpha", task: "Option A facts", after: [] },
        { agentId: "gamma", task: "Option B facts", after: [] },
        { agentId: "beta", task: "Compare them", after: [0, 1] },
      ],
      web,
    );
    await settle(goal.id);
    expect(byId(goal.id)).toMatchObject({ status: "done", planSource: "owner" });
    const subs = tasks().filter((t) => t.parentId === goal.id && t.kind === "subtask");
    expect(subs.map((s) => [s.agentId, s.after])).toEqual([
      ["alpha", []],
      ["gamma", []],
      ["beta", [1, 2]],
    ]);
    expect(tasks().some((t) => t.parentId === goal.id && t.kind === "plan")).toBe(false);
    expect(subs[2].result).toMatch(/from-beta: Compare them/);
    expect(subs[2].result).toMatch(/teammate_output step="1" agent="Alpha"/);
  });

  it("refuses a broken plan with a plain reason", () => {
    const { hub } = crew([{ id: "lead" }, { id: "alpha" }]);
    expect(() => hub.launchGoal("x", [{ agentId: "alpha", task: "a", after: [3] }], web)).toThrow("Step 1 can only build on earlier steps.");
    expect(() => hub.launchGoal("x", [{ agentId: "nobody", task: "a", after: [] }], web)).toThrow("Step 1: pick an available specialist.");
  });
});

describe("Redirecting work", () => {
  it("moves a running step to another specialist with the owner's note, keeping the step in the run", async () => {
    const { hub, tasks, byId, settle } = crew([{ id: "lead" }, { id: "slowpoke", delay: 3 }, { id: "quick" }]);
    const goal = hub.launchGoal("x", [{ agentId: "slowpoke", task: "Draft the intro", after: [] }], web);
    const sub = () => tasks().find((t) => t.parentId === goal.id && t.kind === "subtask")!;
    for (let i = 0; i < 40 && sub().status !== "running"; i++) await new Promise((r) => setTimeout(r, 25));
    expect(hub.redirect(sub().id, { agentId: "quick", note: "keep it to one line" }, web)).toEqual({ taskId: sub().id, mode: "step" });
    await settle(goal.id);
    expect(sub()).toMatchObject({ agentId: "quick", reroutedFrom: "slowpoke", status: "done" });
    expect(sub().result).toMatch(/from-quick: Draft the intro\s+Owner's direction: keep it to one line/);
    expect(byId(goal.id).status).toBe("done");
  });

  it("continues a finished task on another specialist with the earlier attempt as fenced context", async () => {
    const { hub, tasks, byId, settle } = crew([{ id: "lead" }, { id: "alpha" }, { id: "beta" }]);
    const first = await hub.handleText("@alpha outline the post", web);
    await settle(first.taskId!);
    const res = hub.redirect(first.taskId!, { agentId: "beta", note: "make it punchier" }, web);
    expect(res.mode).toBe("new");
    await settle(res.taskId);
    const next = byId(res.taskId);
    expect(next).toMatchObject({ agentId: "beta", continues: first.taskId, status: "done" });
    expect(byId(first.taskId!).redirectedTo).toBe(res.taskId);
    expect(next.prompt).toMatch(/outline the post\s+Owner's direction: make it punchier/);
    expect(next.prompt).toMatch(/<teammate_output step="1" agent="Alpha">\nfrom-alpha:/);
    expect(tasks().length).toBe(2);
    expect(() => hub.redirect(first.taskId!, {}, web)).toThrow("Pick a different specialist or add a note.");
  });
});

describe("Lessons from finished runs", () => {
  it("proposes a playbook, and approved items feed the next plan", async () => {
    const { hub, byId, settle } = crew([{ id: "lead", out: `cat >/dev/null; printf '%s' '${PLAN_JSON}'` }, { id: "alpha" }, { id: "beta" }]);
    const goal = hub.launchGoal("ship the launch post", [{ agentId: "alpha", task: "Find the facts", after: [] }, { agentId: "beta", task: "Write it up", after: [0] }], web);
    await settle(goal.id);
    expect(byId(goal.id).status).toBe("done");
    const book = hub.store.state.lessons.find((l) => l.kind === "playbook")!;
    expect(book).toMatchObject({ status: "proposed", goalId: goal.id, steps: [{ agentId: "alpha", after: [] }, { agentId: "beta", after: [0] }] });
    await expect(hub.draftPlan("again", { playbookId: book.id })).rejects.toThrow("That playbook isn't available.");
    hub.updateLesson(book.id, { status: "approved" });
    const draft = await hub.draftPlan("ship another launch post", { playbookId: book.id });
    expect(draft.source).toBe("playbook");
    expect(draft.steps.map((s) => s.agentId)).toEqual(["alpha", "beta"]);

    hub.store.state.lessons.push({ id: "n1", kind: "note", status: "proposed", createdAt: new Date().toISOString(), goalId: goal.id, title: "t", text: "Prefer beta for write-ups." });
    expect(hub.approvedNotes()).toEqual([]);
    hub.updateLesson("n1", { status: "approved", text: "Prefer beta for every write-up." });
    expect(hub.approvedNotes()).toEqual(["Prefer beta for every write-up."]);
    expect(() => hub.updateLesson("n1", { status: "maybe" })).toThrow(/status must be/);
  });
});

describe("Solo or crew, and comparing them", () => {
  it("drafts a single strong specialist for a plain goal, and a planned crew when asked", async () => {
    const { hub, tasks } = crew([{ id: "lead", out: `cat >/dev/null; printf '%s' '${PLAN_JSON}'` }, { id: "alpha" }, { id: "beta" }]);
    const solo = await hub.draftPlan("explain how index funds work in plain words");
    expect(solo).toMatchObject({ mode: "solo", source: "solo" });
    expect(solo.steps).toHaveLength(1);
    expect(solo.steps[0].why).toMatch(/One strong specialist/);
    expect(tasks().some((t) => t.kind === "plan")).toBe(false);
    const forced = await hub.draftPlan("explain how index funds work in plain words", { mode: "crew" });
    expect(forced).toMatchObject({ mode: "crew", source: "planner", modeReason: "You chose the crew." });
    expect(forced.steps.map((s) => s.agentId)).toEqual(["alpha", "beta"]);
  });

  it("runs both ways side by side, and the verdict steers similar goals", async () => {
    const { hub, tasks, byId, settle } = crew([{ id: "lead", out: `cat >/dev/null; printf '%s' '${PLAN_JSON}'` }, { id: "alpha" }, { id: "beta" }]);
    const goal = "draft a launch post for the golf glove and have it reviewed";
    expect((await hub.draftPlan(goal)).mode).toBe("crew");
    const cmp = await hub.compare(goal, web);
    await settle(cmp.solo);
    await settle(cmp.crew);
    expect(byId(cmp.solo)).toMatchObject({ status: "done", compareId: cmp.compareId, compareSide: "solo", mode: "solo" });
    expect(byId(cmp.crew)).toMatchObject({ status: "done", compareId: cmp.compareId, compareSide: "crew", mode: "crew" });
    expect(tasks().filter((t) => t.parentId === cmp.solo && t.kind === "subtask")).toHaveLength(1);
    expect(tasks().filter((t) => t.parentId === cmp.crew && t.kind === "subtask")).toHaveLength(2);

    const v = hub.compareVerdict(cmp.compareId, "solo");
    expect(byId(cmp.crew).compareWinner).toBe("solo");
    expect(hub.store.state.lessons.find((l) => l.id === v.lessonId)).toMatchObject({ status: "approved", mode: "solo" });
    expect(hub.approvedNotes()).toEqual([]);
    const again = await hub.draftPlan(goal);
    expect(again).toMatchObject({ mode: "solo", modeReason: expect.stringMatching(/You preferred one specialist/) });
    expect(() => hub.compareVerdict(cmp.compareId, "both")).toThrow(/winner must be/);
  });
});

describe("Phone: plans in chat, sign-in links, verdict prompts", () => {
  /** A Telegram stand-in that records what it was asked to send. */
  function fakeTelegram() {
    const sent: { chatId: string; text: string; buttons?: { text: string; data: string }[][] }[] = [];
    return {
      sent,
      channel: {
        name: "telegram" as const,
        status: () => ({ name: "telegram" as const, enabled: true, connected: true, detail: "fake" }),
        start() {},
        stop() {},
        send: async (chatId: string, text: string) => void sent.push({ chatId, text }),
        sendButtons: async (chatId: string, text: string, buttons: { text: string; data: string }[][]) => void sent.push({ chatId, text, buttons }),
      },
    };
  }
  const tg = { channel: "telegram" as const, chatId: "42" };

  it("drafts a plan with buttons, switches it, and launches it from a tap", async () => {
    const { hub, byId, settle } = crew([{ id: "lead", out: `cat >/dev/null; printf '%s' '${PLAN_JSON}'` }, { id: "alpha" }, { id: "beta" }]);
    const fake = fakeTelegram();
    hub.channels.set("telegram", fake.channel);
    const first = await hub.handleText("/plan explain how index funds work in plain words", tg);
    expect(first.reply).toMatch(/Solo plan/);
    const data = first.buttons!.flat().map((b) => b.data);
    const id = /^pl:(\w+):go$/.exec(data[0])![1];
    expect(data).toEqual([`pl:${id}:go`, `pl:${id}:crew`, `pl:${id}:cmp`, `pl:${id}:x`]);
    const switched = await hub.planAction(id, "crew", tg);
    expect(switched.reply).toMatch(/Crew plan/);
    expect(switched.reply).toMatch(/1\. Alpha: Find the facts/);
    const go = await hub.planAction(id, "go", tg);
    expect(go.reply).toMatch(/Launched/);
    await settle(go.taskId!);
    expect(byId(go.taskId!)).toMatchObject({ status: "done", replyTo: tg });
    expect((await hub.planAction(id, "go", tg)).reply).toMatch(/expired/);
    expect(fake.sent.at(-1)!.text).toMatch(/^\[Crew · /);
  });

  it("falls back to a /launch command where the app has no buttons", async () => {
    const { hub } = crew([{ id: "lead" }, { id: "alpha" }]);
    const res = await hub.handleText("/plan explain how index funds work", { channel: "imessage", chatId: "+1555" });
    expect(res.buttons).toBeUndefined();
    expect(res.reply).toMatch(/Reply \/launch \w+ to start it\./);
  });

  it("asks which version was better once both sides of a comparison are in", async () => {
    const { hub, settle } = crew([{ id: "lead", out: `cat >/dev/null; printf '%s' '${PLAN_JSON}'` }, { id: "alpha" }, { id: "beta" }]);
    const fake = fakeTelegram();
    hub.channels.set("telegram", fake.channel);
    const cmp = await hub.compare("draft a launch post and have it reviewed", tg);
    await settle(cmp.solo);
    await settle(cmp.crew);
    for (let i = 0; i < 40 && !fake.sent.some((m) => m.buttons); i++) await new Promise((r) => setTimeout(r, 25));
    const prompt = fake.sent.filter((m) => m.buttons);
    expect(prompt).toHaveLength(1);
    expect(prompt[0].buttons!.flat().map((b) => b.data)).toEqual([`cv:${cmp.compareId}:solo`, `cv:${cmp.compareId}:crew`, `cv:${cmp.compareId}:tie`]);
    expect(hub.verdictFromChat(cmp.compareId, "crew").reply).toMatch(/the crew was better/);
  });

  it("signs a phone in once with a short-lived code, and refuses everything else", () => {
    const { hub } = crew([{ id: "lead" }]);
    const saved = { token: process.env.HUB_TOKEN, host: process.env.HOST };
    try {
      process.env.HOST = "127.0.0.1";
      expect(hub.dashboardText()).toMatch(/only opens on the Mac itself[\s\S]*npm run setup:phone/);
      process.env.HUB_TOKEN = "secret-token";
      const code = hub.createPairCode();
      expect(() => hub.redeemPairCode("nope")).toThrow(/expired or was already used/);
      expect(hub.redeemPairCode(code)).toBe("secret-token");
      expect(() => hub.redeemPairCode(code)).toThrow(/expired or was already used/);
      const late = hub.createPairCode();
      expect(() => hub.redeemPairCode(late, Date.now() + 11 * 60_000)).toThrow(/expired/);
      for (let i = 0; i < 20; i++) { try { hub.redeemPairCode("x"); } catch {} }
      expect(() => hub.redeemPairCode(hub.createPairCode())).toThrow(/Too many sign-in attempts/);
    } finally {
      if (saved.token === undefined) delete process.env.HUB_TOKEN; else process.env.HUB_TOKEN = saved.token;
      if (saved.host === undefined) delete process.env.HOST; else process.env.HOST = saved.host;
    }
  });
});
