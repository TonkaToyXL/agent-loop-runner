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

const tgToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (tgToken) {
  const telegram = new TelegramChannel(hub, tgToken, new Set(list(process.env.TELEGRAM_ALLOWED_CHAT_IDS)));
  hub.channels.set("telegram", telegram);
  telegram.start();
}

let imessage: IMessageChannel | undefined;
const bbUrl = process.env.BLUEBUBBLES_URL?.trim();
const bbPass = process.env.BLUEBUBBLES_PASSWORD?.trim();
const imsgHook = process.env.IMESSAGE_HOOK_TOKEN?.trim();
if (bbUrl && bbPass && !imsgHook) {
  console.log(`[imessage] off: set IMESSAGE_HOOK_TOKEN (any long random string, e.g. ${randomBytes(16).toString("hex")}).`);
} else if (bbUrl && bbPass && imsgHook) {
  imessage = new IMessageChannel(
    hub,
    bbUrl,
    bbPass,
    new Set(list(process.env.IMESSAGE_ALLOWED_HANDLES).map(normalizeHandle)),
    imsgHook,
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
  console.log(`\n  Causeway  →  http://${host === "0.0.0.0" ? "localhost" : host}:${port}${token ? "  (token required)" : ""}`);
  console.log(`  Crew       →  ${live}`);
  console.log(`  Channels   →  web${hub.channels.has("telegram") ? ", telegram" : ""}${imessage ? ", imessage" : ""}\n`);
  if (!token) console.log("  Tip: set HUB_TOKEN in .env before exposing this beyond your own machine.\n");
  // Give channels a moment to connect, then tell the owner Relay is up.
  setTimeout(() => hub.announceStart(), 4000).unref();
});

const shutdown = () => {
  hub.shutdown();
  for (const channel of hub.channels.values()) channel.stop();
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
