import { appendEvent, type Tx } from "@gantry/db";
import { holdsFactoryAdmin } from "./mfa.js";
import { newRecoveryId } from "./ip-recovery.js";
import { readSecurity } from "../read/index.js";

export const RECOVERY_DEFAULT_MIN = 30;
export const RECOVERY_MAX_MIN = 60;

/**
 * Opens the one-time window for a locked-out Factory Admin's NEXT sign-in from any address. Called ONLY by the operator command on the server host
 * (src/cli/allowlist-recovery.ts); no route imports this file, and a test keeps it that way. It does not touch the allow-list itself.
 */
export async function openRecoveryWindow(tx: Tx, orgId: string, personId: string, minutes: number): Promise<{ id: string; expiresAt: Date }> {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > RECOVERY_MAX_MIN) throw new Error(`--minutes must be a whole number from 1 to ${RECOVERY_MAX_MIN}.`);
  const p = (await tx.query<{ status: string; name: string }>(`select status, name from people where org_id = $1 and id = $2`, [orgId, personId])).rows[0];
  if (!p) throw new Error(`There is no person ${personId}.`);
  if (p.status !== "active") throw new Error(`${personId} is ${p.status}; recovery is only for an active Factory Admin.`);
  if (!(await holdsFactoryAdmin(tx, orgId, personId))) throw new Error(`${personId} is not a Factory Admin.`);
  const sec = (await readSecurity(tx, orgId)).value;
  if (!sec.ipAllow.length) throw new Error("The IP allow-list is empty, so nobody is locked out by it. Nothing to recover.");
  await tx.query(`update allowlist_recovery set status = 'replaced' where org_id = $1 and person_id = $2 and status = 'open'`, [orgId, personId]);
  const id = newRecoveryId();
  const row = (await tx.query<{ expires_at: Date }>(
    `insert into allowlist_recovery (org_id, id, person_id, expires_at) values ($1,$2,$3, now() + make_interval(mins => $4::int)) returning expires_at`, [orgId, id, personId, minutes],
  )).rows[0]!;
  await appendEvent(tx, {
    orgId, type: "auth.allowlist_recovery.opened", category: "auth", actor: "operator", channel: "system", subject: { type: "person", id: personId },
    after: { window: id, person: personId, minutes, expiresAt: row.expires_at.toISOString(), note: "one sign-in from any address; MFA and step-up still apply; the allow-list is unchanged" },
  });
  return { id, expiresAt: row.expires_at };
}
