import type { Server } from "bun";
import { openDatabase } from "../db/client";
import {
  getObservationById,
  getRecentObservations,
  getRecentSessions,
  getStats,
  insertObservation,
  insertSession,
  searchObservations,
  updateSession,
  upsertProject,
} from "../db/queries";
import { sanitizePayload } from "../privacy/redactor";
import { estimateTokenCount, generateCompactDigest, generateUserSummary } from "../context/digest";
import { interruptionNotice } from "../context/handoff";
import { SSEHub, getWebUiHtml } from "./sse";
import { getConfig } from "../config";

function jsonResponse(data: any, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export function createMemoryServer(options?: { port?: number; dbPath?: string }): Server {
  const port = options?.port ?? getConfig().port;
  const db = openDatabase(options?.dbPath);
  const sseHub = new SSEHub();
  let uiHtml = "";
  try {
    uiHtml = getWebUiHtml();
  } catch {
    uiHtml = "<h1>agent-mem running</h1>";
  }

  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // CORS headers
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      // 1. Health check
      if (url.pathname === "/health" || url.pathname === "/api/health") {
        return jsonResponse({ status: "ok", port });
      }

      // 2. SSE Live Stream
      if (url.pathname === "/api/stream") {
        const client = sseHub.addClient();
        return client.response;
      }

      // 3. UI Dashboard
      if (url.pathname === "/" || url.pathname.startsWith("/p/")) {
        return new Response(uiHtml, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // 4. Hook Ingestion
      if (url.pathname === "/api/hook" && req.method === "POST") {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }

        const event = body?.event;

        if (event === "session-start") {
          const sessionId = body.sessionId || `ses_${Date.now().toString(36)}`;
          const projectId = body.projectId || "default";
          const projectName = body.projectName || projectId;
          const agentType = body.agentType || "unknown";

          upsertProject(db, {
            id: projectId,
            name: projectName,
            rootPath: body.rootPath || process.cwd(),
          });
          // Agents resend the same session id on resume/compact; reopen it instead of inserting a duplicate
          const isNew = !db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
          if (!isNew) {
            updateSession(db, sessionId, { status: "active", transcriptPath: body.transcriptPath });
          } else {
            insertSession(db, {
              id: sessionId,
              projectId,
              agentType,
              title: body.title,
              startedAt: Date.now(),
              status: "active",
              transcriptPath: body.transcriptPath,
            });
          }

          // Only the latest other session matters: that is the one being handed off from
          const previous = getRecentSessions(db, projectId, 5).find((s) => s.id !== sessionId && s.transcriptPath);
          const notice = previous ? interruptionNotice(previous) : undefined;
          const notices = notice ? [notice] : [];

          const digest = generateCompactDigest(db, projectId, projectName, `http://localhost:${port}`, notices);
          const summary = generateUserSummary(db, projectId, projectName, `http://localhost:${port}`, notices);
          sseHub.broadcast("session_start", { sessionId, projectId, agentType });

          return jsonResponse({ status: "ok", sessionId, isNew, digest, summary });
        }

        if (event === "post-tool") {
          const rawContent = body.content || "";
          const sanitized = sanitizePayload(rawContent);
          const obsId = body.id || `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          const tokensApprox = estimateTokenCount(sanitized.sanitized);
          const sessionId = body.sessionId || "default";
          const projectId = body.projectId || "default";

          // Ensure project and session exist for foreign key integrity
          upsertProject(db, {
            id: projectId,
            name: body.projectName || projectId,
            rootPath: body.rootPath || process.cwd(),
          });
          const existingSession = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
          if (!existingSession) {
            insertSession(db, {
              id: sessionId,
              projectId,
              agentType: body.agentType || "unknown",
              startedAt: Date.now(),
              status: "active",
            });
          }

          const observation = {
            id: obsId,
            sessionId,
            projectId,
            type: body.toolName || "tool_execution",
            summary: body.summary || "Tool execution",
            content: sanitized.sanitized,
            tokensApprox,
            createdAt: Date.now(),
          };

          insertObservation(db, observation);
          sseHub.broadcast("observation", observation);

          return jsonResponse({ status: "ok", observationId: obsId, tokensApprox });
        }

        if (event === "chat") {
          const sessionId = body.sessionId || "default";
          const projectId = body.projectId || "default";
          const messages: any[] = Array.isArray(body.messages) ? body.messages : [];

          upsertProject(db, {
            id: projectId,
            name: body.projectName || projectId,
            rootPath: body.rootPath || process.cwd(),
          });
          const existingSession = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
          if (!existingSession) {
            insertSession(db, {
              id: sessionId,
              projectId,
              agentType: body.agentType || "unknown",
              startedAt: Date.now(),
              status: "active",
            });
          }

          if ((typeof body.summary === "string" && body.summary) || body.transcriptPath) {
            updateSession(db, sessionId, { summary: body.summary || undefined, transcriptPath: body.transcriptPath });
          }

          let recorded = 0;
          for (const msg of messages) {
            if (typeof msg?.text !== "string" || !msg.text.trim()) continue;
            const sanitized = sanitizePayload(msg.text).sanitized;
            const oneLine = sanitized.replace(/\s+/g, " ").trim();
            const observation = {
              // Deterministic id so re-reading the same transcript never duplicates turns
              id: `chat_${sessionId}_${msg.key}`,
              sessionId,
              projectId,
              type: msg.role === "assistant" ? "assistant_reply" : "user_prompt",
              summary: oneLine.length > 200 ? oneLine.slice(0, 197) + "..." : oneLine,
              content: sanitized,
              tokensApprox: estimateTokenCount(sanitized),
              createdAt: typeof msg.createdAt === "number" ? msg.createdAt : Date.now(),
            };
            if (insertObservation(db, observation)) {
              recorded++;
              sseHub.broadcast("observation", observation);
            }
          }

          return jsonResponse({ status: "ok", recorded });
        }

        if (event === "session-end") {
          if (body.sessionId) {
            updateSession(db, body.sessionId, {
              endedAt: Date.now(),
              status: "completed",
              summary: body.summary,
            });
            sseHub.broadcast("session_end", { sessionId: body.sessionId });
          }
          return jsonResponse({ status: "ok" });
        }

        return jsonResponse({ error: "Unknown event type" }, 400);
      }

      // 4.5 Session list (for picking a session to resume)
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        const projectId = url.searchParams.get("project") || "default";
        const rawLimit = parseInt(url.searchParams.get("limit") || "10", 10);
        const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 10 : rawLimit;
        return jsonResponse({ sessions: getRecentSessions(db, projectId, limit) });
      }

      // 5. Search API
      if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q") || "";
        const projectId = url.searchParams.get("project") || undefined;
        const rawLimit = parseInt(url.searchParams.get("limit") || "10", 10);
        const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 10 : rawLimit;
        const results = searchObservations(db, q, projectId, limit);
        return jsonResponse({ results });
      }

      // 5.5 List Recent Observations
      if (url.pathname === "/api/observations" && req.method === "GET") {
        const projectId = url.searchParams.get("project") || undefined;
        const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10);
        const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 50 : rawLimit;
        const observations = getRecentObservations(db, projectId, limit);
        return jsonResponse({ observations });
      }

      // 5.6 Stats API
      if (url.pathname === "/api/stats") {
        const projectId = url.searchParams.get("project") || undefined;
        const stats = getStats(db, projectId);
        return jsonResponse(stats);
      }

      // 6. Observation by ID
      if (url.pathname.startsWith("/api/observations/")) {
        const id = url.pathname.replace("/api/observations/", "");
        if (!id) {
          return jsonResponse({ error: "Observation ID required" }, 400);
        }
        const obs = getObservationById(db, id);
        if (!obs) {
          return jsonResponse({ error: "Observation not found" }, 404);
        }
        return jsonResponse(obs);
      }

      // 7. Digest API
      if (url.pathname === "/api/digest") {
        const projectId = url.searchParams.get("project") || "default";
        const projectName = url.searchParams.get("name") || projectId;
        const digest = generateCompactDigest(db, projectId, projectName, `http://localhost:${port}`);
        return jsonResponse({ digest });
      }

      return jsonResponse({ error: "Not found" }, 404);
    },
  });
}
