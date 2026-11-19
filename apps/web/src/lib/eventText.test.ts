import { describe, expect, it } from "vitest";
import type { Catalog, EventEntry } from "@gantry/domain";
import { eventSentence } from "./eventText";

const cat = { stations: [{ id: "s0", no: "S0", name: "Intake" }], gates: [{ id: "G0G1", label: "G0+G1" }], bays: [] } as unknown as Catalog;
const name = (id: string | null | undefined) => (id === "p-meera" ? "Meera Iyer" : id === "a-intake" ? "Intake Clerk" : String(id));
const ev = (e: Partial<EventEntry>): EventEntry => ({ id: 1, at: 0, type: "x", ...e });

describe("event sentences", () => {
  it("never show the raw event key", () => {
    for (const type of ["wo.enter", "gate.decision", "wo.submit", "wo.bay", "trust.auto", "halt", "kill", "wo.unknown", "zzz"]) {
      expect(eventSentence(ev({ type, wo: "WO-1" }), { cat, name })).not.toMatch(new RegExp(`(^|\\s)${type.replace(".", "\\.")}(\\s|$)`));
    }
  });
  it("reads as a sentence from the event's own data", () => {
    expect(eventSentence(ev({ type: "wo.enter", wo: "WO-2473", station: "s0" }), { cat, name })).toBe("WO-2473 moved to S0 Intake");
    expect(eventSentence(ev({ type: "gate.decision", wo: "WO-2473", gate: "G0G1", by: "p-meera" }), { cat, name })).toBe("G0+G1 decided by Meera Iyer on WO-2473");
    expect(eventSentence(ev({ type: "wo.submit", wo: "WO-2473", by: "p-meera", text: "Final data export" }), { cat, name })).toBe("Meera Iyer submitted WO-2473: Final data export");
  });
});
