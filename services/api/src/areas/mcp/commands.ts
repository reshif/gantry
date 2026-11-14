/**
 * MCP registry commands (spec 8.8, 12.4). Each runs inside `command()`: decision point, state and event in one transaction, a denial audited.
 * Tool definitions and their hashes always come from a discovery the edge made, never from the browser. Credentials are sealed and shown only masked.
 */
import { randomBytes } from "node:crypto";
import type { Tx } from "@gantry/db";
import type { z } from "zod";
import type { Actor, CommandResult } from "../../core/command.js";
import { conflict, invalid, notFound } from "../../core/errors.js";
import type { AddBody, PatchBody, GrantBody } from "./schemas.js";
import type { DiscoveredTool, Discovery } from "./edge-client.js";
import { sealSecret } from "./secret.js";
import { readServer, readServerRows, readToolRows, type ServerRow } from "./store.js";

type Cmd = CommandResult<Record<string, unknown>>;
const json = (v: unknown): string => JSON.stringify(v);
const cat = "integrations" as const;
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16);

/** Plain http is for servers inside a trusted network and has to be switched on by the operator (GANTRY_MCP_ALLOW_HTTP=true). */
export function checkUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw invalid("Enter the server's address as a full URL, for example https://mcp.example.com/mcp.");
  }
  if (u.username || u.password) throw invalid("Put credentials in the secret field, not in the URL.");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && process.env.GANTRY_MCP_ALLOW_HTTP === "true")) throw invalid("MCP servers need an https URL.");
  if (!u.hostname) throw invalid("The URL needs a host name.");
  return u.toString();
}

export function checkAuth(mode: "none" | "bearer" | "header", header: string | null | undefined, secret: string | null | undefined): { header: string | null } {
  if (mode !== "none" && (!secret || secret.length < 6)) throw invalid(`Enter the secret for ${mode === "bearer" ? "the bearer token" : "the API key"} (6 characters or more).`);
  if (mode === "none" && secret) throw invalid("Auth is None, so there is no secret to store.");
  return { header: mode === "header" ? header || "x-api-key" : null };
}

async function checkScope(tx: Tx, orgId: string, s: { projects?: "all" | string[] | undefined; repos?: "all" | string[] | undefined; agents?: "all" | string[] | undefined }): Promise<void> {
  const check = async (what: string, table: string, ids: "all" | string[] | undefined): Promise<void> => {
    if (!ids || ids === "all") return;
    const uniq = [...new Set(ids)];
    const have = new Set((await tx.query<{ id: string }>(`select id from ${table} where org_id = $1 and id = any($2)`, [orgId, uniq])).rows.map((r) => r.id));
    const bad = uniq.filter((x) => !have.has(x));
    if (bad.length) throw invalid(`There is no ${what} ${bad.join(", ")}.`);
  };
  await check("project", "projects", s.projects);
  await check("repo", "repos", s.repos);
  await check("agent", "agents", s.agents);
}

const uniq = (v: "all" | string[]): "all" | string[] => (v === "all" ? "all" : [...new Set(v)]);

function classFor(t: DiscoveredTool, choice?: { write?: boolean | undefined }): "read" | "write" {
  return choice?.write === undefined ? t.hint : choice.write ? "write" : "read";
}

const defOf = (t: DiscoveredTool): Record<string, unknown> => ({ title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations });

const summary = (r: ServerRow): Record<string, unknown> => ({ name: r.name, url: r.url, transport: r.transport, authMode: r.auth_mode, sensitivity: r.sensitivity, enabled: r.enabled });

