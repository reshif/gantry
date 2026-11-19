import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

d("sc7 work order lifecycle edges", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp(); });
  afterAll(() => t.close());
  const w = world(() => t);
  const order = async () => ((await w.call("p-asha", "GET", "/api/v1/catalog")).body.stations as Array<{ id: string }>).map((s) => s.id);
  const atG5 = async (title: string) => {
    const sub = await w.submit("p-tomas", { title });
    const id = sub.body.id as string;
    await w.answerAll(id);
    expect((await w.confirm(id)).status).toBe(200);
    const o = await order();
    await w.walk(id, (x) => o[x.station] === "review" && x.state === "waiting" && x.allowed.approve?.gate === "G5");
    return id;
  };
  const approveG5 = async (id: string) => {
    for (const who of w.APPROVERS) {
      const r = await w.call(who, "POST", await w.gateUrl(id, "G5"), {});
      if (r.status === 200 && r.body.passed) return r;
    }
    throw new Error("G5 not passed");
  };

  it("E1: a person declines an approved order while its merge waits on retries; the merge then happens and brings the order back from Declined", async () => {
    const id = await atG5("Declined while merging");
    const H = "a".repeat(40);
    await t.db.admin.query(`update repos set github_full_name = 'acme/payments-api' where org_id = $1 and id = 'payments-api'`, [t.orgId]);
    await t.db.admin.query(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, state, head_sha) values ($1,'PR-E1','payments-api',$2,810,'x','open',$3)`, [t.orgId, id, H]);
    await approveG5(id);
    expect((await w.q(`select data->'merging' as m from work_orders where id = $1`, [id]))[0].m).toBeTruthy();
    // The merge job has not got through yet (GitHub refuses until a check is green, so the queue retries with backoff). A person declines the work order meanwhile.
    const dec = await w.call("p-asha", "POST", `/api/v1/work-orders/${id}/decline`, { reason: "We no longer want this change" });
    expect(dec.status).toBe(200);
    expect((await w.get(id)).bay).toBe("declined");
    // The worker's merge.request handler runs its retry.
    const { mergeRequest } = await import("../../worker/src/handlers/merge.js");
    const merges: unknown[] = [];
    const broker = {
      pullState: async () => ({ pullRequest: { state: "open", headSha: H, mergeCommitSha: null } }),
      merge: async (a: unknown) => { merges.push(a); return { ok: true, merged: true, mergeSha: "b".repeat(40) }; },
    };
    const job = { id: "j-e1", orgId: t.orgId, kind: "merge.request", payload: { woId: id, prNumber: 810, headSha: H } } as never;
    await mergeRequest(job, { deps: { pool: t.db.app, broker }, last: false } as never);
    const after = await w.get(id);
    expect(merges, "a declined work order's pull request was merged").toHaveLength(0);
    expect(after.bay, "the declined order came back out of Declined").toBe("declined");
    expect((await w.q(`select data->'merging' as m from work_orders where id = $1`, [id]))[0].m, "the approval is gone").toBeNull();
    expect(await w.q(`select 1 from jobs where kind = 'merge.request' and payload->>'woId' = $1 and status = 'queued'`, [id]), "the queued merge job is cancelled").toHaveLength(0);
  });

  it("E1b: the merge handler skips an order a person parked, even if a stale approval is still on it", async () => {
    const id = await atG5("Held while merging");
    const H = "c".repeat(40);
    await t.db.admin.query(`update repos set github_full_name = 'acme/payments-api' where org_id = $1 and id = 'payments-api'`, [t.orgId]);
    await t.db.admin.query(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, state, head_sha) values ($1,'PR-E1B','payments-api',$2,811,'x','open',$3)`, [t.orgId, id, H]);
    await approveG5(id);
    const park = await w.call("p-asha", "POST", `/api/v1/work-orders/${id}/park`, { bay: "hold", reason: "Hold until the audit ends" });
    expect(park.status, JSON.stringify(park.body)).toBe(200);
    expect((await w.q(`select data->'merging' as m from work_orders where id = $1`, [id]))[0].m, "a hold clears the approval").toBeNull();
    // A stale approval left behind (the job was already running when the hold came) is still not merged.
    await t.db.admin.query(`update work_orders set data = jsonb_set(data, '{merging}', $2::jsonb) where id = $1`, [id, JSON.stringify({ prNumber: 811, headSha: H, at: 1 })]);
    const { mergeRequest } = await import("../../worker/src/handlers/merge.js");
    const merges: unknown[] = [];
    const broker = { pullState: async () => ({ pullRequest: { state: "open", headSha: H, mergeCommitSha: null } }), merge: async (a: unknown) => { merges.push(a); return { ok: true, merged: true, mergeSha: "d".repeat(40) }; } };
    const job = { id: "j-e1b", orgId: t.orgId, kind: "merge.request", payload: { woId: id, prNumber: 811, headSha: H } } as never;
    const res = (await mergeRequest(job, { deps: { pool: t.db.app, broker }, last: false } as never)) as { skipped?: string };
    expect(res.skipped).toMatch(/in a bay/);
    expect(merges).toHaveLength(0);
    // and recording a merge never pulls the order out of the bay
    const { recordMerged } = await import("../src/areas/workorders/station.js");
    expect((await w.tx((tx) => recordMerged(tx, t.orgId, id, { prNumber: 811, mergeSha: "d".repeat(40) }))).applied).toBe(false);
    expect((await w.get(id)).bay).toBe("hold");
  });

  it("E2: a priority a person asked for at submit is replaced by the class default when a lead reclassifies at Intake", async () => {
    const classes = ((await w.call("p-asha", "GET", "/api/v1/projects/payments")).body.flow?.classes ?? (await w.call("p-asha", "GET", "/api/v1/catalog")).body.classes ?? []) as Array<{ id: string; priority?: string }>;
    const sub = await w.submit("p-tomas", { title: "Urgent priority kept", priority: "P0", requestedCls: "feature" });
    const id = sub.body.id as string;
    const before = (await w.q(`select class, priority from work_orders where id = $1`, [id]))[0];
    const cls = (classes.find((c) => c.id !== before.class && c.priority && c.priority !== "P0") ?? classes.find((c) => c.id !== before.class))!.id;
    const r = await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/reclassify`, { cls, reason: "This is really a different class" });
    const after = (await w.q(`select class, priority from work_orders where id = $1`, [id]))[0];
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(after.priority, "the P0 the requester set is kept across a reclassify").toBe("P0");
  });
});
