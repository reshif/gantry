import type {
  Action, Away, Catalog, Freeze, KillInfo, HaltInfo, Matrix, Org, Person, Policy, Project, ProjectFlow, Repo, Role, SecuritySettings, Team, Template,
} from "@gantry/domain";
import { ACTIONS, DEFAULT_CATALOG, actionScopeOf, defaultMatrix } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { ms, num, obj, reads } from "./rows.js";

/**
 * Read model: rows -> the legacy `G.store` shapes the frontend reads (docs/BUILD.md "The API contract").
 * Each function owns one slice. Route modules call these; they never re-interpret raw rows.
 */

/* ---------------------------------------------------------------- org ------ */

export interface OrgRow extends Org {
  uuid: string;
  version: number;
  factoryStop: unknown;
  settings: Record<string, unknown>;
}

export async function readOrg(db: Queryable, orgId: string): Promise<OrgRow> {
  const { rows } = await db.query(`select id, slug, name, plant, tz, factory_stop, settings, version from orgs where id = $1`, [orgId]);
  const r = rows[0];
  if (!r) throw new Error(`org ${orgId} not found`);
  return { uuid: r.id, id: r.slug, name: r.name, plant: r.plant ?? "", tz: r.tz, version: r.version, factoryStop: r.factory_stop, settings: obj(r.settings) };
}

/* ---------------------------------------------------------------- stops ---- */

export interface ActiveStop {
  id: string;
  scope: "factory" | "project" | "repo" | "wo";
  project: string | null;
  repo: string | null;
  wo: string | null;
  mode: "halt" | "kill";
  reason: string;
  cause: string;
  inFlight: "hold" | "cancel" | null;
  by: string;
  at: number;
  version: number;
}

/** Active (not lifted) stops. The `stops` table is the one source of stop state. */
export async function readActiveStops(db: Queryable, orgId: string): Promise<ActiveStop[]> {
  const { rows } = await db.query(
    `select id, scope_type, project_id, repo_id, wo_id, mode, reason, cause, in_flight, set_by, set_at, version from stops where org_id = $1 and lifted_at is null order by set_at, id`,
    [orgId],
  );
  return rows.map((r) => ({
    id: r.id, scope: r.scope_type, project: r.project_id, repo: r.repo_id, wo: r.wo_id, mode: r.mode, reason: r.reason, cause: String(r.cause ?? "manual"),
    inFlight: r.in_flight === "cancel" ? "cancel" : r.in_flight === "hold" ? "hold" : null, by: r.set_by, at: ms(r.set_at) ?? 0, version: r.version,
  }));
}

export const killInfo = (s: ActiveStop): KillInfo => ({ by: s.by, at: s.at, reason: s.reason, scope: s.scope === "wo" ? "workorder" : s.scope, mode: s.inFlight ?? "hold" });
export const haltInfo = (s: ActiveStop): HaltInfo => ({ by: s.by, at: s.at, reason: s.reason, cause: s.cause });

/* ---------------------------------------------------------------- people --- */

export async function readPeople(db: Queryable, orgId: string): Promise<Person[]> {
  const { rows } = await db.query(
    `select p.id, p.name, p.title, p.email, p.github_login, p.status, p.mfa, p.away, p.data, p.version,
       (exists (select 1 from projects pr where pr.org_id = p.org_id and pr.config -> 'oncall' ? p.id)
         or exists (select 1 from role_assignments fa where fa.org_id = p.org_id and fa.person_id = p.id and fa.role_id = 'factory_admin' and fa.project_id is null and fa.revoked_at is null)) as oncall,
       coalesce((select jsonb_agg(jsonb_build_object('role', ra.role_id, 'scope', coalesce(ra.project_id, 'factory')) || case when ra.via_team is null then '{}'::jsonb else jsonb_build_object('via', ra.via_team) end order by (ra.via_team is not null), ra.created_at, ra.id)
                 from effective_role_assignments ra where ra.org_id = p.org_id and ra.person_id = p.id and ra.revoked_at is null and (ra.expires_at is null or ra.expires_at > now())), '[]'::jsonb) as roles,
       coalesce((select array_agg(tm.team_id order by tm.created_at, tm.team_id) from team_members tm where tm.org_id = p.org_id and tm.person_id = p.id), '{}') as teams
     from people p where p.org_id = $1 order by p.created_at, p.id`,
    [orgId],
  );
  return rows.map((r) => ({
    ...obj(r.data),
    id: r.id, name: r.name, title: r.title, email: r.email, teams: r.teams, roles: r.roles, status: r.status, oncall: r.oncall,
    github: r.github_login ?? "", away: (r.away as Away | null) ?? null, mfa: r.mfa, version: r.version,
  }) as Person);
}

