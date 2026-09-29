import { Database } from "bun:sqlite";

export function initializeSchema(db: Database): void {
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
      created_at INTEGER NOT NULL
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
  `);

  // Databases created before transcript_path existed need the column added in place
  const sessionColumns = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
  if (!sessionColumns.includes("transcript_path")) {
    db.exec("ALTER TABLE sessions ADD COLUMN transcript_path TEXT");
  }
}
