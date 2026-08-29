# agent-sync Workflow Policy Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-sync enforce configured workflow lifecycles, safely update
existing generated instructions through managed blocks, and use each
repository's detected commit convention instead of plan/task-prefixed commits.

**Architecture:** Workflow behavior remains data-driven in
`registry/workflow-tools.json` and custom `.agent-sync.json` objects. The
scaffold validates and renders those policies, updates only named managed
blocks, and records a locally detected commit convention in
`docs/PROJECT_CONTEXT.md`. Existing unmarked user content is preserved.

**Tech Stack:** Markdown commands/docs and JSON registries/config. Verification
uses JSON assertions, structural checks, and scratch-directory renders.

**Spec:** `docs/superpowers/specs/2026-08-29-agent-sync-workflow-policy-design.md`

## Global Constraints

- Execute every task through Superpowers SDD. Before Task N, the workflow must
  produce `.superpowers/sdd/2026-08-29-agent-sync-workflow-policy/task-N-brief.md`;
  afterward it must produce `task-N-report.md` and update `progress.md`.
- Task 6 is not exempt. If Superpowers cannot produce its artifacts, stop and
  report the blocker; never execute it manually or hand-write SDD state.
- Superpowers owns `.superpowers/sdd/` and `docs/superpowers/`; implementation
  tasks never edit workflow state directly.
- Final plugin version: `0.2.0`.
- Workflow registry fields are exactly `displayName`, `ownedPaths`,
  `activationSignals`, and `executionInstructions`.
- Old-shape custom workflows remain valid and get a generic strict fallback plus
  a warning.
- Exact managed marker names are `agent-policy`, `handoff-template`, and
  `project-policy`, each using `<!-- agent-sync:NAME:start -->` and
  `<!-- agent-sync:NAME:end -->`.
- Never rewrite unmarked user content without explicit approval. Malformed,
  duplicated, mismatched, or nested markers stop changes to the affected file.
- Detect commit conventions from local evidence in spec priority order, then
  fall back to Conventional Commits.
- Commit subjects contain no plan/task identifier, agent identity, or
  AI-attribution. Task identity remains in SDD and `HANDOFF.md`.
- Implementation commits below use Conventional Commits, as explicitly approved
  by the user. Do not add a remote or push.

---

### Task 1: Workflow registry contract and plugin version

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `registry/workflow-tools.json`

**Interfaces:**
- Produces registry values shaped as `{displayName: string, ownedPaths: string[], activationSignals: string[], executionInstructions: string[]}`.
- Produces plugin version `0.2.0`; Tasks 2, 5, and 6 consume both outputs.

- [ ] **Step 1: Run the pre-change assertion and verify RED**

```bash
python3 - <<'PY'
import json
p = json.load(open('.claude-plugin/plugin.json'))
w = json.load(open('registry/workflow-tools.json'))['superpowers']
assert p['version'] == '0.2.0', p['version']
assert set(w) == {'displayName', 'ownedPaths', 'activationSignals', 'executionInstructions'}, w
assert w['activationSignals'] == ['.superpowers/sdd/*/progress.md', 'docs/superpowers/plans/*.md']
assert len(w['executionInstructions']) == 4
PY
```

Expected before implementation: FAIL on version `0.1.0` or missing fields.

- [ ] **Step 2: Set plugin version to `0.2.0`**

Change only the `version` value in `.claude-plugin/plugin.json`; preserve all
other metadata.

- [ ] **Step 3: Replace the workflow registry entry**

Write `registry/workflow-tools.json` exactly as:

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

- [ ] **Step 4: Run the Step 1 assertion and verify GREEN**

Expected: exit 0 with no output.

- [ ] **Step 5: Verify JSON and stable identity**

