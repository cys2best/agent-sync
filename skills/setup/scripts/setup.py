#!/usr/bin/env python3
"""
setup.py - deterministic agent-sync project context & workflow scaffolding.
Usage:
    python3 setup.py [--target-dir PATH] [--regenerate-context] [--agents A,B,C] [--workflow-tools X,Y]
"""

import argparse
import datetime
import glob
import json
import os
import re
import shutil
import sys

START_POLICY_MARKER = "<!-- agent-sync:agent-policy:start -->"
END_POLICY_MARKER = "<!-- agent-sync:agent-policy:end -->"
START_HANDOFF_MARKER = "<!-- agent-sync:handoff-template:start -->"
END_HANDOFF_MARKER = "<!-- agent-sync:handoff-template:end -->"
START_MEMORY_MARKER = "<!-- agent-sync:memory:start -->"
END_MEMORY_MARKER = "<!-- agent-sync:memory:end -->"

VENDOR_DIR_CANDIDATES = [
    "node_modules", "vendor", ".venv", "venv", "target", "dist", "build", ".next", "__pycache__"
]

def find_plugin_root():
    if "CLAUDE_PLUGIN_ROOT" in os.environ and os.path.isdir(os.environ["CLAUDE_PLUGIN_ROOT"]):
        return os.path.abspath(os.environ["CLAUDE_PLUGIN_ROOT"])
    script_dir = os.path.dirname(os.path.abspath(__file__))
    # Check parent dirs: from skills/setup/scripts, root is 3 levels up
    for levels in [3, 2, 1]:
        candidate = os.path.abspath(os.path.join(script_dir, *[".."] * levels))
        if os.path.exists(os.path.join(candidate, "registry", "agents.json")):
            return candidate
    return os.getcwd()

def find_templates_dir(plugin_root, custom_dir=None):
    if custom_dir and os.path.isdir(custom_dir):
        return os.path.abspath(custom_dir)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    skill_dir = os.path.abspath(os.path.join(script_dir, ".."))
    candidates = [
        os.path.join(skill_dir, "templates"),
        os.path.join(skill_dir, "template"),
        os.path.join(plugin_root, "skills", "setup", "templates"),
        os.path.join(plugin_root, "skills", "setup", "template"),
        os.path.join(plugin_root, "templates"),
        os.path.join(os.getcwd(), "skills", "setup", "templates"),
        os.path.join(os.getcwd(), "skills", "setup", "template"),
    ]
    for c in candidates:
        if os.path.isdir(c):
            return os.path.abspath(c)
    return os.path.join(skill_dir, "templates")

def load_registry(plugin_root, registry_name):
    path = os.path.join(plugin_root, "registry", f"{registry_name}.json")
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def read_template(templates_dir, name):
    path = os.path.join(templates_dir, name)
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    raise FileNotFoundError(f"Template {name} not found in {templates_dir}")

def replace_managed_block(content, start_marker, end_marker, replacement_content):
    start_idx = content.find(start_marker)
    end_idx = content.find(end_marker)
    if start_idx != -1 and end_idx != -1 and start_idx < end_idx:
        end_idx += len(end_marker)
        return content[:start_idx] + replacement_content + content[end_idx:]
    return None

def detect_vendor_dirs(target_dir):
    detected = []
    for d in VENDOR_DIR_CANDIDATES:
        p = os.path.join(target_dir, d)
        if os.path.isdir(p):
            detected.append(d)
    return detected

def extract_section_content(markdown_text, heading_title):
    pattern = rf"^##\s+{re.escape(heading_title)}\s*\n(.*?)(?=^##\s+|\Z)"
    match = re.search(pattern, markdown_text, re.MULTILINE | re.DOTALL)
    if match:
        return match.group(1).strip()
    return None

