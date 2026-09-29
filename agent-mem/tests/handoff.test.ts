import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatHandoff, grepSteps, loadHandoff, parseEvents, readTranscriptTail, sessionStatus, stepDetail, stepsBefore } from "../src/context/handoff";

const lines = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n");
const T = (s: number) => new Date(Date.parse("2026-09-28T10:00:00Z") + s * 1000).toISOString();

// Mirrors a real Superpowers run that hit the Claude session limit mid-review
const claudeLimitHit = lines([
  { type: "user", uuid: "u1", timestamp: T(0), message: { content: "continue plan survey-tester final review" } },
  {
    type: "assistant",
    uuid: "a1",
    timestamp: T(1),
    message: { content: [{ type: "tool_use", id: "task1", name: "Agent", input: { description: "Final branch review" } }] },
  },
  { type: "assistant", uuid: "s1", isSidechain: true, timestamp: T(2), message: { content: [{ type: "text", text: "subagent chatter" }] } },
  {
    type: "user",
    uuid: "u2",
    timestamp: T(3),
    message: { content: [{ type: "tool_result", tool_use_id: "task1", content: [{ type: "text", text: "Found 2 issues: missing retry test; stale doc." }] }] },
  },
  { type: "assistant", uuid: "a2", timestamp: T(4), message: { content: [{ type: "text", text: "Fixing issue 1: adding retry test." }] } },
  {
    type: "assistant",
    uuid: "a3",
    timestamp: T(5),
    message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/repo/tests/retry.test.ts" } }] },
  },
  { type: "user", uuid: "u3", timestamp: T(6), message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] } },
  {
    type: "assistant",
    uuid: "a4",
    timestamp: T(7),
    message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "bun test tests/retry.test.ts", description: "Run retry test" } }] },
  },
  {
    type: "assistant",
    uuid: "a5",
    timestamp: T(8),
    isApiErrorMessage: true,
    error: "rate_limit",
    message: { content: [{ type: "text", text: "You've hit your session limit · resets 12am" }] },
  },
]);

