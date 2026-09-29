import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const cliPath = join(import.meta.dir, "../bin/agent-mem.ts");
const root = realpathSync(resolve(import.meta.dir, "../.."));

// Fake claude/codex/agy: log each call, answer `list` queries from files in $FAKE_STATE, exit 1 when named in $FAKE_FAIL.
const FAKE = `#!/bin/bash
name=$(basename "$0")
echo "$name $*" >> "$FAKE_LOG"
[ "$FAKE_FAIL" = "$name" ] && { echo "boom" >&2; exit 1; }
case "$name $*" in
  "claude plugin marketplace list --json") [ -f "$FAKE_STATE/claude-mkt" ] && echo '[{"name":"agent-sync"}]' || echo '[]' ;;
  "claude plugin marketplace add"*) touch "$FAKE_STATE/claude-mkt" ;;
  "claude plugin list --json") [ -f "$FAKE_STATE/claude-plugin" ] && echo '[{"id":"agent-sync@agent-sync"}]' || echo '[]' ;;
  "claude plugin install"*) touch "$FAKE_STATE/claude-plugin" ;;
  "codex plugin marketplace list") echo "MARKETPLACE  ROOT"; [ -f "$FAKE_STATE/codex-mkt" ] && echo "agent-sync   $(cat "$FAKE_STATE/codex-mkt")" ;;
  "codex plugin marketplace add"*) echo "$4" > "$FAKE_STATE/codex-mkt" ;;
  "codex plugin marketplace remove"*) rm -f "$FAKE_STATE/codex-mkt" ;;
esac
exit 0
`;

let tmp: string, home: string, bin: string, state: string, log: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "agent-sync-install-")));
  home = join(tmp, "home");
  bin = join(tmp, "bin");
  state = join(tmp, "state");
  log = join(tmp, "calls.log");
  for (const d of [home, bin, state]) mkdirSync(d, { recursive: true });
  writeFileSync(log, "");
  for (const name of ["claude", "codex", "agy"]) {
    writeFileSync(join(bin, name), FAKE);
    chmodSync(join(bin, name), 0o755);
  }
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function install(args: string[] = [], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "run", cliPath, "install", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_LOG: log, FAKE_STATE: state, ...env },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr, calls: () => readFileSync(log, "utf-8").trim().split("\n").filter(Boolean) };
}

const codexHooks = () => join(home, ".codex", "hooks.json");
const geminiHooks = () => join(home, ".gemini", "config", "hooks.json");
const agyLink = () => join(home, ".gemini", "config", "plugins", "agent-sync");

describe("agent-mem install", () => {
  it("first run installs every detected agent and skips missing ones", async () => {
    const r = await install();
    expect(r.code).toBe(0);
    const calls = r.calls();
    expect(calls).toContain("claude plugin marketplace add cys2best/agent-sync");
    expect(calls).toContain("claude plugin install agent-sync@agent-sync");
    expect(calls).toContain(`codex plugin marketplace add ${root}`);
    expect(calls).toContain("codex plugin add agent-sync@agent-sync");
    expect(readFileSync(codexHooks(), "utf-8")).toContain(`${root}/agent-mem/bin/agent-mem.ts`);
    expect(readFileSync(geminiHooks(), "utf-8")).toContain(`${root}/agent-mem/bin/agent-mem.ts`);
    expect(lstatSync(agyLink()).isSymbolicLink()).toBe(true);
    expect(realpathSync(agyLink())).toBe(root);
    expect(r.stdout).toContain("⏭ grok");
  });

  it("second run changes nothing and updates instead of re-adding", async () => {
    await install();
    const codexBefore = readFileSync(codexHooks(), "utf-8");
    const geminiBefore = readFileSync(geminiHooks(), "utf-8");
    writeFileSync(log, "");
    const r = await install();
    expect(r.code).toBe(0);
    const calls = r.calls();
    expect(calls).toContain("claude plugin marketplace update agent-sync");
    expect(calls).toContain("claude plugin update agent-sync@agent-sync");
    expect(calls.filter((c) => c.startsWith("codex plugin marketplace add"))).toHaveLength(0);
    expect(calls).toContain("codex plugin add agent-sync@agent-sync");
    expect(readFileSync(codexHooks(), "utf-8")).toBe(codexBefore);
    expect(readFileSync(geminiHooks(), "utf-8")).toBe(geminiBefore);
    expect(realpathSync(agyLink())).toBe(root);
  });

  it("moves a stale Antigravity clone out of the plugins dir", async () => {
    mkdirSync(agyLink(), { recursive: true });
    writeFileSync(join(agyLink(), "marker"), "old");
    const r = await install(["--agent", "antigravity"]);
    expect(r.code).toBe(0);
    expect(lstatSync(agyLink()).isSymbolicLink()).toBe(true);
    const backups = readdirSync(join(home, ".agent-sync-backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toStartWith("antigravity-");
    expect(readFileSync(join(home, ".agent-sync-backups", backups[0], "marker"), "utf-8")).toBe("old");
    expect(readdirSync(dirname(agyLink()))).toEqual(["agent-sync"]);
  });

  it("keeps other tools' hooks", async () => {
    mkdirSync(dirname(codexHooks()), { recursive: true });
    mkdirSync(dirname(geminiHooks()), { recursive: true });
    writeFileSync(codexHooks(), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo keep-me" }] }] } }));
    writeFileSync(geminiHooks(), JSON.stringify({ other: { Stop: [] } }));
    expect((await install()).code).toBe(0);
    expect(readFileSync(codexHooks(), "utf-8")).toContain("echo keep-me");
    expect(JSON.parse(readFileSync(geminiHooks(), "utf-8")).other).toEqual({ Stop: [] });
  });

  it("reports a failing agent and still installs the rest", async () => {
    const r = await install([], { FAKE_FAIL: "claude" });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("✗ claude");
    expect(r.calls()).toContain("codex plugin add agent-sync@agent-sync");
    expect(existsSync(geminiHooks())).toBe(true);
  });

  it("fails an agent whose hooks.json is malformed and leaves it untouched", async () => {
    mkdirSync(dirname(geminiHooks()), { recursive: true });
    writeFileSync(geminiHooks(), "{ not json");
    const r = await install(["--agent", "antigravity"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("✗ antigravity");
    expect(r.stdout).toContain("Could not parse");
    expect(readFileSync(geminiHooks(), "utf-8")).toBe("{ not json");
  });

  it("re-points a Codex marketplace registered from another path", async () => {
    writeFileSync(join(state, "codex-mkt"), "/old/agent-sync\n");
    const r = await install(["--agent", "codex"]);
    expect(r.code).toBe(0);
    const calls = r.calls();
    expect(calls).toContain("codex plugin marketplace remove agent-sync");
    expect(calls).toContain(`codex plugin marketplace add ${root}`);
  });

  it("--dry-run changes nothing", async () => {
    const r = await install(["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("would ");
    expect(r.calls().every((c) => / list( --json)?$/.test(c))).toBe(true);
    expect(existsSync(codexHooks())).toBe(false);
    expect(existsSync(geminiHooks())).toBe(false);
    expect(existsSync(agyLink())).toBe(false);
  });

  it("--agent limits the run to one agent", async () => {
    const r = await install(["--agent", "codex"]);
    expect(r.code).toBe(0);
    expect(r.calls().some((c) => c.startsWith("claude"))).toBe(false);
    expect(existsSync(agyLink())).toBe(false);
  });

  it("rejects an unknown --agent", async () => {
    const r = await install(["--agent", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown agent");
  });
});
