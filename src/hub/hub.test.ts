import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAgent } from "./config.js";
import { Hub } from "./hub.js";
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
