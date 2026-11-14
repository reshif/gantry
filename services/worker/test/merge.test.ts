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
});
