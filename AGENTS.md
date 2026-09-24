# Agent Instructions (Claude Code, Codex, Antigravity)

<!-- agent-sync:agent-policy:start -->
This file contains shared project knowledge, conventions, and agent instructions.

See:
- HANDOFF.md — the running log between agents, per plan/task
- MEMORY.md — project learnings, component pitfalls, and durable lessons
- COMMIT_CONVENTION.md — commit message format and rules
- AGENTS.local.md — local private notes and personal overrides (gitignored)

## Overview

agent-sync scaffolds shared context and task handoffs for coding agents through Markdown commands/skills and JSON registries. Helpers and tests use Python 3.10+ and the standard library; no dependency installation is needed.

## Commands

- Verify: `python3 -m unittest discover -s tests -p "test_*.py" && python3 -c "import json, glob; [json.load(open(f)) for f in glob.glob('registry/*.json')]"`
- Focused test: `python3 -m unittest tests.test_archive.TestArchiveScript.test_single_finished_plan_is_archived`

## Boundaries

- `commands/*.md` & `skills/*`: preflight is read-only; apply only staged writes, then reread and verify preservation of unmanaged bytes.
- `registry/*.json`: declarative agent/workflow definitions; commands consume registry or custom config instead of hardcoded agent/tool branches.
- `.agent-sync/scripts/`: deterministic standalone Python helpers without external dependencies.
- `CLAUDE.md`: minimal pointer to `AGENTS.md`; shared project knowledge and agent instructions belong here.
- `HANDOFF.md`: task-ID ledger only; execution details remain in the workflow's own reports.
- `MEMORY.md`: durable project lessons and component pitfalls.
- `COMMIT_CONVENTION.md`: Conventional Commits format and rules.

## Conventions

- Commit format: `<type>(optional-scope): imperative description` (see `COMMIT_CONVENTION.md`)
- Commit example: `feat(config): add workflow model policies`
- Live execution state belongs to Superpowers at `.superpowers/sdd/` and `docs/superpowers/`; use its lifecycle and never hand-edit those paths.

## Claude Code, Codex, Antigravity specific
- Only engage Superpowers when the user's prompt explicitly names it
  or its plan/task artifacts (e.g. mentions Superpowers by name, or
  references a path under `.superpowers/sdd/`, `docs/superpowers/`). Do not infer that a task belongs to
  this workflow from task shape, complexity, or ambient activation signals
  (`.superpowers/sdd/*/progress.md`, `docs/superpowers/plans/*.md`) alone — plain requests get a direct, ordinary
  execution path. When the prompt does invoke Superpowers, follow
  these rules in order:
  1. When a requested task belongs to an active Superpowers plan, resume it through the applicable Superpowers execution workflow.
  2. Keep task briefs, reports, progress, reviews, and completion state inside the Superpowers SDD flow.
  3. Never execute a managed task manually or create or edit Superpowers-owned artifacts directly.
  4. If the required workflow cannot be invoked, stop and report the blocker.
  Do not substitute a manual or generic execution path once engaged.
- Read `HANDOFF.md` to see which agent last touched each plan/task and what's next.
- Before claiming or executing a plan task, check whether the user's prompt
  explicitly names a configured workflow tool or its artifacts. Only then use
  that tool's official lifecycle for the whole task, including its required
  verification and report. A prompt that doesn't mention a workflow tool gets
  a direct, ordinary execution path — do not route it through a workflow tool
  on your own inference.
- When claiming or progressing a plan task, update that plan's entry in
  `HANDOFF.md` in-place (or add an entry if starting a new plan): record your
  active agent identifier (use claude/codex/antigravity depending on which agent you
  are running as), current task, finished tasks, next task, and blockers.
- Before committing, follow the commit convention in `COMMIT_CONVENTION.md`. Keep plan names, task numbers, agent identity, and AI-attribution
  out of the commit message; workflow state and `HANDOFF.md` retain task
  traceability.
- Do not add a "Co-Authored-By" trailer or AI-attribution footer to
  commits or PRs. Disable auto-attribution in your respective agent config.
- Keep only one entry per active plan in `HANDOFF.md`; update it in-place with
  task IDs only. Do not add entries for idle sessions where no tasks progressed.
- Think Before Coding: State consequential assumptions and tradeoffs; ask when ambiguity changes the result, and suggest a simpler approach when appropriate.
- Simplicity First: Implement only the requested behavior with the smallest clear solution; avoid speculative features, configuration, and abstractions.
- Surgical Changes: Match local style, change only what the task requires, and remove only code made unused by your changes; flag unrelated cleanup separately.
- Learning: Keep up to five one-line lessons (25 words each) in MEMORY.md as `Component: pitfall → action`; merge duplicates, replace obsolete entries, and prefer regression tests.
- Context upkeep: Aim for 80 lines, at most 120 lines and 1,200 words; keep actionable facts once, link to existing detail, and omit history, progress, and empty sections.
<!-- agent-sync:agent-policy:end -->
