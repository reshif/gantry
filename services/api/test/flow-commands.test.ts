import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world, type M } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

d("work order commands: denied and stale for every one", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const deniedCount = async () => Number((await w.q(`select count(*)::int n from events where outcome = 'denied'`))[0].n);

  /** The caller without the right gets 403 and an audited denial; a stale If-Match gets 409 and changes nothing. */
  const matrix = async (id: string, method: M, url: string, body: unknown, who: { stale: string; denied?: string }) => {
    const v0 = (await w.get(id)).version;
    const before = await deniedCount();
    const dn = await w.call(who.denied ?? "p-rui", method, url, body);
    expect(dn.status, `${url} denied: ${JSON.stringify(dn.body)}`).toBe(403);
    expect(dn.body.ok).toBe(false);
    expect(await deniedCount(), `${url} audit`).toBe(before + 1);
    const st = await w.call(who.stale, method, url, body, w.ifm(v0 + 50));
    expect(st.status, `${url} stale: ${JSON.stringify(st.body)}`).toBe(409);
    expect(String(st.body.msg)).toMatch(/changed|reload/i);
    expect((await w.get(id)).version, `${url} unchanged`).toBe(v0);
  };

  it("intake commands: answer, follow-up, reclassify, confirm, decline", async () => {
    const id = (await w.submit("p-tomas", { title: "Command matrix at intake" })).body.id as string;
    const base = `/api/v1/work-orders/${id}`;
    await matrix(id, "POST", `${base}/messages`, { text: "Yes, keep it small." }, { stale: "p-tomas" });
    await matrix(id, "POST", `${base}/messages`, { text: "Should we also cover chargebacks in the brief?", kind: "followup" }, { stale: "p-tomas" });
    await matrix(id, "POST", `${base}/messages`, { text: "Needs a person to look at the ledger.", kind: "question" }, { stale: "p-meera" });
    const classes = (await w.call("p-asha", "GET", "/api/v1/catalog")).body.classes as Array<{ id: string }>;
    const wo = await w.get(id);
    const other = classes.find((c) => c.id !== wo.cls)!.id;
    await matrix(id, "POST", `${base}/reclassify`, { cls: other, reason: "The request is really something else" }, { stale: "p-meera" });
    await matrix(id, "POST", `${base}/decline`, { reason: "Out of scope for this quarter" }, { stale: "p-meera" });
    await matrix(id, "POST", `${base}/confirm-brief`, {}, { stale: "p-tomas" });
    // validation: short reason, unknown class, same class, an unfinished brief
    expect((await w.call("p-meera", "POST", `${base}/reclassify`, { cls: other, reason: "no" })).status).toBe(422);
    expect((await w.call("p-meera", "POST", `${base}/reclassify`, { cls: "nonsense", reason: "Because I say so" })).status).toBe(422);
    expect((await w.call("p-meera", "POST", `${base}/reclassify`, { cls: wo.cls, reason: "Same class again" })).status).toBe(422);
    expect((await w.confirm(id)).status).toBe(422);
    // reclassify: new class, new route, conversation restarted, audited override
    const rc = await w.call("p-meera", "POST", `${base}/reclassify`, { cls: other, reason: "The request is really something else" });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    const after = await w.get(id);
    expect(after.cls).toBe(other);
    expect(after.clsOverridden).toMatchObject({ by: "p-meera", from: wo.cls });
    expect(after.conv.done).toBe(false);
    expect(after.priority).toBe((await w.call("p-asha", "GET", "/api/v1/catalog")).body.classes.find((c: any) => c.id === other)?.priority ?? after.priority);
    // follow-up questions: added, capped at three, de-duplicated
    for (let i = 0; i < 3; i++) {
      const f = await w.call("p-tomas", "POST", `${base}/messages`, { kind: "followup", text: `Follow-up number ${i + 1}: which clients retry refunds?`, chips: ["a", "b"] });
      expect(f.status, JSON.stringify(f.body)).toBe(200);
    }
    expect((await w.call("p-tomas", "POST", `${base}/messages`, { kind: "followup", text: "A fourth follow-up question here" })).status).toBe(422);
    // answer the whole conversation (including follow-ups), then confirm: brief version 1 recorded, route starts
    const full = await w.answerAll(id);
    expect(full.conv.questions.length).toBeGreaterThan(3);
    expect((await w.confirm(id)).status).toBe(200);
    expect((await w.q(`select version, confirmed_by from brief_versions where wo_id = $1`, [id]))).toEqual([{ version: 1, confirmed_by: "p-tomas" }]);
    expect((await w.liveAttempt(id))?.station).not.toBe("intake");
    expect((await w.q(`select kind, queue, payload from jobs where kind = 'attempt.dispatch' and payload->>'woId' = $1`, [id])).length).toBe(1);
    // class can only change at Intake
    expect((await w.call("p-meera", "POST", `${base}/reclassify`, { cls: wo.cls, reason: "Back to the first class" })).status).toBe(422);
  });

  it("decline moves to Declined; unpark returns to Intake; a question goes to Needs a person and an answer returns it", async () => {
    const id = (await w.submit("p-tomas", { title: "Decline and return" })).body.id as string;
    const base = `/api/v1/work-orders/${id}`;
    const dc = await w.call("p-meera", "POST", `${base}/decline`, { reason: "Duplicate of an older request" });
    expect(dc.status, JSON.stringify(dc.body)).toBe(200);
    expect((await w.get(id)).bay).toBe("declined");
    expect((await w.call("p-meera", "POST", `${base}/decline`, { reason: "Duplicate of an older request" })).status).toBe(409);
    const up = await w.call("p-meera", "POST", `${base}/unpark`, { reason: "Not a duplicate after all" });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const back = await w.get(id);
    expect(back.bay).toBeNull();
    expect(back.gates.G0G1.status).toBe("waiting");
    expect((await w.q(`select count(*)::int n from gate_instances where wo_id = $1 and status = 'open'`, [id]))[0].n).toBe(1);
    // a question raised to a person
    const q = await w.call("p-meera", "POST", `${base}/messages`, { text: "Does this touch the ledger schema?", kind: "question" });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect((await w.get(id)).bay).toBe("person");
    expect((await w.get(id)).conv.raised[0]).toMatchObject({ answered: false });
    const a = await w.call("p-tomas", "POST", `${base}/messages`, { text: "No, it does not touch the ledger schema." });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const done = await w.get(id);
    expect(done.bay).toBeNull();
    expect(done.conv.raised[0].answered).toBe(true);
  });

  it("running work: park, unpark, send-back, reassign, move (dry run and real), retry, summary", async () => {
    const id = await w.atStation("research", "Command matrix while running");
    const base = `/api/v1/work-orders/${id}`;
    await matrix(id, "POST", `${base}/park`, { bay: "hold", reason: "Waiting for the vendor" }, { stale: "p-meera" });
    await matrix(id, "POST", `${base}/reassign`, { agent: "ag-research" }, { stale: "p-meera" });
    await matrix(id, "POST", `${base}/move`, { target: "hold", reason: "Moving on the board" }, { stale: "p-meera" });
    await matrix(id, "PUT", `${base}/record/summary`, { text: "A person-written summary of this work order." }, { stale: "p-tomas" });
    // park validations and the park itself
    expect((await w.call("p-meera", "POST", `${base}/park`, { bay: "hold", reason: "x" })).status).toBe(422);
    expect((await w.call("p-meera", "POST", `${base}/park`, { bay: "nowhere", reason: "A real reason" })).status).toBe(422);
    expect((await w.call("p-meera", "POST", `${base}/park`, { bay: "queue", reason: "Only work about to build" })).status).toBe(422);
    const att = (await w.liveAttempt(id))!;
    const pk = await w.call("p-meera", "POST", `${base}/park`, { bay: "hold", reason: "Waiting for the vendor" });
    expect(pk.status).toBe(200);
    expect(await w.liveAttempt(id)).toBeUndefined();
    expect(await w.apply(att)).toMatchObject({ applied: false });
    await matrix(id, "POST", `${base}/unpark`, { reason: "Vendor replied" }, { stale: "p-meera" });
    expect((await w.call("p-meera", "POST", `${base}/unpark`, { reason: "Vendor replied" })).status).toBe(200);
    expect((await w.liveAttempt(id))?.station).toBe("research");
    // reassign
    const re = await w.call("p-meera", "POST", `${base}/reassign`, { agent: "ag-research" });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect((await w.call("p-meera", "POST", `${base}/reassign`, { agent: "ag-nobody" })).status).toBe(422);
    // move: dry run for the board, then real moves through the same handlers
    const dry = await w.call("p-meera", "POST", `${base}/move`, { target: "hold", dry_run: true });
    expect(dry.body).toMatchObject({ ok: true, allowed: true, kind: "park" });
    expect((await w.call("p-meera", "POST", `${base}/move`, { target: "build", dry_run: true })).body.allowed).toBe(false);
    expect((await w.call("p-rui", "POST", `${base}/move`, { target: "hold", dry_run: true })).body.allowed).toBe(false);
    expect((await w.call("p-meera", "POST", `${base}/move`, { target: "build" })).status).toBe(409);
    expect((await w.call("p-meera", "POST", `${base}/move`, { target: "hold", reason: "Parked from the board" })).status).toBe(200);
    expect((await w.call("p-meera", "POST", `${base}/move`, { target: "research", reason: "Back from the board" })).status).toBe(200);
    // send-back: validations, then to Intake (the gate reopens, live attempts cancelled)
    await matrix(id, "POST", `${base}/send-back`, { toStation: "intake", note: "The brief was wrong" }, { stale: "p-meera" });
    expect((await w.call("p-meera", "POST", `${base}/send-back`, { toStation: "research", note: "same station" })).status).toBe(422);
    const sb = await w.call("p-meera", "POST", `${base}/send-back`, { toStation: "intake", note: "The brief was wrong" });
    expect(sb.status, JSON.stringify(sb.body)).toBe(200);
    const wo = await w.get(id);
    expect(wo.state).toBe("waiting");
    expect(wo.gates.G0G1.status).toBe("waiting");
    expect(wo.sendbacks[0]).toMatchObject({ from: "research", to: "intake", note: "The brief was wrong", by: "p-meera" });
    expect(await w.liveAttempt(id)).toBeUndefined();
    // the person-written summary
    expect((await w.call("p-tomas", "PUT", `${base}/record/summary`, { text: "short" })).status).toBe(422);
    expect((await w.call("p-tomas", "PUT", `${base}/record/summary`, { text: "Tomás wrote this summary for the record." })).status).toBe(200);
    expect((await w.call("p-asha", "GET", `${base}/record`)).body.summary.written.text).toMatch(/Tomás wrote/);
  });

  it("failures: retry, three failures go to Needs a person, a question from an agent, a lost lease", async () => {
    const id = await w.atStation("research", "Failing station");
    const base = `/api/v1/work-orders/${id}`;
    const f1 = await w.apply((await w.liveAttempt(id))!, { status: "failed", error: { code: "tests", msg: "The suite did not run." } });
    expect(f1.applied).toBe(true);
    let wo = await w.get(id);
    expect(wo).toMatchObject({ state: "failed" });
    expect(wo.failReason).toMatch(/suite/);
    await matrix(id, "POST", `${base}/retry`, {}, { stale: "p-meera" });
    expect((await w.call("p-meera", "POST", `${base}/retry`, {})).status).toBe(200);
    expect((await w.get(id)).state).toBe("running");
    expect((await w.call("p-meera", "POST", `${base}/retry`, {})).status).toBe(422); // not failed any more
    await w.apply((await w.liveAttempt(id))!, { status: "failed", error: { code: "tests", msg: "Failed again." } });
    await w.call("p-meera", "POST", `${base}/retry`, {});
    const third = await w.apply((await w.liveAttempt(id))!, { status: "failed", error: { code: "tests", msg: "Failed a third time." } });
    expect(third).toMatchObject({ applied: true, next: "person" });
    wo = await w.get(id);
    expect(wo.bay).toBe("person");
    expect(wo.bayReason).toMatch(/3 times/);
    // an agent raising a question: the work order goes to Needs a person with the question in the conversation
    const id2 = await w.atStation("research", "Agent asks");
    const q = await w.apply((await w.liveAttempt(id2))!, { status: "needs_person", output: { question: "Which currency should refunds use?" } });
    expect(q).toMatchObject({ applied: true, next: "person" });
    const w2 = await w.get(id2);
    expect(w2.bay).toBe("person");
    expect(w2.conv.raised.at(-1)).toMatchObject({ text: "Which currency should refunds use?", answered: false });
    // a lost lease: bounded retry
    const id3 = await w.atStation("research", "Lost lease");
    const a3 = (await w.liveAttempt(id3))!;
    await t.db.admin.query(`update attempts set state = 'running', lease_until = now() - interval '5 minutes' where id = $1`, [a3.id]);
    const { expireLeases } = await import("../src/areas/workorders/station.js");
    const handled = await w.tx((tx) => expireLeases(tx));
    expect(handled).toContain(a3.id);
    const next = (await w.liveAttempt(id3))!;
    expect(next.id).not.toBe(a3.id);
    expect(await w.apply(a3)).toMatchObject({ applied: false });
  });

  it("gates: a merge request is queued for the pull request, the merge is recorded once, a new head reopens the gate", async () => {
    const id = await w.atStation("research", "Merge path");
    // walk to the merge gate with an open pull request on the work order
    const stations = await w.call("p-asha", "GET", "/api/v1/catalog");
    const order = (stations.body.stations as Array<{ id: string }>).map((s) => s.id);
    await w.walk(id, (x) => order[x.station] === "review" && x.state === "waiting" && x.allowed.approve?.gate === "G5");
    await t.db.admin.query(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, state, head_sha) values ($1,'PR-1','payments-api',$2,501,'Merge path','open','abc1234def5678')`, [t.orgId, id]);
    const prog = (await w.get(id)).allowed.approve;
    expect(prog.gate).toBe("G5");
    // a new head commit closes the open instance and reopens it on the new head
    const { recordNewHead, recordMerged } = await import("../src/areas/workorders/station.js");
    const re = await w.tx((tx) => recordNewHead(tx, t.orgId, id, "def9999aaaa"));
    expect(re.reopened).toBe("G5");
    expect((await w.q(`select closed_reason from gate_instances where id = $1`, [`${id}:G5:1`]))[0].closed_reason).toBe("new_head");
    expect((await w.get(id)).allowed.approve.instance).toBe(`${id}:G5:2`);
    // the old instance id is a stale click now
    expect((await w.call("p-priya", "POST", `/api/v1/gate-instances/${encodeURIComponent(`${id}:G5:1`)}/approve`, {})).status).toBe(409);
    await t.db.admin.query(`update pull_requests set head_sha = 'def9999aaaa' where id = 'PR-1'`);
    let merging = false;
    for (const who of w.APPROVERS) {
      const r = await w.call(who, "POST", `/api/v1/gate-instances/${encodeURIComponent(`${id}:G5`)}/approve`, {});
      if (r.status === 200 && r.body.passed) {
        merging = true;
        break;
      }
    }
    expect(merging).toBe(true);
    const jobs = await w.q(`select payload from jobs where kind = 'merge.request' and payload->>'woId' = $1`, [id]);
    expect(jobs).toEqual([{ payload: { woId: id, prNumber: 501, headSha: "def9999aaaa" } }]);
    expect((await w.get(id)).state).toBe("waiting");
    const first = await w.tx((tx) => recordMerged(tx, t.orgId, id, { prNumber: 501, mergeSha: "feedbeef" }));
    expect(first.applied).toBe(true);
    const second = await w.tx((tx) => recordMerged(tx, t.orgId, id, { prNumber: 501, mergeSha: "feedbeef" }));
    expect(second.applied).toBe(false);
    expect((await w.get(id)).station).toBeGreaterThan(order.indexOf("review"));
  });

  it("epics: Plan splits into children that start at Build; the parent completes when every child is closed", async () => {
    const sub = await w.submit("p-tomas", { title: "Epic: rebuild refunds" });
    const id = sub.body.id as string;
    await t.db.admin.query(`update work_orders set class = 'epic' where id = $1`, [id]);
    await w.answerAll(id);
    expect((await w.confirm(id)).status).toBe(200);
    const order = ((await w.call("p-asha", "GET", "/api/v1/catalog")).body.stations as Array<{ id: string }>).map((s) => s.id);
    await w.walk(id, (x) => order[x.station] === "plan" && x.state === "running");
    const res = await w.apply((await w.liveAttempt(id))!, { status: "succeeded", summary: "Planned", output: { children: ["Ledger changes", "Refund API"] } });
    expect(res.applied).toBe(true);
    // the plan gate comes first; the split happens when it passes
    const parent = await w.walk(id, (x) => x.children.length > 0);
    expect(parent.state).toBe("waiting");
    expect(parent.children.length).toBe(2);
    expect(parent.blockReason).toMatch(/Waiting for/);
    const kids = await w.q(`select id, position, state, parent_id from work_orders where parent_id = $1 order by id`, [id]);
    expect(kids.length).toBe(2);
    expect(kids.every((k) => ["build", "queue"].includes(k.position))).toBe(true);
    expect((await w.q(`select count(*)::int n from epic_children where epic_id = $1`, [id]))[0].n).toBe(2);
    for (const k of kids) {
      const wo = await w.get(k.id);
      expect(wo.parent).toBe(id);
      await w.walk(k.id, (x) => x.state === "done", 80);
    }
    expect((await w.get(id)).state).toBe("done");
  });
});
