import os
import shutil
import tempfile
import unittest
import subprocess
import sys
import json

class TestSetupScript(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        # Isolated HOME so agent-mem hook detection never reads the real ~/.codex or ~/.gemini
        self.home_dir = tempfile.mkdtemp()
        self.script_path = os.path.abspath("skills/setup/scripts/setup.py")
        self.plugin_root = os.path.abspath(".")

    def tearDown(self):
        shutil.rmtree(self.test_dir)
        shutil.rmtree(self.home_dir)

    def run_setup(self, *extra_args):
        cmd = [
            sys.executable, self.script_path,
            "--target-dir", self.test_dir,
            "--plugin-root", self.plugin_root,
        ] + list(extra_args)
        env = {**os.environ, "HOME": self.home_dir}
        return subprocess.run(cmd, capture_output=True, text=True, env=env)

    def write_json(self, relative_path, data, base=None):
        path = os.path.join(base or self.test_dir, relative_path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(data, f)
        return path

    def test_first_run_scaffolds_all_files(self):
        res = self.run_setup("--agents", "claude,codex,antigravity")
        self.assertEqual(res.returncode, 0, msg=f"Setup failed: {res.stderr}\n{res.stdout}")

        # Check .agent-sync/config.json is NOT created (zero-config)
        config_file = os.path.join(self.test_dir, ".agent-sync", "config.json")
        self.assertFalse(os.path.exists(config_file))

        # Check AGENTS.md
        agents_file = os.path.join(self.test_dir, "AGENTS.md")
        self.assertTrue(os.path.isfile(agents_file))
        with open(agents_file, "r") as f:
            agents_text = f.read()
        self.assertIn("# Agent Instructions", agents_text)
        self.assertIn("<!-- agent-sync:agent-policy:start -->", agents_text)
        self.assertIn("<!-- agent-sync:agent-policy:end -->", agents_text)
        self.assertNotIn("COMMIT_CONVENTION.md", agents_text)
        self.assertIn("Conventional Commits", agents_text)
        self.assertNotIn("Claude Code, Codex, Antigravity", agents_text)
        # agent-mem replaces the HANDOFF ledger and per-tool workflow policy
        self.assertIn("/agent-sync:resume", agents_text)
        self.assertIn("/agent-sync:mem-search", agents_text)
        self.assertNotIn("never hand-edit its state files", agents_text)
        self.assertNotIn("TDD.md", agents_text)

        # TDD.md is NOT created
        self.assertFalse(os.path.exists(os.path.join(self.test_dir, ".agent-sync", "TDD.md")))
        self.assertNotIn("HANDOFF", agents_text)
        self.assertNotIn("Only engage", agents_text)

        # Check CLAUDE.md
        claude_file = os.path.join(self.test_dir, "CLAUDE.md")
        self.assertTrue(os.path.isfile(claude_file))
        with open(claude_file, "r") as f:
            claude_text = f.read()
        self.assertIn("Read and follow [AGENTS.md](AGENTS.md)", claude_text)

        # Check COMMIT_CONVENTION.md is not scaffolded
        commit_file = os.path.join(self.test_dir, "COMMIT_CONVENTION.md")
        self.assertFalse(os.path.exists(commit_file))

        # Check MEMORY.md
        mem_file = os.path.join(self.test_dir, "MEMORY.md")
        self.assertTrue(os.path.isfile(mem_file))
        with open(mem_file, "r") as f:
            mem_text = f.read()
        self.assertIn("<!-- agent-sync:memory:start -->", mem_text)

        self.assertFalse(os.path.exists(os.path.join(self.test_dir, "HANDOFF.md")))

        # Check .claude/settings.json
        settings_file = os.path.join(self.test_dir, ".claude", "settings.json")
        self.assertTrue(os.path.isfile(settings_file))
        with open(settings_file, "r") as f:
            settings = json.load(f)
        self.assertEqual(settings.get("attribution", {}).get("commit"), "")
        self.assertNotIn("hooks", settings)
        self.assertFalse(os.path.exists(os.path.join(self.test_dir, ".agent-sync", "scripts", "archive.py")))

    def test_marker_preservation_on_existing_files(self):
        # Create an existing AGENTS.md with content outside markers
        agents_file = os.path.join(self.test_dir, "AGENTS.md")
        initial_content = (
            "# My Custom Header\n\n"
            "Pre-existing text before managed block.\n\n"
            "<!-- agent-sync:agent-policy:start -->\n"
            "Old policy block\n"
            "<!-- agent-sync:agent-policy:end -->\n\n"
            "Post-existing text after managed block.\n"
        )
        with open(agents_file, "w") as f:
            f.write(initial_content)

        # Create HANDOFF.md with real task entry after separator
        handoff_file = os.path.join(self.test_dir, "HANDOFF.md")
        handoff_initial = (
            "# Handoff Log\n\n"
            "<!-- agent-sync:handoff-template:start -->\n"
            "Old template\n"
            "<!-- agent-sync:handoff-template:end -->\n\n"
            "---\n\n"
            "### 2026-09-01 10:00 — claude\n"
            "- Claiming: my-plan/task-1\n"
            "- Finished: none\n"
            "- Next: none\n"
            "- Blockers: none\n"
        )
        with open(handoff_file, "w") as f:
            f.write(handoff_initial)

        res = self.run_setup()
        self.assertEqual(res.returncode, 0)

        with open(agents_file, "r") as f:
            updated_agents = f.read()

        self.assertTrue(updated_agents.startswith("# My Custom Header\n\nPre-existing text before managed block."))
        self.assertTrue(updated_agents.endswith("Post-existing text after managed block.\n"))
        self.assertIn("This file contains shared project knowledge", updated_agents)

        # HANDOFF.md is no longer managed: left byte-for-byte for the user to keep or delete
        with open(handoff_file, "r") as f:
            self.assertEqual(f.read(), handoff_initial)

    def test_rerun_removes_legacy_config_and_drops_archive_hook(self):
        self.write_json(".agent-sync/config.json", {"agents": ["claude"], "workflowTools": ["superpowers"]})
        other_hook = {"type": "command", "command": "echo keep-me"}
        archive_hook = {"type": "command", "command": "python3 .agent-sync/scripts/archive.py"}
        self.write_json(".claude/settings.json", {"hooks": {"SessionEnd": [{"hooks": [other_hook, archive_hook]}]}})

        res = self.run_setup()
        self.assertEqual(res.returncode, 0, msg=res.stderr)

        self.assertFalse(os.path.exists(os.path.join(self.test_dir, ".agent-sync", "config.json")))
        with open(os.path.join(self.test_dir, ".claude", "settings.json")) as f:
            settings = json.load(f)
        self.assertEqual(settings["hooks"], {"SessionEnd": [{"hooks": [other_hook]}]})

    def test_archive_only_session_end_hook_is_removed_entirely(self):
        archive_hook = {"type": "command", "command": "python3 .agent-sync/scripts/archive.py"}
        self.write_json(".claude/settings.json", {"hooks": {"SessionEnd": [{"hooks": [archive_hook]}]}})
        res = self.run_setup()
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        with open(os.path.join(self.test_dir, ".claude", "settings.json")) as f:
            self.assertNotIn("hooks", json.load(f))

    def test_reports_missing_agent_mem_hooks_for_codex_and_antigravity(self):
        res = self.run_setup()
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        self.assertIn("agent-mem.ts\" setup --agent codex", res.stdout)
        self.assertIn("agent-mem.ts\" setup --agent antigravity", res.stdout)

        hook = {"type": "command", "command": 'bun run "/x/agent-mem/bin/agent-mem.ts" hook session-start'}
        self.write_json(".codex/hooks.json", {"hooks": {"SessionStart": [{"hooks": [hook]}]}}, base=self.home_dir)
        self.write_json(".gemini/config/hooks.json", {"agent-mem": {"PreInvocation": [hook]}}, base=self.home_dir)
        res = self.run_setup()
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        self.assertNotIn("setup --agent codex", res.stdout)
        self.assertNotIn("setup --agent antigravity", res.stdout)

    def test_rerun_drops_stale_handoff_boundary_but_keeps_custom_ones(self):
        agents_file = os.path.join(self.test_dir, "AGENTS.md")
        with open(agents_file, "w") as f:
            f.write(
                "# Agent Instructions\n\n"
                "<!-- agent-sync:agent-policy:start -->\n"
                "## Boundaries\n\n"
                "- `api/`: public contract; never break it.\n"
                "- `HANDOFF.md`: task-ID ledger only; execution details remain in the workflow's own reports.\n\n"
                "## Conventions\n"
                "<!-- agent-sync:agent-policy:end -->\n"
            )
        res = self.run_setup()
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        with open(agents_file) as f:
            text = f.read()
        self.assertIn("- `api/`: public contract; never break it.", text)
        self.assertNotIn("HANDOFF", text)

    def test_regenerate_context_creates_backup(self):
        agents_file = os.path.join(self.test_dir, "AGENTS.md")
        original_content = (
            "# Agent Instructions (Claude Code)\n\n"
            "<!-- agent-sync:agent-policy:start -->\n"
            "Original content to backup\n"
            "<!-- agent-sync:agent-policy:end -->\n"
        )
        with open(agents_file, "w") as f:
            f.write(original_content)

        res = self.run_setup("--regenerate-context")
        self.assertEqual(res.returncode, 0)

        backups_dir = os.path.join(self.test_dir, ".agent-sync", "backups")
        self.assertTrue(os.path.isdir(backups_dir))
        backup_files = os.listdir(backups_dir)
        self.assertEqual(len(backup_files), 1)
        self.assertTrue(backup_files[0].startswith("AGENTS."))

        with open(os.path.join(backups_dir, backup_files[0]), "r") as f:
            backup_content = f.read()
        self.assertEqual(backup_content, original_content)

    def test_cleanup_obsolete_project_context(self):
        docs_dir = os.path.join(self.test_dir, "docs")
        os.makedirs(docs_dir, exist_ok=True)
        obsolete_file = os.path.join(docs_dir, "PROJECT_CONTEXT.md")
        with open(obsolete_file, "w") as f:
            f.write("# Obsolete Project Context\n")

        res = self.run_setup()
        self.assertEqual(res.returncode, 0)
        self.assertFalse(os.path.exists(obsolete_file))

    def test_graph_status_through_packaged_setup_root_does_not_touch_project_or_home(self):
        res = self.run_setup("--code-review-graph-status")
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        self.assertFalse(json.loads(res.stdout)["installed"])
    def test_skip_graph_preserves_existing_setup_behavior(self):
        res = self.run_setup("--skip-code-review-graph", "--agents", "claude")
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        self.assertTrue(os.path.isfile(os.path.join(self.test_dir, "AGENTS.md")))
        self.assertEqual(os.listdir(self.home_dir), [])

    def test_agents_md_focuses_on_gotchas_and_omits_obvious(self):
        res = self.run_setup("--agents", "claude")
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        with open(os.path.join(self.test_dir, "AGENTS.md"), "r") as f:
            content = f.read()

        # Section dedicated to key constraints and gotchas
        self.assertIn("## Key Constraints & Gotchas", content)

        # Omit the obvious: should not redundantly repeat self-evident file pointers or vendor lines in constraints
        self.assertNotIn("- `CLAUDE.md`: minimal pointer", content)
        self.assertNotIn("- `MEMORY.md`: durable project lessons", content)
        self.assertNotIn("- `COMMIT_CONVENTION.md`: Conventional Commits", content)
        self.assertNotIn("Vendor exclusions:", content)

        # Rely on model judgment over rigid rules: generic preaching rules and micro-caps are cut off entirely
        self.assertNotIn("Think Before Coding", content)
        self.assertNotIn("Simplicity First", content)
        self.assertNotIn("Surgical Changes", content)
        self.assertNotIn("25 words each", content)
        self.assertNotIn("Aim for 80 lines", content)

        # Progressive disclosure: file is resized and kept lean, linking out to secondary instruction files
        self.assertIn("See:", content)
        self.assertIn("MEMORY.md", content)
        self.assertNotIn("COMMIT_CONVENTION.md", content)
        self.assertNotIn("TDD.md", content)
        # Attribution prohibition is unified into the commit convention without duplicate bullets
        self.assertEqual(content.count("Co-Authored-By"), 1)
        self.assertLess(len(content.splitlines()), 38)

    def test_rerun_migrates_legacy_boundaries_and_prunes_obvious_markers(self):
        agents_file = os.path.join(self.test_dir, "AGENTS.md")
        with open(agents_file, "w") as f:
            f.write(
                "# Agent Instructions (Claude Code)\n\n"
                "<!-- agent-sync:agent-policy:start -->\n"
                "## Boundaries\n\n"
                "- `core/types.ts`: keep types in one monolithic file; do not split.\n"
                "- `CLAUDE.md`: minimal pointer to `AGENTS.md`; shared project knowledge and agent instructions belong here.\n"
                "- Vendor exclusions: Ignore dependencies and build artifacts under `node_modules/`.\n\n"
                "## Conventions\n"
                "<!-- agent-sync:agent-policy:end -->\n"
            )
        res = self.run_setup("--agents", "claude")
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        with open(agents_file) as f:
            text = f.read()

        self.assertIn("## Key Constraints & Gotchas", text)
        self.assertIn("- `core/types.ts`: keep types in one monolithic file; do not split.", text)
        self.assertNotIn("- `CLAUDE.md`: minimal pointer", text)
        self.assertNotIn("Vendor exclusions:", text)

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

if __name__ == "__main__":
    unittest.main()

