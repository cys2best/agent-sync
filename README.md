# agent-sync

Keep multiple coding agents (Claude Code, Codex, Antigravity, Grok, Gemini, Cursor, or any
custom agent) in sync on shared project context and task handoff when
they work on the same repo — without duplicating what
[Superpowers](https://github.com/obra/superpowers) already owns.

## What this solves

- **Universal project memory in `AGENTS.md`** — All agents (Codex, Antigravity,
  Cursor, Grok, and Claude Code via a minimal `CLAUDE.md` redirect) read a
  single canonical instructions and project context file: `AGENTS.md`. No separate
  `docs/PROJECT_CONTEXT.md` is required.
- **Minimal `CLAUDE.md` bridge** — Claude Code natively expects `CLAUDE.md`, so
  agent-sync scaffolds a minimal managed pointer directing Claude Code to read
  and follow `AGENTS.md`. Because `AGENTS.md` references `AGENTS.local.md`, there
  is no need for `claude.local.md`.
- **Durable learnings in `MEMORY.md`** — Project learnings, component pitfalls,
  and lessons are maintained in `MEMORY.md` at the project root, keeping
  `AGENTS.md` focused on actionable instructions and boundaries.
- **Cross-tool handoff** — Superpowers tracks task state within a plan,
  but nothing tracks which agent is working which task right now, or
  leaves notes for whichever agent picks up the work next. That's
  `HANDOFF.md`.
- **Token cost & context conservation** — Auto-discovers dependency and vendor
  directories (`node_modules`, `vendor`, `.venv`, etc.) during setup,
  adds a compact exclusion boundary in `AGENTS.md`, and scaffolds
  `permissions.ask` in `.claude/settings.json` to prevent agents from wasting
  context on third-party code.
- **No manual re-explaining** — `AGENTS.md` and `MEMORY.md` are populated by
  inspecting your actual repo, not hand-written from a blank template.
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
Antigravity automatically loads `agent-sync` skills and respects project instructions in `AGENTS.md`.

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
`registry/agents.json` — plus support for custom agents) and which
workflow/plan-execution tools are in use (offering Superpowers by default —
see `registry/workflow-tools.json` — plus support for none or a custom
tool). It then writes `.agent-sync/config.json`, `AGENTS.md` (with full project
context and agent instructions), `CLAUDE.md` (a minimal managed redirect to
`AGENTS.md`), `MEMORY.md` (for project learnings and component pitfalls),
`HANDOFF.md`, and `.claude/settings.json` (scaffolding `permissions.ask` for
discovered vendor directories).

Re-running without regeneration is safe. Generated policy is confined to managed blocks, so a
rerun replaces only those blocks and preserves surrounding content; unrecognized or malformed
files are left for review rather than overwritten. A pre-existing root
`.agent-sync.json` from an older install is migrated automatically to
`.agent-sync/config.json` the first time any agent-sync command runs.

