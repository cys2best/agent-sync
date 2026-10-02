---
name: setup
description: Create or update shared multi-agent project context and agent-mem guidance, with optional global code-review-graph installation or explicit upgrades.
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
---

## Overview

Scaffold or update shared multi-agent context files (`AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `COMMIT_CONVENTION.md`, and `.claude/settings.json`).
File rendering, project stack detection, and managed-block updates are deterministically executed by `skills/setup/scripts/setup.py` using templates in `skills/setup/templates/`.

Cross-agent session history and handoff come from agent-mem, not from files in the repo: the generated policy tells agents to use `/agent-sync:mem-search` and `/agent-sync:resume`.

## Phase 1 — Resolve configuration and options

1. Accept `--regenerate-context`, `--skip-code-review-graph`, `--upgrade-code-review-graph`, `--code-review-graph-version TAG`, `--allow-downgrade`, and `--dry-run`. Normal setup never silently upgrades code-review-graph. Resolve helper paths from this skill's installed directory (not the target project's working directory).
   - `--dry-run` previews the global graph integration and skips project scaffolding and all global writes. Forward upgrade/version/downgrade options to the graph helper with `--dry-run`, then report and stop.
   - Forward `--regenerate-context` to `setup.py` for a full rescan and archival backup.
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

## Phase 3 — Optional global code-review-graph integration

1. Unless `--skip-code-review-graph` was supplied, inspect local status (no network or writes):

   ```bash
   python3 "<installed-skill-dir>/scripts/install_code_review_graph.py" --status
   ```

2. Select enabled agents whose `registry/agents.json` definition includes `codeReviewGraph` (currently Claude Code, Codex, Antigravity). Custom or unsupported agents are skipped. If none apply, report this and proceed to verification.
3. If absent and no explicit upgrade/version request was supplied, ask: "Install code-review-graph v2.3.9 globally for <enabled supported agents>? This adds its package, seven skills, context, and MCP configuration, without hooks." A declined answer skips the integration. Obtain approval before fetching or installing it.
4. If installed and no explicit upgrade/version request was supplied, run the read-only helper with `--check --agents <comma-separated IDs>`. A complete result needs no apply and no GitHub request. If only legacy hook/adapter artifacts are reported, preview the normal helper with `--dry-run`, obtain cleanup approval, then rerun with `--yes`, without version/upgrade flags: this removes unchanged installer-owned hooks locally with backups and no fetch/build. Other missing integrations or newly enabled agents may need the recorded immutable release: preview with `--dry-run`, obtain approval for that repair/addition, then apply with `--yes`. Edited managed content is reported as a conflict and preserved.
5. For an explicit upgrade or exact version request, run the helper with the corresponding options and `--dry-run`. Show the old/new tags, commit SHA, and changed paths. If the request already authorizes applying that version, continue; otherwise obtain confirmation. Pin the commit shown in the preview for the apply command:

   ```bash
   python3 "<installed-skill-dir>/scripts/install_code_review_graph.py" \
     --agents claude,codex,antigravity --version <resolved-tag> --commit <resolved-sha> --yes
   ```

   Add `--allow-downgrade` only when the user explicitly requested it. Never reinterpret a declined upgrade as permission to install something else.
6. The helper reads `templates/CODE-REVIEW-GRAPH.template` from this skill, resolves GitHub releases to commits, prepares a separate virtualenv, and installs the same seven upstream skill directories for each agent:
   `build-graph`, `debug-issue`, `explore-codebase`, `refactor-safely`, `review-changes`, `review-delta`, `review-pr`.
   It uses the global context/skills/MCP paths declared in the registry. Antigravity uses `~/.gemini/AGENTS.md` and `~/.gemini/config/`; Codex skills use `~/.agents/skills`. It does not install code-review-graph hooks or configure the daemon. Unrelated hooks, including agent-mem, are preserved.
7. Malformed config or user-edited managed content stops preflight before writes. Report the exact conflict and preserve it. Do not delete conflicting skills, rewrite malformed settings, or invoke the upstream `code-review-graph install` as a workaround.
8. Successful changes have timestamped backups and manifest ownership hashes under `~/.agent-sync/`. Report the installed version and backup location; remind the user to restart agents and initialize each repository with `build-graph`. Graph updates use their separately configured multi-repo daemon. Existing TOML configuration requires Python 3.11+ for standard-library validation.

The direct shell entry point is `python3 "<installed-skill-dir>/scripts/install_code_review_graph.py"`; use `--help` for status, version, upgrade, dry-run, and agent-selection options.

## Phase 4 — Verify and report

1. Re-read generated/updated target files (`AGENTS.md`, `COMMIT_CONVENTION.md`, `CLAUDE.md`, `MEMORY.md`, `.agent-sync/TDD.md`, `.claude/settings.json`).
2. Verify created/updated files maintain expected managed markers.
3. Report disposition for every target: created, updated, regenerated, or preserved.
4. Relay any `agent-mem hooks not installed` lines to the user with the exact command. Do not run it yourself: it edits the user's global agent config outside this repository.
