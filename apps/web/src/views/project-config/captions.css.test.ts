import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("project config captions", () => {
  it("station and gate captions wrap instead of ending in an ellipsis", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/views/project-config.css"), "utf8");
    const rule = css.split("\n").find((l) => l.startsWith(".flw-name"))!;
    expect(rule).not.toMatch(/ellipsis|nowrap|overflow:\s*hidden/);
    expect(css).toMatch(/#pcf-bud-stations \.hm-bar-l \{[^}]*white-space: normal/);
  });
});
