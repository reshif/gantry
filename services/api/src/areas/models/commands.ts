/**
 * Vendor, model, routing, price and budget commands (spec 8.7 Models, 10.4, 10.5). Each runs inside `command()`: decision point, state and
 * event in one transaction, a denial audited. Keys are sealed with the data key under AAD `vendor:<id>` and never returned or put in an event.
 */
import { encrypt, fingerprint, mask, type Tx } from "@gantry/db";
import { vendorTemplate, type Routing } from "@gantry/domain";
import type { z } from "zod";
import type { Actor, CommandResult } from "../../core/command.js";
import { conflict, invalid, notFound, refuse } from "../../core/errors.js";
import { readCatalog } from "../../core/read/index.js";
import { liftBudgetHalt } from "../workorders/budget.js";
import { capOfReason, overBudget, overText } from "../workorders/budget-state.js";
import { slug } from "../agents/config.js";
import { ensureDefaultModel } from "./default.js";
import { publishPriceVersion, type Price } from "./prices.js";
import type { AddModelBody, AddVendorBody, BudgetBody, PricesBody, RoutingSchema, VendorPatch } from "./schemas.js";
import { loadRouting, modelRows, qualifiedOf, vendorRows, type VendorRow } from "./store.js";

type Cmd = CommandResult<Record<string, unknown>>;
const cat = "agents" as const;
const json = (v: unknown): string => JSON.stringify(v);
const subject = (type: string, id: string) => ({ type, id });
const usdToMicros = (n: number): string => String(Math.round(n * 1_000_000));

/** A base URL a vendor call may go to: https only, no credentials in it. The on-prem local vendor may use http (it never leaves the network). */
export function checkEndpoint(raw: string, opts: { allowHttp: boolean }): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw invalid("Endpoint must be a full URL, for example https://llm.example.com/v1.");
  }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) throw invalid(opts.allowHttp ? "Endpoint must start with http:// or https://." : "Endpoint must start with https://.");
  if (u.username || u.password) throw invalid("Put the key in the key field, not in the URL.");
  if (u.search || u.hash) throw invalid("The endpoint is a base URL: no query string or fragment.");
  return u.toString().replace(/\/+$/, "");
}

const sealKey = (dataKey: Buffer | null, vendorId: string, key: string): string => {
  if (!dataKey) throw refuse("invalid", "No data key is configured, so a vendor key cannot be stored.");
  return encrypt(key, dataKey, `vendor:${vendorId}`);
};

async function routingRefs(tx: Tx, orgId: string): Promise<{ routing: Routing & { version: number }; byModel: (id: string) => string[] }> {
  const routing = await loadRouting(tx, orgId);
  const byModel = (id: string): string[] => {
    const hit: string[] = [];
    if (routing.defaultModel === id) hit.push("the factory default");
    if (routing.fallback.includes(id)) hit.push("the fallback order");
    for (const [k, v] of Object.entries(routing.overrides)) if (v === id) hit.push(`the ${k} station override`);
    for (const [k, v] of Object.entries(routing.classOverrides ?? {})) if (v === id) hit.push(`the ${k} class override`);
    for (const [p, pol] of Object.entries(routing.projects ?? {})) {
      if (pol.defaultModel === id) hit.push(`the ${p} project default`);
      for (const v of [...Object.values(pol.overrides ?? {}), ...Object.values(pol.classOverrides ?? {})]) if (v === id) hit.push(`a ${p} project override`);
    }
    return [...new Set(hit)];
  };
  return { routing, byModel };
}

/** Agents that use a model as primary, as a fallback or in a project override. */
async function agentsUsing(tx: Tx, orgId: string, modelId: string): Promise<Array<{ name: string; primary: boolean }>> {
  const { rows } = await tx.query<{ name: string; data: Record<string, unknown> }>(`select name, data from agents where org_id = $1 order by name`, [orgId]);
  const out: Array<{ name: string; primary: boolean }> = [];
  for (const r of rows) {
    const d = r.data;
    const primary = d.model === modelId;
    const fb = Array.isArray(d.fallbacks) && d.fallbacks.includes(modelId);
    const ov = d.overrides && typeof d.overrides === "object" && Object.values(d.overrides as Record<string, { model?: string }>).some((o) => o?.model === modelId);
    if (primary || fb || ov) out.push({ name: r.name, primary: primary || Boolean(ov) });
  }
  return out;
}

