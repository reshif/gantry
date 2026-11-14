import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTx } from "@gantry/db";
import { cancelEvalRun, failEvalAttempt, gradeEvalAttempt, progressEval, sweepEvals } from "../src/areas/evals/engine.js";
import { grade, wilson } from "../src/areas/evals/checks.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const ADMIN = "p-asha";
const ENGINEER = "p-tomas";
const SUITE = "SUITE-SPEC";

d("evals (spec 13.2, 8.7)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
    await t.db.admin.query(`insert into suites (org_id, id, name, station, agent_id, data) values ($1,$2,'Spec golden set','spec','ag-spec','{"threshold":0.6}'::jsonb)`, [t.orgId, SUITE]);
  });
  afterAll(async () => {
    await t.close();
  });
  const w = world(() => t);
  const q = w.q;
  let n = 0;
  const key = (): Record<string, string> => ({ "idempotency-key": `ev-${Date.now()}-${n++}` });
  const addCase = (body: object, who = ADMIN, suite = SUITE) => w.call(who, "POST", `/api/v1/suites/${suite}/cases`, body, key());
  const run = (body: object = {}, who = ADMIN, suite = SUITE) => w.call(who, "POST", `/api/v1/suites/${suite}/runs`, { agent: "ag-spec", version: "live", ...body }, key());
  const liveLabel = async (): Promise<string> => (await w.call(ADMIN, "GET", "/api/v1/agents")).body.find((a: any) => a.id === "ag-spec").version;
  const runs = async (suite = SUITE) => (await w.call(ADMIN, "GET", `/api/v1/suites/${suite}/runs`)).body as any[];
  const now = () => new Date();
  const eng = <T>(fn: (tx: import("@gantry/db").Tx) => Promise<T>) => withTx(t.db.app, fn);
  /** The attempts of a run, as the worker would see them after dispatch. */
  const attempts = (runId: string) => q(`select a.id, a.fencing::text, a.state, a.data, w.id wo, w.source, w.state wo_state from attempts a join work_orders w on w.id = a.wo_id where w.data->'eval'->>'run' = $1 order by a.id`, [runId]);

  describe("cases", () => {
    it("is denied for someone without eval.run, and audited", async () => {
      const r = await addCase({ name: "Sneaky" }, ENGINEER);
      expect(r.status).toBe(403);
      expect((await w.events("eval.run.denied")).length).toBe(1);
    });
    it("adds golden cases with deterministic checks, pinned to a repo snapshot", async () => {
      const a = await addCase({ name: "Vague one-liner", task: "Write a spec for: make refunds faster", checks: "Asks what faster means", mustMention: ["acceptance criteria"], mustNotTouch: ["secrets/"] });
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(a.body.case).toMatchObject({ id: "SPE-01", name: "Vague one-liner", golden: false, task: "Write a spec for: make refunds faster", checks: "Asks what faster means" });
      expect(a.body.case.rules.map((r: any) => r.kind)).toEqual(["output_contains", "path_not_touched", "model_graded"]);
      const sha = "a".repeat(40);
      const b = await addCase({ name: "Pinned to a snapshot", repo: "payments-api", commit: sha, rules: [{ kind: "output_equals", path: "class", value: "bug" }] });
      expect(b.status, JSON.stringify(b.body)).toBe(200);
      expect(b.body.case).toMatchObject({ id: "SPE-02", golden: true, repo: "payments-api", commit: sha });
      const suites = (await w.call(ADMIN, "GET", "/api/v1/suites")).body;
      const s = suites.find((x: any) => x.id === SUITE);
      expect(s).toMatchObject({ station: "spec", threshold: 0.6, agent: "ag-spec", running: null });
      expect(s.cases.map((c: any) => c.id)).toEqual(["SPE-01", "SPE-02"]);
      expect((await w.events("eval.case")).length).toBe(2);
    });
    it("refuses an unknown suite, a blank name, a commit with no repo, a repo with no recorded commit and bad checks", async () => {
      expect((await addCase({ name: "x" }, ADMIN, "SUITE-NOPE")).status).toBe(404);
      expect((await addCase({ name: "  " })).status).toBe(422);
      expect((await addCase({ name: "c", commit: "b".repeat(40) })).status).toBe(422);
      expect((await addCase({ name: "c", repo: "payments-api" })).status).toBe(422);
      expect((await addCase({ name: "c", repo: "no-such-repo", commit: "c".repeat(40) })).status).toBe(422);
      expect((await addCase({ name: "c", rules: [{ kind: "output_matches", pattern: "" }] })).status).toBe(422);
      expect((await addCase({ name: "c", skill: "sk-none" })).status).toBe(422);
    });
    it("an idempotent retry adds one case", async () => {
      const k = key();
      const a = await w.call(ADMIN, "POST", `/api/v1/suites/${SUITE}/cases`, { name: "Retry me" }, k);
      const b = await w.call(ADMIN, "POST", `/api/v1/suites/${SUITE}/cases`, { name: "Retry me" }, k);
      expect(a.body.case.id).toBe(b.body.case.id);
      await q(`delete from eval_cases where name = 'Retry me'`);
    });
  });

  describe("grading", () => {
    it("decides on deterministic checks only; a model-graded check is advisory and never counts", () => {
      const g = grade(
        [{ kind: "output_contains", value: "rollback" }, { kind: "output_equals", path: "class", value: "bug" }, { kind: "path_not_touched", paths: ["secrets/"] }, { kind: "model_graded", rubric: "Is it polite?" }],
        { status: "succeeded", output: { class: "bug", summary: "Includes a Rollback plan", filesChanged: ["src/a.ts"] }, seconds: 3 },
      );
      expect(g.pass).toBe(true);
      expect(g.checks.find((c) => c.advisory)).toMatchObject({ pass: null, advisory: true });
      const bad = grade([{ kind: "output_equals", path: "class", value: "bug" }, { kind: "path_not_touched", paths: ["secrets"] }, { kind: "max_files", n: 0 }], { status: "succeeded", output: { class: "feature", filesChanged: ["secrets/key.txt"] }, seconds: 1 });
      expect(bad.pass).toBe(false);
      expect(bad.checks.filter((c) => c.pass === false).length).toBe(3);
      expect(grade([], { status: "failed", output: null, error: { code: "x", msg: "boom" }, seconds: 1 })).toMatchObject({ pass: false, reason: "boom" });
      expect(grade([{ kind: "model_graded", rubric: "Only advice" }], { status: "succeeded", output: {}, seconds: 1 }).pass).toBe(true);
    });
    it("reports a range beside a score", () => {
      expect(wilson(0, 0)).toEqual([0, 0]);
      const [lo, hi] = wilson(5, 6);
      expect(lo).toBeGreaterThan(0.4);
      expect(hi).toBeLessThanOrEqual(1);
      expect(wilson(6, 6)[1]).toBe(1);
      expect(wilson(30, 36)[1] - wilson(30, 36)[0]).toBeLessThan(wilson(5, 6)[1] - wilson(5, 6)[0]);
    });
  });

  describe("running a suite", () => {
    let runId = "";
    it("is denied for someone without eval.run, refuses a suite with no cases, an unknown version or model", async () => {
      expect((await run({}, ENGINEER)).status).toBe(403);
      await q(`insert into suites (org_id, id, name, station, agent_id, data) values ($1,'SUITE-EMPTY','Empty','spec','ag-spec','{}'::jsonb)`, [t.orgId]);
      expect((await run({ version: await liveLabel() }, ADMIN, "SUITE-EMPTY")).status).toBe(422);
      expect((await run({ version: "9.9.9" })).status).toBe(404);
      expect((await run({ version: await liveLabel(), model: "gpt-nope" })).status).toBe(422);
      expect((await run({ agent: "ag-review", version: "1.0.0" })).status).toBe(422);
      expect((await w.call(ADMIN, "POST", `/api/v1/suites/${SUITE}/runs`, { agent: "ag-spec", version: await liveLabel(), repeats: 9 }, key())).status).toBe(422);
      expect((await q(`select count(*)::int n from eval_runs`))[0].n).toBe(0);
    });
    it("starts a run: its items, a job behind work-order jobs, the audit event, and one run at a time per suite", async () => {
      const r = await w.call(ADMIN, "POST", `/api/v1/suites/${SUITE}/runs`, { agent: "ag-spec", version: await liveLabel(), repeats: 2 }, key());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      runId = r.body.run;
      expect(runId).toMatch(/^RUN-\d+$/);
      expect(r.body.total).toBe(4);
      const job = (await q(`select kind, queue, priority, payload from jobs where kind = 'eval.dispatch'`))[0];
      expect(job).toMatchObject({ kind: "eval.dispatch", queue: "flow", priority: -10, payload: { runId } });
      expect((await w.events("eval.run")).at(-1).after).toMatchObject({ run: runId, suite: SUITE, cases: 2, repeats: 2, override: false });
      expect((await run({ version: await liveLabel() })).status).toBe(409);
      expect((await w.call(ADMIN, "GET", "/api/v1/suites")).body.find((s: any) => s.id === SUITE).running).toBe(runId);
      const rr = (await runs())[0];
      expect(rr).toMatchObject({ id: runId, status: "queued", repeats: 2, total: 4, done: 0, score: 0, results: [] });
    });
    it("starts items within the eval cap, as hidden carrier work orders with queued attempts at the version picked", async () => {
      await q(`update orgs set settings = jsonb_set(settings, '{evals}', '{"maxConcurrent":1}')`);
      const out = await eng((tx) => progressEval(tx, t.orgId, runId, now()));
      expect(out).toMatchObject({ finished: false, status: "running" });
      expect(out.jobs.map((j) => [j.kind, j.priority])).toEqual([["attempt.dispatch", -10]]);
      const at = await attempts(runId);
      expect(at.length).toBe(1);
      expect(at[0]).toMatchObject({ state: "queued", source: "eval", wo_state: "done" });
      expect(at[0].data.input).toMatchObject({ goal: "Write a spec for: make refunds faster", eval: true });
      expect(JSON.stringify(at[0].data.input)).not.toMatch(/asks what faster|acceptance criteria/i);
      expect(at[0].data).toMatchObject({ agent: "ag-spec", agentVersion: expect.any(Number) });
      // the cap holds across a second call
      expect((await eng((tx) => progressEval(tx, t.orgId, runId, now()))).jobs.length).toBe(0);
    });
    it("never shows an eval carrier as work: not in lists, counts, the floor or the home view", async () => {
      const list = await w.call(ADMIN, "GET", "/api/v1/projects/payments/work-orders?limit=200");
      const all = JSON.stringify(list.body);
      expect(all).not.toMatch(/"EV-/);
      expect(JSON.stringify((await w.call(ADMIN, "GET", "/api/v1/projects/payments/floor")).body)).not.toMatch(/EV-/);
      expect(JSON.stringify((await w.call(ADMIN, "GET", "/api/v1/home")).body)).not.toMatch(/EV-/);
      expect((await w.call(ADMIN, "GET", `/api/v1/work-orders/${(await attempts(runId))[0].wo}`)).status).toBe(404);
    });
    it("grades a result with the case's checks, ends the attempt, and starts the next case", async () => {
      const a = (await attempts(runId))[0];
      await q(`update attempts set state = 'running', started_at = now() - interval '5 seconds' where id = $1`, [a.id]);
      const r = await eng((tx) => gradeEvalAttempt(tx, t.orgId, a.id, Number(a.fencing), { status: "succeeded", output: { summary: "Has acceptance criteria listed", filesChanged: ["docs/x.md"] } }, now()));
      expect(r).toMatchObject({ applied: true });
      expect(r.jobs.length).toBe(1);
      const after = await attempts(runId);
      expect(after.map((x: any) => x.state).sort()).toEqual(["queued", "succeeded"]);
      const item = (await q(`select data from eval_runs where id = $1`, [runId]))[0].data.items.find((i: any) => i.attempt === a.id);
      expect(item).toMatchObject({ state: "done", pass: true });
      expect(item.checks.map((c: any) => c.kind)).toContain("model_graded");
      // a second result for the same attempt changes nothing
      expect(await eng((tx) => gradeEvalAttempt(tx, t.orgId, a.id, Number(a.fencing), { status: "failed", output: null }, now()))).toMatchObject({ applied: false });
      // a stale fencing number is refused
      const b = after.find((x: any) => x.state === "queued");
      expect(await eng((tx) => gradeEvalAttempt(tx, t.orgId, b.id, Number(b.fencing) + 1, { status: "succeeded", output: {} }, now()))).toMatchObject({ applied: false, reason: "superseded" });
    });
    it("finishes the run when every item is done: per-case results, a score with its range, and no regression event while it passes", async () => {
      for (let i = 0; i < 6; i++) {
        const live = (await attempts(runId)).find((x: any) => x.state === "queued" || x.state === "running");
        if (!live) break;
        // Case SPE-02 has a deterministic check the stub-like output fails; SPE-01 passes.
        const pass = live.id.includes("SPE-01");
        await q(`update attempts set state = 'running', started_at = now() - interval '2 seconds' where id = $1`, [live.id]);
        await eng((tx) => gradeEvalAttempt(tx, t.orgId, live.id, Number(live.fencing), { status: "succeeded", output: { class: pass ? "bug" : "feature", summary: "acceptance criteria" } }, now()));
      }
      const rr = (await runs())[0];
      expect(rr).toMatchObject({ id: runId, status: "completed", count: 2, passed: 1, score: 0.5, repeats: 2, version: await liveLabel(), model: expect.any(String) });
      expect(rr.range[0]).toBeLessThan(0.5);
      expect(rr.range[1]).toBeGreaterThan(0.5);
      expect(rr.results.map((x: any) => [x.caseId, x.pass, x.repeats, x.passes])).toEqual([["SPE-01", true, 2, 2], ["SPE-02", false, 2, 0]]);
      expect(rr.results[0].advisory[0]).toMatchObject({ advisory: true, pass: null });
      const fin = (await w.events("eval.finished")).at(-1);
      expect(fin).toMatchObject({ outcome: "regression" });
      expect(fin.after).toMatchObject({ run: runId, tasks: 2, passed: 1, score: 0.5, threshold: 0.6 });
      expect((await w.call(ADMIN, "GET", "/api/v1/suites")).body.find((s: any) => s.id === SUITE).running).toBeNull();
    });
    it("feeds the promotion gate: a completed run below the threshold blocks the version, and a model override does not qualify it", async () => {
      const ag = (await w.call(ADMIN, "GET", "/api/v1/agents")).body.find((a: any) => a.id === "ag-spec");
      const live = ag.versions.find((v: any) => v.live);
      expect(live.eligibility).toMatchObject({ ok: false, score: 0.5, run: runId, runs: 1 });
      const o = await q(`select data from eval_runs where id = $1`, [runId]);
      expect(o[0].data.override).toBe(false);
    });
    it("a regression against the same version's last good run is reported as one", async () => {
      await q(`update suites set data = '{"threshold":0.3}'::jsonb where id = $1`, [SUITE]);
      const r = await run({ version: await liveLabel() });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const id = r.body.run as string;
      for (let i = 0; i < 6; i++) {
        await eng((tx) => progressEval(tx, t.orgId, id, now()));
        const live = (await attempts(id)).find((x: any) => x.state === "queued");
        if (!live) break;
        await q(`update attempts set state = 'running' where id = $1`, [live.id]);
        await eng((tx) => gradeEvalAttempt(tx, t.orgId, live.id, Number(live.fencing), { status: "failed", output: null, error: { code: "x", msg: "It broke" } }, now()));
      }
      const rr = (await runs()).find((x) => x.id === id);
      expect(rr).toMatchObject({ status: "completed", score: 0 });
      expect((await w.events("eval.finished")).at(-1)).toMatchObject({ outcome: "regression" });
    });
    it("ends an item with an error when its attempt cannot run, which is neither a pass nor a fail of the agent", async () => {
      const r = await run({ version: await liveLabel() });
      const id = r.body.run as string;
      await q(`update orgs set settings = jsonb_set(settings, '{evals}', '{"maxConcurrent":8}')`);
      await eng((tx) => progressEval(tx, t.orgId, id, now()));
      const at = await attempts(id);
      expect(at.length).toBe(2);
      for (const a of at) await eng((tx) => failEvalAttempt(tx, t.orgId, a.id, { code: "no_commit", msg: "No commit is recorded" }, now()));
      const rr = (await runs()).find((x) => x.id === id);
      expect(rr).toMatchObject({ status: "failed", count: 0, score: 0 });
      expect(rr.results[0]).toMatchObject({ pass: false, reason: "No commit is recorded" });
      expect((await w.events("eval.finished")).at(-1)).toMatchObject({ outcome: "failed" });
    });
    it("expires a lost lease and ends a case that sits behind a stop", async () => {
      const r = await run({ version: await liveLabel() });
      const id = r.body.run as string;
      await eng((tx) => progressEval(tx, t.orgId, id, now()));
      const at = await attempts(id);
      await q(`update attempts set state = 'running', lease_until = now() - interval '1 minute' where id = $1`, [at[0].id]);
      const s = await eng((tx) => sweepEvals(tx, t.orgId, now()));
      expect(s.ended).toBe(1);
      expect((await q(`select state, outcome from attempts where id = $1`, [at[0].id]))[0]).toMatchObject({ state: "failed", outcome: "lease_expired" });
      // the engine's own lease expiry never touches an eval carrier
      await q(`update attempts set state = 'running', lease_until = now() - interval '1 minute' where wo_id in (select wo_id from attempts where data->'eval'->>'run' = $1) and state = 'queued'`, [id]);
      const { expireLeases } = await import("../src/areas/workorders/station.js");
      expect(await eng((tx) => expireLeases(tx, { now: now() }))).toEqual([]);
      await q(`insert into stops (org_id, id, scope_type, project_id, mode, reason, set_by) values ($1,'project:payments:77','project','payments','halt','test','system')`, [t.orgId]);
      await q(`update attempts set state = 'queued', lease_until = null, created_at = now() - interval '1 hour' where data->'eval'->>'run' = $1`, [id]);
      const s2 = await eng((tx) => sweepEvals(tx, t.orgId, now()));
      expect(s2.ended).toBeGreaterThanOrEqual(1);
      expect((await q(`select state from attempts where data->'eval'->>'run' = $1`, [id])).every((x: any) => x.state !== "queued")).toBe(true);
      await q(`delete from stops where id = 'project:payments:77'`);
      await eng((tx) => cancelEvalRun(tx, t.orgId, id, now()));
    });
    it("cancels a run: pending items end, live attempts end, and the run is cancelled", async () => {
      await q(`update eval_runs set status = 'cancelled' where status in ('queued','running')`);
      const r = await run({ version: await liveLabel() });
      const id = r.body.run as string;
      await eng((tx) => progressEval(tx, t.orgId, id, now()));
      expect((await w.call(ENGINEER, "POST", `/api/v1/suites/${SUITE}/runs/${id}/cancel`, {})).status).toBe(403);
      const c = await w.call(ADMIN, "POST", `/api/v1/suites/${SUITE}/runs/${id}/cancel`, {});
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      expect((await runs()).find((x) => x.id === id)).toMatchObject({ status: "cancelled" });
      expect((await attempts(id)).every((a: any) => a.state === "cancelled")).toBe(true);
      expect((await w.call(ADMIN, "POST", `/api/v1/suites/${SUITE}/runs/${id}/cancel`, {})).status).toBe(409);
      expect((await w.call(ADMIN, "POST", `/api/v1/suites/${SUITE}/runs/RUN-9999/cancel`, {})).status).toBe(404);
    });
    it("refuses a run while the factory is killed", async () => {
      await q(`insert into stops (org_id, id, scope_type, mode, reason, set_by) values ($1,'factory:factory:98','factory','kill','test','system')`, [t.orgId]);
      const r = await run({ version: await liveLabel() });
      expect(r.status).toBe(409);
      expect(r.body.rule).toMatchObject({ kind: "stop" });
      await q(`delete from stops where id = 'factory:factory:98'`);
    });
  });

  describe("scorecards and the factory view", () => {
    it("returns a card per agent from what happened, with counts, and zero where nothing happened", async () => {
      const sc = (await w.call(ADMIN, "GET", "/api/v1/evals/scorecards")).body;
      expect(Object.keys(sc)).toEqual(expect.arrayContaining(["ag-spec", "ag-build"]));
      expect(sc["ag-spec"]).toMatchObject({ taskSuccess: 0, counts: { attempts: 0, decisions: 0 }, trend: { success: expect.any(Array), cost: expect.any(Array) } });
      expect(sc["ag-spec"].trend.success.length).toBe(8);
    });
    it("counts live work only: a finished work order shows in the card and an eval carrier does not", async () => {
      const id = (await w.submit("p-meera", { title: "Scorecard work order" })).body.id as string;
      await w.answerAll(id, "p-meera");
      await w.confirm(id, "p-meera");
      await w.walk(id, (x) => x.state === "done", 80);
      const sc = (await w.call(ADMIN, "GET", "/api/v1/evals/scorecards")).body;
      const total = Object.values(sc).reduce((s: number, c: any) => s + c.counts.attempts, 0);
      expect(total).toBeGreaterThan(5);
      expect(sc["ag-spec"].counts.attempts).toBe(1);
      expect(sc["ag-spec"]).toMatchObject({ taskSuccess: 1 });
      expect(sc["ag-spec"].counts.decisions).toBeGreaterThanOrEqual(1);
      const f = (await w.call(ADMIN, "GET", "/api/v1/evals/factory")).body;
      expect(f).toMatchObject({ counts: { workOrders: expect.any(Number) }, onboardingStages: expect.any(Object), gateRejections: expect.any(Array) });
      expect(f.heat["ag-spec"].payments).toBe(1);
      expect(Object.keys(f.perClass)).toContain("feature");
      expect(f.perClass.feature.count).toBeGreaterThanOrEqual(1);
    });
    it("returns every suite's recent runs in one request, oldest first, each naming its suite", async () => {
      await q(`insert into suites (org_id, id, name, station, agent_id, data) values ($1,'SUITE-OTHER','Other','review','ag-review','{}'::jsonb) on conflict do nothing`, [t.orgId]);
      await q(`insert into eval_runs (org_id, id, suite_id, status, score, data) values ($1,'RUN-700','SUITE-OTHER','completed',0.9,'{"agent":"ag-review","version":"1.0.0","model":"x","items":[],"cases":{}}'::jsonb)`, [t.orgId]);
      const all = (await w.call(ADMIN, "GET", "/api/v1/evals/runs")).body as any[];
      expect(new Set(all.map((r) => r.suite))).toEqual(new Set([SUITE, "SUITE-OTHER"]));
      expect(all.map((r) => r.at)).toEqual([...all.map((r) => r.at)].sort((a, b) => a - b));
      expect(all.find((r) => r.id === "RUN-700")).toMatchObject({ suite: "SUITE-OTHER", score: 0.9, status: "completed" });
      expect((await t.app.inject({ method: "GET", url: "/api/v1/evals/runs" })).statusCode).toBe(401);
    });
    it("limits the factory view to the projects a person can see", async () => {
      const f = (await w.call(ENGINEER, "GET", "/api/v1/evals/factory")).body;
      expect(Object.keys(f.heat["ag-spec"] ?? {}).filter((p) => p !== "payments")).toEqual([]);
    });
    it("is for signed-in people only", async () => {
      for (const url of ["/api/v1/suites", `/api/v1/suites/${SUITE}/runs`, "/api/v1/evals/scorecards", "/api/v1/evals/factory"]) expect((await t.app.inject({ method: "GET", url })).statusCode).toBe(401);
      expect((await w.call(ADMIN, "GET", "/api/v1/suites/NOPE/runs")).status).toBe(404);
    });
  });
});
