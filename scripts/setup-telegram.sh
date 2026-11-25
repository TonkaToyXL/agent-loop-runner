#!/usr/bin/env bash
# Link a Telegram bot to Relay (free). Saves the token, then catches your chat id
# from one message you send the bot, so only you can command the crew.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

title "Telegram"
command -v curl >/dev/null || die "curl is required."
command -v node >/dev/null || die "Node.js is required."
ensure_relay_env

tg() { curl -s --max-time "${2:-10}" "$TELEGRAM_API/bot$TOKEN/$1"; }

TOKEN="$(get_kv "$RELAY_ENV" TELEGRAM_BOT_TOKEN)"
if [ -n "$TOKEN" ] && [ "$(tg getMe | json_get ok)" = "true" ]; then
  ok "Using the bot token already in .env"
else
  say "In Telegram, message @BotFather, send /newbot, and follow the steps."
  say "It gives you a token like 123456:ABC-DEF..."
  echo
  [ -t 0 ] && printf '  Paste the bot token (hidden): '
  read -r -s TOKEN || true
  [ -t 0 ] && echo
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
  [ -n "$TOKEN" ] || die "No token entered."
fi

ME="$(tg getMe)"
[ "$(printf '%s' "$ME" | json_get ok)" = "true" ] || die "Telegram rejected that token: $(printf '%s' "$ME" | json_get description)"
BOT="$(printf '%s' "$ME" | json_get result.username)"
set_kv "$RELAY_ENV" TELEGRAM_BOT_TOKEN "$TOKEN"
ok "Bot @$BOT is valid and saved"

ALLOWED="$(get_kv "$RELAY_ENV" TELEGRAM_ALLOWED_CHAT_IDS)"
if [ -n "$ALLOWED" ] && ! ask "Chat ids already allowed ($ALLOWED). Add another chat?" n; then
  ok "Keeping the allowed chats"
  exit 0
fi

# Skip anything sent before now.
LAST="$(tg 'getUpdates?offset=-1' | json_get result.0.update_id)"
OFFSET=$(( ${LAST:-0} + 1 ))

echo
say "${B}Now send any message to @$BOT from your phone.${N}"
say "(Open https://t.me/$BOT and tap Start.) Waiting up to 3 minutes…"
CHAT=""; NAME=""
for _ in $(seq 1 7); do
  UPD="$(tg "getUpdates?offset=$OFFSET&timeout=25&allowed_updates=%5B%22message%22%5D" 30 || true)"
  if [ "$(printf '%s' "$UPD" | json_get ok)" != "true" ]; then
    DESC="$(printf '%s' "$UPD" | json_get description)"
    case "$DESC" in
      *Conflict*) die "Something else is reading this bot's messages (another Relay or a webhook). Stop it and run this again." ;;
    esac
    sleep 2; continue
  fi
  CHAT="$(printf '%s' "$UPD" | json_get result.0.message.chat.id)"
  if [ -n "$CHAT" ]; then
    NAME="$(printf '%s' "$UPD" | json_get result.0.message.from.first_name)"
    ID="$(printf '%s' "$UPD" | json_get result.0.update_id)"
    tg "getUpdates?offset=$(( ID + 1 ))&timeout=0" >/dev/null || true
    break
  fi
done
[ -n "$CHAT" ] || die "No message arrived. Run this again and message @$BOT while it waits."

ok "Got a message from ${NAME:-someone} (chat id $CHAT)"
ask "Allow this chat to command your agents?" y || die "Not saved. Run this again to try another chat."
if [ -n "$ALLOWED" ]; then
  case ",$ALLOWED," in *",$CHAT,"*) ;; *) ALLOWED="$ALLOWED,$CHAT" ;; esac
else
  ALLOWED="$CHAT"
fi
set_kv "$RELAY_ENV" TELEGRAM_ALLOWED_CHAT_IDS "$ALLOWED"
curl -s --max-time 10 "$TELEGRAM_API/bot$TOKEN/sendMessage" \
  --data-urlencode "chat_id=$CHAT" \
  --data-urlencode "text=Relay is linked. Once the hub is running, send /agents to see your crew." >/dev/null || true
ok "Telegram linked. Only chat $ALLOWED can use @$BOT."
