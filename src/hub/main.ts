#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { IMessageChannel, normalizeHandle } from "./channels/imessage.js";
import { TelegramChannel } from "./channels/telegram.js";
import { loadConfig } from "./config.js";
import { Hub } from "./hub.js";
import { createHubServer } from "./server.js";
import { Store } from "./store.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const list = (value?: string) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT?.trim() || 4747);
const token = process.env.HUB_TOKEN?.trim() ?? "";
const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";

if (!token && !loopback) {
  console.error(`Refusing to listen on ${host} without HUB_TOKEN. Set HUB_TOKEN in .env first.`);
  process.exit(1);
}

const config = loadConfig();
const store = new Store();
const hub = new Hub(config, store);

if (process.env.TELEGRAM_BOT_TOKEN) {
  const telegram = new TelegramChannel(hub, process.env.TELEGRAM_BOT_TOKEN, new Set(list(process.env.TELEGRAM_ALLOWED_CHAT_IDS)));
  hub.channels.set("telegram", telegram);
  telegram.start();
}

let imessage: IMessageChannel | undefined;
if (process.env.BLUEBUBBLES_URL && process.env.BLUEBUBBLES_PASSWORD && !process.env.IMESSAGE_HOOK_TOKEN) {
  console.log(`[imessage] off: set IMESSAGE_HOOK_TOKEN (any long random string, e.g. ${randomBytes(16).toString("hex")}).`);
} else if (process.env.BLUEBUBBLES_URL && process.env.BLUEBUBBLES_PASSWORD) {
  const hookToken = process.env.IMESSAGE_HOOK_TOKEN!;
  imessage = new IMessageChannel(
    hub,
    process.env.BLUEBUBBLES_URL,
    process.env.BLUEBUBBLES_PASSWORD,
    new Set(list(process.env.IMESSAGE_ALLOWED_HANDLES).map(normalizeHandle)),
    hookToken,
  );
  hub.channels.set("imessage", imessage);
  imessage.start();
}

hub.startHealthChecks(Number(process.env.RELAY_HEALTH_MS) || 30_000);
const server = createHubServer({ hub, token, imessage });
server.listen(port, host, () => {
  const live = hub
    .agents()
    .map((a) => `${a.name}: ${hub.agentView(a).connectorLabel}`)
    .join(" | ");
  console.log(`\n  Relay hub  →  http://${host === "0.0.0.0" ? "localhost" : host}:${port}${token ? "  (token required)" : ""}`);
  console.log(`  Crew       →  ${live}`);
  console.log(`  Channels   →  web${hub.channels.has("telegram") ? ", telegram" : ""}${imessage ? ", imessage" : ""}\n`);
  if (!token) console.log("  Tip: set HUB_TOKEN in .env before exposing this beyond your own machine.\n");
});

const shutdown = () => {
  hub.stopHealthChecks();
  for (const channel of hub.channels.values()) channel.stop();
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
