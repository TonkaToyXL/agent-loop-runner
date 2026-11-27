import { describe, expect, it } from "vitest";
import { isRollCall, parseCommand, pickAgent, resolveAgent } from "./router.js";

const agents = [
  { id: "grok", name: "Grok" },
  { id: "muse", name: "Muse" },
  { id: "hermes", name: "Hermes" },
];

describe("parseCommand", () => {
  it("routes @mentions to one agent", () => {
    expect(parseCommand("@grok what's trending?", agents)).toEqual({ type: "ask", agentId: "grok", text: "what's trending?" });
    expect(parseCommand("@Muse, write a hook", agents)).toEqual({ type: "ask", agentId: "muse", text: "write a hook" });
  });

  it("treats @team, @all and /team as team goals", () => {
    expect(parseCommand("@team launch plan", agents)).toEqual({ type: "team", text: "launch plan" });
    expect(parseCommand("@all launch plan", agents)).toEqual({ type: "team", text: "launch plan" });
    expect(parseCommand("/team launch plan", agents)).toEqual({ type: "team", text: "launch plan" });
    expect(parseCommand("/team", agents).type).toBe("error");
  });

  it("supports /agent shortcuts and plain text auto-routing", () => {
    expect(parseCommand("/hermes fix the build", agents)).toEqual({ type: "ask", agentId: "hermes", text: "fix the build" });
    expect(parseCommand("just do something", agents)).toEqual({ type: "auto", text: "just do something" });
  });

  it("parses model and reasoning edits", () => {
    expect(parseCommand("/model grok grok-4-fast", agents)).toEqual({ type: "model", agentId: "grok", model: "grok-4-fast" });
    expect(parseCommand("/reasoning hermes HIGH", agents)).toEqual({ type: "reasoning", agentId: "hermes", reasoning: "high" });
    expect(parseCommand("/reasoning hermes ultra", agents).type).toBe("error");
    expect(parseCommand("/model nobody x", agents).type).toBe("error");
  });

  it("strips Telegram bot suffixes from commands and guides bare agent mentions", () => {
    const fullCrew = [...agents, { id: "cline", name: "Cline" }, { id: "zen", name: "Zen" }, { id: "chatgpt", name: "ChatGPT" }];
    expect(parseCommand("/status@RelayCrewBot", fullCrew)).toEqual({ type: "status" });
    expect(parseCommand("/chatgpt@Relay_xl_bot summarize this", fullCrew)).toEqual({
      type: "ask",
      agentId: "chatgpt",
      text: "summarize this",
    });
    expect(parseCommand("@gpt quick check", fullCrew)).toEqual({ type: "ask", agentId: "chatgpt", text: "quick check" });
    expect(parseCommand("/codex quick check", fullCrew)).toEqual({ type: "ask", agentId: "chatgpt", text: "quick check" });
    expect(parseCommand("/chatgpt", fullCrew)).toEqual({ type: "error", message: "Usage: /chatgpt <your ask> (or @chatgpt <your ask>)" });
    expect(parseCommand("@zen", fullCrew)).toEqual({ type: "error", message: "Usage: @zen <your ask>" });
  });

  it("reports unknown agents and commands", () => {
    expect(parseCommand("@nobody hi", agents)).toEqual({ type: "error", message: "No agent called @nobody. Try /agents." });
    expect(parseCommand("/dance", agents).type).toBe("error");
    expect(parseCommand("   ", agents).type).toBe("error");
  });
});

describe("resolveAgent", () => {
  it("matches id or name, case-insensitive", () => {
    expect(resolveAgent("@HERMES", agents)).toBe("hermes");
    expect(resolveAgent("zeus", agents)).toBeNull();
  });
});

