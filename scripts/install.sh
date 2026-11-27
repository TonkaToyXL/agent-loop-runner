#!/usr/bin/env bash
# One-line install or update for Relay on a Mac:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/TonkaToyXL/agent-loop-runner/claude/friendly-babbage-yr8apd/scripts/install.sh)"
# Downloads Relay to ~/agent-loop-runner (or updates it), then runs the guided setup.
# Re-running is safe: your .env and settings are kept.
set -euo pipefail

REPO="https://github.com/TonkaToyXL/agent-loop-runner.git"
BRANCH="${RELAY_BRANCH:-claude/friendly-babbage-yr8apd}"
DIR="${RELAY_HOME:-$HOME/agent-loop-runner}"

say() { printf '  %s\n' "$*"; }
die() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

echo
say "Relay installer"
echo
command -v git >/dev/null || die "git is missing. On a Mac, run: xcode-select --install   then run this again."

if [ -d "$DIR/.git" ]; then
  say "Updating Relay in ${DIR}…"
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  if ! git -C "$DIR" diff --quiet || ! git -C "$DIR" diff --cached --quiet; then
    die "You have local code changes in $DIR. Commit or stash them, then run this again."
  fi
  git -C "$DIR" checkout --quiet "$BRANCH" 2>/dev/null || git -C "$DIR" checkout --quiet -b "$BRANCH" "origin/$BRANCH"
  git -C "$DIR" merge --quiet --ff-only "origin/$BRANCH" || die "Couldn't update cleanly. Your copy has its own commits; ask for help before forcing anything."
elif [ -e "$DIR" ]; then
  die "$DIR exists but isn't a Relay checkout. Move it aside or set RELAY_HOME to another folder."
else
  say "Downloading Relay to ${DIR}…"
  git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
fi

cd "$DIR"
# Keep the keyboard as input even if this script itself was piped in.
if { : </dev/tty; } 2>/dev/null; then
  exec bash scripts/setup-mac.sh </dev/tty
else
  exec bash scripts/setup-mac.sh
fi