Shared policy includes concise versions of the first three
[Karpathy-inspired principles](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/README.md#the-four-principles-in-detail):
state meaningful assumptions before coding, choose the simplest sufficient
implementation, and keep changes confined to the requested work. These apply
to all configured agents and models and refresh with the managed policy block.

To rescan the repository and refresh project context inside `AGENTS.md`, run:

```text
/agent-sync:setup --regenerate-context
```

This rescans package manifests, lockfiles, README, test/lint config, git log,
and `.gitignore`, and auto-discovers dependency and vendor directories
(`node_modules`, `vendor`, `.venv`, etc.). It retains still-valid project
constraints, removes redundant or obsolete content, and shows the proposed diff
before applying it. The original `AGENTS.md` is saved byte-for-byte to a unique
`.agent-sync/backups/AGENTS.<unique-id>.md` before replacement; the command
reports that path so you can recover it. Broken markers are preserved and
reported. The setup flag also works on repeat runs and leaves existing
configuration choices intact.

`HANDOFF.md` grows every session. To move finished plans' entries out into
`.agent-sync/HANDOFF.archive.md` and keep the active log short, run:

```
/agent-sync:archive-handoff
```

A plan is considered finished, and its entries archived, once every task it
ever claimed has a matching `Finished:` line and no entry still lists it
under `Next:`. Entries that mix a finished plan with a still-open one stay
in `HANDOFF.md` until both are finished.

## Persistent memory (agent-mem)

`agent-mem` records sessions, tool activity, and chat turns across agents into a
local SQLite store, and injects a short project digest at the start of each
session. It needs [Bun](https://bun.sh) on `PATH`; the daemon starts on demand
at `http://localhost:3777`.

**Claude Code** — nothing to configure. The plugin's `SessionStart` and `Stop`
hooks run automatically. At session start you see a summary like:

```
agent-mem · my-project
12 sessions · 48 observations · last activity 2h ago
Search past work: /agent-sync:mem-search
Live viewer: http://localhost:3777/p/<project-id>
```

**Antigravity** — install the hooks once (global, or `--scope project` for the
current workspace):

```bash
bun run <plugin-dir>/agent-mem/bin/agent-mem.ts setup --agent antigravity
```

**Codex** — install the hooks once. This merges `SessionStart` and `Stop` into
`~/.codex/hooks.json` (or `.codex/hooks.json` with `--scope project`), keeping
any hooks already there; rerun it after upgrading the plugin:

```bash
bun run <plugin-dir>/agent-mem/bin/agent-mem.ts setup --agent codex
```

Search past work with the `/agent-sync:mem-search` skill, or directly:

```bash
bun run <plugin-dir>/agent-mem/bin/agent-mem.ts search "<query>"
bun run <plugin-dir>/agent-mem/bin/agent-mem.ts get <observation-id>
```

When a session stops, its transcript is recorded and summarized as the first
prompt plus the files edited, so the next agent sees lines like
`[ses] (codex, 2h ago): fix login retries · edited guard.ts, token.ts`.

### Resuming another agent's unfinished session

When one agent stops mid-task (for example Claude hits its usage limit during
a final review), switch to another agent and run:

```
/agent-sync:resume
```

It reads the stopped session's transcript straight from disk (so it works even
when the limit cut off the Stop hook) and loads about 500 tokens: why it
stopped, the task, the last replies, recent tool calls, the latest subagent
result (with the path to its full report), and files changed. The agent then
continues the in-progress step instead of starting over. When the previous
session in a project stopped early, the startup summary says so:

```
⚠ claude session 9785cc73 stopped: rate_limit: You've hit your session limit (4m ago) — run /agent-sync:resume
```

The same data is available from the CLI: `agent-mem sessions` lists recent
sessions with how each ended, and `agent-mem handoff [session-id]` prints one
(default: the latest interrupted session).

The injected digest is capped at about 250 tokens (`maxDigestTokens` in
`agent-mem/src/config.ts`): the three most recent sessions plus as many recent
observations as fit, each clipped to 120 characters. It does not grow with
history; older work stays searchable instead. Wrap private details in
`<private>` tags to keep them out of the store.

## Workflow model selection

To spend more reasoning on planning and review, add optional `modelPolicy`
to `.agent-sync/config.json`, then rerun `/agent-sync:setup`. Existing agents
and workflows stay as configured; policy keys must reference enabled IDs.
For example, a project using Claude Code, Codex, and Antigravity can use:

```json
{
  "agents": ["claude", "codex", "antigravity"],
  "workflowTools": ["superpowers"],
  "modelPolicy": {
    "superpowers": {
      "claude": {
        "planning": "sonnet",
        "implementation": "haiku",
        "review": "sonnet",
        "escalation": "ask"
      },
      "codex": {
        "planning": "gpt-5.6-sol",
        "implementation": "gpt-5.6-luna",
        "review": "gpt-5.6-sol",
        "escalation": "ask"
      },
      "antigravity": {
        "planning": "gemini-flash3.7",
        "implementation": "gemini-flash3.7",
        "review": "gemini-flash3.7",
        "escalation": "ask"
      }
    }
  }
}
```

These are recommended starting points, not guarantees that the cheaper model
can implement every plan. Research and replanning use `planning`; coding and
test execution use `implementation` once the plan is ready; task reviews and
the final branch review use `review`. All three model strings are required
for an explicit policy. They may be supported aliases or exact model IDs.

Bundled presets (Claude/Codex checked against official documentation on
2026-09-10; Antigravity uses the project-selected ID):

| Agent | Planning and review | Implementation | Source |
| --- | --- | --- | --- |
| Claude Code | `sonnet` | `haiku` | [Claude model selection](https://code.claude.com/docs/en/sub-agents#choose-a-model) |
| Codex | `gpt-5.6-sol` | `gpt-5.6-luna` | [OpenAI model guidance](https://learn.chatgpt.com/docs/models) |
| Antigravity | `gemini-flash3.7` | `gemini-flash3.7` | Project-selected model ID; availability checked in the host |

Use stronger implementation models for work that still needs substantial
design judgment. Cursor, Gemini CLI, Grok, and custom agents accept explicit
phase mappings, but have no bundled preset: select IDs supported by the
particular host and account. The legacy `gemini` agent ID remains supported,
but its bundled model preset has been replaced by Antigravity's. Existing
`gemini: "balanced"` policies must be changed to explicit model mappings or
moved to an enabled `antigravity` entry. Antigravity defaults to the exact
`gemini-flash3.7` string for all phases, including diagnosis and review; this
is a requested configuration value, not a verified provider alias. Model
availability must be checked in the running host.

An agent policy can also be `"balanced"`, which uses its registry
`modelDefaults` and asks before escalation. Explicit mappings pin the chosen
strings independently of future preset changes. `escalation` accepts:

- `auto`: move to the planning model when redesign is needed or the same
  failure persists after two attempted fixes; report why, then return to the
  implementation model once the revised plan is ready.
- `ask` (default): ask before that escalation.
- `never`: stop the blocked task rather than escalate. The scheduled final
  review still uses the review model.

This is an instruction-based policy, not a model-launching service. Setup
renders agent-specific policy into managed context blocks. The workflow uses
its supported model controls; if it cannot select a model, it requests a
manual switch or supported replacement. It reports requested versus actual
models where the host exposes them, and otherwise marks the actual model
unverified. It never silently substitutes a model. For native controls see
[Claude subagents](https://code.claude.com/docs/en/sub-agents) and
[Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Policies apply only to an already-engaged workflow and do not activate one.
Omitting `modelPolicy`, using `{}`, or omitting a workflow/agent entry leaves
that scope's existing selection unchanged. Rerun setup after adding or removing
policies so the managed context blocks match; existing policy instructions
also reread their config entry before each phase. Setup preserves an existing
config, so edit it directly to change selections on subsequent runs. No
workflow-owned state or globally installed skills are modified.

## Workflow

1. Start each session by reading `HANDOFF.md`, `MEMORY.md`, and
   `AGENTS.md` (Claude Code starts at `CLAUDE.md` which points directly to
   `AGENTS.md`).
2. Claim a task by updating that plan's entry in `HANDOFF.md` in-place
   (or creating an entry if starting a new plan): `Claiming: plan-name/task-N`.
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
7. At session end, update the plan's entry in `HANDOFF.md` in-place with task IDs
   only (`plan-name/task-N`) — rich execution details belong in workflow
   state (e.g. `.superpowers/sdd/`). Do not add entries for idle sessions.

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
- Keep `AGENTS.md` as the central place real project knowledge and
  instructions live; `CLAUDE.md` is a minimal pointer — don't let instructions
  drift into duplicate, conflicting content.
- Workflow/plan-execution tools (Superpowers by default, or any custom
  tool listed in `.agent-sync/config.json`) own their own state paths entirely
  — this plugin doesn't scaffold, own, or instruct agents to write into
  them.

## License

MIT — see [LICENSE](LICENSE).
