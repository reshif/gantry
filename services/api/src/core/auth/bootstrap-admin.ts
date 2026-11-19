import { readSecretOptional } from "@gantry/db";
import type pg from "pg";
import { ENROLMENT_ACTIONS, ENROLMENT_LINK_SECONDS, wireIdpAdmin, type IdpAdmin, type KeycloakAdminApi } from "./idp-admin.js";

export type { KeycloakAdminApi } from "./idp-admin.js";

/**
 * The first Factory Admin from a username and an initial password the owner sets (owner decision, 2026-11-18).
 *
 * At startup, while the organisation has no Factory Admin and GANTRY_BOOTSTRAP_ADMIN_USERNAME is set, the API asks the identity provider
 * (Keycloak admin REST API, as the scoped `gantry-admin` service account: never the master admin) for a user with that username. If there
 * is none, it creates one with the password from the `bootstrap_admin_password` secret file, marked temporary, with the required actions
 * UPDATE_PASSWORD and CONFIGURE_TOTP (and recovery codes).
 *
 * The provider refuses a sign-in that has no second factor and offers no self-service enrolment (S-122), so the first enrolment is the
 * one-time link the provider emails to GANTRY_BOOTSTRAP_ADMIN_EMAIL (valid one hour). Restart the API to get a fresh link while no Factory Admin
 * exists; nothing here runs once one does. Without that address no link can be sent and the log says so.
 * The provider's user id (the OIDC `sub`) is recorded on the organisation; the first Gantry sign-in by that `sub` is made Factory Admin
 * (core/auth/signin.ts). The password is never logged or stored by Gantry.
 */

export interface BootstrapLog { info(o: object, m?: string): void; warn(o: object, m?: string): void }

export type BootstrapAdminOutcome = "disabled" | "has_admin" | "refused" | "unavailable" | "created" | "already_provisioned" | "exists_not_ours" | "failed";

export const BOOTSTRAP_MIN_PASSWORD = 12;
export const BOOTSTRAP_REQUIRED_ACTIONS = ENROLMENT_ACTIONS;
export const BOOTSTRAP_EMAIL_DOMAIN = "bootstrap.invalid";
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,63}$/;
/** Compared after lower-casing and dropping everything but letters and digits. */
const KNOWN_DEFAULTS = new Set(["gantrydev", "gantry", "admin", "administrator", "password", "passw0rd", "changeme", "letmein", "secret", "qwerty", "welcome", "123456789012", "adminadminadmin", "passwordpassword", "password1234", "administrator123"]);

/** Why this initial password is refused, or null when it is acceptable. The reason never contains the password. */
export function weakPasswordReason(pw: string | null, username: string): string | null {
  if (pw === null) return "the secret file bootstrap_admin_password is missing or empty";
  if (pw.length < BOOTSTRAP_MIN_PASSWORD) return `the password is shorter than ${BOOTSTRAP_MIN_PASSWORD} characters`;
  const n = pw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (KNOWN_DEFAULTS.has(n)) return "the password is a well-known default";
  if (n === username.replace(/[^a-z0-9]/g, "")) return "the password equals the username";
  if (/^(.)\1+$/.test(pw)) return "the password is one repeated character";
  return null;
}

export async function hasFactoryAdmin(db: Pick<pg.Pool, "query">, orgId: string): Promise<boolean> {
  const r = await db.query(`select 1 from role_assignments where org_id = $1 and role_id = 'factory_admin' and scope_type = 'factory' and revoked_at is null limit 1`, [orgId]);
  return (r.rowCount ?? 0) > 0;
}

export interface EnsureBootstrapAdminOptions {
  pool: Pick<pg.Pool, "query">;
  orgId: string;
  username: string | null | undefined;
  /** The initial password, or null when the secret is missing or empty. Read only after we know it is needed. */
  readPassword: () => Promise<string | null>;
  /** The Keycloak admin client (the scoped service account), or null when its secret is not available. */
  keycloak: () => Promise<(KeycloakAdminApi & Partial<Pick<IdpAdmin, "sendEnrolmentLink" | "secondFactors">>) | null>;
  /** Where the one-time enrolment link goes (GANTRY_BOOTSTRAP_ADMIN_EMAIL). */
  email?: string | null;
  log: BootstrapLog;
}

