import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConnectorConfig, ProviderQuota, ProviderQuotaWindow } from "./types.js";

const env = (name?: string) => (name ? process.env[name]?.trim() || "" : "");

const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const t = Date.parse(value.trim());
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return undefined;
}

const CLINE_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5h",
  "5h": "5h",
  daily: "Day",
  weekly: "Week",
  monthly: "Month",
};

/** Parse ClinePass /api/v1/users/me/plan/usage-limits (+ optional /plan) payloads. */
export function parseClinePassQuota(
  limitsPayload: unknown,
  planPayload?: unknown,
  now = new Date(),
): ProviderQuota | undefined {
  const data = (limitsPayload as { data?: { limits?: unknown[] }; limits?: unknown[] } | null)?.data ?? limitsPayload;
  const rawLimits = Array.isArray((data as { limits?: unknown[] } | null)?.limits)
    ? ((data as { limits: unknown[] }).limits)
    : [];
  const windows: ProviderQuotaWindow[] = [];
  for (const item of rawLimits) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const rawType = String(rec.type ?? rec.window ?? "").trim().toLowerCase();
    const used = toFiniteNumber(rec.percentUsed ?? rec.used_percent ?? rec.usedPercent);
    if (!rawType || used === undefined) continue;
    const label = CLINE_WINDOW_LABELS[rawType] ?? rawType.replace(/_/g, " ");
    windows.push({
      label,
      usedPercent: clampPct(used),
      resetsAt: normalizeIso(rec.resetsAt ?? rec.resets_at ?? rec.resetAt),
    });
  }
  if (!windows.length) return undefined;

  const planObj = ((planPayload as { data?: { plan?: Record<string, unknown> } } | null)?.data?.plan) ?? undefined;
  const planName = typeof planObj?.displayName === "string"
    ? planObj.displayName.trim()
    : typeof planObj?.name === "string"
      ? planObj.name.trim()
      : undefined;

  return {
    provider: "ClinePass",
    plan: planName || undefined,
    live: true,
    windows,
    updatedAt: now.toISOString(),
  };
}

/** Parse Nous Portal /api/oauth/account payload into live credits & optional usage windows. */
export function parseNousPortalQuota(payload: unknown, now = new Date()): ProviderQuota | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const rec = payload as Record<string, unknown>;
  const access = (rec.paid_service_access && typeof rec.paid_service_access === "object"
    ? rec.paid_service_access
    : {}) as Record<string, unknown>;
  const sub = (rec.subscription && typeof rec.subscription === "object"
    ? rec.subscription
    : {}) as Record<string, unknown>;
  const uw = (rec.usage_window && typeof rec.usage_window === "object"
    ? rec.usage_window
    : undefined) as Record<string, unknown> | undefined;

  const creditsRemainingUsd =
    toFiniteNumber(access.total_usable_credits) ??
    toFiniteNumber(rec.purchased_credits_remaining) ??
    toFiniteNumber(access.purchased_credits_remaining) ??
    toFiniteNumber(sub.credits_remaining);
  const periodSpendUsd = toFiniteNumber(access.member_spend_usd);
  const monthlyCreditsUsd = toFiniteNumber(sub.monthly_credits);

  const windows: ProviderQuotaWindow[] = [];
  if (uw && Array.isArray(uw.gauges)) {
    for (const g of uw.gauges) {
      if (!g || typeof g !== "object") continue;
      const gauge = g as Record<string, unknown>;
      const usedBp = toFiniteNumber(gauge.used_bp);
      if (usedBp === undefined) continue;
      const scope = String(gauge.scope ?? gauge.period ?? gauge.label ?? "Usage").trim();
      windows.push({
        label: scope.replace(/_/g, " "),
        usedPercent: clampPct(usedBp / 100),
        resetsAt: normalizeIso(gauge.resets_at_ms ?? gauge.resets_at),
      });
    }
  } else if (
    monthlyCreditsUsd !== undefined &&
    monthlyCreditsUsd > 0 &&
    creditsRemainingUsd !== undefined &&
    creditsRemainingUsd <= monthlyCreditsUsd
  ) {
    windows.push({
      label: "Monthly",
      usedPercent: clampPct(((monthlyCreditsUsd - creditsRemainingUsd) / monthlyCreditsUsd) * 100),
      resetsAt: normalizeIso(sub.current_period_end),
    });
  }

  if (creditsRemainingUsd === undefined && !windows.length) return undefined;

  const rawPlan = typeof sub.plan === "string" ? sub.plan.trim() : "";
  const plan = rawPlan && rawPlan.toLowerCase() !== "free" ? `Nous ${rawPlan}` : "Nous Credits";

  return {
    provider: "Nous Portal",
    plan,
    live: true,
    windows: windows.length ? windows : undefined,
    creditsRemainingUsd: creditsRemainingUsd !== undefined ? Math.max(0, Math.round(creditsRemainingUsd * 100) / 100) : undefined,
    periodSpendUsd: periodSpendUsd !== undefined ? Math.max(0, Math.round(periodSpendUsd * 100) / 100) : undefined,
    monthlyCreditsUsd: monthlyCreditsUsd && monthlyCreditsUsd > 0 ? Math.round(monthlyCreditsUsd * 100) / 100 : undefined,
    updatedAt: now.toISOString(),
  };
}

