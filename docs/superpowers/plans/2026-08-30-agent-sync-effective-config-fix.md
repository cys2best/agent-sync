# agent-sync Effective Configuration Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make first-run preflight use one explicit in-memory configuration object so it never attempts to read `.agent-sync.json` before the fully approved apply phase writes it.

**Architecture:** Phase 1A produces `{EFFECTIVE_CONFIG}` from exactly one source: parsed bytes from an existing `.agent-sync.json`, or the user's validated first-run selections. Phase 1B resolves agents and workflows only from `{EFFECTIVE_CONFIG}`; Phase 2 remains the sole place that writes serialized first-run configuration.

**Tech Stack:** Markdown command instructions, JSON fixtures, Python 3 assertion scripts, Git

**Spec:** `docs/superpowers/specs/2026-08-29-agent-sync-workflow-policy-design.md`

## Global Constraints

- Execute every task through Superpowers SDD. Before Task N, produce `.superpowers/sdd/2026-08-30-agent-sync-effective-config-fix/task-N-brief.md`; afterward produce `task-N-report.md`, update `progress.md`, and run the normal review gate.
- Task 2 final verification is not exempt from SDD and must produce its own brief and report.
- Superpowers owns `.superpowers/sdd/` and `docs/superpowers/`; implementation workers edit only their assigned task report under SDD state.
- `{EFFECTIVE_CONFIG}` is the parsed configuration object used throughout Phase 1. Its source is either existing `.agent-sync.json` bytes or the proposed first-run object, never both.
- First-run preflight must not create or read a nonexistent `.agent-sync.json`; Phase 2 writes the already serialized proposed bytes only after validation, conflict resolution, classifications, snapshots, and approvals succeed.
- Existing `.agent-sync.json` behavior, missing-`workflowTools` defaulting, and explicit `"workflowTools": []` behavior remain unchanged.
- The repository's tracked `.agent-sync.json` remains byte-for-byte unchanged.
- Commit subjects use Conventional Commits and contain no plan/task identifier, agent identity, or AI attribution.
- Preserve the configured `origin`; do not push during implementation or review.

---

### Task 1: Bind preflight to one effective configuration object

**Files:**
- Modify: `commands/scaffold-shared-context.md`
- Verify unchanged: `.agent-sync.json`

**Interfaces:**
- Consumes: Phase 1A's existing-file bytes or validated first-run selections.
- Produces: `{EFFECTIVE_CONFIG}`, a parsed object with `agents` and optional `workflowTools`, plus proposed serialized bytes only for a missing file.
- Phase 1B consumes `{EFFECTIVE_CONFIG}` exclusively; Phase 2 consumes the staged serialized bytes.

- [ ] **Step 1: Run the focused contract assertion and verify RED**

```bash
python3 - <<'PY'
from pathlib import Path

text = Path('commands/scaffold-shared-context.md').read_text()
phase = text[text.index('### 1A'):text.index('## Phase 2')]
required = [
    'Define `{EFFECTIVE_CONFIG}`',
    'existing `.agent-sync.json`',
    'proposed first-run configuration',
    'Use `{EFFECTIVE_CONFIG}` throughout Phase 1B',
]
missing = [item for item in required if item not in phase]
assert not missing, f'first-run effective configuration contract missing: {missing}'
PY
```

Expected before implementation: exit 1 with `first-run effective configuration contract missing` listing all four required phrases.

- [ ] **Step 2: Define `{EFFECTIVE_CONFIG}` in Phase 1A**

Add this explicit read-only Phase 1A contract:

```markdown
Define `{EFFECTIVE_CONFIG}` once and use it throughout Phase 1:
- Existing configuration: parse the existing `.agent-sync.json` bytes into
  `{EFFECTIVE_CONFIG}` and stage no configuration write.
- First-run configuration: build `{EFFECTIVE_CONFIG}` directly from the user's
  validated agent and workflow selections, then serialize that same object as
  the proposed `.agent-sync.json` bytes for Phase 2.
Never read a missing `.agent-sync.json`. Use `{EFFECTIVE_CONFIG}` throughout
Phase 1B whether its source was existing bytes or the proposed first-run
configuration.
```

Keep the current questions, custom-object shape, missing-`workflowTools` semantics, and explicit-empty semantics unchanged.

- [ ] **Step 3: Make Phase 1B consume `{EFFECTIVE_CONFIG}` exclusively**

Replace the two file-dependent instructions with:

```markdown
For every agent in `{EFFECTIVE_CONFIG}`'s `agents` array, resolve its
`displayName`, `contextFile`, and `supportsImports`...

Resolve the workflow-tool list from `{EFFECTIVE_CONFIG}`'s `workflowTools`
key. If the key is absent, treat it as `["superpowers"]`. If present
(including `[]`), use it exactly as provided.
```

Do not introduce any Phase 1 read of the staged path. Keep Phase 2's existing first-run write and snapshot checks.

- [ ] **Step 4: Run the focused contract assertion and verify GREEN**

Run the Step 1 command unchanged.

Expected: exit 0 with no output.

- [ ] **Step 5: Run first-run and existing-file behavioral checks**

Use a fresh temporary directory and a deterministic Python harness with these hand-derived fixtures:

