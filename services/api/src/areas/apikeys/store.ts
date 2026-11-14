/** Reads for API keys and the request log, mapped to the legacy `apiKeys` and `requestLog` slices. */
import type { ApiKey, RequestLogEntry } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { ms } from "../../core/read/rows.js";

interface KeyRow {
  id: string; name: string; project_id: string | null; key_prefix: string; scopes: unknown; created_by: string | null; expires_at: Date | null; revoked_at: Date | null; revoked_by: string | null;
  last_used_at: Date | null; created_at: Date;
}
const COLS = `id, name, project_id, key_prefix, scopes, created_by, expires_at, revoked_at, revoked_by, last_used_at, created_at`;

export const prefixOf = (prefix: string): string => `gk_${prefix}`;

export function toKey(r: KeyRow): ApiKey {
  const now = Date.now();
  const expired = !!r.expires_at && r.expires_at.getTime() <= now;
  return {
    id: r.id, name: r.name, prefix: r.key_prefix, project: r.project_id ?? "", actions: Array.isArray(r.scopes) ? r.scopes.filter((s): s is string => typeof s === "string") : [], created: r.created_at.getTime(),
    lastUsed: ms(r.last_used_at) ?? null, revoked: !!r.revoked_at, by: r.created_by ?? "",
    expires: ms(r.expires_at) ?? null, ...(r.revoked_at ? { revokedAt: r.revoked_at.getTime() } : {}), ...(r.revoked_by ? { revokedBy: r.revoked_by } : {}), expired,
  };
}

/** Keys on the given projects (null = every project), revoked ones last. */
export async function readKeys(db: Queryable, orgId: string, projects: "all" | string[]): Promise<ApiKey[]> {
  const { rows } = await db.query<KeyRow>(
    `select ${COLS} from api_keys where org_id = $1 and ($2::text[] is null or project_id = any($2)) order by (revoked_at is not null), created_at desc, id`,
    [orgId, projects === "all" ? null : projects],
  );
  return rows.map(toKey);
}

export async function readKey(db: Queryable, orgId: string, id: string): Promise<ApiKey | null> {
  const { rows } = await db.query<KeyRow>(`select ${COLS} from api_keys where org_id = $1 and id = $2`, [orgId, id]);
  return rows[0] ? toKey(rows[0]) : null;
}

export interface LogQuery { key?: string | undefined; status?: "all" | "2xx" | "429" | "4xx" | undefined; cursor?: string | undefined; limit?: number | undefined }

/** Newest first. The cursor is the id of the last row of the previous page. Only requests of keys on the given projects. */
export async function readRequests(db: Queryable, orgId: string, projects: "all" | string[], q: LogQuery): Promise<{ items: RequestLogEntry[]; next: string | null; total: number; last24h: number; limited24h: number }> {
  const limit = q.limit ?? 80;
  const st = q.status ?? "all";
  const cond = `r.org_id = $1 and ($2::text[] is null or k.project_id = any($2)) and ($3::text is null or r.key_id = $3)
    and ($4 = 'all' or ($4 = '2xx' and r.status < 300) or ($4 = '429' and r.status = 429) or ($4 = '4xx' and r.status >= 400 and r.status <> 429))`;
  const args = [orgId, projects === "all" ? null : projects, q.key ?? null, st];
  const page = await db.query<{ id: string; key_id: string; method: string; path: string; status: number; duration_ms: number; at: Date }>(
    `select r.id::text as id, r.key_id, r.method, r.path, r.status, r.duration_ms, r.at from api_requests r join api_keys k on k.org_id = r.org_id and k.id = r.key_id
      where ${cond} and ($5::bigint is null or r.id < $5) order by r.id desc limit $6`,
    [...args, q.cursor && /^\d{1,18}$/.test(q.cursor) ? q.cursor : null, limit + 1],
  );
  const more = page.rows.length > limit;
  const rows = page.rows.slice(0, limit);
  const total = (await db.query<{ n: string }>(`select count(*)::text as n from api_requests r join api_keys k on k.org_id = r.org_id and k.id = r.key_id where ${cond}`, args)).rows[0]!.n;
  const day = (await db.query<{ n: string; l: string }>(
    `select count(*)::text as n, count(*) filter (where r.status = 429)::text as l from api_requests r join api_keys k on k.org_id = r.org_id and k.id = r.key_id
      where r.org_id = $1 and ($2::text[] is null or k.project_id = any($2)) and r.at > now() - interval '24 hours'`, [orgId, projects === "all" ? null : projects])).rows[0]!;
  return {
    items: rows.map((r) => ({ at: r.at.getTime(), key: r.key_id, method: r.method, path: r.path, status: r.status, ms: r.duration_ms })),
    next: more ? rows[rows.length - 1]!.id : null, total: Number(total), last24h: Number(day.n), limited24h: Number(day.l),
  };
}

/** The person who created a key: work the key submits is recorded on their behalf. */
export async function keyCreator(db: Queryable, orgId: string, id: string): Promise<string | null> {
  const { rows } = await db.query<{ created_by: string | null }>(`select created_by from api_keys where org_id = $1 and id = $2`, [orgId, id]);
  return rows[0]?.created_by ?? null;
}
