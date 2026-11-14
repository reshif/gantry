import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_URL } from "./db.js";
import { startWorld, type World } from "./world.js";

const d = TEST_URL ? describe : describe.skip;
const SHA = "a".repeat(40);

/** What the edge's /result intake stores: a station_results row and the run.result job. */
async function deliverResult(w: World, a: { attemptId: string; fencing: number; runId: string }, woId: string, station: string, status: "succeeded" | "failed" | "interrupted", output: object = {}, error?: object) {
  await w.q(`insert into station_results (org_id, id, attempt_id, wo_id, station, outcome, summary, body) values ($1,$2,$3,$4,$5,$6,'done',$7::jsonb)`, [
    w.orgId, `sr-${a.runId}`, a.attemptId, woId, station, status, JSON.stringify({ output, usage: [], error: error ?? null, adapter: "stub" }),
  ]);
  await w.enqueue("run.result", { runId: a.runId, attemptId: a.attemptId, fencing: a.fencing }, { dedupeKey: `run.result:${a.runId}` });
}

d("run.result, publish and teardown", () => {
  let w: World;
  beforeEach(async () => { w = await startWorld(); });
  afterEach(async () => { await w.close(); });

  it("applies the result through the flow engine and tears the run down", async () => {
    const a = await w.workOrderAt("WO-9101", { station: "research", repo: null });
    await w.drain();
    expect(w.launcher.runs.has(a.runId)).toBe(true);
    await deliverResult(w, a, "WO-9101", "research", "succeeded", { findings: [] });
    await w.drain();
    expect((await w.q(`select state, outcome from attempts where id = $1`, [a.attemptId]))[0].state).toBe("succeeded");
    expect(w.launcher.runs.has(a.runId)).toBe(false);
    const stop = w.launcher.calls.find((c) => c.op === "stop")!;
    expect(stop.keepWorkspace).toBe("false");
    const run = (await w.q(`select state, ended_at from runs where id = $1`, [a.runId]))[0];
    expect(run.state).toBe("succeeded");
    expect((await w.q(`select revoked_at from run_tokens where run_id = $1`, [a.runId])).every((t) => t.revoked_at)).toBe(true);
    expect((await w.q(`select position from work_orders where id = 'WO-9101'`))[0].position).not.toBe("research");
  });

  it("publishes a Build result's commits before applying it, and the observed head wins over the agent's", async () => {
    const a = await w.workOrderAt("WO-9102", { station: "build", github: true });
    await w.q(`insert into repo_config (org_id, repo_id, data) values ($1,'payments-api','{"baseSha":"${"1".repeat(40)}"}') on conflict (org_id, repo_id) do update set data = excluded.data`, [w.orgId]);
    await w.drain();
    await deliverResult(w, a, "WO-9102", "build", "succeeded", { commits: ["x"], headSha: "f".repeat(40) });
    await w.drain();
    const pub = w.broker.calls.find((c) => c.op === "publish")!;
    expect(pub.body).toMatchObject({ attemptId: a.attemptId, fencing: a.fencing, repo: "acme/payments-api", volume: `ws-${a.runId}`, branch: "gantry/WO-9102" });
    // Publish happens while the workspace still exists, then the launcher removes the volume.
    const stop = w.launcher.calls.filter((c) => c.op === "stop").pop()!;
    expect(pub.at).toBeLessThanOrEqual(stop.at);
    const wo = (await w.q(`select data from work_orders where id = 'WO-9102'`))[0];
    expect(wo.data.outputs.build._labels.systemObserved).toContain("headSha");
    expect((await w.q(`select count(*)::int as n from events where type = 'run.published'`))[0].n).toBe(1);
    expect((await w.q(`select state from attempts where id = $1`, [a.attemptId]))[0].state).toBe("succeeded");
  });

  it("a workspace the broker refuses (non-linear history) fails the station instead of losing the work", async () => {
    const a = await w.workOrderAt("WO-9103", { station: "build", github: true });
    await w.q(`insert into repo_config (org_id, repo_id, data) values ($1,'payments-api','{"baseSha":"${"1".repeat(40)}"}') on conflict (org_id, repo_id) do update set data = excluded.data`, [w.orgId]);
    await w.drain();
    w.broker.publishResponse = { status: 422, body: { ok: false, code: "non_linear", msg: "merge commits are not published" } };
    await deliverResult(w, a, "WO-9103", "build", "succeeded", { commits: ["x"] });
    await w.drain();
    const att = (await w.q(`select state from attempts where id = $1`, [a.attemptId]))[0];
    expect(att.state).toBe("failed");
  });

  it("a broker outage while publishing is retried and nothing is applied until it succeeds", async () => {
    const a = await w.workOrderAt("WO-9104", { station: "build", github: true });
    await w.q(`insert into repo_config (org_id, repo_id, data) values ($1,'payments-api','{"baseSha":"${"1".repeat(40)}"}') on conflict (org_id, repo_id) do update set data = excluded.data`, [w.orgId]);
    await w.drain();
    w.broker.publishResponse = { status: 502, body: { ok: false, code: "github", msg: "GitHub is down" } };
    await deliverResult(w, a, "WO-9104", "build", "succeeded", { commits: ["x"] });
    await w.drain();
    expect((await w.q(`select state from attempts where id = $1`, [a.attemptId]))[0].state).toBe("running");
    expect((await w.jobs("run.result"))[0]!.status).toBe("queued");
    w.broker.publishResponse = null;
    await w.drain(2);
    expect((await w.q(`select state from attempts where id = $1`, [a.attemptId]))[0].state).toBe("succeeded");
    // Publishing is idempotent at the broker, so the retries did not apply anything twice.
    expect((await w.q(`select count(*)::int as n from station_results where attempt_id = $1`, [a.attemptId]))[0].n).toBe(1);
  });

  it("a result from a superseded attempt is rejected (F3) and its run is still torn down", async () => {
    const a = await w.workOrderAt("WO-9105", { station: "research", repo: null });
    await w.drain();
    await w.q(`update attempts set state = 'superseded' where id = $1`, [a.attemptId]);
    await deliverResult(w, a, "WO-9105", "research", "succeeded", {});
    await w.drain();
    expect(w.launcher.runs.has(a.runId)).toBe(false);
    expect((await w.q(`select position from work_orders where id = 'WO-9105'`))[0].position).toBe("research");
    expect((await w.jobs("run.result"))[0]!.result.superseded).toBeTruthy();
  });

  it("F9: a lost heartbeat leads to a bounded retry, then Needs a person", async () => {
    let attemptId = "";
    await w.workOrderAt("WO-9106", { station: "research", repo: null });
    for (let round = 1; round <= 4; round++) {
      await w.drain();
      const live = (await w.q(`select id, fencing::text from attempts where wo_id = 'WO-9106' and state in ('queued','running') order by created_at desc`))[0];
      if (!live) break;
      attemptId = live.id;
      expect((await w.q(`select state from attempts where id = $1`, [attemptId]))[0].state).toBe("running");
      // The runner dies: no heartbeat. The lease lapses and the sweep expires it.
      await w.q(`update attempts set lease_until = now() - interval '1 minute' where id = $1`, [attemptId]);
      await w.enqueue("reaper.sweep", {}, { dedupeKey: `sweep-${round}` });
      await w.drain();
    }
    const attempts = await w.q(`select state, outcome from attempts where wo_id = 'WO-9106' order by created_at`);
    expect(attempts.length).toBe(3);
    expect(attempts.every((x) => x.outcome === "lease_expired")).toBe(true);
    const wo = (await w.q(`select state, position from work_orders where id = 'WO-9106'`))[0];
    expect(wo).toEqual({ state: "parked", position: "person" });
    expect((await w.q(`select count(*)::int as n from events where wo_id = 'WO-9106' and type = 'run.lease_expired'`))[0].n).toBe(3);
  });

  it("the wall-clock watchdog stops a run past its limit and fails the attempt", async () => {
    const a = await w.workOrderAt("WO-9107", { station: "research", repo: null });
    await w.drain();
    await w.q(`update runs set started_at = now() - interval '2 hours', data = data || '{"wallClockSeconds": 60}'::jsonb where id = $1`, [a.runId]);
    expect(await w.worker.scheduler.watchdog()).toEqual([a.runId]);
    expect(w.launcher.runs.has(a.runId)).toBe(false);
    expect((await w.q(`select state, outcome from attempts where id = $1`, [a.attemptId]))[0].state).toBe("failed");
    expect((await w.q(`select state from runs where id = $1`, [a.runId]))[0].state).toBe("stopped");
    expect(await w.worker.scheduler.watchdog()).toEqual([]);
  });
});
