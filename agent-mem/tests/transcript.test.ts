import { describe, expect, it } from "bun:test";
import { parseTranscript } from "../src/context/transcript";

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

  it("skips malformed lines", () => {
    expect(parseTranscript("not json\n\n{}")).toEqual([]);
  });
});
