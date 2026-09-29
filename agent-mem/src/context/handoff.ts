import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizePayload } from "../privacy/redactor";
import { extractEditedFiles, isInjectedContext, isNoise, toTime, unwrapUserRequest } from "./transcript";

export type HandoffEventKind = "prompt" | "reply" | "tool" | "subagent" | "error";

export interface HandoffEvent {
  kind: HandoffEventKind;
  text: string;
  at: number;
  /** Byte offset of the transcript line this event came from; lets the next agent fetch it again. */
  offset?: number;
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
      // toolUseResult.agentId marks subagent results even when the launching call is outside the loaded chunk
      if (block?.type === "tool_result" && (subagentCalls.has(block.tool_use_id) || row.toolUseResult?.agentId)) {
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
export function parseEvents(jsonl: string, baseOffset: number = 0): HandoffEvent[] {
  const events: HandoffEvent[] = [];
  const subagentCalls = new Set<string>();
  let offset = baseOffset;
  for (const line of jsonl.split("\n")) {
    const lineOffset = offset;
    offset += Buffer.byteLength(line) + 1;
    if (!line.trim()) continue;
    let row: Record<string, any>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const found =
      "step_index" in row ? antigravityEvents(row) : row.type === "response_item" || row.type === "event_msg" ? codexEvents(row) : claudeEvents(row, subagentCalls);
    for (const event of found) events.push({ ...event, offset: lineOffset });
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

function isTaskPrompt(event: HandoffEvent): boolean {
  return event.kind === "prompt" && oneLine(event.text).split(" ").length >= MIN_TASK_WORDS;
}

function findTaskIndex(events: HandoffEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (isTaskPrompt(events[i])) return i;
  }
  return -1;
}

/** One step line; a clipped step names the command that returns it in full. */
function stepLine(event: HandoffEvent, sessionId: string | undefined, withOffset: boolean): string {
  const max = TAIL_LIMITS[event.kind].chars;
  const flat = oneLine(event.text);
  const at = withOffset && event.offset !== undefined ? `@${event.offset} ` : "";
  let line = `  - ${at}[${event.kind}] ${clip(flat, max)}`;
  if (flat.length > max && event.offset !== undefined) {
    line += ` [clipped ${flat.length} chars → ${sessionId ? `handoff ${sessionId} ` : ""}--step @${event.offset}]`;
  }
  return line;
}

export interface HandoffContext {
  /** Task prompt found before the loaded events, when none of them states one. */
  task?: HandoffEvent;
  /** First real prompt of the session. */
  goal?: HandoffEvent;
}

export function formatHandoff(
  session: { id: string; agentType: string; startedAt: number },
  events: HandoffEvent[],
  editedFiles: string[],
  now: number = Date.now(),
  context: HandoffContext = {}
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
  const task = taskIndex >= 0 ? events[taskIndex] : context.task;
  const goal = context.goal;
  if (goal && (!task || goal.offset !== task.offset || goal.text !== task.text)) {
    lines.push(`Original goal (first prompt): ${clip(goal.text, 300)}`);
  }
  lines.push(`Task (last prompt): ${task ? clip(task.text, 300) : "not in the loaded transcript tail"}`);
  if (editedFiles.length > 0) {
    const extra = editedFiles.length - 10;
    lines.push(`Files changed: ${editedFiles.slice(0, 10).join(", ")}${extra > 0 ? ` +${extra}` : ""}`);
  }
  lines.push("Last steps (oldest → newest):");
  if (tail.length === 0) lines.push("  (none recorded after the last prompt)");
  for (const event of tail) lines.push(stepLine(event, session.id, false));
  const earliest = tail[0]?.offset ?? task?.offset;
  if (earliest) lines.push(`Earlier steps: handoff ${session.id} --before @${earliest}`);
  lines.push(
    "Resume from the last step above; do not redo steps it shows as finished. Check `git status` and `git log` first, since files may have changed after this transcript."
  );

  return sanitizePayload(lines.join("\n")).sanitized;
}

function readBytes(path: string, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buffer;
}

/** Whole lines in the `maxBytes` before byte `end` (a line start), with the byte offset they begin at. */
export function readTranscriptChunk(path: string, end: number, maxBytes: number): { text: string; start: number } {
  const start = Math.max(0, end - maxBytes);
  const buffer = readBytes(path, start, end - start);
  if (start === 0) return { text: buffer.toString("utf-8"), start };
  // Drop the partial first line; a line longer than the chunk yields nothing
  const newline = buffer.indexOf(0x0a);
  if (newline === -1) return { text: "", start: end };
  return { text: buffer.subarray(newline + 1).toString("utf-8"), start: start + newline + 1 };
}

/** Last `maxBytes` of a transcript, trimmed to whole lines, so huge sessions stay cheap to read. */
export function readTranscriptTail(path: string, maxBytes: number = 512 * 1024): string {
  if (!existsSync(path)) return "";
  return readTranscriptChunk(path, statSync(path).size, maxBytes).text;
}

/**
 * Walk the transcript backwards chunk by chunk from byte `end`, handing each chunk's events to `visit`
 * until it returns true or the file start is reached, so large sessions are never read whole.
 */
function walkBackwards(path: string, end: number, chunkBytes: number, visit: (events: HandoffEvent[]) => boolean): void {
  while (end > 0) {
    const chunk = readTranscriptChunk(path, end, chunkBytes);
    // A single line bigger than the chunk: widen until it fits
    if (chunk.start === end) {
      chunkBytes *= 2;
      continue;
    }
    if (visit(parseEvents(chunk.text, chunk.start))) return;
    end = chunk.start;
  }
}

const HEAD_BYTES = 64 * 1024;
const CHUNK_BYTES = 512 * 1024;

/** First real prompt in the opening bytes of a transcript. */
function findGoal(path: string): HandoffEvent | undefined {
  const size = statSync(path).size;
  const text = readBytes(path, 0, Math.min(size, HEAD_BYTES)).toString("utf-8");
  // Drop a partial last line
  const whole = size > HEAD_BYTES ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
  return parseEvents(whole).find(isTaskPrompt);
}

/** Handoff for a transcript on disk: tail steps, the task prompt wherever it is, and the original goal. */
export function loadHandoff(
  session: { id: string; agentType: string; startedAt: number },
  path: string,
  now: number = Date.now(),
  opts: { tailBytes?: number; chunkBytes?: number } = {}
): string {
  const size = statSync(path).size;
  const tail = readTranscriptChunk(path, size, opts.tailBytes ?? CHUNK_BYTES);
  const events = parseEvents(tail.text, tail.start);
  const context: HandoffContext = { goal: findGoal(path) };
  if (findTaskIndex(events) < 0) {
    walkBackwards(path, tail.start, opts.chunkBytes ?? CHUNK_BYTES, (chunk) => {
      const i = findTaskIndex(chunk);
      if (i >= 0) context.task = chunk[i];
      return i >= 0;
    });
  }
  return formatHandoff(session, events, extractEditedFiles(tail.text), now, context);
}

const MAX_STEP_CHARS = 20000;

/** Full text of the events on the transcript line starting at byte `offset`. */
export function stepDetail(path: string, offset: number): string {
  const size = statSync(path).size;
  if (!Number.isInteger(offset) || offset < 0 || offset >= size) return `No step at @${offset}; the transcript is ${size} bytes.`;
  let length = Math.min(size - offset, 64 * 1024);
  let buffer = readBytes(path, offset, length);
  while (buffer.indexOf(0x0a) === -1 && offset + length < size) {
    length = Math.min(size - offset, length * 4);
    buffer = readBytes(path, offset, length);
  }
  const newline = buffer.indexOf(0x0a);
  const line = (newline === -1 ? buffer : buffer.subarray(0, newline)).toString("utf-8");
  const events = parseEvents(line, offset);
  if (events.length === 0) return `No prompt, reply, tool call, or subagent result at @${offset}.`;
  const text = events
    .map((e) => {
      const body = e.text.length > MAX_STEP_CHARS ? `${e.text.slice(0, MAX_STEP_CHARS)}\n[truncated at ${MAX_STEP_CHARS} of ${e.text.length} chars]` : e.text;
      return `=== @${offset} [${e.kind}] ${new Date(e.at).toISOString()} ===\n${body}`;
    })
    .join("\n\n");
  return sanitizePayload(text).sanitized;
}

/** The `count` steps before byte `offset`, oldest first, with a pointer to the page before them. */
export function stepsBefore(path: string, offset: number, count: number = 20, chunkBytes: number = CHUNK_BYTES): string {
  let found: HandoffEvent[] = [];
  walkBackwards(path, Math.min(offset, statSync(path).size), chunkBytes, (chunk) => {
    found = [...chunk, ...found];
    return found.length >= count;
  });
  const page = found.slice(-count);
  if (page.length === 0) return `No steps before @${offset}.`;
  const lines = page.map((e) => stepLine(e, undefined, true));
  if (page[0].offset) lines.push(`Earlier steps: --before @${page[0].offset}`);
  return sanitizePayload(lines.join("\n")).sanitized;
}

/** Steps whose text contains `query` (case-insensitive), newest first. */
export function grepSteps(path: string, query: string, limit: number = 10, chunkBytes: number = CHUNK_BYTES): string {
  const needle = query.toLowerCase();
  const hits: HandoffEvent[] = [];
  walkBackwards(path, statSync(path).size, chunkBytes, (chunk) => {
    for (let i = chunk.length - 1; i >= 0 && hits.length < limit; i--) {
      if (chunk[i].text.toLowerCase().includes(needle)) hits.push(chunk[i]);
    }
    return hits.length >= limit;
  });
  if (hits.length === 0) return `No steps match '${query}'.`;
  return sanitizePayload(hits.map((e) => stepLine(e, undefined, true)).join("\n")).sanitized;
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
