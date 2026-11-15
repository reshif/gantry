/**
 * Session and identity (spec 8.2, 14.1). Owns:
 *   GET  /auth/login        OIDC authorization-code + PKCE; ?method=sso|github, ?login_hint=, ?step_up=1, ?return_to=
 *   GET  /auth/callback     validates state/nonce/PKCE, provisions, enforces domains and IP list, creates the session
 *   POST /auth/logout
 *   GET  /api/v1/me
 *   GET  /api/v1/sessions, DELETE /api/v1/sessions/{id}
 *   GET  /api/v1/signins
 *   GET/PATCH /api/v1/security
 *   POST /api/v1/can        batch decision point for disabled controls
 *   GET  /api/v1/stream     server-sent change events
 */
import { randomBytes } from "node:crypto";
import { visibleProjects, type SecuritySettings } from "@gantry/domain";
import { appendEvent, withTx } from "@gantry/db";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { recordSignInFailure, signIn } from "../core/auth/signin.js";
import { csrfFor, findSession, listSessions, revokeSessions } from "../core/auth/sessions.js";
import { publishChange } from "../core/changes.js";
import { command } from "../core/command.js";
import { deriveKey } from "../core/config.js";
import { safeEqual, seal, unseal } from "../core/crypto.js";
import { currentPerson, decide, decideFor, policyState } from "../core/decide.js";
import { invalid, notFound, refuse } from "../core/errors.js";
import { readOrg, readProjects, readSecurity } from "../core/read/index.js";
import { publicConfig } from "../core/app.js";
import { openStream } from "../core/stream.js";

const OIDC_COOKIE = "gantry_oidc";
/** The provider's ID token, sealed, kept only to end the provider session at sign-out (path /auth, never sent to the API). */
const IDT_COOKIE = "gantry_idt";

interface OidcState {
  state: string;
  nonce: string;
  verifier: string;
  method: "sso" | "github";
  stepUp: boolean;
  returnTo: string;
  /** Opened in a small window by the app: the callback answers by redirecting to the app's step-up result page, which tells the opener. */
  popup?: boolean;
  /** One-time invite token from the invite email's link, checked at the callback before an invited person is claimed. */
  invite?: string;
}

/** Only same-site relative paths may be returned to (no open redirect). */
// Browsers strip tabs and newlines from URLs and treat "\\" like "/", so "/\t/evil.example" would become "//evil.example": refuse every
// control character and backslash anywhere, not only a second leading slash.
const safeReturn = (v: string | undefined): string => (v && /^\/(?![/\\])[^\u0000-\u001f\u007f\\]*$/.test(v) ? v : "/");

const SecurityPatch = z.object({ path: z.string().min(1).max(100), value: z.unknown() });
const SecuritySchema = z.object({
  sso: z.object({ provider: z.string().max(100), domain: z.string().max(200), enforced: z.boolean(), entity: z.string().max(500) }),
  mfa: z.object({ policy: z.string().max(50), methods: z.array(z.string().max(50)).max(10) }),
  sessionHours: z.number().int().min(1).max(24 * 30),
  idleMin: z.number().int().min(1).max(24 * 60),
  domains: z.array(z.string().max(200)).max(100),
  ipAllow: z.array(z.string().max(100)).max(200),
  restoreFactoryNeedsTwo: z.boolean(),
  killNeedsStepUp: z.boolean(),
  stepUpWindowMinutes: z.number().int().min(5).max(60).optional(),
  githubLogin: z.boolean(),
  researchHosts: z.array(z.string().max(253).regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/)).max(200).optional(),
});

/** Sets `value` at a dotted `path` that must already exist in `obj`. Returns the new object, or null for an unknown path. */
function setPath(obj: SecuritySettings, path: string, value: unknown): SecuritySettings | null {
  const parts = path.split(".");
  const clone = structuredClone(obj) as unknown as Record<string, unknown>;
  let cur = clone;
  for (const [i, k] of parts.entries()) {
    if (!Object.hasOwn(cur, k)) return null;
    if (i === parts.length - 1) cur[k] = value;
    else {
      const next = cur[k];
      if (!next || typeof next !== "object" || Array.isArray(next)) return null;
      cur = next as Record<string, unknown>;
    }
  }
  return clone as unknown as SecuritySettings;
}

