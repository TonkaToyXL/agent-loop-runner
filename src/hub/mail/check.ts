// Used by scripts/setup-email.sh: sign in read-only and count recent mail. Prints no message content.
import { existsSync } from "node:fs";
import { errorText } from "../errors.js";
import { fetchRecent, mailConfig } from "./inbox.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const cfg = mailConfig();
if (!cfg) {
  console.error("Missing MAIL_IMAP_HOST, MAIL_IMAP_USER or MAIL_IMAP_PASSWORD.");
  process.exit(2);
}
try {
  const items = await fetchRecent(cfg, { hours: 24, max: 60 });
  const unread = items.filter((m) => m.unread).length;
  console.log(`OK ${items.length} ${unread}`);
} catch (err) {
  console.error(errorText(err));
  process.exit(1);
}
