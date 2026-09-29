import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizePayload } from "../privacy/redactor";
import { isInjectedContext, isNoise, toTime, unwrapUserRequest } from "./transcript";

export type HandoffEventKind = "prompt" | "reply" | "tool" | "subagent" | "error";

export interface HandoffEvent {
  kind: HandoffEventKind;
  text: string;
  at: number;
}

export interface SessionStatus {
  state: "interrupted" | "mid-turn" | "active" | "done" | "unknown";
  reason?: string;
  lastEventAt?: number;
}

const HAND_BACK_PREFIX = "Another Claude session sent a message:";
const HAND_BACK_REPORT_MARKER = "The report follows:";
const ASYNC_LAUNCH_PREFIX = "Async agent launched successfully";
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
// A turn that ended on a tool call is only "stopped" once it has been quiet this long
const MID_TURN_QUIET_MS = 2 * 60 * 1000;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  const flat = oneLine(text);
  return flat.length > max ? flat.slice(0, max - 3) + "..." : flat;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
}

// Claude Code uses snake_case tool inputs, Antigravity PascalCase; both end with a human summary field
function describeToolInput(name: string, input: Record<string, any> = {}): string {
  const detail =
    input.command ?? input.CommandLine ?? input.file_path ?? input.TargetFile ?? input.AbsolutePath ?? input.notebook_path ??
    input.pattern ?? input.Query ?? input.Pattern ?? input.url ?? input.skill ?? input.description ?? input.toolSummary ?? input.prompt;
  return detail === undefined ? name : `${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
}

function claudeEvents(row: Record<string, any>, subagentCalls: Set<string>): HandoffEvent[] {
  if ((row.type !== "user" && row.type !== "assistant") || row.isMeta || row.isSidechain) return [];
  const at = toTime(row.timestamp);
  const content = row.message?.content;

  if (row.type === "assistant") {
    if (row.isApiErrorMessage) {
      return [{ kind: "error", text: `${row.error ?? "error"}: ${blockText(content).trim()}`, at }];
    }
    const events: HandoffEvent[] = [];
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === "text" && block.text?.trim()) {
        events.push({ kind: "reply", text: block.text.trim(), at });
      } else if (block?.type === "tool_use") {
        if (SUBAGENT_TOOLS.has(block.name) && block.id) subagentCalls.add(block.id);
        events.push({ kind: "tool", text: describeToolInput(block.name, block.input), at });
      }
    }
    return events;
  }

  // User rows carry typed prompts, subagent results, and hand-back messages
  if (Array.isArray(content)) {
    const events: HandoffEvent[] = [];
    for (const block of content) {
      if (block?.type === "tool_result" && subagentCalls.has(block.tool_use_id)) {
        const text = blockText(block.content).trim();
        // Background agents answer later via task-notification; the launch receipt carries nothing
        if (text && !text.startsWith(ASYNC_LAUNCH_PREFIX)) events.push({ kind: "subagent", text, at });
      }
    }
    if (events.length > 0 || content.some((b: any) => b?.type === "tool_result")) return events;
  }
  const text = blockText(content).trim();
  if (!text || isNoise(text)) return [];
  if (text.startsWith(HAND_BACK_PREFIX)) return [{ kind: "subagent", text: handBackReport(text), at }];
  if (text.startsWith("<task-notification>")) {
    const status = tagText(text, "status");
    const summary = tagText(text, "summary") ?? tagText(text, "result");
    const outputFile = tagText(text, "output-file");
    if (!summary) return [];
    const report = outputFile ? ` (full report: ${outputFile})` : "";
    return [{ kind: "subagent", text: `${status ? `${status}: ` : ""}${summary}${report}`, at }];
  }
  if (text.startsWith("<")) {
    const command = slashCommandPrompt(text);
    return command ? [{ kind: "prompt", text: command, at }] : [];
  }
  return [{ kind: "prompt", text, at }];
}

/**
 * Slash commands arrive wrapped in tags. One with arguments (`/plan continue X`) states the task;
 * bare commands, local command output, and notifications do not.
 */
function slashCommandPrompt(text: string): string | undefined {
  const name = tagText(text, "command-name");
  const commandArgs = tagText(text, "command-args");
  return name && commandArgs ? `${name} ${commandArgs}` : undefined;
}

function tagText(text: string, tag: string): string | undefined {
  const value = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();
  return value || undefined;
}

/** Hand-back messages wrap the subagent's report in a fixed preamble and indent it; keep only the report. */
function handBackReport(text: string): string {
  const marker = text.indexOf(HAND_BACK_REPORT_MARKER);
  const body = marker === -1 ? text : text.slice(marker + HAND_BACK_REPORT_MARKER.length);
  return body
    .replace(/<\/agent-message>\s*$/, "")
    .split("\n")
    .map((line) => line.replace(/^  /, ""))
    .join("\n")
    .trim();
}

function codexEvents(row: Record<string, any>): HandoffEvent[] {
  const payload = row.payload ?? {};
  const at = toTime(row.timestamp);

  if (row.type === "event_msg") {
    if (payload.type === "turn_aborted") return [{ kind: "error", text: `turn_aborted: ${payload.reason ?? "unknown"}`, at }];
    if (payload.type === "error") return [{ kind: "error", text: `error: ${payload.message ?? "unknown"}`, at }];
    return [];
  }
  if (row.type !== "response_item") return [];

  if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
    const text = (Array.isArray(payload.content) ? payload.content : [])
      .filter((b: any) => (b?.type === "input_text" || b?.type === "output_text") && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    if (!text || (payload.role === "user" && isInjectedContext(text))) return [];
    return [{ kind: payload.role === "user" ? "prompt" : "reply", text, at }];
  }
  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const args = typeof payload.arguments === "string" ? payload.arguments : typeof payload.input === "string" ? payload.input : "";
    return [{ kind: "tool", text: args ? `${payload.name}: ${args}` : String(payload.name), at }];
  }
  return [];
}

function antigravityEvents(row: Record<string, any>): HandoffEvent[] {
  const at = toTime(row.created_at);
  if (row.type === "USER_INPUT" && typeof row.content === "string") {
    return [{ kind: "prompt", text: unwrapUserRequest(row.content), at }];
  }
  if (row.type === "ERROR_MESSAGE") return [{ kind: "error", text: `error: ${row.error ?? row.content ?? "unknown"}`, at }];
  if (row.type !== "PLANNER_RESPONSE") return [];
  const events: HandoffEvent[] = (Array.isArray(row.tool_calls) ? row.tool_calls : [])
    .filter((call: any) => call?.name)
    .map((call: any) => ({ kind: "tool" as const, text: describeToolInput(String(call.name), call.args), at }));
  if (typeof row.content === "string" && row.content.trim()) events.push({ kind: "reply", text: row.content.trim(), at });
  return events;
}

/** Ordered prompt/reply/tool/subagent/error events from a Claude Code, Codex, or Antigravity transcript. */
export function parseEvents(jsonl: string): HandoffEvent[] {
  const events: HandoffEvent[] = [];
  const subagentCalls = new Set<string>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, any>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if ("step_index" in row) events.push(...antigravityEvents(row));
    else if (row.type === "response_item" || row.type === "event_msg") events.push(...codexEvents(row));
    else events.push(...claudeEvents(row, subagentCalls));
  }
  return events;
}

/** Whether a session ended cleanly, was cut off by an error or limit, or stopped mid-turn. */
export function sessionStatus(events: HandoffEvent[], now: number = Date.now()): SessionStatus {
  const last = events[events.length - 1];
  if (!last) return { state: "unknown" };
  if (last.kind === "error") return { state: "interrupted", reason: last.text, lastEventAt: last.at };
  if (last.kind === "reply") return { state: "done", lastEventAt: last.at };
  return { state: now - last.at >= MID_TURN_QUIET_MS ? "mid-turn" : "active", lastEventAt: last.at };
}

// Per-kind caps keep the handoff near ~500 tokens however long the session ran
const TAIL_LIMITS: Record<HandoffEventKind, { count: number; chars: number }> = {
  prompt: { count: 2, chars: 200 },
  reply: { count: 3, chars: 400 },
  tool: { count: 8, chars: 120 },
  subagent: { count: 1, chars: 800 },
  error: { count: 1, chars: 200 },
};

function formatAge(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

// Retries like "continue" or "go on" after a limit hit do not describe the task
const MIN_TASK_WORDS = 4;

function findTaskIndex(events: HandoffEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "prompt" && oneLine(events[i].text).split(" ").length >= MIN_TASK_WORDS) return i;
  }
  return -1;
}

export function formatHandoff(
  session: { id: string; agentType: string; startedAt: number },
  events: HandoffEvent[],
  editedFiles: string[],
  now: number = Date.now()
): string {
  const status = sessionStatus(events, now);
  const taskIndex = findTaskIndex(events);

  // Walk back to the task prompt, keeping the newest events of each kind up to its cap
  const used = { prompt: 0, reply: 0, tool: 0, subagent: 0, error: 0 };
  const tail: HandoffEvent[] = [];
  for (let i = events.length - 1; i > taskIndex; i--) {
    const event = events[i];
    if (used[event.kind] >= TAIL_LIMITS[event.kind].count) continue;
    used[event.kind]++;
    tail.unshift(event);
  }

  const statusText = status.reason ? `${status.state} (${status.reason})` : status.state;
  const lines = [
    `=== AGENT-MEM HANDOFF: ${session.agentType} session ${session.id} ===`,
    `Status: ${statusText}${status.lastEventAt ? `, last activity ${formatAge(now - status.lastEventAt)}` : ""}`,
  ];
  lines.push(`Task (last prompt): ${taskIndex >= 0 ? clip(events[taskIndex].text, 300) : "not in the loaded transcript tail"}`);
  if (editedFiles.length > 0) {
    const extra = editedFiles.length - 10;
    lines.push(`Files changed: ${editedFiles.slice(0, 10).join(", ")}${extra > 0 ? ` +${extra}` : ""}`);
  }
  lines.push("Last steps (oldest → newest):");
  if (tail.length === 0) lines.push("  (none recorded after the last prompt)");
  for (const event of tail) {
    lines.push(`  - [${event.kind}] ${clip(event.text, TAIL_LIMITS[event.kind].chars)}`);
  }
  lines.push(
    "Resume from the last step above; do not redo steps it shows as finished. Check `git status` and `git log` first, since files may have changed after this transcript."
  );

  return sanitizePayload(lines.join("\n")).sanitized;
}

/** Last `maxBytes` of a transcript, trimmed to whole lines, so huge sessions stay cheap to read. */
export function readTranscriptTail(path: string, maxBytes: number = 512 * 1024): string {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString("utf-8");
  return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
}

/** Antigravity truncates long fields in transcript.jsonl; transcript_full.jsonl keeps them intact. */
export function resolveTranscriptSource(transcriptPath: string): string {
  const fullPath = join(dirname(transcriptPath), "transcript_full.jsonl");
  return transcriptPath.endsWith("/transcript.jsonl") && existsSync(fullPath) ? fullPath : transcriptPath;
}

// Older interruptions are assumed handled already and are not worth a startup line
const NOTICE_WINDOW_MS = 12 * 60 * 60 * 1000;

/** One-line startup warning when a session stopped early, pointing at the resume skill. */
export function interruptionNotice(
  session: { id: string; agentType: string; transcriptPath?: string | null },
  now: number = Date.now()
): string | undefined {
  if (!session.transcriptPath) return undefined;
  const events = parseEvents(readTranscriptTail(resolveTranscriptSource(session.transcriptPath), 64 * 1024));
  const status = sessionStatus(events, now);
  if (status.state !== "interrupted" && status.state !== "mid-turn") return undefined;
  if (!status.lastEventAt || now - status.lastEventAt > NOTICE_WINDOW_MS) return undefined;
  const why = status.state === "interrupted" ? `stopped: ${clip(status.reason ?? "", 60)}` : "stopped mid-turn";
  return `⚠ ${session.agentType} session ${session.id} ${why} (${formatAge(now - status.lastEventAt)}) — run /agent-sync:resume to continue where it left off`;
}
