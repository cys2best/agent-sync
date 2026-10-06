/** What an observation was for, inferred from its tool and text. Lets search and the digest tell signal from noise. */
export type ObservationKind = "request" | "decision" | "finding" | "change" | "verification" | "exploration" | "command" | "reply" | "other";

export const OBSERVATION_KINDS: ObservationKind[] = ["request", "decision", "finding", "change", "verification", "exploration", "command", "reply", "other"];

// Tool names differ per agent: Claude Code, Antigravity, and Codex each have their own
const CHANGE_TYPES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "replace_file_content", "multi_replace_file_content", "write_to_file", "apply_patch", "files_edited"]);
const EXPLORATION_TYPES = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "view_file", "list_dir", "grep_search", "find_by_name", "search_web", "read_url_content"]);
const COMMAND_TYPES = new Set(["Bash", "run_command", "shell", "exec_command", "local_shell"]);

const VERIFICATION_RE =
  /\b(?:(?:bun|npm|pnpm|yarn|cargo|go|make|deno|mix|gradle|dotnet)\s+(?:run\s+)?(?:test|check|lint|build|typecheck|validate)[\w:-]*|pytest|unittest|jest|vitest|playwright\s+test|phpunit|rspec|tsc|eslint|ruff|mypy)\b/;
const READ_ONLY_COMMAND_RE = /^(?:ls|cat|head|tail|wc|grep|rg|find|fd|tree|pwd|which|stat|file|du|git\s+(?:status|log|diff|show|grep|blame|branch))\b/;

// Replies are free text, so only explicit wording promotes one; an unmarked decision stays a plain reply
const FINDING_RE = /\b(?:root cause|turns? out|the (?:bug|problem|issue|culprit) (?:is|was)|caused by|gotcha|workaround)\b/i;
const DECISION_RE = /\b(?:decided to|chose to|opted (?:for|to)|went with|going with|trade-?off)\b/i;

function commandLine(summary: string, content: string): string {
  let command = "";
  try {
    const args = JSON.parse(content);
    command = args?.CommandLine ?? args?.command ?? args?.cmd ?? "";
  } catch {}
  if (typeof command !== "string" || !command) {
    command = /(?:CommandLine|command)=(.*?)(?:, \w+=|\)?$)/s.exec(summary)?.[1] ?? "";
  }
  // Drop what precedes the program itself: `cd dir &&` and `VAR=value` prefixes
  return command.replace(/^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:\w+=\S*\s+)*/, "");
}

export function classifyObservation(obs: { type: string; summary: string; content: string }): ObservationKind {
  if (obs.type === "user_prompt") return "request";
  if (obs.type === "assistant_reply") {
    const text = `${obs.summary}\n${obs.content}`;
    if (FINDING_RE.test(text)) return "finding";
    if (DECISION_RE.test(text)) return "decision";
    return "reply";
  }
  if (CHANGE_TYPES.has(obs.type)) return "change";
  if (EXPLORATION_TYPES.has(obs.type)) return "exploration";
  if (COMMAND_TYPES.has(obs.type)) {
    const command = commandLine(obs.summary, obs.content);
    if (VERIFICATION_RE.test(command)) return "verification";
    if (READ_ONLY_COMMAND_RE.test(command)) return "exploration";
    return "command";
  }
  return "other";
}
