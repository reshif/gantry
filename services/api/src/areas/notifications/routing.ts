/** Resolving a route's destination to a connected integration instance and its recipients (spec 12.1, 12.2). */
import type { Queryable } from "@gantry/db";
import { obj } from "../../core/read/rows.js";
import { metaOf } from "../integrations/store.js";

export interface Dest {
  channel: string;
  target: string;
  integration?: string | null;
  override?: string | null;
}

export interface InstInfo {
  id: string;
  typeId: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  projects: "all" | string[];
  targetId?: string;
  health: string;
  destination: boolean;
  available: boolean;
  unavailableReason?: string;
  httpTemplate?: { method: "POST" | "PUT"; body: string; contentType: string };
  fields: Array<{ key: string; type: string }>;
}

export async function loadInstances(db: Queryable, orgId: string): Promise<InstInfo[]> {
  const { rows } = await db.query<{ id: string; type_id: string; name: string; enabled: boolean; config: Record<string, unknown>; health: string; tdata: Record<string, unknown>; fields: Array<{ key: string; type: string }> }>(
    `select i.id, i.type_id, i.name, i.enabled, i.config, i.health, coalesce(t.data, '{}'::jsonb) as tdata, coalesce(t.field_schema, '[]'::jsonb) as fields
     from integration_instances i left join integration_types t on t.org_id = i.org_id and t.id = i.type_id where i.org_id = $1 order by i.created_at, i.id`,
    [orgId],
  );
  return rows.map((r) => {
    const m = metaOf(r.config);
    const { _meta, ...config } = r.config;
    void _meta;
    return {
      id: r.id, typeId: r.type_id, name: r.name, enabled: r.enabled, config, projects: m.projects, ...(m.targetId ? { targetId: m.targetId } : {}), health: r.health,
      destination: r.tdata.destination !== false, available: r.tdata.available !== false, ...(typeof r.tdata.unavailableReason === "string" ? { unavailableReason: r.tdata.unavailableReason } : {}),
      ...(r.tdata.httpTemplate ? { httpTemplate: r.tdata.httpTemplate as InstInfo["httpTemplate"] } : {}), fields: Array.isArray(r.fields) ? r.fields : [],
    } as InstInfo;
  });
}

export type Transport = "slack" | "smtp" | "webhook";
export type Resolution = { ok: true; inst: InstInfo; transport: Transport; target: string } | { ok: false; error: string; inst: InstInfo | null };

export const transportOf = (inst: InstInfo): Transport | null => (inst.typeId === "slack" ? "slack" : inst.typeId === "email" ? "smtp" : inst.typeId === "webhook" || (!["github", "teams"].includes(inst.typeId) && inst.destination && inst.fields.some((f) => f.type === "url")) ? "webhook" : null);

const opensTo = (i: InstInfo, project: string | null): boolean => i.projects === "all" || !project || i.projects.includes(project);

/**
 * Legacy `G.integrationFor` made real: an explicit instance, else a webhook endpoint by its id, else the best instance of the channel's type open to the project.
 * A switched-off connection fails the delivery with a reason, except for mandatory events (kill and restore are never switched off).
 */
export function resolveDest(insts: InstInfo[], d: Dest, project: string | null, mandatory: boolean): Resolution {
  let inst: InstInfo | null = null;
  if (d.integration) {
    inst = insts.find((i) => i.id === d.integration) ?? null;
    if (!inst) return { ok: false, error: "the connection was removed", inst: null };
  } else {
    if (d.channel === "webhook") inst = insts.find((i) => i.typeId === "webhook" && i.targetId === d.target) ?? null;
    if (!inst) {
      const mine = insts.filter((i) => i.typeId === d.channel && opensTo(i, project));
      inst = mine.find((i) => i.enabled && i.health !== "failing") ?? mine[0] ?? null;
    }
    if (!inst) return { ok: false, error: `no ${d.channel} connection is open to this project`, inst: null };
  }
  if (!inst.available) return { ok: false, error: inst.unavailableReason ?? `${inst.name} is not available yet`, inst };
  if (!inst.destination) return { ok: false, error: `${inst.name} cannot receive notifications`, inst };
  if (!opensTo(inst, project) && !mandatory) return { ok: false, error: `${inst.name} is not open to this project`, inst };
  if (!inst.enabled && !mandatory) return { ok: false, error: `${inst.name} is switched off`, inst };
  const transport = transportOf(inst);
  if (!transport) return { ok: false, error: `${inst.name} has no way to send`, inst };
  return { ok: true, inst, transport, target: d.target };
}

