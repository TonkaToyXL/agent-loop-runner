import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isReasoning } from "./config.js";
import { resolveConnector, runAgent, type Purpose } from "./connectors.js";
import { fallbackPlan, parsePlan, planPrompt, synthesisPrompt, type PlannerAgent, type PlanStep } from "./planner.js";
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
}

export interface AgentView extends AgentConfig {
  isLead: boolean;
  live: boolean;
  connectorLabel: string;
  status: "idle" | "working" | "limited" | "paused";
  running: number;
  queued: number;
  usage: AgentUsage;
  limit: LimitState;
  rate?: { remainingRequests?: number; remainingTokens?: number; at: string };
}

export type Baton = { from: string; to: string; taskId: string; kind: "delegate" | "return" | "reroute" };

const TOP_LEVEL: TaskKind[] = ["direct", "goal"];
const titleOf = (text: string) => {
  const line = text.trim().split("\n")[0];
  return line.length > 90 ? `${line.slice(0, 87)}…` : line;
};
const fmtK = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

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

  constructor(
    private readonly config: HubConfig,
    readonly store: Store,
  ) {
    this.bus.setMaxListeners(100);
  }

  // ------------------------------------------------------------------ agents
  agents(): AgentConfig[] {
    return this.config.agents.map((a) => ({ ...a, ...this.store.state.overrides[a.id] }));
  }

  agent(id: string): AgentConfig | undefined {
    return this.agents().find((a) => a.id === id);
  }

  get leadId(): string {
    const lead = this.store.state.lead;
    return lead && this.agent(lead) ? lead : this.config.lead;
  }

  private team(): PlannerAgent[] {
    return this.agents().map(({ id, name, skills, tagline, enabled }) => ({ id, name, skills, tagline, enabled }));
  }

  limitFor(agent: AgentConfig, now = new Date()): LimitState {
    return limitState(agentUsage(this.store.state.usage, agent.id, now), agent.limits);
  }

  updateAgent(id: string, patch: Partial<EditableAgentFields>): AgentConfig {
    const base = this.agent(id);
    if (!base) throw new Error(`Unknown agent ${id}`);
    const clean: Partial<EditableAgentFields> = {};
    if (typeof patch.model === "string" && patch.model.trim()) clean.model = patch.model.trim().slice(0, 120);
    if (patch.reasoning !== undefined) {
      if (!isReasoning(patch.reasoning)) throw new Error("reasoning must be off, low, medium, high or max");
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
    this.store.state.overrides[id] = { ...this.store.state.overrides[id], ...clean };
    this.store.save();
    this.emitAgents();
    return this.agent(id)!;
  }

  setLead(id: string): void {
    if (!this.agent(id)) throw new Error(`Unknown agent ${id}`);
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
    return {
      ...agent,
      isLead: agent.id === this.leadId,
      live: connector.live,
      connectorLabel: connector.label,
      status: !agent.enabled ? "paused" : running > 0 ? "working" : !limit.ok ? "limited" : "idle",
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
      case "lead": {
        this.setLead(cmd.agentId);
        return { reply: `${this.agent(cmd.agentId)!.name} now leads team goals.` };
      }
      case "ask": {
        const target = this.agent(cmd.agentId)!;
        const limit = this.limitFor(target);
        if (!target.enabled) return { reply: `${target.name} is paused. Turn it back on in the dashboard, or try @team.` };
        if (!limit.ok) return { reply: `${target.name} hit its ${limit.reason}. Raise the limit or ask someone else.` };
        const task = this.submitDirect(cmd.agentId, cmd.text, origin, "explicit");
        const a = this.agent(task.agentId)!;
        return { reply: `→ ${a.name} is on it (${a.model} · ${a.reasoning}).`, taskId: task.id };
      }
      case "auto": {
        const id = pickAgent(cmd.text, agents, this.leadId);
        const task = this.submitDirect(id, cmd.text, origin, "auto");
        const a = this.agent(task.agentId)!;
        return { reply: `→ Routed to ${a.name} (${a.model} · ${a.reasoning}).`, taskId: task.id };
      }
      case "team": {
        const task = this.submitGoal(cmd.text, origin);
        return { reply: `→ Team goal started. ${this.agent(this.leadId)!.name} is splitting the work.`, taskId: task.id };
      }
    }
  }

  private agentsText(): string {
    return this.agents()
      .map((a) => {
        const v = this.agentView(a);
        const lim = a.limits;
        const lead = v.isLead ? " ★lead" : "";
        return [
          `${v.status === "working" ? "◉" : v.status === "idle" ? "●" : "○"} ${a.name}${lead} · ${v.status}`,
          `  ${a.model} · reasoning ${a.reasoning} · ${v.connectorLabel}`,
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

  submitDirect(agentId: string, prompt: string, origin: ReplyTarget, routing: Task["routing"]): Task {
    const task = this.createTask({ kind: "direct", agentId, prompt, channel: origin.channel, replyTo: origin, routing });
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
    for (const id of ids) this.controllers.get(id)?.abort();
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

      // 2. Delegate in parallel
      const subtasks = steps.map((step) =>
        this.createTask({
          kind: "subtask",
          agentId: step.agentId,
          parentId: goal.id,
          prompt: step.task,
          channel: "system",
          routing: "auto",
        }),
      );
      for (const sub of subtasks) this.baton({ from: lead.id, to: sub.agentId, taskId: sub.id, kind: "delegate" });
      const settled = await Promise.allSettled(
        subtasks.map(async (sub) => {
          const text = await this.execute(sub, "work", sub.prompt);
          this.baton({ from: sub.agentId, to: lead.id, taskId: sub.id, kind: "return" });
          return text;
        }),
      );
      if (controller.signal.aborted) throw new Error("Cancelled");
      const parts = settled.map((s, i) => ({
        agentName: this.agent(subtasks[i].agentId)?.name ?? subtasks[i].agentId,
        ok: s.status === "fulfilled",
        text: s.status === "fulfilled" ? s.value : String(subtasks[i].error ?? "failed"),
      }));
      if (!parts.some((p) => p.ok)) throw new Error("Every subtask failed: " + parts.map((p) => `${p.agentName}: ${p.text}`).join("; "));

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
      goal.error = err instanceof Error ? err.message : String(err);
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
    const open = this.agents().filter((a) => a.id !== exclude && a.enabled && this.limitFor(a).ok);
    if (!open.length) return undefined;
    const id = pickAgent(task.prompt, open, open[0].id);
    return open.find((a) => a.id === id);
  }

  private async acquire(agentId: string, max: number): Promise<void> {
    while ((this.slots.get(agentId) ?? 0) >= max) {
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(agentId) ?? [];
        list.push(resolve);
        this.waiters.set(agentId, list);
      });
    }
    this.slots.set(agentId, (this.slots.get(agentId) ?? 0) + 1);
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
    await this.acquire(agent.id, agent.maxConcurrent);
    task.status = "running";
    task.startedAt = new Date().toISOString();
    task.model = agent.model;
    task.reasoning = agent.reasoning;
    this.touch(task);
    this.emitAgents();

    const started = Date.now();
    try {
      const result = await runAgent({ agent, prompt, purpose, taskId: task.id, signal: controller.signal, team: this.team() });
      task.usage = result.usage;
      task.costUsd = costOf(result.usage, agent.pricing);
      task.result = result.text;
      task.status = "done";
      this.record(task, agent, true, Date.now() - started);
      if (result.rate) this.store.state.rates[agent.id] = result.rate;
      return result.text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      task.status = controller.signal.aborted ? "cancelled" : "failed";
      task.error = message;
      this.record(task, agent, false, Date.now() - started);
      throw err;
    } finally {
      this.release(agent.id);
      this.controllers.delete(task.id);
      task.finishedAt = new Date().toISOString();
      this.touch(task);
      this.emitAgents();
    }
  }

  private fail(task: Task, status: "blocked" | "failed", error: string): Error {
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