export async function readTeams(db: Queryable, orgId: string): Promise<Team[]> {
  const { rows } = await db.query(`select id, name, description, data from teams where org_id = $1 order by created_at, id`, [orgId]);
  const grants = await db.query(
    `select id, team_id, role_id, project_id, granted_by, expires_at from team_role_assignments where org_id = $1 and revoked_at is null and (expires_at is null or expires_at > now()) order by created_at, id`,
    [orgId],
  );
  return rows.map(
    (r) =>
      ({
        ...obj(r.data), id: r.id, name: r.name, desc: r.description,
        roles: grants.rows.filter((g) => g.team_id === r.id).map((g) => ({ id: g.id, role: g.role_id, scope: g.project_id ?? "factory", grantedBy: g.granted_by ?? null, expiresAt: g.expires_at ? new Date(g.expires_at).getTime() : null })),
      }) as Team,
  );
}

/* ---------------------------------------------------------------- projects -- */

export async function readProjects(db: Queryable, orgId: string, stops?: ActiveStop[]): Promise<Project[]> {
  const [pr, teams, flows, rules, notes, budgets, gl, st, spend] = await reads(db, [
    () => db.query(`select id, key, name, description, status, owner_id, template_id, regulated, overlay, config, created_at, version from projects where org_id = $1 order by position nulls last, created_at, id`, [orgId]),
    () => db.query(`select project_id, team_id from project_teams where org_id = $1 order by created_at, team_id`, [orgId]),
    () => db.query(`select f.project_id, f.doc, f.version from flow_versions f join projects p on p.org_id = f.org_id and p.id = f.project_id and p.current_flow_version = f.version where f.org_id = $1`, [orgId]),
    () =>
      db.query(
        `select r.project_id, r.gate_id, v.rule from approver_rules r join approver_rule_versions v on v.org_id = r.org_id and v.project_id = r.project_id and v.gate_id = r.gate_id and v.version = r.current_version where r.org_id = $1 order by r.created_at, r.gate_id`,
        [orgId],
      ),
    () => db.query(`select id, project_id, event, destinations, template, conditions, fields, enabled from notification_routes where org_id = $1 and project_id is not null order by created_at, id`, [orgId]),
    () => db.query(`select project_id, monthly_limit_micros, alert_at from budgets where org_id = $1`, [orgId]),
    // The project's onboarding guidelines (spec 8.6): every published version, newest last.
    () => db.query(`select project_id, version, body, note, published_at, published_by from guideline_versions where org_id = $1 and scope = 'project' and published_at is not null order by project_id, version`, [orgId]),
    () => (stops ? Promise.resolve(stops) : readActiveStops(db, orgId)),
    // Month to date is metered spend, never the figure a project's config once carried: every metered call that names the project counts (station runs, console turns, side threads).
    // The same sum (UTC month) drives the budget gate and the 80% alert, so the number shown and the number acted on cannot differ.
    () => db.query(`select project_id, coalesce(sum(cost_micros), 0)::text as micros from usage_meter where org_id = $1 and project_id is not null and at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' group by project_id`, [orgId]),
  ]);
  const stopList = st;
  return pr.rows.map((r) => {
    const cfg = obj(r.config);
    const b = budgets.rows.find((x) => x.project_id === r.id);
    const flow = flows.rows.find((x) => x.project_id === r.id)?.doc as ProjectFlow | undefined;
    const kill = stopList.find((s) => s.scope === "project" && s.project === r.id && s.mode === "kill");
    const halt = stopList.find((s) => s.scope === "project" && s.project === r.id && s.mode === "halt");
    return {
      ...obj(cfg.extra),
      id: r.id, name: r.name, key: r.key, status: r.status,
      teams: teams.rows.filter((x) => x.project_id === r.id).map((x) => x.team_id),
      owner: r.owner_id ?? "", template: r.template_id ?? "", regulated: r.regulated, desc: r.description,
      flow: flow ?? emptyFlow(),
      approvers: Object.fromEntries(rules.rows.filter((x) => x.project_id === r.id).map((x) => [x.gate_id, x.rule])),
      notifications: notes.rows.filter((x) => x.project_id === r.id).map((x) => ({
        id: String(x.id).slice(String(r.id).length + 1), event: x.event, dest: x.destinations, template: x.template, cond: x.conditions, enabled: x.enabled, fields: x.fields,
      })),
      mcp: Array.isArray(cfg.mcp) ? cfg.mcp : [],
      oncall: Array.isArray(cfg.oncall) ? (cfg.oncall as unknown[]).filter((x): x is string => typeof x === "string") : [],
      budget: { monthly: b ? Math.round(num(b.monthly_limit_micros) / 1_000_000) : 0, mtd: num(spend.rows.find((x) => x.project_id === r.id)?.micros) / 1_000_000, alertAt: b ? num(b.alert_at) : 0.8 },
      created: ms(r.created_at) ?? 0,
      halted: halt ? haltInfo(halt) : null,
      killed: kill ? killInfo(kill) : null,
      overlay: r.overlay,
      ...projectGuidelines(gl.rows.filter((x) => x.project_id === r.id)),
      version: r.version,
    } as unknown as Project;
  });
}