```bash
python3 - <<'PY'
import json
p = json.load(open('.claude-plugin/plugin.json'))
w = json.load(open('registry/workflow-tools.json'))
assert p['name'] == 'agent-sync' and p['license'] == 'MIT'
assert set(w) == {'superpowers'}
assert w['superpowers']['ownedPaths'] == ['.superpowers/sdd/', 'docs/superpowers/']
print('registry contract and plugin version: OK')
PY
```

Expected: `registry contract and plugin version: OK`.

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/plugin.json registry/workflow-tools.json
git commit -m "feat(registry): add workflow execution policy"
```

---

### Task 2: Strict workflow execution policy

**Files:**
- Modify: `commands/scaffold-shared-context.md`

**Interfaces:**
- Consumes Task 1's four-field workflow entries.
- Produces a resolved workflow object with the same four fields and a rendered
  `{WORKFLOW_TOOLS_BLOCK}` in registry instruction order.
- Produces a generic strict fallback for old-shape custom workflows.

- [ ] **Step 1: Run structural checks and verify RED**

```bash
python3 - <<'PY'
from pathlib import Path
t = Path('commands/scaffold-shared-context.md').read_text()
required = ['activationSignals', 'executionInstructions',
            'Never execute a managed task manually',
            'stop and report the blocker', 'generic strict fallback']
missing = [s for s in required if s not in t]
assert not missing, missing
PY
```

Expected before implementation: FAIL listing missing strings.

- [ ] **Step 2: Expand registry and custom-object documentation**

Describe all four workflow fields. Replace the custom workflow example with:

```json
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
```

First-run collection asks for all four fields. The last two may be omitted only
for backward compatibility, with a warning that generic behavior will apply.

- [ ] **Step 3: Add pre-write workflow validation**

Insert this exact policy before any target rendering:

```markdown
Validate every resolved workflow before changing any file:
- `displayName` is a non-empty string.
- `ownedPaths` is a non-empty array of repository-relative paths.
- When present, `activationSignals` is an array of repository-relative glob
  strings. Reject absolute paths and any pattern containing a `..` segment.
- When present, `executionInstructions` is a non-empty array of non-empty
  strings.
On failure, report the workflow id and invalid field, then stop before writes.
```

- [ ] **Step 4: Define old-shape custom workflow fallback**

Add:

```markdown
If a custom workflow has valid `displayName` and `ownedPaths` but omits both new
fields, keep it backward compatible and label the result `generic strict
fallback`. Treat every owned path as an activation signal. Require the agent to
inspect owned state, use the tool's official lifecycle for matching tasks,
never execute a managed task manually or edit owned state, and stop and report
the blocker if the tool is unavailable. Report that tool-specific activation
and resume guidance was not configured. If only one new field is present, stop
before writes as malformed input.
```

- [ ] **Step 5: Replace workflow-block rendering**

For each resolved non-empty workflow, render:

```markdown
- Before plan-scoped work, inspect {TOOL_DISPLAY_NAME}'s activation signals
  ({ACTIVATION_SIGNALS}) and owned state ({OWNED_PATHS}). If the task belongs to
  that workflow, follow these rules in order:
  1. {EXECUTION_INSTRUCTION_1}
  2. {EXECUTION_INSTRUCTION_2}
  Do not substitute a manual or generic execution path. If the required
  workflow cannot be invoked, stop and report the blocker.
```

Continue numbering until every resolved instruction has been rendered verbatim.
Preserve instruction order and avoid repeating an equivalent final blocker
sentence. Explicit `"workflowTools": []` omits the whole block.

- [ ] **Step 6: Add the pre-task gate to the agent template**

Immediately before task claiming, add:

```markdown
- Before claiming or executing a plan task, determine whether it belongs to a
  configured workflow by checking activation signals and owned state. When it
  does, use that tool's official lifecycle for the whole task, including its
  required verification and report. Never finish the task outside that
  workflow.
