import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../install.sh");
const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
};

let tmp: string, src: string, dest: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "agent-sync-sh-")));
  src = join(tmp, "src");
  dest = join(tmp, "dest");
  mkdirSync(join(src, "agent-mem", "bin"), { recursive: true });
  // Stub CLI: prints its args so the test sees what install.sh ran
  writeFileSync(join(src, "agent-mem", "bin", "agent-mem.ts"), `console.log("stub " + process.argv.slice(2).join(" "));\n`);
  writeFileSync(join(src, "VERSION"), "1\n");
  git(src, "init", "-q");
  git(src, "add", "-A");
  git(src, "commit", "-qm", "v1");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function runScript(args: string[] = [], path = `${dirname(process.execPath)}:/usr/bin:/bin`) {
  const proc = Bun.spawn(["/bin/bash", script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { HOME: tmp, PATH: path, AGENT_SYNC_REPO: src, AGENT_SYNC_HOME: dest },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr };
}

describe("install.sh", () => {
  it("clones on first run and passes args to agent-mem install", async () => {
    const r = await runScript(["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("stub install --dry-run");
    expect(readFileSync(join(dest, "VERSION"), "utf-8")).toBe("1\n");
  });

  it("pulls on rerun", async () => {
    await runScript();
    writeFileSync(join(src, "VERSION"), "2\n");
    git(src, "commit", "-qam", "v2");
    const r = await runScript();
    expect(r.code).toBe(0);
    expect(readFileSync(join(dest, "VERSION"), "utf-8")).toBe("2\n");
  });

  it("warns and keeps going when the checkout has local changes", async () => {
    await runScript();
    writeFileSync(join(dest, "VERSION"), "local\n");
    const r = await runScript();
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("local changes");
    expect(r.stdout).toContain("stub install");
    expect(readFileSync(join(dest, "VERSION"), "utf-8")).toBe("local\n");
  });

  it("stops when bun is missing", async () => {
    const r = await runScript([], "/usr/bin:/bin");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("bun is required");
  });

  it("stops when the home exists but is not a git checkout", async () => {
    mkdirSync(dest);
    const r = await runScript();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a git checkout");
  });
});
