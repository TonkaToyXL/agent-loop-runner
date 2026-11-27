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
