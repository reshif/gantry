import { describe, expect, it } from "vitest";
import { applyBriefDraft, briefBase, briefDiff, resolveBriefDraft } from "./workorder-session.js";

const ok = { goal: "Accept an Idempotency-Key header on refund requests.", scopeIn: ["POST /refunds"], ac: ["A repeated key returns the first refund"] };

describe("the rails on an agent-authored brief", () => {
  it("accepts a real brief and bounds the lists", () => {
    const r = resolveBriefDraft({ ...ok, risks: Array.from({ length: 30 }, (_, i) => `risk ${i}`) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.draft.risks).toHaveLength(8);
  });
  it("gives every reason when refused, and never lets a credential into a brief", () => {
    const r = resolveBriefDraft({ goal: "short", scopeIn: [], ac: [] });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reasons).toHaveLength(3);
    const s = resolveBriefDraft({ ...ok, scopeIn: ["use api_key: sk-abcdefghijklmnop"] });
    expect(s.ok).toBe(false);
  });
});

describe("the brief diff", () => {
  it("lists only what differs, field by field, and the fingerprint moves when the brief does", () => {
    const cur = { goal: "Old goal", scopeIn: ["a"], scopeOut: [], ac: ["x"], risks: [], open: [], decisions: [], estimate: "", route: [], children: [] };
    const r = resolveBriefDraft({ ...ok, scopeIn: ["a", "b"] });
    if (!r.ok) throw new Error("draft");
    const d = briefDiff(cur, r.draft);
    expect(d.map((x) => x.field)).toEqual(["goal", "scopeIn", "ac"]);
    expect(d.find((x) => x.field === "scopeIn")).toMatchObject({ added: ["b"], removed: [] });
    expect(briefBase(cur)).not.toBe(briefBase(applyBriefDraft(cur, r.draft)));
    expect(applyBriefDraft(cur, r.draft)).toMatchObject({ goal: ok.goal, route: [], children: [] });
  });
});

describe("briefDiff against a seeded brief", () => {
  it("does not show Gantry's own placeholders as removals, and shows answered questions as resolved", () => {
    const current = { goal: "Add retry", scopeIn: [], scopeOut: ["UI changes unless stated", "Data backfills unless stated"], ac: [], risks: [], open: ["How will we know it is done?"], decisions: [], estimate: "M" };
    const next = { goal: "Add retry with backoff to the device sync job", scopeIn: ["Device sync job"], scopeOut: ["Admin API"], ac: ["Retries 3 times with backoff"], risks: [], open: [], decisions: [], estimate: "M" };
    const d = briefDiff(current, next);
    const out = d.find((x) => x.field === "scopeOut")!;
    expect(out.removed).toEqual([]);
    expect(out.added).toEqual(["Admin API"]);
    const open = d.find((x) => x.field === "open")!;
    expect(open.removed).toEqual([]);
    expect(open.resolved).toEqual(["How will we know it is done?"]);
    // a person's own words still show as removed
    expect(briefDiff({ ...current, scopeIn: ["Mobile app"] }, next).find((x) => x.field === "scopeIn")!.removed).toEqual(["Mobile app"]);
  });
});
