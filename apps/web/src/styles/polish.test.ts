import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("theme review fixes", () => {
  it("the scroll hint sits below the table, not over the last column header", () => {
    const css = read("./blueprint.css");
    expect(css).toMatch(/\.scrollwrap \.sh\{[^}]*bottom:3px/);
    expect(css).not.toMatch(/\.scrollwrap \.sh\{[^}]*top:6px/);
  });
  it("Line at a glance keeps compact rows instead of stretching to the neighbouring column", () => {
    expect(read("./blueprint.css")).toMatch(/\.hb-list\{[^}]*justify-content:flex-start/);
  });
  it("the work orders row chevron is dropped when the last cell holds buttons", () => {
    expect(read("./precision.css")).toContain("td:last-child:has(.btn)::after { content: none; }");
  });
  it("the traveler drawer is a lazy chunk, keeping the record sections out of the entry bundle", () => {
    const src = read("../shell/useTraveler.tsx");
    expect(src).toContain('lazyRetry(() => import("../views/traveler"))');
    expect(src).not.toMatch(/^import Traveler from/m);
  });
  it("Conversations carries its drawing number like every other view", () => {
    expect(read("../views/conversations.tsx")).toContain('drawingNo("conversations")');
  });
  it("the empty Console chat centres its prompt", () => {
    expect(read("./views/console.css")).toContain(".con2-log:has(#con-empty)");
  });
});
