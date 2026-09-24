import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { openDatabase } from "../src/db/client";
import { initializeSchema } from "../src/db/schema";
import {
  getObservationById,
  getRecentObservations,
  getRecentSessions,
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
});
