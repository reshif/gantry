/**
 * The console's fixed tool set (spec 12.6).
 *
 * Read tools answer from live data, through the same endpoints the screens use, called in-process with the person's own session: every
 * visibility rule, project filter and permission is the one the person already has, so the model can never see more than they can. Work order,
 * issue and repository text in a result is wrapped by `mark()` as untrusted data.
 *
 * Action tools never execute. They return a proposal: the ordinary endpoint to call, its body, the permission it needs and what the decision point
 * says about it right now. The frontend renders it as a confirm card; confirming calls that endpoint under the person's own authority, so the
 * decision point, audit, stop checks and idempotency are the endpoint's own. A kind of proposal is offered only to a person who holds its console right (console.propose.*).
 */
import { briefBase, can, policyTrace, visibleProjects } from "@gantry/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { decide, policyState, type PolicyStateLoaded } from "../../core/index.js";
import type { Decision } from "@gantry/domain";
import { actionForGate } from "../workorders/gates.js";
import { scopeFromApi, stopAction } from "../stops/targets.js";
import { mark, markAll } from "./mark.js";

export interface Cited { type: "wo" | "project" | "repo" | "agent" | "person" | "gate"; id: string; label?: string; project?: string }

export interface Proposal {
  id: string;
  kind: "submit" | "approve" | "halt" | "resume" | "kill" | "restore" | "park" | "trust" | "onboard";
  title: string;
  summary: string;
  steps: string[];
  /** The ordinary endpoint a confirmed card calls. `body` carries the proposed values; the card may edit `reason`, `inFlight` and `confirmText`. */
  call: { method: "POST" | "DELETE"; path: string; body: Record<string, unknown>; idempotent: boolean };
  /** The catalog action and scope the endpoint will check, so the card can show who may do it. */
  perm: { action: string; project?: string | null };
  /** What the decision point says for this person right now. A denied card shows the reason and cannot be confirmed. */
  check: Pick<Decision, "allowed" | "reason" | "needs"> & { rule?: string };
  /** The card asks for a reason (at least this many characters). */
  needsReason: number | null;
  /** A typed confirmation (kill of a project or the factory). */
  phrase: string | null;
  danger: boolean;
  entities: Cited[];
  status: "pending" | "done" | "failed" | "dismissed";
  result?: string;
  /** What a refused card still needs (the server's own `needs` line) and the rule that refused it; written by the server when it ran the card. */
  needs?: string;
  refusal?: { code: number; rule?: unknown; overrideKind?: string };
}

export interface ToolCtx {
  app: FastifyInstance;
  req: FastifyRequest;
  person: { id: string; name: string };
  /** Names of the propose tools this person may be offered (their console rights); empty: read-only console. */
  proposeTools: ReadonlySet<string>;
  /** Why a tool is not offered (names the missing right); set by the caller. */
  denyText?: (tool: string) => string;
  proposals: Proposal[];
  cited: Cited[];
  used: string[];
  /** Number proposals within the answer. */
  next: number;
  now: () => number;
  _projects?: Array<Record<string, unknown>>;
  _state?: PolicyStateLoaded;
  /** Work order ids that appeared in a tool result: the only ones an answer may cite as chips. */
  seenWo: Set<string>;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  kind: "read" | "propose";
  run(ctx: ToolCtx, input: Record<string, unknown>): Promise<unknown>;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown, d: number, lo: number, hi: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : d);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const iso = (ms: unknown): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** Calls one of the product's own GET endpoints in-process, as the person (their cookie, their address). */
export async function api(ctx: ToolCtx, url: string): Promise<{ status: number; body: unknown }> {
  const res = await ctx.app.inject({ method: "GET", url, headers: { cookie: String(ctx.req.headers.cookie ?? ""), "x-gantry-console": "tool" }, remoteAddress: ctx.req.ip });
  let body: unknown = null;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body };
}

const visibleProjectsOf = async (ctx: ToolCtx): Promise<Json[]> => {
  if (!ctx._projects) {
    const r = await api(ctx, "/api/v1/projects");
    ctx._projects = r.status === 200 ? (arr(r.body) as Json[]) : [];
  }
  return ctx._projects;
};
const stateOf = async (ctx: ToolCtx): Promise<PolicyStateLoaded> => (ctx._state ??= await policyState(ctx.req));

/** A project named by id, key or name, among those the person can see. `false`: not visible. `null`: none asked for. */
async function projArg(ctx: ToolCtx, v: unknown): Promise<Json | null | false> {
  const q = str(v);
  if (!q) return null;
  const lo = q.toLowerCase();
  const p = (await visibleProjectsOf(ctx)).find((x) => x.id === q || String(x.name).toLowerCase() === lo || String(x.key ?? "").toLowerCase() === lo || String(x.id).toLowerCase() === lo);
  return p ?? false;
}
const NO_PROJECT = { error: "No such project, or it is not visible to this person." };

function cite(ctx: ToolCtx, c: Cited): void {
  if (!ctx.cited.some((x) => x.type === c.type && x.id === c.id)) ctx.cited.push(c);
}

const woBrief = (w: Json): Json => ({
  id: w.id, title: mark(w.title, 200), project: w.project, repo: w.repo, cls: w.cls, priority: w.priority, station: w.station, state: w.state, bay: w.bay ?? null,
  source: w.source, createdAt: iso(w.createdAt), doneAt: iso(w.doneAt), ...(w.blockReason ? { blockReason: mark(w.blockReason, 300) } : {}), ...(w.failReason ? { failReason: mark(w.failReason, 300) } : {}),
});

const waitingGate = (w: Json): string | null => {
  const g = Object.entries(obj(w.gates)).find(([, x]) => obj(x).status === "waiting");
  return g ? g[0] : null;
};

