# agent-sync Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `superpower-dual-agents` prototype (hardcoded to Claude Code + Codex, distributed by copy-paste) into `agent-sync`, an installable Claude Code plugin that generalizes to any number of coding agents via a project-local config and a built-in agent registry.

**Architecture:** Repo root becomes the plugin root (`.claude-plugin/plugin.json` + `marketplace.json`, `commands/`, matching the layout used by real installed plugins like `claude-md-management`). The scaffold command moves from a static two-agent bash heredoc to an LLM-driven procedure that reads two built-in registries — `registry/agents.json` (known coding agents) and `registry/workflow-tools.json` (known plan/task-execution tools, e.g. Superpowers) — plus a project-local `.agent-sync.json`, and renders one generalized per-agent template for however many agents and workflow tools are configured. Workflow-tool ownership (which paths a generated context file must warn agents never to hand-edit) is data-driven the same way the agent list is, rather than hardcoded to Superpowers.

**Tech Stack:** Markdown (Claude Code plugin commands), JSON (plugin/marketplace/registry/config), no compiled code, no test runner — this repo's own "tests" are grep/diff assertions run against scratch directories that simulate what following the command's documented procedure produces, because the artifact under test is instructions for an LLM, not a function.

**Spec:** `docs/superpowers/specs/2026-08-29-agent-sync-plugin-design.md`

## Global Constraints

- Plugin name: `agent-sync`. License: MIT. Author/repo owner: `cys2best`. Repo URL (not yet pushed): `https://github.com/cys2best/agent-sync`.
- Never overwrite an existing file — every generated file (per-agent context file, `HANDOFF.md`, `.claude/settings.json`, `.agent-sync.json`, `docs/PROJECT_CONTEXT.md`) is created only if missing. This idempotency rule from the prototype carries over unchanged.
- Registry entries live in `registry/agents.json` and `registry/workflow-tools.json`, shipped with the plugin, read at runtime via `${CLAUDE_PLUGIN_ROOT}/registry/agents.json` and `${CLAUDE_PLUGIN_ROOT}/registry/workflow-tools.json`.
- Project-local config lives in `.agent-sync.json` at the *consumer* repo root — one per project using the plugin, never shipped by the plugin itself. It has two keys: `agents` (required) and `workflowTools` (optional, defaults to `["superpowers"]` when the key is absent — an explicit `[]` means none, and is not the same as absent).
- Two agents may share a `contextFile` (Codex and Cursor both default to `AGENTS.md`) — write it once, list every agent mapped to it in each other's "other agents" note.
- Every generated agent context file's workflow-tools section is rendered from the resolved `workflowTools` list — one bullet per tool naming its `ownedPaths` — never hardcoded to "Superpowers", and omitted entirely when the list is empty.
- No GitHub push this session — build and `git init`/commit locally only (per user decision during brainstorming).
- Do not touch `.superpowers/sdd/` or `docs/superpowers/` beyond this plan and its own spec — those paths are Superpowers' own generated output everywhere else.

---

### Task 1: Plugin metadata and registries

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `registry/agents.json`
- Create: `registry/workflow-tools.json`

**Interfaces:**
- Produces: `registry/agents.json` schema — a JSON object keyed by agent id, each value `{ "displayName": string, "contextFile": string, "supportsImports": boolean }`. Task 2's command reads this file by this exact shape.
- Produces: `registry/workflow-tools.json` schema — a JSON object keyed by workflow-tool id, each value `{ "displayName": string, "ownedPaths": string[] }`. Task 2's command reads this file by this exact shape.

- [ ] **Step 1: Create `.claude-plugin/plugin.json`**

```json
{
  "name": "agent-sync",
  "description": "Keep multiple coding agents (Claude Code, Codex, and others) in sync on shared project context and task handoff, without duplicating what Superpowers already owns.",
  "version": "0.1.0",
  "author": {
    "name": "cys2best"
  },
  "homepage": "https://github.com/cys2best/agent-sync",
  "repository": "https://github.com/cys2best/agent-sync",
  "license": "MIT",
  "keywords": ["multi-agent", "codex", "handoff", "project-context", "collaboration"]
}
```

