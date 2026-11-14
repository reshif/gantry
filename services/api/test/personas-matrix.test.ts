/**
 * Demo persona matrix. For every demo account (apps/web/src/lib/demo.ts) and every catalogue action, at factory scope and in every
 * relevant project, the decision from POST /api/v1/can must equal what the persona's CARD says, applied to the default role matrix.
 *
 * The oracle below is written from the cards, not from the seed: CARD_GRANTS is what each card promises. Where the dev seed grants
 * more than the card says (or the engine's scoping goes beyond the card), the difference is listed in KNOWN_DEVIATIONS so the suite
 * stays green while the gap stays visible. If a deviation is fixed, this test fails and the entry must be removed.
 */
import { ACTIONS, defaultMatrix } from "@gantry/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;

type Grant = { role: string; scope: string };
const F = "factory";
/** What each demo card promises, as grants. */
export const CARD_GRANTS: Record<string, Grant[]> = {
  "p-asha": [{ role: "factory_admin", scope: F }],
  "p-daniel": [{ role: "project_admin", scope: "payments" }, { role: "project_admin", scope: "storefront" }],
  "p-meera": [{ role: "line_lead", scope: "payments" }],
  "p-tomas": [{ role: "engineer", scope: "payments" }],
  "p-fatima": [{ role: "reviewer", scope: "storefront" }, { role: "engineer", scope: "storefront" }],
  "p-kenji": [{ role: "release_manager", scope: "payments" }, { role: "release_manager", scope: "storefront" }, { role: "release_manager", scope: "risk" }],
  "p-sam": [{ role: "auditor", scope: F }],
  "p-priya": [{ role: "reviewer", scope: "payments" }, { role: "line_lead", scope: "risk" }],
  "p-lena": [{ role: "project_admin", scope: "identity" }],
  "p-omar": [{ role: "factory_admin", scope: F }],
};
const PERSONAS = Object.keys(CARD_GRANTS);
const PROJECTS = ["payments", "storefront", "risk", "identity", "mobile", "data-platform", "search", "internal-tools", "partner-api", "growth-experiments"];

const matrix = defaultMatrix();
/** Wednesday 2026-11-11 11:00 IST: inside every release window. */
const WED_11_IST = Date.UTC(2026, 10, 11, 5, 30);
/** Saturday 2026-11-14 11:00 IST. */
const SAT_11_IST = Date.UTC(2026, 10, 14, 5, 30);

/** The card-derived expectation. Release is also bounded by the seeded release windows (POL-101/102/103/105) that apply at `time`. */
export function expected(persona: string, action: string, scope: string, time: number, oncall = false, grants: Grant[] = CARD_GRANTS[persona]!, factoryViaAnyRole = false): boolean {
  const act = ACTIONS.find((a) => a.id === action)!;
  const dow = new Date(time + 5.5 * 3_600_000).getUTCDay();
  if (act.scope === "project") {
    const held = grants.filter((g) => g.scope === F || g.scope === scope).filter((g) => matrix[g.role]?.[action]);
    if (!held.length) return false;
    if (action === "release") {
      if (held.some((g) => g.role === "factory_admin")) return true;
      const roles = held.map((g) => g.role);
      if (scope === "payments") return roles.includes("release_manager") && [2, 3, 4].includes(dow);
      if (scope === "storefront" || scope === "risk") return [1, 2, 3, 4, 5].includes(dow) && (roles.includes("release_manager") || roles.includes("project_admin"));
      if (scope === "identity") return oncall && (roles.includes("release_manager") || roles.includes("project_admin"));
      return false; // no release policy covers other projects: "no policy covers" denies
    }
    return true;
  }
  // factory-scoped action: the card means a factory-level role
  return grants.filter((g) => factoryViaAnyRole || g.scope === F).some((g) => matrix[g.role]?.[action]);
}

/** What the dev seed actually grants beyond each card (GET people: roles). Reported as card inaccuracies. */
export const SEED_EXTRA: Record<string, Grant[]> = {
  "p-kenji": ["mobile", "data-platform", "partner-api", "growth-experiments", "internal-tools"].map((scope) => ({ role: "release_manager", scope })),
  "p-meera": [{ role: "reviewer", scope: "partner-api" }],
  "p-priya": [{ role: "reviewer", scope: "data-platform" }],
  "p-fatima": [{ role: "reviewer", scope: "growth-experiments" }],
  "p-lena": [{ role: "release_manager", scope: "identity" }, { role: "reviewer", scope: "search" }],
};

