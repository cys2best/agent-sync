# Zero-Config Project Boilerplate & Best Practices Initializer Design

## 1. Overview & Mission

`agent-sync` transitions from an agent registry and workflow intermediary into an opinionated, zero-config boilerplate and best-practices initializer for AI-assisted engineering.

When bootstrapping a new repository or establishing AI standards in an existing codebase, running `/agent-sync:setup` (or `python3 .../setup.py`) immediately inspects the repo and establishes industry-standard context files, vendor token guardrails, durable memory, and cross-agent session continuity—with zero prompts and zero configuration files.

## 2. Motivation & Problem Statement

1. **TDD is Standard LLM Capability:** Modern reasoning and coding models already know how to follow test-driven development, writing failing tests before implementation. Mandating and scaffolding `.agent-sync/TDD.md` and maintaining `.agent-sync/todo/` checklists adds clutter without value.
2. **Supported Agents Configuration is Obsolete:** All modern coding agents (Claude Code, Codex, Antigravity, Cursor, Grok, Gemini) adhere to markdown instructions. Dynamic agent headers like `# Agent Instructions (Claude Code, Codex, Antigravity)` and storing `agents` arrays in `.agent-sync/config.json` create unnecessary friction and coupling. A universal header (`# Agent Instructions`) works everywhere.
3. **Workflows Belong Directly in Tool Commands:** Workflows (such as Superpowers or custom skills) are dispatched directly through their respective commands. `agent-sync` should not act as a mediator or state tracker for them.
4. **Target as Boilerplate / Project Init:** The primary value is giving the developer an instant "best-practice project init" toolkit that sets up clean instruction boundaries, vendor read restrictions, commit attribution suppression, and cross-agent memory.

## 3. Architecture & Target Project Layout

Target repositories scaffolded by `agent-sync` maintain a clean, zero-config layout:

```text
<project-root>/
├── AGENTS.md             # Canonical project instructions, commands, and key gotchas
├── CLAUDE.md             # Minimal 2-line managed redirect to AGENTS.md
├── MEMORY.md             # Durable architecture learnings and component pitfalls
├── AGENTS.local.md       # Gitignored local private notes and personal overrides
└── .claude/
    └── settings.json     # Vendor context boundaries (permissions.ask) & commit hygiene
```

Notice:
- No `.agent-sync/config.json` is generated or required.
- No `.agent-sync/TDD.md` is generated.
- No `.agent-sync/todo/` directory is added to `.gitignore`.
- Claude Code automatically receives `CLAUDE.md` redirecting to `AGENTS.md`.

## 4. Detailed Component Changes

### 4.1. Templates (`skills/setup/templates/`)

1. **`AGENTS.md.template`**:
   - Title: `# Agent Instructions` (fixed, universal).
   - Conventions: Retain Conventional Commits and commit trailer hygiene. Remove the bullet points directing features to `.agent-sync/TDD.md` and referencing workflow plugin state.
   - Section: Rename `{AGENT_SECTION}` to `## Session Memory & Resuming`, keeping the instructions for `/agent-sync:mem-search` and `/agent-sync:resume`.
2. **`TDD.md.template`**:
   - **Delete file entirely**.
3. **`CLAUDE.md.template` & `MEMORY.md.template`**:
   - Retain existing minimal redirect and memory structure.

### 4.2. Setup Script (`skills/setup/scripts/setup.py`)

1. **Zero Prompts & Zero Config:**
   - Remove `resolve_effective_config()` and logic creating `.agent-sync/config.json`.
   - Remove `--agents` CLI argument parsing (or accept silently without effect for backwards compatibility).
   - If legacy `.agent-sync.json` or `.agent-sync/config.json` exists, remove or ignore it.
2. **Remove TDD & Todo Scaffolding:**
   - Remove creation and preservation of `.agent-sync/TDD.md`.
   - Remove `ensure_gitignored(target_dir, TODO_DIR_IGNORE)` which added `.agent-sync/todo/`.
