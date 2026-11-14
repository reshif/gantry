import type pg from "pg";

/**
 * Versioned config endpoints refuse a request without If-Match (409 "version required"). Tests that are not about concurrency call through
 * `withVersion`, which adds the current version the way the web client does (it reads the entity, then sends its version).
 * Returns undefined for URLs that are not versioned config endpoints.
 */
export async function currentVersion(db: pg.Pool, method: string, url: string): Promise<number | undefined> {
  if (method === "GET") return undefined;
  const path = url.split("?")[0]!;
  const one = async (sql: string, params: unknown[]): Promise<number | undefined> => (await db.query(sql, params)).rows[0]?.v ?? undefined;
  let m: RegExpExecArray | null;
  if ((m = /^\/api\/v1\/projects\/([^/]+)\/(config|flow\/.+|approvers\/.+|archive|unarchive)$/.exec(path))) return one(`select version as v from projects where id = $1`, [decodeURIComponent(m[1]!)]);
  if ((m = /^\/api\/v1\/templates\/([^/]+)$/.exec(path)) && method !== "POST") return one(`select version as v from templates where id = $1`, [decodeURIComponent(m[1]!)]);
  if (/^\/api\/v1\/access\/matrix\//.test(path)) return one(`select max(version) as v from role_matrix_versions where published_at is not null`, []);
  if ((m = /^\/api\/v1\/roles\/([^/]+)$/.exec(path))) return one(`select version as v from roles where id = $1`, [decodeURIComponent(m[1]!)]);
  if ((m = /^\/api\/v1\/policies\/([^/]+)$/.exec(path))) return one(`select current_version as v from policies where id = $1`, [decodeURIComponent(m[1]!)]);
  if ((m = /^\/api\/v1\/freezes\/([^/]+)\/end$/.exec(path))) return one(`select version as v from freezes where id = $1`, [decodeURIComponent(m[1]!)]);
  if (path === "/api/v1/security") return one(`select max(version) as v from security_settings where published_at is not null`, []);
  return undefined;
}

export async function withVersion(db: pg.Pool, method: string, url: string, extra: Record<string, string>): Promise<Record<string, string>> {
  if (Object.keys(extra).some((k) => k.toLowerCase() === "if-match")) return extra;
  const v = await currentVersion(db, method, url);
  return v === undefined ? extra : { ...extra, "if-match": String(v) };
}