/* ------------------------------------------------------------------------------------------------ read tools */

const READ: ToolDef[] = [
  {
    name: "list_projects", kind: "read", description: "List the projects the person can see with status, work in flight, waiting gates and halts or kills.", input_schema: { type: "object", properties: {} },
    async run(ctx) {
      return (await visibleProjectsOf(ctx)).map((p) => {
        const m = obj(p.metrics);
        return { id: p.id, name: p.name, key: p.key, status: p.status, regulated: !!p.regulated, halted: p.halted ?? null, killed: p.killed ?? null, inFlight: m.wip ?? 0, waitingAtGates: m.gates ?? 0, inBays: m.bays ?? 0, health: obj(m.health).label ?? null };
      });
    },
  },
  {
    name: "list_work_orders", kind: "read",
    description: "Find work orders in the projects the person can see. Filters: project, state (running|waiting|blocked|failed|done|killed), cls, query (text in the title), limit (max 40).",
    input_schema: { type: "object", properties: { project: { type: "string" }, state: { type: "string" }, cls: { type: "string" }, query: { type: "string" }, limit: { type: "number" } } },
    async run(ctx, i) {
      const p = await projArg(ctx, i.project);
      if (p === false) return NO_PROJECT;
      const ps = p ? [p] : await visibleProjectsOf(ctx);
      const limit = num(i.limit, 20, 1, 40);
      const qs = new URLSearchParams({ limit: String(limit), sort: "age", dir: "desc" });
      if (str(i.state)) qs.set("state", str(i.state)!);
      if (str(i.cls)) qs.set("cls", str(i.cls)!);
      if (str(i.query)) qs.set("q", str(i.query)!);
      const out: Json[] = [];
      let total = 0;
      for (const x of ps) {
        const r = await api(ctx, `/api/v1/projects/${encodeURIComponent(String(x.id))}/work-orders?${qs}`);
        if (r.status !== 200) continue;
        const b = obj(r.body);
        total += Number(b.total ?? 0);
        for (const w of arr(b.items)) out.push(woBrief(w as Json));
      }
      out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return { total, shown: Math.min(out.length, limit), workOrders: out.slice(0, limit) };
    },
  },
  {
    name: "get_work_order", kind: "read",
    description: "The record of one work order: request, brief, plan, files changed, tests, review, gate decisions, outcomes, and whether the person may act on it.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(ctx, i) {
      const id = str(i.id)?.toUpperCase();
      if (!id) return { error: "Give a work order id such as WO-1042." };
      const r = await api(ctx, `/api/v1/work-orders/${encodeURIComponent(id)}`);
      if (r.status !== 200) return { error: `No visible work order ${id}.` };
      const w = obj(r.body);
      cite(ctx, { type: "wo", id });
      const rec = await api(ctx, `/api/v1/work-orders/${encodeURIComponent(id)}/record`);
      const rb = obj(rec.status === 200 ? rec.body : {});
      return {
        ...woBrief(w),
        request: mark(obj(w.request).text ?? w.description, 1500),
        criteria: arr(w.criteria).slice(0, 15).map((c) => ({ text: mark(obj(c).text, 240), status: obj(c).status })),
        plan: arr(w.plan).slice(0, 15).map((s) => mark(typeof s === "string" ? s : obj(s).text ?? obj(s).title, 240)),
        files: arr(w.files).slice(0, 25).map((f) => ({ path: mark(obj(f).path, 200), status: obj(f).status, plus: obj(f).plus, minus: obj(f).minus })),
        gates: Object.entries(obj(w.gates)).map(([k, g]) => ({ gate: k, status: obj(g).status, approvals: arr(obj(g).approvals).map((a) => ({ by: obj(a).by, at: iso(obj(a).at), trust: obj(a).trust ?? null })), rejections: arr(obj(g).rejections).length, decision: obj(g).decision ?? null })),
        gateProgress: w.gateProgress ?? null,
        pr: w.pr ? { number: obj(w.pr).number, state: obj(w.pr).state, checks: obj(w.pr).checks, tag: obj(w.pr).tag ?? null } : null,
        outcomes: arr(w.outcomes).map((o) => ({ kind: obj(o).kind, at: iso(obj(o).at), text: mark(obj(o).text, 300) })),
        sendbacks: arr(w.sendbacks).length,
        stop: w.stop ?? null,
        youMayAct: w.allowed ?? null,
        summary: rb.summary ? mark(obj(rb.summary).text ?? rb.summary, 1500) : null,
      };
    },
  },
  {
    name: "project_status", kind: "read", description: "One project in detail: stations in order with work at each, waiting gates, bays, halts and kills, coding slots, repos with onboarding stage.",
    input_schema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
    async run(ctx, i) {
      const p = await projArg(ctx, i.project);
      if (!p) return NO_PROJECT;
      const pid = encodeURIComponent(String(p.id));
      cite(ctx, { type: "project", id: String(p.id), label: String(p.name) });
      const [floor, repos] = await Promise.all([api(ctx, `/api/v1/projects/${pid}/floor`), api(ctx, `/api/v1/projects/${pid}/repos`)]);
      const f = obj(floor.status === 200 ? floor.body : {});
      const wos = arr(f.workOrders) as Json[];
      const open = wos.filter((w) => !["done", "killed"].includes(String(w.state)));
      const flow = obj(p.flow);
      const stations = arr(flow.order).map((sid) => ({ station: sid, here: open.filter((w) => w.station === sid && !w.bay).length }));
      return {
        id: p.id, name: p.name, status: p.status, regulated: !!p.regulated, halted: p.halted ?? null, killed: p.killed ?? null, stops: f.stops ?? [], slots: f.slots ?? null,
        budget: p.budget ?? null, metrics: obj(p.metrics).health ?? null,
        stations,
        waiting: open.filter((w) => w.state === "waiting").slice(0, 25).map((w) => ({ id: w.id, title: mark(w.title, 120), gate: waitingGate(w) })),
        bays: arr(flow.bays).map((b) => ({ bay: b, count: open.filter((w) => w.bay === b).length })),
        blocked: open.filter((w) => ["blocked", "failed"].includes(String(w.state))).slice(0, 15).map((w) => ({ id: w.id, state: w.state, reason: mark(w.blockReason ?? w.failReason, 200) })),
        repos: (repos.status === 200 ? arr(repos.body) : []).map((r) => ({ id: obj(r).id, name: mark(obj(r).name, 100), onboarding: obj(obj(r).onboarding).stage, halted: obj(r).halted ?? null })),
      };
    },
  },
  {
    name: "onboarding_state", kind: "read", description: "Onboarding stage and blockers for repos, optionally in one project.",
    input_schema: { type: "object", properties: { project: { type: "string" } } },
    async run(ctx, i) {
      const p = await projArg(ctx, i.project);
      if (p === false) return NO_PROJECT;
      const ps = p ? [p] : await visibleProjectsOf(ctx);
      const out: Json[] = [];
      for (const x of ps) {
        const r = await api(ctx, `/api/v1/projects/${encodeURIComponent(String(x.id))}/repos`);
        if (r.status !== 200) continue;
        for (const repo of arr(r.body) as Json[]) {
          const ob = obj(repo.onboarding);
          const pr = obj(ob.pr);
          out.push({ repo: mark(repo.name, 100), repoId: repo.id, project: x.id, stage: ob.stage, blocker: ob.blocker ? mark(ob.blocker, 300) : null, pr: pr.number ? { number: pr.number, state: pr.state, checks: pr.checks } : null, halted: repo.halted ?? null });
        }
      }
      return out;
    },
  },
  {
    name: "who_can", kind: "read",
    description: "Who may do an action (for example gate.approve, kill.project, trust.grant, line.halt, release) in a project, with the deciding rule, using the live policy engine. Optionally for one named person and a moment (epoch ms).",
    input_schema: { type: "object", properties: { action: { type: "string" }, project: { type: "string" }, repo: { type: "string" }, person: { type: "string" }, at: { type: "number" } }, required: ["action"] },
    async run(ctx, i) {
      const st = await stateOf(ctx);
      const act = (st.catalog?.actions ?? []).find((a) => a.id === str(i.action));
      if (!act) return { error: `Unknown action. Known: ${(st.catalog?.actions ?? []).map((a) => a.id).join(", ")}` };
      const p = await projArg(ctx, i.project);
      if (p === false) return NO_PROJECT;
      if (act.scope === "project" && !p) return { error: "That action is project-scoped: name a project." };
      const at = typeof i.at === "number" && Number.isFinite(i.at) ? i.at : ctx.now();
      const visible = new Set(visibleProjects(st, ctx.person.id).map((x) => x.id));
      const factoryWide = st.people.find((x) => x.id === ctx.person.id)?.roles.some((r) => r.scope === "factory") ?? false;
      const q = str(i.person)?.toLowerCase();
      // People the person can already see: those holding a factory role or a role in a project they see (nobody known only from another project).
      const people = st.people.filter((x) => x.status === "active" && (factoryWide || x.id === ctx.person.id || x.roles.some((g) => g.scope === "factory" || visible.has(g.scope))) && (!q || x.id.toLowerCase() === q || x.name.toLowerCase().includes(q)));
      const rows = people.map((x) => {
        const d = can(st, x.id, act.id, { project: act.scope === "project" ? String(p && p.id) : null, repo: str(i.repo) ?? null, time: at });
        return { person: x.name, id: x.id, allowed: d.allowed, reason: d.reason, rule: d.rule.id, needs: d.needs };
      });
      const shown = q ? rows : rows.filter((r) => r.allowed);
      shown.slice(0, 10).forEach((r) => cite(ctx, { type: "person", id: r.id, label: r.person }));
      return { action: act.id, name: act.name, scope: act.scope, project: p ? p.id : null, at: iso(at), allowed: rows.filter((r) => r.allowed).length, denied: rows.filter((r) => !r.allowed).length, people: shown.slice(0, 25) };
    },
  },
  {
    name: "explain_denial", kind: "read",
    description: "Why the policy engine allowed or denied an action for a person (default: the person asking): the roles in scope, the matrix, policies, freezes, the deciding rule, and what would change the answer. The trace is authoritative.",
    input_schema: { type: "object", properties: { action: { type: "string" }, project: { type: "string" }, repo: { type: "string" }, person: { type: "string" }, at: { type: "number" } }, required: ["action"] },
    async run(ctx, i) {
      const st = await stateOf(ctx);
      const who = str(i.person) ?? ctx.person.id;
      const target = st.people.find((x) => x.id === who || x.name.toLowerCase() === who.toLowerCase());
      if (!target) return { error: "No such person." };
      if (target.id !== ctx.person.id) {
        // Asking about someone else needs a right that already shows the permission structure (the same rule as the access simulator).
        const ds = await Promise.all(["policy.edit", "role.edit", "people.manage", "audit.view"].map((a) => decide(ctx.req, a)));
        if (!ds.some((d) => d.allowed)) return { error: "Explaining another person's access needs the right to manage people, roles, policies or the audit." };
      }
      const act = (st.catalog?.actions ?? []).find((a) => a.id === str(i.action));
      if (!act) return { error: `Unknown action. Known: ${(st.catalog?.actions ?? []).map((a) => a.id).join(", ")}` };
      const p = await projArg(ctx, i.project);
      if (p === false) return NO_PROJECT;
      const at = typeof i.at === "number" && Number.isFinite(i.at) ? i.at : ctx.now();
      const scope = { project: act.scope === "project" ? (p ? String(p.id) : null) : null, repo: act.scope === "project" ? str(i.repo) ?? null : null, time: at };
      if (act.scope === "project" && !scope.project) return { error: "That action is project-scoped: name a project." };
      const d = can(st, target.id, act.id, scope);
      return { person: target.name, action: `${act.id} (${act.name})`, project: scope.project, at: iso(at), decision: { allowed: d.allowed, reason: d.reason, rule: d.rule, needs: d.needs }, trace: policyTrace(st, target.id, act.id, scope) };
    },
  },
  {
    name: "waiting_on_me", kind: "read", description: "What waits on the person: gates they may decide now, onboarding pull requests they may merge, and intake conversations that wait for their answer.",
    input_schema: { type: "object", properties: {} },
    async run(ctx) {
      const r = await api(ctx, "/api/v1/home");
      if (r.status !== 200) return { error: "Could not read what waits on you." };
      const b = obj(r.body);
      const approvals = arr(b.approvals) as Json[];
      approvals.filter((a) => a.wo).slice(0, 10).forEach((a) => cite(ctx, { type: "wo", id: String(a.wo) }));
      return {
        approvals: approvals.slice(0, 30).map((a) => ({ wo: a.wo ?? null, title: mark(a.title, 160), gate: a.gate ?? null, project: a.project ?? null, repo: a.repoName ? mark(a.repoName, 80) : null, onboardingPr: a.pr ?? null })),
        conversations: (arr(b.conversations) as Json[]).slice(0, 20).map((c) => ({ wo: c.wo, title: mark(c.title, 160), project: c.project })),
      };
    },
  },
  {
    name: "triggers", kind: "read", description: "GitHub and schedule triggers of a project (default: all the person's projects): type, whether on, and the last run. Triggers are off in a new install.",
    input_schema: { type: "object", properties: { project: { type: "string" } } },
    async run(ctx, i) {
      const p = await projArg(ctx, i.project);
      if (p === false) return NO_PROJECT;
      const r = await api(ctx, "/api/v1/triggers");
      if (r.status !== 200) return { error: "Triggers are not available to this person." };
      return (arr(r.body) as Json[]).filter((t) => !p || t.project === p.id).slice(0, 40).map((t) => {
        const last = arr(t.runs).at(-1) as Json | undefined;
        return { id: t.id, project: t.project, name: mark(t.name, 120), type: t.type, enabled: !!t.enabled, label: t.label ? mark(t.label, 60) : null, schedule: t.schedule ?? null, command: t.command ? mark(t.command, 60) : null, lastRun: last ? { outcome: last.outcome, at: iso(last.at) } : null, held: t.held ?? 0 };
      });
    },
  },
  {
    name: "evals", kind: "read", description: "Agents with their live version, eval suite, threshold and the latest runs with scores.",
    input_schema: { type: "object", properties: { agent: { type: "string" } } },
    async run(ctx, i) {
      const [agents, suites, runs] = await Promise.all([api(ctx, "/api/v1/agents"), api(ctx, "/api/v1/suites"), api(ctx, "/api/v1/evals/runs")]);
      const q = str(i.agent)?.toLowerCase();
      const su = new Map((suites.status === 200 ? (arr(suites.body) as Json[]) : []).map((s) => [String(s.id), s]));
      const rs = (runs.status === 200 ? (arr(runs.body) as Json[]) : []).filter((r) => r.status === "completed" || r.status === undefined);
      return (agents.status === 200 ? (arr(agents.body) as Json[]) : []).filter((a) => !q || a.id === q || String(a.name).toLowerCase().includes(q)).map((a) => {
        const s = su.get(String(a.suite));
        const mine = rs.filter((r) => r.agent === a.id).sort((x, y) => Number(y.at) - Number(x.at)).slice(0, 3);
        return { id: a.id, name: a.name, version: a.version, status: a.status, suite: s ? s.id : null, threshold: s ? s.threshold : null, recent: mine.map((r) => ({ id: r.id, version: r.version, score: r.score, at: iso(r.at), model: r.model })) };
      });
    },
  },
  {
    name: "workload", kind: "read", description: "Human workload from real history (default last 7 days) in the person's projects or one project: approval minutes per person and team, after-hours share, bottleneck gates, suggestions.",
    input_schema: { type: "object", properties: { project: { type: "string" }, days: { type: "number" } } },
    async run(ctx, i) {
      const p = await projArg(ctx, i.project);
      if (p === false) return NO_PROJECT;
      const r = await api(ctx, `/api/v1/workload?scope=${p ? encodeURIComponent(String(p.id)) : "all"}&days=${num(i.days, 7, 1, 30)}`);
      if (r.status !== 200) return { error: "Workload is not available." };
      const w = obj(r.body);
      return { scope: p ? p.name : "your projects", days: w.days, totals: w.totals, people: arr(w.rows).slice(0, 12), teams: arr(w.teams).slice(0, 8), bottlenecks: arr(w.bottlenecks).slice(0, 8), suggestions: arr(w.suggestions).slice(0, 6) };
    },
  },
  {
    name: "trust", kind: "read", description: "Trust ladder cells (agent x class x project) with level, ceiling, clean runs and pending promotion proposals; optionally for one project.",
    input_schema: { type: "object", properties: { project: { type: "string" }, agent: { type: "string" }, cls: { type: "string" } } },
    async run(ctx, i) {
      const p = await projArg(ctx, i.project);
      if (p === false) return NO_PROJECT;
      const r = await api(ctx, `/api/v1/trust/cells${p ? `?project=${encodeURIComponent(String(p.id))}` : ""}`);
      if (r.status !== 200) return { error: "Trust is not available." };
      const cells = (arr(obj(r.body).cells) as Json[]).filter((c) => (!str(i.agent) || c.agent === str(i.agent)) && (!str(i.cls) || c.cls === str(i.cls)));
      const lv = [0, 0, 0, 0, 0];
      for (const c of cells) lv[Math.min(4, Number(c.level) || 0)]!++;
      return {
        project: p ? p.id : null, byLevel: lv,
        cells: cells.slice(0, 40).map((c) => ({ id: c.id, agent: c.agent, cls: c.cls, project: c.project, level: c.level, effective: c.effective, ceiling: obj(c.ceiling).max, cleanRuns: c.cleanRuns, pending: c.pending ?? null })),
        pendingProposals: cells.filter((c) => c.pending).length,
      };
    },
  },
  {
    name: "audit_search", kind: "read", description: "Search the audit ledger by text, optionally in one project, outcome (ok|denied|failed|regression) or category. Needs the right to read the audit.",
    input_schema: { type: "object", properties: { query: { type: "string" }, project: { type: "string" }, outcome: { type: "string" }, category: { type: "string" }, limit: { type: "number" } } },
    async run(ctx, i) {
      const p = await projArg(ctx, i.project);
      if (p === false) return NO_PROJECT;
      const qs = new URLSearchParams({ limit: String(num(i.limit, 20, 1, 50)) });
      if (str(i.query)) qs.set("q", str(i.query)!);
      if (p) qs.set("project", String(p.id));
      if (str(i.outcome)) qs.set("outcome", str(i.outcome)!);
      if (str(i.category)) qs.set("category", str(i.category)!);
      const r = await api(ctx, `/api/v1/audit?${qs}`);
      if (r.status === 403) return { error: "This person may not read the audit ledger." };
      if (r.status !== 200) return { error: "The audit ledger could not be read." };
      return arr(obj(r.body).items).map((a) => ({ seq: obj(a).seq, at: iso(obj(a).at), actor: obj(a).actorName ?? obj(a).actor, action: obj(a).action, target: mark(obj(a).target, 200), project: obj(a).project ?? null, outcome: obj(a).outcome, channel: obj(a).channel }));
    },
  },
  {
    name: "events", kind: "read", description: "The event log of one project (submissions, gate decisions, trust changes, releases, halts, kills) for the last N hours (default 24, max 168).",
    input_schema: { type: "object", properties: { project: { type: "string" }, since_hours: { type: "number" }, types: { type: "array", items: { type: "string" } } }, required: ["project"] },
    async run(ctx, i) {
      const p = await projArg(ctx, i.project);
      if (!p) return NO_PROJECT;
      const hours = num(i.since_hours, 24, 1, 168);
      const qs = new URLSearchParams({ from: String(ctx.now() - hours * 3600_000) });
      const kinds = arr(i.types).filter((t): t is string => typeof t === "string").join(",");
      if (kinds) qs.set("kinds", kinds);
      const r = await api(ctx, `/api/v1/projects/${encodeURIComponent(String(p.id))}/events?${qs}`);
      if (r.status !== 200) return { error: "Events are not available." };
      const list = arr(r.body) as Json[];
      const count: Record<string, number> = {};
      for (const e of list) count[String(e.type)] = (count[String(e.type)] ?? 0) + 1;
      return { project: p.id, hours, total: list.length, count, recent: list.slice(-40).map((e) => ({ at: iso(e.at), type: e.type, by: e.by ?? null, wo: e.wo ?? null })) };
    },
  },
];

