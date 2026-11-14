/**
 * Work-order persistence model and loader (spec 7.3, 9.4).
 *
 * Storage convention (shared with the Home loader):
 *   work_orders        one row per work order: `position` is a station id or a bay id (one position, F2); `data` holds the
 *                      legacy fields that have no column (history, log, brief, outputs, ...), `version` increases on every change
 *   conversations      one intake conversation per work order (`data`: questions, answers, misses, decisions, raised, done)
 *   messages           the conversation's messages (`data.at` is the legacy epoch-ms timestamp)
 *   gate_instances     one row per opening of a gate; id `${woId}:${gateId}:${n}`; the API accepts `${woId}:${gateId}` for "the open one"
 *   gate_votes         one vote per voter and instance (unique)
 *   gate_decisions     append-only decision record with the pinned versions (spec 7.1, 9.5)
 *   slots              `${project}:${n}` rows, free or held (F5)
 *   attempts, station_results, requests, brief_versions, epic_children, bay_stays
 */
import type {
  Brief, BriefVersion, Catalog, Conversation, FlowState, GateInstance as LegacyGate, Project, ProjectFlow, WorkOrder,
} from "@gantry/domain";
import { routeGates } from "@gantry/domain";
import type { Queryable, Tx } from "@gantry/db";
import { loadFlowState } from "../../core/read/state.js";
import { ms, num, obj } from "../../core/read/rows.js";
import { notFound, stale } from "../../core/errors.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Data = Record<string, any>;

/** The raw row, with `data` as a mutable bag. */
export interface Wo {
  id: string;
  project: string;
  repo: string | null;
  title: string;
  cls: string;
  priority: string;
  source: string;
  position: string;
  state: string;
  flowVersion: number;
  assignee: string | null;
  submitter: string | null;
  parentId: string | null;
  risk: string | null;
  slaDueAt: Date | null;
  closedAt: Date | null;
  version: number;
  createdAt: Date;
  data: Data;
  /** Fingerprint of what was last read or written, so a second save of an unchanged row is a no-op (the version bumps once per command). */
  snap?: string;
}

interface WoDb {
  id: string; project_id: string; repo_id: string | null; title: string; class: string; priority: string; source: string; position: string; state: string; flow_version: number;
  assignee: string | null; submitter: string | null; parent_id: string | null; risk: string | null; sla_due_at: Date | null; closed_at: Date | null; version: number; created_at: Date; data: unknown;
}

export const WO_COLS = `id, project_id, repo_id, title, class, priority, source, position, state, flow_version, assignee, submitter, parent_id, risk, sla_due_at, closed_at, version, created_at, data`;

const snapOf = (w: Wo): string => JSON.stringify([w.title, w.cls, w.priority, w.position, w.state, w.assignee, w.risk, w.slaDueAt, w.closedAt, w.repo, w.parentId, w.data]);

export const toWo = (r: WoDb): Wo => withSnap({
  id: r.id, project: r.project_id, repo: r.repo_id, title: r.title, cls: r.class, priority: r.priority, source: r.source, position: r.position, state: r.state, flowVersion: r.flow_version,
  assignee: r.assignee, submitter: r.submitter, parentId: r.parent_id, risk: r.risk, slaDueAt: r.sla_due_at, closedAt: r.closed_at, version: r.version, createdAt: r.created_at, data: { ...obj(r.data) },
});

function withSnap(w: Wo): Wo {
  w.snap = snapOf(w);
  return w;
}

/** Locks the row for the rest of the transaction (F2: commands on one work order are serialised) and checks `If-Match` against the locked row. */
export async function lockWo(tx: Tx, orgId: string, id: string, ifMatch: number | null = null): Promise<Wo> {
  const { rows } = await tx.query<WoDb>(`select ${WO_COLS} from work_orders where org_id = $1 and id = $2 for update`, [orgId, id]);
  const r = rows[0];
  if (!r) throw notFound("No such work order.");
  if (ifMatch !== null && r.version !== ifMatch) throw stale(`${id} changed since you loaded it (version ${r.version}). Reload and try again.`);
  return toWo(r);
}

