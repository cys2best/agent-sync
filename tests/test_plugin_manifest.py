import os
import json
import unittest

class TestPluginManifest(unittest.TestCase):
    def setUp(self):
        self.repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        self.plugin_json_path = os.path.join(self.repo_root, "plugin.json")
        self.claude_plugin_json_path = os.path.join(self.repo_root, ".claude-plugin", "plugin.json")
        self.hooks_json_path = os.path.join(self.repo_root, ".claude-plugin", "hooks.json")
        self.mem_search_skill_path = os.path.join(self.repo_root, "skills", "mem-search", "SKILL.md")

    def test_root_plugin_json_validity(self):
        self.assertTrue(os.path.isfile(self.plugin_json_path), "Root plugin.json must exist")
        with open(self.plugin_json_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.assertEqual(data.get("name"), "agent-sync")
        self.assertIn("version", data)
        self.assertIn("description", data)
        self.assertEqual(data.get("skills"), "./skills")
        self.assertEqual(data.get("hooks"), "./.claude-plugin/hooks.json")

    def test_claude_plugin_json_consistency(self):
        self.assertTrue(os.path.isfile(self.claude_plugin_json_path), ".claude-plugin/plugin.json must exist")
        with open(self.plugin_json_path, "r", encoding="utf-8") as f:
            root_data = json.load(f)
        with open(self.claude_plugin_json_path, "r", encoding="utf-8") as f:
            claude_data = json.load(f)

        self.assertEqual(root_data.get("name"), claude_data.get("name"))
        self.assertEqual(root_data.get("version"), claude_data.get("version"))
        self.assertEqual(root_data.get("skills"), claude_data.get("skills"))
        self.assertEqual(root_data.get("hooks"), claude_data.get("hooks"))

    def test_claude_plugin_hooks_configuration(self):
        self.assertTrue(os.path.isfile(self.hooks_json_path), ".claude-plugin/hooks.json must exist")
        with open(self.hooks_json_path, "r", encoding="utf-8") as f:
            hooks_cfg = json.load(f)

        self.assertIn("hooks", hooks_cfg)
        hooks = hooks_cfg["hooks"]
        self.assertIn("SessionStart", hooks)

        session_start_hooks = hooks["SessionStart"]
        self.assertIsInstance(session_start_hooks, list)
        self.assertTrue(len(session_start_hooks) > 0)

        entry = session_start_hooks[0]["hooks"][0]
        self.assertEqual(entry.get("type"), "command")
        self.assertIn("${CLAUDE_PLUGIN_ROOT}/agent-mem/bin/agent-mem.ts\" hook session-start --output-format claude", entry.get("command", ""))

        stop_entry = hooks["Stop"][0]["hooks"][0]
        self.assertIn("hook transcript", stop_entry.get("command", ""))

    def test_mem_search_skill_metadata_and_instructions(self):
        self.assertTrue(os.path.isfile(self.mem_search_skill_path), "skills/mem-search/SKILL.md must exist")
        with open(self.mem_search_skill_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Validate frontmatter markers
        self.assertTrue(content.startswith("---\n"), "SKILL.md must start with frontmatter")
        parts = content.split("---\n", 2)
        self.assertGreaterEqual(len(parts), 3, "SKILL.md must have closed frontmatter")
        frontmatter = parts[1]

        self.assertIn("name: mem-search", frontmatter)
        self.assertIn("description:", frontmatter)

        # Validate instruction content
        self.assertIn("mem-search: Persistent Project Memory Search", content)
        # Commands must resolve from the skill directory, not the caller's cwd
        self.assertIn("../../agent-mem/bin/agent-mem.ts", content)
        self.assertNotIn("bun run agent-mem/bin/", content)
        self.assertIn('"$AGENT_MEM" search', content)
        self.assertIn('"$AGENT_MEM" get', content)
        self.assertIn("http://localhost:3777", content)

    def test_all_skills_have_valid_structure(self):
        skills_dir = os.path.join(self.repo_root, "skills")
        self.assertTrue(os.path.isdir(skills_dir))
        for item in os.listdir(skills_dir):
            if item.startswith('.'):
                continue
            item_path = os.path.join(skills_dir, item)
            if os.path.isdir(item_path):
                skill_md = os.path.join(item_path, "SKILL.md")
                self.assertTrue(
                    os.path.isfile(skill_md),
                    f"Skill directory {item} must contain a SKILL.md file",
                )
                with open(skill_md, "r", encoding="utf-8") as f:
                    skill_text = f.read()
                self.assertTrue(
                    skill_text.startswith("---\n"),
                    f"{skill_md} must begin with YAML frontmatter",
                )
                self.assertIn(
                    f"name: {item}",
                    skill_text,
                    f"{skill_md} frontmatter must declare its name as {item}",
                )

if __name__ == "__main__":
    unittest.main()
