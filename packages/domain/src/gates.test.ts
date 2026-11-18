import { describe, expect, it } from "vitest";
import { ALWAYS_ON_GATES, COMBINED_GATES, GATES, approvalText, classRequiredError, requiredFor, gateProgress, gateDecision, ruleText, gateExplain, gateKindText, gateLock, gateLockView, gateModeLock, gatePendingName, gatePendingTitle, gateTitle, route, routeGates, DEFAULT_CATALOG } from "./index.js";
import { NOW, seedState } from "./testkit.js";

const gate = (id: string) => GATES.find((g) => g.id === id)!;

describe("gate naming and explanation", () => {
  it("puts the name first and the code second, and says G0+G1 is one gate", () => {
    expect(gateTitle(gate("G0G1"))).toBe("Brief confirmed · G0+G1");
    expect(gateExplain(gate("G0G1"))).toMatch(/One gate\./);
    expect(gateExplain(gate("G3G3s"))).toMatch(/security checks run automatically/);
    expect(Object.keys(COMBINED_GATES).sort()).toEqual(["G0G1", "G3G3s"]);
  });
  it("titles a waiting gate with what to do, never with the outcome it waits for", () => {
    expect(gatePendingTitle(gate("G2"))).toBe("Approve spec · G2");
    expect(gatePendingTitle(gate("G0G1"))).toBe("Confirm brief · G0+G1");
    expect(gateTitle(gate("G2"))).toBe("Spec approved · G2"); // the done wording is unchanged
    for (const g of GATES.filter((x) => x.id !== "G5")) expect(gatePendingName(g), g.id).not.toBe(g.name); // G5 is already worded as an action
    expect(gatePendingName({ id: "X1", name: "Legal sign-off" })).toBe("Approve legal sign-off");
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

describe("per-class approvals required", () => {
  const rule = { roles: ["reviewer", "line_lead"], people: [], required: 2, classRequired: { docs: 1 }, sod: true, conditions: [], escalateH: 0, fallback: null };
  it("a Docs work order needs 1 and a Code one needs 2; a missing override uses the base count", () => {
    expect(requiredFor(rule, "docs")).toBe(1);
    expect(requiredFor(rule, "feature")).toBe(2);
    expect(requiredFor(rule, undefined)).toBe(2);
    expect(requiredFor({ required: 2 }, "docs")).toBe(2);
    expect(approvalText(gate("G5"), "human", rule, undefined, undefined, "docs")).toBe("1 approval: reviewer / line_lead");
    expect(approvalText(gate("G5"), "human", rule, undefined, undefined, "feature")).toBe("2 approvals: reviewer / line_lead");
    expect(ruleText(rule, (x) => x, (x) => x, "docs")).toMatch(/^Needs 1 approval from/);
    const S = seedState();
    const project = S.projects.find((p) => p.id === "payments")!;
    project.approvers.G5 = structuredClone(rule);
    const wo = structuredClone(S.workOrders.find((w) => w.project === "payments" && w.gates.G5))!;
    wo.gates.G5!.approvals = [{ by: "p-priya", at: NOW, via: "web" }];
    expect(gateProgress(project, { ...wo, cls: "docs" }, "G5", S.people)).toMatchObject({ have: 1, need: 1, passes: true });
    expect(gateProgress(project, { ...wo, cls: "feature" }, "G5", S.people)).toMatchObject({ have: 1, need: 2, passes: false });
  });
  it("the author is still refused at a count of 1 (separation of duties is untouched)", () => {
    const S = seedState();
    const project = S.projects.find((p) => p.id === "payments")!;
    project.approvers.G5 = structuredClone(rule);
    const wo = structuredClone(S.workOrders.find((w) => w.project === "payments" && w.gates.G5))!;
    wo.cls = "docs";
    wo.gates.G5!.status = "waiting";
    wo.gates.G5!.approvals = [];
    wo.requestedBy = "p-priya";
    const d = gateDecision(S, "p-priya", wo, "G5", NOW);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/author/i);
    expect(gateDecision(S, "p-meera", wo, "G5", NOW).allowed).toBe(true); // someone else may
  });
  it("rejects 0, negative, fractional and huge counts, and unknown classes", () => {
    const classes = new Set(["docs", "feature"]);
    expect(classRequiredError({ docs: 0 }, classes)).toMatch(/at least 1/);
    expect(classRequiredError({ docs: -1 }, classes)).toMatch(/at least 1/);
    expect(classRequiredError({ docs: 1.5 }, classes)).toMatch(/whole number/);
    expect(classRequiredError({ docs: 10 }, classes)).toMatch(/more than 9/);
    expect(classRequiredError({ nope: 1 }, classes)).toMatch(/does not have/);
    expect(classRequiredError({ docs: 1 }, classes)).toBeNull();
    expect(classRequiredError(undefined, classes)).toBeNull();
  });
});

describe("Factory Admin override of the gate locks (owner decision 2026-11-19)", () => {
  const g = (id: string) => DEFAULT_CATALOG.gates.find((x) => x.id === id)!;
  it("lifts the permission locks on a mode, except G5, and keeps the correctness rule", () => {
    expect(gateModeLock(g("G3G3s"), "auto", null)).not.toBeNull();
    expect(gateModeLock(g("G3G3s"), "auto", null, { override: true })).toBeNull();
    expect(gateModeLock(g("G4"), "auto", { regulated: true })).not.toBeNull();
    expect(gateModeLock(g("G4"), "auto", { regulated: true }, { override: true })).toBeNull();
    for (const m of ["auto", "mixed"] as const) expect(gateModeLock(g("G5"), m, null, { override: true })).toMatch(/I1|merge/);
    // a gate that a person decides and has no checks would pass with no evidence, for an admin too
    for (const id of ["G0G1", "G2", "G6"]) expect(gateModeLock(g(id), "auto", null, { override: true }), id).toMatch(/no automatic checks/);
    expect(gateModeLock(g("G5"), "human", null, { override: true })).toBeNull();
  });
  it("describes a gate's lock for the viewer from a decision, not a role name; G5 is never overridable", () => {
    const flow = { gates: { G4: { enabled: false, mode: "auto" as const, override: { off: { by: "p-asha", byName: "Asha", at: 1, reason: "Because we decided so" } } } }, stations: {} };
    expect(gateLockView(g("G4"), { flow }, true)).toMatchObject({ locked: true, overridable: true, viewerMayOverride: true, overridden: { by: "p-asha" } });
    expect(gateLockView(g("G4"), { flow }, false)).toMatchObject({ viewerMayOverride: false });
    expect(gateLockView(g("G5"), null, true)).toMatchObject({ locked: true, overridable: false, viewerMayOverride: false });
    expect(gateLockView(g("G2"), null, true)).toMatchObject({ locked: false, overridable: false, viewerMayOverride: false });
    expect(gateLockView(g("G2"), { regulated: true }, true)).toMatchObject({ locked: true, overridable: true, viewerMayOverride: true });
  });
});
