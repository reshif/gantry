/**
 * The flow engine's state transitions (spec 9). Every function takes an `Fx` (the open transaction plus the effects to flush),
 * mutates locked rows, and records the events and jobs the transition causes. Callers are the command handlers in `commands.ts`
 * (events and jobs go through the command pipeline) and the worker (`applyStationResult`, `expireLeases`, which flush with `flushFx`).
 *
 * Positions: a work order has one `position`, a station id or a bay id. In a bay, `data.bayFrom` names the station it came from.
 * Slots (F5): `slots` rows `${project}:${n}` go free -> held with an atomic upsert, so the limit holds under concurrent dispatch.
 * Attempts (F3): one live attempt per (work order, station); each has a global fencing number; a stop's own fencing number
 * supersedes every older attempt inside its scope without the stop path having to touch attempts.
 */
import {
  gateAfter, gateDef, gateKind, gateProgress, nextStationId, riskTagsOf, route, routeGates, stationDef,
  type Catalog, type Person, type Project, type WorkOrder,
} from "@gantry/domain";
import { appendEvent, cancel, enqueue, schedule, type EventCategory, type EventChannel, type Tx } from "@gantry/db";
import type { EventSpec } from "../../core/command.js";
import { readCatalog } from "../../core/read/index.js";
import { job, type BuiltJob } from "../../core/jobs-contract.js";
import { revokeRunTokens } from "../internal/tokens.js";
import { ms } from "../../core/read/rows.js";
import { readProject } from "../projects/store.js";
import { afterFinish as trustAfterFinish, demoteForBreach, trustDecision, trustInForce } from "../trust/record.js";
import { bayOf, buildWorkOrders, loadFlowDocs, pinnedProject, saveWo, stationIdOf, type Data, type Wo } from "./model.js";

export interface Fx {
  tx: Tx;
  orgId: string;
  now: Date;
  /** Event actor id: a person, an agent id or "system". */
  actor: string;
  catalog: Catalog;
  events: EventSpec[];
  jobs: BuiltJob[];
  /** Legacy slice names for the SSE change message. */
  changes: Set<string>;
}

export async function newFx(tx: Tx, orgId: string, actor: string, now: Date = new Date()): Promise<Fx> {
  return { tx, orgId, now, actor, catalog: await readCatalog(tx, orgId), events: [], jobs: [], changes: new Set(["workOrders"]) };
}

/** Worker side: append the events and enqueue the jobs the transition collected, in the caller's transaction. */
export async function flushFx(fx: Fx, o: { channel?: EventChannel } = {}): Promise<void> {
  for (const e of fx.events) {
    await appendEvent(fx.tx, {
      orgId: fx.orgId, type: e.type, category: (e.category ?? "flow") as EventCategory, actor: fx.actor, channel: o.channel ?? "system", subject: e.subject ?? null,
      projectId: e.projectId ?? null, woId: e.woId ?? null, woVersion: e.woVersion ?? null, outcome: e.outcome ?? "ok", before: e.before, after: e.after,
      ...(e.occurredAt ? { occurredAt: e.occurredAt } : {}),
    });
  }
  for (const j of fx.jobs) await enqueue(fx.tx, { orgId: fx.orgId, kind: j.kind, queue: j.queue, payload: j.payload, ...(j.dedupeKey ? { dedupeKey: j.dedupeKey } : {}), ...(j.priority !== undefined ? { priority: j.priority } : {}), ...(j.runAt ? { runAt: j.runAt } : {}), ...(j.maxAttempts !== undefined ? { maxAttempts: j.maxAttempts } : {}) });
  fx.events = [];
  fx.jobs = [];
}

/** Records a flow event about a work order. Payload fields the floor replay reads (station, gate, bay, from, to, text, mode, trust) go in `after`. */
export function ev(fx: Fx, w: Wo, type: string, payload: Record<string, unknown> = {}, o: { category?: EventCategory; before?: unknown; outcome?: EventSpec["outcome"] } = {}): void {
  fx.events.push({
    type, category: o.category ?? "flow", subject: { type: "wo", id: w.id }, projectId: w.project, woId: w.id, woVersion: w.version, after: { repo: w.repo ?? undefined, ...payload },
    ...(o.before !== undefined ? { before: o.before } : {}), ...(o.outcome ? { outcome: o.outcome } : {}), occurredAt: fx.now,
  });
}

export const note = (w: Wo, fx: Fx, who: string, text: string): void => {
  const log = Array.isArray(w.data.log) ? (w.data.log as Array<{ at: number; who: string; text: string }>) : [];
  log.push({ at: fx.now.getTime(), who, text });
  w.data.log = log;
};

/* ----------------------------------------------------------------------------------- history */

interface Hist { station: string; agent: string; model: string; startedAt: number; endedAt: number | null; tokens: number; cost: number; outcome: string | null; note: string }
const hist = (w: Wo): Hist[] => (Array.isArray(w.data.history) ? (w.data.history as Hist[]) : (w.data.history = []));
export const openEntry = (w: Wo): Hist | undefined => hist(w).slice().reverse().find((h) => !h.endedAt);
export function closeEntry(w: Wo, fx: Fx, outcome: string, text = ""): void {
  const e = openEntry(w);
  if (e) {
    e.endedAt = fx.now.getTime();
    e.outcome = outcome;
    if (text) e.note = text;
  }
}