```

- [ ] **Step 7: Run Step 1 checks and verify GREEN**

Expected: exit 0 with no output.

- [ ] **Step 8: Verify explicit empty workflows**

In a scratch directory, hand-render the agent policy from the updated command
for `{"agents":["claude"],"workflowTools":[]}`. Assert:

```bash
if grep -qi 'activation signal\|owned state\|official lifecycle' CLAUDE.md; then
  echo 'unexpected workflow policy'
  exit 1
fi
echo 'explicit empty workflow policy omitted: OK'
```

Expected: `explicit empty workflow policy omitted: OK`. Include the full
rendered scratch file in the SDD task report, then remove the scratch directory.

- [ ] **Step 9: Verify strict Superpowers rendering**

In a new scratch repo, create `.superpowers/sdd/example/progress.md` and
`docs/superpowers/plans/example.md`, select Superpowers, and hand-render
`AGENTS.md` exactly from the command. Run:

```bash
grep -q 'Superpowers SDD flow' AGENTS.md && \
grep -q 'Never execute a managed task manually' AGENTS.md && \
grep -q 'stop and report the blocker' AGENTS.md && \
grep -q 'Never finish the task outside that workflow' AGENTS.md && \
echo 'strict Superpowers policy rendered: OK'
```

Expected: `strict Superpowers policy rendered: OK`.

- [ ] **Step 10: Commit**

```bash
git add commands/scaffold-shared-context.md
git commit -m "feat(scaffold): enforce configured workflow execution"
```

---

### Task 3: Managed-block lifecycle and legacy migration

**Files:**
- Modify: `commands/scaffold-shared-context.md`

**Interfaces:**
- Consumes Task 2's rendered workflow policy.
- Produces marker pairs named `agent-policy`, `handoff-template`, and
  `project-policy`.
- Produces classifications `missing`, `managed`, `known-legacy`,
  `unrecognized`, and `malformed`.
- Guarantees unmanaged bytes are preserved and unchanged reruns are idempotent.

- [ ] **Step 1: Run marker checks and verify RED**

```bash
python3 - <<'PY'
from pathlib import Path
t = Path('commands/scaffold-shared-context.md').read_text()
required = ['<!-- agent-sync:agent-policy:start -->',
            '<!-- agent-sync:agent-policy:end -->',
            '<!-- agent-sync:handoff-template:start -->',
            '<!-- agent-sync:handoff-template:end -->',
            '<!-- agent-sync:project-policy:start -->',
            '<!-- agent-sync:project-policy:end -->',
            'known-legacy', 'malformed', 'byte-for-byte']
missing = [s for s in required if s not in t]
assert not missing, missing
PY
```

Expected before implementation: FAIL listing missing markers/rules.

- [ ] **Step 2: Allow precise edits**

Change frontmatter to:

```yaml
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
```

- [ ] **Step 3: Define target classification before writes**

Add:

```markdown
Classify every target and collect all approvals before changing any target:
- `missing`: path does not exist.
- `managed`: exactly one non-nested matching marker pair exists.
- `known-legacy`: no markers exist and the file exactly matches the released
  0.1.0 generated structure: expected title/import variant plus the exact thin
  context, handoff claim, workflow ownership, commit, attribution, and session
  handoff paragraphs, with no additional sections or text.
- `unrecognized`: existing unmarked content that is not exact known legacy.
- `malformed`: one marker missing, duplicate markers, end before start, or any
  nested managed marker.
```

- [ ] **Step 4: Define behavior for each classification**

Add:

```markdown
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
```

- [ ] **Step 5: Wrap the per-agent generated body**

Keep `# {AGENT_NAME} Instructions` outside the markers. Put every generated
line below it between `<!-- agent-sync:agent-policy:start -->` and
`<!-- agent-sync:agent-policy:end -->`. The start marker immediately precedes
the shared-context pointer/import block; the end marker immediately follows the
session-handoff rule. Do not create an empty user section after the block.

- [ ] **Step 6: Wrap only the HANDOFF template**

Render the title, then the exact marker pair around the explanatory comment and
template. Close the managed block before `---`; all real entries remain outside.
The template remains:

```markdown
### YYYY-MM-DD HH:MM — [{AGENT_IDS_PIPE}]
- Claiming: plan-name/task-N (if starting new work)
- Finished: plan-name/task-N, other-plan/task-M
- Next: plan-name/task-K is ready, depends on plan-name/task-N
- Blockers: none / describe
```

- [ ] **Step 7: Add project-policy markers**

Inside `## Conventions`, render:

```markdown
<!-- agent-sync:project-policy:start -->
- Commit message format: {COMMIT_FORMAT}
- Commit convention source: {COMMIT_SOURCE}
- Commit examples: `{COMMIT_EXAMPLE_1}`; `{COMMIT_EXAMPLE_2}`
{WORKFLOW_TOOLS_PROJECT_CONTEXT_BLOCK}
<!-- agent-sync:project-policy:end -->
```

Branch naming, code style, technical context, architecture, and decisions stay
outside this managed block.

- [ ] **Step 8: Run Step 1 checks and verify GREEN**

Expected: exit 0 with no output.

- [ ] **Step 9: Verify managed replacement preserves user bytes**

In a scratch `AGENTS.md`, place `prefix-bytes`, one valid agent-policy block,
and `suffix-bytes`. Follow the documented update with
`UPDATED-POLICY-SENTINEL`, then run:

```bash
python3 - <<'PY'
from pathlib import Path
t = Path('AGENTS.md').read_text()
assert t.startswith('prefix-bytes\n')
assert t.endswith('\nsuffix-bytes\n')
assert t.count('<!-- agent-sync:agent-policy:start -->') == 1
assert t.count('<!-- agent-sync:agent-policy:end -->') == 1
assert 'UPDATED-POLICY-SENTINEL' in t
print('managed replacement preserves user bytes: OK')
PY
```

Expected: `managed replacement preserves user bytes: OK`.

- [ ] **Step 10: Verify malformed markers cause no write**

Create a scratch `AGENTS.md` with two start markers and one end marker, copy it
to `before.md`, classify it, and run:

```bash
cmp before.md AGENTS.md && echo 'malformed target unchanged: OK'
```

Expected: `malformed target unchanged: OK`.

- [ ] **Step 11: Verify legacy migration and rerun idempotency**

Copy the exact 0.1.0 `AGENTS.md` from commit `dde76e9` into scratch. Apply the
documented legacy migration, save `first-run.md`, rerun with identical inputs,
then run:

```bash
cmp first-run.md AGENTS.md && \
grep -q '<!-- agent-sync:agent-policy:start -->' AGENTS.md && \
echo 'legacy migration is idempotent: OK'
```

Expected: `legacy migration is idempotent: OK`.

- [ ] **Step 12: Commit**

```bash
git add commands/scaffold-shared-context.md
git commit -m "feat(scaffold): support managed policy upgrades"
```

---

### Task 4: Repository-local commit convention discovery

**Files:**
- Modify: `commands/scaffold-shared-context.md`

**Interfaces:**
- Produces `{COMMIT_FORMAT}`, `{COMMIT_SOURCE}`, `{COMMIT_EXAMPLE_1}`, and
  `{COMMIT_EXAMPLE_2}` for Task 3's project-policy block.
- Detection priority is commitlint, dedicated policy, contributing guide, local
  Git template, recent history, then Conventional Commits.
- Produces an agent rule that keeps plan/task IDs out of commit messages.

- [ ] **Step 1: Run policy checks and verify RED**

```bash
python3 - <<'PY'
import re
from pathlib import Path
t = Path('commands/scaffold-shared-context.md').read_text()
required = ['commitlint', 'COMMIT_CONVENTION.md',
            'git config --local commit.template', 'latest 50 non-merge',
            '70 percent', 'Conventional Commits fallback',
            '{COMMIT_SOURCE}', '{COMMIT_EXAMPLE_1}']
missing = [s for s in required if s not in t]
assert not missing, missing
assert not re.search(r'\[plan-name/task-N\]\s+description', t)
PY
```

