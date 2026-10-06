import { describe, expect, it } from "bun:test";
import { classifyObservation } from "../src/context/classify";

const kindOf = (type: string, summary = "", content = "") => classifyObservation({ type, summary, content });

describe("classifyObservation", () => {
  it("labels chat turns, with replies promoted when they state a finding or a decision", () => {
    expect(kindOf("user_prompt", "fix the login retries")).toBe("request");
    expect(kindOf("assistant_reply", "Done, tests pass.")).toBe("reply");
    expect(kindOf("assistant_reply", "The root cause is a stale cache key.")).toBe("finding");
    expect(kindOf("assistant_reply", "short", "It turns out the hook never fires on resume.")).toBe("finding");
    expect(kindOf("assistant_reply", "I decided to keep SQLite rather than add a vector store.")).toBe("decision");
  });

  it("labels edits from every agent as changes", () => {
    for (const type of ["Edit", "Write", "MultiEdit", "replace_file_content", "write_to_file", "apply_patch", "files_edited"]) {
      expect(kindOf(type)).toBe("change");
    }
  });

  it("splits shell commands into verification, exploration, and other commands", () => {
    const run = (commandLine: string) =>
      kindOf("run_command", `run_command(BypassSandbox=true, CommandLine=${commandLine}, Cwd=/repo)`, JSON.stringify({ CommandLine: commandLine }));

    expect(run("bun test agent-mem/tests/db.test.ts")).toBe("verification");
    expect(run("DAILY_PLAN=a.json npm run validate:daily-plan")).toBe("verification");
    expect(run("python3 -m unittest discover -s tests")).toBe("verification");
    expect(run("git status")).toBe("exploration");
    expect(run('grep -rn "editor" scripts/ skills/')).toBe("exploration");
    expect(run("cd /repo && ls -la test-results")).toBe("exploration");
    expect(run("git commit -m 'feat: x'")).toBe("command");
    expect(kindOf("Bash", "Bash(command=cargo test)", '{"command":"cargo test"}')).toBe("verification");
  });

  it("labels reads and searches as exploration and anything unknown as other", () => {
    for (const type of ["view_file", "Read", "Grep", "Glob", "search_web"]) expect(kindOf(type)).toBe("exploration");
    expect(kindOf("manage_task")).toBe("other");
    expect(kindOf("tool", "Tool execution")).toBe("other");
  });
});
