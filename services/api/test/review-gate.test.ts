import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { parseReview } from "../src/areas/workorders/review.js";
import { reviewFact } from "../src/areas/internal/spec.js";

const d = TEST_URL ? describe : describe.skip;

const review = (o: Record<string, unknown>) => ({ status: "succeeded", summary: "reviewed", output: { reviewNotes: "notes", pullRequestDescription: "## Summary\nDoes the thing.", ...o } });

d("Review's verdict is enforced (findings 15, 16, 17, 19)", () => {
  let t: TestApp;
  const w = world(() => t);
  beforeAll(async () => { t = await startApp(); });
  afterAll(() => t.close());

  let ids: string[] = [];
  const sid = (wo: { station: number }) => ids[wo.station];
  const atReview = async (title: string) => {
    ids = (await w.call("p-asha", "GET", "/api/v1/catalog")).body.stations.map((x: { id: string }) => x.id);
    await w.q(`update slots set state = 'free', wo_id = null, attempt_id = null, released_at = now() where state = 'held'`);
    const id = await w.atStation("review", title);
    return { id, att: (await w.liveAttempt(id))! };
  };

  it("changes requested goes back to Build by default, with the findings, and never opens G5", async () => {
    const { id, att } = await atReview("Review sends back");
    const r = await w.apply(att, review({ verdict: "changes_requested", criteria: [{ criterion: "The helper is used", result: "fail", evidence: "src/x.ts: added, never called" }], findings: [{ severity: "major", file: "src/x.ts", line: 4, issue: "helper never used", fix: "call it from refund()" }] }));
    expect(r).toMatchObject({ applied: true });
    const wo = await w.get(id);
    expect(sid(wo)).toBe("build");
    expect(wo.state).toBe("running");
    expect((await w.liveAttempt(id))?.station).toBe("build");
    expect(await w.q(`select 1 from gate_instances where wo_id = $1 and gate_id = 'G5' and status = 'open'`, [id])).toHaveLength(0);
    expect(wo.sendbacks.at(-1)).toMatchObject({ from: "review", to: "build", by: "system", review: true });
    expect(wo.sendbacks.at(-1).note).toContain("helper never used");
    expect(wo.sendbacks.at(-1).note).toContain("The helper is used");
    const rec = (await w.call("p-asha", "GET", `/api/v1/work-orders/${id}/record`)).body;
    expect(rec.review).toMatchObject({ verdict: "changes_requested", criteria: [{ criterion: "The helper is used", result: "fail" }] });
    // the station that gets the work back reads why (handoff), and the PR description job was queued for the pull request
    expect((await w.q(`select payload from jobs where kind = 'pr.describe' and payload->>'woId' = $1`, [id]))).toHaveLength(1);
  });

  it("the station the agent names is where the work goes", async () => {
    const { id, att } = await atReview("Review names spec");
    await w.apply(att, review({ verdict: "changes_requested", sendBackTo: "spec" }));
    expect(sid(await w.get(id))).toBe("spec");
    expect((await w.get(id)).sendbacks.at(-1)).toMatchObject({ from: "review", to: "spec", review: true });
  });

  it("an approve with a failed criterion is still a request for changes", async () => {
    const { id, att } = await atReview("Review contradicts itself");
    await w.apply(att, review({ verdict: "approve", criteria: [{ criterion: "Covered by a test", result: "fail", evidence: "no test" }] }));
    expect(sid(await w.get(id))).toBe("build");
  });

  it("approve opens G5 and the gate data carries the verdict, the criteria and the findings", async () => {
    const { id, att } = await atReview("Review approves");
    await w.apply(att, review({ verdict: "approve", criteria: [{ criterion: "Refunds are idempotent", result: "pass", evidence: "src/refund.ts:12" }], findings: [{ severity: "minor", file: "a.ts", line: 1, issue: "naming", fix: "rename" }] }));
    const wo = await w.get(id);
    expect(wo.state).toBe("waiting");
    const rec = (await w.call("p-asha", "GET", `/api/v1/work-orders/${id}/record`)).body;
    const g5 = rec.gates.find((g: any) => g.gate === "G5" && g.status === "open");
    expect(g5.basis.review).toMatchObject({ verdict: "approve", criteria: [{ result: "pass" }], findings: [{ issue: "naming" }] });
  });

  it("after repeated requests for changes a person decides (Needs a person), not another automatic loop", async () => {
    const { id, att } = await atReview("Review keeps asking");
    // two earlier rounds of "changes requested" on record (each walked through Build and Verify again)
    const prior = { from: "review", to: "build", review: true, by: "system", note: "round", at: 1 };
    await w.q(`update work_orders set data = data || $2::jsonb where id = $1`, [id, JSON.stringify({ sendbacks: [prior, { ...prior, round: 2 }] })]);
    const cur = att;
    await w.apply(cur, review({ verdict: "changes_requested", findings: [{ severity: "major", file: "a.ts", line: 1, issue: "still wrong", fix: "fix" }] }));
    const wo = await w.get(id);
    expect(wo.bay).toBe("person");
    expect(await w.q(`select 1 from gate_instances where wo_id = $1 and gate_id = 'G5' and status = 'open'`, [id])).toHaveLength(0);
    expect(String((await w.q(`select data from work_orders where id = $1`, [id]))[0].data.bayReason)).toContain("still wrong");
  });

  it("parseReview: verdicts, aliases and per-criterion results", () => {
    const base = { attempt: "A", headSha: null, now: 1 };
    expect(parseReview({ verdict: "approve" }, base).verdict).toBe("approve");
    expect(parseReview({ verdict: "Changes requested" }, base).verdict).toBe("changes_requested");
    expect(parseReview({ verdict: "approve", criteria: [{ criterion: "a", result: "not met" }] }, base).verdict).toBe("changes_requested");
    expect(parseReview({ verdict: "maybe" }, base).verdict).toBe("changes_requested");
    expect(parseReview({}, base).verdict).toBe("none");
    expect(parseReview({ verdict: "approve", pullRequestDescription: "x", pullRequestTitle: "T" }, base).description).toEqual({ title: "T", body: "x" });
  });

  it("the Review handoff carries the acceptance criteria, the pull request and the changed files", async () => {
    await w.insertWo("WO-9401", { position: "review", state: "running", data: { brief: { ac: ["Refunds accept an Idempotency-Key"] }, files: [{ path: "src/refund.ts", plus: 5, minus: 1 }] } });
    await w.q(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, state, head_sha) values ($1,'pr-9401','payments-api','WO-9401',12,'T','open','abc')`, [t.orgId]);
    const f = await reviewFact(t.db.admin, { orgId: t.orgId, woId: "WO-9401", station: "review", woData: { brief: { ac: ["Refunds accept an Idempotency-Key"] }, files: [{ path: "src/refund.ts", plus: 5, minus: 1 }] } } as never, { ac: ["Refunds accept an Idempotency-Key"] });
    expect(f).toMatchObject({ acceptanceCriteria: ["Refunds accept an Idempotency-Key"], pullRequest: { number: 12, headSha: "abc" }, changedFiles: { observedBy: "platform", files: [{ path: "src/refund.ts", additions: 5, deletions: 1 }] } });
    expect(String(f!.instruction)).toContain("criteria");
    expect(await reviewFact(t.db.admin, { orgId: t.orgId, woId: "WO-9401", station: "verify", woData: {} } as never, null)).toBeNull();
  });

  it("a person can send a work order back to the station it is at (redo) with a note, audited", async () => {
    const id = await w.atStation("research", "Redo research");
    const base = `/api/v1/work-orders/${id}`;
    expect((await w.call("p-meera", "POST", `${base}/send-back`, { toStation: "research", note: "" })).status).toBe(422);
    const before = (await w.liveAttempt(id))!;
    const r = await w.call("p-meera", "POST", `${base}/send-back`, { toStation: "research", note: "Look at the retry path too" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const wo = await w.get(id);
    expect(sid(wo)).toBe("research");
    expect(wo.state).toBe("running");
    const now = (await w.liveAttempt(id))!;
    expect(now.id).not.toBe(before.id);
    expect(wo.sendbacks.at(-1)).toMatchObject({ from: "research", to: "research", redo: true, by: "p-meera", note: "Look at the retry path too" });
    const e = (await w.q(`select actor, after from events where wo_id = $1 and type = 'wo.sendback' order by seq desc limit 1`, [id]))[0];
    expect(e.after).toMatchObject({ redo: true, from: "research", to: "research" });
    expect((await w.call("p-rui", "POST", `${base}/send-back`, { toStation: "research", note: "no right to" })).status).toBe(403);
    // a later station is still refused
    expect((await w.call("p-meera", "POST", `${base}/send-back`, { toStation: "build", note: "too far ahead" })).status).toBe(422);
  });
});
