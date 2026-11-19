import type { Session } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { hmacHex, randomToken } from "../crypto.js";

export interface SessionRow {
  id: string;
  personId: string;
  method: string;
  authTime: number | null;
  /** The sign-in that made this session presented a second factor (acr/amr evidence at the provider). */
  secondFactor: boolean;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  ip: string | null;
  personName: string;
  personStatus: string;
}

export const tokenHash = (key: Buffer, token: string): string => hmacHex(key, `session:${token}`);
/** The CSRF token for a session: an HMAC of the session id, so only a holder of the session key can mint it (double-submit bound to the session). */
export const csrfFor = (key: Buffer, sessionId: string): string => hmacHex(key, `csrf:${sessionId}`);

export interface NewSession {
  orgId: string;
  personId: string;
  method: string;
  ip: string | null;
  userAgent: string;
  absoluteHours: number;
  /** When the person signed in at the provider; null when the token did not say (satisfies no step-up). */
  authTime: Date | null;
  idpSid?: string | null;
  acr?: string | null;
  secondFactor?: boolean;
}

export async function createSession(db: Queryable, key: Buffer, s: NewSession): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const id = `ses-${randomToken(9)}`;
  const expiresAt = new Date(Date.now() + s.absoluteHours * 3600_000);
  await db.query(
    `insert into sessions (org_id, id, person_id, token_hash, idp_sid, ip, user_agent, expires_at, auth_time, method, acr, second_factor)
     values ($1,$2,$3,$4,$5,$6::inet,$7,$8,$9,$10,$11,$12)`,
    [s.orgId, id, s.personId, tokenHash(key, token), s.idpSid ?? null, s.ip, s.userAgent.slice(0, 300), expiresAt, s.authTime, s.method, s.acr ?? null, s.secondFactor ?? false],
  );
  return { id, token, expiresAt };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a pg row
const toRow = (r: Record<string, any>): SessionRow => ({
  id: r.id, personId: r.person_id, method: r.method, authTime: r.auth_time ? new Date(r.auth_time).getTime() : null, secondFactor: r.second_factor === true,
  createdAt: new Date(r.created_at).getTime(), expiresAt: new Date(r.expires_at).getTime(), lastSeenAt: new Date(r.last_seen_at).getTime(), ip: r.ip,
  personName: r.person_name, personStatus: r.person_status,
});

/** The live session for a cookie token: not revoked, inside the absolute lifetime and the idle window. Null otherwise. */
export async function findSession(db: Queryable, key: Buffer, orgId: string, token: string, idleMin: number): Promise<SessionRow | null> {
  const { rows } = await db.query(
    `select s.id, s.person_id, s.method, s.auth_time, s.second_factor, s.created_at, s.expires_at, s.last_seen_at, host(s.ip) as ip, p.name as person_name, p.status as person_status
     from sessions s join people p on p.org_id = s.org_id and p.id = s.person_id
     where s.org_id = $1 and s.token_hash = $2 and s.revoked_at is null and s.expires_at > now() and s.last_seen_at > now() - make_interval(mins => $3::int)`,
    [orgId, tokenHash(key, token), idleMin],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** Records activity at most every 30 seconds per session. */
export async function touchSession(db: Queryable, orgId: string, s: SessionRow): Promise<void> {
  if (Date.now() - s.lastSeenAt < 30_000) return;
  await db.query(`update sessions set last_seen_at = now() where org_id = $1 and id = $2`, [orgId, s.id]);
}

export async function refreshAuthTime(db: Queryable, orgId: string, id: string, authTime: Date, secondFactor = false): Promise<void> {
  await db.query(`update sessions set auth_time = $3, second_factor = second_factor or $4, last_seen_at = now() where org_id = $1 and id = $2`, [orgId, id, authTime, secondFactor]);
}

/** Revokes one session (returns whether it was live) or, with `id` null, every live session of the person. */
export async function revokeSessions(db: Queryable, orgId: string, personId: string, id: string | null, by: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `update sessions set revoked_at = now(), revoked_by = $4 where org_id = $1 and person_id = $2 and revoked_at is null and ($3::text is null or id = $3) returning id`,
    [orgId, personId, id, by],
  );
  return rows.map((r) => r.id);
}

export async function sessionRevoked(db: Queryable, orgId: string, id: string): Promise<boolean> {
  const { rows } = await db.query(`select 1 from sessions where org_id = $1 and id = $2 and revoked_at is null and expires_at > now()`, [orgId, id]);
  return rows.length === 0;
}

/** Legacy `Session` shape. `currentId` marks the caller's own session. */
export async function listSessions(db: Queryable, orgId: string, personId: string | null, currentId: string | null): Promise<Session[]> {
  const { rows } = await db.query(
    `select id, person_id, method, user_agent, host(ip) as ip, created_at, last_seen_at, revoked_at, expires_at from sessions
     where org_id = $1 and ($2::text is null or person_id = $2) and (revoked_at is not null or expires_at > now()) and created_at > now() - interval '30 days' order by created_at desc limit 200`,
    [orgId, personId],
  );
  return rows.map((r) => ({
    id: r.id, person: r.person_id, method: r.method, device: r.user_agent, ip: r.ip ?? "", started: new Date(r.created_at).getTime(),
    lastSeen: new Date(r.last_seen_at).getTime(), revoked: r.revoked_at !== null || new Date(r.expires_at).getTime() <= Date.now(), ...(r.id === currentId ? { current: true } : {}),
  }));
}
