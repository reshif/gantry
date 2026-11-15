import { DEFAULT_CATALOG, TEMPLATES_SEED, defaultMatrix, devSeed } from "@gantry/domain";
import { appendEvent, seedDevOrg, withTx, type SeedState } from "@gantry/db";
import type pg from "pg";
import type { Config } from "./config.js";
import { DEFAULT_SECURITY } from "./read/index.js";
import { seedDemoAudit } from "../areas/audit/seed.js";
import { ensureDefaultModel } from "../areas/models/default.js";
import { loadStarterKit, upgradeOnboardingAgent } from "../areas/agents/starter-kit.js";

export interface BootResult {
  orgId: string;
  seeded: boolean;
}

/**
 * Makes sure the organisation exists and has the rows every request relies on: built-in roles, the default matrix, security
 * settings, the ordered catalogue and the built-in project templates. Idempotent: nothing already present is changed. With GANTRY_DEV_SEED=true the legacy dev
 * seed is loaded first, and only if the organisation does not exist yet. Without it the org starts empty: just the roles, built-in templates,
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
    // Built-in roles, including ones added to the catalogue after this org was created (Factory Manager, Security Reviewer): inserted when
    // missing, never renamed or changed (the catalogue's roles are read from this table).
    const haveRoles = new Set((await tx.query<{ id: string }>(`select id from roles where org_id = $1`, [id])).rows.map((r) => r.id));
    const newRoles = DEFAULT_CATALOG.roles.filter((r) => !haveRoles.has(r.id));
    for (const r of newRoles) {
      await tx.query(`insert into roles (org_id, id, name, level, builtin) values ($1,$2,$3,$4,true) on conflict do nothing`, [id, r.id, r.name, r.level]);
    }
    // A project needs at least one owning team, so an org with no teams at all gets one to start from (rename or replace it in People & teams).
    const anyTeam = await tx.query(`select 1 from teams where org_id = $1 limit 1`, [id]);
    if (!anyTeam.rowCount) {
      await tx.query(`insert into teams (org_id, id, name, description) values ($1,'default','Default','Created with the organisation. Rename it or add your own teams.') on conflict do nothing`, [id]);
    }
    // Built-in project templates: the New project wizard starts from one, so an org without any cannot create projects.
    const tpls = await tx.query(`select 1 from templates where org_id = $1 and builtin limit 1`, [id]);
    if (!tpls.rowCount) {
      for (const t of TEMPLATES_SEED) {
        await tx.query(`insert into templates (org_id, id, name, description, builtin, body) values ($1,$2,$3,$4,true,$5::jsonb) on conflict do nothing`, [id, t.id, t.name, t.desc ?? "", JSON.stringify(t)]);
      }
    }
    // The built-in starter kit: the agents the floor's stations name, their skills and eval suites. Inserted only when missing, never overwritten.
    const kit = await loadStarterKit(tx, id);
    if (kit.length) log?.info({ agents: kit }, "starter kit loaded");
    if (await upgradeOnboardingAgent(tx, id)) log?.info({ agent: "ag-onboard" }, "onboarding agent upgraded to the authoring instructions (version 2)");
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
    // Actions added to the built-in catalogue after this org was created (e.g. the Read rights of default deny, spec 14.3): add them to the
    // org's catalogue, and publish a matrix version that carries the built-in defaults for the new actions only. Nothing existing is changed.
    const cat = ((await tx.query(`select settings->'catalog' as c from orgs where id = $1`, [id])).rows[0]?.c ?? null) as { actions?: Array<{ id: string }> } | null;
    const missing = cat?.actions ? DEFAULT_CATALOG.actions.filter((a) => !cat.actions!.some((x) => x.id === a.id)) : [];
    if (missing.length) {
      await tx.query(`update orgs set settings = jsonb_set(settings, '{catalog,actions}', (settings->'catalog'->'actions') || $2::jsonb) where id = $1`, [id, JSON.stringify(missing)]);
    }
    const cur = (await tx.query(`select version, matrix from role_matrix_versions where org_id = $1 and published_at is not null order by version desc limit 1`, [id])).rows[0] as { version: number; matrix: Record<string, Record<string, boolean>> } | undefined;
    if (cur) {
      const defaults = defaultMatrix();
      const next: Record<string, Record<string, boolean>> = {};
      let changed = false;
      const addedIds = new Set<string>();
      // a built-in role new to this org starts from its defaults (an empty row, so the loop below fills every cell)
      for (const role of Object.keys(defaults)) if (!(role in cur.matrix) && newRoles.some((r) => r.id === role)) cur.matrix[role] = {};
      for (const [role, cells] of Object.entries(cur.matrix)) {
        next[role] = { ...cells };
        for (const a of DEFAULT_CATALOG.actions) {
          if (!(a.id in cells) && defaults[role]?.[a.id] !== undefined) {
            next[role]![a.id] = defaults[role]![a.id]!;
            changed = true;
            addedIds.add(a.id);
          }
        }
      }
      if (changed) {
        await tx.query(`insert into role_matrix_versions (org_id, version, matrix, note, published_at, published_by) values ($1,$2,$3::jsonb,'New built-in actions or roles added with their defaults', now(), 'system')`, [id, cur.version + 1, JSON.stringify(next)]);
        await appendEvent(tx, { orgId: id, type: "matrix.defaults", category: "access", actor: "system", channel: "system", subject: { type: "matrix", id: String(cur.version + 1) }, after: { added: [...addedIds], roles: newRoles.map((r) => r.id), note: "built-in defaults for new actions and roles; existing cells unchanged" } });
      }
    }
    // A connected vendor with callable enabled models but no routing default (connected before the default was set automatically): set one now.
    const auto = await ensureDefaultModel(tx, id, "startup");
    if (auto) log?.info({ model: auto }, "routing default set");
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
