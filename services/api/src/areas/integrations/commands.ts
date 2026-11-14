/**
 * Integration commands (spec 8.8, 12.1). Each runs inside `command()`: decision point, event and state in one transaction, a denial audited.
 * Secrets are sealed with the data key and never appear in a row, an event or a response other than as a mask.
 */
import { randomBytes } from "node:crypto";
import type { IntegrationType } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import type { Actor, CommandResult } from "../../core/command.js";
import { conflict, invalid, notFound } from "../../core/errors.js";
import { BUILTIN_IDS, cleanConfig, validateConfig, type ConnectorType } from "./connectors.js";
import { type TestResult } from "./ops.js";
import { open, seal, type SecretSet } from "./secrets.js";
import { instanceFromRow, metaOf, readInstanceRow, readType, slug, typeFromRow, usageOf, type InstanceRow, type Meta } from "./store.js";
import type { z } from "zod";
import type { AddInstanceBody, CustomTypeBody, PatchInstanceBody } from "./schemas.js";

type Cmd<X extends object = Record<string, unknown>> = CommandResult<X>;
const json = (v: unknown): string => JSON.stringify(v);

/** Secrets from a body: `secrets` keyed by field, or the legacy single `secret` for the type's first secret field. */
export function secretsOf(t: Pick<IntegrationType, "fields">, b: { secret?: string | undefined; secrets?: Record<string, string> | undefined }): SecretSet {
  const keys = t.fields.filter((f) => f.type === "secret").map((f) => f.key);
  const out: SecretSet = {};
  for (const [k, v] of Object.entries(b.secrets ?? {})) {
    if (!keys.includes(k)) throw invalid(`${k} is not a secret field of this type.`);
    if (v.trim()) out[k] = v.trim();
  }
  if (b.secret?.trim() && keys[0] && !out[keys[0]]) out[keys[0]] = b.secret.trim();
  return out;
}

const eventCat = "integrations" as const;

/** A custom type (spec 12.1): a signed webhook in and templated HTTP out. It cannot act as source control. */
export async function addType(tx: Tx, a: Actor, b: z.infer<typeof CustomTypeBody>): Promise<Cmd> {
  if (!b.source && !b.destination) throw invalid("It must send events, receive them, or both.");
  const id = b.id ?? slug(b.name);
  if (!id) throw invalid("Name the integration.");
  if (BUILTIN_IDS.has(id) || (await readType(tx, a.orgId, id))) throw conflict(`An integration type called ${b.name} exists.`);
  const keys = b.fields.map((f) => f.key);
  if (keys.some((k, i) => keys.indexOf(k) !== i)) throw invalid("Each field needs a unique key.");
  if (b.destination && !b.fields.some((f) => f.type === "url")) throw invalid("Templated HTTP out needs an endpoint: add a URL field.");
  if (b.source && !b.fields.some((f) => f.type === "secret")) throw invalid("A signed webhook in needs a signing secret: add a secret field.");
  if (!b.destination && b.httpTemplate) throw invalid("A request template is for types that send.");
  if (b.fields.some((f) => f.type === "select" && !f.options?.length)) throw invalid("A choice field needs its options.");
  const t: Record<string, unknown> = {
    category: b.category, icon: b.icon, auth: b.auth, payload: b.payload, source: b.source, destination: b.destination, targetLabel: b.targetLabel, events: b.events, actions: b.actions,
    createdBy: a.personId ?? a.id, createdAt: a.now.getTime(), ...(b.httpTemplate ? { httpTemplate: b.httpTemplate } : {}),
    manifest: { version: "1.0.0", capabilities: [...(b.destination ? ["notify"] : []), ...(b.source ? ["trigger_source"] : [])], operations: ["test", ...(b.destination ? ["send"] : []), ...(b.source ? ["receive"] : [])],
      delivery: { idempotencyKey: "event id + destination", retryable: "network errors, HTTP 408, 425, 429 and 5xx", permanent: "other 4xx", rateLimit: "backoff with jitter" } },
  };
  await tx.query(`insert into integration_types (org_id, id, name, builtin, field_schema, data) values ($1,$2,$3,false,$4::jsonb,$5::jsonb)`, [a.orgId, id, b.name, json(b.fields.map((f) => ({ ...f, required: f.required !== false }))), json(t)]);
  return {
    msg: `${b.name} added to the catalogue.`, changes: ["integrationTypes"], project: null,
    events: [{ type: "integration.type", category: eventCat, subject: { type: "integrationType", id }, projectId: null, after: { name: b.name, category: b.category, source: b.source, destination: b.destination, fields: b.fields.map((f) => f.key) } }],
    extra: { type: { ...(typeFromRow({ id, name: b.name, builtin: false, field_schema: b.fields as never, data: t }) as object) } },
  };
}

