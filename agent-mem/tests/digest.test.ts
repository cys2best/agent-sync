import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { initializeSchema } from "../src/db/schema";
import { getConfig } from "../src/config";
import { insertObservation, insertSession, upsertProject } from "../src/db/queries";
import { estimateTokenCount, generateCompactDigest, generateUserSummary } from "../src/context/digest";

describe("compact digest generator", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeSchema(db);
    upsertProject(db, { id: "proj_demo", name: "superpower-dual-agents", rootPath: "/demo" });
  });

  afterEach(() => {
    db.close();
  });

  it("calculates approximate tokens based on character length", () => {
    const tokens = estimateTokenCount("Hello world! This is a simple test string.");
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(20);
    expect(estimateTokenCount("")).toBe(0);
  });

  it("generates structured markdown digest with citations and viewer url", () => {
    insertSession(db, {
      id: "ses_01",
      projectId: "proj_demo",
      agentType: "claude",
      title: "Scaffolded database",
      summary: "Implemented SQLite schema and initial queries",
      startedAt: Date.now() - 3600000,
      status: "completed",
    });

    insertObservation(db, {
      id: "obs_01",
      sessionId: "ses_01",
      projectId: "proj_demo",
      type: "file_edit",
      summary: "Created schema.ts with FTS5 support",
      content: "table definitions",
      tokensApprox: 25,
      createdAt: Date.now() - 3600000,
    });

    const digest = generateCompactDigest(db, "proj_demo", "superpower-dual-agents", "http://localhost:3777");
    expect(digest).toContain("=== AGENT-MEM: PROJECT MEMORY ===");
    expect(digest).toContain("Project: superpower-dual-agents");
    expect(digest).toContain("http://localhost:3777/p/proj_demo");
    expect(digest).toContain("claude");
    expect(digest).toContain("[obs_01]");
    expect(estimateTokenCount(digest)).toBeLessThan(250);
  });

  it("handles empty project memory gracefully", () => {
    const digest = generateCompactDigest(db, "proj_demo", "superpower-dual-agents");
    expect(digest).toContain("No past recorded sessions yet");
    expect(digest).toContain("http://localhost:3777/p/proj_demo");
  });

  it("summarizes an empty project for the user", () => {
    const summary = generateUserSummary(db, "proj_demo", "superpower-dual-agents", "http://localhost:3777");
    expect(summary).toContain("agent-mem · superpower-dual-agents");
    expect(summary).toContain("No memory yet");
    expect(summary).toContain("Live viewer: http://localhost:3777/p/proj_demo");
  });

  it("summarizes recorded memory totals for the user", () => {
    insertSession(db, {
      id: "ses_01",
      projectId: "proj_demo",
      agentType: "claude",
      startedAt: Date.now() - 7200000,
      status: "completed",
    });
    insertObservation(db, {
      id: "obs_01",
      sessionId: "ses_01",
      projectId: "proj_demo",
      type: "file_edit",
      summary: "Edited schema",
      content: "",
      tokensApprox: 5,
      createdAt: Date.now() - 7200000,
    });

    const summary = generateUserSummary(db, "proj_demo", "superpower-dual-agents", "http://localhost:3777");
    expect(summary).toContain("1 session · 1 observation · last activity 2h ago");
    expect(summary).not.toContain("No memory yet");
    expect(summary).toContain("/agent-sync:mem-search");
  });

  it("keeps the digest within the token budget as observations grow", () => {
    for (let i = 0; i < 50; i++) {
      insertObservation(db, {
        id: `obs_${i}`,
        sessionId: "ses_01",
        projectId: "proj_demo",
        type: "assistant_reply",
        summary: "x".repeat(200),
        content: "",
        tokensApprox: 50,
        createdAt: Date.now() - i * 1000,
      });
    }
    insertSession(db, { id: "ses_01", projectId: "proj_demo", agentType: "claude", startedAt: Date.now(), status: "active" });

    const digest = generateCompactDigest(db, "proj_demo", "superpower-dual-agents");
    expect(estimateTokenCount(digest)).toBeLessThanOrEqual(getConfig().maxDigestTokens);
    expect(digest).toContain("[obs_0]");
    expect(digest).toContain("search <query>");
  });

  it("prints runnable commands with the absolute CLI path", () => {
    const digest = generateCompactDigest(db, "proj_demo", "superpower-dual-agents");
    const cli = join(import.meta.dir, "..", "bin", "agent-mem.ts");
    expect(digest).toContain(`bun run "${cli}" search <query>`);
    expect(digest).toContain(`bun run "${cli}" get <id>`);
  });

  it("normalizes web viewer URLs by stripping trailing slashes", () => {
    const digest = generateCompactDigest(db, "proj_demo", "superpower-dual-agents", "http://localhost:3777///");
    expect(digest).toContain("Live Viewer: http://localhost:3777/p/proj_demo");
  });

  it("falls back to session title or default text when summary is missing", () => {
    insertSession(db, {
      id: "ses_title_only",
      projectId: "proj_demo",
      agentType: "codex",
      title: "Refactored queries",
      startedAt: Date.now() - 120000,
      status: "completed",
    });
    insertSession(db, {
      id: "ses_no_title",
      projectId: "proj_demo",
      agentType: "antigravity",
      startedAt: Date.now() - 86400000 * 2,
      status: "completed",
    });

    const digest = generateCompactDigest(db, "proj_demo", "superpower-dual-agents");
    expect(digest).toContain("[ses_title_only] (codex, 2m ago): Refactored queries");
    expect(digest).toContain("[ses_no_title] (antigravity, 2d ago): Working session");
  });
  it("leaves the current session out of recent activity so it lists past sessions only", () => {
    for (const [id, ago] of [["ses_a", 3], ["ses_b", 2], ["ses_c", 1]] as const) {
      insertSession(db, { id, projectId: "proj_demo", agentType: "codex", summary: `past ${id}`, startedAt: Date.now() - ago * 60000, status: "completed" });
    }
    insertSession(db, { id: "ses_now", projectId: "proj_demo", agentType: "codex", startedAt: Date.now(), status: "active" });

    const digest = generateCompactDigest(db, "proj_demo", "superpower-dual-agents", "http://localhost:3777", [], "ses_now");
    expect(digest).not.toContain("[ses_now]");
    expect(digest).toContain("[ses_a]");
    expect(digest).toContain("[ses_c]");
  });

  it("prioritizes sessions with summary or title ahead of empty stubs", () => {
    // Insert an older meaningful session
    insertSession(db, {
      id: "ses_meaningful",
      projectId: "proj_demo",
      agentType: "claude",
      title: "Implement feature X",
      summary: "Implement feature X · edited file.ts",
      startedAt: Date.now() - 3600000,
      status: "completed",
    });
    // Insert 3 newer empty stubs (e.g. rate limit queries or cancelled sessions)
    for (let i = 1; i <= 3; i++) {
      insertSession(db, {
        id: `ses_stub_${i}`,
        projectId: "proj_demo",
        agentType: "claude",
        startedAt: Date.now() - i * 60000,
        status: "active",
      });
    }

    const digest = generateCompactDigest(db, "proj_demo", "superpower-dual-agents");
    expect(digest).toContain("[ses_meaningful]");
    expect(digest).toContain("Implement feature X");
  });

  it("shows what was asked, changed, and learned ahead of newer exploration noise", () => {
    insertSession(db, { id: "ses_k", projectId: "proj_demo", agentType: "antigravity", startedAt: Date.now(), status: "completed" });
    const now = Date.now();
    const add = (id: string, type: string, summary: string, ageMs: number) =>
      insertObservation(db, { id, sessionId: "ses_k", projectId: "proj_demo", type, summary, content: "", tokensApprox: 1, createdAt: now - ageMs });
    add("ask", "user_prompt", "speed up the digest", 9000);
    add("edit", "replace_file_content", "replace_file_content(TargetFile=src/digest.ts)", 8000);
    add("why", "assistant_reply", "The root cause is an unbounded query", 7000);
    for (let i = 0; i < 8; i++) add(`look_${i}`, "view_file", `view_file(AbsolutePath=/repo/f${i}.ts)`, i * 100);

    const digest = generateCompactDigest(db, "proj_demo", "demo");
    const lines = digest.split("\n").filter((l) => l.startsWith("  - "));
    expect(lines.slice(0, 3)).toEqual([
      "  - [why] (finding): The root cause is an unbounded query",
      "  - [edit] (change): replace_file_content(TargetFile=src/digest.ts)",
      "  - [ask] (request): speed up the digest",
    ]);
  });

  it("still lists recent observations when none of them carry signal", () => {
    insertSession(db, { id: "ses_n", projectId: "proj_demo", agentType: "antigravity", startedAt: Date.now(), status: "completed" });
    insertObservation(db, { id: "look", sessionId: "ses_n", projectId: "proj_demo", type: "view_file", summary: "view_file(a.ts)", content: "", tokensApprox: 1, createdAt: Date.now() });
    expect(generateCompactDigest(db, "proj_demo", "demo")).toContain("  - [look] (exploration): view_file(a.ts)");
  });
});
