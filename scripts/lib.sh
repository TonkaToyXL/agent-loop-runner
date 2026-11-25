# Shared helpers for Relay's setup scripts. Source after `cd` to the repo root.
# shellcheck shell=bash

RELAY_DIR="$(pwd)"
RELAY_ENV="$RELAY_DIR/.env"
# shellcheck disable=SC2034  # used by scripts that source this file
TELEGRAM_API="${TELEGRAM_API_BASE:-https://api.telegram.org}"

if [ -t 1 ]; then G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; N=$'\033[0m'; else G=""; Y=""; R=""; B=""; N=""; fi
say()  { printf '  %s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '  %s✗%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
title() { printf '\n  %s%s%s\n\n' "$B" "$*" "$N"; }

# ask "Question?" default(y|n) -> returns 0 for yes. Non-interactive runs take the default.
ask() {
  local q="$1" def="${2:-y}" hint reply
  [ "$def" = y ] && hint="[Y/n]" || hint="[y/N]"
  if [ -t 0 ]; then read -r -p "  $q $hint " reply || reply=""; else reply=""; fi
  reply="${reply:-$def}"
  [[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]]
}

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

ensure_relay_env() {
  if [ ! -f "$RELAY_ENV" ]; then
    cp "$RELAY_DIR/.env.example" "$RELAY_ENV"
    ok "Created Relay's .env"
  fi
  chmod 600 "$RELAY_ENV"
}

random_hex() {
  if command -v openssl >/dev/null; then openssl rand -hex "${1:-32}"; else node -e "console.log(require('crypto').randomBytes(${1:-32}).toString('hex'))"; fi
}

# JSON field from stdin using node (always present for Relay). Usage: json_get '.result.username'
json_get() {
  node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        let v = JSON.parse(s);
        for (const k of process.argv[1].split(".").filter(Boolean)) v = v?.[/^\d+$/.test(k) ? Number(k) : k];
        if (v !== undefined && v !== null) process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
      } catch {}
    });' "$1"
}

relay_service_label() { echo "com.relay.hub"; }

# Stop the background Relay service if it's running (macOS), so setup steps don't fight it.
stop_relay_service() {
  [ "$(uname)" = Darwin ] || return 0
  if launchctl print "gui/$(id -u)/$(relay_service_label)" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$(relay_service_label)" >/dev/null 2>&1 || true
    # shellcheck disable=SC2034
    RELAY_WAS_RUNNING=1
    ok "Paused the Relay background service during setup"
  fi
}
