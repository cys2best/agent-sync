---
description: Scaffold per-agent context files (CLAUDE.md/AGENTS.md/...), HANDOFF.md, and docs/PROJECT_CONTEXT.md so multiple coding agents share project context, based on a project-local .agent-sync.json agent + workflow-tool list.
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
---

## Phase 1 — preflight configuration, policy, renders, and decisions

This entire phase is read-only: do not create or modify any file. Complete its
work in this order: determine the configuration; resolve and validate agents
and workflows; inspect project and commit-policy evidence; render every proposed
target; classify every target; then resolve every conflict and approval. Hold
all proposed bytes and each target's original byte snapshot in memory. If any
validation, conflict, or required user decision remains unresolved, stop with
no writes.

### 1A — determine the agent list and workflow tools

1. If `.agent-sync.json` exists at the repo root, read it — it's the
   agent and workflow-tool list for this project, already decided. Skip
   to Phase 1B.
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
   - Before staging `.agent-sync.json`, resolve and validate every selected
     workflow using Phase 1B's workflow policy. On invalid input,
     report the workflow id and invalid field and do not write the file.
   - Render the proposed `.agent-sync.json` bytes in memory for later application:
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
     `["superpowers"]` (see Phase 1B), which matches this plugin's own
     prior hardcoded behavior. An explicit `"workflowTools": []` means
     "none", and is different from omitting the key.

### 1B — resolve and validate configuration and render static targets

For every agent in `.agent-sync.json`, resolve its `displayName`,
`contextFile`, and `supportsImports` — from the registry if it's a
known id, or from the custom object's own fields otherwise. Two agents
may resolve to the same `contextFile` (Codex and Cursor both default to
`AGENTS.md`) — render that target once and list every agent mapped to it
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

During Phase 1D, after every render input is resolved, construct its proposed managed block
for every agent `contextFile`, `HANDOFF.md`, and `docs/PROJECT_CONTEXT.md`, then
classify every target and collect all approvals before changing any target:
- `missing`: path does not exist.
- `managed`: exactly one non-nested matching marker pair exists.
- `known-legacy`: no markers exist and the file is byte-for-byte equal to one
  of the two supported released 0.1.0 per-agent render variants below.
- `unrecognized`: existing unmarked content that is not exact known legacy.
- `malformed`: one marker missing, duplicate markers, end before start, or any
  nested managed marker.

The expected `known-legacy` structure applies to per-agent context files; an
unmarked `HANDOFF.md` or `docs/PROJECT_CONTEXT.md` is `unrecognized` unless it
has its own matching managed markers. A matching pair is the marker type for
that target: `agent-policy`, `handoff-template`, or `project-policy`.

For the two supported legacy variants, compare the entire target file to the
literal contents below, including the single final LF after the last line. Do
not substitute agent names, imports, other-agent names, attribution wording,
or workflow text. These fixed compatibility fixtures are the historical
renders from commit `dde76e9`:

### Supported 0.1.0 Claude import variant (`CLAUDE.md` only)

```markdown
# Claude Code Instructions

This file is intentionally thin. All real project knowledge lives in the
shared files below so other agents see the same thing.

@docs/PROJECT_CONTEXT.md
@HANDOFF.md

## Claude Code specific
- Use the Superpowers skills for any multi-step task. Superpowers owns
  `.superpowers/sdd/`, `docs/superpowers/` — don't hand-edit these or
  create files there yourself; that's the tool's job. Before starting
  work, check Superpowers's own state under those paths for active
  plans and current task status.
- Read `HANDOFF.md` to see which agent (Codex) last touched each
  plan/task and what's next.
- Claim a task by adding an entry to `HANDOFF.md`:
  `Claiming plan-name/task-N — claude`
- Commit messages must include the plan-scoped task ID only, no agent
  name: `[plan-name/task-N] description`
- Do not add a "Co-Authored-By" trailer or "Generated with Claude Code"
  footer to commits or PRs (also enforced by `.claude/settings.json`
  `attribution` config — this line is a backup in case that file is
  missing or overridden locally).
- At the end of a session, append a handoff entry to `HANDOFF.md`: what
  you finished, what's next, and any blockers, per plan.
```

### Supported 0.1.0 Codex no-import variant (`AGENTS.md` only)

```markdown
# Codex Instructions

This file is intentionally thin. All real project knowledge lives in the
shared files below so other agents see the same thing.

See:
- docs/PROJECT_CONTEXT.md — tech stack, conventions, build commands
- HANDOFF.md — the running log between agents, per plan/task

(Codex doesn't support `@path` imports like Claude Code does — read both
files above manually at the start of every session, or wire this into a
startup script if your Codex setup supports one.)

## Codex specific
- Use the Superpowers skills for any multi-step task, same as Claude
  Code. Superpowers owns `.superpowers/sdd/`, `docs/superpowers/` —
  don't hand-edit these or create files there yourself; that's the
  tool's job. Before starting work, check Superpowers's own state
  under those paths for active plans and current task status.
- Read `HANDOFF.md` to see which agent (Claude Code) last touched each
  plan/task and what's next.
- Claim a task by adding an entry to `HANDOFF.md`:
  `Claiming plan-name/task-N — codex`
- Commit messages must include the plan-scoped task ID only, no agent
  name: `[plan-name/task-N] description`
- Do not add a "Co-Authored-By" trailer or similar AI-attribution footer
  to commits or PRs. If your Codex setup has an equivalent auto-attribution
  behavior, disable it in its config the same way `.claude/settings.json`
  does for Claude Code.
- At the end of a session, append a handoff entry to `HANDOFF.md`: what
  you finished, what's next, and any blockers, per plan.
```

Any byte difference or unsupported legacy shape is `unrecognized`, never
automatic migration.

