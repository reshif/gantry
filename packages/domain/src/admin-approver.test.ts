import { describe, expect, it } from "vitest";
import { gateApprovers, reachOf, ruleWarning, type ApproverRule, type Person } from "./index.js";
import { seedState } from "./testkit.js";

/** Owner decision 2026-11-19: a Factory Admin is a normal, eligible approver on every gate; separation of duties still bars the author. */
const admin = (id: string): Person => ({ id, name: id, title: "", email: "", teams: [], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, away: null, mfa: true } as unknown as Person);
const rule = (over: Partial<ApproverRule> = {}): ApproverRule => ({ roles: ["reviewer"], people: [], required: 1, sod: false, conditions: [], escalateH: 0, fallback: null, ...over });
const project = { id: "payments", name: "Payments" };

describe("Factory Admin as an approver", () => {
  it("the domain counts an active Factory Admin as reach, and not a suspended one", () => {
    expect(reachOf([admin("a1")], project, rule()).map((p) => p.id)).toEqual(["a1"]);
    expect(reachOf([{ ...admin("a1"), status: "suspended" } as Person], project, rule())).toEqual([]);
  });
  it("a project with one Factory Admin and a 1-approval gate without sod has no warning", () => {
    expect(ruleWarning([admin("a1")], project, rule(), "G2")).toBeNull();
  });
  it("with sod the author admin is not reached, so the gate warns for a single admin", () => {
    expect(reachOf([admin("a1")], project, rule({ sod: true }), "a1")).toEqual([]);
    expect(ruleWarning([admin("a1")], project, rule({ required: 2 }), "G2")).toMatch(/cannot pass/);
  });
  it("the sod warning says an author's work order passes only by an audited override with a reason", () => {
    const w = ruleWarning([admin("a1")], project, rule({ sod: true }), "G2");
    expect(w).toContain("can pass this gate only by an override with a reason (audited)");
    expect(w).not.toMatch(/never pass|ordinary approval/);
  });
  it("gateApprovers: an admin is eligible; the author admin on a sod gate is override only", () => {
    const s = seedState();
    const hit = s.workOrders.flatMap((w) => Object.entries(w.gates).filter(([k, g]) => k !== "G0G1" && g.status === "waiting").map(([k]) => ({ w, k })))[0]!;
    const wo = hit.w, gate = hit.k;
    const st = structuredClone(s);
    const proj = st.projects.find((p) => p.id === wo.project)!;
    proj.approvers[gate] = rule({ roles: [], sod: true });
    const author = st.people.find((p) => p.id === wo.requestedBy)!;
    author.roles = [...author.roles, { role: "factory_admin", scope: "factory" }];
    const other = st.people.find((p) => p.id !== wo.requestedBy && p.status === "active" && p.roles.some((g) => g.role === "factory_admin"));
    const ga = gateApprovers(st, wo, gate, Date.now())!;
    expect(ga.eligible.map((e) => e.id)).not.toContain(author.id);
    expect(ga.overrides.map((o) => o.id)).toContain(author.id);
    if (other) expect(ga.eligible.map((e) => e.id)).toContain(other.id);
  });
});
