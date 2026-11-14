import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadMigrations, migrate, setAppPassword } from "@gantry/db";

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

/** A throwaway migrated database with pools as the owner (admin) and as gantry_app (what the worker uses). */
export async function createTestDb(): Promise<TestDb> {
  if (!TEST_URL) throw new Error("GANTRY_TEST_DATABASE_URL is not set");
  const name = `gantry_wrk_t_${randomBytes(5).toString("hex")}`;
  const root = new pg.Client({ connectionString: TEST_URL });
  await root.connect();
  await root.query(`create database ${name}`);
  await root.end();
  const admin = new pg.Pool({ connectionString: withDb(TEST_URL, name), max: 4 });
  const app = new pg.Pool({ connectionString: withDb(TEST_URL, name, "gantry_app", APP_PASSWORD), max: 20 });
  for (const p of [admin, app]) p.on("error", () => undefined);
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
