"""Plan and transactionally apply user-scoped code-review-graph integrations.

Preflight is read-only. Ownership is scoped to files, marked blocks, or individual
JSON entries, never an entire shared configuration file.
"""

from dataclasses import dataclass, field
import base64
import contextlib
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_TAG = "v2.3.9"
SKILLS = ("build-graph", "debug-issue", "explore-codebase", "refactor-safely",
          "review-changes", "review-delta", "review-pr")
OWNER = "agent-sync:code-review-graph"
CONTEXT_START = b"<!-- agent-sync:code-review-graph:start -->"
CONTEXT_END = b"<!-- agent-sync:code-review-graph:end -->"
TOML_START = b"# agent-sync:code-review-graph:start"
TOML_END = b"# agent-sync:code-review-graph:end"
STATE_PATH = ".agent-sync/code-review-graph.json"
TRANSACTION_PATH = ".agent-sync/code-review-graph-transaction.json"
# Compatibility only: these artifacts were installed before daemon-only updates.
LEGACY_HOOK_ARTIFACTS = (
    ".local/share/agent-sync/code-review-graph/hook.py",
    ".claude/settings.json#hooks/SessionStart",
    ".claude/settings.json#hooks/PostToolUse",
    ".codex/hooks.json#hooks/SessionStart",
    ".codex/hooks.json#hooks/PostToolUse",
    ".gemini/config/hooks.json#code-review-graph",
)
_HELD_LOCKS = set()
REGISTRY = Path(__file__).resolve().parents[3] / "registry/agents.json"
REPOSITORY = "tirth8205/code-review-graph"
API_URL = "https://api.github.com/repos/" + REPOSITORY
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024


class InstallError(Exception):
    """An installation cannot safely proceed."""


@dataclass(frozen=True)
class Release:
    tag: str
    commit: str
    source_url: str


@dataclass(frozen=True)
class InstallOptions:
    home: Path
    agents: tuple
    source_dir: Path
    template_path: Path


@dataclass
class Change:
    path: Path
    before: bytes | None
    after: bytes | None
    mode: int | None = None


@dataclass
class InstallPlan:
    home: Path
    release: Release
    changes: list = field(default_factory=list)


@dataclass
class InstallResult:
    changed: list
    backup_dir: Path | None = None


def digest(value):
    if not isinstance(value, bytes):
        value = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(value).hexdigest()


def safe_path(home, relative):
    path = home / relative
    if not path.is_relative_to(home) or ".." in Path(relative).parts:
        raise InstallError(f"Unsafe destination: {relative}")
    current = path
    while current != home:
        if current.is_symlink():
            raise InstallError(f"Refusing symlink destination: {current}")
        current = current.parent
    return path


def read_bytes(path):
    if path.exists() and not path.is_file():
        raise InstallError(f"Expected a file: {path}")
    return path.read_bytes() if path.exists() else None


