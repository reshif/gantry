/**
 * Realistic fixtures for the fidelity compare tool: the Blueprint prototype's demo seed (js/data.js) already has the
 * server's own shapes (projects, work orders with gates and history, agents, runs, audit, trust, ...), so the real app
 * is fed from the same data the prototype draws. Both sides therefore show the same factory.
 * `resolve` answers parameterised and list endpoints; anything it does not know falls through to e2e/fixtures.ts.
 */
import type { Me } from "../src/api/types";
import type { Persona } from "./fixtures";

type Seed = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const personaFromSeed = (seed: Seed, id = "p-asha"): Persona => {
  const p = seed.people.find((x: Seed) => x.id === id);
  const me = {
    person: p,
    session: { id: "s-fid", person: id, method: "sso", device: "fidelity", ip: "127.0.0.1", started: seed.NOW, lastSeen: seed.NOW, revoked: false },
    csrf: "csrf-fid",
    projects: seed.projects.map((q: Seed) => ({ id: q.id, name: q.name, key: q.key, status: q.status, halted: q.halted, killed: q.killed })),
    factory: { killed: null },
    config: { demoAccounts: false },
  } as unknown as Me;
  return { id: "admin", me, allows: () => true };
};

const page = <T>(items: T[]) => ({ items, total: items.length });

