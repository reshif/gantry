import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { err, ok, type Result } from "./result.js";

export interface MigrationFile {
  name: string;
  checksum: string;
  sql: string;
}

export type MigrateError =
  | { kind: "checksum_mismatch"; name: string; applied: string; onDisk: string }
  | { kind: "applied_file_missing"; name: string }
  | { kind: "invalid_filename"; name: string }
  | { kind: "duplicate_number"; number: string; names: string[] }
  | { kind: "failed"; name: string; message: string };

export interface MigrateReport {
  applied: string[];
  alreadyApplied: string[];
}

const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const OWNER_ROLE = "gantry_owner";
/** First line of a migration that must run as the login role instead of gantry_owner. */
export const LOGIN_ROLE_MARKER = "-- migrate:login-role";
/** Arbitrary constant: one migrator at a time per database. */
const LOCK_ID = 7_345_001;

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export async function loadMigrations(dir: string): Promise<Result<MigrationFile[], MigrateError>> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  const seen = new Map<string, string[]>();
  for (const name of names) {
    const m = FILE.exec(name);
    if (!m) return err({ kind: "invalid_filename", name });
    seen.set(m[1]!, [...(seen.get(m[1]!) ?? []), name]);
  }
  for (const [number, list] of seen) if (list.length > 1) return err({ kind: "duplicate_number", number, names: list });
  const files: MigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(join(dir, name), "utf8");
    files.push({ name, sql, checksum: sha256(sql) });
  }
  return ok(files);
}

/**
 * Applies pending migrations in order, each in its own transaction, recording name and checksum.
 * Refuses (changing nothing) if an applied file changed or went missing. `client` must be a dedicated
 * connection, normally as the owner role. Each file runs as gantry_owner (SET LOCAL ROLE) so objects are owned by it
 * even when the login role is a superuser such as postgres, unless it starts with LOGIN_ROLE_MARKER.
 */
export async function migrate(client: pg.Client | pg.PoolClient, files: MigrationFile[]): Promise<Result<MigrateReport, MigrateError>> {
  await client.query("select pg_advisory_lock($1)", [LOCK_ID]);
  try {
    await client.query(`create table if not exists schema_migrations (
      name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    const { rows } = await client.query<{ name: string; checksum: string }>("select name, checksum from schema_migrations order by name");
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    const onDisk = new Map(files.map((f) => [f.name, f]));
    for (const [name, checksum] of applied) {
      const f = onDisk.get(name);
      if (!f) return err({ kind: "applied_file_missing", name });
      if (f.checksum !== checksum) return err({ kind: "checksum_mismatch", name, applied: checksum, onDisk: f.checksum });
    }
    const report: MigrateReport = { applied: [], alreadyApplied: [...applied.keys()] };
    for (const f of files) {
      if (applied.has(f.name)) continue;
      try {
        await client.query("begin");
        // Files marked LOGIN_ROLE_MARKER (roles, extensions) need the login role's privileges; all others run as the owner.
        if (!f.sql.startsWith(LOGIN_ROLE_MARKER)) {
          const role = await client.query("select 1 from pg_roles where rolname = $1 and $1 <> session_user", [OWNER_ROLE]);
          if (role.rowCount) await client.query(`set local role ${OWNER_ROLE}`);
        }
        await client.query(f.sql);
        await client.query("reset role");
        await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [f.name, f.checksum]);
        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        return err({ kind: "failed", name: f.name, message: e instanceof Error ? e.message : String(e) });
      }
      report.applied.push(f.name);
    }
    return ok(report);
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
  }
}

/** SCRAM-SHA-256 verifier, so the plaintext password never appears in a statement the server can log. */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const hmac = (key: Buffer, msg: string) => createHmac("sha256", key).update(msg).digest();
  const stored = createHash("sha256").update(hmac(salted, "Client Key")).digest("base64");
  const server = hmac(salted, "Server Key").toString("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${stored}:${server}`;
}

/** Sets gantry_app's login password (idempotent). Requires the gantry_app role to exist (migration 0001). */
export async function setAppPassword(client: pg.Client | pg.PoolClient, password: string, role = "gantry_app"): Promise<void> {
  const { rows } = await client.query<{ stmt: string }>("select format('alter role %I with login password %L', $1::text, $2::text) as stmt", [
    role,
    scramVerifier(password),
  ]);
  // Roles are cluster-wide: two databases on one cluster setting the same role's password at the same moment can make
  // Postgres refuse one with "tuple concurrently updated". The statement is idempotent, so retry a few times.
  for (let attempt = 1; ; attempt++) {
    try {
      await client.query(rows[0]!.stmt);
      return;
    } catch (e) {
      if (attempt >= 15 || !/tuple concurrently updated/i.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, Math.random() * 25 * attempt)); // jitter, so the retries do not collide again
    }
  }
}
