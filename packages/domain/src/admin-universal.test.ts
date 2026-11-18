import { describe, expect, it } from "vitest";
import { can, checkMatrixEdit, defaultMatrix, DEFAULT_CATALOG, isFactoryAdmin, istTime } from "./index.js";
import { seedState } from "./testkit.js";

/** Owner decision 2026-11-19: Factory Admin is universal. */
const fri22 = istTime("2026-11-20", "22:00");

describe("A: the Factory Admin column is locked on", () => {
  it("refuses to switch off any factory_admin cell", () => {
    const S = seedState();
    const m = defaultMatrix(DEFAULT_CATALOG.actions);
    for (const a of DEFAULT_CATALOG.actions) {
      const r = checkMatrixEdit(m, S.people, { role: "factory_admin", action: a.id, value: false });
      expect(r.ok, a.id).toBe(false);
    }
  });
  it("can() grants the admin every right even if the stored matrix has the cell off", () => {
    const S = structuredClone(seedState());
    S.matrix.factory_admin = { ...S.matrix.factory_admin, "audit.view": false };
    expect(can(S, "p-asha", "audit.view", { time: fri22 }).allowed).toBe(true);
  });
});

describe("B: allow policies never restrict a Factory Admin", () => {
  const withoutAdminPolicies = () => {
    const S = structuredClone(seedState());
    S.policies = S.policies.filter((p) => p.id !== "POL-105");
    return S;
  };
  it("a time-window allow policy naming no admin does not lock Asha out (POL-105 removed)", () => {
    const S = withoutAdminPolicies();
    const d = can(S, "p-asha", "release", { project: "payments", repo: "payments-api", time: fri22 });
    expect(d.allowed).toBe(true);
    // a non-admin is still held to the window
    expect(can(S, "p-kenji", "release", { project: "payments", repo: "payments-api", time: fri22 }).allowed).toBe(false);
  });
  it('"*" in an allow policy means anyone', () => {
    const S = structuredClone(seedState());
    S.policies = S.policies.filter((p) => !p.actions.includes("release") || p.effect === "deny");
    S.policies.push({ id: "POL-X", name: "Anyone", enabled: true, effect: "allow", roles: ["*"], actions: ["release"], where: {}, when: null, oncallOnly: false } as never);
    const kenji = can(S, "p-kenji", "release", { project: "payments", repo: "payments-api", time: fri22 });
    expect(kenji.rule.id).toBe("POL-X");
    expect(kenji.allowed).toBe(true);
  });
});

describe("E: isFactoryAdmin needs factory scope", () => {
  it("a factory_admin grant on one project is not a Factory Admin", () => {
    const S = structuredClone(seedState());
    const t = S.people.find((p) => p.id === "p-tomas")!;
    t.roles = [{ role: "factory_admin", scope: "payments" }];
    expect(isFactoryAdmin(S, "p-tomas")).toBe(false);
    expect(isFactoryAdmin(S, "p-asha")).toBe(true);
  });
});