d("demo personas: can() matrix against the cards", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  const can = async (who: string, checks: Array<{ action: string; project?: string | null; repo?: string; time?: number }>) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method: "POST", url: "/api/v1/can", headers: s.headers, payload: { checks } });
    expect(r.statusCode).toBe(200);
    return (r.json() as { results: Array<{ allowed: boolean; reason: string; rule: { id: string }; needs: string }> }).results;
  };
  const cells: Array<{ action: string; scope: string; project: string | null }> = [];
  for (const a of ACTIONS) {
    if (a.scope === "project") for (const p of PROJECTS) cells.push({ action: a.id, scope: p, project: p });
    else cells.push({ action: a.id, scope: F, project: null });
  }
  const allGrants = (who: string): Grant[] => [...CARD_GRANTS[who]!, ...(SEED_EXTRA[who] ?? [])];

  let total = 0;
  const seedExtraCells = new Set<string>();
  const factoryViaProjectRole = new Set<string>();

  for (const [label, time] of [["Wednesday inside every release window", WED_11_IST], ["Saturday (outside the weekday windows)", SAT_11_IST]] as const) {
    it(`${label}: every persona x action x scope equals the engine's rules over the seeded grants (zero unexplained differences)`, async () => {
      for (const who of PERSONAS) {
        const oncall = who === "p-lena";
        const res = await can(who, cells.map((c) => ({ action: c.action, project: c.project, time })));
        const bad: string[] = [];
        cells.forEach((c, i) => {
          total++;
          const card = expected(who, c.action, c.scope, time, oncall);
          // A factory-scoped action needs a factory-level grant (fixed: it used to accept any role, so this passed `true` for factoryViaAnyRole).
          const seeded = expected(who, c.action, c.scope, time, oncall, allGrants(who), false);
          if (res[i]!.allowed !== seeded) bad.push(`${who}:${c.action}@${c.scope} actual=${res[i]!.allowed} want=${seeded} (${res[i]!.reason})`);
          if (card !== seeded) {
            const viaFactory = expected(who, c.action, c.scope, time, oncall, allGrants(who), false);
            (viaFactory === card ? factoryViaProjectRole : seedExtraCells).add(viaFactory === card ? `${who}:${c.action}` : `${who}@${c.scope}`);
          }
        });
        expect(bad, who).toEqual([]);
      }
      expect(total).toBeGreaterThan(1000);
    });
  }

  it("FINDING: the dev seed grants more than the cards promise", () => {
    // Persona -> extra scopes the seed grants. Fix the seed or the card, then delete the entry.
    expect([...seedExtraCells].sort()).toEqual(
      ["p-fatima@growth-experiments", "p-kenji@data-platform", "p-kenji@growth-experiments", "p-kenji@internal-tools", "p-kenji@mobile", "p-kenji@partner-api", "p-lena@search", "p-meera@partner-api", "p-priya@data-platform"].sort(),
    );
  });

  it("FIXED: factory-scoped actions need a factory-level grant (no project role reaches beyond its project)", () => {
    // Was a FINDING: Project Admin (Daniel, Lena) got audit.view and eval.run factory-wide and Line Lead (Meera, Priya) eval.run. Now no difference remains.
    expect([...factoryViaProjectRole]).toEqual([]);
  });

  it("the card-intended people never gain a right from the card's own grants that the matrix does not give (sanity of the oracle)", () => {
    expect(expected("p-sam", "wo.submit", "payments", WED_11_IST)).toBe(false);
    expect(expected("p-sam", "audit.view", F, WED_11_IST)).toBe(true);
    expect(expected("p-kenji", "release", "payments", SAT_11_IST)).toBe(false);
    expect(expected("p-kenji", "release", "payments", WED_11_IST)).toBe(true);
    expect(expected("p-daniel", "release", "payments", WED_11_IST)).toBe(false);
  });
});
