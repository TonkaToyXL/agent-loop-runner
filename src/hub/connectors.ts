import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { accessSync, constants, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fallbackPlan, type PlannerAgent } from "./planner.js";
import { estimateTokens } from "./usage.js";
import type { AgentConfig, Billing, ConnectorConfig, RateInfo, Reasoning, TokenUsage } from "./types.js";

export type Purpose = "plan" | "work" | "synthesis";

export interface RunRequest {
  agent: AgentConfig;
  prompt: string;
  purpose: Purpose;
  taskId: string;
  signal: AbortSignal;
  /** Only the demo connector uses this, to fake a realistic team plan. */
  team: PlannerAgent[];
  /** Ask the owner to approve something the agent wants to do. Resolves false on deny or timeout. */
  approve?: (ask: { title: string; detail: string }) => Promise<boolean>;
  /** Ask the owner a question that needs a typed answer. Resolves null if skipped or unanswered. */
  ask?: (q: { title: string; detail: string }) => Promise<string | null>;
}

export interface RunResult {
  text: string;
  usage: TokenUsage;
  rate?: RateInfo;
  served?: string;
}

export interface ResolvedConnector {
  config: ConnectorConfig;
  live: boolean;
  label: string;
  billing?: Billing;
  /** True when the only working connection is pay-per-use and Relay is blocking it. */
  blocked?: boolean;
}

const env = (name?: string) => (name ? process.env[name]?.trim() || "" : "");

export const meteredAllowed = () => /^(1|true|yes)$/i.test(env("RELAY_ALLOW_METERED"));

const commandCache = new Map<string, boolean>();
/** True when `command` is an executable on PATH (or an absolute path). Cached per process. */
export function hasCommand(command: string): boolean {
  if (commandCache.has(command)) return commandCache.get(command)!;
  const dirs = command.includes("/") ? [""] : (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const found = dirs.some((dir) => {
    try {
      accessSync(dir ? join(dir, command) : command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  commandCache.set(command, found);
  return found;
}

const isOn = (name: string) => {
  const v = env(name);
  return Boolean(v) && !/^(false|0|no|off)$/i.test(v);
};

function available(config: ConnectorConfig): boolean {
  if (!(config.requiresEnv ?? []).every(isOn)) return false;
  if (config.kind === "cli" && (!config.command || !hasCommand(config.command))) return false;
  return true;
}

export function resolveConnector(agent: AgentConfig): ResolvedConnector {
  let blocked: { config: ConnectorConfig; why: string } | undefined;
  for (const config of agent.connectors) {
    if (config.kind === "demo") return { config, live: false, label: "Demo" };
    if (!available(config)) continue;
    if (config.billing === "metered" && !meteredAllowed()) {
      blocked ??= { config, why: "is pay-per-use (blocked)" };
      continue;
    }
    // Prepaid credit only runs under a hard monthly cap, so a missing budget can't drain the balance.
    if (config.billing === "prepaid" && !(agent.limits?.monthlyBudgetUsd > 0) && !meteredAllowed()) {
      blocked ??= { config, why: "spends prepaid credit (set a monthly budget to turn it on)" };
      continue;
    }
    return { config, live: true, label: config.label, billing: config.billing };
  }
  if (blocked) {
    return { config: { kind: "demo", label: "Demo" }, live: false, blocked: true, label: `Off · ${blocked.config.label} ${blocked.why}` };
  }
  // Only pay-per-use options exist and they're blocked: say so instead of asking for keys.
  if (agent.connectors.length && agent.connectors.every((c) => c.billing === "metered") && !meteredAllowed()) {
    return { config: { kind: "demo", label: "Demo" }, live: false, blocked: true, label: `Off · ${agent.connectors[0].label} is pay-per-use (blocked)` };
  }
  const free = agent.connectors.find((c) => c.billing !== "metered") ?? agent.connectors[0];
  const hint = free?.kind === "cli" ? `install ${free.command}` : free?.requiresEnv?.length ? `set ${free.requiresEnv.join(" + ")}` : "";
  return { config: { kind: "demo", label: "Demo" }, live: false, label: hint ? `Demo · ${hint}` : "Demo" };
}

// ---------------------------------------------------------------- webhook
type Settle = (err: Error | null, text?: string) => void;

/** Pending webhook tasks, resolved when the agent POSTs to /hooks/agent/:taskId. */
const pending = new Map<string, { token: string; settle: Settle }>();

function safeTokenEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Check whether a webhook callback token matches a currently pending task before reading its body. */
export function verifyWebhookToken(taskId: string, token: string): boolean {
  const entry = pending.get(taskId);
  return Boolean(entry && token && safeTokenEqual(entry.token, token));
}

export function resolveWebhook(taskId: string, token: string, body: { result?: string; error?: string }): boolean {
  const entry = pending.get(taskId);
  if (!entry || !token || !safeTokenEqual(entry.token, token)) return false;
  if (body.error) {
    entry.settle(new Error(String(body.error)));
    return true;
  }
  const text = typeof body.result === "string" ? body.result.trim() : "";
  if (!text) {
    entry.settle(new Error("Webhook returned an empty reply"));
    return true;
  }
  entry.settle(null, text);
  return true;
}

function waitForWebhook(taskId: string, timeoutMs: number, signal: AbortSignal) {
  const token = randomUUID();
  let settle: Settle = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    const onAbort = () => settle(new Error("Cancelled"));
    const timer = setTimeout(
      () =>
        settle(
          new Error(
            `No webhook reply after ${Math.round(timeoutMs / 1000)}s. The routine accepted the task but never called Causeway back. ` +
              "In its run history, check: did it run, is its computer this Mac, and is relay-reply.sh allowed to run without asking?",
          ),
        ),
      timeoutMs,
    );
    settle = (err, text) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      pending.delete(taskId);
      if (err) reject(err);
      else resolve(text ?? "");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.set(taskId, { token, settle });
  });
  promise.catch(() => {});
  return { token, promise, settle: (err: Error | null, text?: string) => settle(err, text) };
}

async function runWebhook(req: RunRequest, config: ConnectorConfig): Promise<RunResult> {
  const url = env(config.webhookUrlEnv);
  const secret = env(config.apiKeyEnv);
  const publicUrl = (process.env.RELAY_PUBLIC_URL?.trim() || `http://127.0.0.1:${process.env.PORT?.trim() || 4747}`).replace(/\/$/, "");
  const timeoutMs = config.timeoutMs ?? 540_000;
  const wait = waitForWebhook(req.taskId, timeoutMs, req.signal);

  const headers: Record<string, string> = { "content-type": "application/json" };
  const headerName = (env(config.webhookHeaderEnv) || config.webhookHeader || "").toLowerCase();
  if (secret) {
    if (headerName && headerName !== "authorization") headers[headerName] = secret;
    else headers.authorization = /^(bearer|basic)\s/i.test(secret) ? secret : `Bearer ${secret}`;
  }
  const fetchTimeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      signal: AbortSignal.any([req.signal, fetchTimeout]),
      body: JSON.stringify({
        request_id: req.taskId,
        task: req.prompt,
        context: req.agent.system,
        model: req.agent.model,
        reasoning: req.agent.reasoning,
        callback_url: `${publicUrl}/hooks/agent/${req.taskId}`,
        callback_token: wait.token,
        reply_format: 'POST JSON {"result": "..."} to callback_url with header x-relay-token: <callback_token>',
      }),
    });
  } catch (err) {
    const outErr = req.signal.aborted
      ? new Error("Cancelled")
      : fetchTimeout.aborted
        ? new Error(`${config.label} took longer than ${Math.round(timeoutMs / 1000)}s`)
        : err instanceof Error
          ? err
          : new Error(String(err));
    wait.settle(outErr);
    throw outErr;
  }
  if (!res.ok) {
    const err = new Error(`Webhook returned HTTP ${res.status}`);
    wait.settle(err);
    throw err;
  }
  // Some webhooks answer synchronously with {"result": "..."}.
  const sync = (await res.json().catch(() => null)) as { result?: unknown } | null;
  if (sync && typeof sync.result === "string" && sync.result) wait.settle(null, sync.result);
  const text = await wait.promise;
  return { text, usage: { input: estimateTokens(req.prompt), output: estimateTokens(text) } };
}

