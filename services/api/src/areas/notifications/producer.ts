/**
 * The notification producer (spec 12.2). It is the one hook on event append (`addEventObserver`), so every writer (the API's command pipeline, the worker's
 * flow engine, the stop path) produces notifications in the same transaction as the event: committed together, or neither. Routes map an event to destinations
 * with a card template and conditions; repo overrides add or replace destinations; kill and restore ignore switches and conditions; a gate card is updated in
 * place when its gate changes, through the stored message reference. A failure here never undoes the event (the observer runs under a savepoint).
 */
import { addEventObserver, enqueueOutbox, onObserverError, type AppendedEvent, type EventInput, type Queryable, type Tx } from "@gantry/db";
import { obj } from "../../core/read/rows.js";
import { loadSample, slackBlocks, type CardSample } from "./cards.js";
import { emitOne, newDeliveryId, recordDelivery } from "./emit.js";
import { isMandatoryEvent, notifyEventFor, type EventLike } from "./events.js";
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
  // A kill or restore notice that ran out of attempts is tried on every other channel, then the Factory Admins (S-37); the usual failure notice still goes through the routes below.
  if (m.event === "delivery.failed" && typeof after.origEvent === "string" && isMandatoryEvent(after.origEvent)) await retryDeadMandatory(tx, e, ap, publicUrl, after);
  // A mention of someone who cannot read the project carries nothing about the work order: only a plain notice to their own address (an admin decides on access).
  if (m.event === "mention" && after.access === false) return void (await mentionNotice(tx, e, ap, publicUrl, after));
  const projects = e.projectId
    ? [e.projectId]
    : (await tx.query<{ project_id: string }>(`select distinct project_id from notification_routes where org_id = $1 and event = $2 and project_id is not null`, [orgId, m.event])).rows.map((r) => r.project_id);
  if (!projects.length && !m.mandatory) return;
  const wo = e.woId ? (await tx.query<WoFacts>(`select class as cls, priority, repo_id as repo, risk, position from work_orders where org_id = $1 and id = $2`, [orgId, e.woId])).rows[0] ?? null : null;
  const repoId = wo?.repo ?? (typeof after.repo === "string" ? after.repo : null);
  const insts = await loadInstances(tx, orgId);
  const tz = (await tx.query<{ tz: string | null }>(`select tz from orgs where id = $1`, [orgId])).rows[0]?.tz ?? "UTC";
  const overrides = repoId ? await repoOverrides(tx, orgId, repoId, m.event) : [];
  // What reached a connection (not a failed row): a kill that reaches nobody falls back to the Factory Admins (S-35).
  let delivered = 0;
  if (!projects.length) {
    // A factory kill with no kill route in any project: every connection open to the factory gets it, else the Factory Admins.
    const sample = await loadSample(tx, { orgId, publicUrl, event: m.event, projectId: null, woId: e.woId ?? null, source: like, at: ap.recordedAt });
    const base = { orgId, eventId: ap.id, event: m.event, repoId, woId: e.woId ?? null, sample, insts, woFacts: wo };
    delivered += await fallbackMandatory(tx, { ...base, project: null });
    if (!delivered) await fallbackAdmins(tx, { ...base, project: e.projectId ?? null });
    return;
  }
  for (const project of projects) {
    const routes = (
      await tx.query<RouteRow>(`select id, project_id, destinations, template, conditions, fields, enabled from notification_routes where org_id = $1 and project_id = $2 and event = $3 order by created_at, id`, [orgId, project, m.event])
    ).rows;
    const sample = await loadSample(tx, { orgId, publicUrl, event: m.event, projectId: project, woId: e.woId ?? null, source: like, at: ap.recordedAt });
    let produced = 0;
    let carried = 0;
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
        const em = await emitOne(tx, {
          orgId, eventId: ap.id, event: m.event, mandatory: m.mandatory, project, route: { id: r.id.slice(project.length + 1) || r.id, template: r.template || sample.template, fields: r.fields }, dest: d,
          repo: repoId, wo: e.woId ?? null, sample: { ...sample, template: r.template || sample.template }, insts, woFacts: wo, mentioned: typeof after.person === "string" ? after.person : null,
        });
        produced++;
        if (em.status === "pending") carried++;
      }
    }
    if (m.event === "mention" && produced === 0) await mentionNotice(tx, e, ap, publicUrl, after);
    if (m.mandatory && carried === 0) carried += await fallbackMandatory(tx, { orgId, eventId: ap.id, event: m.event, project, repoId, woId: e.woId ?? null, sample, insts, woFacts: wo });
    delivered += carried;
    if (m.mandatory && !delivered && project === projects[projects.length - 1]) await fallbackAdmins(tx, { orgId, eventId: ap.id, event: m.event, project: e.projectId ?? null, repoId, woId: e.woId ?? null, sample, insts, woFacts: wo });
  }
}

