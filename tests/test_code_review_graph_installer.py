"""Global install tests use real files, never the user's agent configuration."""

import importlib.util
import io
import contextlib
import hashlib
import json
import os
from pathlib import Path
import tempfile
import tarfile
import subprocess
import sys
import unittest
from unittest import mock


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "skills/install-code-review-graph/scripts"
SKILLS = ("build-graph", "debug-issue", "explore-codebase", "refactor-safely",
          "review-changes", "review-delta", "review-pr")


class TestGlobalInstall(unittest.TestCase):
    def setUp(self):
        self.stdout = io.StringIO()
        self.stderr = io.StringIO()
        output = contextlib.ExitStack()
        output.enter_context(contextlib.redirect_stdout(self.stdout))
        output.enter_context(contextlib.redirect_stderr(self.stderr))
        self.addCleanup(output.close)
        self.tmp = tempfile.TemporaryDirectory(prefix="crg install ")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / "home with spaces"
        self.home.mkdir()
        self.source = self.root / "release"
        self.make_release("2.3.9")
        self.template = self.root / "context.template"
        self.template.write_bytes(b"Graph instructions\r\nVerify source.\r\n")

    def make_release(self, version):
        self.source.mkdir(exist_ok=True)
        (self.source / "pyproject.toml").write_text(
            '[project]\nname = "code-review-graph"\nversion = "' + version + '"\n')
        for name in SKILLS:
            folder = self.source / "skills" / name
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "SKILL.md").write_text(
                f"---\nname: {name}\ndescription: Use the graph.\n---\nRelease {version}\n")

    def engine(self):
        path = SCRIPT_DIR / "code_review_graph_installer.py"
        self.assertTrue(path.is_file(), "global installer engine is not implemented")
        spec = importlib.util.spec_from_file_location("crg_installer_test", path)
        module = importlib.util.module_from_spec(spec)
        import sys
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module

    def plan(self, engine, version="v2.3.9", commit="a" * 40, agents=None):
        release = engine.Release(version, commit, "https://github.com/tirth8205/code-review-graph")
        options = engine.InstallOptions(
            self.home, tuple(agents or ("claude", "codex", "antigravity")),
            self.source, self.template)
        return engine.plan_install(options, release)

    def write(self, relative, content):
        path = self.home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode() if isinstance(content, str) else content)
        return path

    def snapshot(self):
        return {str(p.relative_to(self.home)): (p.read_bytes(), p.stat().st_mtime_ns)
                for p in self.home.rglob("*") if p.is_file()}

    def add_legacy_hooks(self, engine):
        """Reproduce ownership records and configs shipped by the old installer."""
        state = engine.load_state(self.home)

        def record(key, value):
            raw = value if isinstance(value, bytes) else json.dumps(
                value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
            state["artifacts"][key] = hashlib.sha256(raw).hexdigest()

        other = {"hooks": [{"type": "command", "command": "echo agent-mem"}]}
        for relative in (".claude/settings.json", ".codex/hooks.json"):
            data = {"personal": "keep", "hooks": {}}
            for event in ("SessionStart", "PostToolUse"):
                group = {"matcher": "*", "hooks": [{"type": "command",
                    "command": "python3 hook.py # agent-sync:code-review-graph", "timeout": 10}]}
                data["hooks"][event] = [other, group, other]
                record(relative + "#hooks/" + event, group)
            self.write(relative, json.dumps(data, indent=2))
        named = {"PreInvocation": [{"type": "command",
                                  "command": "python3 hook.py # agent-sync:code-review-graph"}]}
        self.write(".gemini/config/hooks.json", json.dumps({"agent-mem": other, "code-review-graph": named}, indent=2))
        record(".gemini/config/hooks.json#code-review-graph", named)
        adapter = b"# old code-review-graph hook adapter\n"
        self.write(".local/share/agent-sync/code-review-graph/hook.py", adapter)
        record(".local/share/agent-sync/code-review-graph/hook.py", adapter)
        self.write(".agent-sync/code-review-graph.json", json.dumps(state, indent=2) + "\n")

    def test_first_install_has_skills_context_and_mcp_without_hooks(self):
        engine = self.engine()
        plan = self.plan(engine)
        self.assertFalse(list(self.home.rglob("*")), "preflight wrote global files")
        engine.apply_install(plan)
        for skills_dir in (".claude/skills", ".agents/skills", ".gemini/config/skills"):
            for name in SKILLS:
                self.assertEqual((self.home / skills_dir / name / "SKILL.md").read_bytes(),
                                 (self.source / "skills" / name / "SKILL.md").read_bytes())
        for relative in (".claude/CLAUDE.md", ".codex/AGENTS.md", ".gemini/AGENTS.md"):
            content = (self.home / relative).read_bytes()
            self.assertIn(b"code-review-graph.md", content)
            self.assertNotIn(b"Graph instructions", content)
        for doc in (".claude/code-review-graph.md", ".codex/code-review-graph.md", ".gemini/code-review-graph.md"):
            self.assertEqual((self.home / doc).read_bytes(), b"Graph instructions\r\nVerify source.\n")
        for relative in (".claude/settings.json", ".codex/hooks.json", ".gemini/config/hooks.json",
                         ".local/share/agent-sync/code-review-graph/hook.py"):
            self.assertFalse((self.home / relative).exists(), relative)
        for relative in (".claude.json", ".gemini/config/mcp_config.json"):
            entry = json.loads((self.home / relative).read_bytes())["mcpServers"]["code-review-graph"]
            self.assertEqual(entry["args"], ["serve"])
            self.assertTrue(Path(entry["command"]).is_absolute())
        import tomllib
        entry = tomllib.loads((self.home / ".codex/config.toml").read_text())["mcp_servers"]["code-review-graph"]
        self.assertEqual(entry["args"], ["serve"])
        state = engine.load_state(self.home)
        self.assertEqual(state["tag"], "v2.3.9")
        self.assertEqual(state["commit"], "a" * 40)

    def test_unmanaged_context_and_json_bytes_are_preserved(self):
        engine = self.engine()
        context = self.write(".claude/CLAUDE.md", b"# Personal\r\nKeep these bytes")
        config = self.write(".claude.json", '{\n  "custom" : {"url":"https://example.com"},\n  "mcpServers": {"other": {"command":"keep"}}\n}\n')
        other_hook = {"hooks": [{"type": "command", "command": "echo keep"}]}
        self.write(".codex/hooks.json", json.dumps({"hooks": {"SessionStart": [other_hook]}}))
        engine.apply_install(self.plan(engine))
        self.assertTrue(context.read_bytes().startswith(b"# Personal\r\nKeep these bytes"))
        self.assertIn(b'"custom" : {"url":"https://example.com"}', config.read_bytes())
        self.assertIn(b'"other": {"command":"keep"}', config.read_bytes())
        hooks = json.loads((self.home / ".codex/hooks.json").read_bytes())
        self.assertEqual(hooks["hooks"]["SessionStart"][0], other_hook)

    def test_malformed_destination_aborts_before_any_global_write(self):
        engine = self.engine()
        self.write(".gemini/config/mcp_config.json", '{"broken":')
        before = self.snapshot()
        with self.assertRaisesRegex(engine.InstallError, "parse|JSON"):
            self.plan(engine)
        self.assertEqual(self.snapshot(), before)

    def test_existing_unrelated_skill_is_a_conflict(self):
        engine = self.engine()
        self.write(".agents/skills/review-pr/SKILL.md", "User's review workflow")
        before = self.snapshot()
        with self.assertRaisesRegex(engine.InstallError, "conflict"):
            self.plan(engine)
        self.assertEqual(self.snapshot(), before)

    def test_normal_rerun_keeps_bytes_mtimes_and_backup_count(self):
        engine = self.engine()
        engine.apply_install(self.plan(engine))
        before = self.snapshot()
        result = engine.apply_install(self.plan(engine))
        self.assertEqual(result.changed, [])
        self.assertEqual(self.snapshot(), before)

    def test_upgrade_replaces_owned_skills_and_preserves_personal_context(self):
        engine = self.engine()
        self.write(".claude/CLAUDE.md", "Personal text\n")
        engine.apply_install(self.plan(engine))
        self.make_release("2.4.0")
        engine.apply_install(self.plan(engine, "v2.4.0", "b" * 40))
        self.assertEqual(engine.load_state(self.home)["tag"], "v2.4.0")
        self.assertIn(b"Release 2.4.0", (self.home / ".agents/skills/build-graph/SKILL.md").read_bytes())
        self.assertTrue((self.home / ".claude/CLAUDE.md").read_text().startswith("Personal text\n"))
        self.assertTrue(list((self.home / ".agent-sync/backups/code-review-graph").rglob("SKILL.md")))
        self.assertFalse((self.home / ".codex/hooks.json").exists())

    def test_user_edited_managed_skill_blocks_upgrade_without_changes(self):
        engine = self.engine()
        engine.apply_install(self.plan(engine))
        self.write(".agents/skills/build-graph/SKILL.md", "Customized skill")
        self.make_release("2.4.0")
        before = self.snapshot()
        with self.assertRaisesRegex(engine.InstallError, "conflict"):
            self.plan(engine, "v2.4.0", "b" * 40)
        self.assertEqual(self.snapshot(), before)

    def test_failed_atomic_apply_restores_existing_and_removes_new_files(self):
        engine = self.engine()
        original = self.write(".claude/CLAUDE.md", "Personal context")
        plan = self.plan(engine)
        real_replace = engine.os.replace
        calls = 0

        def fail_once(src, dst):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise OSError("injected atomic-write failure")
            return real_replace(src, dst)

        with mock.patch.object(engine.os, "replace", side_effect=fail_once):
            with self.assertRaisesRegex(engine.InstallError, "rolled back"):
                engine.apply_install(plan)
        self.assertEqual(original.read_bytes(), b"Personal context")
        self.assertFalse((self.home / ".agent-sync/code-review-graph.json").exists())
        self.assertFalse((self.home / ".agents/skills/build-graph/SKILL.md").exists())

    def test_latest_release_resolves_annotated_tag_to_immutable_commit(self):
        engine = self.engine()
        replies = [
            {"tag_name": "v2.4.0", "draft": False, "prerelease": False},
            {"object": {"type": "tag", "sha": "c" * 40}},
            {"object": {"type": "commit", "sha": "b" * 40}},
        ]
        with mock.patch.object(engine, "fetch_json", side_effect=replies, create=True):
            release = engine.resolve_release("latest")
        self.assertEqual(release.tag, "v2.4.0")
        self.assertEqual(release.commit, "b" * 40)
        self.assertIn("b" * 40, release.source_url)

    def test_exact_release_resolves_the_requested_tag(self):
        engine = self.engine()
        with mock.patch.object(engine, "fetch_json", return_value={
            "object": {"type": "commit", "sha": "a" * 40}}, create=True):
            release = engine.resolve_release("v2.3.9")
        self.assertEqual(release.tag, "v2.3.9")
        self.assertEqual(release.commit, "a" * 40)

    def test_release_archive_rejects_traversal_and_symlinks(self):
        engine = self.engine()
        for name, kind in (("repo/../../escape", tarfile.REGTYPE),
                           ("repo/skills/link", tarfile.SYMTYPE)):
            with self.subTest(name=name):
                blob = io.BytesIO()
                with tarfile.open(fileobj=blob, mode="w:gz") as archive:
                    item = tarfile.TarInfo(name)
                    item.type = kind
                    item.linkname = "/tmp/escape"
                    archive.addfile(item)
                blob.seek(0)
                with self.assertRaisesRegex(engine.InstallError, "archive|Unsafe"):
                    engine.extract_archive(blob, self.root / "extracted")
                self.assertFalse((self.root / "escape").exists())

    def test_runtime_build_failure_does_not_activate_or_change_agent_files(self):
        engine = self.engine()
        engine.apply_install(self.plan(engine))
        before = self.snapshot()
        release = engine.Release("v2.3.9", "a" * 40, "https://example.test/source")
        import subprocess
        with mock.patch.object(engine, "run_process", side_effect=subprocess.CalledProcessError(
                1, ["pip"], stderr="build failed"), create=True):
            with self.assertRaisesRegex(engine.InstallError, "runtime|package"):
                engine.ensure_runtime(self.home, release, self.source)
        # Only version-environment preparation is allowed before activation.
        after = self.snapshot()
        for path, content in before.items():
            self.assertEqual(after[path], content)

    def test_source_version_mismatch_aborts_preflight(self):
        engine = self.engine()
        self.make_release("2.4.0")
        with self.assertRaisesRegex(engine.InstallError, "version"):
            self.plan(engine)
        self.assertFalse(list(self.home.rglob("*")))

    def cli(self):
        engine = self.engine()
        sys.modules["code_review_graph_installer"] = engine
        path = SCRIPT_DIR / "install_code_review_graph.py"
        self.assertTrue(path.is_file(), "global installer CLI is not implemented")
        spec = importlib.util.spec_from_file_location("crg_cli_test", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, engine

    def cli_args(self, *extra):
        return ["--home", str(self.home), "--source-dir", str(self.source),
                "--commit", "a" * 40, "--template", str(self.template), *extra]

    def test_cli_dry_run_from_any_working_directory_writes_nothing(self):
        script = SCRIPT_DIR / "install_code_review_graph.py"
        self.assertTrue(script.exists(), "global installer CLI is not implemented")
        result = subprocess.run([sys.executable, str(script), *self.cli_args("--dry-run")],
                                cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("v2.3.9", result.stdout)
        self.assertIn(".claude.json", result.stdout)
        self.assertFalse(list(self.home.rglob("*")))

    def test_cli_declined_confirmation_does_not_build_or_write(self):
        cli, engine = self.cli()
        with mock.patch("builtins.input", return_value="n"), mock.patch.object(
                engine, "ensure_runtime", side_effect=AssertionError("package must not build")):
            self.assertEqual(cli.main(self.cli_args()), 0)
        self.assertFalse(list(self.home.rglob("*")))

    def test_cli_install_uses_pinned_release_and_normal_rerun_avoids_network(self):
        cli, engine = self.cli()
        release = engine.Release("v2.3.9", "a" * 40, "https://example.test/source")
        with mock.patch.object(engine, "resolve_release", return_value=release), mock.patch.object(
                engine, "download_release", return_value=self.source), mock.patch.object(
                engine, "ensure_runtime"), mock.patch.object(engine, "verify_runtime"):
            self.assertEqual(cli.main(["--home", str(self.home), "--template", str(self.template), "--yes"]), 0)
        self.assertEqual(engine.load_state(self.home)["tag"], "v2.3.9")
        before = self.snapshot()
        with mock.patch.object(engine, "fetch_bytes", side_effect=AssertionError("network forbidden")), mock.patch.object(
                engine, "verify_runtime"):
            self.assertEqual(cli.main(["--home", str(self.home), "--yes"]), 0)
        self.assertEqual(self.snapshot(), before)

    def test_cli_latest_upgrade_records_new_release(self):
        cli, engine = self.cli()
        engine.apply_install(self.plan(engine))
        self.make_release("2.4.0")
        release = engine.Release("v2.4.0", "b" * 40, "https://example.test/new")
        with mock.patch.object(engine, "resolve_release", return_value=release), mock.patch.object(
                engine, "download_release", return_value=self.source), mock.patch.object(
                engine, "ensure_runtime"), mock.patch.object(engine, "verify_runtime"):
            self.assertEqual(cli.main(["--home", str(self.home), "--template", str(self.template),
                                      "--upgrade", "--yes"]), 0)
        self.assertEqual(engine.load_state(self.home)["commit"], "b" * 40)

    def test_cli_downgrade_requires_explicit_permission(self):
        cli, engine = self.cli()
        self.make_release("2.4.0")
        engine.apply_install(self.plan(engine, "v2.4.0", "b" * 40))
        self.make_release("2.3.9")
        before = self.snapshot()
        with mock.patch.object(engine, "ensure_runtime"), mock.patch.object(engine, "verify_runtime"):
            self.assertEqual(cli.main(self.cli_args("--yes")), 1)
            self.assertEqual(self.snapshot(), before)
            self.assertEqual(cli.main(self.cli_args("--yes", "--allow-downgrade")), 0)
        self.assertEqual(engine.load_state(self.home)["tag"], "v2.3.9")

    def test_cli_status_reports_without_fetching_or_writing(self):
        cli, engine = self.cli()
        with mock.patch.object(engine, "fetch_bytes", side_effect=AssertionError("network forbidden")):
            self.assertEqual(cli.main(["--home", str(self.home), "--status"]), 0)
        self.assertFalse(list(self.home.rglob("*")))

    def test_interrupted_process_is_recoverable_before_rerunning_installation(self):
        engine = self.engine()
        context = self.write(".claude/CLAUDE.md", "Original personal context")
        worker = """
import sys, os
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import code_review_graph_installer as installer
options = installer.InstallOptions(Path(sys.argv[2]), ('claude','codex','antigravity'),
    Path(sys.argv[3]), Path(sys.argv[4]))
plan = installer.plan_install(options, installer.Release('v2.3.9', 'a' * 40, 'https://example.test/source'))
real_write = installer.atomic_write
def interrupted(path, content, mode=0o600):
    real_write(path, content, mode)
    if path.name == 'CLAUDE.md' and 'backups' not in path.parts:
        os._exit(27)
installer.atomic_write = interrupted
installer.apply_install(plan)
"""
        result = subprocess.run([sys.executable, "-c", worker, str(SCRIPT_DIR), str(self.home),
                                 str(self.source), str(self.template)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 27, result.stderr)
        self.assertNotEqual(context.read_bytes(), b"Original personal context")
        engine.recover_install(self.home)
        self.assertEqual(context.read_bytes(), b"Original personal context")
        self.assertFalse((self.home / ".local/share/agent-sync/code-review-graph/bin/code-review-graph").exists())
        engine.apply_install(self.plan(engine))
        self.assertEqual(engine.load_state(self.home)["tag"], "v2.3.9")

    def test_validation_failure_rolls_back_to_previous_installed_release(self):
        engine = self.engine()
        engine.apply_install(self.plan(engine))
        before = self.snapshot()
        self.make_release("2.4.0")
        with self.assertRaisesRegex(engine.InstallError, "rolled back"):
            engine.apply_install(self.plan(engine, "v2.4.0", "b" * 40),
                validator=lambda: (_ for _ in ()).throw(engine.InstallError("validation failed")))
        after = self.snapshot()
        for path, value in before.items():
            self.assertEqual(after[path], value)
        self.assertEqual(engine.load_state(self.home)["tag"], "v2.3.9")

    def test_preflight_race_refuses_to_overwrite_a_new_user_edit(self):
        engine = self.engine()
        context = self.write(".claude/CLAUDE.md", "Original context")
        plan = self.plan(engine)
        context.write_text("Edited while installer was preparing")
        with self.assertRaisesRegex(engine.InstallError, "changed since preflight"):
            engine.apply_install(plan)
        self.assertEqual(context.read_text(), "Edited while installer was preparing")

    def test_fresh_install_does_not_read_or_modify_unmanaged_hook_files(self):
        engine = self.engine()
        paths = [self.write(relative, '{"malformed but unmanaged":') for relative in
                 (".claude/settings.json", ".codex/hooks.json", ".gemini/config/hooks.json")]
        before = {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in paths}
        engine.apply_install(self.plan(engine))
        for path, original in before.items():
            self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), original)

    def test_duplicate_json_keys_and_unmanaged_toml_mcp_are_refused(self):
        engine = self.engine()
        for relative, raw in ((".claude.json", '{"mcpServers":{},"mcpServers":{}}'),
                              (".codex/config.toml", '[mcp_servers."code-review-graph"]\ncommand="custom"\n')):
            with self.subTest(relative=relative):
                path = self.write(relative, raw)
                with self.assertRaises(engine.InstallError):
                    self.plan(engine)
                self.assertEqual(path.read_text(), raw)
                path.unlink()

    def test_conflicting_hook_and_mcp_customizations_block_upgrades(self):
        engine = self.engine()
        engine.apply_install(self.plan(engine))
        self.add_legacy_hooks(engine)
        for relative, selector in ((".claude.json", ("mcpServers", "code-review-graph")),
                                   (".gemini/config/hooks.json", ("code-review-graph",))):
            with self.subTest(relative=relative):
                path = self.home / relative
                original = path.read_bytes()
                data = json.loads(original)
                current = data
                for part in selector:
                    current = current[part]
                current["custom"] = "user override"
                path.write_text(json.dumps(data))
                before = self.snapshot()
                with self.assertRaisesRegex(engine.InstallError, "conflict"):
                    self.plan(engine)
                self.assertEqual(self.snapshot(), before)
                path.write_bytes(original)

    def test_hook_edit_removing_ownership_marker_blocks_upgrade(self):
        engine = self.engine()
        engine.apply_install(self.plan(engine))
        self.add_legacy_hooks(engine)
        path = self.home / ".codex/hooks.json"
        data = json.loads(path.read_bytes())
        data["hooks"]["PostToolUse"][1]["hooks"][0]["command"] = "echo my customized hook"
        path.write_text(json.dumps(data))
        self.make_release("2.4.0")
        before = self.snapshot()
        with self.assertRaisesRegex(engine.InstallError, "conflict"):
            self.plan(engine, "v2.4.0", "b" * 40)
        self.assertEqual(self.snapshot(), before)

    def test_rerun_removes_only_owned_legacy_hooks_and_backs_them_up(self):
        engine = self.engine()
        engine.apply_install(self.plan(engine))
        self.add_legacy_hooks(engine)
        before = self.snapshot()
        result = engine.apply_install(self.plan(engine))
        for relative in (".claude/settings.json", ".codex/hooks.json"):
            data = json.loads((self.home / relative).read_bytes())
            self.assertEqual(data["personal"], "keep")
            for event in ("SessionStart", "PostToolUse"):
                self.assertEqual([g["hooks"][0]["command"] for g in data["hooks"][event]],
                                 ["echo agent-mem", "echo agent-mem"])
            self.assertEqual((result.backup_dir / relative).read_bytes(), before[relative][0])
            other_bytes = json.dumps({"hooks": [{"type": "command", "command": "echo agent-mem"}]}, indent=2)
            # Unmanaged groups retain their original indentation/bytes, not just their values.
            indented = "\n".join("      " + line for line in other_bytes.splitlines()).encode()
            self.assertIn(indented, (self.home / relative).read_bytes())
        self.assertEqual(list(json.loads((self.home / ".gemini/config/hooks.json").read_bytes())), ["agent-mem"])
        self.assertFalse((self.home / ".local/share/agent-sync/code-review-graph/hook.py").exists())
        self.assertFalse(any("hook" in key for key in engine.load_state(self.home)["artifacts"]))
        migrated = self.snapshot()
        self.assertEqual(engine.apply_install(self.plan(engine)).changed, [])
        self.assertEqual(self.snapshot(), migrated)

    def test_normal_cli_rerun_cleans_legacy_hooks_without_network_or_build(self):
        cli, engine = self.cli()
        engine.apply_install(self.plan(engine))
        self.add_legacy_hooks(engine)
        with mock.patch.object(engine, "fetch_bytes", side_effect=AssertionError("network forbidden")), mock.patch.object(
                engine, "ensure_runtime", side_effect=AssertionError("build forbidden")), mock.patch.object(
                engine, "verify_runtime"):
            self.assertEqual(cli.main(["--home", str(self.home), "--yes"]), 0)
        self.assertFalse((self.home / ".local/share/agent-sync/code-review-graph/hook.py").exists())
        self.assertNotIn("code-review-graph", json.loads((self.home / ".gemini/config/hooks.json").read_bytes()))

    def test_legacy_cleanup_dry_run_and_decline_leave_every_file_unchanged(self):
        cli, engine = self.cli()
        engine.apply_install(self.plan(engine))
        self.add_legacy_hooks(engine)
        before = self.snapshot()
        with mock.patch.object(engine, "fetch_bytes", side_effect=AssertionError("network forbidden")), mock.patch.object(
                engine, "verify_runtime"), mock.patch("builtins.input", return_value="n"):
            self.assertEqual(cli.main(["--home", str(self.home), "--dry-run"]), 0)
            self.assertEqual(self.snapshot(), before)
            self.assertEqual(cli.main(["--home", str(self.home)]), 0)
        self.assertEqual(self.snapshot(), before)

    def test_readonly_check_reports_legacy_cleanup_without_modifying_hooks(self):
        cli, engine = self.cli()
        engine.apply_install(self.plan(engine))
        self.add_legacy_hooks(engine)
        before = self.snapshot()
        with mock.patch.object(engine, "fetch_bytes", side_effect=AssertionError("network forbidden")), mock.patch.object(
                engine, "verify_runtime"):
            self.assertEqual(cli.main(["--home", str(self.home), "--check"]), 0)
        health = json.loads(self.stdout.getvalue())
        self.assertFalse(health["complete"])
        self.assertIn(".codex/hooks.json#hooks/PostToolUse", health["missing"])
        self.assertEqual(self.snapshot(), before)

    def test_edited_legacy_adapter_aborts_cleanup_without_writes(self):
        cli, engine = self.cli()
        engine.apply_install(self.plan(engine))
        self.add_legacy_hooks(engine)
        self.write(".local/share/agent-sync/code-review-graph/hook.py", "# my custom adapter\n")
        before = self.snapshot()
        self.assertEqual(cli.main(["--home", str(self.home), "--yes"]), 1)
        self.assertIn("conflict", self.stderr.getvalue())
        self.assertEqual(self.snapshot(), before)

    def test_malformed_owned_hook_config_aborts_cleanup_without_writes(self):
        engine = self.engine()
        engine.apply_install(self.plan(engine))
        self.add_legacy_hooks(engine)
        self.write(".codex/hooks.json", '{"broken":')
        before = self.snapshot()
        with self.assertRaisesRegex(engine.InstallError, "parse|JSON"):
            self.plan(engine)
        self.assertEqual(self.snapshot(), before)

    def test_legacy_cleanup_failure_restores_hook_configs_adapter_and_manifest(self):
        engine = self.engine()
        engine.apply_install(self.plan(engine))
        self.add_legacy_hooks(engine)
        before = self.snapshot()
        with self.assertRaisesRegex(engine.InstallError, "rolled back"):
            engine.apply_install(self.plan(engine), validator=lambda: (_ for _ in ()).throw(
                engine.InstallError("validation failed")))
        for path, original in before.items():
            self.assertEqual(self.snapshot()[path], original)

    def test_upgrade_removes_obsolete_owned_skill_assets_and_keeps_user_assets(self):
        engine = self.engine()
        obsolete = self.source / "skills/build-graph/obsolete.py"
        obsolete.write_text("old upstream support script")
        engine.apply_install(self.plan(engine))
        self.write(".agents/skills/build-graph/my-notes.md", "User notes")
        obsolete.unlink()
        self.make_release("2.4.0")
        engine.apply_install(self.plan(engine, "v2.4.0", "b" * 40))
        self.assertFalse((self.home / ".agents/skills/build-graph/obsolete.py").exists())
        self.assertEqual((self.home / ".agents/skills/build-graph/my-notes.md").read_text(), "User notes")
        self.assertNotIn(".agents/skills/build-graph/obsolete.py", engine.load_state(self.home)["artifacts"])

    def test_owned_skill_asset_removal_preserves_user_edits_as_a_conflict(self):
        engine = self.engine()
        obsolete = self.source / "skills/build-graph/obsolete.py"
        obsolete.write_text("old support script")
        engine.apply_install(self.plan(engine))
        self.write(".agents/skills/build-graph/obsolete.py", "user changed this script")
        obsolete.unlink()
        self.make_release("2.4.0")
        with self.assertRaisesRegex(engine.InstallError, "conflict"):
            self.plan(engine, "v2.4.0", "b" * 40)

    def test_skill_executable_assets_keep_execute_permission(self):
        engine = self.engine()
        asset = self.source / "skills/build-graph/run.sh"
        asset.write_text("#!/bin/sh\nexit 0\n")
        asset.chmod(0o755)
        engine.apply_install(self.plan(engine))
        installed = self.home / ".agents/skills/build-graph/run.sh"
        self.assertTrue(os.access(installed, os.X_OK))

    def test_wrapper_executes_with_spaces_in_installation_path_and_arguments(self):
        engine = self.engine()
        engine.apply_install(self.plan(engine))
        target = self.write(".local/share/agent-sync/code-review-graph/versions/" + "a" * 40
                            + "/bin/code-review-graph", '#!/bin/sh\nprintf "%s\\n" "$@"\n')
        target.chmod(0o755)
        wrapper = self.home / ".local/share/agent-sync/code-review-graph/bin/code-review-graph"
        result = subprocess.run([str(wrapper), "serve", "--repo", "repo with spaces"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ["serve", "--repo", "repo with spaces"])

    def test_readonly_check_reports_missing_integrations_without_fetching_or_writing(self):
        cli, engine = self.cli()
        engine.apply_install(self.plan(engine))
        (self.home / ".agents/skills/build-graph/SKILL.md").unlink()
        before = self.snapshot()
        with mock.patch.object(engine, "fetch_bytes", side_effect=AssertionError("network forbidden")), mock.patch.object(
                engine, "verify_runtime"):
            self.assertEqual(cli.main(["--home", str(self.home), "--check"]), 0)
        health = json.loads(self.stdout.getvalue())
        self.assertFalse(health["complete"])
        self.assertIn(".agents/skills/build-graph/SKILL.md", health["missing"])
        self.assertEqual(self.snapshot(), before)

    def test_nonexecutable_wrapper_is_reported_for_repair(self):
        engine = self.engine()
        engine.apply_install(self.plan(engine))
        wrapper = self.home / ".local/share/agent-sync/code-review-graph/bin/code-review-graph"
        wrapper.chmod(0o600)
        missing = engine.verify_installed(self.home, engine.load_state(self.home))
        self.assertIn(".local/share/agent-sync/code-review-graph/bin/code-review-graph", missing)
        engine.apply_install(self.plan(engine))
        self.assertTrue(os.access(wrapper, os.X_OK))

    def test_failed_validation_restores_original_wrapper_permissions(self):
        engine = self.engine()
        engine.apply_install(self.plan(engine))
        wrapper = self.home / ".local/share/agent-sync/code-review-graph/bin/code-review-graph"
        wrapper.chmod(0o600)
        with self.assertRaisesRegex(engine.InstallError, "rolled back"):
            engine.apply_install(self.plan(engine), validator=lambda: (_ for _ in ()).throw(
                engine.InstallError("validation failed")))
        self.assertEqual(wrapper.stat().st_mode & 0o777, 0o600)

    def test_user_edited_doc_file_is_preserved_as_conflict(self):
        engine = self.engine()
        engine.apply_install(self.plan(engine))
        (self.home / ".claude/code-review-graph.md").write_text("User custom graph docs")
        with self.assertRaisesRegex(engine.InstallError, "Ownership conflict: user modified .claude/code-review-graph.md"):
            self.plan(engine)
        self.assertEqual((self.home / ".claude/code-review-graph.md").read_text(), "User custom graph docs")

    def test_missing_doc_file_is_reported_for_repair(self):
        engine = self.engine()
        engine.apply_install(self.plan(engine))
        (self.home / ".claude/code-review-graph.md").unlink()
        missing = engine.verify_installed(self.home, engine.load_state(self.home))
        self.assertIn(".claude/code-review-graph.md", missing)
        engine.apply_install(self.plan(engine))
        self.assertTrue((self.home / ".claude/code-review-graph.md").is_file())

    def test_builtin_agents_fallback_without_registry_file(self):
        engine = self.engine()
        non_existent = Path("/non/existent/path/agents.json")
        loaded = engine.load_agents_registry(non_existent)
        self.assertEqual(loaded, engine.BUILTIN_AGENTS)
        self.assertIn("claude", loaded)
        self.assertIn("codex", loaded)
        self.assertIn("antigravity", loaded)


if __name__ == "__main__":
    unittest.main()
