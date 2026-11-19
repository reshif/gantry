import { withTx } from "@gantry/db";
import type { Gantry } from "../context.js";
import { recordMfaChangedOutside } from "./mfa-alert.js";
import type { IdpAdminEvent } from "./idp-admin.js";

/**
 * Notices user changes at the identity provider that Gantry did not make (G-M1, G-M2, G-N1, G-N2). The provider's admin events are read in pages with the service
 * account (every USER event since a high-water mark, never a fixed window a flood could push a plant out of). An event is Gantry's own only if (a) it was made by
 * OUR service-account user (`authDetails.userId`; the client id in an event is an internal UUID, not "gantry-admin") AND (b) it matches a not-yet-used row of
 * idp_admin_log, the log of the calls Gantry's own client made, by operation and resource path within a few seconds; each row explains at most one event.
 * Everything else (the provider's console, the master admin, the service account used outside the logged client, an UPDATE of a user, which is how a factor is
 * planted through PUT) is recorded as `auth.mfa_changed_outside` and emailed to the Factory Admins. Detective only: nothing is refused or undone.
 *
 * LIMIT, stated plainly: code running inside the API process can write idp_admin_log (and can simply use the logged client), so this is best-effort against a
 * compromise of the API. It reliably catches changes made by anyone else, and the provider's own record is what makes them visible.
 */
const MATCH_MS = 8_000;
/** Calls that cannot plant or change a factor, and so are never alarms. */
const BENIGN = /(^|\/)(execute-actions-email|logout|send-verify-email)$/;
const PROBE_USER = /"username":"gantry-smtp-test-/;

/** Does a logged Gantry call explain this admin event? Same operation family and the same resource path. */
export function callMatchesEvent(row: { method: string; path: string }, e: { operation: string; resourcePath: string }): boolean {
  const path = row.path.split("?")[0]!.replace(/^\/+/, "");
  if (row.method === "POST" && path === "users") return e.operation === "CREATE" && /^users\/[^/]+$/.test(e.resourcePath);
  if (row.method === "PUT" && /^users\/[^/]+$/.test(path)) return e.operation === "UPDATE" && e.resourcePath === path;
  if ((row.method === "PUT" && path.endsWith("/reset-password")) || (row.method === "DELETE" && /\/credentials\/[^/]+$/.test(path))) return e.operation === "ACTION" && e.resourcePath === path;
  return false;
}

