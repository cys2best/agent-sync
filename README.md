# agent-sync

Keep multiple coding agents (Claude Code, Codex, Antigravity, Grok, Gemini, Cursor, or any
custom agent) in sync on shared project context and cross-agent memory when
they work on the same repo — including picking up a session another agent left
unfinished — without duplicating what workflow plugins such as
[Superpowers](https://github.com/obra/superpowers) already own.

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
- **Cross-agent memory and handoff** — agent-mem records every agent's
  sessions and injects a short digest at startup. When one agent stops
  mid-task (for example on a usage limit), another runs `/agent-sync:resume`
  and continues the in-progress step instead of starting over. Workflow
  plugins keep their own task state; agent-sync only fills the gap between
  agents.
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

One command installs agent-sync for every coding agent it finds on your
machine. Run the same command again to upgrade.

```bash
curl -fsSL https://raw.githubusercontent.com/cys2best/agent-sync/main/install.sh | bash
```

It needs `git` and [Bun](https://bun.sh). It clones the repo to
`~/.agent-sync` (or pulls it if it's already there), then installs each agent
it detects:

| Agent | Detected by | Skills | agent-mem hooks |
|---|---|---|---|
| Claude Code | `claude` on PATH | Plugin `agent-sync@agent-sync` from the `cys2best/agent-sync` marketplace (installed or updated) | Ship with the plugin |
| Codex | `codex` on PATH | Plugin `agent-sync@agent-sync` from a local marketplace at `~/.agent-sync` | Merged into `~/.codex/hooks.json` |
| Antigravity | `agy` on PATH or `~/.gemini/config` | `~/.gemini/config/plugins/agent-sync` links to `~/.agent-sync` | `agent-mem` entry in `~/.gemini/config/hooks.json` |
| Grok | `grok` on PATH or `~/.grok` | `~/.grok/skills/agent-sync` links to `~/.agent-sync` | — |

Rerunning is safe: hooks from other tools are kept, nothing is added twice, and
a hooks file that isn't valid JSON is reported and left alone. An older copy
already sitting at a plugin path (for example a previous `git clone` into
`~/.gemini/config/plugins/agent-sync`) is moved to `~/.agent-sync-backups/`.

Options (pass after `bash -s --`):

- `--dry-run` shows what would change without changing anything.
- `--agent <claude|codex|antigravity|grok>` installs one agent only.

To install from a clone you are developing in, set `AGENT_SYNC_HOME`:

```bash
AGENT_SYNC_HOME=~/code/agent-sync ./install.sh
```

Codex installs the clone's last commit, so commit before rerunning to pick up
local changes. Claude Code always installs from GitHub.

After installing or upgrading, restart your agents and rerun
`/agent-sync:setup` in each project to pick up new templates.

<details>
<summary>Manual install</summary>

- **Claude Code:** `/plugin marketplace add cys2best/agent-sync`, then `/plugin install agent-sync`.
- **Codex:** `codex plugin marketplace add <clone>`, then `codex plugin add agent-sync@agent-sync`.
- **Antigravity:** clone or link the repo to `~/.gemini/config/plugins/agent-sync` (or `.agents/plugins/agent-sync` for one workspace).
- **Grok:** clone or link the repo to `~/.grok/skills/agent-sync`.

Hooks for Codex and Antigravity: `bun run <clone>/agent-mem/bin/agent-mem.ts setup --agent <codex|antigravity>` (add `--scope project` for the current workspace only).

</details>

## Use

In any project, run:

```
/agent-sync:setup
```

First run: it asks which agents are working this repo (offering built-in
defaults for Claude Code, Codex, Antigravity, Grok, Gemini, and Cursor — see
`registry/agents.json` — plus support for custom agents). It then writes
`.agent-sync/config.json`, `AGENTS.md` (with full project context and agent
instructions, including when to search memory and resume), `CLAUDE.md` (a
minimal managed redirect to `AGENTS.md`), `MEMORY.md` (for project learnings
and component pitfalls), and `.claude/settings.json` (scaffolding
`permissions.ask` for discovered vendor directories), plus `.agent-sync/TDD.md`:
the default workflow agents follow for features and bug fixes when no plugin
workflow such as Superpowers is in use (approved todo list, then
red → green → refactor per task, with the list saved under
`.agent-sync/todo/`, which setup adds to `.gitignore`, so another agent on the
same machine can continue it). Edit it freely; setup
keeps an existing copy. For enabled Codex or
Antigravity agents whose global hooks lack agent-mem, it prints the one-line
`agent-mem setup` command to run.

Upgrading from an older version: setup stops managing `HANDOFF.md` (an existing
one is left untouched for you to delete), removes the `archive.py` SessionEnd
hook from `.claude/settings.json`, and drops the old `workflowTools` key from
the config.

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

## Optional code-review-graph integration

`/agent-sync:setup` offers to install
[code-review-graph](https://github.com/tirth8205/code-review-graph) globally for enabled
Claude Code, Codex, and Antigravity agents. Accepting installs the tested `v2.3.9`
release, its seven upstream skills, your `CODE-REVIEW-GRAPH.template` context,
and a global MCP server for each agent. Declining skips it.

```text
/agent-sync:setup --skip-code-review-graph
/agent-sync:setup --upgrade-code-review-graph
/agent-sync:setup --code-review-graph-version v2.3.9
/agent-sync:setup --upgrade-code-review-graph --dry-run
```

Normal reruns verify the installed version locally and make no GitHub request when
complete. Upgrades require an explicit request and use GitHub's latest stable release
or the exact tag you specify, resolved to an immutable commit. To deliberately install
an older release, add `--allow-downgrade` to an exact-version request. Dry runs preview
global integration without package installation or project scaffolding.

For direct shell usage from a clone:

```bash
python3 skills/setup/scripts/install_code_review_graph.py --agents claude,codex,antigravity
python3 skills/setup/scripts/install_code_review_graph.py --upgrade --dry-run
python3 skills/setup/scripts/install_code_review_graph.py --upgrade
python3 skills/setup/scripts/install_code_review_graph.py --version v2.3.9 --allow-downgrade
python3 skills/setup/scripts/install_code_review_graph.py --status
python3 skills/setup/scripts/install_code_review_graph.py --check
```

The helper works from any current directory when invoked by its absolute path. It
needs Python 3.10+ with `venv` and `pip`; use Python 3.11+ when Codex already has a TOML
configuration so the helper can validate it using the standard library. Package
dependencies are installed into a separate versioned environment.

| Agent | Global context | Global skills | MCP |
|---|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `~/.claude/skills` | `~/.claude.json` |
| Codex | `~/.codex/AGENTS.md` | `~/.agents/skills` | `~/.codex/config.toml` |
| Antigravity | `~/.gemini/AGENTS.md` | `~/.gemini/config/skills` | `~/.gemini/config/mcp_config.json` |

Installed skills: `build-graph`, `explore-codebase`, `review-changes`, `review-delta`,
`review-pr`, `debug-issue`, and `refactor-safely`. Restart your agents and run
`build-graph` in each repository to initialize its graph. No code-review-graph hooks
are installed; configure your multi-repo daemon separately to manage graph updates.

Reruns remove unchanged hooks and the adapter recorded by the previous installer,
with backups, while retaining unrelated hooks (including agent-mem). User-edited
legacy hooks or adapters are preserved and reported as conflicts. When only this
cleanup is needed, normal reruns and dry runs require no network request or package
build; `--check` reports the legacy artifacts until cleanup is approved and applied.

The installer preserves personal context and unrelated config entries, refuses malformed
config and conflicting user-edited skills, and leaves identical files and mtimes alone.
Changed files are backed up under `~/.agent-sync/backups/code-review-graph/`; ownership,
release tag, commit, and hashes are recorded in `~/.agent-sync/code-review-graph.json`.
An apply/validation failure rolls back integrations. An interrupted process leaves a
recovery journal; the next install can restore the previous state before retrying.
Previous package environments are retained. The stable executable is
`~/.local/share/agent-sync/code-review-graph/bin/code-review-graph`; optionally add that
`bin` directory to your shell's `PATH` for CLI use.

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

**Codex and Antigravity** — `install.sh` installs their hooks. To install
hooks for one workspace only, run
`bun run ~/.agent-sync/agent-mem/bin/agent-mem.ts setup --agent <codex|antigravity> --scope project`.

Search past work with the `/agent-sync:mem-search` skill, or directly:

```bash
bun run ~/.agent-sync/agent-mem/bin/agent-mem.ts search "<query>"
bun run ~/.agent-sync/agent-mem/bin/agent-mem.ts get <observation-id>
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
(default: the latest interrupted session). The handoff is a summary; clipped
steps carry a byte offset, and `handoff <id> --step @<offset>`,
`--before @<offset>`, or `--grep <text>` fetch more without reading the whole
transcript.

The injected digest is capped at about 250 tokens (`maxDigestTokens` in
`agent-mem/src/config.ts`): the three most recent sessions plus as many recent
observations as fit, each clipped to 120 characters. It does not grow with
history; older work stays searchable instead. Wrap private details in
`<private>` tags to keep them out of the store.

Memory is kept for 90 days. The daemon prunes on startup and then daily:
observations and events older than that are deleted, and a session or project
goes once nothing recent remains under it (a resumed old session is kept).
Set `AGENT_MEM_RETENTION_DAYS` in the daemon's environment to change the window,
or to `0` to keep everything.

## Workflow

1. Each session starts with `AGENTS.md` (Claude Code via `CLAUDE.md`), plus
   the agent-mem digest of recent sessions from every agent.
2. Before re-exploring past work, search memory with `/agent-sync:mem-search`.
3. When another agent stopped mid-task, run `/agent-sync:resume`, then
   continue through the workflow's own command (e.g. the Superpowers skill
   that owns the plan). Never hand-edit a workflow's state files.
4. Commit policy is detected locally in priority order: commitlint,
   `COMMIT_CONVENTION.md`, contributing guidance, a local commit template,
   then sufficiently consistent history. Otherwise use the Conventional
   Commits fallback: `<type>(optional-scope): imperative description`.
   Plan and task IDs stay out of commit subjects.
5. Record durable lessons in `MEMORY.md`; session-by-session history lives in
   agent-mem and is pruned after 90 days.

## Notes

- `.claude/settings.json`'s `attribution` block disables the
  Co-Authored-By commit trailer and "Generated with Claude Code" PR
  footer for the project it's scaffolded into, while its `permissions.ask`
  block guards discovered vendor directories (e.g. `Read(./node_modules/**)`,
  `Read(./vendor/**)`, `Read(./.venv/**)`) to prompt before reading vendored code.
  To apply settings everywhere instead of one repo, copy the blocks into
  `~/.claude/settings.json`.
- Agent identity is recorded in agent-mem sessions, never in commit
  messages or trailers.
- Keep `AGENTS.md` as the central place real project knowledge and
  instructions live; `CLAUDE.md` is a minimal pointer — don't let instructions
  drift into duplicate, conflicting content.
- Workflow plugins such as Superpowers own their state paths entirely —
  this plugin doesn't scaffold, own, or instruct agents to write into them.

## License

MIT — see [LICENSE](LICENSE).
