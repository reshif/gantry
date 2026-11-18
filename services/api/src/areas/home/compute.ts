import { involved } from "../onboarding/session/updates.js";
import { involvedInWo } from "../workorders/session/updates.js";
import { asksMe } from "../workorders/asked.js";
import { openAccessRequests } from "../workorders/session/mentions.js";
import { fmt, gateDecision, gateDef, gateProgress, istToday, istTime, isFactoryAdmin, roleHolds, rolesIn, visibleProjects, type Person, type Project, type Repo } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { decideFor, readSecurity, type ActiveStop, type PolicyStateLoaded, type Principal } from "../../core/index.js";
import { ms, num } from "../../core/read/rows.js";
import { agentRows, eligibility, labelOf, versionRows } from "../agents/store.js";
import { callableModels } from "../models/default.js";
import { loadFacts } from "../models/facts.js";
import { modelRows } from "../models/store.js";
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
  /** A killed scope: Home offers Restore (to people who may) and shows the approvals so far. */
  restore?: { scope: "factory" | "project"; id: string | null; approvals?: Array<{ by: string; at: number }>; needs?: number };
}

type Flow = Awaited<ReturnType<typeof loadHomeState>>;

const DAY = 86_400_000;
const unitOf = (k: unknown): number => num(k) / 1_000_000;

/** What the caller may see of the factory, resolved from the role matrix (stops do not hide a read: a killed factory still shows its problems). */
interface Scope {
  me: Person;
  vis: Set<string>;
  /** The matrix grants `action` on `project` (or factory-wide when no project), the way `can` picks grants. */
  holds(action: string, project?: string): boolean;
  /** The factory's policy state, for judging other people's access. */
  policy: PolicyStateLoaded;
  /** Eval health, when the caller may read agents. */
  evals: EvalHealth | null;
  restore: { approvals: Array<{ by: string; at: number }>; needs: number };
}

export interface EvalHealth {
  /** Live agent versions that have a completed run of their suite. */
  scored: number;
  passing: number;
  /** Live agents with a suite but no completed run for the live version. */
  unscored: number;
  failing: Array<{ agent: string; name: string; version: string; suite: string; score: number; threshold: number }>;
}

/** Real eval health: each live agent version against its suite threshold (the promotion rule's own `eligibility`), from its latest completed run. */
async function evalHealth(db: Queryable, orgId: string): Promise<EvalHealth | null> {
  const [agents, versions] = await Promise.all([agentRows(db, orgId), versionRows(db, orgId)]);
  const out: EvalHealth = { scored: 0, passing: 0, unscored: 0, failing: [] };
  for (const a of agents) {
    if (a.live_version === null || a.live_version === undefined || a.status !== "active") continue;
    const v = versions.find((x) => x.agent_id === a.id && x.version === a.live_version);
    if (!v) continue;
    const e = await eligibility(db, orgId, a, v);
    if (e.score === null || e.threshold === null) {
      if (e.suite) out.unscored += 1;
      continue;
    }
    out.scored += 1;
    if (e.ok) out.passing += 1;
    else out.failing.push({ agent: a.id, name: a.name, version: labelOf(v), suite: e.suite ?? "", score: e.score, threshold: e.threshold });
  }
  return out.scored ? out : null;
}

