#!/usr/bin/env bun
import { createMemoryServer } from "../src/daemon/server";
import { extractEditedFiles, parseTranscript, resolveAgentTitle, summarizeSession } from "../src/context/transcript";
import { grepSteps, loadHandoff, parseEvents, readTranscriptTail, resolveTranscriptSource, sessionStatus, stepDetail, stepsBefore } from "../src/context/handoff";
import { ensureDaemonRunning, stopDaemon } from "../src/daemon/lifecycle";
import { getConfig, getProjectId } from "../src/config";
import { OBSERVATION_KINDS } from "../src/context/classify";
import { formatRelativeTime } from "../src/context/digest";
import { installAntigravityHooks, installCodexHooks } from "../src/install/hooks";
import { AGENTS, runInstall } from "../src/install/install";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
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
    --kind <kind>                Only this kind: request, decision, finding, change, verification, exploration, command, reply, other
    --type <type>                Only this observation type (e.g. user_prompt, assistant_reply, a tool name)
    --agent <type>               Only sessions recorded by this agent
    --session <session-id>       Only this session
    --since <age>                Only the last 30m, 12h, 2d, or 1w
    --file <path>                Only observations mentioning this file; the query is optional with it
  timeline <observation-id>      Show what happened just before and after an observation in its session
    --before <n> --after <n>     How many steps on each side (default 5)
  get <id> [<id>...]             Retrieve exact content of one or more observations
  sessions [--limit <n>]         List recent sessions from all agents with their stop status
  handoff [<session-id>]         Print where a session stopped (default: latest interrupted one)
    --step @<offset>             Full text of one step (offsets come from the handoff output)
    --before @<offset>           The 20 steps before that offset
    --grep <text>                Steps in that session containing the text, newest first
  digest                         Output the compact startup digest for this project
  setup [--agent <type>]         Install hooks for an agent (antigravity, claude, codex)
  install [--agent <name>]       Install or upgrade agent-sync skills and hooks for every detected agent
  help                           Show this help message

Options for hook:
  --output-format <fmt>          Output format: antigravity | claude | codex | raw (default: raw)
  --agent <type>                 Agent recording the session (default: antigravity when detected, else claude)
  --project <path>               Project path override

Options for setup:
  --agent <type>                 Agent type: antigravity (default), claude, codex
  --scope <scope>                Scope: global (default), project

Options for install:
  --agent <name>                 Only this agent: claude, codex, antigravity, grok
  --dry-run                      Print what would change without changing anything
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

/** "30m" | "12h" | "2d" | "1w" → milliseconds; undefined when the text is not an age. */
function parseAge(text: string): number | undefined {
  const match = /^(\d+)([mhdw])$/.exec(text.trim());
  if (!match) return undefined;
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] as "m" | "h" | "d" | "w"];
  return Number(match[1]) * unitMs;
}

