/**
 * Policy engine: `can()` decides every permission. Pure port of G.can (legacy/js/policy.js) with the
 * stop-state check of spec 9.7 and the configuration invariants of spec 5.1 / 14.4 (see invariants.ts).
 *
 *   1. Role grants in scope: factory-level roles apply everywhere; project roles only in their project.
 *   2. Role matrix: does any in-scope role allow the action?  (Extend policies can add rights.)
 *   3. Deny policies (freezes). Deny always wins.
 *   4. Conditional allow policies (release windows): if any exist for the action, one must match.
 * Gate approvals add approver rules on top: gateDecision() in flow.ts. Times are IST.
 */
import { DEFAULT_CATALOG } from "./catalog.js";
import { DAY, DAYS, HOUR, MIN, fmt, hm, ist, istTime, istToday } from "./format.js";
import type { Action, Catalog, Decision, DecisionRule, Freeze, KillInfo, Matrix, Person, Policy, PolicyWhen, Project, Repo, Role, WorkOrder } from "./types.js";

/* ------------------------------------------------------------------ state --------------- */

/** The minimal input of the permission engine. */
export interface PolicyState {
  people: Person[];
  matrix: Matrix;
  policies: Policy[];
  freezes: Freeze[];
  projects: Array<Pick<Project, "id" | "name" | "status"> & Partial<Pick<Project, "killed" | "halted" | "regulated">>>;
  repos: Array<Pick<Repo, "id" | "name" | "project"> & Partial<Pick<Repo, "halted">>>;
  /** Factory-level stop. Project, repo and work-order stops are read from their own records. */
  stops?: { factory: KillInfo | null };
  /** Role and action definitions, including custom ones. Defaults to the built-in catalogue. */
  catalog?: Pick<Catalog, "roles" | "actions">;
}

export interface PolicyContext {
  project?: string | null;
  repo?: string | null;
  /** Epoch ms of the question. Defaults to the current time. */
  time?: number;
  /** The work order the action targets, for work-order-level stops. */
  wo?: Pick<WorkOrder, "id" | "killed" | "state"> | null;
}

const MATRIX_RULE: DecisionRule = { kind: "matrix", id: "MATRIX", name: "Role matrix" };

export function rolesOf(state: PolicyState): readonly Role[] {
  return state.catalog?.roles ?? DEFAULT_CATALOG.roles;
}
export function actionsOf(state: PolicyState): readonly Action[] {
  return state.catalog?.actions ?? DEFAULT_CATALOG.actions;
}

/* ------------------------------------------------------------------ lookups ------------- */

export function findPerson(state: PolicyState, id: string | null | undefined): Person | undefined {
  return id ? state.people.find((p) => p.id === id) : undefined;
}
export function findProject(state: PolicyState, id: string | null | undefined) {
  return id ? state.projects.find((p) => p.id === id) : undefined;
}
/** Repos are found by id or by their "owner/name". */
export function findRepo(state: PolicyState, id: string | null | undefined) {
  return id ? state.repos.find((r) => r.id === id || r.name === id) : undefined;
}
function roleName(state: PolicyState, id: string): string {
  return rolesOf(state).find((r) => r.id === id)?.name ?? id;
}
function roleNames(state: PolicyState, roles: string[]): string {
  return roles.map((r) => roleName(state, r)).join(" or ");
}
export function actorName(state: PolicyState & { agents?: Array<{ id: string; name: string }>; apiKeys?: Array<{ id: string; name: string }>; triggers?: Array<{ id: string; name: string }> }, id: string | null | undefined): string {
  const p = findPerson(state, id);
  if (p) return p.name;
  const a = state.agents?.find((x) => x.id === id);
  if (a) return a.name + " (agent)";
  const k = state.apiKeys?.find((x) => x.id === id);
  if (k) return "API key " + k.name;
  const t = state.triggers?.find((x) => x.id === id);
  if (t) return "Trigger " + t.name;
  if (id === "system") return "Gantry";
  return id || "system";
}

