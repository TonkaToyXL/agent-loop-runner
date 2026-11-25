import type { AgentConfig, AgentLimits, AgentPricing, Task, TokenUsage, UsageEvent } from "./types.js";

export function startOfDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function startOfMonth(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

export function costOf(usage: TokenUsage, pricing: AgentPricing): number {
  return (usage.input * pricing.inputPerMTok + usage.output * pricing.outputPerMTok) / 1_000_000;
}

/** Rough token estimate when a provider does not report usage (~4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface AgentUsage {
  requestsToday: number;
  tokensToday: number;
  costToday: number;
  costMonth: number;
  tokensMonth: number;
}

export function agentUsage(events: UsageEvent[], agentId: string, now: Date): AgentUsage {
  const day = startOfDay(now);
  const month = startOfMonth(now);
  const out: AgentUsage = { requestsToday: 0, tokensToday: 0, costToday: 0, costMonth: 0, tokensMonth: 0 };
  for (const e of events) {
    if (e.agentId !== agentId) continue;
    const t = Date.parse(e.at);
    if (t >= month) {
      out.costMonth += e.costUsd;
      out.tokensMonth += e.input + e.output;
    }
    if (t >= day) {
      out.requestsToday += 1;
      out.tokensToday += e.input + e.output;
      out.costToday += e.costUsd;
    }
  }
  return out;
}

export interface LimitState {
  ok: boolean;
  reason?: string;
  /** 0..1 shares of each limit used; null when that limit is off (0). */
  requests: number | null;
  tokens: number | null;
  budget: number | null;
}

function share(used: number, cap: number): number | null {
  return cap > 0 ? Math.min(1, used / cap) : null;
}

export function limitState(usage: AgentUsage, limits: AgentLimits): LimitState {
  const state: LimitState = {
    ok: true,
    requests: share(usage.requestsToday, limits.dailyRequests),
    tokens: share(usage.tokensToday, limits.dailyTokens),
    budget: share(usage.costMonth, limits.monthlyBudgetUsd),
  };
  if (limits.dailyRequests > 0 && usage.requestsToday >= limits.dailyRequests) {
    return { ...state, ok: false, reason: `daily request limit (${limits.dailyRequests}) reached` };
  }
  if (limits.dailyTokens > 0 && usage.tokensToday >= limits.dailyTokens) {
    return { ...state, ok: false, reason: `daily token limit (${limits.dailyTokens.toLocaleString()}) reached` };
  }
  if (limits.monthlyBudgetUsd > 0 && usage.costMonth >= limits.monthlyBudgetUsd) {
    return { ...state, ok: false, reason: `monthly budget ($${limits.monthlyBudgetUsd}) reached` };
  }
  return state;
}

export interface LeaderRow {
  agentId: string;
  done: number;
  failed: number;
  tokens: number;
  avgMs: number;
  successRate: number;
  score: number;
}

/** Work tasks only: plans and syntheses count, the goal wrapper does not (its work is in its children). */
const WORK_KINDS = new Set(["direct", "plan", "subtask", "synthesis"]);

export function leaderboard(tasks: Task[], agents: Pick<AgentConfig, "id">[], sinceMs: number): LeaderRow[] {
  const rows = new Map<string, LeaderRow & { totalMs: number }>();
  for (const agent of agents) {
    rows.set(agent.id, { agentId: agent.id, done: 0, failed: 0, tokens: 0, avgMs: 0, successRate: 0, score: 0, totalMs: 0 });
  }
  for (const task of tasks) {
    if (!WORK_KINDS.has(task.kind) || !task.finishedAt) continue;
    if (Date.parse(task.finishedAt) < sinceMs) continue;
    const row = rows.get(task.agentId);
    if (!row) continue;
    if (task.status === "done") {
      row.done += 1;
      row.tokens += (task.usage?.input ?? 0) + (task.usage?.output ?? 0);
      if (task.startedAt) row.totalMs += Date.parse(task.finishedAt) - Date.parse(task.startedAt);
    } else if (task.status === "failed") {
      row.failed += 1;
    }
  }
  return [...rows.values()]
    .map(({ totalMs, ...row }) => {
      const attempts = row.done + row.failed;
      return {
        ...row,
        avgMs: row.done ? Math.round(totalMs / row.done) : 0,
        successRate: attempts ? row.done / attempts : 0,
        // Finished work counts most; output volume breaks ties; failures cost a little.
        score: row.done * 10 + Math.round(row.tokens / 1000) - row.failed * 3,
      };
    })
    .sort((a, b) => b.score - a.score || b.done - a.done || a.agentId.localeCompare(b.agentId));
}
