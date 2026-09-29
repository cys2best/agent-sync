import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { installAntigravityHooks, installCodexHooks } from "./hooks";

export interface InstallOptions {
  root: string;
  home: string;
  only?: string;
  dryRun?: boolean;
}

export interface AgentResult {
  agent: string;
  status: "ok" | "skipped" | "failed";
  detail: string;
}

interface Ctx {
  root: string;
  home: string;
  dryRun: boolean;
  binPath: string;
  /** Read-only command: runs even in dry-run. */
  query(cmd: string[]): string;
  /** Changing command: printed instead of run in dry-run. */
  act(cmd: string[]): string;
}

interface Agent {
  name: string;
  detect(ctx: Ctx): boolean;
  install(ctx: Ctx): string[];
}

function exec(cmd: string[]): string {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${proc.stderr.toString().trim() || `exit ${proc.exitCode}`}`);
  }
  return proc.stdout.toString();
}

/** Point `link` at `root`; move a real directory there to ~/.agent-sync-backups first. */
function linkPlugin(ctx: Ctx, agent: string, link: string): string {
  let stat;
  try {
    stat = lstatSync(link);
  } catch {}
  if (stat && existsSync(link) && realpathSync(link) === ctx.root) return `${link} already links to ${ctx.root}`;
  if (ctx.dryRun) {
    const move = stat && !stat.isSymbolicLink() ? " (would move the existing directory to ~/.agent-sync-backups)" : "";
    return `would link ${link} -> ${ctx.root}${move}`;
  }
  mkdirSync(dirname(link), { recursive: true });
  let note = "";
  if (stat?.isSymbolicLink()) {
    unlinkSync(link);
  } else if (stat) {
    const backup = join(ctx.home, ".agent-sync-backups", `${agent}-${Date.now()}`);
    mkdirSync(dirname(backup), { recursive: true });
    renameSync(link, backup);
    note = ` (old copy moved to ${backup})`;
  }
  symlinkSync(ctx.root, link);
  return `linked ${link}${note}`;
}

function hooks(ctx: Ctx, file: string, installer: (file: string, binPath: string) => string): string {
  if (ctx.dryRun) return `would update hooks in ${file}`;
  return `hooks ${installer(file, ctx.binPath)} in ${file}`;
}

const agents: Agent[] = [
  {
    name: "claude",
    detect: () => Bun.which("claude") !== null,
    install(ctx) {
      const markets = JSON.parse(ctx.query(["claude", "plugin", "marketplace", "list", "--json"])) as { name: string }[];
      const hasMarket = markets.some((m) => m.name === "agent-sync");
      ctx.act(hasMarket ? ["claude", "plugin", "marketplace", "update", "agent-sync"] : ["claude", "plugin", "marketplace", "add", "cys2best/agent-sync"]);
      const plugins = JSON.parse(ctx.query(["claude", "plugin", "list", "--json"])) as { id: string }[];
      const hasPlugin = plugins.some((p) => p.id === "agent-sync@agent-sync");
      ctx.act(["claude", "plugin", hasPlugin ? "update" : "install", "agent-sync@agent-sync"]);
      if (ctx.dryRun) return [`would ${hasPlugin ? "update" : "install"} the plugin`];
      return [`plugin ${hasPlugin ? "updated" : "installed"} (restart Claude Code to load it)`];
    },
  },
  {
    name: "codex",
    detect: () => Bun.which("codex") !== null,
    install(ctx) {
      const listed = ctx
        .query(["codex", "plugin", "marketplace", "list"])
        .split("\n")
        .map((line) => line.match(/^agent-sync\s+(.+)$/)?.[1].trim())
        .find((path) => path !== undefined);
      if (listed !== undefined && listed !== ctx.root) ctx.act(["codex", "plugin", "marketplace", "remove", "agent-sync"]);
      if (listed !== ctx.root) ctx.act(["codex", "plugin", "marketplace", "add", ctx.root]);
      ctx.act(["codex", "plugin", "add", "agent-sync@agent-sync"]);
      const plugin = ctx.dryRun ? "would install the plugin from the checkout's committed HEAD" : "plugin installed from the checkout's committed HEAD";
      return [plugin, hooks(ctx, join(ctx.home, ".codex", "hooks.json"), installCodexHooks)];
    },
  },
  {
    name: "antigravity",
    detect: (ctx) => Bun.which("agy") !== null || existsSync(join(ctx.home, ".gemini", "config")),
    install(ctx) {
      const config = join(ctx.home, ".gemini", "config");
      return [linkPlugin(ctx, "antigravity", join(config, "plugins", "agent-sync")), hooks(ctx, join(config, "hooks.json"), installAntigravityHooks)];
    },
  },
  {
    name: "grok",
    detect: (ctx) => Bun.which("grok") !== null || existsSync(join(ctx.home, ".grok")),
    install: (ctx) => [linkPlugin(ctx, "grok", join(ctx.home, ".grok", "skills", "agent-sync"))],
  },
];

export const AGENTS: readonly string[] = agents.map((a) => a.name);

export function runInstall(opts: InstallOptions): AgentResult[] {
  const dryRun = opts.dryRun ?? false;
  const ctx: Ctx = {
    root: opts.root,
    home: opts.home,
    dryRun,
    binPath: join(opts.root, "agent-mem", "bin", "agent-mem.ts"),
    query: exec,
    act: (cmd) => (dryRun ? (console.log(`   would run: ${cmd.join(" ")}`), "") : exec(cmd)),
  };
  return agents
    .filter((a) => !opts.only || a.name === opts.only)
    .map((a): AgentResult => {
      if (!a.detect(ctx)) return { agent: a.name, status: "skipped", detail: "not found" };
      try {
        return { agent: a.name, status: "ok", detail: a.install(ctx).join("; ") };
      } catch (err) {
        return { agent: a.name, status: "failed", detail: (err as Error).message };
      }
    });
}
