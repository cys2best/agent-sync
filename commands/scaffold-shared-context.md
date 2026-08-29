---
description: Scaffold per-agent context files (CLAUDE.md/AGENTS.md/...), HANDOFF.md, and docs/PROJECT_CONTEXT.md so multiple coding agents share project context, based on a project-local .agent-sync.json agent + workflow-tool list.
allowed-tools: Bash, Read, Glob, Grep, Write
---

## Step 0 — determine the agent list and workflow tools

1. If `.agent-sync.json` exists at the repo root, read it — it's the
   agent and workflow-tool list for this project, already decided. Skip
   to Step 1.
2. Otherwise, this is first-run scaffolding for this repo:
   - Read the built-in registries at
     `${CLAUDE_PLUGIN_ROOT}/registry/agents.json` (known agents:
     `displayName`, `contextFile`, `supportsImports`) and
     `${CLAUDE_PLUGIN_ROOT}/registry/workflow-tools.json` (known
     workflow/plan-execution tools: `displayName`, `ownedPaths`).
   - Check the repo root for existing hints: a file matching any
     registry entry's `contextFile` (e.g. an existing `AGENTS.md` or
     `GEMINI.md`) is a signal that agent is already in use here; a
     directory matching a workflow tool's `ownedPaths` (e.g.
     `.superpowers/`) is a signal that tool is already in use here.
   - Ask the user which agents to enable for this project. Offer the
     registry's known agents as defaults, pre-selecting any detected
     from existing files, and allow adding a custom agent (id,
     `contextFile`, `supportsImports`).
   - Ask the user which workflow/plan-execution tools this project
     uses (offer `superpowers` as the default, pre-selected if
     detected; allow zero tools, or a custom tool: id, `displayName`,
     `ownedPaths`).
   - Write `.agent-sync.json` at the repo root:
     ```json
     { "agents": ["claude", "codex"], "workflowTools": ["superpowers"] }
     ```
     Substitute the actual chosen agent and workflow-tool ids. A
     custom (non-registry) agent or workflow tool is an inline object
     instead of a bare string id:
     ```json
     {
       "agents": [
         "claude",
         { "id": "myagent", "displayName": "My Agent", "contextFile": "MYAGENT.md", "supportsImports": false }
       ],
       "workflowTools": [
         { "id": "myplanner", "displayName": "My Planner", "ownedPaths": [".myplanner/state/"] }
       ]
     }
     ```
     If the user has no opinion on workflow tools, omit `workflowTools`
     from the file rather than guessing — a missing key defaults to
     `["superpowers"]` (see Step 1), which matches this plugin's own
     prior hardcoded behavior. An explicit `"workflowTools": []` means
     "none", and is different from omitting the key.

## Step 1 — create the static files

For every agent in `.agent-sync.json`, resolve its `displayName`,
`contextFile`, and `supportsImports` — from the registry if it's a
known id, or from the custom object's own fields otherwise. Two agents
may resolve to the same `contextFile` (Codex and Cursor both default to
`AGENTS.md`) — write that file once and list every agent mapped to it
in each other's "other agents" note below.

Resolve the workflow-tool list the same way: read `.agent-sync.json`'s
`workflowTools` key. If the key is absent, treat it as `["superpowers"]`.
If present (including `[]`), use it exactly as written — do not default
an explicit empty list. Resolve each entry's `displayName` and
`ownedPaths` from the registry (known id) or the object's own fields
(custom).

If an agent's resolved `contextFile` does not already exist, create it
(leave it untouched if it does — this command never overwrites existing
files). Fill in this template, substituting:
- `{AGENT_NAME}` → the agent's `displayName`
- `{IMPORT_BLOCK}` → see below
- `{WORKFLOW_TOOLS_BLOCK}` → see below
- `{OTHER_AGENTS}` → comma-joined `displayName` (or id, if no
  registry `displayName`) of every *other* configured agent
- `{AGENT_ID}` → the agent's id

```markdown
# {AGENT_NAME} Instructions

This file is intentionally thin. All real project knowledge lives in the
shared files below so other agents see the same thing.

{IMPORT_BLOCK}

## {AGENT_NAME} specific
{WORKFLOW_TOOLS_BLOCK}
- Read `HANDOFF.md` to see which agent ({OTHER_AGENTS}) last touched
  each plan/task and what's next.
- Claim a task by adding an entry to `HANDOFF.md`:
  `Claiming plan-name/task-N — {AGENT_ID}`
- Commit messages must include the plan-scoped task ID only, no agent
  name: `[plan-name/task-N] description`
- Do not add a "Co-Authored-By" trailer or AI-attribution footer to
  commits or PRs. If this agent's setup has an equivalent
  auto-attribution behavior, disable it the same way
  `.claude/settings.json` does for Claude Code.
- At the end of a session, append a handoff entry to `HANDOFF.md`: what
  you finished, what's next, and any blockers, per plan.
```

