import { createHmac } from "node:crypto";
import { appendEvent, claimOutbox, decrypt, markDelivered, markFailed, withTx, type OutboxItem } from "@gantry/db";
import { publishChange, slackPost, slackUpdate, SLACK_API } from "@gantry/api/core";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { errMsg, PermanentError, TransientError } from "../errors.js";
import { smtpMailer, type Mailer } from "./smtp.js";

/**
 * What a route puts in `outbox.payload` (spec 12.2). The event it came from is read by id, so a card is always built from the committed event.
 *  - smtp:      `to` (addresses), `subject`, `text`, `html`
 *  - slack:     `integration` (the instance holding the webhook URL), `text`, `card` (blocks)
 *  - teams:     `integration`, `text`, `card` (an Adaptive Card body)
 *  - webhook:   `integration` (URL in its config or sealed secret, signing secret sealed) or `url`; the body is the event envelope
 */
export const OutboxPayload = z.looseObject({
  subject: z.string().max(500).optional(),
  text: z.string().max(60_000).default(""),
  html: z.string().max(200_000).optional(),
  to: z.array(z.string().email()).max(50).optional(),
  integration: z.string().min(1).max(200).optional(),
  url: z.url().max(2000).optional(),
  card: z.unknown().optional(),
  /** Set by routes for kill and restore: delivered even when the destination is switched off. */
  mandatory: z.boolean().optional(),
  /** The row in the delivery log this outbox row belongs to (spec 12.2). */
  deliveryId: z.string().max(100).optional(),
  /** Slack: the channel or user to post to. */
  target: z.string().max(300).optional(),
  /** `update` edits the message at `messageRef` in place (a gate card whose gate changed). */
  mode: z.enum(["post", "update"]).optional(),
  messageRef: z.object({ channel: z.string().min(1), ts: z.string().min(1) }).optional(),
  cardKey: z.string().max(300).optional(),
  /** Custom HTTP types: the request body already rendered from the type's template. */
  body: z.string().max(200_000).optional(),
  contentType: z.string().max(100).optional(),
  method: z.enum(["POST", "PUT"]).optional(),
  /** Signed webhook: the structured card data that goes in the envelope instead of the event's own `after`. */
  data: z.unknown().optional(),
});
export type OutboxPayload = z.infer<typeof OutboxPayload>;

interface EventRow {
  id: string; seq: string; type: string; category: string; actor: string; subject: unknown; project_id: string | null; wo_id: string | null; after: unknown; occurred_at: Date; outcome: string;
}

/** Kill and restore notifications cannot be switched off (spec 12.2). */
const isMandatory = (ev: EventRow, p: OutboxPayload): boolean => p.mandatory === true || (ev.category === "kill" && /^(kill|restore|halt|resume|stop\.)/.test(ev.type));

interface Resolved { url: string | null; signingSecret: string | null; enabled: boolean; typeId: string; config: Record<string, unknown>; secrets: Record<string, string>; name: string }

async function resolveIntegration(deps: Deps, orgId: string, id: string, dest: string): Promise<Resolved> {
  const row = (await deps.pool.query<{ enabled: boolean; type_id: string; name: string; config: Record<string, unknown>; secret_enc: string | null; fields: Array<{ key: string; type: string }> | null }>(
    `select i.enabled, i.type_id, i.name, i.config, i.secret_enc, t.field_schema as fields from integration_instances i left join integration_types t on t.org_id = i.org_id and t.id = i.type_id where i.org_id = $1 and i.id = $2`, [orgId, id],
  )).rows[0];
  if (!row) throw new PermanentError(`Integration ${id} does not exist.`, "no_integration");
  let secret: string | null = null;
  if (row.secret_enc) {
    if (!deps.cfg.dataKey) throw new PermanentError("The data key is not available, so the integration's secret cannot be opened.", "no_data_key");
    const open = decrypt(row.secret_enc, deps.cfg.dataKey, `integration:${id}`);
    const r = open.ok ? open : decrypt(row.secret_enc, deps.cfg.dataKey);
    if (!r.ok) throw new PermanentError(`The secret of integration ${id} cannot be opened (${r.error}).`, "bad_secret");
    secret = r.value;
  }
  let sj: Record<string, unknown> = {};
  if (secret && secret.trim().startsWith("{")) {
    try {
      sj = JSON.parse(secret) as Record<string, unknown>;
    } catch {
      sj = {};
    }
  }
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const secrets: Record<string, string> = Object.fromEntries(Object.entries(sj).filter(([, v]) => typeof v === "string") as Array<[string, string]>);
  const plainUrl = secret && /^https?:\/\//.test(secret.trim()) ? secret.trim() : null;
  const urlField = (row.fields ?? []).find((f) => f.type === "url");
  const url = str(row.config.url) ?? str(row.config.webhookUrl) ?? (urlField ? str(row.config[urlField.key]) : null) ?? str(sj.url) ?? str(sj.webhookUrl) ?? (dest !== "webhook" ? plainUrl : null);
  // A webhook-like type has one secret: the signing secret, under whatever key its schema gave it.
  const only = Object.entries(secrets).filter(([k]) => k !== "botToken" && k !== "url" && k !== "webhookUrl");
  const signingSecret = str(sj.signingSecret) ?? str(sj.secret) ?? (dest === "webhook" && only.length === 1 ? only[0]![1] : null) ?? (dest === "webhook" && secret && !plainUrl && !secret.trim().startsWith("{") ? secret : null);
  const { _meta, ...config } = row.config;
  void _meta;
  return { url, signingSecret, enabled: row.enabled, typeId: row.type_id, config, secrets, name: row.name };
}

