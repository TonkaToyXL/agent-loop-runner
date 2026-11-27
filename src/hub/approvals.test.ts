import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalText, parseApprovalButton } from "./channels/telegram.js";
import { ApprovalDesk, riskyAction, type Approval } from "./approvals.js";
import { pendingControls } from "./connectors.js";
import { parseCommand } from "./router.js";

const req = { taskId: "t1", agentId: "hermes", agentName: "Hermes", source: "relay" as const, title: "Send email", detail: "to Bob" };

describe("ApprovalDesk", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves true only on approve, and reports changes", async () => {
    const seen: string[] = [];
    const desk = new ApprovalDesk((a, created) => seen.push(`${created ? "new" : a.status}`), 60_000);
    const { approval, decision } = desk.request(req);
    expect(approval.id).toMatch(/^[0-9a-f]{6}$/);
    expect(desk.pending()).toHaveLength(1);
    desk.decide(approval.id, true, "telegram");
    await expect(decision).resolves.toBe(true);
    expect(approval).toMatchObject({ status: "approved", decidedVia: "telegram" });
    expect(seen).toEqual(["new", "approved"]);
  });

  it("denies on deny, on timeout, and when the task is cancelled", async () => {
    const desk = new ApprovalDesk(() => {}, 60_000);
    const a = desk.request(req);
    desk.decide(a.approval.id, false, "web");
    await expect(a.decision).resolves.toBe(false);

    const b = desk.request(req);
    vi.advanceTimersByTime(60_001);
    await expect(b.decision).resolves.toBe(false);
    expect(b.approval.status).toBe("expired");

    const c = desk.request({ ...req, taskId: "t9" });
    desk.cancelForTask("t9");
    await expect(c.decision).resolves.toBe(false);
    expect(c.approval.status).toBe("denied");
  });

  it("decides once: a second answer doesn't flip the first", async () => {
    const desk = new ApprovalDesk(() => {}, 60_000);
    const { approval, decision } = desk.request(req);
    expect(desk.decideDetailed(approval.id, false, "telegram").changed).toBe(true);
    expect(desk.decideDetailed(approval.id, false, "telegram").changed).toBe(false);
    desk.decide(approval.id, true, "web");
    await expect(decision).resolves.toBe(false);
    expect(approval.status).toBe("denied");
    expect(desk.decide("ffffff", true, "web")).toBeUndefined();
  });
});

describe("riskyAction", () => {
  it("flags tasks that could act for you", () => {
    for (const t of ["Send an email to Bob", "post this on X", "buy the cheapest flight", "delete old files", "Reply to Sarah's message", "pay the invoice", "book a table for two", "order me a pizza"]) {
      expect(riskyAction(t)).not.toBeNull();
    }
  });
  it("leaves plain thinking and writing alone", () => {
    for (const t of ["summarize this article", "draft three taglines", "what's trending about AI agents", "plan my week", "summarize this book", "sort these in order of size"]) {
      expect(riskyAction(t)).toBeNull();
    }
  });
  it("catches everyday phrasings of outreach, money, and machine actions", () => {
    for (const t of [
      "tell Sam I'm running late",
      "let the team know we shipped",
      "ping the group chat",
      "invite Jess to Friday's call",
      "retweet this thread",
      "unfollow these spam accounts",
      "venmo Alex $20 for lunch",
      "sell my Tesla shares",
      "push it to main",
      "git push the fix",
      "commit these changes",
      "run the cleanup script",
      "rm -rf the old build folder",
      "restart the server",
      "go live with the new page",
    ]) {
      expect(riskyAction(t), t).not.toBeNull();
    }
  });
  it("doesn't flag research that mentions those words", () => {
    for (const t of [
      "tell me what's trending on X",
      "latest on the government shutdown",
      "reactions to the US trade war",
      "who is in charge of xAI now",
      "why the Tesla sell-off happened",
      "explain push notifications",
      "summarize reactions to the GPT-6 launch",
      "what's ClinePass's refund policy",
      "find the best bet for a budget laptop",
    ]) {
      expect(riskyAction(t), t).toBeNull();
    }
  });
});

describe("approval commands", () => {
  const agents = [{ id: "hermes", name: "Hermes" }];
  it("parses yes/no/approve/deny with an id", () => {
    expect(parseCommand("/approve a1b2c3", agents)).toEqual({ type: "decide", id: "a1b2c3", approve: true });
    expect(parseCommand("yes A1B2C3", agents)).toEqual({ type: "decide", id: "a1b2c3", approve: true });
    expect(parseCommand("no a1b2c3", agents)).toEqual({ type: "decide", id: "a1b2c3", approve: false });
    expect(parseCommand("/deny a1b2c3", agents)).toEqual({ type: "decide", id: "a1b2c3", approve: false });
    expect(parseCommand("/approvals", agents)).toEqual({ type: "approvals" });
  });
  it("doesn't mistake normal messages for answers", () => {
    expect(parseCommand("yes please write it", agents).type).toBe("auto");
    expect(parseCommand("/approve", agents).type).toBe("error");
  });
});

