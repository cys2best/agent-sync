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

  it("keeps 90 days of data by default and honours AGENT_MEM_RETENTION_DAYS", () => {
    const original = process.env.AGENT_MEM_RETENTION_DAYS;
    try {
      delete process.env.AGENT_MEM_RETENTION_DAYS;
      expect(getConfig().retentionDays).toBe(90);
      process.env.AGENT_MEM_RETENTION_DAYS = "30";
      expect(getConfig().retentionDays).toBe(30);
      process.env.AGENT_MEM_RETENTION_DAYS = "not-a-number";
      expect(getConfig().retentionDays).toBe(90);
    } finally {
      if (original !== undefined) process.env.AGENT_MEM_RETENTION_DAYS = original;
      else delete process.env.AGENT_MEM_RETENTION_DAYS;
    }
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

  it("reads overrides from a settings file, ignoring invalid values, with env vars winning", () => {
    const dir = join(tmpdir(), `agent-mem-settings-${process.pid}`);
    const settingsPath = join(dir, "settings.json");
    const saved = { settings: process.env.AGENT_MEM_SETTINGS, port: process.env.AGENT_MEM_PORT, retention: process.env.AGENT_MEM_RETENTION_DAYS };
    mkdirSync(dir, { recursive: true });
    try {
      delete process.env.AGENT_MEM_PORT;
      delete process.env.AGENT_MEM_RETENTION_DAYS;
      process.env.AGENT_MEM_SETTINGS = settingsPath;

      // No file yet: defaults
      expect(getConfig().maxDigestTokens).toBe(250);
      expect(getConfig().maxRecentSessionsInDigest).toBe(3);

      writeFileSync(settingsPath, JSON.stringify({ port: 4555, maxDigestTokens: 600, maxRecentSessionsInDigest: -2, retentionDays: 0 }));
      const config = getConfig();
      expect(config.port).toBe(4555);
      expect(config.maxDigestTokens).toBe(600);
      expect(config.maxRecentSessionsInDigest).toBe(3);
      expect(config.retentionDays).toBe(0);

      process.env.AGENT_MEM_PORT = "4777";
      process.env.AGENT_MEM_RETENTION_DAYS = "14";
      expect(getConfig().port).toBe(4777);
      expect(getConfig().retentionDays).toBe(14);

      writeFileSync(settingsPath, "{ not json");
      expect(getConfig().maxDigestTokens).toBe(250);
    } finally {
      for (const [key, value] of [["AGENT_MEM_SETTINGS", saved.settings], ["AGENT_MEM_PORT", saved.port], ["AGENT_MEM_RETENTION_DAYS", saved.retention]] as const) {
        if (value !== undefined) process.env[key] = value;
        else delete process.env[key];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