Expected before implementation: FAIL on missing rules and the old format.

- [ ] **Step 2: Add the ordered detection procedure**

Insert before target rendering:

```markdown
Detect commit policy from local evidence only:
1. Inspect commitlint files and `package.json` commitlint config.
2. Inspect `COMMIT_CONVENTION.md` and case-insensitive filename variants.
3. Inspect `CONTRIBUTING.md` and `.github/CONTRIBUTING.md`.
4. Run `git config --local commit.template`; inspect a repository-readable
   template it names.
5. Otherwise inspect the latest 50 non-merge subjects. Infer a format only from
   at least five subjects when at least 70 percent match one recognizable
   subject pattern.
6. Otherwise select Conventional Commits fallback:
   `<type>(optional-scope): imperative description`.
If explicit sources conflict, show them and ask which governs before writes.
```

The fallback types are `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`,
and `chore`. Features use `feat`; hotfixes use `fix`.

- [ ] **Step 3: Define the four rendered values**

Add:

```markdown
- `{COMMIT_FORMAT}` is the concise subject grammar.
- `{COMMIT_SOURCE}` is a repository-relative source path, `git history`, or
  `Conventional Commits fallback`.
- `{COMMIT_EXAMPLE_1}` and `{COMMIT_EXAMPLE_2}` are safe examples from the
  source, or newly written examples that obey the selected format.
```

Inspect only commit subjects; never copy commit-body secrets or attribution.

- [ ] **Step 4: Replace the generated commit rule**

Use:

```markdown
- Before committing, read the convention in `docs/PROJECT_CONTEXT.md`. If it
  names a repository policy file, read that source too. Follow its format and
  examples. Keep plan names, task numbers, agent identity, and AI-attribution
  out of the commit message; workflow state and `HANDOFF.md` retain task
  traceability.
```

- [ ] **Step 5: Clarify HANDOFF ownership**

Keep plan/task IDs in claims and completion entries. Add inside the managed
handoff template block:

```markdown
Plan/task identifiers belong here and in workflow state, not in commit subjects.
```

- [ ] **Step 6: Run Step 1 checks and verify GREEN**

Expected: exit 0 with no output.

- [ ] **Step 7: Verify explicit policy outranks history**

In a scratch repo, create `COMMIT_CONVENTION.md` containing
`Use ticket subjects: ABC-123 imperative description`, then make five commits
with Conventional Commit subjects. Apply the documented procedure and assert:

```bash
grep -q 'COMMIT_CONVENTION.md' docs/PROJECT_CONTEXT.md && \
grep -q 'ABC-123 imperative description' docs/PROJECT_CONTEXT.md && \
echo 'explicit commit policy wins: OK'
```

Expected: `explicit commit policy wins: OK`.

- [ ] **Step 8: Verify clear history detection**

In a scratch repo with no explicit source, create at least five non-merge
commits with at least 70 percent using `type(scope): description`. Apply the
procedure and run:

```bash
grep -q 'Commit convention source: git history' docs/PROJECT_CONTEXT.md && \
grep -Eq 'Commit examples: `[^`]+`; `[^`]+`' docs/PROJECT_CONTEXT.md && \
echo 'clear history detected: OK'
```

Expected: `clear history detected: OK`.

- [ ] **Step 9: Verify insufficient evidence falls back**

In an empty scratch repo with no explicit source and fewer than five commits,
apply discovery and run:

```bash
grep -q 'Commit convention source: Conventional Commits fallback' docs/PROJECT_CONTEXT.md && \
grep -q '<type>(optional-scope): imperative description' docs/PROJECT_CONTEXT.md && \
echo 'Conventional Commits fallback: OK'
```

Expected: `Conventional Commits fallback: OK`.

- [ ] **Step 10: Commit**

```bash
git add commands/scaffold-shared-context.md
git commit -m "feat(scaffold): detect local commit conventions"
```