def inspect_project(target_dir):
    info = {
        "overview": "",
        "commands": [],
        "boundaries": [],
        "vendor_dirs": detect_vendor_dirs(target_dir),
    }

    # Python inspection
    is_python = any(os.path.exists(os.path.join(target_dir, f)) for f in ["pyproject.toml", "setup.py", "requirements.txt"])
    has_python_tests = os.path.isdir(os.path.join(target_dir, "tests")) or bool(glob.glob(os.path.join(target_dir, "test_*.py")))

    # Node inspection
    pkg_json_path = os.path.join(target_dir, "package.json")
    is_node = os.path.isfile(pkg_json_path)
    pkg_data = {}
    if is_node:
        try:
            with open(pkg_json_path, "r", encoding="utf-8") as f:
                pkg_data = json.load(f)
        except Exception:
            pass

    # Rust inspection
    is_rust = os.path.isfile(os.path.join(target_dir, "Cargo.toml"))

    # Go inspection
    is_go = os.path.isfile(os.path.join(target_dir, "go.mod"))

    # Determine commands
    if is_python and has_python_tests:
        # Check if registries or json validation exist
        has_registry = os.path.isdir(os.path.join(target_dir, "registry"))
        if has_registry:
            info["commands"].append(
                '- Verify: `python3 -m unittest discover -s tests -p "test_*.py" && python3 -c "import json, glob; [json.load(open(f)) for f in glob.glob(\'registry/*.json\')]"`'
            )
        else:
            info["commands"].append('- Verify: `python3 -m unittest discover -s tests -p "test_*.py"`')
        
        # Look for a sample test
        test_files = glob.glob(os.path.join(target_dir, "tests", "test_*.py"))
        if test_files:
            sample_rel = os.path.relpath(test_files[0], target_dir)
            sample_mod = sample_rel.replace(os.sep, ".").removesuffix(".py")
            info["commands"].append(f"- Focused test: `python3 -m unittest {sample_mod}`")
    elif is_node:
        scripts = pkg_data.get("scripts", {})
        pm = "npm"
        if os.path.isfile(os.path.join(target_dir, "pnpm-lock.yaml")):
            pm = "pnpm"
        elif os.path.isfile(os.path.join(target_dir, "yarn.lock")):
            pm = "yarn"
        elif os.path.isfile(os.path.join(target_dir, "bun.lockb")):
            pm = "bun"

        if "test" in scripts:
            info["commands"].append(f"- Verify: `{pm} test`")
        if "build" in scripts:
            info["commands"].append(f"- Build: `{pm} run build`")
    elif is_rust:
        info["commands"].append("- Verify: `cargo test`")
        info["commands"].append("- Build: `cargo build`")
    elif is_go:
        info["commands"].append("- Verify: `go test ./...`")
        info["commands"].append("- Build: `go build`")

    # Overview
    readme_path = os.path.join(target_dir, "README.md")
    if is_node and pkg_data.get("description"):
        info["overview"] = f"{pkg_data.get('name', 'This project')}: {pkg_data['description']}"
    elif os.path.isfile(readme_path):
        try:
            with open(readme_path, "r", encoding="utf-8") as f:
                lines = [l.strip() for l in f if l.strip() and not l.startswith("#")]
                if lines:
                    info["overview"] = lines[0]
        except Exception:
            pass

    if not info["overview"]:
        info["overview"] = "This repository maintains project workflows, tests, and shared agent instructions."

    # Boundaries
    if os.path.isdir(os.path.join(target_dir, "skills")):
        info["boundaries"].append("- `skills/*`: preflight is read-only; apply only staged writes, then reread and verify preservation of unmanaged bytes.")
    if os.path.isdir(os.path.join(target_dir, "registry")):
        info["boundaries"].append("- `registry/*.json`: declarative agent/workflow definitions; skills consume registry or custom config instead of hardcoded agent/tool branches.")
    if os.path.isdir(os.path.join(target_dir, ".agent-sync", "scripts")):
        info["boundaries"].append("- `.agent-sync/scripts/`: deterministic standalone Python helpers without external dependencies.")
    info["boundaries"].append("- `CLAUDE.md`: minimal pointer to `AGENTS.md`; shared project knowledge and agent instructions belong here.")
    info["boundaries"].append("- `HANDOFF.md`: task-ID ledger only; execution details remain in the workflow's own reports.")
    info["boundaries"].append("- `MEMORY.md`: durable project lessons and component pitfalls.")
    info["boundaries"].append("- `COMMIT_CONVENTION.md`: Conventional Commits format and rules.")

    return info

