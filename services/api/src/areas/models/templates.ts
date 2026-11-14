/**
 * Vendors from templates and model discovery (spec 10.4 Vendor templates). A template names the few fields a vendor needs; the secrets among them
 * are sealed with the data key under AAD `vendor:<id>` (one secret: the string itself, as for every vendor key; several: a JSON object of them),
 * the rest live in `vendors.config.fields`. Discovery runs before the transaction (it is a network call) and its result is applied inside the
 * command: the vendor row, its models and their prices change together, and one event says what was found.
 */
import { ensureDefaultModel } from "./default.js";
import { decrypt, encrypt, fingerprint, mask, type Tx } from "@gantry/db";
import { knownModel, templateEndpoint, validateTemplateValues, vendorTemplate, type VendorTemplate } from "@gantry/domain";
import type { z } from "zod";
import type { Actor, CommandResult } from "../../core/command.js";
import { conflict, invalid, notFound, refuse } from "../../core/errors.js";
import { slug } from "../agents/config.js";
import { checkEndpoint } from "./commands.js";
import type { Discovered } from "./discovery.js";
import { publishPriceVersion, type Price } from "./prices.js";
import type { AddVendorFromTemplateBody } from "./schemas.js";
import { modelRows, vendorRows, type VendorRow } from "./store.js";

type Cmd = CommandResult<Record<string, unknown>>;
const json = (v: unknown): string => JSON.stringify(v);
const subject = (type: string, id: string) => ({ type, id });

export const secretKeys = (t: VendorTemplate): string[] => t.fields.filter((f) => f.type === "secret").map((f) => f.key);

/** What a template needs to discover or call, from the form values: the plain fields and the secrets apart. */
export function splitValues(t: VendorTemplate, values: Record<string, string>): { plain: Record<string, string>; secrets: Record<string, string> } {
  const plain: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const f of t.fields) {
    const v = (values[f.key] ?? f.default ?? "").trim();
    if (!v) continue;
    (f.type === "secret" ? secrets : plain)[f.key] = v;
  }
  return { plain, secrets };
}

/** The stored secret: the single secret itself, or a JSON object when the template has several. */
export function packSecrets(t: VendorTemplate, secrets: Record<string, string>): string | null {
  const keys = secretKeys(t).filter((k) => secrets[k]);
  if (!keys.length) return null;
  return secretKeys(t).length === 1 ? secrets[keys[0]!]! : json(Object.fromEntries(keys.map((k) => [k, secrets[k]!])));
}

export function unpackSecrets(t: VendorTemplate, stored: string | null): Record<string, string> {
  if (!stored) return {};
  const keys = secretKeys(t);
  if (keys.length === 1) return { [keys[0]!]: stored };
  try {
    const o = JSON.parse(stored) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "string") as Array<[string, string]>);
  } catch {
    return {};
  }
}

/** The template a vendor was added from; vendors that predate templates are matched by what they are. */
export function templateOf(v: VendorRow): VendorTemplate | undefined {
  const id = typeof v.config.template === "string" ? v.config.template : v.config.custom === true ? "openai-compatible" : /anthropic|claude/i.test(`${v.id} ${v.product}`) ? "anthropic" : "";
  return id ? vendorTemplate(id) : undefined;
}

/** Plain values and secrets of a stored vendor, ready for discovery. Null when its secret cannot be read. */
export function valuesOf(v: VendorRow, t: VendorTemplate, secretEnc: string | null, dataKey: Buffer | null): Record<string, string> | null {
  const fields = (v.config.fields && typeof v.config.fields === "object" ? v.config.fields : {}) as Record<string, string>;
  let plain: Record<string, string> = { ...fields };
  if (t.id === "openai-compatible") plain = { endpoint: v.endpoint, anthropicCompat: v.config.template ? plain.anthropicCompat ?? "" : "true", ...plain };
  if (t.id === "azure-openai" && !plain.endpoint) plain.endpoint = v.endpoint;
  if (t.id === "bedrock" && !plain.region) plain.region = v.region;
  let stored: string | null = null;
  if (secretEnc) {
    if (!dataKey) return null;
    for (const aad of [`vendor:${v.id}`, undefined]) {
      const r = decrypt(secretEnc, dataKey, aad);
      if (r.ok) {
        stored = r.value;
        break;
      }
    }
    if (stored === null) return null;
  }
  return { ...plain, ...unpackSecrets(t, stored) };
}

/** Is the template's vendor callable through the gateway with these values? */
export const invocableWith = (t: VendorTemplate, plain: Record<string, string>): boolean => t.invocable || (t.id === "openai-compatible" && plain.anthropicCompat === "true");

