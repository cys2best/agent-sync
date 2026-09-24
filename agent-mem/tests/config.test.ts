import { describe, expect, it } from "bun:test";
import { getConfig, getProjectId, resolveDbPath } from "../src/config";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

describe("config module", () => {
  it("provides default configuration with required keys", () => {
    const config = getConfig();
    expect(config.port).toBe(3777);
    expect(config.globalDbPath).toBe(join(homedir(), ".agent-mem", "mem.db"));
    expect(config.maxDigestTokens).toBeGreaterThanOrEqual(150);
    expect(Array.isArray(config.secretPatterns)).toBe(true);
  });

  it("respects AGENT_MEM_PORT environment variable", () => {
    const originalPort = process.env.AGENT_MEM_PORT;
    try {
      process.env.AGENT_MEM_PORT = "4888";
      const config = getConfig();
      expect(config.port).toBe(4888);
    } finally {
      if (originalPort !== undefined) {
        process.env.AGENT_MEM_PORT = originalPort;
      } else {
        delete process.env.AGENT_MEM_PORT;
      }
    }
  });

  it("computes deterministic project id from root path", () => {
    const id1 = getProjectId("/Users/example/project-a");
    const id2 = getProjectId("/Users/example/project-a");
    const id3 = getProjectId("/Users/example/project-b");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
  });

  it("computes project id from cwd when projectRoot is omitted", () => {
    const id1 = getProjectId();
    const id2 = getProjectId(process.cwd());
    expect(id1).toBe(id2);
  });

  it("resolves global db path when local override is absent", () => {
    const dbPath = resolveDbPath("/nonexistent/path/for/test");
    expect(dbPath).toBe(join(homedir(), ".agent-mem", "mem.db"));
  });

  it("resolves global db path when projectRoot is omitted", () => {
    const dbPath = resolveDbPath();
    expect(dbPath).toBe(join(homedir(), ".agent-mem", "mem.db"));
  });

  it("resolves local db path when local override is present", () => {
    const tempDir = join(tmpdir(), `agent-mem-test-${Date.now()}`);
    const localDir = join(tempDir, ".agent-mem");
    const localDb = join(localDir, "mem.db");

    try {
      mkdirSync(localDir, { recursive: true });
      writeFileSync(localDb, "");

      const resolved = resolveDbPath(tempDir);
      expect(resolved).toBe(localDb);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