// ---------------------------------------------------------------- openai-compatible
function readRate(headers: Headers): RateInfo | undefined {
  const req = headers.get("x-ratelimit-remaining-requests");
  const tok = headers.get("x-ratelimit-remaining-tokens");
  if (req === null && tok === null) return undefined;
  return {
    remainingRequests: req === null ? undefined : Number(req),
    remainingTokens: tok === null ? undefined : Number(tok),
    at: new Date().toISOString(),
  };
}

export function baseUrlOf(config: ConnectorConfig): string {
  return (env(config.baseUrlEnv) || config.baseUrl || "").replace(/\/$/, "");
}

/** Chat Completions body for an agent, with the reasoning and provider conventions of its connector. */
/**
 * The model this connector will send, or an error message when the model isn't covered by the
 * subscription (e.g. a non-"cline-pass/" model on a ClinePass key would be billed per use).
 */
export function coveredModel(agent: AgentConfig, config: ConnectorConfig): { model: string; error?: string } {
  const model = config.model || agent.model;
  if (model === "auto") {
    const safe = safeAutoCandidates(agent, config);
    if (!safe.length) {
      return {
        model,
        error: `Auto model mode needs at least one model covered by ${config.label}${config.modelPrefix ? ` (${config.modelPrefix}*)` : ""}.`,
      };
    }
    return { model };
  }
  if (config.modelPrefix && !model.startsWith(config.modelPrefix) && !meteredAllowed()) {
    return {
      model,
      error: `${model} isn't included in ${config.label}, so it would be billed per use. Pick a model that starts with ${config.modelPrefix}`,
    };
  }
  return { model };
}

function safeAutoCandidates(agent: AgentConfig, config: ConnectorConfig): string[] {
  return agent.modelOptions.filter(
    (m) => m && m !== "auto" && (!config.modelPrefix || m.startsWith(config.modelPrefix) || meteredAllowed()),
  );
}

export interface TaskRoutingChoice {
  model: string;
  reasoning: Exclude<Reasoning, "auto">;
  reason?: string;
}

