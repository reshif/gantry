/**
 * Rich fixtures for the fidelity harness (apps/web/fidelity/compare.mjs): a plant with eight projects, a loaded payments line
 * (work orders at every station, gates waiting, blocked and queued work), activity, agents, approvals and metrics. Realistic and
 * internally consistent; it extends the e2e fixtures with overrides and changes none of their defaults.
 * All times are relative to NOW, the fixed clock the harness installs (2026-01-15T10:00:00Z).
 */
import { DEFAULT_CATALOG } from "@gantry/domain";
import type { Page } from "@playwright/test";
import { workforceOverrides } from "./rich-workforce";
import { PERSONAS, fulfillJson, mockApi, type Handler } from "./fixtures";
import { woReadOverrides, type Ops1Approve } from "./rich-wo";
import { richGroupE, routesE } from "./rich-e";
import { PROJ_CLASSES, PROJ_OWNER, PROJ_REGULATED, richGroupProj } from "./rich-proj";
import { richGov1 } from "./rich-gov1";

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
  classes: PROJ_CLASSES.map((c) => ({ ...cat.classes.find((x) => x.id === c.id), ...c })), // group proj: the prototype's seven classes
  order: STATION_IDS,
  bays: ["declined", "hold", "sechold", "person", "queue"],
});

