import { randomBytes } from "node:crypto";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface Approval {
  id: string;
  /** approval: yes/no. question: the agent needs a typed answer. */
  kind: "approval" | "question";
  taskId: string;
  agentId: string;
  agentName: string;
  /** relay: Relay's own check before a risky task starts. agent: the agent paused mid-task to ask. */
  source: "relay" | "agent";
  title: string;
  detail: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedVia?: string;
  /** For questions: what you answered. */
  answer?: string;
}

export type ApprovalRequest = Pick<Approval, "taskId" | "agentId" | "agentName" | "source" | "title" | "detail">;

const KEEP = 50;
type Outcome = { ok: boolean; answer?: string };

/**
 * Pending approvals and questions. Every request resolves exactly once: approved/answered,
 * denied/skipped, or expired. No answer means no: expiry counts as a denial.
 */
export class ApprovalDesk {
  readonly items: Approval[] = [];
  private readonly waiters = new Map<string, { resolve: (o: Outcome) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly onChange: (approval: Approval, created: boolean) => void,
    private readonly timeoutMs = 15 * 60_000,
  ) {}

  private open(kind: Approval["kind"], req: ApprovalRequest): { approval: Approval; outcome: Promise<Outcome> } {
    const now = Date.now();
    const approval: Approval = {
      ...req,
      kind,
      title: req.title.slice(0, 200),
      detail: req.detail.slice(0, 1500),
      id: randomBytes(3).toString("hex"),
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.timeoutMs).toISOString(),
    };
    this.items.push(approval);
    while (this.items.length > KEEP) {
      const settledIdx = this.items.findIndex((x) => x.status !== "pending");
      if (settledIdx >= 0) {
        this.items.splice(settledIdx, 1);
      } else {
        const evicted = this.items.shift();
        if (evicted && evicted.status === "pending") this.settle(evicted, "expired", "evicted");
      }
    }
    const outcome = new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => this.settle(approval, "expired", "timeout"), this.timeoutMs);
      timer.unref?.();
      this.waiters.set(approval.id, { resolve, timer });
    });
    this.onChange(approval, true);
    return { approval, outcome };
  }

  /** Yes/no. Resolves true only on an explicit approve. */
  request(req: ApprovalRequest): { approval: Approval; decision: Promise<boolean> } {
    const { approval, outcome } = this.open("approval", req);
    return { approval, decision: outcome.then((o) => o.ok) };
  }

  /** A question that needs a typed answer. Resolves null if skipped or unanswered. */
  ask(req: ApprovalRequest): { approval: Approval; answer: Promise<string | null> } {
    const { approval, outcome } = this.open("question", req);
    return { approval, answer: outcome.then((o) => (o.ok && o.answer ? o.answer : null)) };
  }

  get(id: string): Approval | undefined {
    return this.items.find((a) => a.id === id.trim().toLowerCase());
  }

  pending(): Approval[] {
    return this.items.filter((a) => a.status === "pending");
  }

  /** Record a yes/no (or skip, for questions) and report whether this call actually settled it. */
  decideDetailed(id: string, approve: boolean, via: string): { approval?: Approval; changed: boolean } {
    const approval = this.get(id);
    if (!approval) return { changed: false };
    if (approval.status === "pending") {
      if (approval.kind === "question" && approve) return { approval, changed: false }; // a question needs text, not a yes
      this.settle(approval, approve ? "approved" : "denied", via);
      return { approval, changed: true };
    }
    return { approval, changed: false };
  }

  /** Record a yes/no (or skip, for questions). Already-decided items are left as they are. */
  decide(id: string, approve: boolean, via: string): Approval | undefined {
    return this.decideDetailed(id, approve, via).approval;
  }

  /** Answer a question and report whether this call actually settled it. */
  answerDetailed(id: string, text: string, via: string): { approval?: Approval; changed: boolean } {
    const approval = this.get(id);
    if (!approval) return { changed: false };
    const clean = text.trim().slice(0, 2000);
    if (approval.status === "pending" && approval.kind === "question" && clean) {
      this.settle(approval, "approved", via, clean);
      return { approval, changed: true };
    }
    return { approval, changed: false };
  }

  /** Answer a question. */
  answer(id: string, text: string, via: string): Approval | undefined {
    return this.answerDetailed(id, text, via).approval;
  }

  /** Deny everything still waiting for a task (e.g. it was cancelled). */
  cancelForTask(taskId: string, via = "task cancelled"): void {
    for (const a of this.pending()) if (a.taskId === taskId) this.settle(a, "denied", via);
  }

  /** Deny all pending approvals (e.g. during graceful hub shutdown). */
  cancelAll(via = "hub shutdown"): void {
    for (const a of this.pending()) this.settle(a, "denied", via);
  }

  private settle(approval: Approval, status: Exclude<ApprovalStatus, "pending">, via: string, answer?: string): void {
    if (approval.status !== "pending") return;
    approval.status = status;
    approval.decidedAt = new Date().toISOString();
    approval.decidedVia = via;
    if (answer !== undefined) approval.answer = answer;
    const waiter = this.waiters.get(approval.id);
    this.waiters.delete(approval.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: status === "approved", answer });
    }
    this.onChange(approval, false);
  }
}

