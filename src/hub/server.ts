import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { resolveWebhook } from "./connectors.js";
import { errorText, PublicError } from "./errors.js";
import type { IMessageChannel, BlueBubblesMessage } from "./channels/imessage.js";
import type { Hub } from "./hub.js";

const WEB_ROOT = resolve(process.env.RELAY_WEB_ROOT?.trim() || "web");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};
const MAX_BODY = 256 * 1024;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new PublicError("Body too large", 413);
    chunks.push(chunk as Buffer);
  }
  if (!size) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new PublicError("Invalid JSON", 400);
  }
}

/** Without a token, only answer to loopback hostnames (blocks DNS-rebinding attacks). */
export function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export interface ServerOptions {
  hub: Hub;
  token: string;
  imessage?: IMessageChannel;
}

function webAssetVersion(): string {
  try {
    const a = statSync(join(WEB_ROOT, "app.js")).mtimeMs;
    const b = statSync(join(WEB_ROOT, "app.css")).mtimeMs;
    return `${Math.floor(a)}-${Math.floor(b)}`;
  } catch {
    return "0";
  }
}

export function createHubServer({ hub, token, imessage }: ServerOptions) {
  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (!token) return true;
    const header = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const query = url.searchParams.get("token") ?? "";
    return safeEqual(header || query, token);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      // -------- inbound hooks (own auth)
      const hook = /^\/hooks\/agent\/([\w-]+)$/.exec(path);
      if (hook && req.method === "POST") {
        const body = await readJson<{ result?: string; error?: string }>(req);
        const tokenHeader = String(req.headers["x-relay-token"] ?? url.searchParams.get("token") ?? "");
        return send(res, resolveWebhook(hook[1], tokenHeader, body) ? 200 : 404, { ok: true });
      }
      if (path === "/hooks/imessage" && req.method === "POST") {
        if (!imessage || !safeEqual(url.searchParams.get("token") ?? "", imessage.hookToken)) {
          return send(res, 401, { error: "unauthorized" });
        }
        const payload = await readJson<BlueBubblesMessage>(req);
        void imessage.onWebhook(payload);
        return send(res, 200, { ok: true });
      }

      // -------- API
      if (path.startsWith("/api/")) {
        // Browser-side protections: a web page you visit must not be able to drive your agents.
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: "cross-origin request blocked" });
        if (!token && !isLocalHost(req.headers.host)) return send(res, 403, { error: "set HUB_TOKEN to use a non-local hostname" });
        if (req.method !== "GET" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return send(res, 415, { error: "content-type must be application/json" });
        }
        if (!authorized(req, url)) return send(res, 401, { error: "unauthorized" });

        if (path === "/api/state" && req.method === "GET") return send(res, 200, hub.snapshot());

        if (path === "/api/events" && req.method === "GET") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          res.write(`event: hello\ndata: ${JSON.stringify({ uiVersion: webAssetVersion() })}\n\n`);
          const onEvent = (e: { type: string; data: unknown }) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
          const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
          hub.bus.on("event", onEvent);
          req.on("close", () => {
            clearInterval(ping);
            hub.bus.off("event", onEvent);
          });
          return;
        }

        if (path === "/api/command" && req.method === "POST") {
          const { text } = await readJson<{ text?: string }>(req);
          if (!text?.trim()) return send(res, 400, { error: "text is required" });
          return send(res, 200, await hub.handleText(text.slice(0, 20_000), { channel: "web", chatId: "web" }));
        }

        const agentMatch = /^\/api\/agents\/([\w-]+)$/.exec(path);
        if (agentMatch && req.method === "PATCH") {
          const agent = hub.updateAgent(agentMatch[1], await readJson(req));
          return send(res, 200, hub.agentView(agent));
        }

        if (path === "/api/lead" && req.method === "POST") {
          const { agentId } = await readJson<{ agentId?: string }>(req);
          hub.setLead(String(agentId));
          return send(res, 200, { ok: true });
        }

        const decide = /^\/api\/approvals\/([0-9a-f]{6})$/.exec(path);
        if (decide && req.method === "POST") {
          const { approve, answer } = await readJson<{ approve?: boolean; answer?: string }>(req);
          if (typeof answer === "string" && answer.trim()) {
            const a = hub.answerQuestion(decide[1], answer, "web");
            return a ? send(res, 200, a) : send(res, 404, { error: "unknown question" });
          }
          if (typeof approve !== "boolean") return send(res, 400, { error: "send approve (true/false) or answer" });
          const a = hub.decideApproval(decide[1], approve, "web");
          return a ? send(res, 200, a) : send(res, 404, { error: "unknown approval" });
        }

        const cancel = /^\/api\/tasks\/([\w-]+)\/cancel$/.exec(path);
        if (cancel && req.method === "POST") return send(res, hub.cancel(cancel[1]) ? 200 : 404, { ok: true });

        return send(res, 404, { error: "not found" });
      }

      // -------- static dashboard
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" });
      const rel = path === "/" ? "index.html" : normalize(decodeURIComponent(path)).replace(/^[/\\]+/, "");
      const file = join(WEB_ROOT, rel);
      if (!file.startsWith(WEB_ROOT + sep)) return send(res, 403, { error: "forbidden" });
      try {
        const data = await readFile(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
        res.end(data);
      } catch {
        send(res, 404, { error: "not found" });
      }
    } catch (err) {
      if (err instanceof PublicError) return send(res, err.status, { error: err.message });
      // Unexpected: details stay in the local log, the client gets a generic message.
      console.error(`[server] ${req.method} ${path}: ${errorText(err)}`);
      send(res, 500, { error: "Something went wrong. Check the Relay log for details." });
    }
  });
}
