import os
import shutil
import tempfile
import unittest
import subprocess
import sys

class TestArchiveScript(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.handoff_file = os.path.join(self.test_dir, "HANDOFF.md")
        self.archive_file = os.path.join(self.test_dir, ".agent-sync", "HANDOFF.archive.md")
        os.makedirs(os.path.dirname(self.archive_file), exist_ok=True)
        self.script_path = os.path.abspath(".agent-sync/scripts/archive.py")

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def run_archive(self):
        result = subprocess.run(
            [sys.executable, self.script_path, "--handoff", self.handoff_file, "--archive", self.archive_file],
            capture_output=True,
            text=True
        )
        return result

    def test_single_finished_plan_is_archived(self):
        content = """# Handoff Log

<!-- agent-sync:handoff-template:start -->
Template
<!-- agent-sync:handoff-template:end -->

---

### 2026-09-01 10:00 — agent
- Claiming: none
- Finished: plan-a/task-1
- Next: none
- Blockers: none

### 2026-09-01 09:00 — agent
- Claiming: plan-a/task-1
- Finished: none
- Next: none
- Blockers: none
"""
        with open(self.handoff_file, "w") as f:
            f.write(content)

        res = self.run_archive()
        self.assertEqual(res.returncode, 0)

        with open(self.handoff_file) as f:
            new_handoff = f.read()

        with open(self.archive_file) as f:
            archive_content = f.read()

        # Both entries for plan-a should move to archive
        self.assertNotIn("plan-a/task-1", new_handoff)
        self.assertIn("plan-a/task-1", archive_content)
        self.assertIn("# Handoff Archive", archive_content)

    def test_open_plan_with_next_stays_in_handoff(self):
        content = """# Handoff Log

<!-- agent-sync:handoff-template:start -->
Template
<!-- agent-sync:handoff-template:end -->

---

### 2026-09-01 10:00 — agent
- Claiming: none
- Finished: plan-b/task-1
- Next: plan-b/task-2
- Blockers: none

### 2026-09-01 09:00 — agent
- Claiming: plan-b/task-1
- Finished: none
- Next: none
- Blockers: none
"""
        with open(self.handoff_file, "w") as f:
            f.write(content)

        res = self.run_archive()
        self.assertEqual(res.returncode, 0)

        with open(self.handoff_file) as f:
            new_handoff = f.read()

        # Plan-b has an active Next: line, so it must stay in HANDOFF.md
        self.assertIn("plan-b/task-1", new_handoff)
        self.assertIn("Next: plan-b/task-2", new_handoff)
        self.assertFalse(os.path.exists(self.archive_file))

    def test_tangled_entry_prevents_archiving_that_entry(self):
        content = """# Handoff Log

<!-- agent-sync:handoff-template:start -->
Template
<!-- agent-sync:handoff-template:end -->

---

### 2026-09-01 11:00 — agent
- Claiming: none
- Finished: plan-done/task-1, plan-open/task-1
- Next: plan-open/task-2
- Blockers: none

### 2026-09-01 10:00 — agent
- Claiming: none
- Finished: plan-done/task-1
- Next: none
- Blockers: none

### 2026-09-01 09:00 — agent
- Claiming: plan-done/task-1
- Finished: none
- Next: none
- Blockers: none
"""
        with open(self.handoff_file, "w") as f:
            f.write(content)

        res = self.run_archive()
        self.assertEqual(res.returncode, 0)

        with open(self.handoff_file) as f:
            new_handoff = f.read()

        # The tangled entry mentioning plan-open must stay in HANDOFF.md
        self.assertIn("plan-open/task-2", new_handoff)

    def test_malformed_markers_aborts_without_writes(self):
        content = """# Handoff Log
Missing markers
---
### 2026-09-01 10:00 — agent
- Finished: plan-x/task-1
"""
        with open(self.handoff_file, "w") as f:
            f.write(content)

        res = self.run_archive()
        self.assertNotEqual(res.returncode, 0)
        self.assertFalse(os.path.exists(self.archive_file))

if __name__ == "__main__":
    unittest.main()
