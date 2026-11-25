import { randomUUID } from "node:crypto";
import type { Approval } from "../approvals.js";
import type { ChannelAdapter, Hub } from "../hub.js";
import type { ChannelStatus } from "../types.js";

/**
 * iMessage through a BlueBubbles server running on a Mac.
 * Inbound: BlueBubbles posts "new-message" webhooks to /hooks/imessage?token=...
 * Outbound: POST {server}/api/v1/message/text?password=...
 */
export interface BlueBubblesMessage {
  type?: string;
  data?: {
    text?: string | null;
    isFromMe?: boolean;
    handle?: { address?: string } | null;
    chats?: { guid?: string }[];
  };
}

export function normalizeHandle(handle: string): string {
  const h = handle.trim().toLowerCase();
  if (h.includes("@")) return h;
  const digits = h.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : `+1${digits.replace(/^1(?=\d{10}$)/, "")}`;
}

export class IMessageChannel implements ChannelAdapter {
  readonly name = "imessage" as const;
  private connected = false;
  private detail = "waiting for BlueBubbles";
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly hub: Hub,
    private readonly serverUrl: string,
    private readonly password: string,
    private readonly allowed: Set<string>,
    readonly hookToken: string,
  ) {}

  status(): ChannelStatus {
    return { name: this.name, enabled: true, connected: this.connected, detail: this.detail };
  }

  private url(path: string): string {
    const u = new URL(path, this.serverUrl.replace(/\/$/, "") + "/");
    u.searchParams.set("password", this.password);
    return u.toString();
  }

  start(): void {
    const ping = async () => {
      try {
        const res = await fetch(this.url("api/v1/ping"), { signal: AbortSignal.timeout(8000) });
        this.set(res.ok, res.ok ? "BlueBubbles reachable" : `BlueBubbles HTTP ${res.status}`);
      } catch (err) {
        this.set(false, err instanceof Error ? err.message : "unreachable");
      }
    };
    void ping();
    this.timer = setInterval(ping, 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private set(connected: boolean, detail: string): void {
    if (connected === this.connected && detail === this.detail) return;
    this.connected = connected;
    this.detail = detail;
    this.hub.emitChannels();
  }

  /** iMessage has no buttons: ask for a one-word reply instead. */
  async sendApproval(chatGuid: string, approval: Approval): Promise<void> {
    if (approval.kind === "question") {
      await this.send(
        chatGuid,
        `❓ ${approval.agentName} has a question:\n\n${approval.detail.slice(0, 700)}\n\nReply "answer ${approval.id} <your answer>", or "no ${approval.id}" to skip.`,
      );
      return;
    }
    await this.send(
      chatGuid,
      `🛡 Needs your OK\n${approval.title}\n\n${approval.detail.slice(0, 700)}\n\nReply "yes ${approval.id}" to allow or "no ${approval.id}" to block. No answer in 15 min = no.`,
    );
  }

  async send(chatGuid: string, text: string): Promise<void> {
    const res = await fetch(this.url("api/v1/message/text"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatGuid, tempGuid: `relay-${randomUUID()}`, message: text, method: "apple-script" }),
    });
    if (!res.ok) throw new Error(`BlueBubbles send HTTP ${res.status}`);
  }

  /** Called by the HTTP server for each BlueBubbles webhook. */
  async onWebhook(payload: BlueBubblesMessage): Promise<void> {
    if (payload.type !== "new-message" || !payload.data) return;
    const { text, isFromMe, handle, chats } = payload.data;
    // Ignore our own outgoing messages so replies never loop back in.
    if (isFromMe || !text || !handle?.address) return;
    const sender = normalizeHandle(handle.address);
    if (!this.allowed.has(sender)) {
      console.warn(`[imessage] ignored message from non-allowlisted ${sender}`);
      return;
    }
    const chatGuid = chats?.[0]?.guid ?? `iMessage;-;${handle.address}`;
    this.set(true, "receiving");
    try {
      const { reply } = await this.hub.handleText(text, { channel: "imessage", chatId: chatGuid, from: sender });
      await this.send(chatGuid, reply);
    } catch (err) {
      await this.send(chatGuid, `Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    }
  }
}
