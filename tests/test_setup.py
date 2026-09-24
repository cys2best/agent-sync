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
        self.script_path = os.path.abspath("skills/setup/scripts/setup.py")
        self.plugin_root = os.path.abspath(".")

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def run_setup(self, *extra_args):
        cmd = [
            sys.executable, self.script_path,
            "--target-dir", self.test_dir,
            "--plugin-root", self.plugin_root,
        ] + list(extra_args)
        return subprocess.run(cmd, capture_output=True, text=True)

    def test_first_run_scaffolds_all_files(self):
        res = self.run_setup("--agents", "claude,codex,antigravity", "--workflow-tools", "superpowers")
        self.assertEqual(res.returncode, 0, msg=f"Setup failed: {res.stderr}\n{res.stdout}")

        # Check .agent-sync/config.json
        config_file = os.path.join(self.test_dir, ".agent-sync", "config.json")
        self.assertTrue(os.path.isfile(config_file))
        with open(config_file, "r") as f:
            cfg = json.load(f)
        self.assertEqual(cfg.get("agents"), ["claude", "codex", "antigravity"])
        self.assertEqual(cfg.get("workflowTools"), ["superpowers"])

        # Check AGENTS.md
        agents_file = os.path.join(self.test_dir, "AGENTS.md")
        self.assertTrue(os.path.isfile(agents_file))
        with open(agents_file, "r") as f:
            agents_text = f.read()
        self.assertIn("<!-- agent-sync:agent-policy:start -->", agents_text)
        self.assertIn("<!-- agent-sync:agent-policy:end -->", agents_text)
        self.assertIn("COMMIT_CONVENTION.md", agents_text)
        self.assertIn("Superpowers", agents_text)
        self.assertIn("Claude Code, Codex, Antigravity", agents_text)

        # Check CLAUDE.md
        claude_file = os.path.join(self.test_dir, "CLAUDE.md")
        self.assertTrue(os.path.isfile(claude_file))
        with open(claude_file, "r") as f:
            claude_text = f.read()
        self.assertIn("Read and follow [AGENTS.md](AGENTS.md)", claude_text)

        # Check COMMIT_CONVENTION.md
        commit_file = os.path.join(self.test_dir, "COMMIT_CONVENTION.md")
        self.assertTrue(os.path.isfile(commit_file))
        with open(commit_file, "r") as f:
            commit_text = f.read()
        self.assertIn("Conventional Commits v1.0.0", commit_text)

        # Check MEMORY.md
        mem_file = os.path.join(self.test_dir, "MEMORY.md")
        self.assertTrue(os.path.isfile(mem_file))
        with open(mem_file, "r") as f:
            mem_text = f.read()
        self.assertIn("<!-- agent-sync:memory:start -->", mem_text)

        # Check HANDOFF.md
        handoff_file = os.path.join(self.test_dir, "HANDOFF.md")
        self.assertTrue(os.path.isfile(handoff_file))
        with open(handoff_file, "r") as f:
            handoff_text = f.read()
        self.assertIn("<!-- agent-sync:handoff-template:start -->", handoff_text)

        # Check .claude/settings.json
        settings_file = os.path.join(self.test_dir, ".claude", "settings.json")
        self.assertTrue(os.path.isfile(settings_file))
        with open(settings_file, "r") as f:
            settings = json.load(f)
        self.assertEqual(settings.get("attribution", {}).get("commit"), "")

        # Check archive.py copied
        archive_script = os.path.join(self.test_dir, ".agent-sync", "scripts", "archive.py")
        self.assertTrue(os.path.isfile(archive_script))

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

        with open(handoff_file, "r") as f:
            updated_handoff = f.read()

        self.assertIn("### 2026-09-01 10:00 — claude", updated_handoff)
        self.assertIn("- Claiming: my-plan/task-1", updated_handoff)

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

if __name__ == "__main__":
    unittest.main()