describe("pickAgent", () => {
  const crew = [
    { id: "grok", skills: ["x", "news", "trends"], enabled: true },
    { id: "muse", skills: ["write", "caption", "hooks"], enabled: true },
    { id: "hermes", skills: ["code", "build", "debug"], enabled: true },
  ];

  it("picks the best skill match", () => {
    expect(pickAgent("latest news and trends on X", crew, "hermes")).toBe("grok");
    expect(pickAgent("write a caption", crew, "hermes")).toBe("muse");
  });

  it("falls back when nothing matches or the match is disabled", () => {
    expect(pickAgent("hello there", crew, "hermes")).toBe("hermes");
    expect(pickAgent("write a caption", [{ ...crew[1], enabled: false }, crew[2]], "hermes")).toBe("hermes");
  });

  it("matches word stems like debugging/writing/trending and prefers idle teammates on ties", () => {
    expect(pickAgent("help me debugging this script", crew, "muse")).toBe("hermes");
    expect(pickAgent("I am writing a tagline", crew, "hermes")).toBe("muse");
    expect(pickAgent("what is trending today", [{ id: "grok", skills: ["trend"], enabled: true }, crew[2]], "hermes")).toBe("grok");
    expect(
      pickAgent(
        "review this code",
        [
          { id: "cline", skills: ["code", "review"], enabled: true, busy: 2 },
          { id: "zen", skills: ["code", "review"], enabled: true, busy: 0 },
        ],
        "cline",
      ),
    ).toBe("zen");
  });

  it("routes real-world intents accurately across the full crew and conserves quota on ties", () => {
    const full = [
      { id: "grok", skills: ["x", "news", "trends", "realtime"], enabled: true },
      { id: "muse", skills: ["write", "copy", "hooks", "caption"], enabled: true },
      { id: "hermes", skills: ["code", "terminal", "files", "automate", "deploy"], enabled: true, actsInWorld: true },
      { id: "cline", skills: ["code", "debug", "refactor", "regex", "sql", "typescript"], enabled: true },
      { id: "zen", skills: ["review", "critique", "audit", "compare", "analysis"], enabled: true },
      { id: "chatgpt", skills: ["strategy", "second-opinion", "chatgpt"], enabled: true, conserveQuota: true },
    ];
    expect(pickAgent("What's new in AI today?", full, "hermes")).toBe("grok");
    expect(pickAgent("Restart the LaunchAgent on my Mac mini", full, "hermes")).toBe("hermes");
    expect(pickAgent("Pitch 3 sharp hooks for my YouTube video", full, "hermes")).toBe("muse");
    expect(pickAgent("Fix this TypeScript bug in my regex", full, "hermes")).toBe("cline");
    expect(pickAgent("write a python script to parse CSV", full, "hermes")).toBe("cline");
    expect(pickAgent("Pressure-test this design and list tradeoffs", full, "hermes")).toBe("zen");
    expect(pickAgent("Give me a second opinion on this strategic decision", full, "hermes")).toBe("chatgpt");
    expect(
      pickAgent(
        "quick strategy note",
        [
          { id: "chatgpt", skills: ["strategy"], enabled: true, conserveQuota: true },
          { id: "zen", skills: ["strategy"], enabled: true, conserveQuota: false },
        ],
        "chatgpt",
      ),
    ).toBe("zen");
  });
});

describe("isRollCall", () => {
  it("recognizes asks for every assistant to check in", () => {
    for (const t of [
      "make sure all bots are responsive, say hello",
      "everyone say hi",
      "roll call",
      "are all the agents online?",
      "ping every assistant",
      "each of the bots check in please",
    ]) {
      expect(isRollCall(t), t).toBe(true);
    }
  });
  it("leaves real team goals and single asks alone", () => {
    for (const t of [
      "research AI news and write 3 hooks",
      "say hello to my mom in Spanish",
      "write a hello world in rust",
      "everyone should review this architecture doc and list risks before Friday's launch meeting with the whole product and design org",
      "what's trending on X",
    ]) {
      expect(isRollCall(t), t).toBe(false);
    }
  });
});

describe("phone commands", () => {
  it("parses /plan, /launch, /runs, and /dashboard", () => {
    expect(parseCommand("/plan write a launch post", agents)).toEqual({ type: "plan", text: "write a launch post" });
    expect(parseCommand("/plan", agents).type).toBe("error");
    expect(parseCommand("/launch AB12cd", agents)).toEqual({ type: "planAction", id: "ab12cd", action: "go" });
    expect(parseCommand("/runs", agents)).toEqual({ type: "runs" });
    expect(parseCommand("/dashboard", agents)).toEqual({ type: "dashboard" });
    expect(parseCommand("/phone@RelayCrewBot", agents)).toEqual({ type: "dashboard" });
  });
});
