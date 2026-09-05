#!/usr/bin/env python3
import argparse
import os
import re
import sys

START_MARKER = "<!-- agent-sync:handoff-template:start -->"
END_MARKER = "<!-- agent-sync:handoff-template:end -->"
ARCHIVE_HEADER = """# Handoff Archive

<!-- Entries archived by /agent-sync:archive-handoff from HANDOFF.md.
     Finished-plan entries only; append-only, oldest archived first. -->

"""

ENTRY_HEADER_RE = re.compile(r"^###\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+—\s+.+", re.MULTILINE)
ITEM_RE = re.compile(r"^-\s+(Claiming|Finished|Next|Blockers):\s*(.*)$")
PLAN_TASK_RE = re.compile(r"([a-zA-Z0-9_\-\.]+)/([a-zA-Z0-9_\-\.]+)")
PLAN_NAME_RE = re.compile(r"([a-zA-Z0-9_\-\.]+)")

def validate_handoff_structure(content):
    start_count = content.count(START_MARKER)
    end_count = content.count(END_MARKER)

    if start_count != 1 or end_count != 1:
        return False, f"Expected 1 start and 1 end marker, found {start_count} start and {end_count} end."

    start_idx = content.find(START_MARKER)
    end_idx = content.find(END_MARKER)

    if start_idx >= end_idx:
        return False, "End marker occurs before start marker."

    after_end = content[end_idx + len(END_MARKER):]
    # Expect immediately followed by \n\n--- or \r\n\r\n---
    sep_match = re.match(r"^\r?\n\r?\n---\r?\n?", after_end)
    if not sep_match:
        return False, "End marker must be followed by one blank line and '---'."

    template_and_preamble = content[:end_idx + len(END_MARKER)] + sep_match.group(0)
    entries_part = content[len(template_and_preamble):]
    return True, (template_and_preamble, entries_part)

def split_entries(text):
    positions = [m.start() for m in ENTRY_HEADER_RE.finditer(text)]
    if not positions:
        return []
    entries = []
    for i, pos in enumerate(positions):
        next_pos = positions[i + 1] if i + 1 < len(positions) else len(text)
        entry_text = text[pos:next_pos].strip()
        if entry_text:
            entries.append(entry_text)
    return entries

def parse_entry_info(entry_text):
    info = {
        "text": entry_text,
        "claiming": set(),
        "finished": set(),
        "next": set(),
        "all_plans": set()
    }
    for line in entry_text.splitlines():
        m = ITEM_RE.match(line.strip())
        if not m:
            continue
        field, val = m.group(1), m.group(2).strip()
        if val.lower() in ("none", "none yet", "describe"):
            continue

        # Find plan/task pairs or plan names
        tokens = [t.strip() for t in val.split(",") if t.strip()]
        for tok in tokens:
            # Check for plan-name/task-N
            pt_match = PLAN_TASK_RE.search(tok)
            if pt_match:
                plan, task = pt_match.group(1), pt_match.group(2)
                info["all_plans"].add(plan)
                if field == "Claiming":
                    info["claiming"].add((plan, task))
                elif field == "Finished":
                    info["finished"].add((plan, task))
                elif field == "Next":
                    info["next"].add(plan)
            else:
                # Might just mention plan-name
                p_match = PLAN_NAME_RE.search(tok)
                if p_match:
                    plan = p_match.group(1)
                    if plan.lower() not in ("none", "none yet"):
                        info["all_plans"].add(plan)
                        if field == "Next":
                            info["next"].add(plan)
    return info

def main():
    parser = argparse.ArgumentParser(description="Archive finished plans from HANDOFF.md into HANDOFF.archive.md")
    parser.add_argument("--handoff", default="HANDOFF.md", help="Path to HANDOFF.md")
    parser.add_argument("--archive", default=".agent-sync/HANDOFF.archive.md", help="Path to HANDOFF.archive.md")
    args = parser.parse_args()

    if not os.path.exists(args.handoff):
        print(f"Error: {args.handoff} does not exist.", file=sys.stderr)
        sys.exit(1)

    with open(args.handoff, "r", encoding="utf-8") as f:
        handoff_content = f.read()

    valid, res = validate_handoff_structure(handoff_content)
    if not valid:
        print(f"Error: Malformed {args.handoff}: {res}", file=sys.stderr)
        sys.exit(1)

    template_and_preamble, live_entries_text = res
    live_entries = split_entries(live_entries_text)

    archive_entries = []
    if os.path.exists(args.archive):
        with open(args.archive, "r", encoding="utf-8") as f:
            archive_entries = split_entries(f.read())

    parsed_live = [parse_entry_info(e) for e in live_entries]
    parsed_archive = [parse_entry_info(e) for e in archive_entries]
    all_parsed = parsed_live + parsed_archive

    # Collect plan-level history
    plan_claimed_tasks = {}
    plan_finished_tasks = {}
    plan_has_next = {}

    for p in all_parsed:
        for plan in p["all_plans"]:
            if plan not in plan_claimed_tasks:
                plan_claimed_tasks[plan] = set()
                plan_finished_tasks[plan] = set()
                plan_has_next[plan] = False

        for plan, task in p["claiming"]:
            plan_claimed_tasks[plan].add(task)
        for plan, task in p["finished"]:
            plan_finished_tasks[plan].add(task)
        for plan in p["next"]:
            plan_has_next[plan] = True

    # Determine archivable plans
    archivable_plans = set()
    for plan, claimed in plan_claimed_tasks.items():
        if not claimed:
            continue
        # Every claimed task must be in finished
        finished = plan_finished_tasks.get(plan, set())
        if not claimed.issubset(finished):
            continue
        # Must not have any Next: mentions
        if plan_has_next.get(plan, False):
            continue
        archivable_plans.add(plan)

    # Determine archivable entries from live entries
    to_archive = []
    to_keep = []

    for item in parsed_live:
        if not item["all_plans"]:
            to_keep.append(item["text"])
            continue
        if all(plan in archivable_plans for plan in item["all_plans"]):
            to_archive.append(item["text"])
        else:
            to_keep.append(item["text"])

    if not to_archive:
        print("No finished plans to archive.")
        sys.exit(0)

    # Prepare archive update: oldest-to-newest order (reverse of HANDOFF.md)
    new_archive_text = ""
    if not os.path.exists(args.archive):
        new_archive_text = ARCHIVE_HEADER + "\n\n".join(reversed(to_archive)) + "\n"
    else:
        with open(args.archive, "r", encoding="utf-8") as f:
            existing_archive = f.read().rstrip()
        new_archive_text = existing_archive + "\n\n" + "\n\n".join(reversed(to_archive)) + "\n"

    # Prepare new HANDOFF.md content
    new_handoff_content = template_and_preamble.rstrip()
    if to_keep:
        new_handoff_content += "\n\n" + "\n\n".join(to_keep) + "\n"
    else:
        new_handoff_content += "\n"

    os.makedirs(os.path.dirname(os.path.abspath(args.archive)), exist_ok=True)
    with open(args.archive, "w", encoding="utf-8") as f:
        f.write(new_archive_text)

    with open(args.handoff, "w", encoding="utf-8") as f:
        f.write(new_handoff_content)

    print(f"Successfully archived {len(to_archive)} entries for plans: {', '.join(sorted(archivable_plans))}.")

if __name__ == "__main__":
    main()
