import { Database } from "bun:sqlite";
import { getRecentObservations, getRecentSessions } from "../db/queries";
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

export function generateCompactDigest(
  db: Database,
  projectId: string,
  projectName: string,
  webViewerUrl: string = "http://localhost:3777"
): string {
  const config = getConfig();
  const sessions = getRecentSessions(db, projectId, config.maxRecentSessionsInDigest);
  const observations = getRecentObservations(db, projectId, 5);

  const base = webViewerUrl.replace(/\/+$/, "");
  const lines: string[] = [];
  lines.push("=== AGENT-MEM: PROJECT MEMORY ===");
  lines.push(`Project: ${projectName} | Live Viewer: ${base}/p/${projectId}`);

  if (sessions.length === 0) {
    lines.push("Recent Activity: No past recorded sessions yet. This session is the first recorded.");
  } else {
    lines.push("Recent Activity:");
    for (const session of sessions) {
      const timeStr = formatRelativeTime(session.startedAt);
      const desc = session.summary || session.title || "Working session";
      lines.push(`• [${session.id}] (${session.agentType}, ${timeStr}): ${desc}`);
    }

    if (observations.length > 0) {
      lines.push("Key Recent Observations:");
      for (const obs of observations) {
        lines.push(`  - [${obs.id}] (${obs.type}): ${obs.summary}`);
      }
    }
  }

  const cli = `bun run "${CLI_PATH}"`;
  lines.push(`Commands: Search past context with \`${cli} search <query>\` or retrieve citation with \`${cli} get <id>\`.`);
  lines.push("=================================");

  const fullDigest = lines.join("\n");
  return fullDigest;
}
