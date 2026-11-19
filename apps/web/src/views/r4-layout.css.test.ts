import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string): string => readFileSync(resolve(process.cwd(), "src", f), "utf8");

// Layout is not computed in jsdom, so these pin the rules that fixed the round 4 clips and gaps.
describe("round 4 layout rules", () => {
  it("T-58: a station's run limit fields sit on one row of three columns, one column when narrow", () => {
    const css = read("styles/views/project-config.css");
    expect(css).toMatch(/\.flw-limits \.row \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/max-width: 600px\) \{ \.flw-limits \.row \{ grid-template-columns: minmax\(0, 1fr\)/);
  });
  it("T-63: the agent run limit inputs are number-sized, not page wide", () => {
    expect(read("styles/views/agents.css")).toMatch(/#ag-limits \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(150px, 220px\)\)/);
  });
  it("T-62: the notification route class checkboxes are wide enough for 'Chore / dependency' and wrap rather than clip", () => {
    const css = read("styles/views/notifications.css");
    expect(css).toMatch(/\.nt-checks \{ grid-template-columns: repeat\(auto-fill, minmax\(176px, 1fr\)\)/);
    expect(css).toMatch(/\.nt-checks \.cls \{[^}]*white-space: normal/);
  });
});

describe("T-47: the audit When column", () => {
  it("is held to one line", () => {
    const css = read("styles/views/audit.css");
    expect(css).toMatch(/\.aud-when \{ white-space: nowrap/);
    expect(css).toMatch(/#aud-table td:first-child[^{]*\{[^}]*white-space: nowrap/);
  });
});

describe("T-36, T-49 (blueprint.css)", () => {
  const css = read("styles/blueprint.css");
  it("an unread gate card in the bell drawer is the accent navy", () => {
    // plain .callout is accent on accent-soft; ".warn" was the neutral grey
    expect(css).toMatch(/\.callout\{border:1px solid var\(--line2\);border-left:3px solid var\(--accent\);background:var\(--accent-soft\)/);
    expect(read("shell/NotificationsBody.tsx")).toMatch(/className="callout nt-unread"/);
    expect(read("shell/NotificationsBody.tsx")).not.toMatch(/className="callout warn"/);
  });
  it("a console card is held inside its bubble", () => {
    expect(css).toMatch(/\.bub \.ccard\{[^}]*box-sizing:border-box;max-width:100%/);
    expect(css).toMatch(/\.msg:has\(\.ccard\) \.bub\{flex:1 1 0;max-width:100%/);
  });
});
