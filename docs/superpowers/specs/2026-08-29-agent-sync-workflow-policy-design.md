# agent-sync Workflow Policy and Commit Convention Design

**Date:** 2026-08-29  
**Status:** Approved in conversation; awaiting written-spec review  
**Supersedes:** The workflow-execution and commit-message portions of
`2026-08-29-agent-sync-plugin-design.md`

## Problem

The current scaffold tells agents that a configured workflow tool owns
certain paths, but it does not require the agent to execute matching tasks
through that tool's official lifecycle. An agent can therefore finish a task
manually while leaving required workflow artifacts, such as an SDD task report,
missing.

The current scaffold also imposes `[plan-name/task-N] description` on every
commit. That format ignores repository-local policy and produces unusual commit
subjects even when a project documents or consistently uses a standard such as
Conventional Commits.

Finally, the command's never-overwrite rule means improved instructions do not
reach repositories that were scaffolded by an older plugin version.

## Goals

- Require agents to use a configured workflow tool's official execution flow
  whenever a requested task belongs to that workflow.
- Keep workflow-specific behavior data-driven through the workflow registry and
  custom `.agent-sync.json` entries.
- Stop rather than silently fall back to manual execution when the required
  workflow is unavailable.
- Detect and record each repository's own commit convention, with Conventional
  Commits as the fallback.
- Remove workflow plan/task identifiers from commit messages; preserve that
  traceability in workflow state and `HANDOFF.md`.
- Add managed blocks so future plugin runs can update agent-sync-owned policy
  without overwriting user-authored content.
- Safely migrate files produced by known older agent-sync templates.

## Non-goals

- Implement or emulate any workflow tool.
- Write task briefs, reports, progress, or review state on behalf of a workflow
  tool.
- Rewrite arbitrary unmarked user content without approval.
- Infer a commit convention from remote services or internet sources.
- Change the purpose of `HANDOFF.md`: it remains the cross-agent ownership and
  session-handoff log, not the workflow's execution ledger.

## Workflow Registry Contract

Each built-in workflow entry gains `activationSignals` and
`executionInstructions` while retaining `displayName` and `ownedPaths`:

```json
{
  "superpowers": {
    "displayName": "Superpowers",
    "ownedPaths": [".superpowers/sdd/", "docs/superpowers/"],
    "activationSignals": [
      ".superpowers/sdd/*/progress.md",
      "docs/superpowers/plans/*.md"
    ],
    "executionInstructions": [
      "When a requested task belongs to an active Superpowers plan, resume it through the applicable Superpowers execution workflow.",
      "Keep task briefs, reports, progress, reviews, and completion state inside the Superpowers SDD flow.",
      "Never execute a managed task manually or create or edit Superpowers-owned artifacts directly.",
      "If the required workflow cannot be invoked, stop and report the blocker."
    ]
  }
}
```

Known string IDs resolve all four fields from the registry. A custom workflow
object may provide the same fields inline.

- `ownedPaths` identifies state the workflow exclusively controls.
- `activationSignals` contains repository-relative glob patterns that indicate
  the workflow has an active or resumable plan.
- `executionInstructions` contains ordered, imperative rules rendered into
  each configured agent's managed policy.

For backward compatibility, a custom workflow object that supplies only the
old `displayName` and `ownedPaths` shape remains valid. The scaffold renders a
generic strict rule: inspect the owned paths, use the tool's official workflow
for any matching task, never edit owned state directly, and stop if the tool is
unavailable. It also reports that tool-specific activation and resume guidance
was not configured.

Malformed fields, absolute activation paths, or activation patterns that escape
the repository cause validation to stop before any file changes.

## Workflow Enforcement

Before starting any plan-scoped task, a generated agent policy requires the
agent to:

1. Read `HANDOFF.md` and `docs/PROJECT_CONTEXT.md`.
2. Resolve every configured workflow tool.
3. Inspect its activation signals and owned state for a plan containing the
   requested task.
4. If a match exists, invoke that workflow's official execution mechanism and
   keep the task inside that lifecycle through verification and reporting.
5. Never substitute a generic/manual plan execution path and never directly
   create or edit workflow-owned artifacts.
6. If the workflow mechanism cannot be invoked, stop and report the blocker.

The scaffold command remains workflow-agnostic. It performs resolution and
rendering; all tool-specific wording lives in registry data or an inline custom
workflow object.

The presence of a configured tool alone does not force unrelated work into that
workflow. Enforcement activates when the requested task is found in matching
workflow state or the user explicitly identifies the task as belonging to that
workflow.

## Managed Blocks

Newly created per-agent files wrap agent-sync-owned policy in named markers:

```markdown
<!-- agent-sync:agent-policy:start -->
...generated shared-context, workflow, handoff, commit, and attribution rules...
<!-- agent-sync:agent-policy:end -->
```

`HANDOFF.md` uses a separate managed block around its explanatory text and entry
template. Real handoff entries remain outside the block. `docs/PROJECT_CONTEXT.md`
uses a managed block only for coordination policy and commit-convention
metadata; technical context, architecture notes, and decisions remain
user-owned.

On rerun, the scaffold handles each target as follows:

1. **Missing file:** create it with the appropriate managed block.
2. **Valid managed block:** replace only the bytes between its matching markers.
3. **Known legacy agent-sync template:** replace the recognized generated
   portion with a managed block while preserving content outside that portion.
4. **Customized or unrecognized existing file:** show the proposed managed
   block and ask before inserting it. Never delete or rewrite unmarked content.
5. **Malformed, duplicated, mismatched, or nested markers:** stop for that file
   and report the exact marker problem; do not guess.

After migration, rerunning with unchanged inputs must be byte-for-byte
idempotent. Updating the plugin may change managed content but must leave all
unmanaged content byte-for-byte unchanged.

`.claude/settings.json` remains structured JSON rather than a marked text file.
The scaffold creates it when missing and otherwise preserves it unless a future
design explicitly defines a safe JSON merge policy.

## Commit Convention Discovery

The scaffold detects commit policy from local repository evidence only. The
priority is:

1. Machine-enforced commitlint configuration, including `package.json`.
2. A dedicated repository policy such as `COMMIT_CONVENTION.md`.
3. `CONTRIBUTING.md` or `.github/CONTRIBUTING.md`.
4. A repository-local Git commit template.
5. A clear recurring subject-line pattern in recent non-merge commits.
6. Conventional Commits fallback.

If multiple explicit sources conflict, the scaffold reports the conflict and
asks the user which source governs rather than silently choosing. Git-history
inference examines up to the latest 50 non-merge subjects. It is considered
clear only when at least 70 percent of a sample of five or more commits follows
the same recognizable format. Smaller or less consistent histories fall back
to Conventional Commits.

The fallback subject format is:

```text
<type>(optional-scope): imperative description
```

Supported examples include `feat: add export command`,
`fix(registry): reject invalid workflow paths`, `docs: explain setup`,
`refactor: simplify policy rendering`, `test: cover legacy migration`,
`build: update packaging`, `ci: validate plugin metadata`, and
`chore: update maintenance notes`. Features use `feat`; hotfixes use `fix`.

The managed coordination block in `docs/PROJECT_CONTEXT.md` records:

- the detected format;
- the local source used, or `Conventional Commits fallback`;
- two representative examples.

Generated agent policies instruct agents to consult this record and, when a
source file is named, the source file before committing. Commit subjects no
longer contain plan names, task numbers, agent identity, or AI-attribution
trailers. Workflow state and `HANDOFF.md` retain task traceability.

## Scaffold Data Flow

1. Load and validate the agent registry, workflow registry, and
   `.agent-sync.json`.
2. Resolve configured agents and workflow policies, including backward-compatible
   custom workflow fallbacks.
3. Inspect local commit-policy sources and recent history; resolve conflicts
   with the user when necessary.
4. Render the agent policy, handoff template, and project coordination policy.
5. Classify every target as missing, managed, known legacy, unrecognized, or
   malformed.
6. Obtain any required insertion/migration approvals before writing.
7. Apply all allowed changes while preserving unmanaged bytes.
8. Re-read changed files and report creations, block updates, migrations,
   preserved files, unresolved conflicts, and detected commit-policy source.

Validation and user decisions happen before writes so a bad registry entry or
declined migration does not leave a partially upgraded repository.

## User-Facing Documentation and Dogfooding

The README will explain strict workflow enforcement, managed upgrades, commit
policy detection, and the Conventional Commits fallback. Examples will no
longer prescribe `[plan-name/task-N]` commit subjects.

This repository's own `.agent-sync.json`, agent context files, `HANDOFF.md`, and
`docs/PROJECT_CONTEXT.md` will be migrated to the managed-block format. Its
commit policy will be re-detected using the same rules rather than hardcoded.
The plugin version will receive a minor-version bump because the registry and
generated policy gain backward-compatible capabilities.

## Verification

Scratch-repository scenarios must prove:

- A new repository with active Superpowers state receives the strict SDD policy.
- A Superpowers-managed task cannot fall back to manual execution.
- `"workflowTools": []` renders no workflow policy.
- Custom workflow execution fields render in order.
- Old-shape custom workflows receive the generic strict fallback and a warning.
- Managed-block reruns replace only managed bytes and preserve user content
  byte-for-byte.
- Known legacy templates migrate without losing unrelated content.
- Unrecognized existing files remain unchanged without approval.
- Malformed markers cause a no-write failure for the affected file.
- Explicit local commit policy outranks git history.
- Clear git history is used when no explicit policy exists.
- Ambiguous or insufficient evidence selects Conventional Commits.
- Generated commit instructions contain no plan/task-ID format.
- An unchanged rerun is byte-for-byte idempotent.
- All plugin and configuration JSON remains valid.

Because the shipped artifact is an LLM command rather than executable code,
these remain documented scratch-directory acceptance scenarios with explicit
assertions.

## Implementation Workflow Requirement

This upgrade itself must be implemented through a new Superpowers SDD plan.
Every implementation task, including final repository verification, must have
the workflow-produced brief, report, progress, and review state expected by
that plan. If the Superpowers execution mechanism cannot produce those
artifacts, implementation stops and reports the blocker rather than proceeding
manually or hand-writing files under Superpowers-owned paths.