function classifyTask(prompt: string): "quick" | "creative" | "ui" | "review" | "deep" | "hard" | "general" {
  const text = prompt.trim();
  const fenceCount = (text.match(/```/g) ?? []).length;
  const hasCodeFence = fenceCount >= 2 || text.includes("```");
  const isHard =
    text.length >= 650 ||
    fenceCount >= 4 ||
    /\b(deep dive|thorough|security audit|formal proof|system architecture|distributed|end-to-end design|multi-step|step by step)\b/i.test(text);
  const isReviewOrMath =
    /\b(review|critique|audit|security|vulnerabilit(?:y|ies)|sql|query|database|schema|algorithm|complexity|big-?o|math|proof|calculate|compare|evaluate|benchmark|trade-?offs?)\b/i.test(
      text,
    );
  const isUi =
    /\b(css|html|svg|tailwind|frontend|front-end|ui|ux|layout|responsive|component|react|animation|keyframe|dashboard|design|stylesheet)\b/i.test(
      text,
    );
  const isCreative =
    !hasCodeFence &&
    /\b(tagline|taglines|slogan|slogans|headline|headlines|copywriting|caption|captions|story|hook|hooks|brainstorm|creative|poem|naming)\b/i.test(
      text,
    );
  const isDeepCode =
    hasCodeFence ||
    text.length >= 280 ||
    /\b(refactor|architect|architecture|debug|fix\s+(?:this|the|a|my)|stack\s*trace|exception|typescript|python|rust|golang|backend|endpoint|async|concurren(?:cy|t)|race\s+condition|unit\s+test|test\s+suite|implement|build\s+a|migration)\b/i.test(
      text,
    );
  const isQuick =
    !hasCodeFence &&
    (/\b(regex|regexp|one-?liner|one word|quick|brief|short|tldr|tl;dr|syntax|convert|format|cron|what is|what's|explain simply)\b/i.test(text) ||
      text.length <= 120);

  if (isHard) return "hard";
  if (isCreative && !isReviewOrMath) return "creative";
  if (isReviewOrMath) return "review";
  if (isUi) return "ui";
  if (isDeepCode) return "deep";
  if (isQuick) return "quick";
  return "general";
}

/**
 * Pick the best reasoning effort for a task when an agent's reasoning is set to "auto".
 * Balances speed/cost on simple asks with deeper thinking on coding, reviews, and hard problems.
 * When `conserveQuota` is true (e.g. $20 ChatGPT Plus), steps down effort one notch and caps auto at "high".
 */
export function pickReasoningForTask(
  reasoning: Reasoning,
  prompt: string,
  conserveQuota = false,
  purpose: Purpose = "work",
): Exclude<Reasoning, "auto"> {
  if (purpose === "plan" || purpose === "synthesis") {
    return reasoning === "off" ? "off" : "low";
  }
  if (reasoning !== "auto") return reasoning;
  const kind = classifyTask(prompt);
  if (conserveQuota) {
    switch (kind) {
      case "quick":
      case "creative":
      case "ui":
      case "general":
        return "low";
      case "review":
      case "deep":
        return "medium";
      case "hard":
        return "high";
    }
  }
  switch (kind) {
    case "quick":
      return "low";
    case "creative":
    case "ui":
    case "general":
      return "medium";
    case "review":
    case "deep":
      return "high";
    case "hard":
      return "max";
  }
}

/**
 * When an agent's model is set to "auto", pick the best covered model from its modelOptions
 * based on value + intelligence for the task (preferring free/flash models for simple asks,
 * and flagship models for deep coding, reviews, and hard problems). Pure, zero-cost, and
 * strictly limited to billing-covered options. Exported for tests.
 */
export function pickModelForTask(
  agent: AgentConfig,
  config: ConnectorConfig,
  prompt: string,
  exclude: Iterable<string> = [],
  purpose: Purpose = "work",
): TaskRoutingChoice {
  const conserve = Boolean(config.conserveQuota);
  const reasoning = pickReasoningForTask(agent.reasoning, prompt, conserve, purpose);
  const fixed = config.model || agent.model;
  if (fixed !== "auto") return { model: fixed, reasoning };
  const skip = new Set(exclude);
  const candidates = safeAutoCandidates(agent, config).filter((c) => !skip.has(c));
  if (!candidates.length) return { model: fixed, reasoning };

  const prefer = (...needles: string[]) => {
    for (const needle of needles) {
      const hit = candidates.find((c) => c.toLowerCase().includes(needle));
      if (hit) return hit;
    }
    return candidates[0];
  };

  // Team planning and wrap-up synthesis are fast orchestration calls — use fast models so the crew starts immediately.
  if (purpose === "plan" || purpose === "synthesis") {
    return {
      model: prefer("gpt-6-astra", "deepseek-v4.1-flash", "glm-5.3-flash", "gpt-6-luna", "kimi-k3.1-pro"),
      reasoning,
      reason: purpose === "plan" ? "fast team planner" : "fast wrap-up",
    };
  }

  const kind = classifyTask(prompt);
  if (conserve) {
    switch (kind) {
      case "hard":
        return { model: prefer("gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"), reasoning, reason: "hard reasoning (quota-capped)" };
      case "review":
      case "deep":
        return { model: prefer("gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol"), reasoning, reason: "balanced review/code" };
      default:
        return { model: prefer("gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"), reasoning, reason: "quota-friendly default" };
    }
  }
  switch (kind) {
    case "creative":
      return { model: prefer("muse-spark", "gpt-6.1-sol", "kimi-k3.1-pro", "glm-5.3", "gpt-6-sol"), reasoning, reason: "creative" };
    case "hard":
      return { model: prefer("gpt-6.1-terra", "deepseek-v4-pro", "kimi-k3.1-pro", "gpt-6.1-sol", "qwen3.8-max", "mistral-large-4"), reasoning, reason: "deep analysis" };
    case "review":
      return { model: prefer("gpt-6.1-terra", "deepseek-v4-pro", "qwen3.8-max", "kimi-k3.1-pro", "gpt-6.1-sol", "mistral-large-4"), reasoning, reason: "review & analysis" };
    case "ui":
      return { model: prefer("gpt-6.1-sol", "glm-5.3", "kimi-k3.1-pro", "gpt-6-astra", "qwen3.8-max"), reasoning, reason: "UI & frontend" };
    case "deep":
      return { model: prefer("gpt-6.1-terra", "kimi-k3.1-pro", "gpt-6.1-sol", "qwen3.8-max", "deepseek-v4-pro", "mistral-large-4"), reasoning, reason: "deep coding" };
    case "quick":
      return {
        model: prefer("gpt-6-astra", "deepseek-v4.1-flash", "glm-5.3-flash", "gpt-6-luna", "mimo-v2.6-flash", "minimax-m3.1-flash"),
        reasoning,
        reason: "fast value task",
      };
    default:
      return { model: prefer("gpt-6-astra", "kimi-k3.1-pro", "gpt-6.1-sol", "glm-5.3", "deepseek-v4-pro", "mistral-large-4"), reasoning, reason: "general" };
  }
}

export function buildChatBody(
  agent: AgentConfig,
  config: ConnectorConfig,
  prompt: string,
  purpose: Purpose = "work",
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...config.body,
    model: config.model || agent.model,
    messages: [
      { role: "system", content: agent.system },
      { role: "user", content: prompt },
    ],
  };
  const resolvedReasoning = pickReasoningForTask(agent.reasoning, prompt, Boolean(config.conserveQuota), purpose);
  const effort = resolvedReasoning === "max" ? "high" : resolvedReasoning;
  if (resolvedReasoning !== "off") {
    if (config.reasoningIn === "model_options") body.model_options = { reasoning_effort: effort };
    else if (config.reasoningParam) body[config.reasoningParam] = effort;
  }
  if (config.supportsProvider && agent.provider) body.provider = agent.provider;
  return body;
}

interface ChatResponse {
  /** Some APIs (Cline's legacy format) nest the completion under `data`. */
  data?: ChatResponse;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  runtime?: { provider?: string; model?: string };
  hermes?: { error_code?: string };
}

/** Pull the answer out of a Chat Completions reply. Throws on failed or cancelled turns. */
export function parseChatResponse(raw: ChatResponse, label: string): { text: string; served?: string; usage?: TokenUsage } {
  const data = !raw.choices && raw.data ? raw.data : raw;
  const choice = data.choices?.[0];
  const text = choice?.message?.content?.trim() ?? "";
  const finish = choice?.finish_reason ?? "";
  if (finish === "error" || finish === "cancelled") {
    throw new Error(`${label} ${finish === "error" ? "reported an error" : "cancelled the run"}${text ? `: ${text.slice(0, 300)}` : ""}`);
  }
  if (!text) throw new Error(`${label} returned an empty reply`);
  const rt = data.runtime;
  const served = rt?.model ? (rt.provider ? `${rt.provider}/${rt.model}` : rt.model) : undefined;
  const usage =
    data.usage?.prompt_tokens != null || data.usage?.completion_tokens != null
      ? { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 }
      : undefined;
  return { text, served, usage };
}

/** Turn Node's vague "fetch failed" into the underlying cause, e.g. ECONNREFUSED or ENOTFOUND. */
export function networkReason(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code;
  const known: Record<string, string> = {
    ECONNREFUSED: "nothing is listening there; is it running?",
    ENOTFOUND: "address not found; check the URL or your internet",
    ETIMEDOUT: "connection timed out",
    ECONNRESET: "connection was reset",
  };
  if (code && known[code]) return known[code];
  return code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
}

/** Liveness probe for connectors that declare a healthPath. */
export async function checkHealth(config: ConnectorConfig): Promise<{ ok: boolean; detail: string }> {
  if (!config.healthPath) return { ok: true, detail: "" };
  try {
    const url = new URL(config.healthPath, baseUrlOf(config));
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, detail: res.ok ? "online" : `health HTTP ${res.status}` };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return { ok: false, detail: cause === "ECONNREFUSED" ? "not running" : err instanceof Error ? err.message : "unreachable" };
  }
}

export interface DiscoveredModels {
  provider: string;
  providerName: string;
  defaultModel?: string;
  models: string[];
}

/**
 * Parse Hermes's GET /api/model/options payload. Only exposes models from the provider
 * that is already active (`is_current: true`), so Relay never silently switches to another
 * provider or triggers unexpected billing. Exported for tests.
 */
export function parseModelOptions(raw: unknown): DiscoveredModels | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as {
    provider?: unknown;
    model?: unknown;
    providers?: { slug?: unknown; name?: unknown; is_current?: unknown; authenticated?: unknown; models?: unknown }[];
  };
  const providers = Array.isArray(data.providers) ? data.providers : [];
  const current =
    providers.find((p) => p && p.is_current === true && p.authenticated !== false) ??
    providers.find((p) => p && typeof data.provider === "string" && p.slug === data.provider && p.authenticated === true);
  if (!current || typeof current.slug !== "string" || !current.slug.trim()) return null;
  const models = Array.isArray(current.models)
    ? Array.from(new Set(current.models.filter((m): m is string => typeof m === "string" && m.trim().length > 0).map((m) => m.trim())))
    : [];
  if (!models.length) return null;
  return {
    provider: current.slug.trim(),
    providerName: typeof current.name === "string" && current.name.trim() ? current.name.trim() : current.slug.trim(),
    defaultModel: typeof data.model === "string" && data.model.trim() ? data.model.trim() : undefined,
    models,
  };
}

