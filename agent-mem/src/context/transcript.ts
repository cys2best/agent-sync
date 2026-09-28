export interface ChatMessage {
  /** Stable per-transcript identifier (Antigravity step_index or Claude Code uuid). */
  key: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

function toTime(value: unknown): number {
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? Date.now() : t;
}

/** Antigravity wraps the typed prompt in <USER_REQUEST> alongside metadata blocks. */
function unwrapUserRequest(content: string): string {
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
function isInjectedContext(text: string): boolean {
  return text.startsWith("<") || text.startsWith("# AGENTS.md instructions");
}

/** Interrupt markers carry no meaning for later sessions. */
function isNoise(text: string): boolean {
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
const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

/** Files changed during the session: Claude Code edit tools and Codex apply_patch bodies, first-seen order. */
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

    if (row.type === "assistant" && Array.isArray(row.message?.content)) {
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

const MAX_SUMMARY_CHARS = 80;
const MAX_SUMMARY_FILES = 3;

/** One-line session summary for the digest: the opening prompt plus which files changed. */
export function summarizeSession(messages: ChatMessage[], editedFiles: string[]): string | undefined {
  const firstPrompt = messages.find((m) => m.role === "user")?.text.replace(/\s+/g, " ").trim();
  const parts: string[] = [];
  if (firstPrompt) {
    parts.push(firstPrompt.length > MAX_SUMMARY_CHARS ? firstPrompt.slice(0, MAX_SUMMARY_CHARS - 3) + "..." : firstPrompt);
  }
  if (editedFiles.length > 0) {
    const names = editedFiles.slice(0, MAX_SUMMARY_FILES).map((f) => f.split("/").pop());
    const extra = editedFiles.length - MAX_SUMMARY_FILES;
    parts.push(`edited ${names.join(", ")}${extra > 0 ? ` +${extra}` : ""}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
