/** Test helpers for the traveler, record and conversations tests: the traveler read and the record read built from the dev seed. Not shipped: only tests import it. */
import { DEFAULT_CATALOG, route, type WorkOrder } from "@gantry/domain";
import { PAYMENTS, WOS, type Call } from "../floor/testkit";
import type { TWo } from "./model";
import type { RecordData } from "../record/data";

export const allow = { allowed: true, reason: "", needs: "" };
export const deny = (reason = "No role holds it.", needs = "Project Admin") => ({ allowed: false, reason, needs });

/** The seed work order waiting at a gate (the traveler read adds version, progress and what the viewer may do). */
export const waitingWo = (WOS.find((w) => w.state === "waiting" && w.station > 1 && !w.bay) ?? WOS[0]) as WorkOrder;
export const intakeWo = (WOS.find((w) => w.station === 0 && !w.bay && w.state !== "killed") ?? WOS[0]) as WorkOrder;

export function travelerOf(w: WorkOrder, over: Partial<TWo> = {}, o: { approve?: Record<string, unknown> | null; can?: Record<string, Record<string, unknown>> } = {}): TWo {
  const gate = Object.entries(w.gates).find(([, g]) => g.status === "waiting")?.[0];
  const rt = route(DEFAULT_CATALOG, PAYMENTS, w.cls);
  const moves: TWo["allowed"]["moves"] = {};
  for (const sid of rt) moves[sid] = { allowed: true, reason: "", kind: "back" };
  for (const b of DEFAULT_CATALOG.bays) moves[b.id] = { allowed: true, reason: `Moves to ${b.name}.`, kind: "park" };
  const can: TWo["allowed"]["can"] = {};
  for (const k of ["answer", "classify", "decline", "park", "sendback", "reassign", "move", "confirm", "summary"]) can[k] = allow;
  Object.assign(can, o.can ?? {});
  const gateProgress: TWo["gateProgress"] = {};
  for (const g of Object.keys(w.gates)) gateProgress[g] = { have: 0, need: 1, unmet: [], conds: [], onlyRequester: false, passes: false };
  const approve = o.approve === null || !gate ? null : { ...allow, gate, instance: `${w.id}:${gate}:1`, ...(o.approve ?? {}) };
  return { ...(w as TWo), version: 7, gateProgress, allowed: { approve, moves, can }, stop: null, route: rt, ...over };
}

export function recordOf(w: WorkOrder, over: Partial<RecordData> = {}): RecordData {
  return {
    id: w.id, version: 7, project: w.project, repo: w.repo, title: w.title, state: w.state,
    request: { text: w.description || w.title, by: w.requestedBy, via: w.source, at: w.createdAt, attachments: [] },
    classification: { predicted: w.clsSuggested, final: w.cls, confidence: w.clsConfidence, rationale: w.clsRationale, requested: null, overridden: null },
    route: route(DEFAULT_CATALOG, PAYMENTS, w.cls), flowVersion: 1, clarification: w.conv.messages, briefVersions: w.briefVersions ?? [], brief: w.brief, criteria: w.criteria ?? [],
    journey: w.history, gates: [], sendbacks: [], bayStays: [], attempts: [], results: [], runs: [],
    code: { pullRequests: [], commits: [], files: [], diff: { plus: 0, minus: 0, files: 0 }, tests: { passed: 0, failed: 0, added: 0 } },
    outcomes: [], totals: { tokens: 0, cost: 0 },
    completeness: { sections: { summary: true, request: true, clarification: true, agreement: false, stations: false, changes: false, verification: false, merge: false, approvals: false, after: false, timeline: true }, done: 4, total: 11 },
    summary: { generated: "Tomás asked for it. It is waiting at a gate.", written: null },
    events: [
      { seq: 1, at: new Date(w.createdAt).toISOString(), type: "wo.submit", by: w.requestedBy, outcome: "ok", detail: { text: w.title } },
      { seq: 2, at: new Date(w.createdAt + 1000).toISOString(), type: "wo.enter", by: w.requestedBy, outcome: "ok", detail: { station: "intake" } },
    ],
    ...over,
  };
}

/** The reads a traveler needs for a work order. */
export function readsFor(w: WorkOrder, t: TWo = travelerOf(w), r: RecordData = recordOf(w)) {
  return {
    [`GET /api/v1/work-orders/${w.id}`]: () => ({ body: t }),
    [`GET /api/v1/work-orders/${w.id}/record`]: () => ({ body: r }),
    [`GET /api/v1/work-orders/${w.id}/changes`]: () => ({ body: { pullRequests: [], commits: [], files: [], patches: [] } }),
    "GET /api/v1/audit": () => ({ body: { items: [], next: null } }),
  };
}
export const posts = (calls: Call[], path: string) => calls.filter((c) => c.method !== "GET" && c.path === path);
