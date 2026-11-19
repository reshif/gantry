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
  checkMatches, gateAfter, gateDef, gateKind, gateProgress, requiredFor, nextStationId, riskTagsOf, route, routeGates, stationDef,
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
import { editedByPeople } from "./documents.js";
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
  // The limit counts live holders, not slot numbers: after the limit is lowered, holders on numbers above it still count (S-33). The project's slot table is serialised so two dispatches cannot both see room for one.
  await fx.tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`slots:${fx.orgId}:${project.id}`]);
  const holders = Number((await fx.tx.query<{ n: string }>(`select count(*) n from slots where org_id = $1 and project_id = $2 and state = 'held'`, [fx.orgId, project.id])).rows[0]?.n ?? 0);
  if (holders >= limit) return null;
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
  // A one-off limit raise a person approved applies to this attempt only: it moves from the work order onto the attempt, and is gone for the next one.
  const pending = w.data.limitRaise as { station?: string } | undefined;
  const raise = pending && (!pending.station || pending.station === stationId) ? pending : null;
  if (raise) delete w.data.limitRaise;
  const { rows } = await fx.tx.query<{ fencing: string }>(
    `insert into attempts (org_id, id, wo_id, station, visit, state, data) values ($1,$2,$3,$4,$5,'queued',$6::jsonb) returning fencing`,
    [fx.orgId, id, w.id, stationId, visit, JSON.stringify({ agent: openEntry(w)?.agent ?? stationDef(fx.catalog, stationId)?.agent ?? "", ...(raise ? { limitRaise: raise } : {}) })],
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
  // A swarm still open when the work order enters a station again (a halt and resume, a send-back) is over: its live scouts count as stopped.
  const sw = w.data.swarm as { endedAt?: number; scouts?: Array<{ state: string }> } | undefined;
  if (sw && !sw.endedAt) {
    sw.endedAt = fx.now.getTime();
    for (const sc of sw.scouts ?? []) if (sc.state === "queued" || sc.state === "running") sc.state = "stopped";
  }
  const project = o.project ?? (await pinned(fx, w));
  const live = await projectOf(fx, w.project);
  delete w.data.bayReason;
  delete w.data.bayFrom;
  delete w.data.bayAt;
  delete w.data.bayCause;
  delete w.data.failPhase;
  delete w.data.limitStop;
  // A pending raise is for the next attempt at its own station only.
  if (w.data.limitRaise && (w.data.limitRaise as { station?: string }).station !== stationId) w.data.limitRaise = undefined;
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
    // The Plan agent writes each child as "Title: one-line goal"; the title and the goal are its words, not Gantry's.
    const [t, ...g] = name.split(":");
    const goal = g.join(":").trim();
    await createWorkOrder(fx, {
      id, project: project.id, repo: w.repo ?? "", title: `${w.title}: ${(g.length ? t! : name).trim()}`, description: `Child of ${w.id} (${w.title}).${goal ? ` ${goal}` : g.length ? "" : ` ${name}`}`, forceCls: "feature", requestedBy: w.submitter ?? by, source: "epic", parent: w.id, childOf: { by, parent: w.id },
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
  // An epic with no split is never silently built as one work order: Gantry asks a person (who may add children to the brief or send it back to the Plan agent).
  if (w.cls === "epic" && sid === "plan" && !w.data.split && !(Array.isArray(w.data.brief?.children) && w.data.brief.children.length)) {
    const { parkInto } = await import("./intake.js");
    note(w, fx, "system", "The plan did not split this epic into child work orders.");
    return parkInto(fx, w, "person", "This epic has no split into child work orders. Add children to the brief, or return it to Plan so the Plan agent proposes one.");
  }
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

export type GateCheck = { name: string; ok: boolean; warn?: boolean; note?: string };
export type GateEvidenceSource = "observed" | "person" | "github" | "none";
/** Where an automatic gate's checks came from, recorded on the instance and its decision (GitHub check ids make the verdict traceable). */
export interface GateEvidence { source: GateEvidenceSource; headSha?: string; githubCheckIds?: Array<number | string> }

const CI_PASS = new Set(["success", "neutral", "skipped"]);

/**
 * The real CI results for a work order's pull request head (spec 9.5, G4 "Required checks"): the repository's required checks; with none configured
 * there is no complete set to judge, so there is no evidence. A completed check that did not succeed fails the gate; a required check that is missing or still running is
 * no evidence yet (null), so the gate waits for a person. Fails closed.
 */
async function ciEvidence(fx: Fx, w: Wo, headSha: string | null): Promise<{ checks: GateCheck[]; evidence: GateEvidence } | null> {
  const pr = (await fx.tx.query<{ repo_id: string; head_sha: string | null }>(`select repo_id, head_sha from pull_requests where org_id = $1 and wo_id = $2 and state = 'open' order by number desc limit 1`, [fx.orgId, w.id])).rows[0];
  const sha = headSha ?? pr?.head_sha ?? null;
  if (!pr || !sha) return null;
  const rows = (await fx.tx.query<{ name: string; status: string; conclusion: string | null; github_id: string | null }>(`select name, status, conclusion, github_id::text from checks where org_id = $1 and repo_id = $2 and head_sha = $3`, [fx.orgId, pr.repo_id, sha])).rows;
  const required = (await fx.tx.query<{ required_checks: string[] }>(`select required_checks from repo_config where org_id = $1 and repo_id = $2`, [fx.orgId, pr.repo_id])).rows[0]?.required_checks ?? [];
  // Without required checks there is no way to know the set is complete (a fast check may report before the others exist), so a person decides.
  if (!required.length) return null;
  const names = required;
  const checks: GateCheck[] = [];
  const ids: Array<number | string> = [];
  let unsettled = false;
  for (const name of names) {
    const r = rows.find((x) => x.name === name) ?? rows.find((x) => checkMatches(name, x.name));
    if (!r || r.status !== "completed") {
      unsettled = true;
      continue;
    }
    if (r.github_id) ids.push(r.github_id);
    const ok = !!r.conclusion && CI_PASS.has(r.conclusion);
    checks.push({ name, ok, note: `GitHub check ${r.github_id ?? "?"}: ${r.conclusion ?? "no conclusion"}` });
  }
  if (!checks.some((c) => !c.ok) && unsettled) return null;
  return { checks, evidence: { source: "github", headSha: sha, githubCheckIds: ids } };
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
export async function openGate(fx: Fx, w: Wo, gateId: string, o: { project?: Project; checks?: Array<{ name: string; ok: boolean; warn?: boolean; note?: string }>; headSha?: string | null; evidence?: GateEvidenceSource } = {}): Promise<void> {
  const project = o.project ?? (await pinned(fx, w));
  const g = gateDef(fx.catalog, gateId);
  if (!g) throw new Error(`unknown gate ${gateId}`);
  const kind = gateKind(fx.catalog, project, gateId);
  const sid = stationIdOf(fx.catalog, w);
  const tags = riskTagsOf({ files: (w.data.files as WorkOrder["files"]) ?? [], paths: (w.data.paths as string[]) ?? [], risk: w.risk ?? "normal" });
  // Spec 13.3: a change that is over its agent's diff limit or touches a forbidden or protected path is decided by a person, on any gate, and the cell drops to L1.
  const gr = (w.data.guardrail ?? {}) as { over?: boolean; size?: number; protectedTouched?: string[]; forbiddenTouched?: string[] };
  const breach = [...(gr.forbiddenTouched ?? []), ...(gr.protectedTouched ?? [])];
  const guardrailBreach = !!gr.over || breach.length > 0;
  if (guardrailBreach) await demoteForBreach(fx.tx, fx.orgId, { woId: w.id, kind: "guardrail", gateId, text: gr.over && !breach.length ? `The diff is ${gr.size} lines, over the agent's limit.` : `The change touches guarded paths: ${breach.slice(0, 5).join(", ")}.` }, fx.now, (e) => fx.events.push(e));
  // Evidence comes from the system, never from the agent's own report: checks the worker observed, a person's release, or the GitHub check runs
  // stored for this pull request's head. Nothing else counts, and no evidence is not a pass: an automatic gate then waits for a person.
  // An empty list is not observed evidence: an automatic gate with zero checks must never pass on it.
  const given = o.checks?.length ? o.checks : undefined;
  let checks: GateCheck[] = given ?? [];
  let evidence: GateEvidence = given ? { source: o.evidence ?? "observed" } : { source: "none" };
  if (!given && (kind === "auto" || kind === "mixed") && gateId === "G1f") {
    // Feasibility: judged from what the system holds, a research document a station wrote and no blocking question still open, not from the agent's claim.
    const note_ = (await fx.tx.query(`select 1 from artefacts where org_id = $1 and wo_id = $2 and station = 'research' and doc is not null and author_kind <> 'system' limit 1`, [fx.orgId, w.id])).rowCount;
    const blocking = (await fx.tx.query(`select 1 from wo_questions where org_id = $1 and wo_id = $2 and blocking and status = 'open' limit 1`, [fx.orgId, w.id])).rowCount;
    checks = [{ name: "Research note attached", ok: !!note_ }, { name: "No blocking unknowns", ok: !blocking }];
    evidence = { source: "observed" };
  }
  if (!given && (kind === "auto" || kind === "mixed") && gateId === "G4") {
    const ci = await ciEvidence(fx, w, o.headSha ?? null);
    if (ci) {
      checks = ci.checks;
      evidence = ci.evidence;
    }
  }
  const instance = await openInstance(fx.tx, fx.orgId, w, gateId, { station: sid, flowVersion: w.flowVersion, headSha: o.headSha ?? null, basis: { riskTags: tags, forcedHuman: tags.length > 0 || guardrailBreach, checks, evidence, required: requiredFor(project.approvers[gateId], w.cls), ...(g.after === "review" && w.data.review ? { review: w.data.review } : {}) }, now: fx.now });
  if (kind === "auto" || kind === "mixed") {
    (w.data.gateChecks ??= {})[gateId] = checks;
    const failed = checks.some((c) => !c.ok && !c.warn);
    if (failed) {
      await closeInstance(fx, instance, "decision");
      await fx.tx.query(`insert into gate_decisions (org_id, id, gate_instance_id, wo_id, decision, rule, flow_version, detail, at) values ($1,$2,$3,$4,'auto_failed',$5,$6,$7::jsonb,$8)`, [fx.orgId, `GD-${instance}`, instance, w.id, `AUTO-${gateId}`, w.flowVersion, JSON.stringify({ checks, mode: "auto", evidence }), fx.now]);
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
    // Spec 9.5: any risk tag forces a human vote, even on an automatic gate. A change to CI, dependencies, code owners, auth,
    // migrations or the tests it is judged by must not pass on checks the change itself could influence.
    if (kind === "auto" && tags.length) note(w, fx, "system", `${g.label} ${g.name} checks passed; a person must decide because the change touches ${tags.join(", ")}.`);
    if (kind === "auto" && guardrailBreach && !tags.length) note(w, fx, "system", `${g.label} ${g.name} checks passed; a person must decide because the change breaks a guardrail (${gr.over ? "diff over the limit" : breach.slice(0, 3).join(", ")}).`);
    if (kind === "auto" && !tags.length && !guardrailBreach && evidence.source === "none") note(w, fx, "system", `${g.label} ${g.name} has no verified check results to judge, so a person must decide.`);
    if (kind === "auto" && !tags.length && !guardrailBreach && evidence.source !== "none") {
      await closeInstance(fx, instance, "decision");
      await fx.tx.query(`insert into gate_decisions (org_id, id, gate_instance_id, wo_id, decision, rule, flow_version, detail, at) values ($1,$2,$3,$4,'auto_passed',$5,$6,$7::jsonb,$8)`, [fx.orgId, `GD-${instance}`, instance, w.id, `AUTO-${gateId}`, w.flowVersion, JSON.stringify({ checks, mode: "auto", evidence }), fx.now]);
      note(w, fx, "system", `${g.label} ${g.name} passed automatically.`);
      ev(fx, w, "gate.decision", { gate: gateId, mode: "auto", trust: null }, { category: "approvals" });
      closeEntry(w, fx, "passed");
      return advance(fx, w, "system", project);
    }
  }
  // Spec 13.3: a cell that has earned L2 or L3 (those levels are switched off in a new install) lets this gate pass without a person, except where a person always decides.
  if (kind === "human" || kind === "mixed") {
    const t = await trustDecision(fx.tx, fx.orgId, fx.catalog, { woId: w.id, gateId, instance, cls: w.cls, project: w.project, repo: w.repo, source: w.source, data: w.data, riskTags: tags, guardrailBreach, now: fx.now });
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

/**
 * An epic parent settles once every child has ended: done, killed, or declined. All done completes the parent. Any other mix puts the parent in Needs a person
 * with a summary of how each child ended, so it never waits for ever on a child that will not finish (the person decides: add children, return it to Plan, or
 * close it). Safe to call after any child's end and again later: a parent that is not waiting on its children is left alone.
 */
export async function completeParentIfDone(fx: Fx, parentId: string, by: string): Promise<void> {
  const kids = (await fx.tx.query<{ id: string; state: string; position: string }>(`select id, state, position from work_orders where org_id = $1 and parent_id = $2 order by id`, [fx.orgId, parentId])).rows;
  const how = (k: { state: string; position: string }): string => (k.position === "declined" ? "declined" : k.state);
  if (!kids.length || kids.some((k) => how(k) !== "done" && how(k) !== "killed" && how(k) !== "declined")) return;
  const { lockWo } = await import("./model.js");
  const parent = await lockWo(fx.tx, fx.orgId, parentId);
  if (parent.state === "done" || parent.state === "killed" || parent.position === "declined") return;
  if (kids.every((k) => how(k) === "done")) {
    if (bayOf(fx.catalog, parent)) {
      // It was waiting for a person because a child had not finished; that child finished after all (restored), so the wait is over.
      await leaveBay(fx, parent);
      parent.position = String(parent.data.bayFrom ?? "plan");
      for (const k of ["bayReason", "bayFrom", "bayAt", "bayCause"]) delete parent.data[k];
    }
    parent.state = "done";
    parent.closedAt = fx.now;
    parent.data.progress = 100;
    parent.data.blockReason = null;
    note(parent, fx, by, "Every child work order is closed.");
    await saveWo(fx.tx, fx.orgId, parent);
    ev(fx, parent, "wo.state", { from: "waiting", to: "done" });
    return;
  }
  if (bayOf(fx.catalog, parent)) return; // already waiting for a person
  const summary = kids.map((k) => `${k.id} ${how(k)}`).join(", ");
  const { parkInto } = await import("./intake.js");
  parent.data.blockReason = null;
  note(parent, fx, "system", `Every child work order has ended, but not all finished: ${summary}.`);
  await parkInto(fx, parent, "person", `Every child work order has ended, but not all of them finished (${summary}). Decide whether the epic is complete: add children to the brief, or return it to Plan so the Plan agent proposes the rest.`);
  await saveWo(fx.tx, fx.orgId, parent);
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
        voters: votes.map((v) => ({ by: v.voter, vote: v.vote, at: ms(v.at) })), approvals: o.approvals ?? votes.filter((v) => v.vote === "approve").length, riskTags: inst.basis.riskTags ?? [], samplingReason: inst.basis.forcedHuman ? "risk-triggered" : inst.basis.sampled ? "sampled" : "gated", artefactEdited: await editedByPeople(fx.tx, fx.orgId, w.id), reviewSurface: null, policies, trustLevelNum: lvl.effective, trustGranted: lvl.granted, trustCell: lvl.cellId,
        override: !!o.override, ...(o.override ? { overrideBy: "factory_admin" } : {}),
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
export async function cancelAttempts(fx: Fx, w: Pick<Wo, "id"> & { data?: Record<string, unknown> }, reason: string): Promise<number> {
  // A pending one-off limit raise belongs to the attempt the person's retry starts; a send-back, redo, park, decline or any other cancel drops it.
  if (w.data) w.data.limitRaise = undefined;
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

/**
 * S-62: a station question nobody can act on any more is closed (status dismissed, with the reason in the answer and "system" as who closed it), so it leaves the Inbox and is not counted
 * by the feasibility check of a new run. Used when the work order is declined or killed, and when it is sent back (the station asks again if it still needs to).
 */
export async function closeOpenQuestions(fx: Fx, woId: string, reason: string): Promise<number> {
  const r = await fx.tx.query(
    `update wo_questions set status = 'dismissed', answer = $3, answered_by = 'system', answered_at = $4, updated_at = $4 where org_id = $1 and wo_id = $2 and status = 'open'`,
    [fx.orgId, woId, reason, fx.now],
  );
  if (r.rowCount) fx.changes.add("home");
  return r.rowCount ?? 0;
}

export async function enterBay(fx: Fx, w: Wo, bay: string, reason: string): Promise<void> {
  await fx.tx.query(`insert into bay_stays (org_id, id, wo_id, bay, reason, entered_by, entered_at) values ($1,$2,$3,$4,$5,$6,$7)`, [fx.orgId, `BS-${w.id}-${fx.now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`, w.id, bay, reason, fx.actor, fx.now]);
}
export async function leaveBay(fx: Fx, w: Pick<Wo, "id">): Promise<void> {
  await fx.tx.query(`update bay_stays set left_at = $3, updated_at = now() where org_id = $1 and wo_id = $2 and left_at is null`, [fx.orgId, w.id, fx.now]);
}
