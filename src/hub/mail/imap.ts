import { connect, type TLSSocket } from "node:tls";

/**
 * A deliberately tiny, read-only IMAP client.
 * - Only read commands are allowed (see assertReadOnly); anything else throws before it is sent.
 * - Mailboxes are opened with EXAMINE (read-only), and bodies are fetched with BODY.PEEK so
 *   messages are not even marked as read.
 * - IMAP cannot send email at all; sending would need SMTP, which Relay does not implement.
 * - Always TLS.
 */

const ALLOWED = /^(CAPABILITY|ID|LOGIN|EXAMINE|NOOP|LOGOUT|UID SEARCH|UID FETCH)\b/;

export function assertReadOnly(command: string): void {
  const cmd = command.trim();
  // Messages are fixed text on purpose: commands can contain the password, so never echo them.
  if (!ALLOWED.test(cmd)) throw new Error("Causeway's mail reader refused a command that isn't read-only");
  // A plain BODY[...] or RFC822/RFC822.TEXT fetch would mark messages as read; only BODY.PEEK[...] is allowed.
  if (/^UID FETCH/.test(cmd) && (/\bBODY\[/i.test(cmd) || /\bRFC822(?!\.HEADER\b|\.SIZE\b)/i.test(cmd))) {
    throw new Error("Causeway's mail reader only fetches with BODY.PEEK");
  }
  if (/[\r\n]/.test(cmd)) throw new Error("Line breaks are not allowed in IMAP commands");
}

export function quote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Line breaks are not allowed in IMAP strings");
  return `"${value.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

/** One server response line, with any literals ({N} blocks) that belong to it. */
export interface ImapResponse {
  text: string;
  literals: Buffer[];
}

/**
 * Incremental parser for the server byte stream. Exported for tests.
 * Feeds bytes in; emits complete responses (a line plus its literals).
 */
export class ResponseParser {
  private buf = Buffer.alloc(0);
  private current: ImapResponse | null = null;
  private pendingLiteral = 0;

  constructor(private readonly onResponse: (r: ImapResponse) => void) {}

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.pendingLiteral > 0) {
        if (this.buf.length < this.pendingLiteral) return;
        this.current!.literals.push(this.buf.subarray(0, this.pendingLiteral));
        this.buf = this.buf.subarray(this.pendingLiteral);
        this.pendingLiteral = 0;
        continue;
      }
      const end = this.buf.indexOf("\r\n");
      if (end === -1) return;
      const line = this.buf.subarray(0, end).toString("latin1");
      this.buf = this.buf.subarray(end + 2);
      this.current ??= { text: "", literals: [] };
      const lit = /\{(\d+)\}$/.exec(line);
      if (lit) {
        this.current.text += line.slice(0, lit.index) + `{L${this.current.literals.length}}`;
        this.pendingLiteral = Number(lit[1]);
        if (this.pendingLiteral === 0) this.current.literals.push(Buffer.alloc(0));
        continue;
      }
      this.current.text += line;
      const done = this.current;
      this.current = null;
      this.onResponse(done);
    }
  }
}

export interface ImapOptions {
  host: string;
  port?: number;
  user: string;
  password: string;
  timeoutMs?: number;
}

export interface FetchedMessage {
  uid: number;
  flags: string[];
  internalDate?: string;
  raw: Buffer;
}

export class ReadOnlyImap {
  private socket: TLSSocket | null = null;
  private tag = 0;
  private waiting: { tag: string; resolve: (r: { status: string; text: string; untagged: ImapResponse[] }) => void; reject: (e: Error) => void } | null = null;
  private untagged: ImapResponse[] = [];
  private greeting: ((r: ImapResponse) => void) | null = null;

  constructor(private readonly opts: ImapOptions) {}

  async open(): Promise<void> {
    const timeoutMs = this.opts.timeoutMs ?? 20_000;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.greeting = null;
        fn();
      };
      const timer = setTimeout(() => {
        const err = new Error(`Mail server didn't answer within ${timeoutMs / 1000}s`);
        this.socket?.destroy(err);
        done(() => reject(err));
      }, timeoutMs);
      const parser = new ResponseParser((r) => this.onResponse(r));
      this.greeting = (r) => {
        if (/^\* (OK|PREAUTH)/i.test(r.text)) done(resolve);
        else done(() => reject(new Error(`Mail server refused the connection: ${r.text.slice(0, 120)}`)));
      };
      this.socket = connect({ host: this.opts.host, port: this.opts.port ?? 993, servername: this.opts.host });
      this.socket.setTimeout(timeoutMs, () => this.socket?.destroy(new Error("Mail server timed out")));
      this.socket.on("data", (d: Buffer) => parser.push(d));
      this.socket.on("error", (err) => {
        done(() => reject(err));
        this.waiting?.reject(err);
        this.waiting = null;
      });
      this.socket.on("close", () => {
        const err = new Error("Mail server closed the connection");
        done(() => reject(err));
        this.waiting?.reject(err);
        this.waiting = null;
      });
    });
    const login = await this.run(`LOGIN ${quote(this.opts.user)} ${quote(this.opts.password)}`);
    if (login.status !== "OK") {
      throw new Error(/AUTHENTICATIONFAILED|Invalid credentials|authentication failed/i.test(login.text)
        ? "The mail server rejected the email address or app password."
        : `Mail sign-in failed: ${login.text.slice(0, 160)}`);
    }
  }

  private onResponse(r: ImapResponse): void {
    if (this.greeting) {
      const g = this.greeting;
      this.greeting = null;
      g(r);
      return;
    }
    if (this.waiting && r.text.startsWith(`${this.waiting.tag} `)) {
      const rest = r.text.slice(this.waiting.tag.length + 1);
      const status = rest.split(" ")[0].toUpperCase();
      const w = this.waiting;
      this.waiting = null;
      const untagged = this.untagged;
      this.untagged = [];
      w.resolve({ status, text: rest, untagged });
      return;
    }
    if (r.text.startsWith("* ")) this.untagged.push(r);
  }

  /** Send one read-only command and wait for its tagged reply. */
  async run(command: string): Promise<{ status: string; text: string; untagged: ImapResponse[] }> {
    assertReadOnly(command);
    if (!this.socket) throw new Error("Not connected");
    if (this.waiting) throw new Error("One command at a time");
    const tag = `R${++this.tag}`;
    return new Promise((resolve, reject) => {
      this.waiting = { tag, resolve, reject };
      this.socket!.write(`${tag} ${command}\r\n`);
    });
  }

  async examine(mailbox = "INBOX"): Promise<void> {
    const r = await this.run(`EXAMINE ${quote(mailbox)}`);
    if (r.status !== "OK") throw new Error(`Couldn't open ${mailbox}: ${r.text.slice(0, 120)}`);
  }

  async search(criteria: string): Promise<number[]> {
    const r = await this.run(`UID SEARCH ${criteria}`);
    if (r.status !== "OK") throw new Error(`Mail search failed: ${r.text.slice(0, 120)}`);
    const uids: number[] = [];
    for (const u of r.untagged) {
      if (!/^\* SEARCH\b/i.test(u.text)) continue;
      for (const tok of u.text.slice(8).trim().split(/\s+/)) {
        const n = Number(tok);
        if (Number.isInteger(n) && n > 0) uids.push(n);
      }
    }
    return uids;
  }

  /** Fetch flags, date, and the first `maxBytes` of each message, without marking anything read. */
  async fetch(uids: number[], maxBytes = 30_000): Promise<FetchedMessage[]> {
    if (!uids.length) return [];
    const set = uids.map((n) => Math.floor(n)).join(",");
    const r = await this.run(`UID FETCH ${set} (UID FLAGS INTERNALDATE BODY.PEEK[]<0.${Math.floor(maxBytes)}>)`);
    if (r.status !== "OK") throw new Error(`Mail fetch failed: ${r.text.slice(0, 120)}`);
    return r.untagged.filter((u) => /^\* \d+ FETCH/i.test(u.text)).map(parseFetch).filter((m): m is FetchedMessage => m !== null);
  }

  async close(): Promise<void> {
    try {
      if (this.socket && !this.socket.destroyed && !this.waiting) await Promise.race([this.run("LOGOUT"), new Promise((r) => setTimeout(r, 2000))]);
    } catch {
      // ignore
    }
    this.socket?.destroy();
    this.socket = null;
  }
}

export function parseFetch(r: ImapResponse): FetchedMessage | null {
  const uid = /\bUID (\d+)/i.exec(r.text);
  if (!uid) return null;
  const flags = /\bFLAGS \(([^)]*)\)/i.exec(r.text)?.[1].split(/\s+/).filter(Boolean) ?? [];
  const internalDate = /\bINTERNALDATE "([^"]+)"/i.exec(r.text)?.[1];
  const bodyRef = /BODY\[\](?:<\d+>)? \{L(\d+)\}/i.exec(r.text);
  const raw = bodyRef ? r.literals[Number(bodyRef[1])] ?? Buffer.alloc(0) : r.literals[0] ?? Buffer.alloc(0);
  return { uid: Number(uid[1]), flags, internalDate, raw };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** IMAP SEARCH date, e.g. 24-Nov-2026 (servers compare by day). */
export function imapDate(d: Date): string {
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