const vendorBefore = (v: VendorRow): Record<string, unknown> => ({ connected: v.connected, region: v.region, endpoint: v.endpoint, product: v.product, budget: v.monthly_budget_micros ? Number(v.monthly_budget_micros) / 1e6 : 0, retention: v.config.retention ?? "standard", keyMask: v.secret_mask ?? "" });

export async function setVendor(tx: Tx, a: Actor, dataKey: Buffer | null, vendorId: string, patch: z.infer<typeof VendorPatch>): Promise<Cmd> {
  const v = (await vendorRows(tx, a.orgId, vendorId, true))[0];
  if (!v) throw notFound("No such vendor.");
  const keys = Object.keys(patch);
  if (!keys.length) throw invalid("Nothing to change.");
  const custom = v.config.custom === true;
  const local = v.id === "local" || custom;
  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, val: unknown, cast = ""): void => {
    args.push(val);
    sets.push(`${col} = $${args.length}${cast}`);
  };
  let config: Record<string, unknown> = { ...v.config };
  const after: Record<string, unknown> = {};

  const endpoint = patch.endpoint !== undefined ? (patch.endpoint === "" ? "" : checkEndpoint(patch.endpoint, { allowHttp: !custom })) : v.endpoint;
  if (patch.endpoint !== undefined && !local) throw invalid(`${v.name} is a hosted vendor: its endpoint is fixed.`);
  if (patch.endpoint !== undefined) {
    set("endpoint", endpoint);
    after.endpoint = endpoint;
  }
  if (patch.region !== undefined) { set("region", patch.region); after.region = patch.region; }
  if (patch.product !== undefined) { set("product", patch.product); after.product = patch.product; }
  if (patch.residency !== undefined) { set("residency", patch.residency); after.residency = patch.residency; }
  if (patch.budget !== undefined) { set("monthly_budget_micros", usdToMicros(patch.budget)); after.budget = patch.budget; }
  if (patch.retention !== undefined) { config = { ...config, retention: patch.retention }; after.retention = patch.retention; }

  let keyChanged = false;
  const newKey = patch.key?.trim();
  if (newKey && typeof v.config.template === "string" && (vendorTemplate(v.config.template)?.fields.filter((f) => f.type === "secret").length ?? 0) > 1) throw invalid(`${v.name} has several credentials (${v.config.template}); they cannot be replaced by one key. Add it again from its template.`);
  if (newKey) {
    if (!local && newKey.length < 8) throw invalid("Enter the full key (at least 8 characters).");
    set("secret_enc", sealKey(dataKey, v.id, newKey));
    set("secret_mask", mask(newKey));
    set("secret_fingerprint", fingerprint(newKey));
    after.keyMask = mask(newKey);
    after.keyFingerprint = fingerprint(newKey);
    keyChanged = true;
  }

  let verb = "vendor.update";
  if (patch.connected === true) {
    if (!v.connected) verb = "vendor.connect";
    if (!v.has_secret && !keyChanged && !local) throw invalid(`Enter the API key to connect ${v.name}.`);
    if (!endpoint && local) throw invalid(`${v.name} needs an endpoint URL before it can be connected.`);
    if (!v.connected) { set("connected", true); after.connected = true; }
  } else if (patch.connected === false) {
    verb = "vendor.disconnect";
    const { routing } = await routingRefs(tx, a.orgId);
    const ids = (await modelRows(tx, a.orgId)).filter((m) => m.vendor_id === v.id).map((m) => m.id);
    if (ids.includes(routing.defaultModel)) throw conflict(`The factory default model is on ${v.name}. Pick another default first.`);
    set("connected", false);
    set("secret_enc", null);
    set("secret_mask", "");
    set("secret_fingerprint", null);
    after.connected = false;
    after.keyMask = "";
  }
  if (config.retention !== v.config.retention) set("config", json(config), "::jsonb");
  if (!sets.length) throw invalid("Nothing to change.");
  sets.push("version = version + 1", "updated_at = now()");
  await tx.query(`update vendors set ${sets.join(", ")} where org_id = $${args.length + 1} and id = $${args.length + 2}`, [...args, a.orgId, v.id]);
  if (verb === "vendor.connect" || keyChanged) await ensureDefaultModel(tx, a.orgId, verb);
  const msg = verb === "vendor.connect" ? `${v.name} connected.` : verb === "vendor.disconnect" ? `${v.name} disconnected.` : `${v.name} updated.`;
  return {
    msg,
    events: [{ type: verb, category: cat, subject: subject("vendor", v.id), before: vendorBefore(v), after }],
    changes: ["vendors", "routing"],
  };
}

