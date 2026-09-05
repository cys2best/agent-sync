# Project Context

> Single source of truth for project knowledge. Per-agent context files
> (`CLAUDE.md`, `AGENTS.md`) import or point to this file — edit it here,
> not in any of those.

## What this project is
`agent-sync` is a Claude Code plugin and multi-agent coordination system that scaffolds
shared project context and a deterministic handoff log so multiple coding agents
(Claude Code, OpenAI Codex, Google Antigravity/Gemini CLI, Cursor) working the same repo stay in
sync, without duplicating anything Superpowers already owns.

## Tech stack & Environment
- **Language / runtime**: Python 3.10+ (scripts & test suite), Markdown (command specs), JSON (registries & configs)
- **Package manager**: none (standard library only)
- **Test runner**: Python standard `unittest`
- **Linter / Typecheck**: `python3 -m json.tool` (JSON syntax validation)
- **Environment setup**: none required (standard library only)

## Build & verify commands
- **Run whole test suite**: `python3 -m unittest discover -s tests -p "test_*.py"`
- **Run specific test file**: `python3 -m unittest tests/test_archive.py`
- **Run single test**: `python3 -m unittest tests.test_archive.TestArchiveScript.test_single_finished_plan_is_archived`
- **Typecheck (fast)**: none (standard Python / Markdown)
- **Lint single file**: `python3 -m json.tool registry/agents.json > /dev/null`
- **Lint entire project**: `python3 -c "import json, glob; [json.load(open(f)) for f in glob.glob('registry/*.json')]"`
- **Pre-PR Verification Ritual**:
  ```bash
  python3 -m unittest discover -s tests -p "test_*.py" && \
  python3 -c "import json, glob; [json.load(open(f)) for f in glob.glob('registry/*.json')]"
  ```

## Architecture & Boundaries
<!-- Structural layout and layer constraints. Keep rules paired with enforcement where possible. -->
- **Command Architecture (`commands/*.md`)**:
  - Every command spec follows a strict 3-phase lifecycle:
    - `Phase 1 (Preflight)`: Strictly read-only. Detects, validates, renders in memory, and classifies targets. No disk writes.
    - `Phase 2 (Apply)`: Atomically applies staged writes and migrations.
    - `Phase 3 (Verify & Report)`: Re-reads applied files, asserts byte preservation of unmanaged blocks, and reports disposition.
- **Registry Boundary (`registry/*.json`)**:
  - Pure declarative data models for known agents and workflow tools.
  - Commands must dynamically consume registry definitions — never hardcode agent-specific or tool-specific branching inside `commands/*.md`.
- **Scripts Boundary (`.agent-sync/scripts/`)**:
  - Deterministic helper scripts (e.g., `archive.py`) run as standalone Python CLI utilities without external dependencies.
- **Context Stubs Boundary (`CLAUDE.md`, `AGENTS.md`)**:
  - Kept intentionally thin (~40 lines). They contain only agent-specific invocation syntax and workflow pointers. No project facts belong here.

## Conventions
- Branch naming: not detected — fill in manually if adopted
<!-- agent-sync:project-policy:start -->
- Commit message format: `<type>(optional-scope): imperative description`
- Commit convention source: Conventional Commits fallback
- Commit examples: `feat(scaffold): enforce workflow execution`; `fix(policy): preserve unmanaged content`
- Live execution state (task briefs, reports, progress, and reviews) is owned by
  Superpowers at `.superpowers/sdd/`, `docs/superpowers/`. Never edit those
  artifacts outside the applicable Superpowers workflow.
<!-- agent-sync:project-policy:end -->
- Code style notes: plain Markdown for commands/docs, 2-space indented JSON for configs/registries, PEP 8 for Python scripts.

## Things NOT to do
<!-- Strict negative guardrails to prevent common AI overreach -->
- **Do not edit workflow state**: Never hand-edit `.superpowers/sdd/` or `docs/superpowers/` (Superpowers-owned lifecycle state).
- **No hardcoded agent logic**: Do not add hardcoded `if agent == 'gemini'` conditions in command prompts; add registry entries or `.agent-sync/config.json` custom objects instead.
- **Never write in Phase 1**: Command preflights must remain 100% read-only until explicit approval/validation succeeds.
- **No AI attribution footers**: Do not add `Co-Authored-By` or AI attribution trailers to commit messages or PRs.

## Project Gotchas & Domain Quirks
<!-- Domain traps, schema quirks, and non-obvious runtime behaviors.
     RULE: Only add items that tripped up an agent/dev AND cannot be enforced via types or linters. -->
- **Import Syntax Divergence**: Claude Code resolves `@path` imports automatically; Codex, Antigravity, and Gemini CLI do not. Never use `@docs/...` syntax in `AGENTS.md` or files intended for non-Claude agents.
- **Rule Scoping Isolation**: `.claude/rules/*.md` path rules are invisible to Codex and Antigravity. Any repository-wide rule must live here in `docs/PROJECT_CONTEXT.md` so all agents see it.
- **Configuration Precedence**: `.agent-sync/config.json` takes priority over root `.agent-sync.json`. If root `.agent-sync.json` exists, commands must stage a migration to move it into `.agent-sync/`.
- **Handoff Log Minimalism**: `HANDOFF.md` is strictly an agent turn-taking ledger (`Claiming`, `Finished`, `Next`, `Blockers`). Never write task summaries, architecture designs, or progress prose into `HANDOFF.md` — that belongs in workflow tool state (`.superpowers/sdd/`).

## Error Recovery & Learning Protocol
When an agent encounters a bug, incorrect assumption, or user correction:
1. **Reproduce with code**: Write a failing unit/regression test in `tests/` before applying the fix.
2. **Classify the lesson**:
   - If caught by a test/compiler: Keep it in code. Do not add text to documentation.
   - If it is an architectural boundary rule: Add ONE bullet to `## Things NOT to do`.
   - If it is a subtle domain/runtime trap: Add ONE bullet to `## Project Gotchas & Domain Quirks`.
3. **Format**: Strict one-line format: `[Component/Symbol]: [Issue / What to use instead]`.

## Plan & spec structure
- Multiple plans can be active at once. See HANDOFF.md for which agent
  owns which plan/task right now.

## Architecture notes
- `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` —
  plugin identity and single-plugin marketplace listing.
- `commands/setup.md`, `commands/project-context.md`, `commands/archive-handoff.md` —
  the commands this plugin ships; reads registries and repo configuration to manage context and handoffs.
- `registry/agents.json` — built-in defaults for claude/codex/gemini/cursor/antigravity.
- `registry/workflow-tools.json` — built-in defaults for workflow/plan-execution tools (Superpowers).
- This repo's own root-level `CLAUDE.md`/`AGENTS.md`/`HANDOFF.md`/`docs/PROJECT_CONTEXT.md` are this project dogfooding its own plugin.

## Decisions log
<!-- Promote real decisions here as they're made. Newest on top. -->
- 2026-09-05: Enhanced `docs/PROJECT_CONTEXT.md` template and detection in `commands/` with granular test syntax, architecture boundaries, and error recovery learning protocol.
- 2026-09-05: Added deterministic `archive.py` script and unit tests in `tests/test_archive.py` to archive completed tasks from `HANDOFF.md`.
- 2026-09-05: Added Antigravity agent support and vendor directory discovery to `registry/agents.json` and `commands/`.
- 2026-08-29: Generalized from a two-agent (Claude/Codex) hardcoded prototype to an N-agent, config+registry-driven Claude Code plugin.
