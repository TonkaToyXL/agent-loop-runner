import { randomBytes } from "node:crypto";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface Approval {
  id: string;
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
}

export type ApprovalRequest = Pick<Approval, "taskId" | "agentId" | "agentName" | "source" | "title" | "detail">;

const KEEP = 50;

/**
 * Pending approvals. Every request resolves exactly once: approved, denied, or expired.
 * No answer means no: expiry counts as a denial.
 */
export class ApprovalDesk {
  readonly items: Approval[] = [];
  private readonly waiters = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly onChange: (approval: Approval, created: boolean) => void,
    private readonly timeoutMs = 15 * 60_000,
  ) {}

  request(req: ApprovalRequest): { approval: Approval; decision: Promise<boolean> } {
    const now = Date.now();
    const approval: Approval = {
      ...req,
      title: req.title.slice(0, 200),
      detail: req.detail.slice(0, 1500),
      id: randomBytes(3).toString("hex"),
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.timeoutMs).toISOString(),
    };
    this.items.push(approval);
    if (this.items.length > KEEP) this.items.splice(0, this.items.length - KEEP);
    const decision = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(approval, "expired", "timeout"), this.timeoutMs);
      timer.unref?.();
      this.waiters.set(approval.id, { resolve, timer });
    });
    this.onChange(approval, true);
    return { approval, decision };
  }

  get(id: string): Approval | undefined {
    return this.items.find((a) => a.id === id.trim().toLowerCase());
  }

  pending(): Approval[] {
    return this.items.filter((a) => a.status === "pending");
  }

  /** Record a decision. Returns the approval, or undefined if unknown. Already-decided ones are left as they are. */
  decide(id: string, approve: boolean, via: string): Approval | undefined {
    const approval = this.get(id);
    if (!approval) return undefined;
    if (approval.status === "pending") this.settle(approval, approve ? "approved" : "denied", via);
    return approval;
  }

  /** Deny everything still waiting for a task (e.g. it was cancelled). */
  cancelForTask(taskId: string, via = "task cancelled"): void {
    for (const a of this.pending()) if (a.taskId === taskId) this.settle(a, "denied", via);
  }

  private settle(approval: Approval, status: Exclude<ApprovalStatus, "pending">, via: string): void {
    if (approval.status !== "pending") return;
    approval.status = status;
    approval.decidedAt = new Date().toISOString();
    approval.decidedVia = via;
    const waiter = this.waiters.get(approval.id);
    this.waiters.delete(approval.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(status === "approved");
    }
    this.onChange(approval, false);
  }
}

/**
 * Words that suggest a task could act for you in the outside world (send, post, buy, delete...).
 * Deliberately broad: a false alarm costs one tap, a miss could cost much more.
 * Returns the matching phrase, or null.
 */
export function riskyAction(text: string): string | null {
  const m =
    /\b(send|sending|e-?mail(?:ing)?|reply(?:ing)? to|respond to|forward|post(?:ing)?|tweet|publish|share|buy|purchase|order (?:a|an|the|me|my|some|food|it|them)|place (?:an|the|my) order|pay|payment|checkout|subscribe|unsubscribe|cancel (?:my|the|a|an) |delete|remove|erase|wipe|transfer|wire|book (?:a|an|the|me|my|it|tickets?|flights?|hotel)|reserve|dm|text (?:him|her|them|my)|message (?:him|her|them|my)|submit|sign (?:up|in)|log ?in|deploy|merge|upload|install|uninstall|accept|decline)\b/i.exec(
      text,
    );
  return m ? m[0].trim().toLowerCase() : null;
}