export async function readWoRow(db: Queryable, orgId: string, id: string): Promise<Wo | null> {
  const { rows } = await db.query<WoDb>(`select ${WO_COLS} from work_orders where org_id = $1 and id = $2`, [orgId, id]);
  return rows[0] ? toWo(rows[0]) : null;
}

export const woVersion = (orgId: string, id: string) => async (tx: Tx): Promise<number | null> =>
  (await tx.query<{ version: number }>(`select version from work_orders where org_id = $1 and id = $2`, [orgId, id])).rows[0]?.version ?? null;

/** Writes the row back and bumps the version. The row must be locked by the caller. */
export async function saveWo(tx: Tx, orgId: string, w: Wo): Promise<void> {
  if (w.snap === snapOf(w)) return;
  const r = await tx.query<{ version: number }>(
    `update work_orders set title = $3, class = $4, priority = $5, position = $6, state = $7, assignee = $8, risk = $9, sla_due_at = $10, closed_at = $11, repo_id = $12, parent_id = $13,
       data = $14::jsonb, version = version + 1, updated_at = now() where org_id = $1 and id = $2 returning version`,
    [orgId, w.id, w.title, w.cls, w.priority, w.position, w.state, w.assignee, w.risk, w.slaDueAt, w.closedAt, w.repo, w.parentId, JSON.stringify(w.data)],
  );
  w.version = r.rows[0]!.version;
  w.snap = snapOf(w);
}

/* ------------------------------------------------------------------------- derived position helpers */

export const isBay = (c: Pick<Catalog, "bays">, position: string): boolean => c.bays.some((b) => b.id === position);
/** The station the work order is at, or came from when it waits in a bay. */
export const stationIdOf = (c: Pick<Catalog, "bays">, w: Pick<Wo, "position" | "data">): string => (isBay(c, w.position) ? String(w.data.bayFrom ?? "intake") : w.position);
export const bayOf = (c: Pick<Catalog, "bays">, w: Pick<Wo, "position">): string | null => (isBay(c, w.position) ? w.position : null);
export const OPEN_STATES = ["running", "waiting", "blocked", "failed", "parked"] as const;
export const isClosed = (w: Pick<Wo, "state" | "position">): boolean => w.state === "done" || w.state === "killed" || w.state === "declined" || w.position === "declined";

/** The project as this work order sees it: its flow is the version pinned at submission (spec 9.3); approver rules stay live. */
export function pinnedProject(p: Project, flows: Map<string, ProjectFlow>, w: Pick<Wo, "project" | "flowVersion">): Project {
  const f = flows.get(`${w.project}:${w.flowVersion}`);
  return f ? ({ ...p, flow: f } as Project) : p;
}

export async function loadFlowDocs(db: Queryable, orgId: string, pairs: Array<{ project: string; flowVersion: number }>): Promise<Map<string, ProjectFlow>> {
  const out = new Map<string, ProjectFlow>();
  const want = [...new Set(pairs.map((p) => `${p.project}:${p.flowVersion}`))];
  if (!want.length) return out;
  const { rows } = await db.query<{ project_id: string; version: number; doc: ProjectFlow }>(
    `select project_id, version, doc from flow_versions where org_id = $1 and project_id || ':' || version::text = any($2::text[])`, [orgId, want],
  );
  for (const r of rows) out.set(`${r.project_id}:${r.version}`, r.doc);
  return out;
}

/* ------------------------------------------------------------------------- conversation */

export const convIdOf = (woId: string): string => `CONV-${woId}`;

export const emptyConv = (): Conversation => ({ messages: [], qi: 0, answers: {}, misses: [], decisions: [], awaiting: "submitter", done: false, raised: [], questions: [] });

export interface ConvRow {
  id: string; wo_id: string; status: string; data: Data;
}

/* ------------------------------------------------------------------------- the loader */

export interface LoadOpts {
  ids?: string[];
  project?: string;
  /** Only work orders that are open, or closed on or after this epoch ms. */
  openOrSince?: number;
  parent?: string;
  /** Skip the conversation messages, record extras and review comments (lists that do not show them). */
  light?: boolean;
}

const ROUTE_GATE_FALLBACK = (c: Catalog, p: Project, cls: string): string[] => {
  try {
    return routeGates(c, p, cls);
  } catch {
    return [];
  }
};

