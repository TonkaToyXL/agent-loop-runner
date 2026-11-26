import type { Approval } from "../approvals.js";
import { errorText } from "../errors.js";
import type { ChannelAdapter, Hub } from "../hub.js";
import type { ChannelStatus } from "../types.js";

const API = process.env.TELEGRAM_API_BASE?.trim() || "https://api.telegram.org";
const MAX_LEN = 4000;

export function chunk(text: string, size = MAX_LEN): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf("\n", size);
    const at = cut > size / 2 ? cut : size;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

interface Update {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { first_name?: string; username?: string };
    text?: string;
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { message_id: number; chat: { id: number } };
  };
}

/** Text of an approval message, before and after the decision. */
export function approvalText(a: Approval): string {
  if (a.kind === "question") {
    const head =
      a.status === "pending"
        ? `❓ ${a.agentName} has a question`
        : a.status === "approved"
          ? `✅ Answered: ${a.answer ?? ""}`
          : a.status === "denied"
            ? "⏭ Skipped, so the task stopped"
            : "⌛ No answer in time, so the task stopped";
    const foot = a.status === "pending" ? `\n\nReply to this message with your answer, or tap Skip.  (id ${a.id})` : `\n\n(id ${a.id})`;
    return `${head}\n\n${a.detail.slice(0, 900)}${foot}`;
  }
  const head =
    a.status === "pending"
      ? "🛡 Needs your OK"
      : a.status === "approved"
        ? "✅ Approved"
        : a.status === "denied"
          ? "❌ Denied"
          : "⌛ No answer in time, so denied";
  const mins = Math.max(1, Math.round((Date.parse(a.expiresAt) - Date.parse(a.createdAt)) / 60_000));
  const foot = a.status === "pending" ? `\n\nNo answer in ${mins} min = deny.  (id ${a.id})` : `\n\n(id ${a.id})`;
  return `${head}\n${a.title}\n\n${a.detail.slice(0, 900)}${foot}`;
}

/** Parse button data "ap:<id>:y|n". */
export function parseApprovalButton(data: string | undefined): { id: string; approve: boolean } | null {
  const m = /^ap:([0-9a-f]{6}):(y|n)$/.exec(data ?? "");
  return m ? { id: m[1], approve: m[2] === "y" } : null;
}

/** Build Telegram's / command menu, including every active assistant. */
export function buildBotCommands(agents: { id: string; name: string; tagline?: string }[]): { command: string; description: string }[] {
  const agentCmds = agents
    .filter((a) => /^[a-z0-9_]{1,32}$/.test(a.id))
    .map((a) => ({
      command: a.id,
      description: (`Ask ${a.name}${a.tagline ? ` — ${a.tagline}` : ""}`).slice(0, 120),
    }));
  return [
    { command: "team", description: "Give the crew a goal" },
    ...agentCmds,
    { command: "agents", description: "Models, reasoning, usage" },
    { command: "status", description: "What's running now" },
    { command: "approvals", description: "What's waiting for your OK" },
    { command: "doctor", description: "Check that everything is connected" },
    { command: "board", description: "Who did the most work" },
    { command: "inbox", description: "Recent email (read-only)" },
    { command: "help", description: "How to talk to the crew" },
  ];
}

/** Telegram bot via long polling: no public URL or webhook needed. */
export class TelegramChannel implements ChannelAdapter {
  readonly name = "telegram" as const;
  private offset = 0;
  private running = false;
  private connected = false;
  private detail = "";
  private botUsername = "";
  private abort = new AbortController();
  /** Approval id -> the messages that show it, so they can be updated after a decision. */
  private readonly approvalMessages = new Map<string, { chatId: string; messageId: number }[]>();
  /** "chatId:messageId" of a question message -> question id, so a swipe-reply answers it. */
  private readonly questionMessages = new Map<string, string>();

  constructor(
    private readonly hub: Hub,
    private readonly token: string,
    private readonly allowed: Set<string>,
  ) {}

  status(): ChannelStatus {
    return { name: this.name, enabled: true, connected: this.connected, detail: this.detail };
  }

