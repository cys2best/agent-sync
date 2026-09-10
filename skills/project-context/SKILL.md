---
name: project-context
description: Detect this repo's tech stack, conventions, and commit policy, and (re)generate docs/PROJECT_CONTEXT.md from an existing agent-sync configuration.
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
---

## Phase 1 — preflight detection, policy, render, and classification

This entire phase is read-only: do not create or modify any file.

Read the command arguments (`$ARGUMENTS` when supplied by the host).
Accept only optional `--regenerate`; unknown arguments stop before writes.
Set `{REGENERATE_CONTEXT}` to true only for that flag, otherwise false.
Without it, existing files receive only a managed-policy refresh.

### 1A — resolve configuration

1. If `.agent-sync/config.json` exists, read it into `{EFFECTIVE_CONFIG}` and
   stage no configuration write.
2. Else if `.agent-sync.json` exists at the repo root, read it into
   `{EFFECTIVE_CONFIG}`. Stage `{CONFIG_MIGRATION}`: write the same bytes to
   `.agent-sync/config.json` and delete the root file, to be applied in
   Phase 2.
3. Else, stop immediately and report: "No agent-sync configuration found.
   Run `/agent-sync:setup` first." Make no writes.

### 1B — resolve the workflow-tool list

Resolve the workflow-tool list from `{EFFECTIVE_CONFIG}`'s `workflowTools`
key. If the key is absent, treat it as `["superpowers"]`. If present
(including `[]`), use it exactly as written. Resolve each entry's
`displayName` and `ownedPaths` from `${CLAUDE_PLUGIN_ROOT:-.}/registry/workflow-tools.json`
(known id) or the object's own fields (custom). `activationSignals` and
`executionInstructions` are not needed by this command.

Validate each resolved workflow's `displayName` (non-empty string) and
`ownedPaths` (non-empty array of repository-relative paths). On failure,
report the workflow id and invalid field, then stop before writes.

### 1C — inspect the project and detect commit policy