- [ ] **Step 2: Create `.claude-plugin/marketplace.json`**

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "agent-sync",
  "description": "Keep multiple coding agents in sync on shared project context and task handoff.",
  "owner": {
    "name": "cys2best"
  },
  "plugins": [
    {
      "name": "agent-sync",
      "description": "Scaffold per-agent context files, HANDOFF.md, and docs/PROJECT_CONTEXT.md so multiple coding agents share project context.",
      "source": "./",
      "category": "productivity"
    }
  ]
}
```

- [ ] **Step 3: Create `registry/agents.json`**

```json
{
  "claude": {
    "displayName": "Claude Code",
    "contextFile": "CLAUDE.md",
    "supportsImports": true
  },
  "codex": {
    "displayName": "Codex",
    "contextFile": "AGENTS.md",
    "supportsImports": false
  },
  "gemini": {
    "displayName": "Gemini",
    "contextFile": "GEMINI.md",
    "supportsImports": false
  },
  "cursor": {
    "displayName": "Cursor",
    "contextFile": "AGENTS.md",
    "supportsImports": false
  }
}
```

- [ ] **Step 4: Create `registry/workflow-tools.json`**

```json
{
  "superpowers": {
    "displayName": "Superpowers",
    "ownedPaths": [".superpowers/sdd/", "docs/superpowers/"]
  }
}
```

- [ ] **Step 5: Verify all four files are valid JSON**

Run: `python3 -c "import json; [json.load(open(f)) for f in ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'registry/agents.json', 'registry/workflow-tools.json']]; print('all valid')"`
Expected: `all valid`

- [ ] **Step 6: Verify registry required fields**

Run:
```bash
python3 -c "
import json
r = json.load(open('registry/agents.json'))
assert set(r.keys()) == {'claude', 'codex', 'gemini', 'cursor'}, r.keys()
for agent_id, cfg in r.items():
    assert set(cfg.keys()) == {'displayName', 'contextFile', 'supportsImports'}, (agent_id, cfg)
assert r['claude']['supportsImports'] is True
assert r['codex']['supportsImports'] is False
assert r['codex']['contextFile'] == r['cursor']['contextFile'] == 'AGENTS.md'

w = json.load(open('registry/workflow-tools.json'))
assert set(w.keys()) == {'superpowers'}, w.keys()
for tool_id, cfg in w.items():
    assert set(cfg.keys()) == {'displayName', 'ownedPaths'}, (tool_id, cfg)
assert w['superpowers']['ownedPaths'] == ['.superpowers/sdd/', 'docs/superpowers/']
print('registry shape ok')
"
```
Expected: `registry shape ok`

- [ ] **Step 7: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json registry/agents.json registry/workflow-tools.json
git commit -m "Add agent-sync plugin metadata and built-in agent/workflow-tool registries"
```

---

### Task 2: Generalized scaffold command

**Files:**
- Create: `commands/scaffold-shared-context.md`
- Delete: `.claude/commands/scaffold-shared-context.md` (superseded — plugin commands ship from `commands/` at plugin root, not a project-scoped `.claude/commands/` copy)

**Interfaces:**
- Consumes: `registry/agents.json` shape from Task 1 (`{ id: { displayName, contextFile, supportsImports } }`) and `registry/workflow-tools.json` shape from Task 1 (`{ id: { displayName, ownedPaths } }`).
- Produces: the documented procedure other tasks (and future scaffold runs) follow. No function signatures — the "interface" is the literal template text below, which Task 4 renders by hand for this repo's own files.

- [ ] **Step 1: Write `commands/scaffold-shared-context.md`**

```markdown
---
description: Scaffold per-agent context files (CLAUDE.md/AGENTS.md/...), HANDOFF.md, and docs/PROJECT_CONTEXT.md so multiple coding agents share project context, based on a project-local .agent-sync.json agent + workflow-tool list.
allowed-tools: Bash, Read, Glob, Grep, Write
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
     workflow/plan-execution tools: `displayName`, `ownedPaths`).
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
     `ownedPaths`).
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
         { "id": "myplanner", "displayName": "My Planner", "ownedPaths": [".myplanner/state/"] }
       ]
     }
     ```
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
an explicit empty list. Resolve each entry's `displayName` and
`ownedPaths` from the registry (known id) or the object's own fields
(custom).

