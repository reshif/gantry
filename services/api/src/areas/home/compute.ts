import { involved } from "../onboarding/session/updates.js";
import { ONBOARD_STAGES, fmt, gateDecision, gateDef, gateProgress, istToday, istTime, isFactoryAdmin, rolesIn, visibleProjects, type Person, type Project, type Repo } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { decideFor, readSecurity, type ActiveStop, type PolicyStateLoaded, type Principal } from "../../core/index.js";
import { ms, num, obj } from "../../core/read/rows.js";
import { inFlight, loadHomeState, waitingGates, type HomeWorkOrder } from "./state.js";

/**
 * GET /api/v1/home (spec 8.3): everything the home screen and the nav badges show, computed from rows with the domain's own
 * functions (can, gateDecision, gateProgress). Sections that depend on work orders report what the tables hold: an empty
 * factory returns empty lists and zero counts, never sample data.
 */

export interface AttentionItem {
  id: string;
  /** 0 critical, 1 high, 2 watch. */
  sev: 0 | 1 | 2;
  icon: string;
  title: string;
  where: string;
  sub: string;
  /** Where the action button goes: a route id, and the project to select first. */
  act: { label: string; route: string; project?: string; tab?: string; wo?: string };
}

type Flow = Awaited<ReturnType<typeof loadHomeState>>;

const DAY = 86_400_000;
const unitOf = (k: unknown): number => num(k) / 1_000_000;