For a missing context or requested regeneration, inspect the repository
before rendering; do not use placeholder text. Otherwise refresh only the
managed policy and preserve all bytes outside its markers. Detection for a
full render follows:

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
- Detect vendor/build directories from the relevant manifests, .gitignore,
  and root directory names (reuse setup's `{DETECTED_VENDOR_DIRS}` if available).
  Record the unique existing paths as `{DETECTED_VENDOR_DIRS}`; do not scan
  their contents. Render at most one exclusion bullet.

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
- `{COMMIT_EXAMPLE_1}` is one safe example from the source or a newly written
  example that obeys the selected format.

### 1D — render and classify docs/PROJECT_CONTEXT.md

Using the resolved configuration and commit policy, render the proposed
`docs/PROJECT_CONTEXT.md` using the compact structure below.

For a new or regenerated file, aim for 80 lines; require at most 120 lines and 1,200 words
(including the managed block). Keep only facts that change how an agent works.
Omit empty sections, unknown/unused commands, placeholder comments, "none" or
"not detected" filler, directory inventories, duplicate rules, session history,
and the decisions log. Do not duplicate commands already covered by verify.
Use at most five boundary bullets and five one-line lessons; capture only
observed pitfalls that cannot be adequately enforced by tests or tooling.
Do not fabricate lessons on first setup. Link to existing detailed docs when
needed rather than copying them or creating an overflow document automatically.

```markdown
# Project Context

## Overview
{PROJECT_PURPOSE_AND_STACK_IN_TWO_SENTENCES}

## Commands
- Verify: `{CMD_VERIFY}`
- Focused test: `{CMD_TEST_FOCUSED}`
- Build: `{CMD_BUILD}`
- Setup: `{CMD_SETUP}`

## Boundaries
{UP_TO_FIVE_ACTIONABLE_PATH_SPECIFIC_CONSTRAINTS}
{VENDOR_EXCLUSION_IF_DETECTED}

## Conventions
<!-- agent-sync:project-policy:start -->
- Commit format: {COMMIT_FORMAT}
- Commit source: {COMMIT_SOURCE}
- Commit example: `{COMMIT_EXAMPLE_1}`
{WORKFLOW_TOOLS_PROJECT_CONTEXT_BLOCK}
- Think Before Coding: State consequential assumptions and tradeoffs; ask when ambiguity changes the result, and suggest a simpler approach when appropriate.
- Simplicity First: Implement only the requested behavior with the smallest clear solution; avoid speculative features, configuration, and abstractions.
- Surgical Changes: Match local style, change only what the task requires, and remove only code made unused by your changes; flag unrelated cleanup separately.
- Learning: Keep up to five one-line lessons (25 words each) as `Component: pitfall → action`; merge duplicates, replace obsolete entries, and prefer regression tests.
- Context upkeep: Aim for 80 lines, at most 120 lines and 1,200 words; keep actionable facts once, link to existing detail, and omit history, progress, and empty sections.
<!-- agent-sync:project-policy:end -->
{NON_OBVIOUS_PROJECT_STYLE_IF_ANY}

## Lessons
{UP_TO_FIVE_OBSERVED_ONE_LINE_LESSONS_OR_OMIT_SECTION}
```

The `project-policy` managed block includes commit/workflow policy, the three
coding principles, and the learning/context upkeep rules. Keep technical
facts and lessons outside it. The principles apply to every configured agent,
independent of workflow and model choice.

Before applying a new or regenerated file, count candidate lines and whitespace-delimited
words. If over budget, remove repetition and link to existing detail, preserving
all required policy. If required policy alone cannot fit, report the conflict
before writing rather than silently dropping instructions.

Without regeneration, for an existing file, replace only the managed block; never apply the new
template or size limit by deleting unmanaged content. Report an oversized
existing file and offer a separate, explicitly requested cleanup. When the user
requests that cleanup, retain unique actionable constraints and commands;
remove obsolete, redundant, or historical material. Normal reruns must continue
to preserve unmanaged bytes, even when they exceed the new budget.

When `{REGENERATE_CONTEXT}` is true, an existing well-formed managed or
unmarked file is eligible for full regeneration. Read its entire contents and
rescan the repository. Carry forward still-valid project-specific constraints
and lessons; remove duplicates, obsolete facts, and history. Do not silently
discard a unique constraint merely to fit the size budget; report any
unresolved conflict before writes. Show the proposed diff during preflight.
The explicit flag authorizes this replacement; no second confirmation is
needed. Malformed markers remain preserved with a reported defect.

For each existing file staged for regeneration, reserve a unique missing path
`.agent-sync/backups/PROJECT_CONTEXT.<unique-id>.md` during read-only preflight
and stage an exact-byte backup of the original snapshot. Never overwrite an
existing backup. A missing context needs creation, not a backup. Record
`regenerated` as the disposition for an existing whole-file replacement.
Apply the compact line/word budget to regenerated files as well as new files.

Without a regeneration disposition, classify `docs/PROJECT_CONTEXT.md` as:
`missing` (stage creation), `managed` (exactly one non-nested marker pair —
stage replacement of markers and bytes between them), `unrecognized`
(unmarked content — show proposed block, ask before inserting after a
top-level title or at byte zero; on no, preserve byte-for-byte), or
`malformed` (broken markers — preserve byte-for-byte, report the defect,
never guess).

The workflow ownership line inside the `project-policy` block, when the
resolved workflow-tool list is non-empty — one line per tool:
```
- Live execution state (task briefs, reports, progress) is owned by
  {TOOL_DISPLAY_NAME} at `{ownedPath1}`, `{ownedPath2}`, ... — don't
  hand-edit these or create files there yourself; that's the tool's
  job.
```
(repeat one such line per configured workflow tool)

When the resolved workflow-tool list is empty, omit its ownership line.

For `{VENDOR_EXCLUSION_IF_DETECTED}`, render one bullet naming the detected
vendor/build paths to avoid unless the task requires them; omit it if none
are detected. Count this bullet within the five-boundary limit.

After all candidate bytes exist, complete the classification and collect any
required approval. Do not continue until `.agent-sync/config.json` (existing
or migrated) and `docs/PROJECT_CONTEXT.md` each has an original snapshot and
a fully resolved staged disposition.

## Phase 2 — apply the fully resolved preflight plan

Immediately before the first write, confirm every target still matches its
Phase 1 snapshot and any reserved backup path is still absent. If any target changed, stop before writes and restart the
entire preflight. Otherwise apply the staged plan:

- If regenerating an existing context, create the reserved backup exclusively
  and verify it matches the original snapshot before replacing the context.
  If backup creation or verification fails, stop without replacing the context.
  Never overwrite a backup that appeared after preflight.
- Apply `{CONFIG_MIGRATION}` if one was staged.
- Perform `docs/PROJECT_CONTEXT.md`'s staged creation, managed-block update, full regeneration,
  approved insertion, or byte-for-byte preservation exactly as classified.

## Phase 3 — verify and report

For regeneration, verify the backup matches the preflight original and the
entire context matches the staged full render; report `regenerated`, the
backup path, and final line/word counts. Unmanaged-byte preservation applies
only to ordinary refreshes, not explicitly requested full regeneration.

Re-read `.agent-sync/config.json` and `docs/PROJECT_CONTEXT.md` after
application. Compare each result with the staged bytes and original snapshot.
Verify a created file matches its full render, an ordinary managed-block update
preserves all unmanaged bytes, and a preserved file (including declined
unrecognized or malformed) remains byte-for-byte unchanged. Stop and report
any mismatch.

Report the disposition (created, updated, regenerated, or preserved, with reason), the
config migration if one occurred, the detected commit-policy source, any
rejected outside-root commit template, and which project-context sections
came from real project signals and any essential gaps, plus line/word counts
and any existing-file budget warning.
</content>
