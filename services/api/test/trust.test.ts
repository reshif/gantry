import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const ADMIN = "p-asha";
const ENGINEER = "p-tomas"; // payments only, no trust rights
const PROJECT = "payments";

d("trust ladder (spec 13.3, 8.7)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ seedEvals: true });
  });
  afterAll(async () => {
    await t.close();
  });
  const w = world(() => t);
  const q = w.q;
  let n = 0;
  const key = (): Record<string, string> => ({ "idempotency-key": `trust-${Date.now()}-${n++}` });
  const cells = async (who = ADMIN, project?: string) => (await w.call(who, "GET", `/api/v1/trust/cells${project ? `?project=${project}` : ""}`)).body;
  const cell = async (id: string) => (await cells()).cells.find((c: any) => c.id === id);
  const CELL = "ag-spec|feature|payments";

  describe("reads", () => {
    it("returns the legacy trust shape with counts, criteria, ceilings and the switch off", async () => {
      const tr = await cells();
      expect(tr).toMatchObject({ levelsAboveL1: false, minRuns: 5, maxGrantable: 3, soakDays: 14, sampleRate: 5, criteriaVersion: 1 });
      expect(tr.criteria["2"]).toMatchObject({ cleanRuns: expect.any(Number), evalMin: expect.any(Number) });
      expect(tr.ceilings.map((c: any) => c.id)).toEqual(expect.arrayContaining(["CEIL-1", "CEIL-2"]));
      const c = tr.cells.find((x: any) => x.id === CELL);
      expect(c).toMatchObject({ agent: "ag-spec", cls: "feature", project: PROJECT, level: 1, effective: 1, gate: "G2", rev: expect.any(Number) });
      expect(c.evidence).toMatchObject({ runs: 0, cleanRuns: 0 });
      expect(c.history[0]).toMatchObject({ kind: "seed", to: 1 });
      expect(tr.cells.every((x: any) => !x.virtual)).toBe(true);
    });
    it("adds the cells that do not exist yet for one project, marked virtual", async () => {
      const tr = await cells(ADMIN, PROJECT);
      const v = tr.cells.filter((x: any) => x.virtual);
      expect(v.length).toBeGreaterThan(5);
      expect(v[0]).toMatchObject({ level: 1, rev: 0, evidence: { runs: 0 } });
    });
    it("shows a person only the projects they can see", async () => {
      const mine = await cells(ENGINEER);
      expect(mine.cells.every((c: any) => c.project === PROJECT)).toBe(true);
      expect((await w.call(ENGINEER, "GET", "/api/v1/trust/cells?project=risk")).status).toBe(404);
    });
    it("is for signed-in people only", async () => {
      expect((await t.app.inject({ method: "GET", url: "/api/v1/trust/cells" })).statusCode).toBe(401);
      expect((await t.app.inject({ method: "GET", url: "/api/v1/trust/cells", headers: { authorization: "Bearer edge-token-for-tests" } })).statusCode).toBeGreaterThanOrEqual(401);
    });
  });

  describe("grants", () => {
    it("is denied for someone without trust.grant, and the denial is audited", async () => {
      const r = await w.call(ENGINEER, "POST", "/api/v1/trust/grants", { target: CELL, level: 0, reason: "Trying it out" });
      expect(r.status).toBe(403);
      expect((await w.events("trust.grant.denied")).length).toBe(1);
      expect((await cell(CELL)).level).toBe(1);
    });
    it("refuses levels above L1 while the switch is off, and L4 always", async () => {
      const r = await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 2, reason: "Looks good to me" });
      expect(r.status).toBe(403);
      expect(r.body.msg).toMatch(/switched off/);
      expect(r.body.rule).toMatchObject({ id: "TRUST-SWITCH" });
      const l4 = await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 4, reason: "Unattended please" });
      expect(l4.status).toBe(403);
      expect(l4.body.rule).toMatchObject({ id: "TRUST-L4" });
      expect((await w.events("trust.grant.denied")).length).toBeGreaterThanOrEqual(3);
    });
    it("lowers a cell to L0 with a reason, recording the grant, and refuses a missing reason or the same level", async () => {
      expect((await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 0, reason: "no" })).status).toBe(422);
      expect((await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 1, reason: "Already there, really" })).status).toBe(409);
      const r = await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 0, reason: "Spec quality dipped last week" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const c = await cell(CELL);
      expect(c.level).toBe(0);
      expect(c.history.map((h: any) => [h.kind, h.from, h.to])).toEqual([["seed", null, 1], ["demote", 1, 0]]);
      expect(c.history[1]).toMatchObject({ by: ADMIN, reason: "Spec quality dipped last week" });
      const ev = (await w.events("trust.grant")).at(-1);
      expect(ev.before).toMatchObject({ level: "L1" });
      expect(ev.after).toMatchObject({ level: "L0" });
      const grants = await q(`select revoked_at from trust_grants where cell_id = $1 order by created_at`, [CELL]);
      expect(grants.map((g: any) => g.revoked_at !== null)).toEqual([true, false]);
    });
    it("refuses a stale version", async () => {
      const c = await cell(CELL);
      const r = await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 1, reason: "Back to normal" }, { "if-match": String(c.rev - 1) });
      expect(r.status).toBe(409);
      expect((await cell(CELL)).level).toBe(0);
      expect((await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 1, reason: "Back to normal" }, { "if-match": String(c.rev) })).status).toBe(200);
    });
    it("creates the cell for an agent, class and project that have none, and refuses an agent with no human gate", async () => {
      const spec = { agent: "ag-research", cls: "bug", project: PROJECT };
      const r = await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: spec, level: 0, reason: "Shadow it for a while" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const c = await cell("ag-research|bug|payments");
      expect(c).toMatchObject({ level: 0, project: PROJECT });
      expect(c.history.map((h: any) => h.kind)).toEqual(["seed", "demote"]);
      const bad = await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: { agent: "ag-build", cls: "bug", project: PROJECT }, level: 0, reason: "Build has no gate before it" });
      expect(bad.status).toBe(422);
      expect((await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: "nope|nope|payments", level: 0, reason: "No such cell" })).status).toBe(404);
    });
    it("demotes through its own endpoint, only downwards", async () => {
      const c = await cell("ag-research|bug|payments");
      expect((await w.call(ADMIN, "POST", `/api/v1/trust/cells/${encodeURIComponent(c.id)}/demote`, { to: 0, reason: "Down again" })).status).toBe(409);
      expect((await w.call(ENGINEER, "POST", `/api/v1/trust/cells/${encodeURIComponent(c.id)}/demote`, { to: 0, reason: "Nope nope" })).status).toBe(403);
    });
  });

  describe("the switch, criteria, ceilings and the spot-check rate", () => {
    it("turns trust levels above L1 on only for people who may edit trust criteria, with a reason", async () => {
      expect((await w.call(ENGINEER, "PUT", "/api/v1/trust/switch", { on: true, reason: "Let us try" })).status).toBe(403);
      expect((await w.call(ADMIN, "PUT", "/api/v1/trust/switch", { on: true })).status).toBe(422);
      const r = await w.call(ADMIN, "PUT", "/api/v1/trust/switch", { on: true, reason: "Enough evidence on payments" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await cells()).levelsAboveL1).toBe(true);
      expect((await w.call(ADMIN, "PUT", "/api/v1/trust/switch", { on: true, reason: "Again, please" })).status).toBe(409);
      expect((await w.events("trust.switch")).length).toBe(1);
    });
    it("grants L2 when the switch is on, refuses what a ceiling caps, and the cell then runs at it", async () => {
      const ok = await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 2, reason: "Reviewed the last month of specs" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(await cell(CELL)).toMatchObject({ level: 2, effective: 2 });
      const HOT = "ag-spec|hotfix|payments";
      expect((await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: HOT, level: 2, reason: "Hotfix specs are small" })).status).toBe(200);
      const capped = await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: HOT, level: 3, reason: "Hotfixes are capped at L2 though" });
      expect(capped.status).toBe(409);
      expect(capped.body.msg).toMatch(/Capped at L2 by CEIL-3/);
      expect(await cell(HOT)).toMatchObject({ level: 2, ceiling: { max: 2, ids: ["CEIL-3"] } });
    });
    it("turning the switch off stops anything above L1 from acting without changing the recorded level", async () => {
      expect((await w.call(ADMIN, "PUT", "/api/v1/trust/switch", { on: false })).status).toBe(200);
      expect(await cell(CELL)).toMatchObject({ level: 2, effective: 1 });
      expect((await w.call(ADMIN, "PUT", "/api/v1/trust/switch", { on: true, reason: "Back on for the next tests" })).status).toBe(200);
    });
    it("publishes the next criteria version with If-Match required, and keeps the old one", async () => {
      const v = (await cells()).criteriaVersion;
      expect((await w.call(ADMIN, "PUT", "/api/v1/trust/criteria", { level: 2, patch: { cleanRuns: 25 } }, { "if-match": "" })).status).toBeGreaterThanOrEqual(409);
      const r = await w.call(ADMIN, "PUT", "/api/v1/trust/criteria", { level: 2, patch: { cleanRuns: 25 } }, { "if-match": String(v) });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const tr = await cells();
      expect(tr.criteriaVersion).toBe(v + 1);
      expect(tr.criteria["2"].cleanRuns).toBe(25);
      expect((await q(`select count(*)::int n from trust_criteria_versions`))[0].n).toBe(v + 1);
      expect((await q(`select body->'criteria'->'2'->>'cleanRuns' c from trust_criteria_versions where version = $1`, [v]))[0].c).toBe("6");
      const stale = await w.call(ADMIN, "PUT", "/api/v1/trust/criteria", { level: 2, patch: { cleanRuns: 30 } }, { "if-match": String(v) });
      expect(stale.status).toBe(409);
      expect((await w.call(ENGINEER, "PUT", "/api/v1/trust/criteria", { level: 2, patch: { cleanRuns: 1 } }, { "if-match": String(v + 1) })).status).toBe(403);
      expect((await w.call(ADMIN, "PUT", "/api/v1/trust/criteria", { level: 2, patch: { evalMin: 1.5 } }, { "if-match": String(v + 1) })).status).toBe(422);
      expect((await w.events("trust.criteria")).at(-1).after).toMatchObject({ level: "L2", cleanRuns: 25 });
    });
    it("sets the spot-check rate within 1 in 2 to 1 in 50, as part of the versioned criteria", async () => {
      const v = (await cells()).criteriaVersion;
      expect((await w.call(ADMIN, "PUT", "/api/v1/trust/sample-rate", { n: 1 }, { "if-match": String(v) })).status).toBe(422);
      expect((await w.call(ADMIN, "PUT", "/api/v1/trust/sample-rate", { n: 8 }, { "if-match": String(v) })).status).toBe(200);
      expect((await cells()).sampleRate).toBe(8);
      expect((await cells()).criteria["2"].cleanRuns).toBe(25);
    });
    it("adds, edits and removes ceilings, denies others, and refuses a stale edit", async () => {
      const add = await w.call(ADMIN, "POST", "/api/v1/trust/ceilings", { text: "Docs never above L1", when: { cls: "docs" }, max: 1, enabled: true }, key());
      expect(add.status, JSON.stringify(add.body)).toBe(200);
      const id = add.body.ceiling.id as string;
      expect(id).toMatch(/^CEIL-\d+$/);
      expect((await w.call(ENGINEER, "POST", "/api/v1/trust/ceilings", { text: "Mine", when: {}, max: 0 }, key())).status).toBe(403);
      const cur = (await cells()).ceilings.find((c: any) => c.id === id);
      expect(cur).toMatchObject({ max: 1, when: { cls: "docs" }, enabled: true, version: 1 });
      expect((await w.call(ADMIN, "POST", "/api/v1/trust/ceilings", { id, text: "Docs never above L1", when: { cls: "docs" }, max: 2, enabled: false }, {}, ) ).status).toBeGreaterThanOrEqual(200);
      const after = (await cells()).ceilings.find((c: any) => c.id === id);
      expect(after).toMatchObject({ max: 2, enabled: false });
      const stale = await w.call(ADMIN, "POST", "/api/v1/trust/ceilings", { id, text: "Docs", when: {}, max: 1, enabled: true }, { "if-match": String(after.version - 1) });
      expect(stale.status).toBe(409);
      expect((await w.call(ADMIN, "DELETE", `/api/v1/trust/ceilings/${id}`)).status).toBe(200);
      expect((await w.call(ADMIN, "DELETE", `/api/v1/trust/ceilings/${id}`)).status).toBe(404);
      expect((await cells()).ceilings.find((c: any) => c.id === id)).toBeUndefined();
      const e = await w.events("trust.ceiling");
      expect(e.length).toBe(3);
    });
    it("an idempotent retry of a ceiling create makes one", async () => {
      const k = key();
      const a = await w.call(ADMIN, "POST", "/api/v1/trust/ceilings", { text: "Once only", when: { cls: "spike" }, max: 1 }, k);
      const b = await w.call(ADMIN, "POST", "/api/v1/trust/ceilings", { text: "Once only", when: { cls: "spike" }, max: 1 }, k);
      expect(a.body.ceiling.id).toBe(b.body.ceiling.id);
      expect((await q(`select count(*)::int n from trust_ceilings where reason = 'Once only'`))[0].n).toBe(1);
    });
  });

  describe("a stop covering the factory", () => {
    it("refuses trust changes while the factory is killed", async () => {
      await q(`insert into stops (org_id, id, scope_type, mode, reason, set_by) values ($1,'factory:factory:99','factory','kill','test','system')`, [t.orgId]);
      const r = await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 1, reason: "While killed, nothing" });
      expect(r.status).toBe(409);
      expect(r.body.rule).toMatchObject({ kind: "stop" });
      await q(`delete from stops where id = 'factory:factory:99'`);
    });
  });
});