interface FallbackCtx { orgId: string; eventId: string; event: string; project: string | null; repoId: string | null; woId: string | null; sample: CardSample; insts: InstInfo[]; woFacts: WoFacts | null; exclude?: ReadonlySet<string> }

/** Kill and restore cannot be switched off: with no route to carry them, every connection open to the project that can notify gets them at its default target. Returns how many were queued. */
async function fallbackMandatory(tx: Tx, c: FallbackCtx): Promise<number> {
  let n = 0;
  for (const inst of c.insts) {
    if (!inst.destination || !inst.available || c.exclude?.has(inst.id)) continue;
    if (c.project && inst.projects !== "all" && !inst.projects.includes(c.project)) continue;
    const target = defaultTarget(inst.typeId, inst.config) || (inst.typeId === "webhook" ? inst.targetId ?? "" : "");
    if (!target && inst.typeId !== "webhook") continue;
    const r = await emitOne(tx, { orgId: c.orgId, eventId: c.eventId, event: c.event, mandatory: true, project: c.project, route: null, dest: { channel: inst.typeId, target, integration: inst.id }, repo: c.repoId, wo: c.woId, sample: c.sample, insts: c.insts, woFacts: c.woFacts });
    if (r.status === "pending") n++;
  }
  return n;
}

/**
 * The last line for a kill or restore: when no route and no connection default carried it, the Factory Admins are told by email through any connection that can send
 * it (a switched-off one included: this cannot be switched off). When nothing can carry it, a failed delivery is logged, so the delivery log and the audit trail show
 * that nobody could be told instead of staying silent (S-35, S-37).
 */
async function fallbackAdmins(tx: Tx, c: FallbackCtx): Promise<number> {
  const admins = (
    await tx.query<{ email: string }>(
      `select distinct p.email from people p join effective_role_assignments ra on ra.org_id = p.org_id and ra.person_id = p.id
       where p.org_id = $1 and p.status = 'active' and p.email <> '' and ra.role_id = 'factory_admin' and ra.revoked_at is null and (ra.expires_at is null or ra.expires_at > now()) order by p.email`,
      [c.orgId],
    )
  ).rows.map((r) => r.email);
  let n = 0;
  if (admins.length) {
    for (const inst of c.insts) {
      if (inst.typeId !== "email" || !inst.destination || !inst.available || c.exclude?.has(inst.id)) continue;
      const r = await emitOne(tx, { orgId: c.orgId, eventId: c.eventId, event: c.event, mandatory: true, project: c.project, route: null, dest: { channel: "email", target: admins.join(","), integration: inst.id }, repo: c.repoId, wo: c.woId, sample: c.sample, insts: c.insts, woFacts: c.woFacts });
      if (r.status === "pending") n++;
    }
  }
  if (!n) {
    const ctx = { orgId: c.orgId, eventId: c.eventId, deliveryId: await newDeliveryId(tx), event: c.event, mandatory: true, project: c.project, route: null, dest: { channel: "email", target: "factory admins", integration: null }, repo: c.repoId, wo: c.woId, sample: c.sample, insts: c.insts } as const;
    await recordDelivery(tx, ctx, { ok: false, error: admins.length ? "no route or connection could carry this notice and no email connection can reach the Factory Admins" : "no route or connection could carry this notice and no Factory Admin has an email address", resolvedInst: null }, null);
  }
  return n;
}

