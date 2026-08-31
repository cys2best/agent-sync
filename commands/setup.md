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
   - Ask one more question: "Also generate `docs/PROJECT_CONTEXT.md` now?
     (recommended if this is the first agent-sync setup for this repo)"
     (yes/no, default yes). Record the answer as `{GENERATE_PROJECT_CONTEXT}`.
   - Before staging `.agent-sync/config.json`, resolve and validate every
     selected workflow using Phase 1B's workflow policy. On invalid input,
     report the workflow id and invalid field and do not write the file.
   - Render the proposed `.agent-sync/config.json` bytes in memory for later
     application:
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
known id, or from the custom object's own fields otherwise. Two agents
may resolve to the same `contextFile` (Codex and Cursor both default to
`AGENTS.md`) — render that target once and list every agent mapped to it
in each other's "other agents" note below.

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
- Before claiming or executing a plan task, check whether the user's prompt
  explicitly names a configured workflow tool or its artifacts. Only then use
  that tool's official lifecycle for the whole task, including its required
  verification and report. A prompt that doesn't mention a workflow tool gets
  a direct, ordinary execution path — do not route it through a workflow tool
  on your own inference.
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

After all candidate bytes exist, complete the earlier classification of every
target and collect all approvals. Do not continue until `.agent-sync/config.json`
(existing, migrated, or proposed), every resolved agent `contextFile`,
`HANDOFF.md`, and `.claude/settings.json` each has an original snapshot and a
fully resolved staged disposition.

### 1C — optional docs/PROJECT_CONTEXT.md generation

Only run this section when `{GENERATE_PROJECT_CONTEXT}` is yes (first run
only — never on a repeat run, even if the file is missing or the question
would otherwise apply). Perform the exact same detection and rendering
`commands/project-context.md` performs in its own Phase 1 (repo inspection,
commit-policy detection, `docs/PROJECT_CONTEXT.md` render and classification)
and stage its result for Phase 2 alongside this command's other targets.
When `{GENERATE_PROJECT_CONTEXT}` is no or this is not first-run, skip this
section entirely — do not create, touch, or classify `docs/PROJECT_CONTEXT.md`.

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
- Create `.claude/settings.json` only when its staged disposition is `missing`;
  otherwise preserve it byte-for-byte.

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
