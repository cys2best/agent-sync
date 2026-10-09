---
name: setup
description: Initialize or update zero-config project context and best practices, with optional handoff to install-code-review-graph.
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
---

## Overview

Initialize or update zero-config multi-agent project context files (`AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, and `.claude/settings.json`).
File rendering, project stack detection, and managed-block updates are deterministically executed by `skills/setup/scripts/setup.py` using templates in `skills/setup/templates/`.

Cross-agent session history and handoff come from agent-mem, not from files in the repo: the generated instructions guide agents to use `/agent-sync:mem-search` and `/agent-sync:resume`.

## Context Design Principles — Resizing and Trimming Context

Scaffolded `AGENTS.md` (and `CLAUDE.md`) files are kept ultra-lean by cutting off generic rules and bloat rather than appending to them:

1. **Keep them lightweight and focused on gotchas**: Briefly describe what the repository is for in the overview, but dedicate most of the token budget to codebase-specific "gotchas" or architectural constraints (e.g., keeping types in one monolithic file, subtle domain traps, or non-obvious runtime invariants).
2. **Omit the obvious**: Avoid stating details that agents can easily deduce by inspecting repository layout, `package.json`, `.gitignore`, or the file system. Cut off directory trees, generic language conventions, and self-evident vendor folders.
3. **Rely on model judgment over rigid rules**: Cut off generic agent preaching and strict guardrails (such as "never write multi-paragraph comment blocks", "think before coding", "simplicity first", or arbitrary word/line caps) that create conflicting instructions and waste compute. Trust model judgment to match surrounding code style and local architecture patterns.
4. **Leverage progressive disclosure**: Do not turn `AGENTS.md` into a central dumping ground for every edge-case instruction. Cut off deep workflow details and keep the file lean, linking out to specialized skill files or reference guides only when relevant.

## Phase 1 — Resolve configuration and options

1. Accept `--regenerate-context`, `--skip-code-review-graph`, `--upgrade-code-review-graph`, `--code-review-graph-version TAG`, `--allow-downgrade`, and `--dry-run`. Project scaffolding is zero-prompt and focuses on repository-scoped files. Global code-review-graph management is handled by the `install-code-review-graph` skill.
   - Forward `--regenerate-context` to `setup.py` for a full rescan and archival backup.
2. Setup is completely zero-prompt: it does not ask for active agents, writing universal instructions that work across all modern coding agents.

## Phase 2 — Execute setup script

Run the deterministic setup helper:

```bash
python3 "${CLAUDE_PLUGIN_ROOT:-.}/skills/setup/scripts/setup.py" [args]
```

Arguments:
- `--target-dir PATH`: Target repository directory (default: current directory).
- `--regenerate-context`: Rescan project and create a timestamped backup before updating `AGENTS.md`.

The script will:
- Inspect project stack, commands, and key architectural constraints while omitting obvious directory trees or vendor boilerplate.
- Render target files using modular templates (`skills/setup/templates/*.template`), structuring codebase constraints under `## Key Constraints & Gotchas`.
- Preserve any custom content outside managed markers (`<!-- agent-sync:...:start -->` ... `<!-- agent-sync:...:end -->`).
- Preserve `MEMORY.md` byte-for-byte if it already exists.
- Always scaffold or update minimal `CLAUDE.md` redirecting to `AGENTS.md`.
- Configure `.claude/settings.json` attribution and vendor permission limits, and remove legacy hooks if present.
- Remove legacy `.agent-sync/config.json` or `.agent-sync.json` if encountered.
- Leave an existing `HANDOFF.md` untouched (it is no longer managed) and say so.
- Remove obsolete `docs/PROJECT_CONTEXT.md` if present.
- Print the `agent-mem setup` command for any detected Codex or Antigravity installation whose global hooks lack agent-mem.

## Phase 3 — Optional global code-review-graph integration

Global code-review-graph installation and upgrades are owned by the dedicated `/agent-sync:install-code-review-graph` skill.

1. On initial project setup, check if code-review-graph is installed globally:

   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT:-.}/skills/install-code-review-graph/scripts/install_code_review_graph.py" --status
   ```

2. If not installed and the user has not specified `--skip-code-review-graph`, offer to install it using `/agent-sync:install-code-review-graph`.
3. If explicit graph arguments are passed to `setup.py` (`--upgrade-code-review-graph`, `--code-review-graph-version`, `--code-review-graph-status`), `setup.py` delegates directly to `skills/install-code-review-graph/scripts/install_code_review_graph.py`.

## Phase 4 — Verify and report

1. Re-read generated/updated target files (`AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `.claude/settings.json`).
2. Verify created/updated files maintain expected managed markers, stay lightweight and focused on gotchas, omit obvious file details, and avoid overconstraining rules.
3. Report disposition for every target: created, updated, regenerated, or preserved.
4. Relay any `agent-mem hooks not installed` lines to the user with the exact command. Do not run it yourself: it edits the user's global agent config outside this repository.