export async function addVendor(tx: Tx, a: Actor, dataKey: Buffer | null, b: z.infer<typeof AddVendorBody>): Promise<Cmd> {
  const name = b.name.trim();
  const id = slug(name, 40);
  if (!id) throw invalid("Name the vendor with letters or numbers.");
  if ((await vendorRows(tx, a.orgId, id))[0]) throw conflict(`${name} exists.`);
  const endpoint = b.endpoint ? checkEndpoint(b.endpoint, { allowHttp: false }) : "";
  const key = b.key?.trim() ?? "";
  if (key && key.length < 4) throw invalid("The key is too short.");
  const connected = Boolean(key && endpoint);
  const config = { custom: true, retention: b.retention ?? "standard" };
  await tx.query(
    `insert into vendors (org_id, id, name, product, kind, connected, endpoint, region, residency, secret_enc, secret_mask, secret_fingerprint, config)
     values ($1,$2,$3,'Custom vendor · OpenAI-compatible','custom',$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [a.orgId, id, name, connected, endpoint, b.region ?? "", b.residency ?? "", key ? sealKey(dataKey, id, key) : null, key ? mask(key) : null, key ? fingerprint(key) : null, json(config)],
  );
  const msg = connected ? `${name} added and connected. It is not qualified for any station until its suite passes.` : key ? `${name} added. Add an endpoint to connect it.` : `${name} added. Add a key to connect it.`;
  return {
    msg,
    events: [{ type: "vendor.add", category: cat, subject: subject("vendor", id), after: { name, endpoint, region: b.region ?? "", connected, retention: config.retention, custom: true, ...(key ? { keyMask: mask(key), keyFingerprint: fingerprint(key) } : {}) } }],
    extra: { vendor: { id, name, connected, custom: true } },
    changes: ["vendors"],
  };
}

export async function addModel(tx: Tx, a: Actor, b: z.infer<typeof AddModelBody>): Promise<Cmd> {
  const v = (await vendorRows(tx, a.orgId, b.vendor, true))[0];
  if (!v) throw notFound("No such vendor.");
  const d = b.def;
  const id = d.id?.trim() || slug(d.name, 60);
  if (!id) throw invalid("Give the model an id.");
  if ((await modelRows(tx, a.orgId, id))[0]) throw conflict(`A model with id ${id} exists.`);
  const data: Record<string, unknown> = { tier: d.tier ?? "standard", custom: true, inPrice: d.inPrice, outPrice: d.outPrice, upstream: id, ...(d.canonical ? { canonical: d.canonical } : {}) };
  await tx.query(`insert into models (org_id, id, vendor_id, name, enabled, context_tokens, data) values ($1,$2,$3,$4,true,$5,$6::jsonb)`, [a.orgId, id, v.id, d.name.trim(), d.context ?? 128000, json(data)]);
  const price: Price = { in: d.inPrice, out: d.outPrice, ...(d.cacheRead !== undefined ? { cacheRead: d.cacheRead } : {}), ...(d.cacheWrite !== undefined ? { cacheWrite: d.cacheWrite } : {}) };
  const pv = await publishPriceVersion(tx, a.orgId, { [id]: price }, { by: a.personId ?? a.id, note: `Added ${d.name.trim()}` });
  await ensureDefaultModel(tx, a.orgId, "model.add");
  return {
    msg: `${d.name.trim()} added to ${v.name}.`,
    events: [{ type: "model.add", category: cat, subject: subject("model", id), after: { vendor: v.id, name: d.name.trim(), ...price, context: d.context ?? 128000, tier: data.tier, priceVersion: pv } }],
    extra: { model: { id, name: d.name.trim(), vendor: v.id }, priceVersion: pv },
    changes: ["vendors"],
  };
}

export async function removeModel(tx: Tx, a: Actor, modelId: string): Promise<Cmd> {
  const m = (await modelRows(tx, a.orgId, modelId, true))[0];
  if (!m) throw notFound("No such model.");
  const { byModel } = await routingRefs(tx, a.orgId);
  const refs = byModel(modelId);
  if (refs.length) throw conflict(`Routing uses ${m.name} in ${refs.join(", ")}. Change the routing policy first.`);
  const used = await agentsUsing(tx, a.orgId, modelId);
  if (used.length) throw conflict(`Used by ${used.map((u) => u.name + (u.primary ? "" : " (fallback)")).join(", ")}. Change those agents first.`);
  await tx.query(`delete from models where org_id = $1 and id = $2`, [a.orgId, modelId]);
  return { msg: `${m.name} removed.`, events: [{ type: "model.remove", category: cat, subject: subject("model", modelId), before: { name: m.name, vendor: m.vendor_id }, after: null }], changes: ["vendors"] };
}

export async function setModelEnabled(tx: Tx, a: Actor, modelId: string, on: boolean): Promise<Cmd> {
  const m = (await modelRows(tx, a.orgId, modelId, true))[0];
  if (!m) throw notFound("No such model.");
  if (m.enabled === on) return { msg: `${m.name} is already ${on ? "enabled" : "disabled"}.`, events: [], changes: [] };
  if (!on) {
    const { routing } = await routingRefs(tx, a.orgId);
    if (routing.defaultModel === modelId) throw conflict("This is the factory default model. Pick another default first.");
    const prim = (await agentsUsing(tx, a.orgId, modelId)).filter((u) => u.primary);
    if (prim.length) throw conflict(`Primary model of ${prim.map((u) => u.name).join(", ")}. Change those agents first.`);
  }
  if (on && m.data.invocable === false) throw conflict(`${m.name} is on a vendor the gateway cannot call yet (it speaks the Anthropic Messages API only), so it cannot be switched on.`);
  await tx.query(`update models set enabled = $3, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, modelId, on]);
  if (on) await ensureDefaultModel(tx, a.orgId, "model.toggle");
  return { msg: `${m.name} ${on ? "enabled" : "disabled"}.`, events: [{ type: "model.toggle", category: cat, subject: subject("model", modelId), before: !on, after: on }], changes: ["vendors", "routing"] };
}