def resolve_effective_config(target_dir, cli_agents=None, cli_workflows=None):
    config_dir = os.path.join(target_dir, ".agent-sync")
    config_path = os.path.join(config_dir, "config.json")
    legacy_path = os.path.join(target_dir, ".agent-sync.json")

    migrated = False
    if os.path.isfile(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
    elif os.path.isfile(legacy_path):
        with open(legacy_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        migrated = True
    else:
        # Default configuration
        agents = ["claude", "codex", "antigravity"]
        if cli_agents:
            agents = [a.strip() for a in cli_agents.split(",") if a.strip()]

        workflows = ["superpowers"]
        if cli_workflows is not None:
            workflows = [w.strip() for w in cli_workflows.split(",") if w.strip()]

        config = {
            "agents": agents,
            "workflowTools": workflows
        }

    if cli_agents and not migrated and os.path.isfile(config_path):
        config["agents"] = [a.strip() for a in cli_agents.split(",") if a.strip()]
    if cli_workflows is not None and not migrated and os.path.isfile(config_path):
        config["workflowTools"] = [w.strip() for w in cli_workflows.split(",") if w.strip()]

    return config, migrated

def render_agents_md(template, effective_config, agents_registry, workflow_registry, project_info):
    configured_agents = effective_config.get("agents", [])
    resolved_agents = []
    for item in configured_agents:
        if isinstance(item, str):
            meta = agents_registry.get(item, {
                "displayName": item.title(),
                "contextFile": "AGENTS.md",
                "supportsImports": False
            })
            resolved_agents.append((item, meta))
        elif isinstance(item, dict):
            agent_id = item.get("id", "custom")
            resolved_agents.append((agent_id, item))

    # Agents mapped to AGENTS.md
    target_agents = [a for a in resolved_agents if a[1].get("contextFile", "AGENTS.md") == "AGENTS.md"]
    other_agents = [a for a in resolved_agents if a[1].get("contextFile", "AGENTS.md") != "AGENTS.md"]

    target_display_names = [a[1].get("displayName", a[0]) for a in target_agents]
    target_ids = [a[0] for a in target_agents]

    if len(target_agents) == 1:
        agent_name = target_display_names[0]
        agent_id = target_ids[0]
        agent_title = f"# {agent_name} Instructions"
        agent_section = f"## {agent_name} specific"
        claim_rule = (
            f"- When claiming or progressing a plan task, update that plan's entry in\n"
            f"  `HANDOFF.md` in-place (or add an entry if starting a new plan): record\n"
            f"  `{agent_id}`, current task, finished tasks, next task, and blockers."
        )
        attribution_rule = (
            "- Do not add a \"Co-Authored-By\" trailer or AI-attribution footer to\n"
            "  commits or PRs. If this agent's setup has an equivalent\n"
            "  auto-attribution behavior, disable it the same way\n"
            "  `.claude/settings.json` does for Claude Code."
        )
    else:
        joined_names = ", ".join(target_display_names)
        agent_title = f"# Agent Instructions ({joined_names})"
        agent_section = f"## {joined_names} specific"
        slash_ids = "/".join(target_ids)
        claim_rule = (
            f"- When claiming or progressing a plan task, update that plan's entry in\n"
            f"  `HANDOFF.md` in-place (or add an entry if starting a new plan): record your\n"
            f"  active agent identifier (use {slash_ids} depending on which agent you\n"
            f"  are running as), current task, finished tasks, next task, and blockers."
        )
        attribution_rule = (
            "- Do not add a \"Co-Authored-By\" trailer or AI-attribution footer to\n"
            "  commits or PRs. Disable auto-attribution in your respective agent config."
        )

    if other_agents:
        other_names = ", ".join(a[1].get("displayName", a[0]) for a in other_agents)
        read_handoff_rule = f"- Read `HANDOFF.md` to see which agent ({other_names}) last touched each plan/task and what's next."
    else:
        read_handoff_rule = "- Read `HANDOFF.md` to see which agent last touched each plan/task and what's next."

    # Workflows
    workflow_tools = effective_config.get("workflowTools", ["superpowers"])
    workflow_ownership_lines = []
    workflow_blocks = []

    for wf in workflow_tools:
        wf_id = wf if isinstance(wf, str) else wf.get("id")
        wf_meta = workflow_registry.get(wf_id, wf if isinstance(wf, dict) else {})
        display_name = wf_meta.get("displayName", wf_id.title())
        owned_paths = wf_meta.get("ownedPaths", [])
        owned_paths_list_str = ", ".join(f"`{p}`" for p in owned_paths)
        if len(owned_paths) == 2:
            owned_paths_and_str = f"`{owned_paths[0]}` and `{owned_paths[1]}`"
        else:
            owned_paths_and_str = owned_paths_list_str
        signals = wf_meta.get("activationSignals", [])
        signals_str = ", ".join(f"`{s}`" for s in signals)
        instructions = wf_meta.get("executionInstructions", [])

        if owned_paths:
            workflow_ownership_lines.append(
                f"- Live execution state belongs to {display_name} at {owned_paths_and_str}; use its lifecycle and never hand-edit those paths."
            )

        instr_lines = "\n".join(f"  {idx+1}. {instr}" for idx, instr in enumerate(instructions))
        block = (
            f"- Only engage {display_name} when the user's prompt explicitly names it\n"
            f"  or its plan/task artifacts (e.g. mentions {display_name} by name, or\n"
            f"  references a path under {owned_paths_list_str}). Do not infer that a task belongs to\n"
            f"  this workflow from task shape, complexity, or ambient activation signals\n"
            f"  ({signals_str}) alone — plain requests get a direct, ordinary\n"
            f"  execution path. When the prompt does invoke {display_name}, follow\n"
            f"  these rules in order:\n"
            f"{instr_lines}\n"
            f"  Do not substitute a manual or generic execution path once engaged."
        )
        workflow_blocks.append(block)

    workflow_ownership_line_rendered = "\n".join(workflow_ownership_lines)

    workflow_tools_block_rendered = "\n".join(workflow_blocks)

    # Commands & Boundaries
    commands_rendered = "\n".join(project_info.get("commands", []))
    if not commands_rendered:
        commands_rendered = "- Verify: `python3 -m unittest`"

    boundaries_rendered = "\n".join(project_info.get("boundaries", []))
    vendor_dirs = project_info.get("vendor_dirs", [])
    if vendor_dirs:
        vendor_list = ", ".join(f"`{d}/`" for d in vendor_dirs)
        boundaries_rendered += f"\n- Vendor exclusions: Ignore dependencies and build artifacts under {vendor_list}."

    rendered = template.format(
        AGENT_TITLE=agent_title,
        PROJECT_OVERVIEW=project_info.get("overview", ""),
        COMMANDS_BLOCK=commands_rendered,
        BOUNDARIES_BLOCK=boundaries_rendered,
        COMMIT_EXAMPLE="feat(config): add workflow model policies",
        WORKFLOW_TOOLS_OWNERSHIP_LINE=workflow_ownership_line_rendered,
        AGENT_SECTION=agent_section,
        WORKFLOW_TOOLS_BLOCK=workflow_tools_block_rendered,
        READ_HANDOFF_RULE=read_handoff_rule,
        CLAIM_RULE=claim_rule,
        ATTRIBUTION_RULE=attribution_rule,
    )
    return rendered

def update_claude_settings(target_dir, vendor_dirs):
    claude_dir = os.path.join(target_dir, ".claude")
    os.makedirs(claude_dir, exist_ok=True)
    settings_path = os.path.join(claude_dir, "settings.json")

    settings = {}
    if os.path.isfile(settings_path):
        try:
            with open(settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)
        except Exception:
            settings = {}

    if "attribution" not in settings:
        settings["attribution"] = {"commit": "", "pr": "", "sessionUrl": False}
    else:
        settings["attribution"]["commit"] = ""
        settings["attribution"]["pr"] = ""
        settings["attribution"]["sessionUrl"] = False

    archive_hook = {
        "type": "command",
        "command": "python3 .agent-sync/scripts/archive.py"
    }

    hooks = settings.setdefault("hooks", {})
    session_end_list = hooks.setdefault("SessionEnd", [])
    has_archive = False
    for item in session_end_list:
        subhooks = item.get("hooks", [])
        for h in subhooks:
            if h.get("command") == "python3 .agent-sync/scripts/archive.py":
                has_archive = True
                break

    if not has_archive:
        session_end_list.append({"hooks": [archive_hook]})

    if vendor_dirs:
        permissions = settings.setdefault("permissions", {})
        ask_list = permissions.setdefault("ask", [])
        for v in vendor_dirs:
            pat = f"Read(./{v}/**)"
            if pat not in ask_list:
                ask_list.append(pat)

    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")

def run_setup(args):
    target_dir = os.path.abspath(args.target_dir)
    plugin_root = args.plugin_root or find_plugin_root()
    templates_dir = find_templates_dir(plugin_root, args.templates_dir)

    print(f"Target directory: {target_dir}")
    print(f"Plugin root: {plugin_root}")
    print(f"Templates directory: {templates_dir}")

    agents_registry = load_registry(plugin_root, "agents")
    workflow_registry = load_registry(plugin_root, "workflow-tools")

    effective_config, migrated = resolve_effective_config(
        target_dir, args.agents, args.workflow_tools
    )

    config_dir = os.path.join(target_dir, ".agent-sync")
    os.makedirs(config_dir, exist_ok=True)
    config_path = os.path.join(config_dir, "config.json")
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(effective_config, f, indent=2)
        f.write("\n")

    if migrated:
        legacy_path = os.path.join(target_dir, ".agent-sync.json")
        if os.path.isfile(legacy_path):
            os.remove(legacy_path)
            print("Migrated .agent-sync.json to .agent-sync/config.json")

    project_info = inspect_project(target_dir)
    agents_path = os.path.join(target_dir, "AGENTS.md")

    # If AGENTS.md exists and not regenerate-context, reuse existing overview/commands/boundaries
    if os.path.isfile(agents_path) and not args.regenerate_context:
        with open(agents_path, "r", encoding="utf-8") as f:
            old_agents_text = f.read()
        existing_overview = extract_section_content(old_agents_text, "Overview")
        existing_commands = extract_section_content(old_agents_text, "Commands")
        existing_boundaries = extract_section_content(old_agents_text, "Boundaries")
        if existing_overview:
            project_info["overview"] = existing_overview
        if existing_commands:
            project_info["commands"] = [line for line in existing_commands.splitlines() if line.strip()]
        if existing_boundaries:
            project_info["boundaries"] = [line for line in existing_boundaries.splitlines() if line.strip()]

    # 1. AGENTS.md
    agents_template = read_template(templates_dir, "AGENTS.md.template")
    rendered_agents = render_agents_md(
        agents_template, effective_config, agents_registry, workflow_registry, project_info
    )

    if os.path.isfile(agents_path):
        with open(agents_path, "r", encoding="utf-8") as f:
            current_content = f.read()

        if args.regenerate_context:
            backups_dir = os.path.join(target_dir, ".agent-sync", "backups")
            os.makedirs(backups_dir, exist_ok=True)
            timestamp = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
            backup_path = os.path.join(backups_dir, f"AGENTS.{timestamp}.md")
            with open(backup_path, "w", encoding="utf-8") as f:
                f.write(current_content)
            print(f"Created backup of AGENTS.md at {backup_path}")

        updated_content = replace_managed_block(
            current_content, START_POLICY_MARKER, END_POLICY_MARKER,
            rendered_agents[rendered_agents.find(START_POLICY_MARKER):rendered_agents.find(END_POLICY_MARKER) + len(END_POLICY_MARKER)]
        )
        if updated_content is not None:
            with open(agents_path, "w", encoding="utf-8") as f:
                f.write(updated_content)
            print("Updated AGENTS.md managed block")
        else:
            with open(agents_path, "w", encoding="utf-8") as f:
                f.write(rendered_agents)
            print("Replaced AGENTS.md with managed block")
    else:
        with open(agents_path, "w", encoding="utf-8") as f:
            f.write(rendered_agents)
        print("Created AGENTS.md")

    # 2. CLAUDE.md
    configured_agent_ids = [a if isinstance(a, str) else a.get("id") for a in effective_config.get("agents", [])]
    if "claude" in configured_agent_ids:
        claude_md_path = os.path.join(target_dir, "CLAUDE.md")
        claude_template = read_template(templates_dir, "CLAUDE.md.template")
        if os.path.isfile(claude_md_path):
            with open(claude_md_path, "r", encoding="utf-8") as f:
                cur_claude = f.read()
            upd_claude = replace_managed_block(cur_claude, START_POLICY_MARKER, END_POLICY_MARKER, claude_template.strip())
            if upd_claude is not None:
                with open(claude_md_path, "w", encoding="utf-8") as f:
                    f.write(upd_claude)
                print("Updated CLAUDE.md managed block")
            else:
                with open(claude_md_path, "w", encoding="utf-8") as f:
                    f.write(claude_template)
                print("Replaced CLAUDE.md")
        else:
            with open(claude_md_path, "w", encoding="utf-8") as f:
                f.write(claude_template)
            print("Created CLAUDE.md")

    # 3. COMMIT_CONVENTION.md
    commit_conv_path = os.path.join(target_dir, "COMMIT_CONVENTION.md")
    if not os.path.isfile(commit_conv_path):
        commit_template = read_template(templates_dir, "COMMIT_CONVENTION.md.template")
        with open(commit_conv_path, "w", encoding="utf-8") as f:
            f.write(commit_template)
        print("Created COMMIT_CONVENTION.md")
    else:
        print("Preserved COMMIT_CONVENTION.md")

    # 4. MEMORY.md
    memory_path = os.path.join(target_dir, "MEMORY.md")
    if not os.path.isfile(memory_path):
        memory_template = read_template(templates_dir, "MEMORY.md.template")
        rendered_memory = memory_template.replace("{LESSONS}", "")
        with open(memory_path, "w", encoding="utf-8") as f:
            f.write(rendered_memory)
        print("Created MEMORY.md")
    else:
        print("Preserved MEMORY.md")

    # 5. HANDOFF.md
    handoff_path = os.path.join(target_dir, "HANDOFF.md")
    handoff_template = read_template(templates_dir, "HANDOFF.md.template")
    agent_pipe = "|".join(configured_agent_ids)
    rendered_handoff = handoff_template.replace("{AGENT_IDS_PIPE}", agent_pipe)
    if not os.path.isfile(handoff_path):
        with open(handoff_path, "w", encoding="utf-8") as f:
            f.write(rendered_handoff)
        print("Created HANDOFF.md")
    else:
        with open(handoff_path, "r", encoding="utf-8") as f:
            cur_handoff = f.read()
        template_block = rendered_handoff[
            rendered_handoff.find(START_HANDOFF_MARKER):rendered_handoff.find(END_HANDOFF_MARKER) + len(END_HANDOFF_MARKER)
        ]
        upd_handoff = replace_managed_block(cur_handoff, START_HANDOFF_MARKER, END_HANDOFF_MARKER, template_block)
        if upd_handoff is not None:
            with open(handoff_path, "w", encoding="utf-8") as f:
                f.write(upd_handoff)
            print("Updated HANDOFF.md template block (preserved entries)")
        else:
            print("Preserved HANDOFF.md")

    # 6. .claude/settings.json
    update_claude_settings(target_dir, project_info.get("vendor_dirs", []))
    print("Updated .claude/settings.json")

    # 7. Cleanup docs/PROJECT_CONTEXT.md if present
    legacy_ctx = os.path.join(target_dir, "docs", "PROJECT_CONTEXT.md")
    if os.path.isfile(legacy_ctx):
        os.remove(legacy_ctx)
        print("Removed obsolete docs/PROJECT_CONTEXT.md")

    # 8. Ensure .agent-sync/scripts/archive.py exists
    target_archive = os.path.join(target_dir, ".agent-sync", "scripts", "archive.py")
    source_archive = os.path.join(plugin_root, ".agent-sync", "scripts", "archive.py")
    if not os.path.isfile(target_archive) and os.path.isfile(source_archive):
        os.makedirs(os.path.dirname(target_archive), exist_ok=True)
        shutil.copy2(source_archive, target_archive)
        print("Copied .agent-sync/scripts/archive.py to target repository")

    print("\nSetup completed successfully.")

def main():
    parser = argparse.ArgumentParser(description="Deterministic agent-sync setup script")
    parser.add_argument("--target-dir", default=".", help="Target project root directory (default: current directory)")
    parser.add_argument("--regenerate-context", action="store_true", help="Force rescan and context regeneration with backup")
    parser.add_argument("--agents", default=None, help="Comma-separated agent IDs (e.g. claude,codex,antigravity)")
    parser.add_argument("--workflow-tools", default=None, help="Comma-separated workflow tool IDs (e.g. superpowers)")
    parser.add_argument("--plugin-root", default=None, help="Path to agent-sync plugin root")
    parser.add_argument("--templates-dir", default=None, help="Path to templates directory")
    args = parser.parse_args()

    run_setup(args)

if __name__ == "__main__":
    main()
