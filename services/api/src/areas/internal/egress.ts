import type { Queryable } from "@gantry/db";
import type { RunCtx } from "./context.js";
import { vendorTemplate } from "@gantry/domain";
import { discoveryHosts } from "../models/discovery.js";
import { ANTHROPIC_BASE_URL } from "./route.js";

/**
 * The only hosts a run may reach to install Python test dependencies (owner decision 2026-11-18): the package index and its file host. Exact names, no
 * wildcard. The interpreter is baked into the runner image, so nothing else (no python.org, no GitHub release download) is needed.
 */
export const PYTHON_TEST_HOSTS = ["pypi.org", "files.pythonhosted.org"] as const;

/** The stations whose runs may run the repository's tests, so the only ones that get the package index. Every other station's run is refused those hosts. */
export const TEST_STATIONS: readonly string[] = ["build", "verify"];

/** The GitHub host and the common package registries, without the Python package index (that is per station, see TEST_STATIONS) (spec 5.3 Outbound allow-list). Admins add more per org and per project. */
export const DEFAULT_RUN_HOSTS = [
  "github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com",
  "registry.npmjs.org", "registry.yarnpkg.com",
  "proxy.golang.org", "sum.golang.org", "crates.io", "index.crates.io", "static.crates.io",
  "repo.maven.apache.org", "repo1.maven.org", "rubygems.org",
];

/** Hosts the worker may reach for notification delivery besides the configured integration endpoints. */
export const DEFAULT_SYSTEM_HOSTS = ["slack.com", "hooks.slack.com", "api.slack.com", "*.webhook.office.com", "smba.trafficmanager.net"];

const hostOf = (u: unknown): string | null => {
  if (typeof u !== "string") return null;
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:" ? x.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

const cleanList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((h): h is string => typeof h === "string").map((h) => h.trim().toLowerCase()).filter((h) => /^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h)) : [];

const orgEgress = async (db: Queryable, orgId: string): Promise<{ hosts: string[]; system: string[] }> => {
  const s = (await db.query<{ settings: { egress?: { hosts?: unknown; systemHosts?: unknown } } }>(`select settings from orgs where id = $1`, [orgId])).rows[0]?.settings?.egress;
  return { hosts: cleanList(s?.hosts), system: cleanList(s?.systemHosts) };
};

/** The http(s) hosts named anywhere in a value (an integration's config, a vendor endpoint). */
export const urlHosts = (v: unknown): string[] => {
  const s = new Set<string>();
  jsonUrlHosts(v, s);
  return [...s].sort();
};

/** Audit rows for hosts a vendor or integration change adds to the worker's list (S-67): one `egress.host.added` per new host, naming where it came from. */
export function egressAdded(before: string[], after: string[], from: { kind: "vendor" | "integration"; id: string; name: string }): Array<{ type: string; category: "config"; subject: { type: string; id: string }; projectId: null; after: { host: string; list: "worker"; source: string; sourceName: string } }> {
  const had = new Set(before);
  return [...new Set(after)].filter((h) => !had.has(h)).map((host) => ({ type: "egress.host.added", category: "config" as const, subject: { type: from.kind, id: from.id }, projectId: null, after: { host, list: "worker" as const, source: `${from.kind} ${from.id}`, sourceName: from.name } }));
}

/** Every host on the run and worker lists with where it came from (Security, "Egress hosts and where they came from"). */
export async function egressHostSources(db: Queryable, orgId: string): Promise<Array<{ host: string; list: "run" | "worker"; source: string; kind: string }>> {
  const rows: Array<{ host: string; list: "run" | "worker"; source: string; kind: string }> = [];
  const add = (list: "run" | "worker", kind: string, source: string, hosts: Iterable<string>): void => {
    for (const host of hosts) rows.push({ host, list, kind, source });
  };
  add("run", "built-in", "Built-in defaults", DEFAULT_RUN_HOSTS);
  add("run", "built-in", "Python test dependencies (build and verify)", PYTHON_TEST_HOSTS);
  const model = hostOf(ANTHROPIC_BASE_URL);
  if (model) add("run", "built-in", "Model gateway", [model]);
  add("worker", "built-in", "Built-in defaults", DEFAULT_SYSTEM_HOSTS);
  const org = await orgEgress(db, orgId);
  add("run", "setting", "Security setting (organisation list)", org.hosts);
  add("worker", "setting", "Security setting (system list)", org.system);
  for (const r of (await db.query<{ id: string; name: string; config: unknown }>(`select id, name, config from integration_instances where org_id = $1 and enabled`, [orgId])).rows) add("worker", "integration", `Integration ${r.name} (${r.id})`, urlHosts(r.config));
  for (const v of (await db.query<{ id: string; name: string; endpoint: string; region: string; config: { template?: string; fields?: Record<string, string> } }>(`select id, name, endpoint, region, config from vendors where org_id = $1 and connected`, [orgId])).rows) {
    const h = hostOf(v.endpoint);
    if (h) add("worker", "vendor", `Vendor ${v.name} (${v.id}), model discovery`, [h]);
    const t = v.config?.template ? vendorTemplate(v.config.template) : undefined;
    if (t) add("worker", "vendor", `Vendor ${v.name} (${v.id}), template discovery`, discoveryHosts(t, { ...(v.config.fields ?? {}), ...(v.region ? { region: v.region } : {}) }));
  }
  return rows.sort((a, b) => a.list.localeCompare(b.list) || a.host.localeCompare(b.host));
}

