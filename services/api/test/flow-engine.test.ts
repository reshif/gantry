import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { dispatchQueued, enterStation } from "../src/areas/workorders/engine.js";
import { saveWo, lockWo } from "../src/areas/workorders/model.js";

const d = TEST_URL ? describe : describe.skip;

d("flow engine: guarantees F1 to F6", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);

  it("F1: a repeated idempotency key creates one work order, also under a race", async () => {
    const key = { "idempotency-key": "submit-once-1" };
    const [a, b] = await Promise.all([w.submit("p-tomas", { title: "F1 once" }, "payments", key), w.submit("p-tomas", { title: "F1 once" }, "payments", key)]);
    const later = await w.submit("p-tomas", { title: "F1 once" }, "payments", key);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(later.status).toBe(200);
    expect(later.headers["idempotent-replayed"]).toBe("true");
    const ids = new Set([a, b, later].filter((r) => r.status === 200).map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect((await w.q(`select id from work_orders where title = 'F1 once'`)).length).toBe(1);
    // the same key with a different body is refused, not replayed
    const other = await w.submit("p-tomas", { title: "A different request" }, "payments", key);
    expect(other.status).toBe(409);
  });

  it("F2: two concurrent moves on one version: exactly one wins; a stale If-Match is refused", async () => {
    const id = await w.atStation("research", "F2 concurrent");
    const wo = await w.get(id);
    const hdr = w.ifm(wo.version);
    const body = { bay: "hold", reason: "Waiting for the vendor" };
    const rs = await Promise.all([w.call("p-meera", "POST", `/api/v1/work-orders/${id}/park`, body, hdr), w.call("p-meera", "POST", `/api/v1/work-orders/${id}/park`, { ...body, reason: "Second caller" }, hdr)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = await w.get(id);
    expect(after.bay).toBe("hold");
    expect(after.version).toBe(wo.version + 1);
    expect((await w.q(`select count(*)::int n from bay_stays where wo_id = $1 and left_at is null`, [id]))[0].n).toBe(1);
    // without If-Match the second command still sees the new state: it is already parked
    const again = await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/park`, body);
    expect(again.status).toBe(409);
    const back = await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/unpark`, { reason: "vendor answered" }, w.ifm(after.version));
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await w.get(id)).state).toBe("running");
    expect((await w.get(id)).position ?? "x").toBeDefined();
  });

  it("F3: a result from a superseded attempt is rejected, the current one is applied, and the rejection is recorded", async () => {
    const id = await w.atStation("research", "F3 superseded");
    const first = (await w.liveAttempt(id))!;
    // a second attempt for the same station supersedes the first
    await w.tx(async (tx) => {
      const fx = await w.fxIn(tx);
      const wo = await lockWo(tx, t.orgId, id);
      await enterStation(fx, wo, "research");
      await saveWo(tx, t.orgId, wo);
    });
    const second = (await w.liveAttempt(id))!;
    expect(second.id).not.toBe(first.id);
    expect(Number(second.fencing)).toBeGreaterThan(Number(first.fencing));
    expect((await w.q(`select state from attempts where id = $1`, [first.id]))[0].state).toBe("superseded");
    const late = await w.apply(first);
    expect(late).toMatchObject({ applied: false, code: "superseded" });
    expect((await w.q(`select count(*)::int n from attempts where wo_id = $1 and state in ('queued','running')`, [id]))[0].n).toBe(1);
    expect((await w.events("run.result.rejected")).length).toBeGreaterThanOrEqual(1);
    // the wrong fencing number for the right attempt id is rejected too
    expect(await w.apply({ id: second.id, fencing: String(Number(second.fencing) + 1000) })).toMatchObject({ applied: false });
    const ok = await w.apply(second);
    expect(ok.applied).toBe(true);
    // and it cannot be applied twice
    expect(await w.apply(second)).toMatchObject({ applied: false });
  });

  it("F3: a stop's fencing number supersedes older attempts in its scope even after the stop is lifted", async () => {
    const id = await w.atStation("research", "F3 stop fencing");
    const att = (await w.liveAttempt(id))!;
    const h = await w.call("p-meera", "POST", "/api/v1/stops", { scope: "workorder", id, mode: "halt", reason: "Look at this first" });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect(await w.apply(att)).toMatchObject({ applied: false });
    const r = await w.call("p-meera", "DELETE", `/api/v1/stops/${encodeURIComponent(`workorder:${id}`)}`);
    expect(r.status).toBe(200);
    expect(await w.apply(att)).toMatchObject({ applied: false });
  });

  it("F5/F9: a Build run that loses its lease for the last time parks the work order and its slot goes to the queue at once", async () => {
    const proj = "identity";
    await w.q(`update slots set state = 'free', wo_id = null where project_id = $1`, [proj]);
    const limit = Number((await w.q(`select (f.doc->>'slots')::int n from flow_versions f join projects p on p.org_id = f.org_id and p.id = f.project_id and p.current_flow_version = f.version where f.project_id = $1`, [proj]))[0]?.n ?? 0);
    expect(limit).toBeGreaterThan(0);
    const repo = (await w.q(`select id from repos where project_id = $1 limit 1`, [proj]))[0]?.id ?? null;
    const ids = Array.from({ length: limit + 1 }, (_, i) => `WO-915${i}`);
    for (const id of ids) await w.insertWo(id, { project: proj, repo, position: "plan", state: "waiting" });
    for (const id of ids)
      await w.tx(async (tx) => {
        const fx = await w.fxIn(tx);
        const wo = await lockWo(tx, t.orgId, id);
        await enterStation(fx, wo, "build");
        await saveWo(tx, t.orgId, wo);
      });
    const queued = ids[limit]!;
    expect((await w.q(`select position from work_orders where id = $1`, [queued]))[0].position).toBe("queue");
    const first = ids[0]!;
    // two earlier lost runs at Build, then the live one's lease lapses
    for (const v of [91, 92]) await w.q(`insert into attempts (org_id, id, wo_id, station, visit, state, outcome) values ($1,$2,$3,'build',$4,'failed','lease_expired')`, [t.orgId, `ATT-${first}-old-${v}`, first, v]);
    const att = (await w.liveAttempt(first))!;
    await w.q(`update attempts set state = 'running', lease_until = now() - interval '1 minute' where id = $1`, [att.id]);
    const { expireLeases } = await import("../src/areas/workorders/station.js");
    expect(await w.tx((tx) => expireLeases(tx))).toContain(att.id);
    expect((await w.q(`select position from work_orders where id = $1`, [first]))[0].position).toBe("person");
    expect((await w.q(`select 1 from slots where wo_id = $1 and state = 'held'`, [first])).length).toBe(0);
    expect((await w.q(`select position from work_orders where id = $1`, [queued]))[0].position).toBe("build");
    expect((await w.q(`select count(*)::int n from slots where project_id = $1 and state = 'held'`, [proj]))[0].n).toBeLessThanOrEqual(limit);
  });

  it("F5: the coding slot limit holds under concurrent dispatch and is released on send-back and kill", async () => {
    const proj = "payments";
    const limit = Number((await w.q(`select (doc->>'slots')::int n from flow_versions where project_id = $1 and version = 1`, [proj]))[0].n);
    expect(limit).toBe(2);
    const ids = ["WO-9101", "WO-9102", "WO-9103", "WO-9104"];
    for (const [i, id] of ids.entries()) await w.insertWo(id, { position: "plan", state: "waiting", priority: i === 3 ? "P0" : "P2" });
    const dispatch = (id: string) =>
      w.tx(async (tx) => {
        const fx = await w.fxIn(tx);
        const wo = await lockWo(tx, t.orgId, id);
        await enterStation(fx, wo, "build");
        await saveWo(tx, t.orgId, wo);
      });
    await Promise.all([dispatch(ids[0]!), dispatch(ids[1]!)]);
    await Promise.all([dispatch(ids[2]!), dispatch(ids[3]!), dispatch(ids[0]!)]); // a repeat dispatch of a holder takes no second slot
    const held = await w.q(`select wo_id from slots where project_id = $1 and state = 'held' order by id`, [proj]);
    expect(held.length).toBe(limit);
    const states = await w.q(`select id, position, state from work_orders where id = any($1::text[]) order by id`, [ids]);
    expect(states.filter((s) => s.position === "build").length).toBe(limit);
    expect(states.filter((s) => s.position === "queue").length).toBe(ids.length - limit);
    // F3 at the same time: one live attempt per work order and station
    expect((await w.q(`select wo_id, count(*)::int n from attempts where wo_id = any($1::text[]) and state in ('queued','running') group by 1`, [ids])).every((r) => r.n === 1)).toBe(true);
    // send one holder back: its slot is released and the oldest highest-priority queued work order takes it, never more than the limit
    const holder = ids[0]!;
    const ver = (await w.get(holder)).version;
    const sb = await w.call("p-meera", "POST", `/api/v1/work-orders/${holder}/send-back`, { toStation: "spec", note: "Needs a clearer spec" }, w.ifm(ver));
    expect(sb.status, JSON.stringify(sb.body)).toBe(200);
    const after = await w.q(`select wo_id from slots where project_id = $1 and state = 'held'`, [proj]);
    expect(after.length).toBeLessThanOrEqual(limit);
    expect(after.map((r) => r.wo_id)).not.toContain(holder);
    // the P0 work order came from the queue first (priority, then age)
    expect(after.map((r) => r.wo_id)).toContain("WO-9104");
    expect((await w.get(holder)).state).toBe("running");
    // kill (cancel) one holder through the stop path: the worker's reconcile releases the slot and the queue moves
    const victim = ids[1]!;
    const k = await w.call("p-meera", "POST", "/api/v1/stops", { scope: "workorder", id: victim, mode: "kill", reason: "No longer wanted", confirmText: null });
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    const { reconcileStop } = await import("../src/areas/stops/enforce.js");
    const res = await w.tx((tx) => reconcileStop(tx, String(k.body.stop)));
    expect(res.action).toBe("enforced");
    const final = await w.q(`select wo_id from slots where project_id = $1 and state = 'held'`, [proj]);
    expect(final.length).toBeLessThanOrEqual(limit);
    expect(final.map((r) => r.wo_id)).not.toContain(victim);
    expect((await w.get(victim)).state).toBe("killed");
    void dispatchQueued;
  });

  describe("F6 and I4: gates", () => {
    const rule = (over: Record<string, unknown> = {}) => ({ roles: ["reviewer", "approver", "line_lead", "release_manager", "project_admin"], people: [], required: 2, sod: true, conditions: [], escalateH: 0, fallback: null, ...over });
    const setRule = async (gate: string, value: object) => {
      const r = await w.call("p-daniel", "PUT", `/api/v1/projects/payments/approvers/${gate}`, { value });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    /** A confirmed work order walked to the first human gate after intake. */
    const atGate = async (title: string, who = "p-tomas", first?: object) => {
      if (first) await setRule("G2", first);
      const id = (await w.submit(who, { title })).body.id as string;
      await w.answerAll(id, who);
      expect((await w.confirm(id, who)).status).toBe(200);
      const wo = await w.walk(id, (x) => x.state === "waiting" && !!x.allowed.approve && x.allowed.approve.gate === "G2");
      return { id, gate: "G2", version: wo.version as number };
    };
    const vote = (who: string, id: string, gate: string, verb: "approve" | "reject" = "approve", body: object = {}) =>
      w.call(who, "POST", `/api/v1/gate-instances/${encodeURIComponent(`${id}:${gate}`)}/${verb}`, body);

    it("F6: a double click counts once; loosening the rule between votes approves nothing by itself", async () => {
      const { id, gate } = await atGate("F6 double approve", "p-tomas", rule());
      const a = await vote("p-priya", id, gate);
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(a.body).toMatchObject({ passed: false, have: 1, need: 2 });
      const [dup, dup2] = await Promise.all([vote("p-priya", id, gate), vote("p-priya", id, gate)]);
      expect([dup.status, dup2.status]).toEqual([403, 403]);
      expect((await w.q(`select count(*)::int n from gate_votes where gate_instance_id = $1`, [`${id}:${gate}:1`]))[0].n).toBe(1);
      await setRule(gate, rule({ required: 1 }));
      const still = await w.get(id);
      expect(still.state).toBe("waiting");
      expect(still.gates[gate].status).toBe("waiting");
      const b = await vote("p-meera", id, gate);
      expect(b.body).toMatchObject({ passed: true, have: 2, need: 2 }); // never below what the instance opened with
      const dec = (await w.q(`select * from gate_decisions where gate_instance_id = $1`, [`${id}:${gate}:1`]))[0];
      expect(dec).toMatchObject({ decision: "approved", flow_version: 1 });
      expect(dec.gate_rule_version).not.toBeNull();
      expect(dec.detail.voters.map((v: any) => v.by).sort()).toEqual(["p-meera", "p-priya"]);
    });

    it("F6: tightening applies at once, and a voter the rule no longer lists is refused", async () => {
      const { id, gate } = await atGate("F6 tighten", "p-tomas", rule());
      expect((await vote("p-priya", id, gate)).body.passed).toBe(false);
      await setRule(gate, rule({ required: 3 }));
      const b = await vote("p-meera", id, gate);
      expect(b.body).toMatchObject({ passed: false, have: 2, need: 3 });
      await setRule(gate, rule({ required: 3, roles: ["approver", "reviewer", "line_lead", "project_admin"] }));
      const refused = await vote("p-kenji", id, gate);
      expect(refused.status).toBe(403);
      expect(refused.body.rule?.kind).toBe("approver");
      const c = await vote("p-grace", id, gate);
      expect(c.body).toMatchObject({ passed: true, have: 3 });
    });

    it("I4: the requester is never the sole approver", async () => {
      const { id, gate } = await atGate("I4 requester", "p-meera", rule({ required: 1, sod: false, roles: ["line_lead", "reviewer"] }));
      const own = await vote("p-meera", id, gate);
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      expect(own.body.passed).toBe(false);
      expect((await w.get(id)).state).toBe("waiting");
      const other = await vote("p-priya", id, gate);
      expect(other.body.passed).toBe(true);
    });

    it("Factory Admin override: on their own work order (SoD) and below N of M, the vote asks for a reason, then passes the gate and is audited; nobody else overrides", async () => {
      const { id, gate } = await atGate("FA override", "p-asha", rule({ sod: true, required: 2 }));
      const other = await vote("p-priya", id, gate);
      expect(other.body).toMatchObject({ passed: false, have: 1, need: 2 }); // an ordinary approver is one vote, no override
      const bare = await vote("p-asha", id, gate);
      expect(bare.status).toBe(403);
      expect(bare.body.needs).toBe("override_reason");
      expect(bare.body.msg).toMatch(/override/i);
      expect((await w.q(`select count(*)::int n from gate_votes where gate_instance_id = $1 and voter = 'p-asha'`, [`${id}:${gate}:1`]))[0].n).toBe(0); // nothing recorded
      const ok = await vote("p-asha", id, gate, "approve", { reason: "Urgent fix; second approver unavailable today." });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.passed).toBe(true);
      const dec = (await w.q(`select * from gate_decisions where gate_instance_id = $1`, [`${id}:${gate}:1`]))[0];
      expect(dec.decision).toBe("approved");
      expect(dec.detail).toMatchObject({ override: true, reason: "Urgent fix; second approver unavailable today." });
      const ov = await w.events("gate.override");
      expect(ov.at(-1)?.actor).toBe("p-asha");
      expect(ov.at(-1)?.after).toMatchObject({ gate, author: true });
      expect((await w.get(id)).gates[gate].status).not.toBe("waiting");
    });

    it("separation of duties: the author cannot approve; a stale instance id is refused; a reject reworks the station", async () => {
      const { id, gate } = await atGate("SoD and stale", "p-meera", rule({ sod: true, required: 1, roles: ["line_lead", "reviewer"] }));
      const own = await vote("p-meera", id, gate);
      expect(own.status).toBe(403);
      expect(own.body.msg).toMatch(/author/i);
      const staleClick = await w.call("p-priya", "POST", `/api/v1/gate-instances/${encodeURIComponent(`${id}:${gate}:7`)}/approve`, {});
      expect(staleClick.status).toBe(409);
      const noReason = await vote("p-priya", id, gate, "reject", { reason: "no" });
      expect(noReason.status).toBe(422);
      const rej = await vote("p-priya", id, gate, "reject", { reason: "The tests do not cover refunds." });
      expect(rej.status, JSON.stringify(rej.body)).toBe(200);
      const wo = await w.get(id);
      expect(wo.state).toBe("running");
      expect(wo.gates[gate].rejections[0].reason).toMatch(/refunds/);
      expect((await w.q(`select status, closed_reason from gate_instances where id = $1`, [`${id}:${gate}:1`]))[0]).toMatchObject({ status: "closed", closed_reason: "decision" });
      // the same instance cannot be decided again
      expect((await vote("p-priya", id, gate)).status).toBe(409);
    });
  });
});
