/**
 * Just enough MIME to read email text: headers, encoded words, multipart, quoted-printable,
 * base64, and HTML-to-text. Works on "binary strings" (latin1) so bytes survive until the
 * charset is known.
 */

export interface ParsedPart {
  headers: Map<string, string>;
  body: string; // latin1 "binary string"
}

const toBinary = (buf: Buffer | string) => (typeof buf === "string" ? buf : buf.toString("latin1"));

export function decodeBytes(bytes: Buffer, charset = "utf-8"): string {
  const cs = charset.trim().toLowerCase().replace(/^"|"$/g, "") || "utf-8";
  try {
    return new TextDecoder(cs === "us-ascii" ? "utf-8" : cs).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function decodeQuotedPrintable(input: string): Buffer {
  const s = input.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** RFC 2047 encoded words, e.g. =?UTF-8?B?SGk=?= or =?utf-8?Q?caf=C3=A9?= */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, enc: string, text: string) => {
      const bytes =
        enc.toUpperCase() === "B" ? Buffer.from(text, "base64") : decodeQuotedPrintable(text.replace(/_/g, " "));
      return decodeBytes(bytes, charset.split("*")[0]);
    });
}

export function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    if (!headers.has(key)) headers.set(key, line.slice(i + 1).trim());
  }
  return headers;
}

export function splitMessage(raw: Buffer | string): ParsedPart {
  const s = toBinary(raw);
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return { headers: parseHeaders(s), body: "" };
  return { headers: parseHeaders(s.slice(0, m.index)), body: s.slice(m.index + m[0].length) };
}

/** "text/plain; charset=utf-8; boundary=x" -> { type, params } */
export function parseContentType(value: string | undefined): { type: string; params: Record<string, string> } {
  const [type, ...rest] = (value ?? "text/plain").split(";");
  const params: Record<string, string> = {};
  for (const p of rest) {
    const i = p.indexOf("=");
    if (i > 0) params[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"|"$/g, "");
  }
  return { type: type.trim().toLowerCase() || "text/plain", params };
}

function decodeBody(part: ParsedPart): string {
  const enc = (part.headers.get("content-transfer-encoding") ?? "7bit").toLowerCase();
  const { params } = parseContentType(part.headers.get("content-type"));
  const bytes =
    enc === "base64"
      ? Buffer.from(part.body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64")
      : enc === "quoted-printable"
        ? decodeQuotedPrintable(part.body)
        : Buffer.from(part.body, "latin1");
  return decodeBytes(bytes, params.charset);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Best readable text of a message: first text/plain part, else HTML converted to text. */
export function extractText(part: ParsedPart, depth = 0): string {
  const { type, params } = parseContentType(part.headers.get("content-type"));
  const disposition = (part.headers.get("content-disposition") ?? "").toLowerCase();
  if (disposition.startsWith("attachment")) return "";
  if (type.startsWith("multipart/") && params.boundary && depth < 6) {
    const parts = part.body
      .split(new RegExp(`\\r?\\n?--${params.boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*\\r?\\n?`))
      .slice(1)
      .map((p) => splitMessage(p))
      .filter((p) => p.headers.size || p.body.trim());
    const plain = parts.find((p) => parseContentType(p.headers.get("content-type")).type === "text/plain");
    if (plain) {
      const t = extractText(plain, depth + 1);
      if (t.trim()) return t;
    }
    for (const p of parts) {
      const t = extractText(p, depth + 1);
      if (t.trim()) return t;
    }
    return "";
  }
  if (type === "text/plain") return decodeBody(part);
  if (type === "text/html") return htmlToText(decodeBody(part));
  return "";
}

/** Short, readable preview: drops quoted replies and signatures, collapses whitespace. */
export function snippet(text: string, max = 600): string {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^On .+wrote:\s*$/.test(line.trim()) || /^-{2,}\s*$/.test(line.trim()) || /^_{5,}/.test(line.trim())) break;
    if (line.trim().startsWith(">")) continue;
    lines.push(line);
  }
  const s = lines.join(" ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "Jane Doe <jane@x.com>" -> { name: "Jane Doe", address: "jane@x.com" } */
export function parseFrom(value: string | undefined): { name: string; address: string } {
  const v = decodeWords(value ?? "").trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(v);
  if (m) return { name: m[1].trim() || m[2], address: m[2].trim() };
  return { name: v, address: v };
}
