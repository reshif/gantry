/**
 * The notification producer (spec 12.2). It is the one hook on event append (`addEventObserver`), so every writer (the API's command pipeline, the worker's
 * flow engine, the stop path) produces notifications in the same transaction as the event: committed together, or neither. Routes map an event to destinations
 * with a card template and conditions; repo overrides add or replace destinations; kill and restore ignore switches and conditions; a gate card is updated in
 * place when its gate changes, through the stored message reference. A failure here never undoes the event (the observer runs under a savepoint).
 */
import { addEventObserver, enqueueOutbox, onObserverError, type AppendedEvent, type EventInput, type Queryable, type Tx } from "@gantry/db";
import { obj } from "../../core/read/rows.js";
import { loadSample, slackBlocks, type CardSample } from "./cards.js";
import { emitOne } from "./emit.js";
import { notifyEventFor, type EventLike } from "./events.js";
import { condOf, hoursOk, loadInstances, type Dest, type InstInfo } from "./routing.js";
import { defaultTarget } from "../integrations/connectors.js";

export interface ProducerOptions {
  publicUrl: string;
  onError?: (err: unknown, event: EventInput) => void;
}

let installed: (() => void) | null = null;

/** Installs the observer once per process. Calling it again replaces the options. */
export function registerNotificationProducer(o: ProducerOptions): void {
  installed?.();
  installed = addEventObserver((tx, e, ap) => produceNotifications(tx, e, ap, o.publicUrl));
  onObserverError((err, e) => (o.onError ?? defaultOnError)(err, e));
}
export const unregisterNotificationProducer = (): void => {
  installed?.();
  installed = null;
};

const defaultOnError = (err: unknown, e: EventInput): void => {
  console.error(`notification producer failed for ${e.type}: ${(err as Error)?.message ?? String(err)}`);
};

interface RouteRow { id: string; project_id: string; destinations: Dest[]; template: string; conditions: unknown; fields: Record<string, boolean>; enabled: boolean }
interface WoFacts { cls: string; priority: string; repo: string | null; risk: string | null; position: string }

const asLike = (e: EventInput): EventLike => ({ type: e.type, category: e.category, outcome: e.outcome ?? "ok", projectId: e.projectId ?? null, woId: e.woId ?? null, subject: e.subject ?? null, after: e.after, before: e.before });

export async function produceNotifications(tx: Tx, e: EventInput, ap: AppendedEvent, publicUrl: string): Promise<void> {
  const like = asLike(e);
  await updateGateCards(tx, e, ap, publicUrl);
  const m = notifyEventFor(like);
  if (!m) return;
  const after = obj(e.after);
  // A failed delivery of a delivery-failure notice must not notify again, or a dead endpoint would loop.
  if (m.event === "delivery.failed" && after.origEvent === "delivery.failed") return;
  const orgId = e.orgId;
  const projects = e.projectId
    ? [e.projectId]
    : (await tx.query<{ project_id: string }>(`select distinct project_id from notification_routes where org_id = $1 and event = $2 and project_id is not null`, [orgId, m.event])).rows.map((r) => r.project_id);
  if (!projects.length) return;
  const wo = e.woId ? (await tx.query<WoFacts>(`select class as cls, priority, repo_id as repo, risk, position from work_orders where org_id = $1 and id = $2`, [orgId, e.woId])).rows[0] ?? null : null;
  const repoId = wo?.repo ?? (typeof after.repo === "string" ? after.repo : null);
  const insts = await loadInstances(tx, orgId);
  const tz = (await tx.query<{ tz: string | null }>(`select tz from orgs where id = $1`, [orgId])).rows[0]?.tz ?? "UTC";
  const overrides = repoId ? await repoOverrides(tx, orgId, repoId, m.event) : [];
  for (const project of projects) {
    const routes = (
      await tx.query<RouteRow>(`select id, project_id, destinations, template, conditions, fields, enabled from notification_routes where org_id = $1 and project_id = $2 and event = $3 order by created_at, id`, [orgId, project, m.event])
    ).rows;
    const sample = await loadSample(tx, { orgId, publicUrl, event: m.event, projectId: project, woId: e.woId ?? null, source: like, at: ap.recordedAt });
    let produced = 0;
    const seen = new Set<string>();
    for (const r of routes) {
      if (!m.mandatory) {
        if (!r.enabled) continue;
        const c = condOf(r.conditions);
        if (wo && c.classes.length && !c.classes.includes(wo.cls)) continue;
        if (wo && c.priority.length && !c.priority.includes(wo.priority)) continue;
        if (!hoursOk(c, tz, ap.recordedAt)) continue;
      }
      let dests: Dest[] = Array.isArray(r.destinations) ? r.destinations.map((d) => ({ channel: d.channel, target: d.target, integration: d.integration ?? null })) : [];
      if (overrides.some((o) => o.mode === "instead")) dests = [];
      for (const o of overrides) for (const d of o.dest) dests.push({ channel: d.channel, target: d.target, integration: d.integration ?? null, override: o.id });
      for (const d of dests) {
        const k = `${d.integration ?? d.channel}|${d.target}`;
        if (seen.has(k)) continue;
        seen.add(k);
        await emitOne(tx, {
          orgId, eventId: ap.id, event: m.event, mandatory: m.mandatory, project, route: { id: r.id.slice(project.length + 1) || r.id, template: r.template || sample.template, fields: r.fields }, dest: d,
          repo: repoId, wo: e.woId ?? null, sample: { ...sample, template: r.template || sample.template }, insts, woFacts: wo,
        });
        produced++;
      }
    }
    if (m.mandatory && produced === 0) await fallbackMandatory(tx, { orgId, eventId: ap.id, event: m.event, project, repoId, woId: e.woId ?? null, sample, insts, woFacts: wo });
  }
}