const getPath = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  const oidcKey = deriveKey(g.config.secrets.sessionKey, "oidc-cookie");
  const idtKey = deriveKey(g.config.secrets.sessionKey, "id-token-cookie");
  const redirectUri = `${g.config.publicUrl}/auth/callback`;
  const cookieOpts = { path: "/auth", httpOnly: true, sameSite: "lax" as const, secure: g.config.cookieSecure };
  const authRate = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  /** Popup step-up: the app serves a tiny result page (the API's CSP forbids inline script) that posts to its opener and closes. */
  const popupDone = (reply: import("fastify").FastifyReply, ok: boolean, error?: string) =>
    reply.redirect(`/?step_up_popup=${ok ? "ok" : "error"}${error ? `&msg=${encodeURIComponent(error)}` : ""}`, 302);
  const toApp = (reply: import("fastify").FastifyReply, to: string, error?: string) => reply.redirect(error ? `/?auth_error=${encodeURIComponent(error)}` : to, 302);

  /* ------------------------------------------------------------ sign-in */

  app.get("/auth/login", authRate, async (req, reply) => {
    const q = z.object({ method: z.enum(["sso", "github"]).optional(), login_hint: z.string().max(254).optional(), step_up: z.string().optional(), popup: z.string().optional(), return_to: z.string().max(500).optional(), invite: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional() }).safeParse(req.query);
    if (!q.success) return toApp(reply, "/", "The sign-in link is not valid.");
    const method = q.data.method ?? "sso";
    const meta = { ip: req.ip, userAgent: String(req.headers["user-agent"] ?? ""), requestId: req.id, method };
    let idpHint: string | null = null;
    if (method === "github") {
      const sec = (await g.security.get()).value;
      if (!g.oidc.githubIdp || !sec.githubLogin) {
        await recordSignInFailure(g, meta, "github_unavailable").catch(() => undefined);
        return toApp(reply, "/", "GitHub sign-in is not set up for this installation. Use single sign-on.");
      }
      idpHint = g.oidc.githubIdp;
    }
    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    let url: URL;
    try {
      url = await g.oidc.authorizationUrl({ redirectUri, state, nonce, codeVerifier: verifier, loginHint: q.data.login_hint ?? null, stepUp: q.data.step_up === "1", idpHint });
    } catch (e) {
      req.log.error({ err: e }, "OIDC discovery failed");
      return toApp(reply, "/", "The identity provider is not reachable. Try again shortly.");
    }
    const st: OidcState = { state, nonce, verifier, method, stepUp: q.data.step_up === "1", returnTo: safeReturn(q.data.return_to), ...(q.data.popup === "1" && q.data.step_up === "1" ? { popup: true } : {}), ...(q.data.invite ? { invite: q.data.invite } : {}) };
    reply.setCookie(OIDC_COOKIE, seal(st, oidcKey, "oidc-state"), { ...cookieOpts, maxAge: 600 });
    return reply.redirect(url.toString(), 302);
  });

  app.get("/auth/callback", authRate, async (req, reply) => {
    const st = unseal<OidcState>(req.cookies[OIDC_COOKIE], oidcKey, "oidc-state");
    reply.clearCookie(OIDC_COOKIE, cookieOpts);
    const meta = { ip: req.ip, userAgent: String(req.headers["user-agent"] ?? ""), requestId: req.id, method: st?.method ?? ("sso" as const) };
    if (!st) {
      await recordSignInFailure(g, meta, "state_missing").catch(() => undefined);
      return toApp(reply, "/", "The sign-in attempt expired. Start again.");
    }
    let claims;
    try {
      claims = await g.oidc.exchange(new URL(req.url, g.config.publicUrl), { codeVerifier: st.verifier, state: st.state, nonce: st.nonce });
    } catch (e) {
      req.log.warn({ err: e }, "OIDC exchange failed");
      await recordSignInFailure(g, meta, "idp_rejected").catch(() => undefined);
      return toApp(reply, "/", "Sign-in did not complete. Try again.");
    }
    // A step-up keeps the browser's session when it is the same person.
    let existing: { id: string; personId: string } | null = null;
    const tok = req.cookies[g.config.sessionCookie];
    if (st.stepUp && tok) {
      const s = await findSession(g.pool, g.config.secrets.sessionKey, g.orgId, tok, (await g.security.get()).value.idleMin);
      if (s) existing = { id: s.id, personId: s.personId };
    }
    const r = await signIn(g, claims, { ...meta, existingSession: existing, stepUpOnly: st.stepUp, ...(st.invite ? { inviteToken: st.invite } : {}) });
    if (!r.ok) return st.popup ? popupDone(reply, false, r.msg) : toApp(reply, "/", r.msg);
    if (r.token && r.expiresAt) reply.setCookie(g.config.sessionCookie, r.token, { path: "/", httpOnly: true, sameSite: "lax", secure: g.config.cookieSecure, expires: r.expiresAt });
    if (claims.idToken) reply.setCookie(IDT_COOKIE, seal({ t: claims.idToken }, idtKey, "id-token"), { ...cookieOpts, ...(r.expiresAt ? { expires: r.expiresAt } : { maxAge: 12 * 3600 }) });
    await withTx(g.pool, (tx) => publishChange(tx, { org: g.orgId, keys: ["signins", "sessions", ...(r.provisioned ? ["people"] : [])] })).catch(() => undefined);
    return st.popup ? popupDone(reply, true) : toApp(reply, st.returnTo);
  });

  app.post("/auth/logout", authRate, async (req, reply) => {
    const tok = req.cookies[g.config.sessionCookie];
    const idt = unseal<{ t: string }>(req.cookies[IDT_COOKIE], idtKey, "id-token")?.t ?? null;
    const clear = (): void => {
      reply.clearCookie(g.config.sessionCookie, { path: "/", httpOnly: true, sameSite: "lax", secure: g.config.cookieSecure });
      reply.clearCookie(IDT_COOKIE, cookieOpts);
    };
    /** Where the browser goes next so the identity provider ends its SSO session as well. Best effort: Gantry's own sign-out never waits on it. */
    const providerLogout = async (): Promise<string | undefined> => {
      try {
        return (await g.oidc.endSessionUrl({ idTokenHint: idt, postLogoutRedirectUri: `${g.config.publicUrl}/` }))?.toString();
      } catch (e) {
        req.log.warn({ err: e }, "OIDC end-session URL unavailable");
        return undefined;
      }
    };
    const sec = (await g.security.get()).value;
    const s = tok ? await findSession(g.pool, g.config.secrets.sessionKey, g.orgId, tok, sec.idleMin) : null;
    if (!s) {
      clear();
      const logoutUrl = idt ? await providerLogout() : undefined;
      return { ok: true, msg: "You are signed out.", ...(logoutUrl ? { logoutUrl } : {}) };
    }
    const sent = req.headers["x-csrf-token"];
    if (typeof sent !== "string" || !safeEqual(sent, csrfFor(g.config.secrets.sessionKey, s.id))) {
      // The session stays: a forged cross-site logout must not end it.
      return reply.code(403).send({ ok: false, msg: "The request is missing a valid CSRF token.", rule: { kind: "invariant", id: "CSRF", name: "CSRF token" } });
    }
    await withTx(g.pool, async (tx) => {
      await revokeSessions(tx, g.orgId, s.personId, s.id, s.personId);
      await appendEvent(tx, { orgId: g.orgId, type: "auth.signout", category: "auth", actor: s.personId, channel: "web", subject: { type: "session", id: s.id }, sessionId: s.id, sourceIp: req.ip, requestId: req.id });
      await publishChange(tx, { org: g.orgId, keys: ["sessions", "audit"] });
    });
    clear();
    const logoutUrl = await providerLogout();
    return { ok: true, msg: "You are signed out.", ...(logoutUrl ? { logoutUrl } : {}) };
  });

  /* ------------------------------------------------------------ me */

  app.get("/api/v1/me", async (req, reply) => {
    const p = req.gx.principal;
    if (!p || p.kind !== "person") return reply.code(403).send({ ok: false, msg: "This endpoint is for people signed in through the browser." });
    const st = await policyState(req);
    const person = st.people.find((x) => x.id === p.id);
    if (!person) return reply.code(401).send({ ok: false, msg: "This account no longer exists.", config: await publicConfig(app) });
    const visible = new Set(visibleProjects(st, p.id).map((x) => x.id));
    const [projects, sessions, org, config] = await Promise.all([readProjects(g.pool, g.orgId, st.activeStops), listSessions(g.pool, g.orgId, p.id, p.sessionId), readOrg(g.pool, g.orgId), publicConfig(app)]);
    const session = sessions.find((s) => s.id === p.sessionId);
    return {
      person, session: session ?? { id: p.sessionId, person: p.id, method: req.gx.session?.method ?? "sso", device: "", ip: req.ip, started: req.gx.session?.createdAt ?? Date.now(), lastSeen: Date.now(), revoked: false, current: true },
      csrf: csrfFor(g.config.secrets.sessionKey, p.sessionId),
      org: { id: org.id, name: org.name, plant: org.plant, tz: org.tz },
      projects: projects.filter((x) => visible.has(x.id)),
      factory: { killed: st.stops?.factory ?? null },
      config,
    };
  });

  /* ------------------------------------------------------------ sessions, sign-ins */

  app.get("/api/v1/sessions", async (req) => {
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "Sessions belong to people.");
    const all = (req.query as { all?: string }).all === "1" && (await decide(req, "security.manage")).allowed;
    return listSessions(g.pool, g.orgId, all ? null : p.id, p.sessionId);
  });

  app.delete("/api/v1/sessions/:id", async (req) => {
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "Sessions belong to people.");
    const id = (req.params as { id: string }).id;
    const own = await g.pool.query<{ person_id: string }>(`select person_id from sessions where org_id = $1 and id = $2`, [g.orgId, id]);
    if (!own.rows[0]) throw notFound("That session does not exist.");
    const mine = own.rows[0].person_id === p.id;
    return command(req, { action: mine ? null : "security.manage" }, async (tx, a) => {
      const done = await revokeSessions(tx, g.orgId, own.rows[0]!.person_id, id, a.id);
      if (!done.length) throw refuse("conflict", "That session has already ended.");
      return {
        msg: mine && id === p.sessionId ? "Signed out this device." : "Session revoked.",
        events: [{ type: "session.revoked", category: "auth", subject: { type: "session", id }, after: { person: own.rows[0]!.person_id } }],
        changes: ["sessions", "session"],
        project: null,
      };
    });
  });

  app.get("/api/v1/signins", async (req) => {
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "Sign-in history belongs to people.");
    const q = z.object({ all: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().regex(/^\d+$/).optional() }).parse(req.query);
    const all = q.all === "1" && (await decide(req, "security.manage")).allowed;
    const { rows } = await g.pool.query(
      `select s.id, s.person_id, s.method, s.outcome, s.reason, host(s.source_ip) as ip, s.user_agent, s.at, p.email
       from signins s left join people p on p.org_id = s.org_id and p.id = s.person_id
       where s.org_id = $1 and ($2::boolean or s.person_id = $3) and ($4::bigint is null or s.id < $4) order by s.id desc limit $5`,
      [g.orgId, all, p.id, q.cursor ?? null, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => ({ at: new Date(r.at).getTime(), person: r.person_id, email: r.email ?? "", method: r.method, outcome: r.outcome === "ok" ? "success" : "failure", reason: r.reason ?? "", ip: r.ip ?? "", device: r.user_agent ?? "" })),
      next: rows.length > q.limit ? String(page[page.length - 1]!.id) : null,
    };
  });

  /* ------------------------------------------------------------ security settings */

  /** Read by whoever may change them, and by anyone who may read access policy (an Auditor reviews them; only security.manage edits). */
  app.get("/api/v1/security", async (req) => {
    const d = await decide(req, "security.manage");
    if (!d.allowed && !(await decide(req, "policy.view")).allowed) throw refuse(d.rule.kind === "stop" ? "stopped" : "denied", d.reason, { rule: d.rule, needs: d.needs });
    const s = await readSecurity(g.pool, g.orgId);
    return { ...s.value, version: s.version };
  });

  app.patch("/api/v1/security", async (req) => {
    const body = SecurityPatch.parse(req.body);
    return command(
      req,
      {
        action: "security.manage",
        stepUp: true,
        ifMatchRequired: true,
        ifMatch: async (tx) => (await readSecurity(tx, g.orgId)).version,
      },
      async (tx, a) => {
        const cur = await readSecurity(tx, g.orgId);
        const next = setPath(cur.value, body.path, body.value);
        if (!next) throw invalid(`There is no security setting called ${body.path}.`);
        const parsed = SecuritySchema.safeParse(next);
        if (!parsed.success) throw invalid(`That value is not valid for ${body.path}.`);
        const before = getPath(cur.value, body.path);
        const after = getPath(parsed.data, body.path);
        // Locking yourself out: an IP list that excludes the caller is refused.
        if (a.ip && parsed.data.ipAllow.length) {
          const { ipAllowed } = await import("../core/security.js");
          if (!ipAllowed(a.ip, parsed.data.ipAllow)) throw refuse("conflict", "That IP allow-list would lock out your own address.");
        }
        const version = cur.version + 1;
        await tx.query(`insert into security_settings (org_id, version, body, note, published_at, published_by) values ($1,$2,$3::jsonb,$4, now(), $5)`, [g.orgId, version, JSON.stringify(parsed.data), `Set ${body.path}`, a.id]);
        g.security.invalidate();
        return {
          msg: "Security settings saved.",
          events: [{ type: "security.saved", category: "auth", subject: { type: "security", id: "settings" }, before: { [body.path]: before }, after: { [body.path]: after, version } }],
          extra: { version },
          changes: ["security"],
          project: null,
        };
      },
    );
  });

  /* ------------------------------------------------------------ can, stream */

  const CanBody = z.object({
    checks: z.array(z.object({ action: z.string().min(1).max(100), project: z.string().max(100).nullish(), repo: z.string().max(100).nullish(), time: z.number().finite().optional() })).max(500),
  });
  app.post("/api/v1/can", { config: { apiKey: "any" } }, async (req) => {
    const { checks } = CanBody.parse(req.body);
    const st = await policyState(req);
    const now = Date.now();
    const p = req.gx.principal;
    return { results: checks.map((c) => decideFor(st, p, c.action, { project: c.project ?? null, repo: c.repo ?? null, time: c.time ?? now })).map((d) => ({ allowed: d.allowed, reason: d.reason, rule: d.rule, needs: d.needs })) };
  });

  app.get("/api/v1/stream", async (req, reply) => {
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "The live stream is for signed-in people.");
    const st = await policyState(req);
    const person = await currentPerson(req);
    if (!person) throw refuse("denied", "This account no longer exists.");
    const visible = person.roles.some((r) => r.scope === "factory") ? ("all" as const) : new Set(visibleProjects(st, p.id).map((x) => x.id));
    openStream(req, reply, g.hub, { personId: p.id, sessionId: p.sessionId, visible }, g.heartbeatMs);
  });
};
