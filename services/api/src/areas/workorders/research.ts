/**
 * Governed web research (agent workspace, Phase 2): which hosts a run may read, and the sources it read.
 *
 * A run reads only the hosts a person approved in the work order's research plan. The factory's research allow-list (Security settings,
 * `researchHosts`) is what an approver may approve without security rights. Package registries and model endpoints are run egress, not research.
 */
import type { Queryable, Tx } from "@gantry/db";

export interface ResearchPlan {
  status: "proposed" | "approved" | "rejected";
  /** What the research will try to answer. */
  questions: string[];
  /** Hosts the plan wants to read; on approval, the hosts a person allowed. */
  hosts: string[];
  /** false: repository only, no web. */
  web: boolean;
  budgetUsd: number | null;
  why: string;
  station: string;
  attempt: string;
  proposedAt: number;
  decidedBy?: string;
  decidedAt?: number;
  note?: string;
}

export const planOf = (data: Record<string, unknown>): ResearchPlan | null => (data.researchPlan && typeof data.researchPlan === "object" ? (data.researchPlan as ResearchPlan) : null);

/**
 * The hosts a run on this work order may read: exactly the hosts of its approved research plan. No approved plan, no web: the plan is what a
 * person agreed to (scope, hosts, budget), and the factory allow-list only limits what an approver without security rights may approve.
 */
export async function researchHosts(_db: Queryable, _orgId: string, woData: Record<string, unknown>): Promise<string[]> {
  const plan = planOf(woData);
  if (plan?.status !== "approved" || !plan.web) return [];
  return [...new Set(plan.hosts)].sort();
}

export interface SourceRow {
  id: string; ref: string; kind: string; station: string; attemptId: string | null; fetchedBy: string | null; url: string; finalUrl: string; host: string; title: string;
  httpStatus: number | null; contentType: string; contentHash: string; size: number; truncated: boolean; why: string; fetchedAt: number; excerpt?: string;
}
const row = (r: Record<string, unknown>, withText: boolean): SourceRow => ({
  id: String(r.id), ref: String(r.ref), kind: String(r.kind), station: String(r.station), attemptId: (r.attempt_id as string | null) ?? null, fetchedBy: (r.fetched_by as string | null) ?? null,
  url: String(r.url), finalUrl: String(r.final_url), host: String(r.host), title: String(r.title ?? ""), httpStatus: (r.http_status as number | null) ?? null, contentType: String(r.content_type ?? ""),
  contentHash: String(r.content_hash), size: Number(r.size_bytes), truncated: r.truncated === true, why: String(r.why ?? ""), fetchedAt: (r.fetched_at as Date).getTime(),
  ...(withText ? { excerpt: String(r.excerpt ?? "") } : {}),
});

export async function recordSource(tx: Tx, s: { orgId: string; woId: string; station: string; attemptId: string; runId: string; agent: string | null; url: string; finalUrl: string; title: string; httpStatus: number | null; contentType: string; contentHash: string; size: number; truncated: boolean; why: string; excerpt: string }): Promise<string> {
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`src:${s.orgId}:${s.woId}`]);
  const n = Number((await tx.query<{ n: string }>(`select count(*)::text as n from research_sources where org_id = $1 and wo_id = $2`, [s.orgId, s.woId])).rows[0]!.n) + 1;
  const ref = `s${n}`;
  const host = (() => { try { return new URL(s.finalUrl).hostname; } catch { return ""; } })();
  await tx.query(
    `insert into research_sources (org_id, id, wo_id, ref, kind, station, attempt_id, run_id, fetched_by, url, final_url, host, title, http_status, content_type, content_hash, size_bytes, truncated, why, excerpt)
     values ($1,$2,$3,$4,'web',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [s.orgId, `SRC-${s.woId}-${n}`, s.woId, ref, s.station, s.attemptId, s.runId, s.agent, s.url, s.finalUrl, host, s.title, s.httpStatus, s.contentType, s.contentHash, s.size, s.truncated, s.why, s.excerpt],
  );
  return ref;
}

export async function listSources(db: Queryable, orgId: string, woId: string): Promise<SourceRow[]> {
  return (await db.query(`select * from research_sources where org_id = $1 and wo_id = $2 order by fetched_at, ref`, [orgId, woId])).rows.map((r) => row(r, false));
}
export async function readSource(db: Queryable, orgId: string, woId: string, ref: string): Promise<SourceRow | null> {
  const r = (await db.query(`select * from research_sources where org_id = $1 and wo_id = $2 and ref = $3`, [orgId, woId, ref])).rows[0];
  return r ? row(r, true) : null;
}

/** The sources as a later station receives them: what was read, so it can cite `[^sN]` without fetching again. */
export async function sourcesHandoff(db: Queryable, orgId: string, woId: string): Promise<Array<{ ref: string; url: string; title: string; station: string; fetchedAt: string }>> {
  return (await listSources(db, orgId, woId)).map((s) => ({ ref: s.ref, url: s.finalUrl, title: s.title, station: s.station, fetchedAt: new Date(s.fetchedAt).toISOString() }));
}
