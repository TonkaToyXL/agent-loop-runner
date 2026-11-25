import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fallbackPlan, type PlannerAgent } from "./planner.js";
import { estimateTokens } from "./usage.js";
import type { AgentConfig, Billing, ConnectorConfig, RateInfo, TokenUsage } from "./types.js";

export type Purpose = "plan" | "work" | "synthesis";

export interface RunRequest {
  agent: AgentConfig;
  prompt: string;
  purpose: Purpose;
  taskId: string;
  signal: AbortSignal;
  /** Only the demo connector uses this, to fake a realistic team plan. */
  team: PlannerAgent[];
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

function available(config: ConnectorConfig): boolean {
  if (!(config.requiresEnv ?? []).every((name) => env(name))) return false;
  if (config.kind === "cli" && (!config.command || !hasCommand(config.command))) return false;
  return true;
}

export function resolveConnector(agent: AgentConfig): ResolvedConnector {
  let blocked: ConnectorConfig | undefined;
  for (const config of agent.connectors) {
    if (config.kind === "demo") return { config, live: false, label: "Demo" };
    if (!available(config)) continue;
    if (config.billing === "metered" && !meteredAllowed()) {
      blocked ??= config;
      continue;
    }
    return { config, live: true, label: config.label, billing: config.billing };
  }
  if (blocked) {
    return { config: { kind: "demo", label: "Demo" }, live: false, blocked: true, label: `Off · ${blocked.label} is pay-per-use (blocked)` };
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

export function resolveWebhook(taskId: string, token: string, body: { result?: string; error?: string }): boolean {
  const entry = pending.get(taskId);
  if (!entry || entry.token !== token) return false;
  entry.settle(body.error ? new Error(body.error) : null, String(body.result ?? ""));
  return true;
}

function waitForWebhook(taskId: string, timeoutMs: number, signal: AbortSignal) {
  const token = randomUUID();
  let settle: Settle = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    const onAbort = () => settle(new Error("Cancelled"));
    const timer = setTimeout(() => settle(new Error(`No webhook reply after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
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
  const wait = waitForWebhook(req.taskId, config.timeoutMs ?? 540_000, req.signal);

  const headers: Record<string, string> = { "content-type": "application/json" };
  const headerName = (env(config.webhookHeaderEnv) || config.webhookHeader || "").toLowerCase();
  if (secret) {
    if (headerName && headerName !== "authorization") headers[headerName] = secret;
    else headers.authorization = /^(bearer|basic)\s/i.test(secret) ? secret : `Bearer ${secret}`;
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      signal: req.signal,
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
    wait.settle(err instanceof Error ? err : new Error(String(err)));
    throw err;
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
export function buildChatBody(agent: AgentConfig, config: ConnectorConfig, prompt: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: agent.model,
    messages: [
      { role: "system", content: agent.system },
      { role: "user", content: prompt },
    ],
  };
  const effort = agent.reasoning === "max" ? "high" : agent.reasoning;
  if (agent.reasoning !== "off") {
    if (config.reasoningIn === "model_options") body.model_options = { reasoning_effort: effort };
    else if (config.reasoningParam) body[config.reasoningParam] = effort;
  }
  if (config.supportsProvider && agent.provider) body.provider = agent.provider;
  return body;
}

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  runtime?: { provider?: string; model?: string };
  hermes?: { error_code?: string };
}

/** Pull the answer out of a Chat Completions reply. Throws on failed or cancelled turns. */
export function parseChatResponse(data: ChatResponse, label: string): { text: string; served?: string; usage?: TokenUsage } {
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

async function runOpenAI(req: RunRequest, config: ConnectorConfig): Promise<RunResult> {
  const base = baseUrlOf(config);
  if (!base) throw new Error(`No base URL for ${req.agent.name}`);
  const key = env(config.apiKeyEnv);
  const body = buildChatBody(req.agent, config, req.prompt);
  const timeout = AbortSignal.timeout(config.timeoutMs ?? 300_000);
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.any([req.signal, timeout]),
  });
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

interface ClaudeJson {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

/** Parse a CLI's stdout into a result. Exported for tests. */
export function parseCliOutput(stdout: string, format: ConnectorConfig["outputFormat"], label: string): Omit<RunResult, "rate"> & { usage?: TokenUsage } {
  if (format === "claude-json") {
    let data: ClaudeJson;
    try {
      data = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "") as ClaudeJson;
    } catch {
      throw new Error(`${label} printed something Relay couldn't read`);
    }
    const text = (data.result ?? "").trim();
    if (data.is_error) throw new Error(`${label}: ${text || data.subtype || "error"}`);
    if (!text) throw new Error(`${label} returned an empty reply`);
    const u = data.usage;
    const served = data.modelUsage ? Object.keys(data.modelUsage)[0] : undefined;
    return {
      text,
      served,
      usage: u
        ? { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 }
        : { input: 0, output: estimateTokens(text) },
    };
  }
  const text = stdout.trim();
  if (!text) throw new Error(`${label} returned an empty reply`);
  return { text, usage: { input: 0, output: estimateTokens(text) } };
}

async function runCli(req: RunRequest, config: ConnectorConfig): Promise<RunResult> {
  const template = config.args ?? [];
  const promptInArgs = template.some((a) => a.includes("{prompt}"));
  const args = template.map((a) =>
    a.replaceAll("{model}", req.agent.model).replaceAll("{system}", req.agent.system).replaceAll("{prompt}", req.prompt),
  );
  // An empty working folder, so the tool doesn't pick up whatever project Relay runs from.
  const cwd = join(tmpdir(), "relay-cli", req.agent.id);
  mkdirSync(cwd, { recursive: true });
  const child = spawn(config.command!, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => {
    if (stdout.length < MAX_STDOUT) stdout += d.toString("utf8");
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString("utf8")).slice(-4000);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(promptInArgs ? "" : req.prompt);

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
      reject(new Error(`${config.label} couldn't start: ${err.message}`));
    });
    child.on("close", (c) => {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onAbort);
      resolve(c);
    });
  });
  if (code !== 0) {
    // Claude prints JSON errors on stdout; prefer that message when present.
    try {
      return parseCliOutput(stdout, config.outputFormat, config.label) as RunResult;
    } catch (err) {
      const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
      throw new Error(`${config.label} exited with code ${code}${tail ? `: ${tail}` : err instanceof Error ? `: ${err.message}` : ""}`);
    }
  }
  const parsed = parseCliOutput(stdout, config.outputFormat, config.label);
  return { ...parsed, usage: parsed.usage ?? { input: estimateTokens(req.prompt), output: estimateTokens(parsed.text) } };
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
    const steps = fallbackPlan(goal, req.team).map((s) => ({ agent: s.agentId, task: s.task }));
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
