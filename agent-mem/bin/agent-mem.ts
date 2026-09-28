#!/usr/bin/env bun
import { createMemoryServer } from "../src/daemon/server";
import { extractEditedFiles, parseTranscript, summarizeSession } from "../src/context/transcript";
import { ensureDaemonRunning } from "../src/daemon/lifecycle";
import { getConfig, getProjectId } from "../src/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
Usage: agent-mem <command> [options]

Commands:
  daemon [--port <num>]          Run the persistent memory worker daemon
  hook <event> [options]         Trigger a lifecycle hook (session-start, post-tool, transcript, session-end)
  search <query> [--limit <n>]   Search project memory using SQLite FTS5
  get <observation-id>           Retrieve exact content of an observation
  digest                         Output the compact startup digest for this project
  setup [--agent <type>]         Install hooks for an agent (antigravity, claude, codex)
  help                           Show this help message

Options for hook:
  --output-format <fmt>          Output format: antigravity | claude | codex | raw (default: raw)
  --agent <type>                 Agent recording the session (default: antigravity when detected, else claude)
  --project <path>               Project path override

Options for setup:
  --agent <type>                 Agent type: antigravity (default), claude, codex
  --scope <scope>                Scope: global (default), project
`);
}

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

/**
 * Read stdin as JSON. Antigravity hooks send a JSON payload with
 * conversationId, workspacePaths, etc. We drain stdin to avoid hanging.
 */
async function readStdinJson(): Promise<Record<string, any>> {
  try {
    const input = await Bun.stdin.text();
    if (input.trim()) return JSON.parse(input);
  } catch {}
  return {};
}

function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

if (command === "daemon") {
  const portIndex = args.indexOf("--port");
  const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : getConfig().port;
  console.log(`Starting agent-mem daemon on port ${port}...`);
  createMemoryServer({ port });
  console.log(`agent-mem live Web Viewer running at: http://localhost:${port}`);
} else if (command === "hook") {
  const event = args[1];
  if (!event) {
    console.error("Missing hook event name (e.g. session-start, post-tool, session-end)");
    process.exit(1);
  }

  const outputFormat = getArgValue("--output-format") || "raw";

  // Read stdin — Antigravity hooks send JSON payload, must drain to avoid hanging
  const stdinData = await readStdinJson();

  // Resolve project path: prefer stdin workspacePaths (Antigravity) or cwd (Claude Code), then --project flag, then cwd
  const projectFlagPath = getArgValue("--project");
  const stdinProjectPath = stdinData.workspacePaths?.[0] || stdinData.cwd;
  const projectPath = stdinProjectPath || projectFlagPath || process.cwd();
  const projectId = getProjectId(projectPath);
  const projectName = projectPath.split("/").pop() || "project";

  const dataIndex = args.indexOf("--data");
  let dataObj: Record<string, any> = {};
  if (dataIndex !== -1 && args[dataIndex + 1]) {
    try {
      dataObj = JSON.parse(args[dataIndex + 1]);
    } catch (err) {
      console.error("Invalid JSON in --data:", err);
      process.exit(1);
    }
  }

  const serverUrl = await ensureDaemonRunning();

  // Antigravity sends conversationId; Claude Code and Codex send session_id
  const agentSessionId: string | undefined = stdinData.conversationId || stdinData.session_id;
  const agentType = getArgValue("--agent") || (stdinData.conversationId ? "antigravity" : process.env.AGENT_TYPE || "claude");

  if (event === "session-start") {
    const res = await fetch(`${serverUrl}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "session-start",
        sessionId: agentSessionId,
        projectId,
        projectName,
        agentType,
        ...dataObj,
      }),
    });
    if (!res.ok) {
      console.error(`Request failed (${res.status}): ${await res.text()}`);
      process.exit(1);
    }
    const data = (await res.json()) as any;

    if (outputFormat === "antigravity") {
      // Antigravity PreInvocation contract: output JSON with injectSteps
      const output = {
        injectSteps: [{ ephemeralMessage: data.digest }],
      };
      console.log(JSON.stringify(output));
    } else if (outputFormat === "claude" || outputFormat === "codex") {
      // Claude Code and Codex share this SessionStart contract: systemMessage is shown to the user, additionalContext goes to the model
      const output = {
        systemMessage: data.summary,
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: data.digest },
      };
      console.log(JSON.stringify(output));
    } else {
      console.log(data.digest);
    }
  } else if (event === "post-tool") {
    // Extract tool info from Antigravity PostToolUse stdin or CLI args
    const stdinToolCall = stdinData.toolCall || {};
    const stdinToolName = stdinToolCall.name || "";
    const stdinToolArgs = stdinToolCall.args || {};

    const summaryIndex = args.indexOf("--summary");
    let summary = dataObj.summary || (summaryIndex !== -1 ? args[summaryIndex + 1] : "");

    const toolIndex = args.indexOf("--tool");
    const toolName = stdinToolName || dataObj.toolName || (toolIndex !== -1 ? args[toolIndex + 1] : "tool");

    // Build a meaningful summary from tool call data when not provided via CLI
    if (!summary && stdinToolName) {
      const argSnippets: string[] = [];
      for (const [k, v] of Object.entries(stdinToolArgs)) {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        // Truncate long values
        argSnippets.push(`${k}=${val.length > 80 ? val.slice(0, 77) + "..." : val}`);
      }
      summary = `${stdinToolName}(${argSnippets.join(", ").slice(0, 200)})`;
    }
    if (!summary) summary = "Tool execution";

    let content = dataObj.content || "";
    if (!content && stdinToolName) {
      // Serialize tool call args as content for searchability
      content = JSON.stringify(stdinToolArgs).slice(0, 2000);
    }
    if (!content) {
      const contentTokens: string[] = [];
      for (let i = 2; i < args.length; i++) {
        if (
          args[i] === "--summary" ||
          args[i] === "--project" ||
          args[i] === "--data" ||
          args[i] === "--session" ||
          args[i] === "--tool" ||
          args[i] === "--output-format"
        ) {
          i++;
        } else {
          contentTokens.push(args[i]);
        }
      }
      content = contentTokens.join(" ");
    }

    const sessionIndex = args.indexOf("--session");
    const sessionId = dataObj.sessionId || (sessionIndex !== -1 ? args[sessionIndex + 1] : undefined);

    const res = await fetch(`${serverUrl}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "post-tool",
        projectId,
        sessionId,
        toolName,
        summary,
        content,
        ...dataObj,
      }),
    });
    if (!res.ok) {
      console.error(`Request failed (${res.status}): ${await res.text()}`);
      process.exit(1);
    }
    const data = (await res.json()) as any;

    if (outputFormat === "antigravity") {
      // PostToolUse contract: output empty JSON object
      console.log(JSON.stringify({}));
    } else {
      console.log(`Recorded observation [${data.observationId}] (~${data.tokensApprox} tokens)`);
    }
  } else if (event === "transcript") {
    // Stop hook: Antigravity sends transcriptPath/conversationId, Claude Code sends transcript_path/session_id
    const transcriptPath: string | undefined = stdinData.transcriptPath || stdinData.transcript_path;
    const sessionId = agentSessionId || dataObj.sessionId;

    let messages: ReturnType<typeof parseTranscript> = [];
    let editedFiles: string[] = [];
    if (transcriptPath) {
      // Antigravity truncates long fields in transcript.jsonl; transcript_full.jsonl keeps them intact
      const fullPath = join(dirname(transcriptPath), "transcript_full.jsonl");
      const source = transcriptPath.endsWith("/transcript.jsonl") && existsSync(fullPath) ? fullPath : transcriptPath;
      if (existsSync(source)) {
        const jsonl = readFileSync(source, "utf-8");
        messages = parseTranscript(jsonl);
        editedFiles = extractEditedFiles(jsonl);
      }
    }

    let recorded = 0;
    if (messages.length > 0) {
      const res = await fetch(`${serverUrl}/api/hook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "chat",
          projectId,
          projectName,
          sessionId,
          agentType,
          summary: summarizeSession(messages, editedFiles),
          messages,
        }),
      });
      if (!res.ok) {
        console.error(`Request failed (${res.status}): ${await res.text()}`);
        process.exit(1);
      }
      recorded = ((await res.json()) as any).recorded;
    }

    if (outputFormat === "antigravity") {
      // Stop contract: any decision other than "continue" lets the agent stop
      console.log(JSON.stringify({ decision: "" }));
    } else if (outputFormat === "codex") {
      // Codex requires a JSON object on stdout; an empty one lets the turn stop normally
      console.log("{}");
    } else {
      console.log(`Recorded ${recorded} chat message(s)`);
    }
  } else if (event === "session-end") {
    const sessionIndex = args.indexOf("--session");
    const sessionId = dataObj.sessionId || (sessionIndex !== -1 ? args[sessionIndex + 1] : undefined);
    const summaryIndex = args.indexOf("--summary");
    const summary = dataObj.summary || (summaryIndex !== -1 ? args[summaryIndex + 1] : undefined);

    const res = await fetch(`${serverUrl}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "session-end",
        sessionId,
        summary,
        ...dataObj,
      }),
    });
    if (!res.ok) {
      console.error(`Request failed (${res.status}): ${await res.text()}`);
      process.exit(1);
    }
    const data = (await res.json()) as any;
    console.log("Session ended");
  } else {
    const res = await fetch(`${serverUrl}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        projectId,
        projectName,
        ...dataObj,
      }),
    });
    if (!res.ok) {
      console.error(`Request failed (${res.status}): ${await res.text()}`);
      process.exit(1);
    }
    const data = (await res.json()) as any;
  }
} else if (command === "search") {
  const projectIndex = args.indexOf("--project");
  const projectPath = projectIndex !== -1 ? args[projectIndex + 1] : process.cwd();
  const projectId = getProjectId(projectPath);

  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex !== -1 ? args[limitIndex + 1] : undefined;

  const queryTokens: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--limit" || args[i] === "--project") {
      i++;
    } else if (!args[i].startsWith("--")) {
      queryTokens.push(args[i]);
    }
  }
  const query = queryTokens.join(" ");

  if (!query) {
    console.error("Provide a search query");
    process.exit(1);
  }

  const serverUrl = await ensureDaemonRunning();
  let searchUrl = `${serverUrl}/api/search?q=${encodeURIComponent(query)}&project=${projectId}`;
  if (limit) {
    searchUrl += `&limit=${encodeURIComponent(limit)}`;
  }
  const res = await fetch(searchUrl);
  if (!res.ok) {
    console.error(`Request failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  const data = (await res.json()) as any;
  const results = data.results || [];
  if (results.length === 0) {
    console.log(`No observations found matching '${query}'.`);
  } else {
    console.log(`Found ${results.length} observation(s) for '${query}':`);
    for (const r of results) {
      console.log(`• [${r.id}] (~${r.tokensApprox} tokens): ${r.summary}`);
    }
  }
} else if (command === "get") {
  const obsId = args[1];
  if (!obsId) {
    console.error("Provide observation ID");
    process.exit(1);
  }
  const serverUrl = await ensureDaemonRunning();
  const res = await fetch(`${serverUrl}/api/observations/${obsId}`);
  if (!res.ok) {
    console.error(`Request failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  const data = (await res.json()) as any;
  console.log(`[${data.id}] (${data.type}) ~${data.tokensApprox} tokens:`);
  console.log(data.content);
} else if (command === "digest") {
  const projectIndex = args.indexOf("--project");
  const projectPath = projectIndex !== -1 ? args[projectIndex + 1] : process.cwd();
  const projectId = getProjectId(projectPath);
  const projectName = projectPath.split("/").pop() || "project";

  const serverUrl = await ensureDaemonRunning();
  const res = await fetch(
    `${serverUrl}/api/digest?project=${encodeURIComponent(projectId)}&name=${encodeURIComponent(projectName)}`
  );
  if (!res.ok) {
    console.error(`Request failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  const data = (await res.json()) as any;
  console.log(data.digest);
} else if (command === "setup") {
  const agentType = getArgValue("--agent") || "antigravity";
  const scope = getArgValue("--scope") || "global";

  // Resolve absolute path to this CLI script
  const binPath = resolve(join(import.meta.dir, "agent-mem.ts"));

  if (agentType === "antigravity") {
    const hookEntry = {
      "agent-mem": {
        PreInvocation: [
          {
            type: "command",
            command: `bun run ${binPath} hook session-start --output-format antigravity`,
            timeout: 10,
          },
        ],
        PostToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: `bun run ${binPath} hook post-tool --output-format antigravity`,
                timeout: 10,
              },
            ],
          },
        ],
        Stop: [
          {
            type: "command",
            command: `bun run ${binPath} hook transcript --output-format antigravity`,
            timeout: 10,
          },
        ],
      },
    };

    if (scope === "global") {
      const configDir = join(homedir(), ".gemini", "config");
      const hooksFile = join(configDir, "hooks.json");

      let existing: Record<string, any> = {};
      if (existsSync(hooksFile)) {
        try {
          existing = JSON.parse(readFileSync(hooksFile, "utf-8"));
        } catch {
          console.error(`Warning: Could not parse existing ${hooksFile}, will merge carefully.`);
        }
      }

      // Merge: add/replace the "agent-mem" key, keep everything else
      existing["agent-mem"] = hookEntry["agent-mem"];

      mkdirSync(configDir, { recursive: true });
      writeFileSync(hooksFile, JSON.stringify(existing, null, 2) + "\n");
      console.log(`✅ Antigravity global hook installed at: ${hooksFile}`);
      console.log(`   Hook command: bun run ${binPath} hook session-start --output-format antigravity`);
      console.log(`\n   The agent-mem digest will be injected at the start of every Antigravity session.`);
    } else if (scope === "project") {
      const agentsDir = join(process.cwd(), ".agents");
      const hooksFile = join(agentsDir, "hooks.json");

      let existing: Record<string, any> = {};
      if (existsSync(hooksFile)) {
        try {
          existing = JSON.parse(readFileSync(hooksFile, "utf-8"));
        } catch {}
      }

      existing["agent-mem"] = hookEntry["agent-mem"];

      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(hooksFile, JSON.stringify(existing, null, 2) + "\n");
      console.log(`✅ Antigravity project hook installed at: ${hooksFile}`);
    } else {
      console.error(`Unknown scope: ${scope}. Use 'global' or 'project'.`);
      process.exit(1);
    }
  } else if (agentType === "claude") {
    const hook = (sub: string) => [{ hooks: [{ type: "command", command: `bun run ${binPath} hook ${sub}${sub === "session-start" ? " --output-format claude" : ""}` }] }];
    console.log(`Claude Code setup:`);
    console.log(`\nAdd the following to your ~/.claude/settings.json or project .claude/settings.json:\n`);
    console.log(JSON.stringify({ hooks: { SessionStart: hook("session-start"), Stop: hook("transcript") } }, null, 2));
  } else if (agentType === "codex") {
    const hooksFile =
      scope === "project" ? join(process.cwd(), ".codex", "hooks.json") : scope === "global" ? join(homedir(), ".codex", "hooks.json") : "";
    if (!hooksFile) {
      console.error(`Unknown scope: ${scope}. Use 'global' or 'project'.`);
      process.exit(1);
    }

    let existing: Record<string, any> = {};
    if (existsSync(hooksFile)) {
      try {
        existing = JSON.parse(readFileSync(hooksFile, "utf-8"));
      } catch {
        console.error(`Could not parse ${hooksFile}; fix or remove it, then rerun setup.`);
        process.exit(1);
      }
    }

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

    mkdirSync(dirname(hooksFile), { recursive: true });
    writeFileSync(hooksFile, JSON.stringify(existing, null, 2) + "\n");
    console.log(`✅ Codex ${scope} hooks installed at: ${hooksFile}`);
    console.log(`   SessionStart injects the project digest; Stop records the session transcript.`);
  } else {
    console.error(`Unknown agent type: ${agentType}. Supported: antigravity, claude, codex`);
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}