---

### Task 5: Documentation and dogfood migration

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify: `HANDOFF.md`
- Modify: `docs/PROJECT_CONTEXT.md`
- Verify unchanged: `.agent-sync.json`

**Interfaces:**
- Consumes Tasks 1-4 registry, workflow rendering, markers, and commit values.
- Produces public version 0.2.0 documentation and this repo's managed blocks.
- Produces this repo's detected commit convention; expected fallback is
  Conventional Commits unless higher-priority evidence exists at execution.

- [ ] **Step 1: Run dogfood checks and verify RED**

```bash
python3 - <<'PY'
import re
from pathlib import Path
files = {p: Path(p).read_text() for p in
         ['CLAUDE.md', 'AGENTS.md', 'HANDOFF.md',
          'docs/PROJECT_CONTEXT.md', 'README.md']}
assert '<!-- agent-sync:agent-policy:start -->' in files['CLAUDE.md']
assert '<!-- agent-sync:agent-policy:start -->' in files['AGENTS.md']
assert '<!-- agent-sync:handoff-template:start -->' in files['HANDOFF.md']
assert '<!-- agent-sync:project-policy:start -->' in files['docs/PROJECT_CONTEXT.md']
combined = '\n'.join(files.values())
assert not re.search(r'\[plan-name/task-N\]\s+description', combined)
assert 'Conventional Commits fallback' in files['docs/PROJECT_CONTEXT.md']
assert 'including final verification' in files['README.md'].lower()
PY
```

Expected before implementation: FAIL on missing markers and old format.

- [ ] **Step 2: Update README**

Document all of these explicitly:

- strict configured-workflow activation and stop-on-unavailable behavior;
- registry activation/execution fields and old-shape fallback;
- managed-block reruns and safe legacy migration;
- local commit-policy priority and Conventional Commits fallback;
- plan/task IDs stay in HANDOFF/workflow state, not commits;
- every SDD task, including final verification, needs its workflow-generated
  brief and report.

Remove README text prescribing a bracketed plan/task prefix in commit subjects.

- [ ] **Step 3: Migrate `CLAUDE.md` and `AGENTS.md`**

Keep each top-level title outside one `agent-policy` marker pair. Put pointers
and all generated rules inside. Render Superpowers registry instructions plus:

- activation-state inspection before claiming;
- official SDD lifecycle for matching tasks;
- briefs, reports, progress, reviews, verification, and completion in SDD;
- no manual fallback or direct state edits;
- stop and report if Superpowers cannot be invoked.

Render Task 4's commit rule. Preserve import behavior and other-agent names.

- [ ] **Step 4: Migrate only the HANDOFF template**

Wrap the comment and template in one `handoff-template` pair. Preserve all real
entries byte-for-byte outside it. Add the sentence separating task identifiers
from commit subjects.

- [ ] **Step 5: Migrate only project coordination policy**

Run Task 4 detection against this repo. With the evidence present while writing
this plan, render:

```markdown
<!-- agent-sync:project-policy:start -->
- Commit message format: `<type>(optional-scope): imperative description`
- Commit convention source: Conventional Commits fallback
- Commit examples: `feat(scaffold): enforce workflow execution`; `fix(policy): preserve unmanaged content`
- Live execution state (task briefs, reports, progress, and reviews) is owned by
  Superpowers at `.superpowers/sdd/`, `docs/superpowers/`. Never edit those
  artifacts outside the applicable Superpowers workflow.
<!-- agent-sync:project-policy:end -->
```

If execution-time evidence chooses a higher-priority source, render it and
record the deviation in the SDD task report. Preserve all unmanaged context.

- [ ] **Step 6: Run Step 1 checks and verify GREEN**

Expected: exit 0 with no output.

- [ ] **Step 7: Verify marker cardinality and handoff preservation**

