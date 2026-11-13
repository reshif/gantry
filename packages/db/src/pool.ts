import pg from "pg";
import { readSecret } from "./secrets.js";

export type DbRole = "app" | "owner";

const ROLE_DEFAULTS: Record<DbRole, { user: string; secret: string; userEnv: string }> = {
  app: { user: "gantry_app", secret: "db_password", userEnv: "DATABASE_APP_USER" },
  owner: { user: "gantry_owner", secret: "db_owner_password", userEnv: "DATABASE_OWNER_USER" },
};

export interface PoolOptions {
  env?: NodeJS.ProcessEnv;
  max?: number;
  applicationName?: string;
}

export function dbUser(role: DbRole, env: NodeJS.ProcessEnv = process.env): string {
  const d = ROLE_DEFAULTS[role];
  return env[d.userEnv] || d.user;
}

/** Pool for `role` from DATABASE_HOST / DATABASE_NAME (/ DATABASE_PORT); the password is read from its secret file per connection. */
export function createPool(role: DbRole, opts: PoolOptions = {}): pg.Pool {
  const env = opts.env ?? process.env;
  const host = env.DATABASE_HOST;
  const database = env.DATABASE_NAME;
  if (!host || !database) throw new Error("DATABASE_HOST and DATABASE_NAME are required");
  const d = ROLE_DEFAULTS[role];
  const pool = new pg.Pool({
    host,
    database,
    port: env.DATABASE_PORT ? Number(env.DATABASE_PORT) : 5432,
    user: dbUser(role, env),
    password: () => readSecret(d.secret, env),
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? `gantry-${role}`,
    idleTimeoutMillis: 30_000,
  });
  // An idle client erroring (server restart) must not crash the process; the next checkout reconnects.
  pool.on("error", () => undefined);
  return pool;
}
