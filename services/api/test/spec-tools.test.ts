import { describe, expect, it } from "vitest";
import type { Queryable } from "@gantry/db";
import { changeFact, toolAllowList } from "../src/areas/internal/spec.js";

describe("the run spec's tool allow-list never carries an unrestricted shell", () => {
  it("runTests becomes test commands", () => {
    const l = toolAllowList({}, { tools: { readRepo: true, runTests: true } });
    expect(l).not.toContain("Bash");
    expect(l).toContain("Bash(npm test:*)");
  });
  it("a bare or wildcard Bash in an explicit list is narrowed to test commands", () => {
    for (const bare of ["Bash", "Bash(*)", "Bash(:*)", "Bash( ** )"]) {
      const l = toolAllowList({ toolAllowList: ["Read", bare] }, {});
      expect(l, bare).not.toContain(bare);
      expect(l, bare).toContain("Bash(npm test:*)");
      expect(l.every((t) => t === "Read" || /^Bash\([a-z]/.test(t)), bare).toBe(true);
    }
    expect(toolAllowList({ toolAllowList: ["Read", "Bash(make lint)"] }, {})).toEqual(["Read", "Bash(make lint)"]);
  });
});

describe("a Build that may write the branch can record its work", () => {
  it("writeBranch grants local git add/commit and read-only git, never a bare Bash, push or a network git", () => {
    const l = toolAllowList({}, { tools: { readRepo: true, writeBranch: true, runTests: true } });
    expect(l).toEqual(expect.arrayContaining(["Edit", "Write", "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)", "Bash(git diff:*)"]));
    expect(l).not.toContain("Bash");
    expect(l.filter((t) => /push|fetch|pull|clone|remote|config/.test(t))).toEqual([]);
  });
});

describe("the handoff states what Build delivered, as a fact (Verify and Review judge it)", () => {
  const rows = (after: object | null): Queryable => ({ query: async () => ({ rows: after ? [{ after }] : [] }) }) as unknown as Queryable;
  const ctx = (station: string) => ({ orgId: "o", woId: "WO-1", station }) as never;
  const prior = [{ station: "build", outcome: "succeeded", summary: "", body: {} }] as never;
  it("zero commits reads as no diff, with the reason", async () => {
    const f = await changeFact(rows({ commits: 0, noop: true, headSha: null }), ctx("verify"), prior);
    expect(f).toMatchObject({ observedBy: "platform", commits: 0, diff: "none" });
    expect(String(f?.note)).toMatch(/no change against the base/);
  });
  it("a missing publish record is not read as a change either", async () => {
    expect(await changeFact(rows(null), ctx("review"), prior)).toMatchObject({ diff: "none" });
  });
  it("a published commit reads as present; Build itself and stations before it get nothing", async () => {
    expect(await changeFact(rows({ commits: 2, headSha: "a".repeat(40), pr: 7, branch: "gantry/WO-1" }), ctx("review"), prior)).toMatchObject({ diff: "present", commits: 2, pullRequest: 7 });
    expect(await changeFact(rows({ commits: 0 }), ctx("build"), prior)).toBeNull();
    expect(await changeFact(rows({ commits: 0 }), ctx("plan"), [] as never)).toBeNull();
  });
});
