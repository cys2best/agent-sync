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
  project-context generation, adds a compact exclusion boundary in
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

Re-running without regeneration is safe. Generated policy is confined to managed blocks, so a
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

It performs full repository detection and rendering when the file is
missing or `--regenerate` is supplied:
it inspects package manifests, lockfiles, README, test/lint config, git log,
and `.gitignore`, and auto-discovers dependency and vendor directories
(`node_modules`, `vendor`, `.venv`, etc.), then writes real content instead of a
blank template. The compact context targets 80 lines, with a ceiling of 120 lines
and 1,200 words: purpose/stack, essential commands, up to five boundaries, shared
policy, and at most five one-line lessons. Unknown fields, empty sections,
duplicate facts, architecture inventories, and historical decisions are omitted.
Lessons use `Component: pitfall → action`; merge duplicates and replace obsolete
entries, keeping testable regressions in tests. Detected vendor paths share one
boundary bullet.

Shared policy includes concise versions of the first three
[Karpathy-inspired principles](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/README.md#the-four-principles-in-detail):
state meaningful assumptions before coding, choose the simplest sufficient
implementation, and keep changes confined to the requested work. These apply
to all configured agents and models and refresh with the managed policy block.

On a rerun without `--regenerate`, ownership is
deliberately narrower: it refreshes only the managed `project-policy` block and
preserves every byte outside that block. Technical context, architecture notes,
and other user-maintained sections are therefore not automatically refreshed
after stack changes. An oversized existing file is reported, not automatically
trimmed.
Requires `/agent-sync:setup` to have run at least once.

To rescan the repository and replace an existing context with the compact
template, run either command:

```text
/agent-sync:project-context --regenerate
/agent-sync:setup --regenerate-context
```

Both retain still-valid project constraints and lessons, remove redundant or
obsolete content, and show the proposed diff before applying it. The flag
authorizes whole-file replacement, including content outside managed markers.
The original is saved byte-for-byte to a unique
`.agent-sync/backups/PROJECT_CONTEXT.<unique-id>.md` before replacement; the
command reports that path so you can recover it. Broken markers are preserved
and reported. Without the flag, existing preservation behavior is unchanged.
The setup flag also works on repeat runs and leaves existing configuration
choices intact.

`HANDOFF.md` grows every session. To move finished plans' entries out into
`.agent-sync/HANDOFF.archive.md` and keep the active log short, run:

```
/agent-sync:archive-handoff
```

A plan is considered finished, and its entries archived, once every task it
ever claimed has a matching `Finished:` line and no entry still lists it
under `Next:`. Entries that mix a finished plan with a still-open one stay
in `HANDOFF.md` until both are finished.

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
