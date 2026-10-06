import { describe, expect, it } from "bun:test";
import { extractFilePaths } from "../src/context/files";

describe("extractFilePaths", () => {
  it("finds relative, absolute, and bare file names in prose", () => {
    const text = "Updated src/db/queries.ts and /Users/me/proj/tests/db.test.ts, then touched README.md.";
    expect(extractFilePaths(text)).toEqual(["src/db/queries.ts", "/Users/me/proj/tests/db.test.ts", "README.md"]);
  });

  it("finds paths inside serialized tool arguments", () => {
    expect(extractFilePaths('{"TargetFile":"/repo/app/main.py","Overwrite":true}')).toEqual(["/repo/app/main.py"]);
  });

  it("ignores URLs, property access, versions, and prose slashes", () => {
    const text = "See https://example.com/docs/page.html, call Date.now and data.id, bump to v1.2.3, use and/or.";
    expect(extractFilePaths(text)).toEqual([]);
  });

  it("returns each path once and caps how many it keeps", () => {
    expect(extractFilePaths("a.ts a.ts b.ts")).toEqual(["a.ts", "b.ts"]);
    const many = Array.from({ length: 80 }, (_, i) => `f${i}.ts`).join(" ");
    expect(extractFilePaths(many).length).toBe(50);
  });
});
