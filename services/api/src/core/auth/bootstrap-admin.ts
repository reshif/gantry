import { readSecretOptional } from "@gantry/db";
import type pg from "pg";

/**
 * The first Factory Admin from a username and an initial password the owner sets (owner decision, 2026-11-18).
 *
 * At startup, while the organisation has no Factory Admin and GANTRY_BOOTSTRAP_ADMIN_USERNAME is set, the API asks the identity provider
 * (Keycloak admin REST API) for a user with that username. If there is none, it creates one with the password from the
 * `bootstrap_admin_password` secret file, marked temporary, with the required actions UPDATE_PASSWORD and CONFIGURE_TOTP and no email.
 * The provider's user id (the OIDC `sub`) is recorded on the organisation; the first Gantry sign-in by that `sub` is made Factory Admin
 * (core/auth/signin.ts). Nothing here ever runs once a Factory Admin exists, and the password is never logged or stored by Gantry.
 */

export interface KeycloakAdminApi {
  /** The id of the realm user with this exact username, or null. */
  findUserId(username: string): Promise<string | null>;
  /** Creates the user; returns its id. A concurrent creation (HTTP 409) resolves to the existing id. */
  createUser(u: { username: string; password: string; temporary: true; requiredActions: string[] }): Promise<string>;
}

export interface BootstrapLog { info(o: object, m?: string): void; warn(o: object, m?: string): void }

export type BootstrapAdminOutcome = "disabled" | "has_admin" | "refused" | "unavailable" | "created" | "already_provisioned" | "exists_not_ours" | "failed";

export const BOOTSTRAP_MIN_PASSWORD = 12;
export const BOOTSTRAP_REQUIRED_ACTIONS = ["UPDATE_PASSWORD", "CONFIGURE_TOTP"];
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
  /** A Keycloak admin client, or null when no admin credentials are available. */
  keycloak: () => Promise<KeycloakAdminApi | null>;
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
    // Already created by us: the secret is no longer needed and is never compared, rotated or re-applied.
    if (settings?.sub && settings.username === username) return "already_provisioned";
    if (bad) {
      o.log.warn({ username, reason: bad }, "bootstrap admin not created: refused the initial password. Set a strong one in deploy/secrets/bootstrap_admin_password (at least 12 characters, not a default) and restart gantry-api");
      return "refused";
    }
    const kc = await o.keycloak();
    if (!kc) {
      o.log.warn({ username }, "bootstrap admin not created: no Keycloak admin credentials (secret keycloak_admin_password) are available to the API");
      return "unavailable";
    }
    if (await kc.findUserId(username)) {
      o.log.warn({ username }, "bootstrap admin not created: a user with this username already exists at the identity provider and was not created by Gantry, so it is not adopted. Choose another username, or delete that user");
      return "exists_not_ours";
    }
    const sub = await kc.createUser({ username, password: password!, temporary: true, requiredActions: BOOTSTRAP_REQUIRED_ACTIONS });
    await o.pool.query(`update orgs set settings = settings || jsonb_build_object('bootstrapAdmin', jsonb_build_object('username', $2::text, 'sub', $3::text)) where id = $1`, [o.orgId, username, sub]);
    o.log.info({ username, sub }, "bootstrap admin created at the identity provider with a temporary password; the first sign-in must change it and set up an authenticator app");
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

/** Keycloak admin REST API over fetch, authenticated as the master-realm admin (admin-cli, password grant). */
export function keycloakAdminClient(o: { baseUrl: string; realm: string; adminUser: string; adminPassword: string; fetchImpl?: typeof fetch }): KeycloakAdminApi {
  const f = o.fetchImpl ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, "");
  const token = async (): Promise<string> => {
    const res = await f(`${base}/realms/master/protocol/openid-connect/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: o.adminUser, password: o.adminPassword }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`keycloak admin token request failed (HTTP ${res.status})`);
    const j = (await res.json()) as { access_token?: string };
    if (!j.access_token) throw new Error("keycloak admin token response had no access_token");
    return j.access_token;
  };
  const users = `${base}/admin/realms/${encodeURIComponent(o.realm)}/users`;
  const find = async (t: string, username: string): Promise<string | null> => {
    const res = await f(`${users}?${new URLSearchParams({ username, exact: "true" })}`, { headers: { authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`keycloak user lookup failed (HTTP ${res.status})`);
    const list = (await res.json()) as Array<{ id: string; username: string }>;
    return list.find((u) => u.username.toLowerCase() === username)?.id ?? null;
  };
  return {
    async findUserId(username) { return find(await token(), username); },
    async createUser(u) {
      const t = await token();
      const res = await f(users, {
        method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
        // No email on purpose: the username is the identity, and no address can be mistaken for GANTRY_BOOTSTRAP_ADMIN_EMAIL.
        body: JSON.stringify({ username: u.username, enabled: true, emailVerified: false, requiredActions: u.requiredActions, credentials: [{ type: "password", value: u.password, temporary: u.temporary }] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 409) {
        const id = await find(t, u.username);
        if (id) return id;
      }
      if (res.status !== 201) throw new Error(`keycloak user creation failed (HTTP ${res.status})`);
      const loc = res.headers.get("location");
      const id = loc?.split("/").pop() ?? (await find(t, u.username));
      if (!id) throw new Error("keycloak did not return the new user's id");
      return id;
    },
  };
}

/** The Keycloak admin base URL and realm from the OIDC issuer (`https://host/idp/realms/gantry`); the internal URL is preferred. */
export function keycloakFromIssuer(url: string): { baseUrl: string; realm: string } | null {
  const m = /^(.*)\/realms\/([^/]+)\/?$/.exec(url);
  return m ? { baseUrl: m[1]!, realm: decodeURIComponent(m[2]!) } : null;
}

/** Production wiring: the secrets come from files (never env), and the admin client exists only when the API was given the Keycloak admin password. */
export function wireBootstrapAdmin(o: { pool: pg.Pool; orgId: string; config: { bootstrapAdminUsername?: string | null; oidc: { issuer: string; internalUrl: string | null } }; log: BootstrapLog; env?: NodeJS.ProcessEnv }): Promise<BootstrapAdminOutcome> {
  const env = o.env ?? process.env;
  return startBootstrapAdmin({
    pool: o.pool, orgId: o.orgId, username: o.config.bootstrapAdminUsername, log: o.log,
    readPassword: () => readSecretOptional("bootstrap_admin_password", env),
    keycloak: async () => {
      const at = keycloakFromIssuer(o.config.oidc.internalUrl ?? o.config.oidc.issuer);
      const pw = await readSecretOptional("keycloak_admin_password", env).catch(() => null);
      return at && pw ? keycloakAdminClient({ ...at, adminUser: env.KEYCLOAK_ADMIN_USERNAME || "admin", adminPassword: pw }) : null;
    },
  });
}