export async function checkIdpAdminEvents(g: Gantry, now = Date.now()): Promise<{ checked: number; flagged: number }> {
  const idp = g.idpAdmin;
  if (!idp) return { checked: 0, flagged: 0 };
  const cur = (await g.pool.query<{ at: string | null }>(`select settings->>'idpEventsAt' as at from orgs where id = $1`, [g.orgId])).rows[0]?.at;
  const since = cur ? Number(cur) : now - 5 * 60_000; // the first run looks back five minutes, not the whole history
  let events: IdpAdminEvent[];
  let complete: boolean;
  let svcUser: string | null;
  try { ({ events, complete } = await idp.credentialEvents(since)); svcUser = await idp.serviceAccountUserId(); } catch { return { checked: 0, flagged: 0 }; }
  const relevant = events.filter((e) => e.resourceType === "USER" && !BENIGN.test(e.resourcePath) && !(e.operation === "DELETE" && /^users\/[^/]+$/.test(e.resourcePath))).sort((a, b) => a.time - b.time);
  const rows = relevant.length
    ? (await g.pool.query<{ id: string; method: string; path: string; at: Date }>(`select id, method, path, at from idp_admin_log where org_id = $1 and at between $2 and $3 order by at`, [g.orgId, new Date(relevant[0]!.time - MATCH_MS), new Date(relevant[relevant.length - 1]!.time + MATCH_MS)])).rows
    : [];
  const used = new Set<string>();
  let flagged = 0;
  let newest = since;
  for (const e of events) newest = Math.max(newest, e.time);
  for (const e of relevant) {
    const mine = !!svcUser && e.userId === svcUser;
    if (mine) {
      const row = rows.find((r) => !used.has(r.id) && Math.abs(r.at.getTime() - e.time) <= MATCH_MS && callMatchesEvent(r, e));
      if (row) { used.add(row.id); continue; }
    } else if (e.operation === "CREATE" && e.representation && PROBE_USER.test(e.representation)) {
      continue; // the apply script's test-mail user (made by the master admin, deleted at once): expected once per run (G-N4)
    }
    const userId = /^users\/([^/]+)/.exec(e.resourcePath)?.[1] ?? null;
    await withTx(g.pool, async (tx) => {
      const person = userId ? (await tx.query<{ id: string }>(`select id from people where org_id = $1 and idp_subject = $2`, [g.orgId, userId])).rows[0]?.id ?? null : null;
      if (person) await tx.query(`update people set mfa_fingerprint = null where org_id = $1 and id = $2`, [g.orgId, person]); // the next sign-in is a new baseline, flagged by the audit above
      await recordMfaChangedOutside(tx, g.orgId, person, { why: "provider_admin_event", detail: { operation: e.operation, resource: e.resourcePath, by: mine ? "the Gantry service account, with no matching logged call" : e.clientId ? `another client (${e.clientId})` : `a console user in realm ${e.realmId ?? "?"}`, at: new Date(e.time).toISOString() } });
    });
    flagged++;
  }
  if (!complete) {
    await withTx(g.pool, (tx) => recordMfaChangedOutside(tx, g.orgId, null, { why: "events_incomplete", detail: { note: "The provider's admin events could not be read to the end (more than 20000 since the last check): a flood of changes may be hiding one. Review the provider's admin events by hand." } }));
    flagged++;
  }
  if (used.size) await g.pool.query(`delete from idp_admin_log where id = any($1::bigint[])`, [[...used]]);
  await g.pool.query(`delete from idp_admin_log where org_id = $1 and at < now() - interval '2 days'`, [g.orgId]);
  await g.pool.query(`update orgs set settings = settings || jsonb_build_object('idpEventsAt', $2::text) where id = $1`, [g.orgId, String(Math.max(newest, now - 1000))]);
  return { checked: events.length, flagged };
}

/**
 * Once at start (G-M9, G-N3): fills the People status from the provider, but ONLY where there is no baseline yet. Where a stored baseline differs from what the
 * provider holds now, something changed while the API was down or just before it restarted: that is raised as `auth.mfa_changed_outside` and the baseline is
 * NOT overwritten (the next sign-in compares against the same baseline and reconciles it). A provider that cannot be read changes nothing, so the status stays unknown.
 */
export async function backfillMfa(g: Gantry): Promise<number> {
  const idp = g.idpAdmin;
  if (!idp) return 0;
  const rows = (await g.pool.query<{ id: string; idp_subject: string; mfa_fingerprint: string | null; mfa_types: string[] }>(`select id, idp_subject, mfa_fingerprint, mfa_types from people where org_id = $1 and idp_subject is not null and status <> 'deactivated'`, [g.orgId])).rows;
  const { fingerprintOf } = await import("./signin.js");
  let n = 0;
  for (const p of rows) {
    try {
      const f = await idp.secondFactors(p.idp_subject);
      const fp = f.length ? fingerprintOf(f) : null;
      const types = [...new Set(f.map((x) => x.type))].sort();
      if (!p.mfa_fingerprint) {
        await g.pool.query(`update people set mfa = $3, mfa_types = $4, mfa_fingerprint = $5, mfa_checked_at = now() where org_id = $1 and id = $2`, [g.orgId, p.id, f.length > 0, types, fp]);
      } else if (p.mfa_fingerprint !== fp) {
        await withTx(g.pool, (tx) => recordMfaChangedOutside(tx, g.orgId, p.id, { why: "credentials_changed", detail: { before: p.mfa_types, types, when: "found at API start" } }));
      }
      n++;
    } catch { /* the provider is not reachable now: the status stays unknown until it is read */ }
  }
  return n;
}

export function startIdpWatch(g: Gantry, everyMs = 60_000): NodeJS.Timeout {
  const t = setInterval(() => void checkIdpAdminEvents(g).catch(() => undefined), everyMs);
  t.unref();
  return t;
}
