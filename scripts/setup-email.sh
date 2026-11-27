#!/usr/bin/env bash
# Connect one inbox to Relay, read-only, over IMAP with an app password (free).
# Relay can list, search, and summarize mail. It cannot send, delete, move, or even mark mail as read.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

title "Email (read-only)"
ensure_relay_env

say "Relay reads your inbox over IMAP, which can't send mail. Relay also blocks every"
say "IMAP command except reading, so it can't delete, move, or mark mail as read."
echo
say "Which email provider?"
say "  1) Gmail or Google Workspace     2) iCloud Mail     3) Yahoo"
say "  4) Fastmail                      5) Other (IMAP)"
[ -t 0 ] && printf '  Choose 1-5: '
read -r CHOICE || true
PORT=993
case "${CHOICE:-1}" in
  1) HOST=imap.gmail.com
     HELP="Create an app password at https://myaccount.google.com/apppasswords (needs 2-Step Verification). If the page says it isn't available, your account's admin or security settings block app passwords." ;;
  2) HOST=imap.mail.me.com
     HELP="Create an app-specific password at https://account.apple.com → Sign-In and Security → App-Specific Passwords." ;;
  3) HOST=imap.mail.yahoo.com
     HELP="Create an app password in Yahoo Account Security → Generate app password." ;;
  4) HOST=imap.fastmail.com
     HELP="Create an app password in Fastmail Settings → Privacy & Security → App passwords (IMAP access)." ;;
  5) [ -t 0 ] && printf '  IMAP server (e.g. imap.example.com): '
     read -r HOST || true
     [ -t 0 ] && printf '  Port (Enter for 993): '
     read -r P || true
     PORT="${P:-993}"
     HELP="Use an app password if your provider offers one, rather than your main password." ;;
  *) die "Choose a number from 1 to 5." ;;
esac
HOST="$(printf '%s' "$HOST" | tr -d '[:space:]')"
[ -n "$HOST" ] || die "No server entered."
[[ "$PORT" =~ ^[0-9]+$ ]] || die "Port must be a number."
echo
say "$HELP"
say "(Outlook/Hotmail accounts aren't supported: Microsoft requires a sign-in flow Relay doesn't have.)"
echo
[ -t 0 ] && printf '  Email address: '
read -r USER_EMAIL || true
USER_EMAIL="$(printf '%s' "$USER_EMAIL" | tr -d '[:space:]')"
[[ "$USER_EMAIL" == *@* ]] || die "That doesn't look like an email address."
[ -t 0 ] && printf '  App password (hidden): '
read -r -s APP_PW || true
[ -t 0 ] && echo
APP_PW="$(printf '%s' "$APP_PW" | tr -d '[:space:]')"
[ -n "$APP_PW" ] || die "No app password entered."

# Save to a temp copy first; only keep it if sign-in works.
TMP_ENV="$(mktemp "$RELAY_ENV.XXXXXX")"
cp "$RELAY_ENV" "$TMP_ENV"
chmod 600 "$TMP_ENV"
set_kv "$TMP_ENV" MAIL_IMAP_HOST "$HOST"
set_kv "$TMP_ENV" MAIL_IMAP_PORT "$PORT"
set_kv "$TMP_ENV" MAIL_IMAP_USER "$USER_EMAIL"
set_kv "$TMP_ENV" MAIL_IMAP_PASSWORD "$APP_PW"

say "Signing in (read-only)…"
if RESULT="$(env -i PATH="$PATH" HOME="$HOME" NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-}" \
    MAIL_IMAP_HOST="$HOST" MAIL_IMAP_PORT="$PORT" MAIL_IMAP_USER="$USER_EMAIL" MAIL_IMAP_PASSWORD="$APP_PW" \
    node_modules/.bin/tsx src/hub/mail/check.ts 2>&1)"; then
  read -r _ COUNT UNREAD <<<"$RESULT"
  mv "$TMP_ENV" "$RELAY_ENV"
  ok "Connected to $USER_EMAIL: $COUNT email(s) in the last 24h, $UNREAD unread. Nothing was changed."
else
  rm -f "$TMP_ENV"
  die "Couldn't sign in: $(printf '%s' "$RESULT" | tail -1)"
fi

echo
say "Optional: let one agent read your mail to summarize it (/inbox summary)."
say "Whatever it reads goes to that agent's provider:"
say "  muse    Meta's Muse Spark via ClinePass"
say "  cline   open models (Kimi, GLM, DeepSeek, Qwen…) via ClinePass"
say "  none    no summaries; /inbox lists still work, with no AI involved"
say "Hermes and Grok Bot can't be chosen: they can act on your computer/accounts, and an"
say "email could try to give them orders."
CURRENT="$(get_kv "$RELAY_ENV" MAIL_SUMMARIZER)"
[ -t 0 ] && printf '  Summarizer [%s]: ' "${CURRENT:-none}"
read -r PICK || true
PICK="$(printf '%s' "${PICK:-${CURRENT:-none}}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
case "$PICK" in
  muse|cline|none) ;;
  *) warn "\"$PICK\" isn't one of the choices; using none."; PICK=none ;;
esac
set_kv "$RELAY_ENV" MAIL_SUMMARIZER "$PICK"
ok "Summaries: $PICK"
say "Try: /inbox   ·   /inbox unread   ·   /inbox summary   ·   \"anything urgent in my email?\""
