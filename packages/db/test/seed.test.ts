import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDevOrg, type SeedState } from "../src/seed.js";
import { withTx } from "../src/tx.js";
import { createTestDb, TEST_URL, type TestDb } from "./helpers.js";

const state: SeedState = {
  org: { id: "acme", name: "Acme Payments", plant: "Plant 1", tz: "IST" },
  teams: [{ id: "payments", name: "Payments", desc: "Cards" }],
  people: [
    { id: "p-asha", name: "Asha", email: "asha@acme.dev", teams: ["payments"], roles: [{ role: "factory_admin", scope: "factory" }], mfa: true },
    { id: "p-meera", name: "Meera", email: "meera@acme.dev", teams: ["payments"], roles: [{ role: "line_lead", scope: "payments" }], away: { to: 1 } },
  ],
  matrix: { factory_admin: { "kill.factory": true }, line_lead: { "wo.move": true } },
  templates: [{ id: "tpl-backend", name: "Backend", builtIn: true }],
  projects: [{
    id: "payments", key: "PAY", name: "Payments Platform", status: "active", teams: ["payments"], owner: "p-asha", template: "tpl-backend", created: 1_700_000_000_000,
    flow: { order: ["intake"], gates: { G2: { enabled: true, mode: "human" } } }, approvers: { G2: { roles: ["line_lead"], required: 1 } },
    notifications: [{ event: "kill", dest: [{ channel: "slack", target: "#incidents" }] }], budget: { monthly: 7000, alertAt: 0.8 }, overlay: "Money moves here.",
  }],
  repos: [{ id: "payments-api", name: "acme/payments-api", project: "payments", team: "payments", tags: ["pci"], lang: "Go", config: { requiredChecks: ["ci/test"] }, onboarding: { stage: "ready", readyAt: 1_700_000_000_000 } }],
  skills: [{ id: "sk-spec", name: "Spec writing", versions: [{ v: "1.0.0" }, { v: "1.2.0", note: "tighter" }] }],
  agents: [{ id: "ag-spec", name: "Spec Writer", station: "spec", skills: ["sk-spec"], instructions: "Write a spec.", versions: [{ v: "2.0.0" }, { v: "2.1.0", live: true }] }],
  vendors: [{ id: "anthropic", name: "Anthropic", connected: true, keyMask: "sk-ant-••••3f9a", budget: 9000, models: [{ id: "claude-opus-5-5", name: "Opus", inPrice: 5, outPrice: 25 }] }],
  policies: [{ id: "pol-ip", name: "IP allowlist", kind: "network" }],
  routing: { defaultModel: "claude-opus-5-5" },
  security: { mfa: { policy: "admins" } },
  instructions: { base: "You work inside Gantry." },
  freezes: [{ id: "fz-1", name: "Year end", from: 1_700_000_000_000 }],
};

describe.skipIf(!TEST_URL)("seedDevOrg", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => db.drop());

  it("inserts a dev org from legacy-shaped state, as the app role", async () => {
    const r = await withTx(db.app, async (tx) => {
      // gantry_app cannot insert orgs? it can (INSERT granted); everything else is plain inserts.
      return seedDevOrg(tx, state);
    });
    expect(r.created).toBe(true);
    const n = async (t: string) => Number((await db.admin.query(`select count(*) from ${t} where org_id = $1`, [r.orgId])).rows[0].count);
    expect([await n("people"), await n("team_members"), await n("projects"), await n("repos"), await n("repo_config")]).toEqual([2, 2, 1, 1, 1]);
    expect([await n("role_assignments"), await n("roles"), await n("role_matrix_versions"), await n("flow_versions"), await n("approver_rule_versions")]).toEqual([2, 2, 1, 1, 1]);
    expect([await n("skill_versions"), await n("agent_versions"), await n("models"), await n("price_versions"), await n("policy_versions")]).toEqual([2, 2, 1, 1, 1]);
    const live = await db.admin.query(`select live_version from agents where id = 'ag-spec'`);
    expect(live.rows[0].live_version).toBe(2);
    const proj = await db.admin.query(`select current_flow_version, created_at from projects where id = 'payments'`);
    expect(proj.rows[0].current_flow_version).toBe(1);
    expect(proj.rows[0].created_at.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect((await db.admin.query(`select monthly_limit_micros from budgets`)).rows[0].monthly_limit_micros).toBe("7000000000");
    expect((await db.admin.query(`select level from roles where id = 'factory_admin'`)).rows[0].level).toBe("factory");
  });

  it("is idempotent on the org slug", async () => {
    const again = await withTx(db.app, (tx) => seedDevOrg(tx, state));
    expect(again.created).toBe(false);
    expect(Number((await db.admin.query(`select count(*) from people`)).rows[0].count)).toBe(2);
  });
});
