/** Work-order reads (spec 8.4): the list, the traveler, conversations, the floor with replay, the record and its export, and the changes. All rows are mapped to the legacy shapes the web already reads. */
import { createHash } from "node:crypto";
import {
  can, completeness, criteriaFor, effectiveStop, gateDecision, gateProgress, moveCheck, route, routeGates, stateAt, summaryText, woTotals,
  type Decision, type EventEntry, type FlowState, type MoveCheck, type Project, type WorkOrder,
} from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { loadFlowState } from "../../core/read/state.js";
import { ms, obj } from "../../core/read/rows.js";
import { projectEvents } from "../audit/read.js";
import { coveringStop, type CoveringStop } from "./engine.js";
import { buildWorkOrders, loadFlow, readWoRow, stateWithPinned, type Data } from "./model.js";

/* ------------------------------------------------------------------------- list */

export interface ListQuery {
  q?: string;
  cls?: string;
  where?: string;
  repo?: string;
  prio?: string;
  source?: string;
  state?: string;
  sort?: "id" | "title" | "cls" | "where" | "prio" | "state" | "age" | "sla";
  dir?: "asc" | "desc";
  cursor?: string;
  limit?: number;
}

const SORTS: Record<NonNullable<ListQuery["sort"]>, string> = {
  id: `nullif(regexp_replace(id, '\\D', '', 'g'), '')::bigint`, title: `lower(title)`, cls: `class`, where: `position`, prio: `priority`, state: `state`, age: `created_at`, sla: `sla_due_at`,
};

/** One page of a project's work orders in the legacy shape. Filters and sort run in SQL; `next` is an opaque cursor for the following page. */
export async function listWorkOrders(db: Queryable, orgId: string, projectId: string, q: ListQuery): Promise<{ items: WorkOrder[]; next: string | null; total: number }> {
  const params: unknown[] = [orgId, projectId];
  const where = ["org_id = $1", "project_id = $2", "source <> 'eval'"];
  if (q.q) where.push(`(id ilike $${params.push(`%${q.q.replace(/[%_]/g, "\\$&")}%`)} or title ilike $${params.length})`);
  if (q.cls && q.cls !== "all") where.push(`class = $${params.push(q.cls)}`);
  if (q.where && q.where !== "all") where.push(`position = $${params.push(q.where)}`);
  if (q.repo && q.repo !== "all") where.push(`repo_id = $${params.push(q.repo)}`);
  if (q.prio && q.prio !== "all") where.push(`priority = $${params.push(q.prio)}`);
  if (q.source && q.source !== "all") where.push(`source = $${params.push(q.source)}`);
  if (q.state && q.state !== "all") where.push(q.state === "open" ? `state not in ('done','killed','declined')` : `state = $${params.push(q.state)}`);
  const offset = q.cursor ? Math.max(0, Number.parseInt(Buffer.from(q.cursor, "base64url").toString("utf8"), 10) || 0) : 0;
  const limit = Math.min(200, Math.max(1, q.limit ?? 50));
  const dir = q.dir === "asc" ? "asc" : "desc";
  const sort = SORTS[q.sort ?? "id"] ?? SORTS.id;
  const total = Number((await db.query(`select count(*)::int as n from work_orders where ${where.join(" and ")}`, params)).rows[0].n);
  const { rows } = await db.query<{ id: string }>(
    `select id from work_orders where ${where.join(" and ")} order by ${sort} ${dir}, id ${dir} limit ${limit + 1} offset ${offset}`, params,
  );
  const ids = rows.slice(0, limit).map((r) => r.id);
  const st = await loadFlowState(db, orgId);
  const built = await buildWorkOrders(db, orgId, st.catalog, st.projects, { ids, light: true });
  const order = new Map(ids.map((id, i) => [id, i]));
  built.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { items: built, next: rows.length > limit ? Buffer.from(String(offset + limit)).toString("base64url") : null, total };
}

/* ------------------------------------------------------------------------- traveler */

