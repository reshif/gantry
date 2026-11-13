import type { Queryable } from "@gantry/db";

export const CHANGES_CHANNEL = "gantry_changes";

/** What a change notification says: which legacy store slices changed, and for which project (absent = factory-wide). */
export interface Change {
  org: string;
  keys: string[];
  project?: string;
}

/**
 * Publishes a change inside the caller's transaction. Postgres delivers NOTIFY only when the transaction commits, so a rolled-back
 * command never announces itself. Any api replica and the worker may call this; every api replica's hub receives it.
 */
export async function publishChange(db: Queryable, change: Change): Promise<void> {
  const keys = [...new Set(change.keys)];
  if (!keys.length) return;
  const payload = JSON.stringify({ org: change.org, keys, ...(change.project ? { project: change.project } : {}) });
  await db.query(`select pg_notify($1, $2)`, [CHANGES_CHANNEL, payload.length > 7500 ? JSON.stringify({ org: change.org, keys: ["*"] }) : payload]);
}

export function parseChange(payload: string | undefined): Change | null {
  try {
    const v = JSON.parse(payload ?? "") as Partial<Change>;
    if (typeof v.org === "string" && Array.isArray(v.keys)) return { org: v.org, keys: v.keys.filter((k): k is string => typeof k === "string"), ...(typeof v.project === "string" ? { project: v.project } : {}) };
  } catch {
    /* ignore malformed notifications */
  }
  return null;
}
