import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createMemoryServer } from "../src/daemon/server";
import { getProjectId } from "../src/config";
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

  it("hook transcript uses Claude Code ai-title in the session summary and digest", async () => {
    const tmpDir = join(import.meta.dir, "__claude_title_test__");
    mkdirSync(tmpDir, { recursive: true });
    const transcriptPath = join(tmpDir, "session.jsonl");
    writeFileSync(
      transcriptPath,
      [
        { type: "user", uuid: "u1", message: { role: "user", content: "initial prompt" } },
        { type: "ai-title", aiTitle: "Refined Feature Goal", sessionId: "claude-ai-title-1" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")
    );

    try {
      const proc = Bun.spawn(["bun", "run", cliPath, "hook", "transcript", "--agent", "claude"], {
        stdin: new Blob([JSON.stringify({ session_id: "claude-ai-title-1", cwd: tmpDir, transcript_path: transcriptPath })]),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
      });
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);

      const res = await fetch(`http://127.0.0.1:${testPort}/api/digest?project=${getProjectId(tmpDir)}`);
      const digest = ((await res.json()) as any).digest;
      expect(digest).toContain("[claude-ai-title-1] (claude, just now): Refined Feature Goal");
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
    expect(stdout).toContain("AGENT-MEM: PROJECT MEMORY");

    const res = await fetch(`http://127.0.0.1:${testPort}/api/sessions?project=${getProjectId("/tmp/agent-mem-keep")}`);
    const ids = (((await res.json()) as any).sessions as any[]).map((s) => s.id);
    expect(ids).toContain("claude-ses-keep");
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

  it("setup --agent antigravity refuses to overwrite a malformed hooks.json", async () => {
    const tmpDir = join(import.meta.dir, "__setup_bad_antigravity__");
    const hooksFile = join(tmpDir, ".agents", "hooks.json");
    mkdirSync(join(tmpDir, ".agents"), { recursive: true });
    writeFileSync(hooksFile, "{ not json");
    try {
      const proc = Bun.spawn(["bun", "run", cliPath, "setup", "--agent", "antigravity", "--scope", "project"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: tmpDir,
      });
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(1);
      expect(stderr).toContain("Could not parse");
      expect(readFileSync(hooksFile, "utf-8")).toBe("{ not json");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("setup --agent codex leaves hooks.json byte-identical on rerun", async () => {
    const tmpDir = join(import.meta.dir, "__setup_codex_rerun__");
    const hooksFile = join(tmpDir, ".codex", "hooks.json");
    mkdirSync(tmpDir, { recursive: true });
    try {
      const run = async () => {
        const proc = Bun.spawn(["bun", "run", cliPath, "setup", "--agent", "codex", "--scope", "project"], {
          stdout: "pipe",
          stderr: "pipe",
          cwd: tmpDir,
        });
        expect(await proc.exited).toBe(0);
      };
      await run();
      const first = readFileSync(hooksFile, "utf-8");
      await run();
      expect(readFileSync(hooksFile, "utf-8")).toBe(first);
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
      expect(await run(["handoff", "claude-limited-cli", "--step", "@0"])).toContain("final review of numbatqueue branch");
      expect(await run(["handoff", "claude-limited-cli", "--grep", "reviewer"])).toContain("Reviewer found 2 issues");
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

  async function seedChat(projectDir: string, sessionId: string, agentType: string, messages: { key: string; role: string; text: string; createdAt: number }[]) {
    const res = await fetch(`http://127.0.0.1:${testPort}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "chat", projectId: getProjectId(projectDir), projectName: "seeded", sessionId, agentType, messages }),
    });
    expect(res.ok).toBe(true);
  }

  async function runCli(...cliArgs: string[]) {
    const proc = Bun.spawn(["bun", "run", cliPath, ...cliArgs], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { stdout, stderr, exitCode: await proc.exited };
  }

  it("timeline prints the steps around an observation and marks the anchor", async () => {
    const dir = "/tmp/agent-mem-cli-timeline";
    await seedChat(
      dir,
      "tl_ses",
      "claude",
      [1, 2, 3, 4, 5].map((n) => ({ key: `k${n}`, role: n % 2 ? "user" : "assistant", text: `timeline step number ${n}`, createdAt: n * 1000 }))
    );

    const { stdout, exitCode } = await runCli("timeline", "chat_tl_ses_k3", "--before", "1", "--after", "1");
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines[0]).toContain("session tl_ses");
    expect(lines.slice(1).map((l) => l.slice(0, 18))).toEqual(["  [chat_tl_ses_k2]", "→ [chat_tl_ses_k3]", "  [chat_tl_ses_k4]"]);
    expect(lines[2]).toContain("(request, user_prompt,");
    expect(lines[2]).toContain("timeline step number 3");

    const missing = await runCli("timeline", "obs_nonexistent");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("Request failed (404):");

    const noId = await runCli("timeline");
    expect(noId.exitCode).toBe(1);
    expect(noId.stderr).toContain("Provide observation ID");
  });

  it("search narrows results by agent, type, session, and age", async () => {
    const dir = "/tmp/agent-mem-cli-filters";
    const now = Date.now();
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
    await seedChat(dir, "flt_claude", "claude", [
      { key: "old", role: "user", text: "gizmo rollout planned", createdAt: tenDaysAgo },
      { key: "new", role: "assistant", text: "gizmo rollout shipped", createdAt: now },
    ]);
    await seedChat(dir, "flt_codex", "codex", [{ key: "rev", role: "assistant", text: "gizmo rollout reviewed", createdAt: now }]);

    const found = async (...flags: string[]) => {
      const { stdout, exitCode } = await runCli("search", "gizmo", "--project", dir, ...flags);
      expect(exitCode).toBe(0);
      return [...stdout.matchAll(/\[(chat_[^\]]+)\]/g)].map((m) => m[1]).sort();
    };

    expect(await found()).toEqual(["chat_flt_claude_new", "chat_flt_claude_old", "chat_flt_codex_rev"]);
    expect(await found("--agent", "codex")).toEqual(["chat_flt_codex_rev"]);
    expect(await found("--type", "user_prompt")).toEqual(["chat_flt_claude_old"]);
    expect(await found("--session", "flt_claude")).toEqual(["chat_flt_claude_new", "chat_flt_claude_old"]);
    expect(await found("--since", "2d")).toEqual(["chat_flt_claude_new", "chat_flt_codex_rev"]);
    expect(await found("--kind", "request")).toEqual(["chat_flt_claude_old"]);

    const badKind = await runCli("search", "gizmo", "--project", dir, "--kind", "bogus");
    expect(badKind.exitCode).toBe(1);
    expect(badKind.stderr).toContain("Invalid --kind 'bogus'");

    const { stdout } = await runCli("search", "gizmo", "--project", dir, "--agent", "codex");
    expect(stdout).toContain("[chat_flt_codex_rev] (reply, assistant_reply, codex, just now, ~");

    const bad = await runCli("search", "gizmo", "--project", dir, "--since", "yesterday");
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("Invalid --since");
  });

  it("get prints several observations and reports the ones it cannot find", async () => {
    const dir = "/tmp/agent-mem-cli-multiget";
    await seedChat(dir, "mg_ses", "claude", [
      { key: "a", role: "user", text: "first multiget body", createdAt: 1000 },
      { key: "b", role: "assistant", text: "second multiget body", createdAt: 2000 },
    ]);

    const both = await runCli("get", "chat_mg_ses_a", "chat_mg_ses_b");
    expect(both.exitCode).toBe(0);
    expect(both.stdout).toContain("first multiget body");
    expect(both.stdout).toContain("second multiget body");

    const partial = await runCli("get", "chat_mg_ses_a", "obs_nonexistent");
    expect(partial.exitCode).toBe(1);
    expect(partial.stdout).toContain("first multiget body");
    expect(partial.stderr).toContain("obs_nonexistent");
  });

  it("search --file lists what touched a file, including edits read from a Claude transcript", async () => {
    const tmpDir = join(import.meta.dir, "__file_search_test__");
    mkdirSync(tmpDir, { recursive: true });
    const transcriptPath = join(tmpDir, "session.jsonl");
    const edited = join(tmpDir, "src", "numbat.ts");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "tidy the burrow module" } }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: edited } }] },
        }),
      ].join("\n")
    );

    try {
      const hook = Bun.spawn(["bun", "run", cliPath, "hook", "transcript"], {
        stdin: new Blob([JSON.stringify({ session_id: "file-search-1", cwd: tmpDir, transcript_path: transcriptPath })]),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, AGENT_MEM_PORT: testPort.toString() },
      });
      expect(await hook.exited).toBe(0);

      const byFile = await runCli("search", "--file", "src/numbat.ts", "--project", tmpDir);
      expect(byFile.exitCode).toBe(0);
      expect(byFile.stdout).toContain("observation(s) for file 'src/numbat.ts'");
      expect(byFile.stdout).toContain("[files_file-search-1] (change, files_edited, claude,");

      const none = await runCli("search", "--file", "src/absent.ts", "--project", tmpDir);
      expect(none.stdout).toContain("No observations found");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("search prints a multi-line tool summary on one line", async () => {
    const dir = "/tmp/agent-mem-cli-oneline";
    const hook = await runCli("hook", "post-tool", "--project", dir, "--summary", "run_command(echidna\n  --flag)", "body");
    expect(hook.exitCode).toBe(0);

    const { stdout } = await runCli("search", "echidna", "--project", dir);
    expect(stdout.trim().split("\n")).toHaveLength(2);
    expect(stdout).toContain("run_command(echidna --flag)");
  });
});
