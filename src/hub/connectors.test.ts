import { describe, expect, it } from "vitest";
import { normalizeAgent } from "./config.js";
import { buildChatBody, cliEnv, coveredModel, networkReason, parseChatResponse, parseCliOutput, parseModelOptions, pickModelForTask, pickReasoningForTask, resolveConnector } from "./connectors.js";
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

describe("opt-in connectors", () => {
  it("stays off until the opt-in switch is truly on", () => {
    const a = normalizeAgent(
      { id: "g", model: "default", connectors: [{ kind: "cli", label: "tool", billing: "subscription", command: "sh", requiresEnv: ["T_OPT_IN"] }] },
      0,
    );
    const saved = process.env.T_OPT_IN;
    try {
      for (const off of ["", "false", "0", "no", "off"]) {
        process.env.T_OPT_IN = off;
        expect(resolveConnector(a).live).toBe(false);
      }
      process.env.T_OPT_IN = "true";
      expect(resolveConnector(a).live).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.T_OPT_IN;
      else process.env.T_OPT_IN = saved;
    }
  });
});

describe("parseModelOptions", () => {
  it("keeps only the currently active authenticated provider's models", () => {
    const parsed = parseModelOptions({
      provider: "nous",
      model: "openai/gpt-6.2-sol",
      providers: [
        { slug: "anthropic", name: "Anthropic", is_current: false, authenticated: true, models: ["claude-opus-5"] },
        { slug: "nous", name: "Nous Portal", is_current: true, authenticated: true, models: ["openai/gpt-6.2-sol", "z-ai/glm-5.3", "openai/gpt-6.2-sol"] },
        { slug: "openrouter", name: "OpenRouter", is_current: false, authenticated: false, models: ["x/y"] },
      ],
    });
    expect(parsed).toEqual({
      provider: "nous",
      providerName: "Nous Portal",
      defaultModel: "openai/gpt-6.2-sol",
      models: ["openai/gpt-6.2-sol", "z-ai/glm-5.3"],
    });
  });

  it("returns null for empty or unauthenticated payloads", () => {
    expect(parseModelOptions(null)).toBeNull();
    expect(parseModelOptions({ providers: [{ slug: "nous", is_current: true, authenticated: false, models: ["a"] }] })).toBeNull();
    expect(parseModelOptions({ providers: [{ slug: "nous", is_current: true, authenticated: true, models: [] }] })).toBeNull();
  });
});