/** The notice of a dead kill or restore delivery: the original card again, through every other connection, then the Factory Admins. */
async function retryDeadMandatory(tx: Tx, e: EventInput, ap: AppendedEvent, publicUrl: string, after: Record<string, unknown>): Promise<void> {
  const orgId = e.orgId;
  const origEvent = String(after.origEvent);
  const d = typeof after.delivery === "string"
    ? (await tx.query<{ integration_id: string | null; event_id: string | null; project_id: string | null; wo_id: string | null; repo_id: string | null; is_test: boolean }>(`select integration_id, event_id, project_id, wo_id, repo_id, is_test from deliveries where org_id = $1 and id = $2`, [orgId, after.delivery])).rows[0]
    : undefined;
  if (!d?.event_id || d.is_test) return;
  const src = (await tx.query<{ type: string; category: string; outcome: string; project_id: string | null; wo_id: string | null; subject: { type: string; id: string } | null; after: unknown; before: unknown; recorded_at: Date }>(`select type, category, outcome, project_id, wo_id, subject, after, before, recorded_at from events where id = $1`, [d.event_id])).rows[0];
  const sample = await loadSample(tx, { orgId, publicUrl, event: origEvent, projectId: d.project_id, woId: d.wo_id, ...(src ? { source: { type: src.type, category: src.category, outcome: src.outcome, projectId: src.project_id, woId: src.wo_id, subject: src.subject, after: src.after, before: src.before }, at: src.recorded_at } : {}) });
  const ctx: FallbackCtx = { orgId, eventId: d.event_id, event: origEvent, project: d.project_id, repoId: d.repo_id, woId: d.wo_id, sample, insts: await loadInstances(tx, orgId), woFacts: null, exclude: new Set(d.integration_id ? [d.integration_id] : []) };
  void ap;
  if (!(await fallbackMandatory(tx, ctx))) await fallbackAdmins(tx, ctx);
}

/**
 * The mentioned person's own notice, by email, when no route of the project carries it (or the person cannot read the project, so no route may). It goes through every email
 * connection open to the project. Without access it says only that a colleague mentioned them; the work order is not named.
 */
async function mentionNotice(tx: Tx, e: EventInput, ap: AppendedEvent, publicUrl: string, after: Record<string, unknown>): Promise<void> {
  const person = typeof after.person === "string" ? after.person : "";
  const row = person ? (await tx.query<{ email: string; name: string }>(`select email, name from people where org_id = $1 and id = $2 and status = 'active'`, [e.orgId, person])).rows[0] : null;
  if (!row?.email) return;
  const by = typeof after.by === "string" ? (await tx.query<{ name: string }>(`select name from people where org_id = $1 and id = $2`, [e.orgId, after.by])).rows[0]?.name ?? "A colleague" : "A colleague";
  const access = after.access !== false;
  const source = { type: e.type, category: e.category, after: { ...after, byName: by, personName: row.name, ...(access ? {} : { text: "You were mentioned in a conversation you cannot open yet. A project admin has been asked about access." }) } };
  const sample = await loadSample(tx, { orgId: e.orgId, publicUrl, event: "mention", projectId: e.projectId ?? null, woId: access ? e.woId ?? null : null, source, at: ap.recordedAt });
  for (const inst of await loadInstances(tx, e.orgId)) {
    if (inst.typeId !== "email" || !inst.enabled || !inst.available || !inst.destination) continue;
    if (inst.projects !== "all" && e.projectId && !inst.projects.includes(e.projectId)) continue;
    await emitOne(tx, { orgId: e.orgId, eventId: ap.id, event: "mention", mandatory: false, project: e.projectId ?? null, route: null, dest: { channel: "email", target: row.email, integration: inst.id }, repo: null, wo: access ? e.woId ?? null : null, sample, insts: [inst], mentioned: person });
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

