import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = (p: string): string => readFileSync(resolve(__dirname, "../styles", p), "utf8");

describe("conversations residual fidelity (ops2-045, 055, 056)", () => {
  it("the prototype thread card drops the legacy .conv-thread padding and gap, and its header wraps on a phone", () => {
    const c = css("views/conversations.css");
    expect(c).toMatch(/\.card\.conv-thread\s*\{[^}]*padding:\s*0/);
    expect(c).toMatch(/\.conv-thread \.card-h\s*\{\s*flex-wrap:\s*wrap/);
  });
  it("the project switcher can shrink at tablet widths so the topbar does not overflow", () => {
    expect(css("foundation.css")).toMatch(/max-width:\s*900px\)\s*\{\s*\.top \.proj-sw\s*\{\s*flex:\s*0 1 auto;\s*min-width:\s*0/);
  });
});
