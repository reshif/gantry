import { describe, expect, it } from "vitest";
import { ROUTES } from "../../lib/routes";
import { helpText, liveAnswer, type LiveCtx } from "./live";

const ctx: LiveCtx = {
  wos: [
    { id: "WO-2417", title: "Split payouts", state: "blocked", stationName: "Build", priority: "P2", blockReason: "no repo access" },
    { id: "WO-2400", title: "Done one", state: "done" },
  ],
  waiting: [{ wo: "WO-2400", gate: "G2" }],
  spend: { mtd: 10, monthly: 100 },
  project: "Payments",
};

describe("console live answers", () => {
  it("answers from live state and says when a work order is unknown", () => {
    expect(liveAnswer("What is blocked?", ctx)).toBe("WO-2417: no repo access");
    expect(liveAnswer("What waits on a person?", ctx)).toContain("WO-2400 (G2)");
    expect(liveAnswer("Status of WO-2417", ctx)).toContain("is blocked at Build");
    expect(liveAnswer("status of WO-9999", ctx)).toBe("I cannot find WO-9999.");
    expect(liveAnswer("hello", ctx)).toBeNull();
    expect(helpText(ctx)).toContain("1 work orders in flight");
  });
  it("Console and Conversations are real nav entries, not redirects", () => {
    for (const id of ["console", "conversations"]) expect(ROUTES.find((r) => r.id === id)?.nav).not.toBe(false);
  });
  it("status carries the share through the current station", () => {
    const c: LiveCtx = { ...ctx, wos: [{ id: "WO-2417", title: "T", state: "running", priority: "P1", progress: 40 }] };
    expect(liveAnswer("status of WO-2417", c)).toContain("Priority P1, 40% through the current station.");
  });
});
