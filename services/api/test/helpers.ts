import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { loadMigrations, migrate, setAppPassword } from "@gantry/db";
import { buildApp, type BuildOptions } from "../src/core/app.js";
import { bootstrapOrg } from "../src/core/bootstrap.js";
import type { Config } from "../src/core/config.js";
import { createSession, csrfFor } from "../src/core/auth/sessions.js";

export const TEST_URL = process.env.GANTRY_TEST_DATABASE_URL;
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
const APP_PASSWORD = "app-test-password";

export interface TestDb {
  admin: pg.Pool;
  app: pg.Pool;
  drop(): Promise<void>;
}

const withDb = (url: string, db: string, user?: string, password?: string): string => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
};

/** A throwaway migrated database, with pools as the owner (admin) and as gantry_app. */
export async function createTestDb(): Promise<TestDb> {
  if (!TEST_URL) throw new Error("GANTRY_TEST_DATABASE_URL is not set");
  const name = `gantry_api_t_${randomBytes(5).toString("hex")}`;
  const root = new pg.Client({ connectionString: TEST_URL });
  await root.connect();
  await root.query(`create database ${name}`);
  await root.end();
  const admin = new pg.Pool({ connectionString: withDb(TEST_URL, name), max: 4 });
  const app = new pg.Pool({ connectionString: withDb(TEST_URL, name, "gantry_app", APP_PASSWORD), max: 20 });
  for (const p of [admin, app]) p.on("error", () => undefined); // an idle client killed by DROP DATABASE ... WITH (FORCE)
  const client = await admin.connect();
  try {
    const files = await loadMigrations(MIGRATIONS_DIR);
    if (!files.ok) throw new Error(JSON.stringify(files.error));
    const r = await migrate(client, files.value);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    await setAppPassword(client, APP_PASSWORD);
  } finally {
    client.release();
  }
  return {
    admin,
    app,
    async drop() {
      await app.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      const c = new pg.Client({ connectionString: TEST_URL });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

export const SESSION_KEY = Buffer.from("test-session-key-0123456789abcdef", "utf8");

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    orgSlug: "acme", orgName: "Acme Test", publicUrl: "https://gantry.test", cookieSecure: true, sessionCookie: "__Host-gantry_session",
    oidc: { issuer: "http://127.0.0.1:1/unused", internalUrl: null, clientId: "gantry-web", clientSecret: "secret", githubIdpAlias: null },
    devSeed: true, demoAccounts: true, adminMfaOptional: true, bootstrapAdminEmail: null, trustProxy: false, auditAnchorFile: null, host: "127.0.0.1", port: 0,
    secrets: { sessionKey: SESSION_KEY, dataKey: null, edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" },
    ...over,
  };
}

export interface TestApp {
  app: FastifyInstance;
  db: TestDb;
  orgId: string;
  config: Config;
  close(): Promise<void>;
  /** A signed-in browser for `personId`: cookie header and CSRF token. */
  session(personId: string, o?: { authAgeSec?: number; ip?: string }): Promise<{ cookie: string; csrf: string; id: string; headers: Record<string, string> }>;
}

export async function startApp(o: { config?: Partial<Config>; build?: Partial<BuildOptions>; seed?: boolean; seedNow?: number; /** Load the dev seed's audit history into the ledger (off by default so tests count only their own events). */ seedAudit?: boolean; /** Load the dev seed's demo eval suites, run history and trust ladder (off by default so tests count only their own rows). */ seedEvals?: boolean } = {}): Promise<TestApp> {
  const db = await createTestDb();
  const config = testConfig({ devSeed: o.seed !== false, ...o.config });
  const { orgId } = await bootstrapOrg(db.app, config, undefined, { seedNow: o.seedNow, seedAudit: o.seedAudit ?? false, seedEvals: o.seedEvals ?? false });
  const app = await buildApp({ pool: db.app, config, orgId, logger: false, ...o.build });
  return {
    app, db, orgId, config,
    async close() {
      await app.close();
      await db.drop();
    },
    async session(personId, so = {}) {
      const s = await createSession(db.app, SESSION_KEY, {
        orgId, personId, method: "sso", ip: so.ip ?? "203.0.113.9", userAgent: "vitest", absoluteHours: 12, authTime: new Date(Date.now() - (so.authAgeSec ?? 0) * 1000),
      });
      const csrf = csrfFor(SESSION_KEY, s.id);
      const cookie = `${config.sessionCookie}=${s.token}`;
      return { cookie, csrf, id: s.id, headers: { cookie, "x-csrf-token": csrf } };
    },
  };
}
