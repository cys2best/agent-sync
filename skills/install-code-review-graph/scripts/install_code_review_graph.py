#!/usr/bin/env python3
"""Optional global CRG integration; run --help for install and upgrade options."""

import argparse
import json
from pathlib import Path
import sys
import tempfile

import code_review_graph_installer as installer


def parser():
    result = argparse.ArgumentParser(description="Install code-review-graph globally for coding agents")
    intent = result.add_mutually_exclusive_group()
    intent.add_argument("--upgrade", "--upgrade-code-review-graph", action="store_true",
                        help="Select GitHub's latest stable release")
    intent.add_argument("--version", "--code-review-graph-version", dest="version",
                        help="Select an exact stable tag, e.g. v2.3.9")
    intent.add_argument("--status", action="store_true", help="Read local installation state as JSON")
    intent.add_argument("--check", action="store_true", help="Verify local installation health without fetching or applying")
    result.add_argument("--agents", help="Comma-separated agents (claude,codex,antigravity)")
    result.add_argument("--allow-downgrade", action="store_true")
    result.add_argument("--dry-run", action="store_true", help="Preview integrations without any global writes")
    result.add_argument("--yes", action="store_true", help="Apply an already approved installation")
    result.add_argument("--home", type=Path, default=Path.home(), help="Target user home directory")
    result.add_argument("--template", type=Path,
                        default=Path(__file__).resolve().parents[1] / "templates/CODE-REVIEW-GRAPH.template")
    result.add_argument("--commit", help="Use an already resolved immutable commit (requires --version or --source-dir)")
    result.add_argument("--source-dir", type=Path, help="Trusted local release source; requires --commit")
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        home = args.home.expanduser().absolute()
        pending = installer.safe_path(home, installer.TRANSACTION_PATH).exists()
        if pending and not args.status and not args.check:
            if args.dry_run:
                raise installer.InstallError("Interrupted installation detected; rerun without --dry-run to recover it")
            if not args.yes:
                try:
                    consent = input("Recover the interrupted global installation from its journal? [y/N] ")
                except EOFError:
                    consent = ""
                if consent.strip().lower() not in ("y", "yes"):
                    print("Recovery declined; no global files changed.")
                    return 0
            installer.recover_install(home)
            print("Recovered the previous installation after interruption.")
        state = installer.load_state(home)
        if args.status:
            print(json.dumps({"installed": state is not None, "tag": state.get("tag") if state else None,
                              "commit": state.get("commit") if state else None,
                              "agents": state.get("agents", []) if state else [],
                              "recovery_needed": pending,
                              "default_tag": installer.DEFAULT_TAG}, indent=2))
            return 0
        agents = tuple(part.strip() for part in args.agents.split(",") if part.strip()) if args.agents else tuple(
            state["agents"] if state else ("claude", "codex", "antigravity"))
        if args.check:
            missing = installer.verify_installed(home, state) if state and not pending else ["interrupted transaction" if pending else "installation"]
            if state:
                missing.extend("agent:" + agent for agent in agents if agent not in state["agents"])
                if not pending:
                    try:
                        installer.verify_runtime(home, installer.Release(state["tag"], state["commit"], state["source_url"]))
                    except (installer.InstallError, OSError) as exc:
                        missing.append("runtime: " + str(exc))
            print(json.dumps({"complete": not missing, "missing": missing,
                              "tag": state["tag"] if state else None,
                              "commit": state["commit"] if state else None}, indent=2))
            return 0
        if args.source_dir and not args.commit:
            raise installer.InstallError("--source-dir requires --commit")
        if args.commit and not (args.version or args.source_dir):
            raise installer.InstallError("--commit requires --version or --source-dir")
        explicit = bool(args.upgrade or args.version or args.source_dir)
        missing = installer.verify_installed(home, state) if state else []
        if state and not explicit and set(missing).issubset(installer.LEGACY_HOOK_ARTIFACTS) and set(agents).issubset(state["agents"]):
            release = installer.Release(state["tag"], state["commit"], state["source_url"])
            installer.verify_runtime(home, release)
            if missing:
                plan = installer.plan_hook_removal(home, state)
                print("Remove legacy installer-owned code-review-graph hooks; daemon manages graph updates.")
                for change in plan.changes:
                    action = "remove" if change.after is None else "update"
                    print(f"  {action} {change.path}")
                if args.dry_run:
                    print(f"Dry run: {len(plan.changes)} files would change; no network request or package build.")
                    return 0
                if not args.yes:
                    try:
                        answer = input("Remove unchanged legacy code-review-graph hooks globally? [y/N] ")
                    except EOFError:
                        answer = ""
                    if answer.strip().lower() not in ("y", "yes"):
                        print("Hook cleanup declined; no global files changed.")
                        return 0
                result = installer.apply_install(plan, validator=lambda: installer.verify_runtime(home, release))
                print(f"Removed legacy hooks; {len(result.changed)} files changed (no network request).")
                if result.backup_dir:
                    print(f"Backups: {result.backup_dir}")
                print("Restart the agents to unload removed hooks.")
                return 0
            print(f"code-review-graph {state['tag']} is installed; unchanged (no network request).")
            return 0
        if args.commit:
            tag = "v" + (args.version or installer.DEFAULT_TAG).lstrip("v")
            release = installer.Release(tag, args.commit,
                f"https://github.com/{installer.REPOSITORY}/archive/{args.commit}.tar.gz")
            installer.validate_release(release)
        elif state and not explicit:
            release = installer.Release(state["tag"], state["commit"], state["source_url"])
        else:
            release = installer.resolve_release("latest" if args.upgrade else args.version or installer.DEFAULT_TAG)
        if state and installer.version_tuple(release.tag) < installer.version_tuple(state["tag"]) and not args.allow_downgrade:
            raise installer.InstallError("Downgrade refused; use --allow-downgrade with the explicitly selected version")
        old_version = state["tag"] if state else "not installed"
        print(f"code-review-graph: {old_version} -> {release.tag} ({release.commit})")
        with tempfile.TemporaryDirectory(prefix="agent-sync-crg-") as temporary:
            source = args.source_dir or installer.download_release(release, Path(temporary) / "source")
            options = installer.InstallOptions(home, agents, source, args.template)
            plan = installer.plan_install(options, release)
            for change in plan.changes:
                action = "remove" if change.after is None else "update" if change.before is not None else "create"
                print(f"  {action} {change.path}")
            if args.dry_run:
                print(f"Dry run: {len(plan.changes)} integration files would change; package would be verified/prepared.")
                return 0
            if not args.yes:
                try:
                    answer = input(f"Install {release.tag} globally for {', '.join(agents)}? [y/N] ")
                except EOFError:
                    answer = ""
                if answer.strip().lower() not in ("y", "yes"):
                    print("Installation declined; no global files changed.")
                    return 0
            print("Preparing isolated package runtime...")
            with installer.installation_lock(home):
                installer.ensure_runtime(home, release, source)
                result = installer.apply_install(plan, validator=lambda: installer.verify_runtime(home, release))
        print(f"Installed {release.tag}; {len(result.changed)} integration files changed.")
        if result.backup_dir:
            print(f"Backups: {result.backup_dir}")
        removed = [change for change in plan.changes if change.after is None]
        if removed:
            print(f"Removed {len(removed)} obsolete installer-owned artifacts; recoverable from backups.")
        print(f"CLI: {installer.runtime_root(home) / 'bin/code-review-graph'}")
        print("Restart the agents and run build-graph in each repository. Graph updates use your multi-repo daemon; no hooks installed.")
        return 0
    except (installer.InstallError, OSError, ValueError) as exc:
        print(f"code-review-graph installation stopped: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
