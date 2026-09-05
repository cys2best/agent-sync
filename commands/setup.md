---
description: Create or update .agent-sync/config.json and scaffold per-agent context files, HANDOFF.md, and .claude/settings.json so multiple coding agents share project context and task handoff.
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
---

## Phase 1 — preflight configuration, policy, renders, and decisions

This entire phase is read-only: do not create or modify any file. Complete its
work in this order: resolve configuration; resolve and validate agents and
workflows; render every proposed target; classify every target; then resolve
every conflict and approval. Hold all proposed bytes and each target's
original byte snapshot in memory. If any validation, conflict, or required
user decision remains unresolved, stop with no writes.

### 1A — resolve configuration

Define `{EFFECTIVE_CONFIG}` and `{CONFIG_MIGRATION}` (initially none) once and
use them throughout Phase 1:

1. If `.agent-sync/config.json` exists, read it into `{EFFECTIVE_CONFIG}` and
   stage no configuration write. Skip to Phase 1B.
2. Else if `.agent-sync.json` exists at the repo root, read it into
   `{EFFECTIVE_CONFIG}`. Stage `{CONFIG_MIGRATION}`: write the same bytes to
   `.agent-sync/config.json` and delete the root file, to be applied in
   Phase 2 alongside every other write. Skip to Phase 1B.
