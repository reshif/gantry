import { describe, expect, it } from "vitest";
import { compactPrevious, PREVIOUS_CAP_BYTES, type StationResultRow } from "../src/areas/internal/previous.js";

const row = (station: string, outcome: string, summary: string, output: unknown = { summary }): StationResultRow => ({
  station,
  outcome,
  summary,
  body: { output, usage: [{ model: "m", inputTokens: 10, outputTokens: 5, costUsd: 0.4 }], capabilities: { cancel: true }, adapter: "claude", source: "runner", error: null },
});

describe("previous handoff", () => {
  it("keeps the latest accepted result per station and drops retries, failures, usage and cost", () => {
    const h = compactPrevious(
      [row("spec", "succeeded", "spec v1"), row("spec", "failed", "spec crashed"), row("spec", "succeeded", "spec v2"), row("plan", "needs_person", "asked"), row("plan", "succeeded", "plan ok"), row("build", "interrupted", "")],
      "WO-1",
    );
    expect(h.results.map((r) => [r.station, r.summary])).toEqual([["spec", "spec v2"], ["plan", "plan ok"]]);
    const text = JSON.stringify(h.results);
    for (const noise of ["usage", "costUsd", "capabilities", "adapter", "inputTokens", "spec crashed", "spec v1"]) expect(text).not.toContain(noise);
    expect(h.omitted.attempts).toBe(4);
    expect(h.omitted.note).toContain("WO-1");
  });

  it("caps the size, keeps whole fields that fit and says which were left out", () => {
    const big = "x".repeat(20_000);
    const rows = ["spec", "design", "plan", "build"].map((s) => row(s, "succeeded", `${s} done`, { summary: `${s} done`, notes: big, decisions: ["a", "b"] }));
    const h = compactPrevious(rows, "WO-2");
    expect(Buffer.byteLength(JSON.stringify(h.results))).toBeLessThanOrEqual(PREVIOUS_CAP_BYTES + 4 * 1200);
    for (const r of h.results) {
      expect(r.truncated).toMatchObject({ keptFields: ["summary", "decisions"], omittedFields: ["notes"] });
      expect(r.output).toEqual({ summary: `${r.station} done`, decisions: ["a", "b"] });
    }
  });

  it("passes a small result through untouched and handles an empty history", () => {
    const h = compactPrevious([row("spec", "succeeded", "ok", { summary: "ok", goal: "g" })], "WO-3");
    expect(h.results).toEqual([{ station: "spec", summary: "ok", output: { summary: "ok", goal: "g" } }]);
    expect(compactPrevious([], "WO-3").results).toEqual([]);
  });
});
