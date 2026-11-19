import { withTx } from "@gantry/db";
import { expect } from "vitest";
import type { Actor } from "../src/core/command.js";
import { makeFx } from "../src/areas/workorders/ctx.js";
import type { TestApp } from "./helpers.js";
import { withVersion } from "./versions.js";

export type M = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface Res { status: number; body: Record<string, any>; headers: Record<string, any> }

export function world(getT: () => TestApp) {
  const call = async (who: string, method: M, url: string, payload?: unknown, extra: Record<string, string> = {}, o: { authAgeSec?: number } = {}): Promise<Res> => {
    const t = getT();
    const s = await t.session(who, o);
    const r = await t.app.inject({ method, url, headers: { ...s.headers, ...(await withVersion(t.db.admin, method, url, extra)) }, ...(payload === undefined ? {} : { payload: payload as object }) });
    let body: Record<string, any> = {};
    try {
      body = r.json();
    } catch {
      body = { text: r.body };
    }
    return { status: r.statusCode, body, headers: r.headers };
  };
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await getT().db.admin.query(sql, params)).rows as T[];
  const events = (type: string) => q(`select * from events where type = $1 order by seq`, [type]);
  const ifm = (v: number) => ({ "if-match": String(v) });
  const submit = async (who = "p-tomas", over: Record<string, unknown> = {}, project = "payments", headers: Record<string, string> = {}) =>
    call(who, "POST", `/api/v1/projects/${project}/work-orders`, { repo: "payments-api", title: "Add idempotency keys to refund requests", description: "Refunds can be retried by clients; the API should accept an Idempotency-Key header.", ...over }, headers);
  const get = async (id: string, who = "p-asha") => (await call(who, "GET", `/api/v1/work-orders/${id}`)).body;
  /** Answer every intake question as the submitter until the brief is ready. */
  const answerAll = async (id: string, who = "p-tomas") => {
    for (let i = 0; i < 12; i++) {
      const wo = await get(id);
      if (wo.conv.done) return wo;
      const r = await call(who, "POST", `/api/v1/work-orders/${id}/messages`, { text: `Answer ${i}: yes, keep it small and covered by tests.` });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    throw new Error("conversation never completed");
  };
  const confirm = (id: string, who = "p-tomas", headers: Record<string, string> = {}) => call(who, "POST", `/api/v1/work-orders/${id}/confirm-brief`, {}, headers);
  /** A system actor for engine calls made directly in a transaction (what the worker does). */
  const sys = (): Actor =>
    ({ orgId: getT().orgId, id: "system", kind: "service", personId: null, name: "system", channel: "system", via: null, sessionId: null, ip: null, requestId: "test", decision: {} as never, ifMatch: null, idempotencyKey: null, now: new Date() }) as Actor;
  const tx = <T>(fn: (tx: import("@gantry/db").Tx) => Promise<T>) => withTx(getT().db.app, fn);
  const fxIn = async (t: import("@gantry/db").Tx) => makeFx(t, sys());
  const liveAttempt = async (woId: string) => (await q<{ id: string; fencing: string; station: string; state: string }>(`select id, fencing::text, station, state from attempts where wo_id = $1 and state in ('queued','running') order by created_at desc`, [woId]))[0];
  /** Insert a work order directly (for scenarios that need many at a given position). */
  const insertWo = async (id: string, o: { project?: string; repo?: string; position?: string; state?: string; priority?: string; cls?: string; requestedBy?: string; data?: object } = {}) => {
    const t = getT();
    await t.db.admin.query(
      `insert into work_orders (org_id, id, project_id, repo_id, title, class, priority, position, state, flow_version, submitter, risk, sla_due_at, data)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,(select current_flow_version from projects where org_id = $1 and id = $3),$10,'normal', now() + interval '3 days', $11::jsonb)`,
      [t.orgId, id, o.project ?? "payments", o.repo ?? "payments-api", `Work ${id}`, o.cls ?? "feature", o.priority ?? "P2", o.position ?? "plan", o.state ?? "waiting", o.requestedBy ?? "p-tomas", JSON.stringify({ history: [], log: [], ...(o.data ?? {}) })],
    );
  };
  /** A research station that succeeds has written its note (the stations always do); G1f judges that document, so the helper records one. */
  const noteResearch = async (att: { id: string }) => {
    const a = (await q<{ wo_id: string; station: string }>(`select wo_id, station from attempts where id = $1`, [att.id]))[0];
    if (!a || a.station !== "research") return;
    if ((await q(`select 1 from artefacts where wo_id = $1 and station = 'research' and doc is not null`, [a.wo_id])).length) return;
    await q(`insert into artefacts (org_id, id, wo_id, attempt_id, kind, name, content_hash, media_type, size_bytes, station, doc, version, author_kind, body) values ($1,$2,$3,$4,'document','research.md','0000000000000000000000000000000000000000000000000000000000000000','text/markdown',1,'research','research.md',1,'agent','note')`, [getT().orgId, `art-test-${att.id}`, a.wo_id, att.id]);
  };
  /** CI arrives for a work order waiting at the automatic G4: its pull request head gets every required check green, and the gate reads them (as the GitHub facts would trigger). */
  const ciArrives = async (woId: string) => {
    const open = (await q<{ id: string }>(`select id from gate_instances where wo_id = $1 and status = 'open' and gate_id = 'G4' and not exists (select 1 from gate_votes v where v.gate_instance_id = gate_instances.id)`, [woId]))[0];
    if (!open || (await q(`select 1 from pull_requests where id = $1`, [`pr-t-${woId}`])).length) return false;
    const t = getT();
    const repo = (await q<{ repo_id: string }>(`select repo_id from work_orders where id = $1`, [woId]))[0]!.repo_id;
    const required = (await q<{ required_checks: string[] }>(`select required_checks from repo_config where repo_id = $1`, [repo]))[0]?.required_checks ?? [];
    const sha = "c".repeat(40);
    await q(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, head_sha) values ($1,$2,$3,$4,$5,'t',$6) on conflict do nothing`, [t.orgId, `pr-t-${woId}`, repo, woId, 5000 + Math.floor(Math.random() * 90000), sha]);
    for (const name of required.length ? required : ["ci/test"]) await q(`insert into checks (org_id, id, repo_id, pr_id, head_sha, name, status, conclusion) values ($1,$2,$3,$4,$5,$6,'completed','success') on conflict do nothing`, [t.orgId, `ck-t-${woId}-${name}`, repo, `pr-t-${woId}`, sha, name]);
    const { recheckAutoGate } = await import("../src/areas/workorders/station.js");
    const reopened = (await tx((x) => recheckAutoGate(x, t.orgId, woId, sha))).reopened;
    // The evidence did its job (the gate recorded it); the stand-in pull request goes, so a later merge step behaves as it does for a work order with no repository.
    await q(`delete from checks where pr_id = $1`, [`pr-t-${woId}`]);
    await q(`update pull_requests set wo_id = null where id = $1`, [`pr-t-${woId}`]);
    return reopened;
  };
  const apply = async (att: { id: string; fencing: string }, result: Record<string, unknown> = { status: "succeeded", summary: "done" }) =>
    (await noteResearch(att), w_tx((tx) => import("../src/areas/workorders/station.js").then((m) => m.applyStationResult(tx, att.id, Number(att.fencing), result as never))));
  const w_tx = tx;
  /** The exact open opening of a gate (`WO-1:G2:3`): an approve or reject names it (A8). */
  const gateUrl = async (id: string, gate: string, verb: "approve" | "reject" = "approve") => {
    const inst = (await q<{ id: string }>(`select id from gate_instances where wo_id = $1 and gate_id = $2 and status = 'open'`, [id, gate]))[0];
    return `/api/v1/gate-instances/${encodeURIComponent(inst?.id ?? `${id}:${gate}`)}/${verb}`;
  };
  const APPROVERS = ["p-priya", "p-meera", "p-grace", "p-kenji", "p-daniel", "p-asha", "p-omar"];
  /** Drive a work order (results for running stations, approvals for gates) until `until` holds. */
  const walk = async (id: string, until: (wo: any) => boolean, max = 60) => {
    for (let i = 0; i < max; i++) {
      const wo = await get(id);
      if (until(wo)) return wo;
      const att = await liveAttempt(id);
      if (wo.state === "running" && att) {
        const rr = await apply(att);
        if (!rr.applied) throw new Error(JSON.stringify(rr));
        continue;
      }
      if (wo.state === "waiting" && (await ciArrives(id))) continue;
      if (wo.state === "waiting" && wo.allowed.approve) {
        let passed = false;
        for (const who of APPROVERS) {
          const r = await call(who, "POST", await gateUrl(id, wo.allowed.approve.gate), {});
          if (r.status === 200 && r.body.passed) {
            passed = true;
            break;
          }
        }
        if (!passed) throw new Error(`could not pass ${wo.allowed.approve.gate}`);
        continue;
      }
      throw new Error(`stuck: ${JSON.stringify({ state: wo.state, station: wo.station, bay: wo.bay })}`);
    }
    throw new Error("walk exceeded its steps");
  };
  const catalogStations = async () => (await call("p-asha", "GET", "/api/v1/catalog")).body.stations as Array<{ id: string }>;
  /** A submitted, confirmed work order walked to the station `sid` (running, with a live attempt). */
  const atStation = async (sid: string, title = "Walked work order", who = "p-tomas") => {
    const sub = await submit(who, { title });
    const id = sub.body.id as string;
    await answerAll(id, who);
    const c = await confirm(id, who);
    if (c.status !== 200) throw new Error(JSON.stringify(c.body));
    const st = await catalogStations();
    await walk(id, (wo) => st[wo.station]?.id === sid && wo.state === "running" && !wo.bay);
    return id;
  };
  return { gateUrl, apply, ciArrives, walk, atStation, APPROVERS, call, q, events, ifm, submit, get, answerAll, confirm, sys, tx, fxIn, liveAttempt, insertWo };
}
