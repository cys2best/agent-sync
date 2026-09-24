#!/usr/bin/env bun
import { createMemoryServer } from "../src/daemon/server";
import { ensureDaemonRunning } from "../src/daemon/lifecycle";
import { getConfig, getProjectId } from "../src/config";

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
Usage: agent-mem <command> [options]

Commands:
  daemon [--port <num>]          Run the persistent memory worker daemon
  hook <event> [options]         Trigger a lifecycle hook (session-start, post-tool, session-end)
  search <query> [--limit <n>]   Search project memory using SQLite FTS5
  get <observation-id>           Retrieve exact content of an observation
  digest                         Output the compact startup digest for this project
  help                           Show this help message
`);
}

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
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

  const projectIndex = args.indexOf("--project");
  const projectPath = projectIndex !== -1 ? args[projectIndex + 1] : process.cwd();
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

  if (event === "session-start") {
    const res = await fetch(`${serverUrl}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "session-start",
        projectId,
        projectName,
        agentType: process.env.AGENT_TYPE || "claude",
        ...dataObj,
      }),
    });
    const data = (await res.json()) as any;
    console.log(data.digest);
  } else if (event === "post-tool") {
    const summaryIndex = args.indexOf("--summary");
    const summary =
      dataObj.summary || (summaryIndex !== -1 ? args[summaryIndex + 1] : "Tool execution");

    const toolIndex = args.indexOf("--tool");
    const toolName = dataObj.toolName || (toolIndex !== -1 ? args[toolIndex + 1] : "tool");

    let content = dataObj.content || "";
    if (!content) {
      const contentTokens: string[] = [];
      for (let i = 2; i < args.length; i++) {
        if (
          args[i] === "--summary" ||
          args[i] === "--project" ||
          args[i] === "--data" ||
          args[i] === "--session" ||
          args[i] === "--tool"
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
    const data = (await res.json()) as any;
    console.log(`Recorded observation [${data.observationId}] (~${data.tokensApprox} tokens)`);
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
    const data = (await res.json()) as any;
    if (!res.ok) {
      console.error(data.error || "Hook failed");
      process.exit(1);
    }
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
    console.error(`Observation ${obsId} not found.`);
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
  const data = (await res.json()) as any;
  console.log(data.digest);
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}