export interface Traveler {
  wo: WorkOrder & { version: number };
  progress: Record<string, ReturnType<typeof gateProgress>>;
  allowed: { approve: (Decision & { gate: string; instance: string }) | null; moves: Record<string, MoveCheck>; can: Record<string, Decision> };
  stop: CoveringStop | null;
  route: string[];
}

const ACTIONS = { answer: "wo.answer", classify: "wo.classify", decline: "wo.decline", park: "wo.park", sendback: "wo.sendback", reassign: "wo.reassign", move: "wo.move", confirm: "brief.confirm", summary: "wo.answer" } as const;

/** The traveler: the work order with gate progress (N of M) and what the viewer may do next, from the live decision point. */
export async function readTraveler(db: Queryable, orgId: string, viewer: string | null, woId: string, now = Date.now()): Promise<Traveler | null> {
  const row = await readWoRow(db, orgId, woId);
  if (!row) return null;
  const loaded = await loadFlow(db, orgId, { ids: [woId] });
  const st = await stateWithPinned(db, orgId, loaded, row);
  const wo = st.workOrders[0];
  const project = st.projects.find((p) => p.id === row.project);
  if (!wo || !project) return null;
  const progress: Traveler["progress"] = {};
  for (const gid of routeGates(st.catalog, project, wo.cls)) progress[gid] = gateProgress(project, wo, gid, st.people);
  const stop = await coveringStop(db, orgId, row);
  const moves: Record<string, MoveCheck> = {};
  for (const target of [...route(st.catalog, project, wo.cls), ...(project.flow.bays ?? st.catalog.bays.map((b) => b.id))]) moves[target] = moveCheck(st, viewer, wo, target, now);
  if (stop) for (const k of Object.keys(moves)) if (moves[k]!.allowed) moves[k] = { allowed: false, reason: `${stop.reason || "Stopped"} (${stop.scope} ${stop.mode === "halt" ? "halted" : "killed"})` };
  const cans: Record<string, Decision> = {};
  for (const [k, a] of Object.entries(ACTIONS)) cans[k] = can(st, viewer, a, { project: wo.project, repo: wo.repo, time: now });
  let approve: Traveler["allowed"]["approve"] = null;
  const waiting = Object.entries(wo.gates).find(([, g]) => g.status === "waiting");
  if (waiting) {
    const inst = (await db.query<{ id: string }>(`select id from gate_instances where org_id = $1 and wo_id = $2 and gate_id = $3 and status = 'open'`, [orgId, woId, waiting[0]])).rows[0];
    const d = gateDecision(st, viewer, wo, waiting[0], now);
    approve = { ...d, gate: waiting[0], instance: inst?.id ?? `${woId}:${waiting[0]}` };
  }
  return { wo: { ...wo, version: row.version }, progress, allowed: { approve, moves, can: cans }, stop, route: route(st.catalog, project, wo.cls) };
}

/* ------------------------------------------------------------------------- conversations */

/** Intake conversations of the projects the viewer may see: the work orders with their `conv`. `awaitingMe` keeps those waiting on this person. */
export async function listConversations(db: Queryable, orgId: string, o: { projects: string[] | "all"; project?: string; awaitingMe?: string }): Promise<WorkOrder[]> {
  const params: unknown[] = [orgId];
  const where = ["c.org_id = $1", "c.kind = 'intake'", "c.wo_id is not null"];
  if (o.project) where.push(`c.project_id = $${params.push(o.project)}`);
  else if (o.projects !== "all") where.push(`c.project_id = any($${params.push(o.projects)}::text[])`);
  const ids = (await db.query<{ wo_id: string }>(`select c.wo_id from conversations c join work_orders w on w.org_id = c.org_id and w.id = c.wo_id where ${where.join(" and ")} order by c.updated_at desc limit 300`, params)).rows.map((r) => r.wo_id);
  if (!ids.length) return [];
  const st = await loadFlowState(db, orgId);
  const wos = await buildWorkOrders(db, orgId, st.catalog, st.projects, { ids });
  const order = new Map(ids.map((id, i) => [id, i]));
  wos.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return o.awaitingMe ? wos.filter((w) => w.requestedBy === o.awaitingMe && (!w.conv.done || w.conv.raised.some((r) => !r.answered)) && w.state !== "killed") : wos;
}

