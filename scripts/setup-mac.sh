#!/usr/bin/env bash
# One-time setup for running Relay on an always-on Mac (e.g. a Mac mini).
# Installs dependencies, connects your existing agents and chat apps, blocks pay-per-use APIs,
# and keeps Relay running in the background (starts at login, restarts if it stops).
# Safe to run again any time to add or change something.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
export RELAY_SETUP_ALL=1
chmod +x scripts/*.sh

title "Relay setup"
say "Everything here uses subscriptions and tools you already have."
say "Pay-per-use APIs stay blocked unless you turn them on yourself."

# ---- Node
if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  if command -v brew >/dev/null && ask "Relay needs Node.js 22.13+. Install it with Homebrew now?" y; then
    brew install node
  else
    die "Install Node.js 22.13 or newer from https://nodejs.org, then run this again."
  fi
fi
ok "Node $(node --version)"

# ---- Dependencies
say "Installing Relay's dependencies…"
npm ci --no-audit --no-fund --loglevel=error >/dev/null
ok "Dependencies installed"

ensure_relay_env
set_kv "$RELAY_ENV" RELAY_ALLOW_METERED false
ok "Pay-per-use APIs are blocked (RELAY_ALLOW_METERED=false)"

stop_relay_service

# ---- Agents
if command -v hermes >/dev/null || [ -x "$HOME/.local/bin/hermes" ]; then
  if ask "Connect Hermes Agent?" y; then bash scripts/setup-hermes.sh || warn "Hermes setup didn't finish. You can rerun it with: npm run setup:hermes"; fi
else
  warn "Hermes isn't installed on this Mac. Skipping."
fi

title "Claude"
say "Not connected, on purpose. Anthropic's terms for Pro/Max plans don't allow"
say "bot- or script-driven access except with a pay-per-use API key, so Relay"
say "leaves Claude out to keep your account safe. Keep using Claude in its own apps."

bash scripts/setup-antigravity.sh || warn "Gemini setup didn't finish. Rerun with: npm run setup:antigravity"

if ask "Connect Grok through your Grok Bot routine?" y; then bash scripts/setup-grok.sh || warn "Grok setup didn't finish. Rerun with: npm run setup:grok"; fi

title "ClinePass"
say "Your ClinePass (\$9.99/mo flat) can power Muse (Muse Spark 1.3) and a Cline"
say "teammate on open models like Kimi K3.1 Pro and GLM 5.3. No per-use charges."
if ask "Connect ClinePass?" y; then
  bash scripts/setup-clinepass.sh || warn "ClinePass setup didn't finish. Rerun with: npm run setup:clinepass"
else
  say "Skipped. Without it, Muse stays off (its only other route is pay-per-use)."
fi

# ---- Channels
if ask "Connect Telegram so you can run the crew from your phone?" y; then
  bash scripts/setup-telegram.sh || warn "Telegram setup didn't finish. Rerun with: npm run setup:telegram"
fi

# ---- Phone dashboard (optional)
title "Dashboard on your phone (optional)"
say "With Tailscale (free for personal use) on this Mac and your phone,"
say "you can open the dashboard from anywhere."
if ask "Allow the dashboard from your phone over Tailscale?" n; then
  TOKEN="$(get_kv "$RELAY_ENV" HUB_TOKEN)"
  if [ -z "$TOKEN" ]; then TOKEN="$(random_hex 16)"; set_kv "$RELAY_ENV" HUB_TOKEN "$TOKEN"; fi
  set_kv "$RELAY_ENV" HOST 0.0.0.0
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  [ -n "$TS_IP" ] || TS_IP="<this-mac-tailscale-ip>"
  WEB_PORT="$(get_kv "$RELAY_ENV" PORT)"; WEB_PORT="${WEB_PORT:-4747}"
  ok "Dashboard is open to your devices, protected by a password (HUB_TOKEN)"
  say "On your phone, open: ${B}http://$TS_IP:$WEB_PORT${N}"
  say "and enter this password once: ${B}$TOKEN${N}"
  say "(It's saved in .env if you need it again.)"
fi

# ---- Background service
PORT="$(get_kv "$RELAY_ENV" PORT)"; PORT="${PORT:-4747}"
if [ "$(uname)" = Darwin ]; then
  title "Keep Relay running"
  LABEL="$(relay_service_label)"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  LOG="$HOME/Library/Logs/relay-hub.log"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$RELAY_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$RELAY_DIR/node_modules/tsx/dist/cli.mjs</string>
    <string>src/hub/main.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  printf '  Starting Relay '
  for _ in $(seq 1 30); do curl -sf --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null && break; printf '.'; sleep 1; done
  echo
  if curl -sf --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null; then
    ok "Relay is running and will start again after restarts"
  else
    tail -n 15 "$LOG" 2>/dev/null | sed 's/^/     /' || true
    die "Relay didn't start. See the log lines above, or ~/Library/Logs/relay-hub.log"
  fi
  say "Logs:    tail -f ~/Library/Logs/relay-hub.log"
  say "Restart: launchctl kickstart -k gui/\$(id -u)/$LABEL"
  say "Stop:    launchctl bootout gui/\$(id -u)/$LABEL"
  say "Tip: System Settings → Energy → turn on \"Prevent automatic sleeping\" so the Mac mini stays reachable."
else
  title "Start Relay"
  say "Not a Mac, so no background service. Start it with: npm run hub"
fi

title "Done"
say "Dashboard: http://127.0.0.1:$PORT"
if [ -n "$(get_kv "$RELAY_ENV" TELEGRAM_BOT_TOKEN)" ]; then say "Telegram:  send /agents to your bot"; fi
say "Try:       @team plan my week: 3 priorities and a short task list"
echo
