/** Trigger persistence (spec 7.3, 11.7), mapped to the legacy `triggers` slice. Settings live in `triggers.config`; runs in `trigger_runs`; held work in `trigger_proposals`. */
import type { Trigger, TriggerLimits, TriggerProposal, TriggerRun } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { ms, obj } from "../../core/read/rows.js";

export const DEFAULT_LIMITS: TriggerLimits = { perHour: 6, perDay: 20 };
export const WHO = ["org", "proposal", "system"] as const;
export type Who = (typeof WHO)[number];

export interface TriggerRow {
  id: string; project_id: string | null; kind: string; name: string; enabled: boolean; config: Record<string, unknown>; version: number; next_run_at: Date | null; created_by: string | null; created_at: Date;
}
export const COLS = `id, project_id, kind, name, enabled, config, version, next_run_at, created_by, created_at`;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The settings of a row with defaults, so the engine and the editor read one shape. */
export function settingsOf(r: Pick<TriggerRow, "kind" | "config">): {
  source: string; label: string; labelMap: Record<string, string>; command: string; schedule: string; cls: string; who: Who; reply: string; dedupe: boolean; title: string; repo: string; priority: string; limits: TriggerLimits;
} {
  const c = r.config;
  const lim = obj(c.limits);
  const labelMap = Object.fromEntries(Object.entries(obj(c.labelMap)).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  const who = (WHO as readonly string[]).includes(String(c.who)) ? (c.who as Who) : r.kind === "schedule" ? "system" : "org";
  const int = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : d);
  return {
    source: str(c.source) ?? (r.kind === "schedule" ? "schedule" : ""), label: str(c.label) ?? "", labelMap, command: str(c.command) ?? "", schedule: str(c.schedule) ?? "", cls: str(c.cls) ?? "", who,
    reply: typeof c.reply === "string" ? c.reply : "", dedupe: c.dedupe !== false, title: str(c.title) ?? "", repo: str(c.repo) ?? "", priority: str(c.priority) ?? "",
    limits: { perHour: int(lim.perHour, DEFAULT_LIMITS.perHour), perDay: int(lim.perDay, DEFAULT_LIMITS.perDay) },
  };
}

export const runFromRow = (r: { id: string; wo_id: string | null; outcome: string; detail: unknown; source: string; at: Date }): TriggerRun => {
  const d = obj(r.detail);
  return {
    id: r.id, at: r.at.getTime(), outcome: r.outcome, wo: r.wo_id ?? "", source: r.source,
    ...(str(d.msg) ? { msg: str(d.msg)! } : {}), ...(str(d.proposal) ? { proposal: str(d.proposal)! } : {}), ...(str(d.person) ? { person: str(d.person)! } : {}), ...(d.simulated === true ? { simulated: true } : {}),
  };
};

export function toTrigger(r: TriggerRow, runs: TriggerRun[], held: number): Trigger {
  const s = settingsOf(r);
  return {
    id: r.id, project: r.project_id ?? "", type: r.kind, name: r.name, enabled: r.enabled, who: s.who, reply: s.reply, dedupe: s.dedupe, repos: "ready", runs, source: s.source || undefined,
    ...(s.label ? { label: s.label } : r.kind === "issue" ? { label: "" } : {}), ...(r.kind === "issue" ? { labelMap: s.labelMap } : {}), ...(s.command ? { command: s.command } : {}), ...(s.schedule ? { schedule: s.schedule } : {}),
    ...(s.cls ? { cls: s.cls } : {}), ...(s.title ? { title: s.title } : {}), ...(s.repo ? { repo: s.repo } : {}), ...(s.priority ? { priority: s.priority } : {}), limits: s.limits, version: r.version,
    ...(r.kind === "schedule" ? { nextRun: r.enabled ? ms(r.next_run_at) ?? null : null } : {}), held, ...(r.created_by ? { createdBy: r.created_by } : {}),
  } as Trigger;
}

