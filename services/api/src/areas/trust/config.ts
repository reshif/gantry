/**
 * Trust ladder settings (spec 13.3): the levels, the versioned promotion criteria and spot-check rate, and the runtime switch for levels above L1.
 * Criteria are immutable once published (`trust_criteria_versions`): a change publishes the next version, so a decision can name the criteria it was judged under.
 * Levels above L1 are switched off in a new install (spec 15.3). L4 is not grantable in the first version.
 */
import type { Queryable, Tx } from "@gantry/db";
import type { TrustCriteria } from "@gantry/domain";

/** Below this many finished reviewed runs a rate is shown as "insufficient data" (spec 13.3). */
export const MIN_RUNS = 5;
/** The highest level a person can grant in this version. L4 (unattended including release) is built into the ladder's shape but not grantable. */
export const MAX_GRANTABLE = 3;
export const DEFAULT_SAMPLE_RATE = 5;
export const DEFAULT_SOAK_DAYS = 14;
/** A proposal declined for a cell is not made again for this long (legacy: 3 days). */
export const REPROPOSE_MS = 3 * 86_400_000;
/** The system opens at most this many proposals at a time and per day, so a person is not flooded. */
export const PROPOSAL_CAP = 5;
export const PROPOSAL_DAY = 2;

/** Spec 13.3 proposed criteria: 20 clean reviewed runs for L2, 30 more for L3. L4 has criteria, but nobody can be granted it. */
export const DEFAULT_CRITERIA: Record<string, TrustCriteria> = {
  "2": { cleanRuns: 20, evalMin: 0.85, reworkMax: 0.15, incidentsMax: 0, windowD: 14 },
  "3": { cleanRuns: 30, evalMin: 0.9, reworkMax: 0.1, incidentsMax: 0, windowD: 30 },
  "4": { cleanRuns: 40, evalMin: 0.93, reworkMax: 0.06, incidentsMax: 0, windowD: 60 },
};

export const lvlNum = (s: string | null | undefined): number => {
  const n = Number(/^L(\d)$/.exec(s ?? "")?.[1]);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : 1;
};
export const lvlCode = (n: number): string => `L${n}`;

export interface CriteriaDoc {
  version: number;
  criteria: Record<string, TrustCriteria>;
  sampleRate: number;
  soakDays: number;
}

const isCriteria = (c: unknown): c is TrustCriteria => !!c && typeof c === "object" && ["cleanRuns", "evalMin", "reworkMax", "incidentsMax", "windowD"].every((k) => typeof (c as Record<string, unknown>)[k] === "number");

export async function readCriteria(db: Queryable, orgId: string): Promise<CriteriaDoc> {
  const r = (await db.query<{ version: number; body: Record<string, unknown> }>(`select version, body from trust_criteria_versions where org_id = $1 order by version desc limit 1`, [orgId])).rows[0];
  const criteria: Record<string, TrustCriteria> = { ...DEFAULT_CRITERIA };
  const stored = (r?.body.criteria ?? {}) as Record<string, unknown>;
  for (const k of ["2", "3", "4"]) if (isCriteria(stored[k])) criteria[k] = { ...(stored[k] as TrustCriteria) };
  const sr = Number(r?.body.sampleRate);
  const soak = Number(r?.body.soakDays);
  return { version: r?.version ?? 0, criteria, sampleRate: Number.isInteger(sr) && sr >= 2 && sr <= 50 ? sr : DEFAULT_SAMPLE_RATE, soakDays: Number.isInteger(soak) && soak > 0 ? soak : DEFAULT_SOAK_DAYS };
}

/** Publishes the next criteria version (the previous one stays, immutable). */
export async function publishCriteria(tx: Tx, orgId: string, doc: Pick<CriteriaDoc, "criteria" | "sampleRate" | "soakDays">, by: string, note: string): Promise<number> {
  const next = Number((await tx.query<{ n: string }>(`select (coalesce(max(version), 0) + 1)::text as n from trust_criteria_versions where org_id = $1`, [orgId])).rows[0]!.n);
  await tx.query(`insert into trust_criteria_versions (org_id, version, body, note, published_at, published_by) values ($1,$2,$3::jsonb,$4,now(),$5)`, [
    orgId, next, JSON.stringify({ criteria: doc.criteria, sampleRate: doc.sampleRate, soakDays: doc.soakDays }), note, by,
  ]);
  return next;
}

/** The runtime switch (spec 15.3): trust levels above L1 do nothing until a person turns them on. */
export async function levelsAboveL1(db: Queryable, orgId: string): Promise<boolean> {
  const r = (await db.query<{ on: boolean }>(`select coalesce((settings->'trust'->>'levelsAboveL1')::boolean, false) as on from orgs where id = $1`, [orgId])).rows[0];
  return r?.on === true;
}
export async function setLevelsAboveL1(tx: Tx, orgId: string, on: boolean): Promise<void> {
  await tx.query(`update orgs set settings = jsonb_set(settings, '{trust}', coalesce(settings->'trust', '{}'::jsonb) || $2::jsonb, true) where id = $1`, [orgId, JSON.stringify({ levelsAboveL1: on })]);
}
