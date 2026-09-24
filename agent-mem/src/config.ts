import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AgentMemConfig {
  port: number;
  globalDbDir: string;
  globalDbPath: string;
  projectDbRelativePath: string;
  maxDigestTokens: number;
  maxRecentSessionsInDigest: number;
  secretPatterns: RegExp[];
}

export function getConfig(): AgentMemConfig {
  const globalDbDir = join(homedir(), ".agent-mem");
  return {
    port: parseInt(process.env.AGENT_MEM_PORT || "3777", 10),
    globalDbDir,
    globalDbPath: join(globalDbDir, "mem.db"),
    projectDbRelativePath: ".agent-mem/mem.db",
    maxDigestTokens: 250,
    maxRecentSessionsInDigest: 3,
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