/* ------------------------------------------------------------------------------------------------ propose tools */

const mk = async (
  ctx: ToolCtx,
  p: Omit<Proposal, "id" | "status" | "check"> & { scope: { project?: string | null; repo?: string | null; wo?: string | null } },
): Promise<unknown> => {
  const { scope, ...rest } = p;
  const st = await stateOf(ctx);
  // A factory kill refuses every command but the restore: say so on the card before the person confirms.
  const killed = !!st.stops?.factory;
  let check: Proposal["check"];
  if (killed && rest.kind !== "restore") check = { allowed: false, reason: "The factory is killed. Nothing changes until it is restored.", needs: "restore.factory", rule: "STOP" };
  else {
    const d = await decide(ctx.req, rest.perm.action, scope);
    check = { allowed: d.allowed, reason: d.reason, needs: d.needs, rule: d.rule.id };
  }
  const prop: Proposal = { ...rest, id: `PROP-${ctx.next++}`, status: "pending", check };
  ctx.proposals.push(prop);
  return { proposed: prop.id, title: prop.title, allowed: check.allowed, reason: check.reason, note: "Shown to the person as a confirm card. It has not run." };
};

const stopTarget = async (ctx: ToolCtx, scope: string, id: string | undefined): Promise<{ project: string | null; label: string; apiId: string; wo?: string } | { error: string }> => {
  if (scope === "factory") return { project: null, label: "the factory", apiId: "factory:" };
  if (scope === "project") {
    const p = await projArg(ctx, id);
    return p ? { project: String(p.id), label: String(p.name), apiId: `project:${p.id}` } : { error: "No visible project." };
  }
  if (scope === "workorder") {
    const w = id ? await api(ctx, `/api/v1/work-orders/${encodeURIComponent(id.toUpperCase())}`) : null;
    return w && w.status === 200 ? { project: String(obj(w.body).project), label: String(obj(w.body).id), apiId: `workorder:${obj(w.body).id}`, wo: String(obj(w.body).id) } : { error: "No visible work order." };
  }
  if (scope === "repo") {
    for (const x of await visibleProjectsOf(ctx)) {
      const r = await api(ctx, `/api/v1/projects/${encodeURIComponent(String(x.id))}/repos`);
      const repo = (r.status === 200 ? (arr(r.body) as Json[]) : []).find((y) => y.id === id || y.name === id);
      if (repo) return { project: String(x.id), label: String(repo.name), apiId: `repo:${repo.id}` };
    }
    return { error: "No visible repo." };
  }
  return { error: "Scope is factory, project, repo or workorder." };
};