export interface Applied {
  found: number;
  added: number;
  enabled: number;
  kept: number;
  missing: number;
  needPrice: number;
  priceVersion: number | null;
  models: Array<{ id: string; name: string; enabled: boolean; priced: boolean }>;
}

const ID_MAX = 60;

/**
 * Stores what discovery found for a vendor. Models already known to the vendor (same upstream id) are kept as they are, so a refresh never
 * undoes a person's switches or prices. A new model starts enabled only when the gateway can call the vendor AND the catalogue knows its price
 * (a model with no price would be metered at zero and slip past budgets); every other new model is added disabled, flagged for a price.
 */
export async function applyDiscovery(tx: Tx, a: Actor, v: { id: string; name: string }, t: VendorTemplate, invocable: boolean, found: Discovered[], now: Date): Promise<Applied> {
  const existing = await modelRows(tx, a.orgId);
  const mine = new Map(existing.filter((m) => m.vendor_id === v.id).map((m) => [typeof m.data.upstream === "string" ? m.data.upstream : m.id, m]));
  const taken = new Set(existing.map((m) => m.id));
  const prices: Record<string, Price> = {};
  const out: Applied = { found: found.length, added: 0, enabled: 0, kept: 0, missing: 0, needPrice: 0, priceVersion: null, models: [] };
  const seenUp = new Set(found.map((d) => d.upstream));
  for (const [up, m] of mine) if (m.data.discovered === true && !seenUp.has(up)) out.missing++;
  for (const d of found) {
    if (mine.has(d.upstream)) {
      out.kept++;
      continue;
    }
    const k = knownModel(d.match ?? d.upstream);
    // A Claude model takes its canonical id (claude-sonnet-5-5) when free, on Anthropic or Bedrock, so agents that pin that id (the starter kit) resolve to it
    // as soon as the vendor is connected; the vendor's own id (dated, or a Bedrock profile) stays in `upstream`, which is what the call uses.
    const base = (k && /^claude-/.test(k.canonical) && (t.protocol === "anthropic" || t.protocol === "bedrock") ? k.canonical : "") || slug(d.upstream, ID_MAX) || slug(d.name, ID_MAX) || "model";
    let id = taken.has(base) ? `${v.id}-${base}`.slice(0, ID_MAX + 20) : base;
    for (let i = 2; taken.has(id); i++) id = `${v.id}-${base}-${i}`.slice(0, ID_MAX + 24);
    taken.add(id);
    const priced = k !== null;
    const enabled = invocable && priced;
    const context = d.context ?? k?.context ?? 128_000;
    const data = {
      upstream: d.upstream, discovered: true, invocable, needsPrice: !priced, tier: k?.tier ?? "standard", canonical: k?.canonical ?? slug(d.match ?? d.upstream, 80), discoveredAt: now.toISOString(),
      inPrice: k?.inPrice ?? 0, outPrice: k?.outPrice ?? 0,
    };
    await tx.query(`insert into models (org_id, id, vendor_id, name, enabled, context_tokens, data) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [a.orgId, id, v.id, (d.name || k?.name || d.upstream).slice(0, 120), enabled, context, json(data)]);
    if (k) prices[id] = { in: k.inPrice, out: k.outPrice, ...(k.cacheRead !== undefined ? { cacheRead: k.cacheRead } : {}), ...(k.cacheWrite !== undefined ? { cacheWrite: k.cacheWrite } : {}) };
    out.added++;
    if (enabled) out.enabled++;
    if (!priced) out.needPrice++;
    out.models.push({ id, name: d.name, enabled, priced });
  }
  if (Object.keys(prices).length) out.priceVersion = await publishPriceVersion(tx, a.orgId, prices, { by: a.personId ?? a.id, note: `Discovered on ${v.name}` });
  return out;
}

const summary = (name: string, r: Applied, invocable: boolean, t: VendorTemplate): string => {
  const parts = [`found ${r.found} model${r.found === 1 ? "" : "s"}`, r.added ? `${r.added} new` : "none new"];
  if (r.enabled) parts.push(`${r.enabled} switched on`);
  if (r.needPrice) parts.push(`${r.needPrice} need a price`);
  if (!invocable && r.added) parts.push(`all off: ${t.invocationNote ?? "agents cannot call this vendor yet"}`);
  return `${name}: ${parts.join(", ")}.`;
};

export async function addVendorFromTemplate(tx: Tx, a: Actor, dataKey: Buffer | null, b: z.infer<typeof AddVendorFromTemplateBody>, found: Discovered[], warnings: string[]): Promise<Cmd> {
  const t = vendorTemplate(b.template);
  if (!t) throw notFound("No such vendor template.");
  const bad = validateTemplateValues(t, b.fields);
  if (bad) throw invalid(bad);
  if (!dataKey) throw refuse("invalid", "No data key is configured, so a vendor key cannot be stored.");
  const name = (b.name?.trim() || t.name).slice(0, 80);
  const id = slug(name, 40);
  if (!id) throw invalid("Name the vendor with letters or numbers.");
  if ((await vendorRows(tx, a.orgId, id))[0]) throw conflict(`${name} exists. Open its card to refresh its models, or give this one another name.`);
  const { plain, secrets } = splitValues(t, b.fields);
  const endpoint = checkEndpoint(templateEndpoint(t, { ...plain, ...b.fields }), { allowHttp: false });
  const stored = packSecrets(t, secrets);
  const primary = secretKeys(t).map((k) => secrets[k]).find(Boolean) ?? "";
  const region = plain.region ?? plain.location ?? "";
  const { endpoint: _e, region: _r, ...rest } = plain;
  const config = { template: t.id, custom: t.custom, retention: b.retention ?? "standard", fields: rest, discoveredAt: a.now.toISOString() };
  await tx.query(
    `insert into vendors (org_id, id, name, product, kind, connected, endpoint, region, residency, secret_enc, secret_mask, secret_fingerprint, config)
     values ($1,$2,$3,$4,'template',true,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [a.orgId, id, name, t.name, endpoint, region, t.residency, stored ? encrypt(stored, dataKey, `vendor:${id}`) : null, primary ? mask(primary) : null, primary ? fingerprint(primary) : null, json(config)],
  );
  const invocable = invocableWith(t, plain);
  const applied = await applyDiscovery(tx, a, { id, name }, t, invocable, found, a.now);
  await ensureDefaultModel(tx, a.orgId, "vendor.add");
  const msg = `${name} connected. ${summary(name, applied, invocable, t)}${t.custom ? " It is not qualified for any station until its suite passes." : ""}`;
  return {
    msg,
    events: [
      { type: "vendor.add", category: "agents", subject: subject("vendor", id), after: { name, template: t.id, endpoint, region, connected: true, retention: config.retention, ...(primary ? { keyMask: mask(primary), keyFingerprint: fingerprint(primary) } : {}) } },
      { type: "vendor.discover", category: "agents", subject: subject("vendor", id), after: { found: applied.found, added: applied.added, enabled: applied.enabled, needPrice: applied.needPrice, priceVersion: applied.priceVersion, models: applied.models.slice(0, 200).map((m) => m.id) } },
    ],
    extra: { vendor: { id, name, connected: true, template: t.id }, discovery: { ...applied, warnings } },
    changes: ["vendors", "prices"],
  };
}

export async function refreshVendorModels(tx: Tx, a: Actor, vendorId: string, found: Discovered[], warnings: string[]): Promise<Cmd> {
  const v = (await vendorRows(tx, a.orgId, vendorId, true))[0];
  if (!v) throw notFound("No such vendor.");
  const t = templateOf(v);
  if (!t) throw invalid(`${v.name} was not added from a template, so its models cannot be listed automatically.`);
  const plain = { ...((v.config.fields ?? {}) as Record<string, string>), ...(t.id === "openai-compatible" ? { anthropicCompat: v.config.template ? String((v.config.fields as Record<string, string> | undefined)?.anthropicCompat ?? "") : "true" } : {}) };
  const invocable = invocableWith(t, plain);
  const applied = await applyDiscovery(tx, a, v, t, invocable, found, a.now);
  await tx.query(`update vendors set config = config || $3::jsonb, connected = true, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, v.id, json({ discoveredAt: a.now.toISOString() })]);
  await ensureDefaultModel(tx, a.orgId, "vendor.discover");
  return {
    msg: summary(v.name, applied, invocable, t),
    events: [{ type: "vendor.discover", category: "agents", subject: subject("vendor", v.id), after: { found: applied.found, added: applied.added, enabled: applied.enabled, kept: applied.kept, missing: applied.missing, needPrice: applied.needPrice, priceVersion: applied.priceVersion, models: applied.models.slice(0, 200).map((m) => m.id) } }],
    extra: { discovery: { ...applied, warnings } },
    changes: ["vendors", "prices"],
  };
}

/** A discovery that failed: nothing changes, but the attempt and its reason are on the audit trail. */
export function recordDiscoveryFailure(a: Actor, subj: { type: string; id: string } | null, label: string, reason: string): Cmd {
  void a;
  return { msg: reason, events: [{ type: "vendor.discover", category: "agents", ...(subj ? { subject: subj } : {}), outcome: "failed", after: { vendor: label, reason } }], changes: [] };
}
