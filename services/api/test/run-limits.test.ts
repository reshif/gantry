import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { loadRunLimits, resolveRunLimits } from "../src/areas/agents/run-limits.js";
import { loadRunCtx } from "../src/areas/internal/context.js";
import { composeRunSpec } from "../src/areas/internal/spec.js";
import { loadLimits } from "../src/areas/internal/metering.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const ADMIN = "p-asha";
const NOBODY = "p-tomas";

describe("run limits: resolution order (no database)", () => {
  it("resolves each field on its own: one-off, then station, then agent, then default", () => {
    expect(resolveRunLimits({})).toMatchObject({ turns: 40, wallClockSeconds: 3600, source: { turns: "default", wallClockSeconds: "default" } });
    expect(resolveRunLimits({}).costUsd).toBeUndefined();
    // the agent sets turns, time and cost; the station overrides turns only; a one-off raises time only
    const r = resolveRunLimits({ agent: { turns: 12, wallClockSeconds: 1800, costUsd: 3 }, station: { turns: 80 }, oneOff: { wallClockSeconds: 7200 } });
    expect(r).toMatchObject({ turns: 80, wallClockSeconds: 7200, costUsd: 3, source: { turns: "station", wallClockSeconds: "oneOff", costUsd: "agent" } });
    // the agent's own per-run budget is the cost limit when nothing sets one
    expect(resolveRunLimits({ agentBudget: 2.5 })).toMatchObject({ costUsd: 2.5, source: { costUsd: "agentBudget" } });
    expect(resolveRunLimits({ agentBudget: 2.5, agent: { costUsd: 1 } })).toMatchObject({ costUsd: 1, source: { costUsd: "agent" } });
    // junk in a stored row is ignored, never trusted
    expect(resolveRunLimits({ agent: { turns: -3, wallClockSeconds: "x", costUsd: 0 } })).toMatchObject({ turns: 40, wallClockSeconds: 3600 });
  });
});

