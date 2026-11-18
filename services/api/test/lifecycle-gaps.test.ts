/**
 * Work-order lifecycle gaps found by the TLA+ statechart model (gantry-designs/v3-readiness/statechart). Each test drives the real code along the
 * path the model's counter-example took, one step at a time.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

d("lifecycle gaps", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const order = async () => ((await w.call("p-asha", "GET", "/api/v1/catalog")).body.stations as Array<{ id: string }>).map((s) => s.id);
  /** A work order of `cls` walked to the Review and merge gate (G5), waiting. */
  const atG5 = async (title: string, cls?: string) => {
    const sub = await w.submit("p-tomas", { title });
    const id = sub.body.id as string;
    if (cls) await t.db.admin.query(`update work_orders set class = $2 where id = $1`, [id, cls]);
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

  it("gap 1: a merge that dead-ended waits in Needs a person, and Retry merge asks again for the approved head only", async () => {
    const id = await atG5("Blocked merge");
    await t.db.admin.query(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, state, head_sha) values ($1,'PR-G1','payments-api',$2,601,'x','open','aaaa1111bbbb')`, [t.orgId, id]);
    await approveG5(id);
    const { parkMergeBlocked } = await import("../src/areas/workorders/station.js");
    // What the worker does when the pull request is closed or the merge stays blocked after the last retry.
    expect((await w.tx((tx) => parkMergeBlocked(tx, t.orgId, id, { prNumber: 601, reason: "GitHub still refuses the merge of #601." }))).parked).toBe(true);
    expect((await w.tx((tx) => parkMergeBlocked(tx, t.orgId, id, { prNumber: 601, reason: "again" }))).parked).toBe(false);
    let wo = await w.get(id);
    expect(wo).toMatchObject({ state: "parked", bay: "person", bayCause: "merge", bayReason: "GitHub still refuses the merge of #601." });
    // Retry merge: refused while the pull request is closed, allowed once it is open at the approved head.
    await t.db.admin.query(`update pull_requests set state = 'closed' where id = 'PR-G1'`);
    const closed = await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/retry`, {});
    expect(closed.status).toBe(409);
    expect(String(closed.body.msg)).toMatch(/not open/);
    await t.db.admin.query(`update pull_requests set state = 'open', head_sha = 'moved' where id = 'PR-G1'`);
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/retry`, {})).status).toBe(409);
    await t.db.admin.query(`update pull_requests set head_sha = 'aaaa1111bbbb' where id = 'PR-G1'`);
    const before = (await w.q(`select count(*)::int n from jobs where kind = 'merge.request' and payload->>'woId' = $1`, [id]))[0].n;
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/retry`, {})).status).toBe(200);
    wo = await w.get(id);
    expect(wo).toMatchObject({ state: "waiting" });
    expect(wo.bay).toBeFalsy();
    const jobs = await w.q(`select payload from jobs where kind = 'merge.request' and payload->>'woId' = $1`, [id]);
    expect(jobs.length).toBe(before + 1);
    expect(jobs.at(-1)!.payload).toEqual({ woId: id, prNumber: 601, headSha: "aaaa1111bbbb" });
  });

  it("gap 1: returning a blocked merge to Review drops the old approval", async () => {
    const id = await atG5("Blocked merge returned");
    await t.db.admin.query(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, state, head_sha) values ($1,'PR-G1b','payments-api',$2,602,'x','closed','cccc1111dddd')`, [t.orgId, id]);
    await t.db.admin.query(`update pull_requests set state = 'open' where id = 'PR-G1b'`);
    await approveG5(id);
    const { parkMergeBlocked } = await import("../src/areas/workorders/station.js");
    await w.tx((tx) => parkMergeBlocked(tx, t.orgId, id, { prNumber: 602, reason: "Pull request #602 was closed without merging." }));
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/unpark`, { reason: "Redo the review on a new pull request" })).status).toBe(200);
    expect((await w.q(`select data->'merging' as m from work_orders where id = $1`, [id]))[0].m).toBeNull();
  });

  it("gap 2: approving the merge gate with no open pull request on a GitHub repository is refused; the order keeps waiting at G5", async () => {
    const id = await atG5("No pull request at G5");
    await t.db.admin.query(`update repos set github_full_name = 'acme/payments-api' where org_id = $1 and id = 'payments-api'`, [t.orgId]);
    try {
      // The pull request was closed on GitHub before anyone decided.
      await t.db.admin.query(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, state, head_sha) values ($1,'PR-G2','payments-api',$2,701,'x','closed','eeee1111ffff')`, [t.orgId, id]);
      let refused: { status: number; body: Record<string, any> } | null = null;
      for (const who of w.APPROVERS) {
        const r = await w.call(who, "POST", await w.gateUrl(id, "G5"), {});
        if (r.status === 409) { refused = r; break; }
      }
      expect(refused, "G5 was approved with nothing to merge").not.toBeNull();
      expect(String(refused!.body.msg)).toMatch(/no open pull request/i);
      const wo = await w.get(id);
      expect(wo.state).toBe("waiting");
      expect(wo.allowed.approve?.gate).toBe("G5");
      expect((await w.q(`select count(*)::int n from gate_votes where gate_instance_id like $1`, [`${id}:G5:%`]))[0].n).toBe(0);
    } finally {
      await t.db.admin.query(`update repos set github_full_name = null where org_id = $1 and id = 'payments-api'`, [t.orgId]);
    }
  });

  /** An epic that split into two children, each at Build: the parent waits for them (as the engine leaves it after the split). */
  const epicWithChildren = async (parent: string, kids: string[]) => {
    await w.insertWo(parent, { cls: "epic", position: "plan", state: "waiting", data: { split: true, children: kids, blockReason: `Waiting for ${kids.join(", ")} to finish.` } });
    let ord = 0;
    for (const k of kids) {
      await w.insertWo(k, { position: "build", state: "running" });
      await t.db.admin.query(`update work_orders set parent_id = $2 where id = $1`, [k, parent]);
      await t.db.admin.query(`insert into epic_children (org_id, epic_id, child_id, ord) values ($1,$2,$3,$4)`, [t.orgId, parent, k, ord++]);
    }
  };
  const finishChild = async (id: string) => {
    const { finish, flushFx } = await import("../src/areas/workorders/engine.js");
    const { lockWo } = await import("../src/areas/workorders/model.js");
    await w.tx(async (tx) => {
      const fx = await w.fxIn(tx);
      await finish(fx, await lockWo(tx, t.orgId, id), "p-asha");
      await flushFx(fx);
    });
  };
  const killChild = async (id: string) => {
    expect((await w.call("p-asha", "POST", "/api/v1/stops", { scope: "workorder", id, mode: "kill", reason: "Child no longer wanted" })).status).toBe(200);
    const { reconcileStop } = await import("../src/areas/stops/enforce.js");
    const stop = (await w.q(`select id from stops where wo_id = $1 and lifted_at is null`, [id]))[0].id;
    await w.tx((tx) => reconcileStop(tx, stop));
  };

  it("gap 3: an epic whose last child was killed does not wait for ever: it goes to Needs a person with a summary", async () => {
    await epicWithChildren("WO-9301", ["WO-9302", "WO-9303"]);
    await finishChild("WO-9302");
    expect((await w.get("WO-9301")).state).toBe("waiting"); // one child is still open
    await killChild("WO-9303");
    const p = await w.get("WO-9301");
    expect(p).toMatchObject({ state: "parked", bay: "person" });
    expect(p.bayReason).toMatch(/WO-9302 done/);
    expect(p.bayReason).toMatch(/WO-9303 killed/);
    expect(p.bayReason).not.toMatch(/Waiting for/);
  });

  it("gap 3: an epic whose last open child finishes after a sibling was killed, and one with a declined child, also go to Needs a person", async () => {
    await epicWithChildren("WO-9304", ["WO-9305", "WO-9306"]);
    await killChild("WO-9305");
    expect((await w.get("WO-9304")).state).toBe("waiting");
    await finishChild("WO-9306");
    expect(await w.get("WO-9304")).toMatchObject({ state: "parked", bay: "person" });
    await epicWithChildren("WO-9307", ["WO-9308", "WO-9309"]);
    expect((await w.call("p-asha", "POST", "/api/v1/work-orders/WO-9308/park", { bay: "declined", reason: "Out of scope for this quarter" })).status).toBe(200);
    await finishChild("WO-9309");
    const p = await w.get("WO-9307");
    expect(p).toMatchObject({ state: "parked", bay: "person" });
    expect(p.bayReason).toMatch(/WO-9308 declined/);
  });

  it("gap 3: an epic whose every child is done completes", async () => {
    await epicWithChildren("WO-9310", ["WO-9311", "WO-9312"]);
    await finishChild("WO-9311");
    await finishChild("WO-9312");
    expect((await w.get("WO-9310")).state).toBe("done");
  });
});
