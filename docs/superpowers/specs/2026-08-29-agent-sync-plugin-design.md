# agent-sync plugin — design spec

Date: 2026-08-29
Status: approved, ready for implementation planning

## Problem

This repo currently holds a working prototype (`superpower-dual-agents`) for
keeping Claude Code and Codex in sync on shared project context and task
handoff. Distribution is copy-paste (`README-SETUP.md`), and the agent list
is hardcoded to exactly two: `claude` and `codex`.

Goal: turn this into a publishable, installable Claude Code plugin —
`agent-sync` — that generalizes to any number of coding agents, not just
the original two.

## Non-goals (this iteration)

- Publishing to GitHub / pushing a public repo (build + `git init` +
  local commit only; user pushes when ready).
- Submitting to any official plugin marketplace listing.
- Building adapters/templates for every possible agent up front — ship a
  small known-agent registry, let users add custom entries.

## Architecture

Repo root becomes the plugin root (matches the layout used by
`claude-md-management` and `superpowers` in the official marketplace):

```
.claude-plugin/
  plugin.json          # name, description, version, author, license, repo
  marketplace.json      # single-plugin marketplace, source: "./"
commands/
  scaffold-shared-context.md   # generalized, config+registry driven
registry/
  agents.json           # built-in known agents: claude, codex, gemini, cursor
README.md
LICENSE                 # MIT
CLAUDE.md
AGENTS.md
HANDOFF.md
docs/PROJECT_CONTEXT.md # this project's own dogfood files
.claude/settings.json   # attribution off (unchanged from prototype)
```

Distribution changes from copy-paste to installable plugin: once a user
adds this repo as a marketplace source and installs the plugin,
`/scaffold-shared-context` is available in any repo automatically — no
manual file copying. `README-SETUP.md`'s Option A/B copy-paste
instructions are replaced by install instructions in `README.md`.

## Built-in agent registry

`registry/agents.json`, shipped with the plugin, read via
`${CLAUDE_PLUGIN_ROOT}/registry/agents.json`:

```json
{
  "claude":  { "contextFile": "CLAUDE.md",  "supportsImports": true  },
  "codex":   { "contextFile": "AGENTS.md",  "supportsImports": false },
  "gemini":  { "contextFile": "GEMINI.md",  "supportsImports": false },
  "cursor":  { "contextFile": "AGENTS.md",  "supportsImports": false }
}
```

`supportsImports: true` means the agent supports Claude Code's `@path`
memory-import syntax and its context file can just be pointers via
`@docs/PROJECT_CONTEXT.md` / `@HANDOFF.md`. Agents without import support
get a "See:" bullet list plus an explicit instruction to read those files
manually at session start.

Codex and Cursor share `AGENTS.md` — if both are enabled for a project,
the scaffold command writes `AGENTS.md` once and lists both agent names
in its "other agents" note rather than producing a duplicate file.

## Project-local config

`.agent-sync.json`, written into the *consumer* repo (not shipped, one
per project using the plugin):

```json
{ "agents": ["claude", "codex"] }
```

Custom/unlisted agents are supported inline:

```json
{
  "agents": [
    "claude",
    { "id": "myagent", "contextFile": "MYAGENT.md", "supportsImports": false }
  ]
}
```

## Command flow — `commands/scaffold-shared-context.md`

Step 1 moves from a static bash heredoc (which only worked because the
agent count was fixed at 2) to LLM-driven generation, since content is
now dynamic per configured agent list:

1. If `.agent-sync.json` is missing in the target repo: scan for hints
   (existing `AGENTS.md`, `GEMINI.md`, etc.), ask the user which agents
   to enable (registry defaults, plus freeform custom entries), write
   `.agent-sync.json`.
2. For each configured agent, generate its context file from **one
   generalized template** (not per-agent hardcoded copies) with
   placeholders:
   - agent name
   - context filename
   - import block: `@docs/PROJECT_CONTEXT.md` + `@HANDOFF.md` if
     `supportsImports`, else a "See:" bullet list and a note to read
     those files manually each session
   - "other agents" list, derived from the full config so the wording
     is correct for 2 agents or 5 (not "the other agent (Codex)" baked
     in)
3. `HANDOFF.md`'s claiming-line template — previously
   `` `Claiming plan-name/task-N — [claude|codex]` `` — is generated
   from the config's agent id list instead of hardcoded.
4. `.claude/settings.json` step is unchanged (Claude-Code-specific
   attribution config).
5. Step 2 (inspect the repo, generate `docs/PROJECT_CONTEXT.md`) is
   unchanged from the prototype.

Idempotency is preserved: existing files are left untouched, same as the
prototype.

## This repo's own dogfood files

`CLAUDE.md`, `AGENTS.md`, `HANDOFF.md`, `docs/PROJECT_CONTEXT.md` stay at
repo root as this project's own coordination files — the plugin dev
workflow uses the tool it's building, on itself. They get regenerated
from the new generalized template with `.agent-sync.json` set to
`["claude", "codex"]`.

## Naming / metadata

- Plugin name: `agent-sync`
- License: MIT
- Author / repo owner: `cys2best`
- Repo URL: placeholder `https://github.com/cys2best/agent-sync` (not
  yet pushed)

## Testing plan

- Run `/scaffold-shared-context` against a scratch repo with 2 agents
  (claude, codex) — confirm output matches prototype behavior.
- Run again with 3+ agents (claude, codex, gemini) — confirm generated
  `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` correctly list each other as
  "other agents" and `HANDOFF.md` template reflects all three ids.
- Run with a custom unlisted agent entry — confirm it generates
  correctly without registry support.
- Re-run against a repo where files already exist — confirm nothing is
  overwritten (idempotency).
- Confirm `.claude-plugin/plugin.json` and `marketplace.json` validate
  against the shapes used by real installed plugins (spot-checked
  against `claude-md-management` and `caveman` in this session).
