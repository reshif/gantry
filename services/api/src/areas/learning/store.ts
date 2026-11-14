/** Proposal rows and their legacy shape. Stored states: open (proposed), applied (accepted and applied), verified, rejected (declined), rolled_back. */
import type { Queryable } from "@gantry/db";
import type { LearningProposal } from "@gantry/domain";

export type DbStatus = "open" | "accepted" | "rejected" | "applied" | "superseded" | "verified" | "rolled_back";
export interface Rollback {
  kind: string;
  /** What the undo restores, in words (shown on the card). */
  summary: string;
  /** False when the change cannot be undone by code (the reason is in the summary). */
  available: boolean;
  /** Kind-specific data: the prior value and the value this change wrote, so an undo is refused when something else changed it since. */
  data: Record<string, unknown>;
}
export interface ProposalRow {
  id: string;
  finding_id: string | null;
  kind: string;
  change: Record<string, unknown>;
  status: DbStatus;
  title: string;
  owner: string | null;
  expected: string;
  history: Array<{ at: number; by: string; text: string }>;
  metric: { signal: string; project: string | null; agent: string | null; target: number } | null;
  window_days: number | null;
  baseline: { count: number; from: number; to: number } | null;
  applied_at: Date | null;
  applied_by: string | null;
  rollback: Rollback | null;
  verification: { measured: number; target: number; baseline: number | null; at: number; by: string } | null;
  reason: string | null;
  decided_by: string | null;
  version: number;
  created_at: Date;
}

const COLS = `id, finding_id, kind, change, status, title, owner, expected, history, metric, window_days, baseline, applied_at, applied_by, rollback, verification, reason, decided_by, version, created_at`;
const ms = (d: Date | string | null | undefined): number => (d ? new Date(d).getTime() : 0);

export const proposalRows = async (db: Queryable, orgId: string, id?: string, lock = false): Promise<ProposalRow[]> =>
  (await db.query<ProposalRow>(`select ${COLS} from proposals where org_id = $1 ${id ? "and id = $2" : ""} and title <> '' order by created_at, id ${lock ? "for update" : ""}`, id ? [orgId, id] : [orgId])).rows;

const LEGACY: Record<DbStatus, string> = { open: "proposed", accepted: "accepted", applied: "accepted", verified: "verified", rejected: "declined", rolled_back: "rolled_back", superseded: "declined" };
export const legacyStatus = (s: DbStatus): string => LEGACY[s] ?? s;

export function toProposal(r: ProposalRow): LearningProposal {
  return {
    id: r.id, finding: r.finding_id ?? "", kind: r.kind, title: r.title, owner: r.owner ?? "system", status: legacyStatus(r.status), at: ms(r.created_at), expected: r.expected,
    change: r.change, history: Array.isArray(r.history) ? r.history : [], ...(r.reason ? { reason: r.reason } : {}), rev: r.version,
    ...(r.metric ? { metric: r.metric } : {}), ...(r.window_days ? { windowDays: r.window_days } : {}), baseline: r.baseline, appliedAt: r.applied_at ? ms(r.applied_at) : null, appliedBy: r.applied_by,
    rollback: r.rollback ? { summary: r.rollback.summary, available: r.rollback.available && (r.status === "applied" || r.status === "verified") } : null,
    verification: r.verification,
  };
}

/** The next LP-n. Callers hold the advisory lock on the proposal list. */
export async function nextProposalId(tx: Queryable, orgId: string): Promise<string> {
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`proposals:${orgId}`]);
  const r = (await tx.query<{ n: string }>(`select (coalesce(max(substring(id from 4)::int), 0) + 1)::text as n from proposals where org_id = $1 and id ~ '^LP-[0-9]+$'`, [orgId])).rows[0]!;
  return `LP-${r.n}`;
}

export const stamp = (by: string, text: string, at = Date.now()): { at: number; by: string; text: string } => ({ at, by, text });