const text = (ev: EventRow, p: OutboxPayload): string => p.text || `${ev.type}${ev.wo_id ? ` on ${ev.wo_id}` : ""}`;

function envelope(item: OutboxItem, ev: EventRow, p: OutboxPayload): Record<string, unknown> {
  return {
    id: ev.id, delivery: item.id, destination: item.destination, type: ev.type, category: ev.category, outcome: ev.outcome, seq: Number(ev.seq), occurredAt: ev.occurred_at.toISOString(),
    actor: ev.actor, subject: ev.subject, project: ev.project_id, workOrder: ev.wo_id, text: text(ev, p), data: p.data ?? ev.after,
  };
}

function classify(status: number, what: string, body: string): void {
  if (status >= 200 && status < 300) return;
  const msg = `${what} answered ${status}${body ? `: ${body.slice(0, 200)}` : ""}`;
  if (status === 408 || status === 425 || status === 429 || status >= 500) throw new TransientError(msg, `http_${status}`);
  throw new PermanentError(msg, `http_${status}`);
}

export class OutboxDispatcher {
  private running = false;
  private loopDone: Promise<void> | null = null;
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: Deps, private readonly opts: { concurrency?: number } = {}) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopDone = (async () => {
      while (this.running) {
        let n = 0;
        try {
          n = await this.tick();
        } catch (e) {
          this.deps.log.error({ err: errMsg(e) }, "outbox pass failed");
        }
        if (n === 0 && this.running) await this.deps.sleep(this.deps.cfg.pollMs);
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopDone;
    await Promise.allSettled([...this.inflight]);
  }

  /** One pass: claim due rows and deliver them. Resolves when this pass's deliveries are done. */
  async tick(): Promise<number> {
    const { deps } = this;
    const free = (this.opts.concurrency ?? 8) - this.inflight.size;
    if (free <= 0) return 0;
    const items = await claimOutbox(deps.pool, { workerId: deps.workerId, leaseMs: 60_000, limit: free });
    const mine = items.map((i) => {
      const p: Promise<void> = this.deliver(i).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
      return p;
    });
    await Promise.all(mine);
    return items.length;
  }

  /** Drains until nothing is due (tests). */
  async drain(max = 50): Promise<void> {
    for (let i = 0; i < max; i++) if ((await this.tick()) === 0) return;
  }

  /** The transport is the first part of the destination key (`slack:<instance>:<target>`); a bare `smtp` or `slack` still works. */
  private transportOf = (item: OutboxItem): string => item.destination.split(":")[0] ?? item.destination;

  private async deliver(item: OutboxItem): Promise<void> {
    const { deps } = this;
    const payload = OutboxPayload.safeParse(item.payload);
    const deliveryId = payload.success ? payload.data.deliveryId : undefined;
    const update = payload.success && payload.data.mode === "update";
    try {
      const out = await this.send(item);
      await markDelivered(deps.pool, item.id, deps.workerId);
      if (out.note) await deps.pool.query(`update outbox set last_error = $2 where id = $1`, [item.id, out.note]);
      if (deliveryId) {
        if (update) await this.logUpdate(deliveryId, item, null);
        else if (out.note) await this.log(deliveryId, item, { status: "failed", error: `Not sent: ${out.note.replace(/^skipped: /, "")}.` });
        else await this.log(deliveryId, item, { status: "sent", error: "", responseStatus: out.status ?? null, ref: out.ref ?? null });
      }
    } catch (e) {
      const msg = errMsg(e);
      let dead = false;
      if (e instanceof PermanentError) {
        // Dead-lettered at once: retrying cannot help. It stays in the table for a person to see and re-drive.
        await deps.pool.query(
          `update outbox set status = 'dead', lease_owner = null, lease_until = null, last_error = $3, updated_at = now() where id = $1 and lease_owner = $2 and status = 'sending'`,
          [item.id, deps.workerId, msg.slice(0, 4000)],
        );
        deps.log.warn({ outbox: item.id, destination: item.destination, err: msg }, "delivery dead-lettered");
        dead = true;
      } else {
        const st = await markFailed(deps.pool, item.id, deps.workerId, msg);
        deps.log.warn({ outbox: item.id, destination: item.destination, attempt: item.attempts, status: st, err: msg }, "delivery failed");
        dead = st === "dead";
      }
      if (deliveryId) {
        if (update) await this.logUpdate(deliveryId, item, msg);
        else {
          await this.log(deliveryId, item, { status: dead ? "dead" : "failed", error: msg.slice(0, 1000) });
          if (dead) await this.failureNotice(deliveryId, item, msg).catch((err: unknown) => deps.log.error({ err: errMsg(err) }, "could not record the delivery failure"));
        }
      }
    }
  }

  /** The delivery log row follows the outbox row (spec 12.2: the log shows what happened, and a retry re-drives it). */
  private async log(deliveryId: string, item: OutboxItem, o: { status: "sent" | "failed" | "dead"; error: string; responseStatus?: number | null; ref?: { channel: string; ts: string } | null }): Promise<void> {
    const { deps } = this;
    const r = await deps.pool.query<{ project_id: string | null }>(
      `update deliveries set status = $3, error = $4, attempts = $5, outbox_id = $6, event_id = $7, response_status = coalesce($8, response_status), sent_at = case when $3 = 'sent' then now() else sent_at end,
         message_ref = coalesce($9::jsonb, message_ref), updated_at = now() where org_id = $1 and id = $2 returning project_id`,
      [item.orgId, deliveryId, o.status, o.error, item.attempts, item.id, item.eventId, o.responseStatus ?? null, o.ref ? JSON.stringify(o.ref) : null],
    );
    await publishChange(deps.pool, { org: item.orgId, keys: ["deliveries", "audit"], ...(r.rows[0]?.project_id ? { project: r.rows[0].project_id } : {}) }).catch(() => undefined);
  }

  /** An in-place card update that failed is noted on the card's delivery; it never changes that delivery's own status. */
  private async logUpdate(deliveryId: string, item: OutboxItem, error: string | null): Promise<void> {
    await this.deps.pool.query(`update deliveries set message_ref = coalesce(message_ref, '{}'::jsonb) || $3::jsonb, updated_at = now() where org_id = $1 and id = $2`, [item.orgId, deliveryId, JSON.stringify(error ? { updateError: error.slice(0, 300) } : { updated: true, updateError: null })]);
  }

  /** A delivery that ran out of attempts is itself a notification (spec 12.2), unless it was a test or was itself a delivery-failure notice. */
  private async failureNotice(deliveryId: string, item: OutboxItem, error: string): Promise<void> {
    const { deps } = this;
    const d = (await deps.pool.query<{ project_id: string | null; event_type: string; target: string; channel: string; is_test: boolean; wo_id: string | null }>(`select project_id, event_type, target, channel, is_test, wo_id from deliveries where org_id = $1 and id = $2`, [item.orgId, deliveryId])).rows[0];
    if (!d || d.is_test || d.event_type === "delivery.failed") return;
    await withTx(deps.pool, (tx) => appendEvent(tx, {
      orgId: item.orgId, type: "delivery.failed", category: "integrations", actor: "system", channel: "system", subject: { type: "delivery", id: deliveryId }, projectId: d.project_id, woId: d.wo_id, outcome: "failed",
      after: { delivery: deliveryId, destination: item.destination, channel: d.channel, target: d.target, origEvent: d.event_type, error: error.slice(0, 300), text: `${d.event_type} to ${d.target || d.channel} could not be delivered: ${error.slice(0, 200)}` },
    }));
  }

  /** Delivers one row. `note` is set when the delivery was deliberately skipped. */
  private async send(item: OutboxItem): Promise<{ note: string | null; ref?: { channel: string; ts: string } | null; status?: number }> {
    const { deps } = this;
    const parsed = OutboxPayload.safeParse(item.payload);
    if (!parsed.success) throw new PermanentError(`The outbox payload is malformed: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, "bad_payload");
    const p = parsed.data;
    const ev = (await deps.pool.query<EventRow>(`select id, seq::text as seq, type, category, actor, subject, project_id, wo_id, after, occurred_at, outcome from events where id = $1`, [item.eventId])).rows[0];
    if (!ev) throw new PermanentError(`Event ${item.eventId} does not exist.`, "no_event");
    const messageId = `<${item.eventId}.${item.destination.replace(/[^A-Za-z0-9._-]/g, "_")}@gantry>`;
    const transport = this.transportOf(item);

    if (transport === "smtp") {
      if (!p.to?.length) throw new PermanentError("An email needs at least one recipient.", "no_recipient");
      let mail: Mailer = deps.mail;
      let from: string | undefined;
      if (p.integration) {
        const t = await resolveIntegration(deps, item.orgId, p.integration, "smtp");
        if (!t.enabled && !isMandatory(ev, p)) return { note: `skipped: ${t.name} is switched off` };
        const host = typeof t.config.smtpHost === "string" ? t.config.smtpHost.trim() : "";
        from = typeof t.config.from === "string" && t.config.from ? t.config.from : undefined;
        if (host) {
          const port = Number(t.config.smtpPort || deps.cfg.smtp.port);
          const user = typeof t.config.smtpUser === "string" ? t.config.smtpUser : "";
          mail = smtpMailer({ host, port, from: from ?? deps.cfg.smtp.from, secure: port === 465, ...(user ? { auth: { user, pass: t.secrets.smtpPassword ?? "" } } : {}) });
        }
      }
      await mail.send({ to: p.to, subject: p.subject ?? `[Gantry] ${ev.type}`, text: text(ev, p), ...(p.html ? { html: p.html } : {}), ...(from ? { from } : {}), messageId, headers: { "X-Gantry-Event": ev.id, "X-Gantry-Delivery": item.id } });
      return { note: null };
    }
    if (transport !== "slack" && transport !== "teams" && transport !== "webhook") throw new PermanentError(`Unknown destination ${item.destination}.`, "bad_destination");

    const target: Resolved = p.integration ? await resolveIntegration(deps, item.orgId, p.integration, transport) : { url: null, signingSecret: null, enabled: true, typeId: transport, config: {}, secrets: {}, name: transport };
    if (!target.enabled && !isMandatory(ev, p)) return { note: `skipped: integration ${p.integration} is disabled` };

    // Slack with a bot token: chat.postMessage, or chat.update at the stored message reference (a card updated in place).
    if (transport === "slack" && target.secrets.botToken) {
      const base = process.env.GANTRY_SLACK_API || SLACK_API;
      const blocks = Array.isArray(p.card) ? (p.card as unknown[]) : undefined;
      if (p.mode === "update") {
        if (!p.messageRef) throw new PermanentError("A card update needs the message reference.", "no_ref");
        const r = await slackUpdate(deps.http, target.secrets.botToken, p.messageRef, { text: text(ev, p), ...(blocks ? { blocks } : {}) }, base);
        if (!r.ok) throw r.transient ? new TransientError(`Slack chat.update failed: ${r.error}`, `slack_${r.error}`) : new PermanentError(`Slack chat.update failed: ${r.error}`, `slack_${r.error}`);
        return { note: null, status: r.status };
      }
      const channel = (p.target ?? (typeof target.config.defaultChannel === "string" ? target.config.defaultChannel : "")).replace(/^@/, "");
      if (!channel) throw new PermanentError("No Slack channel to post to.", "no_target");
      const r = await slackPost(deps.http, target.secrets.botToken, { channel, text: text(ev, p), ...(blocks ? { blocks } : {}) }, base);
      if (!r.ok) throw r.transient ? new TransientError(`Slack chat.postMessage failed: ${r.error}`, `slack_${r.error}`) : new PermanentError(`Slack chat.postMessage failed: ${r.error}`, `slack_${r.error}`);
      const ch = typeof r.data.channel === "string" ? r.data.channel : channel;
      const ts = typeof r.data.ts === "string" ? r.data.ts : null;
      return { note: null, status: r.status, ref: ts ? { channel: ch, ts } : null };
    }

    const url = p.url ?? target.url;
    if (!url) throw new PermanentError(`No URL is configured for ${transport}${p.integration ? ` (integration ${p.integration})` : ""}.`, "no_url");

    let body: string;
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "gantry-worker", "x-gantry-event": ev.id, "x-gantry-delivery": item.id };
    if (transport === "slack") {
      body = JSON.stringify({ text: text(ev, p), ...(Array.isArray(p.card) ? { blocks: p.card } : {}) });
    } else if (transport === "teams") {
      body = JSON.stringify(p.card && typeof p.card === "object" && !Array.isArray(p.card)
        ? { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: p.card }] }
        : { "@type": "MessageCard", "@context": "http://schema.org/extensions", summary: p.subject ?? ev.type, text: text(ev, p) });
    } else if (p.body !== undefined) {
      body = p.body;
      headers["content-type"] = p.contentType ?? "application/json";
    } else {
      body = JSON.stringify(envelope(item, ev, p));
    }
    if (transport === "webhook" && target.signingSecret) {
      const t = Math.floor(deps.now().getTime() / 1000);
      headers["x-gantry-signature"] = `t=${t},v1=${createHmac("sha256", target.signingSecret).update(`${t}.${body}`).digest("hex")}`;
    }
    const res = await deps.http.request({ method: p.method ?? "POST", url, headers, body });
    classify(res.status, `${transport} endpoint`, res.body);
    return { note: null, status: res.status };
  }
}