/** One attempt. Never throws; a transient failure returns "failed" so the caller may retry. */
export async function ensureBootstrapAdmin(o: EnsureBootstrapAdminOptions): Promise<BootstrapAdminOutcome> {
  const username = o.username?.trim().toLowerCase();
  if (!username) return "disabled";
  try {
    if (await hasFactoryAdmin(o.pool, o.orgId)) return "has_admin";
    if (!USERNAME.test(username)) {
      o.log.warn({ username }, "bootstrap admin not created: GANTRY_BOOTSTRAP_ADMIN_USERNAME must be 2-64 characters of a-z, 0-9, dot, dash or underscore");
      return "refused";
    }
    const settings = ((await o.pool.query(`select settings->'bootstrapAdmin' as b from orgs where id = $1`, [o.orgId])).rows[0]?.b ?? null) as { username?: string; sub?: string } | null;
    const password = await o.readPassword().catch(() => null);
    const bad = weakPasswordReason(password, username);
    // Already created by us: the secret is no longer needed and is never compared, rotated or re-applied. While no Factory Admin exists the person
    // may not have enrolled yet (the link expires after an hour): a restart sends a fresh link, but only to someone with no second factor.
    if (settings?.sub && settings.username === username) {
      const again = o.email ? await o.keycloak().catch(() => null) : null;
      if (again?.sendEnrolmentLink && again.secondFactors && !(await again.secondFactors(settings.sub)).length) {
        await again.sendEnrolmentLink(settings.sub, { lifespanSec: ENROLMENT_LINK_SECONDS });
        o.log.info({ username }, "bootstrap admin has not enrolled yet: a fresh one-time enrolment link was emailed");
      }
      return "already_provisioned";
    }
    if (bad) {
      o.log.warn({ username, reason: bad }, "bootstrap admin not created: refused the initial password. Set a strong one in deploy/secrets/bootstrap_admin_password (at least 12 characters, not a default) and restart gantry-api");
      return "refused";
    }
    const kc = await o.keycloak();
    if (!kc) {
      o.log.warn({ username }, "bootstrap admin not created: the API has no identity-provider service-account secret (idp_admin_client_secret)");
      return "unavailable";
    }
    if (await kc.findUserId(username)) {
      o.log.warn({ username }, "bootstrap admin not created: a user with this username already exists at the identity provider and was not created by Gantry, so it is not adopted. Choose another username, or delete that user");
      return "exists_not_ours";
    }
    const sub = await kc.createUser({ username, password: password!, requiredActions: BOOTSTRAP_REQUIRED_ACTIONS, ...(o.email ? { email: o.email, emailVerified: false } : {}) });
    await o.pool.query(`update orgs set settings = settings || jsonb_build_object('bootstrapAdmin', jsonb_build_object('username', $2::text, 'sub', $3::text)) where id = $1`, [o.orgId, username, sub]);
    if (o.email && kc.sendEnrolmentLink) {
      await kc.sendEnrolmentLink(sub, { lifespanSec: ENROLMENT_LINK_SECONDS });
      o.log.info({ username, sub }, "bootstrap admin created at the identity provider; a one-time link to set a password and enrol an authenticator was emailed to GANTRY_BOOTSTRAP_ADMIN_EMAIL (valid one hour; restart the API for a new one)");
    } else {
      o.log.warn({ username, sub }, "bootstrap admin created at the identity provider but NO enrolment link could be sent: the provider refuses a sign-in without a second factor. Set GANTRY_BOOTSTRAP_ADMIN_EMAIL to an address you read and restart the API");
    }
    return "created";
  } catch (e) {
    // Only the message of our own errors; an HTTP error carries a status, never the request body.
    o.log.warn({ username, error: e instanceof Error ? e.message : "unknown error" }, "bootstrap admin: identity provider unavailable, will retry");
    return "failed";
  }
}

/** Runs ensureBootstrapAdmin in the background, retrying while the identity provider is still starting. */
export function startBootstrapAdmin(o: EnsureBootstrapAdminOptions, retry: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<BootstrapAdminOutcome> {
  const attempts = retry.attempts ?? 20;
  const delay = retry.delayMs ?? 15_000;
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
  return (async () => {
    let out: BootstrapAdminOutcome = "failed";
    for (let i = 0; i < attempts; i++) {
      out = await ensureBootstrapAdmin(o);
      if (out !== "failed") return out;
      await sleep(delay);
    }
    return out;
  })();
}

/** Production wiring: the secrets come from files (never env); the admin client exists only when the API was given the service-account secret. */
export function wireBootstrapAdmin(o: { pool: pg.Pool; orgId: string; config: { bootstrapAdminUsername?: string | null; bootstrapAdminEmail?: string | null; oidc: { issuer: string; internalUrl: string | null } }; log: BootstrapLog; env?: NodeJS.ProcessEnv; idp?: IdpAdmin | null }): Promise<BootstrapAdminOutcome> {
  const env = o.env ?? process.env;
  return startBootstrapAdmin({
    pool: o.pool, orgId: o.orgId, username: o.config.bootstrapAdminUsername, log: o.log, email: o.config.bootstrapAdminEmail ?? null,
    readPassword: () => readSecretOptional("bootstrap_admin_password", env),
    keycloak: async () => o.idp ?? (await wireIdpAdmin({ config: o.config, env })),
  });
}
