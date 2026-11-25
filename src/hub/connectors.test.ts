import { describe, expect, it } from "vitest";
import { normalizeAgent } from "./config.js";
import { buildChatBody, coveredModel, networkReason, parseChatResponse, parseCliOutput, resolveConnector } from "./connectors.js";
import type { ConnectorConfig } from "./types.js";

const hermesConn: ConnectorConfig = { kind: "openai", label: "Hermes", reasoningIn: "model_options", supportsProvider: true };
const xaiConn: ConnectorConfig = { kind: "openai", label: "xAI", reasoningParam: "reasoning_effort" };
const plainConn: ConnectorConfig = { kind: "openai", label: "Plain" };
const agent = (extra = {}) => normalizeAgent({ id: "hermes", model: "hermes-agent", reasoning: "high", system: "sys", ...extra }, 0);

describe("buildChatBody", () => {
  it("sends Hermes reasoning inside model_options and no provider by default", () => {
    const body = buildChatBody(agent(), hermesConn, "hi");
    expect(body).toMatchObject({ model: "hermes-agent", model_options: { reasoning_effort: "high" } });
    expect(body).not.toHaveProperty("provider");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  it("sends provider with the model when set, and maps max to high", () => {
    const body = buildChatBody(agent({ provider: "openrouter", model: "x/y", reasoning: "max" }), hermesConn, "hi");
    expect(body).toMatchObject({ model: "x/y", provider: "openrouter", model_options: { reasoning_effort: "high" } });
  });

  it("uses a top-level reasoning field when configured, and nothing when off or unsupported", () => {
    expect(buildChatBody(agent({ reasoning: "low" }), xaiConn, "hi")).toMatchObject({ reasoning_effort: "low" });
    expect(buildChatBody(agent({ reasoning: "off" }), xaiConn, "hi")).not.toHaveProperty("reasoning_effort");
    const plain = buildChatBody(agent({ provider: "openrouter" }), plainConn, "hi");
    expect(plain).not.toHaveProperty("reasoning_effort");
    expect(plain).not.toHaveProperty("model_options");
    expect(plain).not.toHaveProperty("provider");
  });
});

describe("parseChatResponse", () => {
  it("returns text, usage, and the model that served the turn", () => {
    const parsed = parseChatResponse(
      {
        choices: [{ message: { content: " ready " }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
        runtime: { provider: "openrouter", model: "m1" },
      },
      "Hermes",
    );
    expect(parsed).toEqual({ text: "ready", served: "openrouter/m1", usage: { input: 10, output: 2 } });
  });

  it("treats Hermes error and cancelled finishes as failures", () => {
    expect(() => parseChatResponse({ choices: [{ message: { content: "boom" }, finish_reason: "error" }] }, "Hermes")).toThrow(
      "Hermes reported an error: boom",
    );
    expect(() => parseChatResponse({ choices: [{ message: { content: "" }, finish_reason: "cancelled" }] }, "Hermes")).toThrow(
      "Hermes cancelled the run",
    );
  });

  it("keeps a budget-exhausted wrap-up as a usable answer", () => {
    expect(parseChatResponse({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] }, "Hermes").text).toBe("partial");
  });

  it("rejects empty replies and leaves usage undefined when not reported", () => {
    expect(() => parseChatResponse({ choices: [] }, "X")).toThrow("X returned an empty reply");
    expect(parseChatResponse({ choices: [{ message: { content: "a" } }] }, "X").usage).toBeUndefined();
  });
});

describe("resolveConnector billing guard", () => {
  const grok = () =>
    normalizeAgent(
      {
        id: "grok",
        model: "grok-4",
        connectors: [
          { kind: "webhook", label: "Grok Bot webhook", billing: "subscription", requiresEnv: ["T_GROK_HOOK"] },
          { kind: "openai", label: "xAI API", billing: "metered", requiresEnv: ["T_XAI_KEY"] },
        ],
      },
      0,
    );
  const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  it("blocks a pay-per-use key by default, even when it is set", () => {
    withEnv({ T_XAI_KEY: "sk-paid", T_GROK_HOOK: undefined, RELAY_ALLOW_METERED: undefined }, () => {
      const r = resolveConnector(grok());
      expect(r).toMatchObject({ live: false, blocked: true });
      expect(r.label).toBe("Off · xAI API is pay-per-use (blocked)");
    });
  });

  it("uses the paid API only when explicitly allowed", () => {
    withEnv({ T_XAI_KEY: "sk-paid", T_GROK_HOOK: undefined, RELAY_ALLOW_METERED: "true" }, () => {
      expect(resolveConnector(grok())).toMatchObject({ live: true, label: "xAI API", billing: "metered" });
    });
  });

  it("prefers the subscription webhook when both are set", () => {
    withEnv({ T_XAI_KEY: "sk-paid", T_GROK_HOOK: "https://hook", RELAY_ALLOW_METERED: "true" }, () => {
      expect(resolveConnector(grok())).toMatchObject({ live: true, label: "Grok Bot webhook", billing: "subscription" });
    });
  });

  it("reports a missing CLI as an install hint", () => {
    const a = normalizeAgent(
      { id: "c", model: "m", connectors: [{ kind: "cli", label: "Tool", billing: "subscription", command: "relay-test-missing-cli-xyz" }] },
      0,
    );
    expect(resolveConnector(a)).toMatchObject({ live: false, label: "Demo · install relay-test-missing-cli-xyz" });
  });
});

describe("parseCliOutput", () => {
  it("passes plain text through", () => {
    expect(parseCliOutput("  answer \n", "text", "Tool").text).toBe("answer");
    expect(() => parseCliOutput("   ", "text", "Tool")).toThrow("empty reply");
  });
});

describe("ClinePass guard", () => {
  const cp: ConnectorConfig = {
    kind: "openai",
    label: "ClinePass",
    billing: "subscription",
    modelPrefix: "cline-pass/",
    headers: { "X-Response-Format": "openai" },
    body: { stream: false },
  };
  const mk = (model: string) => normalizeAgent({ id: "cline", model }, 0);

  it("allows cline-pass models and refuses others that would bill credits", () => {
    const saved = process.env.RELAY_ALLOW_METERED;
    delete process.env.RELAY_ALLOW_METERED;
    try {
      expect(coveredModel(mk("cline-pass/glm-5.3"), cp).error).toBeUndefined();
      expect(coveredModel(mk("anthropic/claude-sonnet-4-6"), cp).error).toMatch(/isn't included in ClinePass.*cline-pass\//);
    } finally {
      if (saved !== undefined) process.env.RELAY_ALLOW_METERED = saved;
    }
  });

  it("sends stream:false and lets a connector override the model id", () => {
    expect(buildChatBody(mk("cline-pass/glm-5.3"), cp, "hi")).toMatchObject({ stream: false, model: "cline-pass/glm-5.3" });
    expect(buildChatBody(mk("cline-pass/x"), { kind: "openai", label: "Meta", model: "muse-spark-1.1" }, "hi").model).toBe("muse-spark-1.1");
  });

  it("unwraps Cline's legacy {success, data} response shape", () => {
    const legacy = { success: true, data: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } } };
    expect(parseChatResponse(legacy as never, "ClinePass")).toMatchObject({ text: "ok", usage: { input: 3, output: 1 } });
  });
});

describe("networkReason", () => {
  it("explains common network failures", () => {
    const fail = (code?: string, message?: string) => Object.assign(new TypeError("fetch failed"), { cause: { code, message } });
    expect(networkReason(fail("ECONNREFUSED"))).toMatch(/is it running/);
    expect(networkReason(fail("ENOTFOUND"))).toMatch(/address not found/);
    expect(networkReason(fail(undefined, "proxy said no"))).toBe("proxy said no");
    expect(networkReason(new Error("plain"))).toBe("plain");
  });
});

describe("Antigravity CLI", () => {
  it("reads agy's JSON envelope, counting thinking tokens as output", () => {
    const out = JSON.stringify({ status: "SUCCESS", response: "ok\n", usage: { input_tokens: 100, output_tokens: 5, thinking_tokens: 20 } });
    expect(parseCliOutput(out, "agy-json", "Antigravity")).toEqual({ text: "ok", usage: { input: 100, output: 25 } });
  });

  it("turns agy errors into readable messages", () => {
    expect(() => parseCliOutput(JSON.stringify({ status: "ERROR", error: "authentication required" }), "agy-json", "Antigravity")).toThrow(
      "not signed in",
    );
    expect(() =>
      parseCliOutput(JSON.stringify({ status: "ERROR", error: "invalid model selection\nAvailable models: ..." }), "agy-json", "Antigravity"),
    ).toThrow("Antigravity: invalid model selection");
  });

  it("stays off until the opt-in switch is truly on", () => {
    const a = normalizeAgent(
      { id: "g", model: "default", connectors: [{ kind: "cli", label: "agy", billing: "subscription", command: "sh", requiresEnv: ["T_AGY_ON"] }] },
      0,
    );
    const saved = process.env.T_AGY_ON;
    try {
      for (const off of ["", "false", "0", "no", "off"]) {
        process.env.T_AGY_ON = off;
        expect(resolveConnector(a).live).toBe(false);
      }
      process.env.T_AGY_ON = "true";
      expect(resolveConnector(a).live).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.T_AGY_ON;
      else process.env.T_AGY_ON = saved;
    }
  });
});