function observationLine(o: { id: string; kind?: string; type: string; agentType?: string; createdAt: number; tokensApprox: number; summary: string }): string {
  const details = [o.kind, o.type, o.agentType, formatRelativeTime(o.createdAt), `~${o.tokensApprox} tokens`].filter(Boolean);
  // Tool summaries can span lines; a result must stay on one
  return `[${o.id}] (${details.join(", ")}): ${o.summary.replace(/\s+/g, " ").trim()}`;
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
  const stdinTranscriptPath: string | undefined = stdinData.transcriptPath || stdinData.transcript_path || undefined;
  const agentType = getArgValue("--agent") || (stdinData.conversationId ? "antigravity" : process.env.AGENT_TYPE || "claude");

  if (event === "session-start") {
    const res = await fetch(`${serverUrl}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "session-start",
        sessionId: agentSessionId,
        transcriptPath: stdinTranscriptPath,
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
      // PreInvocation fires before every model call; inject only on the conversation's first one
      const output = {
        injectSteps: data.isNew === false ? [] : [{ ephemeralMessage: data.digest }],
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
    const sessionId = dataObj.sessionId || (sessionIndex !== -1 ? args[sessionIndex + 1] : undefined) || agentSessionId;

    const res = await fetch(`${serverUrl}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "post-tool",
        projectId,
        projectName,
        sessionId,
        agentType,
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
    const transcriptPath = stdinTranscriptPath;
    const sessionId = agentSessionId || dataObj.sessionId;

    let messages: ReturnType<typeof parseTranscript> = [];
    let editedFiles: string[] = [];
    let agentTitle: string | undefined;
    if (transcriptPath) {
      const source = resolveTranscriptSource(transcriptPath);
      if (existsSync(source)) {
        const jsonl = readFileSync(source, "utf-8");
        messages = parseTranscript(jsonl);
        editedFiles = extractEditedFiles(jsonl);
        agentTitle = resolveAgentTitle(agentType, sessionId, jsonl);
      }
    }
    if (!agentTitle && sessionId) {
      agentTitle = resolveAgentTitle(agentType, sessionId);
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
          transcriptPath,
          title: agentTitle,
          summary: summarizeSession(messages, editedFiles, agentTitle),
          messages,
          editedFiles,
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
} else if (command === "sessions" || command === "handoff") {
  const projectId = getProjectId(getArgValue("--project") || process.cwd());
  const serverUrl = await ensureDaemonRunning();
  const res = await fetch(`${serverUrl}/api/sessions?project=${projectId}&limit=${getArgValue("--limit") || "20"}`);
  if (!res.ok) {
    console.error(`Request failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  const sessions = (((await res.json()) as any).sessions || []) as any[];
  const now = Date.now();
  const withStatus = sessions.map((session) => {
    // A small tail is enough to tell how the session ended; the full tail is read only for the one handed off
    const tail = session.transcriptPath ? readTranscriptTail(resolveTranscriptSource(session.transcriptPath), 64 * 1024) : "";
    return { session, tail, status: sessionStatus(parseEvents(tail), now) };
  });

  if (command === "sessions") {
    if (withStatus.length === 0) console.log("No sessions recorded for this project yet.");
    withStatus.forEach(({ session, status }, i) => {
      const age = Math.round((now - (status.lastEventAt ?? session.startedAt)) / 60000);
      const label = status.state === "interrupted" ? `interrupted (${status.reason})` : status.state;
      console.log(`${i + 1}. ${session.id}  ${session.agentType}  ${age}m ago  ${label}  ${session.summary || session.title || ""}`.trimEnd());
    });
  } else {
    const wanted = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
    const pick = wanted
      ? withStatus.find(({ session }) => session.id === wanted || session.id.startsWith(wanted))
      : withStatus.find(({ status }) => status.state === "interrupted" || status.state === "mid-turn");
    if (!pick) {
      console.log(
        wanted
          ? `Session '${wanted}' not found in this project. Run \`agent-mem sessions\` to list them.`
          : "No interrupted session found. Run `agent-mem sessions` and pass an id to load one anyway."
      );
    } else if (!pick.tail) {
      console.log(`Session ${pick.session.id} has no readable transcript, so there is nothing to hand off.`);
    } else {
      const source = resolveTranscriptSource(pick.session.transcriptPath);
      const offsetArg = (flag: string) => Number((getArgValue(flag) ?? "").replace(/^@/, ""));
      const grep = getArgValue("--grep");
      if (getArgValue("--step")) console.log(stepDetail(source, offsetArg("--step")));
      else if (getArgValue("--before")) console.log(stepsBefore(source, offsetArg("--before")));
      else if (grep) console.log(grepSteps(source, grep));
      else console.log(loadHandoff(pick.session, source, now));
    }
  }
} else if (command === "search") {
  const projectId = getProjectId(getArgValue("--project") || process.cwd());

  const valueFlags = new Set(["--limit", "--project", "--type", "--agent", "--session", "--since", "--file", "--kind"]);
  const queryTokens: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (valueFlags.has(args[i])) {
      i++;
    } else if (!args[i].startsWith("--")) {
      queryTokens.push(args[i]);
    }
  }
  const query = queryTokens.join(" ");

  const file = getArgValue("--file");

  if (!query && !file) {
    console.error("Provide a search query");
    process.exit(1);
  }

  const params = new URLSearchParams({ q: query, project: projectId });
  for (const [flag, name] of [["--limit", "limit"], ["--type", "type"], ["--agent", "agent"], ["--session", "session"], ["--file", "file"], ["--kind", "kind"]]) {
    const value = getArgValue(flag);
    if (value) params.set(name, value);
  }
  const kind = getArgValue("--kind");
  if (kind && !(OBSERVATION_KINDS as string[]).includes(kind)) {
    console.error(`Invalid --kind '${kind}'. Use one of: ${OBSERVATION_KINDS.join(", ")}.`);
    process.exit(1);
  }
  const since = getArgValue("--since");
  if (since) {
    const ageMs = parseAge(since);
    if (ageMs === undefined) {
      console.error(`Invalid --since '${since}'. Use a number and a unit: 30m, 12h, 2d, 1w.`);
      process.exit(1);
    }
    params.set("since", String(Date.now() - ageMs));
  }

  const serverUrl = await ensureDaemonRunning();
  const res = await fetch(`${serverUrl}/api/search?${params}`);
  if (!res.ok) {
    console.error(`Request failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  const data = (await res.json()) as any;
  const results = data.results || [];
  const subject = [query && `'${query}'`, file && `file '${file}'`].filter(Boolean).join(" in ");
  if (results.length === 0) {
    console.log(`No observations found matching ${subject}.`);
  } else {
    console.log(`Found ${results.length} observation(s) for ${subject}:`);
    for (const r of results) {
      console.log(`• ${observationLine(r)}`);
    }
  }
} else if (command === "timeline") {
  const obsId = args[1];
  if (!obsId || obsId.startsWith("--")) {
    console.error("Provide observation ID");
    process.exit(1);
  }
  const params = new URLSearchParams({ id: obsId });
  for (const name of ["before", "after"]) {
    const value = getArgValue(`--${name}`);
    if (value) params.set(name, value);
  }
  const serverUrl = await ensureDaemonRunning();
  const res = await fetch(`${serverUrl}/api/timeline?${params}`);
  if (!res.ok) {
    console.error(`Request failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  const data = (await res.json()) as any;
  console.log(`Timeline around [${data.anchor.id}] (session ${data.anchor.sessionId}):`);
  for (const o of data.before) console.log(`  ${observationLine(o)}`);
  console.log(`→ ${observationLine(data.anchor)}`);
  for (const o of data.after) console.log(`  ${observationLine(o)}`);
} else if (command === "get") {
  const obsIds = args.slice(1).filter((a) => !a.startsWith("--"));
  if (obsIds.length === 0) {
    console.error("Provide observation ID");
    process.exit(1);
  }
  const serverUrl = await ensureDaemonRunning();
  let failed = false;
  let printed = 0;
  for (const obsId of obsIds) {
    const res = await fetch(`${serverUrl}/api/observations/${obsId}`);
    if (!res.ok) {
      console.error(`[${obsId}] Request failed (${res.status}): ${await res.text()}`);
      failed = true;
      continue;
    }
    const data = (await res.json()) as any;
    if (printed++ > 0) console.log("");
    console.log(`[${data.id}] (${data.type}) ~${data.tokensApprox} tokens:`);
    console.log(data.content);
  }
  if (failed) process.exit(1);
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
    if (scope !== "global" && scope !== "project") {
      console.error(`Unknown scope: ${scope}. Use 'global' or 'project'.`);
      process.exit(1);
    }
    const hooksFile = scope === "global" ? join(homedir(), ".gemini", "config", "hooks.json") : join(process.cwd(), ".agents", "hooks.json");
    try {
      installAntigravityHooks(hooksFile, binPath);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    console.log(`✅ Antigravity ${scope} hook installed at: ${hooksFile}`);
    console.log(`   Hook command: bun run ${binPath} hook session-start --output-format antigravity`);
    console.log(`\n   The agent-mem digest will be injected at the start of every Antigravity session.`);
  } else if (agentType === "claude") {
    const hook = (sub: string) => [{ hooks: [{ type: "command", command: `bun run ${binPath} hook ${sub}${sub === "session-start" ? " --output-format claude" : ""}` }] }];
    console.log(`Claude Code setup:`);
    console.log(`\nAdd the following to your ~/.claude/settings.json or project .claude/settings.json:\n`);
    console.log(JSON.stringify({ hooks: { SessionStart: hook("session-start"), Stop: hook("transcript"), SessionEnd: hook("transcript") } }, null, 2));
  } else if (agentType === "codex") {
    if (scope !== "global" && scope !== "project") {
      console.error(`Unknown scope: ${scope}. Use 'global' or 'project'.`);
      process.exit(1);
    }
    const hooksFile = scope === "project" ? join(process.cwd(), ".codex", "hooks.json") : join(homedir(), ".codex", "hooks.json");
    try {
      installCodexHooks(hooksFile, binPath);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    console.log(`✅ Codex ${scope} hooks installed at: ${hooksFile}`);
    console.log(`   SessionStart injects the project digest; Stop records the session transcript.`);
  } else {
    console.error(`Unknown agent type: ${agentType}. Supported: antigravity, claude, codex`);
    process.exit(1);
  }
} else if (command === "install") {
  const only = getArgValue("--agent");
  if (only && !AGENTS.includes(only)) {
    console.error(`Unknown agent: ${only}. Supported: ${AGENTS.join(", ")}`);
    process.exit(1);
  }
  if (!args.includes("--dry-run")) {
    await stopDaemon();
  }
  const results = runInstall({
    root: realpathSync(resolve(import.meta.dir, "../..")),
    home: process.env.HOME || homedir(),
    only,
    dryRun: args.includes("--dry-run"),
  });
  const icon = { ok: "✅", skipped: "⏭", failed: "✗" } as const;
  for (const r of results) console.log(`${icon[r.status]} ${r.agent}: ${r.detail}`);
  if (results.some((r) => r.status === "ok")) {
    console.log(`\nNext: restart your agents, then rerun /agent-sync:setup in each project to pick up new templates.`);
  }
  process.exit(results.some((r) => r.status === "failed") ? 1 : 0);
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}
