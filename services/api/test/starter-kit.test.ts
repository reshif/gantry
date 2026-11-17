import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { STARTER_KIT, STATIONS } from "@gantry/domain";
import { bootstrapOrg } from "../src/core/bootstrap.js";
import { CheckSpec, grade } from "../src/areas/evals/checks.js";
import { readAgents } from "../src/areas/agents/store.js";
import { readSkills } from "../src/areas/skills/store.js";
import { readSuites } from "../src/areas/evals/store.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const kitAgents = STARTER_KIT.agents;
const caseCount = kitAgents.reduce((n, a) => n + a.suite.cases.length, 0);

describe("starter kit definitions", () => {
  it("has an agent for every station of the default floor, and the onboarding agent", () => {
    for (const s of STATIONS) expect(kitAgents.some((a) => a.id === s.agent && a.station === s.id), `${s.id} -> ${s.agent}`).toBe(true);
    expect(kitAgents.some((a) => a.id === "ag-onboard")).toBe(true);
  });
  it("attaches only skills the kit defines, and every skill is attached to someone", () => {
    const ids = new Set(STARTER_KIT.skills.map((s) => s.id));
    expect(ids.size).toBe(STARTER_KIT.skills.length);
    for (const a of kitAgents) for (const s of a.skills) expect(ids.has(s), `${a.id} -> ${s}`).toBe(true);
    for (const s of ids) expect(kitAgents.some((a) => a.skills.includes(s)), s).toBe(true);
  });
  it("has real content: instructions and skill bodies are substantial", () => {
    for (const a of kitAgents) expect(a.instructions.length, a.id).toBeGreaterThan(1200);
    for (const s of STARTER_KIT.skills) expect(s.body.length, s.id).toBeGreaterThan(500);
  });
  it("gives every agent a suite of runnable cases: valid check rules, unique ids, and no case an empty answer passes", () => {
    const seen = new Set<string>();
    for (const a of kitAgents) {
      expect(a.suite.cases.length, a.id).toBeGreaterThanOrEqual(5);
      expect(a.suite.threshold).toBeGreaterThanOrEqual(0.8);
      for (const c of a.suite.cases) {
        expect(seen.has(c.id), `duplicate ${c.id}`).toBe(false);
        seen.add(c.id);
        expect(c.task.length, c.id).toBeGreaterThan(20);
        expect(c.rules.length, c.id).toBeGreaterThan(0);
        for (const r of c.rules) {
          const p = CheckSpec.safeParse(r);
          expect(p.success, `${c.id} ${JSON.stringify(r)}`).toBe(true);
          if (r.kind === "output_matches") expect(() => new RegExp(r.pattern, "i")).not.toThrow();
        }
        if (c.skill) expect(STARTER_KIT.skills.some((s) => s.id === c.skill), `${c.id} skill`).toBe(true);
        const g = grade(c.rules as CheckSpec[], { status: "succeeded", output: {}, seconds: 1 });
        expect(g.pass, `${c.id} must not pass an empty result`).toBe(false);
      }
    }
    expect(kitAgents.find((a) => a.id === "ag-close")!.suite.threshold).toBeGreaterThan(kitAgents.find((a) => a.id === "ag-spec")!.suite.threshold);
  });
  it("is built-in, conservative and pins exact model ids", () => {
    for (const a of kitAgents) {
      expect(a.autonomy, a.id).not.toBe("auto");
      expect(a.tools.merge, a.id).toBeFalsy();
      expect(a.tools.readSecrets, a.id).toBeFalsy();
      expect(a.model).toMatch(/^claude-(opus|sonnet|haiku)-\d+-\d+$/);
    }
  });
});