```bash
python3 - <<'PY'
from pathlib import Path
for path, name in [('CLAUDE.md', 'agent-policy'),
                   ('AGENTS.md', 'agent-policy'),
                   ('HANDOFF.md', 'handoff-template'),
                   ('docs/PROJECT_CONTEXT.md', 'project-policy')]:
    t = Path(path).read_text()
    assert t.count(f'<!-- agent-sync:{name}:start -->') == 1, path
    assert t.count(f'<!-- agent-sync:{name}:end -->') == 1, path
h = Path('HANDOFF.md').read_text()
assert '2026-08-29 16:50 — codex' in h
assert '2026-08-29 17:38 — codex' in h
print('managed markers and handoff preservation: OK')
PY
```

Expected: `managed markers and handoff preservation: OK`.

- [ ] **Step 8: Verify `.agent-sync.json` unchanged**

```bash
git diff --exit-code HEAD -- .agent-sync.json && \
python3 -c "import json; assert json.load(open('.agent-sync.json')) == {'agents':['claude','codex'],'workflowTools':['superpowers']}" && \
echo '.agent-sync.json unchanged: OK'
```

Expected: `.agent-sync.json unchanged: OK`.

- [ ] **Step 9: Commit**

```bash
git add README.md CLAUDE.md AGENTS.md HANDOFF.md docs/PROJECT_CONTEXT.md
git commit -m "docs: adopt managed workflow and commit policies"
```

---

### Task 6: Integrated verification inside Superpowers SDD

**Files:**
- Modify: none in the plugin working tree.
- Workflow output: `.superpowers/sdd/2026-08-29-agent-sync-workflow-policy/task-6-brief.md`
- Workflow output: `.superpowers/sdd/2026-08-29-agent-sync-workflow-policy/task-6-report.md`
- Workflow output: `.superpowers/sdd/2026-08-29-agent-sync-workflow-policy/progress.md`

**Interfaces:**
- Consumes all deliverables and SDD reports from Tasks 1-5.
- Produces fresh integrated evidence in the workflow-generated Task 6 report.
- Completion requires the coordinator to verify `task-6-report.md`; an assistant
  message or HANDOFF entry is not a substitute.

- [ ] **Step 1: Confirm Task 6 is inside SDD**

```bash
test -f .superpowers/sdd/2026-08-29-agent-sync-workflow-policy/task-6-brief.md && \
test -f .superpowers/sdd/2026-08-29-agent-sync-workflow-policy/progress.md && \
echo 'task 6 SDD context present: OK'
```

Expected: `task 6 SDD context present: OK`. If missing, stop and report the
workflow blocker; do not continue manually.

- [ ] **Step 2: Confirm Tasks 1-5 have SDD reports**

```bash
for n in 1 2 3 4 5; do
  test -f ".superpowers/sdd/2026-08-29-agent-sync-workflow-policy/task-$n-report.md" || exit 1
done
echo 'task 1-5 SDD reports present: OK'
```

Expected: `task 1-5 SDD reports present: OK`.

- [ ] **Step 3: Validate all JSON and registry contracts**

```bash
python3 - <<'PY'
import json
paths = ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json',
         'registry/agents.json', 'registry/workflow-tools.json',
         '.agent-sync.json', '.claude/settings.json']
d = {p: json.load(open(p)) for p in paths}
assert d['.claude-plugin/plugin.json']['version'] == '0.2.0'
w = d['registry/workflow-tools.json']['superpowers']
assert set(w) == {'displayName', 'ownedPaths', 'activationSignals', 'executionInstructions'}
assert len(w['executionInstructions']) == 4
print('all JSON and registry contracts: OK')
PY
```

Expected: `all JSON and registry contracts: OK`.

- [ ] **Step 4: Verify command coverage**