/* ------------------------------------------------------------------------- floor */

export interface FloorStop { mode: "halt" | "kill"; scope: string; reason: string; by: string; at: number; id: string; inFlight: string | null }

/** The floor of one project (spec 8.4): the project with its pinned-version flow, work orders at their positions, gates waiting, coding slots and stop state. With `at` it is the replay of that time. */
export async function readFloor(db: Queryable, orgId: string, projectId: string, at?: number, now = Date.now()) {
  const st = await loadFlowState(db, orgId);
  const project = st.projects.find((p) => p.id === projectId);
  if (!project) return null;
  const since = at ? Math.min(at, now) - 14 * 86_400_000 : now - 14 * 86_400_000;
  const wos = await buildWorkOrders(db, orgId, st.catalog, st.projects, { project: projectId, openOrSince: since, light: true });
  const flowVersion = Number((await db.query(`select current_flow_version as v from projects where org_id = $1 and id = $2`, [orgId, projectId])).rows[0]?.v ?? 0);
  const slotRows = (await db.query<{ id: string; wo_id: string | null; state: string }>(`select id, wo_id, state from slots where org_id = $1 and project_id = $2 order by id`, [orgId, projectId])).rows;
  const stops = (
    await db.query<{ id: string; scope_type: string; project_id: string | null; repo_id: string | null; wo_id: string | null; mode: "halt" | "kill"; reason: string; set_by: string; set_at: Date; in_flight: string | null }>(
      `select s.id, s.scope_type, s.project_id, s.repo_id, s.wo_id, s.mode, s.reason, s.set_by, s.set_at, s.in_flight from stops s
        where s.org_id = $1 and s.lifted_at is null and (s.scope_type = 'factory' or s.project_id = $2 or s.repo_id in (select id from repos where org_id = $1 and project_id = $2) or s.wo_id in (select id from work_orders where org_id = $1 and project_id = $2))
        order by case s.scope_type when 'factory' then 0 when 'project' then 1 when 'repo' then 2 else 3 end, s.set_at`,
      [orgId, projectId],
    )
  ).rows.map((s): FloorStop => ({ id: s.id, scope: s.scope_type, mode: s.mode, reason: s.reason, by: s.set_by, at: ms(s.set_at) ?? 0, inFlight: s.in_flight }));
  const waiting = (
    await db.query<{ id: string; wo_id: string; gate_id: string; opened_at: Date }>(`select i.id, i.wo_id, i.gate_id, i.opened_at from gate_instances i join work_orders w on w.org_id = i.org_id and w.id = i.wo_id where i.org_id = $1 and w.project_id = $2 and i.status = 'open' order by i.opened_at`, [orgId, projectId])
  ).rows;
  const gates = waiting.map((g) => {
    const wo = wos.find((w) => w.id === g.wo_id);
    const prog = wo ? gateProgress(project, wo, g.gate_id, st.people) : null;
    return { instance: g.id, wo: g.wo_id, gate: g.gate_id, since: ms(g.opened_at) ?? 0, ...(prog ? { have: prog.have, need: prog.need } : {}) };
  });
  const used = slotRows.filter((s) => s.state === "held").length;
  const slots = { used, total: project.flow.slots, holders: slotRows.filter((s) => s.state === "held").map((s) => ({ slot: Number(s.id.split(":").pop()), wo: s.wo_id })) };
  const queue = wos.filter((w) => w.bay === "queue" && !w.heldByKill).sort((a, b) => (a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : (a.bayAt ?? 0) - (b.bayAt ?? 0))).map((w) => w.id);
  const top = stops.slice().sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "kill" ? -1 : 1))[0] ?? null;
  const live = { project, workOrders: wos, flowVersion, slots, gates, queue, stop: top, stops, at: null as number | null };
  if (!at || at >= now) return live;

  // Replay: positions from the traveler history and the event log (domain `stateAt`), the rest as it was recorded.
  const events = await projectEvents(db, orgId, projectId, { to: at, limit: 20000 });
  const rp = stateAt({ workOrders: wos, projects: st.projects, catalog: st.catalog, events }, at, projectId);
  const byId = new Map(rp.workOrders.map((r) => [r.id, r]));
  const replayed = wos.filter((w) => byId.has(w.id)).map((w) => {
    const r = byId.get(w.id)!;
    const idx = st.catalog.stations.findIndex((s) => s.id === r.station);
    return { ...w, station: idx >= 0 ? idx : w.station, state: r.state as WorkOrder["state"], bay: r.bay as WorkOrder["bay"], progress: r.progress ?? w.progress, replayGate: r.gate ?? null };
  });
  const stopAt = rp.killed ?? rp.halted;
  return { ...live, workOrders: replayed, at, replay: rp, gates: [], slots: { used: replayed.filter((w) => w.slot && w.state !== "done").length, total: project.flow.slots, holders: [] }, stop: stopAt ? { mode: rp.killed ? "kill" : "halt", scope: stopAt.scope ?? "project", reason: stopAt.text ?? "", by: stopAt.by ?? "", at: stopAt.at, id: String(stopAt.id), inFlight: null } : null, stops: [] };
}