describe("parseEvents", () => {
  it("turns a Claude Code transcript into prompt, tool, subagent, reply, and error events", () => {
    expect(parseEvents(claudeLimitHit).map((e) => [e.kind, e.text])).toEqual([
      ["prompt", "continue plan survey-tester final review"],
      ["tool", "Agent: Final branch review"],
      ["subagent", "Found 2 issues: missing retry test; stale doc."],
      ["reply", "Fixing issue 1: adding retry test."],
      ["tool", "Edit: /repo/tests/retry.test.ts"],
      ["tool", "Bash: bun test tests/retry.test.ts"],
      ["error", "rate_limit: You've hit your session limit · resets 12am"],
    ]);
  });

  it("treats agent hand-back messages as subagent results, not prompts", () => {
    const text = lines([
      { type: "user", uuid: "u1", message: { content: "Another Claude session sent a message: <agent-message>[Subagent hand-back] done</agent-message>" } },
    ]);
    expect(parseEvents(text).map((e) => e.kind)).toEqual(["subagent"]);
  });

  it("keeps slash commands with arguments as prompts and drops bare commands and local output", () => {
    const text = lines([
      { type: "user", uuid: "u1", message: { content: "<command-name>/superpowers:execute</command-name>\n<command-message>x</command-message>\n<command-args>continue plan survey</command-args>" } },
      { type: "user", uuid: "u2", message: { content: "<command-name>/low-priority</command-name>\n<command-message>low-priority</command-message>\n<command-args></command-args>" } },
      { type: "user", uuid: "u3", message: { content: "<local-command-stdout>Set priority</local-command-stdout>" } },
      { type: "user", uuid: "u4", message: { content: "<local-command-caveat>Caveat</local-command-caveat>" } },
    ]);
    expect(parseEvents(text).map((e) => [e.kind, e.text])).toEqual([["prompt", "/superpowers:execute continue plan survey"]]);
  });

  it("extracts async subagent results and drops launch metadata", () => {
    const text = lines([
      { type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "Review Task 2" } }] } },
      { type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Async agent launched successfully. (internal metadata)" }] } },
      {
        type: "user",
        uuid: "u2",
        message: {
          content:
            "<task-notification>\n<task-id>a9</task-id>\n<output-file>/tmp/tasks/a9.output</output-file>\n<status>completed</status>\n<summary>Agent \"Review Task 2\" completed: approved, 1 minor finding</summary>\n<note>boilerplate</note>\n</task-notification>",
        },
      },
      {
        type: "user",
        uuid: "u3",
        message: {
          content:
            'Another Claude session sent a message:\n<agent-message from="a1">\n[Subagent hand-back] The text below is the final report. The report follows:\n  **Status:** DONE\n  **Commit:** 8b7393b scaffold\n</agent-message>',
        },
      },
    ]);
    expect(parseEvents(text).map((e) => [e.kind, e.text])).toEqual([
      ["tool", "Agent: Review Task 2"],
      ["subagent", 'completed: Agent "Review Task 2" completed: approved, 1 minor finding (full report: /tmp/tasks/a9.output)'],
      ["subagent", "**Status:** DONE\n**Commit:** 8b7393b scaffold"],
    ]);
  });

  it("reads Codex rollouts including aborted turns", () => {
    const text = lines([
      { timestamp: T(0), type: "response_item", payload: { type: "message", id: "m0", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } },
      { timestamp: T(1), type: "response_item", payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "review the branch" }] } },
      { timestamp: T(2), type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"command":["git","diff"]}' } },
      { timestamp: T(3), type: "response_item", payload: { type: "message", id: "m2", role: "assistant", content: [{ type: "output_text", text: "Reviewing diff." }] } },
      { timestamp: T(4), type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } },
    ]);
    expect(parseEvents(text).map((e) => [e.kind, e.text])).toEqual([
      ["prompt", "review the branch"],
      ["tool", 'shell: {"command":["git","diff"]}'],
      ["reply", "Reviewing diff."],
      ["error", "turn_aborted: interrupted"],
    ]);
  });

  it("reads Antigravity transcripts", () => {
    const text = lines([
      { step_index: 0, type: "USER_INPUT", created_at: T(0), content: "<USER_REQUEST>\nfix login\n</USER_REQUEST>" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: T(1),
        tool_calls: [
          { name: "run_command", args: { CommandLine: "npm test", toolSummary: "Run tests" } },
          { name: "replace_file_content", args: { TargetFile: "/repo/src/login.ts", toolSummary: "Fix login" } },
          { name: "manage_task", args: { Action: "list", toolSummary: "List tasks" } },
        ],
        content: "Looking.",
      },
      { step_index: 2, type: "ERROR_MESSAGE", created_at: T(2), error: "RESOURCE_EXHAUSTED (code 429): Individual quota reached" },
      { step_index: 3, type: "ERROR_MESSAGE", created_at: T(3), content: "Error: The stream was interrupted." },
    ]);
    expect(parseEvents(text).map((e) => [e.kind, e.text])).toEqual([
      ["prompt", "fix login"],
      ["tool", "run_command: npm test"],
      ["tool", "replace_file_content: /repo/src/login.ts"],
      ["tool", "manage_task: List tasks"],
      ["reply", "Looking."],
      ["error", "error: RESOURCE_EXHAUSTED (code 429): Individual quota reached"],
      ["error", "error: Error: The stream was interrupted."],
    ]);
  });
});

describe("sessionStatus", () => {
  const now = Date.parse(T(600));

  it("reports an error as interrupted with its reason", () => {
    expect(sessionStatus(parseEvents(claudeLimitHit), now)).toEqual({
      state: "interrupted",
      reason: "rate_limit: You've hit your session limit · resets 12am",
      lastEventAt: Date.parse(T(8)),
    });
  });

  it("reports a stale turn that ended on a tool call as mid-turn", () => {
    const events = parseEvents(claudeLimitHit).slice(0, -1);
    expect(sessionStatus(events, now).state).toBe("mid-turn");
    expect(sessionStatus(events, Date.parse(T(30))).state).toBe("active");
  });

  it("reports a session that ended on a reply as done", () => {
    expect(sessionStatus(parseEvents(claudeLimitHit).slice(0, 4), now).state).toBe("done");
  });
});