  private async call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
    return data.result;
  }

  async send(chatId: string, text: string): Promise<void> {
    for (const part of chunk(text)) {
      await this.call("sendMessage", { chat_id: chatId, text: part, disable_web_page_preview: true });
    }
  }

  approvalTargets(): string[] {
    return [...this.allowed];
  }

  async sendApproval(chatId: string, approval: Approval): Promise<void> {
    const buttons =
      approval.kind === "question"
        ? [[{ text: "⏭ Skip", callback_data: `ap:${approval.id}:n` }]]
        : [
            [
              { text: "✅ Approve", callback_data: `ap:${approval.id}:y` },
              { text: "❌ Deny", callback_data: `ap:${approval.id}:n` },
            ],
          ];
    const msg = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: approvalText(approval),
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buttons },
    });
    if (approval.kind === "question") this.questionMessages.set(`${chatId}:${msg.message_id}`, approval.id);
    const list = this.approvalMessages.get(approval.id) ?? [];
    list.push({ chatId, messageId: msg.message_id });
    this.approvalMessages.set(approval.id, list);
  }

  async updateApproval(approval: Approval): Promise<void> {
    if (approval.status === "pending") return;
    const list = this.approvalMessages.get(approval.id) ?? [];
    this.approvalMessages.delete(approval.id);
    for (const { chatId, messageId } of list) {
      // Replacing the text without reply_markup also removes the buttons.
      await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: approvalText(approval) }).catch(() => {});
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort.abort();
  }

  private setState(connected: boolean, detail: string): void {
    if (connected === this.connected && detail === this.detail) return;
    this.connected = connected;
    this.detail = detail;
    this.hub.emitChannels();
  }

  private async loop(): Promise<void> {
    try {
      const me = await this.call<{ username: string }>("getMe", {});
      this.botUsername = me.username;
      this.setState(true, `@${me.username}`);
      await this.call("setMyCommands", {
        commands: buildBotCommands(this.hub.agents()),
      }).catch(() => {});
    } catch (err) {
      this.setState(false, err instanceof Error ? err.message : "getMe failed");
    }

    let backoff = 1000;
    while (this.running) {
      try {
        const updates = await this.call<Update[]>(
          "getUpdates",
          { offset: this.offset, timeout: 50, allowed_updates: ["message", "callback_query"] },
          AbortSignal.any([this.abort.signal, AbortSignal.timeout(65_000)]),
        );
        backoff = 1000;
        if (!this.connected) this.setState(true, this.botUsername ? `@${this.botUsername}` : "polling");
        for (const update of updates) {
          this.offset = update.update_id + 1;
          void this.onMessage(update);
        }
      } catch (err) {
        if (!this.running) return;
        this.setState(false, err instanceof Error ? err.message : "poll failed");
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async onButton(q: NonNullable<Update["callback_query"]>): Promise<void> {
    const chatId = String(q.message?.chat.id ?? "");
    const parsed = parseApprovalButton(q.data);
    // Only the owner's chats can decide, whoever else might see the message.
    if (!parsed || !this.allowed.has(chatId)) {
      await this.call("answerCallbackQuery", { callback_query_id: q.id, text: "Not allowed." }).catch(() => {});
      return;
    }
    const a = this.hub.decideApproval(parsed.id, parsed.approve, "telegram");
    const text = !a
      ? "That request is gone."
      : a.decidedVia === "telegram" && (a.status === "approved" || a.status === "denied")
        ? a.status === "approved"
          ? "Approved"
          : "Denied"
        : `Already ${a.status}`;
    // The message itself is updated by updateApproval() for every chat that got it.
    await this.call("answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
  }

  private async onMessage(update: Update): Promise<void> {
    if (update.callback_query) return this.onButton(update.callback_query);
    const msg = update.message;
    if (!msg?.text) return;
    const chatId = String(msg.chat.id);
    if (!this.allowed.has(chatId)) {
      // Only tells the sender their own chat id, so the owner can allowlist it.
      await this.send(chatId, `Not authorized. Your chat id is ${chatId}. Add it to TELEGRAM_ALLOWED_CHAT_IDS to use this hub.`).catch(() => {});
      return;
    }
    // A reply to a question message is the answer.
    const repliedTo = msg.reply_to_message ? this.questionMessages.get(`${chatId}:${msg.reply_to_message.message_id}`) : undefined;
    if (repliedTo) {
      const a = this.hub.answerQuestion(repliedTo, msg.text, "telegram");
      await this.send(chatId, a?.status === "approved" ? `✅ Sent your answer to ${a.agentName}.` : `That question was already ${a?.status ?? "closed"}.`);
      return;
    }
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    try {
      const { reply } = await this.hub.handleText(msg.text, {
        channel: "telegram",
        chatId,
        from: msg.from?.username ?? msg.from?.first_name,
      });
      await this.send(chatId, reply);
    } catch (err) {
      await this.send(chatId, `Error: ${errorText(err)}`).catch(() => {});
    }
  }
}
