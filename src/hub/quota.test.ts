import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatProviderQuotaSummary,
  parseClinePassQuota,
  parseCodexQuota,
  parseNousPortalQuota,
  providerQuotaKey,
  readCodexAuth,
  readHermesNousAuth,
} from "./quota.js";

describe("parseClinePassQuota", () => {
  it("parses 5h, weekly, and monthly rolling limits with plan name", () => {
    const q = parseClinePassQuota(
      {
        data: {
          limits: [
            { type: "five_hour", percentUsed: 0, resetsAt: "2026-11-26T09:32:39Z" },
            { type: "weekly", percentUsed: 16.4, resetsAt: "2026-11-27T20:14:29Z" },
            { type: "monthly", percentUsed: 33, resetsAt: "2026-12-06T18:05:19Z" },
          ],
        },
        success: true,
      },
      { data: { plan: { displayName: "Cline Pass (Annual)" } } },
      new Date("2026-11-26T05:00:00Z"),
    );

    expect(q).toEqual({
      provider: "ClinePass",
      plan: "Cline Pass (Annual)",
      live: true,
      windows: [
        { label: "5h", usedPercent: 0, resetsAt: "2026-11-26T09:32:39.000Z" },
        { label: "Week", usedPercent: 16.4, resetsAt: "2026-11-27T20:14:29.000Z" },
        { label: "Month", usedPercent: 33, resetsAt: "2026-12-06T18:05:19.000Z" },
      ],
      updatedAt: "2026-11-26T05:00:00.000Z",
    });
    expect(formatProviderQuotaSummary(q)).toBe("5h 0% · Week 16% · Month 33%");
  });

  it("returns undefined for empty or invalid payloads", () => {
    expect(parseClinePassQuota(null)).toBeUndefined();
    expect(parseClinePassQuota({ data: { limits: [] } })).toBeUndefined();
  });
});

describe("parseNousPortalQuota", () => {
  it("parses purchased credit balance and period spend", () => {
    const q = parseNousPortalQuota(
      {
        subscription: { plan: "Free", monthly_credits: 0, credits_remaining: 0 },
        purchased_credits_remaining: 98.264283,
        paid_service_access: {
          total_usable_credits: 98.264283,
          member_spend_usd: "10.344246",
        },
      },
      new Date("2026-11-26T05:00:00Z"),
    );

    expect(q).toEqual({
      provider: "Nous Portal",
      plan: "Nous Credits",
      live: true,
      windows: undefined,
      creditsRemainingUsd: 98.26,
      periodSpendUsd: 10.34,
      monthlyCreditsUsd: undefined,
      updatedAt: "2026-11-26T05:00:00.000Z",
    });
    expect(formatProviderQuotaSummary(q)).toBe("$98.26 credits left · $10.34 spent");
  });

  it("parses monthly subscription window when monthly_credits is positive", () => {
    const q = parseNousPortalQuota(
      {
        subscription: {
          plan: "Pro",
          monthly_credits: 100,
          credits_remaining: 65,
          current_period_end: "2026-12-01T00:00:00Z",
        },
        paid_service_access: { total_usable_credits: 65 },
      },
      new Date("2026-11-26T05:00:00Z"),
    );

    expect(q?.plan).toBe("Nous Pro");
    expect(q?.creditsRemainingUsd).toBe(65);
    expect(q?.windows).toEqual([{ label: "Monthly", usedPercent: 35, resetsAt: "2026-12-01T00:00:00.000Z" }]);
  });
});

describe("providerQuotaKey & readHermesNousAuth", () => {
  it("maps connectors to deduplicated provider quota keys", () => {
    expect(providerQuotaKey({ kind: "openai", label: "ClinePass", apiKeyEnv: "CLINEPASS_API_KEY" })).toBe("clinepass");
    expect(providerQuotaKey({ kind: "openai", label: "OpenCode Zen", apiKeyEnv: "OPENCODE_ZEN_API_KEY" })).toBe("opencode-zen");
    expect(providerQuotaKey({ kind: "openai", label: "Hermes", supportsProvider: true, healthPath: "/health" })).toBe("hermes-nous");
    expect(providerQuotaKey({ kind: "openai", label: "Hermes", supportsProvider: true, healthPath: "/health" }, "cline-pass")).toBe("clinepass");
    expect(providerQuotaKey({ kind: "openai", label: "Hermes", supportsProvider: true, healthPath: "/health" }, "openrouter")).toBeUndefined();
    expect(providerQuotaKey({ kind: "cli", label: "Codex CLI", command: "codex" })).toBe("codex");
    expect(providerQuotaKey({ kind: "webhook", label: "Grok Bot webhook", webhookUrlEnv: "GROK_WEBHOOK_URL" })).toBe("webhook:GROK_WEBHOOK_URL");
  });

  it("parses ChatGPT / Codex wham usage windows", () => {
    const q = parseCodexQuota(
      {
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 6, limit_window_seconds: 18000, reset_at: 1795676057 },
          secondary_window: { used_percent: 4, limit_window_seconds: 604800, reset_at: 1796067219 },
        },
      },
      new Date("2026-11-26T06:00:00Z"),
    );
    expect(q).toEqual({
      provider: "ChatGPT",
      plan: "ChatGPT Plus",
      live: true,
      windows: [
        { label: "5h", usedPercent: 6, resetsAt: new Date(1795676057 * 1000).toISOString() },
        { label: "Week", usedPercent: 4, resetsAt: new Date(1796067219 * 1000).toISOString() },
      ],
      updatedAt: "2026-11-26T06:00:00.000Z",
    });
    expect(formatProviderQuotaSummary(q)).toBe("5h 6% · Week 4%");
  });

  it("reads Codex CLI auth.json read-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-codex-auth-"));
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "tok-c", account_id: "acct-1" } }));
    expect(readCodexAuth(dir)).toEqual({ accessToken: "tok-c", accountId: "acct-1" });
  });

  it("reads Nous Portal OAuth token from Hermes auth.json read-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-hermes-auth-"));
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ providers: { nous: { access_token: "tok-test", portal_base_url: "https://portal.nousresearch.com/" } } }),
    );
    expect(readHermesNousAuth(dir)).toEqual({
      accessToken: "tok-test",
      portalBaseUrl: "https://portal.nousresearch.com",
    });
  });
});