export async function removeType(tx: Tx, a: Actor, id: string): Promise<Cmd> {
  const t = await readType(tx, a.orgId, id);
  if (!t) throw notFound("No such integration type.");
  if (t.builtIn) throw conflict(`${t.name} is built in.`);
  const used = (await tx.query<{ name: string }>(`select name from integration_instances where org_id = $1 and type_id = $2`, [a.orgId, id])).rows;
  if (used.length) throw conflict(`${used.length} connection${used.length > 1 ? "s use" : " uses"} this type: ${used.map((r) => r.name).join(", ")}. Remove ${used.length > 1 ? "them" : "it"} first.`);
  await tx.query(`delete from integration_types where org_id = $1 and id = $2`, [a.orgId, id]);
  return { msg: `${t.name} removed from the catalogue.`, changes: ["integrationTypes"], project: null, events: [{ type: "integration.type", category: eventCat, subject: { type: "integrationType", id }, projectId: null, before: { name: t.name }, after: null }] };
}

async function checkProjects(tx: Tx, orgId: string, projects: "all" | string[]): Promise<"all" | string[]> {
  if (projects === "all") return "all";
  const uniq = [...new Set(projects)];
  if (!uniq.length) throw invalid("Pick at least one project, or all projects.");
  const have = new Set((await tx.query<{ id: string }>(`select id from projects where org_id = $1 and id = any($2)`, [orgId, uniq])).rows.map((r) => r.id));
  const bad = uniq.filter((p) => !have.has(p));
  if (bad.length) throw invalid(`There is no project ${bad.join(", ")}.`);
  return uniq;
}

/**
 * A new connection is created switched off (spec 15.3: each integration instance has a runtime switch that is off in a new install). `enable: true`
 * switches it on as a deliberate part of creating it. `test` is the connection test the route ran before the transaction opened; its result is recorded.
 */
