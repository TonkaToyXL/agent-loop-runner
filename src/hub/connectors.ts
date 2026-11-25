import { randomUUID } from "node:crypto";
import { fallbackPlan, type PlannerAgent } from "./planner.js";
import { estimateTokens } from "./usage.js";
import type { AgentConfig, ConnectorConfig, RateInfo, TokenUsage } from "./types.js";

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
}

export interface ResolvedConnector {
  config: ConnectorConfig;
  live: boolean;
  label: string;
}

const env = (name?: string) => (name ? process.env[name]?.trim() || "" : "");

export function resolveConnector(agent: AgentConfig): ResolvedConnector {
  for (const config of agent.connectors) {
    if (config.kind === "demo") return { config, live: false, label: "Demo" };
    if ((config.requiresEnv ?? []).every((name) => env(name))) {
      return { config, live: true, label: config.label };
    }
  }
  const hint = agent.connectors[0]?.requiresEnv?.join(" + ");
  return {
    config: { kind: "demo", label: "Demo" },
    live: false,
    label: hint ? `Demo · set ${hint}` : "Demo",
  };
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
  const publicUrl = (process.env.RELAY_PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4747}`).replace(/\/$/, "");
  const wait = waitForWebhook(req.taskId, config.timeoutMs ?? 540_000, req.signal);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) {
    if (config.webhookHeader) headers[config.webhookHeader] = secret;
    else headers.authorization = `Bearer ${secret}`;
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

async function runOpenAI(req: RunRequest, config: ConnectorConfig): Promise<RunResult> {
  const base = (env(config.baseUrlEnv) || config.baseUrl || "").replace(/\/$/, "");
  if (!base) throw new Error(`No base URL for ${req.agent.name}`);
  const key = env(config.apiKeyEnv);
  const body: Record<string, unknown> = {
    model: req.agent.model,
    messages: [
      { role: "system", content: req.agent.system },
      { role: "user", content: req.prompt },
    ],
  };
  if (config.reasoningParam && req.agent.reasoning !== "off") {
    body[config.reasoningParam] = req.agent.reasoning === "max" ? "high" : req.agent.reasoning;
  }
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
    throw new Error(`${config.label} HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error(`${config.label} returned an empty reply`);
  return {
    text,
    usage: {
      input: data.usage?.prompt_tokens ?? estimateTokens(req.agent.system + req.prompt),
      output: data.usage?.completion_tokens ?? estimateTokens(text),
    },
    rate,
  };
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
  else result = await runDemo(req);
  return { ...result, connector };
}
