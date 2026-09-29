import { Database } from "bun:sqlite";
import { getProjectTotals, getRecentObservations, getRecentSessions } from "../db/queries";
import { getConfig } from "../config";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "bin", "agent-mem.ts");

export function estimateTokenCount(text: string): number {
  // Standard heuristic: ~4 characters per token in English code & text
  return Math.ceil(text.length / 4);
}

function formatRelativeTime(timestamp: number): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

const MAX_LINE_CHARS = 120;

function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS - 3) + "..." : text;
}

export function generateCompactDigest(
  db: Database,
  projectId: string,
  projectName: string,
  webViewerUrl: string = "http://localhost:3777",
  notices: string[] = [],
  currentSessionId?: string
): string {
  const config = getConfig();
  // The session being started has nothing to report yet; list only past sessions
  const sessions = getRecentSessions(db, projectId, config.maxRecentSessionsInDigest + 1)
    .filter((s) => s.id !== currentSessionId)
    .slice(0, config.maxRecentSessionsInDigest);
  const observations = getRecentObservations(db, projectId, 5);

  const base = webViewerUrl.replace(/\/+$/, "");
  const head: string[] = [];
  head.push("=== AGENT-MEM: PROJECT MEMORY ===");
  head.push(`Project: ${projectName} | Live Viewer: ${base}/p/${projectId}`);
  head.push(...notices);

  if (sessions.length === 0) {
    head.push("Recent Activity: No past recorded sessions yet. This session is the first recorded.");
  } else {
    head.push("Recent Activity:");
    for (const session of sessions) {
      const timeStr = formatRelativeTime(session.startedAt);
      const desc = session.summary || session.title || "Working session";
      head.push(`• [${session.id}] (${session.agentType}, ${timeStr}): ${clip(desc)}`);
    }
  }

  const cli = `bun run "${CLI_PATH}"`;
  const tail = [
    `Commands: Search past context with \`${cli} search <query>\` or retrieve citation with \`${cli} get <id>\`.`,
    "=================================",
  ];

  // Observations fill whatever budget remains, newest first, so the digest never grows with history
  let used = estimateTokenCount([...head, ...tail].join("\n"));
  const obsHeader = "Key Recent Observations:";
  const obsLines: string[] = [];
  for (const obs of observations) {
    const line = `  - [${obs.id}] (${obs.type}): ${clip(obs.summary)}`;
    const cost = estimateTokenCount(line + "\n") + (obsLines.length === 0 ? estimateTokenCount(obsHeader + "\n") : 0);
    if (used + cost > config.maxDigestTokens) break;
    used += cost;
    obsLines.push(line);
  }

  const lines = obsLines.length > 0 ? [...head, obsHeader, ...obsLines, ...tail] : [...head, ...tail];

  const fullDigest = lines.join("\n");
  return fullDigest;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Short, user-facing status line shown in the terminal at session start
export function generateUserSummary(
  db: Database,
  projectId: string,
  projectName: string,
  webViewerUrl: string = "http://localhost:3777",
  notices: string[] = []
): string {
  const totals = getProjectTotals(db, projectId);
  const base = webViewerUrl.replace(/\/+$/, "");
  const lines: string[] = [`agent-mem · ${projectName}`, ...notices];

  if (totals.observations === 0 || totals.lastObservationAt === null) {
    lines.push("No memory yet. This session will seed it; later sessions get recent context injected automatically.");
  } else {
    lines.push(
      `${plural(totals.sessions, "session")} · ${plural(totals.observations, "observation")} · last activity ${formatRelativeTime(totals.lastObservationAt)}`
    );
    lines.push("Search past work: /agent-sync:mem-search");
  }
  lines.push(`Live viewer: ${base}/p/${projectId}`);

  return lines.join("\n");
}