describe("pickModelForTask (auto model mode)", () => {
  const cp: ConnectorConfig = {
    kind: "openai",
    label: "ClinePass",
    billing: "subscription",
    modelPrefix: "cline-pass/",
  };
  const cline = () =>
    normalizeAgent(
      {
        id: "cline",
        model: "auto",
        modelOptions: [
          "auto",
          "anthropic/claude-opus-5",
          "cline-pass/kimi-k3.1-pro",
          "cline-pass/glm-5.3",
          "cline-pass/deepseek-v4-pro",
          "cline-pass/deepseek-v4.1-flash",
          "cline-pass/qwen3.8-max",
          "cline-pass/muse-spark-1.3-contributor",
        ],
      },
      0,
    );

  it("allows auto only when billing-covered models exist", () => {
    const saved = process.env.RELAY_ALLOW_METERED;
    delete process.env.RELAY_ALLOW_METERED;
    try {
      expect(coveredModel(cline(), cp).error).toBeUndefined();
      const unsafe = normalizeAgent({ id: "cline", model: "auto", modelOptions: ["auto", "anthropic/claude-opus-5"] }, 0);
      expect(coveredModel(unsafe, cp).error).toMatch(/Auto model mode needs/);
    } finally {
      if (saved !== undefined) process.env.RELAY_ALLOW_METERED = saved;
    }
  });

  it("picks the right covered ClinePass model for each task shape and never picks uncovered models", () => {
    const saved = process.env.RELAY_ALLOW_METERED;
    delete process.env.RELAY_ALLOW_METERED;
    try {
      const a = cline();
      expect(pickModelForTask(a, cp, "write a regex for a US ZIP code").model).toBe("cline-pass/deepseek-v4.1-flash");
      expect(pickModelForTask(a, cp, "review these 3 taglines and critique their clarity").model).toBe("cline-pass/deepseek-v4-pro");
      expect(pickModelForTask(a, cp, "fix the responsive CSS grid layout for this dashboard component").model).toBe("cline-pass/glm-5.3");
      expect(pickModelForTask(a, cp, "debug and refactor this TypeScript async queue race condition").model).toBe("cline-pass/kimi-k3.1-pro");
      expect(pickModelForTask(a, cp, "write 3 punchy taglines for Relay").model).toBe("cline-pass/muse-spark-1.3-contributor");
      // Explicit model stays fixed
      expect(pickModelForTask({ ...a, model: "cline-pass/qwen3.8-max" }, cp, "write a regex").model).toBe("cline-pass/qwen3.8-max");
    } finally {
      if (saved !== undefined) process.env.RELAY_ALLOW_METERED = saved;
    }
  });

  it("scales auto reasoning effort and picks fast flash models on OpenCode Zen for quick tasks", () => {
    const zenConn: ConnectorConfig = { kind: "openai", label: "OpenCode Zen", billing: "subscription", reasoningParam: "reasoning_effort" };
    const zen = normalizeAgent(
      {
        id: "zen",
        model: "auto",
        reasoning: "auto",
        modelOptions: ["auto", "deepseek-v4.1-flash", "kimi-k3.1-pro", "deepseek-v4-pro", "glm-5.3"],
      },
      0,
    );
    expect(pickModelForTask(zen, zenConn, "write a regex for a ZIP code")).toMatchObject({
      model: "deepseek-v4.1-flash",
      reasoning: "low",
    });
    expect(pickModelForTask(zen, zenConn, "fix the responsive CSS grid layout")).toMatchObject({
      model: "glm-5.3",
      reasoning: "medium",
    });
    expect(pickModelForTask(zen, zenConn, "review this SQL schema for index issues")).toMatchObject({
      model: "deepseek-v4-pro",
      reasoning: "high",
    });
    expect(pickModelForTask(zen, zenConn, "review this SQL schema for index issues", ["deepseek-v4-pro"])).toMatchObject({
      model: "kimi-k3.1-pro",
      reasoning: "high",
    });
    expect(pickModelForTask(zen, zenConn, "do a thorough security audit and system architecture deep dive")).toMatchObject({
      model: "deepseek-v4-pro",
      reasoning: "max",
    });
    expect(pickReasoningForTask("low", "deep dive security audit")).toBe("low");
    expect(buildChatBody(zen, zenConn, "write a regex")).toMatchObject({ reasoning_effort: "low" });
  });

  it("parses codex-jsonl stdout with token usage and unwraps API errors", () => {
    const okOut = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "CODEX_OK" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, output_tokens: 8 } }),
    ].join("\n");
    expect(parseCliOutput(okOut, "codex-jsonl", "Codex CLI")).toEqual({
      text: "CODEX_OK",
      usage: { input: 120, output: 8 },
    });

    const errOut = JSON.stringify({
      type: "turn.failed",
      error: { message: JSON.stringify({ error: { message: "Model not supported" } }) },
    });
    expect(() => parseCliOutput(errOut, "codex-jsonl", "Codex CLI")).toThrow("Model not supported");

    const codexConn: ConnectorConfig = {
      kind: "cli",
      label: "Codex CLI",
      billing: "subscription",
      command: "codex",
      conserveQuota: true,
    };
    const chatgpt = normalizeAgent(
      { id: "chatgpt", model: "auto", reasoning: "auto", modelOptions: ["auto", "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"] },
      0,
    );
    expect(pickModelForTask(chatgpt, codexConn, "write a quick regex")).toMatchObject({ model: "gpt-6-astra", reasoning: "low" });
    expect(pickModelForTask(chatgpt, codexConn, "explain how DNS works")).toMatchObject({ model: "gpt-6-astra", reasoning: "low" });
    expect(pickModelForTask(chatgpt, codexConn, "review this SQL query for slow joins")).toMatchObject({
      model: "gpt-6.1-sol",
      reasoning: "medium",
    });
    expect(pickModelForTask(chatgpt, codexConn, "do a thorough security audit and architecture review")).toMatchObject({
      model: "gpt-6.1-terra",
      reasoning: "high",
    });
    // Explicit reasoning override still works when the user asks for it
    expect(pickModelForTask({ ...chatgpt, reasoning: "max" }, codexConn, "quick check")).toMatchObject({
      model: "gpt-6-astra",
      reasoning: "max",
    });
  });
});

describe("cliEnv", () => {
  it("keeps pay-per-use API keys away from a subscription CLI", () => {
    const base = { PATH: "/bin", OPENAI_API_KEY: "sk-paid", CODEX_API_KEY: "sk-paid2", HOME: "/h" };
    const conn: ConnectorConfig = { kind: "cli", label: "Codex", command: "codex", dropEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"] };
    expect(cliEnv(conn, base)).toEqual({ PATH: "/bin", HOME: "/h" });
    expect(base.OPENAI_API_KEY).toBe("sk-paid");
    expect(cliEnv({ kind: "cli", label: "x", command: "x" }, base)).toBe(base);
  });

  it("is configured on the ChatGPT connector", async () => {
    const { readFileSync } = await import("node:fs");
    const cfg = JSON.parse(readFileSync(new URL("../../relay.config.json", import.meta.url), "utf8"));
    const codex = cfg.agents.find((a: { id: string }) => a.id === "chatgpt").connectors[0];
    expect(codex.dropEnv).toEqual(expect.arrayContaining(["CODEX_API_KEY", "OPENAI_API_KEY"]));
  });
});