async function attention(db: Queryable, orgId: string, st: Flow, stops: ActiveStop[], now: number): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const add = (i: AttentionItem): number => items.push(i);
  const fk = stops.find((s) => s.scope === "factory" && s.mode === "kill");
  if (fk) add({ id: "hm-att-factory", sev: 0, icon: "st-kill", title: "Factory killed", where: "Factory", sub: `${fk.reason} · ${fmt.ago(fk.at, now)}`, act: { label: "Control panel", route: "home", tab: "control" } });
  for (const p of st.projects) {
    if (p.killed) add({ id: `hm-att-kill-${p.id}`, sev: 0, icon: "st-kill", title: `${p.name} killed`, where: p.name, sub: `${p.killed.reason} · ${fmt.ago(p.killed.at, now)}`, act: { label: "Danger zone", route: "project-config", project: p.id } });
    if (p.halted) add({ id: `hm-att-halt-${p.id}`, sev: 1, icon: "halt", title: `${p.name} halted`, where: p.name, sub: p.halted.reason, act: { label: "Open floor", route: "floor", project: p.id } });
    const b = p.budget;
    if (p.status !== "archived" && b.monthly && b.mtd / b.monthly >= b.alertAt) {
      add({ id: `hm-att-bud-${p.id}`, sev: b.mtd >= b.monthly ? 1 : 2, icon: "alert", title: `Budget at ${fmt.pct(b.mtd / b.monthly)}`, where: p.name, sub: `${fmt.money0(b.mtd)} of ${fmt.money0(b.monthly)} this month`, act: { label: "Budget", route: "project-config", project: p.id, tab: "budget" } });
    }
  }
  for (const r of st.repos) {
    const p = st.projects.find((x) => x.id === r.project);
    if (!p) continue;
    if (r.halted) add({ id: `hm-att-rh-${r.id}`, sev: 1, icon: "halt", title: `${r.name} halted`, where: p.name, sub: r.halted.reason, act: { label: "Open floor", route: "floor", project: p.id } });
    const o = r.onboarding;
    if (o && (o.stage === "failed" || o.stage === "person" || (o.pr && o.pr.checks === "red" && o.pr.state === "open"))) {
      add({ id: `hm-att-onb-${r.id}`, sev: 1, icon: "rocket", title: `Onboarding PR ${o.stage === "person" ? "needs a person" : "failing"}`, where: `${p.name} · ${r.name}`, sub: o.blocker || "PR checks are red.", act: { label: "Onboarding", route: "onboarding", project: p.id } });
    }
  }
  const stationName = (w: HomeWorkOrder): string => st.catalog.stations[w.station]?.name ?? "";
  for (const w of st.workOrders) {
    if (!inFlight(w)) continue;
    const p = st.projects.find((x) => x.id === w.project);
    const where = `${p?.name ?? w.project} · ${stationName(w)}`;
    const act = { label: "Traveler", route: "traveler", wo: w.id, project: w.project };
    if (w.state === "blocked") add({ id: `hm-att-wo-${w.id}`, sev: 1, icon: "st-block", title: `${w.id} blocked`, where, sub: w.blockReason || w.title, act });
    else if (w.state === "failed") add({ id: `hm-att-wo-${w.id}`, sev: 1, icon: "st-fail", title: `${w.id} check failed`, where, sub: w.failReason || w.title, act });
    else if (w.bay === "sechold") add({ id: `hm-att-wo-${w.id}`, sev: 0, icon: "shield", title: `${w.id} on security hold`, where: p?.name ?? w.project, sub: w.bayReason || w.title, act });
    else if (w.bay === "person") add({ id: `hm-att-wo-${w.id}`, sev: 2, icon: "human", title: `${w.id} needs a person`, where: p?.name ?? w.project, sub: w.bayReason || w.title, act });
  }
  for (const g of waitingGates(st.workOrders, st.projects, now).filter((x) => x.late)) {
    const d = gateDef(st.catalog, g.gate);
    const p = st.projects.find((x) => x.id === g.wo.project);
    add({ id: `hm-att-sla-${g.wo.id}-${g.gate}`, sev: 1, icon: "clock", title: `${d?.label ?? g.gate} past SLA on ${g.wo.id}`, where: p?.name ?? g.wo.project, sub: `Waiting ${fmt.dur(g.age)}; escalates after ${g.slaH} h`, act: { label: "Traveler", route: "traveler", wo: g.wo.id, project: g.wo.project } });
  }
  // Latest eval run per suite below its threshold.
  const ev = await db.query<{ suite: string; name: string; agent_id: string | null; score: string; threshold: string | null; version: string | null }>(
    `select distinct on (r.suite_id) r.suite_id as suite, s.name, s.agent_id, r.score, s.data->>'threshold' as threshold, r.data->>'version' as version
       from eval_runs r join suites s on s.org_id = r.org_id and s.id = r.suite_id where r.org_id = $1 and r.status = 'completed' and r.score is not null order by r.suite_id, r.started_at desc`,
    [orgId],
  );
  for (const r of ev.rows) {
    const th = r.threshold === null ? NaN : Number(r.threshold);
    if (Number.isNaN(th) || Number(r.score) >= th) continue;
    add({ id: `hm-att-ev-${r.suite}`, sev: 2, icon: "eval", title: `Eval below threshold: ${r.agent_id ?? r.suite}${r.version ? ` ${r.version}` : ""}`, where: "Factory", sub: `${r.name} ${fmt.pct(Number(r.score))} vs ${fmt.pct(th)}`, act: { label: "Evals", route: "evals" } });
  }
  const vend = await db.query<{ id: string; name: string; connected: boolean; budget: string | null; mtd: string }>(
    `select v.id, v.name, v.connected, v.monthly_budget_micros as budget,
            coalesce((select sum(u.cost_micros) from usage_meter u where u.org_id = v.org_id and u.vendor_id = v.id and u.at >= date_trunc('month', now())), 0) as mtd
       from vendors v where v.org_id = $1`,
    [orgId],
  );
  for (const v of vend.rows) {
    const b = unitOf(v.budget);
    const mtd = unitOf(v.mtd);
    if (b > 0 && mtd / b >= 0.85) add({ id: `hm-att-vb-${v.id}`, sev: 2, icon: "alert", title: `${v.name} spend at ${fmt.pct(mtd / b)}`, where: "Vendor", sub: `${fmt.money0(mtd)} of ${fmt.money0(b)}`, act: { label: "Models", route: "models" } });
  }
  const ints = await db.query<{ id: string; name: string; health: string; type: string; tname: string | null }>(
    `select i.id, i.name, i.health, i.type_id as type, t.name as tname from integration_instances i left join integration_types t on t.org_id = i.org_id and t.id = i.type_id where i.org_id = $1 and i.enabled and i.health in ('failing','offline')`,
    [orgId],
  );
  for (const i of ints.rows) add({ id: `hm-att-int-${i.id}`, sev: i.health === "offline" ? 2 : 1, icon: "plug", title: `${i.name} ${i.health}`, where: `${i.tname ?? i.type} integration`, sub: i.health === "offline" ? "Not connected" : "Deliveries failing", act: { label: "Integrations", route: "integrations" } });
  return items.sort((a, b) => a.sev - b.sev);
}