/** Triggers on the given projects (`all` or a list), each with its latest runs oldest-first (legacy order) and the number of proposals it holds. */
export async function readTriggers(db: Queryable, orgId: string, projects: "all" | string[], o: { id?: string; runs?: number } = {}): Promise<Trigger[]> {
  const { rows } = await db.query<TriggerRow>(
    `select ${COLS} from triggers where org_id = $1 and ($2::text[] is null or project_id = any($2)) and ($3::text is null or id = $3) order by created_at, id`,
    [orgId, projects === "all" ? null : projects, o.id ?? null],
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const runs = await db.query<{ id: string; trigger_id: string; wo_id: string | null; outcome: string; detail: unknown; source: string; at: Date }>(
    `select id, trigger_id, wo_id, outcome, detail, source, at from (
       select *, row_number() over (partition by trigger_id order by at desc, id desc) as rn from trigger_runs where org_id = $1 and trigger_id = any($2)) x where rn <= $3 order by at, id`,
    [orgId, ids, o.runs ?? 20],
  );
  const held = await db.query<{ trigger_id: string; n: string }>(`select trigger_id, count(*)::text as n from trigger_proposals where org_id = $1 and trigger_id = any($2) and status = 'held' group by trigger_id`, [orgId, ids]);
  const byRuns = new Map<string, TriggerRun[]>();
  for (const r of runs.rows) byRuns.set(r.trigger_id, [...(byRuns.get(r.trigger_id) ?? []), runFromRow(r)]);
  const byHeld = new Map(held.rows.map((h) => [h.trigger_id, Number(h.n)]));
  return rows.map((r) => toTrigger(r, byRuns.get(r.id) ?? [], byHeld.get(r.id) ?? 0));
}

export async function readTriggerRow(db: Queryable, orgId: string, id: string, lock = false): Promise<TriggerRow | null> {
  return (await db.query<TriggerRow>(`select ${COLS} from triggers where org_id = $1 and id = $2 ${lock ? "for update" : ""}`, [orgId, id])).rows[0] ?? null;
}

export async function readRuns(db: Queryable, orgId: string, triggerId: string, limit = 50): Promise<TriggerRun[]> {
  const { rows } = await db.query<{ id: string; wo_id: string | null; outcome: string; detail: unknown; source: string; at: Date }>(
    `select id, wo_id, outcome, detail, source, at from trigger_runs where org_id = $1 and trigger_id = $2 order by at desc, id desc limit $3`, [orgId, triggerId, limit],
  );
  return rows.map(runFromRow).reverse();
}

interface ProposalRow {
  id: string; trigger_id: string; project_id: string; repo_id: string | null; title: string; description: string; requested_class: string | null; priority: string | null; source: string; actor: string | null;
  reason: string; status: "held" | "released" | "declined"; wo_id: string | null; decided_by: string | null; decided_at: Date | null; decision_note: string; created_at: Date;
}
export const proposalFromRow = (r: ProposalRow): TriggerProposal => ({
  id: r.id, trigger: r.trigger_id, project: r.project_id, repo: r.repo_id, title: r.title, description: r.description, cls: r.requested_class, priority: r.priority, source: r.source, actor: r.actor, reason: r.reason,
  status: r.status, wo: r.wo_id, at: r.created_at.getTime(), decidedBy: r.decided_by, decidedAt: ms(r.decided_at) ?? null, note: r.decision_note,
});
const PCOLS = `id, trigger_id, project_id, repo_id, title, description, requested_class, priority, source, actor, reason, status, wo_id, decided_by, decided_at, decision_note, created_at`;

export async function readProposals(db: Queryable, orgId: string, projects: "all" | string[], o: { trigger?: string; status?: string } = {}): Promise<TriggerProposal[]> {
  const { rows } = await db.query<ProposalRow>(
    `select ${PCOLS} from trigger_proposals where org_id = $1 and ($2::text[] is null or project_id = any($2)) and ($3::text is null or trigger_id = $3) and ($4::text is null or status = $4) order by created_at desc, id desc limit 200`,
    [orgId, projects === "all" ? null : projects, o.trigger ?? null, o.status ?? null],
  );
  return rows.map(proposalFromRow);
}
export async function readProposalRow(db: Queryable, orgId: string, id: string, lock = false): Promise<ProposalRow | null> {
  return (await db.query<ProposalRow>(`select ${PCOLS} from trigger_proposals where org_id = $1 and id = $2 ${lock ? "for update" : ""}`, [orgId, id])).rows[0] ?? null;
}