/* ------------------------------------------------------------------------- record */

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** The record of a work order (spec 8.4, 13.1): request verbatim, classification, brief versions, journey, every gate instance with votes and the decision with its pinned versions, send-backs, bay stays, attempts and results, code and outcomes. */
export async function readRecord(db: Queryable, orgId: string, woId: string) {
  const row = await readWoRow(db, orgId, woId);
  if (!row) return null;
  const loaded = await loadFlow(db, orgId, { ids: [woId] });
  const st = await stateWithPinned(db, orgId, loaded, row);
  const wo = st.workOrders[0] as WorkOrder;
  const q = <T extends Record<string, unknown>>(sql: string) => db.query<T>(sql, [orgId, woId]).then((r) => r.rows);
  const [instances, votes, decisions, attempts, results, stays, runs, events, request, prs, commits] = await Promise.all([
    q<{ id: string; gate_id: string; station: string | null; status: string; closed_reason: string | null; flow_version: number; rule_version: number | null; policy_version: number | null; head_sha: string | null; basis: Data; opened_at: Date; closed_at: Date | null }>(
      `select id, gate_id, station, status, closed_reason, flow_version, rule_version, policy_version, head_sha, basis, opened_at, closed_at from gate_instances where org_id = $1 and wo_id = $2 order by opened_at, id`),
    q<{ gate_instance_id: string; voter: string; vote: string; comment: string; at: Date; via: string; role_id: string | null }>(
      `select v.gate_instance_id, v.voter, v.vote, v.comment, v.at, v.via, v.role_id from gate_votes v join gate_instances g on g.org_id = v.org_id and g.id = v.gate_instance_id where v.org_id = $1 and g.wo_id = $2 order by v.at, v.id`),
    q<Record<string, unknown>>(`select gate_instance_id, decision, decided_by, rule, flow_version, gate_rule_version, policy_version, trust_level, role_assignment_id, tuple_id, agent_version, skill_versions, instruction_hash, model_id, commit_sha, detail, at from gate_decisions where org_id = $1 and wo_id = $2 order by at, id`),
    q<{ id: string; station: string; visit: number; fencing: string; state: string; outcome: string | null; started_at: Date | null; ended_at: Date | null; tuple_id: string | null; data: Data }>(
      `select id, station, visit, fencing::text, state, outcome, started_at, ended_at, tuple_id, data from attempts where org_id = $1 and wo_id = $2 order by created_at, id`),
    q<{ id: string; attempt_id: string; station: string; outcome: string; summary: string; created_at: Date; body: Data }>(`select id, attempt_id, station, outcome, summary, created_at, body from station_results where org_id = $1 and wo_id = $2 order by created_at, id`),
    q<{ bay: string; reason: string; entered_by: string | null; entered_at: Date; left_at: Date | null }>(`select bay, reason, entered_by, entered_at, left_at from bay_stays where org_id = $1 and wo_id = $2 order by entered_at`),
    q<{ id: string; attempt_id: string; state: string; model_id: string | null; created_at: Date }>(`select id, attempt_id, state, model_id, created_at from runs where org_id = $1 and wo_id = $2 order by created_at`),
    q<{ seq: string; occurred_at: Date; type: string; actor: string; outcome: string; after: unknown; subject: unknown; project_id: string | null; wo_id: string | null }>(
      `select seq::text, occurred_at, type, actor, outcome, after, subject, project_id, wo_id from events where org_id = $1 and wo_id = $2 and outcome <> 'denied' order by occurred_at, seq limit 2000`),
    q<{ original_text: string; submitted_by: string | null; via: string; created_at: Date }>(`select original_text, submitted_by, via, created_at from requests where org_id = $1 and wo_id = $2`),
    q<{ number: number; state: string; head_sha: string | null; title: string; url: string | null; merged_at: Date | null; draft: boolean }>(`select number, state, head_sha, title, url, merged_at, draft from pull_requests where org_id = $1 and wo_id = $2 order by number`),
    q<{ sha: string; message: string; author: string | null; committed_at: Date | null }>(`select sha, message, author, committed_at from commits where org_id = $1 and wo_id = $2 order by committed_at nulls last`),
  ]);
  const project = st.projects.find((p) => p.id === wo.project) as Project;
  const gates = instances.map((i) => ({
    id: i.id, gate: i.gate_id, station: i.station, status: i.status, closedReason: i.closed_reason, headSha: i.head_sha, openedAt: iso(i.opened_at), closedAt: iso(i.closed_at),
    pinned: { flowVersion: i.flow_version, ruleVersion: i.rule_version, policyVersion: i.policy_version }, basis: i.basis,
    votes: votes.filter((v) => v.gate_instance_id === i.id).map((v) => ({ by: v.voter, vote: v.vote, comment: v.comment, at: iso(v.at), via: v.via, role: v.role_id })),
    decision: decisions.find((d) => d.gate_instance_id === i.id) ?? null,
  }));
  const totals = woTotals(wo);
  const full = {
    ...wo,
    criteria: criteriaFor(wo),
  } as WorkOrder;
  const summary = { generated: summaryText({ ...st, integrationTypes: [], integrationInstances: [] }, full), written: (row.data.recordSummary as { text: string; by: string; at: number } | undefined) ?? null };
  const record = {
    id: wo.id, version: row.version, project: wo.project, repo: wo.repo, title: wo.title, state: wo.state, position: row.position, class: wo.cls, priority: wo.priority, source: wo.source,
    request: { text: request[0]?.original_text ?? wo.title, by: request[0]?.submitted_by ?? wo.requestedBy, via: request[0]?.via ?? wo.source, at: ms(request[0]?.created_at) ?? wo.createdAt, attachments: wo.attachments },
    classification: { predicted: wo.clsSuggested, final: wo.cls, confidence: wo.clsConfidence, rationale: wo.clsRationale, requested: wo.requestedCls, overridden: wo.clsOverridden },
    route: route(st.catalog, project, wo.cls), flowVersion: row.flowVersion,
    clarification: wo.conv.messages, briefVersions: wo.briefVersions ?? [], brief: wo.brief, criteria: full.criteria,
    journey: wo.history, gates, sendbacks: wo.sendbacks ?? [], bayStays: stays.map((s) => ({ bay: s.bay, reason: s.reason, by: s.entered_by, from: iso(s.entered_at), to: iso(s.left_at) })),
    attempts: attempts.map((a) => ({ id: a.id, station: a.station, visit: a.visit, fencing: Number(a.fencing), state: a.state, outcome: a.outcome, startedAt: iso(a.started_at), endedAt: iso(a.ended_at), tuple: a.tuple_id, agent: a.data.agent ?? null })),
    results: results.map((r) => ({ id: r.id, attempt: r.attempt_id, station: r.station, outcome: r.outcome, summary: r.summary, at: iso(r.created_at), output: obj(r.body).output ?? null })),
    runs: runs.map((r) => ({ id: r.id, attempt: r.attempt_id, state: r.state, model: r.model_id, at: iso(r.created_at) })),
    code: { pullRequests: prs.map((p) => ({ number: p.number, state: p.state, draft: p.draft, headSha: p.head_sha, title: p.title, url: p.url, mergedAt: iso(p.merged_at) })), commits: commits.map((c) => ({ sha: c.sha, message: c.message, author: c.author, at: iso(c.committed_at) })), files: wo.files ?? [], diff: wo.diff, tests: wo.tests },
    outcomes: wo.outcomes ?? [], totals, completeness: completeness(full), summary,
    events: events.map((e) => ({ seq: Number(e.seq), at: iso(e.occurred_at), type: e.type, by: e.actor, outcome: e.outcome, detail: e.after })),
  };
  return record;
}

