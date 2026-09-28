import { describe, expect, it } from "bun:test";
import { extractEditedFiles, parseTranscript, summarizeSession } from "../src/context/transcript";

const lines = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n");

describe("parseTranscript", () => {
  it("extracts user prompts and replies from an Antigravity transcript", () => {
    const text = lines([
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-09-28T10:00:00Z",
        content: "<USER_REQUEST>\nfix the login bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>",
      },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", tool_calls: [{ name: "view_file" }] },
      { step_index: 2, source: "MODEL", type: "GENERIC", content: "file contents" },
      {
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-09-28T10:00:05Z",
        content: "Fixed the token check.",
        thinking: "hidden",
      },
      { step_index: 4, source: "SYSTEM", type: "ERROR_MESSAGE", error: "429" },
    ]);

    expect(parseTranscript(text)).toEqual([
      { key: "0", role: "user", text: "fix the login bug", createdAt: Date.parse("2026-09-28T10:00:00Z") },
      { key: "3", role: "assistant", text: "Fixed the token check.", createdAt: Date.parse("2026-09-28T10:00:05Z") },
    ]);
  });

  it("extracts user prompts and replies from a Claude Code transcript", () => {
    const text = lines([
      { type: "attachment", uuid: "a0" },
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-09-28T10:00:00Z",
        message: { role: "user", content: "fix the login bug" },
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-09-28T10:00:01Z",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] },
      },
      {
        type: "user",
        uuid: "u2",
        message: { role: "user", content: [{ type: "tool_result", content: "output" }] },
      },
      { type: "user", uuid: "u3", isMeta: true, message: { role: "user", content: "skill body" } },
      { type: "user", uuid: "u4", message: { role: "user", content: "<task-notification>\ndone" } },
      {
        type: "assistant",
        uuid: "a2",
        isSidechain: true,
        message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] },
      },
      {
        type: "assistant",
        uuid: "a3",
        timestamp: "2026-09-28T10:00:09Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "Fixed the token check." },
          ],
        },
      },
    ]);

    expect(parseTranscript(text)).toEqual([
      { key: "u1", role: "user", text: "fix the login bug", createdAt: Date.parse("2026-09-28T10:00:00Z") },
      { key: "a3", role: "assistant", text: "Fixed the token check.", createdAt: Date.parse("2026-09-28T10:00:09Z") },
    ]);
  });

  it("extracts user prompts and replies from a Codex rollout", () => {
    const msg = (id: string, role: string, type: string, text: string, timestamp = "2026-09-28T10:00:00Z") => ({
      timestamp,
      type: "response_item",
      payload: { type: "message", id, role, content: [{ type, text }] },
    });
    const text = lines([
      { type: "session_meta", payload: { session_id: "s1" } },
      msg("m0", "developer", "input_text", "<skills_instructions>..."),
      msg("m1", "user", "input_text", "# AGENTS.md instructions for /repo\n..."),
      msg("m2", "user", "input_text", "<environment_context>cwd</environment_context>"),
      msg("m3", "user", "input_text", "fix the login bug"),
      { type: "response_item", payload: { type: "reasoning", id: "r1", summary: [] } },
      msg("m4", "assistant", "output_text", "Fixed the token check.", "2026-09-28T10:00:09Z"),
      { type: "event_msg", payload: { type: "task_complete", last_agent_message: "Fixed the token check." } },
    ]);

    expect(parseTranscript(text)).toEqual([
      { key: "m3", role: "user", text: "fix the login bug", createdAt: Date.parse("2026-09-28T10:00:00Z") },
      { key: "m4", role: "assistant", text: "Fixed the token check.", createdAt: Date.parse("2026-09-28T10:00:09Z") },
    ]);
  });

  it("drops interrupt markers from Claude Code transcripts", () => {
    const text = lines([
      { type: "user", uuid: "u1", message: { role: "user", content: "[Request interrupted by user]" } },
      { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } },
    ]);
    expect(parseTranscript(text)).toEqual([]);
  });

  it("skips malformed lines", () => {
    expect(parseTranscript("not json\n\n{}")).toEqual([]);
  });
});

describe("extractEditedFiles", () => {
  it("collects file paths from Claude Code edit tools in first-seen order", () => {
    const text = lines([
      { type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/src/auth/guard.ts" } }] } },
      { type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/repo/README.md" } }] } },
      { type: "assistant", uuid: "a3", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/repo/src/token.ts" } }] } },
      { type: "assistant", uuid: "a4", message: { content: [{ type: "tool_use", name: "MultiEdit", input: { file_path: "/repo/src/auth/guard.ts" } }] } },
      { type: "assistant", uuid: "a5", message: { content: [{ type: "tool_use", name: "NotebookEdit", input: { notebook_path: "/repo/nb.ipynb" } }] } },
    ]);
    expect(extractEditedFiles(text)).toEqual(["/repo/src/auth/guard.ts", "/repo/src/token.ts", "/repo/nb.ipynb"]);
  });

  it("collects file paths from Codex apply_patch calls", () => {
    const patch = "*** Begin Patch\n*** Update File: src/auth/guard.ts\n@@\n-a\n+b\n*** Add File: src/token.ts\n+x\n*** End Patch";
    const text = lines([
      { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: patch } },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["apply_patch", "*** Begin Patch\n*** Delete File: old.ts\n*** End Patch"] }) } },
    ]);
    expect(extractEditedFiles(text)).toEqual(["src/auth/guard.ts", "src/token.ts", "old.ts"]);
  });
});

describe("summarizeSession", () => {
  const user = (text: string) => ({ key: text, role: "user" as const, text, createdAt: 0 });

  it("combines the first prompt with edited file names", () => {
    const summary = summarizeSession([user("fix the login bug"), user("also add tests")], [
      "/repo/src/auth/guard.ts",
      "/repo/src/token.ts",
      "/repo/a.ts",
      "/repo/b.ts",
    ]);
    expect(summary).toBe("fix the login bug · edited guard.ts, token.ts, a.ts +1");
  });

  it("clips long prompts to one line", () => {
    const summary = summarizeSession([user("line one\n" + "x".repeat(200))], []);
    expect(summary!.length).toBeLessThanOrEqual(80);
    expect(summary).not.toContain("\n");
  });

  it("returns undefined when there is nothing to summarize", () => {
    expect(summarizeSession([], [])).toBeUndefined();
  });
});