/** `{ guidelines }` from a project's guideline version rows, or nothing when it has none (seeded demo data may carry its own on the config). */
function projectGuidelines(rows: Array<Record<string, any>>): { guidelines?: unknown } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const last = rows.at(-1);
  if (!last) return {};
  const body = obj(last.body);
  return {
    guidelines: {
      items: Array.isArray(body.items) ? body.items : [], notes: typeof body.notes === "string" ? body.notes : "", version: last.version,
      history: rows.map((x) => ({ v: x.version, at: ms(x.published_at) ?? 0, by: x.published_by ?? "system", note: x.note })),
    },
  };
}

const emptyFlow = (): ProjectFlow => ({ stations: {}, gates: {}, slots: 0, classes: [], order: [], bays: [] });

/* ---------------------------------------------------------------- repos ----- */

export async function readRepos(db: Queryable, orgId: string, stops?: ActiveStop[]): Promise<Repo[]> {
  const [rp, st] = await reads(db, [
    () =>
      db.query(
        `select r.id, r.project_id, r.team_id, r.name, r.lang, r.tags, r.onboarding_stage, r.frozen, r.ready_at, r.guidelines, r.data, r.version,
                c.default_branch, c.branch_prefix, c.merge_strategy, c.tagging, c.required_checks, c.protected_paths
         from repos r left join repo_config c on c.org_id = r.org_id and c.repo_id = r.id where r.org_id = $1 order by r.created_at, r.id`,
        [orgId],
      ),
    () => (stops ? Promise.resolve(stops) : readActiveStops(db, orgId)),
  ]);
  return rp.rows.map((r) => {
    const data = obj(r.data);
    const ob = data.onboarding ? { ...obj(data.onboarding), stage: r.onboarding_stage, ...(r.ready_at ? { readyAt: ms(r.ready_at) } : {}) } : undefined;
    const halt = st.find((s) => s.scope === "repo" && s.repo === r.id && s.mode === "halt");
    return {
      ...data,
      id: r.id, name: r.name, project: r.project_id, team: r.team_id ?? "", tags: r.tags, lang: r.lang,
      halted: halt ? haltInfo(halt) : null,
      config: { defaultBranch: r.default_branch, branchPrefix: r.branch_prefix, merge: r.merge_strategy, tagging: r.tagging, requiredChecks: r.required_checks ?? [], protectedPaths: r.protected_paths ?? [] },
      guidelines: r.guidelines,
      ...(r.frozen ? { freeze: true } : {}),
      ...(ob ? { onboarding: ob } : {}),
      version: r.version,
    } as unknown as Repo;
  });
}

/* ---------------------------------------------------------------- templates -- */

export async function readTemplates(db: Queryable, orgId: string): Promise<Template[]> {
  const { rows } = await db.query(`select id, name, description, builtin, body, version from templates where org_id = $1 order by created_at, id`, [orgId]);
  return rows.map((r) => ({ ...obj(r.body), id: r.id, name: r.name, desc: r.description, builtIn: r.builtin, version: r.version }) as unknown as Template);
}

/* ---------------------------------------------------------------- access ----- */

export interface Versioned<T> {
  version: number;
  value: T;
}

