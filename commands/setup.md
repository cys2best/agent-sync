---
description: Create or update .agent-sync/config.json and scaffold per-agent context files, HANDOFF.md, MEMORY.md, COMMIT_CONVENTION.md, and .claude/settings.json so multiple coding agents share project context and task handoff.
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
---

## Phase 1 — preflight configuration, policy, renders, and decisions

This entire phase is read-only: do not create or modify any file. Complete its
work in this order: resolve configuration; inspect the project tech stack;
resolve and validate agents and workflows; render every proposed target;
classify every target; then resolve every conflict and approval. Hold all proposed
bytes and each target's original byte snapshot in memory. If any validation,
conflict, or required user decision remains unresolved, stop with no writes.

Read the command arguments (`$ARGUMENTS` when supplied by the host).
Accept only optional `--regenerate-context`; unknown arguments stop before
writes. Set `{REGENERATE_CONTEXT}` to true only for that flag, otherwise false.
The flag requests full context regeneration, including on repeat setup runs;
it does not reopen configuration selection or change existing config values.

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
     `CLAUDE.md`) is a signal that agent is already in use here; a
     directory matching a workflow tool's `ownedPaths` (e.g.
     `.superpowers/`) is a signal that tool is already in use here.
   - Ask the user which agents to enable for this project. Offer the
     registry's known agents as defaults (`claude`, `codex`, `antigravity`,
     `cursor`, `grok`, `gemini`), pre-selecting any detected from existing
     files, and allow adding a custom agent (id, `contextFile`, `supportsImports`).
   - Ask the user which workflow/plan-execution tools this project
     uses (offer `superpowers` as the default, pre-selected if
     detected; allow zero tools, or a custom tool: id, `displayName`,
     `ownedPaths`, `activationSignals`, `executionInstructions`). For a
     custom tool, collect all four fields: `displayName` is the name shown to
     agents; `ownedPaths` identifies state the tool owns; `activationSignals`
     identifies repository-relative globs that activate the workflow; and
     `executionInstructions` is the ordered, tool-specific lifecycle the
     agent must follow.
   - Ask whether to enable workflow model routing (default: disabled). If yes,
     offer each enabled agent's `modelDefaults` as an editable balanced
     preset, collect policies for the desired workflows and the escalation
     choice (auto/ask/never; default ask), and include `modelPolicy` in the
     same configuration object. Agents without defaults require explicit
     model IDs available in their host. Show that this generates instructions,
     with automatic selection dependent on the host/workflow's controls.
   - Build one configuration object from the selected agents and workflow
     tools, applying the omission and inline-object rules below.
     Assign that single validated object to `{EFFECTIVE_CONFIG}` before Phase
     1B consumes it. Resolve and validate every selected workflow using Phase 1C's
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
     `["superpowers"]` (see Phase 1C), which matches this plugin's own
     prior hardcoded behavior. An explicit `"workflowTools": []` means
     "none", and is different from omitting the key.

### 1B — inspect project and tech stack

Inspect the repository to discover purpose, runtime, commands, boundaries, and vendor
directories. All real project context is written directly into `AGENTS.md` (and durable
lessons into `MEMORY.md`), eliminating the need for a separate `docs/PROJECT_CONTEXT.md`.

Commit policy is not dynamically inferred: agent-sync strictly enforces Conventional Commits:
`<type>(optional-scope): imperative description` and scaffolds `COMMIT_CONVENTION.md`.

- Read the relevant manifest, lockfile, README, task scripts, and CI config
  to identify purpose, runtime, package manager, and commands. Inspect only
  enough first-party files to confirm these facts.
- Resolve `{CMD_VERIFY}` to the existing verification script, or a compact
  combination of the project's test and lint/typecheck commands.
  Resolve `{CMD_TEST_FOCUSED}` to one useful targeted-test example when known;
  `{CMD_BUILD}` and `{CMD_SETUP}` only when they add necessary information.
  Never invent commands; omit unavailable commands and report essential gaps.
- Identify up to five non-obvious boundaries or constraints with concrete
  paths. Do not produce a directory inventory or describe code readable at
  the point of use. Prefer links to existing detailed documentation.
