/**
 * POST /auth/backchannel-logout (S-72, OIDC Back-Channel Logout 1.0): the identity provider tells Gantry a user's provider session ended (signed out, disabled,
 * sessions revoked in Keycloak). The logout token is verified against the provider's keys; Gantry then revokes the sessions that belong to it: the one with
 * that `sid` or, when the token names only a subject, every session of the person linked to it. No cookie, no CSRF: the signed token is the credential. The jti is stored in the database.
 */
import { appendEvent, withTx } from "@gantry/db";
import type { FastifyPluginAsync } from "fastify";
import { publishChange } from "../core/changes.js";

export const backchannelRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  // Form-encoded body (`logout_token=...`), parsed only in this plugin.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    } catch (e) {
      done(e as Error);
    }
  });
  const refuse = (reply: import("fastify").FastifyReply, msg: string) => reply.code(400).header("cache-control", "no-store").send({ error: "invalid_request", error_description: msg });

  app.post("/auth/backchannel-logout", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const token = (req.body as { logout_token?: unknown } | null)?.logout_token;
    if (typeof token !== "string" || !token) return refuse(reply, "logout_token is required.");
    let who: { sub?: string; sid?: string; jti: string };
    try {
      who = await g.oidc.verifyLogoutToken(token);
    } catch (e) {
      req.log.warn({ err: e instanceof Error ? e.message : String(e) }, "back-channel logout token refused");
      return refuse(reply, "The logout token is not valid.");
    }
    // The jti is recorded in the same transaction as the revocation (unique key): a replay on any process, or after a restart, is a no-op, and a transaction that
    // fails leaves no jti behind, so the provider's retry still ends the sessions. Entries older than an hour are dropped (a token is only valid for 5 minutes).
    const out = await withTx(g.pool, async (tx) => {
      await tx.query(`delete from backchannel_logout_jti where seen_at < now() - interval '1 hour'`);
      const first = await tx.query(`insert into backchannel_logout_jti (org_id, jti) values ($1,$2) on conflict do nothing`, [g.orgId, who.jti]);
      if (!first.rowCount) return { duplicate: true as const };
      const { rows } = await tx.query<{ id: string; person_id: string }>(
        who.sid
          ? `update sessions set revoked_at = now(), revoked_by = 'idp' where org_id = $1 and idp_sid = $2 and revoked_at is null returning id, person_id`
          : `update sessions set revoked_at = now(), revoked_by = 'idp' where org_id = $1 and revoked_at is null and person_id in (select id from people where org_id = $1 and idp_subject = $2) returning id, person_id`,
        [g.orgId, who.sid ?? who.sub],
      );
      if (rows.length) {
        await appendEvent(tx, { orgId: g.orgId, type: "auth.backchannel_logout", category: "auth", actor: "idp", channel: "system", subject: { type: "person", id: rows[0]!.person_id }, after: { sessions: rows.length, by: who.sid ? "sid" : "sub" }, sourceIp: req.ip || null, requestId: req.id });
        await publishChange(tx, { org: g.orgId, keys: ["sessions", "audit"] });
      }
      return { duplicate: false as const, ended: rows.length };
    });
    if (out.duplicate) return reply.code(200).header("cache-control", "no-store").send({ ok: true, duplicate: true });
    return reply.code(200).header("cache-control", "no-store").send({ ok: true, ended: out.ended });
  });
};
