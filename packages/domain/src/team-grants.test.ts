import { describe, expect, it } from "vitest";
import { can, checkTeamGrant, DEFAULT_CATALOG, defaultMatrix, grantSource, permissionSources, policyTrace, rolesIn } from "./index.js";
import { mutate, seedState } from "./testkit.js";

const roles = DEFAULT_CATALOG.roles;
const base = seedState();
const projects = base.projects.map((p) => p.id);
const pid = projects[0]!;

describe("checkTeamGrant", () => {
  const ok = (g: { role: string; scope: string }) => checkTeamGrant(roles, projects, g);
  it("allows a project role on a project and a factory role on the factory", () => {
    expect(ok({ role: "reviewer", scope: pid }).ok).toBe(true);
    expect(ok({ role: "auditor", scope: "factory" }).ok).toBe(true);
  });
  it("never lets a team hold Factory Admin", () => {
    const r = ok({ role: "factory_admin", scope: "factory" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.rule?.id).toBe("INV-TEAM-ADMIN");
  });
  it("refuses level/scope mismatches and unknown roles or projects", () => {
    expect(ok({ role: "reviewer", scope: "factory" }).ok).toBe(false);
    expect(ok({ role: "auditor", scope: pid }).ok).toBe(false);
    expect(ok({ role: "ghost", scope: pid }).ok).toBe(false);
    expect(ok({ role: "reviewer", scope: "ghost" }).ok).toBe(false);
  });
});

describe("inherited grants in the policy engine", () => {
  const person = "p-tomas";
  const withTeamGrant = mutate(base, (s) => {
    const p = s.people.find((x) => x.id === person)!;
    p.roles = [{ role: "reviewer", scope: pid, via: "payments" }];
    s.teams = [{ id: "payments", name: "Payments", desc: "" }];
  });
  const m = defaultMatrix();
  const act = Object.keys(m.reviewer!).find((a) => m.reviewer![a] && !m.engineer![a])!;
  it("a team-granted role allows like an own grant, names its source, and stays in scope", () => {
    const d = can(withTeamGrant, person, act, { project: pid });
    expect(d.allowed).toBe(true);
    expect(d.reason).toContain("(via Payments)");
    const other = projects.find((x) => x !== pid)!;
    expect(can(withTeamGrant, person, act, { project: other }).allowed).toBe(false);
  });
  it("prefers the own grant in the reason when both allow", () => {
    const both = mutate(withTeamGrant, (s) => {
      s.people.find((x) => x.id === person)!.roles.push({ role: "reviewer", scope: pid });
    });
    expect(can(both, person, act, { project: pid }).reason).not.toContain("via");
    expect(permissionSources(both, both.people.find((x) => x.id === person)!, act, pid, true).sort()).toEqual(["direct", "payments"]);
    expect(rolesIn(both.people.find((x) => x.id === person), pid).filter((r) => r === "reviewer")).toHaveLength(1);
  });
  it("trace and grantSource say where roles come from", () => {
    expect(grantSource(withTeamGrant, { via: "payments" })).toBe("via Payments");
    expect(grantSource({}, { via: "x" })).toBe("via x");
    expect(grantSource({}, {})).toBe("direct");
    expect(policyTrace(withTeamGrant, person, act, { project: pid }).join("\n")).toContain("Reviewer (via Payments)");
  });
  it("a project-level role, direct or via a team, never satisfies a factory-scoped action", () => {
    const m2 = defaultMatrix();
    expect(m2.project_admin!["audit.view"]).toBe(true);
    const s = mutate(base, (x) => {
      x.people.find((p) => p.id === "p-tomas")!.roles = [{ role: "project_admin", scope: pid }, { role: "project_admin", scope: pid, via: "payments" }];
    });
    for (const a of ["audit.view", "eval.run"]) {
      const d = can(s, "p-tomas", a, {});
      expect(d.allowed, a).toBe(false);
      expect(d.reason).toContain("factory-level role");
    }
    const withFactory = mutate(s, (x) => x.people.find((p) => p.id === "p-tomas")!.roles.push({ role: "auditor", scope: "factory", via: "payments" }));
    expect(can(withFactory, "p-tomas", "audit.view", {}).allowed).toBe(true);
  });
});
