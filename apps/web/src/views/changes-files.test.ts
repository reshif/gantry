import { describe, expect, it } from "vitest";
import { byFile } from "./changes";

describe("Changes: one row per file when only the commit list is known", () => {
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
});