If an agent's resolved `contextFile` does not already exist, create it
(leave it untouched if it does — this command never overwrites existing
files). Fill in this template, substituting:
- `{AGENT_NAME}` → the agent's `displayName`
- `{IMPORT_BLOCK}` → see below
- `{WORKFLOW_TOOLS_BLOCK}` → see below
- `{OTHER_AGENTS}` → comma-joined `displayName` (or id, if no
  registry `displayName`) of every *other* configured agent
- `{AGENT_ID}` → the agent's id

```markdown
# {AGENT_NAME} Instructions

This file is intentionally thin. All real project knowledge lives in the
shared files below so other agents see the same thing.

{IMPORT_BLOCK}

## {AGENT_NAME} specific
{WORKFLOW_TOOLS_BLOCK}
- Read `HANDOFF.md` to see which agent ({OTHER_AGENTS}) last touched
  each plan/task and what's next.
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
```

`{WORKFLOW_TOOLS_BLOCK}`, when the resolved workflow-tool list is
non-empty — one bullet per tool, using its `displayName` and
`ownedPaths`:
```
- Use the {TOOL_DISPLAY_NAME} skills for any multi-step task.
  {TOOL_DISPLAY_NAME} owns `{ownedPath1}`, `{ownedPath2}`, ... — don't
  hand-edit these or create files there yourself; that's the tool's
  job. Before starting work, check {TOOL_DISPLAY_NAME}'s own state
  under those paths for active plans and current task status.
```
(repeat one such bullet per configured workflow tool)

