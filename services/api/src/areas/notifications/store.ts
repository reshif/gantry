/** Reads for routes, deliveries and card templates, in the legacy shapes (`project.notifications`, `deliveries`, `cardTemplates`). */
import type { CardTemplate, Delivery, NotificationRoute } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { ms, obj } from "../../core/read/rows.js";

export interface RouteOut extends NotificationRoute { version: number }

export function routeFromRow(r: { id: string; project_id: string; event: string; destinations: unknown; template: string; conditions: unknown; fields: unknown; enabled: boolean; version: number }): RouteOut {
  return {
    id: String(r.id).slice(String(r.project_id).length + 1), event: r.event, dest: (Array.isArray(r.destinations) ? r.destinations : []) as RouteOut["dest"], template: r.template, cond: obj(r.conditions) as unknown as RouteOut["cond"],
    enabled: r.enabled, fields: obj(r.fields) as unknown as RouteOut["fields"], version: r.version,
  };
}

export async function readRoutes(db: Queryable, orgId: string, project: string): Promise<RouteOut[]> {
  const { rows } = await db.query<Parameters<typeof routeFromRow>[0]>(`select id, project_id, event, destinations, template, conditions, fields, enabled, version from notification_routes where org_id = $1 and project_id = $2 order by created_at, id`, [orgId, project]);
  return rows.map(routeFromRow);
}

interface DeliveryRow {
  id: string; created_at: Date; updated_at: Date; project_id: string | null; event_type: string; channel: string; target: string; integration_id: string | null; status: string; attempts: number; error: string;
  wo_id: string | null; route_id: string | null; override_id: string | null; repo_id: string | null; is_test: boolean; sent_at: Date | null;
}

export const deliveryFromRow = (r: DeliveryRow): Delivery => ({
  id: r.id, at: ms(r.created_at) ?? 0, project: r.project_id, event: r.event_type, channel: r.channel, target: r.target, integration: r.integration_id, status: r.status === "sent" ? "delivered" : r.status === "pending" ? "pending" : "failed",
  state: r.status as Delivery["state"], attempts: r.attempts, error: r.error, ...(r.wo_id ? { wo: r.wo_id } : {}), ...(r.route_id ? { route: r.route_id } : {}), override: r.override_id, repo: r.repo_id, ...(r.is_test ? { test: true } : {}),
});

export interface DeliveryFilter { projects: string[] | "all"; includeFactory: boolean; project?: string | undefined; status?: string | undefined; integration?: string | undefined; event?: string | undefined; cursor?: string | undefined; limit: number }

/** Newest first; `next` is a keyset cursor (`<created_at ms>:<id>`). */
export async function readDeliveries(db: Queryable, orgId: string, f: DeliveryFilter): Promise<{ items: Delivery[]; next: string | null }> {
  const where: string[] = ["org_id = $1"];
  const args: unknown[] = [orgId];
  const p = (v: unknown): string => {
    args.push(v);
    return `$${args.length}`;
  };
  if (f.projects !== "all") where.push(`(project_id = any(${p(f.projects)})${f.includeFactory ? " or project_id is null" : ""})`);
  if (f.project) where.push(`project_id = ${p(f.project)}`);
  if (f.status && f.status !== "all") where.push(f.status === "delivered" ? `status = 'sent'` : f.status === "pending" ? `status = 'pending'` : `status in ('failed','dead')`);
  if (f.integration) where.push(`integration_id = ${p(f.integration)}`);
  if (f.event) where.push(`event_type = ${p(f.event)}`);
  if (f.cursor) {
    const m = /^(\d+):(.+)$/.exec(f.cursor);
    if (m) where.push(`(created_at, id) < (${p(new Date(Number(m[1])))}::timestamptz, ${p(m[2])})`);
  }
  const { rows } = await db.query<DeliveryRow>(
    `select id, created_at, updated_at, project_id, event_type, channel, target, integration_id, status, attempts, error, wo_id, route_id, override_id, repo_id, is_test, sent_at from deliveries where ${where.join(" and ")} order by created_at desc, id desc limit ${f.limit + 1}`,
    args,
  );
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  return { items: page.map(deliveryFromRow), next: rows.length > f.limit && last ? `${last.created_at.getTime()}:${last.id}` : null };
}

export async function readCardTemplates(db: Queryable, orgId: string): Promise<CardTemplate[]> {
  const { rows } = await db.query<{ id: string; name: string; body: Record<string, unknown>; version: number; created_at: Date; updated_at: Date }>(`select id, name, body, version, created_at, updated_at from card_templates where org_id = $1 order by created_at, id`, [orgId]);
  return rows.map((r) => ({ ...(r.body as object), id: r.id, name: r.name, version: r.version, at: ms(r.updated_at) ?? 0, actions: Array.isArray(r.body.actions) ? (r.body.actions as string[]) : [] }) as CardTemplate);
}
