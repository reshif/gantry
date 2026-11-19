import { readSecretOptional } from "@gantry/db";

/**
 * The identity provider's admin API as Gantry uses it at run time, through ONE scoped service account (the `gantry-admin` client of the
 * gantry realm, role manage-users in that realm and nothing else). The Keycloak master-admin password is never given to the API (S-125):
 * the service account cannot change the realm, its flows, its clients or any other realm, so code execution in the API cannot switch MFA off.
 *
 * What it is for: the one-time enrolment link (the only way a person gets a first authenticator, S-122), an authenticator reset (S-124),
 * reading which second factors a person holds (the per-person status and the "reset behind our back" check), and creating the bootstrap admin.
 */
export interface IdpCredential { id: string; type: string }
export interface IdpUser { id: string; username: string; email: string | null }

export interface KeycloakAdminApi {
  /** The id of the realm user with this exact username, or null. */
  findUserId(username: string): Promise<string | null>;
  /** Creates the user; returns its id. A concurrent creation (HTTP 409) resolves to the existing id. */
  createUser(u: IdpNewUser): Promise<string>;
}

export interface IdpNewUser {
  username: string;
  email?: string;
  emailVerified?: boolean;
  firstName?: string;
  lastName?: string;
  /** Gantry's person id, carried as the `gantry_id` claim. */
  gantryId?: string;
  /** An initial password; always temporary. Omit it for a person who sets their own through the enrolment link. */
  password?: string;
  requiredActions?: string[];
}

export interface IdpAdmin extends KeycloakAdminApi {
  findUser(q: { username?: string; email?: string }): Promise<IdpUser | null>;
  /** The second factors the person holds now (authenticator app, security key, recovery codes). The password is not one. */
  secondFactors(userId: string): Promise<IdpCredential[]>;
  /** Removes every second factor and ends the person's provider sessions; returns how many factors were removed. */
  resetSecondFactors(userId: string): Promise<number>;
  /** Emails the person a one-time link that sets a password and enrols a second factor. It expires after `lifespanSec`. */
  sendEnrolmentLink(userId: string, o?: { lifespanSec?: number; redirectUri?: string }): Promise<void>;
  /** Ends the person's sessions at the provider. */
  endSessions(userId: string): Promise<void>;
}

/** Credential types of the provider that count as a second factor. */
export const SECOND_FACTOR_TYPES = new Set(["otp", "webauthn", "webauthn-passwordless", "recovery-authn-codes"]);
/** What a link makes a person do: choose a password, enrol an authenticator app, save recovery codes (a security key can be added later with the first factor). */
export const ENROLMENT_ACTIONS = ["UPDATE_PASSWORD", "CONFIGURE_TOTP", "CONFIGURE_RECOVERY_AUTHN_CODES"];
/** The link is single-use and short-lived (the realm also caps admin-issued links at one hour). */
export const ENROLMENT_LINK_SECONDS = 3600;

