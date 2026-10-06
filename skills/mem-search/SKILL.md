---
name: mem-search
description: Search persistent cross-agent project memory and inspect past citations using agent-mem
---

# mem-search: Persistent Project Memory Search

Query past project activity, architectural decisions, and tool observations without polluting your context window.

## Usage

The CLI ships with this plugin at `../../agent-mem/bin/agent-mem.ts`, relative to this skill's directory. Resolve it to an absolute path first; do not run it relative to the project cwd:
`AGENT_MEM="<this skill's directory>/../../agent-mem/bin/agent-mem.ts"`

The CLI talks to a local daemon on `127.0.0.1:3777`. In Codex, the default sandbox blocks that connection, so run these commands with escalated permissions (outside the sandbox) from the first call.

Work from cheap to expensive: search, then timeline, then get. Fetch full content only for the few observations that matter.

1. **Search (one line per match):**
   `bun run "$AGENT_MEM" search "<query>"`
   ```
   • [obs_8f12] (change, Edit, claude, 2h ago, ~420 tokens): Added JWT verification middleware to src/auth/guard.ts
   • [chat_ab12_u7] (request, user_prompt, codex, 1d ago, ~60 tokens): make expired tokens return 401
   ```
   Each line shows the observation's kind, then its type (the tool or chat role), agent, age, and size.

   Narrow it with any of:
   - `--kind <kind>`: what the observation was for:
     - `request`: what the user asked
     - `finding`: a reply stating a root cause or gotcha
     - `decision`: a reply stating a choice made
     - `change`: file edits
     - `verification`: test, build, and lint runs
     - `exploration`: reads and searches
     - `command`: other shell commands
     - `reply`: other agent replies
     - `other`: everything else

     Kinds are inferred from wording, so `finding` and `decision` catch only replies that say so explicitly. Search without `--kind` before concluding nothing was decided.
   - `--agent <claude|codex|antigravity>`: what one agent did
   - `--type <type>`: e.g. `user_prompt` (what was asked), `assistant_reply`, `files_edited`, or a tool name
   - `--since <30m|12h|2d|1w>`: recent work only
   - `--session <session-id>`: one session
   - `--file <path>`: observations mentioning a file. The query is optional here, so `search --file src/auth/guard.ts` lists everything that touched it. Run this before editing a file another agent may have worked on.

   If no observation contains every word, the search matches any of them instead. Quote the query (`'"exact phrase"'`) to require the phrase.

2. **Timeline (what happened around a match):**
   `bun run "$AGENT_MEM" timeline <observation-id> [--before <n>] [--after <n>]`
   Prints the steps before and after that observation in its session (5 each by default), one line each, with the match marked `→`.

3. **Get (full content):**
   `bun run "$AGENT_MEM" get <observation-id> [<observation-id>...]`

4. **Live Web Viewer:**
   Open `http://localhost:3777` in your browser for a live stream of agent events.