/** Roles a person holds in a project (factory grants always apply). */
export function rolesIn(person: Person | undefined | null, projectId: string | null): string[] {
  if (!person) return [];
  return person.roles.filter((g) => g.scope === "factory" || g.scope === projectId).map((g) => g.role);
}
export function isFactoryAdmin(state: PolicyState, personId: string): boolean {
  const p = findPerson(state, personId);
  return !!p && p.roles.some((g) => g.role === "factory_admin");
}
export function visibleProjects(state: PolicyState, personId: string) {
  const p = findPerson(state, personId);
  if (!p) return [];
  const factoryWide = p.roles.some((g) => g.scope === "factory");
  return state.projects.filter((pr) => pr.status !== "archived" || factoryWide).filter((pr) => factoryWide || p.roles.some((g) => g.scope === pr.id));
}

export function activeFreeze(state: PolicyState, repoId: string, time: number): Freeze | null {
  return state.freezes.find((f) => time >= f.from && time < f.to && (f.repos === "all" || f.repos.includes(repoId))) ?? null;
}

/* ------------------------------------------------------------------ policy text --------- */

export const policyText = {
  days(days: number[] | undefined | null): string {
    if (!days || days.length === 7) return "any day";
    const s = days.slice().sort();
    const contiguous = s.every((d, i) => i === 0 || d === (s[i - 1] as number) + 1);
    if (contiguous && s.length > 2) return DAYS[s[0] as number] + "–" + DAYS[s[s.length - 1] as number];
    return s.map((d) => DAYS[d]).join(", ");
  },
  when(w: PolicyWhen | null | undefined): string {
    if (!w) return "any time";
    const d = policyText.days(w.days);
    if (w.from === "00:00" && w.to === "24:00") return d === "any day" ? "any time" : d + ", all day";
    return d + " " + w.from + "–" + w.to + " IST";
  },
  where(state: PolicyState, p: Policy): string {
    if (p.where.freeze) return "repos under an active freeze";
    if (p.where.regulated) return "regulated projects";
    if (!p.where.projects || !p.where.projects.length) return "every project";
    return p.where.projects.map((t) => findProject(state, t)?.name ?? t).join(", ");
  },
  roles(state: PolicyState, p: Policy): string {
    if (p.roles[0] === "*") return "Anyone";
    if (p.roles[0] === "agents") return "Agents";
    return p.roles.map((r) => (rolesOf(state).find((x) => x.id === r) ? roleName(state, r) + "s" : r)).join(" and ");
  },
  sentence(state: PolicyState, p: Policy): string {
    const acts = p.actions.map((a) => actionsOf(state).find((x) => x.id === a)?.name.toLowerCase() ?? a).join(", ");
    if (p.id === "POL-112") return "Agents from Plan onward may not act autonomously on regulated projects. The highest autonomy there is act with gate.";
    if (p.effect === "deny") return policyText.roles(state, p) + " may not " + acts + " on " + policyText.where(state, p) + ".";
    let s = policyText.roles(state, p) + " may " + acts + " on " + policyText.where(state, p) + ", " + policyText.when(p.when);
    if (p.oncallOnly) s += ", only while on call";
    if (p.extend) s += ". Adds this right even where the role matrix does not grant it";
    return s + (p.actions.includes("release") ? ", never during a freeze." : ".");
  },
};

/* ------------------------------------------------------------------ stop state ---------- */

export type StopMode = "kill" | "halt" | "archived";
export type StopLevel = "factory" | "project" | "repo" | "workorder";
export interface StopInfo {
  level: StopLevel;
  mode: StopMode;
  reason: string;
  kill?: KillInfo;
}

const MODE_SEVERITY: Record<StopMode, number> = { halt: 1, kill: 2, archived: 2 };
const LEVEL_ORDER: Record<StopLevel, number> = { factory: 0, project: 1, repo: 2, workorder: 3 };

/** Kill or archive in scope (legacy G.stopState). Halts are not included; see haltState. */
export function stopState(state: PolicyState, projectId: string | null | undefined, _repoId?: string | null): StopInfo | null {
  const f = state.stops?.factory;
  if (f) return { level: "factory", mode: "kill", kill: f, reason: "The factory is killed: " + f.reason + " (" + actorName(state, f.by) + ", " + fmt.stamp(f.at) + ")." };
  const p = findProject(state, projectId);
  if (p && p.killed) return { level: "project", mode: "kill", kill: p.killed, reason: p.name + " is killed: " + p.killed.reason + "." };
  if (p && p.status === "archived") return { level: "project", mode: "archived", reason: p.name + " is archived." };
  return null;
}

