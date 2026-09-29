import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("hook transcript records chat turns once from an Antigravity Stop payload", async () => {
    const tmpDir = join(import.meta.dir, "__transcript_test__");
    mkdirSync(tmpDir, { recursive: true });
    const transcriptPath = join(tmpDir, "transcript.jsonl");
    writeFileSync(
      transcriptPath,
      [
        { step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\nwhy is quokkadeploy failing\n</USER_REQUEST>" },
        { step_index: 1, type: "PLANNER_RESPONSE", content: "quokkadeploy needs a token refresh." },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")
    );

    const run = async () => {
      const proc = Bun.spawn(["bun", "run", cliPath, "hook", "transcript", "--output-format", "antigravity"], {
        stdin: new Blob([JSON.stringify({ conversationId: "conv-1", workspacePaths: [tmpDir], transcriptPath })]),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
      });
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      return stdout;
    };

    try {
      expect(JSON.parse(await run())).toEqual({ decision: "" });
      await run();

      const res = await fetch(`http://127.0.0.1:${testPort}/api/search?q=quokkadeploy`);
      const results = ((await res.json()) as any).results;
      expect(results.map((r: any) => r.type).sort()).toEqual(["assistant_reply", "user_prompt"]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("hook transcript reads the Claude Code transcript_path field", async () => {
    const tmpDir = join(import.meta.dir, "__claude_transcript_test__");
    mkdirSync(tmpDir, { recursive: true });
    const transcriptPath = join(tmpDir, "session.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "explain wombatcache eviction" } })
    );

    try {
      const proc = Bun.spawn(["bun", "run", cliPath, "hook", "transcript"], {
        stdin: new Blob([JSON.stringify({ session_id: "claude-1", cwd: tmpDir, transcript_path: transcriptPath })]),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
      });
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(stdout).toContain("Recorded 1 chat message(s)");

      const res = await fetch(`http://127.0.0.1:${testPort}/api/search?q=wombatcache`);
      const results = ((await res.json()) as any).results;
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("user_prompt");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("hook session-start keeps the agent's session id", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "hook", "session-start"], {
      stdin: new Blob([JSON.stringify({ session_id: "claude-ses-keep", cwd: "/tmp/agent-mem-keep" })]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("[claude-ses-keep]");
  });

  it("hook transcript summarizes a Codex session with --agent codex", async () => {
    const tmpDir = join(import.meta.dir, "__codex_transcript_test__");
    mkdirSync(tmpDir, { recursive: true });
    const transcriptPath = join(tmpDir, "rollout.jsonl");
    writeFileSync(
      transcriptPath,
      [
        { type: "response_item", payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "repair platypusqueue retries" }] } },
        { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/queue.ts\n*** End Patch" } },
        { type: "response_item", payload: { type: "message", id: "m2", role: "assistant", content: [{ type: "output_text", text: "Retries fixed." }] } },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")
    );

    try {
      const proc = Bun.spawn(["bun", "run", cliPath, "hook", "transcript", "--agent", "codex", "--output-format", "codex"], {
        stdin: new Blob([JSON.stringify({ session_id: "codex-ses-1", cwd: tmpDir, transcript_path: transcriptPath })]),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
      });
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(JSON.parse(stdout)).toEqual({});

      const start = Bun.spawn(["bun", "run", cliPath, "hook", "session-start", "--agent", "codex", "--output-format", "codex"], {
        stdin: new Blob([JSON.stringify({ session_id: "codex-ses-2", cwd: tmpDir })]),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
      });
      const parsed = JSON.parse(await new Response(start.stdout).text());
      expect(await start.exited).toBe(0);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(parsed.hookSpecificOutput.additionalContext).toContain(
        "[codex-ses-1] (codex, just now): repair platypusqueue retries · edited queue.ts"
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("setup --agent codex --scope project merges hooks into .codex/hooks.json", async () => {
    const tmpDir = join(import.meta.dir, "__setup_codex_workspace__");
    const hooksFile = join(tmpDir, ".codex", "hooks.json");
    mkdirSync(join(tmpDir, ".codex"), { recursive: true });
    const otherHook = { type: "command", command: "echo keep-me" };
    const staleHook = { type: "command", command: 'bun run "/old/0.7.0/agent-mem/bin/agent-mem.ts" hook session-start' };
    writeFileSync(hooksFile, JSON.stringify({ hooks: { SessionStart: [{ hooks: [otherHook, staleHook] }] } }));

    try {
      const run = async () => {
        const proc = Bun.spawn(["bun", "run", cliPath, "setup", "--agent", "codex", "--scope", "project"], {
          stdout: "pipe",
          stderr: "pipe",
          cwd: tmpDir,
        });
        const stdout = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        return stdout;
      };

      expect(await run()).toContain("Codex project hooks installed");
      await run();

      const hooks = JSON.parse(readFileSync(hooksFile, "utf-8")).hooks;
      const commands = (event: string) => hooks[event].flatMap((g: any) => g.hooks.map((h: any) => h.command));
      expect(commands("SessionStart")).toContain("echo keep-me");
      expect(commands("SessionStart").filter((c: string) => c.includes("agent-mem.ts"))).toHaveLength(1);
      expect(commands("SessionStart").find((c: string) => c.includes("agent-mem.ts"))).toContain(
        "hook session-start --agent codex --output-format codex"
      );
      expect(commands("Stop")).toHaveLength(1);
      expect(commands("Stop")[0]).toContain("hook transcript --agent codex --output-format codex");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sessions lists interrupted sessions and handoff prints where one stopped", async () => {
    const dir = join(import.meta.dir, "__handoff_cli_test__");
    mkdirSync(dir, { recursive: true });
    const transcriptPath = join(dir, "claude.jsonl");
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeFileSync(
      transcriptPath,
      [
        { type: "user", uuid: "u1", timestamp: old, message: { content: "final review of numbatqueue branch" } },
        { type: "assistant", uuid: "a1", timestamp: old, message: { content: [{ type: "text", text: "Reviewer found 2 issues; fixing issue 1." }] } },
        { type: "assistant", uuid: "a2", timestamp: old, message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/repo/q.ts" } }] } },
        {
          type: "assistant",
          uuid: "a3",
          timestamp: old,
          isApiErrorMessage: true,
          error: "rate_limit",
          message: { content: [{ type: "text", text: "You've hit your session limit" }] },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")
    );
    const env = { ...process.env, AGENT_MEM_PORT: testPort.toString() };
    const run = async (argv: string[], stdin?: object) => {
      const proc = Bun.spawn(["bun", "run", cliPath, ...argv], {
        cwd: dir,
        stdin: stdin ? new Blob([JSON.stringify(stdin)]) : undefined,
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      return out;
    };

    try {
      await run(["hook", "session-start"], { session_id: "claude-limited-cli", cwd: dir, transcript_path: transcriptPath });
      await run(["hook", "session-start", "--agent", "codex"], { session_id: "codex-now", cwd: dir });

      const list = await run(["sessions"]);
      expect(list).toMatch(/claude-limited-cli .*claude.*interrupted/);

      // With no id, handoff picks the most recent interrupted session
      const handoff = await run(["handoff"]);
      expect(handoff).toContain("=== AGENT-MEM HANDOFF: claude session claude-limited-cli ===");
      expect(handoff).toContain("Task (last prompt): final review of numbatqueue branch");
      expect(handoff).toContain("Reviewer found 2 issues; fixing issue 1.");
      expect(handoff).toContain("Files changed: /repo/q.ts");
      expect(await run(["handoff", "claude-limited-cli"])).toContain("rate_limit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handoff explains when there is nothing to resume", async () => {
    const dir = join(import.meta.dir, "__handoff_empty_test__");
    mkdirSync(dir, { recursive: true });
    try {
      const proc = Bun.spawn(["bun", "run", cliPath, "handoff"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out).toContain("No interrupted session found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("outputs antigravity JSON format with --output-format antigravity", async () => {
    // Simulate Antigravity PreInvocation stdin payload
    const stdinPayload = JSON.stringify({
      conversationId: "test-conv-123",
      workspacePaths: [process.cwd()],
    });

    const proc = Bun.spawn(
      ["bun", "run", cliPath, "hook", "session-start", "--output-format", "antigravity"],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: new Blob([stdinPayload]),
        env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
      }
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toHaveProperty("injectSteps");
    expect(Array.isArray(parsed.injectSteps)).toBe(true);
    expect(parsed.injectSteps.length).toBeGreaterThan(0);
    expect(parsed.injectSteps[0]).toHaveProperty("ephemeralMessage");
    expect(parsed.injectSteps[0].ephemeralMessage).toContain("=== AGENT-MEM: PROJECT MEMORY ===");
  });

  it("outputs Claude Code JSON with user summary via --output-format claude", async () => {
    const proc = Bun.spawn(
      ["bun", "run", cliPath, "hook", "session-start", "--output-format", "claude"],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: new Blob([JSON.stringify({ cwd: process.cwd() })]),
        env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
      }
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.systemMessage).toContain("agent-mem · ");
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("=== AGENT-MEM: PROJECT MEMORY ===");
  });

  it("injects the Antigravity digest once per conversation and links tool observations to it", async () => {
    const env = { ...process.env, AGENT_MEM_PORT: testPort.toString() };
    const hook = async (argv: string[], payload: object) => {
      const proc = Bun.spawn(["bun", "run", cliPath, "hook", ...argv, "--output-format", "antigravity"], {
        stdin: new Blob([JSON.stringify(payload)]),
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      return JSON.parse(out.trim());
    };
    const common = {
      conversationId: "agy-conv-once",
      workspacePaths: [process.cwd()],
      transcriptPath: "/tmp/agy/transcript.jsonl",
    };

    const first = await hook(["session-start"], { ...common, invocationNum: 0, initialNumSteps: 0 });
    expect(first.injectSteps[0].ephemeralMessage).toContain("=== AGENT-MEM: PROJECT MEMORY ===");

    const second = await hook(["session-start"], { ...common, invocationNum: 1, initialNumSteps: 4 });
    expect(second).toEqual({ injectSteps: [] });

    await hook(["post-tool"], { ...common, toolCall: { name: "run_command", args: { CommandLine: "echo kiwiprobe" } }, stepIdx: 5 });
    const results = ((await (await fetch(`http://127.0.0.1:${testPort}/api/search?q=kiwiprobe`)).json()) as any).results;
    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe("agy-conv-once");

    const sessions = ((await (await fetch(`http://127.0.0.1:${testPort}/api/sessions?project=${results[0].projectId}`)).json()) as any).sessions;
    expect(sessions.find((s: any) => s.id === "agy-conv-once")).toMatchObject({
      agentType: "antigravity",
      transcriptPath: "/tmp/agy/transcript.jsonl",
    });
  });

  it("shows setup in help text", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(text).toContain("setup");
  });

  it("setup --agent antigravity --scope project creates hooks.json", async () => {
    const tmpDir = join(import.meta.dir, "__setup_test_workspace__");
    const agentsDir = join(tmpDir, ".agents");
    mkdirSync(tmpDir, { recursive: true });

    try {
      const proc = Bun.spawn(
        ["bun", "run", cliPath, "setup", "--agent", "antigravity", "--scope", "project"],
        {
          stdout: "pipe",
          stderr: "pipe",
          cwd: tmpDir,
        }
      );
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Antigravity project hook installed");

      const hooksFile = join(agentsDir, "hooks.json");
      expect(existsSync(hooksFile)).toBe(true);

      const hooks = JSON.parse(readFileSync(hooksFile, "utf-8"));
      expect(hooks).toHaveProperty("agent-mem");
      expect(hooks["agent-mem"]).toHaveProperty("PreInvocation");
      expect(hooks["agent-mem"].PreInvocation[0].command).toContain("agent-mem.ts");
      expect(hooks["agent-mem"].PreInvocation[0].command).toContain("--output-format antigravity");
      expect(hooks["agent-mem"].Stop[0].command).toContain("hook transcript --output-format antigravity");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("setup --agent claude prints nested SessionStart and Stop hooks", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "setup", "--agent", "claude"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);

    const config = JSON.parse(stdout.slice(stdout.indexOf("{")));
    expect(config.hooks.SessionStart[0].hooks[0].command).toContain("hook session-start");
    expect(config.hooks.Stop[0].hooks[0].command).toContain("hook transcript");
  });
});