const canApprove = (st: Flow, who: string, w: HomeWorkOrder, gate: string, now: number): boolean => gateDecision(st, who, w, gate, now).allowed;

/** My approvals: gates I may decide now and onboarding PRs I may merge (legacy `G.myApprovals`). */
async function myApprovals(db: Queryable, orgId: string, st: Flow, st0: PolicyStateLoaded, principal: Principal, me: Person, now: number) {
  const vis = new Set(visibleProjects(st, me.id).map((p) => p.id));
  const out: Array<Record<string, unknown>> = [];
  for (const w of st.workOrders) {
    if (!vis.has(w.project) || w.bay) continue;
    const p = st.projects.find((x) => x.id === w.project)!;
    for (const [gid, gi] of Object.entries(w.gates)) {
      if (gi.status !== "waiting" || !canApprove(st, me.id, w, gid, now)) continue;
      const g = gateDef(st.catalog, gid);
      const prog = gid === "G0G1" ? null : gateProgress(p, w, gid, st.people);
      out.push({ wo: w.id, title: w.title, gate: gid, gateLabel: g?.label ?? gid, gateName: g?.name ?? gid, project: p.id, projectName: p.name, waitMs: Math.max(0, now - (gi.waitingSince ?? w.waitingSince)), ...(prog ? { have: prog.have, need: prog.need } : {}) });
    }
  }
  const prs = await db.query<{ repo_id: string; number: number | null; project_id: string; repo: string }>(
    `select o.repo_id, o.number, r.project_id, r.name as repo from onboarding_prs o join repos r on r.org_id = o.org_id and r.id = o.repo_id where o.org_id = $1 and o.state = 'open' and o.checks in ('green','none')`,
    [orgId],
  );
  for (const r of prs.rows) {
    if (!vis.has(r.project_id) || !decideFor(st0, principal, "onboarding.merge", { project: r.project_id }).allowed) continue;
    const p = st.projects.find((x) => x.id === r.project_id);
    out.push({ repo: r.repo_id, repoName: r.repo, pr: r.number ?? 0, project: r.project_id, projectName: p?.name ?? r.project_id });
  }
  // Onboarding session updates (checks finished, merged, verified, ...) for the people involved in the session, until they open it.
  const ups = await db.query<{ repo_id: string; project_id: string; repo: string; body: string }>(
    `select distinct on (m.repo_id) m.repo_id, r.project_id, r.name as repo, m.body
       from onboarding_messages m join repos r on r.org_id = m.org_id and r.id = m.repo_id
      where m.org_id = $1 and m.data->>'kind' = 'update' and m.created_at > now() - interval '7 days'
        and m.created_at > coalesce((select s.seen_at from onboarding_session_seen s where s.org_id = m.org_id and s.repo_id = m.repo_id and s.person_id = $2), '-infinity'::timestamptz)
      order by m.repo_id, m.created_at desc`,
    [orgId, me.id],
  );
  for (const u of ups.rows) {
    if (!vis.has(u.project_id) || !(await involved(db, orgId, u.repo_id, u.project_id)).includes(me.id)) continue;
    const p = st.projects.find((x) => x.id === u.project_id);
    out.push({ repo: u.repo_id, repoName: u.repo, pr: 0, project: u.project_id, projectName: p?.name ?? u.project_id, note: u.body.slice(0, 160) });
  }
  return out;
}

