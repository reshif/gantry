#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadMigrations, migrate, setAppPassword } from "../migrate.js";
import { dbUser } from "../pool.js";
import { readSecret } from "../secrets.js";

/** gantry-migrate: connect as the owner, apply pending migrations, set gantry_app's password, exit. */
async function main(): Promise<number> {
  const env = process.env;
  if (!env.DATABASE_HOST || !env.DATABASE_NAME) {
    console.error("migrate: DATABASE_HOST and DATABASE_NAME are required");
    return 2;
  }
  const dir = env.GANTRY_MIGRATIONS_DIR || fileURLToPath(new URL("../../migrations", import.meta.url));
  const loaded = await loadMigrations(dir);
  if (!loaded.ok) {
    console.error("migrate: cannot load migrations:", JSON.stringify(loaded.error));
    return 1;
  }
  const client = new pg.Client({
    host: env.DATABASE_HOST,
    database: env.DATABASE_NAME,
    port: env.DATABASE_PORT ? Number(env.DATABASE_PORT) : 5432,
    user: dbUser("owner", env),
    password: await readSecret("db_owner_password", env),
    application_name: "gantry-migrate",
  });
  await client.connect();
  try {
    const r = await migrate(client, loaded.value);
    if (!r.ok) {
      console.error("migrate: refused:", JSON.stringify(r.error));
      return 1;
    }
    await setAppPassword(client, await readSecret("db_password", env));
    console.log(
      `migrate: applied ${r.value.applied.length} (${r.value.applied.join(", ") || "none"}); ${r.value.alreadyApplied.length} already applied; app password set`,
    );
    return 0;
  } finally {
    await client.end();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error("migrate: failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