/** A person's correction of a discovered or custom model's context window. */
export async function setModelContext(tx: Tx, a: Actor, modelId: string, context: number): Promise<Cmd> {
  const m = (await modelRows(tx, a.orgId, modelId, true))[0];
  if (!m) throw notFound("No such model.");
  if (m.context_tokens === context) return { msg: `${m.name} already has that context window.`, events: [], changes: [] };
  await tx.query(`update models set context_tokens = $3, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, modelId, context]);
  return { msg: `${m.name} context window set to ${context.toLocaleString("en-US")} tokens.`, events: [{ type: "model.edit", category: cat, subject: subject("model", modelId), before: m.context_tokens, after: context }], changes: ["vendors"] };
}

type RoutingIn = z.infer<typeof RoutingSchema>;

/** Validates a routing object against the catalogue, the models and the vendors. Models newly referenced must be enabled on a connected vendor. */
async function validateRouting(tx: Tx, orgId: string, next: RoutingIn, prev: Routing): Promise<void> {
  const [ms, vs, cat2, projects] = await Promise.all([
    modelRows(tx, orgId),
    vendorRows(tx, orgId),
    readCatalog(tx, orgId),
    tx.query<{ id: string }>(`select id from projects where org_id = $1`, [orgId]),
  ]);
  const model = new Map(ms.map((m) => [m.id, m]));
  const vendor = new Map(vs.map((v) => [v.id, v]));
  const before = new Set<string>();
  const collect = (r: Routing, into: Set<string>): void => {
    into.add(r.defaultModel);
    r.fallback.forEach((x) => into.add(x));
    Object.values(r.overrides).forEach((x) => into.add(x));
    Object.values(r.classOverrides ?? {}).forEach((x) => into.add(x));
    for (const p of Object.values(r.projects ?? {})) [p.defaultModel, ...Object.values(p.overrides ?? {}), ...Object.values(p.classOverrides ?? {})].forEach((x) => x && into.add(x));
  };
  collect(prev, before);
  const refs = new Set<string>();
  collect(next as Routing, refs);
  for (const id of refs) {
    const m = model.get(id);
    if (!m) throw invalid(`There is no model ${id}.`);
    if (!before.has(id)) {
      if (!m.enabled) throw invalid(`${m.name} is disabled. Enable it before routing to it.`);
      if (!vendor.get(m.vendor_id)?.connected) throw invalid(`${vendor.get(m.vendor_id)?.name ?? m.vendor_id} is not connected, so ${m.name} cannot be routed to.`);
    }
  }
  if (!next.fallback.length) throw invalid("Keep at least one fallback model.");
  if (new Set(next.fallback).size !== next.fallback.length) throw invalid("A model is in the fallback order twice.");
  const stations = new Set(cat2.stations.map((s) => s.id));
  for (const k of Object.keys(next.overrides)) if (!stations.has(k)) throw invalid(`There is no station ${k}.`);
  for (const [pid, pol] of Object.entries(next.projects ?? {})) {
    if (!projects.rows.some((p) => p.id === pid)) throw invalid(`There is no project ${pid}.`);
    for (const k of Object.keys(pol.overrides ?? {})) if (!stations.has(k)) throw invalid(`There is no station ${k}.`);
    for (const vid of pol.allowedVendors ?? []) if (!vendor.has(vid)) throw invalid(`There is no vendor ${vid}.`);
  }
  const classes = new Set(cat2.classes.map((c) => c.id));
  for (const k of [...Object.keys(next.classOverrides ?? {}), ...Object.values(next.projects ?? {}).flatMap((p) => Object.keys(p.classOverrides ?? {}))]) if (!classes.has(k)) throw invalid(`There is no work-order class ${k}.`);
  const ids = new Set<string>();
  const tags = new Set<string>();
  for (const r of next.rules) {
    if (ids.has(r.id)) throw invalid(`Rule id ${r.id} appears twice.`);
    ids.add(r.id);
    if (tags.has(r.tag)) throw invalid(`A rule for ${r.tag} already exists. Remove it first.`);
    tags.add(r.tag);
    if (!vendor.has(r.use)) throw invalid(`There is no vendor ${r.use}.`);
    if (r.alt && !vendor.has(r.alt)) throw invalid(`There is no vendor ${r.alt}.`);
    if (r.alt && r.alt === r.use) throw invalid("The alternative must be a different vendor.");
  }
}

const clean = (r: RoutingIn): Routing => {
  const out: Routing = { defaultModel: r.defaultModel, overrides: r.overrides, fallback: r.fallback, rules: r.rules };
  if (r.classOverrides && Object.keys(r.classOverrides).length) out.classOverrides = r.classOverrides;
  const projects = Object.fromEntries(Object.entries(r.projects ?? {}).filter(([, p]) => Object.keys(p).length > 0));
  if (Object.keys(projects).length) out.projects = projects;
  if (r.crossModelFallback === true) out.crossModelFallback = true;
  return out;
};

export async function setRouting(tx: Tx, a: Actor, next: RoutingIn, label: string | undefined): Promise<Cmd> {
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`routing_versions:${a.orgId}`]);
  const prev = await loadRouting(tx, a.orgId);
  const body = clean(next);
  await validateRouting(tx, a.orgId, next, prev);
  if (json(body) === json({ ...prev, version: undefined })) return { msg: "Routing is already like that.", events: [], changes: [] };
  const version = prev.version + 1;
  await tx.query(`insert into routing_versions (org_id, version, body, note, published_at, published_by) values ($1,$2,$3::jsonb,$4,now(),$5)`, [a.orgId, version, json(body), label ?? "", a.personId ?? a.id]);
  const { version: _v, ...before } = prev;
  const crossOn = body.crossModelFallback === true && prev.crossModelFallback !== true;
  return {
    msg: `${label || "Routing"} saved.`,
    events: [{ type: "routing.edit", category: cat, subject: subject("routing", "factory"), before, after: { ...body, version, ...(label ? { label } : {}), ...(crossOn ? { crossModelFallbackSwitchedOn: true } : {}) } }],
    extra: { version },
    changes: ["routing"],
  };
}

export async function publishPrices(tx: Tx, a: Actor, b: z.infer<typeof PricesBody>): Promise<Cmd> {
  const ms = new Set((await modelRows(tx, a.orgId)).map((m) => m.id));
  const bad = Object.keys(b.prices).filter((id) => !ms.has(id));
  if (bad.length) throw invalid(`There is no model ${bad.join(", ")}.`);
  const eff = b.effectiveFrom ? new Date(b.effectiveFrom) : null;
  if (eff && eff.getTime() < a.now.getTime() - 60_000) throw invalid("A price cannot take effect in the past: usage already metered keeps the version it was priced at.");
  const version = await publishPriceVersion(tx, a.orgId, b.prices, { by: a.personId ?? a.id, note: b.note ?? "", effectiveFrom: eff });
  return {
    msg: eff && eff.getTime() > a.now.getTime() + 60_000 ? `Price version ${version} saved; it takes effect ${eff.toISOString()}.` : `Price version ${version} is in force.`,
    events: [{ type: "price.publish", category: cat, subject: subject("prices", String(version)), after: { version, effectiveFrom: (eff ?? a.now).toISOString(), models: Object.keys(b.prices), note: b.note ?? "" } }],
    extra: { version },
    changes: ["vendors"],
  };
}

/** Spec 10.4 Custom vendors: a station is qualified on a vendor only after that station's suite passed on it (a completed run at or above the suite's threshold). */
export async function qualifyVendor(tx: Tx, a: Actor, vendorId: string, station: string): Promise<Cmd> {
  const v = (await vendorRows(tx, a.orgId, vendorId, true))[0];
  if (!v) throw notFound("No such vendor.");
  if (v.config.custom !== true) throw invalid(`${v.name} is not a custom vendor, so it needs no qualification.`);
  const st = (await readCatalog(tx, a.orgId)).stations.find((s) => s.id === station);
  if (!st) throw invalid(`There is no station ${station}.`);
  const { rows } = await tx.query<{ id: string; suite_id: string; score: string | null; threshold: string | null; finished_at: Date | null }>(
    `select r.id, r.suite_id, r.score::text, s.data->>'threshold' as threshold, r.finished_at
       from eval_runs r join suites s on s.org_id = r.org_id and s.id = r.suite_id
      where r.org_id = $1 and s.station = $2 and r.status = 'completed' and r.data->>'vendor' = $3 order by r.started_at desc, r.id desc limit 1`,
    [a.orgId, station, vendorId],
  );
  const run = rows[0];
  if (!run) throw conflict(`No eval run of the ${st.name} suite on ${v.name} has completed. Run the suite on a model of this vendor first.`);
  const threshold = run.threshold !== null && !Number.isNaN(Number(run.threshold)) ? Number(run.threshold) : 0.85;
  const score = run.score === null ? 0 : Number(run.score);
  if (score < threshold) throw conflict(`The ${st.name} suite scored ${score} on ${v.name}; ${threshold} is needed.`);
  const q = { ...qualifiedOf(v.config), [station]: { suite: run.suite_id, run: run.id, at: a.now.toISOString() } };
  await tx.query(`update vendors set config = $3::jsonb, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, vendorId, json({ ...v.config, qualified: q })]);
  return { msg: `${v.name} is qualified for ${st.name}.`, events: [{ type: "vendor.qualify", category: cat, subject: subject("vendor", vendorId), after: { station, suite: run.suite_id, run: run.id, score } }], changes: ["vendors", "routing"] };
}

