import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_URL } from "./db.js";
import { startWorld, type World } from "./world.js";

const d = TEST_URL ? describe : describe.skip;
const HEAD = "d".repeat(40);

d("merge.request (F4)", () => {
  let w: World;
  beforeEach(async () => { w = await startWorld(); });
  afterEach(async () => { await w.close(); });

  /** A work order waiting on the merge gate with its pull request open, as the flow engine leaves it after G5 is approved. */
  async function waitingOnMerge(id: string, pr = 7) {
    await w.q(`update repos set github_full_name = 'acme/payments-api' where org_id = $1 and id = 'payments-api'`, [w.orgId]);
    await w.q(
      `insert into work_orders (org_id, id, project_id, repo_id, title, class, priority, position, state, flow_version, submitter, risk, sla_due_at, data)
       values ($1,$2,'payments','payments-api','Merge me','feature','P2','review','waiting',(select current_flow_version from projects where org_id = $1 and id = 'payments'),'p-tomas','normal', now() + interval '3 days', $3::jsonb)`,
      [w.orgId, id, JSON.stringify({ history: [], log: [], merging: { prNumber: pr, headSha: HEAD, at: Date.now() } })],
    );
    await w.q(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, state, head_sha) values ($1,$2,'payments-api',$3,$4,'x','open',$5)`, [w.orgId, `pr-${id}`, id, pr, HEAD]);
    w.broker.prs.set(pr, { number: pr, state: "open", head: HEAD, draft: false, mergeSha: null });
    await w.enqueue("merge.request", { woId: id, prNumber: pr, headSha: HEAD }, { dedupeKey: `merge:${id}:${pr}:${HEAD}` });
  }

  it("merges once at the approved commit and records the merge", async () => {
    await waitingOnMerge("WO-9201");
    await w.drain();
    expect(w.broker.merges).toEqual([{ number: 7, sha: HEAD }]);
    expect(w.broker.calls.find((c) => c.op === "merge")!.body).toMatchObject({ woId: "WO-9201", repo: "acme/payments-api", number: 7, headSha: HEAD, method: "squash" });
    const wo = (await w.q(`select data, position from work_orders where id = 'WO-9201'`))[0];
    expect(wo.data.merging).toBeUndefined();
    expect(wo.position).not.toBe("review");
    expect((await w.q(`select type from events where wo_id = 'WO-9201' and type like 'github.merge.%' order by seq`)).map((e) => e.type)).toEqual(["github.merge.requested", "github.merge.completed"]);
  });

  it("F4: a crash between the merge call and the commit still results in exactly one merge", async () => {
    await waitingOnMerge("WO-9202");
    // GitHub merges, then the connection dies before the worker sees the answer or commits anything.
    w.broker.dropAfterMerge = 1;
    await w.drain();
    expect(w.broker.merges).toHaveLength(1);
    expect((await w.q(`select data from work_orders where id = 'WO-9202'`))[0].data.merging).toBeDefined();
    expect((await w.jobs("merge.request"))[0]!.status).toBe("queued");
    // The retry looks at GitHub first, finds the pull request merged and only records it.
    await w.drain(2);
    expect(w.broker.merges).toHaveLength(1);
    expect(w.broker.count("merge")).toBe(1);
    expect((await w.q(`select data from work_orders where id = 'WO-9202'`))[0].data.merging).toBeUndefined();
    expect((await w.q(`select count(*)::int as n from events where wo_id = 'WO-9202' and type = 'github.merge.requested'`))[0].n).toBe(1);
    expect((await w.q(`select count(*)::int as n from events where wo_id = 'WO-9202' and type = 'github.merge.completed'`))[0].n).toBe(1);
  });

  it("a head that moved after approval is not merged; the gate reopens on the new head", async () => {
    await waitingOnMerge("WO-9203");
    w.broker.prs.get(7)!.head = "e".repeat(40);
    await w.drain();
    expect(w.broker.merges).toHaveLength(0);
    expect(w.broker.count("merge")).toBe(0);
    expect((await w.jobs("merge.request"))[0]!.result.headSha).toBe("e".repeat(40));
  });

  it("does not merge in a stopped scope", async () => {
    await waitingOnMerge("WO-9204");
    await w.q(`insert into stops (org_id, id, scope_type, project_id, mode, reason, set_by) values ($1,'project:payments:1','project','payments','halt','x','p-asha')`, [w.orgId]);
    await w.drain();
    expect(w.broker.count("pull-state")).toBe(0);
    expect(w.broker.merges).toHaveLength(0);
  });

  it("a merge GitHub refuses for its own rules is retried, then raises an alert instead of failing the work order", async () => {
    await waitingOnMerge("WO-9205");
    w.broker.mergeResponse = { status: 409, body: { ok: false, code: "not_mergeable", msg: "Required status check is expected" } };
    await w.q(`update jobs set max_attempts = 3 where kind = 'merge.request'`);
    await w.drain(4);
    expect(w.broker.count("merge")).toBe(3);
    expect((await w.jobs("merge.request"))[0]!.status).toBe("done");
    expect((await w.q(`select outcome from events where type = 'github.merge.blocked'`))[0].outcome).toBe("failed");
    expect((await w.q(`select data from work_orders where id = 'WO-9205'`))[0].data.merging).toBeDefined();
  });

  // ---- Lifecycle gap 1 (statechart model: FailedMergeShowsAWayForward): a merge that cannot happen must not leave the order "merging" forever.
  const wo = async (id: string) => (await w.q(`select state, position, data from work_orders where id = $1`, [id]))[0];

  it("gap 1: a pull request closed without merging sends the order to Needs a person with the reason", async () => {
    await waitingOnMerge("WO-9206");
    await w.q(`update pull_requests set state = 'closed' where wo_id = 'WO-9206'`);
    await w.drain();
    expect(w.broker.count("merge")).toBe(0);
    const r = await wo("WO-9206");
    expect(r).toMatchObject({ state: "parked", position: "person" });
    expect(r.data.bayCause).toBe("merge");
    expect(r.data.bayReason).toMatch(/closed without merging/i);
    expect(r.data.merging).toMatchObject({ prNumber: 7, headSha: HEAD });
  });

  it("gap 1: GitHub reporting the pull request closed does the same", async () => {
    await waitingOnMerge("WO-9207");
    w.broker.prs.get(7)!.state = "closed";
    await w.drain();
    expect(w.broker.count("merge")).toBe(0);
    expect(await wo("WO-9207")).toMatchObject({ state: "parked", position: "person" });
  });

  it("gap 1: a merge still blocked after its final retry sends the order to Needs a person", async () => {
    await waitingOnMerge("WO-9208");
    w.broker.mergeResponse = { status: 409, body: { ok: false, code: "not_mergeable", msg: "Required status check is expected" } };
    await w.q(`update jobs set max_attempts = 2 where kind = 'merge.request'`);
    await w.drain(3);
    const r = await wo("WO-9208");
    expect(r).toMatchObject({ state: "parked", position: "person" });
    expect(r.data.bayCause).toBe("merge");
    expect(r.data.bayReason).toContain("Required status check is expected");
  });

  it("gap 1: a stop covering the order when the merge job runs defers the merge until the stop is lifted", async () => {
    await waitingOnMerge("WO-9209");
    await w.q(`insert into stops (org_id, id, scope_type, project_id, mode, reason, set_by) values ($1,'project:payments:9','project','payments','halt','x','p-asha')`, [w.orgId]);
    await w.drain();
    expect(w.broker.merges).toHaveLength(0);
    expect((await wo("WO-9209")).data.merging).toBeDefined();
    // Resume: the stop is lifted and reconciled. The order is still waiting on the approved merge, so the merge is requested again.
    await w.q(`update stops set lifted_at = now(), lifted_by = 'p-asha', version = version + 1 where id = 'project:payments:9'`);
    await w.enqueue("stop.enforce", { stopId: "project:payments:9", scope: "project", targetId: "payments", mode: "halt" }, { dedupeKey: "stop.enforce:project:payments:9:lift" });
    await w.drain();
    expect(w.broker.merges).toEqual([{ number: 7, sha: HEAD }]);
    expect((await wo("WO-9209")).data.merging).toBeUndefined();
  });

  // Item 12: a merge deferred by a stop of any scope is requested again for the approved head when the stop is lifted.
  const SCOPES = [
    { scope: "wo", col: "wo_id", val: "WO-9220" },
    { scope: "project", col: "project_id", val: "payments" },
    { scope: "repo", col: "repo_id", val: "payments-api" },
    { scope: "factory", col: null, val: null },
  ] as const;
  for (const sc of SCOPES) {
    for (const mode of ["halt", "kill"] as const) {
      it(`item 12: a ${mode} at ${sc.scope} scope, then ${mode === "halt" ? "resume" : "restore"}, still merges the approved head once`, async () => {
        await waitingOnMerge("WO-9220");
        const id = `${sc.scope}:${sc.val ?? ""}:1`;
        const cols = ["org_id", "id", "scope_type", ...(sc.col ? [sc.col] : []), "mode", "reason", "set_by", "in_flight"];
        const vals = [w.orgId, id, sc.scope, ...(sc.val ? [sc.val] : []), mode, "test", "p-asha", mode === "kill" ? "cancel" : null];
        await w.q(`insert into stops (${cols.join(",")}) values (${vals.map((_, i) => `$${i + 1}`).join(",")})`, vals);
        // The stop is committed before the merge job gets to run: the job skips (or the stop handler cancels it).
        await w.enqueue("stop.enforce", { stopId: id, scope: sc.scope, targetId: sc.val, mode }, { dedupeKey: `stop.enforce:${id}` });
        await w.drain();
        expect(w.broker.merges).toHaveLength(0);
        expect((await wo("WO-9220")).data.merging).toBeDefined();
        await w.q(`update stops set lifted_at = now(), lifted_by = 'p-asha', version = version + 1 where id = $1`, [id]);
        await w.enqueue("stop.enforce", { stopId: id, scope: sc.scope, targetId: sc.val, mode }, { dedupeKey: `stop.enforce:${id}:lift` });
        await w.drain();
        expect(w.broker.merges, "the approved merge was never requested again").toEqual([{ number: 7, sha: HEAD }]);
        const r = await wo("WO-9220");
        expect(r.data.merging).toBeUndefined();
        expect(r.state).not.toBe("killed");
      });
    }
  }
});
