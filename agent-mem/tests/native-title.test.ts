import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findAntigravityTitle, findCodexTitle, resolveAgentTitle } from "../src/context/transcript";

describe("native agent title extraction", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `agent-mem-title-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("findAntigravityTitle", () => {
    it("reads title from annotations pbtxt file", () => {
      const annotationsDir = join(tempDir, "annotations");
      mkdirSync(annotationsDir, { recursive: true });
      writeFileSync(join(annotationsDir, "ses-123.pbtxt"), 'title:"Fix Memory Leak"\n');

      expect(findAntigravityTitle("ses-123", tempDir)).toBe("Fix Memory Leak");
    });

    it("falls back to conversation_summaries.db when pbtxt is missing", () => {
      const dbPath = join(tempDir, "conversation_summaries.db");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL);
        INSERT INTO conversation_summaries (conversation_id, title) VALUES ('ses-456', 'Refactor Parser');
      `);
      db.close();

      expect(findAntigravityTitle("ses-456", tempDir)).toBe("Refactor Parser");
    });

    it("returns undefined when session is not found", () => {
      expect(findAntigravityTitle("non-existent", tempDir)).toBeUndefined();
    });
  });

  describe("findCodexTitle", () => {
    it("reads thread_name from session_index.jsonl", () => {
      const indexFile = join(tempDir, "session_index.jsonl");
      writeFileSync(
        indexFile,
        JSON.stringify({ id: "codex-1", thread_name: "Add JWT Authentication" }) + "\n" +
        JSON.stringify({ id: "codex-2", thread_name: "Cleanup logs" }) + "\n"
      );

      expect(findCodexTitle("codex-1", tempDir)).toBe("Add JWT Authentication");
      expect(findCodexTitle("codex-2", tempDir)).toBe("Cleanup logs");
    });

    it("returns undefined when session is not in index", () => {
      const indexFile = join(tempDir, "session_index.jsonl");
      writeFileSync(indexFile, JSON.stringify({ id: "codex-1", thread_name: "Other" }) + "\n");

      expect(findCodexTitle("missing-id", tempDir)).toBeUndefined();
    });

    it("returns undefined when index file does not exist", () => {
      expect(findCodexTitle("codex-1", tempDir)).toBeUndefined();
    });
  });

  describe("resolveAgentTitle", () => {
    it("extracts title from Claude Code transcript JSONL", () => {
      const jsonl = JSON.stringify({ type: "ai-title", aiTitle: "Claude Task Title", sessionId: "c1" });
      expect(resolveAgentTitle("claude", "c1", jsonl)).toBe("Claude Task Title");
    });

    it("extracts title for Antigravity session from annotations", () => {
      const annotationsDir = join(tempDir, "annotations");
      mkdirSync(annotationsDir, { recursive: true });
      writeFileSync(join(annotationsDir, "agy-1.pbtxt"), 'title:"Antigravity Title"\n');

      expect(resolveAgentTitle("antigravity", "agy-1", undefined, { geminiDir: tempDir })).toBe("Antigravity Title");
    });

    it("extracts title for Codex session from session_index", () => {
      const indexFile = join(tempDir, "session_index.jsonl");
      writeFileSync(indexFile, JSON.stringify({ id: "codex-1", thread_name: "Codex Title" }) + "\n");

      expect(resolveAgentTitle("codex", "codex-1", undefined, { codexDir: tempDir })).toBe("Codex Title");
    });
  });
});
