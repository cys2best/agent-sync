---
name: install-code-review-graph
description: Install, upgrade, verify, or inspect the global code-review-graph integration (package runtime, skills, doc, context mention, and MCP configuration) for Claude Code, Codex, and Antigravity.
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
---

## Overview

Install, upgrade, verify, or inspect the global [code-review-graph](https://github.com/tirth8205/code-review-graph) integration across supported coding agents (`claude`, `codex`, `antigravity`).

The integration installs:
1. **Isolated runtime**: An immutable versioned virtualenv and executable under `~/.local/share/agent-sync/code-review-graph/`.
2. **Seven core skills**: `build-graph`, `debug-issue`, `explore-codebase`, `refactor-safely`, `review-changes`, `review-delta`, and `review-pr` into each agent's global skills directory (`~/.claude/skills`, `~/.agents/skills`, `~/.gemini/config/skills`).
3. **Dedicated documentation file**: `code-review-graph.md` created in each agent's config directory (`~/.claude/code-review-graph.md`, `~/.codex/code-review-graph.md`, `~/.gemini/code-review-graph.md`), populated from `templates/CODE-REVIEW-GRAPH.template`.
4. **Context reference**: A concise managed block in each agent's global instructions file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/AGENTS.md`) pointing to `code-review-graph.md` rather than duplicating the entire documentation inline.
5. **Global MCP server**: Configured in `~/.claude.json`, `~/.codex/config.toml`, and `~/.gemini/config/mcp_config.json`.

All operations are transactional, journaled, backed up to `~/.agent-sync/backups/code-review-graph/`, and tracked with SHA-256 hashes in `~/.agent-sync/code-review-graph.json`. Existing unmanaged or user-modified files are strictly preserved.

## Phase 1 — Inspect status and health (read-only)

Run read-only preflight checks before any changes:

```bash
# Check current installation status
python3 "${CLAUDE_PLUGIN_ROOT:-.}/skills/install-code-review-graph/scripts/install_code_review_graph.py" --status

# Verify installation health without network requests or file modifications
python3 "${CLAUDE_PLUGIN_ROOT:-.}/skills/install-code-review-graph/scripts/install_code_review_graph.py" --check
```

- If `--check` reports `complete: true`, the installation is healthy and matches recorded hashes. No further action is required.
- If `--status` reports `installed: false`, proceed to Phase 2 for initial installation.
- If legacy hooks from older installer versions are reported in `missing`, proceed with a dry-run removal.

## Phase 2 — Plan and preview changes

Select the target agents and action:
- **Default install**: Installs tested stable tag `v2.3.9` for all supported agents.
- **Upgrade**: `--upgrade` resolves GitHub's latest stable release to an immutable commit.
- **Pin specific version**: `--version <tag>` (e.g. `--version v2.3.9`).
- **Downgrade**: `--version <tag> --allow-downgrade`.

Always preview changes first with `--dry-run`:

```bash
python3 "${CLAUDE_PLUGIN_ROOT:-.}/skills/install-code-review-graph/scripts/install_code_review_graph.py" \
  --agents claude,codex,antigravity \
  --dry-run
```

Review the output:
- Shows which files will be created, updated, or removed.
- Validates configuration syntax and ownership before any write.
- Confirms the old and new version tags and commit hashes.

## Phase 3 — Apply installation or upgrade

Once confirmed, apply the installation with explicit user consent or `--yes`:

```bash
python3 "${CLAUDE_PLUGIN_ROOT:-.}/skills/install-code-review-graph/scripts/install_code_review_graph.py" \
  --agents claude,codex,antigravity \
  --yes
```

For explicit pinned upgrades:

```bash
python3 "${CLAUDE_PLUGIN_ROOT:-.}/skills/install-code-review-graph/scripts/install_code_review_graph.py" \
  --agents claude,codex,antigravity \
  --version <tag> \
  --commit <resolved-sha> \
  --yes
```

## Phase 4 — Verification and instructions

1. Run `--check` to confirm all integration files and runtime are verified.
2. Report the installed version and backup location.
3. Instruct the user:
   - Restart coding agents to reload MCP servers and skills.
   - Run `/build-graph` in repositories to initialize or inspect the local graph.
   - Graph updates are handled by the multi-repo daemon (no hooks installed).
