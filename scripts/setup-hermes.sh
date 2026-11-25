#!/usr/bin/env bash
# Connect Relay to Hermes Agent's API server.
#   1. Turns on Hermes' API server with a random key (~/.hermes/.env, backed up first)
#   2. Puts the same key and URL in Relay's .env (never printed)
#   3. Restarts the Hermes gateway if needed (asks first)
#   4. Checks that Hermes answers with that key
# Safe to run again: it keeps an existing key and only fills in what is missing.
set -euo pipefail

cd "$(dirname "$0")/.."
RELAY_DIR="$(pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
HERMES_ENV="$HERMES_HOME/.env"
RELAY_ENV="$RELAY_DIR/.env"

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# Read KEY from a dotenv file (last match wins, quotes stripped).
get_kv() {
  [ -f "$1" ] || return 0
  awk -v k="$2" '
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" k "[[:space:]]*=" {
      sub("^[[:space:]]*(export[[:space:]]+)?" k "[[:space:]]*=[[:space:]]*", "")
      gsub(/^["'\'']|["'\'']$/, "")
      v = $0
    }
    END { if (v != "") print v }' "$1"
}

# Set KEY=VALUE in a dotenv file: replace existing lines, else append. Portable (no sed -i).
set_kv() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  awk -v k="$key" -v v="$value" '
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" k "[[:space:]]*=" { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$file" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

echo
echo "  Relay ← Hermes setup"
echo

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
  if command -v openssl >/dev/null; then KEY="$(openssl rand -hex 32)"; else KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"; fi
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
if [ ! -f "$RELAY_ENV" ]; then
  cp .env.example "$RELAY_ENV"
  ok "Created Relay's .env from .env.example"
fi
chmod 600 "$RELAY_ENV"
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
    reply="y"
    if [ -t 0 ]; then read -r -p "  Restart the Hermes gateway now? [Y/n] " reply || true; fi
    if [[ "${reply:-y}" =~ ^[Yy]?$|^[Yy][Ee][Ss]$ ]]; then
      if "$HERMES_BIN" gateway restart; then ok "Restarted the Hermes gateway"; else warn "'hermes gateway restart' failed. Restart Hermes yourself, then run this script again."; fi
    else
      warn "Skipped. Restart Hermes yourself (hermes gateway restart), then run this script again."
      exit 0
    fi
  else
    say "Hermes' gateway isn't running. Start it in another Terminal tab:"
    echo
    echo "      hermes gateway"
    echo
  fi
  printf '  Waiting for Hermes on %s ' "$BASE"
  for _ in $(seq 1 60); do healthy && break; printf '.'; sleep 2; done
  echo
  healthy || die "Hermes didn't come up on $BASE within 2 minutes. Start it with 'hermes gateway' and run this again."
fi

# ---- 5. Verify the key
code="$(auth_status)"
case "$code" in
  200) ok "Hermes accepted Relay's key at $BASE/v1" ;;
  401|403) die "Hermes rejected the key (HTTP $code). An API_SERVER_KEY set in your shell or config.yaml may override $HERMES_ENV. Remove the other one, restart Hermes, and run this again." ;;
  *) die "Unexpected answer from Hermes (HTTP $code). Check 'hermes gateway' output for errors." ;;
esac

echo
echo "  Hermes is connected. Next:"
echo
echo "      npm run hub"
echo
echo "  Then open http://127.0.0.1:4747. Hermes' card should say 'Hermes API server · online'."
echo "  Send:  @hermes reply with one word: ready"
echo
