/**
 * Turns one (event, destination) pair into a delivery: a row in the delivery log and an outbox row, in the caller's transaction (spec 12.2: derived from a
 * committed event, delivered at least once, keyed by event id and destination). A destination that cannot be resolved is logged as a failed delivery with
 * its reason, so it shows up in the log and can be retried once fixed. Nothing here sends: the worker's outbox dispatcher does.
 */
import { enqueueOutbox, type Queryable } from "@gantry/db";
import { publishChange } from "../../core/changes.js";
import { actionsFor, emailParts, factRows, renderTemplate, slackBlocks, webhookData, type CardFields, type CardSample } from "./cards.js";
import { resolveDest, resolveRecipients, type Dest, type InstInfo } from "./routing.js";
import { chatApprovalFor } from "../integrations/chat-policy.js";

export interface EmitCtx {
  orgId: string;
  /** Absent for a test send: the command appends its event after the body returns and queues the outbox row against it. */
  eventId: string | null;
  deliveryId: string;
  /** The notification event id the route subscribed to (`NOTIFY_EVENTS`). */
  event: string;
  mandatory: boolean;
  project: string | null;
  route: { id: string; template: string; fields: CardFields } | null;
  dest: Dest;
  repo: string | null;
  wo: string | null;
  isTest?: boolean;
  sample: CardSample;
  insts: InstInfo[];
  /** The work order's class and risk, for deciding whether chat may offer an approve button. */
  woFacts?: { cls: string; risk: string | null; position?: string } | null;
}

export type EmitInput = Omit<EmitCtx, "deliveryId"> & { deliveryId?: string; reuseDeliveryId?: string };

export interface Emitted { deliveryId: string; status: "pending" | "failed"; error: string }

const destKey = (transport: string, instId: string, target: string): string => `${transport}:${instId}:${target}`.slice(0, 300);

async function nextId(db: Queryable): Promise<string> {
  return `DLV-${(await db.query<{ n: string }>(`select nextval('deliveries_no_seq')::text as n`)).rows[0]!.n}`;
}

/** The request the delivery was made from, kept so a retry of an unresolved destination can be rebuilt. */
const requestOf = (c: EmitCtx): Record<string, unknown> => ({ dest: c.dest, route: c.route, event: c.event, repo: c.repo, wo: c.wo, mandatory: c.mandatory, isTest: c.isTest ?? false });

export type Prepared =
  | { ok: false; error: string; resolvedInst: InstInfo | null }
  | { ok: true; destination: string; payload: Record<string, unknown>; cardKey: string | null; inst: InstInfo; transport: string; target: string };

/** Resolves the destination and builds what the worker will send. No writes. */
export async function prepare(db: Queryable, c: EmitCtx): Promise<Prepared> {
  const res = resolveDest(c.insts, c.dest, c.project, c.mandatory);
  if (!res.ok) return { ok: false, error: res.error, resolvedInst: res.inst };
  const { inst, transport, target } = res;
  const s = c.sample;
  const template = c.route?.template ?? s.template;
  const fields = c.route?.fields ?? {};
  const rows = factRows(fields, c.event, template, s);
  const approve = inst.typeId === "slack" && s.gate && c.woFacts && c.event === "gate.waiting" ? chatApprovalFor(inst.config, s.gate.id, c.woFacts).ok && !!s.instance : false;
  const actions = actionsFor(fields, template, { canApprove: approve, channel: transport === "smtp" ? "email" : transport }, s.link);
  const cardKey = transport === "slack" && c.event === "gate.waiting" && s.instance ? `gate:${s.instance}` : null;
  const common = { integration: inst.id, deliveryId: c.deliveryId, target, mandatory: c.mandatory, text: `${s.head}${s.body ? `\n${s.body}` : ""}` };
  let payload: Record<string, unknown>;
  if (transport === "slack") {
    payload = { ...common, mode: "post", card: slackBlocks(s, rows, actions), ...(cardKey ? { cardKey } : {}) };
  } else if (transport === "smtp") {
    const to = await resolveRecipients(db, c.orgId, target, { project: c.project, woId: c.wo, gateId: s.gate?.id ?? null });
    if (!to.length) return { ok: false, error: `no recipient for "${target}"`, resolvedInst: inst };
    const m = emailParts(s, rows, actions, { ...(c.route ? { route: c.route.id } : {}), showLink: fields.link !== false });
    payload = { ...common, to, subject: m.subject, text: m.text, html: m.html };
  } else if (inst.httpTemplate && inst.httpTemplate.body.trim()) {
    const json = /json/i.test(inst.httpTemplate.contentType);
    payload = { ...common, method: inst.httpTemplate.method, contentType: inst.httpTemplate.contentType, body: renderTemplate(inst.httpTemplate.body, s, { json }) };
  } else {
    payload = { ...common, data: webhookData(s, fields) };
  }
  return { ok: true, destination: destKey(transport, inst.id, target), payload, cardKey, inst, transport, target };
}

/** The delivery-log row. `outboxId` is known when the outbox row was made in the same breath. */
export async function recordDelivery(db: Queryable, c: EmitCtx, p: Prepared, outboxId: string | null): Promise<void> {
  const channel = p.ok ? p.inst.typeId : p.resolvedInst?.typeId ?? c.dest.channel;
  await db.query(
    `insert into deliveries (org_id, id, integration_id, event_id, request, project_id, event_type, channel, target, route_id, override_id, repo_id, wo_id, is_test, destination, status, error, outbox_id, card_key, attempts)
     values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,0)
     on conflict (org_id, id) do update set status = excluded.status, error = excluded.error, outbox_id = excluded.outbox_id, destination = excluded.destination, integration_id = excluded.integration_id, attempts = 0, updated_at = now()`,
    [
      c.orgId, c.deliveryId, p.ok ? p.inst.id : p.resolvedInst?.id ?? c.dest.integration ?? null, c.eventId ?? null, JSON.stringify(requestOf(c)), c.project, c.event, channel, c.dest.target, c.route?.id ?? null, c.dest.override ?? null, c.repo, c.wo, c.isTest ?? false,
      p.ok ? p.destination : `${c.dest.channel}:${c.dest.target}`, p.ok ? "pending" : "failed", p.ok ? "" : `Not delivered: ${p.error}.`, outboxId, p.ok ? p.cardKey : null,
    ],
  );
}

export const newDeliveryId = nextId;

export async function emitOne(db: Queryable, c0: EmitInput): Promise<Emitted> {
  const c: EmitCtx = { ...c0, deliveryId: c0.reuseDeliveryId ?? c0.deliveryId ?? (await nextId(db)) };
  const p = await prepare(db, c);
  if (!p.ok) {
    await recordDelivery(db, c, p, null);
    await publishChange(db, { org: c.orgId, keys: ["deliveries"], ...(c.project ? { project: c.project } : {}) });
    return { deliveryId: c.deliveryId, status: "failed", error: p.error };
  }
  const ob = await enqueueOutbox(db, { orgId: c.orgId, eventId: c.eventId!, destination: p.destination, payload: p.payload });
  // The same event and destination already queued (a route listing a destination twice, a replayed event): one delivery, not two.
  if (!ob.created) return { deliveryId: c.deliveryId, status: "pending", error: "" };
  await recordDelivery(db, c, p, ob.id);
  await publishChange(db, { org: c.orgId, keys: ["deliveries"], ...(c.project ? { project: c.project } : {}) });
  return { deliveryId: c.deliveryId, status: "pending", error: "" };
}
