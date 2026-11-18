import { describe, expect, it } from "vitest";
import { byFile, previewOf } from "./changes";

describe("Changes: one row per file", () => {
  it("adds a file touched by several commits into one row", () => {
    const rows = byFile([
      { path: "a.py", status: "added", plus: 26, minus: 1 },
      { path: "b.py", status: "added", plus: 5, minus: 0 },
      { path: "a.py", status: "modified", plus: 21, minus: 0 },
      { path: "a.py", status: "modified", plus: 53, minus: 2 },
    ]);
    expect(rows.map((r) => r.path)).toEqual(["a.py", "b.py"]);
    expect(rows[0]).toMatchObject({ plus: 100, minus: 3, status: "modified" });
  });
  it("turns patch text into preview lines and says nothing when there is none", () => {
    expect(previewOf(undefined)).toBeUndefined();
    expect(previewOf("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n")).toEqual([{ t: " ", s: "@@ -1,2 +1,2 @@" }, { t: " ", s: "keep" }, { t: "-", s: "old" }, { t: "+", s: "new" }]);
  });
});
