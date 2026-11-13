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
  sid?: string;
  preferredUsername?: string;
}

export interface OidcAdapter {
  /** Browser redirect target for the authorization endpoint (auth-code + PKCE). */
  authorizationUrl(p: LoginParams): Promise<URL>;
  /** Exchanges the callback for validated ID-token claims (state, nonce, PKCE, signature, issuer, audience). */
  exchange(currentUrl: URL, check: { codeVerifier: string; state: string; nonce: string }): Promise<IdClaims>;
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
      if (p.stepUp) params.prompt = "login";
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
        name: s(k.name), gantryId: s(k.gantry_id), gantryTitle: s(k.gantry_title), authTime: n(k.auth_time), acr: s(k.acr), sid: s(k.sid), preferredUsername: s(k.preferred_username),
      };
    },
  };
}