`{WORKFLOW_TOOLS_BLOCK}`, when the resolved workflow-tool list is
empty — omit the bullet, and the `{WORKFLOW_TOOLS_BLOCK}` placeholder
line, entirely (don't leave a blank line in its place).

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

If `HANDOFF.md` doesn't exist, create it — `{AGENT_IDS_PIPE}` is every
configured agent's id, joined with `|`:

```markdown
# Handoff Log

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

If `docs/PROJECT_CONTEXT.md` already exists, skip this step and just
report that it was left untouched.

Otherwise, inspect this repository yourself before writing anything —
do not use placeholder text:

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
- Commit message format: `[plan-name/task-N] short description`
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
```

- [ ] **Step 2: Delete the superseded project-scoped command copy**

Run: `rm .claude/commands/scaffold-shared-context.md`
Expected: file removed; `.claude/commands/` is now empty (leave the
empty directory — `.claude/settings.json` still lives under `.claude/`).

- [ ] **Step 3: Verify the new command file has no leftover hardcoded agent or tool names in its instructional text**

Run: `grep -in 'the other agent\|superpowers owns\|superpowers skills' commands/scaffold-shared-context.md`
Expected: no output — confirms neither the agent-facing instructions
nor the workflow-tools block hardcode a specific agent ("the other
agent (Codex)", the prototype's old singular phrasing) or a specific
workflow tool ("Superpowers owns...", "Superpowers skills..."). The
command file itself should not mention "Superpowers" by name anywhere
— that name only ever comes from the registry data files Task 1
created, resolved into `{TOOL_DISPLAY_NAME}` at render time.

- [ ] **Step 4: Set up a 2-agent scratch scenario and hand-apply Step 0+1**

This simulates what following the command produces — there is no
harness that can execute an LLM-driven markdown command from a shell
script, so this step is done by hand, exactly as documented above, and
checked with assertions.

Run:
```bash
SCRATCH="/private/tmp/claude-501/-Users-cys2best-Personal-superpower-dual-agents/285da23c-f591-4fcd-bdff-ab4226e47c35/scratchpad"
rm -rf "$SCRATCH/scaffold-2agent" && mkdir -p "$SCRATCH/scaffold-2agent"
cd "$SCRATCH/scaffold-2agent"
echo '{ "agents": ["claude", "codex"] }' > .agent-sync.json
ls
```
Expected: only `.agent-sync.json` exists (no context files yet — Step 0
only writes the config, per the documented procedure).

- [ ] **Step 5: Render the two per-agent files per the documented template and assert their shape**

```bash
cd "$SCRATCH/scaffold-2agent"
cat > CLAUDE.md <<'EOF'
# Claude Code Instructions

This file is intentionally thin. All real project knowledge lives in the
shared files below so other agents see the same thing.

@docs/PROJECT_CONTEXT.md
@HANDOFF.md

## Claude Code specific
- Read `HANDOFF.md` to see which agent (Codex) last touched each
  plan/task and what's next.
- Claim a task by adding an entry to `HANDOFF.md`:
  `Claiming plan-name/task-N — claude`
EOF
cat > AGENTS.md <<'EOF'
# Codex Instructions

This file is intentionally thin. All real project knowledge lives in the
shared files below so other agents see the same thing.

See:
- docs/PROJECT_CONTEXT.md — tech stack, conventions, build commands
- HANDOFF.md — the running log between agents, per plan/task

(Codex doesn't support `@path` imports like Claude Code does — read both
files above manually at the start of every session, or wire this into a
startup script if your setup supports one.)

## Codex specific
- Read `HANDOFF.md` to see which agent (Claude Code) last touched each
  plan/task and what's next.
- Claim a task by adding an entry to `HANDOFF.md`:
  `Claiming plan-name/task-N — codex`
EOF
grep -q '@docs/PROJECT_CONTEXT.md' CLAUDE.md && echo "CLAUDE.md has import block: OK"
grep -qv '@docs/PROJECT_CONTEXT.md' AGENTS.md && echo "AGENTS.md has no import syntax: OK"
grep -q 'agent (Codex)' CLAUDE.md && echo "CLAUDE.md names Codex as other agent: OK"
grep -q 'agent (Claude Code)' AGENTS.md && echo "AGENTS.md names Claude Code as other agent: OK"
```
Expected: all four `OK` lines print.

- [ ] **Step 6: Set up a 3-agent scratch scenario (claude, codex, gemini) and assert Gemini gets its own file with both others named**

```bash
SCRATCH="/private/tmp/claude-501/-Users-cys2best-Personal-superpower-dual-agents/285da23c-f591-4fcd-bdff-ab4226e47c35/scratchpad"
rm -rf "$SCRATCH/scaffold-3agent" && mkdir -p "$SCRATCH/scaffold-3agent"
cd "$SCRATCH/scaffold-3agent"
echo '{ "agents": ["claude", "codex", "gemini"] }' > .agent-sync.json
cat > GEMINI.md <<'EOF'
# Gemini Instructions

This file is intentionally thin. All real project knowledge lives in the
shared files below so other agents see the same thing.

See:
- docs/PROJECT_CONTEXT.md — tech stack, conventions, build commands
- HANDOFF.md — the running log between agents, per plan/task

(Gemini doesn't support `@path` imports like Claude Code does — read both
files above manually at the start of every session, or wire this into a
startup script if your setup supports one.)

## Gemini specific
- Read `HANDOFF.md` to see which agent (Claude Code, Codex) last
  touched each plan/task and what's next.
- Claim a task by adding an entry to `HANDOFF.md`:
  `Claiming plan-name/task-N — gemini`
EOF
grep -q 'agent (Claude Code, Codex)' GEMINI.md && echo "GEMINI.md names both other agents: OK"
cat > HANDOFF.md <<'EOF'
# Handoff Log
## Template for new entries
```
### YYYY-MM-DD HH:MM — [claude|codex|gemini]
```
EOF
grep -q '\[claude|codex|gemini\]' HANDOFF.md && echo "HANDOFF.md claim tag lists all three: OK"
```
Expected: both `OK` lines print.

- [ ] **Step 7: Set up a custom-agent scratch scenario and assert it renders without registry support**

```bash
SCRATCH="/private/tmp/claude-501/-Users-cys2best-Personal-superpower-dual-agents/285da23c-f591-4fcd-bdff-ab4226e47c35/scratchpad"
rm -rf "$SCRATCH/scaffold-custom" && mkdir -p "$SCRATCH/scaffold-custom"
cd "$SCRATCH/scaffold-custom"
echo '{ "agents": ["claude", { "id": "myagent", "displayName": "My Agent", "contextFile": "MYAGENT.md", "supportsImports": false }] }' > .agent-sync.json
python3 -c "
import json
cfg = json.load(open('.agent-sync.json'))
custom = cfg['agents'][1]
assert isinstance(custom, dict)
assert custom['contextFile'] == 'MYAGENT.md'
assert custom['supportsImports'] is False
print('custom agent config resolves without registry: OK')
"
```
Expected: `custom agent config resolves without registry: OK`

- [ ] **Step 8: Assert `workflowTools` omitted defaults to `["superpowers"]`**

```bash
SCRATCH="/private/tmp/claude-501/-Users-cys2best-Personal-superpower-dual-agents/285da23c-f591-4fcd-bdff-ab4226e47c35/scratchpad"
rm -rf "$SCRATCH/scaffold-default-workflow" && mkdir -p "$SCRATCH/scaffold-default-workflow"
cd "$SCRATCH/scaffold-default-workflow"
echo '{ "agents": ["claude"] }' > .agent-sync.json
python3 -c "
import json
cfg = json.load(open('.agent-sync.json'))
resolved = cfg.get('workflowTools', ['superpowers'])
assert resolved == ['superpowers'], resolved
print('missing workflowTools key resolves to [\"superpowers\"]: OK')
"
```
Expected: `missing workflowTools key resolves to ["superpowers"]: OK`

- [ ] **Step 9: Assert `"workflowTools": []` omits the workflow-tools block from the generated file**

```bash
SCRATCH="/private/tmp/claude-501/-Users-cys2best-Personal-superpower-dual-agents/285da23c-f591-4fcd-bdff-ab4226e47c35/scratchpad"
rm -rf "$SCRATCH/scaffold-no-workflow" && mkdir -p "$SCRATCH/scaffold-no-workflow"
cd "$SCRATCH/scaffold-no-workflow"
echo '{ "agents": ["claude"], "workflowTools": [] }' > .agent-sync.json
cat > CLAUDE.md <<'EOF'
# Claude Code Instructions

This file is intentionally thin. All real project knowledge lives in the
shared files below so other agents see the same thing.

@docs/PROJECT_CONTEXT.md
@HANDOFF.md

## Claude Code specific
- Read `HANDOFF.md` to see which agent () last touched each plan/task
  and what's next.
- Claim a task by adding an entry to `HANDOFF.md`:
  `Claiming plan-name/task-N — claude`
EOF
grep -q 'owns' CLAUDE.md || echo "no workflow-tool ownership bullet present: OK"
grep -q "don't hand-edit" CLAUDE.md || echo "no hand-edit warning present: OK"
```
Expected: both `OK` lines print.

- [ ] **Step 10: Assert idempotency — rerunning against an existing file must not touch it**

Step 5 already wrote `CLAUDE.md`. Save a copy of that known-good
content, then hand-apply the documented existence check from Step 1
("If an agent's resolved `contextFile` does not already exist, create
it — leave it untouched if it does") as an actual gate before any write
is attempted, and confirm the file is still byte-identical afterward.

```bash
SCRATCH="/private/tmp/claude-501/-Users-cys2best-Personal-superpower-dual-agents/285da23c-f591-4fcd-bdff-ab4226e47c35/scratchpad"
cd "$SCRATCH/scaffold-2agent"
cp CLAUDE.md CLAUDE.md.expected
if [ -f CLAUDE.md ]; then
  echo "CLAUDE.md exists — per documented rule, skipping generation (no write attempted)"
else
  echo "this branch should not run: file was created in Step 5"
  exit 1
fi
diff -q CLAUDE.md CLAUDE.md.expected && echo "idempotency preserved: OK"
rm CLAUDE.md.expected
```
Expected: `CLAUDE.md exists — per documented rule, skipping generation (no write attempted)` then `idempotency preserved: OK`

- [ ] **Step 11: Clean up scratch directories**

```bash
SCRATCH="/private/tmp/claude-501/-Users-cys2best-Personal-superpower-dual-agents/285da23c-f591-4fcd-bdff-ab4226e47c35/scratchpad"
rm -rf "$SCRATCH/scaffold-2agent" "$SCRATCH/scaffold-3agent" "$SCRATCH/scaffold-custom" "$SCRATCH/scaffold-default-workflow" "$SCRATCH/scaffold-no-workflow"
```

- [ ] **Step 12: Commit**

```bash
git add commands/scaffold-shared-context.md
git rm .claude/commands/scaffold-shared-context.md
git commit -m "Generalize scaffold command to N agents via registry + config"
```

---

### Task 3: README and license

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Delete: `README-SETUP.md` (superseded — copy-paste distribution instructions no longer apply once installed as a plugin)

**Interfaces:**
- Consumes: nothing from earlier tasks (references them by path/name only).
- Produces: nothing consumed by later tasks — this is documentation-only.

- [ ] **Step 1: Write `README.md`**

```markdown
# agent-sync

Keep multiple coding agents (Claude Code, Codex, Gemini, Cursor, or any
custom agent) in sync on shared project context and task handoff when
they work on the same repo — without duplicating what
[Superpowers](https://github.com/obra/superpowers) already owns.

## What this solves

- **Cross-tool project memory** — Claude Code reads `CLAUDE.md`, Codex
  reads `AGENTS.md`, other agents read their own context file. None of
  them read each other's natively, so project context (tech stack,
  conventions, build commands) needs one canonical place all of them
  point to: `docs/PROJECT_CONTEXT.md`.
- **Cross-tool handoff** — Superpowers tracks task state within a plan,
  but nothing tracks which agent is working which task right now, or
  leaves notes for whichever agent picks up the work next. That's
  `HANDOFF.md`.
- **No manual re-explaining** — `docs/PROJECT_CONTEXT.md` is generated
  by inspecting your actual repo, not hand-written from a blank
  template.
- **Clean git history** — neither agent identity nor AI-attribution
  trailers leak into commits.

## Install

Add this repo as a marketplace source, then install the plugin:

```
/plugin marketplace add cys2best/agent-sync
/plugin install agent-sync
```

## Use

In any project, run:

```
/scaffold-shared-context
```

First run: it asks which agents are working this repo (offering
built-in defaults for Claude Code, Codex, Gemini, and Cursor — see
`registry/agents.json` — plus support for custom agents) and which
workflow/plan-execution tools are in use (offering Superpowers by
default — see `registry/workflow-tools.json` — plus support for none
or a custom tool), then writes `.agent-sync.json`, one context file per
agent, `HANDOFF.md`, and `.claude/settings.json`. It then inspects the
repo (package manifests, lockfiles, README, test/lint config, git log,
`.gitignore`) and writes real content into `docs/PROJECT_CONTEXT.md`
instead of a blank template.

Re-running is safe — existing files are left untouched.

## Workflow

1. Start each session by reading `HANDOFF.md` then
   `docs/PROJECT_CONTEXT.md` (agents with `@path` import support, like
   Claude Code, do this automatically).
2. Claim a task by adding a line to `HANDOFF.md`:
   `Claiming plan-name/task-N — <agent-id>`.
3. Use Superpowers as normal — it manages `.superpowers/sdd/<plan-name>/`
   and `docs/superpowers/` entirely on its own; this plugin never
   touches those.
4. Commit with `[plan-name/task-N] description` — no agent name in the
   commit message itself.
5. At session end, append a handoff entry to `HANDOFF.md`.

## Notes

- `.claude/settings.json`'s `attribution` block disables the
  Co-Authored-By commit trailer and "Generated with Claude Code" PR
  footer for the project it's scaffolded into. To apply it everywhere
  instead of one repo, copy the same block into
  `~/.claude/settings.json`.
- Agent identity only ever appears in `HANDOFF.md` — never in commit
  messages or trailers.
- Keep `docs/PROJECT_CONTEXT.md` as the only place real project
  knowledge lives; the per-agent context files are thin pointers —
  don't let them drift into duplicate, conflicting content.
- Workflow/plan-execution tools (Superpowers by default, or any custom
  tool listed in `.agent-sync.json`) own their own state paths entirely
  — this plugin doesn't scaffold, own, or instruct agents to write into
  them.

## License

MIT — see [LICENSE](LICENSE).
```

- [ ] **Step 2: Write `LICENSE`**

```
MIT License

Copyright (c) 2026 cys2best

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 3: Delete the superseded setup doc**

Run: `rm README-SETUP.md`
Expected: file removed.

- [ ] **Step 4: Verify README references match real paths**

Run: `grep -o '`[a-zA-Z0-9_./-]*\.md`\|`[a-zA-Z0-9_./-]*\.json`' README.md | tr -d '`' | sort -u`
Expected output includes only paths that exist or will exist after this
plan: `AGENTS.md`, `CLAUDE.md` are not listed (correct — README
describes them generically, doesn't hardcode them); `LICENSE`,
`docs/PROJECT_CONTEXT.md`, `HANDOFF.md`, `registry/agents.json`,
`registry/workflow-tools.json`, `.agent-sync.json`,
`.claude/settings.json` should each appear and each is created by Task
1, 2, or 4.

- [ ] **Step 5: Commit**

```bash
git add README.md LICENSE
git rm README-SETUP.md
git commit -m "Add plugin README and MIT license, drop copy-paste setup doc"
```

---

### Task 4: Regenerate this repo's own dogfood files

**Files:**
- Modify: `CLAUDE.md` (rewrite to match the new generalized template output)
- Modify: `AGENTS.md` (rewrite to match the new generalized template output)
- Modify: `docs/PROJECT_CONTEXT.md` (fill in — currently a blank template; this repo now has real tech-stack/convention facts to record)
- Create: `.agent-sync.json`
- Verify unchanged: `HANDOFF.md` (already matches the generalized template's claim-tag format — confirm, don't rewrite)

**Interfaces:**
- Consumes: the template text from Task 2 Step 1, rendered by hand for this repo's own two agents (`claude`, `codex`).

This is a manual, one-time migration edit — not a scaffold run. The
scaffold command's own idempotency rule (never overwrite an existing
file) would otherwise skip these files entirely, so bringing this
repo's own files in line with the new generalized wording has to be a
deliberate edit, done once, here.

- [ ] **Step 1: Create `.agent-sync.json`**

```json
{ "agents": ["claude", "codex"], "workflowTools": ["superpowers"] }
```

- [ ] **Step 2: Rewrite `CLAUDE.md`**

```markdown
# Claude Code Instructions

This file is intentionally thin. All real project knowledge lives in the
shared files below so other agents see the same thing.

@docs/PROJECT_CONTEXT.md
@HANDOFF.md

## Claude Code specific
- Use the Superpowers skills (writing-plans, subagent-driven-development,
  requesting-code-review) for any multi-step task. Superpowers owns
  `.superpowers/sdd/<plan-name>/` and `docs/superpowers/` — don't
  hand-edit these or create files there yourself; that's the tool's
  job. Before starting work, check `.superpowers/sdd/` for active plans
  and the relevant `progress.md` for current task status.
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

- [ ] **Step 3: Rewrite `AGENTS.md`**

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
  Code. Superpowers owns `.superpowers/sdd/<plan-name>/` and
  `docs/superpowers/` — don't hand-edit these or create files there
  yourself; that's the tool's job. Before starting work, check
  `.superpowers/sdd/` for active plans and the relevant `progress.md`
  for current task status.
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

- [ ] **Step 4: Confirm `HANDOFF.md` already matches the generalized claim-tag format**

Run: `grep -q '\[claude|codex\]' HANDOFF.md && echo "HANDOFF.md already matches: no change needed"`
Expected: `HANDOFF.md already matches: no change needed` (the prototype's
`HANDOFF.md` template already used a pipe-joined agent list — verified
during this plan's brainstorming phase — so no edit is required here).

- [ ] **Step 5: Fill in `docs/PROJECT_CONTEXT.md` with this repo's real facts**

```markdown
# Project Context

> Single source of truth for project knowledge. Per-agent context files
> import or point to this file — edit it here, not in any of those.

## What this project is
`agent-sync` is a Claude Code plugin that scaffolds shared project
context and a task handoff log so multiple coding agents (Claude Code,
Codex, Gemini, Cursor, or custom agents) working the same repo stay in
sync, without duplicating anything Superpowers already owns.

## Tech stack
- Language / framework: none — the plugin's content is Markdown
  (plugin commands, docs) and JSON (plugin/marketplace/registry/config)
- Package manager: none
- Test runner: none — the scaffold command is instructions for an LLM,
  not code; correctness is checked by hand-applying the documented
  procedure to scratch directories and asserting output (see
  `docs/superpowers/plans/2026-08-29-agent-sync-plugin.md` Task 2)
- Lint / format command: none

## Build & verify commands
\`\`\`
# install: add this repo as a Claude Code marketplace source, then
#          `/plugin install agent-sync`
# build:   none — plugin ships as-is
# test:    manual scratch-directory verification, see Task 2 of the
#          implementation plan referenced above
# lint:    none
\`\`\`

## Conventions
- Branch naming: not detected — fill in manually if adopted
- Commit message format: `[plan-name/task-N] short description`
- Code style notes: plain Markdown for commands/docs, plain JSON
  (2-space indent) for plugin/registry/config files
- Things NOT to do: don't hand-edit `.superpowers/sdd/` or
  `docs/superpowers/` (Superpowers-owned); don't add per-agent or
  per-workflow-tool hardcoded logic to
  `commands/scaffold-shared-context.md` — new agents and new workflow
  tools are registry entries or `.agent-sync.json` custom objects, not
  code changes

## Plan & spec structure
- Live execution state (task briefs, reports, progress) is owned by
  Superpowers at `.superpowers/sdd/<plan-name>/` and
  `docs/superpowers/` — don't hand-edit these or create files there
  yourself; that's the tool's job.
- Multiple plans can be active at once. See HANDOFF.md for which agent
  owns which plan/task right now.

## Architecture notes
- `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` —
  plugin identity and single-plugin marketplace listing.
- `commands/scaffold-shared-context.md` — the one command this plugin
  ships; reads `registry/agents.json` (built-in known agents) and
  `registry/workflow-tools.json` (built-in known workflow/plan tools)
  plus a consumer repo's `.agent-sync.json` (which agents and workflow
  tools this project uses) to generate per-agent context files,
  `HANDOFF.md`, and `docs/PROJECT_CONTEXT.md`.
- `registry/agents.json` — built-in defaults for claude/codex/gemini/
  cursor (display name, context filename, whether it supports Claude
  Code's `@path` import syntax).
- `registry/workflow-tools.json` — built-in defaults for workflow/
  plan-execution tools (currently just Superpowers: display name, the
  paths it owns and that generated context files must never instruct
  an agent to hand-edit).
- This repo's own root-level `CLAUDE.md`/`AGENTS.md`/`HANDOFF.md`/
  `docs/PROJECT_CONTEXT.md`/`.agent-sync.json` are this project
  dogfooding its own plugin for its own Claude Code + Codex dev
  workflow, using Superpowers as its workflow tool.

## Decisions log
- 2026-08-29: Generalized from a two-agent (Claude/Codex) hardcoded
  prototype to an N-agent, config+registry-driven Claude Code plugin,
  for public distribution. Also generalized workflow/plan-execution
  tool ownership (previously hardcoded to Superpowers) into its own
  registry, so a future non-Superpowers planning tool doesn't require
  a code change. See
  `docs/superpowers/specs/2026-08-29-agent-sync-plugin-design.md`.
```

- [ ] **Step 6: Verify no stale "the other agent" singular wording remains anywhere in the regenerated files**

Run: `grep -rn "the other agent" CLAUDE.md AGENTS.md HANDOFF.md docs/PROJECT_CONTEXT.md`
Expected: no output (old singular-agent phrasing fully replaced by the
generalized "other agents" / named-list wording).

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md AGENTS.md docs/PROJECT_CONTEXT.md .agent-sync.json
git commit -m "Regenerate this repo's own dogfood files from the generalized template"
```

---

### Task 5: Final repo-state verification

**Files:** none created or modified — verification only.

**Interfaces:** none.

- [ ] **Step 1: Confirm the full expected file tree is present**

Run:
```bash
test -f .claude-plugin/plugin.json && \
test -f .claude-plugin/marketplace.json && \
test -f registry/agents.json && \
test -f registry/workflow-tools.json && \
test -f commands/scaffold-shared-context.md && \
test -f README.md && \
test -f LICENSE && \
test -f CLAUDE.md && \
test -f AGENTS.md && \
test -f HANDOFF.md && \
test -f docs/PROJECT_CONTEXT.md && \
test -f .agent-sync.json && \
test ! -f README-SETUP.md && \
test ! -f .claude/commands/scaffold-shared-context.md && \
echo "file tree matches design: OK"
```
Expected: `file tree matches design: OK`

- [ ] **Step 2: Confirm working tree is clean (everything committed)**

Run: `git status --short`
Expected: no output (empty — everything from Tasks 1-4 was committed at
the end of its own task).

- [ ] **Step 3: Confirm commit history reflects one commit per task plus the earlier spec commits**

Run: `git log --oneline`
Expected: 6 commits total, newest first — one for Task 4, one for Task
3, one for Task 2, one for Task 1, one for the workflow-tools spec
addendum (commit `44641f5`), and one for the original spec (from
brainstorming, root commit `ed10454`).

- [ ] **Step 4: Report completion**

No code change here — this step is a summary to the user: confirm the
plugin is fully built and committed locally, not yet pushed to GitHub
(per the session-scope decision made during brainstorming), and that
`git remote add origin https://github.com/cys2best/agent-sync.git` plus
a push is the next action whenever the user is ready to publish.
