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
    if (path === "agents") return seed.agents.map((a: Seed) => ({ rev: 1, suiteName: a.suite ?? null, threshold: 0.85, ...a, versions: (a.versions ?? []).map((v: Seed) => ({ eligibility: { ok: true, text: "Passes the gate", score: null, suite: a.suite ?? null, threshold: 0.85, needs: "" }, ...v })) }));
    if (path === "evals/factory") return seed.eval_extra;
    if (path === "skills") return seed.skills;
    if (path === "suites" || path === "agents/suites") return seed.suites;
    if (path === "evals/runs") return seed.eval_runs;
    if (path === "evals/scorecards") return seed.scorecards;
    if (path === "audit") return page(seed.audit);
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
    if (path === "access/matrix") return seed.role_matrix;
    if (path === "trust/cells") return seed.trust;
    void q;
    return undefined;
  };
}
