/**
 * Notification commands (spec 8.8, 12.2): routes, test sends, delivery retry, card templates. Each runs inside `command()` (decision point, event and state in one
 * transaction, a denial audited). A test send and a retry only queue an outbox row: the worker delivers, and the delivery log shows the outcome.
 */
import { endSentence } from "../../core/text.js";
import type { z } from "zod";
import type { Tx } from "@gantry/db";
import { CARD_ACTIONS, CARD_TEMPLATES } from "@gantry/domain";
import type { Actor, CommandResult } from "../../core/command.js";
import { conflict, invalid, notFound } from "../../core/errors.js";
import { loadSample, type CardFields } from "./cards.js";
import { emitOne, newDeliveryId, prepare, recordDelivery } from "./emit.js";
import { isMandatoryEvent, NOTIFY_EVENT_IDS } from "./events.js";
import { loadInstances, type Dest } from "./routing.js";
import { routeFromRow } from "./store.js";
import type { CardTemplateBody, RouteBody, RoutePatch, TestBody } from "./schemas.js";

type Cmd = CommandResult<Record<string, unknown>>;
const json = (v: unknown): string => JSON.stringify(v);
const cat = "integrations" as const;

const ROUTE_COLS = `id, project_id, event, destinations, template, conditions, fields, enabled, version`;

async function checkTemplate(tx: Tx, orgId: string, template: string): Promise<void> {
  if (!template || CARD_TEMPLATES[template]) return;
  const r = await tx.query(`select 1 from card_templates where org_id = $1 and id = $2`, [orgId, template]);
  if (!r.rowCount) throw invalid(`There is no card template ${template}.`);
}

async function checkDests(tx: Tx, orgId: string, dest: Dest[]): Promise<void> {
  const insts = await loadInstances(tx, orgId);
  for (const d of dest) {
    if (d.integration && !insts.some((i) => i.id === d.integration)) throw invalid(`There is no connection ${d.integration}.`);
    const inst = d.integration ? insts.find((i) => i.id === d.integration)! : insts.find((i) => i.typeId === d.channel);
    if (!d.target && !(inst && inst.typeId === "webhook")) throw invalid(`Give the target for ${inst?.name ?? d.channel}.`);
  }
}

/** Kill and restore notifications cannot be switched off (spec 12.2): their routes stay on and unconditional, and cannot be removed. */
const mandatoryRoute = (event: string): boolean => isMandatoryEvent(event);

export async function createRoute(tx: Tx, a: Actor, project: string, b: z.infer<typeof RouteBody>): Promise<Cmd> {
  if (!NOTIFY_EVENT_IDS.has(b.event)) throw invalid(`${b.event} is not a notification event.`);
  if (mandatoryRoute(b.event) && (!b.enabled || b.cond.classes.length || b.cond.priority.length || b.cond.hours !== "any")) throw invalid("Kill and restore notifications cannot be switched off or narrowed.");
  await checkTemplate(tx, a.orgId, b.template);
  await checkDests(tx, a.orgId, b.dest);
  await tx.query(`select 1 from projects where org_id = $1 and id = $2 for update`, [a.orgId, project]);
  const ids = (await tx.query<{ id: string }>(`select id from notification_routes where org_id = $1 and project_id = $2`, [a.orgId, project])).rows.map((r) => Number(r.id.slice(project.length + 1).replace(/^NR-/, "")) || 0);
  const rid = `NR-${Math.max(0, ...ids) + 1}`;
  await tx.query(
    `insert into notification_routes (org_id, id, project_id, event, destinations, template, conditions, fields, enabled) values ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9)`,
    [a.orgId, `${project}:${rid}`, project, b.event, json(b.dest), b.template, json(b.cond), json(b.fields), b.enabled],
  );
  return {
    msg: `Route ${rid} saved.`, changes: ["projects", "notifications"], project,
    events: [{ type: "notify.edit", category: cat, subject: { type: "route", id: `${project}:${rid}` }, before: null, after: { event: b.event, dest: b.dest, template: b.template, cond: b.cond, enabled: b.enabled } }],
    extra: { id: rid, version: 1 },
  };
}