/** Parse ChatGPT / Codex CLI /backend-api/wham/usage payload into live 5h & Weekly quota windows. */
export function parseCodexQuota(payload: unknown, now = new Date()): ProviderQuota | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const rec = payload as Record<string, unknown>;
  const rl = (rec.rate_limit && typeof rec.rate_limit === "object" ? rec.rate_limit : {}) as Record<string, unknown>;
  const windows: ProviderQuotaWindow[] = [];
  const labelFor = (seconds: number | undefined, fallback: string) =>
    seconds === 18_000 ? "5h" : seconds === 604_800 ? "Week" : seconds === 86_400 ? "Day" : fallback;

  for (const [key, fallback] of [
    ["primary_window", "5h"],
    ["secondary_window", "Week"],
  ] as const) {
    const win = rl[key];
    if (!win || typeof win !== "object") continue;
    const w = win as Record<string, unknown>;
    const used = toFiniteNumber(w.used_percent ?? w.usedPercent);
    if (used === undefined) continue;
    const secs = toFiniteNumber(w.limit_window_seconds);
    windows.push({
      label: labelFor(secs, fallback),
      usedPercent: clampPct(used),
      resetsAt: normalizeIso(w.reset_at ?? w.resets_at),
    });
  }
  if (!windows.length) return undefined;

  const rawPlan = typeof rec.plan_type === "string" ? rec.plan_type.trim() : "";
  const plan = rawPlan ? `ChatGPT ${rawPlan[0].toUpperCase()}${rawPlan.slice(1)}` : "ChatGPT";

  return {
    provider: "ChatGPT",
    plan,
    live: true,
    windows,
    updatedAt: now.toISOString(),
  };
}

/** Shared cache key so agents on the same provider account (e.g. Cline + Muse on ClinePass) share one fetch. */
export function providerQuotaKey(config: ConnectorConfig): string | undefined {
  const baseUrl = (env(config.baseUrlEnv) || config.baseUrl || "").toLowerCase();
  if (config.apiKeyEnv === "CLINEPASS_API_KEY" || baseUrl.includes("api.cline.bot")) return "clinepass";
  if (config.apiKeyEnv === "OPENCODE_ZEN_API_KEY" || baseUrl.includes("opencode.ai/zen")) return "opencode-zen";
  if (config.kind === "openai" && config.supportsProvider && config.healthPath) return "hermes-nous";
  if (config.kind === "cli" && config.command === "codex") return "codex";
  if (config.kind === "webhook") return `webhook:${config.webhookUrlEnv ?? config.label}`;
  return undefined;
}

interface CodexAuthToken {
  accessToken: string;
  accountId?: string;
}

/** Read Codex CLI's existing ChatGPT OAuth token strictly read-only (never mutates auth.json). */
export function readCodexAuth(codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")): CodexAuthToken | undefined {
  try {
    const path = join(codexHome, "auth.json");
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      tokens?: { access_token?: string; account_id?: string };
    };
    const accessToken = typeof raw.tokens?.access_token === "string" ? raw.tokens.access_token.trim() : "";
    if (!accessToken) return undefined;
    const accountId = typeof raw.tokens?.account_id === "string" ? raw.tokens.account_id.trim() || undefined : undefined;
    return { accessToken, accountId };
  } catch {
    return undefined;
  }
}

interface NousAuthToken {
  accessToken: string;
  portalBaseUrl: string;
}

