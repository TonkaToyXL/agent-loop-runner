import { describe, expect, it } from "vitest";
import { agentUsage, costOf, leaderboard, limitState, priceFor } from "./usage.js";
import type { Task, UsageEvent } from "./types.js";

const now = new Date(2026, 10, 25, 15, 0, 0);
const at = (daysAgo: number, hour = 12) => new Date(2026, 10, 25 - daysAgo, hour).toISOString();
const ev = (agentId: string, daysAgo: number, tokens: number, cost = 0): UsageEvent => ({
  at: at(daysAgo),
  agentId,
  taskId: "t",
  model: "m",
  input: tokens / 2,
  output: tokens / 2,
  costUsd: cost,
  ok: true,
  ms: 1000,
});

describe("agentUsage", () => {
  it("splits today from the rest of the month", () => {
    const events = [ev("grok", 0, 100, 0.5), ev("grok", 0, 300, 0.25), ev("grok", 3, 1000, 1), ev("muse", 0, 999, 9), ev("grok", 40, 5000, 5)];
    expect(agentUsage(events, "grok", now)).toEqual({
      requestsToday: 2,
      tokensToday: 400,
      costToday: 0.75,
      costMonth: 1.75,
      tokensMonth: 1400,
    });
  });
});

describe("limitState", () => {
  const usage = { requestsToday: 10, tokensToday: 5000, costToday: 0, costMonth: 2, tokensMonth: 0 };

  it("is ok under limits and reports shares", () => {
    const s = limitState(usage, { dailyRequests: 20, dailyTokens: 10000, monthlyBudgetUsd: 0 });
    expect(s).toMatchObject({ ok: true, requests: 0.5, tokens: 0.5, budget: null });
  });

  it("blocks at each limit with a reason", () => {
    expect(limitState(usage, { dailyRequests: 10, dailyTokens: 0, monthlyBudgetUsd: 0 }).reason).toMatch(/request limit/);
    expect(limitState(usage, { dailyRequests: 0, dailyTokens: 5000, monthlyBudgetUsd: 0 }).reason).toMatch(/token limit/);
    expect(limitState(usage, { dailyRequests: 0, dailyTokens: 0, monthlyBudgetUsd: 2 }).reason).toMatch(/budget/);
  });

  it("treats 0 as no limit", () => {
    expect(limitState(usage, { dailyRequests: 0, dailyTokens: 0, monthlyBudgetUsd: 0 })).toMatchObject({ ok: true, requests: null });
  });
});

describe("costOf", () => {
  it("prices per million tokens", () => {
    expect(costOf({ input: 1_000_000, output: 500_000 }, { inputPerMTok: 3, outputPerMTok: 15 })).toBe(10.5);
  });

  const zen = {
    inputPerMTok: 2,
    outputPerMTok: 10,
    models: { "glm-5.3-flash": { inputPerMTok: 0.15, outputPerMTok: 0.5 }, "kimi-k3.1-pro": { inputPerMTok: 2, outputPerMTok: 10 } },
  };
  const million = { input: 1_000_000, output: 1_000_000 };

  it("uses the per-model price for the model that served the request", () => {
    expect(costOf(million, zen, "glm-5.3-flash")).toBeCloseTo(0.65);
    expect(costOf(million, zen, undefined, "kimi-k3.1-pro")).toBe(12);
  });
  it("prefers the served model, matches case-insensitively, and ignores a provider prefix", () => {
    expect(costOf(million, zen, "Zen/GLM-5.3-Flash", "kimi-k3.1-pro")).toBeCloseTo(0.65);
  });
  it("falls back to the flat (priciest) rate for unlisted models", () => {
    expect(costOf(million, zen, "brand-new-model")).toBe(12);
    expect(priceFor(zen, "auto")).toBe(zen);
  });
});

describe("leaderboard", () => {
  const task = (agentId: string, status: Task["status"], kind: Task["kind"] = "direct", tokens = 2000): Task => ({
    id: Math.random().toString(36).slice(2),
    kind,
    agentId,
    title: "t",
    prompt: "p",
    status,
    channel: "web",
    routing: "auto",
    createdAt: at(0, 9),
    startedAt: at(0, 9),
    finishedAt: at(0, 10),
    usage: { input: tokens / 2, output: tokens / 2 },
  });

  it("ranks by finished work, counts failures, and ignores goal wrappers", () => {
    const tasks = [
      task("grok", "done"),
      task("grok", "done", "subtask"),
      task("muse", "done"),
      task("muse", "failed"),
      task("hermes", "done", "goal", 999_999),
    ];
    const rows = leaderboard(tasks, [{ id: "grok" }, { id: "muse" }, { id: "hermes" }], 0);
    expect(rows.map((r) => r.agentId)).toEqual(["grok", "muse", "hermes"]);
    expect(rows[0]).toMatchObject({ done: 2, failed: 0, tokens: 4000, successRate: 1, score: 24, avgMs: 3_600_000 });
    expect(rows[1]).toMatchObject({ done: 1, failed: 1, successRate: 0.5, score: 9 });
    expect(rows[2]).toMatchObject({ done: 0, score: 0 });
  });

  it("respects the time window", () => {
    expect(leaderboard([task("grok", "done")], [{ id: "grok" }], now.getTime())[0].done).toBe(0);
  });
});
