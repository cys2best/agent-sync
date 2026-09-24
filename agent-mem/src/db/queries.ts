import { Database } from "bun:sqlite";

export interface Project {
  id: string;
  name: string;
  rootPath: string;
}

export interface Session {
  id: string;
  projectId: string;
  agentType: string;
  title?: string;
  summary?: string;
  startedAt: number;
  endedAt?: number;
  status: string;
}

export interface EventRecord {
  id: string;
  sessionId: string;
  projectId: string;
  eventType: string;
  timestamp: number;
  data: string;
}

export type Event = EventRecord;

export interface Observation {
  id: string;
  sessionId: string;
  projectId: string;
  type: string;
  summary: string;
  content: string;
  tokensApprox: number;
  createdAt: number;
}

export function upsertProject(db: Database, project: Project): void {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      root_path = excluded.root_path,
      updated_at = excluded.updated_at
  `);
  stmt.run(project.id, project.name, project.rootPath, now, now);
}

export function insertSession(db: Database, session: Session): void {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, project_id, agent_type, title, summary, started_at, ended_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    session.id,
    session.projectId,
    session.agentType,
    session.title || null,
    session.summary || null,
    session.startedAt,
    session.endedAt || null,
    session.status || "active"
  );
}

export function updateSession(db: Database, id: string, updates: Partial<Session>): void {
  const existing = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
  if (!existing) return;

  const stmt = db.prepare(`
    UPDATE sessions
    SET title = COALESCE(?, title),
        summary = COALESCE(?, summary),
        ended_at = COALESCE(?, ended_at),
        status = COALESCE(?, status)
    WHERE id = ?
  `);
  stmt.run(
    updates.title ?? null,
    updates.summary ?? null,
    updates.endedAt ?? null,
    updates.status ?? null,
    id
  );
}

export function insertEvent(db: Database, event: EventRecord): void {
  const stmt = db.prepare(`
    INSERT INTO events (id, session_id, project_id, event_type, timestamp, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    event.id,
    event.sessionId,
    event.projectId,
    event.eventType,
    event.timestamp,
    event.data
  );
}

export function insertObservation(db: Database, obs: Observation): void {
  const stmt = db.prepare(`
    INSERT INTO observations (id, session_id, project_id, type, summary, content, tokens_approx, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    obs.id,
    obs.sessionId,
    obs.projectId,
    obs.type,
    obs.summary,
    obs.content,
    obs.tokensApprox,
    obs.createdAt
  );
}

export function searchObservations(
  db: Database,
  query: string,
  projectId?: string,
  limit: number = 10
): Observation[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  let ftsQuery: string;
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) {
    const unquoted = trimmed.slice(1, -1).replace(/"/g, '""');
    ftsQuery = `"${unquoted}"`;
  } else {
    const terms = trimmed
      .replace(/"/g, "")
      .split(/\s+/)
      .filter(Boolean);
    ftsQuery = terms.length > 0 ? terms.map((t) => `"${t}"`).join(" ") : '""';
  }

  let sql = `
    SELECT o.id, o.session_id as sessionId, o.project_id as projectId, o.type,
           o.summary, o.content, o.tokens_approx as tokensApprox, o.created_at as createdAt
    FROM observations_fts fts
    JOIN observations o ON o.id = fts.id
    WHERE observations_fts MATCH ?
  `;
  const params: any[] = [ftsQuery];

  if (projectId) {
    sql += " AND o.project_id = ?";
    params.push(projectId);
  }

  sql += " ORDER BY rank LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params) as Observation[];
}

export function getObservationById(db: Database, id: string): Observation | null {
  const row = db.prepare(`
    SELECT id, session_id as sessionId, project_id as projectId, type,
           summary, content, tokens_approx as tokensApprox, created_at as createdAt
    FROM observations
    WHERE id = ?
  `).get(id) as any;
  return row ? (row as Observation) : null;
}

export function getRecentSessions(db: Database, projectId: string, limit: number = 3): Session[] {
  const rows = db.prepare(`
    SELECT id, project_id as projectId, agent_type as agentType,
           title, summary, started_at as startedAt, ended_at as endedAt, status
    FROM sessions
    WHERE project_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(projectId, limit) as any[];

  return rows as Session[];
}

export function getRecentObservations(db: Database, projectId?: string, limit: number = 20): Observation[] {
  let sql = `
    SELECT id, session_id as sessionId, project_id as projectId, type,
           summary, content, tokens_approx as tokensApprox, created_at as createdAt
    FROM observations
  `;
  const params: any[] = [];
  if (projectId) {
    sql += " WHERE project_id = ?";
    params.push(projectId);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params) as Observation[];
}

export function getStats(db: Database, projectId?: string) {
  let sessionSql = "SELECT COUNT(*) as count FROM sessions WHERE status = 'active'";
  let obsSql = "SELECT COUNT(*) as count FROM observations";
  const params: any[] = [];
  if (projectId) {
    sessionSql += " AND project_id = ?";
    obsSql += " WHERE project_id = ?";
    params.push(projectId);
  }
  const activeSessions = (db.prepare(sessionSql).get(...params) as any)?.count || 0;
  const totalObs = (db.prepare(obsSql).get(...params) as any)?.count || 0;
  const projects = db.prepare("SELECT id, name FROM projects ORDER BY updated_at DESC").all() as any[];

  return {
    activeSessions,
    totalObservations: totalObs,
    projects,
  };
}
