import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import * as client from "openid-client";
import type { Config } from "./config.js";

export interface LoginParams {
  redirectUri: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  loginHint?: string | null;
  stepUp?: boolean;
  idpHint?: string | null;
}

export interface IdClaims {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  gantryId?: string;
  gantryTitle?: string;
  authTime?: number;
  acr?: string;
  /** Authentication methods the provider says were used (RFC 8176 `amr`), when it issues them. */
  amr?: string[];
  sid?: string;
  preferredUsername?: string;
  /** The raw ID token, kept (sealed) only to end the provider's session at sign-out as `id_token_hint`. */
  idToken?: string;
}

/** `amr` values (RFC 8176) that mean something beyond a password was presented. */
const SECOND_FACTOR_AMR = new Set(["otp", "mfa", "hwk", "swk", "sc", "fpt", "face", "iris", "retina", "vbm", "pop", "webauthn"]);
export const DEFAULT_MFA_ACR = ["2", "3", "mfa"];

/**
 * Whether the ID token carries evidence of a second sign-in factor: an `amr` naming one, or an `acr` equal to one of the
 * realm's second-factor levels. A password alone (acr "1", amr ["pwd"] or nothing) is not evidence.
 */
export function hasSecondFactor(c: Pick<IdClaims, "acr" | "amr">, acrValues: readonly string[] = DEFAULT_MFA_ACR): boolean {
  if (c.amr?.some((m) => SECOND_FACTOR_AMR.has(m.toLowerCase()))) return true;
  return !!c.acr && acrValues.includes(c.acr);
}

export interface OidcAdapter {
  /** Browser redirect target for the authorization endpoint (auth-code + PKCE). */
  authorizationUrl(p: LoginParams): Promise<URL>;
  /** Exchanges the callback for validated ID-token claims (state, nonce, PKCE, signature, issuer, audience). */
  exchange(currentUrl: URL, check: { codeVerifier: string; state: string; nonce: string }): Promise<IdClaims>;
  /**
   * RP-initiated logout: where to send the browser so the provider ends its own SSO session too. Without this, signing out
   * of Gantry leaves the provider session alive and the next "Sign in" goes straight back in without a password.
   * Null when the provider publishes no end-session endpoint.
   */
  endSessionUrl(p: { idTokenHint?: string | null; postLogoutRedirectUri: string }): Promise<URL | null>;
  /**
   * OIDC Back-Channel Logout 1.0: validates a logout token the provider posted (signature against the provider's keys, issuer, audience, age, the logout
   * event, no nonce, and a subject or session id). Returns who and which provider session ended; throws when the token is not valid.
   */
  verifyLogoutToken(token: string): Promise<{ sub?: string; sid?: string; jti: string }>;
  /** Whether a federated GitHub identity provider is configured. */
  readonly githubIdp: string | null;
}

/**
 * openid-client v6 against Keycloak. Discovery runs against the internal URL when one is set (containers cannot reach the public
 * https://localhost origin), while `issuer` stays the public value tokens carry. The authorization endpoint stays public because the
 * browser follows it; the token and JWKS endpoints are rewritten to the internal base.
 */
