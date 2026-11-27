#!/usr/bin/env bash
# Connect your ClinePass subscription ($9.99/mo flat) to Relay.
# Powers Muse (Muse Spark 1.3) and the Cline agent (Kimi, GLM, DeepSeek, Qwen...).
# Relay only sends cline-pass/ models on this key; other models would bill Cline credits.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

title "ClinePass"
command -v curl >/dev/null || die "curl is required."
command -v node >/dev/null || die "Node.js is required."
ensure_relay_env
API="$(get_kv "$RELAY_ENV" CLINEPASS_BASE_URL)"; API="${CLINEPASS_BASE_URL:-${API:-https://api.cline.bot/api/v1}}"

KEY="$(get_kv "$RELAY_ENV" CLINEPASS_API_KEY)"
if [ -n "$KEY" ] && ! ask "A ClinePass key is already saved. Replace it?" n; then
  ok "Keeping the saved ClinePass key"
else
  say "Create a key at app.cline.bot → Settings → API Keys (needs an active ClinePass)."
  [ -t 0 ] && printf '  Paste the API key (hidden): '
  read -r -s KEY || true
  [ -t 0 ] && echo
  KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
  [ -n "$KEY" ] || die "No key entered."
fi

if ask "Send one tiny test message? (uses a sliver of your ClinePass quota, no extra charge)" y; then
  BODY='{"model":"cline-pass/deepseek-v4.1-flash","stream":false,"messages":[{"role":"user","content":"Reply with the single word: ok"}]}'
  RESP="$(curl -s --max-time 60 -w '\n%{http_code}' -X POST "$API/chat/completions" \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -H 'X-Response-Format: openai' -H 'X-Title: Relay' --data "$BODY" || true)"
  CODE="$(printf '%s' "$RESP" | tail -n 1)"
  JSON="$(printf '%s' "$RESP" | sed '$d')"
  case "$CODE" in
    200)
      TEXT="$(printf '%s' "$JSON" | json_get choices.0.message.content)"
      ok "ClinePass answered: ${TEXT:-"(empty)"}" ;;
    401|403) die "Cline rejected the key (HTTP $CODE). Check it at app.cline.bot → Settings → API Keys." ;;
    402) die "Cline says payment is required (HTTP 402). Check that ClinePass is active on this account." ;;
    429) warn "ClinePass is rate-limited right now (HTTP 429). The key is saved; it will work once your 5-hour window resets." ;;
    *) die "Unexpected answer from Cline (HTTP ${CODE:-none}): $(printf '%s' "$JSON" | head -c 200)" ;;
  esac
fi

set_kv "$RELAY_ENV" CLINEPASS_API_KEY "$KEY"
ok "Saved. Muse and Cline will run on your ClinePass."
say "Relay only sends cline-pass/ models on this key, so nothing bills your Cline credits."
say "For extra safety, keep your Cline credit balance at \$0 so nothing else can draw on it."
