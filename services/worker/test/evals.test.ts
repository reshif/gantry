import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_URL } from "./db.js";
import { startWorld, type World } from "./world.js";
import { runIdFor } from "../src/handlers/common.js";

const d = TEST_URL ? describe : describe.skip;
const SHA = "c".repeat(40);

/** An eval run as the API's runSuite leaves it: a suite, its cases, the run row with its items. The worker takes it from there. */
async function seedRun(w: World, o: { cases?: Array<{ id: string; repo?: string | null; commit?: string | null; rules?: object[] }>; repeats?: number; version?: number; model?: string; cap?: number } = {}): Promise<string> {
  const cases = o.cases ?? [{ id: "SPE-01", rules: [{ kind: "output_contains", value: "criteria" }] }, { id: "SPE-02", rules: [{ kind: "output_equals", path: "class", value: "bug" }] }];
  await w.q(`insert into suites (org_id, id, name, station, agent_id, data) values ($1,'SUITE-SPEC','Spec golden set','spec','ag-spec','{"threshold":0.5}'::jsonb)`, [w.orgId]);
  for (const c of cases) await w.q(`insert into eval_cases (org_id, id, suite_id, name, body, golden) values ($1,$2,'SUITE-SPEC',$3,$4::jsonb,$5)`, [w.orgId, c.id, `Case ${c.id}`, JSON.stringify({ task: `Do ${c.id}`, repo: c.repo ?? null, commit: c.commit ?? null, rules: c.rules ?? [] }), !!c.repo]);
  const repeats = o.repeats ?? 1;
  const items = cases.flatMap((c) => Array.from({ length: repeats }, (_, i) => ({ case: c.id, n: i + 1, state: "pending" })));
  const snaps = Object.fromEntries(cases.map((c) => [c.id, { name: `Case ${c.id}`, task: `Do ${c.id}`, repo: c.repo ?? null, commit: c.commit ?? null, project: "payments", cls: "feature", checks: c.rules ?? [] }]));
  const ver = o.version ?? 1;
  await w.q(`insert into eval_runs (org_id, id, suite_id, status, started_by, data) values ($1,'RUN-1','SUITE-SPEC','queued','p-asha',$2::jsonb)`, [w.orgId, JSON.stringify({ agent: "ag-spec", version: "1.0.0", versionNumber: ver, model: o.model ?? "claude-sonnet-5-5", vendor: null, override: true, repeats, station: "spec", cap: 2, items, cases: snaps })]);
  if (o.cap) await w.q(`update orgs set settings = jsonb_set(settings, '{evals}', $1::jsonb)`, [JSON.stringify({ maxConcurrent: o.cap })]);
  await w.enqueue("eval.dispatch", { runId: "RUN-1" }, { dedupeKey: "eval.dispatch:RUN-1" });
  return "RUN-1";
}

const attempts = (w: World) => w.q(`select a.id, a.fencing::text, a.state, a.tuple_id, a.data, w.id wo, w.state wo_state from attempts a join work_orders w on w.id = a.wo_id where w.source = 'eval' order by a.id`);
const runItems = async (w: World) => (await w.q(`select status, score::text, data from eval_runs where id = 'RUN-1'`))[0];
async function deliver(w: World, att: { id: string; fencing: string; wo: string }, status: "succeeded" | "failed", output: object | null = {}, error?: object) {
  const runId = runIdFor(att.id);
  await w.q(`insert into station_results (org_id, id, attempt_id, wo_id, station, outcome, summary, body) values ($1,$2,$3,$4,'spec',$5,'done',$6::jsonb)`, [w.orgId, `sr-${runId}`, att.id, att.wo, status, JSON.stringify({ output, usage: [], error: error ?? null, adapter: "stub" })]);
  await w.enqueue("run.result", { runId, attemptId: att.id, fencing: Number(att.fencing) }, { dedupeKey: `run.result:${runId}` });
}

