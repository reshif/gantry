import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadMigrations, migrate, setAppPassword } from "../src/migrate.js";

export const TEST_URL = process.env.GANTRY_TEST_DATABASE_URL;
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
export const APP_PASSWORD = "app-test-password";

export interface TestDb {
  name: string;
  /** Superuser/owner connection pool (edits and inspection). */
  admin: pg.Pool;
  /** Pool as gantry_app, the role services use. */
  app: pg.Pool;
  orgId: string;
  drop(): Promise<void>;
}

function withDb(url: string, db: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/** Creates an empty database, applies all migrations, sets the app password and inserts one org. */
export async function createTestDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  if (!TEST_URL) throw new Error("GANTRY_TEST_DATABASE_URL is not set");
  const name = `gantry_t_${randomBytes(5).toString("hex")}`;
  const root = new pg.Client({ connectionString: TEST_URL });
  await root.connect();
  await root.query(`create database ${name}`);
  await root.end();
  const admin = new pg.Pool({ connectionString: withDb(TEST_URL, name), max: 8 });
  const app = new pg.Pool({ connectionString: withDb(TEST_URL, name, "gantry_app", APP_PASSWORD), max: 30 });
  let orgId = "";
  if (opts.migrate !== false) {
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
    orgId = (await admin.query<{ id: string }>(`insert into orgs (slug, name) values ('t', 'Test') returning id`)).rows[0]!.id;
  }
  return {
    name,
    admin,
    app,
    orgId,
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