`{WORKFLOW_TOOLS_BLOCK}`, when the resolved workflow-tool list is
non-empty — one bullet per tool, using its `displayName` and
`ownedPaths`:
```
- Use the {TOOL_DISPLAY_NAME} skills for any multi-step task.
  {TOOL_DISPLAY_NAME} owns `{ownedPath1}`, `{ownedPath2}`, ... — don't
  hand-edit these or create files there yourself; that's the tool's
  job. Before starting work, check {TOOL_DISPLAY_NAME}'s own state
  under those paths for active plans and current task status.
```
(repeat one such bullet per configured workflow tool)

`{WORKFLOW_TOOLS_BLOCK}`, when the resolved workflow-tool list is
empty — omit the bullet, and the `{WORKFLOW_TOOLS_BLOCK}` placeholder
line, entirely (don't leave a blank line in its place).

`{IMPORT_BLOCK}`, when `supportsImports` is true:
```
@docs/PROJECT_CONTEXT.md
@HANDOFF.md
```

`{IMPORT_BLOCK}`, when `supportsImports` is false:
```
See:
- docs/PROJECT_CONTEXT.md — tech stack, conventions, build commands
- HANDOFF.md — the running log between agents, per plan/task

({AGENT_NAME} doesn't support `@path` imports like Claude Code does —
read both files above manually at the start of every session, or wire
this into a startup script if your setup supports one.)
```

If `HANDOFF.md` doesn't exist, create it — `{AGENT_IDS_PIPE}` is every
configured agent's id, joined with `|`:

```markdown
# Handoff Log

<!-- Newest entry on top. Each agent appends one entry at session end,
     and one "Claiming" line when picking up a task. Multiple plans can
     appear here at once — always include the plan name. -->

## Template for new entries
\`\`\`
### YYYY-MM-DD HH:MM — [{AGENT_IDS_PIPE}]
- Claiming: plan-name/task-N (if starting new work)
- Finished: plan-name/task-N, other-plan/task-M
- Next: plan-name/task-K is ready, depends on plan-name/task-N
- Blockers: none / describe
\`\`\`

---
```

If `.claude/settings.json` doesn't exist, create it:

```json
{
  "attribution": {
    "commit": "",
    "pr": ""
  }
}
```

## Step 2 — generate docs/PROJECT_CONTEXT.md from the real project

If `docs/PROJECT_CONTEXT.md` already exists, skip this step and just
report that it was left untouched.

Otherwise, inspect this repository yourself before writing anything —
do not use placeholder text:

- Read package.json / pyproject.toml / Cargo.toml / go.mod / Gemfile
  (whichever exists) to identify the language, framework, and package
  manager.
- Check for lockfiles to confirm the package manager (package-lock.json,
  pnpm-lock.yaml, yarn.lock, poetry.lock, Cargo.lock, etc.).
- Find the test runner and lint/format commands from package.json
  scripts, Makefile, tox.ini, or CI config (.github/workflows/*.yml).
- Skim the README for a one/two-sentence description of what the project
  does and who it's for.
- Look at the top-level directory layout and note the architecture at a
  glance (e.g. "monorepo with apps/ and packages/", "Django app with
  standard app-per-feature layout").
- Check for an existing branch-naming or commit-convention pattern in
  `git log` (last ~20 commits) rather than inventing one.
- Note any obvious "don't touch" paths (generated dirs, vendored code,
  build output) from .gitignore.

Then create `docs/PROJECT_CONTEXT.md` with this structure, filled in
with what you actually found (leave a section explicitly marked
"not detected — fill in manually" if you can't determine it from the
repo, rather than guessing):

```markdown
# Project Context

> Single source of truth for project knowledge. Per-agent context files
> import or point to this file — edit it here, not in any of those.

## What this project is
<!-- from README / package metadata -->

## Tech stack
- Language / framework:
- Package manager:
- Test runner:
- Lint / format command:

## Build & verify commands
\`\`\`
# install
# build
# test
# lint
\`\`\`

## Conventions
- Branch naming: <!-- inferred from git log, or "not detected" -->
- Commit message format: `[plan-name/task-N] short description`
- Code style notes:
- Things NOT to do (generated files to leave alone, dirs to avoid, etc.):

## Plan & spec structure
{WORKFLOW_TOOLS_PROJECT_CONTEXT_BLOCK}
- Multiple plans can be active at once. See HANDOFF.md for which agent
  owns which plan/task right now.

## Architecture notes
<!-- from directory layout -->

## Decisions log
<!-- Promote real decisions here as they're made. Newest on top. -->
- YYYY-MM-DD:
\`\`\`

`{WORKFLOW_TOOLS_PROJECT_CONTEXT_BLOCK}`, when the resolved
workflow-tool list is non-empty — one line per tool:
```
- Live execution state (task briefs, reports, progress) is owned by
  {TOOL_DISPLAY_NAME} at `{ownedPath1}`, `{ownedPath2}`, ... — don't
  hand-edit these or create files there yourself; that's the tool's
  job.
```
(repeat one such line per configured workflow tool)

`{WORKFLOW_TOOLS_PROJECT_CONTEXT_BLOCK}`, when the resolved
workflow-tool list is empty — omit entirely, and drop the "Plan & spec
structure" heading down to just the "Multiple plans..." line.

After writing the file, report which sections you filled from real
project signals vs. left as "not detected", and remind the user to
review it and fill any gaps.
