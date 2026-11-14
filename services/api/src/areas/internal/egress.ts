import type { Queryable } from "@gantry/db";
import type { RunCtx } from "./context.js";
import { ANTHROPIC_BASE_URL } from "./route.js";

/** The GitHub host and the common package registries (spec 5.3 Outbound allow-list). Admins add more per org and per project. */
export const DEFAULT_RUN_HOSTS = [
  "github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com",
  "registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org",
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

const jsonUrlHosts = (v: unknown, out: Set<string>): void => {
  if (typeof v === "string") {
    const h = hostOf(v);
    if (h) out.add(h);
  } else if (Array.isArray(v)) for (const x of v) jsonUrlHosts(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) jsonUrlHosts(x, out);
};

/** Outbound allow-list for one run's project: model endpoints, GitHub, package registries, in-scope MCP servers, plus configured extras. */
export async function runEgressHosts(db: Queryable, c: RunCtx, mcpServerIds: string[]): Promise<string[]> {
  const out = new Set<string>(DEFAULT_RUN_HOSTS);
  const org = await orgEgress(db, c.orgId);
  for (const h of org.hosts) out.add(h);
  const extra = (c.projectConfig.extra ?? {}) as { allowedHosts?: unknown };
  for (const h of cleanList(extra.allowedHosts)) out.add(h);
  const model = hostOf(ANTHROPIC_BASE_URL);
  if (model) out.add(model);
  for (const r of (await db.query<{ endpoint: string }>(`select endpoint from vendors where org_id = $1 and connected and endpoint <> ''`, [c.orgId])).rows) {
    const h = hostOf(r.endpoint);
    if (h) out.add(h);
  }
  if (mcpServerIds.length) {
    for (const r of (await db.query<{ url: string }>(`select url from mcp_servers where org_id = $1 and id = any($2) and enabled`, [c.orgId, mcpServerIds])).rows) {
      const h = hostOf(r.url);
      if (h) out.add(h);
    }
  }
  return [...out].sort();
}

/** The worker's outbound allow-list (chat and webhook delivery, spec 12.2): the enabled integration instances' own URLs plus the chat vendors' hosts. */
export async function systemEgressHosts(db: Queryable, orgId: string): Promise<string[]> {
  const out = new Set<string>(DEFAULT_SYSTEM_HOSTS);
  for (const h of (await orgEgress(db, orgId)).system) out.add(h);
  const { rows } = await db.query<{ config: unknown }>(`select config from integration_instances where org_id = $1 and enabled`, [orgId]);
  for (const r of rows) jsonUrlHosts(r.config, out);
  return [...out].sort();
}
