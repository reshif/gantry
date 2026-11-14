/** Legacy console settings (spec 12.6): the old factory-wide "actions" switch, retired in favour of console rights in the role matrix. The stored value is ignored. */
import type { Queryable, Tx } from "@gantry/db";
import { obj } from "../../core/read/rows.js";

export interface ConsoleSettings {
  /** The model may propose actions (confirm cards that call the ordinary endpoints). Off in a new install: the console is read-only. */
  actionsEnabled: boolean;
  version: number;
}

export const THREAD_RETENTION_DAYS = 90;

export const parseConsole = (settings: unknown): ConsoleSettings => {
  const c = obj(obj(settings).console);
  return { actionsEnabled: c.actionsEnabled === true, version: typeof c.version === "number" ? c.version : 0 };
};

export async function readConsoleSettings(db: Queryable, orgId: string): Promise<ConsoleSettings> {
  const { rows } = await db.query<{ settings: unknown }>(`select settings from orgs where id = $1`, [orgId]);
  return parseConsole(rows[0]?.settings);
}

export async function writeConsoleSettings(tx: Tx, orgId: string, s: Omit<ConsoleSettings, "version">): Promise<number> {
  const cur = parseConsole((await tx.query<{ settings: unknown }>(`select settings from orgs where id = $1 for update`, [orgId])).rows[0]?.settings);
  const version = cur.version + 1;
  await tx.query(`update orgs set settings = jsonb_set(settings, '{console}', coalesce(settings->'console', '{}'::jsonb) || $2::jsonb, true) where id = $1`, [orgId, JSON.stringify({ actionsEnabled: s.actionsEnabled, version })]);
  return version;
}
