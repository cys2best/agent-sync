# Zero-Config Project Boilerplate & Best Practices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform agent-sync into a zero-config project boilerplate & best practices initializer by removing the TDD template, eliminating supported-agents configuration and the registry, and streamlining setup.

**Architecture:** Internalize agent definitions for code-review-graph into `code_review_graph_installer.py` and delete `registry/`. Simplify setup templates to use universal headers and remove TDD/workflow references. Refactor `skills/setup/scripts/setup.py` to be completely zero-prompt and zero-config, generating standard context files (`AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `.claude/settings.json`) without `.agent-sync/config.json` or `.agent-sync/TDD.md`. Update docs, skills, and tests.

**Tech Stack:** Python 3.10+, standard library (`unittest`, `json`, `os`, `pathlib`).

**Spec:** `docs/superpowers/specs/2026-10-09-zero-config-boilerplate-design.md`

## Global Constraints

- Preserve unmanaged bytes outside `<!-- agent-sync:...:start -->` and `<!-- agent-sync:...:end -->` blocks.
- No external Python dependencies; use only Python standard library.
- Zero prompts and zero configuration files generated in target repositories.
- Commit conventions: Conventional Commits without AI attribution trailers or plan metadata.

---

### Task 1: Internalize Agent Specs in `code_review_graph_installer.py` and Remove `registry/`

**Files:**
- Modify: `skills/install-code-review-graph/scripts/code_review_graph_installer.py`
- Delete: `registry/agents.json`
- Test: `tests/test_code_review_graph_installer.py`

**Interfaces:**
- Consumes: None
- Produces: `BUILTIN_AGENTS` constant in `code_review_graph_installer.py`, self-contained agent paths without `registry/agents.json`.

- [ ] **Step 1: Write a test asserting that `code_review_graph_installer` can load agents without `registry/agents.json` existing**

Add a test method to `tests/test_code_review_graph_installer.py`:
```python
    def test_builtin_agents_fallback_without_registry_file(self):
        from skills.install_code_review_graph.scripts.code_review_graph_installer import (
            load_agents_registry,
            BUILTIN_AGENTS,
        )
        # Calling without existing file should return BUILTIN_AGENTS
        non_existent = Path("/non/existent/path/agents.json")
        loaded = load_agents_registry(non_existent)
        self.assertEqual(loaded, BUILTIN_AGENTS)
        self.assertIn("claude", loaded)
        self.assertIn("codex", loaded)
        self.assertIn("antigravity", loaded)
```

- [ ] **Step 2: Run test to verify failure**

Run: `python3 -m unittest tests.test_code_review_graph_installer.TestCodeReviewGraphInstaller.test_builtin_agents_fallback_without_registry_file`
Expected: FAIL (ImportError or AttributeError for `BUILTIN_AGENTS` / `load_agents_registry`)

- [ ] **Step 3: Implement `BUILTIN_AGENTS` and `load_agents_registry` fallback in `code_review_graph_installer.py`**

In `skills/install-code-review-graph/scripts/code_review_graph_installer.py`:
Define `BUILTIN_AGENTS`:
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
            "mcpFormat": "json",
        },
    },
    "codex": {
        "displayName": "Codex",
        "contextFile": "AGENTS.md",
        "codeReviewGraph": {
            "context": ".codex/AGENTS.md",
            "doc": ".codex/code-review-graph.md",
            "skills": ".agents/skills",
            "mcp": ".codex/config.toml",
            "mcpFormat": "toml",
        },
    },
    "antigravity": {
        "displayName": "Antigravity",
        "contextFile": "AGENTS.md",
        "codeReviewGraph": {
            "context": ".gemini/AGENTS.md",
            "doc": ".gemini/code-review-graph.md",
            "skills": ".gemini/config/skills",
            "mcp": ".gemini/config/mcp_config.json",
            "mcpFormat": "json",
        },
    },
}

def load_agents_registry(registry_path: Path | None = None) -> dict:
    if registry_path and registry_path.is_file():
        return parse_json(registry_path.read_bytes(), registry_path)
    if REGISTRY.is_file():
        return parse_json(REGISTRY.read_bytes(), REGISTRY)
    return BUILTIN_AGENTS
```
Update all places in `code_review_graph_installer.py` that read `REGISTRY.read_bytes()` to use `load_agents_registry()`.
Delete `registry/agents.json` and remove the `registry/` directory.

- [ ] **Step 4: Run tests to verify all code review graph tests pass**

Run: `python3 -m unittest tests/test_code_review_graph_installer.py`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skills/install-code-review-graph/scripts/code_review_graph_installer.py tests/test_code_review_graph_installer.py
git rm -r registry/
git commit -m "refactor(registry): internalize agent specs in installer and remove registry"
```

---

### Task 2: Delete `TDD.md.template` and Update `AGENTS.md.template`

**Files:**
- Delete: `skills/setup/templates/TDD.md.template`
- Modify: `skills/setup/templates/AGENTS.md.template`
- Test: `tests/test_setup.py`

**Interfaces:**
- Consumes: None
- Produces: Streamlined `AGENTS.md.template` with universal `# Agent Instructions` header and no TDD/workflow state bullets.

- [ ] **Step 1: Write test asserting template content and absence of TDD template**

In `tests/test_setup.py`, add a test:
```python
    def test_templates_content_and_tdd_removed(self):
        templates_dir = os.path.join(os.path.dirname(__file__), "..", "skills", "setup", "templates")
        tdd_template = os.path.join(templates_dir, "TDD.md.template")
        self.assertFalse(os.path.exists(tdd_template), "TDD.md.template should be removed")
        agents_template_path = os.path.join(templates_dir, "AGENTS.md.template")
        with open(agents_template_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn("# Agent Instructions", content)
        self.assertNotIn("TDD.md", content)
        self.assertNotIn("Superpowers", content)
        self.assertIn("## Session Memory & Resuming", content)
```

- [ ] **Step 2: Run test to verify failure**

Run: `python3 -m unittest tests.test_setup.TestSetupScript.test_templates_content_and_tdd_removed`
Expected: FAIL

- [ ] **Step 3: Delete `TDD.md.template` and update `AGENTS.md.template`**

Remove `skills/setup/templates/TDD.md.template`.
Update `skills/setup/templates/AGENTS.md.template`:
```markdown
# Agent Instructions

<!-- agent-sync:agent-policy:start -->
This file contains shared project knowledge, conventions, and agent instructions.

See:
- MEMORY.md — project learnings, component pitfalls, and durable lessons
- AGENTS.local.md — local private notes and personal overrides (gitignored)

## Overview

{PROJECT_OVERVIEW}

## Commands

{COMMANDS_BLOCK}

## Key Constraints & Gotchas

{BOUNDARIES_BLOCK}

## Conventions

- Commits: Conventional Commits (e.g. `{COMMIT_EXAMPLE}`). Keep plan names, task numbers, and AI attribution (no "Co-Authored-By" trailers or PR footers) out; disable auto-attribution in agent config.

## Session Memory & Resuming
- Shared memory (agent-mem): a short digest of recent sessions from every agent is injected at session start. Don't re-explore work it already covers; search with `/agent-sync:mem-search` before re-reading large files or re-running long investigations.
- Resuming: if the digest warns that a session was interrupted, or the user says continue/resume work another agent started, run `/agent-sync:resume` first and continue its in-progress step instead of starting over.
<!-- agent-sync:agent-policy:end -->
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m unittest tests.test_setup.TestSetupScript.test_templates_content_and_tdd_removed`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git rm skills/setup/templates/TDD.md.template
git add skills/setup/templates/AGENTS.md.template tests/test_setup.py
git commit -m "refactor(templates): remove TDD template and simplify AGENTS.md template"
```

---

### Task 3: Refactor Setup Engine (`skills/setup/scripts/setup.py`) for Zero-Config & No TDD

**Files:**
- Modify: `skills/setup/scripts/setup.py`
- Modify: `tests/test_setup.py`

**Interfaces:**
- Consumes: Streamlined `AGENTS.md.template`
- Produces: Pure zero-config `run_setup()` that generates `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `.claude/settings.json` without creating `.agent-sync/config.json` or `.agent-sync/TDD.md`.

- [ ] **Step 1: Update `tests/test_setup.py` for zero-config assertions**

Update `tests/test_setup.py`:
- In `test_first_run_scaffolds_all_files`:
  - Assert `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `.claude/settings.json` exist.
  - Assert `.agent-sync/config.json` does NOT exist.
  - Assert `.agent-sync/TDD.md` does NOT exist.
  - Assert `.agent-sync/todo/` is NOT in `.gitignore`.
  - Assert `AGENTS.md` contains `# Agent Instructions` and does NOT contain `TDD.md`.
- Remove or update tests that assert custom TDD preservation or dynamic agent list headers.

- [ ] **Step 2: Run tests to verify failure**

Run: `python3 -m unittest tests.test_setup.TestSetupScript.test_first_run_scaffolds_all_files`
Expected: FAIL

- [ ] **Step 3: Update `skills/setup/scripts/setup.py`**

1. Remove `load_registry()` and `resolve_effective_config()`.
2. In `render_agents_md(template, project_info)`:
   Format template directly:
   ```python
   commands_rendered = "\n".join(project_info.get("commands", [])) or "- Verify: `python3 -m unittest`"
   boundaries_rendered = "\n".join(project_info.get("boundaries", [])) or "- Codebase-specific constraints and gotchas belong here; omit details evident from repository layout or linter rules."
   return template.format(
       PROJECT_OVERVIEW=project_info.get("overview", ""),
       COMMANDS_BLOCK=commands_rendered,
       BOUNDARIES_BLOCK=boundaries_rendered,
       COMMIT_EXAMPLE="feat(auth): add token refresh",
   )
   ```
3. Remove creation of `.agent-sync/config.json` and `.agent-sync/TDD.md`.
4. Remove `ensure_gitignored(target_dir, TODO_DIR_IGNORE)`.
5. Remove any legacy `.agent-sync.json` or `.agent-sync/config.json` if encountered during setup.
6. Always write `CLAUDE.md` redirect.
7. Always configure `.claude/settings.json` for vendor directories and attribution.
8. Check missing agent-mem hooks directly for `["codex", "antigravity"]`.
9. In `main()`, keep `--agents` as optional ignored arg to maintain backwards compatibility if called with `--agents`.

- [ ] **Step 4: Run full `tests/test_setup.py`**

Run: `python3 -m unittest tests/test_setup.py`
Expected: PASS (all tests pass)

- [ ] **Step 5: Commit**

```bash
git add skills/setup/scripts/setup.py tests/test_setup.py
git commit -m "feat(setup): make project init zero-config and remove TDD scaffolding"
```

---

### Task 4: Update Skill Documentation (`skills/setup/SKILL.md`, `skills/resume/SKILL.md`)

**Files:**
- Modify: `skills/setup/SKILL.md`
- Modify: `skills/resume/SKILL.md`

**Interfaces:**
- Consumes: Zero-config setup behavior
- Produces: Updated markdown documentation for `/agent-sync:setup` and `/agent-sync:resume`.

- [ ] **Step 1: Update `skills/setup/SKILL.md`**

Reflect that setup is zero-prompt:
- Remove instructions for asking the user which agents to enable.
- Remove references to `.agent-sync/config.json`, `.agent-sync/TDD.md`, and `.agent-sync/todo/`.
- Document that `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, and `.claude/settings.json` are automatically created/updated with zero configuration.

- [ ] **Step 2: Update `skills/resume/SKILL.md`**

In step 3, update the checklist advice:
Replace:
```markdown
If `.agent-sync/todo/` holds a todo list for this work (from the `.agent-sync/TDD.md` workflow), read it: unchecked items are what remains.
```
With:
```markdown
If local plan or checklist files exist for this work, check them for remaining items.
```

- [ ] **Step 3: Verify markdown formatting**

Ensure all links and headers are properly formatted and valid markdown.

- [ ] **Step 4: Commit**

```bash
git add skills/setup/SKILL.md skills/resume/SKILL.md
git commit -m "docs(skills): update setup and resume skill documentation for zero-config"
```

---

### Task 5: Self-Repo Cleanup, Documentation & Manifest Updates

**Files:**
- Delete: `.agent-sync/TDD.md`
- Modify: `.gitignore`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `plugin.json`
- Test: Full test suite

**Interfaces:**
- Consumes: All updated tools and templates
- Produces: Cleaned repo adhering to the new zero-config boilerplate standards.

- [ ] **Step 1: Remove `.agent-sync/TDD.md` and clean `.gitignore`**

Delete `.agent-sync/TDD.md`.
In `.gitignore`, remove line `.agent-sync/todo/`.

- [ ] **Step 2: Update repo's `AGENTS.md` and `CLAUDE.md`**

Update `AGENTS.md` to conform to the new template:
- Header: `# Agent Instructions`
- Section: `## Session Memory & Resuming`
- Conventions: remove `.agent-sync/TDD.md` and Superpowers task state lines.
- Remove registry validation from verification command:
  `- Verify: python3 -m unittest discover -s tests -p "test_*.py"`

- [ ] **Step 3: Update `README.md` and `plugin.json`**

- Update `plugin.json` description: "Zero-config boilerplate and best practices for initializing projects for AI coding agents (Claude Code, Codex, Antigravity, and others)."
- Update `README.md`:
  - Position agent-sync as zero-config boilerplate & best practice project initializer.
  - Remove registry validation and TDD descriptions.
  - Highlight instant setup with standard files, vendor token limits, durable memory, and cross-agent resume.

- [ ] **Step 4: Run full test suite**

Run: `python3 -m unittest discover -s tests -p "test_*.py"`
Expected: Ran N tests ... OK (All passing)

- [ ] **Step 5: Commit**

```bash
git rm .agent-sync/TDD.md
git add .gitignore AGENTS.md CLAUDE.md README.md plugin.json
git commit -m "chore: align repository with zero-config boilerplate best practices"
```
