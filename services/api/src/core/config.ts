import { loadDataKey, readSecret } from "@gantry/db";
import { createHash } from "node:crypto";

export interface Config {
  /** Organisation slug (GANTRY_ORG_ID). The uuid is resolved at startup. */
  orgSlug: string;
  orgName: string;
  /** Public origin, e.g. https://localhost. Redirect URIs and the CSRF origin check derive from it. */
  publicUrl: string;
  cookieSecure: boolean;
  sessionCookie: string;
  oidc: {
    issuer: string; internalUrl: string | null; clientId: string; clientSecret: string; githubIdpAlias: string | null;
    /** ID-token `acr` values that prove a second factor (the realm's level-2 authentication). The first one is what a second-factor sign-in requests. */
    mfaAcrValues?: string[];
  };
  devSeed: boolean;
  demoAccounts: boolean;
  /** Development only (GANTRY_DEV_ADMIN_MFA_OPTIONAL): lets a Factory Admin work without a second sign-in factor. Always false off localhost. */
  adminMfaOptional: boolean;
  bootstrapAdminEmail: string | null;
  /**
   * Which peers may set X-Forwarded-For (Fastify trustProxy). Default: loopback and private networks only (the ingress on the
   * compose network), so a client reaching the API directly from a public address can't spoof the address that the IP
   * allow-list, rate limits and audit use. `false` trusts nobody; a list of addresses or CIDRs pins the ingress.
   */
  trustProxy: boolean | string;
  /** File that receives signed audit-head checkpoints (GANTRY_AUDIT_ANCHOR_FILE); null = off. */
  auditAnchorFile: string | null;
  host: string;
  port: number;
  secrets: { sessionKey: Buffer; dataKey: Buffer | null; edgeToken: string; githubToken: string };
  /** gantry-github (GITHUB_BROKER_URL), for the few reads the API makes of GitHub through it: the repositories the App can see. Absent in tests that need none. */
  brokerUrl?: string;
}

/** Key for sealing short-lived cookies and hashing tokens, derived from the session key. */
export const deriveKey = (sessionKey: Buffer, label: string): Buffer => createHash("sha256").update(sessionKey).update(`\0${label}`).digest();

/** Reads config from the environment and /run/secrets (docs/BUILD.md). Secrets are never taken from env vars. */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const publicUrl = need("GANTRY_PUBLIC_URL").replace(/\/+$/, "");
  const secure = publicUrl.startsWith("https://");
  const [sessionKey, edgeToken, githubToken, clientSecret] = await Promise.all([
    readSecret("session_key", env), readSecret("edge_token", env), readSecret("github_token", env), readSecret("oidc_client_secret", env),
  ]);
  const dataKey = await loadDataKey(env).catch(() => null);
  return {
    orgSlug: env.GANTRY_ORG_ID || "acme",
    orgName: env.GANTRY_ORG_NAME || env.GANTRY_ORG_ID || "acme",
    publicUrl,
    cookieSecure: secure,
    sessionCookie: secure ? "__Host-gantry_session" : "gantry_session",
    oidc: {
      issuer: need("OIDC_ISSUER"),
      internalUrl: env.OIDC_INTERNAL_URL || null,
      clientId: need("OIDC_CLIENT_ID"),
      clientSecret,
      githubIdpAlias: env.OIDC_GITHUB_IDP_ALIAS || null,
      mfaAcrValues: (env.OIDC_MFA_ACR_VALUES ?? "2,3,mfa").split(",").map((x) => x.trim()).filter(Boolean),
    },
    devSeed: env.GANTRY_DEV_SEED === "true",
    // The demo sign-in list follows the seed: only a stack loaded with the seeded demo organisation lists its demo users (owner, 2026-11-18).
    demoAccounts: demoAccountsAllowed(env.GANTRY_DEV_SEED === "true", publicUrl),
    adminMfaOptional: adminMfaOptionalAllowed(env.GANTRY_DEV_ADMIN_MFA_OPTIONAL === "true", publicUrl),
    bootstrapAdminEmail: env.GANTRY_BOOTSTRAP_ADMIN_EMAIL ? env.GANTRY_BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase() : null,
    trustProxy: trustProxyFrom(env.GANTRY_TRUST_PROXY),
    auditAnchorFile: env.GANTRY_AUDIT_ANCHOR_FILE || null,
    host: env.HOST || "0.0.0.0",
    port: env.PORT ? Number(env.PORT) : 8000,
    secrets: { sessionKey: Buffer.from(sessionKey, "utf8"), dataKey, edgeToken, githubToken },
    brokerUrl: (env.GITHUB_BROKER_URL || "http://gantry-github:9200").replace(/\/+$/, ""),
  };
}

/**
 * The demo sign-in list publishes every person's name, email and roles to anyone who reaches the sign-in page. It is shown only when the
 * seeded demo organisation is loaded (GANTRY_DEV_SEED=true) AND the public URL is this machine; seeding a non-local stack never lists them.
 * (The separate GANTRY_DEV_DEMO_ACCOUNTS switch was removed on 2026-11-18; it is ignored if still set.)
 */
export function demoAccountsAllowed(seeded: boolean, publicUrl: string): boolean {
  if (!seeded) return false;
  const host = (() => { try { return new URL(publicUrl).hostname; } catch { return ""; } })();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

/**
 * GANTRY_DEV_ADMIN_MFA_OPTIONAL=true waives the second sign-in factor Factory Admins otherwise need, so the seeded demo admin (asha,
 * password only) can work on a local stack. The service refuses to start when the public URL is not this machine.
 */
export function adminMfaOptionalAllowed(on: boolean, publicUrl: string): boolean {
  if (!on) return false;
  const host = (() => { try { return new URL(publicUrl).hostname; } catch { return ""; } })();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost")) return true;
  throw new Error(`GANTRY_DEV_ADMIN_MFA_OPTIONAL=true is for local development only; GANTRY_PUBLIC_URL (${publicUrl}) is not localhost. Unset it: Factory Admins must use a second sign-in factor.`);
}

/** GANTRY_TRUST_PROXY: unset -> "loopback, uniquelocal"; "false" -> false; anything else -> that address or CIDR list. "true" (trust any peer) is refused. */
export function trustProxyFrom(v: string | undefined): boolean | string {
  const x = (v ?? "").trim();
  if (!x) return "loopback, uniquelocal";
  if (x === "false") return false;
  if (x === "true") throw new Error("GANTRY_TRUST_PROXY=true would let any client set its own address. Set the ingress address or CIDR, or leave it unset for private networks only.");
  return x;
}
