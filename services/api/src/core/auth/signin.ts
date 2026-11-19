import { createHash } from "node:crypto";
import { appendEvent, withTx, type Tx } from "@gantry/db";
import { DenialSampler } from "../denial-sampler.js";
import type { Gantry } from "../context.js";
import type { IdClaims } from "../oidc.js";
import { readSecurity } from "../read/index.js";
import { emailDomainAllowed, ipAllowed } from "../security.js";
import { hasSecondFactor } from "../oidc.js";
import { BOOTSTRAP_EMAIL_DOMAIN } from "./bootstrap-admin.js";
import { holdsFactoryAdmin, MFA_REQUIRED_MSG } from "./mfa.js";
import { createSession, refreshAuthTime } from "./sessions.js";
import { recordMfaChangedOutside } from "./mfa-alert.js";
import { bindRecoveryWindow, consumeRecoveryWindow } from "./ip-recovery.js";

export interface SignInRequest {
  ip: string;
  userAgent: string;
  requestId: string;
  method: "sso" | "github";
  /** Session the browser already holds when this sign-in is a step-up. */
  existingSession?: { id: string; personId: string } | null;
  /** A step-up must refresh the held session and must never switch it to another person. */
  stepUpOnly?: boolean;
  /** When the authorize request was made (ms): the provider's auth_time must not be older than this (S-129, G-M4), or a silent provider session signs someone in. */
  authorizedAt?: number;
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
  stale_auth: "That sign-in was not fresh (it reused an older session at the identity provider), so it was cancelled. Sign in again and complete both steps.",
  invite_required: "This account has not been linked to your sign-in yet. Open the invite link from your email to join (it is valid for 14 days), or ask an administrator to invite you again.",
} as const;

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "user";

/**
 * Spec 14.1: provisioning on first sign-in, domain and IP rules, the bootstrap Factory Admin, the session, and the sign-in event.
 * A refusal is recorded (signins row and an `auth.signin` event with outcome denied) and committed; it is not rolled back.
 */
