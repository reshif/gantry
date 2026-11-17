import { createHash } from "node:crypto";
import { appendEvent, withTx, type Tx } from "@gantry/db";
import { DenialSampler } from "../denial-sampler.js";
import type { Gantry } from "../context.js";
import type { IdClaims } from "../oidc.js";
import { readSecurity } from "../read/index.js";
import { emailDomainAllowed, ipAllowed } from "../security.js";
import { hasSecondFactor } from "../oidc.js";
import { holdsFactoryAdmin, MFA_REQUIRED_MSG } from "./mfa.js";
import { createSession, refreshAuthTime } from "./sessions.js";

export interface SignInRequest {
  ip: string;
  userAgent: string;
  requestId: string;
  method: "sso" | "github";
  /** Session the browser already holds when this sign-in is a step-up. */
  existingSession?: { id: string; personId: string } | null;
  /** A step-up must refresh the held session and must never switch it to another person. */
  stepUpOnly?: boolean;
  /** The one-time token from an invite link. Required to claim an invited person by email address. */
  inviteToken?: string;
}

export type SignInResult =
  | { ok: true; personId: string; sessionId: string; token: string | null; expiresAt: Date | null; stepUp: boolean; provisioned: boolean }
  | { ok: false; reason: string; msg: string; personId: string | null };

const DENY = {
  no_email: "The identity provider did not return an email address.",
  email_unverified: "Your email address is not verified at the identity provider.",
  domain_not_allowed: "Your email domain is not allowed to sign in.",
  ip_not_allowed: "Sign-in is not allowed from this network address.",
  account_inactive: "This account is deactivated or suspended.",
  different_person: "That sign-in was a different person, so the change was cancelled. Sign in again as yourself.",
  identity_mismatch: "This account is linked to a different identity at the provider.",
  mfa_required: MFA_REQUIRED_MSG,
  invite_required: "This account has not been linked to your sign-in yet. Open the invite link from your email to join (it is valid for 14 days), or ask an administrator to invite you again.",
} as const;

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "user";

/**
 * Spec 14.1: provisioning on first sign-in, domain and IP rules, the bootstrap Factory Admin, the session, and the sign-in event.
 * A refusal is recorded (signins row and an `auth.signin` event with outcome denied) and committed; it is not rolled back.
 */