export async function addInstance(tx: Tx, a: Actor, dataKey: Buffer | null, b: z.infer<typeof AddInstanceBody>, test: TestResult | null): Promise<Cmd> {
  const t = await readType(tx, a.orgId, b.type);
  if (!t) throw invalid("Pick an integration type.");
  if (t.available === false) throw conflict(`${t.name} is not available yet.`);
  const secrets = secretsOf(t, b);
  const bad = validateConfig(t, b.config, secrets, { needSecret: true });
  if (bad) throw invalid(bad);
  const config = cleanConfig(t, b.config);
  const projects = await checkProjects(tx, a.orgId, b.projects ?? "all");
  let targetId: string | undefined;
  if (t.id === "webhook") {
    targetId = (b.targetId ?? "").trim();
    if (!/^[a-z0-9-]{2,24}$/.test(targetId)) throw invalid("Endpoint id: 2 to 24 lowercase letters, digits or dashes.");
    const dup = await tx.query(`select 1 from integration_instances where org_id = $1 and config -> '_meta' ->> 'targetId' = $2`, [a.orgId, targetId]);
    if (dup.rowCount) throw conflict(`An endpoint called ${targetId} exists.`);
  }
  const id = `int-${slug(b.name) || "conn"}-${randomBytes(2).toString("hex")}`;
  const sealed = seal(dataKey, id, secrets);
  const meta: Meta = { projects, createdBy: a.personId ?? a.id, lastSync: a.now.getTime(), ...(targetId ? { targetId } : {}), ...(test ? { lastTest: { at: a.now.getTime(), ok: test.ok, by: a.personId ?? a.id, lines: test.lines.map((l) => l[1]), ms: test.ms } } : {}) };
  const health = test ? (test.ok ? "healthy" : "failing") : "unknown";
  await tx.query(
    `insert into integration_instances (org_id, id, type_id, name, enabled, config, secret_enc, secret_mask, health) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
    [a.orgId, id, t.id, b.name, b.enable === true, json({ ...config, _meta: meta }), sealed.enc, sealed.mask, health],
  );
  const row = (await readInstanceRow(tx, a.orgId, id))!;
  const events: Cmd["events"] = [{ type: "integration.add", category: eventCat, subject: { type: "integration", id }, projectId: null, after: { name: b.name, type: t.id, config, projects, secretMask: sealed.mask, enabled: row.enabled } }];
  return { msg: `${b.name} added${row.enabled ? " and switched on" : ". It is switched off until you turn it on"}.`, changes: ["integrationInstances", "home"], project: null, events, extra: { integration: instanceFromRow(row) } };
}

/** The instance a path names: its id, or (the legacy channel form) a type id with exactly one instance. */
export async function resolveInstance(tx: Pick<Tx, "query">, orgId: string, idOrChannel: string, lock = false): Promise<InstanceRow> {
  const direct = await readInstanceRow(tx as Tx, orgId, idOrChannel, lock);
  if (direct) return direct;
  const byType = (await (tx as Tx).query<{ id: string }>(`select id from integration_instances where org_id = $1 and type_id = $2`, [orgId, idOrChannel])).rows;
  if (byType.length === 1) return (await readInstanceRow(tx as Tx, orgId, byType[0]!.id, lock))!;
  throw notFound("No such integration.");
}

export async function updateInstance(tx: Tx, a: Actor, dataKey: Buffer | null, idOrChannel: string, b: z.infer<typeof PatchInstanceBody>): Promise<Cmd> {
  const row = await resolveInstance(tx, a.orgId, idOrChannel, true);
  const t = (await readType(tx, a.orgId, row.type_id))!;
  const meta = metaOf(row.config);
  const { _meta, ...cfg } = row.config;
  void _meta;
  const before = { name: row.name, config: cfg, projects: meta.projects, connected: row.enabled };
  const incoming = secretsOf(t, b);
  const config = b.config ? { ...cfg, ...cleanConfig(t, { ...cfg, ...b.config }) } : cfg;
  if (b.config) for (const f of t.fields) if (f.type !== "secret" && f.key in b.config && (b.config[f.key] === "" || b.config[f.key] == null)) delete (config as Record<string, unknown>)[f.key];
  const bad = validateConfig(t, config, { ...Object.fromEntries(t.fields.filter((f) => f.type === "secret").map((f) => [f.key, "x".repeat(8)])), ...incoming }, { needSecret: false });
  if (bad) throw invalid(bad);
  let enc = row.secret_enc;
  let maskText = row.secret_mask ?? "";
  if (Object.keys(incoming).length) {
    const merged = { ...open(dataKey, row.id, row.secret_enc, t.fields.find((f) => f.type === "secret")?.key ?? "secret"), ...incoming };
    ({ enc, mask: maskText } = seal(dataKey, row.id, merged));
  }
  const projects = b.projects ? await checkProjects(tx, a.orgId, b.projects) : meta.projects;
  const enabled = b.connected ?? row.enabled;
  if (enabled && !row.enabled) {
    const missing = t.fields.filter((f) => f.type === "secret" && f.required !== false).filter((f) => !open(dataKey, row.id, enc, f.key)[f.key]);
    if (missing.length) throw invalid(`Add the ${missing[0]!.label.toLowerCase()} before switching it on.`);
  }
  const nextMeta: Meta = { ...meta, projects, lastSync: a.now.getTime() };
  const name = b.name ?? row.name;
  await tx.query(
    `update integration_instances set name = $3, enabled = $4, config = $5::jsonb, secret_enc = $6, secret_mask = $7, health = $8, version = version + 1, updated_at = now() where org_id = $1 and id = $2`,
    [a.orgId, row.id, name, enabled, json({ ...config, _meta: nextMeta }), enc, maskText, b.connected === false ? "offline" : b.connected === true ? "unknown" : row.health],
  );
  const changed = Object.keys(b).filter((k) => k !== "via");
  const after = { name, config, projects, connected: enabled, ...(Object.keys(incoming).length ? { secretMask: maskText } : {}) };
  return {
    msg: `${name} saved.`, changes: ["integrationInstances", "integrations", "home"], project: null,
    events: [{ type: "integration.edit", category: eventCat, subject: { type: "integration", id: row.id }, projectId: null, before, after: { ...after, changed } }],
    extra: { integration: instanceFromRow((await readInstanceRow(tx, a.orgId, row.id))!) },
  };
}

/** Records a connection test: health, the time and the result. The call itself ran before the transaction (a network call does not hold a transaction open). */
export async function recordTest(tx: Tx, a: Actor, idOrChannel: string, r: TestResult): Promise<Cmd> {
  const row = await resolveInstance(tx, a.orgId, idOrChannel, true);
  const meta = metaOf(row.config);
  const { _meta, ...cfg } = row.config;
  void _meta;
  const next: Meta = { ...meta, lastSync: a.now.getTime(), lastTest: { at: a.now.getTime(), ok: r.ok, by: a.personId ?? a.id, lines: r.lines.map((l) => l[1]), ms: r.ms } };
  await tx.query(`update integration_instances set config = $3::jsonb, health = $4, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, row.id, json({ ...cfg, _meta: next }), r.ok ? "healthy" : "failing"]);
  return {
    msg: r.ok ? `${row.name} answered in ${r.ms} ms.` : `${row.name}: ${r.lines.find((l) => l[0] === "fail")?.[1] ?? "the test failed."}`, changes: ["integrationInstances", "integrations", "home"], project: null,
    events: [{ type: "integration.test", category: eventCat, subject: { type: "integration", id: row.id }, projectId: null, outcome: r.ok ? "ok" : "failed", after: { name: row.name, ok: r.ok, ms: r.ms, lines: r.lines.map((l) => l[1]) } }],
    extra: { test: { ok: r.ok, ms: r.ms, lines: r.lines }, integration: instanceFromRow((await readInstanceRow(tx, a.orgId, row.id))!) },
  };
}

