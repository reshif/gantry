import { describe, expect, it } from "vitest";
import { gateDecision, gateProgress, type ApproverRule } from "./index.js";
import { seedState } from "./testkit.js";

/** Statechart gaps found by the TLA+ model (items 11 and 14). */
const rule = (over: Partial<ApproverRule> = {}): ApproverRule => ({ roles: ["reviewer"], people: [], required: 2, sod: false, conditions: [], escalateH: 0, fallback: null, ...over });

function waitingGate() {
  const s = structuredClone(seedState());
  const hit = s.workOrders.flatMap((w) => Object.entries(w.gates).filter(([k, g]) => k !== "G0G1" && g.status === "waiting").map(([k]) => ({ w, k })))[0]!;
  return { s, wo: s.workOrders.find((w) => w.id === hit.w.id)!, gate: hit.k };
}

describe("item 11: separation of duties is judged when votes are counted", () => {
  it("the author's earlier vote does not count once SoD is on", () => {
    const { s, wo, gate } = waitingGate();
    const project = s.projects.find((p) => p.id === wo.project)!;
    const other = s.people.find((p) => p.id !== wo.requestedBy)!;
    // The author approved while SoD was off (1 of 2) ...
    project.approvers[gate] = rule({ sod: false });
    wo.gates[gate]!.approvals = [{ by: wo.requestedBy, at: 1 } as never];
    expect(gateProgress(project, wo, gate, s.people).have).toBe(1);
    // ... then SoD is turned on and someone else approves: that is 1 of 2, not 2 of 2.
    project.approvers[gate] = rule({ sod: true });
    wo.gates[gate]!.approvals = [{ by: wo.requestedBy, at: 1 } as never, { by: other.id, at: 2 } as never];
    const p = gateProgress(project, wo, gate, s.people);
    expect(p).toMatchObject({ have: 1, need: 2, passes: false, authorExcluded: true });
  });
  it("with SoD off the author's vote counts as before", () => {
    const { s, wo, gate } = waitingGate();
    const project = s.projects.find((p) => p.id === wo.project)!;
    const other = s.people.find((p) => p.id !== wo.requestedBy)!;
    project.approvers[gate] = rule({ sod: false });
    wo.gates[gate]!.approvals = [{ by: wo.requestedBy, at: 1 } as never, { by: other.id, at: 2 } as never];
    expect(gateProgress(project, wo, gate, s.people)).toMatchObject({ have: 2, passes: true });
  });
});

describe("item 14: a delegate counts only while the away window is active", () => {
  it("not before the leave starts, yes during it, not after", () => {
    const { s, wo, gate } = waitingGate();
    const project = s.projects.find((p) => p.id === wo.project)!;
    const delegate = s.people.find((p) => p.id !== wo.requestedBy && p.status === "active" && p.roles.some((r) => r.role === "reviewer") && !p.roles.some((r) => r.role === "factory_admin"))!;
    const away = s.people.find((p) => p.id !== delegate.id && p.id !== wo.requestedBy)!;
    // Only the away person is a named approver; the delegate has no standing of their own.
    project.approvers[gate] = rule({ roles: [], people: [away.id], sod: false });
    const now = 1_000_000;
    away.away = { from: now + 1000, to: now + 5000, delegate: delegate.id };
    const before = gateDecision(s, delegate.id, wo, gate, now);
    const during = gateDecision(s, delegate.id, wo, gate, now + 2000);
    const after = gateDecision(s, delegate.id, wo, gate, now + 6000);
    expect(during.reason).toMatch(/Delegate for/);
    expect(before.reason).not.toMatch(/Delegate for/);
    expect(after.reason).not.toMatch(/Delegate for/);
  });
});
