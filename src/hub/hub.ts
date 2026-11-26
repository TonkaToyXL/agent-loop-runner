import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { isReasoning } from "./config.js";
import { errorText, PublicError } from "./errors.js";
import { checkHealth, coveredModel, fetchModelOptions, resolveConnector, runAgent, type DiscoveredModels, type Purpose } from "./connectors.js";
import { ApprovalDesk, riskyAction, type Approval, type ApprovalRequest } from "./approvals.js";
import { digestPrompt, fetchRecent, formatList, mailConfig, span } from "./mail/inbox.js";
import {
  fallbackPlan,
  parsePlan,
  planPrompt,
  readySteps,
  stepPrompt,
  synthesisPrompt,
  type PlannerAgent,
  type PlanStep,
  type StepResult,
} from "./planner.js";
import { HELP_TEXT, parseCommand, pickAgent } from "./router.js";
import type { Store } from "./store.js";
import type {
  AgentConfig,
  Channel,
  ChannelStatus,
  EditableAgentFields,
  HubConfig,
  ReplyTarget,
  Task,
  TaskKind,
} from "./types.js";
import { agentUsage, costOf, leaderboard, limitState, startOfDay, type AgentUsage, type LimitState } from "./usage.js";

export interface ChannelAdapter {
  name: Channel;
  status(): ChannelStatus;
  send(chatId: string, text: string): Promise<void>;
  start(): void;
  stop(): void;
  /** Chats that always get approval requests (e.g. the owner's Telegram). */
  approvalTargets?(): string[];
  /** Send an approval request (with buttons where the app supports them). */
  sendApproval?(chatId: string, approval: Approval): Promise<void>;
  /** Update earlier approval messages once decided. */
  updateApproval?(approval: Approval): Promise<void>;
}

export interface AgentView extends AgentConfig {
  isLead: boolean;
  live: boolean;
  connectorLabel: string;
  supportsProvider: boolean;
  sendsReasoning: boolean;
  billing?: "subscription" | "metered" | "local";
  blocked: boolean;
  /** undefined when the connector has no health check. */
  online?: boolean;
  healthDetail?: string;
  discoveredProvider?: string;
  discoveredProviderName?: string;
  discoveredDefaultModel?: string;
  avatarIdle?: string;
  avatarWorking?: string;
  lastServed?: string;
  status: "idle" | "working" | "limited" | "paused" | "offline";
  running: number;
  queued: number;
  usage: AgentUsage;
  limit: LimitState;
  rate?: { remainingRequests?: number; remainingTokens?: number; at: string };
}

export type Baton = { from: string; to: string; taskId: string; kind: "delegate" | "return" | "reroute" | "handoff" };

const TOP_LEVEL: TaskKind[] = ["direct", "goal"];
const titleOf = (text: string) => {
  const line = text.trim().split("\n")[0];
  return line.length > 90 ? `${line.slice(0, 87)}…` : line;
};
const fmtK = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const AVATAR_EXTS = [".gif", ".webp", ".png", ".jpg", ".jpeg", ".svg"] as const;

/** Locate optional custom static/animated profile images in web/avatars/<id>-{idle,working}.<ext>. */
export function findAgentAvatars(agentId: string, webRoot = resolve(process.env.RELAY_WEB_ROOT?.trim() || "web")): { idle?: string; working?: string } {
  const dir = join(webRoot, "avatars");
  const pick = (state: "idle" | "working") => {
    for (const ext of AVATAR_EXTS) {
      const file = `${agentId}-${state}${ext}`;
      if (existsSync(join(dir, file))) return `/avatars/${file}`;
    }
    return undefined;
  };
  return { idle: pick("idle"), working: pick("working") };
}

/** Chat apps show markdown markers literally; keep the text, drop the markers. */
export function toPlainText(md: string): string {
  return md
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:]|$)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "");
}

export class Hub {
  readonly bus = new EventEmitter();
  readonly channels = new Map<Channel, ChannelAdapter>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly slots = new Map<string, number>();
  private readonly waiters = new Map<string, (() => void)[]>();
  /** Requests started but not yet recorded in usage, per agent. */
  private readonly inFlight = new Map<string, number>();
  private readonly health = new Map<string, { ok: boolean; detail: string }>();
  private readonly discoveredModels = new Map<string, DiscoveredModels>();
  private healthTimer: NodeJS.Timeout | null = null;
  private readonly healthFails = new Map<string, number>();
  private readonly healthAlerted = new Map<string, "down" | "up">();
  readonly approvals: ApprovalDesk;

  constructor(
    private readonly config: HubConfig,
    readonly store: Store,
    approvalTimeoutMs = Number(process.env.RELAY_APPROVAL_TIMEOUT_MS) || 15 * 60_000,
  ) {
    this.bus.setMaxListeners(100);
    this.approvals = new ApprovalDesk((a, created) => this.onApproval(a, created), approvalTimeoutMs);
  }

  // ------------------------------------------------------------------ approvals
  /** Ask the owner. Resolves true only on an explicit approve; deny and timeout resolve false. */
  async requestApproval(req: ApprovalRequest, task?: Task): Promise<boolean> {
    const { approval, decision } = this.approvals.request(req);
    if (task) {
      task.awaitingApproval = approval.id;
      this.touch(task);
    }
    const ok = await decision;
    if (task) {
      task.awaitingApproval = undefined;
      this.touch(task);
    }
    return ok;
  }

  decideApproval(id: string, approve: boolean, via: string): Approval | undefined {
    return this.approvals.decide(id, approve, via);
  }

