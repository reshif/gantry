import { describe, expect, it } from "vitest";
import { toolAllowList } from "../src/areas/internal/spec.js";

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