export function seedResolver(seed: Seed): (method: string, path: string, url: URL) => unknown {
  const NOW: number = seed.NOW;
  const wos: Seed[] = seed.work_orders;
  const gateInfo = (w: Seed) => {
    const g = Object.entries(w.gates as Record<string, Seed>).find(([, v]) => v.status === "waiting");
    return g ? { id: g[0], since: g[1].waitingSince as number } : null;
  };
  const byId = new Map<string, Seed>(wos.map((w) => [w.id, w]));
  const cat = seed.catalog;
  const gateName = (id: string) => (cat.gates as Seed[]).find((g) => g.id === id)?.name ?? id;
  const projName = (id: string) => seed.projects.find((p: Seed) => p.id === id)?.name ?? id;
  const waiting = wos.filter((w) => w.state === "waiting" && gateInfo(w));
  const stationId = (w: Seed) => (cat.stations as Seed[])[w.station]?.id ?? "intake";
  const approvals = waiting.map((w) => {
    const g = gateInfo(w)!;
    return { wo: w.id, title: w.title, gate: g.id, gateLabel: g.id, gateName: gateName(g.id), instance: `${w.id}:${g.id}:1`, project: w.project, projectName: projName(w.project), have: 0, need: 1, waitMs: NOW - g.since, pr: w.pr?.number };
  });
  const conversations = wos.filter((w) => w.state === "blocked").map((w) => ({ wo: w.id, title: w.title, project: w.project, question: w.blockReason, stuck: { state: "blocked", station: stationId(w), reason: w.blockReason ?? "", actions: ["retry"] } }));
  const live = wos.filter((w) => w.state !== "done");
  const done = wos.filter((w) => w.state === "done");
  const byStation: Record<string, number> = {};
  for (const w of live) byStation[stationId(w)] = (byStation[stationId(w)] ?? 0) + 1;
  const spent = seed.projects.reduce((a: number, p: Seed) => a + (p.budget?.mtd ?? 0), 0);
  const home = {
    approvals,
    conversations,
    badges: { inbox: { n: approvals.length } },
    factory: { killed: null },
    sections: {
      waiting: { approvals, conversations },
      attention: [],
      motion: {
        inFlight: live.length, running: live.filter((w) => w.state === "running").length, inBays: live.filter((w) => w.bay).length, byStation,
        shippedToday: 3, shippedWeek: done.length, shippedPrevWeek: Math.max(0, done.length - 4),
        recentDone: done.slice(0, 6).map((w) => ({ id: w.id, title: w.title, project: w.project, projectName: projName(w.project), doneAt: w.doneAt })),
        mine: live.filter((w) => w.requestedBy === "p-asha").slice(0, 5).map((w) => ({ id: w.id, title: w.title, project: w.project, projectName: projName(w.project), state: w.state, bay: w.bay, bayName: w.bay, station: stationId(w), cls: w.cls, doneAt: null })),
      },
      approvers: { count: approvals.length, oldestMs: Math.max(0, ...approvals.map((a: Seed) => a.waitMs)), late: 0, byProject: [] },
      projects: seed.projects.map((p: Seed) => ({ id: p.id, roles: [], repos: seed.repos.filter((r: Seed) => r.project === p.id).map((r: Seed) => ({ id: r.id, name: r.name, stage: r.stage ?? "ready", blocker: "" })) })),
      health: { spend: { spent, budget: seed.projects.reduce((a: number, p: Seed) => a + (p.budget?.monthly ?? 0), 0), projects: seed.projects.map((p: Seed) => ({ id: p.id, label: p.name, v: p.budget?.mtd ?? 0, b: p.budget?.monthly ?? 0, alert: p.budget?.alertAt ?? 0.8 })) }, evals: { scored: 12, passing: 11, unscored: 1, failing: [] }, audit: true },
    },
  };
  const slim = (w: Seed) => w;
  return (method, path, url) => {
    if (method !== "GET") return undefined;
    const seg = path.split("/");
    const q = (k: string) => url.searchParams.get(k);
    if (path === "home") return home;
    if (path === "projects") return seed.projects;
    if (seg[0] === "projects" && seg[1]) {
      const p = seed.projects.find((x: Seed) => x.id === seg[1]);
      if (!p) return undefined;
      const mine = wos.filter((w) => w.project === p.id);
      if (!seg[2]) return p;
      if (seg[2] === "floor") {
        const holders = Array.from({ length: p.flow.slots }, (_, i) => ({ slot: i + 1, wo: mine.find((w) => w.slot === i + 1)?.id ?? null }));
        const gates = mine.flatMap((w) => { const g = gateInfo(w); return w.state === "waiting" && g ? [{ instance: `${w.id}:${g.id}:1`, wo: w.id, gate: g.id, since: g.since, have: 0, need: 1 }] : []; });
        return { project: p, workOrders: mine.map(slim), flowVersion: 1, slots: { used: holders.filter((h) => h.wo).length, total: p.flow.slots, holders }, gates, queue: mine.filter((w) => w.bay === "queue").map((w) => w.id), stop: null, stops: [], at: null };
      }
      if (seg[2] === "work-orders") return page(mine.map(slim));
      if (seg[2] === "repos") return seed.repos.filter((r: Seed) => r.project === p.id);
      if (seg[2] === "events") return seed.events.filter((e: Seed) => !e.project || e.project === p.id);
    }
    if (seg[0] === "work-orders" && seg[1]) {
      const w = byId.get(seg[1]);
      if (!w) return undefined;
      return seg[2] === "record" ? { wo: w, workOrder: w, project: seed.projects.find((p: Seed) => p.id === w.project) } : w;
    }
    if (path === "activity") return seed.events;
    if (path === "conversations") return page(conversations);
    if (path === "people") return seed.people;
    if (path === "teams") return seed.teams;
    if (path === "templates") return seed.templates;
    if (path === "agents") return seed.agents;
    if (path === "skills") return seed.skills;
    if (path === "suites" || path === "agents/suites") return seed.suites;
    if (path === "evals/runs") return seed.eval_runs;
    if (path === "evals/scorecards") return seed.scorecards;
    if (path === "audit") {
      const ppl = new Map((seed.people as Array<{ id: string; name: string }>).map((x) => [x.id, x.name]));
      const items = (seed.audit as Array<Record<string, any>>).slice().sort((x, y) => y.at - x.at).map((e, i, all) => ({ ...e, seq: e.id, actorKind: String(e.actor).startsWith("p-") ? "human" : "system", actorName: ppl.get(e.actor) ?? e.actor, channel: e.via ?? "web", digest: `d${String(e.id).padStart(8, "0")}ffff`, prev: `d${String(all[i + 1]?.id ?? 0).padStart(8, "0")}ffff` }));
      const count = (k: string) => items.reduce<Record<string, number>>((m, e) => ({ ...m, [e[k]]: (m[e[k]] ?? 0) + 1 }), {});
      const cats = count("category");
      return { items, next: null, total: items.length, summary: { entries: items.length, denied: items.filter((e) => e.outcome === "denied").length, changes: items.filter((e) => e.category === "config").length, head: items[0]?.digest ?? "", categories: cats, topics: {}, facets: { outcomes: Object.keys(count("outcome")), channels: ["web", "api"], actors: Object.keys(count("actor")).map((id) => ({ id, name: ppl.get(id) ?? id })) } } };
    }
    if (path === "signins") return seed.signins;
    if (path === "sessions") return seed.sessions;
    if (path === "policies") return seed.policies;
    if (path === "security") return seed.security;
    if (path === "routing") return seed.routing;
    if (path === "vendors") return seed.vendors;
    if (path === "deliveries") return seed.deliveries;
    if (path === "freezes") return seed.freezes;
    if (path === "integrations") return seed.integration_instances;
    if (path === "integration-types") return seed.integration_types;
    if (path === "mcp/servers") return seed.mcp;
    if (path === "mcp/calls") return seed.mcp_usage;
    if (path === "triggers") return seed.triggers;
    if (path === "api-keys") return seed.api_keys;
    if (path === "api-requests") return seed.request_log;
    if (path === "api-config") return seed.api_config;
    if (path === "guidelines") return seed.guidelines;
    if (path === "instructions/base") return seed.instructions;
    if (path === "access/matrix") return { matrix: seed.role_matrix, roles: seed.catalog.roles, actions: seed.catalog.actions, version: 1 };
    if (path === "trust/cells") return seed.trust;
    if (path === "system/health") {
      const at = new Date(seed.NOW).toISOString();
      const svc = (id: string, name: string, status: "ok" | "degraded", detail: string) => ({ id, name, status, detail, latencyMs: 40 });
      return {
        at,
        services: [svc("api", "API gateway", "ok", "p95 212 ms"), svc("worker", "Worker pool", "ok", "6 of 6 workers"), svc("db", "Postgres", "ok", "replica lag 0.4 s"), svc("queue", "Job queue", "degraded", "2 dead letters")],
        backup: { status: "ok", at, ageHours: 6, set: "nightly-0412", detail: "verified" },
        drill: { status: "ok", at, ageHours: 40, set: "nightly-0410", seconds: 840, failedChecks: 0, detail: "restore drill passed" },
        outbox: { counts: { pending: 1, sending: 0, delivered: 220, dead: 2 }, oldestPendingSeconds: 30, dead: [{ id: "dl-1", destination: "slack #gates", scope: "project", attempts: 5, maxAttempts: 5, lastError: "channel_not_found", createdAt: at, failedAt: at }] },
        jobs: { counts: { queued: 2, running: 3, done: 480, dead: 0 }, stuck: [], runningLongMinutes: 180, dead: [], deadWindowHours: 24 },
        runStarts: { windowMinutes: 60, failed: 0, reasons: [] },
      };
    }
    if (path === "workload") {
      const people = (seed.people as Array<{ id: string; name: string; status: string; oncall?: boolean; teams?: string[] }>).filter((x) => x.status === "active");
      const rows = people.map((x, i) => ({ person: x.id, name: x.name, team: x.teams?.[0] ?? null, glass: 0, perDay: (4 + i) / 7, waitN: 6, waiting: i % 3, approvals: 4 + i, answered: i % 4, medianResponseMin: 12 + i, afterHours: i % 2, n: 6, sole: i % 5 === 0 ? 1 : 0, minutes: 30 + i * 5, away: null, oncall: !!x.oncall, waitingGates: [], recent: [] }));
      return { at: seed.NOW, days: 7, scope: "all", minN: 5, projects: [{ id: "payments", name: "Payments Platform" }], factoryWide: true, ids: people.map((x) => x.id), totals: { gatesWaiting: 6, soleGates: 1, noneGates: 0, timedN: 12, medianWaitMin: 42, acts: 64, afterHours: 9, minutes: 520 }, rows, teams: [], byCls: [], byProject: [], bottlenecks: [], needsPerson: [], suggestions: [] };
    }
    const eff = /^people\/([^/]+)\/effective-permissions$/.exec(path);
    if (eff) {
      const person = (seed.people as Array<{ id: string; roles: Array<{ role: string; scope: string }> }>).find((x) => x.id === eff[1]);
      const projs = (seed.projects as Array<{ id: string; name: string }>).map((x) => ({ id: x.id, name: x.name }));
      const acts = seed.catalog.actions as Array<{ id: string; name: string; group: string; scope: "project" | "factory" }>;
      const ok = (a: string, scope: string) => (person?.roles ?? []).some((g) => (g.scope === "factory" || g.scope === scope) && seed.role_matrix[g.role]?.[a]);
      const cells: Record<string, Record<string, [0 | 1, string]>> = {};
      for (const pr of projs) { cells[pr.id] = {}; for (const a of acts.filter((x) => x.scope === "project")) cells[pr.id]![a.id] = [ok(a.id, pr.id) ? 1 : 0, "matrix"]; }
      const factory: Record<string, { allowed: boolean; reason: string; rule: { id: string } }> = {};
      for (const a of acts.filter((x) => x.scope === "factory")) factory[a.id] = { allowed: ok(a.id, "factory"), reason: "role matrix", rule: { id: "MATRIX" } };
      return { person: eff[1], at: NOW, projects: projs, actions: acts, cells, rules: { MATRIX: { kind: "matrix", name: "Role matrix" } }, factory };
    }
    void q;
    return undefined;
  };
}
