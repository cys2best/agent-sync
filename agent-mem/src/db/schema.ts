import { Database } from "bun:sqlite";
import { classifyObservation } from "../context/classify";
import { indexObservationFiles } from "./queries";

export function initializeSchema(db: Database): void {
  const hadFileIndex = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'observation_files'").get());

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_type TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      transcript_path TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      tokens_approx INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      kind TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project_started ON sessions(project_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_observations_project_created ON observations(project_id, created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      id UNINDEXED,
      session_id UNINDEXED,
      project_id UNINDEXED,
      summary,
      content,
      tokenize = 'porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(id, session_id, project_id, summary, content)
      VALUES (new.id, new.session_id, new.project_id, new.summary, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
      DELETE FROM observations_fts WHERE id = old.id;
    END;

    CREATE TABLE IF NOT EXISTS observation_files (
      observation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (observation_id, path)
    );

    CREATE TRIGGER IF NOT EXISTS observation_files_ad AFTER DELETE ON observations BEGIN
      DELETE FROM observation_files WHERE observation_id = old.id;
    END;
  `);

  // Observations recorded before the file index existed are indexed once, when the table first appears
  if (!hadFileIndex) {
    const rows = db.prepare("SELECT id, project_id as projectId, summary, content FROM observations").all() as any[];
    db.transaction(() => {
      for (const row of rows) indexObservationFiles(db, row);
    })();
  }

  // Databases created before transcript_path existed need the column added in place
  const sessionColumns = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
  if (!sessionColumns.includes("transcript_path")) {
    db.exec("ALTER TABLE sessions ADD COLUMN transcript_path TEXT");
  }

  // Databases created before kinds existed get the column, then every unclassified observation is classified once
  const observationColumns = (db.prepare("PRAGMA table_info(observations)").all() as { name: string }[]).map((c) => c.name);
  if (!observationColumns.includes("kind")) {
    db.exec("ALTER TABLE observations ADD COLUMN kind TEXT");
  }
  const unclassified = db.prepare("SELECT id, type, summary, content FROM observations WHERE kind IS NULL").all() as any[];
  if (unclassified.length > 0) {
    const setKind = db.prepare("UPDATE observations SET kind = ? WHERE id = ?");
    db.transaction(() => {
      for (const row of unclassified) setKind.run(classifyObservation(row), row.id);
    })();
  }
}
