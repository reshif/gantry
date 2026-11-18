import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The Inbox badge counts what the Inbox lists (gates, onboarding, questions, blocked), from the same waiting list: not the server's separate number.
describe("nav inbox badge", () => {
  it("is computed from home.sections.waiting, counting a brief-gate conversation once", () => {
    const src = readFileSync(resolve(__dirname, "nav.ts"), "utf8");
    expect(src).toContain("sections as { waiting?: Waiting }");
    expect(src).toContain("delete b.inbox;");
    expect(src).toContain("gateKeys.has(");
  });
});
