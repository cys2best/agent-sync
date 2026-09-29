import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type HookResult = "installed" | "unchanged";

function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    throw new Error(`Could not parse ${file}; fix or remove it, then rerun.`);
  }
}

function writeIfChanged(file: string, data: unknown): HookResult {
  const next = JSON.stringify(data, null, 2) + "\n";
  if (existsSync(file) && readFileSync(file, "utf-8") === next) return "unchanged";
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  return "installed";
}

export function installCodexHooks(hooksFile: string, binPath: string): HookResult {
  const existing = readJson(hooksFile);
  const hooks: Record<string, any[]> = existing.hooks ?? {};
  const command = (sub: string) => `bun run "${binPath}" hook ${sub} --agent codex --output-format codex`;
  const ours: Record<string, any> = {
    SessionStart: { matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: command("session-start"), timeout: 15 }] },
    Stop: { hooks: [{ type: "command", command: command("transcript"), timeout: 30 }] },
  };
  for (const [eventName, group] of Object.entries(ours)) {
    // Drop earlier agent-mem entries (any install path, so upgrades don't duplicate); keep everyone else's hooks
    const others = (hooks[eventName] ?? [])
      .map((g: any) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !/agent-mem\.ts"? hook /.test(String(h.command ?? ""))) }))
      .filter((g: any) => g.hooks.length > 0);
    hooks[eventName] = [...others, group];
  }
  existing.hooks = hooks;
  return writeIfChanged(hooksFile, existing);
}

export function installAntigravityHooks(hooksFile: string, binPath: string): HookResult {
  const existing = readJson(hooksFile);
  // Add or replace the "agent-mem" key, keep everything else
  existing["agent-mem"] = {
    PreInvocation: [{ type: "command", command: `bun run ${binPath} hook session-start --output-format antigravity`, timeout: 10 }],
    PostToolUse: [
      { matcher: "*", hooks: [{ type: "command", command: `bun run ${binPath} hook post-tool --output-format antigravity`, timeout: 10 }] },
    ],
    Stop: [{ type: "command", command: `bun run ${binPath} hook transcript --output-format antigravity`, timeout: 10 }],
  };
  return writeIfChanged(hooksFile, existing);
}