/** Email recipients: addresses as written, or a role keyword (submitter, approvers, project admins) resolved against people and role assignments. */
export async function resolveRecipients(db: Queryable, orgId: string, target: string, ctx: { project: string | null; woId: string | null; gateId: string | null }): Promise<string[]> {
  const out = new Set<string>();
  for (const tok of target.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tok)) {
      out.add(tok.toLowerCase());
      continue;
    }
    const kw = tok.toLowerCase();
    if (kw === "submitter" && ctx.woId) {
      const r = (await db.query<{ email: string }>(`select p.email from work_orders w join people p on p.org_id = w.org_id and p.id = w.submitter where w.org_id = $1 and w.id = $2 and p.status = 'active'`, [orgId, ctx.woId])).rows[0];
      if (r?.email) out.add(r.email.toLowerCase());
    } else if (kw === "approvers" && ctx.project) {
      const rule = (
        await db.query<{ rule: { roles?: string[]; people?: string[] } }>(
          `select v.rule from approver_rules a join approver_rule_versions v on v.org_id = a.org_id and v.project_id = a.project_id and v.gate_id = a.gate_id and v.version = a.current_version where a.org_id = $1 and a.project_id = $2 and ($3::text is null or a.gate_id = $3)`,
          [orgId, ctx.project, ctx.gateId],
        )
      ).rows;
      const roles = [...new Set(rule.flatMap((r) => r.rule.roles ?? []))];
      const people = [...new Set(rule.flatMap((r) => r.rule.people ?? []))];
      for (const r of (await db.query<{ email: string }>(
        `select distinct p.email from people p where p.org_id = $1 and p.status = 'active' and (p.id = any($3) or exists (select 1 from role_assignments ra where ra.org_id = p.org_id and ra.person_id = p.id and ra.revoked_at is null and (ra.expires_at is null or ra.expires_at > now()) and ra.role_id = any($2) and (ra.project_id is null or ra.project_id = $4)))`,
        [orgId, roles, people, ctx.project],
      )).rows) if (r.email) out.add(r.email.toLowerCase());
    } else if (kw === "project admins" || kw === "project admin") {
      for (const r of (await db.query<{ email: string }>(
        `select distinct p.email from people p join role_assignments ra on ra.org_id = p.org_id and ra.person_id = p.id where p.org_id = $1 and p.status = 'active' and ra.revoked_at is null and (ra.expires_at is null or ra.expires_at > now()) and ra.role_id in ('project_admin','factory_admin') and (ra.project_id is null or ra.project_id = $2)`,
        [orgId, ctx.project],
      )).rows) if (r.email) out.add(r.email.toLowerCase());
    }
  }
  return [...out];
}

export const hoursOk = (cond: { hours?: string } | null | undefined, tz: string, at: Date): boolean => {
  if (!cond || cond.hours !== "business") return true;
  const zone = tz === "IST" ? "Asia/Kolkata" : tz === "UTC" || tz === "GMT" ? "UTC" : tz;
  let h: number;
  try {
    h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: zone }).format(at));
  } catch {
    h = at.getUTCHours();
  }
  return h >= 9 && h < 19;
};

export const condOf = (v: unknown): { classes: string[]; priority: string[]; hours: string } => {
  const c = obj(v);
  return { classes: Array.isArray(c.classes) ? (c.classes as string[]) : [], priority: Array.isArray(c.priority) ? (c.priority as string[]) : [], hours: typeof c.hours === "string" ? c.hours : "any" };
};
