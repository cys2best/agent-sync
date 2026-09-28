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
  if (!text || text.startsWith("<task-notification>")) return null;
  return { key: String(row.uuid), role: row.type, text, createdAt: toTime(row.timestamp) };
}

/** Extract user prompts and assistant replies from an Antigravity or Claude Code JSONL transcript. */
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
    const msg = "step_index" in row ? fromAntigravity(row) : fromClaude(row);
    if (msg && msg.text) messages.push(msg);
  }
  return messages;
}
