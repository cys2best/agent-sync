import { Database } from "bun:sqlite";
import { classifyObservation } from "../context/classify";
import { extractFilePaths } from "../context/files";

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
  transcriptPath?: string;
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
  /** What the observation was for (request, change, finding, ...); inferred on insert when omitted. */
  kind?: string;
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
    INSERT INTO sessions (id, project_id, agent_type, title, summary, started_at, ended_at, status, transcript_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    session.id,
    session.projectId,
    session.agentType,
    session.title || null,
    session.summary || null,
    session.startedAt,
    session.endedAt || null,
    session.status || "active",
    session.transcriptPath || null
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
        status = COALESCE(?, status),
        transcript_path = COALESCE(?, transcript_path)
    WHERE id = ?
  `);
  stmt.run(
    updates.title ?? null,
    updates.summary ?? null,
    updates.endedAt ?? null,
    updates.status ?? null,
    updates.transcriptPath ?? null,
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

/** Returns false when an observation with the same id already exists. */
export function insertObservation(db: Database, obs: Observation): boolean {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO observations (id, session_id, project_id, type, summary, content, tokens_approx, created_at, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    obs.id,
    obs.sessionId,
    obs.projectId,
    obs.type,
    obs.summary,
    obs.content,
    obs.tokensApprox,
    obs.createdAt,
    obs.kind ?? classifyObservation(obs)
  );
  if (result.changes === 0) return false;
  indexObservationFiles(db, obs);
  return true;
}

/** Swap in a new version of an observation whose content changes over a session. */
export function replaceObservation(db: Database, obs: Observation): void {
  db.transaction(() => {
    db.prepare("DELETE FROM observations WHERE id = ?").run(obs.id);
    insertObservation(db, obs);
  })();
}

/** Record which files an observation mentions, so memory can be searched by file. */
export function indexObservationFiles(db: Database, obs: Pick<Observation, "id" | "projectId" | "summary" | "content">): void {
  const stmt = db.prepare("INSERT OR IGNORE INTO observation_files (observation_id, project_id, path) VALUES (?, ?, ?)");
  for (const path of extractFilePaths(`${obs.summary}\n${obs.content}`)) {
    stmt.run(obs.id, obs.projectId, path);
  }
}

export interface SearchFilters {
  type?: string;
  agent?: string;
  sessionId?: string;
  kind?: string;
  /** Only observations created at or after this epoch-millisecond timestamp. */
  since?: number;
  /** Only observations mentioning this file; a bare name or a longer path than the recorded one both match. */
  file?: string;
}

export type SearchResult = Observation & { agentType: string };

const OBSERVATION_COLUMNS = `o.id, o.session_id as sessionId, o.project_id as projectId, o.type,
           o.summary, o.content, o.tokens_approx as tokensApprox, o.created_at as createdAt, o.kind`;

// Either path may be the longer one: an absolute path was recorded and a relative one is asked for, or the reverse
const FILE_MATCH = `EXISTS (
      SELECT 1 FROM observation_files f
      WHERE f.observation_id = o.id
        AND (f.path = ?1 OR substr(f.path, -length(?1) - 1) = '/' || ?1 OR substr(?1, -length(f.path) - 1) = '/' || f.path)
    )`;

/** Ranked by relevance when there is a text query, otherwise newest first. */
function runSearch(db: Database, ftsQuery: string | undefined, projectId: string | undefined, limit: number, filters: SearchFilters): SearchResult[] {
  const conditions: [string, string | number | undefined][] = [
    ["observations_fts MATCH ?", ftsQuery],
    ["o.project_id = ?", projectId],
    ["o.type = ?", filters.type],
    ["o.kind = ?", filters.kind],
    ["s.agent_type = ?", filters.agent],
    ["o.session_id = ?", filters.sessionId],
    ["o.created_at >= ?", filters.since],
  ];
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  // The file is bound first because FILE_MATCH refers to it by position
  if (filters.file !== undefined) {
    clauses.push(FILE_MATCH);
    params.push(filters.file);
  }
  for (const [clause, value] of conditions) {
    if (value === undefined) continue;
    clauses.push(clause);
    params.push(value);
  }
  params.push(limit);

  const sql = `
    SELECT ${OBSERVATION_COLUMNS}, s.agent_type as agentType
    FROM observations o
    JOIN sessions s ON s.id = o.session_id
    ${ftsQuery === undefined ? "" : "JOIN observations_fts fts ON fts.id = o.id"}
    WHERE ${clauses.length > 0 ? clauses.join(" AND ") : "1"}
    ORDER BY ${ftsQuery === undefined ? "o.created_at DESC, o.rowid DESC" : "rank"}
    LIMIT ?
  `;
  return db.prepare(sql).all(...params) as SearchResult[];
}

export function searchObservations(
  db: Database,
  query: string,
  projectId?: string,
  limit: number = 10,
  filters: SearchFilters = {}
): SearchResult[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return filters.file === undefined ? [] : runSearch(db, undefined, projectId, limit, filters);
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) {
    const unquoted = trimmed.slice(1, -1).replace(/"/g, '""');
    return runSearch(db, `"${unquoted}"`, projectId, limit, filters);
  }

  const terms = trimmed
    .replace(/"/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"`);
  if (terms.length === 0) return [];

  const strict = runSearch(db, terms.join(" "), projectId, limit, filters);
  if (strict.length > 0 || terms.length === 1) return strict;
  // One word that appears nowhere should not hide everything else the query matches
  return runSearch(db, terms.join(" OR "), projectId, limit, filters);
}