async function attention(db: Queryable, orgId: string, st: Flow, stops: ActiveStop[], now: number, sc: Scope): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const add = (i: AttentionItem): number => items.push(i);
  const seeProject = (id: string): boolean => sc.vis.has(id);
  const fk = stops.find((s) => s.scope === "factory" && s.mode === "kill");
  if (fk) {
    const have = sc.restore.approvals.length;
    add({
      id: "hm-att-factory", sev: 0, icon: "st-kill", title: "Factory killed", where: "Factory",
      sub: `${fk.reason} · ${fmt.ago(fk.at, now)} · restore approvals ${have} of ${sc.restore.needs}`, act: { label: "Open Security", route: "security" },
      restore: { scope: "factory", id: null, approvals: sc.restore.approvals, needs: sc.restore.needs },
    });
  }
  for (const p of st.projects) {
    if (!seeProject(p.id)) continue;
    if (p.killed) add({ id: `hm-att-kill-${p.id}`, sev: 0, icon: "st-kill", title: `${p.name} killed`, where: p.name, sub: `${p.killed.reason} · ${fmt.ago(p.killed.at, now)}`, act: { label: "Open floor", route: "floor", project: p.id }, restore: { scope: "project", id: p.id } });
    if (p.halted) add({ id: `hm-att-halt-${p.id}`, sev: 1, icon: "halt", title: `${p.name} halted`, where: p.name, sub: p.halted.reason, act: { label: "Open floor", route: "floor", project: p.id } });
    const b = p.budget;
    if (p.status !== "archived" && b.monthly && b.mtd / b.monthly >= b.alertAt && (sc.holds("project.config", p.id) || sc.holds("audit.view", p.id))) {
      add({ id: `hm-att-bud-${p.id}`, sev: b.mtd >= b.monthly ? 1 : 2, icon: "alert", title: `Budget at ${fmt.pct(b.mtd / b.monthly)}`, where: p.name, sub: `${fmt.money0(b.mtd)} of ${fmt.money0(b.monthly)} this month`, act: { label: "Budget", route: "project-config", project: p.id, tab: "budget" } });
    }
  }
  for (const r of st.repos) {
    const p = st.projects.find((x) => x.id === r.project);
    if (!p || !seeProject(p.id)) continue;
    if (r.halted) add({ id: `hm-att-rh-${r.id}`, sev: 1, icon: "halt", title: `${r.name} halted`, where: p.name, sub: r.halted.reason, act: { label: "Open floor", route: "floor", project: p.id } });
    const o = r.onboarding;
    // "needs you" only for people who can act: running onboarding fixes a failed or stuck repo; red checks also concern whoever may merge
    const redPr = !!o?.pr && o.pr.checks === "red" && o.pr.state === "open";
    const onb = sc.holds("onboarding.manage", p.id) || (redPr && sc.holds("onboarding.merge", p.id));
    if (onb && o && (o.stage === "failed" || o.stage === "person" || redPr)) {
      const why = o.stage === "failed" ? "verification failed" : o.stage === "person" ? "needs a person" : "PR checks are red";
      add({ id: `hm-att-onb-${r.id}`, sev: 1, icon: "rocket", title: `${r.name} onboarding needs you: ${why}`, where: p.name, sub: o.blocker || "Open the onboarding session to continue.", act: { label: "Open session", route: "onboarding", project: p.id } });
    }
  }
  const admin = st.projects.filter((p) => seeProject(p.id) && sc.holds("project.members", p.id)).map((p) => p.id);
  for (const r of await openAccessRequests(db, orgId, sc.policy, admin)) {
    const p = st.projects.find((x) => x.id === r.project);
    add({ id: `hm-att-access-${r.id}`, sev: 2, icon: "human", title: `${r.personName} was mentioned but cannot open ${p?.name ?? r.project}`, where: p?.name ?? r.project, sub: `${r.byName} mentioned them${r.wo ? ` on ${r.wo}` : ""}. Nothing was granted: give them a role or dismiss the request.`, act: { label: "Open people", route: "people", project: r.project } });
  }
  const stationName = (w: HomeWorkOrder): string => st.catalog.stations[w.station]?.name ?? "";
  for (const w of st.workOrders) {
    if (!inFlight(w) || !seeProject(w.project)) continue;
    const p = st.projects.find((x) => x.id === w.project);
    const oversee = w.requestedBy === sc.me.id || sc.holds("wo.move", w.project) || sc.holds("audit.view", w.project) || sc.holds("release", w.project);
    if (!oversee) continue;
    const where = `${p?.name ?? w.project} · ${stationName(w)}`;
    const act = { label: "Traveler", route: "traveler", wo: w.id, project: w.project };
    if (w.state === "blocked") add({ id: `hm-att-wo-${w.id}`, sev: 1, icon: "st-block", title: `${w.id} blocked`, where, sub: w.blockReason || w.title, act });
    else if (w.state === "failed") add({ id: `hm-att-wo-${w.id}`, sev: 1, icon: "st-fail", title: w.failPhase === "start" ? `${w.id} run did not start` : `${w.id} check failed`, where, sub: w.failReason || w.title, act });
    else if (w.bay === "sechold") add({ id: `hm-att-wo-${w.id}`, sev: 0, icon: "shield", title: `${w.id} on security hold`, where: p?.name ?? w.project, sub: w.bayReason || w.title, act });
    else if (w.bay === "person") add({ id: `hm-att-wo-${w.id}`, sev: 2, icon: "human", title: `${w.id} needs a person`, where: p?.name ?? w.project, sub: w.bayReason || w.title, act });
  }
  for (const g of waitingGates(st.workOrders, st.projects, now).filter((x) => x.late && seeProject(x.wo.project))) {
    if (!(sc.holds("audit.view", g.wo.project) || sc.holds("wo.move", g.wo.project) || canApprove(st, sc.me.id, g.wo, g.gate, now))) continue;
    const d = gateDef(st.catalog, g.gate);
    const p = st.projects.find((x) => x.id === g.wo.project);
    add({ id: `hm-att-sla-${g.wo.id}-${g.gate}`, sev: 1, icon: "clock", title: `${d?.label ?? g.gate} past SLA on ${g.wo.id}`, where: p?.name ?? g.wo.project, sub: `Waiting ${fmt.dur(g.age)}; escalates after ${g.slaH} h`, act: { label: "Traveler", route: "traveler", wo: g.wo.id, project: g.wo.project } });
  }
  // A live agent version whose latest suite run is below the suite's threshold.
  for (const f of sc.evals?.failing ?? []) {
    add({ id: `hm-att-ev-${f.agent}`, sev: 2, icon: "eval", title: `Live ${f.name} ${f.version} is below its eval threshold`, where: "Factory", sub: `${f.suite} ${fmt.pct(f.score)} vs ${fmt.pct(f.threshold)}`, act: { label: "Evals", route: "evals" } });
  }
  if (sc.holds("models.view")) {
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
  }
  if (sc.holds("integrations.view")) {
    const ints = await db.query<{ id: string; name: string; health: string; type: string; tname: string | null }>(
      `select i.id, i.name, i.health, i.type_id as type, t.name as tname from integration_instances i left join integration_types t on t.org_id = i.org_id and t.id = i.type_id where i.org_id = $1 and i.enabled and i.health in ('failing','offline')`,
      [orgId],
    );
    for (const i of ints.rows) add({ id: `hm-att-int-${i.id}`, sev: i.health === "offline" ? 2 : 1, icon: "plug", title: `${i.name} ${i.health}`, where: `${i.tname ?? i.type} integration`, sub: i.health === "offline" ? "Not connected" : "Deliveries failing", act: { label: "Integrations", route: "integrations" } });
  }
  return items.sort((a, b) => a.sev - b.sev);
}