/** Fetch live model options for provider-backed local servers (e.g. Hermes /api/model/options). */
export async function fetchModelOptions(config: ConnectorConfig): Promise<DiscoveredModels | null> {
  if (config.kind !== "openai" || !config.supportsProvider) return null;
  const base = baseUrlOf(config);
  if (!base) return null;
  try {
    const url = new URL("/api/model/options", base);
    const key = env(config.apiKeyEnv);
    const res = await fetch(url, {
      headers: key ? { authorization: `Bearer ${key}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return parseModelOptions(await res.json());
  } catch {
    return null;
  }
}

async function runOpenAI(req: RunRequest, config: ConnectorConfig): Promise<RunResult> {
  const base = baseUrlOf(config);
  if (!base) throw new Error(`No base URL for ${req.agent.name}`);
  const key = env(config.apiKeyEnv);
  const covered = coveredModel(req.agent, config);
  if (covered.error) throw new Error(covered.error);
  const chosen = pickModelForTask(req.agent, config, req.prompt, [], req.purpose);
  const effectiveAgent =
    chosen.model !== req.agent.model || chosen.reasoning !== req.agent.reasoning
      ? { ...req.agent, model: chosen.model, reasoning: chosen.reasoning }
      : req.agent;
  // Never bypass Hermes's Runs API approval gate on an actsInWorld agent, even for plan/synthesis.
  if (config.runsApi && (req.purpose === "work" || req.agent.actsInWorld)) {
    const headers = { ...config.headers, "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
    if (await hermesSupportsRuns(base, headers, req.signal)) return runHermesRun({ ...req, agent: effectiveAgent }, config, base, headers);
  }
  const body = buildChatBody(effectiveAgent, config, req.prompt, req.purpose);
  const timeout = AbortSignal.timeout(config.timeoutMs ?? 300_000);
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { ...config.headers, "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.any([req.signal, timeout]),
    });
  } catch (err) {
    if (req.signal.aborted) throw new Error("Cancelled");
    if (timeout.aborted) throw new Error(`${config.label} took longer than ${Math.round((config.timeoutMs ?? 300_000) / 1000)}s`);
    throw new Error(`Can't reach ${config.label} (${networkReason(err)})`);
  }
  const rate = readRate(res.headers);
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const hint =
      res.status === 401 ? " (API key mismatch: check the agent's key in .env)" : res.status === 429 ? " (busy: too many runs at once)" : "";
    throw new Error(`${config.label} HTTP ${res.status}${hint}${detail ? `: ${detail}` : ""}`);
  }
  const parsed = parseChatResponse((await res.json()) as ChatResponse, config.label);
  return {
    text: parsed.text,
    served: parsed.served,
    usage: parsed.usage ?? {
      input: estimateTokens(req.agent.system + req.prompt),
      output: estimateTokens(parsed.text),
    },
    rate,
  };
}

// ---------------------------------------------------------------- cli (local, signed-in tools)
const MAX_STDOUT = 4 * 1024 * 1024;
const SAFE_CLI_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TERM",
  "COLORTERM",
  "LANG",
  "CODEX_HOME",
  "NO_COLOR",
  "CI",
  "NODE_ENV",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

/**
 * The environment a CLI runs with: a minimal safe allowlist (preventing Relay secrets like
 * HUB_TOKEN, TELEGRAM_BOT_TOKEN, MAIL_IMAP_PASSWORD, and pay-per-use API keys from leaking),
 * plus any explicitly configured passEnv variables, minus dropEnv. Exported for tests.
 */
export function cliEnv(config: ConnectorConfig, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const pass = new Set(config.passEnv ?? []);
  const drop = new Set(config.dropEnv ?? []);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || drop.has(k)) continue;
    if (SAFE_CLI_ENV.has(k) || k.startsWith("LC_") || k.startsWith("XDG_") || pass.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

function unwrapCliError(raw: string): string {
  let errMsg = raw.trim();
  if (!errMsg) return "";
  try {
    const nested = JSON.parse(errMsg) as { error?: { message?: string } };
    if (nested.error?.message) errMsg = nested.error.message;
  } catch {}
  return errMsg.slice(0, 300);
}

interface CodexJsonlAcc {
  messages: string[];
  usage?: TokenUsage;
  errMsg: string;
  partial: string;
}

function feedCodexJsonlLine(acc: CodexJsonlAcc, rawLine: string): void {
  const line = rawLine.trim();
  if (!line.startsWith("{")) return;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (ev.type === "item.completed" && ev.item && typeof ev.item === "object") {
    const item = ev.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
      acc.messages.push(item.text.trim());
    }
  } else if (ev.type === "turn.completed" && ev.usage && typeof ev.usage === "object") {
    const u = ev.usage as Record<string, unknown>;
    const input = Number(u.input_tokens ?? 0);
    const output = Number(u.output_tokens ?? 0);
    if (Number.isFinite(input) && Number.isFinite(output)) acc.usage = { input, output };
  } else if (ev.type === "turn.failed" && ev.error && typeof ev.error === "object") {
    const m = (ev.error as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) acc.errMsg = m.trim();
  } else if (ev.type === "error" && typeof ev.message === "string" && ev.message.trim()) {
    acc.errMsg = ev.message.trim();
  }
}

/** Parse a CLI's stdout into a result. Exported for tests. */
export function parseCliOutput(stdout: string, format: ConnectorConfig["outputFormat"], label: string): Omit<RunResult, "rate"> & { usage?: TokenUsage } {
  if (format === "codex-jsonl") {
    const acc: CodexJsonlAcc = { messages: [], errMsg: "", partial: "" };
    for (const rawLine of stdout.split("\n")) feedCodexJsonlLine(acc, rawLine);
    if (acc.messages.length) {
      const text = acc.messages.join("\n\n").trim();
      return { text, usage: acc.usage ?? { input: 0, output: estimateTokens(text) } };
    }
    if (acc.errMsg) throw new Error(unwrapCliError(acc.errMsg));
    throw new Error(`${label} returned an empty reply`);
  }
  const text = stdout.trim();
  if (!text) throw new Error(`${label} returned an empty reply`);
  return { text, usage: { input: 0, output: estimateTokens(text) } };
}

async function runCli(req: RunRequest, config: ConnectorConfig): Promise<RunResult> {
  const chosen = pickModelForTask(req.agent, config, req.prompt, [], req.purpose);
  const effectiveModel = chosen.model;
  const effectiveReasoning = chosen.reasoning;
  const template = config.args ?? [];
  const promptInArgs = template.some((a) => a.includes("{prompt}"));
  const args = template.map((a) =>
    a
      .replaceAll("{model}", effectiveModel)
      .replaceAll("{reasoning}", effectiveReasoning)
      .replaceAll("{system}", req.agent.system)
      .replaceAll("{prompt}", req.prompt),
  );
  if (config.modelArg && effectiveModel && effectiveModel !== "default" && effectiveModel !== "auto") {
    args.push(config.modelArg, effectiveModel);
  }
  if (config.reasoningArg) {
    const effort = effectiveReasoning === "off" ? "low" : effectiveReasoning;
    args.push("-c", `${config.reasoningArg}="${effort}"`);
  }
  // An empty working folder, so the tool doesn't pick up whatever project Relay runs from.
  const cwd = join(tmpdir(), "relay-cli", req.agent.id);
  mkdirSync(cwd, { recursive: true });
  if (req.signal.aborted) throw new Error("Cancelled");
  const child = spawn(config.command!, args, { cwd, env: cliEnv(config), stdio: ["pipe", "pipe", "pipe"] });
  const outDec = new StringDecoder("utf8");
  const errDec = new StringDecoder("utf8");
  const jsonl: CodexJsonlAcc = { messages: [], errMsg: "", partial: "" };
  let stdout = "";
  let stderr = "";
  const ingestJsonl = (chunk: string) => {
    jsonl.partial += chunk;
    let nl = jsonl.partial.indexOf("\n");
    while (nl !== -1) {
      feedCodexJsonlLine(jsonl, jsonl.partial.slice(0, nl));
      jsonl.partial = jsonl.partial.slice(nl + 1);
      nl = jsonl.partial.indexOf("\n");
    }
  };
  child.stdout.on("data", (d: Buffer) => {
    const chunk = outDec.write(d);
    if (config.outputFormat === "codex-jsonl") ingestJsonl(chunk);
    else if (stdout.length < MAX_STDOUT) stdout += chunk.slice(0, MAX_STDOUT - stdout.length);
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + errDec.write(d)).slice(-4000);
  });
  child.stdin.on("error", () => {});
  const stdinText = promptInArgs
    ? ""
    : config.outputFormat === "codex-jsonl" && req.agent.system
      ? `System instructions:\n${req.agent.system}\n\nUser request:\n${req.prompt}`
      : req.prompt;
  child.stdin.end(stdinText);

  const timeoutMs = config.timeoutMs ?? 600_000;
  const code = await new Promise<number | null>((resolve, reject) => {
    const kill = (why: string) => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      reject(new Error(why));
    };
    const timer = setTimeout(() => kill(`${config.label} took longer than ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    const onAbort = () => kill("Cancelled");
    req.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onAbort);
      reject(new Error(`${config.label} couldn't start: ${err.message}`));
    });
    child.on("close", (c) => {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onAbort);
      const tailOut = outDec.end();
      const tailErr = errDec.end();
      if (tailOut) {
        if (config.outputFormat === "codex-jsonl") ingestJsonl(tailOut);
        else if (stdout.length < MAX_STDOUT) stdout += tailOut.slice(0, MAX_STDOUT - stdout.length);
      }
      if (jsonl.partial) {
        feedCodexJsonlLine(jsonl, jsonl.partial);
        jsonl.partial = "";
      }
      if (tailErr) stderr = (stderr + tailErr).slice(-4000);
      resolve(c);
    });
  });
  if (code !== 0) {
    // Non-zero exit is always a failure; never treat partial stdout as a successful reply.
    const parsedErr = config.outputFormat === "codex-jsonl" && jsonl.errMsg ? unwrapCliError(jsonl.errMsg) : "";
    const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    throw new Error(`${config.label} exited with code ${code}${parsedErr ? `: ${parsedErr}` : tail ? `: ${tail}` : ""}`);
  }
  const parsed =
    config.outputFormat === "codex-jsonl"
      ? jsonl.messages.length
        ? {
            text: jsonl.messages.join("\n\n").trim(),
            usage: jsonl.usage ?? { input: 0, output: estimateTokens(jsonl.messages.join("\n\n").trim()) },
          }
        : (() => {
            if (jsonl.errMsg) throw new Error(unwrapCliError(jsonl.errMsg));
            throw new Error(`${config.label} returned an empty reply`);
          })()
      : parseCliOutput(stdout, config.outputFormat, config.label);
  return {
    ...parsed,
    served: req.agent.model === "auto" ? effectiveModel : parsed.served,
    usage: parsed.usage ?? { input: estimateTokens(req.prompt), output: estimateTokens(parsed.text) },
  };
}

