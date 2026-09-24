# Specification: `agent-mem` Persistent Memory & Handoff System

**Date:** 2026-09-24  
**Status:** Approved  
**Author:** Pair Programming Session (Antigravity & User)

---

## 1. Overview & Motivation

When working with autonomous coding agents (Claude Code, Antigravity, Codex) across projects and long-running sessions, context between sessions is typically lost ("agent amnesia") or depends on manual maintenance of static log files like `HANDOFF.md`.

`agent-mem` is a lightweight, zero-external-LLM-cost persistent memory subsystem integrated directly into this repository (`superpower-dual-agents`). Built with **Bun** and **SQLite (FTS5)** under `agent-mem/`, it captures raw agent actions, tool outputs, and user prompts per project, redacts sensitive information, provides an interactive real-time Web Viewer UI, and automatically injects a compact project digest on session startup to replace manual handoff routines.

### Key Objectives
1. **Persistent Memory Across Sessions:** Project context, recent decisions, file diffs, and tool results survive across agent reboots and switches.
2. **Handoff Automation:** Eliminates manual `HANDOFF.md` editing by generating an automated, high-signal ~150-token **Compact Project Digest** on session start.
3. **Progressive Disclosure & Token Visibility:** 3-tier retrieval (Digest -> Search Summaries + Token Estimates -> Full Observation) prevents context window bloat.
4. **Deterministic Citations:** Every observation has a stable ID (`obs_xxxx`) that agents can cite and retrieve on demand.
5. **Real-Time Web Viewer UI:** Zero-build single-page web dashboard using Server-Sent Events (SSE) to observe cross-agent activity live at `http://localhost:3777`.
6. **Privacy First:** Multi-line `<private>...</private>` tags and common credential patterns are stripped before storage.
7. **Native In-Repo Integration:** Packaged cleanly within `agent-mem/`, exposed via plugin hooks (`.claude-plugin/hooks.json`) and native skill (`skills/mem-search/`).

---

## 2. Architecture & Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│                      Coding Agents                           │
│  (Claude Code Hooks / Antigravity Hooks / Codex CLI Wrapper) │
└──────────────┬───────────────────────────────▲───────────────┘
               │ Event Payload                 │ Injected Context
               │ (prompt, tool call, response) │ (Digest, citations)
               ▼                               │
┌──────────────────────────────────────────────────────────────┐
│              agent-mem CLI / Hook Runner                     │
│                (agent-mem/bin/agent-mem.ts)                  │
└──────────────┬───────────────────────────────▲───────────────┘
               │ HTTP (localhost:3777) / IPC   │
               ▼                               │