/** Kill and restore cannot be switched off: with no route to carry them, every connection open to the project that can notify gets them at its default target. */
async function fallbackMandatory(tx: Tx, c: { orgId: string; eventId: string; event: string; project: string; repoId: string | null; woId: string | null; sample: CardSample; insts: InstInfo[]; woFacts: WoFacts | null }): Promise<void> {
  for (const inst of c.insts) {
    if (!inst.destination || !inst.available) continue;
    if (inst.projects !== "all" && !inst.projects.includes(c.project)) continue;
    const target = defaultTarget(inst.typeId, inst.config) || (inst.typeId === "webhook" ? inst.targetId ?? "" : "");
    if (!target && inst.typeId !== "webhook") continue;
    await emitOne(tx, { orgId: c.orgId, eventId: c.eventId, event: c.event, mandatory: true, project: c.project, route: null, dest: { channel: inst.typeId, target, integration: inst.id }, repo: c.repoId, wo: c.woId, sample: c.sample, insts: c.insts, woFacts: c.woFacts });
  }
}

interface Override { id: string; event: string; dest: Dest[]; template: string; mode: "also" | "instead" }

/** Repo overrides (spec 12.2): stored on the repo (`data.notifyOverrides`) by onboarding. `also` adds destinations, `instead` replaces the project's. */
async function repoOverrides(db: Queryable, orgId: string, repoId: string, event: string): Promise<Override[]> {
  const r = (await db.query<{ data: { notifyOverrides?: Override[] } }>(`select data from repos where org_id = $1 and id = $2`, [orgId, repoId])).rows[0];
  return (Array.isArray(r?.data?.notifyOverrides) ? r!.data.notifyOverrides! : []).filter((o) => o.event === event && Array.isArray(o.dest)).map((o) => ({ ...o, mode: o.mode === "instead" ? "instead" : "also" }) as Override);
}

/**
 * Cards updated in place (spec 12.2). When a gate instance that a chat card was posted for is no longer open (decided, sent back, reopened on a new head
 * commit, killed), an update is queued for the stored message reference: the card says what happened and loses its buttons.
 */
async function updateGateCards(tx: Tx, e: EventInput, ap: AppendedEvent, publicUrl: string): Promise<void> {
  if (!e.woId || !/^(gate\.|wo\.|kill$|release$)/.test(e.type)) return;
  const cards = (
    await tx.query<{ id: string; card_key: string; message_ref: { channel: string; ts: string }; integration_id: string; target: string; request: { route?: { template?: string; fields?: Record<string, boolean> } | null }; event_type: string }>(
      `select d.id, d.card_key, d.message_ref, d.integration_id, d.target, d.request, d.event_type from deliveries d
       where d.org_id = $1 and d.wo_id = $2 and d.card_key like 'gate:%' and d.status = 'sent' and d.message_ref is not null and coalesce(d.message_ref ->> 'closing', '') = ''
         and not exists (select 1 from gate_instances g where g.org_id = d.org_id and g.id = substr(d.card_key, 6) and g.status = 'open')`,
      [e.orgId, e.woId],
    )
  ).rows;
  if (!cards.length) return;
  const a = obj(e.after);
  const who = typeof a.by === "string" ? (await tx.query<{ name: string }>(`select name from people where org_id = $1 and id = $2`, [e.orgId, a.by])).rows[0]?.name ?? a.by : null;
  for (const c of cards) {
    const gi = (await tx.query<{ closed_reason: string | null; gate_id: string }>(`select closed_reason, gate_id from gate_instances where org_id = $1 and id = $2`, [e.orgId, c.card_key.slice(5)])).rows[0];
    const closedLine =
      gi?.closed_reason === "decision" ? (/rejected/.test(String(a.text ?? "")) ? `Rejected${who ? ` by ${who}` : ""}.` : `Decided${who ? ` by ${who}` : ""}: approved.`)
      : gi?.closed_reason === "new_head" ? "A new commit arrived: this request was superseded."
      : gi?.closed_reason === "send_back" ? "The work order was sent back: this request is closed."
      : gi?.closed_reason === "kill" ? "The work order was killed: this request is closed."
      : "This request is closed.";
    const sample = await loadSample(tx, { orgId: e.orgId, publicUrl, event: "gate.waiting", projectId: e.projectId ?? null, woId: e.woId, source: { type: "gate.waiting", category: "approvals", after: { gate: gi?.gate_id ?? "" } } });
    const blocks = slackBlocks(sample, [], [], { closed: closedLine });
    const dest = `slack:${c.integration_id}:${c.target}:update`.slice(0, 300);
    await enqueueOutbox(tx, { orgId: e.orgId, eventId: ap.id, destination: dest, payload: { integration: c.integration_id, target: c.target, mode: "update", messageRef: c.message_ref, deliveryId: c.id, text: `${sample.head}. ${closedLine}`, card: blocks, mandatory: false } });
    await tx.query(`update deliveries set message_ref = message_ref || '{"closing": true}'::jsonb, updated_at = now() where org_id = $1 and id = $2`, [e.orgId, c.id]);
  }
}