export async function modelFor(tx: Tx, orgId: string, agentId: string): Promise<string> {
  const { rows } = await tx.query<{ model_id: string | null }>(
    `select v.model_id from agents a join agent_versions v on v.org_id = a.org_id and v.agent_id = a.id and v.version = a.live_version where a.org_id = $1 and a.id = $2`, [orgId, agentId],
  );
  return rows[0]?.model_id ?? "";
}

async function openHistory(fx: Fx, w: Wo, stationId: string, agentOverride?: string): Promise<void> {
  const st = stationDef(fx.catalog, stationId);
  const agent = agentOverride ?? (typeof w.data.agentOverride === "object" && w.data.agentOverride ? (w.data.agentOverride as Record<string, string>)[stationId] : undefined) ?? st?.agent ?? "";
  hist(w).push({ station: stationId, agent, model: agent ? await modelFor(fx.tx, fx.orgId, agent) : "", startedAt: fx.now.getTime(), endedAt: null, tokens: 0, cost: 0, outcome: null, note: "" });
}

/* ----------------------------------------------------------------------------------- stop state */

export interface CoveringStop { id: string; scope: string; mode: "halt" | "kill"; reason: string; fencing: number }

/** The stop that covers a work order, outermost scope first then most severe (spec 9.7). A parent's work-order stop covers its children. Live: read in the caller's transaction. */
export async function coveringStop(db: Pick<Tx, "query">, orgId: string, w: Pick<Wo, "id" | "project" | "repo" | "parentId">): Promise<CoveringStop | null> {
  const { rows } = await db.query<{ id: string; scope_type: string; mode: "halt" | "kill"; reason: string; fencing: string }>(
    `select id, scope_type, mode, reason, fencing from stops where org_id = $1 and lifted_at is null
       and (scope_type = 'factory' or (scope_type = 'project' and project_id = $2) or (scope_type = 'repo' and repo_id = $3) or (scope_type = 'wo' and (wo_id = $4 or wo_id = $5)))
     order by case scope_type when 'factory' then 0 when 'project' then 1 when 'repo' then 2 else 3 end, case mode when 'kill' then 0 else 1 end limit 1`,
    [orgId, w.project, w.repo, w.id, w.parentId],
  );
  const r = rows[0];
  return r ? { id: r.id, scope: r.scope_type, mode: r.mode, reason: r.reason, fencing: Number(r.fencing) } : null;
}

/* ----------------------------------------------------------------------------------- slots (F5) */

export async function projectOf(fx: Pick<Fx, "tx" | "orgId">, id: string): Promise<Project> {
  const p = await readProject(fx.tx, fx.orgId, id);
  if (!p) throw new Error(`project ${id} missing`);
  return p;
}

/** The slot number held by the work order, or the lowest free one it can take now, or null when every slot is busy. */
export async function acquireSlot(fx: Fx, w: Wo, project: Project): Promise<number | null> {
  const held = await fx.tx.query<{ id: string }>(`select id from slots where org_id = $1 and wo_id = $2 and state = 'held'`, [fx.orgId, w.id]);
  if (held.rows[0]) return Number(held.rows[0].id.split(":").pop());
  const limit = Math.max(0, Number(project.flow.slots) || 0);
  for (let n = 1; n <= limit; n++) {
    const r = await fx.tx.query(
      `insert into slots (org_id, id, project_id, repo_id, wo_id, state, acquired_at, released_at) values ($1, $2, $3, $4, $5, 'held', $6, null)
       on conflict (org_id, id) do update set state = 'held', wo_id = excluded.wo_id, repo_id = excluded.repo_id, acquired_at = excluded.acquired_at, released_at = null, updated_at = now()
       where slots.state <> 'held' returning id`,
      [fx.orgId, `${project.id}:${n}`, project.id, w.repo, w.id, fx.now],
    );
    if (r.rowCount) return n;
  }
  return null;
}

/** Releases the work order's slot (every exit path: finish, kill, send-back, park, decline). Returns whether one was held. */
export async function releaseSlot(fx: Fx, w: Wo): Promise<boolean> {
  const r = await fx.tx.query(`update slots set state = 'free', wo_id = null, attempt_id = null, released_at = $3, updated_at = now() where org_id = $1 and wo_id = $2 and state = 'held'`, [fx.orgId, w.id, fx.now]);
  return (r.rowCount ?? 0) > 0;
}

const PRIORITY_SQL = `case priority when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 when 'P3' then 3 else 9 end`;