  /** Ask the owner a question that needs a typed answer. */
  async askOwner(req: ApprovalRequest, task?: Task): Promise<string | null> {
    const { approval, answer } = this.approvals.ask(req);
    if (task) {
      task.awaitingApproval = approval.id;
      this.touch(task);
    }
    const reply = await answer;
    if (task) {
      task.awaitingApproval = undefined;
      this.touch(task);
    }
    return reply;
  }

  answerQuestion(id: string, text: string, via: string): Approval | undefined {
    return this.approvals.answer(id, text, via);
  }

  /** Send a short notice to the owner's chats (Telegram). Never fails loudly. */
  notifyOwner(text: string): void {
    if (/^(0|false|no|off)$/i.test(process.env.RELAY_NOTIFY?.trim() ?? "")) return;
    for (const channel of this.channels.values()) {
      for (const chatId of channel.approvalTargets?.() ?? []) {
        channel.send(chatId, text).catch(() => {});
      }
    }
  }

  private readonly startedAt = Date.now();
  private version = "";

  /** Tell the owner Relay is up (e.g. after the Mac restarts). */
  announceStart(): void {
    try {
      this.version = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      this.version = "";
    }
    const live = this.agents().filter((a) => resolveConnector(a).live).map((a) => a.name);
    this.notifyOwner(`🟢 Relay is running on ${hostname()}.\nCrew: ${live.join(", ") || "none connected yet"}.\nSend /doctor for a full check.`);
  }

