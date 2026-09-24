---
description: Create or update .agent-sync/config.json and scaffold per-agent context files, HANDOFF.md, MEMORY.md, COMMIT_CONVENTION.md, and .claude/settings.json so multiple coding agents share project context and task handoff.
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
---

## Overview

Scaffold or update shared multi-agent context files (`AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `COMMIT_CONVENTION.md`, `HANDOFF.md`, and `.claude/settings.json`).
File rendering, project stack detection, and managed-block updates are deterministically executed by `skills/setup/scripts/setup.py` using templates in `skills/setup/templates/`.

## Phase 1 — Resolve configuration and options

1. Accept optional `--regenerate-context` argument. If passed, forward it to `setup.py` to trigger a full rescan and create an archival backup under `.agent-sync/backups/`.
2. Check if `.agent-sync/config.json` exists:
   - If it exists, use the existing configuration.
   - If `.agent-sync.json` exists at repo root, `setup.py` will automatically migrate it to `.agent-sync/config.json`.
   - If neither exists (first-run):
     - Check the repo root for hints (`AGENTS.md`, `CLAUDE.md`, `.superpowers/`).
     - Ask the user which agents to enable (defaults: `claude,codex,antigravity`).
     - Ask the user which workflow tools to enable (default: `superpowers`).

## Phase 2 — Execute setup script

Run the deterministic setup helper:

```bash
python3 "${CLAUDE_PLUGIN_ROOT:-.}/skills/setup/scripts/setup.py" [args]
```

Arguments:
- `--target-dir PATH`: Target repository directory (default: current directory).
- `--regenerate-context`: Rescan project and create a timestamped backup before updating `AGENTS.md`.
- `--agents claude,codex,...`: Specify enabled agents on first run.
- `--workflow-tools superpowers,...`: Specify workflow tools on first run.

The script will:
- Inspect project stack, commands, vendor directories, and boundaries.
- Render target files using modular templates (`skills/setup/templates/*.template`).
- Preserve any custom content outside managed markers (`<!-- agent-sync:...:start -->` ... `<!-- agent-sync:...:end -->`).
- Preserve `COMMIT_CONVENTION.md` byte-for-byte if it already exists.
- Configure `.claude/settings.json` with the `archive.py` hook and vendor permission limits.
- Remove obsolete `docs/PROJECT_CONTEXT.md` if present.
- Ensure `.agent-sync/scripts/archive.py` is installed in the target repository.

## Phase 3 — Verify and report

1. Re-read generated/updated target files (`AGENTS.md`, `COMMIT_CONVENTION.md`, `CLAUDE.md`, `MEMORY.md`, `HANDOFF.md`, `.claude/settings.json`).
2. Verify created/updated files maintain expected managed markers.
3. Report disposition for every target: created, updated, regenerated, or preserved.
