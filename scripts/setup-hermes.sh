#!/usr/bin/env bash
# Connect Relay to Hermes Agent's API server.
#   1. Turns on Hermes' API server with a random key (~/.hermes/.env, backed up first)
#   2. Puts the same key and URL in Relay's .env (never printed)
#   3. Restarts the Hermes gateway if needed (asks first)
#   4. Checks that Hermes answers with that key
# Safe to run again: it keeps an existing key and only fills in what is missing.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
HERMES_ENV="$HERMES_HOME/.env"

title "Hermes"

# ---- 1. prerequisites
command -v node >/dev/null || die "Node.js is not installed. Install Node 22.13+ from https://nodejs.org, then run this again."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node $(node --version) is too old. Relay needs 22.13 or newer."
command -v curl >/dev/null || die "curl is required."
HERMES_BIN="$(command -v hermes || true)"
[ -z "$HERMES_BIN" ] && [ -x "$HOME/.local/bin/hermes" ] && HERMES_BIN="$HOME/.local/bin/hermes"
[ -n "$HERMES_BIN" ] || die "Can't find the 'hermes' command. Install Hermes Agent first, or add it to your PATH."
[ -d "$HERMES_HOME" ] || die "No Hermes config at $HERMES_HOME. Run 'hermes setup' once, then run this again."
ok "Found Hermes at $HERMES_BIN"

# ---- 2. Hermes API server settings
if [ -f "$HERMES_ENV" ]; then
  backup="$HERMES_ENV.relay-backup-$(date +%Y%m%d-%H%M%S)"
  cp -p "$HERMES_ENV" "$backup"
  chmod 600 "$backup"
  ok "Backed up Hermes settings to $backup"
else
  touch "$HERMES_ENV"
  chmod 600 "$HERMES_ENV"
fi

KEY="$(get_kv "$HERMES_ENV" API_SERVER_KEY)"
if [ -z "$KEY" ] || [ "$KEY" = "change-me-local-dev" ]; then
  KEY="$(random_hex 32)"
  set_kv "$HERMES_ENV" API_SERVER_KEY "$KEY"
  ok "Created a new Hermes API key (stored in $HERMES_ENV, not shown)"
  KEY_CHANGED=1
else
  ok "Kept your existing Hermes API key"
  KEY_CHANGED=0
fi

WAS_ENABLED="$(get_kv "$HERMES_ENV" API_SERVER_ENABLED)"
set_kv "$HERMES_ENV" API_SERVER_ENABLED true
[ "$WAS_ENABLED" = "true" ] && ok "Hermes API server was already enabled" || ok "Enabled the Hermes API server"

PORT="$(get_kv "$HERMES_ENV" API_SERVER_PORT)"; PORT="${PORT:-8642}"
HOST="$(get_kv "$HERMES_ENV" API_SERVER_HOST)"; HOST="${HOST:-127.0.0.1}"
[ "$HOST" = "0.0.0.0" ] && HOST=127.0.0.1
BASE="http://$HOST:$PORT"

# ---- 3. Relay settings
ensure_relay_env
set_kv "$RELAY_ENV" HERMES_BASE_URL "$BASE/v1"
set_kv "$RELAY_ENV" HERMES_API_KEY "$KEY"
ok "Saved Hermes URL and key in Relay's .env"

# ---- 4. Make sure the running gateway uses these settings
auth_status() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Authorization: Bearer $KEY" "$BASE/v1/models" || true; }
healthy() { curl -sf --max-time 3 "$BASE/health" >/dev/null 2>&1; }

if healthy && [ "$(auth_status)" = "200" ] && [ "$KEY_CHANGED" = 0 ] && [ "$WAS_ENABLED" = "true" ]; then
  ok "Hermes is already serving the API with this key. No restart needed."
else
  echo
  if healthy || pgrep -f "hermes.*gateway" >/dev/null 2>&1; then
    say "The Hermes gateway is running with old settings and needs a restart."
    say "This briefly disconnects Hermes from its chat apps (a few seconds)."
    if ask "Restart the Hermes gateway now?" y; then
      if "$HERMES_BIN" gateway restart; then ok "Restarted the Hermes gateway"; else warn "'hermes gateway restart' failed. Restart Hermes yourself, then run this script again."; fi
    else
      warn "Skipped. Restart Hermes yourself (hermes gateway restart), then run this script again."
      exit 0
    fi
  else
    say "Hermes' gateway isn't running."
    if ask "Start it in the background now?" y; then
      mkdir -p "$HOME/Library/Logs" 2>/dev/null || true
      HLOG="$HOME/Library/Logs/hermes-gateway.log"; [ -d "$HOME/Library/Logs" ] || HLOG="$HERMES_HOME/relay-gateway.log"
      nohup "$HERMES_BIN" gateway >> "$HLOG" 2>&1 &
      ok "Started the Hermes gateway (log: $HLOG)"
      warn "It runs until this Mac restarts. To keep it always on, use Hermes' own start-at-login option."
    else
      say "Start it in another Terminal tab with:  hermes gateway"
    fi
  fi
  printf '  Waiting for Hermes on %s ' "$BASE"
  for _ in $(seq 1 45); do healthy && break; printf '.'; sleep 2; done
  echo
  healthy || die "Hermes didn't come up on $BASE within 90 seconds. Start it with 'hermes gateway', then run: npm run setup:hermes"
fi

# ---- 5. Verify the key
code="$(auth_status)"
case "$code" in
  200) ok "Hermes accepted Relay's key at $BASE/v1" ;;
  401|403) die "Hermes rejected the key (HTTP $code). An API_SERVER_KEY set in your shell or config.yaml may override $HERMES_ENV. Remove the other one, restart Hermes, and run this again." ;;
  *) die "Unexpected answer from Hermes (HTTP $code). Check 'hermes gateway' output for errors." ;;
esac

echo
ok "Hermes is connected."
if [ -z "${RELAY_SETUP_ALL:-}" ]; then
  echo
  say "Next: npm run hub, open http://127.0.0.1:4747, and send:  @hermes reply with one word: ready"
  echo
fi