/** Builds the legacy `WorkOrder` objects the domain functions and the web read. */
export async function buildWorkOrders(db: Queryable, orgId: string, catalog: Catalog, projects: Project[], opts: LoadOpts = {}): Promise<WorkOrder[]> {
  const params: unknown[] = [orgId];
  const where = ["org_id = $1"];
  if (opts.ids) where.push(`id = any($${params.push(opts.ids)}::text[])`);
  if (opts.project) where.push(`project_id = $${params.push(opts.project)}`);
  if (opts.parent) where.push(`parent_id = $${params.push(opts.parent)}`);
  if (opts.openOrSince !== undefined) where.push(`(state not in ('done','killed','declined') or closed_at >= $${params.push(new Date(opts.openOrSince))})`);
  const { rows } = await db.query<WoDb>(`select ${WO_COLS} from work_orders where ${where.join(" and ")} order by created_at, id`, params);
  if (!rows.length) return [];
  const wos = rows.map(toWo);
  const ids = wos.map((w) => w.id);
  // A transaction client runs one query at a time: serialise there, run concurrently on a pool.
  const isTx = "release" in db;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => (isTx ? ((chain = chain.then(fn, fn)) as Promise<T>) : fn());
  const q = <T extends Record<string, unknown>>(sql: string) => serial(() => db.query<T>(sql, [orgId, ids]).then((r) => r.rows));
  const [flows, gis, votes, decs, convs, msgs, slots, prs, reqs, bvs, commits, checks, outcomes] = await Promise.all([
    serial(() => loadFlowDocs(db, orgId, wos)),
    q<{ id: string; wo_id: string; gate_id: string; status: string; closed_reason: string | null; opened_at: Date; closed_at: Date | null; basis: Data }>(
      `select id, wo_id, gate_id, status, closed_reason, opened_at, closed_at, basis from gate_instances where org_id = $1 and wo_id = any($2::text[]) order by opened_at, id`),
    q<{ gate_instance_id: string; wo_id: string; voter: string; vote: string; comment: string; at: Date; via: string }>(
      `select v.gate_instance_id, g.wo_id, v.voter, v.vote, v.comment, v.at, v.via from gate_votes v join gate_instances g on g.org_id = v.org_id and g.id = v.gate_instance_id where v.org_id = $1 and g.wo_id = any($2::text[]) order by v.at, v.id`),
    q<{ gate_instance_id: string; wo_id: string; decision: string; decided_by: string | null; detail: Data; at: Date; trust_level: string | null }>(
      `select gate_instance_id, wo_id, decision, decided_by, detail, at, trust_level from gate_decisions where org_id = $1 and wo_id = any($2::text[]) order by at, id`),
    q<{ id: string; wo_id: string; status: string; data: Data }>(`select id, wo_id, status, data from conversations where org_id = $1 and wo_id = any($2::text[]) and kind = 'intake'`),
    opts.light
      ? Promise.resolve([] as Array<{ conversation_id: string; author: string; body: string; data: Data }>)
      : q<{ conversation_id: string; author: string; body: string; data: Data }>(
          `select m.conversation_id, m.author, m.body, m.data from messages m join conversations c on c.org_id = m.org_id and c.id = m.conversation_id where m.org_id = $1 and c.wo_id = any($2::text[]) order by coalesce((m.data->>'at')::bigint, (extract(epoch from m.created_at) * 1000)::bigint), m.id`),
    q<{ id: string; wo_id: string }>(`select id, wo_id from slots where org_id = $1 and wo_id = any($2::text[]) and state = 'held'`),
    q<{ wo_id: string; number: number; state: string; draft: boolean; head_sha: string | null; head_branch: string | null; title: string; data: Data; merged_at: Date | null; id: string }>(
      `select id, wo_id, number, state, draft, head_sha, head_branch, title, data, merged_at from pull_requests where org_id = $1 and wo_id = any($2::text[]) order by number`),
    q<{ wo_id: string; original_text: string; submitted_by: string | null; via: string; created_at: Date }>(`select wo_id, original_text, submitted_by, via, created_at from requests where org_id = $1 and wo_id = any($2::text[])`),
    q<{ wo_id: string; version: number; body: Brief; confirmed_by: string | null; confirmed_at: Date | null; created_at: Date }>(
      `select wo_id, version, body, confirmed_by, confirmed_at, created_at from brief_versions where org_id = $1 and wo_id = any($2::text[]) order by version`),
    opts.light ? Promise.resolve([]) : q<{ wo_id: string; sha: string; message: string; author: string | null; committed_at: Date | null }>(`select wo_id, sha, message, author, committed_at from commits where org_id = $1 and wo_id = any($2::text[]) order by committed_at nulls last, created_at`),
    opts.light ? Promise.resolve([]) : q<{ wo_id: string; name: string; status: string; conclusion: string | null; completed_at: Date | null; created_at: Date }>(
      `select p.wo_id, c.name, c.status, c.conclusion, c.completed_at, c.created_at from checks c join pull_requests p on p.org_id = c.org_id and p.id = c.pr_id where c.org_id = $1 and p.wo_id = any($2::text[]) order by c.created_at`),
    opts.light ? Promise.resolve([]) : q<{ wo_id: string; kind: string; recorded_by: string | null; note: string; at: Date }>(`select wo_id, kind, recorded_by, note, at from outcomes where org_id = $1 and wo_id = any($2::text[]) order by at`),
  ]);
  const by = <T extends { wo_id: string }>(list: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const x of list) (m.get(x.wo_id) ?? m.set(x.wo_id, []).get(x.wo_id)!).push(x);
    return m;
  };
  const gisBy = by(gis), votesBy = by(votes), decsBy = by(decs), prsBy = by(prs), commitsBy = by(commits), checksBy = by(checks), outBy = by(outcomes);
  const convBy = new Map(convs.map((c) => [c.wo_id, c]));
  const msgBy = new Map<string, typeof msgs>();
  for (const m of msgs) (msgBy.get(m.conversation_id) ?? msgBy.set(m.conversation_id, []).get(m.conversation_id)!).push(m);
  const slotBy = new Map(slots.map((s) => [s.wo_id, s.id]));
  const reqBy = new Map(reqs.map((r) => [r.wo_id, r]));
  const bvBy = by(bvs);
  const childrenBy = new Map<string, string[]>();
  for (const w of wos) if (w.parentId) (childrenBy.get(w.parentId) ?? childrenBy.set(w.parentId, []).get(w.parentId)!).push(w.id);

  return wos.map((w) => {
    const d = w.data;
    const base = projects.find((p) => p.id === w.project);
    const project = base ? pinnedProject(base, flows, w) : undefined;
    const bay = bayOf(catalog, w);
    const stId = stationIdOf(catalog, w);
    const station = Math.max(0, catalog.stations.findIndex((s) => s.id === stId));
    const created = ms(w.createdAt) ?? 0;

    // gates: derived from instances, votes and decisions
    const gates: Record<string, LegacyGate> = {};
    const gateIds = new Set<string>(project ? ROUTE_GATE_FALLBACK(catalog, project, w.cls) : []);
    for (const gi of gisBy.get(w.id) ?? []) gateIds.add(gi.gate_id);
    for (const gid of Object.keys(obj(d.gateStatus))) gateIds.add(gid);
    for (const gid of gateIds) {
      const insts = (gisBy.get(w.id) ?? []).filter((g) => g.gate_id === gid && !g.basis?.reset);
      const last = insts[insts.length - 1];
      const rejections = (decsBy.get(w.id) ?? []).filter((x) => x.decision === "rejected" && insts.concat((gisBy.get(w.id) ?? []).filter((g) => g.gate_id === gid)).some((g) => g.id === x.gate_instance_id))
        .map((x) => ({ by: x.decided_by ?? "", at: ms(x.at) ?? 0, reason: String(x.detail?.reason ?? "") }));
      const override = obj(d.gateStatus)[gid] as string | undefined;
      const checksFor = Array.isArray(obj(d.gateChecks)[gid]) ? (obj(d.gateChecks)[gid] as LegacyGate["checks"]) : [];
      const g: LegacyGate = { status: "pending", approvals: [], rejections, checks: checksFor };
      const voteList = last ? (votesBy.get(w.id) ?? []).filter((v) => v.gate_instance_id === last.id && v.vote === "approve") : [];
      const approvals = voteList.map((v) => ({ by: v.voter, at: ms(v.at) ?? 0, via: v.via }));
      if (last?.status === "open") {
        g.status = "waiting";
        g.approvals = approvals;
        g.waitingSince = ms(last.opened_at) ?? created;
        if (typeof last.basis?.trustNote === "string") g.trustNote = last.basis.trustNote;
      } else if (override === "skipped") g.status = "skipped" as LegacyGate["status"];
      else if (override === "failed") g.status = "failed";
      else if (last) {
        const dec = (decsBy.get(w.id) ?? []).find((x) => x.gate_instance_id === last.id);
        if (dec && (dec.decision === "approved" || dec.decision === "auto_passed")) {
          g.status = "passed";
          g.approvals = approvals;
          const mode = dec.decision === "auto_passed" ? (dec.detail?.mode === "trust" ? "trust" : "auto") : "human";
          g.decision = { mode, ...(dec.decided_by ? { by: dec.decided_by } : {}), at: ms(dec.at) ?? 0, via: String(dec.detail?.channel ?? "web"), trust: dec.detail?.trustLevelNum == null ? null : Number(dec.detail.trustLevelNum), approvals: approvals.length } as LegacyGate["decision"];
        }
      }
      gates[gid] = g;
    }

    // conversation
    const cr = convBy.get(w.id);
    const cd = obj(cr?.data);
    const conv: Conversation = {
      messages: (msgBy.get(cr?.id ?? "") ?? []).map((m) => ({ from: m.author, at: num(m.data?.at, 0), text: m.body, ...(m.data?.qid ? { qid: String(m.data.qid) } : {}), ...(Array.isArray(m.data?.chips) ? { chips: m.data.chips as string[] } : {}) })),
      qi: num(cd.qi), answers: obj(cd.answers) as Record<string, string>, misses: Array.isArray(cd.misses) ? (cd.misses as Conversation["misses"]) : [], decisions: Array.isArray(cd.decisions) ? (cd.decisions as Conversation["decisions"]) : [],
      awaiting: typeof cd.awaiting === "string" ? cd.awaiting : "submitter", done: cd.done === true, raised: Array.isArray(cd.raised) ? (cd.raised as Conversation["raised"]) : [], questions: Array.isArray(cd.questions) ? (cd.questions as Conversation["questions"]) : [],
    };

    // pull request
    const prRows = prsBy.get(w.id) ?? [];
    const prRow = prRows[prRows.length - 1];
    const cks = checksBy.get(w.id) ?? [];
    const prChecks: "pending" | "green" | "red" = cks.some((c) => c.conclusion === "failure" || c.conclusion === "cancelled" || c.conclusion === "timed_out") ? "red" : cks.length && cks.every((c) => c.status === "completed" && c.conclusion === "success") ? "green" : "pending";
    const pr = prRow
      ? ({ ...obj(prRow.data), number: prRow.number, branch: prRow.head_branch ?? "", checks: prChecks, state: prRow.state === "merged" ? "merged" : prRow.state === "closed" ? "closed" : prRow.draft ? "draft" : "open", tag: (obj(prRow.data).tag as string | undefined) ?? null, title: prRow.title, ...(prRow.merged_at ? { mergedAt: ms(prRow.merged_at) } : {}) } as WorkOrder["pr"])
      : ((d.pr as WorkOrder["pr"]) ?? null);

    const req = reqBy.get(w.id);
    const briefVersions: BriefVersion[] = (bvBy.get(w.id) ?? []).map((b) => ({ v: b.version, at: ms(b.confirmed_at ?? b.created_at) ?? 0, by: b.confirmed_by ?? "", note: String(obj(b.body).note ?? ""), brief: b.body }));

    const out = {
      ...d,
      id: w.id, project: w.project, repo: w.repo ?? "", title: w.title, description: String(d.description ?? ""), attachments: Array.isArray(d.attachments) ? d.attachments : [],
      cls: w.cls, clsConfidence: num(d.clsConfidence), clsRationale: String(d.clsRationale ?? ""), clsSuggested: String(d.clsSuggested ?? w.cls), clsOverridden: d.clsOverridden ?? null, requestedCls: (d.requestedCls as string | null) ?? null,
      priority: w.priority, source: w.source, requestedBy: w.submitter ?? "", createdAt: created, station, state: w.state, bay, bayReason: String(d.bayReason ?? ""), bayFrom: bay ? ((d.bayFrom as string | null) ?? null) : null,
      ...(d.bayAt ? { bayAt: num(d.bayAt) } : {}), progress: num(d.progress, w.state === "done" ? 100 : 0), slot: slotBy.has(w.id) ? Number(slotBy.get(w.id)!.split(":").pop()) : null,
      history: Array.isArray(d.history) ? d.history : [], gates, log: Array.isArray(d.log) ? d.log : [], diff: d.diff ?? { plus: 0, minus: 0, files: 0 }, tests: d.tests ?? { passed: 0, failed: 0, added: 0 },
      pr, blockReason: (d.blockReason as string | null) ?? null, failReason: (d.failReason as string | null) ?? null, doneAt: ms(w.closedAt) ?? null, killed: d.killed ?? null,
      parent: w.parentId, children: childrenBy.get(w.id) ?? (Array.isArray(d.children) ? d.children : []), risk: w.risk ?? "normal", paths: Array.isArray(d.paths) ? d.paths : [], slaDue: ms(w.slaDueAt) ?? 0,
      conv, brief: (d.brief as Brief) ?? { goal: w.title, scopeIn: [], scopeOut: [], ac: [], risks: [], open: [], decisions: [], estimate: "M", route: [], children: [] },
      request: { title: w.title, text: req?.original_text ?? w.title, source: w.source, by: req?.submitted_by ?? w.submitter ?? "", via: req?.via ?? null, at: ms(req?.created_at) ?? created, attachments: Array.isArray(d.attachments) ? d.attachments : [], requestedCls: (d.requestedCls as string | null) ?? null },
      briefVersions,
      commits: (commitsBy.get(w.id) ?? []).map((c) => ({ hash: c.sha, message: c.message, agent: c.author ?? "", station: "build", at: ms(c.committed_at) ?? 0, files: [], step: "" })),
      checks: cks.map((c) => ({ name: c.name, status: c.conclusion ?? c.status, at: ms(c.completed_at ?? c.created_at) ?? 0 })),
      outcomes: (outBy.get(w.id) ?? []).map((o) => ({ kind: o.kind === "regression" || o.kind === "rollback" ? "revert" : o.kind, at: ms(o.at) ?? 0, text: o.note, by: o.recorded_by ?? "" })),
      sendbacks: Array.isArray(d.sendbacks) ? d.sendbacks : [],
      ...(d.heldByKill ? { heldByKill: true } : {}),
    } as unknown as WorkOrder;
    return out;
  });
}

/** Flow state (policy, projects, repos, catalogue) plus the requested work orders built from rows. */
export async function loadFlow(db: Queryable, orgId: string, opts: LoadOpts = {}): Promise<FlowState> {
  const st = await loadFlowState(db, orgId);
  const workOrders = await buildWorkOrders(db, orgId, st.catalog, st.projects, opts);
  return { ...st, workOrders };
}

/** A loader in the shape `loadFlowState(db, org, { workOrders })` takes. */
export const workOrderLoader = (opts: LoadOpts = {}) => async (db: Queryable, orgId: string): Promise<WorkOrder[]> => {
  const st = await loadFlowState(db, orgId);
  return buildWorkOrders(db, orgId, st.catalog, st.projects, opts);
};

/** A flow state whose `projects` carry the flow version pinned by `w`, for the domain functions that look the project up by id. */
export async function stateWithPinned(db: Queryable, orgId: string, st: FlowState, w: Pick<Wo, "project" | "flowVersion">): Promise<FlowState> {
  const flows = await loadFlowDocs(db, orgId, [w]);
  return { ...st, projects: st.projects.map((p) => (p.id === w.project ? pinnedProject(p, flows, w) : p)) };
}
