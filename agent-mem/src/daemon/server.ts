import type { Server } from "bun";
import { openDatabase } from "../db/client";
import {
  getObservationById,
  insertObservation,
  insertSession,
  searchObservations,
  updateSession,
  upsertProject,
} from "../db/queries";
import { sanitizePayload } from "../privacy/redactor";
import { estimateTokenCount, generateCompactDigest } from "../context/digest";
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
          insertSession(db, {
            id: sessionId,
            projectId,
            agentType,
            title: body.title,
            startedAt: Date.now(),
            status: "active",
          });

          const digest = generateCompactDigest(db, projectId, projectName, `http://localhost:${port}`);
          sseHub.broadcast("session_start", { sessionId, projectId, agentType });

          return jsonResponse({ status: "ok", sessionId, digest });
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

      // 5. Search API
      if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q") || "";
        const projectId = url.searchParams.get("project") || undefined;
        const limit = parseInt(url.searchParams.get("limit") || "10", 10);
        const results = searchObservations(db, q, projectId, limit);
        return jsonResponse({ results });
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
