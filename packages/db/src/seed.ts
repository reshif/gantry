import { createHash } from "node:crypto";
import type { Tx } from "./tx.js";

/**
 * Minimal input for a development organisation, shaped like the legacy store slices. Fields not listed here
 * are carried inside jsonb `data` columns unchanged. Timestamps are epoch milliseconds, as in the legacy store.
 */
export interface SeedRole { id: string; name?: string; level?: "factory" | "project"; custom?: boolean; base?: string | null; desc?: string }
export interface SeedPerson {
  id: string; name: string; title?: string; email: string; github?: string; status?: string; mfa?: boolean; oncall?: boolean;
  away?: unknown; teams?: string[]; roles?: { role: string; scope: string }[];
  /** Any other legacy field (invitedBy, invitedAt, ...) is kept in people.data. */
  [extra: string]: unknown;
}
export interface SeedProject {
  id: string; key: string; name: string; desc?: string; status?: string; teams?: string[]; owner?: string; template?: string;
  regulated?: boolean; overlay?: string; halted?: unknown; killed?: unknown; created?: number;
  flow?: unknown; approvers?: Record<string, unknown>; notifications?: { id?: string; event: string; dest?: unknown; template?: string; cond?: unknown; fields?: unknown; enabled?: boolean }[];
  mcp?: string[]; budget?: { monthly?: number; mtd?: number; alertAt?: number };
  /** Any other legacy field (guidelines, ...) is kept in projects.config.extra. */
  [extra: string]: unknown;
}
export interface SeedRepo {
  id: string; name: string; project: string; team?: string; tags?: string[]; lang?: string; halted?: unknown; freeze?: boolean;
  guidelines?: string; config?: { defaultBranch?: string; branchPrefix?: string; merge?: string; tagging?: string; requiredChecks?: string[]; protectedPaths?: string[] };
  onboarding?: { stage?: string; readyAt?: number; blocker?: string; timeline?: unknown[]; [extra: string]: unknown };
  /** Any other legacy field (mcp, notifyOverrides, triggers, source, ...) is kept in repos.data. */
  [extra: string]: unknown;
}
export interface SeedAgent {
  id: string; name: string; station?: string | null; status?: string; instructions?: string; model?: string; skills?: string[];
  versions?: { v: string; at?: number; note?: string; rc?: boolean; live?: boolean }[];
}
export interface SeedSkill {
  id: string; name: string; desc?: string; projects?: unknown; body?: string; versions?: { v: string; at?: number; by?: string; note?: string }[];
}
export interface SeedVendor {
  id: string; name: string; product?: string; connected?: boolean; keyMask?: string; region?: string; endpoint?: string; residency?: string;
  budget?: number; models?: { id: string; name: string; enabled?: boolean; context?: number; inPrice?: number; outPrice?: number }[];
}
export interface SeedState {
  org: { id: string; name: string; plant?: string; tz?: string };
  roles?: SeedRole[];
  teams?: { id: string; name: string; desc?: string; [extra: string]: unknown }[];
  people?: SeedPerson[];
  projects?: SeedProject[];
  repos?: SeedRepo[];
  agents?: SeedAgent[];
  skills?: SeedSkill[];
  vendors?: SeedVendor[];
  templates?: { id: string; name: string; desc?: string; builtIn?: boolean; [extra: string]: unknown }[];
  policies?: { id: string; name?: string; kind?: string; effect?: string; enabled?: boolean; [extra: string]: unknown }[];
  /** roleId -> actionId -> allowed */
  matrix?: Record<string, Record<string, boolean>>;
  routing?: unknown;
  security?: unknown;
  instructions?: { base: string };
  freezes?: { id: string; name?: string; reason?: string; project?: string; repos?: "all" | string[]; by?: string; from?: number; to?: number }[];
  /** Factory-wide kill, if any (becomes an active factory stop). */
  factory?: { killed?: { by: string; at: number; reason: string; mode?: string } | null };
  /** Ordered catalogue (built-in plus custom stations, gates, bays, classes and actions). Stored in orgs.settings.catalog. */
  catalog?: { stations?: unknown[]; gates?: unknown[]; bays?: unknown[]; classes?: unknown[]; actions?: unknown[] };
}