d("eval runs through the production runtime (spec 13.2)", () => {
  let w: World;
  beforeEach(async () => { w = await startWorld(); });
  afterEach(async () => { await w.close(); });

  it("starts a case's attempt in a sandbox at the version and model picked, behind work orders, within the cap", async () => {
    await seedRun(w, { cap: 1, version: 1 });
    await w.drain();
    const at = await attempts(w);
    expect(at.length).toBe(1);
    expect(at[0]).toMatchObject({ state: "running", wo_state: "done" });
    const tuple = (await w.q(`select agent_id, agent_version, model_id from agent_version_tuples where id = $1`, [at[0].tuple_id]))[0];
    expect(tuple).toMatchObject({ agent_id: "ag-spec", agent_version: 1, model_id: "claude-sonnet-5-5" });
    const live = (await w.q(`select live_version from agents where id = 'ag-spec'`))[0].live_version;
    expect(live).not.toBe(1);
    expect(w.launcher.runs.has(runIdFor(at[0].id))).toBe(true);
    expect((await w.q(`select priority from jobs where kind = 'attempt.dispatch'`)).every((j) => j.priority === -10)).toBe(true);
    expect((await w.q(`select data from runs where attempt_id = $1`, [at[0].id]))[0].data).toMatchObject({ adapter: "claude" });
    expect((await runItems(w)).status).toBe("running");
  });

  it("grades each result with the case's checks, never publishes, never touches the flow, and starts the next case", async () => {
    await seedRun(w, { cap: 1 });
    await w.drain();
    const first = (await attempts(w))[0];
    await deliver(w, first, "succeeded", { summary: "It lists acceptance criteria" });
    await w.drain();
    const at = await attempts(w);
    expect(at.map((a: any) => a.state).sort()).toEqual(["running", "succeeded"]);
    expect(w.launcher.runs.has(runIdFor(first.id))).toBe(false);
    const second = at.find((a: any) => a.state === "running");
    await deliver(w, second, "succeeded", { class: "feature" });
    await w.drain();
    const run = await runItems(w);
    expect(run).toMatchObject({ status: "completed", score: "0.5" });
    expect(run.data.items.map((i: any) => [i.case, i.state, i.pass])).toEqual([["SPE-01", "done", true], ["SPE-02", "done", false]]);
    const res = await w.q(`select case_id, passed, detail from eval_results order by case_id`);
    expect(res.map((r: any) => [r.case_id, r.passed])).toEqual([["SPE-01", true], ["SPE-02", false]]);
    expect(res[1].detail.reason).toMatch(/Got "feature"/);
    // nothing was published, no gate or work-order state moved, the carriers stay out of the flow
    expect(w.broker.count("publish")).toBe(0);
    expect((await w.q(`select count(*)::int n from gate_instances where wo_id like 'EV-%'`))[0].n).toBe(0);
    expect((await w.q(`select count(*)::int n from work_orders where source = 'eval' and state <> 'done'`))[0].n).toBe(0);
    expect((await w.q(`select count(*)::int n from events where type = 'eval.finished'`))[0].n).toBe(1);
    expect((await w.q(`select count(*)::int n from run_tokens where revoked_at is null`))[0].n).toBe(0);
  });

  it("seeds a case's workspace at its pinned commit, read-only, and the brief it is given has the task and no checks", async () => {
    await w.q(`update repos set github_full_name = 'acme/payments-api' where id = 'payments-api'`);
    await seedRun(w, { cases: [{ id: "SPE-01", repo: "payments-api", commit: SHA, rules: [{ kind: "output_contains", value: "SECRET-RUBRIC" }] }] });
    await w.drain();
    const seed = w.broker.calls.find((c) => c.op === "seed")!;
    expect(seed.body).toMatchObject({ repo: "acme/payments-api", commit: SHA });
    const at = (await attempts(w))[0];
    expect(JSON.stringify(at.data.input)).not.toMatch(/SECRET-RUBRIC/);
    expect(at.data.input).toMatchObject({ goal: "Do SPE-01", repo: "payments-api", commit: SHA });
    await deliver(w, at, "succeeded", { summary: "SECRET-RUBRIC", commits: ["x"], headSha: "f".repeat(40) });
    await w.drain();
    expect(w.broker.count("publish")).toBe(0);
    expect((await runItems(w)).status).toBe("completed");
  });

  it("repeats each task, counts a task as passed when most runs pass, and records the repeats", async () => {
    await seedRun(w, { cases: [{ id: "SPE-01", rules: [{ kind: "output_contains", value: "ok" }] }], repeats: 3, cap: 3 });
    await w.drain();
    expect((await attempts(w)).length).toBe(3);
    const outs = ["ok", "nope", "ok"];
    for (const [i, a] of (await attempts(w)).entries()) await deliver(w, a, "succeeded", { summary: outs[i] });
    await w.drain();
    const res = (await w.q(`select passed, score::text, detail from eval_results`))[0];
    expect(res).toMatchObject({ passed: true, score: "0.667" });
    expect(res.detail).toMatchObject({ repeats: 3, passes: 2, graded: 3 });
  });

  it("a case that cannot start ends with an error, neither a pass nor a fail, and the run still finishes", async () => {
    await w.q(`update repos set github_full_name = 'acme/payments-api' where id = 'payments-api'`);
    w.broker.failSeed = 99;
    await seedRun(w, { cases: [{ id: "SPE-01", repo: "payments-api", commit: SHA }], cap: 1 });
    await w.drain(4);
    const run = await runItems(w);
    expect(run.status).toBe("failed");
    expect(run.data.items[0]).toMatchObject({ state: "done", error: expect.stringMatching(/could not be started/) });
    expect((await w.q(`select passed, detail from eval_results`))[0]).toMatchObject({ passed: false });
    expect((await attempts(w))[0].state).toBe("failed");
  }, 30000);

  it("sweeps an attempt that lost its lease and one that sat behind a stop, so a run is never stuck", async () => {
    await seedRun(w, { cap: 2 });
    await w.drain();
    const [a, b] = await attempts(w);
    await w.q(`update attempts set lease_until = now() - interval '1 minute' where id = $1`, [a.id]);
    await w.q(`insert into stops (org_id, id, scope_type, project_id, mode, reason, set_by) values ($1,'project:payments:1','project','payments','halt','test','system')`, [w.orgId]);
    await w.q(`update attempts set state = 'queued', created_at = now() - interval '1 hour' where id = $1`, [b.id]);
    await w.enqueue("reaper.sweep", {}, { dedupeKey: "sweep-1" });
    await w.drain();
    const run = await runItems(w);
    expect(run.data.items.map((i: any) => [i.state, i.error ?? ""])).toEqual([["done", "The run stopped heartbeating."], ["cancelled", expect.stringMatching(/stop covers/)]]);
    expect(run.status).toBe("failed");
    // the engine's own lease expiry and the watchdog leave the carrier out of the flow
    expect((await w.q(`select count(*)::int n from events where type = 'run.lease_expired'`))[0].n).toBe(0);
  });

  it("ends a case whose run exceeded its wall-clock limit with an error", async () => {
    await seedRun(w, { cases: [{ id: "SPE-01" }], cap: 1 });
    await w.drain();
    const a = (await attempts(w))[0];
    const runId = runIdFor(a.id);
    await w.q(`update runs set data = data || '{"wallClockSeconds": 1}'::jsonb, started_at = now() - interval '1 hour' where id = $1`, [runId]);
    await w.enqueue("reaper.sweep", {}, { dedupeKey: "sweep-wc" });
    await w.drain();
    const run = await runItems(w);
    expect(run.data.items[0]).toMatchObject({ state: "done", error: expect.stringMatching(/wall-clock/) });
    expect((await w.q(`select state from runs where id = $1`, [runId]))[0].state).toBe("stopped");
  });

  it("a stop on the project refuses the case's run at dispatch like any other run", async () => {
    await w.q(`insert into stops (org_id, id, scope_type, project_id, mode, reason, set_by) values ($1,'project:payments:2','project','payments','halt','test','system')`, [w.orgId]);
    await seedRun(w, { cases: [{ id: "SPE-01" }], cap: 1 });
    await w.drain();
    expect(w.launcher.runs.size).toBe(0);
    expect((await w.jobs("attempt.dispatch"))[0]?.result).toMatchObject({ skipped: expect.stringMatching(/halt/) });
  });

  it("runs the trust evaluation job without error when there is nothing to propose", async () => {
    await w.enqueue("trust.evaluate", {}, { dedupeKey: "te-1" });
    await w.drain();
    expect((await w.jobs("trust.evaluate"))[0]).toMatchObject({ status: "done", result: { demoted: 0, proposed: 0 } });
  });
});
