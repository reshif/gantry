import { fmt } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import { conflict, invalid, notFound } from "../../core/errors.js";
import type { CommandResult } from "../../core/command.js";
import { readFreezes, readRepos } from "../../core/read/index.js";
import { lockOrgConfig } from "./config.js";
import type { z } from "zod";
import type { FreezeBody } from "./schemas.js";

export const freezeVersion = async (tx: Tx, orgId: string, id: string): Promise<number | null> =>
  (await tx.query(`select version from freezes where org_id = $1 and id = $2`, [orgId, id])).rows[0]?.version ?? null;

/** Spec 8.9 saveFreeze. A freeze names repos ("all" = every repo); POL-110 then denies releases on them. */
export async function createFreeze(tx: Tx, orgId: string, by: string, f: z.infer<typeof FreezeBody>): Promise<CommandResult<{ freeze: unknown; version: number }>> {
  await lockOrgConfig(tx, orgId);
  if (!(f.to > f.from)) throw invalid("The end must be after the start.");
  if (f.repos !== "all") {
    const known = new Set((await readRepos(tx, orgId)).map((r) => r.id));
    const missing = f.repos.filter((r) => !known.has(r));
    if (missing.length) throw invalid(`There is no repo ${missing[0]}.`);
  }
  const { rows } = await tx.query<{ n: number | null }>(`select max((substring(id from 5))::int) as n from freezes where org_id = $1 and id ~ '^FRZ-[0-9]+$'`, [orgId]);
  const id = `FRZ-${String((rows[0]?.n ?? 0) + 1).padStart(2, "0")}`;
  await tx.query(
    `insert into freezes (org_id, id, scope_type, name, starts_at, ends_at, created_by, data) values ($1,$2,'factory',$3, to_timestamp($4::float8 / 1000), to_timestamp($5::float8 / 1000), $6, $7::jsonb)`,
    [orgId, id, f.name, f.from, f.to, by, JSON.stringify({ repos: f.repos })],
  );
  const freeze = (await readFreezes(tx, orgId)).find((x) => x.id === id);
  return {
    msg: `${id} scheduled.`,
    events: [{ type: "freeze.create", category: "access", subject: { type: "freeze", id }, before: null, after: `${f.name} · ${f.repos === "all" ? "all repos" : f.repos.join(", ")} · ${fmt.stamp(f.from)} to ${fmt.stamp(f.to)}`, projectId: null }],
    extra: { freeze, version: 1 },
    changes: ["freezes", "policies"],
    project: null,
  };
}

/** Ends a running freeze now, or cancels one that has not started. `lifted_at` caps the end, so an ended freeze keeps its history. */
export async function endFreeze(tx: Tx, orgId: string, id: string): Promise<CommandResult<{ version: number }>> {
  await lockOrgConfig(tx, orgId);
  const f = (await readFreezes(tx, orgId)).find((x) => x.id === id);
  if (!f) throw notFound("No such freeze.");
  const now = Date.now();
  if (now >= f.to) throw conflict(`${id} has already ended.`);
  const active = now >= f.from;
  const { rows } = await tx.query(`update freezes set lifted_at = now(), version = version + 1, updated_at = now() where org_id = $1 and id = $2 returning version`, [orgId, id]);
  return {
    msg: `${id} ${active ? "ended." : "cancelled."}`,
    events: [{ type: "freeze.end", category: "access", subject: { type: "freeze", id }, before: fmt.stamp(f.to), after: fmt.stamp(now), projectId: null }],
    extra: { version: rows[0]!.version as number },
    changes: ["freezes", "policies"],
    project: null,
  };
}