- Detect vendor/build directories from package manifests (`package.json`,
  `composer.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`), `.gitignore`,
  and root directory names (`node_modules/`, `vendor/`, `.venv/`, `venv/`,
  `target/`, `dist/`, `build/`, `.next/`, `__pycache__/`).
  Record unique existing paths as `{DETECTED_VENDOR_DIRS}`; do not scan their
  contents. Render at most one exclusion bullet.

Define the following values before rendering the `agent-policy` block:
- `{COMMIT_FORMAT}` is `<type>(optional-scope): imperative description`.
- `{COMMIT_EXAMPLE_1}` is `feat(config): add workflow model policies`.
- `{PROJECT_PURPOSE_AND_STACK}` is the two-sentence project purpose and tech stack summary.

### 1C — resolve, validate, and render targets

For every agent in `{EFFECTIVE_CONFIG}`'s `agents` array, resolve its
`displayName`, `contextFile`, and `supportsImports` — from the registry if it's a
known id, or from the custom object's own fields otherwise. Group enabled
agents in `{EFFECTIVE_CONFIG}` by their resolved target `contextFile`. For each
unique `contextFile`, define:
- `{TARGET_AGENTS}`: array of agents configured for this file.
- `{OTHER_AGENTS}`: comma-joined `displayName` (or id) of every configured
  agent *not* mapped to this file.
Two or more agents may resolve to the same `contextFile` (e.g. Claude Code, Codex,
Antigravity, Cursor, and Grok all resolve to `AGENTS.md`) — render that target once
using the multi-agent rendering rules below.

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

Resolve and validate the optional model policy in Phase 1C.1 before rendering.

After every render input is resolved, construct the proposed managed blocks for
all targets:
1. `AGENTS.md` (and any custom agent `contextFile`s)
2. `COMMIT_CONVENTION.md`
3. `CLAUDE.md` (when `claude` is an enabled agent)
4. `MEMORY.md`
5. `HANDOFF.md`
6. `.claude/settings.json`
7. `docs/PROJECT_CONTEXT.md` (staged for removal if existing)

Classify every target and collect all approvals before changing any target:
- `missing`: path does not exist.
- `managed`: exactly one non-nested matching marker pair exists.
- `unrecognized`: existing unmarked content.
- `malformed`: one marker missing, duplicate markers, end before start, or any
  nested managed marker.

During preflight, record one staged action for each classification after all
approvals have been collected; do not execute any action yet:
- `missing`: stage creation of the file with its managed block.
- `managed`: stage replacement of the matching markers and all bytes between
  them; preserve every byte before and after.
- `unrecognized`: show the proposed block and ask before inserting it. On yes,
  stage insertion after a top-level title, otherwise at byte zero. On no, stage
  byte-for-byte preservation and continue classifying other targets.
- `malformed`: stage byte-for-byte preservation, record the exact defect, and
  never guess or ask to overwrite it.

#### Rendering `AGENTS.md`

For `AGENTS.md`, define:
- `{TARGET_AGENTS}`: array of agents configured for this file.
- `{OTHER_AGENTS}`: comma-joined `displayName` (or id) of every configured
  agent *not* mapped to this file.
- `{AGENT_NAMES_JOINED}`: comma-joined `displayName` (or id, if no registry
  `displayName`) of every agent in `{TARGET_AGENTS}`.
- `{AGENT_IDS_SLASH}`: id of every agent in `{TARGET_AGENTS}`, joined with `/`
  (e.g. `claude/codex/antigravity`).

Resolve the title, section, claim rule, and attribution rule:
- When `{TARGET_AGENTS}` has length 1 (single agent with `displayName` `{AGENT_NAME}` and id `{AGENT_ID}`):
  - `{AGENT_TITLE}`: `# {AGENT_NAME} Instructions`
  - `{AGENT_SECTION}`: `## {AGENT_NAME} specific`
  - `{CLAIM_RULE}`:
    ```
    - When claiming or progressing a plan task, update that plan's entry in
      `HANDOFF.md` in-place (or add an entry if starting a new plan): record
      `{AGENT_ID}`, current task, finished tasks, next task, and blockers.
    ```
  - `{ATTRIBUTION_RULE}`:
    ```
    - Do not add a "Co-Authored-By" trailer or AI-attribution footer to
      commits or PRs. If this agent's setup has an equivalent
      auto-attribution behavior, disable it the same way
      `.claude/settings.json` does for Claude Code.
    ```