/** Andon halt in scope (legacy G.haltState): project first, then repo. */
export function haltState(state: PolicyState, projectId: string | null | undefined, repoId?: string | null): StopInfo | null {
  const p = findProject(state, projectId);
  if (p && p.halted) return { level: "project", mode: "halt", reason: p.name + " is halted (andon): " + p.halted.reason };
  const r = findRepo(state, repoId);
  if (r && r.halted) return { level: "repo", mode: "halt", reason: r.name + " is halted (andon): " + r.halted.reason };
  return null;
}

/**
 * The effective stop across factory, project, repo and work order (spec 9.7): the most severe wins
 * (kill and archive over halt); among equals the outermost scope is reported, because lifting an outer
 * stop never lifts an inner one and the outer one must be lifted first.
 */
export function effectiveStop(state: PolicyState, scope: { project?: string | null; repo?: string | null; wo?: Pick<WorkOrder, "id" | "killed" | "state"> | null }): StopInfo | null {
  const found: StopInfo[] = [];
  const kill = stopState(state, scope.project, scope.repo);
  if (kill) found.push(kill);
  const p = findProject(state, scope.project);
  if (p && p.halted) found.push({ level: "project", mode: "halt", reason: p.name + " is halted (andon): " + p.halted.reason });
  const r = findRepo(state, scope.repo);
  if (r && r.halted) found.push({ level: "repo", mode: "halt", reason: r.name + " is halted (andon): " + r.halted.reason });
  const w = scope.wo;
  if (w && (w.killed || w.state === "killed")) found.push({ level: "workorder", mode: "kill", reason: w.id + " is killed" + (w.killed ? ": " + w.killed.reason + "." : "."), ...(w.killed ? { kill: w.killed } : {}) });
  if (!found.length) return null;
  found.sort((a, b) => MODE_SEVERITY[b.mode] - MODE_SEVERITY[a.mode] || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  return found[0] as StopInfo;
}

/** Stop controls and reads keep working in a stopped scope (I7). */
const STOP_EXEMPT = new Set(["project.view", "audit.view", "line.halt", "line.resume", "kill.workorder", "restore.workorder", "kill.project", "restore.project", "kill.factory", "restore.factory"]);
/** A halt blocks gate progression, merges and moves; a kill or archive blocks all stoppable work. */
const HALT_BLOCKS = new Set(["gate.approve", "release", "onboarding.merge", "wo.move", "brief.confirm"]);
const STOPPABLE_GROUPS = new Set(["Work", "Gates", "Onboarding"]);

/** Does this stop refuse this action? */
export function stopBlocks(state: PolicyState, action: string, stop: StopInfo): boolean {
  if (STOP_EXEMPT.has(action)) return false;
  const act = actionsOf(state).find((a) => a.id === action);
  if (!act || act.scope !== "project" || !STOPPABLE_GROUPS.has(act.group)) return false;
  return stop.mode === "halt" ? HALT_BLOCKS.has(action) : true;
}

/* ------------------------------------------------------------------ can() --------------- */

function whenOk(q: Policy, t: { day: number; mins: number }): boolean {
  return !q.when || (q.when.days.includes(t.day) && t.mins >= hm(q.when.from) && t.mins < hm(q.when.to));
}
function whereOk(q: Policy, projectId: string | null): boolean {
  return !projectId || !q.where.projects || !q.where.projects.length || q.where.projects.includes(projectId);
}

/** Actions a Factory Admin keeps even if the matrix is damaged (I7): stopping and restoring. */
const ADMIN_ALWAYS = new Set(["line.halt", "line.resume", "kill.workorder", "restore.workorder", "kill.project", "restore.project", "kill.factory", "restore.factory"]);

export function can(state: PolicyState, personId: string | null | undefined, action: string, ctx: PolicyContext = {}): Decision {
  const matrix = state.matrix;
  const person = findPerson(state, personId);
  const act = actionsOf(state).find((a) => a.id === action);
  const time = ctx.time ?? Date.now();
  const repo = ctx.repo ? findRepo(state, ctx.repo) : undefined;
  const projectId = ctx.project || repo?.project || null;
  const project = projectId ? findProject(state, projectId) : undefined;
  if (!person) return { allowed: false, reason: "Not signed in.", rule: MATRIX_RULE, needs: "Sign in" };
  if (person.status !== "active") return { allowed: false, reason: person.name + " has not accepted the invite yet.", rule: MATRIX_RULE, needs: "Accepted invite" };

  const scoped = act?.scope === "project";
  const grants = person.roles.filter((g) => g.scope === "factory" || !scoped || !projectId || g.scope === projectId);
  const granting = grants.filter((g) => matrix[g.role]?.[action]);
  const heldRoles = grants.map((g) => g.role);
  const t = ist(time);

  /* spec 9.7: stop state of the scope refuses work; stop controls themselves are exempt (I7) */
  const stop = effectiveStop(state, { project: projectId, repo: ctx.repo ?? null, wo: ctx.wo ?? null });
  /* an archived project is not a stop: only kill and andon halt refuse work here (archived is handled by submitGuard and moveCheck) */
  if (stop && stop.mode !== "archived" && granting.length && stopBlocks(state, action, stop)) {
    return { allowed: false, reason: stop.reason, rule: { kind: "stop", id: "STOP-" + stop.level.toUpperCase(), name: "Stop state" }, needs: stop.mode === "halt" ? "Resume first" : "Restore first" };
  }

  if (!granting.length) {
    const ext = state.policies.filter((p) => p.enabled && p.extend && p.effect === "allow" && p.actions.includes(action));
    const hit = ext.find((q) => q.roles.some((r) => heldRoles.includes(r)) && whereOk(q, projectId) && whenOk(q, t) && (!q.oncallOnly || person.oncall));
    if (hit) return { allowed: true, reason: "Allowed by " + hit.id + " '" + hit.name + "'.", rule: { kind: "policy", id: hit.id, name: hit.name }, needs: "" };
    /* I7: a Factory Admin can always halt, kill and restore, even if the matrix is damaged */
    if (ADMIN_ALWAYS.has(action) && person.roles.some((g) => g.role === "factory_admin" && g.scope === "factory")) {
      return { allowed: true, reason: "Factory Admin can always halt, kill and restore.", rule: { kind: "invariant", id: "I7", name: "Stop commands always work" }, needs: "" };
    }
    let rolesWith = rolesOf(state).filter((r) => matrix[r.id]?.[action] && r.id !== "factory_admin").map((r) => r.id);
    if (!rolesWith.length) rolesWith = ["factory_admin"];
    const needs = "Needs " + roleNames(state, rolesWith.slice(0, 2)) + (scoped && project ? " on " + project.name : "");
    const outOfScope = person.roles.some((g) => matrix[g.role]?.[action]);
    let reason = outOfScope
      ? person.name + "'s roles that allow this do not cover " + (project ? project.name : "this scope") + "."
      : "No role held by " + person.name + (scoped && project ? " in " + project.name : "") + " includes '" + (act ? act.name : action) + "'.";
    if (ext.length && ext.some((q) => q.oncallOnly && q.roles.some((r) => heldRoles.includes(r))) && !person.oncall) reason += " " + (ext[0] as Policy).id + " would allow it while on call.";
    return { allowed: false, reason, rule: MATRIX_RULE, needs };
  }

  const held = granting.map((g) => g.role);
  const denies = state.policies.filter((p) => p.enabled && p.effect === "deny" && p.actions.includes(action));
  for (const p of denies) {
    if (p.where.freeze && repo) {
      const f = activeFreeze(state, repo.id, time);
      if (f) {
        return { allowed: false, reason: "Freeze " + f.id + " '" + f.name + "' is active on " + repo.name + " until " + fmt.stamp(f.to) + ".", rule: { kind: "policy", id: p.id, name: p.name, freeze: f.id }, needs: "Wait for the freeze to end" };
      }
    }
  }
  const allows = state.policies.filter((p) => p.enabled && p.effect === "allow" && !p.extend && p.actions.includes(action));
  if (allows.length) {
    const applicable = allows.filter((q) => q.roles.some((r) => held.includes(r)) && whereOk(q, projectId));
    if (!applicable.length) {
      return {
        allowed: false,
        reason: "No " + (act ? act.name.toLowerCase() : action) + " policy covers " + roleNames(state, held) + (project ? " on " + project.name : "") + ".",
        rule: { kind: "policy-missing", id: "NO-POLICY", name: "No matching policy" },
        needs: "Needs a policy for " + roleNames(state, held),
      };
    }
    let why: { q: Policy; text: string } | null = null;
    for (const q of applicable) {
      if (whenOk(q, t) && (!q.oncallOnly || person.oncall)) return { allowed: true, reason: "Allowed by " + q.id + " '" + q.name + "'.", rule: { kind: "policy", id: q.id, name: q.name }, needs: "" };
      if (!why) why = { q, text: q.oncallOnly && !person.oncall ? person.name + " is not on call; " + q.id + " applies only on call." : "Outside the window in " + q.id + ": " + policyText.when(q.when) + "." };
    }
    const w = why as { q: Policy; text: string };
    return { allowed: false, reason: w.text, rule: { kind: "policy", id: w.q.id, name: w.q.name }, needs: "Allowed " + policyText.when(w.q.when) + (w.q.oncallOnly ? " while on call" : "") };
  }
  const g0 = granting[0] as { role: string; scope: string };
  const scopeName = g0.scope === "factory" ? "the factory" : findProject(state, g0.scope)?.name ?? g0.scope;
  return { allowed: true, reason: "Role matrix: " + roleName(state, g0.role) + " on " + scopeName + " may " + (act ? act.name.toLowerCase() : action) + ".", rule: MATRIX_RULE, needs: "" };
}

/** Batch form behind `POST /api/v1/can`. */
export interface CanCheck {
  action: string;
  project?: string | null;
  repo?: string | null;
  time?: number;
}
export function canMany(state: PolicyState, personId: string | null | undefined, checks: CanCheck[], now: number): Decision[] {
  return checks.map((c) => can(state, personId, c.action, { project: c.project ?? null, repo: c.repo ?? null, time: c.time ?? now }));
}

/** First project the person may do `action` in, else the decision for their first visible project (legacy G.meAnyProject). */
export function canAnyProject(state: PolicyState, personId: string, action: string, now: number): Decision {
  const ps = visibleProjects(state, personId);
  for (const p of ps) {
    const d = can(state, personId, action, { project: p.id, time: now });
    if (d.allowed) return d;
  }
  return can(state, personId, action, { project: ps[0]?.id ?? null, time: now });
}

/* ------------------------------------------------------------------ explain & simulate -- */

/** The engine's decision as readable lines (legacy G.policyTrace). */
export function policyTrace(state: PolicyState, personId: string, action: string, ctx: PolicyContext = {}): string[] {
  const p = findPerson(state, personId);
  const act = actionsOf(state).find((a) => a.id === action);
  if (!p || !act) return ["Unknown person or action."];
  const m = state.matrix;
  const scoped = act.scope === "project";
  const pid = ctx.project || null;
  const time = ctx.time ?? Date.now();
  const grants = p.roles.filter((g) => g.scope === "factory" || !scoped || !pid || g.scope === pid);
  const granting = grants.filter((g) => m[g.role]?.[act.id]);
  const pols = state.policies.filter((q) => q.actions.includes(act.id));
  const repo = ctx.repo ? findRepo(state, ctx.repo) : undefined;
  const frz = repo ? activeFreeze(state, repo.id, time) : null;
  const d = can(state, personId, action, ctx);
  const out: string[] = [];
  out.push("Roles in scope: " + (grants.length ? grants.map((g) => roleName(state, g.role) + (g.scope === "factory" ? " (factory)" : "")).join(", ") : "none") + ".");
  out.push("Role matrix grants " + act.id + ": " + (granting.length ? "yes, via " + granting.map((g) => roleName(state, g.role)).join(", ") : "no") + ".");
  if (repo) out.push("Freeze on " + repo.name + ": " + (frz ? frz.id + " " + frz.name + " until " + fmt.stamp(frz.to) : "none at that time") + ".");
  out.push("Policies on this action: " + (pols.length ? pols.map((q) => q.id + (q.enabled ? "" : " (off)")).join(", ") : "none, so the matrix decides") + ".");
  out.push("Deciding rule: " + d.rule.id + " " + (d.rule.name || "") + ". " + d.reason);
  if (d.needs && !d.allowed) out.push("To allow it: " + d.needs + ".");
  const holders = rolesOf(state).filter((r) => m[r.id]?.[act.id]).map((r) => r.name);
  if (!d.allowed && holders.length) out.push("Roles that include it: " + holders.join(", ") + ".");
  return out;
}

export interface SimulatorQuestion {
  person: string;
  action: string;
  project?: string | null;
  repo?: string | null;
  /** Epoch ms of the selected moment. */
  time: number;
}
export interface WeekCell {
  hour: number;
  allowed: boolean;
  rule: string;
  selected: boolean;
}
export interface WeekRow {
  /** Epoch ms of 00:00 IST that day. */
  day0: number;
  /** 0 = Sunday. */
  dow: number;
  label: string;
  cells: WeekCell[];
}
export interface SimulationResult {
  decision: Decision;
  trace: string[];
  /** Same question for every hour of the next 7 IST days, starting today, evaluated at half past each hour. */
  week: WeekRow[];
}

/**
 * The access simulator: one decision, its trace, and the 7-day strip. Uses the same `can()` as enforcement,
 * so the simulator and the engine cannot disagree.
 */
export function simulate(state: PolicyState, q: SimulatorQuestion, now: number): SimulationResult {
  const act = actionsOf(state).find((a) => a.id === q.action);
  const scopeCtx = (time: number): PolicyContext => (act && act.scope === "project" ? { project: q.project ?? null, repo: q.repo || null, time } : { time });
  const decision = can(state, q.person, q.action, scopeCtx(q.time));
  const trace = policyTrace(state, q.person, q.action, scopeCtx(q.time));
  const start = istTime(istToday(now, 0), "00:00");
  const week: WeekRow[] = [];
  for (let d = 0; d < 7; d++) {
    const day0 = start + d * DAY;
    const dow = new Date(day0 + 330 * MIN).getUTCDay();
    const cells: WeekCell[] = [];
    for (let hr = 0; hr < 24; hr++) {
      const t = day0 + hr * HOUR + 30 * MIN;
      const dd = can(state, q.person, q.action, scopeCtx(t));
      cells.push({ hour: hr, allowed: dd.allowed, rule: dd.rule.id, selected: q.time >= day0 + hr * HOUR && q.time < day0 + (hr + 1) * HOUR });
    }
    week.push({ day0, dow, label: fmt.istDate(day0 + 6 * HOUR), cells });
  }
  return { decision, trace, week };
}

/* ------------------------------------------------------------------ agent autonomy ------ */

/** POL-112: no autonomous agents from Plan onward on regulated projects. */
export function agentAutonomyCheck(
  state: PolicyState,
  agent: { station: string | null; projects: "all" | string[] },
  autonomy: string,
  projectId?: string | null,
): { allowed: true } | { allowed: false; reason: string; rule: string } {
  if (autonomy !== "auto") return { allowed: true };
  const p = state.policies.find((x) => x.id === "POL-112");
  if (!p || !p.enabled) return { allowed: true };
  const early = agent.station === null || ["intake", "research", "spec", "design"].includes(agent.station);
  if (early) return { allowed: true };
  const projs = projectId
    ? [findProject(state, projectId)]
    : agent.projects === "all"
      ? state.projects
      : agent.projects.map((id) => findProject(state, id)).filter(Boolean);
  const reg = projs.filter((x) => x && x.regulated);
  if (reg.length) {
    return { allowed: false, reason: "POL-112: no autonomous agents from Plan onward on regulated projects (" + reg.map((x) => (x as { name: string }).name).join(", ") + "). Use act with gate or exclude those projects.", rule: "POL-112" };
  }
  return { allowed: true };
}