const jsonUrlHosts = (v: unknown, out: Set<string>): void => {
  if (typeof v === "string") {
    const h = hostOf(v);
    if (h) out.add(h);
  } else if (Array.isArray(v)) for (const x of v) jsonUrlHosts(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) jsonUrlHosts(x, out);
};

/**
 * Outbound allow-list for one run's project: model endpoints, GitHub, package registries, plus configured extras.
 * MCP servers are deliberately not on it (spec 12.4): a run reaches them only through the edge's MCP gateway, which checks scope, the definition hash and
 * the write pre-authorisation on every call and logs it. A direct route through the proxy would skip all of that for a server without its own auth.
 */
export async function runEgressHosts(db: Queryable, c: RunCtx): Promise<string[]> {
  const out = new Set<string>(DEFAULT_RUN_HOSTS);
  if (TEST_STATIONS.includes(c.station)) for (const h of PYTHON_TEST_HOSTS) out.add(h);
  const org = await orgEgress(db, c.orgId);
  for (const h of org.hosts) out.add(h);
  const extra = (c.projectConfig.extra ?? {}) as { allowedHosts?: unknown };
  for (const h of cleanList(extra.allowedHosts)) out.add(h);
  // S-67: a vendor's endpoint is NOT on a run's list. A run reaches a model only through the edge gateway; a host a person adds for a vendor must not become a path for the run's repository.
  const model = hostOf(ANTHROPIC_BASE_URL);
  if (model) out.add(model);
  return [...out].sort();
}

/**
 * Hosts a model discovery is about to call (spec 10.4 Vendor templates), for a few minutes: the vendor does not exist yet when its credentials are
 * first checked, so its host cannot come from the vendors table. Registered only for a caller the decision point let through (`model.edit`).
 */
const pendingHosts = new Map<string, number>();
const PENDING_TTL_MS = 5 * 60_000;
export function allowDiscoveryHosts(hosts: string[], now = Date.now()): void {
  for (const h of hosts) pendingHosts.set(h.toLowerCase(), now + PENDING_TTL_MS);
}

/** The worker's outbound allow-list (chat and webhook delivery, spec 12.2): the enabled integration instances' own URLs plus the chat vendors' hosts. */
export async function systemEgressHosts(db: Queryable, orgId: string): Promise<string[]> {
  const out = new Set<string>(DEFAULT_SYSTEM_HOSTS);
  for (const h of (await orgEgress(db, orgId)).system) out.add(h);
  const { rows } = await db.query<{ config: unknown }>(`select config from integration_instances where org_id = $1 and enabled`, [orgId]);
  for (const r of rows) jsonUrlHosts(r.config, out);
  // Connected vendors whose models are discovered through the proxy: the endpoint and the template's own discovery hosts.
  const vs = await db.query<{ endpoint: string; region: string; config: { template?: string; fields?: Record<string, string> } }>(`select endpoint, region, config from vendors where org_id = $1 and connected`, [orgId]);
  for (const v of vs.rows) {
    const h = hostOf(v.endpoint);
    if (h) out.add(h);
    const t = v.config?.template ? vendorTemplate(v.config.template) : undefined;
    if (t) for (const x of discoveryHosts(t, { ...(v.config.fields ?? {}), ...(v.region ? { region: v.region } : {}) })) out.add(x);
  }
  const now = Date.now();
  for (const [h, until] of pendingHosts) if (until > now) out.add(h); else pendingHosts.delete(h);
  return [...out].sort();
}
