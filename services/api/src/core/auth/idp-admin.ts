import { readSecretOptional } from "@gantry/db";

/**
 * The identity provider's admin API as Gantry uses it at run time, through ONE scoped service account (the `gantry-admin` client of the
 * gantry realm: manage-users and view-events in that realm). The Keycloak master-admin password is never given to the API (S-125): the
 * service account cannot change the realm, its flows or its clients, nor reach any other realm.
 *
 * WHAT IT CAN STILL DO, plainly: manage-users lets it set any user's password (`reset-password`) and create or update a user with an `otp`
 * credential whose secret it chose, so whoever controls the API process or the `idp_admin_client_secret` file can plant a factor on ANY
 * account, a Factory Admin included, and sign in as them. MFA does not survive a compromise of the API or of that secret. This is a smaller hole
 * than the master password (no realm, flow or client changes), not a closed one. The controls are detective: every call this client makes is
 * logged (idp_admin_log), and core/auth/idp-watch.ts reads the realm's admin events and records `auth.mfa_changed_outside` (ledger and an
 * email to the Factory Admins) for any credential or password change that did not come from a logged Gantry call, and sign-in compares each
 * person's authenticators (ids and creation times) with the last sighting.
 *
 * What it is for: the one-time enrolment link (the only way a person gets a first authenticator, S-122), an authenticator reset (S-124),
 * reading which second factors a person holds (the per-person status and the "reset behind our back" check), and creating the bootstrap admin.
 */
export interface IdpCredential { id: string; type: string; /** When the provider created it (ms); a re-planted factor with a reused id differs here. */ createdDate?: number }
/** One admin-API change at the provider (admin events), as far as Gantry reads it. */
export interface IdpAdminEvent { /** The provider's event id, used to avoid handling an event twice. */ id?: string; time: number; operation: string; resourceType: string; resourcePath: string; /** The client that made the change (`gantry-admin`), or null for a person in a console. */ clientId: string | null; userId: string | null; realmId: string | null; /** The submitted user representation when the provider recorded one (it omits credentials). */ representation?: string | null }
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
  /** Removes second factors (only `only` when given, else every one) and ends the person's provider sessions; returns how many were removed. */
  resetSecondFactors(userId: string, only?: string[]): Promise<number>;
  /**
   * Every user-affecting admin event since `sinceMs`, read in pages until the window is exhausted (never a fixed first-200 view a flood could push a plant out of).
   * `complete` is false only if the page cap was hit. Needs the view-events role.
   */
  credentialEvents(sinceMs: number): Promise<{ events: IdpAdminEvent[]; complete: boolean }>;
  /** The id of this client's own service-account user: the `authDetails.userId` of every event Gantry itself causes (the client id in events is an internal UUID, not "gantry-admin"). */
  serviceAccountUserId(): Promise<string | null>;
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
  /** Called for every change this client makes (not reads), so the watcher can tell Gantry's own changes from anyone else's. */
  onCall?: (method: string, path: string) => void | Promise<void>;
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
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    if (method !== "GET") await Promise.resolve(o.onCall?.(method, path)).catch(() => undefined);
    return f(`${admin}${path}`, {
      method, headers: { authorization: `Bearer ${await token()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000),
    });
  };
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
    return ((await res.json()) as Array<{ id: string; type: string; createdDate?: number }>).filter((c) => SECOND_FACTOR_TYPES.has(c.type)).map((c) => ({ id: c.id, type: c.type, ...(typeof c.createdDate === "number" ? { createdDate: c.createdDate } : {}) }));
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
    async resetSecondFactors(id, only) {
      const held = (await secondFactors(id)).filter((c) => !only || only.includes(c.id));
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
    async serviceAccountUserId() { return (await findUser({ username: `service-account-${o.clientId}` }))?.id ?? null; },
    async credentialEvents(sinceMs) {
      const PAGE = 200;
      const MAX_PAGES = 100;
      const out: IdpAdminEvent[] = [];
      const dateFrom = new Date(sinceMs - 3_600_000).toISOString().slice(0, 10);
      for (let page = 0; page < MAX_PAGES; page++) {
        const q = new URLSearchParams({ first: String(page * PAGE), max: String(PAGE), dateFrom });
        q.append("resourceTypes", "USER"); // credential deletes and password resets are USER events too (there is no CREDENTIAL resource type)
        const res = await call("GET", `/admin-events?${q}`);
        if (!res.ok) throw new Error(`identity provider admin events could not be read (HTTP ${res.status})`);
        const rows = (await res.json()) as Array<{ id?: string; time: number; operationType: string; resourceType: string; resourcePath?: string; representation?: string; authDetails?: { clientId?: string; userId?: string; realmId?: string } }>;
        for (const e of rows) {
          if (e.time <= sinceMs) continue;
          out.push({ ...(e.id ? { id: e.id } : {}), time: e.time, operation: e.operationType, resourceType: e.resourceType, resourcePath: e.resourcePath ?? "", clientId: e.authDetails?.clientId ?? null, userId: e.authDetails?.userId ?? null, realmId: e.authDetails?.realmId ?? null, representation: e.representation ?? null });
        }
        // newest first: once a page reaches back to the high-water mark (or is short) everything newer has been read
        if (rows.length < PAGE || rows.some((e) => e.time <= sinceMs)) return { events: out, complete: true };
      }
      return { events: out, complete: false };
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
export async function wireIdpAdmin(o: { config: { oidc: { issuer: string; internalUrl: string | null } }; env?: NodeJS.ProcessEnv; onCall?: KeycloakAdminOptions["onCall"] }): Promise<IdpAdmin | null> {
  const env = o.env ?? process.env;
  const at = keycloakFromIssuer(o.config.oidc.internalUrl ?? o.config.oidc.issuer);
  const secret = await readSecretOptional("idp_admin_client_secret", env).catch(() => null);
  return at && secret ? keycloakAdminClient({ ...at, clientId: env.IDP_ADMIN_CLIENT_ID || "gantry-admin", clientSecret: secret, ...(o.onCall ? { onCall: o.onCall } : {}) }) : null;
}
