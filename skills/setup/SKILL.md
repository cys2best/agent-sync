---
name: setup
description: Create or update .agent-sync/config.json and scaffold AGENTS.md, CLAUDE.md, MEMORY.md, COMMIT_CONVENTION.md, and .claude/settings.json so multiple coding agents share project context and use agent-mem memory.
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
---

## Overview

Scaffold or update shared multi-agent context files (`AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `COMMIT_CONVENTION.md`, and `.claude/settings.json`).
File rendering, project stack detection, and managed-block updates are deterministically executed by `skills/setup/scripts/setup.py` using templates in `skills/setup/templates/`.

Cross-agent session history and handoff come from agent-mem, not from files in the repo: the generated policy tells agents to use `/agent-sync:mem-search` and `/agent-sync:resume`.

## Phase 1 — Resolve configuration and options

1. Accept optional `--regenerate-context` argument. If passed, forward it to `setup.py` to trigger a full rescan and create an archival backup under `.agent-sync/backups/`.
2. Check if `.agent-sync/config.json` exists:
   - If it exists, use the existing configuration.
   - If `.agent-sync.json` exists at repo root, `setup.py` will automatically migrate it to `.agent-sync/config.json`.
   - If neither exists (first-run), check the repo root for hints (`AGENTS.md`, `CLAUDE.md`) and ask the user which agents to enable (defaults: `claude,codex,antigravity`).

## Phase 2 — Execute setup script

Run the deterministic setup helper:

```bash
python3 "${CLAUDE_PLUGIN_ROOT:-.}/skills/setup/scripts/setup.py" [args]
```

Arguments:
- `--target-dir PATH`: Target repository directory (default: current directory).
- `--regenerate-context`: Rescan project and create a timestamped backup before updating `AGENTS.md`.
- `--agents claude,codex,...`: Specify enabled agents on first run.

The script will:
- Inspect project stack, commands, vendor directories, and boundaries.
- Render target files using modular templates (`skills/setup/templates/*.template`).
- Preserve any custom content outside managed markers (`<!-- agent-sync:...:start -->` ... `<!-- agent-sync:...:end -->`).
- Preserve `COMMIT_CONVENTION.md` and `MEMORY.md` byte-for-byte if they already exist.
- Create `.agent-sync/TDD.md`, the default TDD workflow agents follow when no plugin workflow is in use; preserve it if it exists.
- Add `.agent-sync/todo/` (the TDD workflow's local todo lists) to `.gitignore` if it is not listed.
- Configure `.claude/settings.json` attribution and vendor permission limits, and remove the HANDOFF archive hook older versions installed.
- Drop the retired `workflowTools` key from `.agent-sync/config.json`.
- Leave an existing `HANDOFF.md` untouched (it is no longer managed) and say so.
- Remove obsolete `docs/PROJECT_CONTEXT.md` if present.
- Print the `agent-mem setup` command for any enabled Codex or Antigravity agent whose global hooks lack agent-mem.

## Phase 3 — Verify and report

1. Re-read generated/updated target files (`AGENTS.md`, `COMMIT_CONVENTION.md`, `CLAUDE.md`, `MEMORY.md`, `.agent-sync/TDD.md`, `.claude/settings.json`).
2. Verify created/updated files maintain expected managed markers.
3. Report disposition for every target: created, updated, regenerated, or preserved.
4. Relay any `agent-mem hooks not installed` lines to the user with the exact command. Do not run it yourself: it edits the user's global agent config outside this repository.
