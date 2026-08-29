---
description: Scaffold per-agent context files (CLAUDE.md/AGENTS.md/...), HANDOFF.md, and docs/PROJECT_CONTEXT.md so multiple coding agents share project context, based on a project-local .agent-sync.json agent + workflow-tool list.
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
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
     workflow/plan-execution tools: `displayName`, `ownedPaths`,
     `activationSignals`, `executionInstructions`).
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
     `ownedPaths`, `activationSignals`, `executionInstructions`). For a
     custom tool, collect all four fields: `displayName` is the name shown to
     agents; `ownedPaths` identifies state the tool owns; `activationSignals`
     identifies repository-relative globs that activate the workflow; and
     `executionInstructions` is the ordered, tool-specific lifecycle the
     agent must follow.
   - Before writing `.agent-sync.json`, resolve and validate every selected
     workflow using Step 1's pre-write workflow policy. On invalid input,
     report the workflow id and invalid field and do not write the file.
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
         {
           "id": "myplanner",
           "displayName": "My Planner",
           "ownedPaths": [".myplanner/state/"],
           "activationSignals": [".myplanner/state/*/progress.json"],
           "executionInstructions": [
             "Resume matching tasks with My Planner's official run command.",
             "Do not edit .myplanner/state directly.",
             "Stop and report a blocker if My Planner is unavailable."
           ]
         }
       ]
     }
     ```
     For backward compatibility only, an existing custom workflow may omit
     both `activationSignals` and `executionInstructions`; warn that generic
     behavior will apply. Do not offer that omission for new first-run
     collection.
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
an explicit empty list. Resolve each entry's `displayName`, `ownedPaths`,
`activationSignals`, and `executionInstructions` from the registry (known id)
or the object's own fields (custom).

Validate every resolved workflow before changing any file:
- `displayName` is a non-empty string.
- `ownedPaths` is a non-empty array of repository-relative paths.
- When present, `activationSignals` is an array of repository-relative glob
  strings. Reject absolute paths and any pattern containing a `..` segment.
- When present, `executionInstructions` is a non-empty array of non-empty
  strings.
On failure, report the workflow id and invalid field, then stop before writes.

If a custom workflow has valid `displayName` and `ownedPaths` but omits both new
fields, keep it backward compatible and label the result `generic strict
fallback`. Treat every owned path as an activation signal. Require the agent to
inspect owned state, use the tool's official lifecycle for matching tasks,
never execute a managed task manually or edit owned state, and stop and report
the blocker if the tool is unavailable. Report that tool-specific activation
and resume guidance was not configured. If only one new field is present, stop
before writes as malformed input.

For a `generic strict fallback`, resolve the rendered instructions in this
order:
1. Inspect the workflow's owned state and use its official lifecycle for
   matching tasks.
2. Never execute a managed task manually or edit owned state.
3. If the workflow tool is unavailable, stop and report the blocker.

For registry workflows and complete custom workflows, preserve every
`executionInstructions` item verbatim and in registry/custom-object order.

For every resolved agent `contextFile`, `HANDOFF.md`, and
`docs/PROJECT_CONTEXT.md`, construct its proposed managed block, then classify
every target and collect all approvals before changing any target:
- `missing`: path does not exist.
- `managed`: exactly one non-nested matching marker pair exists.
- `known-legacy`: no markers exist and the file exactly matches the released
  0.1.0 generated structure: expected title/import variant plus the exact thin
  context, handoff claim, workflow ownership, commit, attribution, and session
  handoff paragraphs, with no additional sections or text.
- `unrecognized`: existing unmarked content that is not exact known legacy.
- `malformed`: one marker missing, duplicate markers, end before start, or any
  nested managed marker.

The expected `known-legacy` structure applies to per-agent context files; an
unmarked `HANDOFF.md` or `docs/PROJECT_CONTEXT.md` is `unrecognized` unless it
has its own matching managed markers. A matching pair is the marker type for
that target: `agent-policy`, `handoff-template`, or `project-policy`.

For each classification, use this behavior after all approvals have been
collected:
- `missing`: create the file with its managed block.
- `managed`: replace the matching markers and all bytes between them; preserve
  every byte before and after.
- `known-legacy`: replace the recognized legacy content with the managed block
  and report automatic migration.
- `unrecognized`: show the proposed block and ask before inserting it. On yes,
  insert after a top-level title, otherwise at byte zero. On no, preserve the
  file byte-for-byte and continue with other approved targets.
- `malformed`: preserve the file, report the exact defect, and never guess or
  ask to overwrite it.

For an agent `contextFile`, fill the managed block below, substituting:
- `{AGENT_NAME}` → the agent's `displayName`
- `{IMPORT_BLOCK}` → see below
- `{WORKFLOW_TOOLS_BLOCK}` → see below
- `{OTHER_AGENTS}` → comma-joined `displayName` (or id, if no
  registry `displayName`) of every *other* configured agent
- `{AGENT_ID}` → the agent's id

```markdown
# {AGENT_NAME} Instructions

