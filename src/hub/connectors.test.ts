import { describe, expect, it } from "vitest";
import { normalizeAgent } from "./config.js";
import { buildChatBody, parseChatResponse } from "./connectors.js";
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
