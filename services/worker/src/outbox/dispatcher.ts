import { createHmac } from "node:crypto";
import { claimOutbox, decrypt, markDelivered, markFailed, type OutboxItem } from "@gantry/db";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { errMsg, PermanentError, TransientError } from "../errors.js";

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
});
export type OutboxPayload = z.infer<typeof OutboxPayload>;

interface EventRow {
  id: string; seq: string; type: string; category: string; actor: string; subject: unknown; project_id: string | null; wo_id: string | null; after: unknown; occurred_at: Date; outcome: string;
}

/** Kill and restore notifications cannot be switched off (spec 12.2). */
const isMandatory = (ev: EventRow, p: OutboxPayload): boolean => p.mandatory === true || (ev.category === "kill" && /^(kill|restore|halt|resume|stop\.)/.test(ev.type));

interface Resolved { url: string | null; signingSecret: string | null; enabled: boolean }

async function resolveIntegration(deps: Deps, orgId: string, id: string, dest: string): Promise<Resolved> {
  const row = (await deps.pool.query<{ enabled: boolean; config: Record<string, unknown>; secret_enc: string | null }>(
    `select enabled, config, secret_enc from integration_instances where org_id = $1 and id = $2`, [orgId, id],
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
  const plainUrl = secret && /^https?:\/\//.test(secret.trim()) ? secret.trim() : null;
  const url = str(row.config.url) ?? str(row.config.webhookUrl) ?? str(sj.url) ?? str(sj.webhookUrl) ?? (dest !== "webhook" ? plainUrl : null);
  const signingSecret = str(sj.signingSecret) ?? str(sj.secret) ?? (dest === "webhook" && secret && !plainUrl && !secret.trim().startsWith("{") ? secret : null);
  return { url, signingSecret, enabled: row.enabled };
}

const text = (ev: EventRow, p: OutboxPayload): string => p.text || `${ev.type}${ev.wo_id ? ` on ${ev.wo_id}` : ""}`;

function envelope(item: OutboxItem, ev: EventRow, p: OutboxPayload): Record<string, unknown> {
  return {
    id: ev.id, delivery: item.id, destination: item.destination, type: ev.type, category: ev.category, outcome: ev.outcome, seq: Number(ev.seq), occurredAt: ev.occurred_at.toISOString(),
    actor: ev.actor, subject: ev.subject, project: ev.project_id, workOrder: ev.wo_id, text: text(ev, p), data: ev.after,
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

  private async deliver(item: OutboxItem): Promise<void> {
    const { deps } = this;
    try {
      const note = await this.send(item);
      await markDelivered(deps.pool, item.id, deps.workerId);
      if (note) await deps.pool.query(`update outbox set last_error = $2 where id = $1`, [item.id, note]);
    } catch (e) {
      const msg = errMsg(e);
      if (e instanceof PermanentError) {
        // Dead-lettered at once: retrying cannot help. It stays in the table for a person to see and re-drive.
        await deps.pool.query(
          `update outbox set status = 'dead', lease_owner = null, lease_until = null, last_error = $3, updated_at = now() where id = $1 and lease_owner = $2 and status = 'sending'`,
          [item.id, deps.workerId, msg.slice(0, 4000)],
        );
        deps.log.warn({ outbox: item.id, destination: item.destination, err: msg }, "delivery dead-lettered");
      } else {
        const s = await markFailed(deps.pool, item.id, deps.workerId, msg);
        deps.log.warn({ outbox: item.id, destination: item.destination, attempt: item.attempts, status: s, err: msg }, "delivery failed");
      }
    }
  }

  /** Delivers one row. Returns a note when the delivery was deliberately skipped. */
  private async send(item: OutboxItem): Promise<string | null> {
    const { deps } = this;
    const parsed = OutboxPayload.safeParse(item.payload);
    if (!parsed.success) throw new PermanentError(`The outbox payload is malformed: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, "bad_payload");
    const p = parsed.data;
    const ev = (await deps.pool.query<EventRow>(`select id, seq::text as seq, type, category, actor, subject, project_id, wo_id, after, occurred_at, outcome from events where id = $1`, [item.eventId])).rows[0];
    if (!ev) throw new PermanentError(`Event ${item.eventId} does not exist.`, "no_event");
    const messageId = `<${item.eventId}.${item.destination}@gantry>`;

    if (item.destination === "smtp") {
      if (!p.to?.length) throw new PermanentError("An email needs at least one recipient.", "no_recipient");
      await deps.mail.send({ to: p.to, subject: p.subject ?? `[Gantry] ${ev.type}`, text: text(ev, p), ...(p.html ? { html: p.html } : {}), messageId, headers: { "X-Gantry-Event": ev.id, "X-Gantry-Delivery": item.id } });
      return null;
    }
    if (item.destination !== "slack" && item.destination !== "teams" && item.destination !== "webhook") throw new PermanentError(`Unknown destination ${item.destination}.`, "bad_destination");

    const target: Resolved = p.integration ? await resolveIntegration(deps, item.orgId, p.integration, item.destination) : { url: null, signingSecret: null, enabled: true };
    if (!target.enabled && !isMandatory(ev, p)) return `skipped: integration ${p.integration} is disabled`;
    const url = p.url ?? target.url;
    if (!url) throw new PermanentError(`No URL is configured for ${item.destination}${p.integration ? ` (integration ${p.integration})` : ""}.`, "no_url");

    let body: string;
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "gantry-worker", "x-gantry-event": ev.id, "x-gantry-delivery": item.id };
    if (item.destination === "slack") {
      body = JSON.stringify({ text: text(ev, p), ...(Array.isArray(p.card) ? { blocks: p.card } : {}) });
    } else if (item.destination === "teams") {
      body = JSON.stringify(p.card && typeof p.card === "object" && !Array.isArray(p.card)
        ? { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: p.card }] }
        : { "@type": "MessageCard", "@context": "http://schema.org/extensions", summary: p.subject ?? ev.type, text: text(ev, p) });
    } else {
      body = JSON.stringify(envelope(item, ev, p));
      if (target.signingSecret) {
        const t = Math.floor(deps.now().getTime() / 1000);
        headers["x-gantry-signature"] = `t=${t},v1=${createHmac("sha256", target.signingSecret).update(`${t}.${body}`).digest("hex")}`;
      }
    }
    const res = await deps.http.request({ method: "POST", url, headers, body });
    classify(res.status, `${item.destination} endpoint`, res.body);
    return null;
  }
}