d("starter kit in an empty organisation", () => {
  let t: TestApp;
  const q = async (sql: string, p: unknown[] = []) => (await t.db.admin.query(sql, p)).rows;
  const dump = async () => ({
    agents: await q(`select * from agents order by id`),
    versions: await q(`select * from agent_versions order by agent_id, version`),
    skills: await q(`select * from skills order by id`),
    skillVersions: await q(`select * from skill_versions order by skill_id, version`),
    attach: await q(`select agent_id, skill_id, position from agent_skills order by agent_id, position`),
    suites: await q(`select * from suites order by id`),
    cases: await q(`select * from eval_cases order by id`),
  });
  beforeAll(async () => {
    t = await startApp({ seed: false });
  });
  afterAll(() => t.close());

  it("loads an agent for every station, with its skills in order, a suite and runnable cases", async () => {
    const agents = await readAgents(t.db.admin, t.orgId);
    for (const s of STATIONS) {
      const a = agents.find((x) => x.id === s.agent);
      expect(a, s.agent).toBeDefined();
      expect(a).toMatchObject({ station: s.id, status: "active", version: "1.0.0", autonomy: expect.stringMatching(/^(suggest|gate)$/) });
      expect(a!.instructions.length).toBeGreaterThan(1000);
      expect(a!.versions).toHaveLength(1);
      expect(a!.versions[0]).toMatchObject({ v: "1.0.0", live: true });
      const def = kitAgents.find((k) => k.id === s.agent)!;
      expect(a!.skills).toEqual(def.skills);
      expect(a!.model).toBe(def.model);
      expect(a!.suite).toBe(def.suite.id);
      expect(a!.threshold).toBe(def.suite.threshold);
    }
    expect(agents.find((a) => a.id === "ag-onboard")).toMatchObject({ station: null, tools: expect.objectContaining({ readRepo: true, writeBranch: false, openPR: false, merge: false }) });
    const skills = await readSkills(t.db.admin, t.orgId);
    expect(skills.map((s) => s.id).sort()).toEqual(STARTER_KIT.skills.map((s) => s.id).sort());
    for (const s of skills) expect(s).toMatchObject({ version: "1.0.0", owner: "system", projects: "all" });
    const suites = await readSuites(t.db.admin, t.orgId);
    expect(suites).toHaveLength(kitAgents.length);
    for (const su of suites) {
      const def = kitAgents.find((k) => k.suite.id === su.id)!;
      expect(su).toMatchObject({ agent: def.id, station: def.suite.station, threshold: def.suite.threshold });
      expect(su.cases).toHaveLength(def.suite.cases.length);
      for (const c of su.cases) {
        expect(c.rules.length).toBeGreaterThan(0);
        expect(c.rules.every((r) => CheckSpec.safeParse(r).success)).toBe(true);
        expect(c.task.length).toBeGreaterThan(20);
      }
    }
    expect(skills.find((s) => s.id === "sk-spec")!.coverage.cases).toBeGreaterThan(0);
    expect((await q(`select count(*)::int n from eval_cases`))[0].n).toBe(caseCount);
  });
  it("marks every item built-in, records version tuples' inputs honestly and invents no history", async () => {
    expect((await q(`select count(*)::int n from agents where data->>'builtin' = 'true'`))[0].n).toBe(kitAgents.length);
    expect((await q(`select count(*)::int n from skills where data->>'builtin' = 'true' and data->>'owner' = 'system'`))[0].n).toBe(STARTER_KIT.skills.length);
    expect((await q(`select count(*)::int n from suites where data->>'builtin' = 'true'`))[0].n).toBe(kitAgents.length);
    for (const t2 of ["eval_runs", "eval_results", "trust_cells", "trust_grants", "usage_meter", "agent_version_tuples"]) expect((await q(`select count(*)::int n from ${t2}`))[0].n, t2).toBe(0);
    const v = (await q(`select instruction_hash, model_id, published_by from agent_versions where agent_id = 'ag-build'`))[0];
    expect(v).toMatchObject({ model_id: "claude-sonnet-5-5", published_by: "system" });
    expect(v.instruction_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("starts every agent at the lowest trust: no cell exists, so L1 applies", async () => {
    expect((await q(`select count(*)::int n from trust_cells`))[0].n).toBe(0);
  });
  it("is idempotent: a second bootstrap changes nothing, and an edited agent, skill or suite is never overwritten", async () => {
    const before = await dump();
    await bootstrapOrg(t.db.app, t.config, undefined, { seedAudit: false, seedEvals: false });
    expect(await dump()).toEqual(before);

    await q(`update agents set data = data || '{"instructions":"Our own words.","budget":9}'::jsonb, status = 'paused', name = 'Our Spec Writer' where id = 'ag-spec'`);
    await q(`update skills set description = 'edited' where id = 'sk-spec'`);
    await q(`insert into skill_versions (org_id, skill_id, version, body, note) select org_id, 'sk-spec', 2, '{"label":"1.1.0","body":"mine"}'::jsonb, 'edit' from skills where id = 'sk-spec'`);
    await q(`update skills set live_version = 2 where id = 'sk-spec'`);
    await q(`delete from eval_cases where id = 'SPE-01'`);
    await q(`update suites set data = data || '{"threshold":0.5}'::jsonb where id = 'SUITE-SPEC'`);
    await q(`delete from agent_skills where agent_id = 'ag-plan' and skill_id = 'sk-migration'`);
    const edited = await dump();
    await bootstrapOrg(t.db.app, t.config, undefined, { seedAudit: false, seedEvals: false });
    expect(await dump()).toEqual(edited);
    const a = (await readAgents(t.db.admin, t.orgId, "ag-spec"))[0]!;
    expect(a).toMatchObject({ name: "Our Spec Writer", instructions: "Our own words.", status: "paused", budget: 9 });
    expect((await q(`select count(*)::int n from eval_cases where suite_id = 'SUITE-SPEC'`))[0].n).toBe(STARTER_KIT.agents.find((x) => x.id === "ag-spec")!.suite.cases.length - 1);
  });

  it("an org still on the first built-in Onboarding Agent (it could only draft AGENTS.md) gets the authoring instructions as version 2; an edited one is left alone; running it twice changes nothing more", async () => {
    const { upgradeOnboardingAgent } = await import("../src/areas/agents/starter-kit.js");
    const { sha256 } = await import("../src/areas/agents/config.js");
    const kit = STARTER_KIT.agents.find((a) => a.id === "ag-onboard")!;
    const old = "You may draft only AGENTS.md. (the first kit's instructions)";
    await q(`update agents set data = jsonb_set(jsonb_set(data, '{instructions}', to_jsonb($2::text)), '{guardrails}', '{"paths":[".github/workflows/**"],"maxDiff":300}'::jsonb) where org_id = $1 and id = 'ag-onboard'`, [t.orgId, old]);
    // Published versions are immutable; the test plays the first kit's v1 by bypassing that trigger on one connection.
    const c0 = await t.db.admin.connect();
    try { await c0.query("set session_replication_role = replica"); await c0.query(`update agent_versions set instruction_hash = $2 where org_id = $1 and agent_id = 'ag-onboard' and version = 1`, [t.orgId, sha256(old)]); } finally { await c0.query("reset session_replication_role"); c0.release(); }
    const up = () => t.db.admin.connect().then(async (c) => { try { return await upgradeOnboardingAgent(c as never, t.orgId); } finally { c.release(); } });
    expect(await up()).toBe(true);
    const a = (await q(`select live_version, data from agents where org_id = $1 and id = 'ag-onboard'`, [t.orgId]))[0];
    expect(a.live_version).toBe(2);
    expect(a.data.instructions).toBe(kit.instructions);
    expect(a.data.guardrails).toEqual({ paths: [], maxDiff: 1500 });
    expect((await q(`select version, note from agent_versions where org_id = $1 and agent_id = 'ag-onboard' order by version`, [t.orgId])).map((r) => r.version)).toEqual([1, 2]);
    expect((await q(`select live_version from skills where org_id = $1 and id = 'sk-onboardpr'`, [t.orgId]))[0].live_version).toBe(2);
    expect(await up()).toBe(false);
  });

});

d("starter kit in a seeded organisation", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);

  it("adds nothing when the organisation already has the agents (the dev seed keeps its own)", async () => {
    const agents = (await t.db.admin.query(`select instructions_len from (select length(data->>'instructions') instructions_len from agents where id = 'ag-spec') x`)).rows[0];
    expect(agents.instructions_len).toBeLessThan(200);
    expect((await t.db.admin.query(`select count(*)::int n from skills`)).rows[0].n).toBe(10);
  });
  it("loads a missing bundle into an existing organisation, and its suite can be run from the API", async () => {
    // Published versions are immutable, so the test (as the database owner) removes the seeded agent with triggers off, to stand in for an org that lacks it.
    const c = await t.db.admin.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query(`delete from agent_skills where agent_id = 'ag-intake'`);
      await c.query(`delete from agent_versions where agent_id = 'ag-intake'`);
      await c.query(`delete from agents where id = 'ag-intake'`);
      await c.query("commit");
    } finally {
      c.release();
    }
    await bootstrapOrg(t.db.app, t.config, undefined, { seedAudit: false, seedEvals: false });
    const a = (await readAgents(t.db.admin, t.orgId, "ag-intake"))[0]!;
    expect(a.skills).toEqual(["sk-intake", "sk-classify"]);
    expect(a.instructions.length).toBeGreaterThan(1000);
    // the seed's skills of the same id are attached, not replaced
    expect((await t.db.admin.query(`select count(*)::int n from skills`)).rows[0].n).toBe(10);
    expect((await t.db.admin.query(`select count(*)::int n from eval_cases where suite_id = 'SUITE-INTAKE'`)).rows[0].n).toBe(STARTER_KIT.agents.find((x) => x.id === "ag-intake")!.suite.cases.length);
    const r = await w.call("p-asha", "POST", "/api/v1/suites/SUITE-INTAKE/runs", { agent: "ag-intake", version: "1.0.0", model: undefined }, { "idempotency-key": "kit-run-1" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, total: STARTER_KIT.agents.find((x) => x.id === "ag-intake")!.suite.cases.length });
  });
});