export type WoRecord = NonNullable<Awaited<ReturnType<typeof readRecord>>>;

/** The record as Markdown (GET .../record.md). */
export function recordMarkdown(r: WoRecord): string {
  const L: string[] = [];
  const ln = (s = "") => L.push(s);
  ln(`# ${r.id}: ${r.title}`);
  ln();
  ln(`Project ${r.project} · repo ${r.repo} · class ${r.class} · priority ${r.priority} · state ${r.state}`);
  ln();
  ln("## Summary");
  ln(r.summary.written?.text ?? r.summary.generated);
  ln();
  ln("## Request (verbatim)");
  ln(r.request.text.split("\n").map((x) => `> ${x}`).join("\n"));
  ln(`Submitted by ${r.request.by} via ${r.request.via}.`);
  ln();
  ln("## Classification");
  ln(`Predicted ${r.classification.predicted} (${Math.round(r.classification.confidence * 100)}%), final ${r.classification.final}${r.classification.overridden ? `, changed by ${r.classification.overridden.by}: ${r.classification.overridden.reason}` : ""}. ${r.classification.rationale}`);
  ln(`Route: ${r.route.join(" → ")} (flow version ${r.flowVersion}).`);
  ln();
  ln("## Agreed brief");
  if (!r.briefVersions.length) ln("Not confirmed yet.");
  for (const b of r.briefVersions) ln(`- Version ${b.v}, confirmed by ${b.by || "unknown"}: ${b.brief.goal}`);
  ln();
  ln("## Acceptance criteria");
  for (const c of r.criteria ?? []) ln(`- ${c.id} ${c.text}: ${c.status}`);
  ln();
  ln("## Journey");
  for (const j of r.journey) ln(`- ${j.station} by ${j.agent || "n/a"}: ${j.outcome ?? "in progress"}${j.note ? ` (${j.note})` : ""}`);
  ln();
  ln("## Gates and approvals");
  if (!r.gates.length) ln("No gate has opened yet.");
  for (const g of r.gates) {
    const d = g.decision as { decision?: string; decided_by?: string } | null;
    ln(`- ${g.gate} (${g.id}): ${g.status}${g.closedReason ? ` (${g.closedReason})` : ""}${d ? `, ${d.decision}${d.decided_by ? ` by ${d.decided_by}` : ""}` : ""}; votes: ${g.votes.map((v) => `${v.by} ${v.vote}`).join(", ") || "none"}; pinned flow v${g.pinned.flowVersion}, rule v${g.pinned.ruleVersion ?? "-"}, policy v${g.pinned.policyVersion ?? "-"}`);
  }
  ln();
  ln("## Send-backs");
  if (!r.sendbacks.length) ln("None.");
  for (const s of r.sendbacks) ln(`- ${s.from} → ${s.to}: ${s.note}`);
  ln();
  ln("## Code");
  for (const p of r.code.pullRequests) ln(`- PR #${p.number} ${p.state}${p.headSha ? ` at ${p.headSha.slice(0, 7)}` : ""}: ${p.title}`);
  ln(`${r.code.commits.length} commits, ${r.code.files.length} files, tests ${r.code.tests.passed} passed / ${r.code.tests.failed} failed.`);
  ln();
  ln("## Outcomes after release");
  if (!r.outcomes.length) ln("None recorded.");
  for (const o of r.outcomes) ln(`- ${o.kind}: ${o.text}`);
  ln();
  ln(`Totals: ${r.totals.tokens} tokens, $${r.totals.cost.toFixed(2)}. Record completeness ${r.completeness.done} of ${r.completeness.total}.`);
  return L.join("\n") + "\n";
}

