---
description: Detect this repo's tech stack, conventions, and commit policy, and (re)generate docs/PROJECT_CONTEXT.md from an existing agent-sync configuration.
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
---

## Phase 1 — preflight detection, policy, render, and classification

This entire phase is read-only: do not create or modify any file.

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

For a missing `docs/PROJECT_CONTEXT.md`, inspect this repository yourself
before writing anything — do not use placeholder text. For a managed or
approved unrecognized file, preserve every byte outside the `project-policy`
markers while replacing or inserting only that block:

- Read package.json / pyproject.toml / Cargo.toml / go.mod / Gemfile
  (whichever exists) to identify the language, framework, and package
  manager.
- Check for lockfiles to confirm the package manager (package-lock.json,
  pnpm-lock.yaml, yarn.lock, poetry.lock, Cargo.lock, etc.).
- Find the test runner and detect granular execution syntax from package.json
  scripts, pyproject.toml, Makefile, Cargo.toml, go.mod, tox.ini, or CI config (.github/workflows/*.yml):
  - Whole suite: `{CMD_TEST_ALL}` (e.g. `bun test`, `npm test`, `pytest`, `cargo test`, `go test ./...`, `python3 -m unittest`)
  - Specific test file: `{CMD_TEST_FILE}` (e.g. `bun test <file>`, `npm test -- <file>`, `pytest <file>`, `cargo test --test <file>`, `go test <file>`, `python3 -m unittest <file>`)
  - Single test: `{CMD_TEST_SINGLE}` (e.g. `bun test -- -t "<name>"`, `npm test -- -t "<name>"`, `pytest -k "<name>"`, `cargo test <name>`, `go test -run ^<name>$ ./...`, `python3 -m unittest <module>.<class>.<method>`)
- Find fast typecheck and lint/format commands:
  - Fast typecheck: `{CMD_TYPECHECK}` (e.g. `bun run typecheck`, `npx tsc --noEmit`, `mypy`, `pyright`, or "none")
  - Single file lint: `{CMD_LINT_FILE}` (e.g. `bun run lint:file -- <file>`, `npx eslint <file>`, `ruff check <file>`, or "none")
  - Project lint: `{CMD_LINT_ALL}` (e.g. `bun run lint`, `npm run lint`, `ruff check .`, or "none")
- Assemble `{CMD_PRE_PR_RITUAL}`: combine lint/typecheck and test commands (e.g. `{CMD_LINT_ALL} && {CMD_TEST_ALL}`). If a dedicated verification script exists (e.g. `lint:claude`, `check:pr`, `verify`), prefer that script.
- Check for environment setup files (`.env.example`, `.env.sample`, `docker-compose.yml`, `compose.yaml`). Define `{DETECTED_ENV_SETUP}` (e.g. `cp .env.example .env (check required secrets)` or "not detected — fill in manually").
- Skim the README for a one/two-sentence description of what the project
  does and who it's for.
- Look at the top-level directory layout and note architecture and system boundaries:
  - Routing / API boundaries (e.g. auth middleware, controller paths).
  - Data access boundaries (e.g. query layer directory vs inline queries).
  - Module system (ESM vs CommonJS).
- Note any obvious "don't touch" paths (generated dirs, vendored code,
  build output) from .gitignore.
- Detect vendor, dependency, and build directories:
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

### 1D — render and classify docs/PROJECT_CONTEXT.md

Using the resolved configuration and commit policy, render the proposed
`docs/PROJECT_CONTEXT.md` bytes with this structure, filled in with what you
actually found (leave a section explicitly marked
"not detected — fill in manually" if you can't determine it from the
repo, rather than guessing):

```markdown
# Project Context

> Single source of truth for project knowledge. Per-agent context files
> (`CLAUDE.md`, `AGENTS.md`) import or point to this file — edit it here,
> not in any of those.

## What this project is
<!-- from README / package metadata -->

## Tech stack & Environment
- Language / runtime: {DETECTED_LANGUAGE_AND_RUNTIME}
- Package manager: {DETECTED_PACKAGE_MANAGER}
- Test runner: {DETECTED_TEST_RUNNER}
- Linter / Typecheck: {DETECTED_LINTER}
- Environment setup: {DETECTED_ENV_SETUP}

## Build & verify commands
- Run whole test suite: `{CMD_TEST_ALL}`
- Run specific test file: `{CMD_TEST_FILE}`
- Run single test: `{CMD_TEST_SINGLE}`
- Typecheck (fast): `{CMD_TYPECHECK}`
- Lint single file: `{CMD_LINT_FILE}`
- Lint entire project: `{CMD_LINT_ALL}`
- Pre-PR Verification Ritual:
  ```bash
  {CMD_PRE_PR_RITUAL}
  ```

## Architecture & Boundaries
<!-- Structural layout and layer constraints. Keep rules paired with enforcement where possible. -->
- Routing & API Boundary: <!-- e.g., All API routes pass through auth middleware in src/api/middleware/auth.ts -->
- Data Access Boundary: <!-- e.g., All database queries reside in src/db/queries/; no raw SQL in controllers -->
- Module System: <!-- e.g., ESM (import/export) only, never CommonJS require() -->

## Conventions
- Branch naming: <!-- inferred from git log, or "not detected — fill in manually" -->
<!-- agent-sync:project-policy:start -->
- Commit message format: {COMMIT_FORMAT}
- Commit convention source: {COMMIT_SOURCE}
- Commit examples: `{COMMIT_EXAMPLE_1}`; `{COMMIT_EXAMPLE_2}`
{WORKFLOW_TOOLS_PROJECT_CONTEXT_BLOCK}
<!-- agent-sync:project-policy:end -->
- Code style notes:

## Things NOT to do
<!-- Strict negative guardrails to prevent common AI overreach -->
{THINGS_NOT_TO_DO_VENDOR_BLOCK}
- Leave adjacent code alone: do not reformat or "clean up" unrelated lines/files outside your task scope.
- No speculative abstractions: write the minimal concrete code required; do not add unrequested configuration layers.
- No AI attribution footers: do not add `Co-Authored-By` or AI attribution trailers to commit messages or PRs.

## Project Gotchas & Domain Quirks
<!-- Domain traps, schema quirks, and non-obvious runtime behaviors.
     RULE: Only add items that tripped up an agent/dev AND cannot be enforced via types or linters. -->
- <!-- e.g., Types vs Rows, currency locale defaults -->

## Error Recovery & Learning Protocol
When an agent encounters a bug, incorrect assumption, or user correction:
1. **Reproduce with code**: Write a failing unit/regression test in `tests/` before applying the fix.
2. **Classify the lesson**:
   - If caught by a test/compiler: Keep it in code. Do not add text to documentation.
   - If it is an architectural boundary rule: Add ONE bullet to `## Things NOT to do`.
   - If it is a subtle domain/runtime trap: Add ONE bullet to `## Project Gotchas`.
3. **Format**: Strict one-line format: `[Component/Symbol]: [Issue / What to use instead]`.

## Plan & spec structure
- Multiple plans can be active at once. See HANDOFF.md for which agent
  owns which plan/task right now.

## Architecture notes
<!-- from directory layout -->

## Decisions log
<!-- Promote real decisions here as they're made. Newest on top. -->
- YYYY-MM-DD:
```

The `project-policy` block is inside `## Conventions`. Keep branch naming,
code style, technical context, architecture, and decisions outside this managed
block.

Classify `docs/PROJECT_CONTEXT.md` the same way as any managed target:
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

When the resolved workflow-tool list is empty, omit the workflow ownership
line from the `project-policy` block. Keep the `Plan & spec structure` heading
and its `Multiple plans...` line unchanged.

For `{THINGS_NOT_TO_DO_VENDOR_BLOCK}` under `## Things NOT to do`:
- When `{DETECTED_VENDOR_DIRS}` is non-empty:
  ```markdown
  - Do not read, search, or edit vendored or build directories ({DETECTED_VENDOR_DIRS}) to conserve context and reduce cost. Only inspect specific files if diagnosing third-party bugs after checking project source code.
  ```
- When `{DETECTED_VENDOR_DIRS}` is empty:
  ```markdown
  - Leave generated build artifacts and dependency directories alone.
  ```

After all candidate bytes exist, complete the classification and collect any
required approval. Do not continue until `.agent-sync/config.json` (existing
or migrated) and `docs/PROJECT_CONTEXT.md` each has an original snapshot and
a fully resolved staged disposition.

## Phase 2 — apply the fully resolved preflight plan

Immediately before the first write, confirm every target still matches its
Phase 1 snapshot. If any target changed, stop before writes and restart the
entire preflight. Otherwise apply the staged plan:

- Apply `{CONFIG_MIGRATION}` if one was staged.
- Perform `docs/PROJECT_CONTEXT.md`'s staged creation, managed-block update,
  approved insertion, or byte-for-byte preservation exactly as classified.

## Phase 3 — verify and report

Re-read `.agent-sync/config.json` and `docs/PROJECT_CONTEXT.md` after
application. Compare each result with the staged bytes and original snapshot.
Verify a created file matches its full render, an updated managed file
preserves all unmanaged bytes, and a preserved file (including declined
unrecognized or malformed) remains byte-for-byte unchanged. Stop and report
any mismatch.

Report the disposition (created, updated, or preserved, with reason), the
config migration if one occurred, the detected commit-policy source, any
rejected outside-root commit template, and which project-context sections
came from real project signals versus remained "not detected", with a
reminder to review those gaps.
</content>
