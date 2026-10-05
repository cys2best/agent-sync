import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ChatMessage {
  /** Stable per-transcript identifier (Antigravity step_index or Claude Code uuid). */
  key: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

export function toTime(value: unknown): number {
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? Date.now() : t;
}

/** Antigravity wraps the typed prompt in <USER_REQUEST> alongside metadata blocks. */
export function unwrapUserRequest(content: string): string {
  const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  return (match ? match[1] : content).trim();
}

function fromAntigravity(row: Record<string, any>): ChatMessage | null {
  if (typeof row.content !== "string") return null;
  const base = { key: String(row.step_index), createdAt: toTime(row.created_at) };
  if (row.type === "USER_INPUT") return { ...base, role: "user", text: unwrapUserRequest(row.content) };
  if (row.type === "PLANNER_RESPONSE") return { ...base, role: "assistant", text: row.content.trim() };
  return null;
}

/** Codex rollouts inject AGENTS.md and environment blocks as user messages; only typed prompts count. */
export function isInjectedContext(text: string): boolean {
  return text.startsWith("<") || text.startsWith("# AGENTS.md instructions");
}

/** Interrupt markers carry no meaning for later sessions. */
export function isNoise(text: string): boolean {
  return /^\[Request interrupted by user[^\]]*\]$/.test(text);
}

function fromCodex(row: Record<string, any>): ChatMessage | null {
  const payload = row.payload;
  if (row.type !== "response_item" || payload?.type !== "message") return null;
  if (payload.role !== "user" && payload.role !== "assistant") return null;
  const text = (Array.isArray(payload.content) ? payload.content : [])
    .filter((block: any) => (block?.type === "input_text" || block?.type === "output_text") && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
  if (!text || (payload.role === "user" && isInjectedContext(text))) return null;
  return { key: String(payload.id ?? row.ordinal), role: payload.role, text, createdAt: toTime(row.timestamp) };
}

function fromClaude(row: Record<string, any>): ChatMessage | null {
  if ((row.type !== "user" && row.type !== "assistant") || row.isMeta || row.isSidechain) return null;
  const content = row.message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join("\n");
  }
  text = text.trim();
  if (!text || text.startsWith("<task-notification>") || isNoise(text)) return null;
  return { key: String(row.uuid), role: row.type, text, createdAt: toTime(row.timestamp) };
}

/** Extract user prompts and assistant replies from an Antigravity, Codex, or Claude Code JSONL transcript. */
export function parseTranscript(jsonl: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, any>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = "step_index" in row ? fromAntigravity(row) : row.type === "response_item" ? fromCodex(row) : fromClaude(row);
    if (msg && msg.text) messages.push(msg);
  }
  return messages;
}

const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const ANTIGRAVITY_EDIT_TOOLS = new Set(["replace_file_content", "multi_replace_file_content", "write_to_file"]);
const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

/** Files changed during the session: Claude Code and Antigravity edit tools, Codex apply_patch bodies; first-seen order. */
export function extractEditedFiles(jsonl: string): string[] {
  const files = new Set<string>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, any>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    if (row.type === "PLANNER_RESPONSE" && Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        const path = call?.args?.TargetFile;
        if (ANTIGRAVITY_EDIT_TOOLS.has(call?.name) && typeof path === "string") files.add(path);
      }
    } else if (row.type === "assistant" && Array.isArray(row.message?.content)) {
      for (const block of row.message.content) {
        if (block?.type !== "tool_use" || !CLAUDE_EDIT_TOOLS.has(block.name)) continue;
        const path = block.input?.file_path ?? block.input?.notebook_path;
        if (typeof path === "string") files.add(path);
      }
    } else if (row.type === "response_item") {
      const payload = row.payload ?? {};
      const body = typeof payload.input === "string" ? payload.input : typeof payload.arguments === "string" ? payload.arguments : "";
      // Shell-wrapped patches arrive JSON-encoded, so decode escaped newlines before matching
      for (const match of body.replace(/\\n/g, "\n").matchAll(PATCH_FILE_RE)) files.add(match[1].trim());
    }
  }
  return [...files];
}

