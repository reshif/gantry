import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string): string => readFileSync(resolve(process.cwd(), "src", f), "utf8");

describe("Floor and Agents at work show their text whole (T-5, T-6, T-7)", () => {
  const css = read("styles/views/floor-line.css");
  it("the waiting strip and stack stations wrap instead of ending in an ellipsis", () => {
    for (const sel of [".fp-ncard .t1", ".fp-ncard .t2", ".fp-stn-h span", ".fp-valvel span"]) {
      const line = css.split("\n").find((l) => l.includes(`${sel} {`)) ?? "";
      expect(line, sel).not.toMatch(/text-overflow: ellipsis/);
    }
  });
  it("the Board columns wrap to rows so none runs off the page edge", () => {
    expect(css).toMatch(/\.board\.board-fit \{[^}]*grid-auto-flow: row;[^}]*overflow: visible/);
  });
  it("an agent card's work-order title wraps", () => {
    const src = read("views/workspace/AtWork.tsx");
    expect(src).toMatch(/className="wrap-text"><span className="mono">\{w\.id\}/);
    expect(src).not.toMatch(/className="trunc"/);
  });
  it("the drawing wraps station captions rather than cutting them", () => {
    const line = read("views/floor/Line.tsx");
    expect(line).not.toMatch(/trunc\(st\.caption/);
    expect(line).not.toMatch(/trunc\(bay\.bay\.desc/);
  });
});
