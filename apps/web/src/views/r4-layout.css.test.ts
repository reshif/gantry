import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string): string => readFileSync(resolve(process.cwd(), "src", f), "utf8");

// Layout is not computed in jsdom, so these pin the rules that fixed the round 4 clips and gaps.
describe("round 4 layout rules", () => {
  it("T-58: a station's run limit fields sit on one row of three columns", () => {
    expect(read("views/project-config/flow-line.tsx")).toMatch(/className="flw-limit-row" style=\{\{ display: "grid", gridTemplateColumns: "repeat\(3, minmax\(0, 1fr\)\)"/);
  });
  it("T-63: the agent run limit inputs are number-sized, not page wide", () => {
    expect(read("styles/views/agents.css")).toMatch(/#ag-limits\{grid-template-columns:repeat\(auto-fit,minmax\(150px,220px\)\)/);
  });
  it("T-62: the notification route class checkboxes are wide enough for 'Chore / dependency'", () => {
    expect(read("views/notifications/Routes.tsx")).toMatch(/nt-checks" style=\{\{ gridTemplateColumns: "repeat\(auto-fill, minmax\(160px, 1fr\)\)"/);
  });
});

describe("T-36, T-49 (blueprint.css)", () => {
  const css = read("styles/blueprint.css");
  const con = read("styles/views/console.css");
  it("an unread gate card in the bell drawer is the accent navy", () => {
    // plain .callout is accent on accent-soft; ".warn" was the neutral grey
    expect(css).toMatch(/\.callout\{border:1px solid var\(--line2\);border-left:3px solid var\(--accent\);background:var\(--accent-soft\)/);
    expect(read("shell/NotificationsBody.tsx")).toMatch(/className="callout nt-unread"/);
    expect(read("shell/NotificationsBody.tsx")).not.toMatch(/className="callout warn"/);
  });
  it("a console card is held inside its bubble", () => {
    expect(con).toMatch(/\.msg:has\(\.ccard\) \.bub\{max-width:100%;overflow-x:hidden\}/);
  });
});