export async function updateRoute(tx: Tx, a: Actor, project: string, rid: string, b: z.infer<typeof RoutePatch>): Promise<Cmd> {
  const cur = (await tx.query<Parameters<typeof routeFromRow>[0]>(`select ${ROUTE_COLS} from notification_routes where org_id = $1 and id = $2 and project_id = $3 for update`, [a.orgId, `${project}:${rid}`, project])).rows[0];
  if (!cur) throw notFound("No such route.");
  const before = routeFromRow(cur);
  const next = {
    event: b.event ?? before.event, dest: b.dest ?? before.dest, template: b.template ?? before.template, cond: b.cond ?? before.cond, enabled: b.enabled ?? before.enabled, fields: b.fields ?? before.fields,
  };
  if (!NOTIFY_EVENT_IDS.has(next.event)) throw invalid(`${next.event} is not a notification event.`);
  const cond = next.cond as { classes?: string[]; priority?: string[]; hours?: string };
  if (mandatoryRoute(next.event) && (!next.enabled || cond.classes?.length || cond.priority?.length || (cond.hours && cond.hours !== "any"))) throw invalid("Kill and restore notifications cannot be switched off or narrowed.");
  await checkTemplate(tx, a.orgId, next.template);
  await checkDests(tx, a.orgId, next.dest as Dest[]);
  await tx.query(
    `update notification_routes set event = $3, destinations = $4::jsonb, template = $5, conditions = $6::jsonb, fields = $7::jsonb, enabled = $8, version = version + 1, updated_at = now() where org_id = $1 and id = $2`,
    [a.orgId, `${project}:${rid}`, next.event, json(next.dest), next.template, json(next.cond), json(next.fields), next.enabled],
  );
  return {
    msg: `Route ${rid} saved.`, changes: ["projects", "notifications"], project,
    events: [{ type: "notify.edit", category: cat, subject: { type: "route", id: `${project}:${rid}` }, before: { event: before.event, dest: before.dest, template: before.template, cond: before.cond, enabled: before.enabled }, after: next }],
    extra: { id: rid, version: before.version + 1 },
  };
}

export async function deleteRoute(tx: Tx, a: Actor, project: string, rid: string): Promise<Cmd> {
  const cur = (await tx.query<Parameters<typeof routeFromRow>[0]>(`select ${ROUTE_COLS} from notification_routes where org_id = $1 and id = $2 and project_id = $3 for update`, [a.orgId, `${project}:${rid}`, project])).rows[0];
  if (!cur) throw notFound("No such route.");
  if (mandatoryRoute(cur.event)) throw conflict("Kill and restore routes cannot be removed. Change where they go instead.");
  await tx.query(`delete from notification_routes where org_id = $1 and id = $2`, [a.orgId, `${project}:${rid}`]);
  return { msg: "Route removed.", changes: ["projects", "notifications"], project, events: [{ type: "notify.delete", category: cat, subject: { type: "route", id: `${project}:${rid}` }, before: { event: cur.event, dest: cur.destinations }, after: null }] };
}

/** A test send (spec 8.8 `sendTest`): a real card for the chosen event, queued to one destination and delivered by the worker like any other. */
export async function sendTest(tx: Tx, a: Actor, publicUrl: string, project: string, b: z.infer<typeof TestBody>): Promise<Cmd> {
  const d0: Dest = typeof b.dest === "object" ? { channel: b.dest.channel, target: (b.dest.target ?? "").trim(), integration: b.dest.integration ?? null } : { channel: b.dest, target: (b.target ?? "").trim(), integration: b.integration ?? null };
  const event = b.event && NOTIFY_EVENT_IDS.has(b.event) ? b.event : "submitted";
  const insts = await loadInstances(tx, a.orgId);
  const sample = await loadSample(tx, { orgId: a.orgId, publicUrl, event, projectId: project });
  const deliveryId = await newDeliveryId(tx);
  const ctx = { orgId: a.orgId, eventId: null, deliveryId, event, mandatory: false, project, route: null, dest: d0, repo: null, wo: null, isTest: true, sample, insts } as const;
  const p = await prepare(tx, ctx);
  if (p.ok && !d0.target && p.inst.typeId !== "webhook") throw invalid("Give the target to send the test to.");
  await recordDelivery(tx, ctx, p, null);
  const label = `${p.ok ? p.inst.name : p.resolvedInst?.name ?? d0.channel} → ${d0.target || "default"}`;
  const queued = p.ok;
  return {
    msg: p.ok ? `Test to ${d0.target || "the default target"} queued on ${p.inst.name}. The delivery log shows the outcome.` : `Test to ${d0.target} failed: ${endSentence(p.error)}`, changes: ["deliveries"], project,
    events: [{ type: "notify.test", category: cat, outcome: queued ? "ok" : "failed", subject: { type: "project", id: project }, after: { label, event, delivery: deliveryId, ...(p.ok ? {} : { error: p.error }) } }],
    extra: { delivery: { id: deliveryId, event, channel: p.ok ? p.inst.typeId : d0.channel, target: d0.target, integration: p.ok ? p.inst.id : p.resolvedInst?.id ?? d0.integration ?? null, queued, status: queued ? "pending" : "failed", ...(p.ok ? {} : { error: p.error }) } },
    ...(p.ok ? { outbox: [{ destination: p.destination, payload: p.payload }] } : {}),
  };
}

