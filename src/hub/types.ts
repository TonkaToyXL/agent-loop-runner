export const REASONING_LEVELS = ["off", "low", "medium", "high", "max"] as const;
export type Reasoning = (typeof REASONING_LEVELS)[number];

export type ConnectorKind = "openai" | "webhook" | "cli" | "demo";

/** subscription: runs on a plan you already pay for. metered: billed per use. local: runs on your machine. */
export type Billing = "subscription" | "metered" | "local";

/**
 * How the hub reaches an agent. An agent can list several connectors; the first
 * one whose required environment variables are all set wins, and demo mode is
 * the fallback so the dashboard always works.
 */
export interface ConnectorConfig {
  kind: ConnectorKind;
  label: string;
  /** How this connection is paid for. Metered connectors are skipped unless RELAY_ALLOW_METERED=true. */
  billing?: Billing;
  /** cli: executable to run (looked up on PATH). */
  command?: string;
  /** cli: arguments. {model}, {system} and {prompt} are filled in; without {prompt} the prompt goes to stdin. */
  args?: string[];
  /** cli: how to read stdout. */
  outputFormat?: "text";
  /** cli: flag that selects the model (e.g. --model). Skipped when the agent's model is "default". */
  modelArg?: string;
  /** Env vars that must be non-empty for this connector to be used. */
  requiresEnv?: string[];
  /** openai: base URL such as https://api.x.ai/v1. */
  baseUrl?: string;
  /** openai: env var that overrides baseUrl. */
  baseUrlEnv?: string;
  /** openai / webhook: env var holding the API key or webhook secret. */
  apiKeyEnv?: string;
  /** openai: send reasoning level as this body field (omit if the model rejects it). */
  reasoningParam?: string;
  /** openai: send reasoning as model_options.reasoning_effort instead (Hermes Agent). */
  reasoningIn?: "model_options";
  /** openai: the endpoint routes by a `provider` field; the agent's provider setting is sent with the model. */
  supportsProvider?: boolean;
  /** openai: path on the base URL's host polled every 30s to show online/offline, e.g. /health. */
  healthPath?: string;
  /** openai: use Hermes' Runs API (supports pausing for your approval); falls back to chat if unsupported. */
  runsApi?: boolean;
  /** openai: extra request headers (non-secret), e.g. {"X-Response-Format": "openai"}. */
  headers?: Record<string, string>;
  /** openai: extra body fields, e.g. {"stream": false}. */
  body?: Record<string, unknown>;
  /** Only model IDs starting with this are covered by the subscription; others are refused (they'd be billed). */
  modelPrefix?: string;
  /** Model ID to send through this connector instead of the agent's model (when providers name it differently). */
  model?: string;
  /** webhook: env var holding the webhook URL. */
  webhookUrlEnv?: string;
  /** webhook: header that carries the secret (default Authorization: Bearer). */
  webhookHeader?: string;
  /** webhook: env var that overrides webhookHeader. */
  webhookHeaderEnv?: string;
  timeoutMs?: number;
}

export interface AgentLimits {
  dailyRequests: number;
  dailyTokens: number;
  monthlyBudgetUsd: number;
}

export interface AgentPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface AgentConfig {
  id: string;
  name: string;
  color: string;
  tagline: string;
  model: string;
  /** For connectors with supportsProvider: provider slug that serves `model`. Empty = endpoint default. */
  provider: string;
  modelOptions: string[];
  reasoning: Reasoning;
  skills: string[];
  system: string;
  connectors: ConnectorConfig[];
  limits: AgentLimits;
  pricing: AgentPricing;
  enabled: boolean;
  maxConcurrent: number;
  /** Hide this agent entirely unless one of its connectors is available (e.g. its CLI is installed). */
  optional: boolean;
  /** Can act outside Relay (run commands, use accounts). Risky-sounding tasks need your OK first. */
  actsInWorld: boolean;
}

export type EditableAgentFields = Pick<
  AgentConfig,
  "model" | "provider" | "reasoning" | "skills" | "limits" | "pricing" | "enabled" | "tagline" | "maxConcurrent"
>;

export interface HubConfig {
  lead: string;
  agents: AgentConfig[];
}

export type TaskStatus = "queued" | "running" | "done" | "failed" | "blocked" | "cancelled";
export type TaskKind = "direct" | "goal" | "plan" | "subtask" | "synthesis";
export type Channel = "web" | "telegram" | "imessage" | "system";

export interface ReplyTarget {
  channel: Channel;
  chatId: string;
  /** Display name of who sent it, if known. */
  from?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface Task {
  id: string;
  kind: TaskKind;
  agentId: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  channel: Channel;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  parentId?: string;
  result?: string;
  error?: string;
  model?: string;
  /** Provider/model that actually answered, when the endpoint reports it. */
  servedModel?: string;
  reasoning?: Reasoning;
  usage?: TokenUsage;
  costUsd?: number;
  /** explicit: the user named the agent. auto: the hub picked it, so it may reroute. */
  routing: "explicit" | "auto";
  /** Set when the hub moved this task to another agent. */
  reroutedFrom?: string;
  /** Team steps: 1-based step number and the steps it builds on. */
  step?: number;
  after?: number[];
  /** What the user actually typed, when the prompt sent to the agent is longer (e.g. inbox summaries). */
  display?: string;
  /** Id of the approval this task is waiting on, if any. */
  awaitingApproval?: string;
  replyTo?: ReplyTarget;
}

export interface UsageEvent {
  at: string;
  agentId: string;
  taskId: string;
  model: string;
  input: number;
  output: number;
  costUsd: number;
  ok: boolean;
  ms: number;
}

export interface RateInfo {
  remainingRequests?: number;
  remainingTokens?: number;
  at: string;
}

export interface ChannelStatus {
  name: Channel;
  enabled: boolean;
  connected: boolean;
  detail: string;
}
