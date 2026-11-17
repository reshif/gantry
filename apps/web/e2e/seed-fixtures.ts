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
  // The traveler read adds what the server computes for the viewer (may approve, may move, gate progress); the record read is the lifecycle record.
  const allow = { allowed: true, reason: "", needs: "" };
  const routeOf = (w: Seed): string[] => {
    const skips: string[] = ((cat.classes as Seed[] | undefined)?.find((c) => c.id === w.cls)?.skips as string[] | undefined) ?? [];
    return (cat.stations as Seed[]).map((x) => x.id as string).filter((id) => !skips.includes(id));
  };
  const travelerOf = (w: Seed) => {
    const g = gateInfo(w);
    const moves: Record<string, unknown> = {};
    for (const id of routeOf(w)) moves[id] = { allowed: true, reason: "", kind: "back" };
    for (const b of (cat.bays as Seed[]) ?? []) moves[b.id] = { allowed: true, reason: `Moves to ${b.name}.`, kind: "park" };
    const can: Record<string, unknown> = {};
    for (const k of ["answer", "classify", "decline", "park", "sendback", "reassign", "move", "confirm", "summary", "edit", "kill"]) can[k] = allow;
    const gateProgress: Record<string, unknown> = {};
    for (const k of Object.keys(w.gates ?? {})) gateProgress[k] = { have: 0, need: 1, unmet: [], conds: [], onlyRequester: false, passes: false };
    const approve = g && w.state === "waiting" && !w.bay ? { ...allow, gate: g.id, instance: `${w.id}:${g.id}:1` } : null;
    return { ...w, version: 7, gateProgress, allowed: { approve, moves, can }, stop: null, route: routeOf(w) };
  };
  const sessionOf = (w: Seed) => {
    const st = (cat.stations as Seed[])[w.station];
    const g = gateInfo(w);
    const gd = g ? (cat.gates as Seed[]).find((x) => x.id === g.id) : null;
    const rt = routeOf(w);
    const ci = rt.indexOf(st?.id);
    return {
      woId: w.id, project: w.project, repo: w.repo,
      wo: { id: w.id, title: w.title, description: w.description ?? "", cls: w.cls, clsName: w.cls, confidence: w.clsConfidence ?? 0, rationale: w.clsRationale ?? "", priority: w.priority, station: st?.id ?? "intake", stationName: st?.name ?? "Intake", state: w.state, bay: w.bay ?? null, gate: gd ? { id: gd.id, label: gd.label, name: gd.name, purpose: gd.purpose } : null, requestedBy: w.requestedBy, closed: w.state === "done" || w.state === "killed" },
      messages: (w.conv?.messages ?? []).map((m: Seed, i: number) => ({ id: `m${i}`, role: m.from === w.requestedBy ? "user" : "assistant", author: m.from, text: m.text, at: m.at, data: {} })),
      agent: { mode: "rule-based", name: "Intake Clerk", id: st?.agent ?? "ag-intake", reason: "Rule-based intake", label: "Rule-based", station: st?.id ?? "intake" },
      budget: { spentUsd: 0, limitUsd: 5 }, costUsd: 0,
      can: { talk: true, talkWhy: "", confirm: true, confirmWhy: "", park: true, parkWhy: "" },
      steps: rt.map((id, i) => ({ id, name: ((cat.stations as Seed[]).find((x) => x.id === id)?.name as string) ?? id, state: i < ci || w.state === "done" ? "done" : i === ci ? "current" : "todo" })),
      next: { actor: w.state === "waiting" ? "approver" : "agent", text: w.state === "waiting" ? "An approver decides the gate." : "An agent is working." },
      waiting: w.state === "waiting" ? { text: "Waiting at a gate.", kind: "gate" } : null,
      dialogue: { questions: [], assumptions: [], objections: [], askedMe: false },
      swarm: null, documents: [], research: { plan: null, allowList: [], canDecide: false, canApproveUnlisted: false }, sources: [], pending: [],
      brief: w.brief ?? {}, briefConfirmed: !!w.gates?.G0G1 && w.gates.G0G1.status === "passed", briefOpen: false, ruleQuestion: null, ruleReady: false, busy: false,
    };
  };
  const approversOf = (w: Seed, gate: string) => {
    const gd = (cat.gates as Seed[]).find((x) => x.id === gate);
    return {
      gate, label: gd?.label ?? gate, name: gd?.name ?? gate, kind: gd?.kind ?? "human",
      rule: { text: "1 approval from: Line Lead, Project Admin.", required: 1, conditions: [], sod: true },
      progress: { have: 0, need: 1, approvals: [], unmet: [] }, satisfiable: true, warning: "",
      eligible: seed.people.slice(0, 3).map((p: Seed) => ({ id: p.id, name: p.name, away: false, oncall: false, why: "Project Admin" })),
      overrides: [], viewerCanOverride: false,
      can: { editRule: true, editWhy: "", grantRole: true, grantWhy: "" },
    };
  };
  const iso = (t: number | undefined | null) => (t ? new Date(t).toISOString() : null);
  const recordOf = (w: Seed) => ({
    id: w.id, version: 7, project: w.project, repo: w.repo, title: w.title, state: w.state,
    request: { text: w.description || w.title, by: w.requestedBy, via: w.source ?? "ui", at: w.createdAt, attachments: [] },
    classification: { predicted: w.clsSuggested ?? w.cls, final: w.cls, confidence: w.clsConfidence ?? 0, rationale: w.clsRationale ?? "", requested: null, overridden: null },
    route: routeOf(w), flowVersion: 1, clarification: w.conv?.messages ?? [], briefVersions: w.briefVersions ?? [], brief: w.brief, criteria: w.criteria ?? [],
    journey: w.history ?? [],
    gates: Object.entries((w.gates ?? {}) as Record<string, Seed>).map(([k, g]) => ({
      id: `${w.id}:${k}:1`, gate: k, station: (cat.gates as Seed[]).find((x) => x.id === k)?.after ?? null, status: g.status === "passed" ? "closed" : "open", closedReason: g.status === "passed" ? "approved" : null, headSha: null, openedAt: iso(g.waitingSince), closedAt: null,
      pinned: { flowVersion: 1, ruleVersion: 1, policyVersion: null }, basis: { required: 1 },
      votes: [...(g.approvals ?? []), ...(g.rejections ?? [])].map((a: Seed) => ({ by: a.by, vote: g.rejections?.includes(a) ? "reject" : "approve", comment: a.note ?? "", at: iso(a.at), via: "ui", role: null })),
      decision: g.status === "passed" ? { decision: "approved", decided_by: g.approvals?.[0]?.by ?? null, rule: null, trust_level: null, detail: { mode: g.decision?.mode ?? "human" }, at: iso(g.approvals?.[0]?.at) } : null,
    })),
    sendbacks: w.sendbacks ?? [], bayStays: [], attempts: [], results: [], runs: [],
    code: { pullRequests: w.pr ? [{ number: w.pr.number, state: w.pr.state, draft: false, headSha: null, title: w.title, url: null, mergedAt: null }] : [], commits: (w.commits ?? []).map((c: Seed) => ({ sha: c.hash, message: c.message, author: c.agent, at: null })), files: w.files ?? [], diff: w.diff ?? { plus: 0, minus: 0, files: 0 }, tests: w.tests ?? { passed: 0, failed: 0, added: 0 } },
    outcomes: [], totals: { tokens: (w.history ?? []).reduce((a: number, x: Seed) => a + (x.tokens || 0), 0), cost: (w.history ?? []).reduce((a: number, x: Seed) => a + (x.cost || 0), 0) },
    completeness: { sections: { summary: true, request: true, clarification: true, agreement: !!w.brief, stations: true, changes: !!w.files?.length, verification: false, merge: false, approvals: false, after: false, timeline: true }, done: 5, total: 11 },
    summary: { generated: `${w.title}. ${w.state === "waiting" ? "It is waiting at a gate." : "It is on the line."}`, written: null },
    events: (w.log ?? []).map((l: Seed, i: number) => ({ seq: i + 1, at: new Date(l.at).toISOString(), type: "wo.log", by: l.who, outcome: "ok", detail: { text: l.text } })),
  });
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
      return seg[2] === "record" ? recordOf(w) : seg[2] === "gates" && seg[4] === "approvers" ? approversOf(w, seg[3]!) : seg[2] === "session" ? sessionOf(w) : seg[2] === "changes" ? { pullRequests: [], commits: [], files: w.files ?? [], patches: [] } : seg[2] ? undefined : travelerOf(w);
    }
    if (path === "work-order-sessions") {
      const proj = url.searchParams.get("project");
      return {
        items: wos.filter((w) => !proj || w.project === proj).map((w) => {
          const last = w.conv?.messages?.[w.conv.messages.length - 1];
          const st = (cat.stations as Seed[])[w.station];
          return { id: w.id, project: w.project, title: w.title, cls: w.cls, station: st?.id ?? "intake", stationName: st?.name ?? "Intake", state: w.state, bay: w.bay ?? null, gate: gateInfo(w)?.id ?? null, agent: st?.agent ?? null, agentName: null, waitingOn: w.state === "waiting" ? "approver" : "agent", latest: last ? { text: last.text, at: last.at, by: last.from, role: "assistant" } : null, unread: false, closed: w.state === "done" || w.state === "killed", started: true, requestedBy: w.requestedBy, createdAt: w.createdAt };
        }),
      };
    }
    if (path === "activity") return seed.events;
    if (path === "conversations") return page(conversations);
    if (path === "workspace/inbox") return { items: [] };
    if (path === "console/status") return { configured: true, vendor: "anthropic", model: "claude-sonnet-5-5", actionsEnabled: false, canUse: true, retentionDays: 90, tools: [], proposals: [], models: [] };
    if (path === "console/threads") return { items: [], retentionDays: 90 };
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
    if (path === "learning/findings") return seed.learning?.findings ?? [];
    if (path === "learning/proposals") return (seed.learning?.proposals ?? []).map((x: Seed) => ({ ...x, status: x.status === "adopted" ? "accepted" : x.status }));
    if (path === "learning/settings") return { proposalsOn: true, otherDeciders: 2 };
    if (path === "learning/signals") return [];
    if (path === "trust/cells") return { levelsAboveL1: true, minRuns: 5, soakDays: 7, maxGrantable: 3, ...seed.trust, cells: (seed.trust?.cells ?? []).map((c: Seed) => ({ rev: 1, gate: null, pending: null, effective: c.level, projection: 2, meets: { ok: false, next: Math.min(4, c.level + 1), missing: [] }, ceiling: { max: 4, ids: [] }, evidence: { runs: c.cleanRuns + 1, cleanRuns: c.cleanRuns, evalScore: 0.9, rework: 0.08, incidents: 0, incidentWos: [] }, ...c })), proposals: (seed.trust?.proposals ?? []).map((p: Seed) => ({ ...p, status: p.status === "approved" ? "accepted" : p.status })) };
    void q;
    return undefined;
  };
}