/** Work orders waiting on a question from me (legacy `G.awaitingMe`): raised questions, an open intake conversation, or a brief to confirm. */
async function myConversations(db: Queryable, orgId: string, st: Flow, st0: PolicyStateLoaded, principal: Principal, me: Person, now: number) {
  const vis = new Set(visibleProjects(st, me.id).map((p) => p.id));
  const q = await db.query<{ wo_id: string; question: string | null }>(
    `select c.wo_id, (select m.body from messages m where m.org_id = c.org_id and m.conversation_id = c.id and m.author_kind <> 'person' order by m.created_at desc limit 1) as question
       from conversations c where c.org_id = $1 and c.status = 'open' and c.wo_id is not null`,
    [orgId],
  );
  const text = new Map(q.rows.map((r) => [r.wo_id, r.question]));
  const out: Array<{ wo: string; title: string; project: string; question: string | null }> = [];
  for (const w of st.workOrders) {
    if (!vis.has(w.project) || w.state === "done" || w.state === "killed" || w.bay === "declined") continue;
    const open = text.has(w.id);
    const raised = w.conv.raised.some((x) => !x.answered);
    const atIntake = w.station === 0 && w.gates.G0G1?.status === "waiting";
    const toConfirm = atIntake && !open && !w.bay;
    if (!open && !raised && !toConfirm) continue;
    const lead = rolesIn(me, w.project).some((r) => r === "line_lead" || r === "project_admin");
    const mine = toConfirm && !open && !raised ? canApprove(st, me.id, w, "G0G1", now) && (w.requestedBy === me.id || lead) : w.requestedBy === me.id || (raised && lead && decideFor(st0, principal, "wo.answer", { project: w.project, time: now }).allowed);
    if (mine) out.push({ wo: w.id, title: w.title, project: w.project, question: text.get(w.id) ?? null });
  }
  return out;
}

export interface HomeOptions {
  db: Queryable;
  orgId: string;
  principal: Principal;
  st0: PolicyStateLoaded;
  now?: number;
}

