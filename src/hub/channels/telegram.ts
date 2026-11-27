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
    let at = cut > size / 2 ? cut : size;
    // Never split between a UTF-16 high surrogate and low surrogate (e.g. emoji).
    if (at > 0 && at < rest.length) {
      const code = rest.charCodeAt(at - 1);
      if (code >= 0xd800 && code <= 0xdbff) at--;
    }
    if (at <= 0) at = size;
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
/** Plan and comparison buttons: pl:<draft id>:<go|solo|crew|cmp|x> and cv:<comparison id>:<solo|crew|tie>. */
export function parseHubButton(data: string | undefined): { kind: "plan" | "verdict"; id: string; action: string } | null {
  const m = /^(pl|cv):([\w-]{1,24}):(go|solo|crew|cmp|x|tie)$/.exec(data ?? "");
  if (!m) return null;
  if (m[1] === "cv" && !["solo", "crew", "tie"].includes(m[3])) return null;
  if (m[1] === "pl" && m[3] === "tie") return null;
  return { kind: m[1] === "pl" ? "plan" : "verdict", id: m[2], action: m[3] };
}

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
    { command: "plan", description: "See the plan first, then launch it" },
    { command: "team", description: "Give the crew a goal" },
    { command: "runs", description: "What's live and how far along" },
    { command: "dashboard", description: "Open Causeway on this phone" },
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
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    const raw = await res.text();
    let data: { ok: boolean; result: T; description?: string };
    try {
      data = JSON.parse(raw) as { ok: boolean; result: T; description?: string };
    } catch {
      throw new Error(`Telegram ${method} HTTP ${res.status}: non-JSON reply`);
    }
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
    return data.result;
  }

  async send(chatId: string, text: string): Promise<void> {
    for (const part of chunk(text)) {
      await this.call("sendMessage", { chat_id: chatId, text: part, disable_web_page_preview: true });
    }
  }

  async sendButtons(chatId: string, text: string, buttons: { text: string; data: string }[][]): Promise<void> {
    const parts = chunk(text);
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      await this.call("sendMessage", {
        chat_id: chatId,
        text: part,
        disable_web_page_preview: true,
        ...(last && buttons.length ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}),
      });
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
    // If the approval settled on another channel while sendMessage was in flight, update it right away.
    if (approval.status !== "pending") {
      await this.call("editMessageText", { chat_id: chatId, message_id: msg.message_id, text: approvalText(approval) }).catch(() => {});
      return;
    }
    if (approval.kind === "question") this.questionMessages.set(`${chatId}:${msg.message_id}`, approval.id);
    const list = this.approvalMessages.get(approval.id) ?? [];
    list.push({ chatId, messageId: msg.message_id });
    this.approvalMessages.set(approval.id, list);
  }

  async updateApproval(approval: Approval): Promise<void> {
    if (approval.status === "pending") return;
    const list = this.approvalMessages.get(approval.id) ?? [];
    this.approvalMessages.delete(approval.id);
    for (const [key, qId] of this.questionMessages.entries()) {
      if (qId === approval.id) this.questionMessages.delete(key);
    }
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

  private async initBot(): Promise<void> {
    const me = await this.call<{ username: string }>("getMe", {});
    this.botUsername = me.username;
    this.setState(true, `@${me.username}`);
    await this.call("setMyCommands", {
      commands: buildBotCommands(this.hub.agents()),
    }).catch(() => {});
  }

  private async loop(): Promise<void> {
    try {
      await this.initBot();
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
        if (!this.botUsername) {
          void this.initBot().catch(() => {});
        } else if (!this.connected) {
          this.setState(true, `@${this.botUsername}`);
        }
        for (const update of updates) {
          this.offset = update.update_id + 1;
          void this.onMessage(update).catch((err) => console.error("[telegram] update handler failed:", errorText(err)));
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
    const hubBtn = parseHubButton(q.data);
    if (hubBtn) {
      if (!this.allowed.has(chatId)) {
        await this.call("answerCallbackQuery", { callback_query_id: q.id, text: "Not allowed." }).catch(() => {});
        return;
      }
      await this.call("answerCallbackQuery", { callback_query_id: q.id, text: hubBtn.kind === "verdict" ? "Saved" : "On it" }).catch(() => {});
      try {
        const res =
          hubBtn.kind === "plan"
            ? await this.hub.planAction(hubBtn.id, hubBtn.action as "go" | "solo" | "crew" | "cmp" | "x", { channel: "telegram", chatId })
            : this.hub.verdictFromChat(hubBtn.id, hubBtn.action as "solo" | "crew" | "tie");
        if (q.message?.message_id) {
          await this.call("editMessageText", {
            chat_id: chatId,
            message_id: q.message.message_id,
            text: chunk(res.reply)[0],
            disable_web_page_preview: true,
            ...(res.buttons?.length ? { reply_markup: { inline_keyboard: res.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}),
          }).catch(() => this.send(chatId, res.reply));
        } else {
          await this.send(chatId, res.reply);
        }
      } catch (err) {
        await this.send(chatId, `Error: ${errorText(err)}`).catch(() => {});
      }
      return;
    }
    const parsed = parseApprovalButton(q.data);
    // Only the owner's chats can decide, whoever else might see the message.
    if (!parsed || !this.allowed.has(chatId)) {
      await this.call("answerCallbackQuery", { callback_query_id: q.id, text: "Not allowed." }).catch(() => {});
      return;
    }
    const { approval: a, changed } = this.hub.decideApprovalDetailed(parsed.id, parsed.approve, "telegram");
    const text = !a
      ? "That request is gone."
      : changed
        ? a.status === "approved"
          ? "Approved"
          : "Denied"
        : a.kind === "question" && parsed.approve
          ? "Reply with text to answer."
          : `Already ${a.status}`;
    // The message itself is updated by updateApproval() for every chat that got it.
    await this.call("answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
  }

  private async onMessage(update: Update): Promise<void> {
    try {
      if (update.callback_query) return await this.onButton(update.callback_query);
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
        const { approval: a, changed } = this.hub.answerQuestionDetailed(repliedTo, msg.text, "telegram");
        await this.send(chatId, changed && a ? `✅ Sent your answer to ${a.agentName}.` : `That question was already ${a?.status ?? "closed"}.`).catch(() => {});
        return;
      }
      await this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      try {
        const { reply, buttons } = await this.hub.handleText(msg.text, {
          channel: "telegram",
          chatId,
          from: msg.from?.username ?? msg.from?.first_name,
        });
        if (buttons?.length) await this.sendButtons(chatId, reply, buttons);
        else await this.send(chatId, reply);
      } catch (err) {
        await this.send(chatId, `Error: ${errorText(err)}`).catch(() => {});
      }
    } catch (err) {
      console.error("[telegram] onMessage failed:", errorText(err));
    }
  }
}
