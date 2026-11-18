import { describe, expect, it } from "vitest";
import { splitPatch } from "../src/areas/workorders/split-patch.js";

describe("splitPatch", () => {
  it("cuts a commit's diff into one text per file", () => {
    const m = splitPatch("diff --git a/a.py b/a.py\nindex 1..2\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/dir/b.md b/dir/b.md\n@@ -0,0 +1 @@\n+hi\n");
    expect([...m.keys()]).toEqual(["a.py", "dir/b.md"]);
    expect(m.get("a.py")).toContain("+y");
    expect(m.get("a.py")).not.toContain("hi");
    expect(m.get("dir/b.md")).toBe("diff --git a/dir/b.md b/dir/b.md\n@@ -0,0 +1 @@\n+hi\n");
  });
  it("returns nothing for text that is not a diff", () => {
    expect(splitPatch("hello").size).toBe(0);
  });
});