/** Moves work waiting in the Queue bay onto free slots, in the deterministic order of spec 9.6 (priority, then age in the bay). Skips stopped scopes and rows another command holds. */
export async function dispatchQueued(fx: Fx, projectId: string): Promise<string[]> {
  const started: string[] = [];
  const project = await projectOf(fx, projectId);
  for (let guard = 0; guard < 50; guard++) {
    const { rows } = await fx.tx.query<{ id: string }>(
      `select id from work_orders where org_id = $1 and project_id = $2 and position = 'queue' and state = 'parked' and coalesce(data->>'heldByKill', '') = ''
       order by ${PRIORITY_SQL}, coalesce((data->>'bayAt')::bigint, 0), created_at, id for update skip locked`,
      [fx.orgId, projectId],
    );
    let moved = false;
    for (const c of rows) {
      const { rows: [r] } = await fx.tx.query(`select ${(await import("./model.js")).WO_COLS} from work_orders where org_id = $1 and id = $2`, [fx.orgId, c.id]);
      const { toWo } = await import("./model.js");
      const w = toWo(r);
      if (await coveringStop(fx.tx, fx.orgId, w)) continue;
      const n = await acquireSlot(fx, w, project);
      if (n === null) return started;
      w.position = "build";
      w.state = "running";
      delete w.data.bayReason;
      delete w.data.bayFrom;
      delete w.data.bayAt;
      w.data.progress = 0;
      await openHistory(fx, w, "build");
      await startAttempt(fx, w, "build");
      note(w, fx, "system", `Left the Queue for coding slot ${n}.`);
      await saveWo(fx.tx, fx.orgId, w);
      ev(fx, w, "wo.bay", { bay: null, from: "queue", station: "build", text: "Back on the belt" });
      ev(fx, w, "wo.enter", { station: "build" });
      started.push(w.id);
      moved = true;
      break;
    }
    if (!moved) break;
  }
  return started;
}

/* ----------------------------------------------------------------------------------- attempts (F3) */

export interface Attempt { id: string; fencing: number }

/** Creates the attempt for a station visit and enqueues its dispatch in the same transaction. Any live attempt for the same station is superseded first. */
export async function startAttempt(fx: Fx, w: Wo, stationId: string): Promise<Attempt> {
  await fx.tx.query(`update attempts set state = 'superseded', ended_at = $4, updated_at = now(), version = version + 1 where org_id = $1 and wo_id = $2 and station = $3 and state in ('queued','running')`, [fx.orgId, w.id, stationId, fx.now]);
  const visit = Number((await fx.tx.query(`select coalesce(max(visit), 0) + 1 as v from attempts where org_id = $1 and wo_id = $2 and station = $3`, [fx.orgId, w.id, stationId])).rows[0].v);
  const id = `ATT-${w.id}-${stationId}-${visit}`;
  const { rows } = await fx.tx.query<{ fencing: string }>(
    `insert into attempts (org_id, id, wo_id, station, visit, state, data) values ($1,$2,$3,$4,$5,'queued',$6::jsonb) returning fencing`,
    [fx.orgId, id, w.id, stationId, visit, JSON.stringify({ agent: openEntry(w)?.agent ?? stationDef(fx.catalog, stationId)?.agent ?? "" })],
  );
  const fencing = Number(rows[0]!.fencing);
  fx.jobs.push(job("attempt.dispatch", { woId: w.id, station: stationId, attemptId: id, fencing }, { dedupeKey: `attempt:${id}` }));
  fx.changes.add("floor");
  return { id, fencing };
}

export interface AttemptRow { id: string; wo_id: string; station: string; fencing: string; state: string; visit: number; lease_until: Date | null; data: Data }

/** F3: an attempt is current while it is the live one for its station and no stop covering it has taken a higher fencing number since it began. */
export async function attemptIsCurrent(db: Pick<Tx, "query">, orgId: string, attemptId: string, fencing: number): Promise<{ current: boolean; reason: string; attempt: AttemptRow | null }> {
  const { rows } = await db.query<AttemptRow & { project_id: string; repo_id: string | null; parent_id: string | null }>(
    `select a.id, a.wo_id, a.station, a.fencing, a.state, a.visit, a.lease_until, a.data, w.project_id, w.repo_id, w.parent_id from attempts a join work_orders w on w.org_id = a.org_id and w.id = a.wo_id where a.org_id = $1 and a.id = $2`,
    [orgId, attemptId],
  );
  const a = rows[0];
  if (!a) return { current: false, reason: "No such attempt.", attempt: null };
  if (Number(a.fencing) !== fencing) return { current: false, reason: "That attempt was superseded (fencing number differs).", attempt: a };
  if (a.state !== "queued" && a.state !== "running") return { current: false, reason: `That attempt is ${a.state}.`, attempt: a };
  const s = await db.query(
    `select 1 from stops where org_id = $1 and fencing > $2 and (scope_type = 'factory' or (scope_type = 'project' and project_id = $3) or (scope_type = 'repo' and repo_id = $4) or (scope_type = 'wo' and (wo_id = $5 or wo_id = $6))) limit 1`,
    [orgId, fencing, a.project_id, a.repo_id, a.wo_id, a.parent_id],
  );
  if (s.rowCount) return { current: false, reason: "A stop superseded that attempt.", attempt: a };
  return { current: true, reason: "", attempt: a };
}

/** Runner heartbeat: extends the lease of the current attempt. Returns false for a superseded one, so the wrapper stops. */
export async function heartbeatAttempt(tx: Tx, orgId: string, attemptId: string, fencing: number, o: { holder: string; leaseMs: number; now?: Date }): Promise<{ ok: boolean; reason: string }> {
  const cur = await attemptIsCurrent(tx, orgId, attemptId, fencing);
  if (!cur.current) return { ok: false, reason: cur.reason };
  const now = o.now ?? new Date();
  await tx.query(
    `update attempts set state = 'running', lease_holder = $3, lease_until = $4, started_at = coalesce(started_at, $5), updated_at = now(), version = version + 1 where org_id = $1 and id = $2`,
    [orgId, attemptId, o.holder, new Date(now.getTime() + o.leaseMs), now],
  );
  return { ok: true, reason: "" };
}

