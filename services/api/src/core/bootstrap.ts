import { DEFAULT_CATALOG, defaultMatrix, devSeed } from "@gantry/domain";
import { seedDevOrg, withTx, type SeedState } from "@gantry/db";
import type pg from "pg";
import type { Config } from "./config.js";
import { DEFAULT_SECURITY } from "./read/index.js";
import { seedDemoAudit } from "../areas/audit/seed.js";

export interface BootResult {
  orgId: string;
  seeded: boolean;
}

/**
 * Makes sure the organisation exists and has the rows every request relies on: built-in roles, the default matrix, security
 * settings and the ordered catalogue. Idempotent: nothing already present is changed. With GANTRY_DEV_SEED=true the legacy dev
 * seed is loaded first, and only if the organisation does not exist yet. Without it the org starts empty: just the roles,
 * matrix and settings, and a Factory Admin appears when GANTRY_BOOTSTRAP_ADMIN_EMAIL signs in for the first time.
 */
export async function bootstrapOrg(pool: pg.Pool, config: Pick<Config, "orgSlug" | "orgName" | "devSeed">, log?: { info(o: object, m?: string): void }, opts: { seedNow?: number; /** Dev seed only: also load the seed's audit history into the ledger (default true). */ seedAudit?: boolean; /** Dev seed only: also load the demo eval suites, their run history and the trust ladder (default true). */ seedEvals?: boolean } = {}): Promise<BootResult> {
  let seeded = false;
  if (config.devSeed) {
    const seed = devSeed(opts.seedNow);
    const full = toSeedState(seed, config.orgSlug);
    const { suites: _suites, evalRuns: _runs, trust: _trust, ...withoutEvals } = full;
    const state: SeedState = opts.seedEvals === false ? withoutEvals : full;
    const r = await withTx(pool, (tx) => seedDevOrg(tx, state));
    seeded = r.created;
    log?.info({ created: r.created }, "dev seed");
  }
  const orgId = await withTx(pool, async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `insert into orgs (slug, name, plant, tz, settings) values ($1, $2, '', 'UTC', $3::jsonb) on conflict (slug) do nothing returning id`,
      [config.orgSlug, config.orgName, JSON.stringify({ catalog: DEFAULT_CATALOG })],
    );
    const id = ins.rows[0]?.id ?? (await tx.query<{ id: string }>(`select id from orgs where slug = $1`, [config.orgSlug])).rows[0]!.id;
    const org = (await tx.query(`select settings from orgs where id = $1 for update`, [id])).rows[0]!;
    const settings = (org.settings ?? {}) as { catalog?: unknown };
    if (!settings.catalog) await tx.query(`update orgs set settings = settings || $2::jsonb where id = $1`, [id, JSON.stringify({ catalog: DEFAULT_CATALOG })]);
    const roles = await tx.query(`select 1 from roles where org_id = $1 limit 1`, [id]);
    if (!roles.rowCount) {
      for (const r of DEFAULT_CATALOG.roles) {
        await tx.query(`insert into roles (org_id, id, name, level, builtin) values ($1,$2,$3,$4,true) on conflict do nothing`, [id, r.id, r.name, r.level]);
      }
    }
    await tx.query(
      `insert into role_matrix_versions (org_id, version, matrix, note, published_at, published_by)
       select $1, 1, $2::jsonb, 'Built-in defaults', now(), 'system' where not exists (select 1 from role_matrix_versions where org_id = $1)`,
      [id, JSON.stringify(defaultMatrix())],
    );
    await tx.query(
      `insert into security_settings (org_id, version, body, note, published_at, published_by)
       select $1, 1, $2::jsonb, 'Defaults', now(), 'system' where not exists (select 1 from security_settings where org_id = $1)`,
      [id, JSON.stringify(DEFAULT_SECURITY)],
    );
    return id;
  });
  if (seeded && opts.seedAudit !== false) await seedDemoAudit(pool, orgId, devSeed(opts.seedNow));
  return { orgId, seeded };
}

/** devSeed() -> the db seeder's input. The seed's demo IP allow-list is dropped: it would lock out every real browser address. */
export function toSeedState(seed: ReturnType<typeof devSeed>, slug: string): SeedState {
  const s = seed.state as unknown as Record<string, unknown>;
  const cat = seed.catalog;
  return {
    ...(s as object),
    org: { id: slug, name: (s.org as { name: string }).name, plant: (s.org as { plant?: string }).plant, tz: (s.org as { tz?: string }).tz },
    roles: cat.roles,
    catalog: { stations: cat.stations, gates: cat.gates, bays: cat.bays, classes: cat.classes, actions: cat.actions },
    security: { ...(s.security as object), ipAllow: [] },
  } as unknown as SeedState;
}
