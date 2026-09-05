# agent-sync

Keep multiple coding agents (Claude Code, Codex, Antigravity, Grok, Gemini, Cursor, or any
custom agent) in sync on shared project context and task handoff when
they work on the same repo — without duplicating what
[Superpowers](https://github.com/obra/superpowers) already owns.

## What this solves

- **Cross-tool project memory** — Claude Code reads `CLAUDE.md`, Codex
  reads `AGENTS.md`, other agents read their own context file. None of
  them read each other's natively, so project context (tech stack,
  conventions, build commands) needs one canonical place all of them
  point to: `docs/PROJECT_CONTEXT.md`.
- **Shared context file disambiguation** — When multiple configured agents
  share a single context file (such as Codex and Antigravity both reading
  `AGENTS.md`), agent-sync generates self-disambiguating multi-agent instructions
  so each agent identifies itself properly in handoffs and task claims without
  overwriting each other.
- **Cross-tool handoff** — Superpowers tracks task state within a plan,
  but nothing tracks which agent is working which task right now, or
  leaves notes for whichever agent picks up the work next. That's
  `HANDOFF.md`.
- **Token cost & context conservation** — Auto-discovers dependency and vendor
  directories (`node_modules`, `vendor`, `.venv`, etc.) during setup and
  project-context generation, populates "Things NOT to do" in
  `docs/PROJECT_CONTEXT.md`, and scaffolds `permissions.ask` in
  `.claude/settings.json` to prevent agents from wasting context on third-party code.
- **No manual re-explaining** — `docs/PROJECT_CONTEXT.md` is generated
  by inspecting your actual repo, not hand-written from a blank
  template.
- **Clean git history** — neither agent identity nor AI-attribution
  trailers leak into commits.

## Install

### Claude Code
Add this repo as a marketplace source, then install the plugin:
```
/plugin marketplace add cys2best/agent-sync
/plugin install agent-sync
```

### Google Antigravity (`agy`)
Clone into your Antigravity global configuration (or workspace `.agents/` directory):
```bash
# Global installation (available across all projects)
git clone https://github.com/cys2best/agent-sync.git ~/.gemini/config/plugins/agent-sync

# Or workspace-level installation
git clone https://github.com/cys2best/agent-sync.git .agents/plugins/agent-sync
```
Antigravity automatically loads `agent-sync` commands and respects project instructions in `AGENTS.md`.

### Grok (Grok Build CLI)
Clone into Grok's skills directory:
```bash
# Global installation (available across all projects)
git clone https://github.com/cys2best/agent-sync.git ~/.grok/skills/agent-sync
```
Grok Build automatically reads repository conventions and handoffs from `AGENTS.md`.

## Use

In any project, run:

```
/agent-sync:setup
```

First run: it asks which agents are working this repo (offering built-in
defaults for Claude Code, Codex, Antigravity, Grok, Gemini, and Cursor — see
`registry/agents.json` — plus support for custom agents), which
workflow/plan-execution tools are in use (offering Superpowers by default —
see `registry/workflow-tools.json` — plus support for none or a custom
tool), and whether to also generate `docs/PROJECT_CONTEXT.md` now. It then
writes `.agent-sync/config.json`, context files for configured agents (grouping
agents that share a context file, such as Codex, Antigravity, and Grok sharing
`AGENTS.md`, with self-disambiguating multi-agent instructions), `HANDOFF.md`,
and `.claude/settings.json` (scaffolding `permissions.ask` for discovered vendor
directories).

Re-running is safe. Generated policy is confined to managed blocks, so a
rerun replaces only those blocks and preserves surrounding content. It safely
migrates only recognized historical renderings; unrecognized or malformed
files are left for review rather than overwritten. A pre-existing root
`.agent-sync.json` from an older install is migrated automatically to
`.agent-sync/config.json` the first time any agent-sync command runs.

To generate `docs/PROJECT_CONTEXT.md` after declining it during setup, or to
refresh agent-sync's managed project-policy block, run:

```
/agent-sync:project-context
```

It performs full repository detection and rendering only when the file is
missing:
it inspects package manifests, lockfiles, README, test/lint config, git log,
and `.gitignore`, and auto-discovers dependency and vendor directories
(`node_modules`, `vendor`, `.venv`, etc.), then writes real content instead of a
blank template. Discovered vendor directories are populated under "Things NOT to
do" to conserve context and reduce token cost. On a rerun, ownership is
deliberately narrower: it refreshes only the managed `project-policy` block and
preserves every byte outside that block. Technical context, architecture notes,
and other user-maintained sections are therefore not automatically refreshed
after stack changes. Requires `/agent-sync:setup` to have run at least once.

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
7. At session end, append a compact handoff entry to `HANDOFF.md` with task IDs
   only (`plan-name/task-N` or `none`) — rich execution details belong in workflow
   state (e.g. `.superpowers/sdd/`).

## Notes

- `.claude/settings.json`'s `attribution` block disables the
  Co-Authored-By commit trailer and "Generated with Claude Code" PR
  footer for the project it's scaffolded into, while its `permissions.ask`
  block guards discovered vendor directories (e.g. `Read(./node_modules/**)`,
  `Read(./vendor/**)`, `Read(./.venv/**)`) to prompt before reading vendored code.
  To apply settings everywhere instead of one repo, copy the blocks into
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