/** Read Hermes's existing Nous Portal OAuth token strictly read-only (never mutates auth.json). */
export function readHermesNousAuth(hermesHome = process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes")): NousAuthToken | undefined {
  try {
    const path = join(hermesHome, "auth.json");
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      providers?: { nous?: { access_token?: string; portal_base_url?: string } };
      nous?: { access_token?: string; portal_base_url?: string };
    };
    const nous = raw.providers?.nous ?? raw.nous;
    const accessToken = typeof nous?.access_token === "string" ? nous.access_token.trim() : "";
    if (!accessToken) return undefined;
    const portalBaseUrl = (typeof nous?.portal_base_url === "string" && nous.portal_base_url.trim()
      ? nous.portal_base_url.trim()
      : "https://portal.nousresearch.com"
    ).replace(/\/$/, "");
    return { accessToken, portalBaseUrl };
  } catch {
    return undefined;
  }
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 8000): Promise<unknown> {
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return undefined;
  return res.json();
}

/**
 * Fetch real provider quota / credits for a live connector.
 * Returns undefined only when no quota metadata applies; for providers that do not expose
 * a balance/quota API (e.g. OpenCode Zen wallet or Grok Bot webhook), returns an honest
 * `live: false` descriptor with a short note.
 */
export async function fetchProviderQuota(
  config: ConnectorConfig,
  opts?: { hermesHome?: string },
): Promise<ProviderQuota | undefined> {
  const key = providerQuotaKey(config);
  if (!key) return undefined;

  if (key === "clinepass") {
    const apiKey = env(config.apiKeyEnv || "CLINEPASS_API_KEY");
    if (!apiKey) return undefined;
    const base = (env(config.baseUrlEnv) || config.baseUrl || "https://api.cline.bot/api/v1").replace(/\/$/, "");
    const headers = { authorization: `Bearer ${apiKey}` };
    try {
      const [limitsPayload, planPayload] = await Promise.all([
        fetchJson(`${base}/users/me/plan/usage-limits`, headers),
        fetchJson(`${base}/users/me/plan`, headers).catch(() => undefined),
      ]);
      return parseClinePassQuota(limitsPayload, planPayload);
    } catch {
      return undefined;
    }
  }

  if (key === "hermes-nous") {
    const auth = readHermesNousAuth(opts?.hermesHome);
    if (!auth) return undefined;
    try {
      const payload = await fetchJson(`${auth.portalBaseUrl}/api/oauth/account`, {
        authorization: `Bearer ${auth.accessToken}`,
      });
      return parseNousPortalQuota(payload);
    } catch {
      return undefined;
    }
  }

  if (key === "codex") {
    const auth = readCodexAuth();
    if (!auth) return { provider: "ChatGPT", live: false, note: "Sign in via Codex CLI", updatedAt: new Date().toISOString() };
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${auth.accessToken}`,
        "user-agent": "codex-cli",
        ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
      };
      const payload = await fetchJson("https://chatgpt.com/backend-api/wham/usage", headers);
      return parseCodexQuota(payload) ?? {
        provider: "ChatGPT",
        live: false,
        note: "Shared with your Codex CLI quota",
        updatedAt: new Date().toISOString(),
      };
    } catch {
      return { provider: "ChatGPT", live: false, note: "Shared with your Codex CLI quota", updatedAt: new Date().toISOString() };
    }
  }

  if (key === "opencode-zen") {
    return {
      provider: "OpenCode Zen",
      live: false,
      note: "Wallet balance in OpenCode Console",
      updatedAt: new Date().toISOString(),
    };
  }

  if (key.startsWith("webhook:")) {
    return {
      provider: config.label,
      live: false,
      note: "Plan quota managed by webhook",
      updatedAt: new Date().toISOString(),
    };
  }

  return undefined;
}

/** Compact one-line summary for Telegram /agents and /doctor. */
export function formatProviderQuotaSummary(q?: ProviderQuota): string {
  if (!q) return "";
  if (!q.live) return q.note ?? "";
  const parts: string[] = [];
  if (q.creditsRemainingUsd !== undefined) {
    parts.push(`$${q.creditsRemainingUsd.toFixed(2)} credits left`);
  }
  if (q.windows?.length) {
    parts.push(q.windows.map((w) => `${w.label} ${Math.round(w.usedPercent)}%`).join(" · "));
  }
  if (q.periodSpendUsd !== undefined && q.creditsRemainingUsd !== undefined) {
    parts.push(`$${q.periodSpendUsd.toFixed(2)} spent`);
  }
  return parts.join(" · ");
}