3. **Universal Rendering:**
   - `render_agents_md()` renders directly from `AGENTS.md.template` with detected `PROJECT_OVERVIEW`, `COMMANDS_BLOCK`, and `BOUNDARIES_BLOCK`.
   - Always create/update `CLAUDE.md` redirect to `AGENTS.md`.
4. **Agent Hooks Check:**
   - Inspect home directories directly for `codex` (`~/.codex/hooks.json`) and `antigravity` (`~/.gemini/config/hooks.json`) to warn if `agent-mem` hooks are missing.

### 4.3. Registry Removal & Code Review Graph Installer

1. **Delete `registry/agents.json` and `registry/` directory.**
2. **Update `skills/install-code-review-graph/scripts/code_review_graph_installer.py`:**
   - Define agent configurations directly as internal dictionary constants:
     ```python
     BUILTIN_AGENTS = {
         "claude": {
             "displayName": "Claude Code",
             "contextFile": "AGENTS.md",
             "codeReviewGraph": {
                 "context": ".claude/CLAUDE.md",
                 "doc": ".claude/code-review-graph.md",
                 "skills": ".claude/skills",
                 "mcp": ".claude.json",
                 "mcpFormat": "json"
             }
         },
         "codex": {
             "displayName": "Codex",
             "contextFile": "AGENTS.md",
             "codeReviewGraph": {
                 "context": ".codex/AGENTS.md",
                 "doc": ".codex/code-review-graph.md",
                 "skills": ".agents/skills",
                 "mcp": ".codex/config.toml",
                 "mcpFormat": "toml"
             }
         },
         "antigravity": {
             "displayName": "Antigravity",
             "contextFile": "AGENTS.md",
             "codeReviewGraph": {
                 "context": ".gemini/AGENTS.md",
                 "doc": ".gemini/code-review-graph.md",
                 "skills": ".gemini/config/skills",
                 "mcp": ".gemini/config/mcp_config.json",
                 "mcpFormat": "json"
             }
         }
     }
     ```
   - If `registry_path` is passed and exists, read it; otherwise fallback to `BUILTIN_AGENTS`.

### 4.4. Skills Documentation Updates

1. **`skills/setup/SKILL.md`:**
   - Update instructions to reflect zero-prompt execution.
   - Remove references to `--agents`, `TDD.md`, and `.agent-sync/todo/`.
2. **`skills/resume/SKILL.md`:**
   - Update step 3 to reference git status and active plans, removing specific references to `.agent-sync/todo/` and `TDD.md`.

### 4.5. Self-Repo Cleanup & Documentation

1. Remove `.agent-sync/TDD.md` from the `agent-sync` repo itself.
2. Update this repo's `AGENTS.md` and `CLAUDE.md` to conform to the new template structure.
3. Update `README.md` and `plugin.json` to reflect the boilerplate / best-practice initializer mission.
4. Update verification command in `README.md` and `AGENTS.md` to remove `registry/*.json` glob check.

## 5. Verification Plan

1. **Unit Tests:**
   - Update `tests/test_setup.py`:
     - Test that first-run scaffolds `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `.claude/settings.json`.
     - Test that `.agent-sync/config.json` and `TDD.md` are not created.
     - Test that `.agent-sync/todo/` is not added to `.gitignore`.
     - Test that `AGENTS.md` contains universal `# Agent Instructions` header.
     - Test that vendor permissions and attribution in `.claude/settings.json` are maintained.
   - Run `python3 -m unittest discover -s tests -p "test_*.py"`.
2. **Code Review Graph Tests:**
   - Run `tests/test_code_review_graph_installer.py` to ensure all graph installer tests pass with the internalized `BUILTIN_AGENTS`.
3. **Agent-Mem Tests:**
   - Run agent-mem unit tests if bun is available.
