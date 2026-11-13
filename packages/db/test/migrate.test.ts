import { copyFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, migrate, setAppPassword } from "../src/migrate.js";
import { APP_PASSWORD, createTestDb, MIGRATIONS_DIR, TEST_URL, type TestDb } from "./helpers.js";

describe.skipIf(!TEST_URL)("migrations", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb({ migrate: false });
  });
  afterAll(async () => db.drop());

  it("applies from empty, then is idempotent", async () => {
    const files = await loadMigrations(MIGRATIONS_DIR);
    if (!files.ok) throw new Error("load");
    const c = await db.admin.connect();
    try {
      const first = await migrate(c, files.value);
      expect(first).toMatchObject({ ok: true });
      if (first.ok) expect(first.value.applied).toEqual(files.value.map((f) => f.name));
      const second = await migrate(c, files.value);
      expect(second).toEqual({ ok: true, value: { applied: [], alreadyApplied: files.value.map((f) => f.name) } });
      const { rows } = await c.query("select count(*)::int as n from schema_migrations");
      expect(rows[0].n).toBe(files.value.length);
    } finally {
      c.release();
    }
  });

  it("creates the schema as gantry_owner, not as the login role", async () => {
    const { rows } = await db.admin.query(`select tableowner from pg_tables where schemaname = 'public' and tablename in ('events','jobs')`);
    expect(rows.map((r) => r.tableowner)).toEqual(["gantry_owner", "gantry_owner"]);
  });

  it("every business table carries org_id uuid not null", async () => {
    const { rows } = await db.admin.query<{ table_name: string }>(
      `select t.tablename as table_name from pg_tables t where t.schemaname = 'public' and t.tablename <> 'schema_migrations'
         and not exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = t.tablename
                         and c.column_name = 'org_id' and c.data_type = 'uuid' and c.is_nullable = 'NO')`,
    );
    expect(rows).toEqual([]);
  });

  it("has every table from spec 7.3", async () => {
    const spec = `orgs teams people team_members invites roles role_matrix_versions role_assignments policies freezes delegations oncall
      projects project_members templates budgets saved_views flow_versions approver_rules gate_modes repos repo_config onboarding_runs onboarding_findings onboarding_prs guideline_versions
      work_orders requests conversations messages brief_versions epic_children bay_stays slots attempts runs run_usage artefacts checkpoints station_results
      commits changed_files patches pull_requests reviews review_comments checks test_results merges releases outcomes gate_instances gate_votes gate_decisions stops restore_approvals
      agents agent_versions skills skill_versions agent_skills instruction_versions agent_overrides vendors models routing_versions price_versions usage_meter
      suites eval_cases eval_runs eval_results trust_cells trust_grants trust_proposals trust_criteria_versions trust_ceilings sampling_draws findings proposals proposal_evidence
      integration_types integration_instances chat_identity_links notification_routes repo_route_overrides card_templates deliveries mcp_servers mcp_tools mcp_scopes mcp_calls
      api_keys api_requests idempotency_keys triggers trigger_runs inbound_deliveries sessions signins security_settings jobs timers outbox console_threads console_messages events`.split(/\s+/);
    const { rows } = await db.admin.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'public'`);
    const have = new Set(rows.map((r) => r.tablename));
    expect(spec.filter((t) => !have.has(t))).toEqual([]);
  });

  /** A scratch database whose migration dir starts with the real 0001 (roles and schema grants). */
  async function scratch(files: Record<string, string>) {
    const s = await createTestDb({ migrate: false });
    const dir = await mkdtemp(join(tmpdir(), "gantry-mig-"));
    await copyFile(join(MIGRATIONS_DIR, "0001_roles.sql"), join(dir, "0001_roles.sql"));
    for (const [n, sql] of Object.entries(files)) await writeFile(join(dir, n), sql);
    return {
      dir,
      db: s,
      async done() {
        await rm(dir, { recursive: true, force: true });
        await s.drop();
      },
    };
  }

  it("refuses to run when an applied file changed or went missing, and changes nothing", async () => {
    const t = await scratch({ "0002_a.sql": "create table zz_a (id int);" });
    const c = await t.db.admin.connect();
    try {
      const v1 = await loadMigrations(t.dir);
      if (!v1.ok) throw new Error("load");
      expect((await migrate(c, v1.value)).ok).toBe(true);
      await writeFile(join(t.dir, "0002_a.sql"), "create table zz_a (id int, extra int);");
      await writeFile(join(t.dir, "0003_b.sql"), "create table zz_b (id int);");
      const v2 = await loadMigrations(t.dir);
      if (!v2.ok) throw new Error("load");
      expect(await migrate(c, v2.value)).toMatchObject({ ok: false, error: { kind: "checksum_mismatch", name: "0002_a.sql" } });
      expect((await c.query("select to_regclass('zz_b') as b")).rows[0].b).toBeNull();
      await rm(join(t.dir, "0002_a.sql"));
      const v3 = await loadMigrations(t.dir);
      if (!v3.ok) throw new Error("load");
      expect(await migrate(c, v3.value)).toMatchObject({ ok: false, error: { kind: "applied_file_missing", name: "0002_a.sql" } });
    } finally {
      c.release();
      await t.done();
    }
  });

  it("rolls back a failing migration and does not record it", async () => {
    const t = await scratch({ "0002_bad.sql": "create table zz_ok (id int); select 1/0;" });
    const c = await t.db.admin.connect();
    try {
      const f = await loadMigrations(t.dir);
      if (!f.ok) throw new Error("load");
      expect(await migrate(c, f.value)).toMatchObject({ ok: false, error: { kind: "failed", name: "0002_bad.sql" } });
      const { rows } = await c.query("select to_regclass('zz_ok') as t, (select count(*)::int from schema_migrations) as n");
      expect(rows[0]).toEqual({ t: null, n: 1 }); // 0001 stays applied, 0002 is not recorded
    } finally {
      c.release();
      await t.done();
    }
  });

  it("rejects badly named and duplicate migration files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gantry-mig-"));
    try {
      await writeFile(join(dir, "1_bad.sql"), "select 1");
      expect(await loadMigrations(dir)).toMatchObject({ ok: false, error: { kind: "invalid_filename" } });
      await rm(join(dir, "1_bad.sql"));
      await writeFile(join(dir, "0001_a.sql"), "select 1");
      await writeFile(join(dir, "0001_b.sql"), "select 1");
      expect(await loadMigrations(dir)).toMatchObject({ ok: false, error: { kind: "duplicate_number" } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sets the gantry_app password as a SCRAM verifier and the app can log in", async () => {
    const c = await db.admin.connect();
    try {
      await setAppPassword(c, APP_PASSWORD);
      const { rows } = await c.query<{ rolpassword: string }>(`select rolpassword from pg_authid where rolname = 'gantry_app'`);
      expect(rows[0]!.rolpassword).toMatch(/^SCRAM-SHA-256\$/);
    } finally {
      c.release();
    }
    const u = new URL(TEST_URL!);
    u.pathname = `/${db.name}`;
    u.username = "gantry_app";
    u.password = APP_PASSWORD;
    const client = new pg.Client({ connectionString: u.toString() });
    await client.connect();
    expect((await client.query("select current_user as u")).rows[0].u).toBe("gantry_app");
    await client.end();
    u.password = "wrong";
    await expect(new pg.Client({ connectionString: u.toString() }).connect()).rejects.toThrow();
  });
});