const at = (ms: number | undefined): Date | null => (ms === undefined ? null : new Date(ms));
const j = (v: unknown) => JSON.stringify(v ?? null);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const micros = (usd: number | undefined) => Math.round((usd ?? 0) * 1_000_000);

/** Inserts a dev org and returns its id. Idempotent on the org slug: an existing org is returned untouched. Runs in the caller's transaction (as an owner or app role with write access). */
export async function seedDevOrg(tx: Tx, state: SeedState): Promise<{ orgId: string; created: boolean }> {
  const ins = await tx.query<{ id: string }>(
    `insert into orgs (slug, name, plant, tz, settings) values ($1, $2, $3, $4, $5::jsonb) on conflict (slug) do nothing returning id`,
    [state.org.id, state.org.name, state.org.plant ?? null, state.org.tz ?? "UTC", j(state.catalog ? { catalog: state.catalog } : {})],
  );
  if (!ins.rows[0]) {
    const { rows } = await tx.query<{ id: string }>(`select id from orgs where slug = $1`, [state.org.id]);
    return { orgId: rows[0]!.id, created: false };
  }
  const org = ins.rows[0].id;
  const q = (sql: string, params: unknown[]) => tx.query(sql, params);

  for (const t of state.teams ?? []) await q(`insert into teams (org_id, id, name, description, data) values ($1,$2,$3,$4,$5::jsonb)`, [org, t.id, t.name, t.desc ?? "", j(rest(t, ["id", "name", "desc"]))]);

  // roles: declared ones, plus any role the matrix or assignments mention
  const roleIds = new Map<string, SeedRole>();
  for (const r of state.roles ?? []) roleIds.set(r.id, r);
  for (const id of Object.keys(state.matrix ?? {})) if (!roleIds.has(id)) roleIds.set(id, { id });
  for (const p of state.people ?? []) for (const r of p.roles ?? []) if (!roleIds.has(r.role)) roleIds.set(r.role, { id: r.role });
  for (const r of roleIds.values()) {
    const factory = r.level ? r.level === "factory" : (state.people ?? []).some((p) => p.roles?.some((x) => x.role === r.id && x.scope === "factory"));
    await q(`insert into roles (org_id, id, name, level, builtin, description, data) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [org, r.id, r.name ?? r.id.replace(/_/g, " "), factory ? "factory" : "project", !r.custom, r.desc ?? "", j({ base: r.base ?? null })]);
  }
  if (state.matrix) {
    await q(`insert into role_matrix_versions (org_id, version, matrix, note, published_at, published_by) values ($1,1,$2::jsonb,'Seeded', now(), 'system')`, [org, j(state.matrix)]);
  }

  for (const p of state.people ?? []) {
    await q(
      `insert into people (org_id, id, name, title, email, github_login, status, mfa, oncall, away, data) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,
      [org, p.id, p.name, p.title ?? "", p.email, p.github ?? null, p.status ?? "active", p.mfa ?? false, p.oncall ?? false, p.away ? j(p.away) : null,
        j(rest(p, ["id", "name", "title", "email", "github", "status", "mfa", "oncall", "away", "teams", "roles"]))],
    );
    for (const t of p.teams ?? []) await q(`insert into team_members (org_id, team_id, person_id) values ($1,$2,$3)`, [org, t, p.id]);
  }

  for (const t of state.templates ?? []) {
    await q(`insert into templates (org_id, id, name, description, builtin, body) values ($1,$2,$3,$4,$5,$6::jsonb)`, [org, t.id, t.name, t.desc ?? "", t.builtIn ?? false, j(t)]);
  }

  for (const [position, pr] of (state.projects ?? []).entries()) {
    await q(
      `insert into projects (org_id, id, key, name, description, status, owner_id, template_id, regulated, overlay, halted, killed, config, created_at, position)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb, coalesce($14::timestamptz, now()), $15)`,
      [org, pr.id, pr.key, pr.name, pr.desc ?? "", pr.status ?? "new", pr.owner ?? null, pr.template ?? null, pr.regulated ?? false, pr.overlay ?? "",
        null, null, j({ mcp: pr.mcp ?? [], mtd: pr.budget?.mtd ?? 0, extra: rest(pr, PROJECT_COLUMNS) }), at(pr.created), position],
    );
    await seedStop(q, org, "project", pr.id, pr.killed ? "kill" : pr.halted ? "halt" : null, pr.killed ?? pr.halted);
    for (const t of pr.teams ?? []) await q(`insert into project_teams (org_id, project_id, team_id) values ($1,$2,$3)`, [org, pr.id, t]);
    if (pr.flow) {
      await q(`insert into flow_versions (org_id, project_id, version, doc, note, published_at, published_by) values ($1,$2,1,$3::jsonb,'Seeded', now(), 'system')`, [org, pr.id, j(pr.flow)]);
      await q(`update projects set current_flow_version = 1 where org_id = $1 and id = $2`, [org, pr.id]);
    }
    for (const [gate, rule] of Object.entries(pr.approvers ?? {})) {
      await q(`insert into approver_rules (org_id, project_id, gate_id, current_version) values ($1,$2,$3,1)`, [org, pr.id, gate]);
      await q(`insert into approver_rule_versions (org_id, project_id, gate_id, version, rule, note, published_at, published_by) values ($1,$2,$3,1,$4::jsonb,'Seeded', now(), 'system')`, [org, pr.id, gate, j(rule)]);
    }
    const flowGates = (pr.flow as { gates?: Record<string, { enabled?: boolean; mode?: string; absent?: boolean }> } | undefined)?.gates ?? {};
    for (const [gate, g] of Object.entries(flowGates)) {
      if (g.absent || !g.mode) continue;
      await q(`insert into gate_modes (org_id, project_id, gate_id, mode, enabled) values ($1,$2,$3,$4,$5)`, [org, pr.id, gate, g.mode, g.enabled ?? true]);
    }
    let n = 0;
    for (const r of pr.notifications ?? []) {
      n += 1;
      await q(`insert into notification_routes (org_id, id, project_id, event, destinations, template, conditions, fields, enabled) values ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9)`,
        [org, `${pr.id}:${r.id ?? `NR-${n}`}`, pr.id, r.event, j(r.dest ?? []), r.template ?? "", j(r.cond ?? {}), j(r.fields ?? {}), r.enabled ?? true]);
    }
    if (pr.budget) await q(`insert into budgets (org_id, project_id, monthly_limit_micros, alert_at) values ($1,$2,$3,$4)`, [org, pr.id, micros(pr.budget.monthly), pr.budget.alertAt ?? 0.8]);
    if (pr.overlay) {
      await q(`insert into instruction_versions (org_id, scope, scope_id, version, body, hash, note, published_at, published_by) values ($1,'project',$2,1,$3,$4,'Seeded', now(), 'system')`, [org, pr.id, pr.overlay, sha(pr.overlay)]);
    }
  }

  // assignments and project membership from each person's roles
  const members = new Set<string>();
  let ra = 0;
  for (const p of state.people ?? []) {
    for (const r of p.roles ?? []) {
      ra += 1;
      const factory = r.scope === "factory";
      await q(`insert into role_assignments (org_id, id, person_id, role_id, scope_type, project_id, granted_by) values ($1,$2,$3,$4,$5,$6,'system')`, [org, `ra-${ra}`, p.id, r.role, factory ? "factory" : "project", factory ? null : r.scope]);
      if (!factory && !members.has(`${r.scope}/${p.id}`)) {
        members.add(`${r.scope}/${p.id}`);
        await q(`insert into project_members (org_id, project_id, person_id) values ($1,$2,$3)`, [org, r.scope, p.id]);
      }
    }
  }

  for (const rp of state.repos ?? []) {
    const c = rp.config ?? {};
    await q(
      `insert into repos (org_id, id, project_id, team_id, name, lang, tags, onboarding_stage, halted, frozen, ready_at, guidelines, data)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb)`,
      [org, rp.id, rp.project, rp.team ?? null, rp.name, rp.lang ?? "", rp.tags ?? [], rp.onboarding?.stage ?? "connected", null, rp.freeze ?? false,
        at(rp.onboarding?.readyAt), rp.guidelines ?? "", j(rest(rp, ["id", "name", "project", "team", "tags", "lang", "halted", "freeze", "guidelines", "config"]))],
    );
    await seedStop(q, org, "repo", rp.id, rp.halted ? "halt" : null, rp.halted);
    await q(
      `insert into repo_config (org_id, repo_id, default_branch, branch_prefix, merge_strategy, tagging, required_checks, protected_paths) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [org, rp.id, c.defaultBranch ?? "main", c.branchPrefix ?? "gantry/", c.merge ?? "squash", c.tagging ?? "semver-patch", c.requiredChecks ?? [], c.protectedPaths ?? []],
    );
  }

  for (const s of state.skills ?? []) {
    const versions = s.versions?.length ? s.versions : [{ v: "1.0.0" }];
    await q(`insert into skills (org_id, id, name, description, projects, live_version, data) values ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`, [org, s.id, s.name, s.desc ?? "", j(s.projects ?? "all"), versions.length, j({})]);
    for (const [i, v] of versions.entries()) {
      await q(`insert into skill_versions (org_id, skill_id, version, body, content_hash, note, published_at, published_by) values ($1,$2,$3,$4::jsonb,$5,$6, coalesce($7::timestamptz, now()), $8)`,
        [org, s.id, i + 1, j({ label: v.v, body: s.body ?? "" }), sha(s.body ?? ""), v.note ?? "", at(v.at), v.by ?? "system"]);
    }
  }

  for (const a of state.agents ?? []) {
    const versions = a.versions?.length ? a.versions : [{ v: "1.0.0" }];
    const liveIdx = versions.findIndex((v) => "live" in v && v.live);
    const live = (liveIdx >= 0 ? liveIdx : versions.length - 1) + 1;
    await q(`insert into agents (org_id, id, name, station, status, live_version) values ($1,$2,$3,$4,$5,$6)`, [org, a.id, a.name, a.station ?? null, a.status ?? "active", live]);
    for (const [i, v] of versions.entries()) {
      await q(
        `insert into agent_versions (org_id, agent_id, version, body, harness_version, instruction_hash, model_id, note, published_at, published_by)
         values ($1,$2,$3,$4::jsonb,'', $5, $6, $7, coalesce($8::timestamptz, now()), 'system')`,
        [org, a.id, i + 1, j({ label: v.v, instructions: a.instructions ?? "", skills: a.skills ?? [], rc: "rc" in v ? !!v.rc : false }), sha(a.instructions ?? ""), a.model ?? null, v.note ?? "", at(v.at)],
      );
    }
    for (const sk of a.skills ?? []) await q(`insert into agent_skills (org_id, agent_id, skill_id) values ($1,$2,$3)`, [org, a.id, sk]);
  }

  for (const v of state.vendors ?? []) {
    await q(`insert into vendors (org_id, id, name, product, connected, endpoint, region, residency, secret_mask, monthly_budget_micros) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [org, v.id, v.name, v.product ?? "", v.connected ?? false, v.endpoint ?? "", v.region ?? "", v.residency ?? "", v.keyMask ?? null, v.budget === undefined ? null : micros(v.budget)]);
    for (const m of v.models ?? []) {
      await q(`insert into models (org_id, id, vendor_id, name, enabled, context_tokens, data) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [org, m.id, v.id, m.name, m.enabled ?? true, m.context ?? 0, j({ inPrice: m.inPrice ?? 0, outPrice: m.outPrice ?? 0 })]);
    }
  }
  if (state.routing) await q(`insert into routing_versions (org_id, version, body, note, published_at, published_by) values ($1,1,$2::jsonb,'Seeded', now(), 'system')`, [org, j(state.routing)]);
  if (state.vendors?.length) {
    const prices = Object.fromEntries(state.vendors.flatMap((v) => (v.models ?? []).map((m) => [m.id, { in: m.inPrice ?? 0, out: m.outPrice ?? 0 }])));
    await q(`insert into price_versions (org_id, version, body, note, published_at, published_by) values ($1,1,$2::jsonb,'Seeded', now(), 'system')`, [org, j(prices)]);
  }

  for (const p of state.policies ?? []) {
    await q(`insert into policies (org_id, id, name, kind, enabled, current_version) values ($1,$2,$3,$4,$5,1)`, [org, p.id, p.name ?? p.id, p.kind ?? p.effect ?? "access", p.enabled ?? true]);
    await q(`insert into policy_versions (org_id, policy_id, version, body, note, published_at, published_by) values ($1,$2,1,$3::jsonb,'Seeded', now(), 'system')`, [org, p.id, j(p)]);
  }
  for (const f of state.freezes ?? []) {
    await q(`insert into freezes (org_id, id, scope_type, project_id, name, reason, starts_at, ends_at, created_by, data) values ($1,$2,$3,$4,$5,$6, coalesce($7::timestamptz, now()), $8, $9, $10::jsonb)`,
      [org, f.id, f.project ? "project" : "factory", f.project ?? null, f.name ?? "", f.reason ?? "", at(f.from), at(f.to), f.by ?? null, j({ repos: f.repos ?? null })]);
  }
  if (state.security) await q(`insert into security_settings (org_id, version, body, note, published_at, published_by) values ($1,1,$2::jsonb,'Seeded', now(), 'system')`, [org, j(state.security)]);
  if (state.instructions) {
    await q(`insert into instruction_versions (org_id, scope, scope_id, version, body, hash, note, published_at, published_by) values ($1,'base','',1,$2,$3,'Seeded', now(), 'system')`, [org, state.instructions.base, sha(state.instructions.base)]);
  }
  const fk = state.factory?.killed;
  if (fk) {
    await q(`update orgs set factory_stop = $2::jsonb where id = $1`, [org, j(fk)]);
    await seedStop(q, org, "factory", null, "kill", fk);
  }
  return { orgId: org, created: true };
}

const PROJECT_COLUMNS = ["id", "key", "name", "desc", "status", "owner", "template", "regulated", "overlay", "halted", "killed", "created", "teams", "flow", "approvers", "notifications", "mcp", "budget"];

function rest(o: object, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
}

/** A halt or kill present in the seed becomes an active row in `stops`, the one source of stop state. */
async function seedStop(
  q: (sql: string, params: unknown[]) => Promise<unknown>,
  org: string,
  scope: "factory" | "project" | "repo",
  target: string | null,
  mode: "halt" | "kill" | null,
  info: unknown,
): Promise<void> {
  if (!mode || !info) return;
  const i = info as { by?: string; at?: number; reason?: string; mode?: string };
  const id = `${scope}:${target ?? "factory"}:1`;
  await q(
    `insert into stops (org_id, id, scope_type, project_id, repo_id, mode, reason, in_flight, set_by, set_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10::timestamptz, now()))`,
    [org, id, scope, scope === "project" ? target : null, scope === "repo" ? target : null, mode, i.reason ?? "", mode === "kill" ? i.mode ?? "hold" : null, i.by ?? "system", i.at === undefined ? null : new Date(i.at)],
  );
}
