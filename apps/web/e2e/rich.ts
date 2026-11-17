/**
 * Rich fixtures for the fidelity harness (apps/web/fidelity/compare.mjs): a plant with eight projects, a loaded payments line
 * (work orders at every station, gates waiting, blocked and queued work), activity, agents, approvals and metrics. Realistic and
 * internally consistent; it extends the e2e fixtures with overrides and changes none of their defaults.
 * All times are relative to NOW, the fixed clock the harness installs (2026-01-15T10:00:00Z).
 */
import { DEFAULT_CATALOG } from "@gantry/domain";
import type { Page } from "@playwright/test";
import { PERSONAS, fulfillJson, mockApi, type Handler } from "./fixtures";
import { woReadOverrides } from "./rich-wo";

export const NOW = Date.parse("2026-01-15T10:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const cat = DEFAULT_CATALOG;
const STATION_IDS = cat.stations.map((s) => s.id);

const PROJECTS = [
  { id: "payments", key: "PAY", name: "Payments Platform", desc: "Payouts, refunds, ledger and the merchant API." },
  { id: "storefront", key: "WEB", name: "Storefront", desc: "Customer web shop and checkout UI." },
  { id: "risk", key: "RSK", name: "Risk and Compliance", desc: "Fraud rules, KYC and audit exports." },
  { id: "identity", key: "IDN", name: "Identity", desc: "Sign-in, sessions and device trust." },
  { id: "mobile", key: "MOB", name: "Mobile Apps", desc: "iOS and Android apps." },
  { id: "data-platform", key: "DAT", name: "Data Platform", desc: "Warehouse, pipelines and metrics." },
  { id: "search", key: "SRC", name: "Search", desc: "Query service and relevance tuning.", halted: true },
  { id: "internal-tools", key: "INT", name: "Internal Tools", desc: "Back-office apps for support and ops." },
] as const;

const flow = () => ({
  stations: Object.fromEntries(cat.stations.map((s) => [s.id, { enabled: true, wip: s.id === "build" ? 4 : 3 }])),
  gates: Object.fromEntries(cat.gates.map((g) => [g.id, { enabled: true, mode: g.kind }])),
  slots: 4,
  classes: cat.classes,
  order: STATION_IDS,
  bays: ["declined", "hold", "sechold", "person", "queue"],
});

/* [id, title, class, priority, station, kind] kind: run | queue | gate | block | fail | person */
type Spec = [number, string, string, string, string, "run" | "queue" | "gate" | "block" | "fail" | "person"];
const PAY: Spec[] = [
  [1002, "Rate limit the payout API per merchant", "hotfix", "P1", "spec", "run"],
  [1003, "Retry failed ledger postings with backoff", "security", "P1", "intake", "queue"],
  [1004, "Add idempotency keys to refund endpoint", "feature", "P1", "review", "gate"],
  [1005, "Expose payout status webhook", "bug", "P2", "design", "block"],
  [1006, "Migrate payouts to batch settlement", "bug", "P1", "close", "block"],
  [1007, "Remove deprecated v1 charge route", "epic", "P3", "research", "run"],
  [1008, "Reconcile pending holds nightly", "security", "P1", "spec", "queue"],
  [1035, "Rate limit the payout API (phase 2)", "chore", "P2", "close", "gate"],
  [1037, "Fix rounding on multi-currency refunds", "security", "P1", "build", "run"],
  [1038, "Add webhook signature rotation", "feature", "P2", "build", "run"],
  [1039, "Settlement report: add fee breakdown", "feature", "P2", "build", "run"],
  [1040, "Paginate the ledger export", "refactor", "P3", "build", "run"],
  [1041, "Reconcile pending holds nightly (phase 2)", "feature", "P2", "plan", "run"],
  [1045, "Cache merchant limits in Redis", "feature", "P2", "build", "queue"],
  [1046, "Dead-letter queue for failed payouts", "feature", "P1", "build", "queue"],
  [1053, "Normalise currency codes on import", "chore", "P3", "build", "queue"],
  [1054, "Payout calendar holiday handling", "bug", "P2", "build", "queue"],
  [1060, "Chargeback evidence upload", "epic", "P2", "plan", "gate"],
  [1061, "Soft-delete merchants", "refactor", "P3", "plan", "run"],
  [1062, "Refund reason taxonomy", "feature", "P2", "verify", "run"],
  [1063, "Audit log for limit changes", "security", "P1", "verify", "run"],
  [1064, "Idempotent webhook retries", "bug", "P2", "verify", "fail"],
  [1065, "Ledger index for settlement lookups", "chore", "P3", "review", "run"],
  [1066, "Merchant onboarding checklist API", "feature", "P2", "review", "run"],
  [1067, "Add per-region payout cut-off", "feature", "P1", "review", "gate"],
  [1068, "Drop unused currency tables", "chore", "P3", "close", "run"],
  [1069, "Pre-auth void for expired holds", "bug", "P1", "intake", "run"],
  [1070, "Batch size tuning for payout worker", "chore", "P3", "intake", "run"],
  [1071, "Sandbox seed data refresh", "chore", "P3", "research", "queue"],
  [1072, "Webhook replay tool", "feature", "P2", "spec", "run"],
  [1073, "Fee schedule versioning", "epic", "P2", "design", "run"],
  [1074, "PCI scope note for new endpoint", "security", "P1", "design", "gate"],
  [1075, "Payout failure alert routing", "feature", "P2", "intake", "queue"],
  [1076, "Reconciliation diff viewer", "feature", "P2", "research", "run"],
];

let _agents: unknown[] | null = null;
function agents() {
  if (_agents) return _agents;
  const names: Record<string, string> = { "ag-intake": "Intake Clerk", "ag-research": "Researcher", "ag-spec": "Spec Writer", "ag-design": "Designer", "ag-plan": "Planner", "ag-build": "Builder", "ag-test": "Test Engineer", "ag-review": "Reviewer", "ag-close": "Release Captain" };
  _agents = cat.stations.map((s) => ({ id: s.agent, name: names[s.agent] ?? s.agent, station: s.id, model: "claude-sonnet", fallbacks: [], version: "1.4.0", status: "active", autonomy: { level: 2 }, tools: {}, skills: [], mcp: [], stations: [s.id], projects: "all", budget: 40, guardrails: { paths: [], maxDiff: 800 }, suite: "su-" + s.id, instructions: "", overrides: {}, versions: [], spark: [], spend7d: 12.4, initials: (names[s.agent] ?? "AG").split(" ").map((x) => x[0]).join("").slice(0, 2) }));
  return _agents;
}

function project(p: (typeof PROJECTS)[number], i: number) {
  return {
    id: p.id, name: p.name, key: p.key, status: "active", teams: ["platform"], owner: "p-admin", template: "standard", regulated: i % 2 === 0, desc: p.desc, flow: flow(), approvers: {}, notifications: [], mcp: [],
    budget: { monthly: 4000, mtd: 1280 + i * 190, alertAt: 0.8 }, created: NOW - 90 * DAY,
    halted: "halted" in p && p.halted ? { by: "p-admin", at: NOW - 3 * HOUR, reason: "Relevance regression under investigation" } : null, killed: null, overlay: "", version: 3,
  };
}

function wo(s: Spec, projectId: string) {
  const [num, title, cls, priority, sid, kind] = s;
  const station = STATION_IDS.indexOf(sid);
  const age = ((num * 37) % 200) * MIN + 12 * MIN;
  const startedAt = NOW - age;
  const gate = cat.gates.find((g) => g.after === sid);
  const waitingGate = kind === "gate" && gate ? gate.id : null;
  const state = kind === "run" ? "running" : kind === "gate" ? "waiting" : kind === "queue" ? "waiting" : kind === "block" ? "blocked" : kind === "fail" ? "failed" : "waiting";
  return {
    id: `WO-${num}`, project: projectId, repo: ["payments-api", "payouts-worker", "ledger-core"][num % 3], title, description: title, attachments: [], cls, clsConfidence: 0.9, clsRationale: "", clsSuggested: cls, clsOverridden: null, requestedCls: null,
    priority, source: "console", requestedBy: "p-lead", createdAt: NOW - age - 6 * HOUR, station, state, bay: null, bayReason: "", bayFrom: null, progress: kind === "run" ? 30 + (num % 60) : 0, slot: null,
    history: [{ station: sid, agent: cat.stations[station]!.agent, model: "claude-sonnet", startedAt, endedAt: kind === "queue" || kind === "gate" ? startedAt + 5 * MIN : null, tokens: 120000, cost: 1.4, outcome: null, note: "" }],
    gates: waitingGate ? { [waitingGate]: { status: "waiting", approvals: [], rejections: [], checks: [], waitingSince: startedAt } } : {},
    log: [], diff: { files: 0, add: 0, del: 0 }, tests: { total: 0, passed: 0, failed: 0 }, pr: null, blockReason: kind === "block" ? "Waiting on an upstream schema change" : null, failReason: kind === "fail" ? "2 checks failed" : null,
    doneAt: null, killed: null, parent: null, children: [], risk: "normal", paths: [], slaDue: NOW + 2 * DAY, conv: { messages: [] }, brief: {}, split: false,
  };
}

function done(num: number, projectId: string, hoursAgo: number) {
  const w = wo([num, "Shipped change " + num, "feature", "P2", "close", "run"], projectId);
  return { ...w, state: "done", doneAt: NOW - hoursAgo * HOUR, station: 8 } as unknown as ReturnType<typeof wo>;
}

export function floorFor(projectId: string) {
  const p = project(PROJECTS.find((x) => x.id === projectId) ?? PROJECTS[0], PROJECTS.findIndex((x) => x.id === projectId));
  const specs = projectId === "payments" ? PAY : PAY.filter((s) => s[5] !== "block" && s[5] !== "fail").slice(0, 8).map((s, i) => [s[0] + 100 * (i + 1), s[1], s[2], s[3], s[4], s[5]] as Spec);
  const wos = [...specs.map((s) => wo(s, projectId)), done(990, projectId, 2), done(991, projectId, 5), done(992, projectId, 9), done(993, projectId, 30)];
  const gates = wos.filter((w) => Object.keys(w.gates).length).map((w) => ({ instance: `${w.id}:${Object.keys(w.gates)[0]}:1`, wo: w.id, gate: Object.keys(w.gates)[0], since: w.createdAt, have: 0, need: 1 }));
  return { project: p, workOrders: wos, flowVersion: 3, slots: { used: 4, total: 4, holders: [] }, gates, queue: wos.filter((w) => w.station === 5 && w.state === "waiting").map((w) => w.id), stop: null, stops: [], at: null };
}

function events(projectId?: string) {
  const types: Array<[string, string, Record<string, unknown>]> = [
    ["wo.enter", "WO-1038", { station: "build" }], ["gate.decision", "WO-1004", { gate: "G4", by: "p-lead" }], ["wo.enter", "WO-1062", { station: "verify" }], ["wo.enter", "WO-1037", { station: "build" }],
    ["gate.decision", "WO-1027", { gate: "G5", by: "p-admin" }], ["wo.enter", "WO-1022", { station: "research" }], ["wo.submit", "WO-1076", { text: "Reconciliation diff viewer" }], ["wo.enter", "WO-1039", { station: "build" }],
    ["release", "WO-1035", { text: "WO-1035 to production" }], ["wo.enter", "WO-1061", { station: "plan" }], ["wo.enter", "WO-1066", { station: "review" }], ["wo.bay", "WO-1064", { bay: "person" }],
    ["wo.enter", "WO-1072", { station: "spec" }], ["wo.enter", "WO-1073", { station: "design" }],
  ];
  const out: unknown[] = [];
  for (let h = 0; h < 40; h++) {
    const t = types[h % types.length]!;
    out.push({ id: 5000 - h, at: NOW - (h * 36 + 3) * MIN, type: t[0], wo: t[1], project: projectId ?? "payments", ...t[2] });
  }
  return out;
}

const person = (id: string, name: string, title: string, role: string) => ({ id, name, title, email: `${id}@acme.dev`, teams: ["platform"], roles: [{ role, scope: "factory" }], status: "active", oncall: false, github: id, away: null });

function metrics(i: number, projectId: string) {
  const byPosition: Record<string, { n: number; blocked: number }> = {};
  const specs = projectId === "payments" ? PAY : PAY.filter((s) => s[5] !== "block" && s[5] !== "fail").slice(0, 8);
  for (const s of specs) {
    const c = (byPosition[s[4]] ??= { n: 0, blocked: 0 });
    c.n += 1;
    if (s[5] === "block" || s[5] === "fail") c.blocked += 1;
  }
  const byGate: Record<string, number> = {};
  for (const s of specs) if (s[5] === "gate") byGate[cat.gates.find((g) => g.after === s[4])!.id] = (byGate[cat.gates.find((g) => g.after === s[4])!.id] ?? 0) + 1;
  const bad = specs.filter((s) => s[5] === "block" || s[5] === "fail").length;
  return { wip: specs.length, bays: 0, gates: Object.values(byGate).reduce((a, b) => a + b, 0), oldest: 5 * HOUR, late: 0, eff: 0.82, effN: 12, cov: { total: 8, auto: 3, share: 0.3 }, bad, haltedRepos: 0, byPosition, byClass: {}, byGate, slotsUsed: 4, onboarding: 0, health: { id: i === 6 ? "halted" : bad ? "attention" : "ok", label: i === 6 ? "Halted" : bad ? "Needs attention" : "Healthy", icon: "st-done" } };
}

export function richOverrides(): Record<string, Handler> {
  const ov: Record<string, Handler> = {};
  const me = { ...PERSONAS.admin.me, projects: PROJECTS.map((p, i) => ({ id: p.id, name: p.name, key: p.key, status: "active", halted: "halted" in p && p.halted ? { by: "p-admin", at: NOW - 3 * HOUR, reason: "x" } : null, killed: null, order: i })) };
  ov["me"] = (r) => fulfillJson(r, me);
  ov["projects"] = (r) => fulfillJson(r, PROJECTS.map((p, i) => ({ ...project(p, i), metrics: metrics(i, p.id) })));
  for (const p of PROJECTS) {
    ov[`projects/${p.id}/floor`] = (r) => fulfillJson(r, floorFor(p.id));
    ov[`projects/${p.id}`] = (r) => fulfillJson(r, { ...project(p, PROJECTS.indexOf(p)), metrics: metrics(PROJECTS.indexOf(p), p.id) });
    ov[`projects/${p.id}/work-orders`] = (r) => {
      const u = new URL(r.request().url());
      const st = u.searchParams.get("state") ?? "all";
      const q = (u.searchParams.get("q") ?? "").toLowerCase();
      const lim = Number(u.searchParams.get("limit") ?? 50);
      let items = floorFor(p.id).workOrders as Array<ReturnType<typeof wo>>;
      if (st === "open") items = items.filter((w) => w.state !== "done" && w.state !== "killed");
      else if (st !== "all") items = items.filter((w) => w.state === st);
      if (q) items = items.filter((w) => (w.id + w.title).toLowerCase().includes(q));
      items = [...items].sort((a, b) => b.createdAt - a.createdAt);
      return fulfillJson(r, { items: items.slice(0, lim), total: items.length, next: null });
    };
    Object.assign(ov, woReadOverrides(floorFor(p.id).workOrders as never, p.id));
    ov[`projects/${p.id}/repos`] = (r) => fulfillJson(r, []);
  }
  ov["activity"] = (r) => fulfillJson(r, events());
  ov["agents"] = (r) => fulfillJson(r, agents());
  ov["home"] = (r) =>
    fulfillJson(r, {
      approvals: [
        { wo: "WO-1004", title: "Add idempotency keys to refund endpoint", gate: "G5", gateLabel: "G5", gateName: "Review and merge", project: "payments", projectName: "Payments Platform", have: 1, need: 2, waitMs: 5 * HOUR },
        { wo: "WO-1013", title: "Add order tracking page", gate: "G6", gateLabel: "G6", gateName: "Release confirmed", project: "storefront", projectName: "Storefront", have: 0, need: 1, waitMs: 6 * HOUR },
        { wo: "WO-1021", title: "Add WebAuthn backup codes", gate: "G4", gateLabel: "G4", gateName: "Checks green", project: "identity", projectName: "Identity", have: 0, need: 1, waitMs: 2 * HOUR },
      ],
      conversations: [{ wo: "WO-1070", title: "Batch size tuning for payout worker", project: "payments", question: "Should the batch size be per region?" }],
      badges: { inbox: { n: 4, label: "4 waiting for you" }, floor: { n: 6, label: "6 gates waiting", kind: "wait" } },
      factory: { killed: null },
      sections: {
        attention: [
          { id: "hm-att-1", sev: 0, icon: "st-block", title: "WO-1006 is blocked at Close", where: "Payments Platform", sub: "Waiting on an upstream schema change · 7h", act: { label: "Open", route: "traveler", wo: "WO-1006" } },
          { id: "hm-att-2", sev: 1, icon: "st-wait", title: "Search is halted", where: "Search", sub: "Relevance regression under investigation", act: { label: "Open floor", route: "floor", project: "search" } },
        ],
        waiting: {
          approvals: [
            { wo: "WO-1004", title: "Add idempotency keys to refund endpoint", gate: "G5", gateLabel: "G5", gateName: "Review and merge", project: "payments", projectName: "Payments Platform", have: 1, need: 2, waitMs: 5 * HOUR },
            { wo: "WO-1013", title: "Add order tracking page", gate: "G6", gateLabel: "G6", gateName: "Release confirmed", project: "storefront", projectName: "Storefront", have: 0, need: 1, waitMs: 6 * HOUR },
            { wo: "WO-1021", title: "Add WebAuthn backup codes", gate: "G4", gateLabel: "G4", gateName: "Checks green", project: "identity", projectName: "Identity", have: 0, need: 1, waitMs: 2 * HOUR },
          ],
          conversations: [{ wo: "WO-1070", title: "Batch size tuning for payout worker", project: "payments", question: "Should the batch size be per region?" }],
        },
        motion: { inFlight: 52, running: 31, inBays: 3, byStation: {}, shippedToday: 7, shippedWeek: 34, shippedPrevWeek: 29, recentDone: [], mine: [] },
        health: { spend: { spent: 186.4, budget: 240, projects: [] }, evals: null, audit: true },
        projects: [],
      },
    });
  ov["people"] = (r) => fulfillJson(r, [person("p-admin", "Asha Raman", "Engineering Director", "factory_admin"), person("p-lead", "Meera Iyer", "Tech Lead", "tech_lead"), person("p-reader", "Rae Reader", "Auditor", "auditor")]);
  return ov;
}

/** Install the API fixtures for the fidelity harness on a page: the admin persona and the rich plant above. */
export async function installRich(page: Page): Promise<void> {
  await mockApi(page, { persona: PERSONAS.admin, overrides: richOverrides() });
}