During preflight, record one staged action for each classification after all
approvals have been collected; do not execute any action yet:
- `missing`: stage creation of the file with its managed block.
- `managed`: stage replacement of the matching markers and all bytes between
  them; preserve every byte before and after.
- `known-legacy`: stage replacement of the recognized legacy content with the
  managed block and record an automatic migration.
- `unrecognized`: show the proposed block and ask before inserting it. On yes,
  stage insertion after a top-level title, otherwise at byte zero. On no, stage
  byte-for-byte preservation and continue classifying other targets.
- `malformed`: stage byte-for-byte preservation, record the exact defect, and
  never guess or ask to overwrite it.

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
- Before committing, read the convention in `docs/PROJECT_CONTEXT.md`. If it
  names a repository policy file, read that source too. Follow its format and
  examples. Keep plan names, task numbers, agent identity, and AI-attribution
  out of the commit message; workflow state and `HANDOFF.md` retain task
  traceability.
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

Plan/task identifiers belong here and in workflow state, not in commit subjects.

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

If `.claude/settings.json` doesn't exist, render and stage these candidate bytes;
otherwise stage byte-for-byte preservation of the existing JSON:

```json
{
  "attribution": {
    "commit": "",
    "pr": ""
  }
}
```

### 1C — inspect the project and detect commit policy

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
- Note any obvious "don't touch" paths (generated dirs, vendored code,
  build output) from .gitignore.

Before target rendering, detect commit policy from local evidence only:

1. Inspect commitlint files and `package.json` commitlint config.
2. Inspect `COMMIT_CONVENTION.md` and case-insensitive filename variants.
3. Inspect `CONTRIBUTING.md` and `.github/CONTRIBUTING.md`.
4. Run `git config --local commit.template`. Resolve a relative value against
   the repository root, then canonicalize both it and the repository root while
   following symlinks. Use path-component containment rather than a string
   prefix: accept only a readable regular file inside the repository root.
   Reject and never inspect a missing, non-file, personal, or outside-root
   template. For an accepted template, record `{COMMIT_SOURCE}` as its
   repository-relative path, never as an absolute path.
5. Otherwise inspect the latest 50 non-merge subjects. Infer a format only from
   at least five subjects when at least 70 percent match one recognizable
   subject pattern.
6. Otherwise select Conventional Commits fallback:
   `<type>(optional-scope): imperative description`.

If explicit sources conflict, show them and ask which governs before writes.
Do not use remote, global, or personal Git configuration as evidence. Inspect
only commit subjects; never copy commit-body secrets or attribution.

The Conventional Commits fallback types are `feat`, `fix`, `docs`, `refactor`,
`test`, `build`, `ci`, and `chore`. Features use `feat`; hotfixes use `fix`.

Define the following values before rendering the `project-policy` block:

- `{COMMIT_FORMAT}` is the concise subject grammar.
- `{COMMIT_SOURCE}` is a repository-relative source path, `git history`, or
  `Conventional Commits fallback`.
- `{COMMIT_EXAMPLE_1}` and `{COMMIT_EXAMPLE_2}` are safe examples from the
  source, or newly written examples that obey the selected format.

### 1D — render and classify every target and collect decisions

Using the resolved configuration and commit policy, render the proposed
`docs/PROJECT_CONTEXT.md` bytes with this structure, filled in with what you
actually found (leave a section explicitly marked
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

The workflow ownership line inside the `project-policy` block, when the
resolved workflow-tool list is non-empty — one line per tool:
```
- Live execution state (task briefs, reports, progress) is owned by
  {TOOL_DISPLAY_NAME} at `{ownedPath1}`, `{ownedPath2}`, ... — don't
  hand-edit these or create files there yourself; that's the tool's
  job.
```
(repeat one such line per configured workflow tool)

When the resolved workflow-tool list is empty, omit the workflow ownership
line from the `project-policy` block. Keep the `Plan & spec structure` heading
and its `Multiple plans...` line unchanged.

After all candidate bytes exist, complete the earlier classification of every
target and collect all approvals. Do not continue until `.agent-sync.json`
(existing or proposed), every resolved agent `contextFile`, `HANDOFF.md`,
`docs/PROJECT_CONTEXT.md`, and `.claude/settings.json` each has an original
snapshot and a fully resolved staged disposition.

## Phase 2 — apply the fully resolved preflight plan

Immediately before the first write, confirm every target still matches its
Phase 1 snapshot. If any target changed, stop before writes and restart the
entire preflight. Otherwise apply the staged plan without further detection,
rendering, classification, prompts, or user decisions:

- On first run, write the staged `.agent-sync.json`; otherwise preserve the
  existing configuration.
- For each managed Markdown target, perform its staged creation, managed-block
  update, known-legacy migration, approved insertion, or byte-for-byte
  preservation exactly as classified.
- Create `.claude/settings.json` only when its staged disposition is `missing`;
  otherwise preserve it byte-for-byte.

## Phase 3 — verify and report every target

Re-read every target after application: `.agent-sync.json`, every resolved agent `contextFile`,
`HANDOFF.md`, `docs/PROJECT_CONTEXT.md`, and `.claude/settings.json`. Compare each result with the staged bytes and original
snapshot. Verify created files match their full render; updated managed files
preserve all unmanaged bytes; migrated legacy files match the proposed managed
render; and preserved files, including declined unrecognized and malformed
targets, remain byte-for-byte unchanged. Stop and report any mismatch.

Report one disposition for every target: created, updated, migrated, or
preserved, including the reason for preservation. Also report the detected
commit-policy source (a repository-relative path, `git history`, or
`Conventional Commits fallback`), any rejected outside-root commit template,
which project-context sections came from real project signals versus remained
"not detected", and a reminder to review those gaps.