/* ----------------------------------------------------------------------------------- gates */

const instId = (woId: string, gateId: string, n: number): string => `${woId}:${gateId}:${n}`;

export async function openInstance(tx: Tx, orgId: string, w: Wo, gateId: string, o: { station: string | null; flowVersion: number; headSha?: string | null; basis?: Data; now: Date }): Promise<string> {
  const n = Number((await tx.query(`select count(*) + 1 as n from gate_instances where org_id = $1 and wo_id = $2 and gate_id = $3`, [orgId, w.id, gateId])).rows[0].n);
  const id = instId(w.id, gateId, n);
  const rule = (await tx.query<{ current_version: number | null }>(`select current_version from approver_rules where org_id = $1 and project_id = $2 and gate_id = $3`, [orgId, w.project, gateId])).rows[0];
  const pol = (await tx.query<{ v: number | null }>(`select max(current_version) as v from policies where org_id = $1 and enabled and deleted_at is null`, [orgId])).rows[0];
  await tx.query(
    `insert into gate_instances (org_id, id, wo_id, gate_id, station, status, flow_version, rule_version, policy_version, head_sha, basis, opened_at) values ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10::jsonb,$11)`,
    [orgId, id, w.id, gateId, o.station, o.flowVersion, rule?.current_version ?? null, pol?.v ?? null, o.headSha ?? null, JSON.stringify(o.basis ?? {}), o.now],
  );
  delete (w.data.gateStatus ??= {})[gateId];
  return id;
}

export async function openInstanceOf(tx: Tx, orgId: string, woId: string, gateId: string): Promise<{ id: string; opened_at: Date; basis: Data; flow_version: number; rule_version: number | null; policy_version: number | null; head_sha: string | null; station: string | null } | null> {
  const { rows } = await tx.query(`select id, opened_at, basis, flow_version, rule_version, policy_version, head_sha, station from gate_instances where org_id = $1 and wo_id = $2 and gate_id = $3 and status = 'open' for update`, [orgId, woId, gateId]);
  return rows[0] ?? null;
}

export type CloseReason = "decision" | "send_back" | "kill" | "new_head";

export async function closeInstance(fx: Fx, id: string, reason: CloseReason): Promise<void> {
  await fx.tx.query(`update gate_instances set status = 'closed', closed_reason = $3, closed_at = $4, version = version + 1, updated_at = now() where org_id = $1 and id = $2 and status = 'open'`, [fx.orgId, id, reason, fx.now]);
  await cancel(fx.tx, { orgId: fx.orgId, subject: id });
}

/** Closes every open gate instance of a work order (send-back, stop, new head commit) with the given reason. */
export async function closeOpenInstances(fx: Fx, woId: string, reason: CloseReason): Promise<number> {
  const { rows } = await fx.tx.query<{ id: string }>(`select id from gate_instances where org_id = $1 and wo_id = $2 and status = 'open' for update`, [fx.orgId, woId]);
  for (const r of rows) await closeInstance(fx, r.id, reason);
  return rows.length;
}

/** Marks passed instances of the gates at or after a station as reset (a send-back makes them pending again). */
export async function resetGatesFrom(fx: Fx, w: Wo, project: Project, fromStation: string): Promise<void> {
  const r = route(fx.catalog, project, w.cls);
  const idx = r.indexOf(fromStation);
  const gids = fx.catalog.gates.filter((g) => g.id !== "G0G1" && r.indexOf(g.after) >= idx && r.indexOf(g.after) >= 0).map((g) => g.id);
  if (!gids.length) return;
  await fx.tx.query(`update gate_instances set basis = basis || '{"reset": true}'::jsonb, updated_at = now() where org_id = $1 and wo_id = $2 and gate_id = any($3::text[]) and status = 'closed'`, [fx.orgId, w.id, gids]);
  const gs = (w.data.gateStatus ??= {}) as Record<string, string>;
  for (const g of gids) delete gs[g];
}

/** Escalation timer for a waiting gate (F7: timers are rows, so a restart loses nothing). */
async function scheduleEscalation(fx: Fx, w: Wo, project: Project, gateId: string, instance: string): Promise<void> {
  const h = Number(project.approvers[gateId]?.escalateH) || 0;
  if (!h) return;
  await schedule(fx.tx, {
    orgId: fx.orgId, kind: "flow.timer", fireAt: new Date(fx.now.getTime() + h * 3_600_000), subject: instance, dedupeKey: `escalation:${instance}`, payload: { kind: "escalation", woId: w.id, gateInstanceId: instance },
  });
}

export async function loadOne(fx: Fx, w: Wo, project?: Project): Promise<WorkOrder> {
  const projects = project ? [project] : [await projectOf(fx, w.project)];
  const [wo] = await buildWorkOrders(fx.tx, fx.orgId, fx.catalog, projects, { ids: [w.id] });
  return wo as WorkOrder;
}