const PROPOSE: ToolDef[] = [
  {
    name: "propose_submit_work_order", kind: "propose", description: "Propose a new work order. The person confirms in the page.",
    input_schema: { type: "object", properties: { project: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, description: { type: "string" }, priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] } }, required: ["project", "repo", "title"] },
    async run(ctx, i) {
      const p = await projArg(ctx, i.project);
      if (!p) return NO_PROJECT;
      const r = await api(ctx, `/api/v1/projects/${encodeURIComponent(String(p.id))}/repos`);
      const repo = (r.status === 200 ? (arr(r.body) as Json[]) : []).find((x) => x.id === str(i.repo) || x.name === str(i.repo));
      if (!repo) return { error: `That repo is not in ${p.name}.` };
      const title = str(i.title)?.slice(0, 300);
      if (!title) return { error: "A work order needs a title." };
      const stage = obj(repo.onboarding).stage;
      return mk(ctx, {
        kind: "submit", title: `Submit a work order to ${repo.name}`, summary: title,
        steps: [`Title: ${title}`, ...(str(i.description) ? [`Description: ${str(i.description)!.slice(0, 300)}`] : []), "It starts at Intake; the Intake Clerk opens a conversation with you to build the brief", ...(stage !== "ready" ? [`The repo is at onboarding stage ${String(stage)}; work orders can only go to Ready repos.`] : [])],
        call: { method: "POST", path: `/api/v1/projects/${p.id}/work-orders`, body: { repo: repo.id, title, description: str(i.description) ?? "", ...(["P0", "P1", "P2", "P3"].includes(String(i.priority)) ? { priority: i.priority } : {}), source: "console", via: "console" }, idempotent: true },
        perm: { action: "wo.submit", project: String(p.id) }, needsReason: null, phrase: null, danger: false, entities: [{ type: "project", id: String(p.id), label: String(p.name) }], scope: { project: String(p.id), repo: String(repo.id) },
      });
    },
  },
  {
    name: "propose_approve_gate", kind: "propose", description: "Propose approving the gate a work order is waiting at.",
    input_schema: { type: "object", properties: { wo: { type: "string" } }, required: ["wo"] },
    async run(ctx, i) {
      const id = str(i.wo)?.toUpperCase();
      const r = id ? await api(ctx, `/api/v1/work-orders/${encodeURIComponent(id)}`) : null;
      if (!r || r.status !== 200) return { error: "No visible work order." };
      const w = obj(r.body);
      const gate = waitingGate(w);
      if (!gate) return { error: `${id} is not waiting at a gate.` };
      const st = await stateOf(ctx);
      const prog = obj(obj(w.gateProgress)[gate] ?? w.gateProgress);
      // The decision names the exact opening the person is shown (A8): a stale card cannot land on a newer instance.
      const opened = str(obj(obj(w.allowed).approve).instance);
      const instance = opened && opened.split(":").length === 3 ? opened : `${id}:${gate}`;
      return mk(ctx, {
        kind: "approve", title: `Approve ${gate} on ${id}`, summary: String(w.title ?? ""),
        steps: [mark(w.title, 160), ...(typeof prog.have === "number" ? [`Approvals so far: ${prog.have} of ${String(prog.need)}`] : [])],
        call: { method: "POST", path: `/api/v1/gate-instances/${encodeURIComponent(instance)}/approve`, body: { via: "console", ...(gate === "G0G1" ? { briefBase: briefBase(obj(w.brief) as never) } : {}) }, idempotent: false },
        perm: { action: actionForGate(st.catalog, gate), project: String(w.project) }, needsReason: null, phrase: null, danger: false, entities: [{ type: "wo", id: id! }], scope: { project: String(w.project), repo: w.repo ? String(w.repo) : null, wo: id! },
      });
    },
  },
  {
    name: "propose_halt", kind: "propose", description: "Propose halting a repo line or a whole project (stops new work; reversible).",
    input_schema: { type: "object", properties: { scope: { type: "string", enum: ["repo", "project"] }, id: { type: "string" }, reason: { type: "string" } }, required: ["scope", "id", "reason"] },
    async run(ctx, i) {
      const scope = i.scope === "repo" ? "repo" : "project";
      const t = await stopTarget(ctx, scope, str(i.id));
      if ("error" in t) return t;
      return mk(ctx, {
        kind: "halt", title: `Pull the andon cord on ${t.label}`, summary: str(i.reason) ?? "",
        steps: ["A soft, resumable pause: agents stop at their current step", "Give a reason of at least 4 characters (20 for a regulated project)", "Posted to the project's andon notification routes", "For a hard stop, propose a kill instead"],
        call: { method: "POST", path: "/api/v1/stops", body: { scope, id: scope === "repo" ? t.apiId.slice(5) : t.apiId.slice(8), mode: "halt", reason: str(i.reason) ?? "", via: "console" }, idempotent: true },
        perm: { action: stopAction("halt", scope === "repo" ? "repo" : "project"), project: t.project }, needsReason: 4, phrase: null, danger: false, entities: t.project ? [{ type: scope === "repo" ? "repo" : "project", id: t.apiId.split(":")[1]!, label: t.label }] : [], scope: { project: t.project, repo: scope === "repo" ? t.apiId.slice(5) : null },
      });
    },
  },
  {
    name: "propose_resume", kind: "propose", description: "Propose resuming a halted repo line or project.",
    input_schema: { type: "object", properties: { scope: { type: "string", enum: ["repo", "project"] }, id: { type: "string" } }, required: ["scope", "id"] },
    async run(ctx, i) {
      const scope = i.scope === "repo" ? "repo" : "project";
      const t = await stopTarget(ctx, scope, str(i.id));
      if ("error" in t) return t;
      return mk(ctx, {
        kind: "resume", title: `Resume ${t.label}`, summary: "Agents restart from where they stopped.", steps: ["Agents restart from where they stopped"],
        call: { method: "DELETE", path: `/api/v1/stops/${encodeURIComponent(t.apiId)}`, body: { via: "console" }, idempotent: false },
        perm: { action: stopAction("resume", scope), project: t.project }, needsReason: null, phrase: null, danger: false, entities: [], scope: { project: t.project, repo: scope === "repo" ? t.apiId.slice(5) : null },
      });
    },
  },
  {
    name: "propose_kill", kind: "propose", description: "Propose a kill switch (factory, project or one work order). The card needs a reason and, for a project or the factory, a typed confirmation.",
    input_schema: { type: "object", properties: { scope: { type: "string", enum: ["factory", "project", "workorder"] }, id: { type: "string" }, reason: { type: "string" } }, required: ["scope", "reason"] },
    async run(ctx, i) {
      const scope = i.scope === "factory" ? "factory" : i.scope === "workorder" ? "workorder" : "project";
      const t = await stopTarget(ctx, scope, str(i.id));
      if ("error" in t) return t;
      const phrase = scope === "factory" ? "KILL FACTORY" : scope === "project" ? t.label : null;
      return mk(ctx, {
        kind: "kill", title: `Kill ${t.label}`, summary: str(i.reason) ?? "",
        steps: ["Hard stop: agents stop, coding slots are freed, new submissions are refused", scope === "workorder" ? "The work order moves to Killed; an open PR becomes a draft" : "Choose: hold work in place, or cancel it to Killed", "Posted to the kill notification routes", `Restoring needs restore.${scope}`],
        call: { method: "POST", path: "/api/v1/stops", body: { scope, ...(scope === "factory" ? {} : { id: t.apiId.split(":")[1] }), mode: "kill", reason: str(i.reason) ?? "", ...(scope === "workorder" ? {} : { inFlight: "hold" }), ...(phrase ? { confirmText: "" } : {}), via: "console" }, idempotent: true },
        perm: { action: stopAction("kill", scopeFromApi(scope)), project: t.project }, needsReason: 4, phrase, danger: true, entities: t.project ? [{ type: "project", id: t.project }] : [], scope: { project: t.project, wo: t.wo ?? null },
      });
    },
  },
  {
    name: "propose_restore", kind: "propose", description: "Propose restoring after a kill (factory, project or one work order).",
    input_schema: { type: "object", properties: { scope: { type: "string", enum: ["factory", "project", "workorder"] }, id: { type: "string" }, reason: { type: "string" } }, required: ["scope", "reason"] },
    async run(ctx, i) {
      const scope = i.scope === "factory" ? "factory" : i.scope === "workorder" ? "workorder" : "project";
      const t = await stopTarget(ctx, scope, str(i.id));
      if ("error" in t) return t;
      return mk(ctx, {
        kind: "restore", title: `Restore ${t.label}`, summary: str(i.reason) ?? "", steps: ["Held work resumes, and the work orders it killed come back from where they were", ...(scope === "factory" ? ["The factory may need two different Factory Admins"] : [])],
        call: { method: "POST", path: `/api/v1/stops/${encodeURIComponent(t.apiId)}/restore`, body: { reason: str(i.reason) ?? "", via: "console" }, idempotent: false },
        perm: { action: stopAction("restore", scopeFromApi(scope)), project: t.project }, needsReason: 4, phrase: null, danger: false, entities: [], scope: { project: t.project, wo: t.wo ?? null },
      });
    },
  },
  {
    name: "propose_park", kind: "propose", description: "Propose moving a work order to a bay (queue, hold, person and so on) with a reason.",
    input_schema: { type: "object", properties: { wo: { type: "string" }, bay: { type: "string" }, reason: { type: "string" } }, required: ["wo", "bay", "reason"] },
    async run(ctx, i) {
      const id = str(i.wo)?.toUpperCase();
      const r = id ? await api(ctx, `/api/v1/work-orders/${encodeURIComponent(id)}`) : null;
      if (!r || r.status !== 200) return { error: "No visible work order." };
      const w = obj(r.body);
      return mk(ctx, {
        kind: "park", title: `Move ${id} to ${str(i.bay)}`, summary: str(i.reason) ?? "", steps: [mark(w.title, 160)],
        call: { method: "POST", path: `/api/v1/work-orders/${encodeURIComponent(id!)}/park`, body: { bay: str(i.bay), reason: str(i.reason) ?? "", via: "console" }, idempotent: false },
        perm: { action: "wo.park", project: String(w.project) }, needsReason: 1, phrase: null, danger: false, entities: [{ type: "wo", id: id! }], scope: { project: String(w.project), repo: w.repo ? String(w.repo) : null, wo: id! },
      });
    },
  },
  {
    name: "propose_trust_change", kind: "propose", description: "Propose changing a trust cell's level (0-4) with a reason. Ceilings and the trust switch still apply.",
    input_schema: { type: "object", properties: { cell: { type: "string" }, level: { type: "number" }, reason: { type: "string" } }, required: ["cell", "level", "reason"] },
    async run(ctx, i) {
      const cellId = str(i.cell);
      let cell: Json | undefined;
      let switchOn = true;
      for (const p of await visibleProjectsOf(ctx)) {
        const r = await api(ctx, `/api/v1/trust/cells?project=${encodeURIComponent(String(p.id))}`);
        cell = (r.status === 200 ? (arr(obj(r.body).cells) as Json[]) : []).find((c) => c.id === cellId);
        if (cell) { switchOn = obj(r.body).levelsAboveL1 !== false; break; }
      }
      if (!cell) return { error: `No visible trust cell ${cellId}.` };
      const level = num(i.level, -1, -1, 4);
      if (level < 0) return { error: "Level is 0 to 4." };
      const cap = Number(obj(cell.ceiling).max ?? 4);
      return mk(ctx, {
        kind: "trust", title: `Set ${cellId} to L${level}`, summary: str(i.reason) ?? "",
        steps: [
          `Now L${String(cell.level)}; ceiling L${cap}`,
          ...(level < Number(cell.level) ? ["Lowering a level is always allowed."] : [
            ...(level > cap ? [`Capped at L${cap} by a ceiling: the change will be refused.`] : []),
            ...(level > 1 && !switchOn ? ["Trust levels above L1 are switched off: raising to this level will be refused until the switch is on."] : []),
          ]),
        ],
        call: { method: "POST", path: "/api/v1/trust/grants", body: { target: cellId, level, reason: str(i.reason) ?? "", via: "console" }, idempotent: false },
        perm: { action: "trust.grant", project: String(cell.project) }, needsReason: 1, phrase: null, danger: false, entities: [{ type: "project", id: String(cell.project) }], scope: { project: String(cell.project) },
      });
    },
  },
  {
    name: "propose_onboard_repo", kind: "propose", description: "Propose connecting a repo (owner/name) to a project for onboarding.",
    input_schema: { type: "object", properties: { project: { type: "string" }, repo: { type: "string" } }, required: ["project", "repo"] },
    async run(ctx, i) {
      const p = await projArg(ctx, i.project);
      if (!p) return NO_PROJECT;
      const name = str(i.repo);
      if (!name || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) return { error: "Give the repo as owner/name." };
      return mk(ctx, {
        kind: "onboard", title: `Connect ${name}`, summary: `Onboard into ${p.name}`, steps: ["The Onboarding agent assesses CI, tests, branch protection, CODEOWNERS, secrets and MCP needs", "It opens an onboarding PR; the repo becomes Ready after the PR merges and verifies"],
        call: { method: "POST", path: `/api/v1/projects/${p.id}/repos`, body: { name }, idempotent: true },
        perm: { action: "repo.onboard", project: String(p.id) }, needsReason: null, phrase: null, danger: false, entities: [{ type: "project", id: String(p.id), label: String(p.name) }], scope: { project: String(p.id) },
      });
    },
  },
];

