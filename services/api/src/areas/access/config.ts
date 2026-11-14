import type { Matrix, Person, Policy, PolicyState } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import { loadPolicyState } from "../../core/read/state.js";

/**
 * One configuration write at a time per org. Matrix, role, policy and role-grant edits all check invariants against the
 * state they read (last Factory Admin, matrix lockout), so they serialise on the org row. `for no key update` does not
 * block the foreign-key checks other inserts take on the same row.
 */
export async function lockOrgConfig(tx: Tx, orgId: string): Promise<void> {
  await tx.query(`select 1 from orgs where id = $1 for no key update`, [orgId]);
}

/** Policy state as this transaction sees it (after the lock, so it is the state the edit will change). */
export const stateIn = (tx: Tx, orgId: string): Promise<Awaited<ReturnType<typeof loadPolicyState>>> => loadPolicyState(tx, orgId);

/** Publishes the next matrix version. Published versions are immutable (migration 0009), so every edit is a new row. */
export async function publishMatrix(tx: Tx, orgId: string, matrix: Matrix, note: string, by: string): Promise<number> {
  const { rows } = await tx.query<{ v: number }>(`select coalesce(max(version), 0) + 1 as v from role_matrix_versions where org_id = $1`, [orgId]);
  const version = rows[0]!.v;
  await tx.query(`insert into role_matrix_versions (org_id, version, matrix, note, published_at, published_by) values ($1,$2,$3::jsonb,$4, now(), $5)`, [orgId, version, JSON.stringify(matrix), note, by]);
  return version;
}

export type { Person, Policy, PolicyState };