// ---------------------------------------------------------------- Hermes Runs API (approvals)
export interface PendingControl {
  requestId: string;
  generation: number;
  kind: string;
  summary: string;
}

const TERMINAL_OK = new Set(["completed", "succeeded", "success", "done"]);
const TERMINAL_BAD = new Set(["failed", "error", "cancelled", "canceled", "interrupted", "expired"]);

function short(v: unknown, max = 400): string {
  const s = typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Pull approval prompts out of a Hermes run status (`pending_controls`). Hermes documents the
 * identity fields (prompt_id / request_id and execution_generation); the rest is read defensively.
 * Exported for tests.
 */
export function pendingControls(run: Record<string, unknown>): PendingControl[] {
  const raw = run.pending_controls;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw as object).flat() : [];
  const out: PendingControl[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const requestId = String(c.prompt_id ?? c.request_id ?? c.id ?? "");
    const generation = Number(c.execution_generation ?? c.generation);
    if (!requestId || !Number.isFinite(generation)) continue;
    const kind = String(c.kind ?? c.type ?? "approval");
    const tool = c.tool ?? c.tool_name ?? c.name;
    const what = c.description ?? c.summary ?? c.message ?? c.title ?? c.question ?? c.preview ?? c.command ?? c.arguments ?? c.params;
    const summary = [tool ? `Tool: ${short(tool, 80)}` : "", what ? short(what) : ""].filter(Boolean).join("\n") || short(c);
    out.push({ requestId, generation, kind, summary });
  }
  return out;
}