- When `{TARGET_AGENTS}` has length > 1 (multiple agents sharing this file, e.g. Claude Code, Codex, Antigravity):
  - `{AGENT_TITLE}`: `# Agent Instructions ({AGENT_NAMES_JOINED})`
  - `{AGENT_SECTION}`: `## {AGENT_NAMES_JOINED} specific`
  - `{CLAIM_RULE}`:
    ```
    - When claiming or progressing a plan task, update that plan's entry in
      `HANDOFF.md` in-place (or add an entry if starting a new plan): record
      your active agent identifier (use {AGENT_IDS_SLASH} depending on which agent you are running as),
      current task, finished tasks, next task, and blockers.
    ```
  - `{ATTRIBUTION_RULE}`:
    ```
    - Do not add a "Co-Authored-By" trailer or AI-attribution footer to
      commits or PRs. Disable auto-attribution in your respective agent config.
    ```

Then render `AGENTS.md` managed block:

```markdown
{AGENT_TITLE}

<!-- agent-sync:agent-policy:start -->
This file contains shared project knowledge, conventions, and agent instructions.

See:
- HANDOFF.md — the running log between agents, per plan/task
- MEMORY.md — project learnings, component pitfalls, and durable lessons
- COMMIT_CONVENTION.md — commit message format and rules
- AGENTS.local.md — local private notes and personal overrides (gitignored)

## Overview

{PROJECT_PURPOSE_AND_STACK}

## Commands

- Verify: `{CMD_VERIFY}`
- Focused test: `{CMD_TEST_FOCUSED}`
- Build: `{CMD_BUILD}`
- Setup: `{CMD_SETUP}`

## Boundaries

{UP_TO_FIVE_ACTIONABLE_PATH_SPECIFIC_CONSTRAINTS}
{VENDOR_EXCLUSION_IF_DETECTED}

## Conventions

- Commit format: `<type>(optional-scope): imperative description` (see `COMMIT_CONVENTION.md`)
- Commit example: `{COMMIT_EXAMPLE_1}`
{WORKFLOW_TOOLS_OWNERSHIP_LINE}

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
- Before committing, follow the commit convention in `COMMIT_CONVENTION.md`. Keep plan names, task numbers, agent identity, and AI-attribution
  out of the commit message; workflow state and `HANDOFF.md` retain task
  traceability.
{ATTRIBUTION_RULE}
- Keep only one entry per active plan in `HANDOFF.md`; update it in-place with
  task IDs only. Do not add entries for idle sessions where no tasks progressed.
- Think Before Coding: State consequential assumptions and tradeoffs; ask when ambiguity changes the result, and suggest a simpler approach when appropriate.
- Simplicity First: Implement only the requested behavior with the smallest clear solution; avoid speculative features, configuration, and abstractions.
- Surgical Changes: Match local style, change only what the task requires, and remove only code made unused by your changes; flag unrelated cleanup separately.
- Learning: Keep up to five one-line lessons (25 words each) in MEMORY.md as `Component: pitfall → action`; merge duplicates, replace obsolete entries, and prefer regression tests.
- Context upkeep: Aim for 80 lines, at most 120 lines and 1,200 words; keep actionable facts once, link to existing detail, and omit history, progress, and empty sections.
<!-- agent-sync:agent-policy:end -->
```

If `{OTHER_AGENTS}` is empty (all configured agents share `AGENTS.md`), omit `({OTHER_AGENTS})` from the `Read HANDOFF.md` bullet so it reads:
`- Read HANDOFF.md to see which agent last touched each plan/task and what's next.`

`{WORKFLOW_TOOLS_OWNERSHIP_LINE}`, when the resolved workflow-tool list is non-empty, is one line per tool:
`- Live execution state belongs to {TOOL_DISPLAY_NAME} at {OWNED_PATHS}; use its lifecycle and never hand-edit those paths.`
When empty, omit this line.

`{WORKFLOW_TOOLS_BLOCK}`, when the resolved workflow-tool list is non-empty — one bullet per tool:
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
When empty, omit `{WORKFLOW_TOOLS_BLOCK}` entirely without leaving a blank line.