```bash
python3 - <<'PY'
import re
from pathlib import Path
t = Path('commands/scaffold-shared-context.md').read_text()
required = ['activationSignals', 'executionInstructions',
            'generic strict fallback',
            '<!-- agent-sync:agent-policy:start -->',
            '<!-- agent-sync:handoff-template:start -->',
            '<!-- agent-sync:project-policy:start -->',
            'known-legacy', 'malformed', 'byte-for-byte',
            'commitlint', 'latest 50 non-merge', '70 percent',
            'Conventional Commits fallback']
missing = [s for s in required if s not in t]
assert not missing, missing
assert not re.search(r'\[plan-name/task-N\]\s+description', t)
print('command policy coverage: OK')
PY
```

Expected: `command policy coverage: OK`.

- [ ] **Step 5: Re-run all eight scratch scenarios**

Freshly repeat Task 2's strict-Superpowers and empty-workflow scenarios, Task
3's managed-update, malformed-marker, and legacy-idempotency scenarios, and
Task 4's explicit-policy, history, and fallback scenarios. Return every command
and output through the SDD reporting mechanism.

Expected report summary: `8 scenarios run, 8 passed, 0 failed`.

- [ ] **Step 6: Verify public and dogfood content**

```bash
python3 - <<'PY'
import re
from pathlib import Path
paths = ['README.md', 'CLAUDE.md', 'AGENTS.md', 'HANDOFF.md',
         'docs/PROJECT_CONTEXT.md']
combined = '\n'.join(Path(p).read_text() for p in paths)
assert not re.search(r'\[plan-name/task-N\]\s+description', combined)
assert 'Conventional Commits fallback' in Path('docs/PROJECT_CONTEXT.md').read_text()
assert 'including final verification' in Path('README.md').read_text().lower()
assert 'Never execute a managed task manually' in Path('CLAUDE.md').read_text()
assert 'Never execute a managed task manually' in Path('AGENTS.md').read_text()
print('public and dogfood policies: OK')
PY
```

Expected: `public and dogfood policies: OK`.

- [ ] **Step 7: Verify implementation commit subjects**

```bash
plan_base=$(git log -1 --format='%H' --fixed-strings \
  --grep='[2026-08-29-agent-sync-workflow-policy/task-0] Add implementation plan')
test -n "$plan_base"
git log --format='%s' "$plan_base"..HEAD | python3 -c '
import re, sys
subjects = [line.rstrip("\n") for line in sys.stdin if line.strip()]
pattern = re.compile(r"(feat|fix|docs|refactor|test|build|ci|chore)(\([^)]+\))?!?: .+")
bad = [subject for subject in subjects if not pattern.fullmatch(subject)]
assert not bad, bad
expected = {
    "feat(registry): add workflow execution policy",
    "feat(scaffold): enforce configured workflow execution",
    "feat(scaffold): support managed policy upgrades",
    "feat(scaffold): detect local commit conventions",
    "docs: adopt managed workflow and commit policies",
}
assert expected <= set(subjects), expected - set(subjects)
print("implementation commit subjects: OK")
'
```

Expected: `implementation commit subjects: OK`. Conventional fix-round commits
are allowed, but every implementation commit after the plan commit must match
the same Conventional Commit grammar.

- [ ] **Step 8: Verify plugin working tree cleanliness**

```bash
git status --short
```

Expected: no output. SDD runtime state is workflow-owned and ignored.

- [ ] **Step 9: Return through SDD reporting**

Return Steps 1-8 evidence to the SDD coordinator. The coordinator must generate
`task-6-report.md`, update `progress.md`, and run its normal review gate. Do not
mark Task 6 or the plan complete from an assistant message alone.

- [ ] **Step 10: Coordinator postcondition**

After the task returns, the coordinator runs:

```bash
test -f .superpowers/sdd/2026-08-29-agent-sync-workflow-policy/task-6-report.md && \
grep -q 'Task 6' .superpowers/sdd/2026-08-29-agent-sync-workflow-policy/progress.md && \
echo 'task 6 report and progress recorded: OK'
```

Expected: `task 6 report and progress recorded: OK`. Only then may the plan be
reported complete.