const runsSupport = new Map<string, { ok: boolean; at: number }>();

async function hermesSupportsRuns(base: string, headers: Record<string, string>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) throw new Error("Cancelled");
  const cached = runsSupport.get(base);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.ok;
  try {
    const res = await fetch(`${base}/capabilities`, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (res.ok) {
      const caps = (await res.json()) as { features?: Record<string, unknown> };
      const ok = Boolean(caps.features?.run_submission && caps.features?.run_status);
      runsSupport.set(base, { ok, at: Date.now() });
      return ok;
    }
    if (res.status === 404 || res.status === 501) {
      runsSupport.set(base, { ok: false, at: Date.now() });
    }
    return false;
  } catch {
    if (signal.aborted) throw new Error("Cancelled");
    // Transient network/timeout failure: don't poison the 10-minute cache.
    return false;
  }
}

async function runHermesRun(req: RunRequest, config: ConnectorConfig, base: string, headers: Record<string, string>): Promise<RunResult> {
  const chat = buildChatBody(req.agent, config, req.prompt, req.purpose);
  const body: Record<string, unknown> = { input: req.prompt, instructions: req.agent.system, model: chat.model };
  if (chat.provider) body.provider = chat.provider;
  if (chat.model_options) body.model_options = chat.model_options;

  const deadline = Date.now() + (config.timeoutMs ?? 1_800_000);
  const created = await fetch(`${base}/runs`, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": `relay-${req.taskId}-${randomUUID().slice(0, 6)}` },
    body: JSON.stringify(body),
    signal: AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]),
  });
  if (!created.ok) throw new Error(`${config.label} HTTP ${created.status}: ${(await created.text().catch(() => "")).slice(0, 200)}`);
  const runId = String(((await created.json()) as { run_id?: string }).run_id ?? "");
  if (!runId) throw new Error(`${config.label} didn't return a run id`);

  const stop = () =>
    fetch(`${base}/runs/${runId}/stop`, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(15_000) }).catch(() => {});
  const handled = new Set<string>();
  const decisions = new Map<string, { kind: "clarify"; answer: string } | { kind: "approval"; ok: boolean }>();
  let warned = false;
  let terminal = false;
  let pollErrors = 0;
  const pollDelays = [250, 400, 650, 1000, 1200];
  let pollIdx = 0;
  try {
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`${config.label} took longer than ${Math.round((config.timeoutMs ?? 1_800_000) / 60_000)} minutes`);
      }
      await sleep(pollDelays[Math.min(pollIdx++, pollDelays.length - 1)], req.signal);
      let res: Response;
      try {
        res = await fetch(`${base}/runs/${runId}`, { headers, signal: AbortSignal.any([req.signal, AbortSignal.timeout(15_000)]) });
      } catch (err) {
        if (req.signal.aborted) throw new Error("Cancelled");
        pollErrors++;
        if (pollErrors >= 4) throw new Error(`${config.label} status poll failed (${networkReason(err)})`);
        await sleep(Math.min(4000, pollErrors * 1000), req.signal);
        continue;
      }
      if (!res.ok) {
        if (res.status >= 500 && pollErrors < 3) {
          pollErrors++;
          await sleep(Math.min(4000, pollErrors * 1000), req.signal);
          continue;
        }
        throw new Error(`${config.label} status HTTP ${res.status}`);
      }
      pollErrors = 0;
      const run = (await res.json()) as Record<string, unknown>;
      const status = String(run.status ?? "").toLowerCase();

      if (TERMINAL_OK.has(status)) {
        terminal = true;
        const text = short(run.output ?? run.response ?? "", 1_000_000).trim();
        if (!text) throw new Error(`${config.label} returned an empty reply`);
        const u = run.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const rt = run.runtime as { provider?: string; model?: string } | undefined;
        return {
          text,
          served: rt?.model ? (rt.provider ? `${rt.provider}/${rt.model}` : rt.model) : undefined,
          usage: { input: u?.input_tokens ?? estimateTokens(req.prompt), output: u?.output_tokens ?? estimateTokens(text) },
        };
      }
      if (TERMINAL_BAD.has(status)) {
        terminal = true;
        throw new Error(`${config.label} run ${status}${run.error ? `: ${short(run.error, 300)}` : ""}`);
      }

      for (const control of pendingControls(run)) {
        const key = `${control.requestId}:${control.generation}`;
        if (handled.has(key)) continue;
        if (/clarif|question/i.test(control.kind)) {
          let decision = decisions.get(key);
          if (!decision) {
            const reply = req.ask ? await req.ask({ title: `${req.agent.name} has a question`, detail: control.summary }) : null;
            if (reply === null) {
              throw new Error(`${req.agent.name} asked a question and got no answer, so the task stopped.`);
            }
            decision = { kind: "clarify", answer: reply };
            decisions.set(key, decision);
          }
          const post = await fetch(`${base}/runs/${runId}/clarify`, {
            method: "POST",
            headers,
            signal: AbortSignal.timeout(15_000),
            body: JSON.stringify({
              request_id: control.requestId,
              execution_generation: control.generation,
              answer: decision.kind === "clarify" ? decision.answer : "",
            }),
          }).catch(() => null);
          if (post?.ok) {
            handled.add(key);
            decisions.delete(key);
          } else {
            console.warn(`[hermes] couldn't deliver your answer to run ${runId}; will retry on next poll`);
          }
          continue;
        }
        let decision = decisions.get(key);
        if (!decision) {
          const ok = req.approve
            ? await req.approve({ title: `${req.agent.name} wants to run an action`, detail: control.summary })
            : false;
          decision = { kind: "approval", ok };
          decisions.set(key, decision);
        }
        const post = await fetch(`${base}/runs/${runId}/approval`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({
            request_id: control.requestId,
            execution_generation: control.generation,
            choice: decision.kind === "approval" && decision.ok ? "once" : "deny",
          }),
        }).catch(() => null);
        if (post?.ok) {
          handled.add(key);
          decisions.delete(key);
        } else {
          console.warn(`[hermes] couldn't deliver approval to run ${runId}; will retry on next poll`);
        }
      }
      if (/approval/.test(status) && !pendingControls(run).length && !warned) {
        warned = true;
        console.warn(`[hermes] run ${runId} is waiting for approval but Causeway couldn't read the request.`);
      }
    }
  } catch (err) {
    if (!terminal) void stop();
    throw err;
  }
}