export async function signIn(g: Gantry, claims: IdClaims, r: SignInRequest): Promise<SignInResult> {
  return withTx(g.pool, async (tx) => {
    const orgId = g.orgId;
    const sec = (await readSecurity(tx, orgId)).value;
    const email = claims.email;
    let person: { id: string; status: string; idp_subject: string | null; email: string } | null = null;

    const record = async (outcome: "ok" | "denied", reason: string | null, personId: string | null, sessionId: string | null, type = "auth.signin", extra: Record<string, unknown> = {}): Promise<void> => {
      await tx.query(`insert into signins (org_id, person_id, method, outcome, reason, source_ip, user_agent) values ($1,$2,$3,$4,$5,$6::inet,$7)`, [orgId, personId, r.method, outcome, reason, r.ip || null, r.userAgent.slice(0, 300)]);
      await appendEvent(tx, {
        orgId, type, category: "auth", actor: personId ?? "anonymous", channel: "web", subject: personId ? { type: "person", id: personId } : { type: "identity", id: claims.sub },
        outcome, rule: reason ? `SIGNIN-${reason.toUpperCase()}` : null, after: { method: r.method, ...(email ? { email } : {}), ...extra }, sessionId, sourceIp: r.ip || null, requestId: r.requestId,
      });
    };
    const deny = async (reason: keyof typeof DENY, personId: string | null): Promise<SignInResult> => {
      await record("denied", reason, personId, null);
      return { ok: false, reason, msg: DENY[reason], personId };
    };

    if (!email) return deny("no_email", null);
    // Only a provider-verified address links or provisions a person: an IdP that omits email_verified must not claim an invitee by address.
    if (claims.emailVerified !== true) return deny("email_unverified", null);
    if (!emailDomainAllowed(email, sec.domains)) return deny("domain_not_allowed", null);

    const find = async (sql: string, p: unknown[]) => (await tx.query(sql, p)).rows[0] as typeof person | undefined;
    const cols = `id, status, idp_subject, email`;
    person = (await find(`select ${cols} from people where org_id = $1 and idp_subject = $2`, [orgId, claims.sub])) ?? null;
    if (!person && claims.gantryId) {
      const byId = await find(`select ${cols} from people where org_id = $1 and id = $2`, [orgId, claims.gantryId]);
      if (byId && byId.email.toLowerCase() === email) person = byId;
    }
    let inviteId: string | null = null;
    if (!person) {
      const byEmail = (await find(`select ${cols} from people where org_id = $1 and lower(email) = $2`, [orgId, email])) ?? null;
      // A person nobody has linked yet (no provider subject) is never claimed by address alone: the address does not prove the caller
      // is that person (an account at the provider could hold it). An invitee needs the invite's single-use token; anyone else
      // unlinked (accepted without signing in, seeded, imported) is linked only by an identity the provider asserts by Gantry id.
      if (byEmail && !byEmail.idp_subject && (byEmail.status === "invited" || byEmail.status === "active")) {
        const hash = r.inviteToken ? createHash("sha256").update(r.inviteToken).digest("hex") : null;
        const inv = hash ? (await tx.query<{ id: string }>(`select id from invites where org_id = $1 and lower(email) = $2 and token_hash = $3 and status = 'pending' and expires_at > now() for update`, [orgId, email, hash])).rows[0] : undefined;
        if (!inv) return deny("invite_required", byEmail.id);
        inviteId = inv.id;
      }
      person = byEmail;
    }

    if (!ipAllowed(r.ip, sec.ipAllow)) return deny("ip_not_allowed", person?.id ?? null);

    let provisioned = false;
    if (person && person.idp_subject && person.idp_subject !== claims.sub) return deny("identity_mismatch", person.id);
    // A step-up never switches the held session to another person, and a refusal must leave nothing behind: decide before any write below.
    if (r.stepUpOnly && r.existingSession && (!person || r.existingSession.personId !== person.id)) return deny("different_person", person?.id ?? null);
    // Factory Admins need a second factor, decided here by the server from the provider's token (acr/amr), not by the provider's flow alone.
    // Includes the person the bootstrap rule below is about to make Factory Admin. A step-up keeps the factor the session already has.
    const secondFactor = hasSecondFactor(claims, g.config.oidc.mfaAcrValues);
    if (!g.config.adminMfaOptional && !secondFactor && !(person && (person.status === "deactivated" || person.status === "suspended"))) {
      const bootstrap = !!g.config.bootstrapAdminEmail && email === g.config.bootstrapAdminEmail.toLowerCase() && claims.emailVerified === true;
      const admin = person ? await holdsFactoryAdmin(tx, orgId, person.id) : false;
      const willBootstrap = !admin && bootstrap && !(await tx.query(`select 1 from role_assignments where org_id = $1 and role_id = 'factory_admin' and scope_type = 'factory' and revoked_at is null limit 1`, [orgId])).rowCount;
      if (admin || willBootstrap) return deny("mfa_required", person?.id ?? null);
    }
    if (!person) {
      const id = await freePersonId(tx, orgId, claims.gantryId, claims.preferredUsername ?? email.split("@")[0]!);
      await tx.query(`insert into people (org_id, id, name, title, email, idp_subject, status, last_seen_at) values ($1,$2,$3,$4,$5,$6,'active', now())`, [orgId, id, claims.name ?? email.split("@")[0], claims.gantryTitle ?? "", email, claims.sub]);
      person = { id, status: "active", idp_subject: claims.sub, email };
      provisioned = true;
      await appendEvent(tx, {
        orgId, type: "people.provisioned", category: "access", actor: "system", channel: "system", subject: { type: "person", id }, after: { email, source: "first sign-in" }, sourceIp: r.ip || null, requestId: r.requestId,
      });
    }
    if (person.status === "deactivated" || person.status === "suspended") return deny("account_inactive", person.id);

    await tx.query(`update people set idp_subject = coalesce(idp_subject, $3), status = case when status = 'invited' then 'active' else status end, last_seen_at = now(), updated_at = now() where org_id = $1 and id = $2`, [orgId, person.id, claims.sub]);
    if (inviteId) await tx.query(`update invites set status = 'accepted', accepted_at = now(), updated_at = now() where org_id = $1 and id = $2`, [orgId, inviteId]);

    // Bootstrap Factory Admin: the configured email, signing in to an org that has no Factory Admin yet.
    // Only a provider-verified address counts: an IdP that omits email_verified must not hand out the factory.
    if (g.config.bootstrapAdminEmail && email === g.config.bootstrapAdminEmail.toLowerCase() && claims.emailVerified === true) {
      const has = await tx.query(`select 1 from role_assignments where org_id = $1 and role_id = 'factory_admin' and scope_type = 'factory' and revoked_at is null limit 1`, [orgId]);
      if (!has.rowCount) {
        await tx.query(`insert into role_assignments (org_id, id, person_id, role_id, scope_type, granted_by) values ($1,$2,$3,'factory_admin','factory','system')`, [orgId, `ra-boot-${person.id}`, person.id]);
        await appendEvent(tx, {
          orgId, type: "people.role_granted", category: "access", actor: "system", channel: "system", subject: { type: "person", id: person.id }, after: { role: "factory_admin", scope: "factory", reason: "bootstrap admin" }, sourceIp: r.ip || null, requestId: r.requestId,
        });
      }
    }

    const authTime = claims.authTime ? new Date(claims.authTime * 1000) : new Date();
    const ex = r.existingSession;
    if (ex && ex.personId === person.id) {
      await refreshAuthTime(tx, orgId, ex.id, authTime, secondFactor);
      await record("ok", null, person.id, ex.id, "auth.stepup", { authTime: authTime.toISOString() });
      return { ok: true, personId: person.id, sessionId: ex.id, token: null, expiresAt: null, stepUp: true, provisioned };
    }
    const s = await createSession(tx, g.config.secrets.sessionKey, {
      orgId, personId: person.id, method: r.method, ip: r.ip || null, userAgent: r.userAgent, absoluteHours: sec.sessionHours, authTime, idpSid: claims.sid ?? null, acr: claims.acr ?? null, secondFactor,
    });
    await record("ok", null, person.id, s.id, "auth.signin", { authTime: authTime.toISOString() });
    return { ok: true, personId: person.id, sessionId: s.id, token: s.token, expiresAt: s.expiresAt, stepUp: false, provisioned };
  });
}

