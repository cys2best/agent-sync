# agent-sync

Keep multiple coding agents (Claude Code, Codex, Gemini, Cursor, or any
custom agent) in sync on shared project context and task handoff when
they work on the same repo — without duplicating what
[Superpowers](https://github.com/obra/superpowers) already owns.

## What this solves

- **Cross-tool project memory** — Claude Code reads `CLAUDE.md`, Codex
  reads `AGENTS.md`, other agents read their own context file. None of
  them read each other's natively, so project context (tech stack,
  conventions, build commands) needs one canonical place all of them
  point to: `docs/PROJECT_CONTEXT.md`.
- **Cross-tool handoff** — Superpowers tracks task state within a plan,
  but nothing tracks which agent is working which task right now, or
  leaves notes for whichever agent picks up the work next. That's
  `HANDOFF.md`.
- **No manual re-explaining** — `docs/PROJECT_CONTEXT.md` is generated
  by inspecting your actual repo, not hand-written from a blank
  template.
- **Clean git history** — neither agent identity nor AI-attribution
  trailers leak into commits.

## Install

Add this repo as a marketplace source, then install the plugin:

```
/plugin marketplace add cys2best/agent-sync
/plugin install agent-sync
```

## Use

In any project, run:

```
/agent-sync:setup
```

First run: it asks which agents are working this repo (offering built-in
defaults for Claude Code, Codex, Gemini, and Cursor — see
`registry/agents.json` — plus support for custom agents), which
workflow/plan-execution tools are in use (offering Superpowers by default —
see `registry/workflow-tools.json` — plus support for none or a custom
tool), and whether to also generate `docs/PROJECT_CONTEXT.md` now. It then
writes `.agent-sync/config.json`, one context file per agent, `HANDOFF.md`,
and `.claude/settings.json`.

Re-running is safe. Generated policy is confined to managed blocks, so a
rerun replaces only those blocks and preserves surrounding content. It safely
migrates only recognized historical renderings; unrecognized or malformed
files are left for review rather than overwritten. A pre-existing root
`.agent-sync.json` from an older install is migrated automatically to
`.agent-sync/config.json` the first time any agent-sync command runs.

To (re)generate `docs/PROJECT_CONTEXT.md` on its own — for example, after
declining it during setup, or to refresh it after the repo's tech stack
changes — run:

```
/agent-sync:project-context
```

It inspects the repo (package manifests, lockfiles, README, test/lint
config, git log, `.gitignore`) and writes real content instead of a blank
template. Requires `/agent-sync:setup` to have run at least once.

`HANDOFF.md` grows every session. To move finished plans' entries out into
`.agent-sync/HANDOFF.archive.md` and keep the active log short, run:

```
/agent-sync:archive-handoff
```

A plan is considered finished, and its entries archived, once every task it
ever claimed has a matching `Finished:` line and no entry still lists it
under `Next:`. Entries that mix a finished plan with a still-open one stay
in `HANDOFF.md` until both are finished.

## Workflow

1. Start each session by reading `HANDOFF.md` then
   `docs/PROJECT_CONTEXT.md` (agents with `@path` import support, like
   Claude Code, do this automatically).
2. Claim a task by adding a line to `HANDOFF.md`:
   `Claiming plan-name/task-N — <agent-id>`.
3. Before plan-scoped work, inspect each configured workflow's activation
   signals and owned state. If a task is activated, follow that workflow's
   official lifecycle, including final verification and its report. Never
   substitute a manual path or edit the workflow-owned state; if the workflow
   cannot be invoked, stop and report the blocker.
4. The workflow registry supplies `activationSignals` and
   `executionInstructions`. Older custom workflow entries without both fields
   use the strict generic fallback: inspect owned state, use the tool's
   official lifecycle, and stop if it is unavailable.
5. Commit policy is detected locally in priority order: commitlint,
   `COMMIT_CONVENTION.md`, contributing guidance, a local commit template,
   then sufficiently consistent history. Otherwise use the Conventional
   Commits fallback: `<type>(optional-scope): imperative description`.
   Plan and task IDs stay in `HANDOFF.md` and workflow state, not commit
   subjects.
6. Every SDD task, including final verification, needs its
   workflow-generated brief and report.
7. At session end, append a handoff entry to `HANDOFF.md`.

## Notes

- `.claude/settings.json`'s `attribution` block disables the
  Co-Authored-By commit trailer and "Generated with Claude Code" PR
  footer for the project it's scaffolded into. To apply it everywhere
  instead of one repo, copy the same block into
  `~/.claude/settings.json`.
- Agent identity only ever appears in `HANDOFF.md` — never in commit
  messages or trailers.
- Keep `docs/PROJECT_CONTEXT.md` as the only place real project
  knowledge lives; the per-agent context files are thin pointers —
  don't let them drift into duplicate, conflicting content.
- Workflow/plan-execution tools (Superpowers by default, or any custom
  tool listed in `.agent-sync/config.json`) own their own state paths entirely
  — this plugin doesn't scaffold, own, or instruct agents to write into
  them.

## License

MIT — see [LICENSE](LICENSE).
