import { describe, expect, it } from "vitest";
import { eventRows, eventText } from "./eventText";

const name = (id: string | null | undefined) => id ?? "";

describe("activity rows from the live server (audit shape)", () => {
  it("never prints undefined: an audit row reads as its action and target", () => {
    const rows = eventRows({ items: [{ id: 5, at: 1, actor: "p1", action: "wo.submit", target: "WO-1008", project: "x" }, { id: 6, at: 2, actor: "p1", action: "gate.decision", target: "gate G5" }] });
    const lines = rows.map((r) => eventText(r, null, name));
    expect(lines[0]).toBe("WO-1008 submitted");
    expect(lines[1]).toBe("a gate decided by p1");
    for (const l of lines) expect(l).not.toContain("undefined");
  });
  it("reads the real audit shape: the work order comes from entity, the type is the action", () => {
    const row = { id: 9, at: 1, actor: "p-arjun", action: "gate.decision", target: "wo WO-1001", entity: { type: "wo", id: "WO-1001" }, project: "nautobot-jobs" };
    const e = eventRows([row])[0]!;
    expect(e.wo).toBe("WO-1001");
    expect(eventText(e, null, name)).toBe("WO-1001 a gate decided by p-arjun");
    expect(eventText(eventRows([{ ...row, action: "wo.submit" }])[0]!, null, name)).toBe("WO-1001 submitted");
    expect(eventText(eventRows([{ ...row, action: "run.started", target: "run r-1", entity: { type: "run", id: "r-1" } }])[0]!, null, name)).toBe("run r-1");
  });
  it("still reads the prototype event shape", () => {
    expect(eventText(eventRows([{ id: 1, at: 1, type: "release", text: "WO-1" }])[0]!, null, name)).toBe("Released WO-1");
  });
  it("reads the station an audit row recorded in its after text", () => {
    const row = { id: 9, at: 1, actor: "p1", action: "wo.enter", target: "WO-1001", entity: { type: "wo", id: "WO-1001" }, after: JSON.stringify({ station: "build" }) };
    expect(eventText(eventRows([row])[0]!, { stations: [{ id: "build", name: "Build" }], gates: [], bays: [] } as never, name)).toBe("WO-1001 entered Build");
    expect(eventText(eventRows([{ ...row, after: "not json" }])[0]!, null, name)).toBe("WO-1001 entered a station");
  });
});
