import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AgentMemConfig {
  port: number;
  globalDbDir: string;
  globalDbPath: string;
  projectDbRelativePath: string;
  maxDigestTokens: number;
  maxRecentSessionsInDigest: number;
  /** Days of inactivity after which data is pruned; 0 keeps everything. */
  retentionDays: number;
  secretPatterns: RegExp[];
}

const DEFAULTS = { port: 3777, maxDigestTokens: 250, maxRecentSessionsInDigest: 3, retentionDays: 90 };

type Settings = typeof DEFAULTS;

const SETTING_MINIMUMS: Settings = { port: 1, maxDigestTokens: 1, maxRecentSessionsInDigest: 1, retentionDays: 0 };

/**
 * Defaults overridden by ~/.agent-mem/settings.json (or the file AGENT_MEM_SETTINGS names).
 * A missing or malformed file, and any value that is not a whole number in range, leaves the default in place.
 */
function loadSettings(globalDbDir: string): Settings {
  const settings = { ...DEFAULTS };
  let file: Record<string, unknown>;
  try {
    file = JSON.parse(readFileSync(process.env.AGENT_MEM_SETTINGS || join(globalDbDir, "settings.json"), "utf-8"));
  } catch {
    return settings;
  }
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const value = file?.[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= SETTING_MINIMUMS[key]) settings[key] = value;
  }
  return settings;
}

function parseRetentionDays(value: string | undefined, fallback: number): number {
  const days = Number(value);
  return value !== undefined && Number.isInteger(days) && days >= 0 ? days : fallback;
}

export function getConfig(): AgentMemConfig {
  const globalDbDir = join(homedir(), ".agent-mem");
  const settings = loadSettings(globalDbDir);
  return {
    port: process.env.AGENT_MEM_PORT ? parseInt(process.env.AGENT_MEM_PORT, 10) : settings.port,
    globalDbDir,
    globalDbPath: join(globalDbDir, "mem.db"),
    projectDbRelativePath: ".agent-mem/mem.db",
    maxDigestTokens: settings.maxDigestTokens,
    maxRecentSessionsInDigest: settings.maxRecentSessionsInDigest,
    retentionDays: parseRetentionDays(process.env.AGENT_MEM_RETENTION_DAYS, settings.retentionDays),
    secretPatterns: [
      /sk-ant-[a-zA-Z0-9_\-]{20,}/g,
      /sk-[a-zA-Z0-9]{30,}/g,
      /ghp_[a-zA-Z0-9]{30,}/g,
      /AKIA[0-9A-Z]{16}/g,
      /Bearer\s+[a-zA-Z0-9_\-\.]{25,}/gi,
    ],
  };
}

export function getProjectId(projectRoot?: string): string {
  const root = projectRoot ? resolve(projectRoot) : process.cwd();
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

export function resolveDbPath(projectRoot?: string): string {
  const config = getConfig();
  if (projectRoot) {
    const localDb = join(resolve(projectRoot), config.projectDbRelativePath);
    if (existsSync(localDb)) {
      return localDb;
    }
  }
  return config.globalDbPath;
}
