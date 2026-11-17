import type { Queryable } from "@gantry/db";

export const CHANGES_CHANNEL = "gantry_changes";

/** What a change notification says: which legacy store slices changed, and for which project (absent = factory-wide). */
export interface Change {
  org: string;
  keys: string[];
  project?: string;
  /**
   * People allowed to read the item this change is about (a private chat: its owner and members). Only they receive it; absent, the
   * project filter alone decides. A change to an item with no project and no audience reaches no one who is not factory-wide.
   */
  audience?: string[];
}

/** Keys that name one item (a chat, work order, delivery): knowing they changed tells a reader the item exists and when it was active. */
export const ITEM_KEYS: ReadonlySet<string> = new Set(["console", "workspace", "conversations", "workOrders", "floor", "repos", "deliveries", "triggers"]);

/**
 * Publishes a change inside the caller's transaction. Postgres delivers NOTIFY only when the transaction commits, so a rolled-back
 * command never announces itself. Any api replica and the worker may call this; every api replica's hub receives it.
 */
export async function publishChange(db: Queryable, change: Change): Promise<void> {
  const keys = [...new Set(change.keys)];
  if (!keys.length) return;
  const aud = change.audience ? [...new Set(change.audience)] : undefined;
  const scope = (a: string[] | undefined) => ({ ...(change.project ? { project: change.project } : {}), ...(a ? { audience: a } : {}) });
  const payload = JSON.stringify({ org: change.org, keys, ...scope(aud) });
  if (Buffer.byteLength(payload) <= 7500) {
    await db.query(`select pg_notify($1, $2)`, [CHANGES_CHANNEL, payload]);
    return;
  }
  // Too big for one NOTIFY: say only that everything may have changed, keeping who it is for (split, so the audience is never widened).
  const chunks: Array<string[] | undefined> = [];
  if (aud) for (let i = 0; i < aud.length; i += 50) chunks.push(aud.slice(i, i + 50));
  else chunks.push(undefined);
  for (const c of chunks) await db.query(`select pg_notify($1, $2)`, [CHANGES_CHANNEL, JSON.stringify({ org: change.org, keys: ["*"], ...scope(c) })]);
}

export function parseChange(payload: string | undefined): Change | null {
  try {
    const v = JSON.parse(payload ?? "") as Partial<Change> & { audience?: unknown; project?: unknown };
    // A scope that is present but malformed must narrow, never widen: it reaches no one rather than everyone.
    const badScope = (v.audience !== undefined && !Array.isArray(v.audience)) || (v.project !== undefined && typeof v.project !== "string");
    if (typeof v.org === "string" && Array.isArray(v.keys) && badScope) return { org: v.org, keys: v.keys.filter((k): k is string => typeof k === "string"), audience: [] };
    if (typeof v.org === "string" && Array.isArray(v.keys)) return { org: v.org, keys: v.keys.filter((k): k is string => typeof k === "string"), ...(typeof v.project === "string" ? { project: v.project } : {}), ...(Array.isArray(v.audience) ? { audience: v.audience.filter((a): a is string => typeof a === "string") } : {}) };
  } catch {
    /* ignore malformed notifications */
  }
  return null;
}
