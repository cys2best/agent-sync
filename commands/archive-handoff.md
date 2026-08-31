---
description: Move finished plans' entries out of HANDOFF.md into .agent-sync/HANDOFF.archive.md to keep the active handoff log short.
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
---

## Phase 1 — preflight: resolve configuration and find archivable entries

This entire phase is read-only: do not create or modify any file.

### 1A — resolve configuration

1. If `.agent-sync/config.json` exists, read it. Stage no configuration write.
2. Else if `.agent-sync.json` exists at the repo root, read it, then stage
   `{CONFIG_MIGRATION}`: write the same bytes to `.agent-sync/config.json`
   and delete the root file, to be applied in Phase 2.
3. Else, stop immediately and report: "No agent-sync configuration found.
   Run `/agent-sync:setup` first." Make no writes.

### 1B — parse HANDOFF.md entries

Read `HANDOFF.md`. Identify the real, user-appended entries: everything
after the `<!-- agent-sync:handoff-template:end -->` marker and before the
end of the file (skip the `---` separator itself; entries follow it). Never
touch or move anything inside the `agent-sync:handoff-template` markers —
that's the template, not a real entry.

Each real entry is one `### YYYY-MM-DD HH:MM — [agent]` block running up to
(not including) the next `###` heading or end of file. Parse each entry's
`Claiming:`, `Finished:`, `Next:`, and `Blockers:` lines. Each of these lines
may list one or more `plan-name/task-N` identifiers, comma-separated. Extract
every `plan-name` mentioned anywhere in the entry, and record, per plan name:
every task id that plan's entries ever `Claiming:`, every task id that
plan's entries ever `Finished:`, and whether any entry mentions that plan in
a `Next:` line (regardless of task id — a `Next:` mention means there's
known follow-on work).

Preserve each entry's original file order (top of file = newest, per the
template's own convention) — this ordering matters for reconstructing the
archive in old-to-new order in 1D.

### 1C — determine archivable plans

A plan name is **archivable** when both hold:
1. It has at least one `Claiming:` mention somewhere in `HANDOFF.md`, and
   every task id it was ever `Claiming:`'d for also appears in some
   `Finished:` line for that same plan (anywhere in the file, any entry).
2. No entry mentions that plan in a `Next:` line.

A plan with zero `Claiming:` mentions (only ever appearing in `Finished:` or
`Next:` context) is **not** archivable — leave it in place; don't guess
whether it's done.

An entry is **archivable** (eligible to move) only when *every* plan name it
mentions, across all of its `Claiming:`/`Finished:`/`Next:`/`Blockers:`
lines, is archivable. An entry mentioning even one non-archivable plan stays
in `HANDOFF.md` in full — never split a single entry across both files.

If no entry is archivable, stop and report "No finished plans to archive."
Make no writes.

### 1D — render the archive update

For each archivable entry, in **oldest-to-newest** order (reverse of their
order in `HANDOFF.md`, since the file lists newest-first), prepare to append
its full, unmodified `### ...` block to `.agent-sync/HANDOFF.archive.md`.

If `.agent-sync/HANDOFF.archive.md` does not exist, its render begins with
this header before the first appended entry:

```markdown
# Handoff Archive

<!-- Entries archived by /agent-sync:archive-handoff from HANDOFF.md.
     Finished-plan entries only; append-only, oldest archived first. -->

```

If it already exists, preserve its existing bytes in full and append the
new entries after its current last line (with a single blank line separating
the last existing entry from the first newly-appended one).

Stage `HANDOFF.md`'s update: the same file with every archivable entry
removed (and the immediately following blank line, if any, collapsed so no
double-blank-line gap is left behind), everything else — the
`handoff-template` block, the `---` separator, and every non-archivable
entry — byte-for-byte unchanged in its original order.

## Phase 2 — apply the archive

Immediately before the first write, confirm `HANDOFF.md` and
`.agent-sync/HANDOFF.archive.md` (or its absence) still match their Phase 1
snapshots. If either changed, stop before writes and restart the entire
preflight. Otherwise:

- Apply `{CONFIG_MIGRATION}` if one was staged.
- Write the staged `.agent-sync/HANDOFF.archive.md` (create or append).
- Write the staged `HANDOFF.md` (archivable entries removed).

## Phase 3 — verify and report

Re-read both files. Confirm every staged-for-archive entry is present,
byte-for-byte, in `.agent-sync/HANDOFF.archive.md`, and absent from
`HANDOFF.md`. Confirm every non-archivable entry and the `handoff-template`
block are still present in `HANDOFF.md`, byte-for-byte unchanged. Stop and
report any mismatch.

Report: which plans were archived and how many entries each contributed;
which plans looked close but were left in place, and why (an open `Next:`
mention, or an unfinished `Claiming:`/`Finished:` pair, or no `Claiming:`
mention at all making the plan's status ambiguous).