<!-- agent-sync:agent-policy:start -->
This file is intentionally thin. All real project knowledge lives in the
shared files below so other agents see the same thing.

{IMPORT_BLOCK}

## {AGENT_NAME} specific
{WORKFLOW_TOOLS_BLOCK}
- Read `HANDOFF.md` to see which agent ({OTHER_AGENTS}) last touched
  each plan/task and what's next.
- Before claiming or executing a plan task, determine whether it belongs to a
  configured workflow by checking activation signals and owned state. When it
  does, use that tool's official lifecycle for the whole task, including its
  required verification and report. Never finish the task outside that workflow.
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
<!-- agent-sync:agent-policy:end -->
```

Keep `# {AGENT_NAME} Instructions` outside the markers. The start marker
immediately precedes the shared-context pointer/import block, and the end
marker immediately follows the session-handoff rule. Do not create an empty
user section after the block.

`{WORKFLOW_TOOLS_BLOCK}`, when the resolved workflow-tool list is
non-empty — one bullet per tool, using its `displayName`,
`activationSignals`, `ownedPaths`, and resolved instructions:
```
- Before plan-scoped work, inspect {TOOL_DISPLAY_NAME}'s activation signals
  ({ACTIVATION_SIGNALS}) and owned state ({OWNED_PATHS}). If the task belongs to
  that workflow, follow these rules in order:
  1. {EXECUTION_INSTRUCTION_1}
  2. {EXECUTION_INSTRUCTION_2}
  Do not substitute a manual or generic execution path. If the required
  workflow cannot be invoked, stop and report the blocker.
```
Continue numbering until every resolved instruction has been rendered verbatim.
Preserve instruction order. If any resolved instruction already says to stop
and report the blocker when the workflow is unavailable, omit the equivalent
final blocker sentence from the rendering; otherwise retain it.
Repeat one such bullet per configured workflow tool. For a `generic strict
fallback`, include the label `generic strict fallback` with that tool's bullet
and report that tool-specific activation and resume guidance was not
configured.

`{WORKFLOW_TOOLS_BLOCK}`, when the resolved workflow-tool list is
empty — omit the workflow bullets, the pre-task workflow gate, and the
`{WORKFLOW_TOOLS_BLOCK}` placeholder line entirely (don't leave a blank line
in its place).

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

For a missing `HANDOFF.md`, `{AGENT_IDS_PIPE}` is every configured agent's id,
joined with `|`. Render the title, then the exact managed block around its
explanatory comment and template. Close the managed block before `---`; real
handoff entries remain outside the block. For a managed or approved
unrecognized file, replace or insert only this block and preserve every real
entry outside it:

```markdown
# Handoff Log

<!-- agent-sync:handoff-template:start -->
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
<!-- agent-sync:handoff-template:end -->

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

For a missing `docs/PROJECT_CONTEXT.md`, inspect this repository yourself
before writing anything — do not use placeholder text. For a managed or
approved unrecognized file, preserve every byte outside the `project-policy`
markers while replacing or inserting only that block:

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
<!-- agent-sync:project-policy:start -->
- Commit message format: {COMMIT_FORMAT}
- Commit convention source: {COMMIT_SOURCE}
- Commit examples: `{COMMIT_EXAMPLE_1}`; `{COMMIT_EXAMPLE_2}`
{WORKFLOW_TOOLS_PROJECT_CONTEXT_BLOCK}
<!-- agent-sync:project-policy:end -->
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

The `project-policy` block is inside `## Conventions`. Keep branch naming,
code style, technical context, architecture, and decisions outside this managed
block.

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
