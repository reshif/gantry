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

  describe("precision theme", () => {
    it("defines the seven new tokens in light and both dark blocks", () => {
      const { light, darkMedia, darkAttr } = parseThemes(tokens);
      for (const n of ["--station", "--station-head", "--split", "--split-soft", "--on-warn", "--warn-solid", "--hatch", "--control-line"]) {
        for (const v of [light, darkMedia, darkAttr]) expect(v[n], n).toBeTruthy();
      }
    });
    it("meaning colours are readable text on every surface in both themes", () => {
      const { light, darkAttr } = parseThemes(tokens);
      for (const [name, v] of [["light", light], ["dark", darkAttr]] as const) {
        for (const fg of ["--ink", "--ink2", "--ink3", "--accent", "--warn", "--bad", "--ok", "--split"]) {
          for (const bg of ["--bg", "--surface", "--surface2"]) expect(ratio(resolve(v, fg), resolve(v, bg)), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(ratio(resolve(v, "--on-warn"), resolve(v, "--warn-solid")), `${name} on-warn`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(resolve(v, "--bg"), resolve(v, "--ink")), `${name} primary btn`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(resolve(v, "--control-line"), resolve(v, "--surface")), `${name} control border`).toBeGreaterThanOrEqual(3);
      }
    });
    it("uses the warm neutral palette: charcoal dark, off-white light, clay accent", () => {
      const { light, darkAttr } = parseThemes(tokens);
      expect(darkAttr["--bg"]).toBe("#1f1e1c");
      expect(darkAttr["--accent"]).toBe("#e08a63");
      expect(light["--bg"]).toBe("#f5f4ef");
      expect(light["--warn-solid"]).toBe("#f4b429");
    });
    it("panels carry no offset shadow and no permanent corner ticks; only data-hot keeps them", () => {
      const css = fs.readFileSync(path.join(srcDir, "styles", "precision.css"), "utf8");
      expect(css).toMatch(/\.panel, \.stat, \.card[^{]*\{ box-shadow: none; \}/);
      expect(css).toMatch(/\.panel::before, \.panel::after \{ content: none; \}/);
      expect(css).toMatch(/\.panel\[data-hot\]::before/);
      expect(tokens).toContain("--t-title: 21px");
    });
    it("precision.css is the last stylesheet loaded", () => {
      const idx = fs.readFileSync(path.join(srcDir, "styles", "index.ts"), "utf8").trim().split("\n");
      expect(idx[idx.length - 1]).toContain("precision.css");
    });
  });

  describe("the checker itself", () => {
    it("computes known ratios", () => {
      expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 0);
      expect(ratio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
    });
    it("flags a pair that fails, so a regression in tokens.css is caught", () => {
      const bad = tokens.replace(/--ink3:#[0-9a-f]{6};/, "--ink3:#d0d5dc;");
      expect(contrastFailures(bad).some((f) => f.fg === "--faint" && f.theme === "light")).toBe(true);
    });
    it("flags dark blocks that drift", () => {
      const bad = tokens.replace(/(:root\[data-theme="dark"\] \{[\s\S]*?--ink3:)#[0-9a-f]{6}/, "$1#999999");
      expect(darkBlocksDiff(bad)).toContain("--ink3");
    });
  });
});