┌──────────────────────────────────────────────────────────────┐
│         agent-mem Background Daemon (Bun.serve)              │
│  ┌───────────────────────┐       ┌────────────────────────┐  │
│  │ Privacy & Redactor    │       │ Digest / Context Gen   │  │
│  └──────────┬────────────┘       └───────────▲────────────┘  │
│             ▼                                │               │
│  ┌───────────────────────────────────────────┴────────────┐  │
│  │                  SQLite + FTS5 Engine                  │  │
│  └───────────────────────────┬────────────────────────────┘  │
│                              │ SSE Stream                    │
│                              ▼                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │         Real-Time Web Viewer (http://localhost:3777)   │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### Component Breakdown
1. **Background Daemon (`agent-mem/src/daemon/server.ts`):** Lightweight HTTP server running on Bun (`Bun.serve`), listening on port 3777 (configurable). Handles ingestion endpoints, query APIs, SSE broadcasts, and static Web Viewer assets.
2. **Storage Engine (`agent-mem/src/db/`):** Backed by Bun's native SQLite (`bun:sqlite`). Stores structured entities and an FTS5 virtual table for lightning-fast keyword and full-text searches.
3. **Privacy Redactor (`agent-mem/src/privacy/redactor.ts`):** Pre-ingestion sanitizer stripping `<private>` tags and scrubbing credential patterns before database writes.
4. **Context Digest Generator (`agent-mem/src/context/digest.ts`):** Formats recent sessions and pending state into a concise markdown snippet suitable for direct session startup injection.
5. **Universal Hook CLI (`agent-mem/bin/agent-mem.ts`):** Subcommands (`hook`, `start`, `stop`, `search`, `get`, `ui`) providing a standardized bridge for any agent.
6. **Agent Skill (`skills/mem-search/SKILL.md`):** Portable skill definition teaching agents how and when to invoke `mem-search` and `mem-get`.
7. **Web Viewer UI (`agent-mem/src/ui/index.html`):** Self-contained, zero-npm-build web dashboard receiving SSE updates.

---

## 3. Storage & Database Schema

### Database Location & Scoping
- Default global database: `~/.agent-mem/mem.db`.
- Project scoping: Every project is keyed by a canonical identifier (`project_id`), derived from git root or working directory hash.
- Repository-local override: If `.agent-mem/mem.db` exists in the local project root, the daemon routes queries for that project to the local database file.

### SQLite Schema

```sql
-- Projects Table
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Sessions Table
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_type TEXT NOT NULL,          -- 'claude' | 'antigravity' | 'codex' | 'generic'
    title TEXT,
    summary TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active' -- 'active' | 'completed' | 'aborted'
);

-- Events Table (Raw stream)
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,          -- 'session_start' | 'user_prompt' | 'tool_call' | 'tool_result' | 'agent_response' | 'session_end'
    timestamp INTEGER NOT NULL,
    data TEXT NOT NULL                 -- JSON payload (sanitized)
);

-- Observations Table (Granular units with citation IDs)
CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,               -- e.g. 'obs_01hx...'
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                -- 'tool_execution' | 'file_edit' | 'decision' | 'test_run' | 'error'
    summary TEXT NOT NULL,             -- One-line summary
    content TEXT NOT NULL,             -- Full diff or output (sanitized)
    tokens_approx INTEGER NOT NULL,    -- Estimated token cost
    created_at INTEGER NOT NULL
);

-- Full-Text Search (FTS5) Table
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
    id UNINDEXED,
    session_id UNINDEXED,
    project_id UNINDEXED,
    summary,
    content,
    tokenize = 'porter unicode61'
);

-- Triggers for FTS consistency
CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(id, session_id, project_id, summary, content)
    VALUES (new.id, new.session_id, new.project_id, new.summary, new.content);
END;

CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, id, session_id, project_id, summary, content)
    VALUES ('delete', old.id, old.session_id, old.project_id, old.summary, old.content);
END;
```

---

## 4. Hook Lifecycle & Privacy Pipeline

### Hook Ingestion Events
The CLI provides `agent-mem hook <event>`:
- `session-start`:
  1. Checks if daemon is active on port 3777; if not, spawns `agent-mem daemon` detached.
  2. Creates a new session record in SQLite.
  3. Queries `GET /api/digest?project=<id>` and outputs the formatted **Compact Project Digest** to stdout.
- `user-prompt`:
  - Captures incoming user instructions and updates the session title if unset.
- `post-tool`:
  - Captures tool name, input arguments, exit codes, and stdout/stderr.
  - Sanitizes the payload and creates an `observation` with an auto-generated citation ID (`obs_xxxx`).
- `session-end`:
  - Marks session as completed and updates final session summary.

### Privacy Redactor Specification
1. **Explicit Tag Stripping:**
   - Any pattern matching `/<private>[\s\S]*?<\/private>/gi` is replaced with `[REDACTED_PRIVATE]`.
2. **Secret Masking:**
   - Detects API keys and tokens matching standard regex patterns (e.g., Anthropic `sk-ant-[a-zA-Z0-9_\-]{30,}`, OpenAI `sk-[a-zA-Z0-9]{32,}`, GitHub `ghp_[a-zA-Z0-9]{36}`, AWS access keys, JWTs, and `Authorization: Bearer ...`).
   - Masks matches with `[REDACTED_SECRET]`.
3. **Project Ignore Filter:**
   - Reads `.agent-mem/ignore` (glob patterns like `.env*`, `*.pem`, `id_rsa`) to skip persisting file contents when matching files are edited.

---

## 5. Progressive Disclosure & Context Retrieval

### Injected Startup Digest (Tier 1)
Delivered at `session-start`, ~150-200 tokens:
```markdown
=== AGENT-MEM: PROJECT MEMORY ===
Project: superpower-dual-agents | Live Viewer: http://localhost:3777/p/superpower-dual-agents
Recent Activity:
• [ses_01...] (claude, 2h ago): Implemented Bun SQLite migrations and tests
  Files touched: src/db/schema.ts, tests/db.test.ts (tests passing)
  Key observations: [obs_8a12] schema definition, [obs_8a13] test output
• [ses_01...] (antigravity, 30m ago): Added SSE live stream endpoint
  Files touched: src/server/sse.ts
Pending State / Last Known Context:
  - Working branch clean. Last test suite passed with 14 tests.
Tip: Search past observations with `mem-search <query>` or open the Live Viewer.
=================================
```

### Search Interface (Tier 2)
- Command: `bun run agent-mem/bin/agent-mem.ts search <query> [--limit 5]` (or skill `mem-search`)
- Queries `observations_fts` joined with `sessions` to return ranked results with token counts:
```
Found 2 matches for 'auth middleware':
1. [obs_8f12] (ses_01...) 2 hours ago | Type: file_edit
   Summary: Added JWT verification middleware to src/auth/guard.ts
   Cost: ~420 tokens | Command: mem-get obs_8f12
2. [obs_8f15] (ses_01...) 1 hour ago | Type: test_run
   Summary: Unit tests for expired token handling passed (5 tests)
   Cost: ~180 tokens | Command: mem-get obs_8f15
```

### Observation Retrieval (Tier 3)
- Command: `bun run agent-mem/bin/agent-mem.ts get <observation_id>` (or skill `mem-get`)
- Fetches the full raw observation content corresponding to the citation ID.

---

## 6. Real-Time Web Viewer UI

- **Endpoint:** `GET /` (and `/p/:projectId`).
- **Live Streaming:** Connects to `GET /api/stream` via SSE.
- **Features:**
  - **Live Stream View:** Real-time log of events, tool executions, and sessions across all active agents.
  - **Project Switcher:** Fast toggle between multiple projects.
  - **Session History:** Interactive timeline showing active vs completed sessions.
  - **Observation Drawer:** Modal/drawer displaying raw code diffs, command stdout, and token metrics.
  - **FTS Search Bar:** Instant client-side search query input querying `/api/search`.

---

## 7. Repository Layout & Integration

```
superpower-dual-agents/
├── plugin.json                 # Claude Code plugin descriptor
├── .claude-plugin/
│   └── hooks.json              # Plugin lifecycle hooks (session-start, post-tool, session-end)
├── skills/
│   ├── archive-handoff/
│   ├── project-context/
│   ├── setup/
│   └── mem-search/             # Memory search & citation inspection skill
│       └── SKILL.md
├── agent-mem/                  # Standalone Bun package in this repo
│   ├── package.json
│   ├── tsconfig.json
│   ├── README.md
│   ├── bin/
│   │   └── agent-mem.ts        # CLI entry point (start, stop, hook, search, get, ui)
│   ├── src/
│   │   ├── config.ts           # Config paths, default port 3777, token limits
│   │   ├── db/
│   │   │   ├── client.ts       # bun:sqlite connection & path resolution
│   │   │   ├── schema.ts       # SQLite DDL + FTS5 virtual tables
│   │   │   └── queries.ts      # Sessions, events, FTS search, and citation lookups
│   │   ├── daemon/
│   │   │   ├── server.ts       # Bun.serve HTTP API & router
│   │   │   ├── sse.ts          # SSE connection pool for live browser updates
│   │   │   └── lifecycle.ts    # Daemon supervisor, PID file, auto-spawn lock
│   │   ├── privacy/
│   │   │   └── redactor.ts     # <private> regex tag stripper and secret masking
│   │   ├── context/
│   │   │   └── digest.ts       # Compact Project Digest generator (handoff replacement)
│   │   └── ui/
│   │       └── index.html      # Embedded zero-build reactive Web Viewer with SSE
│   └── tests/
│       ├── redactor.test.ts    # Privacy tag stripping & secret masking tests
│       ├── db.test.ts          # SQLite FTS5 search & citation lookup tests
│       ├── digest.test.ts      # Compact digest formatting & token limits tests
│       └── server.test.ts      # HTTP API, hook ingestion, and SSE broadcast tests
├── tests/                      # Python agent-sync tests
└── docs/superpowers/specs/
    └── 2026-09-24-agent-mem-design.md
```

---

## 8. Error Handling & Edge Cases

1. **Port Collisions:** If port 3777 is occupied by another process, `agent-mem` checks if it is an existing daemon instance via `GET /api/health`. If occupied by an unrelated service, it increments to the next available port and persists the active port in `~/.agent-mem/worker.json`.
2. **Concurrent SQLite Access:** Bun's SQLite operates with WAL (Write-Ahead Logging) mode enabled (`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`) to ensure concurrent reads and writes from multiple hooks do not encounter locks.
3. **Token Overflow in Digest:** If a project has hundreds of past sessions, `digest.ts` enforces a strict ceiling (default 3 recent sessions and top 5 recent observations) to guarantee the digest never exceeds 250 tokens.
4. **Daemon Crash Resilience:** Hooks communicate via HTTP with a 500ms connection timeout; if the daemon fails to respond, hooks log the failure to a fallback append-only queue and gracefully exit without blocking the user's agent session.

---

## 9. Verification & Test Plan

1. **Unit Testing (`bun test` within `agent-mem/`):**
   - `redactor.test.ts`: Verify multi-line `<private>` tags, lowercase/uppercase variations, and sensitive tokens (API keys, passwords) are properly stripped.
   - `db.test.ts`: Validate table creation, session/event insertion, FTS5 search ranking, and trigger synchronization.
   - `digest.test.ts`: Test that digest outputs match formatting standards and strictly respect token boundaries.
   - `server.test.ts`: Verify `/api/hook`, `/api/search`, `/api/observations/:id`, and `/api/stream` SSE broadcasting.
2. **Dual-Environment Test Suite:**
   - Existing Python tests continue passing cleanly via `python3 -m unittest discover -s tests -p "test_*.py"`.
   - New Bun tests run via `cd agent-mem && bun test`.
3. **Integration Testing:**
   - Simulate a full session lifecycle: `session-start` -> `post-tool` -> `session-end`.
   - Verify citation lookup `agent-mem get <obs_id>` accurately returns the stored payload.
   - Verify the Web Viewer HTML renders received SSE messages in real-time.
