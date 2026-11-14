import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_URL } from "./db.js";
import { startWorld, type World } from "./world.js";

const d = TEST_URL ? describe : describe.skip;
const HEAD = "d".repeat(40);

d("stop.enforce (spec 4.4, 9.7)", () => {
  let w: World;
  beforeEach(async () => { w = await startWorld(); });
  afterEach(async () => { await w.close(); });

  async function running(id: string) {
    const a = await w.workOrderAt(id, { station: "build", github: true });
    await w.q(`insert into repo_config (org_id, repo_id, data) values ($1,'payments-api','{"baseSha":"${"1".repeat(40)}"}') on conflict (org_id, repo_id) do update set data = excluded.data`, [w.orgId]);
    await w.drain();
    expect(w.launcher.runs.get(a.runId)?.state).toBe("started");
    return a;
  }
  const openPr = async (id: string, n: number) => {
    await w.q(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, state, head_sha) values ($1,$2,'payments-api',$3,$4,'x','open',$5)`, [w.orgId, `pr-${id}`, id, n, HEAD]);
    w.broker.prs.set(n, { number: n, state: "open", head: HEAD, draft: false, mergeSha: null });
  };
  const stop = async (id: string, scope: "wo" | "project", target: string, mode: "halt" | "kill", inFlight: string | null = null) => {
    await w.q(`insert into stops (org_id, id, scope_type, ${scope === "wo" ? "wo_id" : "project_id"}, mode, reason, set_by, in_flight) values ($1,$2,$3,$4,$5,'test','p-asha',$6)`, [w.orgId, id, scope, target, mode, inFlight]);
    await w.enqueue("stop.enforce", { stopId: id, scope, targetId: target, mode }, { dedupeKey: `stop.enforce:${id}` });
  };

  it("kill-cancel: database first, then launcher, then GitHub; merges cancelled; PR failed and drafted", async () => {
    const a = await running("WO-9301");
    await openPr("WO-9301", 5);
    await w.enqueue("merge.request", { woId: "WO-9301", prNumber: 5, headSha: HEAD }, { runAt: new Date(Date.now() + 3600_000) });
    const seen: Record<string, unknown> = {};
    w.launcher.onStop = async (id) => {
      if (id !== a.runId) return;
      // By the time the launcher is asked to terminate, the stop's database side is committed: the token is revoked and the attempt is cancelled.
      seen.revoked = (await w.q(`select count(*)::int as n from run_tokens where run_id = $1 and revoked_at is null`, [a.runId]))[0].n;
      seen.attempt = (await w.q(`select state from attempts where id = $1`, [a.attemptId]))[0].state;
      seen.merge = (await w.q(`select status from jobs where kind = 'merge.request'`))[0].status;
    };
    await stop("wo:WO-9301:1", "wo", "WO-9301", "kill", "cancel");
    await w.drain();
    expect(seen).toEqual({ revoked: 0, attempt: "cancelled", merge: "done" });
    const stopCall = w.launcher.calls.find((c) => c.op === "stop" && c.runId === a.runId)!;
    expect(stopCall.keepWorkspace).toBe("false");
    expect(w.launcher.runs.has(a.runId)).toBe(false);
    const check = w.broker.calls.find((c) => c.op === "check")!;
    expect(check.body).toMatchObject({ woId: "WO-9301", repo: "acme/payments-api", headSha: HEAD, state: "failing" });
    const draft = w.broker.calls.find((c) => c.op === "draft")!;
    expect(draft.body).toMatchObject({ woId: "WO-9301", number: 5 });
    expect(stopCall.at).toBeLessThanOrEqual(check.at);
    expect(check.at).toBeLessThanOrEqual(draft.at);
    expect((await w.q(`select state from work_orders where id = 'WO-9301'`))[0].state).toBe("killed");
    expect((await w.q(`select state from runs where id = $1`, [a.runId]))[0].state).toBe("stopped");
    expect((await w.q(`select result from jobs where kind = 'merge.request'`))[0].result).toEqual({ cancelled: "stop" });
    const ev = (await w.q(`select after from events where type = 'stop.enforced'`))[0].after;
    expect(ev).toMatchObject({ stop: "wo:WO-9301:1", runsStopped: 1, mergesCancelled: 1, checksFailed: 1, draftsConverted: 1 });
  });

  it("kill-hold fails the Gantry check but does not draft; a halt touches GitHub not at all", async () => {
    const a = await running("WO-9302");
    const b = await running("WO-9303");
    await openPr("WO-9302", 6);
    await openPr("WO-9303", 8);
    await stop("wo:WO-9302:1", "wo", "WO-9302", "kill", "hold");
    await stop("wo:WO-9303:1", "wo", "WO-9303", "halt");
    await w.drain();
    expect(w.broker.calls.filter((c) => c.op === "check").map((c) => c.body!.woId)).toEqual(["WO-9302"]);
    expect(w.broker.count("draft")).toBe(0);
    expect(w.launcher.runs.has(a.runId) || w.launcher.runs.has(b.runId)).toBe(false);
  });

  it("a stop at project scope terminates every run in it and no run elsewhere", async () => {
    const a = await running("WO-9304");
    const b = await running("WO-9305");
    await w.q(`update work_orders set project_id = (select id from projects where org_id = $1 and id <> 'payments' limit 1), repo_id = null where id = 'WO-9305'`, [w.orgId]);
    await stop("project:payments:1", "project", "payments", "halt");
    await w.drain();
    expect(w.launcher.runs.has(a.runId)).toBe(false);
    expect(w.launcher.runs.has(b.runId)).toBe(true);
  });

  it("raises 'termination unconfirmed' when a container will not die, retries, and succeeds once it is gone", async () => {
    const a = await running("WO-9306");
    w.launcher.stuck.add(a.runId);
    await stop("wo:WO-9306:1", "wo", "WO-9306", "kill", "cancel");
    await w.drain();
    const alert = (await w.q(`select type, outcome, category, after from events where type = 'run.termination_unconfirmed'`));
    expect(alert).toHaveLength(1);
    expect(alert[0]).toMatchObject({ outcome: "failed", category: "kill" });
    expect((await w.jobs("stop.enforce"))[0]!.status).toBe("queued");
    expect((await w.jobs("stop.enforce"))[0]!.last_error).toMatch(/Termination unconfirmed/);
    w.launcher.stuck.clear();
    await w.drain(2);
    expect((await w.jobs("stop.enforce"))[0]!.status).toBe("done");
    expect(w.launcher.runs.size).toBe(0);
    // The alert is raised once per stop and run, not once per retry.
    expect((await w.q(`select count(*)::int as n from events where type = 'run.termination_unconfirmed'`))[0].n).toBe(1);
  });

  it("a stop whose job was lost is found by the sweep and enforced", async () => {
    const a = await running("WO-9307");
    await w.q(`insert into stops (org_id, id, scope_type, wo_id, mode, reason, set_by, set_at) values ($1,'wo:WO-9307:1','wo','WO-9307','kill','lost job','p-asha', now() - interval '5 minutes')`, [w.orgId]);
    expect(w.launcher.runs.has(a.runId)).toBe(true);
    await w.enqueue("reaper.sweep", {});
    await w.drain();
    expect(w.launcher.runs.has(a.runId)).toBe(false);
    expect((await w.q(`select enforced_at from stops where id = 'wo:WO-9307:1'`))[0].enforced_at).not.toBeNull();
  });

  it("lifting a halt reconciles only: a fresh attempt is dispatched and no container is touched", async () => {
    const a = await running("WO-9308");
    await stop("wo:WO-9308:1", "wo", "WO-9308", "halt");
    await w.drain();
    expect(w.launcher.runs.size).toBe(0);
    await w.q(`update stops set lifted_at = now(), lifted_by = 'p-asha', version = version + 1 where id = 'wo:WO-9308:1'`);
    await w.enqueue("stop.enforce", { stopId: "wo:WO-9308:1", scope: "wo", targetId: "WO-9308", mode: "halt" }, { dedupeKey: "lift" });
    const stopsBefore = w.launcher.calls.filter((c) => c.op === "stop").length;
    await w.drain();
    expect(w.launcher.calls.filter((c) => c.op === "stop").length).toBe(stopsBefore);
    const attempts = await w.q(`select id, state from attempts where wo_id = 'WO-9308' order by created_at`);
    expect(attempts.length).toBe(2);
    expect(attempts[0].id).toBe(a.attemptId);
    expect(w.launcher.runs.size).toBe(1);
  });
});
