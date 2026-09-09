# Project Context

## Overview

agent-sync scaffolds shared context and task handoffs for coding agents through Markdown commands/skills and JSON registries. Helpers and tests use Python 3.10+ and the standard library; no dependency installation is needed.

## Commands

- Verify: `python3 -m unittest discover -s tests -p "test_*.py" && python3 -c "import json, glob; [json.load(open(f)) for f in glob.glob('registry/*.json')]"`
- Focused test: `python3 -m unittest tests.test_archive.TestArchiveScript.test_single_finished_plan_is_archived`

## Boundaries

- `commands/*.md`: preflight is read-only; apply only staged writes, then reread and verify preservation of unmanaged bytes.
- `registry/*.json`: declarative agent/workflow definitions; commands consume registry or custom config instead of hardcoded agent/tool branches.
- `.agent-sync/scripts/`: deterministic standalone Python helpers without external dependencies.
- `CLAUDE.md` and `AGENTS.md`: thin agent-specific pointers; shared project knowledge belongs here.
- `HANDOFF.md`: task-ID ledger only; execution details remain in the workflow's own reports.

## Conventions

<!-- agent-sync:project-policy:start -->
- Commit format: `<type>(optional-scope): imperative description`
- Commit source: Conventional Commits fallback
- Commit example: `feat(config): add workflow model policies`
- Live execution state belongs to Superpowers at `.superpowers/sdd/` and `docs/superpowers/`; use its lifecycle and never hand-edit those paths.
- Think Before Coding: State consequential assumptions and tradeoffs; ask when ambiguity changes the result, and suggest a simpler approach when appropriate.
- Simplicity First: Implement only the requested behavior with the smallest clear solution; avoid speculative features, configuration, and abstractions.
- Surgical Changes: Match local style, change only what the task requires, and remove only code made unused by your changes; flag unrelated cleanup separately.
- Learning: Keep up to five one-line lessons (25 words each) as `Component: pitfall → action`; merge duplicates, replace obsolete entries, and prefer regression tests.
- Context upkeep: Aim for 80 lines, at most 120 lines and 1,200 words; keep actionable facts once, link to existing detail, and omit history, progress, and empty sections.
<!-- agent-sync:project-policy:end -->
- Style: Markdown command specs, JSON indented with two spaces, Python following PEP 8.
- No agent identity, plan/task IDs, or AI attribution in commit messages or PRs; keep task traceability in handoffs and workflow state.
- Bug fixes: reproduce the failure in a regression test before changing the implementation.

## Lessons

- Imports: only Claude Code resolves `@path` references → other agents must read shared files explicitly.
- Rule visibility: Claude-specific rules are invisible to other agents → keep repository-wide constraints here.
- Config precedence: `.agent-sync/config.json` wins → migrate root `.agent-sync.json` only when the canonical file is absent.