/**
 * Words that suggest a task could act for you in the outside world (send, post, buy, delete...).
 * Deliberately broad: a false alarm costs one tap, a miss could cost much more.
 * Returns the matching phrase, or null.
 */
const RISKY = new RegExp(
  "\\b(" +
    [
      // Messages and outreach
      String.raw`send|sending|e-?mail(?:ing)?|reply(?:ing)? to|respond to|forward|dm|submit`,
      String.raw`text (?:him|her|them|my)|message (?:him|her|them|my)`,
      String.raw`tell (?!me\b|us\b|you\b|a\b|an\b)\w+|let (?:\w+ ){1,3}know|ping (?:him|her|them|my|the|everyone|@)|notify`,
      String.raw`reach out|contact (?:him|her|them|my|the)|call (?:him|her|them|my|mom|dad)|invite|rsvp`,
      // Social
      String.raw`post(?:ing)?|tweet|retweet|repost|quote[- ]tweet|publish|share|comment on|unfollow|follow (?:him|her|them|back|@)`,
      String.raw`like (?:the|this|that|their|his|her|my) (?:post|tweet|photo|video|reel)`,
      // Money
      String.raw`buy|purchase|order (?:a|an|the|me|my|some|food|it|them)|place (?:an|the|my) order|pay|payment|checkout`,
      String.raw`transfer|wire|venmo|zelle|paypal|cash ?app|donate|tip (?:him|her|them|the)|place a bet|wager`,
      String.raw`(?:sell|trade|swap) (?:my|the|it|them|some|all|\d)|refund (?:my|the|him|her|them|it)|issue a refund`,
      String.raw`charge (?:my|the|their|his|her) (?:card|account|customer)|(?:withdraw|deposit) (?:\$|money|funds|cash)`,
      // Accounts and bookings
      String.raw`subscribe|unsubscribe|cancel (?:my|the|a|an) |book (?:a|an|the|me|my|it|tickets?|flights?|hotel)|reserve`,
      String.raw`sign (?:up|in)|log ?in|accept|decline|(?:grant|revoke) (?:access|permission|him|her|them)`,
      String.raw`change (?:my|the) (?:password|settings|email|plan)|update (?:my|the) (?:profile|bio|settings|status|password)`,
      // Files, code, and machines
      String.raw`delete|remove|erase|wipe|overwrite|rename|move (?:the |my |these |those |all )?files?|chmod|rm -\w+|sudo`,
      String.raw`deploy|merge|upload|install|uninstall|git (?:push|commit|reset)|force[- ]push`,
      String.raw`push (?:it|this|that|the (?:code|changes|branch|fix)|to (?:main|prod|production|github))`,
      String.raw`commit (?:it|this|that|the (?:changes|code|files)|these|those|all)`,
      String.raw`execute|run (?:the|this|that|my|a) (?:script|command|cleanup|job|migration|backup|update|code)`,
      String.raw`kill (?:the|it|this|that|all|process)|(?:restart|reboot|shut down) (?:the|my|it|this|that|your|all)`,
      String.raw`go live|(?:launch|release|ship) (?:it|this|the)`,
    ].join("|") +
    ")\\b",
  "i",
);

export function riskyAction(text: string): string | null {
  const m = RISKY.exec(text);
  return m ? m[0].trim().toLowerCase() : null;
}