export const ALL_TOOLS: readonly ToolDef[] = [...READ, ...PROPOSE];
export const READ_TOOLS: readonly ToolDef[] = READ;
export const toolByName = (name: string): ToolDef | undefined => ALL_TOOLS.find((t) => t.name === name);

/** The tools the model is offered: the read tools always, a propose tool only when the person holds its console right. */
export const offered = (proposeTools: ReadonlySet<string>): ToolDef[] => [...READ_TOOLS, ...ALL_TOOLS.filter((t) => t.kind === "propose" && proposeTools.has(t.name))];

/** Runs a tool and returns what the model sees: JSON text. A tool never throws into the loop. */
export async function execute(ctx: ToolCtx, name: string, input: unknown): Promise<{ text: string; ok: boolean }> {
  const t = toolByName(name);
  if (!t) return { text: JSON.stringify({ error: `No such tool ${name}.` }), ok: false };
  if (t.kind === "propose" && !ctx.proposeTools.has(name)) return { text: JSON.stringify({ error: ctx.denyText?.(name) ?? "The console may not propose this for this person. Say which screen they can use instead." }), ok: false };
  ctx.used.push(name);
  try {
    const out = await t.run(ctx, obj(input));
    const text = JSON.stringify(out);
    for (const m of text.match(/\bWO-\d{3,6}\b/g) ?? []) ctx.seenWo.add(m);
    // The whole result is capped: a very long list must not push the conversation out of the model's window.
    return { text: text.length > 24_000 ? `${text.slice(0, 24_000)}...[cut: ask a narrower question]` : text, ok: !(out && typeof out === "object" && "error" in (out as object)) };
  } catch (e) {
    ctx.req.log.error({ err: e, tool: name }, "console tool failed");
    return { text: JSON.stringify({ error: "The tool failed." }), ok: false };
  }
}

/** Cited entities named in an answer: work order ids and project names among what the tools showed. */
export function mentioned(text: string, ctx: ToolCtx): Cited[] {
  const out: Cited[] = [...ctx.cited];
  const seen = new Set(out.map((c) => `${c.type}:${c.id}`));
  for (const m of text.match(/\bWO-\d{3,6}\b/g) ?? []) if (!seen.has(`wo:${m}`) && ctx.seenWo.has(m)) { seen.add(`wo:${m}`); out.push({ type: "wo", id: m }); }
  for (const p of ctx._projects ?? []) {
    const name = String(p.name);
    if (text.includes(name) && !seen.has(`project:${p.id}`)) { seen.add(`project:${p.id}`); out.push({ type: "project", id: String(p.id), label: name }); }
  }
  return out;
}

export { markAll };
