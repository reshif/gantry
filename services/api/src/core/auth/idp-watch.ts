import { withTx } from "@gantry/db";
import type { Gantry } from "../context.js";
import { recordMfaChangedOutside } from "./mfa-alert.js";
import type { IdpAdminEvent } from "./idp-admin.js";

/**
 * Notices credential and password changes at the identity provider that Gantry did not make (G-M1, G-M2). The provider's admin events are read with the
 * service account; each change is matched against idp_admin_log, the log of the calls Gantry's own client made. A change by the service account with no
 * logged call near it (someone using the secret directly), or by anyone else (the provider's console, the master admin), is recorded as
 * `auth.mfa_changed_outside` and emailed to the Factory Admins. Detective only: nothing is refused or undone.
 */
const SLOP_MS = 120_000;

export async function checkIdpAdminEvents(g: Gantry, now = Date.now()): Promise<{ checked: number; flagged: number }> {
  const idp = g.idpAdmin;
  if (!idp) return { checked: 0, flagged: 0 };
  const cur = (await g.pool.query<{ at: string | null }>(`select settings->>'idpEventsAt' as at from orgs where id = $1`, [g.orgId])).rows[0]?.at;
  const since = cur ? Number(cur) : now - 5 * 60_000; // the first run looks back five minutes, not the whole history
  let events: IdpAdminEvent[];
  try { events = await idp.credentialEvents(since); } catch { return { checked: 0, flagged: 0 }; }
  let flagged = 0;
  let newest = since;
  for (const e of events.sort((a, b) => a.time - b.time)) {
    newest = Math.max(newest, e.time);
    const ours = e.clientId === "gantry-admin" && (await g.pool.query(`select 1 from idp_admin_log where org_id = $1 and at between $2 and $3 limit 1`, [g.orgId, new Date(e.time - SLOP_MS), new Date(e.time + SLOP_MS)])).rowCount;
    if (ours) continue;
    const userId = /^users\/([^/]+)/.exec(e.resourcePath)?.[1] ?? null;
    await withTx(g.pool, async (tx) => {
      const person = userId ? (await tx.query<{ id: string }>(`select id from people where org_id = $1 and idp_subject = $2`, [g.orgId, userId])).rows[0]?.id ?? null : null;
      if (person) await tx.query(`update people set mfa_fingerprint = null where org_id = $1 and id = $2`, [g.orgId, person]); // the next sign-in is a new baseline, flagged by the audit above
      await recordMfaChangedOutside(tx, g.orgId, person, { why: "provider_admin_event", detail: { operation: e.operation, resource: e.resourcePath, by: e.clientId ? `client ${e.clientId}` : `a console user in realm ${e.realmId ?? "?"}`, at: new Date(e.time).toISOString() } });
    });
    flagged++;
  }
  await g.pool.query(`update orgs set settings = settings || jsonb_build_object('idpEventsAt', $2::text) where id = $1`, [g.orgId, String(Math.max(newest, now - 1000))]);
  return { checked: events.length, flagged };
}

/** Once at start: records who holds which second factors, from the provider, as the baseline (people.mfa, mfa_types and the fingerprint), so the status is right before anyone signs in again (G-M9). */
export async function backfillMfa(g: Gantry): Promise<number> {
  const idp = g.idpAdmin;
  if (!idp) return 0;
  const rows = (await g.pool.query<{ id: string; idp_subject: string }>(`select id, idp_subject from people where org_id = $1 and idp_subject is not null and status <> 'deactivated'`, [g.orgId])).rows;
  let n = 0;
  for (const p of rows) {
    try {
      const f = await idp.secondFactors(p.idp_subject);
      const { fingerprintOf } = await import("./signin.js");
      await g.pool.query(`update people set mfa = $3, mfa_types = $4, mfa_fingerprint = $5, mfa_checked_at = now() where org_id = $1 and id = $2`, [g.orgId, p.id, f.length > 0, [...new Set(f.map((x) => x.type))].sort(), f.length ? fingerprintOf(f) : null]);
      n++;
    } catch { /* the provider is not reachable now: the next sign-in records it */ }
  }
  return n;
}

export function startIdpWatch(g: Gantry, everyMs = 60_000): NodeJS.Timeout {
  const t = setInterval(() => void checkIdpAdminEvents(g).catch(() => undefined), everyMs);
  t.unref();
  return t;
}