describe("formatHandoff", () => {
  const events = parseEvents(claudeLimitHit);
  const out = formatHandoff(
    { id: "9785cc73", agentType: "claude", startedAt: Date.parse(T(0)) },
    events,
    ["/repo/tests/retry.test.ts"],
    Date.parse(T(600))
  );

  it("leads with who stopped, why, and the task", () => {
    expect(out).toContain("=== AGENT-MEM HANDOFF: claude session 9785cc73 ===");
    expect(out).toContain("Status: interrupted (rate_limit: You've hit your session limit · resets 12am)");
    expect(out).toContain("Task (last prompt): continue plan survey-tester final review");
    expect(out).toContain("Files changed: /repo/tests/retry.test.ts");
  });

  it("lists the recent steps oldest to newest, including the subagent result", () => {
    const steps = out.slice(out.indexOf("Last steps"));
    const order = ["Found 2 issues", "Fixing issue 1", "Edit: /repo/tests/retry.test.ts", "Bash: bun test", "rate_limit"];
    const positions = order.map((s) => steps.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("looks past a bare 'continue' retry to the real task and its steps", () => {
    const retried = [
      ...events,
      { kind: "prompt" as const, text: "contine", at: Date.parse(T(300)) },
      { kind: "error" as const, text: "rate_limit: You've hit your session limit", at: Date.parse(T(301)) },
    ];
    const text = formatHandoff({ id: "x", agentType: "claude", startedAt: 0 }, retried, [], Date.parse(T(600)));
    expect(text).toContain("Task (last prompt): continue plan survey-tester final review");
    expect(text).toContain("Found 2 issues");
    expect(text).toContain("[prompt] contine");
  });

  it("walks the whole tail when only retry prompts are in it", () => {
    const retryOnly = [
      { kind: "reply" as const, text: "Task 3 implementer running. Waiting for its report.", at: 1 },
      { kind: "error" as const, text: "rate_limit: limit", at: 2 },
      { kind: "prompt" as const, text: "contine", at: 3 },
      { kind: "error" as const, text: "rate_limit: limit", at: 4 },
    ];
    const text = formatHandoff({ id: "x", agentType: "claude", startedAt: 0 }, retryOnly, [], 100);
    expect(text).toContain("Task 3 implementer running");
    expect(text).toContain("Task (last prompt): not in the loaded transcript tail");
  });

  it("tells the next agent not to redo finished steps", () => {
    expect(out).toContain("do not redo");
  });

  it("caps each kind so long sessions stay small", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ kind: "tool" as const, text: `Bash: step ${i}`, at: i }));
    const capped = formatHandoff({ id: "x", agentType: "claude", startedAt: 0 }, many, [], 100);
    expect(capped).toContain("Bash: step 39");
    expect(capped).not.toContain("Bash: step 20");
  });

  it("redacts private blocks and secrets", () => {
    const leaky = [{ kind: "reply" as const, text: "key sk-ant-abcdefghijklmnopqrstuvwxyz0123 <private>pw</private>", at: 0 }];
    const safe = formatHandoff({ id: "x", agentType: "claude", startedAt: 0 }, leaky, [], 100);
    expect(safe).not.toContain("sk-ant-abcdefghij");
    expect(safe).not.toContain("pw</private>");
  });
});

describe("readTranscriptTail", () => {
  const dir = join(import.meta.dir, "__tail_test__");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns only whole lines from the end of a large file", () => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "t.jsonl");
    writeFileSync(file, Array.from({ length: 1000 }, (_, i) => JSON.stringify({ n: i })).join("\n"));
    const tail = readTranscriptTail(file, 200);
    const rows = tail.split("\n").map((l) => JSON.parse(l));
    expect(rows[rows.length - 1].n).toBe(999);
    expect(rows.length).toBeGreaterThan(3);
  });

  it("returns an empty string for a missing file", () => {
    expect(readTranscriptTail(join(dir, "missing.jsonl"))).toBe("");
  });
});

