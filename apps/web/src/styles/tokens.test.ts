import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastFailures, darkBlocksDiff, parseThemes, ratio, resolve, runChecks } from "../../scripts/tokens-lib.mjs";
import fs from "node:fs";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tokens = fs.readFileSync(path.join(srcDir, "styles", "tokens.css"), "utf8");

describe("design tokens", () => {
  it("every colour pair the UI uses meets WCAG in light and both dark blocks", () => {
    expect(contrastFailures(tokens)).toEqual([]);
  });

  it("has no var(--x) without a definition (runtime-set --heat/--g/--v excepted)", () => {
    expect(runChecks(srcDir).undefinedVars).toEqual([]);
  });

  it("keeps the two dark blocks identical", () => {
    expect(darkBlocksDiff(tokens)).toEqual([]);
  });

  it("resolves the aliases views relied on without defining", () => {
    const { light } = parseThemes(tokens);
    for (const n of ["--surface-2", "--hover", "--c-bad", "--danger", "--paper-2", "--text", "--mono", "--topbar-h", "--focus-ring", "--z-modal", "--dur-base", "--target-min"]) expect(light[n], n).toBeTruthy();
    expect(resolve(light, "--c-bad")).toBe(resolve(light, "--block"));
  });

  it("--faint is readable text on every surface in light mode", () => {
    const { light } = parseThemes(tokens);
    for (const bg of ["--bg", "--surface", "--panel", "--sunk"]) expect(ratio(resolve(light, "--faint"), resolve(light, bg)), bg).toBeGreaterThanOrEqual(4.5);
  });

  describe("the checker itself", () => {
    it("computes known ratios", () => {
      expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 0);
      expect(ratio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
    });
    it("flags a pair that fails, so a regression in tokens.css is caught", () => {
      const bad = tokens.replace("--ink3:#566478;", "--ink3:#d0d5dc;");
      expect(contrastFailures(bad).some((f) => f.fg === "--faint" && f.theme === "light")).toBe(true);
    });
    it("flags dark blocks that drift", () => {
      const bad = tokens.replace(/(:root\[data-theme="dark"\] \{[\s\S]*?--ink3:)#93aed1/, "$1#999999");
      expect(darkBlocksDiff(bad)).toContain("--ink3");
    });
  });
});
