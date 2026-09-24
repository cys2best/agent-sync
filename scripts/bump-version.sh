#!/usr/bin/env bash
#
# bump-version.sh — bump version numbers across all declared manifests
# with drift detection and repo-wide audit for missed files.
#
# Usage:
#   scripts/bump-version.sh <new-version | patch | minor | major>
#   scripts/bump-version.sh --check
#   scripts/bump-version.sh --audit
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$REPO_ROOT/.version-bump.json"

if [[ ! -f "$CONFIG" ]]; then
  echo "error: .version-bump.json not found at $CONFIG" >&2
  exit 1
fi

python3 - "$REPO_ROOT" "$CONFIG" "$@" << 'EOF'
import sys
import os
import json
import re

repo_root = sys.argv[1]
config_path = sys.argv[2]
args = sys.argv[3:]

with open(config_path, "r", encoding="utf-8") as f:
    config = json.load(f)

declared_files = config.get("files", [])
audit_excludes = set(config.get("audit", {}).get("exclude", []))

def get_field_val(data, field_path):
    parts = field_path.split(".")
    curr = data
    for p in parts:
        if isinstance(curr, list):
            curr = curr[int(p)]
        else:
            curr = curr.get(p)
    return curr

def set_field_val(data, field_path, val):
    parts = field_path.split(".")
    curr = data
    for p in parts[:-1]:
        if isinstance(curr, list):
            curr = curr[int(p)]
        else:
            curr = curr.setdefault(p, {})
    last = parts[-1]
    if isinstance(curr, list):
        curr[int(last)] = val
    else:
        curr[last] = val

def read_manifest(path, field):
    full_path = os.path.join(repo_root, path)
    if not os.path.isfile(full_path):
        return None
    with open(full_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return get_field_val(data, field)

def write_manifest(path, field, val):
    full_path = os.path.join(repo_root, path)
    with open(full_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    set_field_val(data, field, val)
    with open(full_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

def cmd_check():
    versions = []
    has_drift = False
    print("Version check:")
    print()
    for item in declared_files:
        p, field = item["path"], item["field"]
        val = read_manifest(p, field)
        if val is None:
            print(f"  {p} ({field}): MISSING")
            has_drift = True
        else:
            print(f"  {p} ({field}): {val}")
            versions.append(val)
    print()
    unique = sorted(set(versions))
    if len(unique) > 1:
        print("DRIFT DETECTED — versions are not in sync:")
        for v in unique:
            count = versions.count(v)
            print(f"  {v} ({count} files)")
        return 1
    elif len(unique) == 1:
        print(f"All declared files are in sync at {unique[0]}")
        return 0
    else:
        print("No versions found.")
        return 1

def cmd_audit():
    cmd_check()
    print()
    # find current version
    versions = [read_manifest(item["path"], item["field"]) for item in declared_files]
    versions = [v for v in versions if v]
    if not versions:
        print("No versions found to audit.")
        return 1
    current = max(set(versions), key=versions.count)
    print(f"Audit: scanning repo for version string '{current}'...")
    print()

    found_undeclared = []
    declared_paths = {item["path"] for item in declared_files}

    for root, dirs, files in os.walk(repo_root):
        rel_root = os.path.relpath(root, repo_root)
        # filter excludes
        if any(rel_root == ex or rel_root.startswith(ex + os.sep) for ex in audit_excludes) or ".git" in rel_root:
            dirs.clear()
            continue
        dirs[:] = [d for d in dirs if d not in audit_excludes and d != ".git"]
        for f in files:
            rel_file = os.path.normpath(os.path.join(rel_root, f))
            if rel_file.startswith("./"):
                rel_file = rel_file[2:]
            if rel_file in audit_excludes or any(rel_file.startswith(ex + os.sep) for ex in audit_excludes):
                continue
            if rel_file in declared_paths:
                continue
            full = os.path.join(root, f)
            try:
                with open(full, "r", encoding="utf-8", errors="ignore") as fh:
                    for i, line in enumerate(fh, 1):
                        if current in line:
                            found_undeclared.append((rel_file, i, line.strip()))
            except Exception:
                pass

    if found_undeclared:
        print(f"UNDECLARED files containing '{current}':")
        for f, lineno, l in found_undeclared:
            print(f"  {f}:{lineno}: {l}")
        print()
        print("Review the above files — if they should be bumped, add them to .version-bump.json")
    else:
        print("No undeclared files contain the version string. All clear.")
    return 0

def bump_semver(ver, bump_type):
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(.*)$", ver)
    if not m:
        raise ValueError(f"Cannot parse semver: {ver}")
    major, minor, patch, rest = int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4)
    if bump_type == "major":
        return f"{major + 1}.0.0"
    elif bump_type == "minor":
        return f"{major}.{minor + 1}.0"
    elif bump_type == "patch":
        return f"{major}.{minor}.{patch + 1}"
    return ver

def cmd_bump(target):
    # Determine current version
    versions = [read_manifest(item["path"], item["field"]) for item in declared_files]
    versions = [v for v in versions if v]
    current = max(set(versions), key=versions.count) if versions else "0.0.0"

    if target in ("major", "minor", "patch"):
        new_version = bump_semver(current, target)
    else:
        if not re.match(r"^\d+\.\d+\.\d+", target):
            print(f"error: '{target}' doesn't look like a valid version (expected X.Y.Z or major/minor/patch)", file=sys.stderr)
            sys.exit(1)
        new_version = target

    print(f"Bumping all declared files from {current} to {new_version}...")
    print()
    for item in declared_files:
        p, field = item["path"], item["field"]
        old_val = read_manifest(p, field)
        write_manifest(p, field, new_version)
        print(f"  {p:<45} {old_val} -> {new_version}")

    print()
    print("Done. Running audit to check for missed files...")
    print()
    cmd_audit()

if not args or args[0] in ("-h", "--help"):
    print("Usage: scripts/bump-version.sh <new-version | patch | minor | major> | --check | --audit")
    sys.exit(0)

action = args[0]
if action == "--check":
    sys.exit(cmd_check())
elif action == "--audit":
    sys.exit(cmd_audit())
else:
    cmd_bump(action)
EOF
