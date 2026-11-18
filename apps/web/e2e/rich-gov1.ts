/* eslint-disable @typescript-eslint/no-explicit-any -- fixture handlers mutate loosely typed JSON */
/**
 * gov1 fixtures (People, Person, Workload, Access) in the shape of the Control Room prototype's sample data: its 20 people, 8 teams,
 * 9 built-in roles by 18 permissions, 4 policies, who holds what. Installed over the shared ones by richOverrides() via richGov1(ov).
 * Nothing outside the people / teams / access / policies / workload / work-order-list reads changes.
 */
import type { Route } from "@playwright/test";
import { fulfillJson, type Handler } from "./fixtures";

const NOW = Date.parse("2026-01-15T10:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

type Row = [id: string, name: string, title: string, role: string, team: string];
// The prototype's people, in its order. Asha is the signed-in persona (id p-admin).
const P: Row[] = [
  ["p-admin", "Asha Raman", "Head of Engineering", "factory_admin", "platform"], ["p-omar", "Omar Haddad", "VP Platform", "factory_admin", "platform"],
  ["p-daniel", "Daniel Okafor", "Factory Manager", "project_admin", "platform"], ["p-meera", "Meera Iyer", "Engineering Lead, Payments", "line_lead", "payments"],
  ["p-tomas", "Tomás Ferreira", "Software Engineer", "engineer", "payments"], ["p-priya", "Priya Nair", "Staff Engineer", "reviewer", "payments"],
  ["p-kenji", "Kenji Watanabe", "Release Manager", "release_manager", "platform"], ["p-sam", "Sam Whitfield", "Compliance Auditor", "auditor", "security"],
  ["p-lena", "Lena Fischer", "Engineering Lead, Platform", "project_admin", "platform"], ["p-chloe", "Chloe Martin", "Engineering Lead, Growth", "line_lead", "growth"],
  ["p-arjun", "Arjun Mehta", "Frontend Engineer", "engineer", "growth"], ["p-fatima", "Fatima Zahra", "Senior Engineer", "reviewer", "payments"],
  ["p-nikhil", "Nikhil Rao", "Engineering Lead, Data", "project_admin", "data"], ["p-grace", "Grace Liu", "Security Engineer", "approver", "security"],
  ["p-rui", "Rui Costa", "Platform Engineer", "engineer", "platform"], ["p-hana", "Hana Sato", "Engineering Lead, Mobile", "project_admin", "mobile"],
  ["p-diego", "Diego Alvarez", "Engineering Manager, Data", "line_lead", "data"], ["p-ines", "Ines Moreau", "Engineering Lead, Internal Tools", "project_admin", "internal"],
  ["p-kwame", "Kwame Mensah", "Engineering Lead, Partners", "project_admin", "partners"], ["p-sofia", "Sofia Rossi", "Senior Engineer, Search", "reviewer", "platform"],
];
const SEEN_MIN = [180, 720, 1860, 2760, 2340, 600, 1080, 1500, 180, 2880, 2760, 1620, 900, 1620, 2400, 2340, 2340, 1260, 1440, 300];
const PROJECT_IDS = ["payments", "storefront", "risk", "identity", "mobile", "data-platform", "search", "internal-tools"];
const OWNER: Record<string, string> = { payments: "p-meera", storefront: "p-chloe", mobile: "p-hana", "internal-tools": "p-ines", "data-platform": "p-nikhil" };

const TEAMS = [["payments", "Payments"], ["platform", "Platform"], ["growth", "Growth"], ["data", "Data"], ["security", "Security"], ["mobile", "Mobile"], ["partners", "Partners"], ["internal", "Internal"]]
  .map(([id, name]) => ({ id, name, desc: `${name} team.`, members: P.filter((p) => p[4] === id).length, roles: [] as unknown[] }));

const ROLES = [
  { id: "factory_admin", name: "Factory Admin", level: "factory" }, { id: "auditor", name: "Auditor", level: "factory" },
  { id: "project_admin", name: "Project Admin", level: "project" }, { id: "line_lead", name: "Line Lead", level: "project" },
  { id: "engineer", name: "Engineer", level: "project" }, { id: "reviewer", name: "Reviewer", level: "project" },
  { id: "approver", name: "Approver", level: "project" }, { id: "release_manager", name: "Release Manager", level: "project" }, { id: "viewer", name: "Viewer", level: "project" },
];
const FACTORY_SCOPE = new Set(["kill.factory", "people.manage", "policy.edit", "model.edit", "agent.edit", "mcp.edit", "integration.edit", "audit.read"]);
const ACTIONS = [
  ["project.view", "View project", "Work"], ["wo.submit", "Submit work order", "Work"], ["wo.answer", "Answer a question", "Work"], ["gate.approve", "Approve at a gate", "Gates"],
  ["release", "Release", "Gates"], ["line.halt", "Halt the line", "Stops"], ["kill.project", "Emergency stop project", "Stops"], ["kill.factory", "Emergency stop factory", "Stops"],
  ["repo.onboard", "Onboard a repo", "Setup"], ["project.config", "Configure project", "Setup"], ["agent.edit", "Edit agents", "Setup"], ["model.edit", "Edit models", "Setup"],
  ["mcp.edit", "Edit MCP servers", "Setup"], ["integration.edit", "Edit integrations", "Setup"], ["api.keys", "Manage API keys", "Setup"], ["people.manage", "Manage people", "People"],
  ["policy.edit", "Edit policies", "People"], ["audit.read", "Read audit", "People"],
].map(([id, name, group]) => ({ id: id!, name: name!, group: group!, scope: FACTORY_SCOPE.has(id!) ? "factory" : "project" }));
const PM: Record<string, string[] | "*"> = {
  factory_admin: "*", auditor: ["project.view", "audit.read"],
  project_admin: ["project.view", "wo.submit", "wo.answer", "gate.approve", "line.halt", "repo.onboard", "project.config", "api.keys"],
  line_lead: ["project.view", "wo.submit", "wo.answer", "gate.approve", "line.halt"], engineer: ["project.view", "wo.submit", "wo.answer"],
  reviewer: ["project.view", "wo.answer", "gate.approve"], approver: ["project.view", "gate.approve"], release_manager: ["project.view", "release", "gate.approve"], viewer: ["project.view"],
};
const holds = (role: string, action: string): boolean => PM[role] === "*" || (PM[role] as string[]).includes(action);
const matrix = () => Object.fromEntries(ROLES.map((r) => [r.id, Object.fromEntries(ACTIONS.map((a) => [a.id, holds(r.id, a.id)]))]));

const grantsOf = (i: number): Array<{ role: string; scope: string }> => {
  const p = P[i]!;
  const level = ROLES.find((r) => r.id === p[3])!.level;
  if (level === "factory") return [{ role: p[3], scope: "factory" }];
  const scopes = PROJECT_IDS.filter((id, j) => OWNER[id] === p[0] || (i + j) % 4 === 0);
  return (scopes.length ? scopes : [PROJECT_IDS[0]!]).map((scope) => ({ role: p[3], scope }));
};
const person = (i: number) => {
  const p = P[i]!;
  // Prototype statuses: the 16th person is invited, the 20th deactivated. MFA is off for every 7th person from the 4th.
  return { id: p[0], name: p[1], title: p[2], email: `${p[1].toLowerCase().normalize("NFD").replace(/[^a-z ]/g, "").replace(" ", ".")}@acme.dev`, teams: [p[4]], roles: grantsOf(i), status: i === 19 ? "deactivated" : i === 15 ? "invited" : "active", oncall: false, github: p[0].slice(2), away: null, mfa: i % 7 !== 3, version: 1, lastSeen: NOW - SEEN_MIN[i]! * MIN };
};

const POLICIES = [
  { id: "POL-101", name: "Payments release window", effect: "allow", enabled: true, roles: ["release_manager"], actions: ["release"], where: { projects: ["payments"] }, when: { days: [2, 3, 4], from: "10:00", to: "16:00" }, oncallOnly: false, version: 1 },
  { id: "POL-102", name: "Standard release window", effect: "allow", enabled: true, roles: ["release_manager", "project_admin"], actions: ["release"], where: { projects: ["storefront", "risk"] }, when: { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }, oncallOnly: false, version: 1 },
  { id: "POL-103", name: "No releases during year-end freeze", effect: "deny", enabled: true, roles: ROLES.map((r) => r.id), actions: ["release"], where: { freeze: true }, when: null, oncallOnly: false, version: 1 },
  { id: "POL-104", name: "On-call only for identity", effect: "allow", enabled: false, roles: ["release_manager"], actions: ["release"], where: { projects: ["identity"] }, when: null, oncallOnly: true, version: 1 },
];

/** Who has how many open work orders and waiting approvals (the Workload matrix and the Person page "Holds right now"). */
const REQUESTED: Record<string, number> = { "p-meera": 2, "p-tomas": 1, "p-priya": 1, "p-chloe": 1, "p-lena": 1, "p-kenji": 1, "p-arjun": 1, "p-daniel": 1 };
const ELIGIBLE: Record<string, Record<string, number>> = {
  "p-meera": { payments: 6, storefront: 2 }, "p-priya": { payments: 2 }, "p-fatima": { payments: 2, storefront: 1 }, "p-kenji": { payments: 1 }, "p-grace": { risk: 2 },
  "p-lena": { payments: 1, identity: 1 }, "p-daniel": { storefront: 2 }, "p-chloe": { storefront: 1 }, "p-admin": { payments: 1 },
};

function wrapBody(h: Handler | undefined, mutate: (j: any) => void): Handler | undefined {
  if (!h) return undefined;
  return (r) => h({ request: () => r.request(), fulfill: (o: { body?: string | Buffer }) => {
    try { const j = JSON.parse(String(o.body)); mutate(j); return r.fulfill({ ...o, body: JSON.stringify(j) }); } catch { return r.fulfill(o as never); }
  } } as unknown as Route);
}

export function richGov1(ov: Record<string, Handler>, floorFor: (id: string) => { workOrders: Array<Record<string, any>> }): void {
  const ppl = P.map((_, i) => person(i));
  ov["people"] = (r) => fulfillJson(r, ppl);
  ov["teams"] = (r) => fulfillJson(r, TEAMS);
  ov["access/matrix"] = (r) => fulfillJson(r, { matrix: matrix(), roles: ROLES, actions: ACTIONS, version: 7 });
  ov["policies"] = (r) => fulfillJson(r, POLICIES);
  ov["freezes"] = (r) => fulfillJson(r, []);
  const names: Record<string, string> = { payments: "Payments Platform", storefront: "Storefront" };
  for (const [i, pe] of P.entries()) {
    ov[`people/${pe[0]}/effective-permissions`] = (r) => {
      const projs = Object.entries(names).map(([id, name]) => ({ id, name }));
      const acts = ACTIONS.map((a) => ({ ...a }));
      const cells: Record<string, Record<string, [0 | 1, string, string[]?]>> = {};
      for (const a of acts.filter((x) => x.scope === "project")) { cells[a.id] = {}; for (const pr of projs) cells[a.id]![pr.id] = [holds(pe[3], a.id) ? 1 : 0, "MATRIX", ["direct"]]; }
      const factory: Record<string, { allowed: boolean; reason: string; rule: { id: string } }> = {};
      for (const a of acts.filter((x) => x.scope === "factory")) factory[a.id] = { allowed: holds(pe[3], a.id), reason: holds(pe[3], a.id) ? "Granted by the role." : "The role does not include it.", rule: { id: "MATRIX" } };
      return fulfillJson(r, { person: pe[0], at: NOW, projects: projs, actions: acts, cells, teams: { [pe[4]]: TEAMS.find((t) => t.id === pe[4])!.name }, grants: grantsOf(i).map((g) => ({ ...g, roleName: ROLES.find((x) => x.id === g.role)!.name, via: null })), rules: { MATRIX: { kind: "matrix", name: "Role matrix" } }, factory });
    };
  }
  ov["POST access/simulate"] = (r) => {
    const q = JSON.parse(r.request().postData() ?? "{}") as { person: string; action: string; time?: number };
    const pe = P.find((x) => x[0] === q.person) ?? P[0]!;
    const ok = holds(pe[3], q.action);
    const t = q.time ?? NOW;
    const day0 = Math.floor((t + 330 * MIN) / (24 * HOUR)) * 24 * HOUR - 330 * MIN;
    return fulfillJson(r, {
      ok: true,
      decision: { allowed: ok, reason: ok ? `${ROLES.find((x) => x.id === pe[3])!.name} includes this right.` : `${ROLES.find((x) => x.id === pe[3])!.name} does not include this right.`, needs: ok ? "" : "A role that includes it", rule: { id: "MATRIX", kind: "matrix", name: "Role matrix" } },
      trace: [`Roles in scope: ${ROLES.find((x) => x.id === pe[3])!.name}.`, `Role matrix grants it: ${ok ? "yes" : "no"}.`, "Policies on this action: none, so the matrix decides."],
      week: Array.from({ length: 7 }, (_, d) => ({ day0: day0 + d * 24 * HOUR, dow: (new Date(day0 + d * 24 * HOUR + 330 * MIN).getUTCDay()), label: "", cells: Array.from({ length: 24 }, (_, h) => ({ hour: h, allowed: ok, rule: "MATRIX", selected: false })) })),
    });
  };

  // Work orders and waiting approvals per person, from the people counts above.
  for (const id of PROJECT_IDS) {
    const base = ov[`projects/${id}/work-orders`];
    if (!base) continue;
    ov[`projects/${id}/work-orders`] = (r) => {
      const u = new URL(r.request().url());
      if (u.searchParams.get("state") === "open" && u.searchParams.get("limit") === "100") {
        const mine = id === "payments" ? Object.entries(REQUESTED).flatMap(([pid, n]) => Array.from({ length: n }, () => pid)) : [];
        const wos = floorFor(id).workOrders.filter((w) => w.state !== "done" && w.state !== "killed");
        const items = mine.map((pid, k) => ({ ...wos[k % Math.max(1, wos.length)], id: `WO-${3000 + k}`, requestedBy: pid }));
        return fulfillJson(r, { items, total: items.length, next: null });
      }
      return base(r);
    };
    const pbase = ov[`projects/${id}`];
    ov[`projects/${id}`] = wrapBody(pbase, (j) => { if (OWNER[id]) j.owner = OWNER[id]; })!;
  }
  ov["projects"] = wrapBody(ov["projects"], (j: Array<{ id: string; owner: string }>) => { for (const p of j) if (OWNER[p.id]) p.owner = OWNER[p.id]!; })!;

  ov["workload"] = (r) => {
    const rows = ppl.filter((p) => p.status === "active").map((p, i) => {
      const gates = Object.entries(ELIGIBLE[p.id] ?? {}).flatMap(([project, n]) => Array.from({ length: n }, (_, k) => ({ wo: { id: `WO-${1004 + k}`, title: "Work order", project, cls: "feature" }, gate: "G4", since: NOW - (k + 1) * HOUR, eligible: 2 })));
      return { person: p.id, name: p.name, team: p.teams[0]!, waiting: gates.length, glass: 0, approvals: 12 + i, perDay: 1.5 + (i % 4) * 0.7, answered: 4 + i, waitN: 10 + i, medianResponseMin: 25 + i * 11, afterHours: i % 3, n: 14 + i, sole: gates.length && i % 4 === 0 ? 1 : 0, minutes: 120 + i * 35, away: null, oncall: false, waitingGates: gates, recent: [] };
    });
    return fulfillJson(r, {
      at: NOW, days: 7, scope: "all", minN: 5, projects: Object.entries(names).map(([id, name]) => ({ id, name })), factoryWide: true, ids: [],
      totals: { gatesWaiting: 12, soleGates: 2, noneGates: 0, timedN: 40, medianWaitMin: 130, acts: 96, afterHours: 11, minutes: 2840 },
      rows,
      teams: TEAMS.map((t, i) => ({ team: t.id, name: t.name, people: t.members, waiting: i + 1, approvals: 20 + i * 8, answered: 9 + i, minutes: 600 + i * 120, waitN: 12, medianResponseMin: 40 + i * 15, afterHours: i, n: 20, sole: i % 2 })),
      byCls: [{ key: "feature", minutes: 1200, workOrders: 18, perWO: 66 }, { key: "bug", minutes: 800, workOrders: 22, perWO: 36 }],
      byProject: [{ key: "payments", minutes: 1500, workOrders: 20, perWO: 75 }, { key: "storefront", minutes: 900, workOrders: 14, perWO: 64 }],
      bottlenecks: [{ project: "payments", gate: "G5", decisions: 14, medianWaitMin: 190, open: 3, oldestMin: 300, station: "review", minEligible: 1 }],
      needsPerson: [],
      suggestions: [{ key: "s1", kind: "approver", icon: "people", weight: 3, text: "Review and merge on Payments Platform has one eligible approver (Meera Iyer).", action: { id: "wl-sg-1", label: "Open approver rules", type: "config", project: "payments", gate: "G5" } }],
    });
  };
}
