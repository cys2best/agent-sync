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

1. **Search Memory (Progressive Disclosure):**
   Run:
   `bun run "$AGENT_MEM" search "<query>"`
   Returns ranked observation summaries with token cost estimates:
   ```
   • [obs_8f12] (~420 tokens): Added JWT verification middleware to src/auth/guard.ts
   • [obs_8f15] (~180 tokens): Unit tests for expired token handling passed (5 tests)
   ```

2. **Retrieve Full Citation Content:**
   If you need the full code diff or output from a specific citation:
   Run:
   `bun run "$AGENT_MEM" get <observation-id>`

3. **Live Web Viewer:**
   Open `http://localhost:3777` in your browser for a live stream of agent events.
