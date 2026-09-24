import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { createMemoryServer } from "../src/daemon/server";
import type { Server } from "bun";

describe("CLI entry point", () => {
  const cliPath = join(import.meta.dir, "../bin/agent-mem.ts");
  const testPort = 3998;
  let server: Server;

  beforeAll(() => {
    server = createMemoryServer({ port: testPort, dbPath: ":memory:" });
  });

  afterAll(() => {
    server.stop(true);
  });

  it("displays help when no arguments are provided", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(text).toContain("Usage: agent-mem");
    expect(text).toContain("daemon");
    expect(text).toContain("search");
    expect(text).toContain("hook");
    expect(text).toContain("get");
    expect(text).toContain("digest");
  });

  it("displays help with --help, -h, and help", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const proc = Bun.spawn(["bun", "run", cliPath, flag], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const text = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      expect(text).toContain("Usage: agent-mem");
    }
  });

  it("displays error on unknown command", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "unknown-cmd"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command: unknown-cmd");
  });

  it("fails when hook event is missing", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "hook"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Missing hook event name");
  });

  it("fails when search query is missing", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "search"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Provide a search query");
  });

  it("fails when get observation id is missing", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "get"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Provide observation ID");
  });

  it("executes session-start hook and outputs compact digest", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "hook", "session-start"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("=== AGENT-MEM: PROJECT MEMORY ===");
  });

  it("executes post-tool hook and records observation", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "hook",
        "post-tool",
        "--summary",
        "Refactored auth token logic",
        "export function verifyToken() { return true; }",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
      }
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Recorded observation [");
    expect(stdout).toContain("tokens)");
  });

  it("executes search command and formats results", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "search", "auth token"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("observation(s) for 'auth token'");
    expect(stdout).toContain("Refactored auth token logic");

    // Search with no matches
    const noMatchProc = Bun.spawn(["bun", "run", cliPath, "search", "nonexistentquery123"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
    });
    const noMatchStdout = await new Response(noMatchProc.stdout).text();
    const noMatchExit = await noMatchProc.exited;
    expect(noMatchExit).toBe(0);
    expect(noMatchStdout).toContain("No observations found matching 'nonexistentquery123'");
  });

  it("executes get command to retrieve observation content", async () => {
    // First search to get observation ID
    const searchProc = Bun.spawn(["bun", "run", cliPath, "search", "auth token"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
    });
    const searchStdout = await new Response(searchProc.stdout).text();
    const match = searchStdout.match(/\[(obs_[^\]]+)\]/);
    expect(match).not.toBeNull();
    const obsId = match![1];

    const getProc = Bun.spawn(["bun", "run", cliPath, "get", obsId], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
    });
    const getStdout = await new Response(getProc.stdout).text();
    const getExit = await getProc.exited;

    expect(getExit).toBe(0);
    expect(getStdout).toContain(`[${obsId}]`);
    expect(getStdout).toContain("verifyToken");

    // Non-existent observation
    const failProc = Bun.spawn(["bun", "run", cliPath, "get", "obs_nonexistent"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
    });
    const failStderr = await new Response(failProc.stderr).text();
    const failExit = await failProc.exited;

    expect(failExit).toBe(1);
    expect(failStderr).toContain("Request failed (404):");
    expect(failStderr).toContain("Observation not found");
  });

  it("handles HTTP error response when hook fails on server", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "hook", "invalid_event"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Request failed (400):");
    expect(stderr).toContain("Unknown event type");
  });

  it("executes digest command to print project memory digest", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "digest"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("=== AGENT-MEM: PROJECT MEMORY ===");
  });
});
