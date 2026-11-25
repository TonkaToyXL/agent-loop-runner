#!/usr/bin/env bash
# Add Gemini (your Google AI Pro plan) to Relay through Google's own Antigravity CLI (agy).
# Relay only runs the official, unmodified agy command on this Mac. It never reads or copies
# your Google sign-in. Off until you opt in here.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

title "Gemini via Antigravity (Google AI Pro)"
ensure_relay_env

say "How this works: Relay runs Google's own 'agy' command in headless mode, the way"
say "Google's docs describe for scripts. It never touches your Google sign-in."
say "Antigravity's terms forbid third-party tools that use your Antigravity login;"
say "Relay doesn't do that. A reply on Google's developer forum says scripted 'agy -p'"
say "runs under your own account are allowed, but Google hasn't put that in the terms."
echo
if ! ask "Add Gemini this way?" y; then
  set_kv "$RELAY_ENV" ANTIGRAVITY_ENABLED false
  ok "Left off. Run 'npm run setup:antigravity' any time to change that."
  exit 0
fi

AGY="$(command -v agy || true)"
if [ -z "$AGY" ]; then
  warn "The Antigravity CLI ('agy') isn't installed on this Mac."
  say "Install it from https://antigravity.google/product/antigravity-cli, run 'agy' once"
  say "and sign in with your Google AI Pro account, then run: npm run setup:antigravity"
  exit 0
fi
ok "Found agy at $AGY"

# Listing models needs a signed-in session but doesn't run a model, so it costs nothing.
if MODELS="$(agy models 2>&1)"; then
  ok "Signed in. Models on your plan:"
  printf '%s\n' "$MODELS" | head -25 | sed 's/^/      /'
  say "Pick one later in Gemini's editor (or keep 'default' to use agy's own choice)."
else
  warn "agy isn't signed in yet: $(printf '%s' "$MODELS" | tail -1)"
  say "Run 'agy' once in Terminal, sign in with your Google AI Pro account, then rerun this."
  exit 0
fi

set_kv "$RELAY_ENV" ANTIGRAVITY_ENABLED true
ok "Gemini is on. Relay runs it from an empty folder with agy's terminal sandbox turned on."
