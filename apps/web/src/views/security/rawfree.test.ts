import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), "src/views", rel), "utf8");
import { describe, expect, it } from "vitest";

describe("security views use primitives, not raw elements", () => {
  for (const f of ["security.tsx", "security/Stop.tsx"]) {
    it(f, () => {
      const src = read(f);
      expect(src).not.toMatch(/<(input|button|table|select|textarea)[\s>]/);
    });
  }
  it("stuck rows carry no attempt count in the visible line", () => {
    const src = read("system/index.tsx");
    expect(src).not.toContain("· try ${j.attempts}");
    expect(src).not.toContain('d: "flagged jobs"');
  });
});