def parse_json(raw, path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate key {key}")
            result[key] = value
        return result
    try:
        data = json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        if not isinstance(data, dict):
            raise ValueError("expected a JSON object")
        return data
    except (ValueError, UnicodeError) as exc:
        raise InstallError(f"Could not parse JSON {path}: {exc}") from exc


def load_state(home):
    path = safe_path(Path(home), STATE_PATH)
    raw = read_bytes(path)
    if raw is None:
        return None
    state = parse_json(raw, path)
    if state.get("schema") != 1 or not isinstance(state.get("artifacts"), dict):
        raise InstallError(f"Unsupported or malformed installation manifest: {path}")
    if not isinstance(state.get("agents"), list) or not isinstance(state.get("tag"), str):
        raise InstallError(f"Malformed installation manifest: {path}")
    validate_release(Release(state["tag"], state.get("commit", ""), state.get("source_url", "")))
    for key, value in state["artifacts"].items():
        if not isinstance(key, str) or not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
            raise InstallError(f"Malformed ownership record in {path}")
    return state


def validate_release(release):
    if not re.fullmatch(r"v?\d+\.\d+\.\d+", release.tag):
        raise InstallError("Select a stable release tag such as v2.3.9")
    if not re.fullmatch(r"[a-f0-9]{40}", release.commit):
        raise InstallError("Release must resolve to an immutable 40-character commit SHA")


def version_tuple(tag):
    if not re.fullmatch(r"v?\d+\.\d+\.\d+", tag):
        raise InstallError(f"Unsupported stable version: {tag}")
    return tuple(int(part) for part in tag.lstrip("v").split("."))


def validate_source(source, release):
    validate_release(release)
    source = Path(source)
    project = source / "pyproject.toml"
    if not project.is_file() or project.is_symlink():
        raise InstallError("Release source is missing pyproject.toml")
    # The immutable upstream project uses a simple literal version in [project].
    text = project.read_text(encoding="utf-8")
    section = re.search(r"(?ms)^\[project\]\s*\n(.*?)(?=^\[|\Z)", text)
    version = re.search(r'(?m)^version\s*=\s*[\"\']([\d.]+)[\"\']\s*$', section[1]) if section else None
    if not version or version[1] != release.tag.lstrip("v"):
        raise InstallError("Release source version does not match the requested tag")
    files = {}
    for name in SKILLS:
        folder = source / "skills" / name
        if not folder.is_dir() or folder.is_symlink():
            raise InstallError(f"Release is missing skill {name}")
        for path in folder.rglob("*"):
            if path.is_symlink():
                raise InstallError(f"Release skill contains a symlink: {path}")
            if path.is_file():
                files[str(path.relative_to(source / "skills"))] = path.read_bytes()
        skill = files.get(f"{name}/SKILL.md", b"")
        if not re.match(rb"---\r?\n", skill) or not re.search(
                rb"(?m)^name:\s*" + name.encode() + rb"\s*$", skill):
            raise InstallError(f"Release has an invalid SKILL.md for {name}")
    return files


def json_spans(text):
    """Map JSON paths to value spans so unrelated bytes survive shared-file edits."""
    decoder = json.JSONDecoder()
    spans = {}

    def whitespace(index):
        while index < len(text) and text[index].isspace():
            index += 1
        return index

    def walk(index, path):
        start = index = whitespace(index)
        if text[index] == "{":
            index = whitespace(index + 1)
            while text[index] != "}":
                key, index = decoder.raw_decode(text, index)
                index = whitespace(index)
                index = walk(index + 1, path + (key,))  # skip colon
                index = whitespace(index)
                if text[index] == ",":
                    index = whitespace(index + 1)
                else:
                    break
            end = index + 1
        elif text[index] == "[":
            index = whitespace(index + 1)
            item = 0
            while text[index] != "]":
                index = walk(index, path + (item,))
                item += 1
                index = whitespace(index)
                if text[index] == ",":
                    index = whitespace(index + 1)
                else:
                    break
            end = index + 1
        else:
            _, end = decoder.raw_decode(text, index)
        spans[path] = (start, end)
        return end

    walk(0, ())
    return spans


def json_set(raw, path, value):
    text = raw.decode("utf-8")
    spans = json_spans(text)
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if path in spans:
        start, end = spans[path]
        return (text[:start] + encoded + text[end:]).encode()
    parent = path[:-1]
    if parent not in spans:
        nested = value
        for key in reversed(path[len(parent):]):
            nested = {key: nested}
        return json_set(raw, parent, nested)
    start, end = spans[parent]
    parent_value = json.loads(text[start:end])
    if isinstance(parent_value, dict):
        addition = json.dumps(path[-1]) + ":" + encoded
    elif isinstance(parent_value, list) and path[-1] == len(parent_value):
        addition = encoded
    else:
        raise InstallError(f"Unexpected JSON shape at {parent}")
    insertion = end - 1
    return (text[:insertion] + ("," if parent_value else "") + addition + text[insertion:]).encode()


def json_remove(raw, path):
    """Remove one member, retaining the bytes of all neighboring JSON members."""
    text = raw.decode("utf-8")
    spans = json_spans(text)
    parent = path[:-1]
    start, end = spans[parent]
    value = json.loads(text[start:end])
    keys = list(value) if isinstance(value, dict) else list(range(len(value)))
    index = keys.index(path[-1])

    def member_start(position):
        offset = start + 1 if position == 0 else spans[parent + (keys[position - 1],)][1]
        while text[offset].isspace() or text[offset] == ",":
            offset += 1
        return offset

    if index:
        begin = spans[parent + (keys[index - 1],)][1]
        finish = spans[path][1]
    else:
        begin = member_start(0)
        finish = member_start(1) if len(keys) > 1 else spans[path][1]
    return (text[:begin] + text[finish:]).encode()


def stage_legacy_hook_removal(home, state, staged, owned):
    """Remove only recorded, unchanged legacy hook artifacts; never adopt hooks."""
    old = state.get("artifacts", {})
    for key in LEGACY_HOOK_ARTIFACTS:
        if key not in old:
            continue
        relative, separator, selector = key.partition("#")
        path = safe_path(home, relative)
        raw = staged[path] if path in staged else read_bytes(path)
        if raw is not None:
            if not separator:
                current, after = raw, None
            else:
                data = parse_json(raw, relative)
                if selector.startswith("hooks/"):
                    event = selector.split("/", 1)[1]
                    hooks = data.get("hooks", {})
                    if not isinstance(hooks, dict) or not isinstance(hooks.get(event, []), list):
                        raise InstallError(f"Invalid hooks structure in {relative}")
                    groups = hooks.get(event, [])
                    if any(not isinstance(group, dict) or not isinstance(group.get("hooks"), list)
                           or any(not isinstance(item, dict) for item in group["hooks"]) for group in groups):
                        raise InstallError(f"Invalid hooks group in {relative}:{event}")
                    matches = [i for i, group in enumerate(groups)
                               if any(OWNER in str(item.get("command", "")) for item in group["hooks"])]
                    if len(matches) > 1:
                        raise InstallError(f"Duplicate owned hooks in {relative}:{event}")
                    if not matches and groups:
                        raise InstallError(f"Ownership conflict: previously managed hook was edited or removed in {relative}:{event}; preserved")
                    current = groups[matches[0]] if matches else None
                    after = json_remove(raw, ("hooks", event, matches[0])) if matches else raw
                else:
                    current = data.get(selector)
                    after = json_remove(raw, (selector,)) if current is not None else raw
            if current is not None and digest(current) != old[key]:
                raise InstallError(f"Ownership conflict: user modified {key}; preserved")
            staged[path] = after
        owned.pop(key)


def finish_plan(home, state, release, agents, owned, staged, modes):
    plan = InstallPlan(home, release)
    next_state = {"schema": 1, "tag": release.tag, "commit": release.commit,
                  "source_url": release.source_url, "agents": agents, "artifacts": owned}
    comparable = {k: v for k, v in state.items() if k != "installed_at"}
    if comparable == next_state:
        next_state["installed_at"] = state["installed_at"]
    else:
        next_state["installed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    staged[safe_path(home, STATE_PATH)] = (json.dumps(next_state, indent=2, ensure_ascii=False) + "\n").encode()
    for path, after in staged.items():
        before = read_bytes(path)
        mode = modes.get(path)
        needs_mode = mode is not None and path.exists() and stat.S_IMODE(path.stat().st_mode) != mode
        if before != after or needs_mode:
            plan.changes.append(Change(path, before, after, mode))
    return plan


def plan_hook_removal(home, state):
    """Plan a local migration without release downloads or package preparation."""
    home = Path(home).absolute()
    staged, owned = {}, dict(state["artifacts"])
    stage_legacy_hook_removal(home, state, staged, owned)
    release = Release(state["tag"], state["commit"], state["source_url"])
    return finish_plan(home, state, release, state["agents"], owned, staged, {})


def marked_block(raw, start, end, path):
    if raw.count(start) != raw.count(end) or raw.count(start) > 1:
        raise InstallError(f"Unbalanced or duplicate managed markers in {path}")
    if start not in raw:
        return None
    begin, finish = raw.find(start), raw.find(end)
    if finish < begin:
        raise InstallError(f"Reversed managed markers in {path}")
    return raw[begin:finish + len(end)]


def runtime_root(home):
    return Path(home) / ".local/share/agent-sync/code-review-graph"


def plan_install(options, release):
    home = Path(options.home).absolute()
    state = load_state(home) or {}
    old = state.get("artifacts", {})
    owned = dict(old)
    source_files = validate_source(options.source_dir, release)
    template = Path(options.template_path).read_bytes().rstrip(b"\r\n")
    if CONTEXT_START in template or CONTEXT_END in template:
        raise InstallError("Context template must not contain installer ownership markers")
    registry = parse_json(REGISTRY.read_bytes(), REGISTRY)
    agents = sorted(set(options.agents) | set(state.get("agents", [])))
    if not agents:
        raise InstallError("Select at least one supported agent")
    for agent in agents:
        if agent not in registry or "codeReviewGraph" not in registry[agent]:
            raise InstallError(f"Unsupported code-review-graph agent: {agent}")
    staged = {}
    stage_legacy_hook_removal(home, state, staged, owned)

    def read(relative):
        path = safe_path(home, relative)
        return staged.get(path, read_bytes(path))

    def stage(relative, after, mode=0o600):
        path = safe_path(home, relative)
        staged[path] = after
        return path

    def claim(key, current, wanted):
        previous = old.get(key)
        if current is not None:
            actual = digest(current)
            if previous and actual != previous:
                raise InstallError(f"Ownership conflict: user modified {key}; preserved")
            if not previous and actual != digest(wanted):
                raise InstallError(f"Ownership conflict: existing unmanaged {key}; preserved")
        owned[key] = digest(wanted)

    def file(relative, wanted, mode=0o600):
        claim(relative, read(relative), wanted)
        path = stage(relative, wanted, mode)
        return path, mode

    def block(relative, start, end, wanted):
        raw = read(relative) or b""
        current = marked_block(raw, start, end, relative)
        claim(relative + "#block", current, wanted)
        if current is None:
            after = raw + (b"\n\n" if raw else b"") + wanted + b"\n"
        else:
            after = raw.replace(current, wanted, 1)
        stage(relative, after)

    def json_entry(relative, selector, wanted):
        raw = read(relative)
        if raw is None:
            raw = b"{}\n"
        data = parse_json(raw, relative)
        current = data
        for key in selector:
            if not isinstance(current, dict):
                raise InstallError(f"Invalid JSON configuration shape: {relative}:{selector}")
            current = current.get(key)
            if current is None:
                break
        claim(relative + "#" + "/".join(selector), current, wanted)
        stage(relative, json_set(raw, tuple(selector), wanted))

    base = runtime_root(home)
    executable = str(base / "bin/code-review-graph")
    modes = {}
    wrapper_relative = str((base / "bin/code-review-graph").relative_to(home))
    target = base / "versions" / release.commit / "bin/code-review-graph"
    wrapper = ("#!/bin/sh\n# " + OWNER + "\nexec " + shlex.quote(str(target)) + ' "$@"\n').encode()
    path, mode = file(wrapper_relative, wrapper, 0o755)
    modes[path] = mode

    for agent in agents:
        layout = registry[agent]["codeReviewGraph"]
        block(layout["context"], CONTEXT_START, CONTEXT_END,
              CONTEXT_START + b"\n" + template + b"\n" + CONTEXT_END)
        for relative, content in source_files.items():
            source_mode = (Path(options.source_dir) / "skills" / relative).stat().st_mode
            path, mode = file(layout["skills"] + "/" + relative, content, 0o755 if source_mode & 0o111 else 0o644)
            modes[path] = mode
        wanted_paths = {layout["skills"] + "/" + relative for relative in source_files}
        for key in old:
            if key.startswith(layout["skills"] + "/") and "#" not in key and key not in wanted_paths:
                current = read(key)
                if current is not None and digest(current) != old[key]:
                    raise InstallError(f"Ownership conflict: user modified obsolete skill asset {key}; preserved")
                stage(key, None)
                owned.pop(key)

        mcp = {"command": executable, "args": ["serve"]}
        if layout["mcpFormat"] == "toml":
            raw = read(layout["mcp"]) or b""
            current = marked_block(raw, TOML_START, TOML_END, layout["mcp"])
            unmanaged = raw.replace(current, b"", 1) if current else raw
            if re.search(rb"(?m)^\s*\[\s*mcp_servers\.(?:\"code-review-graph\"|'code-review-graph'|code-review-graph)(?:\s*\]|\.)", unmanaged):
                raise InstallError(f"Ownership conflict: unmanaged code-review-graph MCP in {layout['mcp']}")
            # Full validation is available in Python 3.11+. On 3.10, refuse an
            # existing TOML file instead of guessing and overwriting bad config.
            validate_toml(raw, layout["mcp"])
            wanted = (TOML_START + b'\n[mcp_servers."code-review-graph"]\ncommand = '
                      + json.dumps(executable).encode() + b'\nargs = ["serve"]\n' + TOML_END)
            block(layout["mcp"], TOML_START, TOML_END, wanted)
            validate_toml(staged[home / layout["mcp"]], layout["mcp"], generated=True)
        else:
            if agent == "claude":
                mcp["type"] = "stdio"
            json_entry(layout["mcp"], ("mcpServers", "code-review-graph"), mcp)

    return finish_plan(home, state, release, agents, owned, staged, modes)


def validate_toml(raw, path, generated=False):
    if not raw:
        return
    try:
        import tomllib
    except ImportError:
        if not generated:
            raise InstallError(f"Python 3.11+ is needed to validate existing TOML: {path}")
        return
    try:
        tomllib.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise InstallError(f"Could not parse TOML {path}: {exc}") from exc


def atomic_write(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=".agent-sync-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def installation_lock(home):
    """Serialize runtime builds and commits; nested calls share the process lock."""
    import fcntl
    home = Path(home).absolute()
    key = str(home)
    if key in _HELD_LOCKS:
        yield
        return
    lock = safe_path(home, ".agent-sync/code-review-graph.lock")
    lock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with lock.open("a+b") as stream:
        os.fchmod(stream.fileno(), 0o600)
        fcntl.flock(stream, fcntl.LOCK_EX)
        _HELD_LOCKS.add(key)
        try:
            yield
        finally:
            _HELD_LOCKS.remove(key)
            fcntl.flock(stream, fcntl.LOCK_UN)


def recover_install(home):
    """Roll back a durable transaction, refusing to overwrite intervening edits."""
    home = Path(home).absolute()
    journal_path = safe_path(home, TRANSACTION_PATH)
    raw = read_bytes(journal_path)
    if raw is None:
        return False
    with installation_lock(home):
        journal = parse_json(journal_path.read_bytes(), journal_path)
        if journal.get("schema") != 1 or not isinstance(journal.get("changes"), list):
            raise InstallError(f"Malformed recovery journal: {journal_path}")
        prepared = []
        seen = set()
        for entry in journal["changes"]:
            try:
                if not isinstance(entry, dict) or entry["path"] in seen:
                    raise ValueError("duplicate or invalid journal entry")
                seen.add(entry["path"])
                path = safe_path(home, entry["path"])
                before = base64.b64decode(entry["before"], validate=True) if entry["before"] is not None else None
                actual = read_bytes(path)
                actual_hash = digest(actual) if actual is not None else None
                if actual != before and actual_hash != entry["after_hash"]:
                    raise InstallError(f"Recovery conflict: {path} changed after interruption; backups: {journal.get('backups')}")
                prepared.append((path, before, entry))
            except (KeyError, ValueError, TypeError) as exc:
                raise InstallError(f"Malformed recovery journal: {journal_path}") from exc
        for path, before, entry in reversed(prepared):
            if read_bytes(path) == before and (before is None or stat.S_IMODE(path.stat().st_mode) == entry["mode"]):
                continue
            if before is None:
                path.unlink()
            else:
                atomic_write(path, before, entry["mode"])
                os.utime(path, ns=(entry["atime_ns"], entry["mtime_ns"]))
        journal_path.unlink()
    return True


def apply_install(plan, validator=None):
    if not plan.changes:
        return InstallResult([])
    with installation_lock(plan.home):
        return _apply_install(plan, validator)


def _apply_install(plan, validator):
    journal_path = safe_path(plan.home, TRANSACTION_PATH)
    if journal_path.exists():
        raise InstallError("An interrupted install needs recovery before applying; rerun the installer")
    originals = {}
    for change in plan.changes:
        safe_path(plan.home, change.path.relative_to(plan.home))
        if read_bytes(change.path) != change.before:
            raise InstallError(f"File changed since preflight: {change.path}; rerun")
        originals[change.path] = change.path.stat() if change.before is not None else None
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backups = plan.home / ".agent-sync/backups/code-review-graph" / stamp
    safe_path(plan.home, backups.relative_to(plan.home))
    journal = {"schema": 1, "backups": str(backups), "changes": []}
    for change in plan.changes:
        previous_stat = originals[change.path]
        if change.before is not None:
            backup = backups / change.path.relative_to(plan.home)
            atomic_write(backup, change.before, 0o600)
        journal["changes"].append({
            "path": str(change.path.relative_to(plan.home)),
            "before": base64.b64encode(change.before).decode() if change.before is not None else None,
            "after_hash": digest(change.after) if change.after is not None else None,
            "mode": stat.S_IMODE(previous_stat.st_mode) if previous_stat else change.mode or 0o600,
            "atime_ns": previous_stat.st_atime_ns if previous_stat else None,
            "mtime_ns": previous_stat.st_mtime_ns if previous_stat else None,
        })
    atomic_write(journal_path, json.dumps(journal).encode())
    try:
        for change in plan.changes:
            if read_bytes(change.path) != change.before:
                raise InstallError(f"File changed since preflight: {change.path}; preserved")
            previous_stat = originals[change.path]
            mode = change.mode or (stat.S_IMODE(previous_stat.st_mode) if previous_stat else 0o600)
            if change.after is None:
                change.path.unlink()
            else:
                atomic_write(change.path, change.after, mode)
            if read_bytes(change.path) != change.after:
                raise InstallError(f"Readback failed: {change.path}")
        if validator:
            validator()
    except BaseException as exc:
        try:
            recover_install(plan.home)
        except (InstallError, OSError) as rollback_exc:
            raise InstallError(f"Apply failed; rollback incomplete: {rollback_exc}. Backups: {backups}") from exc
        raise InstallError(f"Apply failed and rolled back: {exc}. Backups: {backups}") from exc
    journal_path.unlink()
    return InstallResult([str(change.path) for change in plan.changes], backups if backups.exists() else None)


def fetch_bytes(url, maximum=MAX_ARCHIVE_BYTES):
    request = urllib.request.Request(url, headers={
        "User-Agent": "agent-sync-code-review-graph-installer",
        "Accept": "application/vnd.github+json" if url.startswith(API_URL) else "application/octet-stream",
    })
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            content = response.read(maximum + 1)
        if len(content) > maximum:
            raise InstallError(f"Download exceeds size limit: {url}")
        return content
    except (urllib.error.URLError, OSError) as exc:
        raise InstallError(f"Could not download {url}: {exc}") from exc


def fetch_json(url):
    return parse_json(fetch_bytes(url, 2 * 1024 * 1024), url)


def resolve_release(tag=DEFAULT_TAG):
    if tag == "latest":
        data = fetch_json(API_URL + "/releases/latest")
        if data.get("draft") or data.get("prerelease") or not data.get("tag_name"):
            raise InstallError("GitHub did not return a stable release")
        tag = data["tag_name"]
    version_tuple(tag)
    tag = "v" + tag.lstrip("v")
    ref = fetch_json(API_URL + "/git/ref/tags/" + urllib.parse.quote(tag, safe=""))
    obj = ref.get("object", {})
    for _ in range(5):
        if obj.get("type") == "commit":
            break
        if obj.get("type") != "tag" or not re.fullmatch(r"[a-f0-9]{40}", str(obj.get("sha", ""))):
            raise InstallError(f"Invalid GitHub release reference for {tag}")
        obj = fetch_json(API_URL + "/git/tags/" + obj["sha"]).get("object", {})
    if obj.get("type") != "commit":
        raise InstallError(f"Could not resolve release {tag} to a commit")
    commit = obj.get("sha", "")
    release = Release(tag, commit, f"https://github.com/{REPOSITORY}/archive/{commit}.tar.gz")
    validate_release(release)
    return release


def extract_archive(stream, destination):
    """Validate the complete tar index before extracting any regular file."""
    destination = Path(destination)
    try:
        with tarfile.open(fileobj=stream, mode="r:gz") as archive:
            members = archive.getmembers()
            roots, seen, size = set(), set(), 0
            if not members or len(members) > 20000:
                raise InstallError("Invalid release archive member count")
            for member in members:
                path = Path(member.name)
                if (path.is_absolute() or ".." in path.parts or not path.parts
                        or member.name in seen or not (member.isfile() or member.isdir())):
                    raise InstallError(f"Unsafe release archive member: {member.name}")
                roots.add(path.parts[0])
                seen.add(member.name)
                size += member.size
            if len(roots) != 1 or size > MAX_ARCHIVE_BYTES:
                raise InstallError("Invalid or oversized release archive")
            for member in members:
                relative = Path(*Path(member.name).parts[1:])
                target = destination / relative
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open("xb") as output:
                    import shutil
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
    except (tarfile.TarError, OSError) as exc:
        raise InstallError(f"Could not extract release archive: {exc}") from exc
    return destination


def download_release(release, destination):
    import io
    validate_release(release)
    expected = f"https://github.com/{REPOSITORY}/archive/{release.commit}.tar.gz"
    if release.source_url != expected:
        raise InstallError("Release archive URL does not match its immutable commit")
    source = extract_archive(io.BytesIO(fetch_bytes(expected)), destination)
    validate_source(source, release)
    return source


def run_process(command, timeout=600):
    # Isolate package installation from ambient pip configuration and Python paths.
    env = {k: v for k, v in os.environ.items()
           if k not in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV")}
    return subprocess.run(command, check=True, capture_output=True, text=True,
                          timeout=timeout, env=env)


def verify_runtime(home, release):
    runtime = runtime_root(home) / "versions" / release.commit
    executable = runtime / "bin/code-review-graph"
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise InstallError(f"Missing or non-executable package command: {executable}")
    python = runtime / "bin/python"
    expected = release.tag.lstrip("v")
    try:
        result = run_process([str(python), "-I", "-c",
                              "from importlib.metadata import version; "
                              "import code_review_graph.cli, code_review_graph.main; "
                              "print(version('code-review-graph'))"], timeout=60)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        raise InstallError(f"Package runtime verification failed: {getattr(exc, 'stderr', None) or exc}") from exc
    if result.stdout.strip() != expected:
        raise InstallError(f"Package runtime version does not match {release.tag}")
    return executable


def ensure_runtime(home, release, source):
    validate_source(source, release)
    home = Path(home).absolute()
    runtime = runtime_root(home) / "versions" / release.commit
    safe_path(home, runtime.relative_to(home))
    marker = runtime / ".agent-sync-runtime.json"
    pending = runtime / ".agent-sync-pending.json"
    identity = {"tag": release.tag, "commit": release.commit, "source_url": release.source_url}
    try:
        if marker.exists():
            if parse_json(marker.read_bytes(), marker) != identity:
                raise InstallError(f"Package runtime ownership conflict: {runtime}")
            return verify_runtime(home, release)
        if runtime.exists():
            if not pending.is_file() or parse_json(pending.read_bytes(), pending) != identity:
                raise InstallError(f"Unmanaged package runtime: {runtime}")
        else:
            runtime.mkdir(parents=True)
            atomic_write(pending, json.dumps(identity).encode())
        run_process([sys.executable, "-I", "-m", "venv", str(runtime)])
        python = runtime / "bin/python"
        run_process([str(python), "-I", "-m", "pip", "--isolated", "install",
                     "--disable-pip-version-check", "--no-input", "--no-cache-dir", str(Path(source).absolute())])
        executable = verify_runtime(home, release)
        atomic_write(marker, json.dumps(identity).encode())
        pending.unlink()
        return executable
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        detail = (getattr(exc, "stderr", None) or str(exc))[-3000:]
        raise InstallError(f"Could not prepare package runtime; active integrations preserved: {detail}") from exc


def verify_installed(home, state):
    """Verify ownership locally; return missing artifacts that a rerun can restore."""
    home = Path(home).absolute()
    missing = []
    for key, expected in state["artifacts"].items():
        relative, separator, selector = key.partition("#")
        path = safe_path(home, relative)
        raw = read_bytes(path)
        current = raw
        if raw is not None and separator:
            if selector == "block":
                start, end = (TOML_START, TOML_END) if path.suffix == ".toml" else (CONTEXT_START, CONTEXT_END)
                current = marked_block(raw, start, end, path)
                if path.suffix == ".toml":
                    validate_toml(raw, path)
            else:
                data = parse_json(raw, path)
                if selector.startswith("hooks/"):
                    event = selector.split("/", 1)[1]
                    hooks = data.get("hooks", {})
                    if not isinstance(hooks, dict) or not isinstance(hooks.get(event, []), list):
                        raise InstallError(f"Invalid hooks structure in {path}")
                    groups = [group for group in hooks.get(event, [])
                              if isinstance(group, dict) and isinstance(group.get("hooks"), list)
                              and any(isinstance(hook, dict) and OWNER in str(hook.get("command", ""))
                                      for hook in group["hooks"])]
                    if len(groups) > 1:
                        raise InstallError(f"Duplicate owned hooks in {path}")
                    if not groups and hooks.get(event):
                        raise InstallError(f"Ownership conflict: previously managed hook was edited or removed in {path}:{event}; preserved")
                    current = groups[0] if groups else None
                else:
                    current = data
                    for part in selector.split("/"):
                        if not isinstance(current, dict):
                            raise InstallError(f"Invalid configuration shape in {path}")
                        current = current.get(part)
                        if current is None:
                            break
        if current is None:
            missing.append(key)
        elif digest(current) != expected:
            raise InstallError(f"Ownership conflict: user modified {key}; preserved")
        elif path == runtime_root(home) / "bin/code-review-graph" and not os.access(path, os.X_OK):
            missing.append(key)
        elif key in LEGACY_HOOK_ARTIFACTS:
            missing.append(key)  # Local daemon-only migration, not a missing release file.
    return missing