d("trust evidence, enforcement and automatic demotion (spec 13.1, 13.3)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ seedEvals: true });
  }, 60000);
  afterAll(async () => {
    await t.close();
  });
  const w = world(() => t);
  const q = w.q;
  const CELL = "ag-spec|feature|payments";
  const cells = async (project?: string) => (await w.call(ADMIN, "GET", `/api/v1/trust/cells${project ? `?project=${project}` : ""}`)).body;
  const cell = async (id: string) => (await cells()).cells.find((c: any) => c.id === id);
  let shipped = "";

  it("records the trust level in force and its grant on every human gate decision, and counts the finished work order as evidence", async () => {
    // a cell that does not exist yet is created by the first reviewed decision that finishes through it
    await q(`delete from trust_grants where cell_id = 'ag-close|feature|payments'`);
    await q(`delete from trust_cells where id = 'ag-close|feature|payments'`);
    const id = (await w.submit("p-meera", { title: "Evidence work order" })).body.id as string;
    await w.answerAll(id, "p-meera");
    await w.confirm(id, "p-meera");
    await w.walk(id, (x) => x.state === "done", 80);
    shipped = id;
    const decisions = await q(`select i.gate_id, d.trust_level, d.trust_grant_id, d.detail from gate_decisions d join gate_instances i on i.id = d.gate_instance_id where d.wo_id = $1 and d.decided_by is not null order by d.at`, [id]);
    expect(decisions.length).toBeGreaterThan(2);
    const g2 = decisions.find((x: any) => x.gate_id === "G2");
    expect(g2).toMatchObject({ trust_level: "L1", trust_grant_id: `TG-${CELL}-1` });
    expect(g2.detail).toMatchObject({ mode: "human", trustLevelNum: 1, trustGranted: 1, trustCell: CELL, samplingReason: "gated" });
    const c = await cell(CELL);
    expect(c.evidence).toMatchObject({ runs: 1, cleanRuns: 0 });
    expect(c.meets).toMatchObject({ ok: false, next: 2 });
    expect(await cell("ag-close|feature|payments")).toMatchObject({ level: 1, history: [{ kind: "seed", reason: "First reviewed decision recorded", by: "system" }] });
  });

  it("counts a run as clean only after the soak period, and never an unattended pass", async () => {
    expect((await cell(CELL)).evidence.cleanRuns).toBe(0);
    await q(`update work_orders set closed_at = now() - interval '20 days' where id = $1`, [shipped]);
    expect((await cell(CELL)).evidence).toMatchObject({ runs: 1, cleanRuns: 1 });
  });

  describe("an automatic pass (L2 and L3, switched off until turned on)", () => {
    const gate = async (o: Record<string, unknown> = {}) => {
      const { trustDecision } = await import("../src/areas/trust/record.js");
      const { readCatalog } = await import("../src/core/read/index.js");
      return w.tx(async (tx) => {
        const base = { woId: "WO-X", gateId: "G2", instance: `I-${Math.random()}`, cls: "feature", project: PROJECT, repo: null, source: "web", data: {}, riskTags: [] as string[], guardrailBreach: false, now: new Date(), draw: () => false, ...o };
        return trustDecision(tx, t.orgId, await readCatalog(tx, t.orgId), base as never);
      });
    };
    const setLevel = (level: string) => q(`update trust_cells set level = $2 where id = $1`, [CELL, level]);
    it("needs the switch: while it is off nothing above L1 acts, whatever the cell holds", async () => {
      await setLevel("L2");
      const r = await gate();
      expect(r).toMatchObject({ auto: false, level: 1, reason: "Trust levels above L1 are switched off." });
    });
    it("passes at L2 when not sampled, records the draw, and waits for a person when sampled", async () => {
      await w.call(ADMIN, "PUT", "/api/v1/trust/switch", { on: true, reason: "Evidence reviewed, switching on" });
      const pass = await gate({ instance: "I-L2-pass", draw: () => false });
      expect(pass).toMatchObject({ auto: true, level: 2, sampled: false, cellId: CELL });
      expect(pass.grantId).toBe(`TG-${CELL}-1`);
      const sampled = await gate({ instance: "I-L2-sampled", draw: () => true });
      expect(sampled).toMatchObject({ auto: false, level: 2, sampled: true });
      const draws = await q(`select drawn, rate, cell_id from sampling_draws where gate_instance_id in ('I-L2-pass','I-L2-sampled') order by gate_instance_id`);
      expect(draws.map((x: any) => [x.drawn, Number(x.rate), x.cell_id])).toEqual([[false, 5, CELL], [true, 5, CELL]]);
    });
    it("keeps reviewing a random sample at L3: at least 1 in 10, whatever the L2 rate", async () => {
      await w.call(ADMIN, "PUT", "/api/v1/trust/sample-rate", { n: 40 }, { "if-match": String((await cells()).criteriaVersion) });
      await q(`update trust_cells set level = 'L3' where id = $1`, [CELL]);
      await q(`update trust_ceilings set enabled = false where id = 'CEIL-3'`);
      await gate({ instance: "I-L3", draw: (rate: number) => { expect(rate).toBe(10); return false; } });
      expect((await q(`select rate from sampling_draws where gate_instance_id = 'I-L3'`))[0].rate).toBe("10");
      await q(`update trust_ceilings set enabled = true where id = 'CEIL-3'`);
    });
    it("never passes the brief, the merge or release, a risk-tagged change, outside text or a guardrail breach", async () => {
      expect(await gate({ gateId: "G0G1" })).toMatchObject({ auto: false });
      expect(await gate({ gateId: "G5" })).toMatchObject({ auto: false, reason: "A person always decides this gate." });
      expect(await gate({ gateId: "G6" })).toMatchObject({ auto: false, reason: expect.stringMatching(/L4/) });
      expect(await gate({ riskTags: ["auth"] })).toMatchObject({ auto: false, reason: expect.stringMatching(/Risk-tagged/) });
      expect(await gate({ source: "issue" })).toMatchObject({ auto: false, reason: expect.stringMatching(/outside the organisation/) });
      expect(await gate({ data: { externalText: true } })).toMatchObject({ auto: false });
      expect(await gate({ guardrailBreach: true })).toMatchObject({ auto: false, reason: expect.stringMatching(/Guardrail/) });
      // an L1 cell and a cell capped by a ceiling stay with a person
      await q(`update trust_cells set level = 'L1' where id = $1`, [CELL]);
      expect(await gate()).toMatchObject({ auto: false, level: 1 });
    });
    it("in a real flow, a gate at an unattended level either passes under trust with the grant recorded or waits as a sampled review, and the draw is recorded either way", async () => {
      await q(`update trust_cells set level = 'L2' where id = $1`, [CELL]);
      await q(`update trust_cells set level = 'L2' where id in ('ag-design|feature|payments','ag-plan|feature|payments','ag-review|feature|payments')`);
      const id = (await w.submit("p-meera", { title: "Under trust" })).body.id as string;
      await w.answerAll(id, "p-meera");
      await w.confirm(id, "p-meera");
      // walk to the spec gate: either it waits (sampled) or it has passed under trust
      await w.walk(id, (x) => x.state === "running" && x.station >= 3 || x.state === "waiting" && !!x.allowed.approve && x.allowed.approve.gate !== "G0G1", 40);
      const d = await q(`select d.decision, d.trust_grant_id, d.detail, i.basis from gate_instances i left join gate_decisions d on d.gate_instance_id = i.id where i.wo_id = $1 and i.gate_id = 'G2' order by i.opened_at`, [id]);
      expect(d.length).toBeGreaterThan(0);
      const draw = await q(`select drawn from sampling_draws where wo_id = $1 and gate_instance_id like '%G2%'`, [id]);
      expect(draw.length).toBe(1);
      if (draw[0].drawn) expect(d[0].basis).toMatchObject({ sampled: true, trustNote: expect.stringMatching(/spot check/) });
      else {
        expect(d[0]).toMatchObject({ decision: "auto_passed", trust_grant_id: `TG-${CELL}-1` });
        expect(d[0].detail).toMatchObject({ mode: "trust", trustLevelNum: 2 });
        expect((await w.events("trust.auto")).length).toBeGreaterThan(0);
      }
      await q(`update trust_cells set level = 'L1' where id like '%|feature|payments'`);
    });
  });

  describe("proposals", () => {
    let proposal = "";
    let pcell = "";
    it("proposes a promotion when the criteria are met, once, only while the switch is on", async () => {
      const v = (await cells()).criteriaVersion;
      await w.call(ADMIN, "PUT", "/api/v1/trust/criteria", { level: 2, patch: { cleanRuns: 1, evalMin: 0, reworkMax: 1, incidentsMax: 5 } }, { "if-match": String(v) });
      const { evaluateAllTrust } = await import("../src/areas/trust/record.js");
      await w.call(ADMIN, "PUT", "/api/v1/trust/switch", { on: false });
      const off = await w.tx((tx) => evaluateAllTrust(tx, t.orgId, new Date(), () => undefined));
      expect(off.proposed).toBe(0);
      await w.call(ADMIN, "PUT", "/api/v1/trust/switch", { on: true, reason: "Switching on for the proposal test" });
      const ev: any[] = [];
      const on = await w.tx((tx) => evaluateAllTrust(tx, t.orgId, new Date(), (e) => ev.push(e)));
      expect(on.proposed).toBeGreaterThanOrEqual(1);
      const tr = await cells();
      // the system opens at most two a day: the first two cells (in id order) that meet the criteria
      const pending = tr.proposals.filter((x: any) => x.status === "pending");
      expect(pending.length).toBe(2);
      const p = pending[0];
      expect(p).toMatchObject({ status: "pending", from: 1, to: 2, evidence: { cleanRuns: 1 }, by: null });
      proposal = p.id;
      pcell = p.cell;
      expect((await cell(pcell)).pending).toBe(proposal);
      expect(ev.find((e) => e.type === "trust.propose")).toMatchObject({ category: "trust", after: { to: "L2" } });
      // one open proposal per cell
      const again = await w.tx((tx) => evaluateAllTrust(tx, t.orgId, new Date(), () => undefined));
      expect(again.proposed).toBe(0);
    });
    it("is granted only by a permitted person with a reason, and the cell then moves", async () => {
      expect((await w.call(ENGINEER, "POST", `/api/v1/trust/proposals/${proposal}/decide`, { accept: true, reason: "Sure, why not" })).status).toBe(403);
      expect((await w.call(ADMIN, "POST", `/api/v1/trust/proposals/${proposal}/decide`, { accept: true })).status).toBe(422);
      expect((await w.call(ADMIN, "POST", `/api/v1/trust/proposals/TP-9999/decide`, { accept: true, reason: "Does not exist" })).status).toBe(404);
      const r = await w.call(ADMIN, "POST", `/api/v1/trust/proposals/${proposal}/decide`, { accept: true, reason: "Clean month on specs" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await cell(pcell)).toMatchObject({ level: 2, pending: null });
      expect((await cell(pcell)).history.at(-1)).toMatchObject({ to: 2, by: ADMIN, reason: expect.stringMatching(/approved: Clean month/) });
      const done = (await cells()).proposals.find((x: any) => x.id === proposal);
      expect(done).toMatchObject({ status: "accepted", by: ADMIN, reason: "Clean month on specs" });
      expect((await w.call(ADMIN, "POST", `/api/v1/trust/proposals/${proposal}/decide`, { accept: false, reason: "Too late now" })).status).toBe(409);
      expect((await w.events("trust.proposal")).at(-1).after).toMatchObject({ decision: "approved", level: "L2" });
      await q(`update trust_cells set level = 'L1' where id = $1`, [pcell]);
    });
    it("a declined proposal is not made again for a while", async () => {
      await q(`update trust_cells set level = 'L1' where id = $1`, [CELL]);
      await q(`insert into trust_proposals (org_id, id, cell_id, proposed_level, status, evidence) values ($1,'TP-900',$2,'L2','open','{"from":1,"cleanRuns":1,"evalScore":0.9,"note":"x"}')`, [t.orgId, CELL]);
      expect((await w.call(ADMIN, "POST", `/api/v1/trust/proposals/TP-900/decide`, { accept: false, reason: "Not yet, one more month" })).status).toBe(200);
      const { evaluateAllTrust } = await import("../src/areas/trust/record.js");
      expect((await w.tx((tx) => evaluateAllTrust(tx, t.orgId, new Date(), () => undefined))).proposed).toBe(0);
      expect((await cells()).proposals.find((x: any) => x.id === "TP-900")).toMatchObject({ status: "declined", reason: "Not yet, one more month" });
    });
    it("refuses to accept what a ceiling now caps, and withdraws a pending proposal when a person moves the cell directly", async () => {
      await q(`insert into trust_proposals (org_id, id, cell_id, proposed_level, status, evidence) values ($1,'TP-901','ag-spec|hotfix|payments','L3','open','{"from":2}')`, [t.orgId]);
      await q(`update trust_cells set level = 'L2' where id = 'ag-spec|hotfix|payments'`);
      const r = await w.call(ADMIN, "POST", `/api/v1/trust/proposals/TP-901/decide`, { accept: true, reason: "Hotfix cap, though" });
      expect(r.status).toBe(409);
      expect(r.body.msg).toMatch(/Capped at L2 by CEIL-3/);
      await q(`insert into trust_proposals (org_id, id, cell_id, proposed_level, status, evidence) values ($1,'TP-902',$2,'L2','open','{"from":1}')`, [t.orgId, CELL]);
      expect((await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 0, reason: "Shadow it instead" })).status).toBe(200);
      expect((await cells()).proposals.find((x: any) => x.id === "TP-902")).toMatchObject({ status: "withdrawn", reason: "Superseded by a direct change" });
    });
  });

  describe("outcomes after release and automatic demotion", () => {
    const outcome = (who: string, wo: string, body: object, k?: Record<string, string>) => w.call(who, "POST", `/api/v1/work-orders/${wo}/outcomes`, body, k ?? { "idempotency-key": `out-${Math.random()}` });
    it("records an outcome with its attribution, and an attributed incident drops the agent's cells at L2 and above for that class and project to L1", async () => {
      await q(`update trust_cells set level = 'L3' where id in ('ag-spec|feature|payments','ag-design|feature|payments')`);
      await q(`update trust_cells set level = 'L2' where id = 'ag-plan|feature|payments'`);
      const r = await outcome(ADMIN, shipped, { kind: "incident", text: "Refunds doubled for 10 minutes", attribution: { station: "spec" } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.demoted).toEqual([CELL]);
      const c = await cell(CELL);
      expect(c).toMatchObject({ level: 1 });
      expect(c.history.at(-1)).toMatchObject({ kind: "demote", from: 3, to: 1, by: "system", cause: { type: "incident", wo: shipped } });
      expect(await cell("ag-design|feature|payments")).toMatchObject({ level: 3 });
      expect(await cell("ag-plan|feature|payments")).toMatchObject({ level: 2 });
      const o = (await q(`select kind, attribution, station, recorded_by from outcomes where wo_id = $1`, [shipped]))[0];
      expect(o).toMatchObject({ kind: "incident", attribution: "agent", station: "spec", recorded_by: ADMIN });
      const ev = (await w.events("trust.demote")).at(-1);
      expect(ev).toMatchObject({ outcome: "regression" });
      expect(ev.after).toMatchObject({ level: "L1", cause: { type: "incident" } });
      expect((await w.events("outcome.recorded")).length).toBe(1);
    });
    it("does not demote for an outcome attributed to the spec, the environment or something unrelated, or one nobody attributed", async () => {
      await q(`update trust_cells set level = 'L3' where id = $1`, [CELL]);
      for (const attribution of ["spec", "environment", "unrelated"]) {
        const r = await outcome(ADMIN, shipped, { kind: "revert", text: `Reverted (${attribution})`, attribution });
        expect(r.status).toBe(200);
        expect(r.body.demoted).toEqual([]);
      }
      expect((await outcome(ADMIN, shipped, { kind: "incident", text: "Nobody attributed this yet" })).body.demoted).toEqual([]);
      expect(await cell(CELL)).toMatchObject({ level: 3 });
      // a revert attributed to the agent does
      expect((await outcome(ADMIN, shipped, { kind: "revert", text: "Reverted: the agent's change", attribution: { agent: "ag-spec" } })).body.demoted).toEqual([CELL]);
    });
    it("refuses work that has not shipped, unknown work, someone without the right, and an empty text; an idempotent retry records once", async () => {
      const open = (await w.submit("p-meera", { title: "Not shipped" })).body.id as string;
      expect((await outcome(ADMIN, open, { kind: "incident", text: "Too early" })).status).toBe(409);
      expect((await outcome(ADMIN, "WO-9999999", { kind: "incident", text: "Nothing here" })).status).toBe(404);
      expect((await outcome("p-tomas", shipped, { kind: "incident", text: "Not allowed to" })).status).toBe(403);
      expect((await w.events("outcome.record.denied")).length).toBe(1);
      expect((await outcome(ADMIN, shipped, { kind: "incident", text: "" })).status).toBe(422);
      const before = (await q(`select count(*)::int n from outcomes`))[0].n;
      const k = { "idempotency-key": "out-same" };
      await outcome(ADMIN, shipped, { kind: "followup", text: "Add a monitor" }, k);
      await outcome(ADMIN, shipped, { kind: "followup", text: "Add a monitor" }, k);
      expect((await q(`select count(*)::int n from outcomes`))[0].n).toBe(before + 1);
    });
    it("counts an attributed revert or incident against the cell's evidence, so it cannot be promoted over it", async () => {
      const v = (await cells()).criteriaVersion;
      await w.call(ADMIN, "PUT", "/api/v1/trust/criteria", { level: 2, patch: { incidentsMax: 0 } }, { "if-match": String(v) });
      await q(`update trust_cells set level = 'L1' where id = $1`, [CELL]);
      const c = await cell(CELL);
      expect(c.evidence.incidents).toBeGreaterThanOrEqual(1);
      expect(c.evidence.incidentWos).toContain(shipped);
      expect(c.meets.ok).toBe(false);
      expect(c.meets.missing.join(" ")).toMatch(/incident/);
    });
  });
});