/** Retry a delivery that failed or ran out of attempts: its outbox row goes back to pending with a fresh attempt count, or an unresolved destination is resolved again. */
export async function retryDelivery(tx: Tx, a: Actor, publicUrl: string, deliveryId: string): Promise<Cmd & { projectOf?: string | null }> {
  const d = (
    await tx.query<{ id: string; project_id: string | null; status: string; outbox_id: string | null; event_id: string | null; request: Record<string, unknown>; target: string; channel: string; event_type: string; wo_id: string | null; repo_id: string | null }>(
      `select id, project_id, status, outbox_id, event_id, request, target, channel, event_type, wo_id, repo_id from deliveries where org_id = $1 and id = $2 for update`, [a.orgId, deliveryId],
    )
  ).rows[0];
  if (!d) throw notFound("No such delivery.");
  if (d.status === "sent") throw conflict("That delivery already went out.");
  if (d.status === "pending") throw conflict("That delivery is still being sent.");
  const mk = (msg: string): Cmd => ({ msg, changes: ["deliveries"], project: d.project_id, events: [{ type: "delivery.retry", category: cat, subject: { type: "delivery", id: deliveryId }, projectId: d.project_id, woId: d.wo_id, after: { event: d.event_type, target: d.target, channel: d.channel } }] });
  if (d.outbox_id) {
    const r = await tx.query(`update outbox set status = 'pending', attempts = 0, next_attempt_at = now(), lease_owner = null, lease_until = null, last_error = null where id = $1 and status in ('dead','pending','delivered')`, [d.outbox_id]);
    if (!r.rowCount) throw conflict("That delivery is being retried already.");
    await tx.query(`update deliveries set status = 'pending', error = '', attempts = 0, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, deliveryId]);
    return mk("Queued again. The delivery log shows the outcome.");
  }
  if (!d.event_id) throw conflict("That delivery has no event to send from.");
  const req = d.request as { dest?: Dest; route?: { id: string; template: string; fields: CardFields } | null; event?: string; mandatory?: boolean; isTest?: boolean };
  if (!req.dest) throw conflict("That delivery cannot be rebuilt.");
  const ev = (await tx.query<{ type: string; category: string; outcome: string; project_id: string | null; wo_id: string | null; subject: { type: string; id: string } | null; after: unknown; before: unknown; recorded_at: Date }>(`select type, category, outcome, project_id, wo_id, subject, after, before, recorded_at from events where id = $1`, [d.event_id])).rows[0];
  const event = req.event ?? d.event_type;
  const sample = await loadSample(tx, { orgId: a.orgId, publicUrl, event, projectId: d.project_id, woId: d.wo_id, ...(ev ? { source: { type: ev.type, category: ev.category, outcome: ev.outcome, projectId: ev.project_id, woId: ev.wo_id, subject: ev.subject, after: ev.after, before: ev.before }, at: ev.recorded_at } : {}) });
  const insts = await loadInstances(tx, a.orgId);
  const e = await emitOne(tx, { orgId: a.orgId, eventId: d.event_id, event, mandatory: req.mandatory === true || isMandatoryEvent(event), project: d.project_id, route: req.route ?? null, dest: req.dest, repo: d.repo_id, wo: d.wo_id, isTest: req.isTest ?? false, sample, insts, reuseDeliveryId: deliveryId });
  if (e.status === "failed") throw conflict(`Retry failed again: ${endSentence(e.error)}`);
  return mk("Queued again. The delivery log shows the outcome.");
}

/* ------------------------------------------------------------------ card templates */

/** The projects (other than `owner`) whose routes or repo overrides point at a card. */
async function otherProjectsUsing(tx: Tx, orgId: string, id: string, owner: string | null): Promise<string[]> {
  const routes = (await tx.query<{ project_id: string }>(`select distinct project_id from notification_routes where org_id = $1 and template = $2`, [orgId, id])).rows.map((r) => r.project_id);
  const ovr = (await tx.query<{ project_id: string }>(`select distinct r.project_id from repos r, jsonb_array_elements(coalesce(r.data -> 'notifyOverrides', '[]'::jsonb)) o where r.org_id = $1 and o ->> 'template' = $2`, [orgId, id])).rows.map((r) => r.project_id);
  return [...new Set([...routes, ...ovr])].filter((p) => p && p !== owner);
}

/** `projectOnly`: the caller holds only the project's `notify.edit`, so a card that other projects' routes use is not theirs to change. */
export async function saveCardTemplate(tx: Tx, a: Actor, b: z.infer<typeof CardTemplateBody>, o: { projectOnly?: boolean } = {}): Promise<Cmd> {
  if (!b.name) throw invalid("Name the card.");
  if (!CARD_TEMPLATES[b.kind]) throw invalid("Pick what the card is for.");
  const bad = b.actions.filter((x) => !CARD_ACTIONS[x]);
  if (bad.length) throw invalid(`Unknown actions: ${bad.join(", ")}.`);
  const body = { kind: b.kind, fields: b.fields, actions: b.actions, integration: b.integration ?? null, project: b.project ?? null, by: a.personId ?? a.id };
  let id = b.id;
  let before: unknown = null;
  if (id) {
    const ex = (await tx.query<{ name: string; body: unknown; version: number }>(`select name, body, version from card_templates where org_id = $1 and id = $2 for update`, [a.orgId, id])).rows[0];
    if (!ex) throw notFound("No such card template.");
    if (o.projectOnly) {
      const others = await otherProjectsUsing(tx, a.orgId, id, b.project ?? null);
      if (others.length) throw conflict(`Also used by ${others.join(", ")}. Ask a factory admin to change a card other projects use.`);
    }
    before = { name: ex.name, ...(ex.body as object) };
    await tx.query(`update card_templates set name = $3, body = $4::jsonb, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, id, b.name, json(body)]);
  } else {
    const n = Number((await tx.query<{ n: string }>(`select count(*) as n from card_templates where org_id = $1`, [a.orgId])).rows[0]!.n);
    for (let k = n + 1; ; k++) {
      id = `CT-${k}`;
      const ins = await tx.query(`insert into card_templates (org_id, id, name, body) values ($1,$2,$3,$4::jsonb) on conflict do nothing`, [a.orgId, id, b.name, json(body)]);
      if (ins.rowCount) break;
    }
  }
  return { msg: `${b.name} saved.`, changes: ["cardTemplates"], project: b.project ?? null, events: [{ type: "card.template", category: cat, subject: { type: "cardTemplate", id: id! }, projectId: b.project ?? null, before, after: { name: b.name, ...body } }], extra: { template: { id, name: b.name, ...body, actions: b.actions } } };
}

