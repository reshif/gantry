import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** jsdom does no layout, so these pin the CSS rules that keep tall dialogs and drawers scrollable. */
const css = readFileSync(resolve(__dirname, "../styles/base.css"), "utf8");
const rule = (sel: string): string => {
  const m = new RegExp(`(^|\\n)${sel.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule for ${sel}`);
  return m[2]!;
};

describe("overlay scrolling", () => {
  it("caps a dialog at the viewport height (not a % that never resolves inside the centring grid)", () => {
    const dlg = rule(".dlg");
    expect(dlg).toMatch(/max-height:\s*calc\(100dvh\s*-/);
    expect(dlg).not.toMatch(/max-height:\s*calc\(100%/);
    expect(dlg).toMatch(/flex-direction:\s*column/);
  });

  it("lets the dialog body scroll between the fixed header and footer", () => {
    expect(rule(".dlg-body")).toMatch(/overflow-y:\s*auto/);
    expect(rule(".dlg-body")).toMatch(/min-height:\s*0/);
    expect(rule(".dlg-form")).toMatch(/min-height:\s*0/);
  });

  it("drawers scroll even when their content sets up no scroll area of its own", () => {
    expect(rule(".drawer")).toMatch(/overflow-y:\s*auto/);
  });

  it("the dialog wrapper scrolls when the viewport is shorter than the dialog's minimum", () => {
    expect(rule(".dlg-wrap")).toMatch(/overflow-y:\s*auto/);
  });

  it("popovers and menus are capped to the viewport and scroll inside themselves", () => {
    expect(rule(".pop")).toMatch(/max-height:/);
    expect(rule(".pop")).toMatch(/overflow-y:\s*auto/);
  });
});
