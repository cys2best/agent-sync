# Claude Code Instructions

<!-- agent-sync:agent-policy:start -->
This file is intentionally thin. All real project knowledge lives in the
shared files below so other agents see the same thing.

@docs/PROJECT_CONTEXT.md
@HANDOFF.md
@AGENTS.local.md

## Claude Code specific
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
- Read `HANDOFF.md` to see which agent (Codex, Antigravity) last touched
  each plan/task and what's next.
- Before claiming or executing a plan task, check whether the user's prompt
  explicitly names a configured workflow tool or its artifacts. Only then use
  that tool's official lifecycle for the whole task, including its required
  verification and report. A prompt that doesn't mention a workflow tool gets
  a direct, ordinary execution path — do not route it through a workflow tool
  on your own inference.
- When claiming or progressing a plan task, update that plan's entry in
  `HANDOFF.md` in-place (or add an entry if starting a new plan): record
  `claude`, current task, finished tasks, next task, and blockers.
- Before committing, read the convention in `docs/PROJECT_CONTEXT.md`. If it
  names a repository policy file, read that source too. Follow its format and
  examples. Keep plan names, task numbers, agent identity, and AI-attribution
  out of the commit message; workflow state and `HANDOFF.md` retain task
  traceability.
- Do not add a "Co-Authored-By" trailer or AI-attribution footer to
  commits or PRs. If this agent's setup has an equivalent
  auto-attribution behavior, disable it the same way
  `.claude/settings.json` does for Claude Code.
- Keep only one entry per active plan in `HANDOFF.md`; update it in-place with
  task IDs only. Do not add entries for idle sessions where no tasks progressed.
<!-- agent-sync:agent-policy:end -->