/** Latest published matrix. An org with none gets the built-in default (read only; the first edit publishes version 1). */
export async function readMatrix(db: Queryable, orgId: string, actions: readonly Action[] = ACTIONS): Promise<Versioned<Matrix>> {
  const { rows } = await db.query(`select version, matrix from role_matrix_versions where org_id = $1 and published_at is not null order by version desc limit 1`, [orgId]);
  const r = rows[0];
  return r ? { version: r.version, value: r.matrix as Matrix } : { version: 0, value: defaultMatrix(actions) };
}

export async function readRoles(db: Queryable, orgId: string): Promise<Role[]> {
  const { rows } = await db.query(`select id, name, level, builtin, description, data, version from roles where org_id = $1 order by created_at, id`, [orgId]);
  return rows.map((r) => {
    const base = obj(r.data).base;
    return { id: r.id, name: r.name, level: r.level, ...(r.builtin ? {} : { custom: true, base: typeof base === "string" ? base : null }), ...(r.description ? { desc: r.description } : {}), version: r.version } as Role;
  });
}

export async function readPolicies(db: Queryable, orgId: string): Promise<Policy[]> {
  const { rows } = await db.query(
    `select p.id, p.name, p.enabled, p.current_version, v.body from policies p left join policy_versions v on v.org_id = p.org_id and v.policy_id = p.id and v.version = p.current_version where p.org_id = $1 and p.deleted_at is null order by p.created_at, p.id`,
    [orgId],
  );
  return rows.map((r) => ({ ...obj(r.body), id: r.id, name: r.name, enabled: r.enabled, version: r.current_version }) as unknown as Policy);
}

export async function readFreezes(db: Queryable, orgId: string): Promise<Freeze[]> {
  const { rows } = await db.query(
    `select id, name, scope_type, project_id, starts_at, ends_at, lifted_at, created_by, data, version from freezes where org_id = $1 order by created_at, id`,
    [orgId],
  );
  return rows.map((r) => {
    const repos = obj(r.data).repos;
    const to = Math.min(ms(r.ends_at) ?? Number.MAX_SAFE_INTEGER, ms(r.lifted_at) ?? Number.MAX_SAFE_INTEGER);
    return { id: r.id, name: r.name, repos: Array.isArray(repos) ? repos : "all", from: ms(r.starts_at) ?? 0, to, by: r.created_by ?? "", version: r.version } as Freeze;
  });
}

export async function readSecurity(db: Queryable, orgId: string): Promise<Versioned<SecuritySettings>> {
  const { rows } = await db.query(`select version, body from security_settings where org_id = $1 and published_at is not null order by version desc limit 1`, [orgId]);
  const r = rows[0];
  return r ? { version: r.version, value: { ...DEFAULT_SECURITY, ...(r.body as SecuritySettings) } } : { version: 0, value: DEFAULT_SECURITY };
}

export const DEFAULT_SECURITY: SecuritySettings = {
  sso: { provider: "OpenID Connect", domain: "", enforced: false, entity: "" },
  mfa: { policy: "admins", methods: [] },
  sessionHours: 12,
  idleMin: 30,
  domains: [],
  ipAllow: [],
  restoreFactoryNeedsTwo: true,
  killNeedsStepUp: true,
  stepUpWindowMinutes: 15,
  githubLogin: false,
  researchHosts: [],
  chatCapUsdPerDay: null,
};

/* ---------------------------------------------------------------- catalog ---- */

/** The catalogue: ordered stations, gates, bays, classes and actions (built-in plus custom, from orgs.settings.catalog) and the roles table. */
export async function readCatalog(db: Queryable, orgId: string, org?: OrgRow): Promise<Catalog> {
  const [o, roles] = await reads(db, [() => (org ? Promise.resolve(org) : readOrg(db, orgId)), () => readRoles(db, orgId)]);
  const c = obj(o.settings.catalog);
  const pick = <T>(k: string, dflt: T[]): T[] => (Array.isArray(c[k]) ? (c[k] as T[]) : dflt);
  return {
    stations: pick("stations", DEFAULT_CATALOG.stations),
    gates: pick("gates", DEFAULT_CATALOG.gates),
    bays: pick("bays", DEFAULT_CATALOG.bays),
    classes: pick("classes", DEFAULT_CATALOG.classes),
    roles: roles.length ? roles : DEFAULT_CATALOG.roles,
    // The scope of a built-in action is fixed by the code, not by an org's stored copy (which once carried the Read rights as project scope).
    actions: pick<Action>("actions", [...DEFAULT_CATALOG.actions]).map((a) => {
      const scope = actionScopeOf([], a.id);
      return scope && scope !== a.scope ? { ...a, scope } : a;
    }),
  };
}
