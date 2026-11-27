import { describe, expect, it } from "vitest";
import { toPlainText } from "../hub.js";
import { normalizeHandle } from "./imessage.js";
import { buildBotCommands, chunk, parseHubButton } from "./telegram.js";

describe("normalizeHandle", () => {
  it("normalizes US numbers in any format", () => {
    for (const raw of ["(512) 555-0100", "512-555-0100", "15125550100", "+1 512 555 0100"]) {
      expect(normalizeHandle(raw)).toBe("+15125550100");
    }
  });

  it("keeps emails and international numbers", () => {
    expect(normalizeHandle(" Me@iCloud.com ")).toBe("me@icloud.com");
    expect(normalizeHandle("+44 20 7946 0958")).toBe("+442079460958");
  });
});

describe("chunk", () => {
  it("keeps short text whole", () => {
    expect(chunk("hello")).toEqual(["hello"]);
  });

  it("splits long text on line breaks under the limit", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const parts = chunk(text, 200);
    expect(parts.every((p) => p.length <= 200)).toBe(true);
    expect(parts.join("\n")).toBe(text);
  });

  it("never splits inside a UTF-16 surrogate pair (emoji)", () => {
    const text = "a".repeat(9) + "🚀" + "b".repeat(5);
    const parts = chunk(text, 10);
    expect(parts[0]).toBe("a".repeat(9));
    expect(parts[1]).toBe("🚀" + "b".repeat(5));
  });
});

describe("buildBotCommands", () => {
  it("includes every active assistant in Telegram's slash command menu", () => {
    const cmds = buildBotCommands([
      { id: "grok", name: "Grok", tagline: "Live scout" },
      { id: "muse", name: "Muse", tagline: "Creative lead" },
      { id: "hermes", name: "Hermes", tagline: "Operator" },
      { id: "cline", name: "Cline", tagline: "Open-model coder" },
      { id: "zen", name: "Zen", tagline: "Analyst" },
      { id: "chatgpt", name: "ChatGPT", tagline: "Generalist" },
    ]);
    const names = cmds.map((c) => c.command);
    expect(names).toContain("team");
    for (const id of ["grok", "muse", "hermes", "cline", "zen", "chatgpt"]) {
      expect(names).toContain(id);
    }
    expect(names).toContain("doctor");
  });
});

describe("toPlainText", () => {
  it("drops markdown markers for chat apps", () => {
    expect(toPlainText("## Plan\n**Bold** and `code` and _soft_ words")).toBe("Plan\nBold and code and soft words");
  });

  it("leaves snake_case alone", () => {
    expect(toPlainText("set XAI_API_KEY now")).toBe("set XAI_API_KEY now");
  });
});

describe("isLocalHost", () => {
  it("accepts loopback hostnames only", async () => {
    const { isLocalHost } = await import("../server.js");
    expect(isLocalHost("127.0.0.1:4747")).toBe(true);
    expect(isLocalHost("localhost:4747")).toBe(true);
    expect(isLocalHost("[::1]:4747")).toBe(true);
    expect(isLocalHost("evil.example.com:4747")).toBe(false);
    expect(isLocalHost("127.0.0.1.evil.com")).toBe(false);
    expect(isLocalHost(undefined)).toBe(false);
  });
});

describe("parseHubButton", () => {
  it("reads plan and verdict buttons and rejects anything else", () => {
    expect(parseHubButton("pl:ab12cd:go")).toEqual({ kind: "plan", id: "ab12cd", action: "go" });
    expect(parseHubButton("pl:ab12cd:cmp")).toEqual({ kind: "plan", id: "ab12cd", action: "cmp" });
    expect(parseHubButton("cv:9f8e7d6c:tie")).toEqual({ kind: "verdict", id: "9f8e7d6c", action: "tie" });
    for (const bad of ["pl:ab12cd:tie", "cv:x:go", "ap:abc123:y", "pl:../../x:go", undefined]) expect(parseHubButton(bad), String(bad)).toBeNull();
  });
});
