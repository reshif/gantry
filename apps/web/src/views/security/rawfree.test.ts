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
  it("the restore toggle toasts Enabled or Disabled, as the prototype does", () => {
    const src = read("security.tsx");
    expect(src).toContain('`${v ? "Enabled" : "Disabled"} Two admins to restore`');
    expect(src).not.toContain("One Factory Admin can restore the factory.");
  });
  it("dead letters have no sort glyphs", () => {
    const src = read("system/index.tsx");
    const block = src.slice(src.indexOf('id="sys-dead"'), src.indexOf("</DataTable>") > 0 ? src.indexOf("</DataTable>") : undefined);
    expect(block.slice(0, block.indexOf("/>"))).not.toContain("sort: true");
  });
});