export const pinned = async (fx: Fx, w: Wo): Promise<Project> => {
  const p = await projectOf(fx, w.project);
  return pinnedProject(p, await loadFlowDocs(fx.tx, fx.orgId, [w]), w);
};

/* ----------------------------------------------------------------------------------- the machine */

/** Puts a work order at a station: Intake waits on its conversation and brief; other stations get a run (Build first needs a coding slot). */
export async function enterStation(fx: Fx, w: Wo, stationId: string, o: { project?: Project; entryNote?: string } = {}): Promise<void> {
  const project = o.project ?? (await pinned(fx, w));
  const live = await projectOf(fx, w.project);
  delete w.data.bayReason;
  delete w.data.bayFrom;
  delete w.data.bayAt;
  w.data.blockReason = null;
  w.data.failReason = null;
  if (stationId === "intake") {
    w.position = "intake";
    w.state = "waiting";
    await releaseSlot(fx, w);
    await openHistory(fx, w, "intake");
    const wasOpen = await openInstanceOf(fx.tx, fx.orgId, w.id, "G0G1");
    if (!wasOpen) await openInstance(fx.tx, fx.orgId, w, "G0G1", { station: "intake", flowVersion: w.flowVersion, now: fx.now });
    ev(fx, w, "wo.enter", { station: "intake" });
    return;
  }
  if (stationId === "build") {
    const n = await acquireSlot(fx, w, live);
    if (n === null) {
      w.position = "queue";
      w.data.bayFrom = "build";
      w.data.bayReason = "Waiting for a free coding slot";
      w.data.bayAt = fx.now.getTime();
      w.state = "parked";
      note(w, fx, "system", "Waiting in the Queue for a coding slot.");
      ev(fx, w, "wo.bay", { bay: "queue", from: null, station: "build", text: "Waiting for a free coding slot" });
      return;
    }
  } else {
    await releaseSlot(fx, w);
  }
  w.position = stationId;
  w.state = "running";
  w.data.progress = 0;
  await openHistory(fx, w, stationId);
  await startAttempt(fx, w, stationId);
  if (o.entryNote) note(w, fx, fx.actor, o.entryNote);
  ev(fx, w, "wo.enter", { station: stationId });
  void project;
}

/** The brief says an epic splits into children after Plan: creates them, each skipping straight to Build (spec 9.6). The parent waits until every child is closed. */
async function splitEpic(fx: Fx, w: Wo, project: Project, by: string): Promise<void> {
  const names = (w.data.brief?.children as string[] | undefined) ?? [];
  const ids: string[] = [];
  const { newWoId, createWorkOrder } = await import("./create.js");
  for (const name of names) {
    const id = await newWoId(fx.tx);
    await createWorkOrder(fx, {
      id, project: project.id, repo: w.repo ?? "", title: `${w.title}: ${name}`, description: `Child of ${w.id}. ${name} part of the epic.`, forceCls: "feature", requestedBy: w.submitter ?? by, source: "epic", parent: w.id, childOf: { by, parent: w.id },
    });
    ids.push(id);
  }
  let ord = 0;
  for (const id of ids) await fx.tx.query(`insert into epic_children (org_id, epic_id, child_id, ord) values ($1,$2,$3,$4)`, [fx.orgId, w.id, id, ord++]);
  closeEntry(w, fx, "split");
  w.state = "waiting";
  w.data.split = true;
  w.data.blockReason = `Waiting for ${ids.join(", ")} to finish.`;
  w.data.children = ids;
  note(w, fx, by, `Split into ${ids.join(", ")}.`);
  ev(fx, w, "wo.split", { text: ids.join(", ") });
}

/** Moves past the current station: the next one on the route, the release gate, or finish. */
export async function advance(fx: Fx, w: Wo, by: string, project?: Project): Promise<void> {
  const p = project ?? (await pinned(fx, w));
  const sid = stationIdOf(fx.catalog, w);
  const idx = fx.catalog.stations.findIndex((s) => s.id === sid);
  if (w.cls === "epic" && sid === "plan" && Array.isArray(w.data.brief?.children) && w.data.brief.children.length && !w.data.split) return splitEpic(fx, w, p, by);
  const next = nextStationId(fx.catalog, p, { cls: w.cls, station: idx });
  if (!next) {
    const g6 = routeGates(fx.catalog, p, w.cls).includes("G6");
    const passedG6 = (await fx.tx.query(`select 1 from gate_instances i join gate_decisions d on d.org_id = i.org_id and d.gate_instance_id = i.id where i.org_id = $1 and i.wo_id = $2 and i.gate_id = 'G6' and coalesce((i.basis->>'reset')::boolean, false) = false`, [fx.orgId, w.id])).rowCount;
    if (g6 && !passedG6 && !(await openInstanceOf(fx.tx, fx.orgId, w.id, "G6"))) {
      await openGate(fx, w, "G6", { project: p });
      return;
    }
    return finish(fx, w, by);
  }
  await enterStation(fx, w, next, { project: p });
}