/** The export bundle (GET .../record/export): the record, its Markdown and the sha256 of each part, so a copy can be checked later. */
export function recordBundle(r: WoRecord): { manifest: { id: string; version: number; algorithm: "sha256"; files: Array<{ name: string; sha256: string; bytes: number }> }; files: Record<string, unknown> } {
  const json = JSON.stringify(r, null, 2);
  const md = recordMarkdown(r);
  const parts: Array<[string, string]> = [["record.json", json], ["record.md", md], ["events.json", JSON.stringify(r.events)], ["gates.json", JSON.stringify(r.gates)]];
  return {
    manifest: { id: r.id, version: r.version, algorithm: "sha256", files: parts.map(([name, body]) => ({ name, sha256: sha(body), bytes: Buffer.byteLength(body) })) },
    files: { "record.json": r, "record.md": md, "events.json": r.events, "gates.json": r.gates },
  };
}

/* ------------------------------------------------------------------------- changes */

/** Commits, changed files and patches by reference (content hash into object storage), for the record's changes tab. */
export async function readChanges(db: Queryable, orgId: string, woId: string) {
  const q = <T extends Record<string, unknown>>(sql: string) => db.query<T>(sql, [orgId, woId]).then((r) => r.rows);
  const [commits, files, patches, prs] = await Promise.all([
    q<{ id: string; sha: string; message: string; author: string | null; committed_at: Date | null; pr_id: string | null }>(`select id, sha, message, author, committed_at, pr_id from commits where org_id = $1 and wo_id = $2 order by committed_at nulls last, created_at`),
    q<{ commit_id: string | null; pr_id: string | null; path: string; status: string; additions: number; deletions: number }>(
      `select f.commit_id, f.pr_id, f.path, f.status, f.additions, f.deletions from changed_files f where f.org_id = $1 and (f.pr_id in (select id from pull_requests where org_id = $1 and wo_id = $2) or f.commit_id in (select id from commits where org_id = $1 and wo_id = $2)) order by f.path`),
    q<{ id: string; commit_id: string | null; pr_id: string | null; content_hash: string; size_bytes: string }>(`select id, commit_id, pr_id, content_hash, size_bytes::text from patches where org_id = $1 and wo_id = $2 order by created_at`),
    q<{ id: string; number: number; state: string; head_sha: string | null; head_branch: string | null; base_branch: string | null; url: string | null }>(`select id, number, state, head_sha, head_branch, base_branch, url from pull_requests where org_id = $1 and wo_id = $2 order by number`),
  ]);
  return {
    pullRequests: prs.map((p) => ({ number: p.number, state: p.state, headSha: p.head_sha, branch: p.head_branch, base: p.base_branch, url: p.url })),
    commits: commits.map((c) => ({ sha: c.sha, message: c.message, author: c.author, at: ms(c.committed_at) ?? null, files: files.filter((f) => f.commit_id === c.id).map((f) => ({ path: f.path, status: f.status, plus: f.additions, minus: f.deletions })) })),
    files: files.map((f) => ({ path: f.path, status: f.status, plus: f.additions, minus: f.deletions })),
    patches: patches.map((p) => ({ id: p.id, ref: `sha256/${p.content_hash}`, bytes: Number(p.size_bytes) })),
  };
}

void effectiveStop;
export type { FlowState, EventEntry };
