import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const ASHA = "p-asha";
const OMAR = "p-omar";
const NOBODY = "p-tomas";
const DAY = 86_400_000;

d("learning loop (spec 8.7, 13.4)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t.close();
  });
  const w = world(() => t);
  const q = w.q;
  let n = 0;
  const key = (): Record<string, string> => ({ "idempotency-key": `ln-${Date.now()}-${n++}` });
  const get = async (url: string, who = ASHA) => (await w.call(who, "GET", url)).body as any;
  const post = (url: string, body: object, who = ASHA, h: Record<string, string> = {}) => w.call(who, "POST", url, body, h);
  const wos: string[] = [];
  let fid = "";
  /** A work order of the payments project whose record carries sendbacks from `build` at the given times (the signal the loop reads). */
  const record = async (sendbacks: number[]) => {
    const r = await w.submit(NOBODY, { title: `Learning source ${wos.length + 1}` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const id = r.body.workOrder?.id ?? r.body.id;
    wos.push(id);
    await q(`update work_orders set data = jsonb_set(data, '{sendbacks}', $3::jsonb) where org_id = $1 and id = $2`, [t.orgId, id, JSON.stringify(sendbacks.map((at) => ({ from: "build", to: "build", note: "Missing a rollback note", at, by: "p-meera" })))]);
    return id;
  };
  const refresh = async (who = ASHA) => post("/api/v1/learning/findings/refresh", {}, who);
  const _switchOn = async () => (await w.call(ASHA, "PUT", "/api/v1/learning/switch", { on: true, reason: "Trying the loop" })).body;
  const skillText = async (id: string) => (await get("/api/v1/skills")).find((s: any) => s.id === id);
  const draftSkill = async (finding: string, after: string, who = ASHA, over: Record<string, unknown> = {}) =>
    post("/api/v1/learning/proposals", { finding, kind: "skill", title: "Spec writing: add a rollback section", expected: "Fewer rollback send-backs", change: { skill: "sk-testdesign", after }, metric: { target: 0 }, windowDays: 7, ...over }, who, key());

  const suiteIds = ["SUITE-BUILD"];
  beforeAll(async () => {
    for (const id of suiteIds) await q(`insert into suites (org_id, id, name, station, agent_id, data) values ($1,$2,$2,'build','ag-build','{}'::jsonb) on conflict do nothing`, [t.orgId, id]);
  });

  describe("findings and signals", () => {
    it("starts empty, with proposals switched off", async () => {
      expect(await get("/api/v1/learning/findings")).toEqual([]);
      expect(await get("/api/v1/learning/proposals")).toEqual([]);
      expect(await get("/api/v1/learning/settings")).toMatchObject({ proposalsOn: false });
    });

    it("groups repeated signals into one finding, with evidence, and picks up more on refresh", async () => {
      const now = Date.now();
      const a = await record([now - 5 * DAY]);
      const r0 = await refresh();
      expect(r0.status, JSON.stringify(r0.body)).toBe(200);
      expect(r0.body).toMatchObject({ ok: true, created: 0 }); // one signal does not repeat
      const b = await record([now - 4 * DAY, now - 3 * DAY]);
      const r1 = await refresh();
      // Intake no longer asks a fixed questionnaire, so it carries no canned-question misses of its own: only the send-backs group.
      expect(r1.body).toMatchObject({ created: 1, updated: 0, open: 1 });
      const f = (await get("/api/v1/learning/findings")).find((x: any) => x.signal === "sendback");
      fid = f.id;
      expect(f).toMatchObject({ signal: "sendback", agent: "ag-build", project: "payments", status: "open", count: 2 });
      expect((await get("/api/v1/learning/findings")).find((x: any) => x.signal === "miss")).toBeUndefined();
      expect(f.title).toContain("Missing a rollback note");
      expect([...f.evidence].sort()).toEqual([a, b].sort());
      const again = await refresh();
      expect(again.body).toMatchObject({ created: 0, updated: 0 });
      const c = await record([now - 1 * DAY]);
      const r2 = await refresh();
      expect(r2.body).toMatchObject({ created: 0 });
      expect(r2.body.updated).toBeGreaterThanOrEqual(1);
      expect((await get("/api/v1/learning/findings")).find((x: any) => x.id === fid)).toMatchObject({ count: 3, evidence: expect.arrayContaining([c]) });
      expect((await w.events("learning.refresh")).length).toBe(4);
    });

    it("lists the signals the findings came from", async () => {
      const s = await get("/api/v1/learning/signals");
      expect(s.filter((x: any) => x.signal === "sendback")).toHaveLength(4);
      expect(s.find((x: any) => x.signal === "sendback")).toMatchObject({ project: "payments", agent: "ag-build", text: "Missing a rollback note" });
    });

    it("turns an eval score drop into a regression signal", async () => {
      await q(`insert into suites (org_id, id, name, station, agent_id, data) values ($1,'SUITE-LN','LN suite','build','ag-build','{}'::jsonb) on conflict do nothing`, [t.orgId]);
      await q(`insert into eval_runs (org_id, id, suite_id, status, score, finished_at) values ($1,'RUN-LN1','SUITE-LN','completed',0.9, now() - interval '2 days'), ($1,'RUN-LN2','SUITE-LN','completed',0.8, now() - interval '1 day')`, [t.orgId]);
      const s = await get("/api/v1/learning/signals");
      expect(s.find((x: any) => x.signal === "regression")).toMatchObject({ project: null, ref: "RUN-LN2", text: expect.stringContaining("90% to 80%") });
      await q(`delete from eval_runs where org_id = $1 and suite_id = 'SUITE-LN'`, [t.orgId]);
    });

    it("hides findings about projects a person cannot see", async () => {
      expect(await get("/api/v1/learning/findings", "p-arjun")).toEqual([]);
      expect((await get("/api/v1/learning/findings", NOBODY)).map((x: any) => x.id)).toContain(fid);
    });

    it("refuses a refresh from someone without the right, and audits it", async () => {
      const r = await refresh(NOBODY);
      expect(r.status).toBe(403);
      expect((await w.events("learning.apply.denied")).length).toBe(1);
    });
  });
  const denials = async () => (await w.events("learning.apply.denied")).length;

  describe("the switch (spec 15.3)", () => {
    it("refuses to draft while proposals are off, and audits the refusal", async () => {
      const was = await denials();
      const r = await draftSkill(fid, "x");
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ ok: false, needs: "Turn on learning proposals", rule: { id: "LEARN-SWITCH" } });
      expect(await denials()).toBe(was + 1);
    });
    it("needs a reason to turn on, and a permitted person", async () => {
      expect((await w.call(ASHA, "PUT", "/api/v1/learning/switch", { on: true })).status).toBe(422);
      expect((await w.call(NOBODY, "PUT", "/api/v1/learning/switch", { on: true, reason: "please" })).status).toBe(403);
      const r = await w.call(ASHA, "PUT", "/api/v1/learning/switch", { on: true, reason: "Trying the loop" });
      expect(r.body).toMatchObject({ ok: true, on: true });
      expect((await w.events("learning.switch")).pop()).toMatchObject({ before: { on: false }, after: { on: true, reason: "Trying the loop" } });
      expect((await w.call(ASHA, "PUT", "/api/v1/learning/switch", { on: true, reason: "again" })).status).toBe(409);
    });
  });

  describe("drafting", () => {
    it("records the proposal with its metric and window, fills the skill's current text, and is idempotent", async () => {
      const sk = await skillText("sk-testdesign");
      const k = key();
      const body = { finding: fid, kind: "skill", title: "Add a rollback section", expected: "Fewer rollback send-backs", change: { skill: "sk-testdesign", after: `${sk.body} Always add a Rollback section.` }, metric: { target: 1 }, windowDays: 7 };
      const r = await post("/api/v1/learning/proposals", body, ASHA, k);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.proposal).toMatchObject({ id: "LP-1", finding: fid, kind: "skill", status: "proposed", owner: ASHA, windowDays: 7, metric: { signal: "sendback", project: "payments", agent: "ag-build", target: 1 }, change: { before: sk.body } });
      const dup = await post("/api/v1/learning/proposals", body, ASHA, k);
      expect(dup.body.proposal.id).toBe("LP-1");
      expect(await q(`select count(*)::int as n from proposals where title <> ''`)).toEqual([{ n: 1 }]);
      expect((await w.events("learning.draft")).length).toBe(1);
    });
    it("needs a declared metric and window", async () => {
      const base = { finding: fid, kind: "skill", title: "t", change: { skill: "sk-testdesign", after: "y" } };
      expect((await post("/api/v1/learning/proposals", { ...base, windowDays: 7 }, ASHA, key())).status).toBe(422);
      expect((await post("/api/v1/learning/proposals", { ...base, metric: { target: 0 } }, ASHA, key())).status).toBe(422);
    });
    it("refuses changes that could weaken a control, or reach past the kind", async () => {
      const draft = (kind: string, change: object) => post("/api/v1/learning/proposals", { finding: fid, kind, title: "t", change, metric: { target: 0 }, windowDays: 7 }, ASHA, key());
      // the loop cannot edit graders, trust criteria or eval rules by riding along
      expect((await draft("eval", { suite: "SUITE-BUILD", case: { name: "n" }, graders: [] })).status).toBe(422);
      expect((await draft("guardrail", { agent: "ag-build", path: "infra/**", maxDiff: 99999 })).status).toBe(422);
      expect((await draft("skill", { skill: "sk-testdesign", after: "x", trust: { cleanRuns: 1 } })).status).toBe(422);
      // a condition that asks for nobody changes nothing
      const noOne = await draft("approver", { project: "payments", gate: "G2", condition: { when: { type: "path", value: "ingest/" }, needs: { roles: [], people: [], oncall: false }, text: "x" } });
      expect(noOne.status).toBe(422);
      expect(noOne.body.msg).toMatch(/ask for someone else/);
      // a route cannot skip a station a person's gate follows, nor verification
      const skipSpec = await draft("route", { project: "payments", cls: "feature", addSkip: "spec" });
      expect(skipSpec.status).toBe(422);
      expect(skipSpec.body.msg).toMatch(/G2/);
      expect((await draft("route", { project: "payments", cls: "feature", addSkip: "verify" })).status).toBe(422);
      expect((await draft("guardrail", { agent: "ag-build", path: "**" })).status).toBe(422);
      expect((await draft("nonsense", {})).status).toBe(422);
    });
    it("is refused for someone without the right", async () => {
      expect((await draftSkill(fid, "x", NOBODY)).status).toBe(403);
    });
  });

  describe("accepting", () => {
    it("refuses the drafter while a second eligible person exists, and audits it", async () => {
      expect((await get("/api/v1/learning/settings")).otherDeciders).toBeGreaterThanOrEqual(1);
      const was = await denials();
      const r = await post("/api/v1/learning/proposals/LP-1/accept", {});
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ ok: false, needs: "A second person", rule: { id: "LEARN-TWO-PERSON" } });
      expect((await get("/api/v1/learning/proposals"))[0].status).toBe("proposed");
      expect(await denials()).toBe(was + 1);
    });
    it("applies through the ordinary skill command when someone else accepts, audited twice, with a baseline and a rollback path", async () => {
      const before = await skillText("sk-testdesign");
      const floor = async () => (await q(`select version, live_version from agents where id = 'ag-build'`, []))[0];
      const bv = (await q(`select count(*)::int n from agent_versions where agent_id = 'ag-build'`, []))[0].n;
      const live0 = await floor();
      const r = await post("/api/v1/learning/proposals/LP-1/accept", { note: "Looks right" }, OMAR);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.msg).toMatch(/^LP-1 applied\./);
      const after = await skillText("sk-testdesign");
      expect(after.body).toContain("Always add a Rollback section.");
      expect(after.versions.length).toBe(before.versions.length + 1);
      const p = (await get("/api/v1/learning/proposals"))[0];
      expect(p).toMatchObject({ status: "accepted", appliedBy: OMAR, baseline: { count: 4 }, rollback: { available: true } });
      expect(p.history.at(-1).text).toMatch(/^Accepted and applied: Looks right/);
      expect((await get("/api/v1/learning/findings")).find((x: any) => x.id === fid).status).toBe("addressed");
      const edit = (await w.events("skill.edit")).pop()!;
      const apply = (await w.events("learning.apply")).pop()!;
      expect(edit.actor).toBe(OMAR);
      expect(apply).toMatchObject({ actor: OMAR, subject: { type: "learning", id: "LP-1" }, after: { status: "accepted", result: expect.stringContaining("saved as") } });
      expect(edit.command_id).toBe(apply.command_id);
      // the approved change reaches runs only as a candidate: one new version, the floor unchanged
      expect((await q(`select count(*)::int n from agent_versions where agent_id = 'ag-build'`, []))[0].n).toBe(bv + 1);
      expect((await floor()).live_version).toBe(live0.live_version);
      const cand = (await q(`select body, published_by from agent_versions where agent_id = 'ag-build' order by version desc limit 1`, []))[0];
      expect(cand.body).toMatchObject({ rc: true, source: { type: "skill.edit", skill: "sk-testdesign", by: OMAR } });
      expect(cand.body.skillVersions["sk-testdesign"]).toBe(after.versions.length);
      expect((await w.events("agent.version")).pop()!.after).toMatchObject({ trigger: "skill.edit", skill: "sk-testdesign" });
    });
    it("is refused the second time, and when the proposal is stale", async () => {
      expect((await post("/api/v1/learning/proposals/LP-1/accept", {}, OMAR)).status).toBe(409);
      expect((await post("/api/v1/learning/proposals/LP-404/accept", {}, OMAR)).status).toBe(404);
    });
    it("is refused for someone without the right", async () => {
      const r = await post("/api/v1/learning/proposals/LP-1/accept", {}, NOBODY);
      expect(r.status).toBe(403);
    });
    it("refuses a skill change drafted against text that has since changed, and applies nothing", async () => {
      await q(`update findings set status = 'open' where id = $1`, [fid]);
      const sk = await skillText("sk-testdesign");
      const r = await draftSkill(fid, `${sk.body} Second addition.`);
      const id = r.body.proposal.id;
      const edit = await w.call(ASHA, "PATCH", "/api/v1/skills/sk-testdesign", { patch: { body: `${sk.body} Edited by hand.` } }, { "if-match": String(sk.rev) });
      expect(edit.status).toBe(200);
      const acc = await post(`/api/v1/learning/proposals/${id}/accept`, {}, OMAR);
      expect(acc.status).toBe(409);
      expect(acc.body.msg).toMatch(/changed since this was drafted/);
      expect((await get("/api/v1/learning/proposals")).find((p: any) => p.id === id).status).toBe("proposed");
      const dec = await post(`/api/v1/learning/proposals/${id}/decline`, { reason: "Stale" }, OMAR);
      expect(dec.status).toBe(200);
    });
    it("lets the only eligible person decide their own draft", async () => {
      await q(`update people set status = 'deactivated' where id = $1`, [OMAR]);
      try {
        const sk = await skillText("sk-testdesign");
        const r = await draftSkill(fid, `${sk.body} Solo addition.`);
        const acc = await post(`/api/v1/learning/proposals/${r.body.proposal.id}/accept`, {});
        expect(acc.status, JSON.stringify(acc.body)).toBe(200);
      } finally {
        await q(`update people set status = 'active' where id = $1`, [OMAR]);
      }
    });
  });

  describe("declining", () => {
    it("needs a reason, then leaves the finding open and the change unapplied", async () => {
      const sk = await skillText("sk-testdesign");
      const r = await draftSkill(fid, `${sk.body} Declined addition.`);
      const id = r.body.proposal.id;
      expect((await post(`/api/v1/learning/proposals/${id}/decline`, { reason: "no" }, OMAR)).status).toBe(422);
      const ok = await post(`/api/v1/learning/proposals/${id}/decline`, { reason: "Not now" }, OMAR);
      expect(ok.status).toBe(200);
      const p = (await get("/api/v1/learning/proposals")).find((x: any) => x.id === id);
      expect(p).toMatchObject({ status: "declined", reason: "Not now" });
      expect((await skillText("sk-testdesign")).body).not.toContain("Declined addition.");
      expect((await post(`/api/v1/learning/proposals/${id}/decline`, { reason: "again again" }, OMAR)).status).toBe(409);
      expect((await post(`/api/v1/learning/proposals/${id}/decline`, { reason: "nope nope" }, NOBODY)).status).toBe(403);
    });
  });

  describe("verifying", () => {
    it("waits for the declared window, measures the declared metric, and refuses when it was not met", async () => {
      const id = "LP-1";
      const early = await post(`/api/v1/learning/proposals/${id}/verify`, {}, OMAR);
      expect(early.status).toBe(409);
      expect(early.body.msg).toMatch(/window runs until/);
      // the window has passed: three signals before the change, none after, target at most 1
      await q(`update proposals set applied_at = now() - interval '10 days' where id = $1`, [id]);
      // a signal inside the window, above a target of 0 would refuse; here the target is 1 and one signal landed after
      await q(`update work_orders set data = jsonb_set(data, '{sendbacks}', '[]'::jsonb) where org_id = $1 and id = any($2::text[])`, [t.orgId, wos]);
      await q(`update work_orders set data = jsonb_set(data, '{sendbacks}', $3::jsonb) where org_id = $1 and id = $2`, [t.orgId, wos[0], JSON.stringify([{ from: "build", to: "build", note: "x", at: Date.now() - 5 * DAY, by: "p-meera" }, { from: "build", to: "build", note: "y", at: Date.now() - 4 * DAY, by: "p-meera" }])]);
      const no = await post(`/api/v1/learning/proposals/${id}/verify`, {}, OMAR);
      expect(no.status).toBe(409);
      expect(no.body.msg).toMatch(/Not verified: 2 sendback signals/);
      await q(`update work_orders set data = jsonb_set(data, '{sendbacks}', '[]'::jsonb) where org_id = $1 and id = $2`, [t.orgId, wos[0]]);
      const yes = await post(`/api/v1/learning/proposals/${id}/verify`, {}, OMAR);
      expect(yes.status, JSON.stringify(yes.body)).toBe(200);
      const p = (await get("/api/v1/learning/proposals")).find((x: any) => x.id === id);
      expect(p).toMatchObject({ status: "verified", verification: { measured: expect.any(Number), target: 1, baseline: 4, by: OMAR } });
      expect((await w.events("learning.verify")).length).toBe(1);
      expect((await post(`/api/v1/learning/proposals/${id}/verify`, {}, OMAR)).status).toBe(409);
      expect((await post(`/api/v1/learning/proposals/${id}/verify`, {}, NOBODY)).status).toBe(403);
    });
    it("cannot verify a proposal that is only drafted", async () => {
      const sk = await skillText("sk-testdesign");
      const r = await draftSkill(fid, `${sk.body} Another.`);
      const v = await post(`/api/v1/learning/proposals/${r.body.proposal.id}/verify`, {}, OMAR);
      expect(v.status).toBe(409);
      await post(`/api/v1/learning/proposals/${r.body.proposal.id}/decline`, { reason: "clean up" }, OMAR);
    });
  });

  describe("every kind applies through its own command and can be rolled back", () => {
    const run = async (kind: string, change: object, check: () => Promise<void>, undone: () => Promise<void>) => {
      const dr = await post("/api/v1/learning/proposals", { finding: fid, kind, title: `kind ${kind}`, change, metric: { target: 0 }, windowDays: 7 }, ASHA, key());
      expect(dr.status, JSON.stringify(dr.body)).toBe(200);
      const id = dr.body.proposal.id;
      const acc = await post(`/api/v1/learning/proposals/${id}/accept`, {}, OMAR);
      expect(acc.status, JSON.stringify(acc.body)).toBe(200);
      await check();
      const rb = await post(`/api/v1/learning/proposals/${id}/rollback`, { reason: "Undo it" }, OMAR);
      expect(rb.status, JSON.stringify(rb.body)).toBe(200);
      await undone();
      expect((await get("/api/v1/learning/proposals")).find((p: any) => p.id === id)).toMatchObject({ status: "rolled_back", reason: "Undo it", rollback: { available: false } });
      expect((await post(`/api/v1/learning/proposals/${id}/rollback`, { reason: "twice again" }, OMAR)).status).toBe(409);
      expect((await w.events("learning.rollback")).pop()).toMatchObject({ subject: { id } });
    };
    it("guardrail: adds a path, and removes it again only on rollback", async () => {
      const paths = async () => (await get("/api/v1/agents")).find((a: any) => a.id === "ag-build").guardrails.paths as string[];
      const was = await paths();
      await run("guardrail", { agent: "ag-build", path: "services/ledger/**" }, async () => expect(await paths()).toContain("services/ledger/**"), async () => expect(await paths()).toEqual(was));
      expect((await w.events("agent.edit")).length).toBeGreaterThanOrEqual(2);
    });
    it("guideline: adds an item to the project's guidelines", async () => {
      const items = async () => ((await get("/api/v1/projects/payments")).guidelines?.items ?? (await q(`select body from guideline_versions where project_id = 'payments' order by version desc limit 1`))[0]?.body?.items ?? []) as any[];
      await run("guideline", { project: "payments", item: { text: "Currency rounding needs property tests", required: true } }, async () => expect((await items()).map((i) => i.text)).toContain("Currency rounding needs property tests"), async () => expect((await items()).map((i) => i.text)).not.toContain("Currency rounding needs property tests"));
    });
    it("approver: adds a condition to the gate's rule", async () => {
      const conds = async () => ((await get("/api/v1/projects/payments")).approvers.G2.conditions as any[]).map((c) => c.text);
      await run("approver", { project: "payments", gate: "G2", condition: { when: { type: "path", value: "ledger/" }, needs: { roles: ["reviewer"], people: [], oncall: false }, text: "Ledger changes need a Reviewer" } }, async () => expect(await conds()).toContain("Ledger changes need a Reviewer"), async () => expect(await conds()).not.toContain("Ledger changes need a Reviewer"));
    });
    it("route: a class skips a station, and goes back on rollback", async () => {
      const skips = async () => (await get("/api/v1/projects/payments")).flow.classes.find((c: any) => c.id === "refactor").skips as string[];
      const was = await skips();
      expect(was).toEqual(["research"]);
      await run("route", { project: "payments", cls: "refactor", addSkip: "build" }, async () => expect(await skips()).toEqual(["research", "build"]), async () => expect(await skips()).toEqual(was));
    });
    it("eval: adds a case, and removes it on rollback while nothing has run it", async () => {
      const cases = async () => (await q(`select id, name from eval_cases where suite_id = 'SUITE-BUILD'`)).map((r: any) => r.name);
      await run("eval", { suite: "SUITE-BUILD", case: { name: "Regression described as a feature", task: "Fix the bug" } }, async () => expect(await cases()).toContain("Regression described as a feature"), async () => expect(await cases()).not.toContain("Regression described as a feature"));
    });
    it("skill rollback restores the text, and is refused once the skill was edited again", async () => {
      const sk = await skillText("sk-testdesign");
      const r = await draftSkill(fid, `${sk.body} Rolled.`);
      const id = r.body.proposal.id;
      await post(`/api/v1/learning/proposals/${id}/accept`, {}, OMAR);
      const mid = await skillText("sk-testdesign");
      const rb = await post(`/api/v1/learning/proposals/${id}/rollback`, { reason: "Undo it" }, OMAR);
      expect(rb.status, JSON.stringify(rb.body)).toBe(200);
      expect((await skillText("sk-testdesign")).body).toBe(sk.body);
      expect((await skillText("sk-testdesign")).versions.length).toBe(mid.versions.length + 1);
      // edited again after the change: the rollback would undo someone else's edit
      const r2 = await draftSkill(fid, `${sk.body} Again.`);
      await post(`/api/v1/learning/proposals/${r2.body.proposal.id}/accept`, {}, OMAR);
      const cur = await skillText("sk-testdesign");
      await w.call(ASHA, "PATCH", "/api/v1/skills/sk-testdesign", { patch: { body: `${cur.body} By hand.` } }, { "if-match": String(cur.rev) });
      const stale = await post(`/api/v1/learning/proposals/${r2.body.proposal.id}/rollback`, { reason: "Undo it" }, OMAR);
      expect(stale.status).toBe(409);
      expect(stale.body.msg).toMatch(/edited again/);
    });
  });

  describe("stopped scopes", () => {
    it("applies nothing into a project that is killed, and says why; once restored it applies", async () => {
      const dr = await post("/api/v1/learning/proposals", { finding: fid, kind: "route", title: "Refactor skips build", change: { project: "payments", cls: "refactor", addSkip: "build" }, metric: { target: 0 }, windowDays: 7 }, ASHA, key());
      expect(dr.status, JSON.stringify(dr.body)).toBe(200);
      const id = dr.body.proposal.id;
      const k = await w.call(ASHA, "POST", "/api/v1/stops", { scope: "project", id: "payments", mode: "kill", reason: "Incident", confirmText: "Payments Platform", inFlight: "hold" });
      expect(k.status, JSON.stringify(k.body)).toBe(200);
      const was = await denials();
      const acc = await post(`/api/v1/learning/proposals/${id}/accept`, {}, OMAR);
      expect([403, 409]).toContain(acc.status);
      expect(acc.body.msg).toMatch(/kill|stop|halt/i);
      expect(await denials()).toBe(was + 1);
      expect((await get("/api/v1/learning/proposals")).find((p: any) => p.id === id).status).toBe("proposed");
      expect((await get("/api/v1/projects/payments")).flow.classes.find((c: any) => c.id === "refactor").skips).toEqual(["research"]);
    });
    it("changes nothing while the factory is killed", async () => {
      const k = await w.call(ASHA, "POST", "/api/v1/stops", { scope: "factory", mode: "kill", reason: "Incident", confirmText: "KILL FACTORY", inFlight: "hold" });
      expect(k.status, JSON.stringify(k.body)).toBe(200);
      const sk = await skillText("sk-testdesign");
      const r = await draftSkill(fid, `${sk.body} Killed.`);
      expect([403, 409]).toContain(r.status);
      expect(r.body.msg).toMatch(/killed/);
      expect([403, 409]).toContain((await refresh()).status);
      expect([403, 409]).toContain((await w.call(ASHA, "PUT", "/api/v1/learning/switch", { on: false })).status);
    });
  });

  it("writes every state change through the ledger", async () => {
    const types = (await q(`select distinct type from events where type like 'learning.%' order by type`)).map((r: any) => r.type);
    expect(types).toEqual(expect.arrayContaining(["learning.apply", "learning.apply.denied", "learning.decline", "learning.draft", "learning.refresh", "learning.rollback", "learning.switch", "learning.verify"]));
  });
});
