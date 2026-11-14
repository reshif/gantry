/**
 * Learning loop settings (spec 13.4, 15.3). Findings and signals are evidence and are always recorded; proposals (drafting, accepting, declining, verifying,
 * rolling back) are switched off in a new install and turned on deliberately. The switch lives in `orgs.settings.learning.proposals`.
 */
import type { Queryable, Tx } from "@gantry/db";

/** A finding needs the same signal at least this many times in the window (the same kind of signal has to repeat). */
export const MIN_REPEATS = 2;
/** Signals older than this do not open or feed a finding. */
export const FINDING_WINDOW_DAYS = 30;
/** Evidence kept on a finding (legacy: 20). */
export const EVIDENCE_CAP = 20;
/** Below this many signals a finding is a small sample (the screen says so). */
export const SMALL_SAMPLE = 3;
/** An eval score that falls by at least this much between two completed runs of the same suite is a regression signal. */
export const REGRESSION_DROP = 0.05;
export const MAX_WINDOW_DAYS = 90;
export const DEFAULT_WINDOW_DAYS = 14;

export const KINDS = ["skill", "eval", "guideline", "guardrail", "approver", "route"] as const;
export type Kind = (typeof KINDS)[number];

export const SIGNALS = ["rejection", "sendback", "revert", "incident", "override", "miss", "regression"] as const;
export type SignalType = (typeof SIGNALS)[number];

export const SWITCH_RULE = { kind: "switch", id: "LEARN-SWITCH", name: "Learning proposals are off" } as const;

export async function proposalsOn(db: Queryable, orgId: string): Promise<boolean> {
  const r = (await db.query<{ on: boolean }>(`select coalesce((settings->'learning'->>'proposals')::boolean, false) as on from orgs where id = $1`, [orgId])).rows[0];
  return r?.on === true;
}

export async function setProposalsOn(tx: Tx, orgId: string, on: boolean): Promise<void> {
  await tx.query(`update orgs set settings = jsonb_set(settings, '{learning}', coalesce(settings->'learning', '{}'::jsonb) || $2::jsonb, true) where id = $1`, [orgId, JSON.stringify({ proposals: on })]);
}
