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
  oidc: { issuer: string; internalUrl: string | null; clientId: string; clientSecret: string; githubIdpAlias: string | null };
  devSeed: boolean;
  demoAccounts: boolean;
  bootstrapAdminEmail: string | null;
  trustProxy: boolean;
  host: string;
  port: number;
  secrets: { sessionKey: Buffer; dataKey: Buffer | null; edgeToken: string; githubToken: string };
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
    },
    devSeed: env.GANTRY_DEV_SEED === "true",
    demoAccounts: env.GANTRY_DEV_DEMO_ACCOUNTS === "true",
    bootstrapAdminEmail: env.GANTRY_BOOTSTRAP_ADMIN_EMAIL ? env.GANTRY_BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase() : null,
    trustProxy: env.GANTRY_TRUST_PROXY !== "false",
    host: env.HOST || "0.0.0.0",
    port: env.PORT ? Number(env.PORT) : 8000,
    secrets: { sessionKey: Buffer.from(sessionKey, "utf8"), dataKey, edgeToken, githubToken },
  };
}
