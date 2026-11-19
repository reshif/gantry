import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string): string => readFileSync(resolve(process.cwd(), "src", f), "utf8");

// T-53: the drawer content was 536 px inside a 520 px panel because the grid track was auto (min-content). Layout is not run in jsdom,
// so the rule is asserted here and measured for real in e2e/drawer-fit.spec.ts.
describe("the work order drawer lays out inside its panel (T-53)", () => {
  it("the scroll body is one shrinkable column in the work order drawer and the Floor drawers", () => {
    expect(read("views/drawerCol.ts")).toMatch(/gridTemplateColumns: "minmax\(0, 1fr\)"/);
    expect(read("views/traveler/Drawer.tsx")).toMatch(/className="drawer-scroll" style=\{COL\}/);
    expect(read("views/floor/Drawers.tsx")).toMatch(/className="drawer-scroll" style=\{COL\}/);
  });
  it("the action rows wrap and can shrink", () => {
    expect(read("styles/views.css")).toMatch(/\.drawer-actions \{[^}]*flex-wrap: wrap/);
  });
});