export interface KeycloakAdminOptions {
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

/** Keycloak admin REST API over fetch, authenticated as the realm's `gantry-admin` service account (client_credentials). */
export function keycloakAdminClient(o: KeycloakAdminOptions): IdpAdmin {
  const f = o.fetchImpl ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, "");
  const realm = encodeURIComponent(o.realm);
  const admin = `${base}/admin/realms/${realm}`;
  let cached: { token: string; until: number } | null = null;
  const token = async (): Promise<string> => {
    if (cached && cached.until > Date.now() + 5_000) return cached.token;
    const res = await f(`${base}/realms/${realm}/protocol/openid-connect/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: o.clientId, client_secret: o.clientSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`identity provider service-account token request failed (HTTP ${res.status})`);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error("identity provider token response had no access_token");
    cached = { token: j.access_token, until: Date.now() + (j.expires_in ?? 60) * 1000 };
    return j.access_token;
  };
  const call = async (method: string, path: string, body?: unknown): Promise<Response> =>
    f(`${admin}${path}`, {
      method, headers: { authorization: `Bearer ${await token()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000),
    });
  const users = async (q: Record<string, string>): Promise<Array<{ id: string; username: string; email?: string }>> => {
    const res = await call("GET", `/users?${new URLSearchParams({ ...q, exact: "true" })}`);
    if (!res.ok) throw new Error(`identity provider user lookup failed (HTTP ${res.status})`);
    return (await res.json()) as Array<{ id: string; username: string; email?: string }>;
  };
  const findUser: IdpAdmin["findUser"] = async (q) => {
    const list = q.username ? await users({ username: q.username }) : q.email ? await users({ email: q.email }) : [];
    const u = list.find((x) => (q.username ? x.username.toLowerCase() === q.username.toLowerCase() : (x.email ?? "").toLowerCase() === q.email!.toLowerCase()));
    return u ? { id: u.id, username: u.username, email: u.email ?? null } : null;
  };
  const secondFactors: IdpAdmin["secondFactors"] = async (id) => {
    const res = await call("GET", `/users/${encodeURIComponent(id)}/credentials`);
    if (!res.ok) throw new Error(`identity provider credential lookup failed (HTTP ${res.status})`);
    return ((await res.json()) as Array<{ id: string; type: string }>).filter((c) => SECOND_FACTOR_TYPES.has(c.type)).map((c) => ({ id: c.id, type: c.type }));
  };
  const endSessions = async (id: string): Promise<void> => {
    const res = await call("POST", `/users/${encodeURIComponent(id)}/logout`);
    if (!res.ok) throw new Error(`identity provider could not end the person's sessions (HTTP ${res.status})`);
  };
  return {
    findUser,
    async findUserId(username) { return (await findUser({ username }))?.id ?? null; },
    async createUser(u) {
      const res = await call("POST", "/users", {
        username: u.username, enabled: true, emailVerified: u.emailVerified ?? false, requiredActions: u.requiredActions ?? [],
        ...(u.email ? { email: u.email } : {}), ...(u.firstName ? { firstName: u.firstName } : {}), ...(u.lastName ? { lastName: u.lastName } : {}),
        ...(u.gantryId ? { attributes: { gantry_id: [u.gantryId] } } : {}),
        ...(u.password ? { credentials: [{ type: "password", value: u.password, temporary: true }] } : {}),
      });
      if (res.status === 409) {
        const id = (await findUser({ username: u.username }))?.id;
        if (id) return id;
      }
      if (res.status !== 201) throw new Error(`identity provider user creation failed (HTTP ${res.status})`);
      const loc = res.headers.get("location");
      const id = loc?.split("/").pop() ?? (await findUser({ username: u.username }))?.id;
      if (!id) throw new Error("identity provider did not return the new user's id");
      return id;
    },
    secondFactors,
    async resetSecondFactors(id) {
      const held = await secondFactors(id);
      for (const c of held) {
        const res = await call("DELETE", `/users/${encodeURIComponent(id)}/credentials/${encodeURIComponent(c.id)}`);
        if (!res.ok && res.status !== 404) throw new Error(`identity provider could not remove a second factor (HTTP ${res.status})`);
      }
      await endSessions(id);
      return held.length;
    },
    async sendEnrolmentLink(id, opt = {}) {
      const q = new URLSearchParams({ lifespan: String(opt.lifespanSec ?? ENROLMENT_LINK_SECONDS), client_id: "gantry-web", ...(opt.redirectUri ? { redirect_uri: opt.redirectUri } : {}) });
      const res = await call("PUT", `/users/${encodeURIComponent(id)}/execute-actions-email?${q}`, ENROLMENT_ACTIONS);
      if (!res.ok) throw new Error(`identity provider could not send the enrolment link (HTTP ${res.status})`);
    },
    endSessions,
  };
}

/** The Keycloak base URL and realm from the OIDC issuer (`https://host/idp/realms/gantry`); the internal URL is preferred. */
export function keycloakFromIssuer(url: string): { baseUrl: string; realm: string } | null {
  const m = /^(.*)\/realms\/([^/]+)\/?$/.exec(url);
  return m ? { baseUrl: m[1]!, realm: decodeURIComponent(m[2]!) } : null;
}

/** Production wiring: the secret is read from the file `idp_admin_client_secret` (never from the environment). Null when it is not provided. */
export async function wireIdpAdmin(o: { config: { oidc: { issuer: string; internalUrl: string | null } }; env?: NodeJS.ProcessEnv }): Promise<IdpAdmin | null> {
  const env = o.env ?? process.env;
  const at = keycloakFromIssuer(o.config.oidc.internalUrl ?? o.config.oidc.issuer);
  const secret = await readSecretOptional("idp_admin_client_secret", env).catch(() => null);
  return at && secret ? keycloakAdminClient({ ...at, clientId: env.IDP_ADMIN_CLIENT_ID || "gantry-admin", clientSecret: secret }) : null;
}
