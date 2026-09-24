---
name: mem-search
description: Search persistent cross-agent project memory and inspect past citations using agent-mem
---

# mem-search: Persistent Project Memory Search

Query past project activity, architectural decisions, and tool observations without polluting your context window.

## Usage

1. **Search Memory (Progressive Disclosure):**
   Run:
   `bun run agent-mem/bin/agent-mem.ts search "<query>"`
   Returns ranked observation summaries with token cost estimates:
   ```
   • [obs_8f12] (~420 tokens): Added JWT verification middleware to src/auth/guard.ts
   • [obs_8f15] (~180 tokens): Unit tests for expired token handling passed (5 tests)
   ```

2. **Retrieve Full Citation Content:**
   If you need the full code diff or output from a specific citation:
   Run:
   `bun run agent-mem/bin/agent-mem.ts get <observation-id>`

3. **Live Web Viewer:**
   Open `http://localhost:3777` in your browser for a live stream of agent events.