describe("Telegram approval buttons", () => {
  it("round-trips button data", () => {
    expect(parseApprovalButton("ap:a1b2c3:y")).toEqual({ id: "a1b2c3", approve: true });
    expect(parseApprovalButton("ap:a1b2c3:n")).toEqual({ id: "a1b2c3", approve: false });
    expect(parseApprovalButton("ap:zzz:y")).toBeNull();
    expect(parseApprovalButton(undefined)).toBeNull();
  });
  it("shows the outcome after a decision", () => {
    const a: Approval = { ...req, kind: "approval", id: "a1b2c3", status: "pending", createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T00:15:00Z" };
    expect(approvalText(a)).toContain("No answer in 15 min = deny");
    expect(approvalText({ ...a, status: "approved" })).toMatch(/^✅ Approved/);
    expect(approvalText({ ...a, status: "expired" })).toMatch(/^⌛/);
  });
});

describe("Hermes pending_controls", () => {
  it("reads documented identity fields and a readable summary", () => {
    const run = { status: "waiting_for_approval", pending_controls: [{ prompt_id: "p1", execution_generation: 3, kind: "approval", tool: "terminal", command: "rm -rf build" }] };
    expect(pendingControls(run)).toEqual([{ requestId: "p1", generation: 3, kind: "approval", summary: "Tool: terminal\nrm -rf build" }]);
  });
  it("skips entries without an identity and tolerates odd shapes", () => {
    expect(pendingControls({ pending_controls: [{ tool: "x" }, null, "str"] })).toEqual([]);
    expect(pendingControls({})).toEqual([]);
    expect(pendingControls({ pending_controls: { approvals: [{ request_id: "r", generation: 0 }] } })[0]).toMatchObject({ requestId: "r", generation: 0 });
  });
});

describe("questions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves with the typed answer; a bare yes doesn't count", async () => {
    const desk = new ApprovalDesk(() => {}, 60_000);
    const { approval, answer } = desk.ask({ ...req, title: "Hermes has a question", detail: "Which folder?" });
    expect(approval.kind).toBe("question");
    desk.decide(approval.id, true, "telegram");
    expect(approval.status).toBe("pending");
    desk.answer(approval.id, "  ~/Documents/Relay  ", "telegram");
    await expect(answer).resolves.toBe("~/Documents/Relay");
    expect(approval).toMatchObject({ status: "approved", answer: "~/Documents/Relay" });
  });

  it("resolves null when skipped or unanswered", async () => {
    const desk = new ApprovalDesk(() => {}, 60_000);
    const a = desk.ask(req);
    desk.decide(a.approval.id, false, "telegram");
    await expect(a.answer).resolves.toBeNull();
    const b = desk.ask(req);
    vi.advanceTimersByTime(60_001);
    await expect(b.answer).resolves.toBeNull();
    expect(desk.answer("ffffff", "x", "web")).toBeUndefined();
  });

  it("parses answers and the doctor command", () => {
    const agents = [{ id: "hermes", name: "Hermes" }];
    expect(parseCommand("/answer a1b2c3 use the blue logo", agents)).toEqual({ type: "answer", id: "a1b2c3", text: "use the blue logo" });
    expect(parseCommand("answer A1B2C3 yes, the 3pm slot", agents)).toEqual({ type: "answer", id: "a1b2c3", text: "yes, the 3pm slot" });
    expect(parseCommand("/doctor", agents)).toEqual({ type: "doctor" });
    expect(parseCommand("/health", agents)).toEqual({ type: "doctor" });
    expect(parseCommand("/answer", agents).type).toBe("error");
  });

  it("shows questions in Telegram with reply instructions", () => {
    const q: Approval = { ...req, kind: "question", id: "a1b2c3", status: "pending", detail: "Which folder?", createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T00:15:00Z" };
    expect(approvalText(q)).toContain("❓ Hermes has a question");
    expect(approvalText(q)).toContain("Reply to this message with your answer");
    expect(approvalText({ ...q, status: "approved", answer: "Docs" })).toMatch(/^✅ Answered: Docs/);
    expect(approvalText({ ...q, status: "denied" })).toMatch(/^⏭ Skipped/);
  });
});

describe("error text", () => {
  it("shows only Error messages and marks user-facing errors", async () => {
    const { errorText, PublicError } = await import("./errors.js");
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText({ stack: "at secret.js:1" })).toBe("Unexpected error");
    const e = new PublicError("Pick a cline-pass/ model", 400);
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(400);
  });

  it("never puts command text (which can hold a password) in read-only guard errors", async () => {
    const { assertReadOnly } = await import("./mail/imap.js");
    let message = "";
    try {
      assertReadOnly('XLOGIN "me@x.com" "hunter2secret"');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("Relay's mail reader refused a command that isn't read-only");
    expect(message).not.toContain("hunter2");
  });
});

describe("riskyAction and results that come back to you", () => {
  it("doesn't hold a step that only returns its answer to you", () => {
    for (const t of [
      "Summarize what's trending and send me the top 3",
      "Find the latest news and post a summary here",
      "Respond to this check-in with a hello",
      "share it with me when you're done",
      "research the topic and report back",
    ]) {
      expect(riskyAction(t), t).toBeNull();
    }
  });
  it("still holds anything aimed at the outside world", () => {
    for (const t of [
      "send me an email with the list",
      "send it to Bob",
      "share the results on LinkedIn",
      "post it on X",
      "reply to the message from Sarah",
      "send me $20 on venmo",
      "share it with me and then post it on X",
    ]) {
      expect(riskyAction(t), t).not.toBeNull();
    }
  });
});