```python
existing = {"agents": ["codex"], "workflowTools": ["superpowers"]}
first_run = {"agents": ["claude"], "workflowTools": []}
```

Prove all four cases in the report:

1. Missing path plus first-run selections resolves `agents == ["claude"]` and `workflowTools == []` without attempting a file read.
2. Existing path resolves `agents == ["codex"]` and `workflowTools == ["superpowers"]` from parsed bytes and stages no config write.
3. An effective object with no `workflowTools` key resolves to `["superpowers"]`.
4. Phase 2 writes proposed first-run bytes only after preflight is marked complete.

Expected summary: `effective configuration scenarios: 4 passed, 0 failed`.

- [ ] **Step 6: Run regression and hygiene checks**

```bash
python3 -m json.tool .agent-sync.json >/dev/null
python3 -m json.tool registry/agents.json >/dev/null
python3 -m json.tool registry/workflow-tools.json >/dev/null
git diff --check
git diff --exit-code HEAD -- .agent-sync.json
```

Expected: every command exits 0 with no output.

- [ ] **Step 7: Commit**

```bash
git add commands/scaffold-shared-context.md
git commit -m "fix(scaffold): use effective first-run configuration"
```

---

### Task 2: Final verification inside Superpowers SDD

**Files:**
- Modify: none in the tracked plugin working tree.
- Workflow output: `.superpowers/sdd/2026-08-30-agent-sync-effective-config-fix/task-2-brief.md`
- Workflow output: `.superpowers/sdd/2026-08-30-agent-sync-effective-config-fix/task-2-report.md`
- Workflow output: `.superpowers/sdd/2026-08-30-agent-sync-effective-config-fix/progress.md`

**Interfaces:**
- Consumes: Task 1's `{EFFECTIVE_CONFIG}` contract and commit.
- Produces: fresh first-run, existing-file, default-workflow, explicit-empty, regression, history, and cleanliness evidence.

- [ ] **Step 1: Confirm both tasks are inside this SDD workspace**

```bash
for n in 1 2; do
  test -f ".superpowers/sdd/2026-08-30-agent-sync-effective-config-fix/task-$n-brief.md" || exit 1
done
test -f .superpowers/sdd/2026-08-30-agent-sync-effective-config-fix/task-1-report.md
echo 'effective-config SDD context: OK'
```

Expected: `effective-config SDD context: OK`.

- [ ] **Step 2: Re-run Task 1's focused contract and four behavioral scenarios**

Repeat Task 1 Steps 1, 5, and 6 from a new temporary directory. Return the complete command, literal fixture definitions, outputs, and no-file-read evidence through `task-2-report.md`.

Expected summary: `effective configuration scenarios: 4 passed, 0 failed`.

- [ ] **Step 3: Verify the full workflow-policy repository contract**

```bash
python3 - <<'PY'
import json
import re
import subprocess
from pathlib import Path

paths = ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json',
         'registry/agents.json', 'registry/workflow-tools.json',
         '.agent-sync.json', '.claude/settings.json']
data = {path: json.loads(Path(path).read_text()) for path in paths}
assert data['.claude-plugin/plugin.json']['version'] == '0.2.0'
assert data['.agent-sync.json'] == {
    'agents': ['claude', 'codex'],
    'workflowTools': ['superpowers'],
}
workflow = data['registry/workflow-tools.json']['superpowers']
assert set(workflow) == {
    'displayName', 'ownedPaths', 'activationSignals', 'executionInstructions'
}

command = Path('commands/scaffold-shared-context.md').read_text()
phase = command[command.index('### 1A'):command.index('## Phase 2')]
for required in ['Define `{EFFECTIVE_CONFIG}`',
                 'existing `.agent-sync.json`',
                 'proposed first-run configuration',
                 'Use `{EFFECTIVE_CONFIG}` throughout Phase 1B']:
    assert required in phase, required

active_start = command.index('For an agent `contextFile`, fill the managed block below')
active_end = command.index('`{WORKFLOW_TOOLS_BLOCK}`, when the resolved workflow-tool list is', active_start)
active = command[active_start:active_end]
assert not re.search(r'\[plan-name/task-N\]\s+description', active)

subjects = subprocess.check_output(
    ['git', 'log', '--format=%s', '42ab619..HEAD'], text=True
).splitlines()
grammar = re.compile(r'(feat|fix|docs|refactor|test|build|ci|chore)(\([^)]+\))?!?: .+')
identifier = re.compile(r'(?i)\b(?:task|plan)[-_/ ]?\d+\b')
assert all(grammar.fullmatch(subject) for subject in subjects), subjects
assert not [subject for subject in subjects if identifier.search(subject)], subjects
print('full workflow-policy regression: OK')
PY
```

Expected: `full workflow-policy regression: OK`.

- [ ] **Step 4: Verify no tracked verification changes and no remote side effect**

```bash
git status --short
git diff --check
git remote -v
```

Expected: status and diff checks produce no output; `origin` remains configured exactly as before, with no push performed by this plan.

- [ ] **Step 5: Return through SDD reporting**

Write complete Steps 1-4 evidence to `task-2-report.md`. The coordinator verifies the report, updates `progress.md`, and runs the normal task and whole-branch review gates before integration.

Expected: tracked HEAD is unchanged from Task 1's commit.
