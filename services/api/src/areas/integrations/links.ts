/**
 * Chat identity linking (spec 12.3). A click in chat counts only when the chat user is linked to exactly one active Gantry person by a recorded link step:
 * the person asks Gantry for a one-time code (signed in, in the browser), then sends it from the chat app (`/gantry link <code>`). The chat app proves who
 * the chat user is; the browser session proves which person. Both ends are recorded.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { Queryable, Tx } from "@gantry/db";
import { command, refuse } from "../../core/index.js";
import { conflict, notFound } from "../../core/errors.js";
import { LinkBody, IdParam } from "./schemas.js";

export const LINK_TTL_MS = 10 * 60_000;
const hashCode = (code: string): string => createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = (): string => Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("").replace(/(.{4})(.{4})/, "$1-$2");

export interface ChatLink { id: string; channel: string; externalId: string; verifiedAt: number | null; person: string }

export const linkOut = (r: { id: string; person_id: string; channel: string; external_id: string; verified_at: Date | null }): ChatLink => ({ id: r.id, channel: r.channel, externalId: r.external_id, verifiedAt: r.verified_at ? r.verified_at.getTime() : null, person: r.person_id });

/** The one active person a chat user is linked to, or why there is none. Inactive people never resolve. */
export async function personForChatUser(db: Queryable, orgId: string, channel: "slack" | "teams", externalId: string): Promise<{ ok: true; personId: string; name: string; linkId: string } | { ok: false; reason: "unlinked" | "inactive" }> {
  const r = (
    await db.query<{ id: string; person_id: string; name: string; status: string }>(
      `select l.id, l.person_id, p.name, p.status from chat_identity_links l join people p on p.org_id = l.org_id and p.id = l.person_id where l.org_id = $1 and l.channel = $2 and l.external_id = $3 and l.verified_at is not null`,
      [orgId, channel, externalId],
    )
  ).rows;
  if (r.length !== 1) return { ok: false, reason: "unlinked" };
  return r[0]!.status === "active" ? { ok: true, personId: r[0]!.person_id, name: r[0]!.name, linkId: r[0]!.id } : { ok: false, reason: "inactive" };
}

/** The chat side of the link step: the code the person was given, sent from the chat app by `externalId`. */
export async function completeLink(tx: Tx, orgId: string, channel: "slack" | "teams", externalId: string, code: string, now: Date): Promise<{ personId: string; name: string }> {
  const req = (await tx.query<{ id: string; person_id: string; expires_at: Date; used_at: Date | null; channel: string }>(`select id, person_id, expires_at, used_at, channel from chat_link_requests where org_id = $1 and code_hash = $2 for update`, [orgId, hashCode(code)])).rows[0];
  if (!req || req.used_at || req.channel !== channel) throw notFound("That link code is not valid. Ask Gantry for a new one.");
  if (req.expires_at.getTime() < now.getTime()) throw conflict("That link code has expired. Ask Gantry for a new one.");
  const person = (await tx.query<{ name: string; status: string }>(`select name, status from people where org_id = $1 and id = $2`, [orgId, req.person_id])).rows[0];
  if (!person || person.status !== "active") throw refuse("denied", "That person is not active, so a chat account cannot be linked to them.");
  const taken = (await tx.query<{ person_id: string }>(`select person_id from chat_identity_links where org_id = $1 and channel = $2 and external_id = $3`, [orgId, channel, externalId])).rows[0];
  if (taken && taken.person_id !== req.person_id) throw conflict("That chat account is already linked to another person. They must unlink it first.");
  await tx.query(`delete from chat_identity_links where org_id = $1 and channel = $2 and person_id = $3`, [orgId, channel, req.person_id]);
  await tx.query(`insert into chat_identity_links (org_id, id, person_id, channel, external_id, verified_at) values ($1,$2,$3,$4,$5,$6)`, [orgId, `cl-${randomBytes(6).toString("hex")}`, req.person_id, channel, externalId, now]);
  await tx.query(`update chat_link_requests set used_at = $3 where org_id = $1 and id = $2`, [orgId, req.id, now]);
  return { personId: req.person_id, name: person.name };
}

export const chatLinkRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  const me = (req: import("fastify").FastifyRequest): string => {
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "Linking a chat account is for signed-in people.");
    return p.id;
  };

  /** The caller's own links. */
  app.get("/api/v1/chat-links", async (req) => {
    const who = me(req);
    const { rows } = await g.pool.query<{ id: string; person_id: string; channel: string; external_id: string; verified_at: Date | null }>(
      `select id, person_id, channel, external_id, verified_at from chat_identity_links where org_id = $1 and person_id = $2 order by created_at`, [g.orgId, who]);
    return rows.map(linkOut);
  });

  /** Step one: the signed-in person asks for a one-time code. The code is shown once; only its hash is stored. */
  app.post("/api/v1/chat-links", async (req) => {
    const b = LinkBody.parse(req.body ?? {});
    me(req);
    // The one-time code is shown once: it is kept out of the stored idempotent reply and out of the message.
    return command(req, { action: null, idempotent: true, storedOmit: ["code", "command"] }, async (tx, a) => {
      const integration = b.integration ?? (await tx.query<{ id: string }>(`select id from integration_instances where org_id = $1 and type_id = $2 and enabled order by created_at limit 1`, [a.orgId, b.channel])).rows[0]?.id;
      if (!integration) throw conflict("Slack is not switched on for this install, so there is nothing to link yet.");
      const code = newCode();
      const expires = new Date(a.now.getTime() + LINK_TTL_MS);
      await tx.query(`insert into chat_link_requests (org_id, id, person_id, channel, integration_id, code_hash, expires_at) values ($1,$2,$3,$4,$5,$6,$7)`, [a.orgId, `clr-${randomBytes(6).toString("hex")}`, a.personId, b.channel, integration, hashCode(code), expires]);
      return {
        msg: `Send the link command in ${b.channel === "slack" ? "Slack" : b.channel} within 10 minutes.`, changes: [], project: null,
        events: [{ type: "chat.link.requested", category: "integrations", subject: { type: "person", id: a.personId! }, projectId: null, after: { channel: b.channel, integration, expiresAt: expires.toISOString() } }],
        extra: { code, expiresAt: expires.getTime(), channel: b.channel, command: `/gantry link ${code}` },
      };
    });
  });

  app.delete("/api/v1/chat-links/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const who = me(req);
    return command(req, { action: null }, async (tx, a) => {
      const r = (await tx.query<{ channel: string; external_id: string }>(`delete from chat_identity_links where org_id = $1 and id = $2 and person_id = $3 returning channel, external_id`, [a.orgId, id, who])).rows[0];
      if (!r) throw notFound("No such link.");
      return { msg: "Chat account unlinked.", changes: [], project: null, events: [{ type: "chat.link.removed", category: "integrations", subject: { type: "person", id: who }, projectId: null, after: { channel: r.channel, externalId: r.external_id } }] };
    });
  });
};