/** A station finished: run the gate behind it, if the class passes one, otherwise advance. `checks` are the observed results for automatic and mixed gates. */
export async function arriveAtGate(fx: Fx, w: Wo, by: string, o: { checks?: Array<{ name: string; ok: boolean; warn?: boolean; note?: string }>; headSha?: string | null; project?: Project } = {}): Promise<void> {
  const project = o.project ?? (await pinned(fx, w));
  const sid = stationIdOf(fx.catalog, w);
  const g = gateAfter(fx.catalog, sid);
  if (!g || !routeGates(fx.catalog, project, w.cls).includes(g.id)) return advance(fx, w, by, project);
  return openGate(fx, w, g.id, { project, ...(o.checks ? { checks: o.checks } : {}), ...(o.headSha !== undefined ? { headSha: o.headSha } : {}) });
}

/** Opens a gate instance and, for automatic and mixed gates, judges the checks (spec 9.5). Trust levels above L1 are off by default, so a human gate always waits. */
export async function openGate(fx: Fx, w: Wo, gateId: string, o: { project?: Project; checks?: Array<{ name: string; ok: boolean; warn?: boolean; note?: string }>; headSha?: string | null } = {}): Promise<void> {
  const project = o.project ?? (await pinned(fx, w));
  const g = gateDef(fx.catalog, gateId);
  if (!g) throw new Error(`unknown gate ${gateId}`);
  const kind = gateKind(fx.catalog, project, gateId);
  const sid = stationIdOf(fx.catalog, w);
  const tags = riskTagsOf({ files: (w.data.files as WorkOrder["files"]) ?? [], paths: (w.data.paths as string[]) ?? [], risk: w.risk ?? "normal" });
  const checks: Array<{ name: string; ok: boolean; warn?: boolean; note?: string }> = o.checks ?? (Array.isArray((w.data.gateChecks ?? {})[gateId]) ? (w.data.gateChecks[gateId] as Array<{ name: string; ok: boolean }>) : g.checks.map((c) => ({ name: c, ok: true })));
  const instance = await openInstance(fx.tx, fx.orgId, w, gateId, { station: sid, flowVersion: w.flowVersion, headSha: o.headSha ?? null, basis: { riskTags: tags, forcedHuman: tags.length > 0, checks, required: Math.max(1, Number(project.approvers[gateId]?.required) || 1) }, now: fx.now });
  if (kind === "auto" || kind === "mixed") {
    (w.data.gateChecks ??= {})[gateId] = checks;
    const failed = checks.some((c) => !c.ok && !c.warn);
    if (failed) {
      await closeInstance(fx, instance, "decision");
      await fx.tx.query(`insert into gate_decisions (org_id, id, gate_instance_id, wo_id, decision, rule, flow_version, detail, at) values ($1,$2,$3,$4,'auto_failed',$5,$6,$7::jsonb,$8)`, [fx.orgId, `GD-${instance}`, instance, w.id, `AUTO-${gateId}`, w.flowVersion, JSON.stringify({ checks, mode: "auto" }), fx.now]);
      (w.data.gateStatus ??= {})[gateId] = "failed";
      closeEntry(w, fx, `failed at ${g.label}`);
      if (gateId === "G3G3s") {
        w.position = "sechold";
        w.data.bayFrom = sid;
        w.data.bayAt = fx.now.getTime();
        w.data.bayReason = `${g.label} check failed: ${checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}.`;
        w.state = "parked";
        await releaseSlot(fx, w);
        ev(fx, w, "wo.bay", { bay: "sechold", from: null, station: sid, text: String(w.data.bayReason) });
        // Spec 13.3: a security finding drops the cell that produced this work to L1 at once.
        await demoteForBreach(fx.tx, fx.orgId, { woId: w.id, kind: "security", gateId, text: String(w.data.bayReason) }, fx.now, (e) => fx.events.push(e));
      } else {
        w.state = "failed";
        w.data.failReason = `${g.label}: required check '${checks.find((c) => !c.ok)?.name ?? g.name}' failed on ${w.repo ?? "the repo"}.`;
        ev(fx, w, "wo.state", { from: "running", to: "failed", station: sid, text: String(w.data.failReason) });
      }
      note(w, fx, "system", `${g.label} check failed.`);
      ev(fx, w, "gate.check", { gate: gateId, text: "failed" }, { category: "approvals", outcome: "failed" });
      await saveWo(fx.tx, fx.orgId, w);
      return;
    }
    if (kind === "auto") {
      await closeInstance(fx, instance, "decision");
      await fx.tx.query(`insert into gate_decisions (org_id, id, gate_instance_id, wo_id, decision, rule, flow_version, detail, at) values ($1,$2,$3,$4,'auto_passed',$5,$6,$7::jsonb,$8)`, [fx.orgId, `GD-${instance}`, instance, w.id, `AUTO-${gateId}`, w.flowVersion, JSON.stringify({ checks, mode: "auto" }), fx.now]);
      note(w, fx, "system", `${g.label} ${g.name} passed automatically.`);
      ev(fx, w, "gate.decision", { gate: gateId, mode: "auto", trust: null }, { category: "approvals" });
      closeEntry(w, fx, "passed");
      return advance(fx, w, "system", project);
    }
  }
  // Spec 13.3: a cell that has earned L2 or L3 (those levels are switched off in a new install) lets this gate pass without a person, except where a person always decides.
  if (kind === "human" || kind === "mixed") {
    const gr = (w.data.guardrail ?? {}) as { over?: boolean; protectedTouched?: unknown[] };
    const t = await trustDecision(fx.tx, fx.orgId, fx.catalog, { woId: w.id, gateId, instance, cls: w.cls, project: w.project, repo: w.repo, source: w.source, data: w.data, riskTags: tags, guardrailBreach: !!gr.over || (gr.protectedTouched?.length ?? 0) > 0, now: fx.now });
    if (t.auto) {
      await closeInstance(fx, instance, "decision");
      await fx.tx.query(
        `insert into gate_decisions (org_id, id, gate_instance_id, wo_id, decision, rule, flow_version, trust_grant_id, trust_level, detail, at) values ($1,$2,$3,$4,'auto_passed',$5,$6,$7,$8,$9::jsonb,$10)`,
        [fx.orgId, `GD-${instance}`, instance, w.id, `TRUST-${gateId}`, w.flowVersion, t.grantId, `L${t.level}`, JSON.stringify({ mode: "trust", checks, trustLevelNum: t.level, trustCell: t.cellId, sampled: false, reason: t.reason }), fx.now],
      );
      note(w, fx, "system", `${g.label} ${g.name} passed under trust (L${t.level}).`);
      ev(fx, w, "gate.decision", { gate: gateId, mode: "trust", trust: t.level, instance }, { category: "approvals" });
      ev(fx, w, "trust.auto", { gate: gateId, trust: t.level, text: t.reason, cell: t.cellId }, { category: "approvals" });
      fx.changes.add("trust");
      closeEntry(w, fx, "passed");
      return advance(fx, w, "system", project);
    }
    if (t.level >= 2) await fx.tx.query(`update gate_instances set basis = basis || $3::jsonb where org_id = $1 and id = $2`, [fx.orgId, instance, JSON.stringify({ trustNote: t.reason, ...(t.sampled ? { sampled: true } : {}) })]);
  }
  w.state = "waiting";
  w.data.blockReason = null;
  closeEntry(w, fx, "waiting");
  await scheduleEscalation(fx, w, project, gateId, instance);
  note(w, fx, openEntry(w)?.agent ?? "system", `Waiting at ${g.label} ${g.name}.`);
  await saveWo(fx.tx, fx.orgId, w);
  ev(fx, w, "gate.waiting", { gate: gateId, text: g.name }, { category: "approvals" });
  fx.changes.add("home");
}

