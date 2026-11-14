/** API key and API settings commands (spec 8.8, 12.5). Each runs inside `command()`: decision point, state and event in one transaction. The secret is returned once and never stored. */
import { randomBytes } from "node:crypto";
import type { Tx } from "@gantry/db";
import type { Actor, CommandResult } from "../../core/command.js";
import { generateApiKey } from "../../core/auth/apikeys.js";
import { conflict, invalid, notFound } from "../../core/errors.js";
import { DEFAULT_API, parseApi, type ApiSettings } from "./config.js";
import { KEY_ACTIONS } from "./schemas.js";
import { prefixOf, readKey } from "./store.js";

type Cmd = CommandResult<Record<string, unknown>>;
const DAY = 86_400_000;

/** A new key on one project. `extra.secret` is the only time the full key is visible; the response is not stored for idempotent replays (see `storedOmit`). */
export async function createKey(tx: Tx, a: Actor, b: { name: string; project: string; actions?: string[] | undefined; expiresInDays?: number | undefined }): Promise<Cmd> {
  const p = (await tx.query<{ id: string; name: string; status: string }>(`select id, name, status from projects where org_id = $1 and id = $2`, [a.orgId, b.project])).rows[0];
  if (!p) throw notFound("No such project.");
  if (p.status === "archived") throw conflict(`${p.name} is archived and read-only.`);
  const actions = [...new Set(b.actions?.length ? b.actions : ["wo.submit", "wo.read"])].filter((x) => (KEY_ACTIONS as readonly string[]).includes(x));
  if (!actions.length) throw invalid("Pick at least one scope.");
  const expires = new Date(a.now.getTime() + (b.expiresInDays ?? 90) * DAY);
  const { key, prefix, hash } = generateApiKey();
  const id = `key-${randomBytes(5).toString("hex")}`;
  await tx.query(
    `insert into api_keys (org_id, id, name, project_id, key_hash, key_prefix, scopes, created_by, expires_at, created_at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
    [a.orgId, id, b.name.trim(), b.project, hash, prefixOf(prefix), JSON.stringify(actions), a.personId, expires, a.now],
  );
  const created = (await readKey(tx, a.orgId, id))!;
  return {
    msg: "Key created. Copy it now; it is not shown again.",
    events: [{ type: "api.key.create", category: "api", subject: { type: "apikey", id }, projectId: b.project, after: { name: created.name, prefix: created.prefix, project: b.project, actions, expires: created.expires } }],
    extra: { key: created, secret: key }, changes: ["apiKeys"], project: b.project,
  };
}

/** Revoking is immediate: the next request with the key fails with 401. */
export async function revokeKey(tx: Tx, a: Actor, id: string): Promise<Cmd> {
  const r = (await tx.query<{ name: string; key_prefix: string; project_id: string | null; revoked_at: Date | null }>(`select name, key_prefix, project_id, revoked_at from api_keys where org_id = $1 and id = $2 for update`, [a.orgId, id])).rows[0];
  if (!r) throw notFound("No such key.");
  if (r.revoked_at) throw conflict(`${r.name} is already revoked.`);
  await tx.query(`update api_keys set revoked_at = $3, revoked_by = $4, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, id, a.now, a.personId]);
  return {
    msg: `${r.name} revoked.`,
    events: [{ type: "api.key.revoke", category: "api", subject: { type: "apikey", id }, projectId: r.project_id, before: { revoked: false }, after: { name: r.name, prefix: r.key_prefix, revoked: true } }],
    changes: ["apiKeys"], project: r.project_id,
  };
}

export async function lockApiSettings(tx: Tx, orgId: string): Promise<{ version: number; value: ApiSettings }> {
  const { rows } = await tx.query<{ settings: unknown }>(`select settings from orgs where id = $1 for update`, [orgId]);
  return parseApi(rows[0]?.settings);
}

/** Merges the patch into orgs.settings.api. The version bumps on every save; a caller that sent `If-Match` is refused when it is not the current one. */
export async function setApiConfig(tx: Tx, a: Actor, patch: Partial<ApiSettings>): Promise<Cmd> {
  const cur = await lockApiSettings(tx, a.orgId);
  if (a.ifMatch !== null && a.ifMatch !== cur.version) throw conflict("The API settings changed since you loaded them. Reload and try again.");
  const next: ApiSettings = { ...DEFAULT_API, ...cur.value, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  const changed = (Object.keys(next) as Array<keyof ApiSettings>).filter((k) => next[k] !== cur.value[k]);
  if (!changed.length) return { msg: "API settings are unchanged.", events: [], changes: ["apiConfig"], project: null, extra: { version: cur.version } };
  const version = cur.version + 1;
  await tx.query(`update orgs set settings = jsonb_set(settings, '{api}', $2::jsonb, true), updated_at = now() where id = $1`, [a.orgId, JSON.stringify({ ...next, version })]);
  const pick = (v: ApiSettings): Record<string, unknown> => Object.fromEntries(changed.map((k) => [k, v[k]]));
  return {
    msg: changed.includes("triggersEnabled") && next.triggersEnabled ? "API settings saved. Triggers are switched on for the organisation." : "API settings saved.",
    events: [{ type: "api.config", category: "api", subject: { type: "org", id: a.orgId }, before: pick(cur.value), after: pick(next) }],
    changes: ["apiConfig"], project: null, extra: { version },
  };
}