// ---------------------------------------------------------------- demo
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("Cancelled"));
      },
      { once: true },
    );
  });

function demoReply(req: RunRequest): string {
  const { agent, prompt, purpose } = req;
  if (purpose === "plan") {
    const goal = /Goal: ([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? prompt;
    const steps = fallbackPlan(goal, req.team).map((s, i) => ({ step: i + 1, agent: s.agentId, task: s.task, after: i === 0 ? [] : [1] }));
    return JSON.stringify(steps);
  }
  const topic = prompt.split("\n")[0].replace(/^Goal: /, "").slice(0, 90);
  if (purpose === "synthesis") {
    return [
      `**Combined result for:** ${topic}`,
      "",
      "1. Each teammate covered their part (see the steps above).",
      "2. Overlaps merged, gaps flagged.",
      "3. Next action: connect real API keys to replace these demo answers.",
      "",
      `_${agent.name} (demo mode) synthesized this._`,
    ].join("\n");
  }
  return [
    `**${agent.name}** on "${topic}"`,
    "",
    `- Angle: ${agent.tagline}.`,
    `- Would run on \`${agent.model}\` with ${agent.reasoning} reasoning.`,
    "- This is a demo answer. Add the agent's key in `.env` to go live.",
  ].join("\n");
}

async function runDemo(req: RunRequest): Promise<RunResult> {
  const base = req.purpose === "plan" ? 900 : 1500;
  await sleep(base + Math.random() * 2200, req.signal);
  const text = demoReply(req);
  return { text, usage: { input: estimateTokens(req.agent.system + req.prompt), output: estimateTokens(text) * 6 } };
}

export async function runAgent(req: RunRequest): Promise<RunResult & { connector: ResolvedConnector }> {
  const connector = resolveConnector(req.agent);
  const { config } = connector;
  let result: RunResult;
  if (config.kind === "openai") result = await runOpenAI(req, config);
  else if (config.kind === "webhook") result = await runWebhook(req, config);
  else if (config.kind === "cli") result = await runCli(req, config);
  else result = await runDemo(req);
  return { ...result, connector };
}