/** Release and close: the work order is done. A parent epic completes when every child is closed. */
export async function finish(fx: Fx, w: Wo, by: string): Promise<void> {
  closeEntry(w, fx, "released");
  w.state = "done";
  w.closedAt = fx.now;
  w.data.progress = 100;
  await releaseSlot(fx, w);
  await closeOpenInstances(fx, w.id, "decision");
  note(w, fx, by, "Released and confirmed.");
  await saveWo(fx.tx, fx.orgId, w);
  ev(fx, w, "release", { text: w.title, mode: "human" }, { category: "approvals" });
  // Spec 13.3: the finished work order is evidence for the cells it went through; two failures in the last ten reviewed runs demote, and met criteria are proposed.
  await trustAfterFinish(fx.tx, fx.orgId, w.id, fx.now, (e) => fx.events.push(e));
  fx.changes.add("trust");
  if (w.parentId) await completeParentIfDone(fx, w.parentId, by);
  await dispatchQueued(fx, w.project);
}

async function completeParentIfDone(fx: Fx, parentId: string, by: string): Promise<void> {
  const open = await fx.tx.query(`select 1 from work_orders where org_id = $1 and parent_id = $2 and state not in ('done') limit 1`, [fx.orgId, parentId]);
  if (open.rowCount) return;
  const { lockWo } = await import("./model.js");
  const parent = await lockWo(fx.tx, fx.orgId, parentId);
  if (parent.state === "done" || parent.state === "killed") return;
  parent.state = "done";
  parent.closedAt = fx.now;
  parent.data.progress = 100;
  parent.data.blockReason = null;
  note(parent, fx, by, "Every child work order is closed.");
  await saveWo(fx.tx, fx.orgId, parent);
  ev(fx, parent, "wo.state", { from: "waiting", to: "done" });
}

/* ----------------------------------------------------------------------------------- votes and decisions */

export interface Voter { personId: string; via: string; channel: string }