const canApprove = (st: Flow, who: string, w: HomeWorkOrder, gate: string, now: number): boolean => gateDecision(st, who, w, gate, now).allowed;

/** Onboarding session updates a merge right can act on (session/updates.ts event names); every other update needs onboarding.manage. */
const MERGE_UPDATES: ReadonlySet<string> = new Set(["pr", "checks.green", "checks.none", "merge.refused"]);

/** My approvals: gates I may decide now and onboarding PRs I may merge (legacy `G.myApprovals`). */
async function myApprovals(db: Queryable, orgId: string, st: Flow, st0: PolicyStateLoaded, principal: Principal, me: Person, now: number) {
  const vis = new Set(visibleProjects(st, me.id).map((p) => p.id));
  const out: Array<Record<string, unknown>> = [];
  const openInst = new Map((await db.query<{ id: string; wo_id: string; gate_id: string }>(`select id, wo_id, gate_id from gate_instances where org_id = $1 and status = 'open'`, [orgId])).rows.map((r) => [`${r.wo_id}:${r.gate_id}`, r.id]));
  for (const w of st.workOrders) {
    if (!vis.has(w.project) || w.bay) continue;
    const p = st.projects.find((x) => x.id === w.project)!;
    for (const [gid, gi] of Object.entries(w.gates)) {
      if (gi.status !== "waiting" || !canApprove(st, me.id, w, gid, now)) continue;
      const g = gateDef(st.catalog, gid);
      const prog = gid === "G0G1" ? null : gateProgress(p, w, gid, st.people);
      out.push({ wo: w.id, title: w.title, gate: gid, gateLabel: g?.label ?? gid, gateName: g?.name ?? gid, ...(openInst.get(`${w.id}:${gid}`) ? { instance: openInst.get(`${w.id}:${gid}`) } : {}), project: p.id, projectName: p.name, waitMs: Math.max(0, now - (gi.waitingSince ?? w.waitingSince)), ...(prog ? { have: prog.have, need: prog.need } : {}) });
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
  const ups = await db.query<{ repo_id: string; project_id: string; repo: string; body: string; event: string | null }>(
    `select distinct on (m.repo_id) m.repo_id, r.project_id, r.name as repo, m.body, m.data->>'event' as event
       from onboarding_messages m join repos r on r.org_id = m.org_id and r.id = m.repo_id
      where m.org_id = $1 and m.data->>'kind' = 'update' and m.created_at > now() - interval '7 days'
        and m.created_at > coalesce((select s.seen_at from onboarding_session_seen s where s.org_id = m.org_id and s.repo_id = m.repo_id and s.person_id = $2), '-infinity'::timestamptz)
      order by m.repo_id, m.created_at desc`,
    [orgId, me.id],
  );
  for (const u of ups.rows) {
    if (!vis.has(u.project_id) || !(await involved(db, orgId, u.repo_id, u.project_id)).includes(me.id)) continue;
    // only people who can act on it (Wave 3, F13): a PR to merge needs a merge right; anything else needs the right to run onboarding
    const acts = MERGE_UPDATES.has(u.event ?? "") ? ["onboarding.merge", "onboarding.manage"] : ["onboarding.manage"];
    if (!acts.some((a) => decideFor(st0, principal, a, { project: u.project_id }).allowed)) continue;
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
  const out: Array<{ wo: string; title: string; project: string; question: string | null; gate?: { id: string; label: string; name: string }; stuck?: { state: string; station: string; reason: string; actions: string[] } }> = [];
  const briefGate = gateDef(st.catalog, "G0G1");
  for (const w of st.workOrders) {
    if (!vis.has(w.project) || w.state === "done" || w.state === "killed" || w.bay === "declined") continue;
    const open = text.has(w.id);
    const raised = w.conv.raised.some((x) => !x.answered);
    const atIntake = w.station === 0 && w.gates.G0G1?.status === "waiting";
    const toConfirm = atIntake && !open && !w.bay;
    if (!open && !raised && !toConfirm) continue;
    const lead = rolesIn(me, w.project).some((r) => r === "line_lead" || r === "project_admin");
    const mine = toConfirm && !open && !raised ? canApprove(st, me.id, w, "G0G1", now) && (w.requestedBy === me.id || lead) : w.requestedBy === me.id || (raised && lead && decideFor(st0, principal, "wo.answer", { project: w.project, time: now }).allowed);
    // A work order at the brief gate is a gate decision for its submitter, whatever line the conversation last said (the classifier's, a question, a draft): it carries the gate so it is listed with gate approvals.
    if (mine) out.push({ wo: w.id, title: w.title, project: w.project, question: text.get(w.id) ?? null, ...(atIntake && briefGate ? { gate: { id: briefGate.id, label: briefGate.label, name: briefGate.name } } : {}) });
  }
  // A failed or blocked work order, or one parked for a person after repeated failures, waits on a person who may retry it. It stays in "Waiting on you" with the reason and the actions it allows.
  for (const w of st.workOrders) {
    if (!vis.has(w.project) || w.state === "done" || w.state === "killed" || w.bay === "declined" || out.some((x) => x.wo === w.id)) continue;
    const failedBay = w.bay === "person" && (w.bayCause === "failed" || w.bayCause === "merge");
    if (w.state !== "failed" && w.state !== "blocked" && !failedBay) continue;
    const scope = { project: w.project, time: now };
    const retry = decideFor(st0, principal, "wo.sendback", scope).allowed;
    const assign = decideFor(st0, principal, "wo.reassign", scope).allowed;
    if (!retry && !assign) continue;
    const reason = (w.state === "failed" ? w.failReason : w.state === "blocked" ? w.blockReason : w.bayReason) || `${st.catalog.stations[w.station]?.name ?? "The station"} did not finish.`;
    out.push({ wo: w.id, title: w.title, project: w.project, question: reason, stuck: { state: failedBay ? "parked" : w.state, station: st.catalog.stations[w.station]?.id ?? "", reason, actions: [...(retry ? ["retry"] : []), ...(assign ? ["assign"] : [])] } });
  }
  // A station agent's question (wo_questions) is for the people its `ask_of` names, not for everyone who can see the work order.
  const asks = await db.query<{ wo_id: string; ask_of: string; question: string }>(`select wo_id, ask_of, question from wo_questions where org_id = $1 and status = 'open' order by created_at`, [orgId]);
  for (const a of asks.rows) {
    const w = st.workOrders.find((x) => x.id === a.wo_id);
    if (!w || !vis.has(w.project) || w.state === "done" || w.state === "killed" || out.some((x) => x.wo === w.id)) continue;
    if (asksMe(a.ask_of, me, { project: w.project, requestedBy: w.requestedBy }, (act) => decideFor(st0, principal, act, { project: w.project, time: now }).allowed)) out.push({ wo: w.id, title: w.title, project: w.project, question: a.question.slice(0, 160) });
  }
  // The work-order session: the agent asked or proposed, or Gantry posted an update (a station finished, a gate decided), and this person has not opened it since.
  const ups = await db.query<{ wo_id: string; project_id: string; title: string; body: string }>(
    `select distinct on (m.wo_id) m.wo_id, w.project_id, w.title, m.body
       from workorder_messages m join work_orders w on w.org_id = m.org_id and w.id = m.wo_id
      where m.org_id = $1 and m.role <> 'user' and m.created_at > now() - interval '7 days' and w.state not in ('done','killed') and w.position <> 'declined'
        and m.created_at > coalesce((select s.seen_at from workorder_session_seen s where s.org_id = m.org_id and s.wo_id = m.wo_id and s.person_id = $2), '-infinity'::timestamptz)
      order by m.wo_id, m.created_at desc`,
    [orgId, me.id],
  );
  // A colleague @mentioned this person in a session. It lists once they can read the project (a mention never opens anything) and stops listing when they open the session.
  const mentions = await db.query<{ wo_id: string; project_id: string; title: string; by_name: string | null; body: string | null }>(
    `select distinct on (n.wo_id) n.wo_id, w.project_id, w.title, p.name as by_name, m.body
       from workorder_mentions n join work_orders w on w.org_id = n.org_id and w.id = n.wo_id
       left join people p on p.org_id = n.org_id and p.id = n.by_person left join workorder_messages m on m.org_id = n.org_id and m.id = n.message_id
      where n.org_id = $1 and n.person_id = $2 and n.created_at > now() - interval '14 days' and w.state not in ('done','killed') and w.position <> 'declined'
        and n.created_at > coalesce((select s.seen_at from workorder_session_seen s where s.org_id = n.org_id and s.wo_id = n.wo_id and s.person_id = $2), '-infinity'::timestamptz)
      order by n.wo_id, n.created_at desc`,
    [orgId, me.id],
  );
  for (const u of mentions.rows) {
    if (!vis.has(u.project_id) || out.some((x) => x.wo === u.wo_id)) continue;
    out.push({ wo: u.wo_id, title: u.title, project: u.project_id, question: `${u.by_name ?? "A colleague"} mentioned you: ${(u.body ?? "").slice(0, 140)}`.trim() });
  }
  for (const u of ups.rows) {
    if (!vis.has(u.project_id) || out.some((x) => x.wo === u.wo_id) || !(await involvedInWo(db, orgId, u.wo_id, u.project_id)).includes(me.id)) continue;
    out.push({ wo: u.wo_id, title: u.title, project: u.project_id, question: u.body.slice(0, 160) });
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

/** The five first-run steps, derived from data on every request (nothing is stored). Null once all are done, or for anyone who cannot do the setup. */
async function setupSteps(db: Queryable, orgId: string, st: Flow, active: Project[]) {
  const [gh, facts, rows, anyWo] = await Promise.all([
    db.query<{ health: string }>(`select health from integration_instances where org_id = $1 and type_id = 'github' and enabled`, [orgId]),
    loadFacts(db, orgId),
    modelRows(db, orgId),
    db.query<{ n: string }>(`select count(*)::text as n from (select 1 from work_orders where org_id = $1 and source not in ('eval','onboarding') limit 1) x`, [orgId]),
  ]);
  const github = gh.rows.some((r) => r.health !== "failing" && r.health !== "offline");
  const ghBad = !github && gh.rows.length > 0;
  const callable = callableModels(facts, rows);
  const ready = (r: Repo): boolean => r.onboarding?.stage === "ready" || !!r.onboarding?.exception;
  const repos = st.repos.filter((r) => active.some((p) => p.id === r.project));
  const readyRepo = repos.some(ready);
  const open = repos.find((r) => !ready(r));
  const stageText: Record<string, string> = { failed: "verification failed", person: "needs a person", connected: "connected, assessing", assessed: "assessed", pr_opened: "PR opened", pr_checks: "PR checks running", pr_merged: "PR merged, verifying", verified: "verified" };
  const steps = [
    { id: "github", label: "Connect GitHub", done: github, detail: github ? "" : ghBad ? "The GitHub integration is failing or offline." : "Install the GitHub App so Gantry can read and open pull requests.", route: "integrations", project: null as string | null },
    { id: "vendor", label: "Add a model vendor", done: callable.length > 0, detail: callable.length ? "" : "Anthropic is ready to call once its key is saved. Bedrock, OpenAI, Azure and Gemini can be discovered but cannot run agents yet.", route: "models", project: null },
    { id: "project", label: "Create a project", done: active.length > 0, detail: active.length ? "" : "A project holds repos, approvers and a budget.", route: "projects", project: null },
    { id: "repo", label: "Onboard a repo", done: readyRepo, detail: readyRepo ? "" : open ? `${open.name}: ${stageText[open.onboarding?.stage ?? ""] ?? "in progress"}` : "Connect a repo to the project and let the onboarding agent verify it.", route: "onboarding", project: (open ?? repos[0])?.project ?? active[0]?.id ?? null },
    { id: "work-order", label: "Submit the first work order", done: num(anyWo.rows[0]?.n) > 0, detail: "Once a repo is Ready, submit work and watch it move down the belt.", route: "work-orders", project: active[0]?.id ?? null },
  ];
  const firstOpen = steps.findIndex((x) => !x.done);
  if (firstOpen < 0) return null;
  return { done: steps.filter((x) => x.done).length, total: steps.length, steps: steps.map((x, i) => ({ id: x.id, label: x.label, state: x.done ? "done" : i === firstOpen ? "active" : "todo", detail: x.done ? "" : x.detail, route: x.route, project: x.project })) };
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
  const visIds = new Set(vis.map((p) => p.id));
  const projName = (id: string): string => st.projects.find((p) => p.id === id)?.name ?? id;
  const holds = (action: string, project?: string): boolean => {
    const act = st.catalog.actions.find((a) => a.id === action);
    const grants = me.roles.filter((g) => g.scope === "factory" || (act?.scope !== "factory" && (act?.scope !== "project" || !project || g.scope === project)));
    return grants.some((g) => roleHolds(st, g.role, action));
  };
  const out: Record<string, unknown> = { approvals, conversations, badges: {} as Record<string, unknown>, projectBadges: {} as Record<string, Record<string, unknown>> };

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
  if (n(lp) && (factoryRole || holds("learning.apply"))) badges.learning = { n: n(lp), label: `${n(lp)} learning proposals to review` };
  if (n(bad) && holds("integrations.view")) badges.integrations = { n: n(bad), kind: "is-warn", label: `${n(bad)} integrations failing or offline` };
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

  // ---- Home sections: built by the caller's rights, never filtered in the browser. A section the person may not see is absent, not empty. ----
  if (!vis.length && !factoryRole) {
    out.sections = { access: "none" };
    return out;
  }
  const fk = stops.find((s) => s.scope === "factory" && s.mode === "kill");
  const restore = fk ? await db.query<{ approver: string; at: Date }>(`select approver, at from restore_approvals where org_id = $1 and stop_id = $2 order by at`, [orgId, fk.id]) : { rows: [] as Array<{ approver: string; at: Date }> };
  const sec = fk ? await readSecurity(db, orgId) : null;
  const evals = holds("agents.view") ? await evalHealth(db, orgId) : null;
  const scope: Scope = {
    me, vis: visIds, holds, evals, policy: st0,
    restore: { approvals: restore.rows.map((r) => ({ by: r.approver, at: ms(r.at) ?? 0 })), needs: sec?.value.restoreFactoryNeedsTwo ? 2 : 1 },
  };
  const items = await attention(db, orgId, st, stops, now, scope);
  const visWos = (st.workOrders as HomeWorkOrder[]).filter((w) => visIds.has(w.project));
  const live = visWos.filter(inFlight);
  const gates = waitingGates(visWos, st.projects, now);
  const dayStart = istTime(istToday(now, 0), "00:00");
  const shipped = visWos.filter((w) => w.state === "done" && !w.split && w.doneAt);
  const stationIds = st.catalog.stations.map((s) => s.id);
  const byStation: Record<string, number> = {};
  for (const w of live) if (!w.bay) byStation[stationIds[w.station] ?? ""] = (byStation[stationIds[w.station] ?? ""] ?? 0) + 1;
  const prevWeek = await db.query<{ n: string }>(
    `select count(*)::text as n from work_orders where org_id = $1 and state = 'done' and source not in ('eval','onboarding') and project_id = any($2::text[]) and closed_at >= $3 and closed_at < $4`,
    [orgId, [...visIds], new Date(now - 14 * DAY), new Date(now - 7 * DAY)],
  );
  const shippedWeek = shipped.filter((w) => (w.doneAt ?? 0) >= now - 7 * DAY).length;
  const mine = visWos
    .filter((w) => w.requestedBy === me.id && (inFlight(w) || (w.doneAt && w.doneAt > now - 7 * DAY) || w.state === "killed"))
    .sort((a, b) => Number(inFlight(b)) - Number(inFlight(a)) || b.createdAt - a.createdAt)
    .map((w) => ({
      id: w.id, title: w.title, project: w.project, projectName: projName(w.project), state: w.state, bay: w.bay, cls: w.cls, priority: w.priority, doneAt: w.doneAt,
      station: st.catalog.stations[w.station]?.name ?? "", stationId: st.catalog.stations[w.station]?.id ?? null, bayName: w.bay ? st.catalog.bays.find((b) => b.id === w.bay)?.name ?? w.bay : null,
    }));
  const motion = {
    inFlight: live.length, running: live.filter((w) => w.state === "running").length, inBays: live.filter((w) => w.bay).length, byStation,
    shippedToday: shipped.filter((w) => (w.doneAt ?? 0) >= dayStart).length, shippedWeek, shippedPrevWeek: num(prevWeek.rows[0]?.n),
    recentDone: shipped.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, 5).map((w) => ({ id: w.id, title: w.title, project: w.project, projectName: projName(w.project), doneAt: w.doneAt })),
    mine,
  };
  const myProjects = vis.map((p) => {
    const rs = st.repos.filter((r) => r.project === p.id);
    return {
      id: p.id, roles: rolesIn(me, p.id).map((r) => ({ id: r, name: st.catalog.roles.find((x) => x.id === r)?.name ?? r })),
      repos: rs.filter((r) => !(r.onboarding?.stage === "ready" || r.onboarding?.exception)).map((r) => ({ id: r.id, name: r.name, stage: r.onboarding?.stage ?? "connected", blocker: r.onboarding?.blocker ?? "" })),
    };
  });
  const active = st.projects.filter((p) => visIds.has(p.id) && p.status !== "archived");
  const decides = ["gate.approve", "wo.answer", "brief.confirm", "onboarding.merge"].some((a) => holds(a));
  const sections: Record<string, unknown> = { attention: items, motion, projects: myProjects };
  if (decides || approvals.length || conversations.length) sections.waiting = { approvals, conversations };
  // Read-only view of the human bottleneck for people who audit but do not decide (the Auditor).
  if (holds("audit.view") && !holds("gate.approve")) {
    const per = new Map<string, { count: number; oldestMs: number }>();
    for (const g of gates) {
      const c = per.get(g.wo.project) ?? { count: 0, oldestMs: 0 };
      c.count += 1;
      c.oldestMs = Math.max(c.oldestMs, g.age);
      per.set(g.wo.project, c);
    }
    sections.approvers = { count: gates.length, oldestMs: gates[0]?.age ?? 0, late: gates.filter((g) => g.late).length, byProject: [...per.entries()].map(([id, c]) => ({ id, name: projName(id), ...c })) };
  }
  if (factoryRole && (holds("models.view") || holds("audit.view") || evals)) {
    const spent = active.reduce((a, p) => a + p.budget.mtd, 0);
    const budget = active.reduce((a, p) => a + p.budget.monthly, 0);
    sections.health = {
      spend: { spent, budget, projects: active.map((p) => ({ id: p.id, label: p.name, v: p.budget.mtd, b: p.budget.monthly, alert: p.budget.alertAt })) },
      evals, audit: holds("audit.view"),
    };
  }
  if (isFactoryAdmin(st, me.id)) {
    const setup = await setupSteps(db, orgId, st, st.projects.filter((p) => p.status !== "archived"));
    if (setup) sections.setup = setup;
  }
  out.sections = sections;
  return out;
}

export type { Project, Repo };