3. Else, this is first-run scaffolding for this repo:
   - Read the built-in registries at
     `${CLAUDE_PLUGIN_ROOT:-.}/registry/agents.json` (known agents:
     `displayName`, `contextFile`, `supportsImports`) and
     `${CLAUDE_PLUGIN_ROOT:-.}/registry/workflow-tools.json` (known
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
   - Ask one more question: "Also generate `docs/PROJECT_CONTEXT.md` now?
     (recommended if this is the first agent-sync setup for this repo)"
     (yes/no, default yes). Record the answer as `{GENERATE_PROJECT_CONTEXT}`.
   - Build one configuration object from the selected agents and workflow
     tools, applying the omission and inline-object rules below.
     Assign that single validated object to `{EFFECTIVE_CONFIG}` before Phase
     1B consumes it. Resolve and validate every selected workflow using Phase 1B's
     workflow policy; on invalid input, report the workflow id and invalid
     field and do not stage or write the file.
   - Serialize that exact same `{EFFECTIVE_CONFIG}` object, without rebuilding
     it from the selections, as the proposed `.agent-sync/config.json`
     candidate bytes in memory for later application:
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

### 1B — resolve and validate configuration and render targets

For every agent in `{EFFECTIVE_CONFIG}`'s `agents` array, resolve its
`displayName`, `contextFile`, and `supportsImports` — from the registry if it's a
known id, or from the custom object's own fields otherwise. Group enabled
agents in `{EFFECTIVE_CONFIG}` by their resolved target `contextFile`. For each
unique `contextFile`, define:
- `{TARGET_AGENTS}`: array of agents configured for this file.
- `{OTHER_AGENTS}`: comma-joined `displayName` (or id) of every configured
  agent *not* mapped to this file.
Two or more agents may resolve to the same `contextFile` (e.g. Codex and
Antigravity both default to `AGENTS.md`) — render that target once using the
multi-agent rendering rules below.

Resolve the workflow-tool list from `{EFFECTIVE_CONFIG}`'s `workflowTools`
key. If the key is absent, treat it as `["superpowers"]`.
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

After every render input is resolved, construct the proposed managed block
for every agent `contextFile` and `HANDOFF.md`, then classify every target
and collect all approvals before changing any target:
- `missing`: path does not exist.
- `managed`: exactly one non-nested matching marker pair exists.
- `known-legacy`: no markers exist and the file is byte-for-byte equal to one
  of the two supported released 0.1.0 per-agent render variants below.
- `unrecognized`: existing unmarked content that is not exact known legacy.
- `malformed`: one marker missing, duplicate markers, end before start, or any
  nested managed marker.

The expected `known-legacy` structure applies to per-agent context files; an
unmarked `HANDOFF.md` is `unrecognized` unless it has its own matching managed
markers (`handoff-template`).

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

For an agent `contextFile`, define:
- `{TARGET_AGENTS}`: array of agents configured for this file.
- `{OTHER_AGENTS}`: comma-joined `displayName` (or id) of every configured
  agent *not* mapped to this file.
- `{AGENT_NAMES_JOINED}`: comma-joined `displayName` (or id, if no registry
  `displayName`) of every agent in `{TARGET_AGENTS}`.
- `{AGENT_IDS_SLASH}`: id of every agent in `{TARGET_AGENTS}`, joined with `/`
  (e.g. `codex/antigravity`).

Resolve the per-file title, section, claim rule, and attribution rule based on `{TARGET_AGENTS}` length:

- When `{TARGET_AGENTS}` has length 1 (single agent with `displayName` `{AGENT_NAME}` and id `{AGENT_ID}`):
  - `{AGENT_TITLE}`: `# {AGENT_NAME} Instructions`
  - `{AGENT_SECTION}`: `## {AGENT_NAME} specific`
  - `{CLAIM_RULE}`:
    ```
    - Claim a task by adding an entry to `HANDOFF.md`:
      `Claiming plan-name/task-N — {AGENT_ID}`
    ```
  - `{ATTRIBUTION_RULE}`:
    ```
    - Do not add a "Co-Authored-By" trailer or AI-attribution footer to
      commits or PRs. If this agent's setup has an equivalent
      auto-attribution behavior, disable it the same way
      `.claude/settings.json` does for Claude Code.
    ```
- When `{TARGET_AGENTS}` has length > 1 (multiple agents sharing this file, e.g. Codex and Antigravity):
  - `{AGENT_TITLE}`: `# Agent Instructions ({AGENT_NAMES_JOINED})`
  - `{AGENT_SECTION}`: `## {AGENT_NAMES_JOINED} specific`
  - `{CLAIM_RULE}`:
    ```
    - Claim a task by adding an entry to `HANDOFF.md` using your active agent identifier:
      `Claiming plan-name/task-N — <agent-id>` (use {AGENT_IDS_SLASH} depending on which agent you are running as)
    ```
  - `{ATTRIBUTION_RULE}`:
    ```
    - Do not add a "Co-Authored-By" trailer or AI-attribution footer to
      commits or PRs. Disable auto-attribution in your respective agent config.
    ```

Then fill the managed block below, substituting `{AGENT_TITLE}`, `{IMPORT_BLOCK}`, `{AGENT_SECTION}`, `{WORKFLOW_TOOLS_BLOCK}`, `{OTHER_AGENTS}`, `{CLAIM_RULE}`, and `{ATTRIBUTION_RULE}`:

```markdown
{AGENT_TITLE}

<!-- agent-sync:agent-policy:start -->
This file is intentionally thin. All real project knowledge lives in the
shared files below so other agents see the same thing.

{IMPORT_BLOCK}

{AGENT_SECTION}
{WORKFLOW_TOOLS_BLOCK}
- Read `HANDOFF.md` to see which agent ({OTHER_AGENTS}) last touched
  each plan/task and what's next.
- Before claiming or executing a plan task, check whether the user's prompt
  explicitly names a configured workflow tool or its artifacts. Only then use
  that tool's official lifecycle for the whole task, including its required
  verification and report. A prompt that doesn't mention a workflow tool gets
  a direct, ordinary execution path — do not route it through a workflow tool
  on your own inference.
{CLAIM_RULE}
- Before committing, read the convention in `docs/PROJECT_CONTEXT.md`. If it
  names a repository policy file, read that source too. Follow its format and
  examples. Keep plan names, task numbers, agent identity, and AI-attribution
  out of the commit message; workflow state and `HANDOFF.md` retain task
  traceability.
{ATTRIBUTION_RULE}
- At the end of a session, append a handoff entry to `HANDOFF.md` with task IDs
  only (e.g. `plan-name/task-N` or `none`). Do not write summaries or progress
  prose here — rich execution details belong in your workflow tool (e.g. `.superpowers/sdd/`).
<!-- agent-sync:agent-policy:end -->
```

Keep `{AGENT_TITLE}` outside the markers. The start marker immediately
precedes the shared-context pointer/import block, and the end marker
immediately follows the session-handoff rule. Do not create an empty user
section after the block.

`{WORKFLOW_TOOLS_BLOCK}`, when the resolved workflow-tool list is
non-empty — one bullet per tool, using its `displayName`,
`activationSignals`, `ownedPaths`, and resolved instructions:
```
- Only engage {TOOL_DISPLAY_NAME} when the user's prompt explicitly names it
  or its plan/task artifacts (e.g. mentions {TOOL_DISPLAY_NAME} by name, or
  references a path under {OWNED_PATHS}). Do not infer that a task belongs to
  this workflow from task shape, complexity, or ambient activation signals
  ({ACTIVATION_SIGNALS}) alone — plain requests get a direct, ordinary
  execution path. When the prompt does invoke {TOOL_DISPLAY_NAME}, follow
  these rules in order:
  1. {EXECUTION_INSTRUCTION_1}
  2. {EXECUTION_INSTRUCTION_2}
  Do not substitute a manual or generic execution path once engaged. If the
  required workflow cannot be invoked, stop and report the blocker.
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
- When `{TARGET_AGENTS}` has length 1:
```
See:
- docs/PROJECT_CONTEXT.md — tech stack, conventions, build commands
- HANDOFF.md — the running log between agents, per plan/task

({AGENT_NAME} doesn't support `@path` imports like Claude Code does —
read both files above manually at the start of every session, or wire
this into a startup script if your setup supports one.)
```
- When `{TARGET_AGENTS}` has length > 1:
```
See:
- docs/PROJECT_CONTEXT.md — tech stack, conventions, build commands
- HANDOFF.md — the running log between agents, per plan/task

({AGENT_NAMES_JOINED} do not support `@path` imports like Claude Code does —
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
<!-- Keep entries minimal: task IDs only. Do not write summaries or progress prose here
     — detailed briefs, reports, and reviews belong in your workflow tool (e.g. .superpowers/sdd/). -->

Plan/task identifiers belong here and in workflow state, not in commit subjects.

## Template for new entries
\`\`\`
### YYYY-MM-DD HH:MM — [{AGENT_IDS_PIPE}]
- Claiming: plan-name/task-N
- Finished: plan-name/task-N
- Next: plan-name/task-K (or none)
- Blockers: none (or 1-line reason)
\`\`\`
<!-- agent-sync:handoff-template:end -->

---
```

For `.claude/settings.json`:

Detect vendor, dependency, and build directories (check for directory existence at repository root: `node_modules/`, `vendor/`, `.venv/`, `venv/`, `target/`, `dist/`, `build/`, `.next/`, `__pycache__/`, and inspect package manifests `package.json`, `composer.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) to compile `{DETECTED_VENDOR_DIRS}`.

If `.claude/settings.json` doesn't exist:
- When vendor directories are detected (e.g. `node_modules`, `vendor`, `.venv`), render and stage these candidate bytes:
  ```json
  {
    "attribution": {
      "commit": "",
      "pr": "",
      "sessionUrl": false
    },
    "hooks": {
      "SessionEnd": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "python3 .agent-sync/scripts/archive.py"
            }
          ]
        }
      ]
    },
    "permissions": {
      "ask": [
        "Read(./node_modules/**)"
      ]
    }
  }
  ```
  Add a `Read(./{dir}/**)` entry under `permissions.ask` for each discovered vendor directory (e.g. `Read(./node_modules/**)`, `Read(./vendor/**)`, `Read(./.venv/**)`).
- When no vendor directories are detected, render and stage:
  ```json
  {
    "attribution": {
      "commit": "",
      "pr": "",
      "sessionUrl": false
    },
    "hooks": {
      "SessionEnd": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "python3 .agent-sync/scripts/archive.py"
            }
          ]
        }
      ]
    }
  }
  ```

If `.claude/settings.json` already exists:
- Read the existing file into memory.
- Preserve all existing keys, attribution settings, and permission rules.
- If `hooks.SessionEnd` is missing or does not include the `archive.py` hook command, merge/append the hook.
- If `permissions.ask` is missing or does not include the detected vendor patterns (`Read(./{dir}/**)`), merge/append the missing patterns. If all are already present, stage byte-for-byte preservation.

After all candidate bytes exist, complete the earlier classification of every
target and collect all approvals. Do not continue until `.agent-sync/config.json`
(existing, migrated, or proposed), every resolved agent `contextFile`,
`HANDOFF.md`, and `.claude/settings.json` each has an original snapshot and a
fully resolved staged disposition.

### 1C — optional docs/PROJECT_CONTEXT.md generation

Only run this section when `{GENERATE_PROJECT_CONTEXT}` is yes (first run
only — never on a repeat run, even if the file is missing or the question
would otherwise apply). Use the workflow-tool list already resolved and
validated in Phase 1B, then perform the following self-contained preflight.
When `{GENERATE_PROJECT_CONTEXT}` is no or this is not first-run, skip all of
1C — do not create, touch, or classify `docs/PROJECT_CONTEXT.md`.

### 1C.1 — inspect the project and detect commit policy

For a missing `docs/PROJECT_CONTEXT.md`, inspect this repository yourself
before writing anything — do not use placeholder text. For a managed or
approved unrecognized file, preserve every byte outside the `project-policy`
markers while replacing or inserting only that block:

- Read package.json / pyproject.toml / Cargo.toml / go.mod / Gemfile
  (whichever exists) to identify the language, framework, and package
  manager.
- Check for lockfiles to confirm the package manager (package-lock.json,
  pnpm-lock.yaml, yarn.lock, poetry.lock, Cargo.lock, etc.).
- Find the test runner and lint/format commands from package.json scripts,
  Makefile, tox.ini, or CI config (.github/workflows/*.yml).
- Skim the README for a one/two-sentence description of what the project does
  and who it's for.
- Look at the top-level directory layout and note the architecture at a glance
  (e.g. "monorepo with apps/ and packages/", "Django app with standard
  app-per-feature layout").
- Note any obvious "don't touch" paths (generated dirs, vendored code, build
  output) from .gitignore.
- Detect vendor, dependency, and build directories (or reuse `{DETECTED_VENDOR_DIRS}` compiled in Phase 1B):
  - Check for directory existence at repository root: `node_modules/`, `vendor/`, `.venv/`, `venv/`, `target/`, `dist/`, `build/`, `.next/`, `__pycache__/`.
  - Also inspect package manifests (`package.json`, `composer.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) for expected dependency trees.
  - Compile the unique list of detected paths as `{DETECTED_VENDOR_DIRS}` (e.g. `node_modules/`, `dist/`).

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

### 1C.2 — render and classify docs/PROJECT_CONTEXT.md

Using the resolved configuration and commit policy, render the proposed
`docs/PROJECT_CONTEXT.md` bytes with this structure, filled in with what you
actually found (leave a section explicitly marked
"not detected — fill in manually" if you can't determine it from the repo,
rather than guessing):

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
  <!-- When {DETECTED_VENDOR_DIRS} is non-empty:
  - Do not read, search, or edit vendored or build directories ({DETECTED_VENDOR_DIRS}) to conserve context and reduce cost. Only inspect specific files if diagnosing third-party bugs after checking project source code.
  When {DETECTED_VENDOR_DIRS} is empty:
  - Leave generated build artifacts and dependency directories alone. -->

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
code style, technical context, architecture, and decisions outside this
managed block.

Classify `docs/PROJECT_CONTEXT.md` as:
- `missing`: stage creation of the full render.
- `managed`: exactly one non-nested matching `project-policy` marker pair
  exists; stage replacement of the markers and all bytes between them while
  preserving every byte before and after.
- `unrecognized`: unmarked content; show the proposed block and ask before
  inserting it after a top-level title or at byte zero. On no, stage
  byte-for-byte preservation.
- `malformed`: one marker missing, duplicate markers, end before start, or a
  nested managed marker; stage byte-for-byte preservation, report the exact
  defect, and never guess or ask to overwrite it.

The workflow ownership line inside the `project-policy` block, when the
resolved workflow-tool list is non-empty, is one line per tool:

```
- Live execution state (task briefs, reports, progress) is owned by
  {TOOL_DISPLAY_NAME} at `{ownedPath1}`, `{ownedPath2}`, ... — don't
  hand-edit these or create files there yourself; that's the tool's
  job.
```

When the resolved workflow-tool list is empty, omit the workflow ownership
line. Keep the `Plan & spec structure` heading and its `Multiple plans...`
line unchanged.

For `- Things NOT to do (generated files to leave alone, dirs to avoid, etc.):`:
- When `{DETECTED_VENDOR_DIRS}` is non-empty:
  ```markdown
  - Things NOT to do (generated files to leave alone, dirs to avoid, etc.):
    - Do not read, search, or edit vendored or build directories ({DETECTED_VENDOR_DIRS}) to conserve context and reduce cost. Only inspect specific files if diagnosing third-party bugs after checking project source code.
  ```
- When `{DETECTED_VENDOR_DIRS}` is empty:
  ```markdown
  - Things NOT to do (generated files to leave alone, dirs to avoid, etc.):
    - Leave generated build artifacts and dependency directories alone.
  ```

After the candidate bytes exist, complete classification and collect any
required approval. Do not continue until `docs/PROJECT_CONTEXT.md` has an
original byte snapshot (or recorded absence) and a fully resolved staged
disposition. Stage its result for Phase 2 alongside this command's other
targets.

## Phase 2 — apply the fully resolved preflight plan

Immediately before the first write, confirm every target still matches its
Phase 1 snapshot. If any target changed, stop before writes and restart the
entire preflight. Otherwise apply the staged plan without further detection,
rendering, classification, prompts, or user decisions:

- Apply `{CONFIG_MIGRATION}` if one was staged (write `.agent-sync/config.json`,
  delete root `.agent-sync.json`); on first run, write the staged
  `.agent-sync/config.json`; otherwise preserve the existing configuration.
- For each managed Markdown target (agent `contextFile`s, `HANDOFF.md`, and
  `docs/PROJECT_CONTEXT.md` if staged in 1C), perform its staged creation,
  managed-block update, known-legacy migration, approved insertion, or
  byte-for-byte preservation exactly as classified.
- Create `.claude/settings.json` when its staged disposition is `missing`; update it
  if missing vendor permission rules were merged; otherwise preserve it byte-for-byte.

## Phase 3 — verify and report every target

Re-read every target after application: `.agent-sync/config.json`, every
resolved agent `contextFile`, `HANDOFF.md`, `.claude/settings.json`, and
`docs/PROJECT_CONTEXT.md` if it was generated in 1C. Compare each result with
the staged bytes and original snapshot. Verify created files match their full
render; updated managed files preserve all unmanaged bytes; migrated legacy
files match the proposed managed render; and preserved files, including
declined unrecognized and malformed targets, remain byte-for-byte unchanged.
Stop and report any mismatch.

Report one disposition for every target: created, updated, migrated, or
preserved, including the reason for preservation. Report the config migration
if one occurred. If `docs/PROJECT_CONTEXT.md` was generated in 1C, also report
its commit-policy source and which sections came from real project signals
versus remained "not detected", with a reminder to review those gaps.
