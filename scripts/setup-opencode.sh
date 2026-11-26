#!/usr/bin/env bash
# Connect your OpenCode Zen prepaid credit to Relay as the Zen assistant.
# Uses a hidden prompt for OPENCODE_ZEN_API_KEY, verifies with a free model ($0),
# and leaves RELAY_ALLOW_METERED=false untouched.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

title "OpenCode Zen"
command -v curl >/dev/null || die "curl is required."
command -v node >/dev/null || die "Node.js is required."
ensure_relay_env
API="$(get_kv "$RELAY_ENV" OPENCODE_ZEN_BASE_URL)"; API="${OPENCODE_ZEN_BASE_URL:-${API:-https://opencode.ai/zen/v1}}"

say "Zen runs on your prepaid OpenCode credit with Auto model + Auto thinking"
say "(free models for quick asks, heavier models only for harder work, capped at \$30/mo)."
say "Tip: make sure auto-reload is OFF in your OpenCode billing settings so it stops at your credit."
echo

KEY="$(get_kv "$RELAY_ENV" OPENCODE_ZEN_API_KEY)"
if [ -n "$KEY" ] && ! ask "An OpenCode Zen key is already saved. Replace it?" n; then
  ok "Keeping the saved OpenCode Zen key"
else
  say "Create or copy a key from your OpenCode Zen dashboard."
  [ -t 0 ] && printf '  Paste the OpenCode Zen API key (hidden): '
  read -r -s KEY || true
  [ -t 0 ] && echo
  KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
  [ -n "$KEY" ] || die "No key entered."
fi

if ask "Send one tiny test message on deepseek-v4.1-flash-free (\$0 cost)?" y; then
  BODY='{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"Reply with the single word: ok"}]}'
  RESP="$(curl -s --max-time 60 -w '\n%{http_code}' -X POST "$API/chat/completions" \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' --data "$BODY" || true)"
  CODE="$(printf '%s' "$RESP" | tail -n 1)"
  JSON="$(printf '%s' "$RESP" | sed '$d')"
  case "$CODE" in
    200)
      TEXT="$(printf '%s' "$JSON" | json_get choices.0.message.content)"
      ok "OpenCode Zen answered: ${TEXT:-"(empty)"}" ;;
    401|403) die "OpenCode rejected the key (HTTP $CODE). Check your OpenCode Zen API key." ;;
    402) die "OpenCode says payment/credit is required (HTTP 402). Check your OpenCode Zen credit balance." ;;
    429) warn "OpenCode Zen is rate-limited right now (HTTP 429). The key is saved." ;;
    *) die "Unexpected answer from OpenCode Zen (HTTP ${CODE:-none}): $(printf '%s' "$JSON" | head -c 200)" ;;
  esac
fi

set_kv "$RELAY_ENV" OPENCODE_ZEN_API_KEY "$KEY"
ok "Saved OPENCODE_ZEN_API_KEY in Relay's .env (not printed)."

if [ "$(uname)" = Darwin ] && launchctl print "gui/$(id -u)/$(relay_service_label)" >/dev/null 2>&1; then
  if ask "Restart Relay now so Zen appears in your dashboard and Telegram?" y; then
    launchctl kickstart -k "gui/$(id -u)/$(relay_service_label)"
    ok "Restarted Relay. Refresh http://127.0.0.1:4747 to see Zen."
  fi
fi