export async function computeHome(o: HomeOptions) {
  const { db, orgId, st0, principal } = o;
  const now = o.now ?? Date.now();
  const st = await loadHomeState(db, orgId);
  const me = st.people.find((p) => p.id === principal.id);
  if (!me || principal.kind !== "person") return null;
  const factoryRole = me.roles.some((g) => g.scope === "factory");
  const stops = st0.activeStops;
  const [approvals, conversations] = await Promise.all([myApprovals(db, orgId, st, st0, principal, me, now), myConversations(db, orgId, st, st0, principal, me, now)]);
  const vis = visibleProjects(st, me.id);
  const projName = (id: string): string => st.projects.find((p) => p.id === id)?.name ?? id;
  const mine = st.workOrders
    .filter((w) => w.requestedBy === me.id && (inFlight(w) || (w.doneAt && w.doneAt > now - 7 * DAY) || w.state === "killed"))
    .sort((a, b) => Number(inFlight(b)) - Number(inFlight(a)) || b.createdAt - a.createdAt)
    .map((w) => ({
      id: w.id, title: w.title, project: w.project, projectName: projName(w.project), state: w.state, bay: w.bay, cls: w.cls, priority: w.priority, doneAt: w.doneAt,
      station: st.catalog.stations[w.station]?.name ?? "", stationId: st.catalog.stations[w.station]?.id ?? null, bayName: w.bay ? st.catalog.bays.find((b) => b.id === w.bay)?.name ?? w.bay : null,
    }));
  const myProjects = vis.map((p) => ({ id: p.id, roles: rolesIn(me, p.id).map((r) => ({ id: r, name: st.catalog.roles.find((x) => x.id === r)?.name ?? r })) }));
  const out: Record<string, unknown> = {
    mode: factoryRole ? "factory" : "mine", approvals, conversations, mine: { workOrders: mine, projects: myProjects, factoryRole },
    badges: {} as Record<string, unknown>, projectBadges: {} as Record<string, Record<string, unknown>>,
  };

  // Nav badges. Floor, work-orders and onboarding badges follow the selected project, so they are given per project.
  const badges: Record<string, unknown> = {};
  if (conversations.length) badges.conversations = { n: conversations.length, label: `${conversations.length} conversations waiting for you` };
  const [tp, lp, bad] = await Promise.all([
    db.query<{ n: string }>(`select count(*) as n from trust_proposals tp join trust_cells c on c.org_id = tp.org_id and c.id = tp.cell_id where tp.org_id = $1 and tp.status = 'open' and (c.project_id is null or c.project_id = any($2::text[]))`, [orgId, vis.map((p) => p.id)]),
    db.query<{ n: string }>(`select count(*) as n from proposals where org_id = $1 and status = 'open'`, [orgId]),
    db.query<{ n: string }>(`select count(*) as n from integration_instances where org_id = $1 and enabled and health in ('failing','offline')`, [orgId]),
  ]);
  const n = (r: { rows: Array<{ n: string }> }): number => num(r.rows[0]?.n);
  if (n(tp)) badges.trust = { n: n(tp), label: `${n(tp)} trust proposals pending` };
  if (n(lp)) badges.learning = { n: n(lp), label: `${n(lp)} learning proposals to review` };
  if (n(bad)) badges.integrations = { n: n(bad), kind: "is-warn", label: `${n(bad)} integrations failing or offline` };
  out.badges = badges;
  const pb: Record<string, Record<string, unknown>> = {};
  for (const p of vis) {
    const b: Record<string, unknown> = {};
    if (p.killed || p.halted) b.floor = { text: p.killed ? "killed" : "halted", kind: p.killed ? "is-kill" : "is-halt", label: `${p.name} is ${p.killed ? "killed" : "halted"}` };
    const ap = approvals.filter((a) => a.wo && a.project === p.id).length;
    if (ap) b["work-orders"] = { n: ap, label: `${ap} approvals you can give in ${p.name}` };
    const ob = st.repos.filter((r) => r.project === p.id && ["person", "failed"].includes(r.onboarding?.stage ?? "")).length;
    if (ob) b.onboarding = { n: ob, kind: "is-warn", label: `${ob} repos need a person` };
    if (Object.keys(b).length) pb[p.id] = b;
  }
  out.projectBadges = pb;
  if (!factoryRole) return out;

  // ---- factory overview ----
  const active = st.projects.filter((p) => p.status !== "archived");
  const live = st.workOrders.filter(inFlight);
  const gates = waitingGates(st.workOrders, st.projects, now);
  const dayStart = istTime(istToday(now, 0), "00:00");
  const shipped = st.workOrders.filter((w) => w.state === "done" && !w.split && w.doneAt);
  const stopNames: string[] = [];
  const fk = stops.find((s) => s.scope === "factory" && s.mode === "kill");
  if (fk) stopNames.push("factory");
  for (const p of active) {
    if (p.killed) stopNames.push(`${p.name} killed`);
    if (p.halted) stopNames.push(`${p.name} halted`);
  }
  for (const r of st.repos) if (r.halted) stopNames.push(`${r.name} halted`);
  const items = await attention(db, orgId, st, stops, now);
  const [sec, restore, spendV, trustP, trustD, learn, onb, people, prs] = await Promise.all([
    readSecurity(db, orgId),
    fk ? db.query<{ approver: string; at: Date }>(`select approver, at from restore_approvals where org_id = $1 and stop_id = $2 order by at`, [orgId, fk.id]) : Promise.resolve({ rows: [] as Array<{ approver: string; at: Date }> }),
    db.query<{ id: string; name: string; budget: string | null; mtd: string }>(
      `select v.id, v.name, v.monthly_budget_micros as budget, coalesce((select sum(u.cost_micros) from usage_meter u where u.org_id = v.org_id and u.vendor_id = v.id and u.at >= date_trunc('month', now())), 0) as mtd from vendors v where v.org_id = $1 order by v.name`, [orgId]),
    db.query<{ id: string; cell_id: string; proposed_level: string; evidence: unknown }>(`select id, cell_id, proposed_level, evidence from trust_proposals where org_id = $1 and status = 'open' order by created_at desc`, [orgId]),
    db.query<{ cell_id: string; at: Date; reason: string | null }>(
      `select g.cell_id, g.revoked_at as at, g.evidence->>'reason' as reason from trust_grants g where g.org_id = $1 and g.revoked_at >= $2 order by g.revoked_at desc`, [orgId, new Date(now - 7 * DAY)]),
    db.query<{ id: string; kind: string; title: string; change: unknown; decided_by: string | null }>(`select id, kind, title, change, decided_by from proposals where org_id = $1 and status = 'open' order by created_at desc`, [orgId]),
    db.query<{ repo: string; name: string; project: string; stage: string }>(`select r.id as repo, r.name, r.project_id as project, r.onboarding_stage as stage from repos r join projects p on p.org_id = r.org_id and p.id = r.project_id where r.org_id = $1 and p.status <> 'archived' order by r.name`, [orgId]),
    Promise.resolve(st.people),
    db.query<{ n: string }>(`select count(*) as n from pull_requests where org_id = $1 and state = 'open'`, [orgId]),
  ]);
  const stageOf = (r: { repo: string; stage: string }): string => st.repos.find((x) => x.id === r.repo)?.onboarding?.stage ?? r.stage;
  const stages = ONBOARD_STAGES.map((s) => ({ id: s.id, name: s.name, count: onb.rows.filter((r) => stageOf(r) === s.id).length }));
  const stuck = onb.rows.filter((r) => ["failed", "person"].includes(stageOf(r))).map((r) => ({ repo: r.repo, name: r.name, project: r.project, stage: stageOf(r) }));
  const openRepos = onb.rows.filter((r) => stageOf(r) !== "ready").map((r) => ({ repo: r.repo, name: r.name, project: r.project, stage: stageOf(r) }));
  // Human attention: gates each person may decide, and gates only one person (besides Factory Admins) may decide.
  const deciders = people.filter((x) => x.status === "active" && !(x.roles.length === 1 && x.roles[0]!.role === "factory_admin"));
  const perPerson = new Map<string, { waiting: number; sole: number }>();
  let sole = 0;
  for (const g of gates) {
    const who = deciders.filter((x) => canApprove(st, x.id, g.wo, g.gate, now));
    if (who.length <= 1) sole += 1;
    for (const x of who) {
      const c = perPerson.get(x.id) ?? { waiting: 0, sole: 0 };
      c.waiting += 1;
      if (who.length === 1) c.sole += 1;
      perPerson.set(x.id, c);
    }
  }
  const waitingPeople = [...perPerson.entries()].map(([id, c]) => ({ person: id, name: people.find((p) => p.id === id)?.name ?? id, ...c })).sort((a, b) => b.waiting - a.waiting);
  const killedWo = st.workOrders.filter((w) => w.state === "killed").length;
  const spent = active.reduce((a, p) => a + p.budget.mtd, 0);
  const budget = active.reduce((a, p) => a + p.budget.monthly, 0);
  const running = live.filter((w) => w.state === "running").length;
  const f = st.projects;
  Object.assign(out, {
    figures: {
      projects: { active: active.length, archived: f.length - active.length }, inFlight: live.length, running, inBays: live.filter((w) => w.bay).length,
      shippedToday: shipped.filter((w) => (w.doneAt ?? 0) >= dayStart).length, shippedWeek: shipped.filter((w) => (w.doneAt ?? 0) >= now - 7 * DAY).length,
      gatesWaiting: gates.length, oldestWaitMs: gates[0]?.age ?? 0, lateGates: gates.filter((g) => g.late).length, stops: stopNames, killedWorkOrders: killedWo,
      spent, budget, agentSuccess: null as number | null, agentSuccessTrend: [] as number[],
    },
    attention: items,
    control: {
      killed: fk ? { by: fk.by, at: fk.at, reason: fk.reason, mode: fk.inFlight ?? "hold" } : null,
      restoreApprovals: restore.rows.map((r) => ({ by: r.approver, at: ms(r.at) ?? 0 })), restoreNeeds: sec.value.restoreFactoryNeedsTwo ? 2 : 1,
      admins: st.people.filter((p) => p.status === "active" && isFactoryAdmin(st, p.id)).map((p) => ({ id: p.id, name: p.name })),
      impact: { projects: active.filter((p) => !p.killed).length, workOrders: live.length, running, prs: num(prs.rows[0]?.n) },
    },
    human: {
      waiting: waitingPeople.slice(0, 4), gates: { count: gates.length, oldestMs: gates[0]?.age ?? 0, sole },
      trust: {
        proposals: trustP.rows.map((r) => ({ id: r.id, cell: r.cell_id, to: r.proposed_level })), demotions: trustD.rows.map((r) => ({ cell: r.cell_id, at: ms(r.at) ?? 0, reason: r.reason })),
      },
      learning: learn.rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title || String(obj(r.change).title ?? obj(r.change).summary ?? r.kind) })),
    },
    onboarding: { stages, stuck, open: openRepos, total: onb.rows.length, ready: onb.rows.length - openRepos.length },
    spend: {
      projects: active.map((p) => ({ id: p.id, label: p.name, v: p.budget.mtd, b: p.budget.monthly, alert: p.budget.alertAt })),
      vendors: spendV.rows.map((v) => ({ id: v.id, label: v.name, v: unitOf(v.mtd), b: unitOf(v.budget) })),
    },
    factory: { killed: fk ? { by: fk.by, at: fk.at, reason: fk.reason, mode: fk.inFlight ?? "hold" } : null },
  });
  return out;
}

export type { Project, Repo };