async function freePersonId(tx: Tx, orgId: string, claimed: string | undefined, hint: string): Promise<string> {
  const base = claimed && /^[A-Za-z0-9_-]{1,64}$/.test(claimed) ? claimed : `p-${slug(hint)}`;
  for (let i = 0; ; i++) {
    const id = i === 0 ? base : `${base}-${i + 1}`;
    const { rowCount } = await tx.query(`select 1 from people where org_id = $1 and id = $2`, [orgId, id]);
    if (!rowCount) return id;
  }
}

/**
 * Failed sign-ins with no identity are reachable by anyone on the internet, and the ledger is append-only, so they are sampled:
 * per reason and source address 5 rows a minute, 30 per reason overall; the rest are counted and the next row carries the count.
 * The HTTP answer never changes. Sign-in failures that carry a person (see `signIn`) are not anonymous and are always recorded.
 */
export const anonymousSigninFailures = new DenialSampler(5, 30);

/** A sign-in that never got as far as an identity (bad state, IdP error). Recorded (sampled) so the history shows it. */
export async function recordSignInFailure(g: Gantry, r: Pick<SignInRequest, "ip" | "userAgent" | "requestId" | "method">, reason: string): Promise<void> {
  const sample = anonymousSigninFailures.sample(`signin:${reason}`, r.ip || "unknown");
  if (!sample.audit) return;
  await withTx(g.pool, async (tx) => {
    await tx.query(`insert into signins (org_id, person_id, method, outcome, reason, source_ip, user_agent) values ($1,null,$2,'failed',$3,$4::inet,$5)`, [g.orgId, r.method, reason, r.ip || null, r.userAgent.slice(0, 300)]);
    if (reason === "state_missing") return; // a missing state cookie names no identity and gets no ledger event
    await appendEvent(tx, { orgId: g.orgId, type: "auth.signin_failed", category: "auth", actor: "anonymous", channel: "web", outcome: "failed", rule: `SIGNIN-${reason.toUpperCase()}`, after: { method: r.method, reason, ...(sample.suppressed ? { suppressedSinceLastRow: sample.suppressed } : {}) }, sourceIp: r.ip || null, requestId: r.requestId });
  });
}