/* [id, title, class, priority, station, kind] kind: run | queue | gate | block | fail | person */
type Spec = [number, string, string, string, string, "run" | "queue" | "gate" | "block" | "fail" | "person"];
const PAY: Spec[] = [
  [1001, "Add idempotency keys to refund endpoint", "feature", "P2", "build", "run"],
  [1002, "Rate limit the payout API per merchant", "hotfix", "P1", "spec", "run"],
  [1003, "Retry failed ledger postings with backoff", "security", "P1", "intake", "queue"],
  [1004, "Rate limit the payout API per merchant", "feature", "P1", "review", "gate"],
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

/* ---- ops1 fixtures (Home, Inbox, Agents at work): each station agent runs the model the prototype names ---- */
const OPS1_MODEL: Record<string, string> = { "ag-intake": "claude-haiku-5-5", "ag-research": "claude-sonnet-5-5", "ag-spec": "claude-opus-5-5", "ag-design": "claude-sonnet-5-5", "ag-plan": "claude-opus-5-5", "ag-build": "claude-sonnet-5-5", "ag-test": "claude-sonnet-5-5", "ag-review": "claude-opus-5-5", "ag-close": "claude-haiku-5-5" };
export const ops1Model = (agent: string): string => OPS1_MODEL[agent] ?? "claude-sonnet-5-5";
/* ---- end ops1 ---- */

let _agents: unknown[] | null = null;
function agents() {
  if (_agents) return _agents;
  const names: Record<string, string> = { "ag-intake": "Intake Clerk", "ag-research": "Researcher", "ag-spec": "Spec Writer", "ag-design": "Designer", "ag-plan": "Planner", "ag-build": "Builder", "ag-test": "Test Engineer", "ag-review": "Reviewer", "ag-close": "Release Captain" };
  _agents = cat.stations.map((s) => ({ id: s.agent, name: names[s.agent] ?? s.agent, station: s.id, model: ops1Model(s.agent), fallbacks: [], version: "1.4.0", status: "active", autonomy: "gate", evalScore: 0.9, threshold: 0.85, suiteName: "Golden set", rev: 1, runs30: 120, rework: 0.06, tools: {}, skills: [], mcp: [], stations: [s.id], projects: "all", budget: 40, guardrails: { paths: [], maxDiff: 800 }, suite: "su-" + s.id, instructions: "", overrides: {}, versions: [{ v: "1.4.0", at: NOW - 5 * DAY, note: "Live version", diff: "", suiteScore: 0.9, live: true, rc: false, snapshot: null, eligibility: { ok: true, text: "Passed", score: 0.9, suite: "su-" + s.id, threshold: 0.85, needs: "" } }], spark: [0.9, 0.88, 0.91, 0.9, 0.92, 0.9, 0.91], spend7d: 12.4, initials: (names[s.agent] ?? "AG").split(" ").map((x) => x[0]).join("").slice(0, 2) }));
  /* work1 block: the tenth agent, outside the belt (no station), like the prototype's Onboarding Agent. */
  const first = _agents[0] as Record<string, unknown>;
  _agents.push({ ...first, id: "ag-onboard", name: "Onboarding Agent", station: null, stations: [], skills: [], version: "1.1.0", suite: "su-intake", status: "idle" });
  return _agents;
}

// group proj: approver rules for the payments gates (the Approvers tab), prototype wording
const PAY_APPROVERS = Object.fromEntries([["G0G1", ["project_admin", "line_lead"]], ["G2", ["project_admin", "line_lead"]], ["G3d", ["approver"]], ["G3G3s", ["approver", "security_reviewer"]], ["G5", ["reviewer", "line_lead"]], ["G6", ["release_manager"]]].map(([g, roles]) => [g, { roles, people: [], required: 2, sod: true, conditions: [], escalateH: 24, fallback: null }]));

function project(p: (typeof PROJECTS)[number], i: number) {
  return {
    id: p.id, name: p.name, key: p.key, status: "active", teams: ["platform"], owner: PROJ_OWNER[p.id] ?? "p-admin", template: "standard", regulated: PROJ_REGULATED.has(p.id), desc: p.desc, flow: flow(), approvers: p.id === "payments" ? PAY_APPROVERS : {}, notifications: routesE, mcp: [],
    budget: { monthly: 4000, mtd: 1280 + i * 190, alertAt: 0.8 }, created: NOW - 90 * DAY,
    halted: "halted" in p && p.halted ? { by: "p-admin", at: NOW - 3 * HOUR, reason: "Relevance regression under investigation" } : null, killed: null, overlay: "", version: 3,
  };
}

// --- ops2 fixtures: a few work orders are requested by the signed-in admin, so "Requested by me" has rows (prototype: 4). ---
const OPS2_MINE = new Set([1038, 1060, 1065, 1076]);
// --- end ops2 ---

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
    priority, source: "console", requestedBy: OPS2_MINE.has(num) ? "p-admin" : "p-lead", createdAt: NOW - age - 6 * HOUR, station, state, bay: null, bayReason: "", bayFrom: null, progress: kind === "run" ? 30 + (num % 60) : 0, slot: null,
    history: [{ station: sid, agent: cat.stations[station]!.agent, model: ops1Model(cat.stations[station]!.agent), startedAt, endedAt: kind === "queue" || kind === "gate" ? startedAt + 5 * MIN : null, tokens: 120000, cost: 1.4, outcome: null, note: "" }],
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
  /* floor group: 24 shipped in the last six hours (4.0 an hour, as the prototype) for payments, and no gate after Research or Verify so the belt shows joints there */
  const shipped = projectId === "payments" ? Array.from({ length: 22 }, (_, i) => done(900 + i, projectId, 0.2 + (i * 5.6) / 22)) : [];
  /* floor group: a deep queue at Spec so the belt shows "+N more" and the pile opens the station drawer */
  const deepQueue = projectId === "payments" ? [1201, 1202, 1203, 1204, 1205, 1206].map((n, i) => wo([n, "Queued spec request " + (i + 1), "feature", i % 3 === 0 ? "P1" : "P2", "spec", "queue"], projectId)) : [];
  const wos = [...specs.map((s) => wo(s, projectId)), ...deepQueue, ...shipped, done(990, projectId, 2), done(991, projectId, 5), done(992, projectId, 9), done(993, projectId, 30)].map((w) => ({ ...w, requestedBy: "p-fatima" }));
  const pf = { ...p, flow: { ...p.flow, gates: { ...p.flow.gates, G1f: { ...p.flow.gates.G1f, absent: true }, G4: { ...p.flow.gates.G4, absent: true } } } };
  const gates = wos.filter((w) => Object.keys(w.gates).length).map((w) => ({ instance: `${w.id}:${Object.keys(w.gates)[0]}:1`, wo: w.id, gate: Object.keys(w.gates)[0], since: w.createdAt, have: 0, need: 1 }));
  return { project: pf, workOrders: wos, flowVersion: 3, slots: { used: 4, total: 4, holders: [] }, gates, queue: wos.filter((w) => w.station === 5 && w.state === "waiting").map((w) => w.id), stop: null, stops: [], at: null };
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

/** Repos of the payments project at every onboarding stage (the onboarding and project-config screens). */
function reposFor(project: string) {
  const mk = (name: string, lang: string, stage: string, extra: Record<string, unknown> = {}, findings = 6, gapsN = 0) => ({
    id: name.split("/")[1], name, project, team: "platform", tags: lang === "Go" ? ["regulated"] : [], lang, halted: null,
    config: { defaultBranch: "main", branchPrefix: "gantry/", merge: "squash", tagging: "semver", requiredChecks: ["ci/test", "ci/lint"], protectedPaths: [".github/workflows/**", "CODEOWNERS"] },
    mcp: [], notifyOverrides: [], triggers: true, guidelines: "", source: undefined, version: 1,
    onboarding: {
      stage, startedAt: NOW - 3 * DAY, readyAt: stage === "ready" ? NOW - 2 * DAY : undefined, exception: null, timeline: [{ at: NOW - 3 * DAY, who: "p-admin", text: "Connected" }], busy: null, verification: null,
      findings: stage === "connected" ? [] : Array.from({ length: findings }, (_, i) => ({ id: `f${i}`, check: ["Tests run in CI", "Coverage reported", "CODEOWNERS present", "Secrets scan", "Branch protection", "Guidelines file"][i % 6], ok: i >= gapsN, sev: "medium", fix: "Add the file", file: i < gapsN ? "CODEOWNERS" : null })),
      pr: ["pr_opened", "pr_checks", "pr_merged", "verified", "ready"].includes(stage) ? { number: 3, title: "Onboard to Gantry", branch: "gantry/onboarding", files: [{ path: ".github/workflows/gantry.yml", plus: 80, minus: 0, finding: "f0" }, { path: "CODEOWNERS", plus: 4, minus: 1, finding: "f2" }, { path: "gantry/guidelines.md", plus: 120, minus: 0, finding: "f5" }], checks: stage === "pr_opened" ? "running" : "green", state: ["pr_merged", "verified", "ready"].includes(stage) ? "merged" : "open", reviewers: [], mergedBy: null } : null,
      ...extra,
    },
  });
  return [
    mk("acme/payments-api", "Go", "ready"), mk("acme/ledger-sync", "Go", "ready"), mk("acme/merchant-portal", "TypeScript", "ready"),
    mk("acme/refund-worker", "Python", "pr_checks", {}, 6, 2), mk("acme/payout-batch", "Java", "assessed", {}, 6, 3),
    mk("acme/notify-worker", "Python", "connected"), mk("acme/fraud-rules", "Rust", "person", { blocker: "Needs a person to pick the default branch" }, 6, 2),
  ];
}

// ---- ops2 group: the other projects' repos (the prototype's REPOS table), so the Console's Repository list follows the project ----
const OTHER_REPOS: Record<string, string[]> = { storefront: ["storefront-web", "checkout-ui"], risk: ["risk-rules", "kyc-service"], identity: ["identity-gateway", "session-store"], mobile: ["ios-app", "android-app"], "data-platform": ["pipelines", "metrics-lake"], search: ["search-service", "relevance-lab"], "internal-tools": ["support-console", "ops-portal"] };
function otherRepos(project: string) {
  const mk = reposFor(project)[0]!;
  return (OTHER_REPOS[project] ?? []).map((n) => ({ ...mk, id: n, name: `acme/${n}`, lang: "TypeScript", tags: [] }));
}
// ---- end ops2 group ----

export function richOverrides(): Record<string, Handler> {
  const ov: Record<string, Handler> = {};
  const me = { ...PERSONAS.admin.me, projects: PROJECTS.map((p, i) => ({ id: p.id, name: p.name, key: p.key, status: "active", halted: "halted" in p && p.halted ? { by: "p-admin", at: NOW - 3 * HOUR, reason: "x" } : null, killed: null, order: i })) };
  // the prototype's user menu always offers "Switch persona (demo)"; the real menu shows it when the stack runs demo accounts
  const demoAccountList = [["p-asha", "Asha Raman", "asha", "factory admin"], ["p-meera", "Meera Iyer", "meera", "line lead"], ["p-tomas", "Tomás Ferreira", "tomas", "engineer"], ["p-sam", "Sam Whitfield", "sam", "auditor"]].map(([id, name, e, role]) => ({ id, name, email: `${e}@acme.dev`, role, note: "" }));
  ov["me"] = (r) => fulfillJson(r, { ...me, config: { demoAccounts: true, demoAccountList } });
  // eval runs per station suite: a few runs so an agent page has a trend and recent runs
  for (const st of ["intake", "research", "spec", "design", "plan", "build", "test", "verify", "review", "close"]) ov[`suites/su-${st}/runs`] = (r) => fulfillJson(r, [0.86, 0.9, 0.88, 0.93, 0.91].map((score, i) => ({ id: `run-${st}-${i + 1}`, suite: `su-${st}`, agent: `ag-${st}`, version: "1.4.0", model: "claude-sonnet", at: NOW - (5 - i) * DAY, score, results: [], by: "p-admin", cost: 0.4 + i * 0.3, status: "completed", count: 20 })));
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
    ov[`projects/${p.id}/repos`] = (r) => fulfillJson(r, p.id === "payments" ? reposFor(p.id) : otherRepos(p.id));
  }
  /* ---- ops1 fixtures: the station is called Release (the prototype's name), and the three gate approvals on Home carry what the server says about this person ---- */
  ov["catalog"] = (r) => fulfillJson(r, { ...cat, stations: cat.stations.map((st) => (st.id === "close" ? { ...st, name: "Release" } : st)) });
  const OPS1_APPROVE: Array<[number, string, string, string, string, string, Ops1Approve]> = [
    [1004, "Add idempotency keys to refund endpoint", "payments", "review", "G5", "Review and merge", { allowed: true, reason: "", have: 1, need: 2, approvals: [{ name: "Meera Iyer" }] }],
    [1013, "Add order tracking page", "storefront", "close", "G6", "Release confirmed", { allowed: false, reason: "Separation of duties: you requested this work order, so someone else must approve.", have: 0, need: 1 }],
    [1021, "Add WebAuthn backup codes", "identity", "verify", "G4", "Checks green", { allowed: true, reason: "", have: 0, need: 2 }],
  ];
  for (const [num, title, proj, sid, gate, , approve] of OPS1_APPROVE) {
    const w = { ...wo([num, title, "feature", "P2", sid, "gate"], proj), gates: { [gate]: { status: "waiting", approvals: [], rejections: [], checks: [], waitingSince: NOW - 5 * HOUR } } };
    Object.assign(ov, woReadOverrides([w as never], proj, { [`WO-${num}`]: approve }));
  }
  /* a conversation for every work order on the payments line, so Talk opens a real thread */
  for (const w of floorFor("payments").workOrders as Array<ReturnType<typeof wo>>) {
    const st = cat.stations[w.station];
    if (!st || w.id === "WO-1006") continue;
    const agentName = ({ "ag-intake": "Intake Clerk", "ag-research": "Researcher", "ag-spec": "Spec Writer", "ag-design": "Designer", "ag-plan": "Planner", "ag-build": "Builder", "ag-test": "Test Engineer", "ag-review": "Reviewer", "ag-close": "Release Captain" } as Record<string, string>)[st.agent] ?? st.agent;
    ov[`work-orders/${w.id}/session`] = (r) => fulfillJson(r, {
      woId: w.id, project: "payments", repo: w.repo,
      wo: { id: w.id, title: w.title, description: "", cls: w.cls, clsName: "Feature", confidence: 0.9, rationale: "", priority: w.priority, station: st.id, stationName: st.id === "close" ? "Release" : st.name, state: "running", bay: null, gate: null, requestedBy: "p-lead", closed: false },
      messages: [{ id: "m1", role: "assistant", author: st.agent, text: `I am working on "${w.title}" at ${st.name}.`, at: NOW - 40 * MIN, data: { kind: "station", mode: "agent" } }],
      agent: { mode: "agent", name: agentName, id: st.agent, model: ops1Model(st.agent), vendor: "anthropic", version: 3, station: st.id },
      budget: { spentUsd: 1.2, limitUsd: 20 }, costUsd: 0.6, can: { talk: true, talkWhy: "", confirm: false, confirmWhy: "" },
      steps: [], next: { actor: "agent", text: `${agentName} is working.` }, waiting: null,
      dialogue: { questions: [], assumptions: [], objections: [], askedMe: false }, swarm: null, documents: [], research: { state: "none" }, sources: [], pending: [], brief: {}, briefConfirmed: true, briefOpen: false, ruleQuestion: null, ruleReady: false, busy: false,
    });
  }
  /* ---- end ops1 ---- */
  ov["activity"] = (r) => fulfillJson(r, events());
  ov["stops/impact"] = (r) => fulfillJson(r, { projects: PROJECTS.length, workOrders: 52, running: 31, slots: 4, prs: 3 });
  ov["agents"] = (r) => fulfillJson(r, agents());
  ov["home"] = (r) =>
    fulfillJson(r, {
      approvals: [
        { wo: "WO-1004", title: "Rate limit the payout API per merchant", gate: "G5", gateLabel: "G5", gateName: "Review and merge", project: "payments", projectName: "Payments Platform", have: 1, need: 2, waitMs: 5 * HOUR },
        { wo: "WO-1013", title: "Add order tracking page", gate: "G6", gateLabel: "G6", gateName: "Release confirmed", project: "storefront", projectName: "Storefront", have: 0, need: 1, waitMs: 6 * HOUR },
        { wo: "WO-1021", title: "Add WebAuthn backup codes", gate: "G4", gateLabel: "G4", gateName: "Checks green", project: "identity", projectName: "Identity", have: 0, need: 1, waitMs: 2 * HOUR },
      ],
      conversations: [{ wo: "WO-1070", title: "Batch size tuning for payout worker", project: "payments", question: "Should the batch size be per region?", agent: "ag-intake", at: NOW - 95 * MIN, options: ["Per region", "One global size"] }],
      badges: { inbox: { n: 4, label: "4 waiting for you" } },
      factory: { killed: null },
      sections: {
        attention: [
          { id: "hm-att-1", sev: 0, icon: "st-block", title: "WO-1006 is blocked at Release", where: "Payments Platform", sub: "Waiting on an upstream schema change · 7h", act: { label: "Open", route: "traveler", wo: "WO-1006" } },
          { id: "hm-att-2", sev: 1, icon: "st-wait", title: "Search is halted", where: "Search", sub: "Relevance regression under investigation", act: { label: "Open floor", route: "floor", project: "search" } },
        ],
        waiting: {
          approvals: [
            { wo: "WO-1004", title: "Rate limit the payout API per merchant", gate: "G5", gateLabel: "G5", gateName: "Review and merge", project: "payments", projectName: "Payments Platform", have: 1, need: 2, waitMs: 5 * HOUR },
            { wo: "WO-1013", title: "Add order tracking page", gate: "G6", gateLabel: "G6", gateName: "Release confirmed", project: "storefront", projectName: "Storefront", have: 0, need: 1, waitMs: 6 * HOUR },
            { wo: "WO-1021", title: "Add WebAuthn backup codes", gate: "G4", gateLabel: "G4", gateName: "Checks green", project: "identity", projectName: "Identity", have: 0, need: 1, waitMs: 2 * HOUR },
          ],
          conversations: [{ wo: "WO-1070", title: "Batch size tuning for payout worker", project: "payments", question: "Should the batch size be per region?", agent: "ag-intake", at: NOW - 95 * MIN, options: ["Per region", "One global size"] }],
        },
        motion: { inFlight: 52, running: 31, inBays: 3, byStation: {}, shippedToday: 7, shippedWeek: 34, shippedPrevWeek: 29, recentDone: [], mine: [] },
        health: { spend: { spent: 186.4, budget: 240, projects: [] }, evals: null, audit: true },
        projects: [],
      },
    });
  const sess = (id: string, title: string, agent: string, agentName: string, station: string, stationName: string, waitingOn: string, agoMin: number, text: string, unread: boolean) => ({ id, project: "payments", title, cls: "feature", station, stationName, state: "running", bay: null, gate: null, agent, agentName, waitingOn, latest: { text, at: NOW - agoMin * MIN, by: agent, role: "assistant" }, unread, closed: false, started: true, requestedBy: "p-lead", createdAt: NOW - 6 * HOUR });
  // ---- ops2 group (Conversations): the prototype's four conversations (cv-1 .. cv-4), each openable ----
  const convRows = [
    sess("WO-1006", "Retry limit scope", "ag-spec", "Spec Writer", "spec", "Spec", "you", 40, "Thanks. I will state it per merchant with a default of 60 requests a minute and note that it is configurable.", true),
    sess("WO-1004", "Review findings on the payout limiter", "ag-review", "Reviewer", "review", "Review and merge", "approver", 100, "Fixed window is fine for v1. Please add a note in the PR.", false),
    sess("WO-1042", "New request: bulk refund screen", "ag-intake", "Intake Clerk", "intake", "Intake", "agent", 300, "Opened WO-1042 as a feature, P2, classification confidence 91%. It needs a brief confirm at G1.", false),
    sess("WO-1090", "Onboarding relevance-lab", "ag-onboard", "Onboarding Agent", "intake", "Intake", "you", 90, "Assessment done for relevance-lab: tests run in 4m, coverage 71%, one flaky suite. I propose a guideline pack v2 and an onboarding PR.", true),
  ];
  ov["work-order-sessions"] = (r) => fulfillJson(r, { items: convRows });
  const convMsgs: Record<string, Array<[string, string, number]>> = {
    "WO-1006": [["ag-spec", "I am writing the spec for the payout rate limit. Before I commit to a criterion: should the limit apply per merchant or per account?", 52], ["p-meera", "Per merchant. Accounts are internal.", 47], ["ag-spec", "Thanks. I will state it per merchant with a default of 60 requests a minute and note that it is configurable. Spec v3 will be ready for G2 in about 10 minutes.", 46]],
    "WO-1004": [["ag-review", "The limiter uses a fixed window. A burst at the window edge allows double the stated rate. I recommend a sliding window; the plan allowed either. Flagged as a nit, not blocking.", 110], ["p-priya", "Fixed window is fine for v1. Please add a note in the PR.", 100]],
    "WO-1042": [["p-ines", "Support wants a bulk refund screen with a CSV upload. Can you open a work order?", 300], ["ag-intake", "Opened WO-1042 as a feature on internal-tools, P2, classification confidence 91%. It needs a brief confirm at G1.", 299]],
    "WO-1090": [["ag-onboard", "Assessment done for relevance-lab: tests run in 4m, coverage 71%, one flaky suite. I propose a guideline pack v2 and an onboarding PR.", 95]],
  };
  for (const row of convRows) {
    ov[`work-orders/${row.id}/session`] = (r) => fulfillJson(r, {
      woId: row.id, project: "payments", repo: "payments-api",
      wo: { id: row.id, title: row.title, description: "", cls: "feature", clsName: "Feature", confidence: 0.9, rationale: "", priority: "P2", station: row.station, stationName: row.stationName, state: "running", bay: null, gate: null, requestedBy: "p-lead", closed: false },
      messages: (convMsgs[row.id] ?? []).map(([who, text, ago], i) => ({ id: `m${i}`, role: who.startsWith("ag-") ? "assistant" : "user", author: who, text, at: NOW - ago * MIN, data: who.startsWith("ag-") ? { kind: "station", mode: "agent" } : {} })),
      agent: { mode: "agent", name: row.agentName, id: row.agent, model: "claude-opus", vendor: "anthropic", version: 3, station: row.station },
      budget: { spentUsd: 4.2, limitUsd: 20 }, costUsd: 1.4, can: { talk: true, talkWhy: "", confirm: false, confirmWhy: "" },
      steps: [], next: { actor: "agent", text: `${row.agentName} is working.` }, waiting: null,
      dialogue: { questions: [], assumptions: [], objections: [], askedMe: false }, swarm: null, documents: [], research: { state: "none" }, sources: [], pending: [], brief: {}, briefConfirmed: true, briefOpen: false, ruleQuestion: null, ruleReady: false, busy: false,
    });
  }
  // ---- end ops2 group ----
  ov["people"] = (r) => fulfillJson(r, [person("p-admin", "Asha Raman", "Engineering Director", "factory_admin"), person("p-lead", "Meera Iyer", "Tech Lead", "tech_lead"), person("p-reader", "Rae Reader", "Auditor", "auditor")]);
  Object.assign(ov, workforceOverrides());
  Object.assign(ov, richGroupE());
  Object.assign(ov, richGroupProj());
  richGov1(ov, floorFor as never); // gov1 (People, Workload, Access) fixtures, over the shared ones
  return ov;
}

/** Install the API fixtures for the fidelity harness on a page: the admin persona and the rich plant above. */
export async function installRich(page: Page): Promise<void> {
  await mockApi(page, { persona: PERSONAS.admin, overrides: richOverrides() });
}

/** Signed-out API for the sign-in screen: /me answers 401, nothing else is needed. */
export async function installSignedOut(page: Page): Promise<void> {
  // --- ds group: the public config the prototype's sign-in screen names (provider, domain, MFA policy) ---
  await mockApi(page, { persona: null, overrides: { me: (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ ok: false, msg: "Not signed in", config: { demoAccounts: false, githubLogin: true, idpName: "Okta", allowedDomain: "acme.dev", mfaRequiredForAdmins: true } }) }) } });
  // --- end ds group ---
}
