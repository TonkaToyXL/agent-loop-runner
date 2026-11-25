import type { ChannelAdapter, Hub } from "../hub.js";
import type { ChannelStatus } from "../types.js";

const API = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";
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
  message?: { chat: { id: number }; from?: { first_name?: string; username?: string }; text?: string };
}

/** Telegram bot via long polling: no public URL or webhook needed. */
export class TelegramChannel implements ChannelAdapter {
  readonly name = "telegram" as const;
  private offset = 0;
  private running = false;
  private connected = false;
  private detail = "";
  private abort = new AbortController();

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
      this.setState(true, `@${me.username}`);
      await this.call("setMyCommands", {
        commands: [
          { command: "agents", description: "Models, reasoning, usage" },
          { command: "status", description: "What's running now" },
          { command: "board", description: "Who did the most work" },
          { command: "team", description: "Give the crew a goal" },
          { command: "help", description: "How to talk to the crew" },
        ],
      }).catch(() => {});
    } catch (err) {
      this.setState(false, err instanceof Error ? err.message : "getMe failed");
    }

    let backoff = 1000;
    while (this.running) {
      try {
        const updates = await this.call<Update[]>(
          "getUpdates",
          { offset: this.offset, timeout: 50, allowed_updates: ["message"] },
          AbortSignal.any([this.abort.signal, AbortSignal.timeout(65_000)]),
        );
        backoff = 1000;
        if (!this.connected) this.setState(true, this.detail || "polling");
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

  private async onMessage(update: Update): Promise<void> {
    const msg = update.message;
    if (!msg?.text) return;
    const chatId = String(msg.chat.id);
    if (!this.allowed.has(chatId)) {
      // Only tells the sender their own chat id, so the owner can allowlist it.
      await this.send(chatId, `Not authorized. Your chat id is ${chatId}. Add it to TELEGRAM_ALLOWED_CHAT_IDS to use this hub.`).catch(() => {});
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
      await this.send(chatId, `Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    }
  }
}
