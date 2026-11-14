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
  const apply = async (att: { id: string; fencing: string }, result: Record<string, unknown> = { status: "succeeded", summary: "done" }) =>
    w_tx((tx) => import("../src/areas/workorders/station.js").then((m) => m.applyStationResult(tx, att.id, Number(att.fencing), result as never)));
  const w_tx = tx;
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
      if (wo.state === "waiting" && wo.allowed.approve) {
        let passed = false;
        for (const who of APPROVERS) {
          const r = await call(who, "POST", `/api/v1/gate-instances/${encodeURIComponent(`${id}:${wo.allowed.approve.gate}`)}/approve`, {});
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
  return { apply, walk, atStation, APPROVERS, call, q, events, ifm, submit, get, answerAll, confirm, sys, tx, fxIn, liveAttempt, insertWo };
}