export async function addServer(tx: Tx, a: Actor, dataKey: Buffer | null, b: z.infer<typeof AddBody>, found: Discovery): Promise<Cmd> {
  const url = checkUrl(b.url);
  const auth = checkAuth(b.authMode, b.authHeader, b.secret);
  if (!found.ok) throw invalid(`Could not list the server's tools: ${found.msg}`);
  if (!found.tools.length) throw invalid("The server lists no tools, so there is nothing to register.");
  if ((await tx.query(`select 1 from mcp_servers where org_id = $1 and lower(name) = lower($2)`, [a.orgId, b.name])).rowCount) throw conflict(`An MCP server called ${b.name} exists.`);
  const by = new Map(found.tools.map((t) => [t.name, t]));
  const bad = b.tools.filter((c) => !by.has(c.name)).map((c) => c.name);
  if (bad.length) throw invalid(`The server does not list ${bad.join(", ")}. Discover its tools again.`);
  await checkScope(tx, a.orgId, b);
  const id = `mcp-${slug(b.name) || "server"}-${randomBytes(2).toString("hex")}`;
  const sealed = b.secret ? sealSecret(dataKey, id, b.secret) : { enc: null, mask: "" };
  await tx.query(
    `insert into mcp_servers (org_id, id, name, url, enabled, secret_enc, secret_mask, transport, protocol_revision, auth_mode, auth_header, sensitivity, health, health_detail, health_at, discovered_at)
     values ($1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10,$11,'healthy',null,now(),now())`,
    [a.orgId, id, b.name, url, sealed.enc, sealed.mask, b.transport, found.protocolRevision, b.authMode, auth.header, b.sensitivity],
  );
  const scope = { projects: uniq(b.projects ?? []), repos: uniq(b.repos ?? []), agents: uniq(b.agents ?? []), stations: uniq(b.stations ?? []), classes: uniq(b.classes ?? "all") };
  await tx.query(`insert into mcp_scopes (org_id, id, server_id, projects, repos, agents, stations, classes) values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)`, [a.orgId, `sc-${id}`, id, json(scope.projects), json(scope.repos), json(scope.agents), json(scope.stations), json(scope.classes)]);
  const tools = found.tools.map((t) => {
    const choice = b.tools.find((c) => c.name === t.name);
    const cls = classFor(t, choice);
    return { name: t.name, class: cls, allowed: choice?.allowed ?? cls === "read", hash: t.hash, hint: t.hint, def: defOf(t) };
  });
  for (const t of tools) {
    await tx.query(`insert into mcp_tools (org_id, server_id, name, definition_hash, tool_class, allowed, definition, hint) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [a.orgId, id, t.name, t.hash, t.class, t.allowed, json(t.def), t.hint]);
  }
  const server = (await readServer(tx, a.orgId, id))!;
  return {
    msg: `${b.name} added. Scope it to projects, repos and agents before use.`, changes: ["mcp"], project: null,
    events: [{ type: "mcp.add", category: cat, subject: { type: "mcp_server", id }, projectId: null, after: { name: b.name, url, transport: b.transport, protocolRevision: found.protocolRevision, authMode: b.authMode, secretMask: sealed.mask, sensitivity: b.sensitivity, scope, tools: tools.map((t) => ({ name: t.name, class: t.class, allowed: t.allowed, hash: t.hash })) } }],
    extra: { server },
  };
}

/** Audited, changes no row: what the Add dialog's Discover button did (spec 15.4). Never carries the secret. */
export function recordDiscovery(a: Actor, target: { url: string; transport: string; name?: string | undefined }, found: Discovery): Cmd {
  const n = found.ok ? found.tools.length : 0;
  return {
    msg: found.ok ? `Found ${n} tool${n === 1 ? "" : "s"}. Write tools start denied.` : `Could not list tools: ${found.msg}`, changes: [], project: null,
    events: [{ type: "mcp.discover", category: cat, subject: { type: "mcp_server", id: target.name ?? target.url }, projectId: null, outcome: found.ok ? "ok" : "failed", after: { url: target.url, transport: target.transport, saved: false, ...(found.ok ? { tools: n, protocolRevision: found.protocolRevision } : { error: found.msg }) } }],
    extra: found.ok ? { tools: found.tools.map((t) => ({ name: t.name, write: t.hint === "write", allowed: t.hint === "read", hint: t.hint, description: t.description, hash: t.hash })), protocolRevision: found.protocolRevision, serverName: found.serverName } : { tools: [] },
  };
}

async function row(tx: Tx, orgId: string, id: string): Promise<ServerRow> {
  const r = (await readServerRows(tx, orgId, id, true))[0];
  if (!r) throw notFound("No such MCP server.");
  return r;
}

export async function patchServer(tx: Tx, a: Actor, dataKey: Buffer | null, id: string, b: z.infer<typeof PatchBody>): Promise<Cmd> {
  const r = await row(tx, a.orgId, id);
  const before = summary(r);
  const changed: string[] = [];
  const after: Record<string, unknown> = {};
  const set: string[] = [];
  const args: unknown[] = [a.orgId, id];
  const put = (col: string, v: unknown, cast = ""): void => {
    args.push(v);
    set.push(`${col} = $${args.length}${cast}`);
  };
  if (b.name !== undefined && b.name !== r.name) {
    if ((await tx.query(`select 1 from mcp_servers where org_id = $1 and lower(name) = lower($2) and id <> $3`, [a.orgId, b.name, id])).rowCount) throw conflict(`An MCP server called ${b.name} exists.`);
    put("name", b.name);
    changed.push("name");
    after.name = b.name;
  }
  if (b.sensitivity !== undefined && b.sensitivity !== r.sensitivity) {
    put("sensitivity", b.sensitivity);
    changed.push("sensitivity");
    after.sensitivity = b.sensitivity;
  }
  // The address, transport or credential changed: what answers is no longer the server that was approved (spec 12.4). It stays off until re-approved.
  const url = b.url !== undefined ? checkUrl(b.url) : r.url;
  const transport = b.transport ?? r.transport;
  const mode = b.authMode ?? r.auth_mode;
  const header = b.authHeader !== undefined ? b.authHeader : r.auth_header;
  const wantsAuth = b.authMode !== undefined || b.authHeader !== undefined || b.secret !== undefined;
  if (wantsAuth) {
    if (mode !== "none" && !b.secret && !r.secret_enc) throw invalid("Enter the secret for this auth mode.");
    if (b.secret) checkAuth(mode, header, b.secret);
    if (mode === "none" && b.secret) throw invalid("Auth is None, so there is no secret to store.");
  }
  let reapprove = false;
  if (url !== r.url) { put("url", url); changed.push("url"); after.url = url; reapprove = true; }
  if (transport !== r.transport) { put("transport", transport); changed.push("transport"); after.transport = transport; reapprove = true; }
  if (mode !== r.auth_mode) { put("auth_mode", mode); changed.push("authMode"); after.authMode = mode; }
  const nextHeader = mode === "header" ? header || "x-api-key" : null;
  if (nextHeader !== r.auth_header) { put("auth_header", nextHeader); changed.push("authHeader"); after.authHeader = nextHeader; }
  if (mode === "none" && r.secret_enc) { put("secret_enc", null); put("secret_mask", ""); }
  if (b.secret) {
    const s = sealSecret(dataKey, id, b.secret);
    put("secret_enc", s.enc);
    put("secret_mask", s.mask);
    changed.push("secret");
    after.secretMask = s.mask;
  }
  let reason = r.disabled_reason;
  let enabled = r.enabled;
  if (reapprove) {
    enabled = false;
    reason = "The address changed. Discover its tools again and re-approve them before it is used.";
    put("health", "unknown");
  }
  if (b.enabled !== undefined && !reapprove) {
    if (b.enabled && !r.enabled && r.disabled_reason) throw conflict(`${r.name} is disabled: ${r.disabled_reason} Re-approve it instead.`);
    enabled = b.enabled;
    if (!b.enabled) reason = null;
  }
  if (enabled !== r.enabled || reason !== r.disabled_reason) { put("enabled", enabled); put("disabled_reason", reason); if (!changed.includes("enabled")) changed.push("enabled"); after.enabled = enabled; }

  const tools = await readToolRows(tx, a.orgId, id);
  const toolChanges: Record<string, { class?: string; allowed?: boolean }> = {};
  for (const c of b.tools ?? []) {
    const t = tools.find((x) => x.name === c.name);
    if (!t) throw invalid(`${r.name} has no tool ${c.name}.`);
    const cls = c.write === undefined ? t.tool_class : c.write ? "write" : "read";
    const allowed = c.allowed ?? t.allowed;
    if (cls === t.tool_class && allowed === t.allowed) continue;
    await tx.query(`update mcp_tools set tool_class = $4, allowed = $5, updated_at = now() where org_id = $1 and server_id = $2 and name = $3`, [a.orgId, id, c.name, cls, allowed]);
    toolChanges[c.name] = { ...(cls !== t.tool_class ? { class: cls } : {}), ...(allowed !== t.allowed ? { allowed } : {}) };
  }
  if (Object.keys(toolChanges).length) { changed.push("tools"); after.tools = toolChanges; }

  const scopeKeys = ["projects", "repos", "agents", "stations", "classes"] as const;
  const scopeSet = scopeKeys.filter((k) => b[k] !== undefined);
  if (scopeSet.length) {
    await checkScope(tx, a.orgId, b);
    const cur: Record<string, unknown> = { projects: r.projects, repos: r.repos, agents: r.agents, stations: r.stations, classes: r.classes };
    const next: Record<string, unknown> = {};
    for (const k of scopeSet) {
      const v = uniq(b[k]!);
      if (json(v) !== json(cur[k])) next[k] = v;
    }
    if (Object.keys(next).length) {
      const merged = { ...cur, ...next };
      await tx.query(
        `insert into mcp_scopes (org_id, id, server_id, projects, repos, agents, stations, classes) values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)
         on conflict (org_id, id) do update set projects = excluded.projects, repos = excluded.repos, agents = excluded.agents, stations = excluded.stations, classes = excluded.classes, updated_at = now()`,
        [a.orgId, `sc-${id}`, id, json(merged.projects ?? []), json(merged.repos ?? []), json(merged.agents ?? []), json(merged.stations ?? []), json(merged.classes ?? "all")],
      );
      changed.push("scope");
      after.scope = next;
    }
  }
  if (!changed.length) return { msg: `${r.name} is unchanged.`, changes: [], project: null, events: [], extra: { server: (await readServer(tx, a.orgId, id))! } };
  await tx.query(`update mcp_servers set ${[...set, "version = version + 1", "updated_at = now()"].join(", ")} where org_id = $1 and id = $2`, args);
  const server = (await readServer(tx, a.orgId, id))!;
  return {
    msg: reapprove ? `${r.name} saved. It is switched off until its tools are discovered and approved again.` : `${r.name} saved.`, changes: ["mcp"], project: null,
    events: [{ type: "mcp.edit", category: cat, subject: { type: "mcp_server", id }, projectId: null, before, after: { ...after, changed } }],
    extra: { server },
  };
}

export async function removeServer(tx: Tx, a: Actor, id: string): Promise<Cmd> {
  const r = await row(tx, a.orgId, id);
  const projects = (await tx.query<{ id: string; name: string }>(`select id, name from projects where org_id = $1 and config -> 'mcp' ? $2`, [a.orgId, id])).rows;
  for (const p of projects) {
    await tx.query(`update projects set config = jsonb_set(config, '{mcp}', coalesce((select jsonb_agg(x) from jsonb_array_elements(config -> 'mcp') x where x <> to_jsonb($3::text)), '[]'::jsonb)), version = version + 1 where org_id = $1 and id = $2`, [a.orgId, p.id, id]);
  }
  const agents = (await tx.query<{ id: string }>(`select id from agents where org_id = $1 and data -> 'mcp' ? $2`, [a.orgId, id])).rows;
  await tx.query(`delete from mcp_servers where org_id = $1 and id = $2`, [a.orgId, id]);
  return {
    msg: `${r.name} removed.`, changes: ["mcp", "projects"], project: null,
    events: [{ type: "mcp.remove", category: cat, subject: { type: "mcp_server", id }, projectId: null, before: { ...summary(r), projects: projects.map((p) => p.id), agents: agents.map((x) => x.id) }, after: null }],
    extra: { projects: projects.map((p) => p.name), agents: agents.length },
  };
}

/** Applies a fresh discovery to a saved server. New tools arrive denied; a tool whose definition changed disables the server until an admin re-approves (spec 12.4). */
export async function applyDiscovery(tx: Tx, a: Actor, id: string, found: Discovery, mode: "discover" | "approve"): Promise<Cmd> {
  const r = await row(tx, a.orgId, id);
  if (!found.ok) {
    await tx.query(`update mcp_servers set health = 'failing', health_detail = $3, health_at = now(), updated_at = now() where org_id = $1 and id = $2`, [a.orgId, id, found.msg.slice(0, 500)]);
    return {
      msg: `${r.name} did not answer: ${found.msg}`, changes: ["mcp"], project: null,
      events: [{ type: mode === "approve" ? "mcp.approve" : "mcp.discover", category: cat, subject: { type: "mcp_server", id }, projectId: null, outcome: "failed", after: { name: r.name, error: found.msg } }],
      extra: { ok: false, server: (await readServer(tx, a.orgId, id))! },
    };
  }
  const have = await readToolRows(tx, a.orgId, id);
  const added: string[] = [];
  const changedTools: string[] = [];
  for (const t of found.tools) {
    const cur = have.find((x) => x.name === t.name);
    if (!cur) {
      await tx.query(`insert into mcp_tools (org_id, server_id, name, definition_hash, tool_class, allowed, definition, hint) values ($1,$2,$3,$4,$5,false,$6::jsonb,$7)`, [a.orgId, id, t.name, t.hash, t.hint, json(defOf(t)), t.hint]);
      added.push(t.name);
    } else if (cur.definition_hash !== t.hash) {
      if (mode === "approve") {
        if (cur.pending_hash && cur.pending_hash !== t.hash) throw conflict(`The definition of ${t.name} changed again since you reviewed it. Discover its tools again.`);
        await tx.query(`update mcp_tools set definition_hash = $4, definition = $5::jsonb, hint = $6, pending_hash = null, updated_at = now() where org_id = $1 and server_id = $2 and name = $3`, [a.orgId, id, t.name, t.hash, json(defOf(t)), t.hint]);
      } else {
        await tx.query(`update mcp_tools set pending_hash = $4, updated_at = now() where org_id = $1 and server_id = $2 and name = $3`, [a.orgId, id, t.name, t.hash]);
      }
      changedTools.push(t.name);
    } else if (cur.pending_hash) {
      await tx.query(`update mcp_tools set pending_hash = null where org_id = $1 and server_id = $2 and name = $3`, [a.orgId, id, t.name]);
    }
  }
  const gone = have.filter((x) => !found.tools.some((t) => t.name === x.name)).map((x) => x.name);
  const events: Cmd["events"] = [];
  let enabled = r.enabled;
  let reason = r.disabled_reason;
  if (mode === "approve") {
    if (!changedTools.length && !r.disabled_reason) throw conflict(`${r.name} has no changed definitions to approve.`);
    enabled = true;
    reason = null;
  } else if (changedTools.length && r.enabled) {
    enabled = false;
    reason = `Definition of ${changedTools.join(", ")} changed`;
    events.push({ type: "mcp.server.disabled", category: cat, subject: { type: "mcp_server", id }, projectId: null, after: { reason, tools: changedTools } });
  }
  await tx.query(
    `update mcp_servers set enabled = $3, disabled_reason = $4, protocol_revision = $5, health = 'healthy', health_detail = null, health_at = now(), discovered_at = now(), version = version + 1, updated_at = now() where org_id = $1 and id = $2`,
    [a.orgId, id, enabled, reason, found.protocolRevision || r.protocol_revision],
  );
  events.unshift({ type: mode === "approve" ? "mcp.approve" : "mcp.discover", category: cat, subject: { type: "mcp_server", id }, projectId: null, outcome: "ok", after: { name: r.name, tools: found.tools.length, added, changed: changedTools, gone, protocolRevision: found.protocolRevision } });
  const server = (await readServer(tx, a.orgId, id))!;
  const msg = mode === "approve"
    ? `${r.name} approved: ${changedTools.length} changed definition${changedTools.length === 1 ? "" : "s"} accepted. It is switched on.`
    : changedTools.length ? `${r.name} is disabled: the definition of ${changedTools.join(", ")} changed. Review and re-approve it.` : `${r.name} answered with ${found.tools.length} tools${added.length ? `, ${added.length} new (denied until you allow them)` : ""}.`;
  return { msg, changes: ["mcp"], project: null, events, extra: { ok: true, server, added, changed: changedTools, gone } };
}

/** Pre-authorises write tools for the live attempt of a work order (spec 12.4). The gateway checks the grant on every write call; a new attempt starts with none. */
export async function grantWrites(tx: Tx, a: Actor, b: z.infer<typeof GrantBody>): Promise<Cmd> {
  const att = (await tx.query<{ id: string; station: string; data: Record<string, unknown> }>(
    `select id, station, data from attempts where org_id = $1 and wo_id = $2 and state in ('queued','running') order by fencing desc limit 1 for update`, [a.orgId, b.wo],
  )).rows[0];
  if (!att) throw conflict(`${b.wo} has no attempt in progress to pre-authorise.`);
  for (const g of b.tools) {
    const [server, tool] = g.split("/", 2) as [string, string];
    if (!(await tx.query(`select 1 from mcp_servers where org_id = $1 and id = $2`, [a.orgId, server])).rowCount) throw invalid(`There is no MCP server ${server}.`);
    if (tool !== "*") {
      const t = (await tx.query<{ tool_class: string }>(`select tool_class from mcp_tools where org_id = $1 and server_id = $2 and name = $3`, [a.orgId, server, tool])).rows[0];
      if (!t) throw invalid(`${server} has no tool ${tool}.`);
      if (t.tool_class !== "write") throw invalid(`${tool} is a read tool and needs no pre-authorisation.`);
    }
  }
  const cur = Array.isArray(att.data.writeGrants) ? (att.data.writeGrants as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const next = [...new Set([...cur, ...b.tools])];
  await tx.query(`update attempts set data = jsonb_set(data, '{writeGrants}', $3::jsonb), updated_at = now() where org_id = $1 and id = $2`, [a.orgId, att.id, json(next)]);
  return {
    msg: `Write tools pre-authorised for ${b.wo} at ${att.station}: ${b.tools.join(", ")}.`, changes: ["mcp"], project: null,
    events: [{ type: "mcp.grant", category: cat, subject: { type: "attempt", id: att.id }, woId: b.wo, after: { attempt: att.id, station: att.station, grants: b.tools } }],
    extra: { attempt: att.id, station: att.station, grants: next },
  };
}
