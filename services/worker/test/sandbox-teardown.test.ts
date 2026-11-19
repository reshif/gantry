/** Sandbox review S-94, S-95 and S-96: the order of teardown steps (replays of replay.watchdog-token and replay.kill-start-race, now with the fix). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_URL } from "./db.js";
import { startWorld, type World } from "./world.js";

const d = TEST_URL ? describe : describe.skip;

d("sandbox teardown order", () => {
  let w: World;
  beforeEach(async () => { w = await startWorld(); });
  afterEach(async () => { await w.close(); });

  it("S-94: a run past its wall clock loses its token even while the launcher cannot stop it, and is stopped once it can", async () => {
    const a = await w.workOrderAt("WO-9301", { station: "research", repo: null });
    await w.drain();
    await w.q(`update runs set started_at = now() - interval '2 hours', data = data || '{"wallClockSeconds": 60}'::jsonb where id = $1`, [a.runId]);
    w.launcher.stopFailures = 3;
    expect(await w.worker.scheduler.watchdog()).toEqual([]);
    const tok = await w.q(`select revoked_at is not null as revoked from run_tokens where run_id = $1`, [a.runId]);
    expect(tok.length).toBeGreaterThan(0);
    expect(tok.every((t) => t.revoked === true)).toBe(true);
    // the run is still starting/running, so the next pass retries the stop
    expect((await w.q(`select state from runs where id = $1`, [a.runId]))[0].state).not.toBe("stopped");
    w.launcher.stopFailures = 0;
    expect(await w.worker.scheduler.watchdog()).toEqual([a.runId]);
    expect((await w.q(`select state from runs where id = $1`, [a.runId]))[0].state).toBe("stopped");
  });

  it("S-95: a kill that lands while the second start is in flight leaves no runner behind", async () => {
    const a = await w.workOrderAt("WO-9302", { station: "research", repo: null, dispatch: false });
    let fired = false;
    w.launcher.onStart = async (b) => {
      if (b.seedComplete === false || fired) return;
      fired = true;
      await w.q(`update run_tokens set revoked_at = now(), revoked_reason = 'kill' where run_id = $1`, [a.runId]);
      await w.q(`update attempts set state = 'cancelled' where id = $1`, [a.attemptId]);
      w.launcher.runs.delete(a.runId);
    };
    await w.enqueue("attempt.dispatch", { woId: "WO-9302", station: "research", attemptId: a.attemptId, fencing: a.fencing }, { dedupeKey: `attempt:${a.attemptId}` });
    await w.drain();
    expect(w.launcher.runs.has(a.runId)).toBe(false); // removed by dispatch itself, not by the next reaper pass
    expect(w.launcher.calls.filter((c) => c.op === "stop" && c.runId === a.runId).length).toBeGreaterThan(0);
    expect((await w.q(`select state from attempts where id = $1`, [a.attemptId]))[0].state).toBe("cancelled");
  });

  it("S-95: a kill committed before the second start is seen by the check just before it, and no runner is started", async () => {
    const a = await w.workOrderAt("WO-9303", { station: "research", repo: null, dispatch: false });
    let seen = 0;
    w.launcher.onStart = async (b) => {
      if (b.seedComplete !== false) { seen++; return; }
      await w.q(`update attempts set state = 'cancelled' where id = $1`, [a.attemptId]); // lands after the first check, before the second start
    };
    await w.enqueue("attempt.dispatch", { woId: "WO-9303", station: "research", attemptId: a.attemptId, fencing: a.fencing }, { dedupeKey: `attempt:${a.attemptId}` });
    await w.drain();
    expect(seen).toBe(0);
    expect(w.launcher.runs.has(a.runId)).toBe(false);
  });

  it("S-96: a start that is deferred leaves no live token behind", async () => {
    w.launcher.capacity = true;
    const a = await w.workOrderAt("WO-9304", { station: "research", repo: null });
    await w.drain(0);
    const toks = await w.q(`select revoked_at is not null as revoked from run_tokens where run_id = $1`, [a.runId]);
    expect(toks.length).toBeGreaterThan(0);
    expect(toks.every((t) => t.revoked === true)).toBe(true);
  });

  it("G-S3: waiting for capacity never fails queued work, however long, and the order says why", async () => {
    w.launcher.capacity = true;
    const a = await w.workOrderAt("WO-9310", { station: "research", repo: null });
    await w.drain(8); // far more waits than the world's deferral budget of 3
    expect((await w.q(`select state from attempts where id = $1`, [a.attemptId]))[0].state).toBe("queued");
    const run = (await w.q(`select data from runs where id = $1`, [a.runId]))[0];
    expect(run.data.dispatchError).toBeUndefined();
    expect(run.data.dispatchWait.label).toBe("Waiting for a run slot (1 queued)");
    expect(run.data.dispatchWait.deferrals).toBeGreaterThan(3);
    // room appears: it starts, and the wait note is gone
    w.launcher.capacity = false;
    await w.drain(1);
    const after = (await w.q(`select data, state from runs where id = $1`, [a.runId]))[0];
    expect(after.data.dispatch.phase).toBe("started");
    expect(after.data.dispatchWait).toBeUndefined();
  });

  it("G-S3: a low host disk reads as 'Waiting: host disk low'", async () => {
    w.launcher.capacity = "host free disk is 3.0 GB, under the 20.0 GB floor";
    const a = await w.workOrderAt("WO-9311", { station: "research", repo: null });
    await w.drain(5);
    const run = (await w.q(`select data from runs where id = $1`, [a.runId]))[0];
    expect(run.data.dispatchWait.label).toBe("Waiting: host disk low");
    expect(run.data.dispatchError).toBeUndefined();
  });

  it("G-S9: the wall clock starts at the runner start, and a run that never started is not killed by the watchdog", async () => {
    w.launcher.capacity = true;
    const a = await w.workOrderAt("WO-9312", { station: "research", repo: null });
    await w.drain(1);
    await w.q(`update runs set started_at = now() - interval '2 hours', data = data || '{"wallClockSeconds": 60}'::jsonb where id = $1`, [a.runId]);
    expect(await w.worker.scheduler.watchdog()).toEqual([]);
    w.launcher.capacity = false;
    await w.drain(1);
    const r = (await w.q(`select now() - started_at < interval '1 minute' as fresh from runs where id = $1`, [a.runId]))[0];
    expect(r.fresh).toBe(true);
  });

  it("G-S4: a kill during the second start with the launcher down at that moment is retried, not left for the reaper", async () => {
    const a = await w.workOrderAt("WO-9313", { station: "research", repo: null, dispatch: false });
    let fired = false;
    w.launcher.onStart = async (b) => {
      if (b.seedComplete === false || fired) return;
      fired = true;
      await w.q(`update attempts set state = 'cancelled' where id = $1`, [a.attemptId]);
      w.launcher.stopFailures = 1; // the launcher fails the first stop
    };
    await w.enqueue("attempt.dispatch", { woId: "WO-9313", station: "research", attemptId: a.attemptId, fencing: a.fencing }, { dedupeKey: `attempt:${a.attemptId}` });
    await w.drain(3);
    expect(w.launcher.runs.has(a.runId)).toBe(false);
  });

  it("R1: a run the launcher stopped for a critically low host disk gets that as its blocker, not a lease timeout, and its workspace is kept for an hour", async () => {
    const a = await w.workOrderAt("WO-9320", { station: "research", repo: null });
    await w.drain();
    w.launcher.criticalStops.push({ runId: a.runId, at: Date.now(), freeBytes: 1e9 });
    await w.enqueue("reaper.sweep", {}, { dedupeKey: "sbx-crit" });
    await w.drain();
    const run = (await w.q(`select state, data from runs where id = $1`, [a.runId]))[0];
    expect(run.state).toBe("stopped");
    expect(run.data.blocker).toMatchObject({ code: "host_disk_critical", label: "Host disk critically low" });
    const att = (await w.q(`select state, outcome from attempts where id = $1`, [a.attemptId]))[0];
    expect(att.state).toBe("failed");
    expect(att.outcome).toBe("failed");
    const wo = (await w.q(`select data::text as d from work_orders where id = 'WO-9320'`))[0];
    expect(wo.d).toMatch(/Host disk critically low/);
    // the workspace survives the sweep that just ran (evidence), unlike an ordinary orphan
    expect(w.launcher.calls.filter((c) => c.op === "stop" && c.runId === a.runId && c.keepWorkspace === "false").length).toBe(0);
  });

  it("R1: an evidence run whose container is still running loses the container, not the workspace", async () => {
    const a = await w.workOrderAt("WO-9321", { station: "research", repo: null });
    await w.drain();
    await w.q(`update runs set state = 'stopped', data = data || '{"blocker":{"code":"host_disk_critical"}}'::jsonb where id = $1`, [a.runId]);
    await w.q(`update attempts set state = 'failed' where id = $1`, [a.attemptId]);
    await w.enqueue("reaper.sweep", {}, { dedupeKey: "sbx-ev" });
    await w.drain();
    const stops = w.launcher.calls.filter((c) => c.op === "stop" && c.runId === a.runId);
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.every((c) => c.keepWorkspace === "true")).toBe(true);
  });
});