d("run limits: agent version, station override, one-off retry raise", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const q = w.q;
  const rev = async (id: string) => String((await w.call(ADMIN, "GET", "/api/v1/agents")).body.find((a: any) => a.id === id).rev);
  const save = async (id: string, patch: object, who = ADMIN) => w.call(who, "PATCH", `/api/v1/agents/${id}`, { patch }, { "if-match": await rev(id) });
  const projVer = async (p: string) => String((await q(`select version from projects where id = $1`, [p]))[0].version);
  const setStation = async (path: string, value: unknown, who = ADMIN) => w.call(who, "PATCH", "/api/v1/projects/payments/config", { path, value }, { "if-match": await projVer("payments") });
  let n = 0;
  /** A run of `agent`'s live version at `station` in payments, and the spec the runner would be served for it. */
  async function specFor(agent: string, station: string, attemptData: object = {}) {
    const i = ++n;
    const o = t.orgId;
    const woId = `WO-rl-${i}`, attemptId = `at-rl-${i}`, runId = `run-rl-${i}`;
    await q(`insert into work_orders (org_id, id, project_id, title, class, position, state, flow_version, data) values ($1,$2,'payments','T','feature',$3,'running',1,'{}')`, [o, woId, station]);
    const live = (await q(`select live_version from agents where id = $1`, [agent]))[0].live_version;
    await q(`insert into agent_version_tuples (org_id, id, agent_id, agent_version, skill_versions, instruction_hash, harness_version, model_id) values ($1,$2,$3,$4,'{}','h','1','claude-opus-5-5') on conflict do nothing`, [o, `tup-rl-${agent}-${live}`, agent, live]);
    await q(`insert into attempts (org_id, id, wo_id, station, visit, state, tuple_id, data) values ($1,$2,$3,$4,1,'running',$5,$6::jsonb)`, [o, attemptId, woId, station, `tup-rl-${agent}-${live}`, JSON.stringify(attemptData)]);
    await q(`insert into runs (org_id, id, attempt_id, wo_id, model_id, data) values ($1,$2,$3,$4,'claude-opus-5-5','{"adapter":"stub"}')`, [o, runId, attemptId, woId]);
    const ctx = await loadRunCtx(t.db.admin, o, runId);
    const spec = await composeRunSpec(t.db.admin, ctx!, "http://127.0.0.1:1");
    if ("error" in spec) throw new Error(spec.error);
    return spec;
  }

  it("an agent edit sets limits, a new version carries them, and the run is served the version's limits (never the draft)", async () => {
    expect((await specFor("ag-build", "build")).limits).toMatchObject({ turns: 40, wallClockSeconds: 3600 });
    const r = await save("ag-build", { limits: { turns: 90, wallClockSeconds: 7200, costUsd: 4.5 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ag = (await w.call(ADMIN, "GET", "/api/v1/agents")).body.find((a: any) => a.id === "ag-build");
    expect(ag.limits).toEqual({ turns: 90, wallClockSeconds: 7200, costUsd: 4.5 });
    // audited on the agent edit: what it was and what it is now
    const edit = (await w.events("agent.edit")).at(-1)!;
    expect(edit.after.limits).toEqual({ turns: 90, wallClockSeconds: 7200, costUsd: 4.5 });
    expect(edit.before.limits).toEqual({});
    // not yet a version: the floor still runs with the defaults
    expect((await specFor("ag-build", "build")).limits).toMatchObject({ turns: 40, wallClockSeconds: 3600 });
    // a new version snapshots it
    const cut = await w.call(ADMIN, "POST", "/api/v1/agents/ag-build/versions", { label: "9.0.0", note: "limits" }, { "if-match": await rev("ag-build") });
    expect(cut.status, JSON.stringify(cut.body)).toBe(200);
    const body = (await q(`select body from agent_versions where agent_id = 'ag-build' order by version desc limit 1`))[0].body;
    expect(body.limits).toEqual({ turns: 90, wallClockSeconds: 7200, costUsd: 4.5 });
    expect(body.diff).toMatch(/limits/);
    // the floor moves by the ordinary promote path (gated by the eval suite, tested elsewhere); here the version is put on the floor directly
    await q(`update agents set live_version = (select max(version) from agent_versions where agent_id = 'ag-build') where id = 'ag-build'`);
    expect((await specFor("ag-build", "build")).limits).toEqual({ turns: 90, wallClockSeconds: 7200, costUsd: 4.5 });
  });

  it("validates the ranges: turns 1..500, time 60..14400 s, cost from 0.01", async () => {
    for (const bad of [{ turns: 0 }, { turns: 501 }, { turns: 1.5 }, { wallClockSeconds: 59 }, { wallClockSeconds: 14401 }, { costUsd: 0 }, { costUsd: 0.001 }, { costUsd: 100001 }, { hours: 2 }]) {
      const r = await save("ag-build", { limits: bad });
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
    for (const ok of [{ turns: 1 }, { turns: 500, wallClockSeconds: 14400, costUsd: 0.01 }, { wallClockSeconds: 60 }]) expect((await save("ag-build", { limits: ok })).status, JSON.stringify(ok)).toBe(200);
    expect((await save("ag-build", { limits: { turns: 7 } }, NOBODY)).status).toBe(403);
    expect((await save("ag-build", { limits: {} })).status).toBe(200); // cleared: the defaults again
  });

  it("the station override beats the agent per field; the rest is inherited", async () => {
    // the live version of ag-build has turns 90, time 7200, cost 4.5 (first test); the station overrides turns and cost only
    const r = await setStation("flow.stations.build.runLimits", { turns: 120, costUsd: 9 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await specFor("ag-build", "build")).limits).toEqual({ turns: 120, wallClockSeconds: 7200, costUsd: 9 });
    // another station in the same project is not touched
    expect((await specFor("ag-build", "review")).limits).toEqual({ turns: 90, wallClockSeconds: 7200, costUsd: 4.5 });
    // audited as a project config change with the new value
    const ev = (await w.events("project.config")).at(-1)!;
    expect(JSON.stringify(ev)).toContain("runLimits");
    // a field cleared falls back to the agent
    expect((await setStation("flow.stations.build.runLimits", { turns: null })).status).toBe(200);
    expect((await specFor("ag-build", "build")).limits).toEqual({ turns: 90, wallClockSeconds: 7200, costUsd: 9 });
    // out of range and unknown stations are refused; a person without the flow right is refused
    expect((await setStation("flow.stations.build.runLimits", { turns: 501 })).status).toBe(422);
    expect((await setStation("flow.stations.build.runLimits", { minutes: 5 })).status).toBe(422);
    expect((await setStation("flow.stations.nope.runLimits", { turns: 5 })).status).toBeGreaterThanOrEqual(400);
    expect((await setStation("flow.stations.build.runLimits", { turns: 5 }, NOBODY)).status).toBe(403);
    expect((await setStation("flow.stations.build.runLimits", { costUsd: null })).status).toBe(200);
    expect((await q(`select f.doc->'stations'->'build'->'runLimits' as r from flow_versions f join projects p on p.id = f.project_id and p.current_flow_version = f.version where p.id = 'payments'`))[0].r).toBeNull();
  });

  it("a run that reached its cost limit (the budget halt) is lifted by a one-off cost raise that applies to the next attempt only", async () => {
    const id = await w.atStation("research", "Hits the cost limit");
    const base = `/api/v1/work-orders/${id}`;
    await q(`insert into stops (org_id, id, scope_type, wo_id, mode, reason, cause, set_by) values ($1,$2,'wo',$3,'halt','Budget reached: the run has spent $2.00 of $2.00 (the run cost limit).','budget','system')`, [t.orgId, `wo:${id}:1`, id]);
    expect((await w.call(ADMIN, "POST", `${base}/retry-with-limits`, { limits: { turns: 80 } })).status).toBe(422); // the cost is what stopped it
    expect((await w.call(NOBODY, "POST", `${base}/retry-with-limits`, { limits: { costUsd: 6 } })).status).toBe(403);
    const ok = await w.call(ADMIN, "POST", `${base}/retry-with-limits`, { limits: { costUsd: 6 }, reason: "Needs one more pass" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await q(`select lifted_at from stops where wo_id = $1`, [id]))[0].lifted_at).not.toBeNull();
    expect((await q(`select data from work_orders where id = $1`, [id]))[0].data.limitRaise).toMatchObject({ limits: { costUsd: 6 }, stoppedOn: "cost" });
    expect((await w.events("wo.limit.raise")).at(-1)!.after).toMatchObject({ limits: { costUsd: 6 }, stoppedOn: "cost" });
  });

  it("a run that stops on a limit says which one and the numbers; Retry with a higher limit raises the next attempt only", async () => {
    const id = await w.atStation("research", "Hits the turn limit");
    const base = `/api/v1/work-orders/${id}`;
    const att = (await w.liveAttempt(id))!;
    await q(`insert into runs (org_id, id, attempt_id, wo_id, data) values ($1,$2,$3,$4,'{"limits":{"turns":40,"wallClockSeconds":3600}}')`, [t.orgId, `run-${att.id}`, att.id, id]);
    const f = await w.apply(att, { status: "failed", error: { code: "max_turns", msg: "turn limit 40 reached" } });
    expect(f.applied).toBe(true);
    const wo = await w.get(id);
    expect(wo.state).toBe("failed");
    expect(wo.failReason).toBe("Stopped at the turn limit: used 40 of 40 turns.");
    expect(wo.limitStop).toMatchObject({ limit: "turns", used: 40, max: 40, station: "research" });
    // time: the watchdog's own code is read the same way
    const idT = await w.atStation("research", "Hits the clock");
    const attT = (await w.liveAttempt(idT))!;
    await q(`insert into runs (org_id, id, attempt_id, wo_id, data) values ($1,$2,$3,$4,'{"limits":{"turns":40,"wallClockSeconds":1800}}')`, [t.orgId, `run-${attT.id}`, attT.id, idT]);
    await w.apply(attT, { status: "failed", error: { code: "wall_clock_exceeded", msg: "The run exceeded its wall-clock limit of 1800 seconds and was stopped." } });
    expect((await w.get(idT)).failReason).toBe("Stopped at the time limit: used 30 of 30 minutes.");

    // the retry needs the right to change limits, a number above the one that stopped it, and something to raise
    expect((await w.call(NOBODY, "POST", `${base}/retry-with-limits`, { limits: { turns: 80 } })).status).toBe(403);
    expect((await w.call(ADMIN, "POST", `${base}/retry-with-limits`, { limits: { turns: 40 } })).status).toBe(422);
    expect((await w.call(ADMIN, "POST", `${base}/retry-with-limits`, { limits: { turns: 501 } })).status).toBe(422);
    expect((await w.call(ADMIN, "POST", `${base}/retry-with-limits`, { limits: {} })).status).toBe(422);
    const agentOf = async (attemptId: string) => JSON.stringify((await q(`select data from agents where id = (select agent_id from agent_version_tuples where id = (select tuple_id from attempts where id = $1))`, [attemptId]))[0]?.data ?? null);
    const agentBefore = await agentOf(att.id);
    const flowBefore = (await q(`select current_flow_version from projects where id = 'payments'`))[0].current_flow_version;
    const ok = await w.call(ADMIN, "POST", `${base}/retry-with-limits`, { limits: { turns: 80 }, reason: "Large refactor needs more turns" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await w.get(id)).state).toBe("running");
    // recorded on the attempt, and neither the agent nor the project changed
    const a2 = (await w.liveAttempt(id))!;
    expect(a2.id).not.toBe(att.id);
    const row = (await q(`select data from attempts where id = $1`, [a2.id]))[0].data;
    expect(row.limitRaise).toMatchObject({ limits: { turns: 80 }, station: "research", reason: "Large refactor needs more turns", stoppedOn: "turns" });
    expect(await agentOf(att.id)).toBe(agentBefore);
    expect((await q(`select current_flow_version from projects where id = 'payments'`))[0].current_flow_version).toBe(flowBefore);
    // the audit says who, why and the numbers
    const raised = (await w.events("wo.limit.raise")).at(-1)!;
    expect(raised.after).toMatchObject({ limits: { turns: 80 }, oneOff: true, reason: "Large refactor needs more turns", stoppedOn: "turns" });
    expect(raised.before).toMatchObject({ turns: 40 });
    expect(raised.wo_id).toBe(id);
    // the next attempt's run is bound by 80 turns ...
    const ctx = { orgId: t.orgId, projectId: "payments", station: "research", attemptData: row };
    expect((await loadRunLimits(t.db.admin, ctx, { body: {}, data: {} })).turns).toBe(80);
    // ... and only that attempt: fail it, retry plainly, and the new attempt carries no raise
    await w.apply(a2, { status: "failed", error: { code: "tests", msg: "Failed for another reason." } });
    expect((await w.call(ADMIN, "POST", `${base}/retry`, {})).status).toBe(200);
    const a3 = (await w.liveAttempt(id))!;
    expect((await q(`select data from attempts where id = $1`, [a3.id]))[0].data.limitRaise).toBeUndefined();
    expect((await q(`select data from work_orders where id = $1`, [id]))[0].data.limitRaise).toBeUndefined();
  });

  /** The work order's live attempt fails and the run it had is on record with the limits it was dispatched with. */
  async function failWith(id: string, error: { code: string; msg: string }, limits = '{"limits":{"turns":40,"wallClockSeconds":3600}}') {
    const att = (await w.liveAttempt(id))!;
    await q(`insert into runs (org_id, id, attempt_id, wo_id, data) values ($1,$2,$3,$4,$5::jsonb)`, [t.orgId, `run-${att.id}`, att.id, id, limits]);
    await w.apply(att, { status: "failed", error });
    return att;
  }
  const retryWith = (id: string, limits: object, who = ADMIN) => w.call(who, "POST", `/api/v1/work-orders/${id}/retry-with-limits`, { limits });
  const raiseOnWo = async (id: string) => (await q(`select data->'limitRaise' as r from work_orders where id = $1`, [id]))[0].r;
  const runCapHalt = (id: string, n = 1) => q(`insert into stops (org_id, id, scope_type, wo_id, mode, reason, cause, set_by) values ($1,$2,'wo',$3,'halt','Budget reached: the run has spent $2.00 of $2.00 (the run cost limit).','budget','system')`, [t.orgId, `wo:${id}:${n}`, id]);

  it("G-R1: a raise never lowers any field, whether or not a limit stopped the run", async () => {
    const id = await w.atStation("research", "lower");
    await failWith(id, { code: "tests", msg: "boom" });
    const r = await retryWith(id, { turns: 5, wallClockSeconds: 60 });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(JSON.stringify(r.body)).toMatch(/can only raise|down from/);
    expect((await w.get(id)).state).toBe("failed");
    expect((await retryWith(id, { turns: 40 })).status).toBe(422); // equal to what applies: nothing is higher
    // one limit stopped it: raising that one does not license lowering another
    const id2 = await w.atStation("research", "lower2");
    await failWith(id2, { code: "max_turns", msg: "turn limit 40 reached" });
    const r2 = await retryWith(id2, { turns: 80, wallClockSeconds: 60 });
    expect(r2.status, JSON.stringify(r2.body)).toBe(422);
    expect(await q(`select 1 from attempts where wo_id = $1 and data ? 'limitRaise'`, [id2])).toHaveLength(0);
    // a higher value in every field it names is fine
    expect((await retryWith(id2, { turns: 80, wallClockSeconds: 7200 })).status).toBe(200);
  });

  it("G-R2: a cost raise keeps the halt while the work order is still over its own cap, and says so", async () => {
    const id = await w.atStation("research", "cost over wo cap");
    const att = (await w.liveAttempt(id))!;
    await q(`insert into runs (org_id, id, attempt_id, wo_id, data) values ($1,$2,$3,$4,'{}')`, [t.orgId, `run-${att.id}`, att.id, id]);
    await q(`insert into run_usage (org_id, run_id, attempt_id, wo_id, model_id, cost_micros) values ($1,$2,$3,$4,'m',3000000)`, [t.orgId, `run-${att.id}`, att.id, id]);
    await q(`update work_orders set data = data || '{"budgetUsd":2}'::jsonb where id = $1`, [id]);
    await runCapHalt(id);
    const r = await retryWith(id, { costUsd: 60 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.running).toBe(false);
    expect(r.body.msg).toMatch(/stays halted/);
    expect(r.body.msg).not.toMatch(/running again/);
    expect((await q(`select lifted_at from stops where wo_id = $1`, [id]))[0].lifted_at).toBeNull();
  });

  it("a raise beside an active kill does not claim the work order is running", async () => {
    const id = await w.atStation("research", "kill and run cap");
    await runCapHalt(id);
    await q(`insert into stops (org_id, id, scope_type, wo_id, mode, reason, cause, set_by) values ($1,$2,'wo',$3,'kill','manual kill','manual','p-asha')`, [t.orgId, `wo:${id}:2`, id]);
    const r = await retryWith(id, { costUsd: 60 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.running).toBe(false);
    expect(r.body.msg).toMatch(/stays stopped/);
    expect(r.body.msg).not.toMatch(/running again/);
    expect((await q(`select lifted_at from stops where id = $1`, [`wo:${id}:2`]))[0].lifted_at).toBeNull();
  });

  it("G-R3: a pending raise is dropped by a send-back, never lands on a later attempt, and a merge retry refuses a raise", async () => {
    const id = await w.atStation("research", "stale raise");
    await runCapHalt(id);
    const ok = await retryWith(id, { costUsd: 60 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await raiseOnWo(id)).toMatchObject({ station: "research", limits: { costUsd: 60 } });
    expect((await w.events("wo.limit.raise")).at(-1)!.after).toMatchObject({ boundTo: { station: "research", nextAttemptOnly: true } });
    expect((await w.call(ADMIN, "POST", `/api/v1/work-orders/${id}/send-back`, { toStation: "intake", note: "redo" })).status).toBe(200);
    expect(await raiseOnWo(id)).toBeNull();
    await q(`update work_orders set position = 'research', state = 'failed' where id = $1`, [id]);
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/retry`, {})).status).toBe(200);
    const a = (await w.liveAttempt(id))!;
    expect((await q(`select data->'limitRaise' as r from attempts where id = $1`, [a.id]))[0].r).toBeNull();
    // a raise is bound to its own station: entering another one drops it
    const id2 = await w.atStation("research", "other station");
    await q(`update work_orders set data = data || '{"limitRaise":{"station":"build","limits":{"turns":90}}}'::jsonb where id = $1`, [id2]);
    await w.call(ADMIN, "POST", `/api/v1/work-orders/${id2}/send-back`, { toStation: "research", note: "again" });
    expect((await q(`select data->'limitRaise' as r from attempts where wo_id = $1 order by created_at desc limit 1`, [id2]))[0].r).toBeNull();
    // a merge retry starts no run: it refuses the raise rather than answering 200 and dropping it
    const id3 = await w.atStation("research", "merge bay");
    await q(`update work_orders set position = 'person', state = 'parked', data = data || '{"bayCause":"merge","bayFrom":"review","bayReason":"merge blocked","bayAt":1}'::jsonb where id = $1`, [id3]);
    const m = await retryWith(id3, { turns: 90 });
    expect(m.status, JSON.stringify(m.body)).toBe(422);
    expect(JSON.stringify(m.body)).toMatch(/no agent run/);
  });

  it("G-R4: a run's limits are frozen at dispatch; a later station edit changes neither the spec nor the meter's cap", async () => {
    const id = await w.atStation("research", "mid-run");
    const att = (await w.liveAttempt(id))!;
    const run = `run-${att.id}`;
    await q(`insert into runs (org_id, id, attempt_id, wo_id, model_id, data) values ($1,$2,$3,$4,'claude-opus-5-5',$5::jsonb)`, [t.orgId, run, att.id, id, JSON.stringify({ adapter: "stub", wallClockSeconds: 3600, limits: { turns: 40, wallClockSeconds: 3600, costUsd: 2 } })]);
    const ctx = async () => (await loadRunCtx(t.db.admin, t.orgId, run))!;
    const before: any = await composeRunSpec(t.db.admin, await ctx(), "http://127.0.0.1:1");
    expect(before.limits).toEqual({ turns: 40, wallClockSeconds: 3600, costUsd: 2 });
    expect((await loadLimits(t.db.admin, await ctx())).runMicros).toBe(2_000_000);
    const e = await setStation("flow.stations.research.runLimits", { turns: 200, wallClockSeconds: 14400, costUsd: 50 });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    const after: any = await composeRunSpec(t.db.admin, await ctx(), "http://127.0.0.1:1");
    expect(after.limits).toEqual({ turns: 40, wallClockSeconds: 3600, costUsd: 2 });
    expect((await loadLimits(t.db.admin, await ctx())).runMicros).toBe(2_000_000);
    await setStation("flow.stations.research.runLimits", { turns: null, wallClockSeconds: null, costUsd: null });
  });

  it("G-R5: the agent read carries the limits of the version on the floor next to the working copy's", async () => {
    await save("ag-research", { limits: { turns: 77 } });
    const ag = (await w.call(ADMIN, "GET", "/api/v1/agents")).body.find((a: any) => a.id === "ag-research");
    expect(ag.limits).toEqual({ turns: 77 });
    expect(ag.liveLimits).toEqual({});
    // the floor version's own per-run budget, not the working copy's
    await save("ag-research", { budget: 31 });
    const ag2 = (await w.call(ADMIN, "GET", "/api/v1/agents")).body.find((a: any) => a.id === "ag-research");
    expect(ag2.budget).toBe(31);
    const floor = (await q(`select v.body->>'budget' as b from agents a join agent_versions v on v.agent_id = a.id and v.version = a.live_version where a.id = 'ag-research'`))[0].b;
    expect(ag2.liveBudget).toBe(floor === null ? 31 : Number(floor));
    if (floor !== null) expect(ag2.liveBudget).not.toBe(31);
  });
});