  /** Full health report, readable on a phone. */
  async doctorText(): Promise<string> {
    const up = Math.round((Date.now() - this.startedAt) / 60_000);
    const lines = [`🩺 Relay check · ${hostname()} · up ${up < 90 ? `${up}m` : `${Math.round(up / 60)}h`}${this.version ? ` · ${this.version}` : ""}`, "", "Agents"];
    for (const a of this.agents()) {
      const v = this.agentView(a);
      const icon = v.blocked ? "⛔" : !v.live ? "⚪" : v.online === false ? "🔴" : !v.enabled ? "⏸" : !v.limit.ok ? "🟡" : "✅";
      const state = v.blocked
        ? "off (pay-per-use, blocked)"
        : !v.live
          ? v.connectorLabel.replace(/^Demo · /, "not connected: ")
          : v.online === false
            ? `offline (${v.healthDetail})`
            : !v.enabled
              ? "paused"
              : !v.limit.ok
                ? `at limit: ${v.limit.reason}`
                : `${v.connectorLabel}${v.online ? " · online" : ""}`;
      lines.push(`${icon} ${a.name}${v.isLead ? " (lead)" : ""}: ${state}`);
    }
    lines.push("", "Channels", "✅ Dashboard");
    const chans = [...this.channels.values()].map((c) => c.status());
    for (const name of ["telegram", "imessage"] as const) {
      const c = chans.find((x) => x.name === name);
      const label = name === "telegram" ? "Telegram" : "iMessage";
      lines.push(c ? `${c.connected ? "✅" : "🔴"} ${label}: ${c.detail || (c.connected ? "connected" : "not connected")}` : `⚪ ${label}: not set up`);
    }
    lines.push("", "Email");
    const cfg = mailConfig();
    if (!cfg) lines.push("⚪ not set up (npm run setup:email)");
    else {
      try {
        const items = await Promise.race([
          fetchRecent(cfg, { hours: 24, max: 60 }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 20_000)),
        ]);
        lines.push(`✅ ${cfg.user}: signed in read-only · ${items.length} in 24h`);
      } catch (err) {
        lines.push(`🔴 ${cfg.user}: ${errorText(err)}`);
      }
      const reader = this.mailReader();
      lines.push(reader.agent ? `✅ Summaries by ${reader.agent.name}` : `⚪ Summaries off: ${reader.why}`);
    }
    const metered = /^(1|true|yes)$/i.test(process.env.RELAY_ALLOW_METERED?.trim() ?? "");
    const waiting = this.approvals.pending().length;
    lines.push(
      "",
      "Safety",
      metered ? "⚠️ Pay-per-use APIs are ALLOWED (RELAY_ALLOW_METERED=true)" : "✅ Pay-per-use APIs blocked",
      waiting ? `🟡 ${waiting} waiting for your OK (/approvals)` : "✅ Nothing waiting for your OK",
    );
    return lines.join("\n");
  }

  /** Where approval requests go: every owner chat (Telegram) plus the chat the task came from. */
  private approvalRecipients(approval: Approval): { channel: ChannelAdapter; chatId: string }[] {
    const out: { channel: ChannelAdapter; chatId: string }[] = [];
    const seen = new Set<string>();
    const add = (channel: ChannelAdapter | undefined, chatId: string | undefined) => {
      if (!channel?.sendApproval || !chatId) return;
      const key = `${channel.name}:${chatId}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ channel, chatId });
    };
    for (const channel of this.channels.values()) for (const chatId of channel.approvalTargets?.() ?? []) add(channel, chatId);
    const task = this.store.state.tasks.find((t) => t.id === approval.taskId);
    const origin = task?.parentId ? this.store.state.tasks.find((t) => t.id === task.parentId)?.replyTo : task?.replyTo;
    if (origin && origin.channel !== "web" && origin.channel !== "system") add(this.channels.get(origin.channel), origin.chatId);
    return out;
  }

  private onApproval(approval: Approval, created: boolean): void {
    this.emit("approval", approval);
    if (created) {
      console.log(`[approval] ${approval.id} requested: ${approval.title}`);
      for (const { channel, chatId } of this.approvalRecipients(approval)) {
        channel.sendApproval!(chatId, approval).catch((err) =>
          console.error(`[${channel.name}] couldn't send approval:`, err instanceof Error ? err.message : err),
        );
      }
    } else {
      console.log(`[approval] ${approval.id} ${approval.status} (${approval.decidedVia})`);
      for (const channel of this.channels.values()) channel.updateApproval?.(approval).catch(() => {});
    }
  }

  // ------------------------------------------------------------------ agents
  agents(): AgentConfig[] {
    return this.config.agents
      .map((a) => ({ ...a, ...this.store.state.overrides[a.id] }))
      .filter((a) => !a.optional || resolveConnector(a).live);
  }

  /**
   * Agents the hub may pick on its own (auto-routing and team plans).
   * Once any agent is live, demo agents are left out so fake answers never mix into real work.
   */
  private routable(): AgentConfig[] {
    const enabled = this.agents().filter((a) => a.enabled);
    const live = enabled.filter((a) => resolveConnector(a).live && this.health.get(a.id)?.ok !== false);
    return live.length ? live : enabled;
  }

  agent(id: string): AgentConfig | undefined {
    return this.agents().find((a) => a.id === id);
  }

  get leadId(): string {
    const chosen = this.store.state.lead && this.agent(this.store.state.lead) ? this.store.state.lead : this.config.lead;
    const pool = this.routable();
    return pool.some((a) => a.id === chosen) || !pool.length ? chosen : pool[0].id;
  }

  private team(): PlannerAgent[] {
    const ok = new Set(this.routable().map((a) => a.id));
    return this.agents().map(({ id, name, skills, tagline }) => ({ id, name, skills, tagline, enabled: ok.has(id) }));
  }

  /** Limit status, counting requests already running for this agent (they aren't in usage yet). */
  limitFor(agent: AgentConfig, now = new Date()): LimitState {
    const usage = agentUsage(this.store.state.usage, agent.id, now);
    usage.requestsToday += this.inFlight.get(agent.id) ?? 0;
    return limitState(usage, agent.limits);
  }

  updateAgent(id: string, patch: Partial<EditableAgentFields>): AgentConfig {
    const base = this.agent(id);
    if (!base) throw new PublicError(`Unknown agent ${id}`, 404);
    const clean: Partial<EditableAgentFields> = {};
    if (typeof patch.model === "string" && patch.model.trim()) clean.model = patch.model.trim().slice(0, 120);
    if (typeof patch.provider === "string") clean.provider = patch.provider.trim().slice(0, 60);
    else if (clean.model) {
      const discovered = this.discoveredModels.get(id);
      if (discovered) {
        if (clean.model === "hermes-agent") clean.provider = "";
        else if (!base.provider && discovered.models.includes(clean.model)) clean.provider = discovered.provider;
      }
    }
    if (patch.reasoning !== undefined) {
      if (!isReasoning(patch.reasoning)) throw new PublicError("reasoning must be off, low, medium, high or max");
      clean.reasoning = patch.reasoning;
    }
    if (typeof patch.enabled === "boolean") clean.enabled = patch.enabled;
    if (typeof patch.tagline === "string") clean.tagline = patch.tagline.slice(0, 120);
    if (Array.isArray(patch.skills)) {
      clean.skills = patch.skills.map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 40);
    }
    const nonNeg = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);
    if (patch.limits) {
      clean.limits = {
        dailyRequests: Math.floor(nonNeg(patch.limits.dailyRequests, base.limits.dailyRequests)),
        dailyTokens: Math.floor(nonNeg(patch.limits.dailyTokens, base.limits.dailyTokens)),
        monthlyBudgetUsd: nonNeg(patch.limits.monthlyBudgetUsd, base.limits.monthlyBudgetUsd),
      };
    }
    if (patch.pricing) {
      clean.pricing = {
        inputPerMTok: nonNeg(patch.pricing.inputPerMTok, base.pricing.inputPerMTok),
        outputPerMTok: nonNeg(patch.pricing.outputPerMTok, base.pricing.outputPerMTok),
      };
    }
    if (patch.maxConcurrent !== undefined) clean.maxConcurrent = Math.max(1, Math.min(8, Math.floor(nonNeg(patch.maxConcurrent, 1))));
    // Refuse model edits that would leave a subscription and start billing per use.
    if (clean.model) {
      const conn = resolveConnector({ ...base, ...clean });
      const check = coveredModel({ ...base, ...clean }, conn.config);
      if (conn.live && check.error) throw new PublicError(check.error);
    }
    this.store.state.overrides[id] = { ...this.store.state.overrides[id], ...clean };
    this.store.save();
    this.emitAgents();
    return this.agent(id)!;
  }

  /** Poll agents whose connector declares a health path, so the dashboard shows online/offline. */
  startHealthChecks(intervalMs = 30_000): void {
    const run = async () => {
      let changed = false;
      for (const agent of this.agents()) {
        const connector = resolveConnector(agent);
        if (!connector.live || !connector.config.healthPath) {
          changed = this.health.delete(agent.id) || changed;
          continue;
        }
        const next = await checkHealth(connector.config);
        const prev = this.health.get(agent.id);
        const fails = next.ok ? 0 : (this.healthFails.get(agent.id) ?? 0) + 1;
        this.healthFails.set(agent.id, fails);
        if (fails === 2 && this.healthAlerted.get(agent.id) !== "down") {
          this.healthAlerted.set(agent.id, "down");
          this.notifyOwner(`🔴 ${agent.name} went offline (${next.detail}). Team work will skip it until it's back.`);
        } else if (next.ok && this.healthAlerted.get(agent.id) === "down") {
          this.healthAlerted.set(agent.id, "up");
          this.notifyOwner(`🟢 ${agent.name} is back online.`);
        }
        if (!prev || prev.ok !== next.ok || prev.detail !== next.detail) {
          this.health.set(agent.id, next);
          changed = true;
          console.log(`[health] ${agent.name}: ${next.ok ? "online" : `offline (${next.detail})`}`);
        }
        if (next.ok && connector.config.supportsProvider && (!this.discoveredModels.has(agent.id) || prev?.ok === false)) {
          const discovered = await fetchModelOptions(connector.config);
          if (discovered) {
            this.discoveredModels.set(agent.id, discovered);
            changed = true;
          }
        }
      }
      if (changed) this.emitAgents();
    };
    void run();
    this.healthTimer = setInterval(run, intervalMs);
    this.healthTimer.unref();
  }

  stopHealthChecks(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
  }

  setLead(id: string): void {
    if (!this.agent(id)) throw new PublicError(`Unknown agent ${id}`, 404);
    this.store.state.lead = id;
    this.store.save();
    this.emitAgents();
  }

  agentView(agent: AgentConfig, now = new Date()): AgentView {
    const connector = resolveConnector(agent);
    const mine = this.store.state.tasks.filter((t) => t.agentId === agent.id);
    const running = mine.filter((t) => t.status === "running" && t.kind !== "goal").length;
    const queued = mine.filter((t) => t.status === "queued").length;
    const usage = agentUsage(this.store.state.usage, agent.id, now);
    const limit = limitState(usage, agent.limits);
    const health = this.health.get(agent.id);
    const discovered = this.discoveredModels.get(agent.id);
    const avatars = findAgentAvatars(agent.id);
    const modelOptions = discovered
      ? Array.from(new Set([agent.model, ...agent.modelOptions, ...discovered.models]))
      : agent.modelOptions;
    const lastServed = [...mine].reverse().find((t) => t.servedModel)?.servedModel;
    return {
      ...agent,
      modelOptions,
      isLead: agent.id === this.leadId,
      live: connector.live,
      connectorLabel: connector.label,
      supportsProvider: Boolean(connector.config.supportsProvider),
      sendsReasoning: Boolean(connector.config.reasoningParam || connector.config.reasoningIn),
      billing: connector.billing,
      blocked: Boolean(connector.blocked),
      online: health?.ok,
      healthDetail: health?.detail,
      discoveredProvider: discovered?.provider,
      discoveredProviderName: discovered?.providerName,
      discoveredDefaultModel: discovered?.defaultModel,
      avatarIdle: avatars.idle,
      avatarWorking: avatars.working,
      lastServed,
      status: !agent.enabled || connector.blocked
        ? "paused"
        : running > 0
          ? "working"
          : health && !health.ok
            ? "offline"
            : !limit.ok
              ? "limited"
              : "idle",
      running,
      queued,
      usage,
      limit,
      rate: this.store.state.rates[agent.id],
    };
  }

  snapshot() {
    const now = new Date();
    const agents = this.agents();
    const tasks = this.store.state.tasks;
    const day = startOfDay(now);
    const views = agents.map((a) => this.agentView(a, now));
    return {
      now: now.toISOString(),
      lead: this.leadId,
      agents: views,
      tasks: tasks.slice(-300),
      leaderboard: {
        today: leaderboard(tasks, agents, day),
        week: leaderboard(tasks, agents, now.getTime() - 7 * 86_400_000),
        all: leaderboard(tasks, agents, 0),
      },
      kpis: {
        tasksToday: tasks.filter((t) => TOP_LEVEL.includes(t.kind) && Date.parse(t.createdAt) >= day).length,
        running: tasks.filter((t) => t.status === "running" && t.kind !== "goal").length,
        tokensToday: views.reduce((n, v) => n + v.usage.tokensToday, 0),
        costMonth: views.reduce((n, v) => n + v.usage.costMonth, 0),
      },
      channels: [...this.channels.values()].map((c) => c.status()),
      approvals: this.approvals.items.slice(-30),
    };
  }

  // ------------------------------------------------------------------ events
  private emit(type: string, data: unknown): void {
    this.bus.emit("event", { type, data });
  }

  private emitAgents(): void {
    const snap = this.snapshot();
    this.emit("agents", { agents: snap.agents, leaderboard: snap.leaderboard, kpis: snap.kpis, lead: snap.lead });
  }

  emitChannels(): void {
    this.emit("channels", [...this.channels.values()].map((c) => c.status()));
  }

  private touch(task: Task): void {
    this.store.save();
    this.emit("task", task);
  }

  private baton(b: Baton): void {
    if (b.from !== b.to) this.emit("baton", b);
  }

  // ------------------------------------------------------------------ commands
  /** Entry point for every channel. Returns the immediate reply text. */
  async handleText(text: string, origin: ReplyTarget): Promise<{ reply: string; taskId?: string }> {
    const agents = this.agents();
    const cmd = parseCommand(text, agents);
    switch (cmd.type) {
      case "help":
        return { reply: HELP_TEXT };
      case "agents":
        return { reply: this.agentsText() };
      case "status":
        return { reply: this.statusText() };
      case "board":
        return { reply: this.boardText() };
      case "error":
        return { reply: cmd.message };
      case "model": {
        const a = this.updateAgent(cmd.agentId, { model: cmd.model });
        return { reply: `${a.name} now runs on ${a.model}.` };
      }
      case "reasoning": {
        const a = this.updateAgent(cmd.agentId, { reasoning: cmd.reasoning });
        return { reply: `${a.name} reasoning set to ${a.reasoning}.` };
      }
      case "approvals": {
        const open = this.approvals.pending();
        if (!open.length) return { reply: "Nothing is waiting for your OK." };
        return {
          reply: open
            .map((a) =>
              a.kind === "question"
                ? `${a.id} · ${a.agentName} asks: ${a.detail}\n  /answer ${a.id} <your answer>   /deny ${a.id} to skip`
                : `${a.id} · ${a.agentName}: ${a.title}\n  /approve ${a.id}   /deny ${a.id}`,
            )
            .join("\n\n"),
        };
      }
      case "decide": {
        const a = this.decideApproval(cmd.id, cmd.approve, origin.channel);
        if (!a) return { reply: `No approval called ${cmd.id}. Send /approvals to see what's waiting.` };
        if (a.decidedVia !== origin.channel || (a.status !== "approved" && a.status !== "denied")) {
          return { reply: `${a.id} was already ${a.status}.` };
        }
        return { reply: a.status === "approved" ? `✅ Approved: ${a.title}` : `❌ Denied: ${a.title}` };
      }
      case "inbox":
        return this.inbox(cmd, text, origin);
      case "doctor":
        return { reply: await this.doctorText() };
      case "answer": {
        const a = this.answerQuestion(cmd.id, cmd.text, origin.channel);
        if (!a) return { reply: `No question called ${cmd.id}. Send /approvals to see what's waiting.` };
        if (a.kind !== "question") return { reply: `${a.id} is a yes/no request. Use /approve ${a.id} or /deny ${a.id}.` };
        return { reply: a.status === "approved" && a.answer === cmd.text.trim().slice(0, 2000) ? `✅ Sent your answer to ${a.agentName}.` : `${a.id} was already ${a.status}.` };
      }
      case "lead": {
        this.setLead(cmd.agentId);
        return { reply: `${this.agent(cmd.agentId)!.name} now leads team goals.` };
      }
      case "ask": {
        const target = this.agent(cmd.agentId)!;
        const limit = this.limitFor(target);
        if (!target.enabled) return { reply: `${target.name} is paused. Turn it back on in the dashboard, or try @team.` };
        const conn = resolveConnector(target);
        if (conn.blocked) return { reply: `${target.name} is off: its only connection is pay-per-use, and Relay blocks paid APIs. Try @team or another agent.` };
        if (!limit.ok) return { reply: `${target.name} hit its ${limit.reason}. Raise the limit or ask someone else.` };
        const task = this.submitDirect(cmd.agentId, cmd.text, origin, "explicit");
        const a = this.agent(task.agentId)!;
        if (a.actsInWorld && riskyAction(cmd.text)) return { reply: `🛡 ${a.name} needs your OK before starting this. Check for the Approve button.`, taskId: task.id };
        return { reply: `→ ${a.name} is on it (${a.model} · ${a.reasoning}).`, taskId: task.id };
      }
      case "auto": {
        const pool = this.routable();
        const fallback = pool.some((a) => a.id === this.leadId) ? this.leadId : pool[0]?.id ?? this.leadId;
        const id = pickAgent(cmd.text, pool, fallback);
        const task = this.submitDirect(id, cmd.text, origin, "auto");
        const a = this.agent(task.agentId)!;
        if (a.actsInWorld && riskyAction(cmd.text)) return { reply: `🛡 Routed to ${a.name}, which needs your OK before starting. Check for the Approve button.`, taskId: task.id };
        return { reply: `→ Routed to ${a.name} (${a.model} · ${a.reasoning}).`, taskId: task.id };
      }
      case "team": {
        const task = this.submitGoal(cmd.text, origin);
        return { reply: `→ Team goal started. ${this.agent(this.leadId)!.name} is splitting the work.`, taskId: task.id };
      }
    }
  }

  /** The agent allowed to read email: set by MAIL_SUMMARIZER, text-only, and live. */
  mailReader(): { agent?: AgentConfig; why?: string } {
    const id = process.env.MAIL_SUMMARIZER?.trim().toLowerCase();
    if (!id || id === "none") return { why: "No agent is allowed to read your email yet (MAIL_SUMMARIZER isn't set)." };
    const agent = this.agent(id);
    if (!agent) return { why: `MAIL_SUMMARIZER is "${id}", but there's no such agent connected.` };
    if (agent.actsInWorld) return { why: `${agent.name} can act on your computer or accounts, so Relay won't let it read email (an email could try to give it orders).` };
    if (!agent.enabled || !resolveConnector(agent).live) return { why: `${agent.name} is off or not connected right now.` };
    return { agent };
  }

  private async inbox(
    cmd: { mode: "list" | "summary"; hours: number; unreadOnly: boolean; text?: string; question?: string },
    typed: string,
    origin: ReplyTarget,
  ): Promise<{ reply: string; taskId?: string }> {
    const cfg = mailConfig();
    if (!cfg) return { reply: "Email isn't connected. On the Mac, run: npm run setup:email" };
    const reader = cmd.mode === "summary" ? this.mailReader() : {};
    try {
      const items = await fetchRecent(cfg, { hours: cmd.hours, unreadOnly: cmd.unreadOnly, text: cmd.text, max: cmd.mode === "summary" ? 40 : 30 });
      if (cmd.mode === "list") return { reply: formatList(items, cmd) };
      if (!reader.agent) return { reply: `${reader.why}\n\nHere's the plain list instead:\n\n${formatList(items, cmd)}` };
      if (!items.length) return { reply: `No ${cmd.unreadOnly ? "unread " : ""}email in the last ${span(cmd.hours)}.` };
      const task = this.submitDirect(reader.agent.id, digestPrompt(items, cmd.hours, cmd.question), origin, "explicit", {
        display: typed,
        title: `Inbox summary · ${items.length} email${items.length === 1 ? "" : "s"}, last ${span(cmd.hours)}`,
      });
      return { reply: `📥 ${reader.agent.name} is reading ${items.length} email${items.length === 1 ? "" : "s"} from the last ${span(cmd.hours)}…`, taskId: task.id };
    } catch (err) {
      return { reply: `Couldn't read email: ${errorText(err)}` };
    }
  }

  private agentsText(): string {
    return this.agents()
      .map((a) => {
        const v = this.agentView(a);
        const lim = a.limits;
        const lead = v.isLead ? " ★lead" : "";
        const served = v.lastServed && v.lastServed !== a.model ? ` (last served by ${v.lastServed})` : "";
        return [
          `${v.status === "working" ? "◉" : v.status === "idle" ? "●" : "○"} ${a.name}${lead} · ${v.status}`,
          `  ${a.provider ? `${a.provider}/` : ""}${a.model}${served} · reasoning ${a.reasoning} · ${v.connectorLabel}`,
          `  today ${v.usage.requestsToday}${lim.dailyRequests ? `/${lim.dailyRequests}` : ""} req · ${fmtK(v.usage.tokensToday)}${lim.dailyTokens ? `/${fmtK(lim.dailyTokens)}` : ""} tok`,
        ].join("\n");
      })
      .join("\n\n");
  }

  private statusText(): string {
    const active = this.store.state.tasks.filter((t) => (t.status === "running" || t.status === "queued") && t.kind !== "goal");
    if (!active.length) return "Nothing running. The crew is idle.";
    return active
      .map((t) => `${t.status === "running" ? "▶" : "…"} ${this.agent(t.agentId)?.name ?? t.agentId}: ${t.title}`)
      .join("\n");
  }

  private boardText(): string {
    const rows = leaderboard(this.store.state.tasks, this.agents(), Date.now() - 7 * 86_400_000);
    const medals = ["🥇", "🥈", "🥉"];
    return [
      "Last 7 days",
      ...rows.map(
        (r, i) =>
          `${medals[i] ?? `${i + 1}.`} ${this.agent(r.agentId)?.name}: ${r.done} done · ${fmtK(r.tokens)} tok · ${Math.round(r.successRate * 100)}% ok`,
      ),
    ].join("\n");
  }

  // ------------------------------------------------------------------ tasks
  private createTask(fields: Omit<Task, "id" | "createdAt" | "status" | "title"> & { title?: string }): Task {
    const agent = this.agent(fields.agentId);
    const task: Task = {
      id: randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
      status: "queued",
      title: fields.title ?? titleOf(fields.prompt),
      model: agent?.model,
      reasoning: agent?.reasoning,
      ...fields,
    };
    this.store.state.tasks.push(task);
    this.touch(task);
    return task;
  }

  submitDirect(
    agentId: string,
    prompt: string,
    origin: ReplyTarget,
    routing: Task["routing"],
    extra: { display?: string; title?: string } = {},
  ): Task {
    const task = this.createTask({ kind: "direct", agentId, prompt, channel: origin.channel, replyTo: origin, routing, ...extra });
    this.baton({ from: "you", to: agentId, taskId: task.id, kind: "delegate" });
    void this.execute(task, "work", prompt)
      .catch(() => {})
      .finally(() => this.deliver(task));
    return task;
  }

  submitGoal(goal: string, origin: ReplyTarget): Task {
    const task = this.createTask({
      kind: "goal",
      agentId: this.leadId,
      prompt: goal,
      channel: origin.channel,
      replyTo: origin,
      routing: "auto",
    });
    void this.runGoal(task).finally(() => this.deliver(task));
    return task;
  }

  cancel(taskId: string): boolean {
    const task = this.store.state.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    const ids = [task.id, ...this.store.state.tasks.filter((t) => t.parentId === task.id).map((t) => t.id)];
    for (const id of ids) {
      this.approvals.cancelForTask(id);
      this.controllers.get(id)?.abort();
    }
    return true;
  }

  private async runGoal(goal: Task): Promise<void> {
    const lead = this.agent(this.leadId)!;
    goal.status = "running";
    goal.startedAt = new Date().toISOString();
    this.touch(goal);
    const controller = new AbortController();
    this.controllers.set(goal.id, controller);
    this.baton({ from: "you", to: lead.id, taskId: goal.id, kind: "delegate" });

    try {
      // 1. Plan
      const team = this.team();
      const planTask = this.createTask({
        kind: "plan",
        agentId: lead.id,
        parentId: goal.id,
        prompt: planPrompt(goal.prompt, team),
        title: `Plan: ${titleOf(goal.prompt)}`,
        channel: "system",
        routing: "auto",
      });
      let steps: PlanStep[];
      try {
        const reply = await this.execute(planTask, "plan", planTask.prompt);
        steps = parsePlan(reply, team.filter((a) => a.enabled).map((a) => a.id)) ?? fallbackPlan(goal.prompt, team);
      } catch {
        steps = fallbackPlan(goal.prompt, team);
      }
      if (controller.signal.aborted) throw new Error("Cancelled");

      // 2. Run the steps: each starts once the steps it builds on are finished.
      const subtasks = steps.map((step, i) =>
        this.createTask({
          kind: "subtask",
          agentId: step.agentId,
          parentId: goal.id,
          prompt: step.task,
          channel: "system",
          routing: "auto",
          step: i + 1,
          after: step.after.map((d) => d + 1),
        }),
      );
      const usedLater = new Set(steps.flatMap((s) => s.after));
      const results: StepResult[] = [];
      const finished = new Set<number>();
      const started = new Set<number>();
      const running = new Map<number, Promise<void>>();
      const nameOf = (i: number) => this.agent(subtasks[i].agentId)?.name ?? subtasks[i].agentId;

      const launch = (i: number) => {
        started.add(i);
        const sub = subtasks[i];
        const inputs = steps[i].after.map((d) => results[d]);
        if (inputs.length && inputs.every((r) => !r.ok)) {
          this.fail(sub, "blocked", "Skipped: every step it builds on failed.");
          results[i] = { step: i + 1, agentName: nameOf(i), ok: false, text: sub.error ?? "skipped" };
          finished.add(i);
          return;
        }
        if (inputs.length) for (const d of steps[i].after) this.baton({ from: subtasks[d].agentId, to: sub.agentId, taskId: sub.id, kind: "handoff" });
        else this.baton({ from: lead.id, to: sub.agentId, taskId: sub.id, kind: "delegate" });
        const job = this.execute(sub, "work", stepPrompt(steps[i].task, inputs))
          .then((text) => {
            results[i] = { step: i + 1, agentName: nameOf(i), ok: true, text };
            if (!usedLater.has(i)) this.baton({ from: sub.agentId, to: lead.id, taskId: sub.id, kind: "return" });
          })
          .catch(() => {
            results[i] = { step: i + 1, agentName: nameOf(i), ok: false, text: String(sub.error ?? "failed") };
          })
          .finally(() => {
            finished.add(i);
            running.delete(i);
          });
        running.set(i, job);
      };

      while (finished.size < steps.length) {
        if (controller.signal.aborted) throw new Error("Cancelled");
        const ready = readySteps(steps, finished, started);
        for (const i of ready) launch(i);
        if (running.size) await Promise.race(running.values());
        else if (!ready.length) break;
      }
      if (controller.signal.aborted) throw new Error("Cancelled");
      const parts = steps.map((_, i) => results[i] ?? { step: i + 1, agentName: nameOf(i), ok: false, text: "not run" });
      if (!parts.some((p) => p.ok)) throw new Error("Every step failed: " + parts.map((p) => `${p.agentName}: ${p.text}`).join("; "));

      // 3. Synthesize
      const synth = this.createTask({
        kind: "synthesis",
        agentId: lead.id,
        parentId: goal.id,
        prompt: synthesisPrompt(goal.prompt, parts),
        title: `Wrap-up: ${titleOf(goal.prompt)}`,
        channel: "system",
        routing: "auto",
      });
      goal.result = await this.execute(synth, "synthesis", synth.prompt);
      goal.status = "done";
    } catch (err) {
      goal.status = controller.signal.aborted ? "cancelled" : "failed";
      goal.error = errorText(err);
      for (const t of this.store.state.tasks) {
        if (t.parentId === goal.id && t.status === "queued") {
          t.status = "cancelled";
          t.error = "Team goal stopped before this step started.";
          t.finishedAt = new Date().toISOString();
          this.touch(t);
        }
      }
    } finally {
      this.controllers.delete(goal.id);
      goal.finishedAt = new Date().toISOString();
      const children = this.store.state.tasks.filter((t) => t.parentId === goal.id);
      goal.usage = children.reduce(
        (sum, t) => ({ input: sum.input + (t.usage?.input ?? 0), output: sum.output + (t.usage?.output ?? 0) }),
        { input: 0, output: 0 },
      );
      goal.costUsd = children.reduce((n, t) => n + (t.costUsd ?? 0), 0);
      this.touch(goal);
      this.emitAgents();
    }
  }

  /** Find someone else with capacity, best skill match first. */
  private alternateFor(task: Task, exclude: string): AgentConfig | undefined {
    const open = this.routable().filter((a) => a.id !== exclude && this.limitFor(a).ok);
    if (!open.length) return undefined;
    const id = pickAgent(task.prompt, open, open[0].id);
    return open.find((a) => a.id === id);
  }

  /** Wait for a free slot. Returns false (holding no slot) if the task is cancelled while waiting. */
  private async acquire(agentId: string, max: number, signal: AbortSignal): Promise<boolean> {
    while ((this.slots.get(agentId) ?? 0) >= max) {
      if (signal.aborted) return false;
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(agentId) ?? [];
        const wake = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const i = list.indexOf(wake);
          if (i >= 0) list.splice(i, 1);
          resolve();
        };
        list.push(wake);
        this.waiters.set(agentId, list);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (signal.aborted) return false;
    this.slots.set(agentId, (this.slots.get(agentId) ?? 0) + 1);
    return true;
  }

  private release(agentId: string): void {
    this.slots.set(agentId, Math.max(0, (this.slots.get(agentId) ?? 1) - 1));
    this.waiters.get(agentId)?.shift()?.();
  }

  private async execute(task: Task, purpose: Purpose, prompt: string): Promise<string> {
    let agent = this.agent(task.agentId);
    if (!agent) throw this.fail(task, "blocked", `Unknown agent ${task.agentId}`);

    const limit = this.limitFor(agent);
    if (!agent.enabled || !limit.ok) {
      const why = !agent.enabled ? `${agent.name} is paused` : `${agent.name}: ${limit.reason}`;
      const alt = task.routing === "auto" ? this.alternateFor(task, agent.id) : undefined;
      if (!alt) throw this.fail(task, "blocked", task.routing === "explicit" ? `${why}. Try another agent or raise the limit.` : why);
      task.reroutedFrom = agent.id;
      task.agentId = alt.id;
      task.model = alt.model;
      task.reasoning = alt.reasoning;
      this.baton({ from: agent.id, to: alt.id, taskId: task.id, kind: "reroute" });
      agent = alt;
      this.touch(task);
    }

    const controller = new AbortController();
    this.controllers.set(task.id, controller);

    // Agents that can act for you (run commands, use your accounts) need your OK for risky-sounding work.
    const risky = purpose === "work" && agent.actsInWorld ? riskyAction(task.prompt) : null;
    if (risky) {
      const ok = await this.requestApproval(
        {
          taskId: task.id,
          agentId: agent.id,
          agentName: agent.name,
          source: "relay",
          title: `${agent.name} may "${risky}" something for you`,
          detail: task.prompt,
        },
        task,
      );
      if (controller.signal.aborted) {
        this.controllers.delete(task.id);
        throw this.fail(task, "failed", "Cancelled");
      }
      if (!ok) {
        this.controllers.delete(task.id);
        const a = this.approvals.items.find((x) => x.taskId === task.id && x.status !== "pending" && x.source === "relay");
        const mins = a ? Math.max(1, Math.round((Date.parse(a.expiresAt) - Date.parse(a.createdAt)) / 60_000)) : 15;
        throw this.fail(task, "blocked", a?.status === "expired" ? `No answer within ${mins} min, so it didn't run.` : "You denied this, so it didn't run.");
      }
    }

    if (!(await this.acquire(agent.id, agent.maxConcurrent, controller.signal))) {
      this.controllers.delete(task.id);
      throw this.fail(task, "cancelled", "Cancelled before it started.");
    }
    // Re-check limits now that the task is about to run: others may have used them up while it waited.
    const latest = this.limitFor(agent);
    if (!latest.ok) {
      this.release(agent.id);
      this.controllers.delete(task.id);
      throw this.fail(task, "blocked", `${agent.name}: ${latest.reason} while this was waiting.`);
    }
    this.inFlight.set(agent.id, (this.inFlight.get(agent.id) ?? 0) + 1);
    task.status = "running";
    task.startedAt = new Date().toISOString();
    task.model = agent.model;
    task.reasoning = agent.reasoning;
    this.touch(task);
    this.emitAgents();

    const started = Date.now();
    try {
      const runner = agent;
      const result = await runAgent({
        agent,
        prompt,
        purpose,
        taskId: task.id,
        signal: controller.signal,
        team: this.team(),
        approve: (ask) =>
          this.requestApproval({ taskId: task.id, agentId: runner.id, agentName: runner.name, source: "agent", ...ask }, task),
        ask: (q) => this.askOwner({ taskId: task.id, agentId: runner.id, agentName: runner.name, source: "agent", ...q }, task),
      });
      task.usage = result.usage;
      task.servedModel = result.served;
      task.costUsd = costOf(result.usage, agent.pricing);
      task.result = result.text;
      task.status = "done";
      this.record(task, agent, true, Date.now() - started);
      if (result.rate) this.store.state.rates[agent.id] = result.rate;
      return result.text;
    } catch (err) {
      const message = errorText(err);
      task.status = controller.signal.aborted ? "cancelled" : "failed";
      task.error = message;
      this.record(task, agent, false, Date.now() - started);
      throw err;
    } finally {
      this.inFlight.set(agent.id, Math.max(0, (this.inFlight.get(agent.id) ?? 1) - 1));
      this.release(agent.id);
      this.controllers.delete(task.id);
      task.finishedAt = new Date().toISOString();
      this.touch(task);
      this.emitAgents();
    }
  }

  private fail(task: Task, status: "blocked" | "failed" | "cancelled", error: string): Error {
    task.status = status;
    task.error = error;
    task.finishedAt = new Date().toISOString();
    this.touch(task);
    return new Error(error);
  }

  private record(task: Task, agent: AgentConfig, ok: boolean, ms: number): void {
    this.store.state.usage.push({
      at: new Date().toISOString(),
      agentId: agent.id,
      taskId: task.id,
      model: agent.model,
      input: task.usage?.input ?? 0,
      output: task.usage?.output ?? 0,
      costUsd: task.costUsd ?? 0,
      ok,
      ms,
    });
  }

  /** Send the final answer back to the chat it came from (web gets it over SSE). */
  private async deliver(task: Task): Promise<void> {
    const target = task.replyTo;
    if (!target || target.channel === "web" || target.channel === "system") return;
    const channel = this.channels.get(target.channel);
    if (!channel) return;
    const agent = this.agent(task.agentId);
    const who = task.kind === "goal" ? `Team (lead ${agent?.name})` : `${agent?.name} · ${task.model} · ${task.reasoning}`;
    const tokens = (task.usage?.input ?? 0) + (task.usage?.output ?? 0);
    const secs = task.startedAt && task.finishedAt ? ((Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 1000).toFixed(1) : "?";
    const body =
      task.status === "done"
        ? toPlainText(task.result ?? "")
        : `⚠️ ${task.status}: ${task.error ?? "no details"}`;
    const reroute = task.reroutedFrom ? `\n(rerouted from ${this.agent(task.reroutedFrom)?.name})` : "";
    try {
      await channel.send(target.chatId, `[${who}]${reroute}\n\n${body}\n\n— ${fmtK(tokens)} tok · ${secs}s`);
    } catch (err) {
      console.error(`[${target.channel}] reply failed:`, err instanceof Error ? err.message : err);
    }
  }
}
