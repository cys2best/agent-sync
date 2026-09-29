#!/usr/bin/env bash
# Install or upgrade agent-sync for every detected coding agent. Safe to rerun.
#   curl -fsSL https://raw.githubusercontent.com/cys2best/agent-sync/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/cys2best/agent-sync/main/install.sh | bash -s -- --dry-run
set -euo pipefail

repo="${AGENT_SYNC_REPO:-https://github.com/cys2best/agent-sync.git}"
home="${AGENT_SYNC_HOME:-$HOME/.agent-sync}"

for tool in git bun; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "agent-sync: $tool is required but was not found on PATH." >&2
    exit 1
  fi
done

if [ -d "$home/.git" ]; then
  if [ -n "$(git -C "$home" status --porcelain)" ]; then
    echo "agent-sync: $home has local changes; skipping update and installing the current checkout." >&2
  elif ! git -C "$home" pull --ff-only --quiet; then
    echo "agent-sync: could not fast-forward $home; installing the current checkout." >&2
  fi
elif [ -e "$home" ]; then
  echo "agent-sync: $home exists but is not a git checkout; move it or set AGENT_SYNC_HOME." >&2
  exit 1
else
  git clone --quiet "$repo" "$home"
fi

exec bun run "$home/agent-mem/bin/agent-mem.ts" install "$@"
