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
  it("still reads the prototype event shape", () => {
    expect(eventText(eventRows([{ id: 1, at: 1, type: "release", text: "WO-1" }])[0]!, null, name)).toBe("Released WO-1");
  });
});
