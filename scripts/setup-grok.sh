#!/usr/bin/env bash
# Connect Grok to Relay through a Grok Bot routine's webhook (runs on your Grok subscription,
# not the pay-per-use xAI API).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

title "Grok Bot"
ensure_relay_env
chmod +x scripts/relay-reply.sh

INSTRUCTIONS="$(sed "s|{{RELAY_DIR}}|$RELAY_DIR|g" docs/grok-bot-routine.md)"

say "Relay talks to Grok through a Grok Bot routine with a Webhook trigger,"
say "so it runs on your Grok subscription. Each task uses Grok Bot usage."
echo
say "1. In Grok Bot, create a new routine named ${B}Relay${N} with a ${B}Webhook${N} trigger."
say "   Keep your existing routines as they are."
say "2. Paste these as the routine's instructions:"
echo
printf '%s\n' "$INSTRUCTIONS" | sed 's/^/     │ /'
echo
if command -v pbcopy >/dev/null; then
  printf '%s\n' "$INSTRUCTIONS" | pbcopy
  ok "Copied the instructions to your clipboard"
fi
say "3. Make sure the routine's computer is this Mac, so it can reach Relay at 127.0.0.1."
echo

URL="$(get_kv "$RELAY_ENV" GROK_WEBHOOK_URL)"
if [ -n "$URL" ] && ! ask "A Grok webhook is already saved. Replace it?" n; then
  ok "Keeping the saved Grok webhook"
  exit 0
fi
[ -t 0 ] && printf '  Paste the routine'\''s webhook URL: '
read -r URL || true
URL="$(printf '%s' "$URL" | tr -d '[:space:]')"
[[ "$URL" =~ ^https:// ]] || die "That doesn't look like a webhook URL (should start with https://)."
[ -t 0 ] && printf '  Paste the webhook key or secret, if it has one (hidden, Enter to skip): '
read -r -s KEY || true
[ -t 0 ] && echo
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
HEADER=""
if [ -n "$KEY" ]; then
  [ -t 0 ] && printf '  Header name for the key (Enter for "Authorization: Bearer"): '
  read -r HEADER || true
  HEADER="$(printf '%s' "$HEADER" | tr -d '[:space:]' | sed 's/:$//')"
fi

set_kv "$RELAY_ENV" GROK_WEBHOOK_URL "$URL"
set_kv "$RELAY_ENV" GROK_WEBHOOK_KEY "$KEY"
set_kv "$RELAY_ENV" GROK_WEBHOOK_HEADER "$HEADER"
ok "Saved the Grok webhook in Relay's .env"
say "Test it from the dashboard or Telegram:  @grok what's trending on X right now?"