export function createOidcAdapter(cfg: Config["oidc"], opts: { allowInsecure?: boolean } = {}): OidcAdapter {
  let configP: Promise<client.Configuration> | null = null;
  const load = (): Promise<client.Configuration> => {
    configP ??= (async () => {
      const base = (cfg.internalUrl ?? cfg.issuer).replace(/\/+$/, "");
      const res = await fetch(`${base}/.well-known/openid-configuration`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
      const meta = (await res.json()) as client.ServerMetadata;
      const pub = cfg.issuer.replace(/\/+$/, "");
      const toInternal = (u: string | undefined): string | undefined => (u && cfg.internalUrl && u.startsWith(pub) ? base + u.slice(pub.length) : u);
      const server: client.ServerMetadata = {
        ...meta,
        issuer: cfg.issuer,
        token_endpoint: toInternal(meta.token_endpoint),
        jwks_uri: toInternal(meta.jwks_uri),
        userinfo_endpoint: toInternal(meta.userinfo_endpoint),
      };
      const c = new client.Configuration(server, cfg.clientId, undefined, client.ClientSecretPost(cfg.clientSecret));
      if (opts.allowInsecure ?? (cfg.internalUrl?.startsWith("http://") || cfg.issuer.startsWith("http://"))) client.allowInsecureRequests(c);
      return c;
    })().catch((e) => {
      configP = null; // retry discovery on the next attempt
      throw e;
    });
    return configP;
  };
  return {
    githubIdp: cfg.githubIdpAlias,
    async verifyLogoutToken(token) {
      const c = await load();
      const md = c.serverMetadata();
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("not a JWT");
      const [h, p, sig] = parts as [string, string, string];
      const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string; kid?: string };
      if (header.alg !== "RS256" && header.alg !== "ES256") throw new Error("unsupported signing algorithm");
      if (!md.jwks_uri) throw new Error("the provider publishes no keys");
      const res = await fetch(md.jwks_uri, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`keys unavailable: ${res.status}`);
      const keys = ((await res.json()) as { keys?: Array<JsonWebKey & { kid?: string; use?: string }> }).keys ?? [];
      const jwk = keys.find((k) => (!header.kid || k.kid === header.kid) && (!k.use || k.use === "sig") && k.kty === (header.alg === "RS256" ? "RSA" : "EC"));
      if (!jwk) throw new Error("no key for this token");
      const ok = cryptoVerify(header.alg === "RS256" ? "sha256" : "sha256", Buffer.from(`${h}.${p}`), header.alg === "ES256" ? { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" } : createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(sig, "base64url"));
      if (!ok) throw new Error("bad signature");
      const k = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
      const aud = Array.isArray(k.aud) ? k.aud : [k.aud];
      const events = k.events && typeof k.events === "object" ? (k.events as Record<string, unknown>) : {};
      const now = Date.now() / 1000;
      if (k.iss !== cfg.issuer) throw new Error("wrong issuer");
      if (!aud.includes(cfg.clientId)) throw new Error("wrong audience");
      if (typeof k.iat !== "number" || Math.abs(now - k.iat) > 300) throw new Error("token is not recent");
      if (typeof k.exp === "number" && k.exp < now) throw new Error("token expired");
      if (typeof k.jti !== "string" || !k.jti) throw new Error("no jti");
      if (!("http://schemas.openid.net/event/backchannel-logout" in events)) throw new Error("not a logout token");
      if ("nonce" in k) throw new Error("a logout token carries no nonce");
      const sub = typeof k.sub === "string" && k.sub ? k.sub : undefined;
      const sid = typeof k.sid === "string" && k.sid ? k.sid : undefined;
      if (!sub && !sid) throw new Error("no subject or session id");
      return { ...(sub ? { sub } : {}), ...(sid ? { sid } : {}), jti: k.jti };
    },
    async authorizationUrl(p) {
      const c = await load();
      const params: Record<string, string> = {
        redirect_uri: p.redirectUri,
        scope: "openid profile email",
        code_challenge: await client.calculatePKCECodeChallenge(p.codeVerifier),
        code_challenge_method: "S256",
        state: p.state,
        nonce: p.nonce,
      };
      if (p.loginHint) params.login_hint = p.loginHint;
      // Every sign-in is a fresh one (S-130): without prompt=login the provider would sign the previous person back in from its own SSO session, with the
      // old authentication level and no credentials, after Gantry's session had ended (idle, absolute end, an admin revoking it). It also makes a named
      // account (demo card, invite link) get its own login instead of whoever holds the provider session.
      params.prompt = "login";
      // A step-up asks for a sign-in that happened now (max_age=0); the callback checks the token's auth_time is recent (S-129).
      if (p.stepUp) params.max_age = "0";
      // Everyone needs a second factor (S-121), at every sign-in and every step-up: always ask for the provider's second-factor level.
      params.acr_values = cfg.mfaAcrValues?.[0] ?? DEFAULT_MFA_ACR[0]!;
      if (p.idpHint) params.kc_idp_hint = p.idpHint;
      return client.buildAuthorizationUrl(c, params);
    },
    async exchange(currentUrl, check) {
      const c = await load();
      const tokens = await client.authorizationCodeGrant(c, currentUrl, { pkceCodeVerifier: check.codeVerifier, expectedState: check.state, expectedNonce: check.nonce, idTokenExpected: true });
      const k = tokens.claims();
      if (!k) throw new Error("no ID token claims");
      const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
      const n = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
      return {
        sub: k.sub, email: s(k.email)?.toLowerCase(), emailVerified: typeof k.email_verified === "boolean" ? k.email_verified : undefined,
        name: s(k.name), gantryId: s(k.gantry_id), gantryTitle: s(k.gantry_title), authTime: n(k.auth_time), acr: s(k.acr), amr: Array.isArray(k.amr) ? k.amr.filter((x): x is string => typeof x === "string") : undefined, sid: s(k.sid), preferredUsername: s(k.preferred_username),
        ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
      };
    },
    async endSessionUrl(p) {
      const c = await load();
      if (!c.serverMetadata().end_session_endpoint) return null;
      // Without an id_token_hint the provider asks the person to confirm the sign-out, but still ends its session: the client_id names who is leaving.
      const params: Record<string, string> = { client_id: cfg.clientId, post_logout_redirect_uri: p.postLogoutRedirectUri };
      if (p.idTokenHint) params.id_token_hint = p.idTokenHint;
      return client.buildEndSessionUrl(c, params);
    },
  };
}
