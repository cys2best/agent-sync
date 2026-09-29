import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createMemoryServer, startPruning } from "../src/daemon/server";
import { Database } from "bun:sqlite";
import { initializeSchema } from "../src/db/schema";
import { insertObservation, insertSession, upsertProject } from "../src/db/queries";
import { ensureDaemonRunning, isDaemonRunning, stopDaemon } from "../src/daemon/lifecycle";
import type { Server } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe("memory daemon HTTP server", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(() => {
    server = createMemoryServer({ port: 3888, dbPath: ":memory:" });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("prunes expired data as soon as pruning starts, and not at all when retention is 0", () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    upsertProject(db, { id: "p", name: "p", rootPath: "/p" });
    insertSession(db, { id: "s", projectId: "p", agentType: "claude", startedAt: Date.now(), status: "active" });
    insertObservation(db, {
      id: "ancient",
      sessionId: "s",
      projectId: "p",
      type: "t",
      summary: "old",
      content: "",
      tokensApprox: 1,
      createdAt: Date.now() - 400 * 24 * 60 * 60 * 1000,
    });

    expect(startPruning(db, 0)).toBeUndefined();
    expect(db.prepare("SELECT id FROM observations").get()).not.toBeNull();

    const timer = startPruning(db, 90);
    clearInterval(timer);
    expect(db.prepare("SELECT id FROM observations").get()).toBeNull();
    db.close();
  });

  it("responds to /health with ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.port).toBe(3888);

    const apiRes = await fetch(`${baseUrl}/api/health`);
    expect(apiRes.status).toBe(200);
    const apiBody = (await apiRes.json()) as any;
    expect(apiBody.status).toBe("ok");
  });

  it("handles CORS OPTIONS preflight", async () => {
    const res = await fetch(`${baseUrl}/api/hook`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("handles /api/hook session-start and returns compact digest", async () => {
    const res = await fetch(`${baseUrl}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "session-start",
        projectId: "proj_test",
        projectName: "test-app",
        agentType: "claude",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.digest).toContain("=== AGENT-MEM: PROJECT MEMORY ===");
    expect(body.sessionId).toBeDefined();
  });

  it("reuses the agent's session id so resume does not create a second session", async () => {
    const start = () =>
      fetch(`${baseUrl}/api/hook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "session-start", sessionId: "agent-ses-1", projectId: "proj_resume", agentType: "codex" }),
      });

    const first = await start();
    const second = await start();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await second.json()) as any).sessionId).toBe("agent-ses-1");

    const digest = ((await (await fetch(`${baseUrl}/api/digest?project=proj_resume`)).json()) as any).digest;
    expect(digest.match(/\[agent-ses-1\]/g)).toHaveLength(1);
  });

  it("stores a chat session summary and shows it in the digest", async () => {
    const res = await fetch(`${baseUrl}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "chat",
        sessionId: "agent-ses-2",
        projectId: "proj_summary",
        agentType: "codex",
        summary: "fix the login bug · edited guard.ts",
        messages: [{ key: "k1", role: "user", text: "fix the login bug", createdAt: Date.now() }],
      }),
    });
    expect(res.status).toBe(200);

    const digest = ((await (await fetch(`${baseUrl}/api/digest?project=proj_summary`)).json()) as any).digest;
    expect(digest).toContain("[agent-ses-2] (codex, just now): fix the login bug · edited guard.ts");
  });

  it("lists sessions with transcript paths and warns the next session about an interrupted one", async () => {
    const dir = join(import.meta.dir, "__notice_test__");
    mkdirSync(dir, { recursive: true });
    const transcriptPath = join(dir, "claude.jsonl");
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeFileSync(
      transcriptPath,
      [
        { type: "user", uuid: "u1", timestamp: old, message: { content: "final review" } },
        {
          type: "assistant",
          uuid: "a1",
          timestamp: old,
          isApiErrorMessage: true,
          error: "rate_limit",
          message: { content: [{ type: "text", text: "You've hit your session limit" }] },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")
    );
    const start = (sessionId: string, agentType: string, path?: string) =>
      fetch(`${baseUrl}/api/hook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "session-start", sessionId, projectId: "proj_notice", agentType, transcriptPath: path }),
      }).then((r) => r.json() as Promise<any>);

    try {
      await start("claude-limited", "claude", transcriptPath);
      const listed = (await (await fetch(`${baseUrl}/api/sessions?project=proj_notice`)).json()) as any;
      expect(listed.sessions[0]).toMatchObject({ id: "claude-limited", agentType: "claude", transcriptPath });

      const next = await start("codex-next", "codex");
      expect(next.digest).toContain("⚠ claude session claude-limited stopped: rate_limit");
      expect(next.digest).toContain("/agent-sync:resume");
      expect(next.summary).toContain("⚠ claude session claude-limited stopped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles /api/hook post-tool with private tag sanitization", async () => {
    const res = await fetch(`${baseUrl}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "post-tool",
        sessionId: "ses_test",
        projectId: "proj_test",
        toolName: "bash",
        summary: "Created secret key",
        content: "Result: <private>secret-value-1234</private>",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.observationId).toBeDefined();

    // Query observation to verify sanitization
    const getRes = await fetch(`${baseUrl}/api/observations/${body.observationId}`);
    const obs = (await getRes.json()) as any;
    expect(obs.content).toContain("[REDACTED_PRIVATE]");
    expect(obs.content).not.toContain("secret-value-1234");
  });

  it("handles /api/hook session-end and updates session status", async () => {
    const res = await fetch(`${baseUrl}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "session-end",
        sessionId: "ses_test",
        summary: "Completed test session",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
  });

  it("returns 400 for unknown hook event", async () => {
    const res = await fetch(`${baseUrl}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "non-existent-event",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("Unknown event type");
  });

  it("searches observations via /api/search", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=secret&project=proj_test`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].summary).toContain("Created secret key");

    // Guard against NaN or non-positive limit
    const nanRes = await fetch(`${baseUrl}/api/search?q=secret&project=proj_test&limit=notanumber`);
    expect(nanRes.status).toBe(200);
    const nanBody = (await nanRes.json()) as any;
    expect(nanBody.results.length).toBeGreaterThan(0);

    const negRes = await fetch(`${baseUrl}/api/search?q=secret&project=proj_test&limit=-5`);
    expect(negRes.status).toBe(200);
    const negBody = (await negRes.json()) as any;
    expect(negBody.results.length).toBeGreaterThan(0);
  });

  it("returns 404 for non-existent observation ID", async () => {
    const res = await fetch(`${baseUrl}/api/observations/obs_nonexistent`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toContain("not found");
  });

  it("returns project digest via /api/digest", async () => {
    const res = await fetch(`${baseUrl}/api/digest?project=proj_test&name=test-app`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.digest).toContain("=== AGENT-MEM: PROJECT MEMORY ===");
    expect(body.digest).toContain("test-app");
  });

  it("serves Web Viewer HTML on / and /p/:project", async () => {
    const resRoot = await fetch(`${baseUrl}/`);
    expect(resRoot.status).toBe(200);
    expect(resRoot.headers.get("Content-Type")).toContain("text/html");
    const htmlRoot = await resRoot.text();
    expect(htmlRoot).toContain("agent-mem");

    const resProj = await fetch(`${baseUrl}/p/proj_test`);
    expect(resProj.status).toBe(200);
    expect(resProj.headers.get("Content-Type")).toContain("text/html");
    const htmlProj = await resProj.text();
    expect(htmlProj).toContain("agent-mem");
  });

  it("establishes SSE stream on /api/stream", async () => {
    const res = await fetch(`${baseUrl}/api/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (reader) {
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain(": connected");
      reader.cancel();
    }
  });

  it("returns 404 for unknown endpoints", async () => {
    const res = await fetch(`${baseUrl}/unknown/route`);
    expect(res.status).toBe(404);
  });

  it("checks lifecycle supervisor status functions", async () => {
    const running = await isDaemonRunning(server.port);
    expect(running).toBe(true);

    const notRunning = await isDaemonRunning(59123);
    expect(notRunning).toBe(false);

    const activeUrl = await ensureDaemonRunning(server.port);
    expect(activeUrl).toBe(`http://127.0.0.1:${server.port}`);

    const stopped = await stopDaemon(59123);
    expect(stopped).toBe(false);
  });
});
