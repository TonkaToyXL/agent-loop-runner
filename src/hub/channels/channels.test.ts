import { describe, expect, it } from "vitest";
import { toPlainText } from "../hub.js";
import { normalizeHandle } from "./imessage.js";
import { chunk } from "./telegram.js";

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