#### Rendering `COMMIT_CONVENTION.md`

Scaffold `COMMIT_CONVENTION.md` at the project root:

```markdown
# Commit Convention

This repository follows the [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/#summary) specification.

## Structure

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

## Types

- `feat`: (correlates with `MINOR` in SemVer) A new feature or capability
- `fix`: (correlates with `PATCH` in SemVer) A bug fix
- `docs`: Documentation only changes
- `style`: Changes that do not affect the meaning of the code (white-space, formatting, semi-colons, etc.)
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `perf`: A code change that improves performance
- `test`: Adding missing tests or correcting existing tests
- `build`: Changes that affect the build system or external dependencies
- `ci`: Changes to CI configuration files and scripts
- `chore`: Other changes that don't modify src or test files

## Breaking Changes

Breaking changes (correlating with `MAJOR` in SemVer) MUST be signaled by:
- An exclamation mark (`!`) immediately preceding the colon (e.g., `feat!: drop support for python 3.9` or `fix(api)!: alter response shape`), or
- A `BREAKING CHANGE: <description>` entry in the footer.

## Rules & Best Practices

1. **Imperative Mood**: Use imperative present tense in description (e.g., "add feature", not "added feature" or "adds feature").
2. **Case**: Lowercase type and description.
3. **No Trailing Period**: Do not end the description line with a period.
4. **Line Length**: Keep the header line concise (under 72 characters).
5. **Scope**: Optional noun enclosed in parentheses describing the affected codebase section (e.g., `feat(config): ...`).
6. **Body & Footers**: Optional. When provided, separate the header, body, and footers with a single blank line.
7. **Clean Traceability**:
   - Do NOT include agent identities, plan names, or task numbers in commit messages (traceability belongs in `HANDOFF.md` and workflow state).
   - Do NOT add "Co-Authored-By", AI-attribution footers, or generator trailers to commits or PRs.
```

- If `COMMIT_CONVENTION.md` does not exist: stage creation.
- If `COMMIT_CONVENTION.md` exists: preserve byte-for-byte.

#### Rendering `CLAUDE.md`

When `claude` is an enabled agent in `{EFFECTIVE_CONFIG}`:
Render a minimal redirect block that instructs Claude Code to read and follow `AGENTS.md`. Wrap this single instruction in an `agent-policy` managed block so that existing content outside the markers in `CLAUDE.md` is strictly preserved:

```markdown
<!-- agent-sync:agent-policy:start -->
Read and follow [AGENTS.md](AGENTS.md) before doing anything in this repository.
<!-- agent-sync:agent-policy:end -->
```

- If `CLAUDE.md` does not exist: stage creation of the file with the managed block above.
- If `CLAUDE.md` already contains an `agent-policy` managed block: stage replacement of the block with the minimal instruction above, preserving every byte before and after.
- If `CLAUDE.md` contains unrecognized unmarked content: prompt before inserting the managed block after a top-level heading or at byte zero.
Because Claude Code follows `AGENTS.md`, and `AGENTS.md` directs agents to `AGENTS.local.md`, no `claude.local.md` is needed.

#### Rendering `MEMORY.md`

Scaffold a project-root `MEMORY.md` for project learnings, component pitfalls, and durable lessons:

```markdown
# Project Memory & Lessons

<!-- agent-sync:memory:start -->
## Lessons

{UP_TO_FIVE_OBSERVED_ONE_LINE_LESSONS_OR_OMIT}
<!-- agent-sync:memory:end -->
```

- If missing: stage creation.
- If managed (`<!-- agent-sync:memory:start -->` ... `<!-- agent-sync:memory:end -->`): stage replacement of the managed block, preserving all unmanaged notes.
- If unrecognized: ask before inserting or preserve.

#### Rendering `HANDOFF.md`

For a missing `HANDOFF.md`, `{AGENT_IDS_PIPE}` is every configured agent's id,
joined with `|`. Render the title, then the exact managed block around its
explanatory comment and template. Close the managed block before `---`; real
handoff entries remain outside the block:

```markdown
# Handoff Log

<!-- agent-sync:handoff-template:start -->
<!-- Keep entries minimal: task IDs only. Do not write summaries or progress prose here
     — detailed briefs, reports, and reviews belong in your workflow tool (e.g. .superpowers/sdd/). -->

Active plans and current task state. Each plan has at most one entry, updated in-place as work progresses.
Do not log idle sessions or append duplicate historical entries.

## Template for active plan entry
\`\`\`
### [plan-name] — [{AGENT_IDS_PIPE}] (YYYY-MM-DD HH:MM)
- Claiming: plan-name/task-N
- Finished: plan-name/task-M (or none)
- Next: plan-name/task-K (or none)
- Blockers: none (or 1-line reason)
\`\`\`
<!-- agent-sync:handoff-template:end -->

---
```

#### Rendering `.claude/settings.json`

If `.claude/settings.json` doesn't exist:
- When vendor directories are detected, render and stage:
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
  Add a `Read(./{dir}/**)` entry under `permissions.ask` for each discovered vendor directory.
- When no vendor directories are detected, render and stage without `permissions.ask`.

If `.claude/settings.json` already exists:
- Read into memory. Preserve all existing keys, attribution settings, and permissions.
- If `hooks.SessionEnd` is missing or lacks the `archive.py` hook, merge/append the hook.
- If `permissions.ask` is missing or lacks detected vendor patterns, merge/append them.

#### Cleanup of `docs/PROJECT_CONTEXT.md`

If `docs/PROJECT_CONTEXT.md` exists in the repository (e.g. from an older setup run):
Stage its deletion in Phase 2, as its contents have been directly absorbed into `AGENTS.md`.

### 1C.1 — optional workflow model policy

Resolve optional `modelPolicy` from `{EFFECTIVE_CONFIG}`. Missing or `{}`
means no model routing; preserve historical behavior and render no model-policy
instructions. Never enable it merely because registry defaults exist.

The schema is `modelPolicy[workflowId][agentId]`, where each agent policy is
either `"balanced"` or an object with required `planning`,
`implementation`, and `review` model strings and optional `escalation`.
`escalation` is `"auto"`, `"ask"`, or `"never"`; omission means `"ask"`.
`"balanced"` copies that agent's registry/custom `modelDefaults` and uses
`"ask"`. Model strings are opaque IDs/aliases, not shell commands: require
non-empty strings without whitespace, backticks, or control characters.
Pass model IDs as structured arguments to exposed controls; never interpolate
config values into shell command text.
Reject unknown fields in a policy object, invalid types (including null),
unknown/disabled workflow or agent IDs, and incomplete phase mappings before
any writes. Empty workflow maps are valid and render nothing.

Resolve `modelDefaults` and `modelSelectionInstructions` from the agent
registry or inline custom agent object, never from hardcoded agent branches.
A preset requires all three valid default model strings; if absent, report
that explicit models are required. Optional selection instructions must be a
non-empty string. Explicit phase objects replace the preset entirely; do not
merge missing phases from defaults. Explicit objects work for any configured
agent/workflow, including custom entries. Where selection instructions are
absent, use: "Use only model-selection controls exposed by the current host;
if none are available, request a manual model switch."

For each resolved workflow/agent policy, render the following as an additional
bullet in that agent's `agent-policy` managed block in `AGENTS.md`:

- For {WORKFLOW_ID}, when running as {AGENT_ID}, use planning={PLANNING_MODEL},
  implementation={IMPLEMENTATION_MODEL}, review={REVIEW_MODEL},
  escalation={ESCALATION}.
  Read the matching entry in `.agent-sync/config.json` before each phase;
  it is authoritative if changed since setup. Use the schema and resolution
  rules above for that entry; a removed policy disables routing. A missing
  preset definition or invalid entry requires correction before dispatch.
  Planning includes discovery, design, plan writing, and substantive replanning.
  Review includes task/spec/code reviews and the final whole-branch review.
  Implementation includes coding and running the plan's checks only after
  the workflow's plan approval/readiness gate is satisfied, with concrete
  scope and acceptance checks. If the plan is absent or materially ambiguous,
  return to planning before implementation. Model choice never skips tests,
  approval gates, or required reviews.
  {MODEL_SELECTION_INSTRUCTIONS}
  Keep the workflow's official dispatch, prompts, tools, and reports. Apply
  the model through that dispatch's supported controls; do not replace its
  lifecycle or edit its owned state or installed skills. Do not change
  global/default model settings for all phases.
  If a selected model is unavailable, model selection is unsupported, or
  host overrides conflict, report the requested model and the limitation
  and request a supported replacement or manual switch before that phase.
  Never claim a model switch without host evidence; report the requested
  model and actual model if exposed, otherwise mark actual model unverified.
  If implementation requires redesign or repeats the same failure after two
  attempted fixes, use the planning model for diagnosis/replanning under
  escalation=auto and report why. With escalation=ask, ask first; with
  escalation=never, stop that task and report the blocker. Return to the
  implementation model once the revised plan is ready. Final review always
  uses the configured review model regardless of escalation.
  Record routing decisions in the workflow's normal report if supported, or
  the conversation; keep HANDOFF.md limited to task IDs.

