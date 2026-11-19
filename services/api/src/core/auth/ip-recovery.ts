import { randomBytes } from "node:crypto";
import { appendEvent, type Queryable, type Tx } from "@gantry/db";

/** How long the session made by a recovery sign-in may use the API from that one address (time to confirm the allow-list entry in the app). */
export const RECOVERY_SESSION_MIN = 30;

/**
 * Called inside the sign-in transaction when the address is not on the allow-list. Consumes the named admin's open window (once) and returns true,
 * or returns false and changes nothing. Nobody else's window is touched, and an expired window never opens.
 */
export async function consumeRecoveryWindow(tx: Tx, orgId: string, personId: string, ip: string): Promise<string | null> {
  const w = (await tx.query<{ id: string }>(
    `select id from allowlist_recovery where org_id = $1 and person_id = $2 and status = 'open' and expires_at > now() order by created_at desc limit 1 for update`,
    [orgId, personId],
  )).rows[0];
  if (!w) return null;
  await tx.query(`update allowlist_recovery set status = 'used', used_at = now(), used_ip = $3::inet where org_id = $1 and id = $2`, [orgId, w.id, ip]);
  return w.id;
}

/** Binds the consumed window to the session the sign-in produced, and records the use in the ledger. */
export async function bindRecoveryWindow(tx: Tx, orgId: string, windowId: string, personId: string, sessionId: string, ip: string, requestId: string): Promise<void> {
  await tx.query(`update allowlist_recovery set session_id = $3 where org_id = $1 and id = $2`, [orgId, windowId, sessionId]);
  await appendEvent(tx, {
    orgId, type: "auth.allowlist_recovery.used", category: "auth", actor: personId, channel: "web", subject: { type: "person", id: personId },
    after: { window: windowId, address: ip, note: "one-time sign-in from outside the allow-list, opened by the operator" }, sessionId, sourceIp: ip || null, requestId,
  });
}

/** Does this session hold a used recovery window for this address, still within its short life? Only then may it pass the allow-list. */
export async function sessionMayPassAllowList(db: Queryable, orgId: string, sessionId: string, ip: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `select 1 from allowlist_recovery where org_id = $1 and session_id = $2 and status in ('used','added','declined') and host(used_ip) = $3
       and used_at > now() - make_interval(mins => $4::int) limit 1`,
    [orgId, sessionId, ip.startsWith("::ffff:") ? ip.slice(7) : ip, RECOVERY_SESSION_MIN],
  );
  return (rowCount ?? 0) > 0;
}

/** The address waiting for the admin's confirmation, for the session asking. */
export async function pendingRecovery(db: Queryable, orgId: string, sessionId: string): Promise<{ id: string; address: string; usedAt: Date } | null> {
  const r = (await db.query<{ id: string; address: string; used_at: Date }>(
    `select id, host(used_ip) as address, used_at from allowlist_recovery where org_id = $1 and session_id = $2 and status = 'used' order by used_at desc limit 1`, [orgId, sessionId],
  )).rows[0];
  return r ? { id: r.id, address: r.address, usedAt: r.used_at } : null;
}

export const newRecoveryId = (): string => `ar-${randomBytes(6).toString("hex")}`;