export interface Timeline {
  anchor: Observation;
  before: Observation[];
  after: Observation[];
}

/** The observations recorded just before and after one observation in its session, oldest first. */
export function getTimeline(db: Database, id: string, before: number = 5, after: number = 5): Timeline | null {
  const anchor = db
    .prepare(`SELECT ${OBSERVATION_COLUMNS}, o.rowid as rowid FROM observations o WHERE o.id = ?`)
    .get(id) as (Observation & { rowid?: number }) | null;
  if (!anchor) return null;
  const { rowid, ...anchorObservation } = anchor;

  // rowid breaks ties between observations recorded in the same millisecond
  const neighbors = (comparison: "<" | ">", direction: "ASC" | "DESC", limit: number) =>
    db
      .prepare(`
        SELECT ${OBSERVATION_COLUMNS}
        FROM observations o
        WHERE o.session_id = ?
          AND (o.created_at ${comparison} ? OR (o.created_at = ? AND o.rowid ${comparison} ?))
        ORDER BY o.created_at ${direction}, o.rowid ${direction}
        LIMIT ?
      `)
      .all(anchor.sessionId, anchor.createdAt, anchor.createdAt, rowid ?? 0, limit) as Observation[];

  return {
    anchor: anchorObservation,
    before: neighbors("<", "DESC", before).reverse(),
    after: neighbors(">", "ASC", after),
  };
}

export function getObservationById(db: Database, id: string): Observation | null {
  const row = db.prepare(`SELECT ${OBSERVATION_COLUMNS} FROM observations o WHERE o.id = ?`).get(id) as any;
  return row ? (row as Observation) : null;
}

export function getRecentSessions(db: Database, projectId: string, limit: number = 3): Session[] {
  const rows = db.prepare(`
    SELECT id, project_id as projectId, agent_type as agentType,
           title, summary, started_at as startedAt, ended_at as endedAt, status,
           transcript_path as transcriptPath
    FROM sessions
    WHERE project_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(projectId, limit) as any[];

  return rows as Session[];
}

export function getRecentObservations(db: Database, projectId?: string, limit: number = 20): Observation[] {
  let sql = `SELECT ${OBSERVATION_COLUMNS} FROM observations o`;
  const params: any[] = [];
  if (projectId) {
    sql += " WHERE o.project_id = ?";
    params.push(projectId);
  }
  sql += " ORDER BY o.created_at DESC LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params) as Observation[];
}

export function getProjectTotals(db: Database, projectId: string) {
  const sessions = (db.prepare("SELECT COUNT(*) as count FROM sessions WHERE project_id = ?").get(projectId) as any)?.count || 0;
  const obs = db.prepare(
    "SELECT COUNT(*) as count, MAX(created_at) as lastAt FROM observations WHERE project_id = ?"
  ).get(projectId) as any;

  return {
    sessions,
    observations: obs?.count || 0,
    lastObservationAt: (obs?.lastAt as number | null) ?? null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete memory with no activity in the last `retentionDays`. Old observations and events go first;
 * a session or project is removed only once nothing recent remains under it, so resumed work survives.
 */
export function pruneOldData(db: Database, retentionDays: number, now: number = Date.now()) {
  const counts = { observations: 0, events: 0, sessions: 0, projects: 0 };
  if (retentionDays <= 0) return counts;
  const cutoff = now - retentionDays * DAY_MS;

  db.transaction(() => {
    // Count first: `changes` would also include the rows the FTS delete trigger removes
    counts.observations = (db.prepare("SELECT COUNT(*) as n FROM observations WHERE created_at < ?").get(cutoff) as any).n;
    db.prepare("DELETE FROM observations WHERE created_at < ?").run(cutoff);
    counts.events = db.prepare("DELETE FROM events WHERE timestamp < ?").run(cutoff).changes;
    counts.sessions = db
      .prepare(`
        DELETE FROM sessions
        WHERE started_at < ? AND COALESCE(ended_at, 0) < ?
          AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.session_id = sessions.id)
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = sessions.id)
      `)
      .run(cutoff, cutoff).changes;
    counts.projects = db
      .prepare("DELETE FROM projects WHERE updated_at < ? AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = projects.id)")
      .run(cutoff).changes;
  })();

  return counts;
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
