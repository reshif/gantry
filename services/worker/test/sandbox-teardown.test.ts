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
});
