import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { openDatabase } from "../src/db/client";
import { initializeSchema } from "../src/db/schema";
import {
  getObservationById,
  getRecentObservations,
  getRecentSessions,
  getTimeline,
  insertEvent,
  insertObservation,
  insertSession,
  pruneOldData,
  searchObservations,
  updateSession,
  upsertProject,
} from "../src/db/queries";

describe("database operations", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("initializes tables and creates project & session", () => {
    upsertProject(db, { id: "proj_1", name: "test-proj", rootPath: "/test/path" });
    insertSession(db, {
      id: "ses_1",
      projectId: "proj_1",
      agentType: "claude",
      title: "Initial setup",
      summary: "Completed setup task",
      startedAt: Date.now(),
      status: "active",
    });

    const sessions = getRecentSessions(db, "proj_1", 5);
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("ses_1");
    expect(sessions[0].agentType).toBe("claude");
  });

  it("indexes and searches observations using FTS5", () => {
    upsertProject(db, { id: "proj_1", name: "test-proj", rootPath: "/test/path" });
    insertSession(db, {
      id: "ses_1",
      projectId: "proj_1",
      agentType: "claude",
      startedAt: Date.now(),
      status: "active",
    });

    insertObservation(db, {
      id: "obs_01",
      sessionId: "ses_1",
      projectId: "proj_1",
      type: "file_edit",
      summary: "Added JWT token validator in auth.ts",
      content: "export function validateToken(token: string) { return true; }",
      tokensApprox: 35,
      createdAt: Date.now(),
    });

    insertObservation(db, {
      id: "obs_02",
      sessionId: "ses_1",
      projectId: "proj_1",
      type: "test_run",
      summary: "Database connection migration passed",
      content: "5 tests passed in db.test.ts",
      tokensApprox: 20,
      createdAt: Date.now(),
    });

    const searchResults = searchObservations(db, "JWT validator", "proj_1");
    expect(searchResults.length).toBe(1);
    expect(searchResults[0].id).toBe("obs_01");

    const single = getObservationById(db, "obs_01");
    expect(single).not.toBeNull();
    expect(single?.summary).toContain("JWT");
  });

  it("updates existing sessions", () => {
    upsertProject(db, { id: "proj_1", name: "test-proj", rootPath: "/test/path" });
    insertSession(db, {
      id: "ses_update",
      projectId: "proj_1",
      agentType: "codex",
      title: "Working on task",
      startedAt: 1000,
      status: "active",
    });

    updateSession(db, "ses_update", {
      title: "Finished task",
      summary: "Completed with tests",
      endedAt: 2000,
      status: "completed",
    });

    const sessions = getRecentSessions(db, "proj_1", 1);
    expect(sessions[0].title).toBe("Finished task");
    expect(sessions[0].summary).toBe("Completed with tests");
    expect(sessions[0].endedAt).toBe(2000);
    expect(sessions[0].status).toBe("completed");
  });

  it("stores a session transcript path and keeps it across updates", () => {
    upsertProject(db, { id: "proj_1", name: "p", rootPath: "/p" });
    insertSession(db, { id: "ses_t", projectId: "proj_1", agentType: "claude", startedAt: 1, status: "active", transcriptPath: "/t/a.jsonl" });
    updateSession(db, "ses_t", { summary: "s" });
    expect(getRecentSessions(db, "proj_1")[0].transcriptPath).toBe("/t/a.jsonl");

    updateSession(db, "ses_t", { transcriptPath: "/t/b.jsonl" });
    expect(getRecentSessions(db, "proj_1")[0].transcriptPath).toBe("/t/b.jsonl");
  });

  it("adds the transcript_path column to databases created before it existed", () => {
    const old = new Database(":memory:");
    old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_type TEXT NOT NULL,
      title TEXT, summary TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL DEFAULT 'active')`);
    initializeSchema(old);
    initializeSchema(old);
    const columns = (old.prepare("PRAGMA table_info(sessions)").all() as any[]).map((c) => c.name);
    expect(columns).toContain("transcript_path");
    old.close();
  });

  it("prunes data with no activity inside the retention window", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = 1_000 * DAY;
    const obs = (id: string, sessionId: string, age: number) =>
      insertObservation(db, {
        id,
        sessionId,
        projectId: "proj_1",
        type: "t",
        summary: `prunetoken ${id}`,
        content: "",
        tokensApprox: 1,
        createdAt: now - age * DAY,
      });
    upsertProject(db, { id: "proj_1", name: "p", rootPath: "/p" });
    insertSession(db, { id: "old", projectId: "proj_1", agentType: "claude", startedAt: now - 200 * DAY, status: "completed" });
    insertSession(db, { id: "old-but-resumed", projectId: "proj_1", agentType: "claude", startedAt: now - 200 * DAY, status: "active" });
    insertSession(db, { id: "old-but-ended-recently", projectId: "proj_1", agentType: "claude", startedAt: now - 200 * DAY, endedAt: now - 5 * DAY, status: "completed" });
    insertSession(db, { id: "recent", projectId: "proj_1", agentType: "codex", startedAt: now - 10 * DAY, status: "active" });
    obs("o_old", "old", 150);
    obs("o_resumed_old", "old-but-resumed", 150);
    obs("o_resumed_new", "old-but-resumed", 1);
    obs("o_recent", "recent", 10);
    insertEvent(db, { id: "e_old", sessionId: "recent", projectId: "proj_1", eventType: "x", timestamp: now - 120 * DAY, data: "{}" });
    insertEvent(db, { id: "e_new", sessionId: "recent", projectId: "proj_1", eventType: "x", timestamp: now - 1 * DAY, data: "{}" });
    upsertProject(db, { id: "proj_gone", name: "gone", rootPath: "/gone" });
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = 'proj_gone'").run(now - 100 * DAY);

    expect(pruneOldData(db, 0, now)).toEqual({ observations: 0, events: 0, sessions: 0, projects: 0 });
    expect(pruneOldData(db, 90, now)).toEqual({ observations: 2, events: 1, sessions: 1, projects: 1 });

    const sessions = (db.prepare("SELECT id FROM sessions ORDER BY id").all() as any[]).map((r) => r.id);
    expect(sessions).toEqual(["old-but-ended-recently", "old-but-resumed", "recent"]);
    const remaining = (db.prepare("SELECT id FROM observations ORDER BY id").all() as any[]).map((r) => r.id);
    expect(remaining).toEqual(["o_recent", "o_resumed_new"]);
    expect(searchObservations(db, "prunetoken").map((o) => o.id).sort()).toEqual(["o_recent", "o_resumed_new"]);
    expect(db.prepare("SELECT id FROM projects WHERE id = 'proj_gone'").get()).toBeNull();
  });

  it("retrieves recent observations ordered by createdAt DESC", () => {
    upsertProject(db, { id: "proj_1", name: "test-proj", rootPath: "/test/path" });
    insertSession(db, {
      id: "ses_1",
      projectId: "proj_1",
      agentType: "antigravity",
      startedAt: 1000,
      status: "active",
    });

    insertObservation(db, {
      id: "obs_old",
      sessionId: "ses_1",
      projectId: "proj_1",
      type: "note",
      summary: "Old note",
      content: "Old note content",
      tokensApprox: 10,
      createdAt: 1000,
    });

    insertObservation(db, {
      id: "obs_new",
      sessionId: "ses_1",
      projectId: "proj_1",
      type: "note",
      summary: "New note",
      content: "New note content",
      tokensApprox: 10,
      createdAt: 2000,
    });

    const recent = getRecentObservations(db, "proj_1", 10);
    expect(recent.length).toBe(2);
    expect(recent[0].id).toBe("obs_new");
    expect(recent[1].id).toBe("obs_old");
  });

  it("deletes observation and updates FTS index via trigger", () => {
    upsertProject(db, { id: "proj_1", name: "test-proj", rootPath: "/test/path" });
    insertSession(db, {
      id: "ses_1",
      projectId: "proj_1",
      agentType: "claude",
      startedAt: 1000,
      status: "active",
    });

    insertObservation(db, {
      id: "obs_del",
      sessionId: "ses_1",
      projectId: "proj_1",
      type: "note",
      summary: "Temporary ephemeral observation to delete",
      content: "Ephemeral content details",
      tokensApprox: 15,
      createdAt: 1000,
    });

    expect(searchObservations(db, "ephemeral", "proj_1").length).toBe(1);

    db.prepare("DELETE FROM observations WHERE id = ?").run("obs_del");

    expect(getObservationById(db, "obs_del")).toBeNull();
    expect(searchObservations(db, "ephemeral", "proj_1").length).toBe(0);
  });

  it("inserts and stores events", () => {
    upsertProject(db, { id: "proj_1", name: "test-proj", rootPath: "/test/path" });
    insertSession(db, {
      id: "ses_1",
      projectId: "proj_1",
      agentType: "claude",
      startedAt: 1000,
      status: "active",
    });

    insertEvent(db, {
      id: "evt_1",
      sessionId: "ses_1",
      projectId: "proj_1",
      eventType: "tool_call",
      timestamp: 1500,
      data: JSON.stringify({ tool: "view_file", path: "src/db/client.ts" }),
    });

    const row = db.prepare("SELECT * FROM events WHERE id = ?").get("evt_1") as any;
    expect(row).not.toBeNull();
    expect(row.event_type).toBe("tool_call");
    expect(row.timestamp).toBe(1500);
    expect(JSON.parse(row.data).tool).toBe("view_file");
  });

  it("openDatabase opens and initializes schema", () => {
    const memoryDb = openDatabase(":memory:");
    try {
      upsertProject(memoryDb, { id: "proj_mem", name: "memory-proj", rootPath: "/mem" });
      const row = memoryDb.prepare("SELECT * FROM projects WHERE id = ?").get("proj_mem") as any;
      expect(row).not.toBeNull();
      expect(row.name).toBe("memory-proj");
    } finally {
      memoryDb.close();
    }
  });

  it("enforces foreign keys and cascades deletions via openDatabase", () => {
    const memoryDb = openDatabase(":memory:");
    try {
      // Inserting session without existing project should fail foreign key constraint
      expect(() => {
        insertSession(memoryDb, {
          id: "ses_orphaned",
          projectId: "nonexistent_proj",
          agentType: "claude",
          startedAt: 1000,
          status: "active",
        });
      }).toThrow();

      // Create project, session, observation, event
      upsertProject(memoryDb, { id: "proj_fk", name: "fk-test", rootPath: "/fk/path" });
      insertSession(memoryDb, {
        id: "ses_fk",
        projectId: "proj_fk",
        agentType: "claude",
        startedAt: 1000,
        status: "active",
      });
      insertObservation(memoryDb, {
        id: "obs_fk",
        sessionId: "ses_fk",
        projectId: "proj_fk",
        type: "note",
        summary: "Cascade test note",
        content: "Content to cascade delete",
        tokensApprox: 10,
        createdAt: 1000,
      });
      insertEvent(memoryDb, {
        id: "evt_fk",
        sessionId: "ses_fk",
        projectId: "proj_fk",
        eventType: "message",
        timestamp: 1000,
        data: "{}",
      });

      expect(getRecentSessions(memoryDb, "proj_fk", 1).length).toBe(1);
      expect(getObservationById(memoryDb, "obs_fk")).not.toBeNull();

      // Deleting project should cascade delete sessions, observations, and events
      memoryDb.prepare("DELETE FROM projects WHERE id = ?").run("proj_fk");

      expect(getRecentSessions(memoryDb, "proj_fk", 1).length).toBe(0);
      expect(getObservationById(memoryDb, "obs_fk")).toBeNull();
      const eventRow = memoryDb.prepare("SELECT * FROM events WHERE id = ?").get("evt_fk");
      expect(eventRow).toBeNull();
    } finally {
      memoryDb.close();
    }
  });
});

describe("timeline and filtered search", () => {
  let db: Database;

  function obs(id: string, sessionId: string, createdAt: number, summary: string, type = "tool") {
    insertObservation(db, { id, sessionId, projectId: "p", type, summary, content: summary, tokensApprox: 1, createdAt });
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initializeSchema(db);
    upsertProject(db, { id: "p", name: "p", rootPath: "/p" });
    insertSession(db, { id: "s_claude", projectId: "p", agentType: "claude", startedAt: 1, status: "active" });
    insertSession(db, { id: "s_codex", projectId: "p", agentType: "codex", startedAt: 2, status: "active" });
  });

  afterEach(() => {
    db.close();
  });

  it("returns the observations around an anchor, oldest first, from its session only", () => {
    for (let i = 1; i <= 7; i++) obs(`a${i}`, "s_claude", i * 10, `step ${i}`);
    obs("other", "s_codex", 35, "unrelated session");

    const timeline = getTimeline(db, "a4", 2, 1);
    expect(timeline?.anchor.id).toBe("a4");
    expect(timeline?.before.map((o) => o.id)).toEqual(["a2", "a3"]);
    expect(timeline?.after.map((o) => o.id)).toEqual(["a5"]);
    expect(getTimeline(db, "missing")).toBeNull();
  });

  it("keeps insertion order for observations sharing a timestamp", () => {
    obs("t1", "s_claude", 100, "first");
    obs("t2", "s_claude", 100, "second");
    obs("t3", "s_claude", 100, "third");

    const timeline = getTimeline(db, "t2");
    expect(timeline?.before.map((o) => o.id)).toEqual(["t1"]);
    expect(timeline?.after.map((o) => o.id)).toEqual(["t3"]);
  });

  it("filters search by type, agent, session, and age, and reports the agent", () => {
    obs("c_old", "s_claude", 1000, "migrated the widget table", "user_prompt");
    obs("c_new", "s_claude", 5000, "widget table index added", "assistant_reply");
    obs("x_new", "s_codex", 6000, "widget table reviewed", "assistant_reply");

    const ids = (filters: Parameters<typeof searchObservations>[4]) =>
      searchObservations(db, "widget", "p", 10, filters).map((o) => o.id).sort();

    expect(ids({})).toEqual(["c_new", "c_old", "x_new"]);
    expect(ids({ type: "user_prompt" })).toEqual(["c_old"]);
    expect(ids({ agent: "codex" })).toEqual(["x_new"]);
    expect(ids({ sessionId: "s_claude" })).toEqual(["c_new", "c_old"]);
    expect(ids({ since: 4000 })).toEqual(["c_new", "x_new"]);
    expect(ids({ agent: "claude", since: 4000 })).toEqual(["c_new"]);

    expect(searchObservations(db, "widget", "p", 10, { agent: "codex" })[0].agentType).toBe("codex");
  });

  it("falls back to matching any term when no observation has them all", () => {
    obs("only_cache", "s_claude", 10, "tuned the cache eviction policy");
    obs("both", "s_claude", 20, "cache invalidation on logout");

    // Every term present somewhere: strict match wins, no widening
    expect(searchObservations(db, "cache logout", "p").map((o) => o.id)).toEqual(["both"]);
    // "zebra" appears nowhere: widen instead of returning nothing
    expect(searchObservations(db, "cache zebra", "p").map((o) => o.id).sort()).toEqual(["both", "only_cache"]);
    // A quoted phrase is never widened
    expect(searchObservations(db, '"cache zebra"', "p")).toEqual([]);
  });
});

describe("file index", () => {
  let db: Database;

  function obs(id: string, summary: string, content = "", createdAt = Date.now()) {
    insertObservation(db, { id, sessionId: "s", projectId: "p", type: "tool", summary, content, tokensApprox: 1, createdAt });
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initializeSchema(db);
    upsertProject(db, { id: "p", name: "p", rootPath: "/p" });
    insertSession(db, { id: "s", projectId: "p", agentType: "claude", startedAt: 1, status: "active" });
  });

  afterEach(() => {
    db.close();
  });

  it("finds observations by file, whichever of the two paths is the longer one", () => {
    obs("rel", "refactored src/db/queries.ts for speed", "", 1);
    obs("abs", "edit", '{"file_path":"/p/src/db/queries.ts"}', 2);
    obs("near_miss", "wrote src/db/other_queries.ts", "", 3);

    const byFile = (file: string, query = "") => searchObservations(db, query, "p", 10, { file }).map((o) => o.id);

    // No text query: newest first
    expect(byFile("src/db/queries.ts")).toEqual(["abs", "rel"]);
    expect(byFile("queries.ts")).toEqual(["abs", "rel"]);
    expect(byFile("/p/src/db/queries.ts")).toEqual(["abs", "rel"]);
    expect(byFile("other_queries.ts")).toEqual(["near_miss"]);
    // Combined with a text query
    expect(byFile("queries.ts", "speed")).toEqual(["rel"]);
    // Without a file or a query there is nothing to search for
    expect(searchObservations(db, "", "p")).toEqual([]);
  });

  it("drops a file's entries when its observation is deleted", () => {
    obs("gone", "touched src/app.ts");
    db.prepare("DELETE FROM observations WHERE id = ?").run("gone");
    expect((db.prepare("SELECT COUNT(*) as n FROM observation_files").get() as any).n).toBe(0);
  });

  it("indexes the files of observations recorded before the index existed", () => {
    obs("legacy", "patched lib/legacy.rb");
    db.exec("DROP TABLE observation_files");
    initializeSchema(db);
    expect(searchObservations(db, "", "p", 10, { file: "lib/legacy.rb" }).map((o) => o.id)).toEqual(["legacy"]);
  });
});

describe("observation kinds", () => {
  it("stores a kind for each observation and filters search by it", () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    upsertProject(db, { id: "p", name: "p", rootPath: "/p" });
    insertSession(db, { id: "s", projectId: "p", agentType: "claude", startedAt: 1, status: "active" });
    const add = (id: string, type: string, summary: string) =>
      insertObservation(db, { id, sessionId: "s", projectId: "p", type, summary, content: "", tokensApprox: 1, createdAt: 1 });
    add("ask", "user_prompt", "make the possum cache faster");
    add("why", "assistant_reply", "The root cause is the possum cache key");
    add("done", "assistant_reply", "possum cache is faster now");

    expect(getObservationById(db, "ask")?.kind).toBe("request");
    expect(searchObservations(db, "possum", "p", 10, { kind: "finding" }).map((o) => o.id)).toEqual(["why"]);
    expect(searchObservations(db, "possum", "p", 10, { kind: "finding" })[0].kind).toBe("finding");
    expect(getTimeline(db, "why")?.anchor.kind).toBe("finding");
    db.close();
  });

  it("classifies observations recorded before kinds existed", () => {
    const old = new Database(":memory:");
    old.exec(`CREATE TABLE observations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL, type TEXT NOT NULL,
      summary TEXT NOT NULL, content TEXT NOT NULL, tokens_approx INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    old.exec(`INSERT INTO observations VALUES ('legacy', 's', 'p', 'write_to_file', 'wrote a file', '', 1, 1)`);
    initializeSchema(old);
    initializeSchema(old);
    expect(getObservationById(old, "legacy")?.kind).toBe("change");
    old.close();
  });
});