describe("drill-down by byte offset", () => {
  const dir = join(import.meta.dir, "__drill_test__");
  const session = { id: "ses1", agentType: "claude", startedAt: 0 };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, rows: object[]) => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, lines(rows));
    return file;
  };
  const prompt = (text: string, t = 0) => ({ type: "user", timestamp: T(t), message: { content: text } });
  const reply = (text: string, t = 0) => ({ type: "assistant", timestamp: T(t), message: { content: [{ type: "text", text }] } });
  const bash = (command: string, t = 0) => ({ type: "assistant", timestamp: T(t), message: { content: [{ type: "tool_use", id: `b${t}`, name: "Bash", input: { command } }] } });

  it("tags each event with the byte offset of its line", () => {
    const rows = [prompt("héllo wörld prompt here"), reply("second line")];
    const text = lines(rows);
    const events = parseEvents(text, 100);
    expect(events.map((e) => e.offset)).toEqual([100, 100 + Buffer.byteLength(JSON.stringify(rows[0])) + 1]);
  });

  it("finds the task prompt even when it is far before the tail", () => {
    const filler = Array.from({ length: 50 }, (_, i) => bash(`echo ${"x".repeat(200)} ${i}`, i + 1));
    const file = write("far.jsonl", [prompt("fix the wombat parser crash", 0), ...filler]);
    const out = loadHandoff(session, file, Date.parse(T(9999)), { tailBytes: 2048, chunkBytes: 2048 });
    expect(out).toContain("Task (last prompt): fix the wombat parser crash");
    expect(out).toMatch(/Earlier steps: handoff ses1 --before @\d+/);
  });

  it("shows the original goal when the last prompt is a follow-up", () => {
    const file = write("goal.jsonl", [prompt("build the numbat export feature end to end", 0), reply("done step one", 1), prompt("now fix the failing tests please", 2), reply("fixing", 3)]);
    const out = loadHandoff(session, file, Date.parse(T(9999)));
    expect(out).toContain("Original goal (first prompt): build the numbat export feature end to end");
    expect(out).toContain("Task (last prompt): now fix the failing tests please");
    const same = loadHandoff(session, write("same.jsonl", [prompt("build the numbat export feature end to end"), reply("ok", 1)]), Date.parse(T(9999)));
    expect(same).not.toContain("Original goal");
  });

  it("marks clipped steps with the command that returns them in full", () => {
    const long = "Review findings: " + Array.from({ length: 60 }, (_, i) => `issue${i}`).join(" ");
    const file = write("clip.jsonl", [prompt("review the whole branch carefully"), reply(long, 1)]);
    const out = loadHandoff(session, file, Date.parse(T(9999)));
    const offset = Number(out.match(/--step @(\d+)/)?.[1]);
    expect(Number.isNaN(offset)).toBe(false);
    const full = stepDetail(file, offset);
    expect(full).toContain("issue59");
    expect(full).toContain("[reply]");
  });

  it("pages older steps before an offset, newest page last", () => {
    const rows = [prompt("start the long job now please"), ...Array.from({ length: 30 }, (_, i) => bash(`step-${i}`, i + 1))];
    const file = write("page.jsonl", rows);
    const all = parseEvents(lines(rows));
    const out = stepsBefore(file, all[25].offset!, 5);
    expect(out).toContain("step-23");
    expect(out).toContain("step-19");
    expect(out).not.toContain("step-18");
    expect(out).not.toContain("step-24");
    expect(out).toMatch(/Earlier steps: --before @\d+/);
  });

  it("greps steps across the whole session, newest first", () => {
    const rows = [prompt("investigate the platypus timeout issue"), bash("ls", 1), reply("platypus fixed in cache layer", 2), ...Array.from({ length: 30 }, (_, i) => bash(`noise-${"y".repeat(100)}-${i}`, i + 3))];
    const file = write("grep.jsonl", rows);
    const out = grepSteps(file, "PLATYPUS", 10, 1024);
    expect(out.indexOf("platypus fixed")).toBeLessThan(out.indexOf("investigate the platypus"));
    expect(out).toMatch(/@\d+ \[reply\] platypus fixed/);
    expect(grepSteps(file, "nothing-matches-this")).toContain("No steps match");
  });

  it("reads a subagent result on its own, without the launching tool call", () => {
    const row = { type: "user", timestamp: T(1), toolUseResult: { agentId: "a1" }, message: { content: [{ type: "tool_result", tool_use_id: "gone", content: [{ type: "text", text: "Reviewer report: all good" }] }] } };
    expect(parseEvents(JSON.stringify(row))).toEqual([expect.objectContaining({ kind: "subagent", text: "Reviewer report: all good" })]);
  });
});
