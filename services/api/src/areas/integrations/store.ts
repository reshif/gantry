/** Persistence of integration types and instances (spec 7.3), mapped to the legacy `integrationTypes` and `integrationInstances` slices. */
import type { IntegrationField, IntegrationInstance } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { ms, obj } from "../../core/read/rows.js";
import { builtinTypes, type ConnectorType, type Manifest } from "./connectors.js";

export const slug = (s: string): string => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

interface TypeRow { id: string; name: string; builtin: boolean; field_schema: IntegrationField[]; data: Record<string, unknown> }

/** Writes the built-in catalogue (idempotent). Called once at start-up and before a type is looked up, so a new install lists every connector. */
export async function ensureBuiltinTypes(db: Queryable, orgId: string): Promise<void> {
  for (const t of builtinTypes()) {
    const { id, name, fields, manifest, ...data } = t;
    await db.query(
      `insert into integration_types (org_id, id, name, builtin, field_schema, data) values ($1,$2,$3,true,$4::jsonb,$5::jsonb)
       on conflict (org_id, id) do update set name = excluded.name, field_schema = excluded.field_schema, data = excluded.data, builtin = true, updated_at = now()
       where integration_types.builtin and (integration_types.field_schema, integration_types.data, integration_types.name) is distinct from (excluded.field_schema, excluded.data, excluded.name)`,
      [orgId, id, name, JSON.stringify(fields), JSON.stringify({ ...data, manifest })],
    );
  }
}

const EMPTY_MANIFEST: Manifest = { version: "1.0.0", capabilities: ["notify"], operations: ["test", "send"], delivery: { idempotencyKey: "event id + destination", retryable: "network errors, HTTP 408, 425, 429 and 5xx", permanent: "other 4xx", rateLimit: "backoff with jitter" } };

export function typeFromRow(r: TypeRow): ConnectorType {
  const d = r.data;
  return {
    category: "custom", icon: "plug", auth: "token", payload: "json", targetLabel: "Target", events: [], actions: [], source: false, destination: true,
    ...(d as object), id: r.id, name: r.name, builtIn: r.builtin, fields: Array.isArray(r.field_schema) ? r.field_schema : [], custom: !r.builtin,
    manifest: (d.manifest as Manifest | undefined) ?? EMPTY_MANIFEST,
  } as ConnectorType;
}

export async function readTypes(db: Queryable, orgId: string): Promise<ConnectorType[]> {
  const { rows } = await db.query<TypeRow>(`select id, name, builtin, field_schema, data from integration_types where org_id = $1 order by builtin desc, created_at, id`, [orgId]);
  // Catalogue order: the built-in list as the domain defines it, then custom types by creation.
  const order = new Map(builtinTypes().map((t, i) => [t.id, i]));
  return rows.map(typeFromRow).sort((a, b) => (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6));
}

export async function readType(db: Queryable, orgId: string, id: string): Promise<ConnectorType | null> {
  const { rows } = await db.query<TypeRow>(`select id, name, builtin, field_schema, data from integration_types where org_id = $1 and id = $2`, [orgId, id]);
  return rows[0] ? typeFromRow(rows[0]) : null;
}

export interface InstanceRow {
  id: string; type_id: string; name: string; enabled: boolean; config: Record<string, unknown>; secret_enc: string | null; secret_mask: string | null; health: string; version: number; created_at: Date; updated_at: Date;
}

export interface Meta {
  projects: "all" | string[];
  targetId?: string;
  createdBy?: string;
  lastSync?: number;
  lastTest?: { at: number; ok: boolean; by: string; lines?: string[]; ms?: number };
}

export const metaOf = (config: Record<string, unknown>): Meta => {
  const m = obj(config._meta);
  return { ...(m as object), projects: m.projects === "all" || !Array.isArray(m.projects) ? "all" : (m.projects as string[]) } as Meta;
};
export const configOf = (config: Record<string, unknown>): Record<string, unknown> => {
  const { _meta, ...rest } = config;
  void _meta;
  return rest;
};

export function instanceFromRow(r: InstanceRow): IntegrationInstance {
  const meta = metaOf(r.config);
  const status = !r.enabled ? "offline" : r.health === "failing" ? "failing" : r.health === "offline" ? "offline" : r.health === "unknown" ? "unknown" : "healthy";
  return {
    id: r.id, type: r.type_id, name: r.name, config: configOf(r.config) as IntegrationInstance["config"], secretMask: r.secret_mask ?? "", status, connected: r.enabled, projects: meta.projects,
    lastSync: meta.lastSync ?? ms(r.updated_at) ?? 0, createdBy: meta.createdBy ?? "", createdAt: ms(r.created_at) ?? 0, ...(meta.targetId ? { targetId: meta.targetId } : {}),
    ...(meta.lastTest ? { lastTest: meta.lastTest } : {}), version: r.version,
  };
}

const COLS = `id, type_id, name, enabled, config, secret_enc, secret_mask, health, version, created_at, updated_at`;

export async function readInstanceRows(db: Queryable, orgId: string): Promise<InstanceRow[]> {
  return (await db.query<InstanceRow>(`select ${COLS} from integration_instances where org_id = $1 order by created_at, id`, [orgId])).rows;
}
export async function readInstanceRow(db: Queryable, orgId: string, id: string, lock = false): Promise<InstanceRow | null> {
  return (await db.query<InstanceRow>(`select ${COLS} from integration_instances where org_id = $1 and id = $2 ${lock ? "for update" : ""}`, [orgId, id])).rows[0] ?? null;
}
export async function readInstances(db: Queryable, orgId: string): Promise<IntegrationInstance[]> {
  return (await readInstanceRows(db, orgId)).map(instanceFromRow);
}

/** Who depends on an instance (legacy `usage`): routes (explicit or by type), repo overrides, triggers and repos connected through it. */
export async function usageOf(db: Queryable, orgId: string, inst: InstanceRow): Promise<{ routes: number; overrides: number; triggers: Array<{ id: string; name: string; enabled: boolean }>; repos: number }> {
  const routes = (await db.query<{ n: string }>(`select count(*) as n from notification_routes r, jsonb_array_elements(r.destinations) d where r.org_id = $1 and d ->> 'integration' = $2`, [orgId, inst.id])).rows[0]!.n;
  const overrides = (await db.query<{ n: string }>(
    `select count(*) as n from repos r, jsonb_array_elements(coalesce(r.data -> 'notifyOverrides', '[]'::jsonb)) o, jsonb_array_elements(coalesce(o -> 'dest', '[]'::jsonb)) d where r.org_id = $1 and d ->> 'integration' = $2`, [orgId, inst.id],
  )).rows[0]!.n;
  const triggers = (await db.query<{ id: string; name: string; enabled: boolean }>(`select id, name, enabled from triggers where org_id = $1 and config ->> 'source' = $2`, [orgId, inst.id])).rows;
  const repos = (await db.query<{ n: string }>(`select count(*) as n from repos where org_id = $1 and data ->> 'source' = $2`, [orgId, inst.id])).rows[0]!.n;
  return { routes: Number(routes), overrides: Number(overrides), triggers, repos: Number(repos) };
}