export async function removeCardTemplate(tx: Tx, a: Actor, id: string): Promise<Cmd> {
  const t = (await tx.query<{ name: string; body: unknown }>(`select name, body from card_templates where org_id = $1 and id = $2 for update`, [a.orgId, id])).rows[0];
  if (!t) throw notFound(CARD_TEMPLATES[id] ? "Built-in card templates cannot be removed." : "No such card template.");
  const users = (
    await tx.query<{ project_id: string; id: string }>(`select project_id, id from notification_routes where org_id = $1 and template = $2`, [a.orgId, id])
  ).rows.map((r) => `${r.project_id} ${r.id.slice(r.project_id.length + 1)}`);
  const ovr = (await tx.query<{ name: string }>(`select r.name from repos r, jsonb_array_elements(coalesce(r.data -> 'notifyOverrides', '[]'::jsonb)) o where r.org_id = $1 and o ->> 'template' = $2`, [a.orgId, id])).rows.map((r) => `${r.name} override`);
  if (users.length + ovr.length) throw conflict(`Used by ${[...users, ...ovr].join(", ")}. Pick another card on those routes first.`);
  await tx.query(`delete from card_templates where org_id = $1 and id = $2`, [a.orgId, id]);
  return { msg: `${t.name} removed.`, changes: ["cardTemplates"], project: null, events: [{ type: "card.template", category: cat, subject: { type: "cardTemplate", id }, before: { name: t.name, ...(t.body as object) }, after: null }] };
}