export async function setWoBudget(tx: Tx, a: Actor, projectId: string, b: z.infer<typeof BudgetBody>): Promise<Cmd> {
  const p = (await tx.query<{ name: string }>(`select name from projects where org_id = $1 and id = $2`, [a.orgId, projectId])).rows[0];
  if (!p) throw notFound("No such project.");
  const before = (await tx.query<{ w: string }>(`select wo_limit_micros::text as w from budgets where org_id = $1 and project_id = $2 for update`, [a.orgId, projectId])).rows[0];
  await tx.query(
    `insert into budgets (org_id, project_id, wo_limit_micros) values ($1,$2,$3) on conflict (org_id, project_id) do update set wo_limit_micros = excluded.wo_limit_micros, version = budgets.version + 1, updated_at = now()`,
    [a.orgId, projectId, usdToMicros(b.perWorkOrder)],
  );
  // Raising the default (or taking it off) lifts the budget halts it was holding, like the monthly raise does (S-45); a work order still over a cap stays halted and is named.
  const lifted: string[] = [];
  const kept: string[] = [];
  const events: NonNullable<Cmd["events"]> = [];
  const jobs: NonNullable<Cmd["jobs"]> = [];
  const was = before ? Number(before.w) / 1e6 : 0;
  if (b.perWorkOrder === 0 || b.perWorkOrder > was) {
    const halts = (await tx.query<{ wo_id: string; reason: string }>(
      `select s.wo_id, s.reason from stops s join work_orders w on w.org_id = s.org_id and w.id = s.wo_id where s.org_id = $1 and w.project_id = $2 and s.scope_type = 'wo' and s.mode = 'halt' and s.cause = 'budget' and s.lifted_at is null order by s.wo_id`, [a.orgId, projectId],
    )).rows;
    for (const h of halts) {
      if (capOfReason(h.reason) !== "wo") continue;
      const still = await overBudget(tx, a.orgId, h.wo_id);
      if (still.length) { kept.push(`${h.wo_id} (${still.map(overText).join(" and ")})`); continue; }
      const l = await liftBudgetHalt(tx, a, h.wo_id, b.perWorkOrder > 0 ? `Per-work-order default raised to $${b.perWorkOrder}` : "Per-work-order default taken off");
      events.push(...l.events);
      jobs.push(...l.jobs);
      lifted.push(h.wo_id);
    }
  }
  return {
    msg: `${b.perWorkOrder > 0 ? `Each work order in ${p.name} may spend up to $${b.perWorkOrder}.` : `${p.name} has no per-work-order cap.`}${lifted.length ? ` Lifted the budget halt on ${lifted.join(", ")}.` : ""}${kept.length ? ` Still halted: ${kept.join("; ")}.` : ""}`,
    events: [{ type: "budget.wo", category: "config", subject: subject("project", projectId), projectId, before: was, after: b.perWorkOrder, ...(lifted.length ? { lifted } : {}) }, ...events],
    ...(jobs.length ? { jobs } : {}),
    changes: lifted.length ? ["projects", "vendors", "workOrders", "stops", "floor", "home"] : ["projects", "vendors"],
    project: projectId,
  };
}
