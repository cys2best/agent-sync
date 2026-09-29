import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { openDatabase } from "../src/db/client";
import { initializeSchema } from "../src/db/schema";
import {
  getObservationById,
  getRecentObservations,
  getRecentSessions,
  insertEvent,
  insertObservation,
  insertSession,
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
