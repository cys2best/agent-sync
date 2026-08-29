# Project Context

> Single source of truth for project knowledge. Per-agent context files
> import or point to this file — edit it here, not in any of those.

## What this project is
`agent-sync` is a Claude Code plugin that scaffolds shared project
context and a task handoff log so multiple coding agents (Claude Code,
Codex, Gemini, Cursor, or custom agents) working the same repo stay in
sync, without duplicating anything Superpowers already owns.

## Tech stack
- Language / framework: none — the plugin's content is Markdown
  (plugin commands, docs) and JSON (plugin/marketplace/registry/config)
- Package manager: none
- Test runner: none — the scaffold command is instructions for an LLM,
  not code; correctness is checked by hand-applying the documented
  procedure to scratch directories and asserting output (see
  `docs/superpowers/plans/2026-08-29-agent-sync-plugin.md` Task 2)
- Lint / format command: none

## Build & verify commands
```
# install: add this repo as a Claude Code marketplace source, then
#          `/plugin install agent-sync`
# build:   none — plugin ships as-is
# test:    manual scratch-directory verification, see Task 2 of the
#          implementation plan referenced above
# lint:    none
```

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
- Code style notes: plain Markdown for commands/docs, plain JSON
  (2-space indent) for plugin/registry/config files
- Things NOT to do: don't hand-edit `.superpowers/sdd/` or
  `docs/superpowers/` (Superpowers-owned); don't add per-agent or
  per-workflow-tool hardcoded logic to
  `commands/scaffold-shared-context.md` — new agents and new workflow
  tools are registry entries or `.agent-sync.json` custom objects, not
  code changes

## Plan & spec structure
- Multiple plans can be active at once. See HANDOFF.md for which agent
  owns which plan/task right now.

## Architecture notes
- `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` —
  plugin identity and single-plugin marketplace listing.
- `commands/scaffold-shared-context.md` — the one command this plugin
  ships; reads `registry/agents.json` (built-in known agents) and
  `registry/workflow-tools.json` (built-in known workflow/plan tools)
  plus a consumer repo's `.agent-sync.json` (which agents and workflow
  tools this project uses) to generate per-agent context files,
  `HANDOFF.md`, and `docs/PROJECT_CONTEXT.md`.
- `registry/agents.json` — built-in defaults for claude/codex/gemini/
  cursor (display name, context filename, whether it supports Claude
  Code's `@path` import syntax).
- `registry/workflow-tools.json` — built-in defaults for workflow/
  plan-execution tools (currently just Superpowers: display name, the
  paths it owns and that generated context files must never instruct
  an agent to hand-edit).
- This repo's own root-level `CLAUDE.md`/`AGENTS.md`/`HANDOFF.md`/
  `docs/PROJECT_CONTEXT.md`/`.agent-sync.json` are this project
  dogfooding its own plugin for its own Claude Code + Codex dev
  workflow, using Superpowers as its workflow tool.

## Decisions log
- 2026-08-29: Generalized from a two-agent (Claude/Codex) hardcoded
  prototype to an N-agent, config+registry-driven Claude Code plugin,
  for public distribution. Also generalized workflow/plan-execution
  tool ownership (previously hardcoded to Superpowers) into its own
  registry, so a future non-Superpowers planning tool doesn't require
  a code change. See
  `docs/superpowers/specs/2026-08-29-agent-sync-plugin-design.md`.
