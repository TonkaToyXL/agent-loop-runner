#!/usr/bin/env bash
# Connect iMessage to Relay through BlueBubbles (free, runs on a Mac signed in to Messages).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

title "iMessage (via BlueBubbles)"
ensure_relay_env

say "iMessage needs the free BlueBubbles Server app on a Mac that's signed in to Messages."
say "Cleanest setup: sign that Mac's Messages into a separate Apple ID just for Relay,"
say "then text that Apple ID from your iPhone. Install: https://bluebubbles.app/install"
echo
ask "Is BlueBubbles Server installed and running?" n || { say "Set it up first, then run: npm run setup:imessage"; exit 0; }

CURRENT_URL="$(get_kv "$RELAY_ENV" BLUEBUBBLES_URL)"
[ -t 0 ] && printf '  BlueBubbles server URL [%s]: ' "${CURRENT_URL:-http://localhost:1234}"
read -r URL || true
URL="$(printf '%s' "${URL:-${CURRENT_URL:-http://localhost:1234}}" | tr -d '[:space:]')"
URL="${URL%/}"
[[ "$URL" =~ ^https?:// ]] || die "The URL should start with http:// or https://"
[ -t 0 ] && printf '  BlueBubbles server password (hidden): '
read -r -s PW || true
[ -t 0 ] && echo
[ -n "$PW" ] || die "No password entered."

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -G "$URL/api/v1/ping" --data-urlencode "password=$PW" || true)"
case "$CODE" in
  200) ok "BlueBubbles answered" ;;
  401|403) die "BlueBubbles rejected that password (HTTP $CODE)." ;;
  000) die "Couldn't reach $URL. Is BlueBubbles Server running on this Mac?" ;;
  *) die "Unexpected answer from BlueBubbles (HTTP $CODE)." ;;
esac

CURRENT_HANDLES="$(get_kv "$RELAY_ENV" IMESSAGE_ALLOWED_HANDLES)"
say "Which phone number or Apple ID email will you text Relay from? Only these can use it."
[ -t 0 ] && printf '  Your number/email [%s]: ' "${CURRENT_HANDLES:-e.g. +15125550100}"
read -r HANDLES || true
HANDLES="$(printf '%s' "${HANDLES:-$CURRENT_HANDLES}" | tr -d ' ')"
[ -n "$HANDLES" ] || die "Enter at least one phone number or email."

HOOK="$(get_kv "$RELAY_ENV" IMESSAGE_HOOK_TOKEN)"
[ -n "$HOOK" ] || HOOK="$(random_hex 16)"
set_kv "$RELAY_ENV" BLUEBUBBLES_URL "$URL"
set_kv "$RELAY_ENV" BLUEBUBBLES_PASSWORD "$PW"
set_kv "$RELAY_ENV" IMESSAGE_ALLOWED_HANDLES "$HANDLES"
set_kv "$RELAY_ENV" IMESSAGE_HOOK_TOKEN "$HOOK"
ok "Saved. Only $HANDLES can command the crew by iMessage."

PORT="$(get_kv "$RELAY_ENV" PORT)"; PORT="${PORT:-4747}"
PUBLIC="$(get_kv "$RELAY_ENV" RELAY_PUBLIC_URL)"
WEBHOOK="${PUBLIC:-http://127.0.0.1:$PORT}/hooks/imessage?token=$HOOK"
echo
say "Last step, in BlueBubbles Server: Settings → API & Webhooks → Add webhook."
say "Event: ${B}New Messages${N}. URL:"
echo
echo "      $WEBHOOK"
echo
if command -v pbcopy >/dev/null; then printf '%s' "$WEBHOOK" | pbcopy; ok "Copied the webhook URL to your clipboard"; fi
say "Keep that URL private: it contains the secret that lets BlueBubbles talk to Relay."
say "If BlueBubbles runs on a different Mac, set RELAY_PUBLIC_URL to an address it can reach."