export async function signIn(g: Gantry, claims: IdClaims, r: SignInRequest): Promise<SignInResult> {
  // The second factors the person holds at the provider (their ids), read before the transaction so a slow provider never holds it open. Best effort:
  // the token's acr/amr decides the sign-in; this only feeds the per-person status and the "reset behind our back" audit (S-124, S-127).
  const secondFactor = hasSecondFactor(claims, g.config.oidc.mfaAcrValues);
  const idpFactors = secondFactor && g.idpAdmin ? await Promise.race([g.idpAdmin.secondFactors(claims.sub), new Promise<null>((res) => setTimeout(() => res(null), 3000).unref())]).catch(() => null) : null;
  return withTx(g.pool, async (tx) => {
    const orgId = g.orgId;
    const sec = (await readSecurity(tx, orgId)).value;
    // The bootstrap admin (GANTRY_BOOTSTRAP_ADMIN_USERNAME) is the identity-provider user Gantry itself created: matched by the provider's
    // subject recorded at creation, never by a name or an address. It has no email at the provider, so it gets a placeholder that no mailbox can use.
    const bootSub = g.config.bootstrapAdminUsername
      ? (((await tx.query(`select settings->'bootstrapAdmin' as b from orgs where id = $1`, [orgId])).rows[0]?.b ?? null) as { username?: string; sub?: string } | null)
      : null;
    const bootUser = !!bootSub?.sub && bootSub.username === g.config.bootstrapAdminUsername && bootSub.sub === claims.sub && claims.preferredUsername?.toLowerCase() === bootSub.username;
    const email = claims.email ?? (bootUser ? `${bootSub!.username}@${BOOTSTRAP_EMAIL_DOMAIN}` : undefined);
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
    if (claims.emailVerified !== true && !bootUser) return deny("email_unverified", null);
    // The placeholder domain is reserved for the bootstrap admin; no one else may sign in claiming an address there.
    if (!bootUser && email.endsWith(`@${BOOTSTRAP_EMAIL_DOMAIN}`)) return deny("domain_not_allowed", null);
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
      const byEmail = bootUser ? null : (await find(`select ${cols} from people where org_id = $1 and lower(email) = $2`, [orgId, email])) ?? null;
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

    // Outside the allow-list: only the named admin's open, unexpired recovery window (opened on the server host by the operator) lets this one sign-in
    // through. It is consumed below, after every other refusal, so a sign-in that is refused for another reason does not burn it.
    let recoveryCandidate = false;
    if (!ipAllowed(r.ip, sec.ipAllow)) {
      const open = person ? (await tx.query(`select 1 from allowlist_recovery where org_id = $1 and person_id = $2 and status = 'open' and expires_at > now() limit 1`, [orgId, person.id])).rowCount : 0;
      if (!person || !open || !(await holdsFactoryAdmin(tx, orgId, person.id))) return deny("ip_not_allowed", person?.id ?? null);
      recoveryCandidate = true;
    }

    let provisioned = false;
    if (person && person.idp_subject && person.idp_subject !== claims.sub) return deny("identity_mismatch", person.id);
    // A step-up never switches the held session to another person, and a refusal must leave nothing behind: decide before any write below.
    if (r.stepUpOnly && r.existingSession && (!person || r.existingSession.personId !== person.id)) return deny("different_person", person?.id ?? null);
    // Everyone needs a second factor (S-121), decided here by the server from the provider's token (acr/amr), not by the provider's flow alone.
    // A step-up keeps asking for it: the same check refuses a step-up whose token lost the factor, and the session is left as it was.
    // Only the dev waiver (GANTRY_DEV_ADMIN_MFA_OPTIONAL, never the default, refused off localhost) lets a password-only sign-in through.
    if (!g.config.adminMfaOptional && !secondFactor && !(person && (person.status === "deactivated" || person.status === "suspended"))) return deny("mfa_required", person?.id ?? null);
    // EVERY sign-in must be fresh (S-129, G-M4): the provider is asked for prompt=login, but a request with it stripped returns the provider's own old session
    // (acr 2, old auth_time) with no credentials. So auth_time must exist and be no older than the authorize request (a few seconds of clock slack), and a
    // step-up must also be inside the step-up window.
    {
      const floor = r.authorizedAt ? r.authorizedAt / 1000 - 5 : Date.now() / 1000 - 120;
      const window = (sec.stepUpWindowMinutes ?? 15) * 60;
      if (!g.config.adminMfaOptional || r.stepUpOnly) { // the dev waiver only skips this for a plain sign-in
        if (!claims.authTime || claims.authTime < floor || (r.stepUpOnly && Date.now() / 1000 - claims.authTime > window)) return deny("stale_auth", person?.id ?? null);
      }
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
    // Or, preferred, the username bootstrap above (bootUser); the email rule is deprecated but still honoured.
    if (bootUser || (g.config.bootstrapAdminEmail && email === g.config.bootstrapAdminEmail.toLowerCase() && claims.emailVerified === true)) {
      const has = await tx.query(`select 1 from role_assignments where org_id = $1 and role_id = 'factory_admin' and scope_type = 'factory' and revoked_at is null limit 1`, [orgId]);
      if (!has.rowCount) {
        await tx.query(`insert into role_assignments (org_id, id, person_id, role_id, scope_type, granted_by) values ($1,$2,$3,'factory_admin','factory','system')`, [orgId, `ra-boot-${person.id}`, person.id]);
        // The first admin joins the team created with the organisation, so a fresh install's only person is not team-less.
        // Only at the grant: a later sign-in never re-adds an admin who has left the team.
        await tx.query(`insert into team_members (org_id, team_id, person_id) select $1, id, $2 from teams where org_id = $1 and id = 'default' on conflict do nothing`, [orgId, person.id]);
        await appendEvent(tx, {
          orgId, type: "people.role_granted", category: "access", actor: "system", channel: "system", subject: { type: "person", id: person.id }, after: { role: "factory_admin", scope: "factory", reason: bootUser ? "bootstrap admin (username)" : "bootstrap admin" }, sourceIp: r.ip || null, requestId: r.requestId,
        });
      }
    }

    let recoveryWindow: string | null = null;
    if (recoveryCandidate) {
      recoveryWindow = await consumeRecoveryWindow(tx, orgId, person.id, r.ip);
      if (!recoveryWindow) return deny("ip_not_allowed", person.id);
    }
    // A token that does not say when the person signed in gives a session with an unknown sign-in time, which satisfies no step-up (S-129).
    const authTime = claims.authTime ? new Date(claims.authTime * 1000) : null;
    if (secondFactor) await recordMfa(tx, orgId, person.id, idpFactors, r, bootUser);
    const ex = r.existingSession;
    if (ex && ex.personId === person.id) {
      await refreshAuthTime(tx, orgId, ex.id, authTime!, secondFactor); // a step-up always has an auth_time (checked above)
      if (recoveryWindow) await bindRecoveryWindow(tx, orgId, recoveryWindow, person.id, ex.id, r.ip, r.requestId);
      await record("ok", null, person.id, ex.id, "auth.stepup", { authTime: authTime!.toISOString() });
      return { ok: true, personId: person.id, sessionId: ex.id, token: null, expiresAt: null, stepUp: true, provisioned };
    }
    const s = await createSession(tx, g.config.secrets.sessionKey, {
      orgId, personId: person.id, method: r.method, ip: r.ip || null, userAgent: r.userAgent, absoluteHours: sec.sessionHours, authTime, idpSid: claims.sid ?? null, acr: claims.acr ?? null, secondFactor,
    });
    if (recoveryWindow) await bindRecoveryWindow(tx, orgId, recoveryWindow, person.id, s.id, r.ip, r.requestId);
    await record("ok", null, person.id, s.id, "auth.signin", authTime ? { authTime: authTime.toISOString() } : { authTime: null });
    return { ok: true, personId: person.id, sessionId: s.id, token: s.token, expiresAt: s.expiresAt, stepUp: false, provisioned };
  });
}

/** A hash of the person's second factors at the provider: type, id AND creation time, so a factor deleted and re-planted with a reused id still differs (G-M2). */
export const fingerprintOf = (factors: Array<{ id: string; type: string; createdDate?: number }>): string =>
  createHash("sha256").update(factors.map((f) => `${f.type}:${f.id}:${f.createdDate ?? 0}`).sort().join("\n")).digest("hex");

/**
 * Records that the person signed in with a second factor (the per-person status the People list and the Security page show, S-127) and, when the
 * provider told us which factors they hold, audits two things that are NOT refusals (G-M2): their authenticators differ from the last sighting (changed at the
 * provider outside Gantry, e.g. a console reset or a planted credential), and a factor seen for the first time with no baseline and no enrolment link Gantry
 * sent (a plant before the first sign-in). Both write `auth.mfa_changed_outside` and email the Factory Admins. A Gantry reset clears the baseline and notes the link.
 */
async function recordMfa(tx: Tx, orgId: string, personId: string, factors: Array<{ id: string; type: string; createdDate?: number }> | null, r: SignInRequest, bootstrap: boolean): Promise<void> {
  if (!factors) {
    await tx.query(`update people set mfa = true, mfa_checked_at = now() where org_id = $1 and id = $2`, [orgId, personId]);
    return;
  }
  const fp = fingerprintOf(factors);
  const types = [...new Set(factors.map((f) => f.type))].sort();
  const prev = (await tx.query<{ mfa_fingerprint: string | null; mfa_types: string[]; mfa_link_at: Date | null }>(`select mfa_fingerprint, mfa_types, mfa_link_at from people where org_id = $1 and id = $2 for update`, [orgId, personId])).rows[0];
  await tx.query(`update people set mfa = true, mfa_checked_at = now(), mfa_fingerprint = $3, mfa_types = $4 where org_id = $1 and id = $2`, [orgId, personId, fp, types]);
  if (prev?.mfa_fingerprint && prev.mfa_fingerprint !== fp) {
    await recordMfaChangedOutside(tx, orgId, personId, { why: "credentials_changed", detail: { before: prev.mfa_types, types }, requestId: r.requestId, sourceIp: r.ip || null });
  } else if (!prev?.mfa_fingerprint && !prev?.mfa_link_at && !bootstrap) {
    await recordMfaChangedOutside(tx, orgId, personId, { why: "first_seen_without_enrolment", detail: { types }, requestId: r.requestId, sourceIp: r.ip || null });
  }
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
