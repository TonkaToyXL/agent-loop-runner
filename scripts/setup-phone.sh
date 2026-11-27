#!/usr/bin/env bash
# Open the Causeway dashboard to your phone: token required, Tailscale for use away from home.
# Runs without questions, so Hermes can run it for you from Telegram.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

title "Causeway on your phone"
ensure_relay_env

TOKEN="$(get_kv "$RELAY_ENV" HUB_TOKEN)"
if [ -z "$TOKEN" ]; then
  TOKEN="$(random_hex 32)"
  set_kv "$RELAY_ENV" HUB_TOKEN "$TOKEN"
  ok "Created an access token (the dashboard always asks for it away from this Mac)"
else
  ok "Access token is set"
fi
set_kv "$RELAY_ENV" HOST 0.0.0.0
ok "The dashboard now accepts your other devices"

PORT="$(get_kv "$RELAY_ENV" PORT)"
PORT="${PORT:-4747}"
TS=""
for BIN in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  if command -v "$BIN" >/dev/null 2>&1 || [ -x "$BIN" ]; then
    TS="$("$BIN" ip -4 2>/dev/null | head -1 || true)"
    [ -n "$TS" ] && break
  fi
done
LAN="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

if [ "$(uname)" = Darwin ] && launchctl print "gui/$(id -u)/$(relay_service_label)" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/$(relay_service_label)"
  ok "Restarted Causeway"
else
  warn "Causeway isn't running as a background service. Start it with: npm run hub"
fi

echo
if [ -n "$TS" ]; then
  ok "Anywhere, with Tailscale on: http://${TS}:${PORT}"
else
  warn "Tailscale isn't set up on this Mac, so the dashboard only works on the same Wi-Fi."
  say "For anywhere: install the free Tailscale app on this Mac and your phone, sign in to both"
  say "with the same account, then run this again."
fi
if [ -n "$LAN" ]; then
  ok "Same Wi-Fi as this Mac: http://${LAN}:${PORT}"
fi
echo
say "On your phone, send /dashboard to the Telegram bot for a one-tap sign-in link."