/** The pinned versions in force when a gate is decided (spec 7.1, 9.5), stored with the decision. */
export async function recordDecision(fx: Fx, w: Wo, inst: { id: string; opened_at: Date; basis: Data; flow_version: number; rule_version: number | null; policy_version: number | null; head_sha: string | null; station: string | null },
  gateId: string, decision: "approved" | "rejected", by: Voter, o: { reason?: string; approvals?: number; override?: boolean } = {}): Promise<void> {
  const tuple = (
    await fx.tx.query<{ id: string; agent_version: number; skill_versions: unknown; instruction_hash: string; model_id: string }>(
      `select t.id, t.agent_version, t.skill_versions, t.instruction_hash, t.model_id from attempts a join agent_version_tuples t on t.org_id = a.org_id and t.id = a.tuple_id where a.org_id = $1 and a.wo_id = $2 and a.station = $3 order by a.visit desc limit 1`,
      [fx.orgId, w.id, inst.station ?? ""],
    )
  ).rows[0];
  const ra = (
    await fx.tx.query<{ id: string; role_id: string }>(
      `select id, role_id from effective_role_assignments where org_id = $1 and person_id = $2 and revoked_at is null and (expires_at is null or expires_at > now()) and (project_id = $3 or project_id is null) order by (project_id is null), created_at limit 1`,
      [fx.orgId, by.personId, w.project],
    )
  ).rows[0];
  // Spec 13.1: the trust level in force at the decision, and the grant it came from (a cell capped by a ceiling, or held at L1 while levels above L1 are off, runs lower than it was granted).
  const lvl = await trustInForce(fx.tx, fx.orgId, fx.catalog, { gateId, cls: w.cls, project: w.project, repo: w.repo ?? null });
  const votes = (await fx.tx.query<{ voter: string; vote: string; at: Date }>(`select voter, vote, at from gate_votes where org_id = $1 and gate_instance_id = $2 order by at, id`, [fx.orgId, inst.id])).rows;
  const pr = (await fx.tx.query<{ head_sha: string | null }>(`select head_sha from pull_requests where org_id = $1 and wo_id = $2 order by number desc limit 1`, [fx.orgId, w.id])).rows[0];
  const policies = Object.fromEntries((await fx.tx.query<{ id: string; v: number | null }>(`select id, current_version as v from policies where org_id = $1 and enabled and deleted_at is null`, [fx.orgId])).rows.map((r) => [r.id, r.v]));
  await fx.tx.query(
    `insert into gate_decisions (org_id, id, gate_instance_id, wo_id, decision, decided_by, rule, flow_version, gate_rule_version, policy_version, trust_level, role_assignment_id, tuple_id, agent_version, skill_versions, instruction_hash, model_id, commit_sha, detail, at, trust_grant_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19::jsonb,$20,$21)`,
    [
      fx.orgId, `GD-${inst.id}`, inst.id, w.id, decision, by.personId, `APR-${gateId}`, inst.flow_version, inst.rule_version, inst.policy_version, `L${lvl.effective}`, ra?.id ?? null, tuple?.id ?? null, tuple?.agent_version ?? null,
      tuple ? JSON.stringify(tuple.skill_versions) : null, tuple?.instruction_hash ?? null, tuple?.model_id ?? null, inst.head_sha ?? pr?.head_sha ?? null,
      JSON.stringify({
        mode: "human", channel: by.channel, via: by.via, reason: o.reason ?? "", reasonCode: decision === "approved" ? "approved" : "rejected", timeToDecideMs: fx.now.getTime() - (ms(inst.opened_at) ?? fx.now.getTime()),
        voters: votes.map((v) => ({ by: v.voter, vote: v.vote, at: ms(v.at) })), approvals: o.approvals ?? votes.filter((v) => v.vote === "approve").length, riskTags: inst.basis.riskTags ?? [], samplingReason: inst.basis.forcedHuman ? "risk-triggered" : inst.basis.sampled ? "sampled" : "gated", artefactEdited: null, reviewSurface: null, policies, trustLevelNum: lvl.effective, trustGranted: lvl.granted, trustCell: lvl.cellId,
        ...(o.override ? { override: true, overrideBy: "factory_admin" } : {}),
      }),
      fx.now,
      lvl.grantId,
    ],
  );
}

export function progressFor(project: Project, wo: WorkOrder, gateId: string, people: Person[]) {
  return gateProgress(project, wo, gateId, people);
}

export { bayOf, stationIdOf };

/* ----------------------------------------------------------------------------------- shared helpers for the commands */

/** Cancels the work order's live attempts (send-back, park, decline, stop). The run tokens are revoked in the same transaction, so the edge refuses the run on its next call and the reaper removes the sandbox. */
export async function cancelAttempts(fx: Fx, w: Pick<Wo, "id">, reason: string): Promise<number> {
  const r = await fx.tx.query(
    `update attempts set state = 'cancelled', outcome = $4, ended_at = $3, updated_at = now(), version = version + 1 where org_id = $1 and wo_id = $2 and state in ('queued','running')`,
    [fx.orgId, w.id, fx.now, reason],
  );
  if (r.rowCount) {
    await revokeRunTokens(fx.tx, { orgId: fx.orgId, woId: w.id, reason });
    fx.changes.add("floor");
  }
  return r.rowCount ?? 0;
}

export async function enterBay(fx: Fx, w: Wo, bay: string, reason: string): Promise<void> {
  await fx.tx.query(`insert into bay_stays (org_id, id, wo_id, bay, reason, entered_by, entered_at) values ($1,$2,$3,$4,$5,$6,$7)`, [fx.orgId, `BS-${w.id}-${fx.now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`, w.id, bay, reason, fx.actor, fx.now]);
}
export async function leaveBay(fx: Fx, w: Pick<Wo, "id">): Promise<void> {
  await fx.tx.query(`update bay_stays set left_at = $3, updated_at = now() where org_id = $1 and wo_id = $2 and left_at is null`, [fx.orgId, w.id, fx.now]);
}