/**
 * Extract agent-generated title/recap if present in the transcript (e.g. Claude Code ai-title).
 * Scans all rows and returns the latest title.
 */
export function extractAgentTitle(jsonl: string): string | undefined {
  let title: string | undefined;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, any>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === "ai-title" && typeof row.aiTitle === "string" && row.aiTitle.trim()) {
      title = row.aiTitle.trim();
    }
  }
  return title;
}

const MAX_SUMMARY_CHARS = 80;
const MAX_SUMMARY_FILES = 3;

/** One-line session summary for the digest: agent title (or opening prompt) plus which files changed. */
export function summarizeSession(messages: ChatMessage[], editedFiles: string[], agentTitle?: string): string | undefined {
  const cleanTitle = agentTitle?.replace(/\s+/g, " ").trim();
  const firstPrompt = messages.find((m) => m.role === "user")?.text.replace(/\s+/g, " ").trim();
  const lead = cleanTitle || firstPrompt;
  const parts: string[] = [];
  if (lead) {
    parts.push(lead.length > MAX_SUMMARY_CHARS ? lead.slice(0, MAX_SUMMARY_CHARS - 3) + "..." : lead);
  }
  if (editedFiles.length > 0) {
    const names = editedFiles.slice(0, MAX_SUMMARY_FILES).map((f) => f.split("/").pop());
    const extra = editedFiles.length - MAX_SUMMARY_FILES;
    parts.push(`edited ${names.join(", ")}${extra > 0 ? ` +${extra}` : ""}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Look up the session title generated by Antigravity from its annotations pbtxt
 * or conversation_summaries.db.
 */
export function findAntigravityTitle(sessionId: string, geminiDir?: string): string | undefined {
  if (!sessionId) return undefined;
  const root = geminiDir || join(homedir(), ".gemini", "antigravity-cli");
  const pbtxt = join(root, "annotations", `${sessionId}.pbtxt`);
  if (existsSync(pbtxt)) {
    try {
      const match = readFileSync(pbtxt, "utf-8").match(/title:\s*"([^"]+)"/);
      if (match && match[1].trim()) return match[1].trim();
    } catch {}
  }
  const dbPath = join(root, "conversation_summaries.db");
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath);
      const row = db.prepare("SELECT title FROM conversation_summaries WHERE conversation_id = ?").get(sessionId) as any;
      db.close();
      if (typeof row?.title === "string" && row.title.trim()) return row.title.trim();
    } catch {}
  }
  return undefined;
}

/**
 * Look up the thread/session title generated by Codex from its session_index.jsonl.
 */
export function findCodexTitle(sessionId: string, codexDir?: string): string | undefined {
  if (!sessionId) return undefined;
  const indexFile = join(codexDir || join(homedir(), ".codex"), "session_index.jsonl");
  if (!existsSync(indexFile)) return undefined;
  try {
    const content = readFileSync(indexFile, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.includes(sessionId)) continue;
      try {
        const row = JSON.parse(line);
        if (row.id === sessionId && typeof row.thread_name === "string" && row.thread_name.trim()) {
          return row.thread_name.trim();
        }
      } catch {}
    }
  } catch {}
  return undefined;
}

/**
 * Resolve the native agent title/recap for a session across Claude Code, Antigravity, or Codex.
 */
export function resolveAgentTitle(
  agentType: string,
  sessionId?: string,
  transcriptJsonl?: string,
  opts?: { geminiDir?: string; codexDir?: string }
): string | undefined {
  if (transcriptJsonl) {
    const title = extractAgentTitle(transcriptJsonl);
    if (title) return title;
  }
  if (!sessionId) return undefined;
  if (agentType === "antigravity") {
    return findAntigravityTitle(sessionId, opts?.geminiDir);
  }
  if (agentType === "codex") {
    return findCodexTitle(sessionId, opts?.codexDir);
  }
  return undefined;
}