/** A test of settings that are not saved yet (the Add integration dialog's third step): recorded as an audit event, changes no row. */
export function recordDraftTest(a: Actor, t: Pick<ConnectorType, "id" | "name">, r: TestResult): Cmd {
  return {
    msg: r.ok ? `${t.name} answered in ${r.ms} ms.` : `${t.name}: ${r.lines.find((l) => l[0] === "fail")?.[1] ?? "the test failed."}`, changes: [], project: null,
    events: [{ type: "integration.test", category: eventCat, subject: { type: "integrationType", id: t.id }, projectId: null, outcome: r.ok ? "ok" : "failed", after: { type: t.id, ok: r.ok, ms: r.ms, lines: r.lines.map((l) => l[1]), saved: false } }],
    extra: { test: { ok: r.ok, ms: r.ms, lines: r.lines } },
  };
}

export async function removeInstance(tx: Tx, a: Actor, idOrChannel: string): Promise<Cmd> {
  const row = await resolveInstance(tx, a.orgId, idOrChannel, true);
  const u = await usageOf(tx, a.orgId, row);
  const trig = u.triggers.filter((t) => t.enabled);
  if (trig.length) throw conflict(`Triggers use it: ${trig.map((t) => t.name).join(", ")}. Turn them off first.`);
  if (u.routes + u.overrides) {
    const ps = (await tx.query<{ name: string }>(`select distinct p.name from notification_routes r join projects p on p.org_id = r.org_id and p.id = r.project_id, jsonb_array_elements(r.destinations) d where r.org_id = $1 and d ->> 'integration' = $2`, [a.orgId, row.id])).rows;
    throw conflict(`Notification routes${ps.length ? ` in ${ps.map((p) => p.name).join(", ")}` : ""} send to it.`);
  }
  if (u.repos) throw conflict(`${u.repos} repositor${u.repos === 1 ? "y is" : "ies are"} connected through it.`);
  await tx.query(`delete from integration_instances where org_id = $1 and id = $2`, [a.orgId, row.id]);
  return { msg: `${row.name} removed.`, changes: ["integrationInstances", "integrations", "home"], project: null, events: [{ type: "integration.remove", category: eventCat, subject: { type: "integration", id: row.id }, projectId: null, before: { name: row.name, type: row.type_id }, after: null }] };
}