The text referring to schema rules must be self-contained in generated
context files: render the compact schema, preset defaults for that agent,
and validation/disabled-policy rules alongside the bullet (not a dangling
reference to this command). Render resolved literal IDs, never placeholders.
If the policy is removed on a later setup run, remove its generated bullets
with the managed-block replacement. Report every resolved phase mapping and
whether host selection remains unverified; setup is not a model smoke test.

### 1D — handling `--regenerate-context`

When `{REGENERATE_CONTEXT}` is true (via `--regenerate-context`):
- Rescan the repository as detailed in 1B to re-detect project purpose, stack,
  commands, boundaries, vendor directories, and lessons.
- Reserve a unique missing path `.agent-sync/backups/AGENTS.<unique-id>.md`
  during read-only preflight and stage an exact-byte backup of the original
  `AGENTS.md` snapshot. Never overwrite an existing backup.
- Stage replacement of `AGENTS.md` managed context block with the refreshed
  sections, while carrying forward still-valid user constraints.
- Record `regenerated` as the disposition for `AGENTS.md`.

## Phase 2 — apply the fully resolved preflight plan

Immediately before the first write, confirm every target still matches its
Phase 1 snapshot and any reserved backup path is still absent. If any target changed, stop before writes and restart the
entire preflight. Otherwise apply the staged plan without further detection,
rendering, classification, prompts, or user decisions:

- If regenerating an existing context, create the reserved backup exclusively
  and verify it matches the original snapshot before replacing the context.
  If backup creation or verification fails, stop without replacing the context.
  Never overwrite a backup that appeared after preflight.
- Apply `{CONFIG_MIGRATION}` if one was staged (write `.agent-sync/config.json`,
  delete root `.agent-sync.json`); on first run, write the staged
  `.agent-sync/config.json`; otherwise preserve the existing configuration.
- For each managed Markdown target (`AGENTS.md`, `COMMIT_CONVENTION.md`,
  `CLAUDE.md`, `MEMORY.md`, and `HANDOFF.md`), perform its staged creation,
  managed-block update, full regeneration, approved insertion, or byte-for-byte
  preservation exactly as classified.
- Delete `docs/PROJECT_CONTEXT.md` if staged for removal.
- Create `.claude/settings.json` when its staged disposition is `missing`; update it
  if missing vendor permission rules or hooks were merged; otherwise preserve it byte-for-byte.

## Phase 3 — verify and report every target

For regeneration, verify the backup matches the preflight original and the
entire context matches the staged full render; report `regenerated`, the
backup path, and final line/word counts. Unmanaged-byte preservation applies
only to ordinary refreshes, not explicitly requested full regeneration.

Re-read every target after application: `.agent-sync/config.json`, `AGENTS.md`,
`COMMIT_CONVENTION.md`, `CLAUDE.md` (if enabled), `MEMORY.md`, `HANDOFF.md`, and `.claude/settings.json`.
Compare each result with the staged bytes and original snapshot. Verify created
files match their full render; ordinary managed-block updates preserve all unmanaged
bytes; and preserved files, including declined unrecognized and malformed targets,
remain byte-for-byte unchanged.
Verify `docs/PROJECT_CONTEXT.md` is removed if it previously existed.
Stop and report any mismatch.

Report one disposition for every target: created, updated, regenerated,
deleted, or preserved, including the reason for preservation. Report the config migration
if one occurred. Report commit format (`<type>(optional-scope): imperative description`),
detected commands, line/word counts, and any existing-file budget warning.
