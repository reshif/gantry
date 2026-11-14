import { describe, expect, it } from "vitest";
import { ALWAYS_ON_GATES, COMBINED_GATES, GATES, approvalText, gateExplain, gateKindText, gateLock, gateTitle, route, routeGates, DEFAULT_CATALOG } from "./index.js";
import { seedState } from "./testkit.js";

const gate = (id: string) => GATES.find((g) => g.id === id)!;

describe("gate naming and explanation", () => {
  it("puts the name first and the code second, and says G0+G1 is one gate", () => {
    expect(gateTitle(gate("G0G1"))).toBe("Brief confirmed · G0+G1");
    expect(gateExplain(gate("G0G1"))).toMatch(/One gate\./);
    expect(gateExplain(gate("G3G3s"))).toMatch(/security checks run automatically/);
    expect(Object.keys(COMBINED_GATES).sort()).toEqual(["G0G1", "G3G3s"]);
  });
  it("names the kind in words", () => {
    expect([gateKindText("human"), gateKindText("auto"), gateKindText("mixed")]).toEqual(["person", "automatic", "person + automatic"]);
  });
  it("reads the approvals from the rule", () => {
    const rule = { roles: ["reviewer", "line_lead"], people: [], required: 2, sod: true, conditions: [], escalateH: 8, fallback: null };
    expect(approvalText(gate("G5"), "human", rule)).toBe("2 approvals: reviewer / line_lead");
    expect(approvalText(gate("G3G3s"), "mixed", { ...rule, required: 1 })).toBe("Checks, then 1 approval: reviewer / line_lead");
    expect(approvalText(gate("G4"), "auto", undefined)).toMatch(/^No approvals/);
    expect(approvalText(gate("G0G1"), "human", { ...rule, roles: ["engineer", "line_lead"], required: 1 })).toBe("1 approval: the submitter, or line_lead");
    expect(approvalText(gate("G2"), "human", undefined)).toMatch(/Factory Admin/);
  });
});

describe("gate locks", () => {
  it("locks the gates that guard merge, checks, security and the brief, each with a reason", () => {
    for (const id of ["G0G1", "G3G3s", "G4", "G5"]) {
      const l = gateLock({ id });
      expect(l.locked, id).toBe(true);
      expect(l.reason).toBe(ALWAYS_ON_GATES[id]);
    }
    expect(gateLock({ id: "G5" }).reason).toMatch(/I1/);
  });
  it("lets the rest be turned off, unless the project is regulated", () => {
    for (const id of ["G1f", "G2", "G3d", "G6", "custom-gate"]) {
      expect(gateLock({ id }).locked, id).toBe(false);
      expect(gateLock({ id }, { regulated: true })).toEqual({ locked: true, reason: "Regulated projects keep every gate on." });
    }
  });
  it("a gate turned off drops out of the route of new work orders; locked ones never do", () => {
    const p = seedState().projects.find((x) => x.id === "payments")!;
    const flow = structuredClone(p.flow);
    flow.gates.G3d!.enabled = false;
    const off = { ...p, flow };
    expect(routeGates(DEFAULT_CATALOG, p, "feature")).toContain("G3d");
    expect(routeGates(DEFAULT_CATALOG, off, "feature")).not.toContain("G3d");
    expect(routeGates(DEFAULT_CATALOG, off, "feature")).toEqual(expect.arrayContaining(["G0G1", "G5"]));
    expect(route(DEFAULT_CATALOG, off, "feature")).toContain("design");
  });
});
