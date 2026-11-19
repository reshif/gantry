import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string): string => readFileSync(resolve(process.cwd(), "src", f), "utf8");

// T-53: the drawer content was 536 px inside a 520 px panel because the grid track was auto (min-content). Layout is not run in jsdom,
// so the rule is asserted here and measured for real in e2e/drawer-fit.spec.ts.
describe("the work order drawer lays out inside its panel (T-53)", () => {
  it("the scroll body is one shrinkable column and clips nothing sideways", () => {
    const css = read("styles/views.css");
    const rule = css.split("\n").find((l) => l.startsWith(".drawer-scroll {")) ?? "";
    expect(rule).toMatch(/grid-template-columns: minmax\(0, 1fr\)/);
  });
  it("the action rows wrap and can shrink", () => {
    expect(read("styles/views.css")).toMatch(/\.drawer-actions \{[^}]*flex-wrap: wrap/);
  });
});
