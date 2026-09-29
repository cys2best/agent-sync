---
name: resume
description: Continue work another agent (Claude Code, Codex, Antigravity) left unfinished, for example after it hit a usage limit, by loading where that session stopped from agent-mem. Use when the user says resume, continue from Claude/Codex, pick up where it left off, or the startup digest shows "run /agent-sync:resume".
---

# resume: Pick Up an Interrupted Session

Loads the tail of another agent's session (last prompt, last replies, recent tool calls, the last subagent result, files changed, and why it stopped) straight from its transcript on disk, so you continue the in-progress step instead of starting it over.

## Setup

The CLI ships with this plugin at `../../agent-mem/bin/agent-mem.ts`, relative to this skill's directory. Resolve it to an absolute path first; do not run it relative to the project cwd:
`AGENT_MEM="<this skill's directory>/../../agent-mem/bin/agent-mem.ts"`

The CLI talks to a local daemon on `127.0.0.1:3777`. In Codex, the default sandbox blocks that connection, so run these commands with escalated permissions (outside the sandbox) from the first call.

## Steps

1. **Pick the session.**
   - If the user named a session id (or an id prefix), use it.
   - Otherwise run `bun run "$AGENT_MEM" sessions --limit 5`. If exactly one session is `interrupted` or `mid-turn`, use it and say which. If there are several or none, show the list and ask the user to choose (in Claude Code, use AskUserQuestion).

2. **Load it.** Run `bun run "$AGENT_MEM" handoff <session-id>`. With no id, it picks the most recent interrupted session. The output is the handoff; keep it in context.

3. **Check what changed since.** Run `git status` and `git log --oneline -5`. If `.agent-sync/todo/` holds a todo list for this work (from the `.agent-sync/TDD.md` workflow), read it: unchecked items are what remains. The other agent may have committed or edited files after its last recorded step; trust the repository over the transcript when they disagree.

4. **Continue, don't restart.** Resume from the last step in the handoff. Do not redo steps it shows as finished. For example, if a review's findings are listed and some fixes are already applied, apply the remaining fixes rather than re-running the whole review. If a workflow tool manages the task, use its own resume path and treat the handoff as the record of what the interrupted step already did.

5. Tell the user in one line which session you are resuming and the step you are continuing from.
