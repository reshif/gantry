/** Workforce fixtures for the fidelity harness (group D): skills, vendors, routing, prices, budgets, evals, trust and learning. Extends rich.ts; changes no defaults. */
import { fulfillJson, type Handler } from "./fixtures";

const NOW = Date.parse("2026-01-15T10:00:00Z");
const DAY = 86_400_000;
const AG = ["ag-intake", "ag-research", "ag-spec", "ag-design", "ag-plan", "ag-build", "ag-test", "ag-review", "ag-close"];
const AGN: Record<string, string> = { "ag-intake": "Intake Clerk", "ag-research": "Researcher", "ag-spec": "Spec Writer", "ag-design": "Designer", "ag-plan": "Planner", "ag-build": "Builder", "ag-test": "Test Engineer", "ag-review": "Reviewer", "ag-close": "Release Captain" };
const ST = ["intake", "research", "spec", "design", "plan", "build", "verify", "review", "close"];

const SKILLS: Array<[string, string, string, string, string[]]> = [
  ["sk-review", "Code review and PR description", "Review against the plan.", "1.0.0", ["ag-review"]],
  ["sk-research", "Codebase research", "Find the files, owners and prior art.", "1.2.0", ["ag-research"]],
  ["sk-design", "Design notes and risks", "Interfaces, data changes, risks.", "1.4.0", ["ag-design"]],
  ["sk-impl", "Implementation discipline", "Small commits, tests first.", "1.3.0", ["ag-build"]],
  ["sk-plan", "Implementation planning", "Ordered steps with tests.", "1.1.0", ["ag-plan"]],
  ["sk-intake", "Intake interviewing", "Ask the few questions that unblock a brief.", "1.0.0", ["ag-intake"]],
  ["sk-migration", "Migration safety", "Expand, backfill, contract.", "1.2.0", ["ag-plan", "ag-build"]],
  ["sk-relnotes", "Release notes", "Customer-facing change summary.", "1.1.0", ["ag-close"]],
  ["sk-security", "Security review", "Threat check on sensitive paths.", "1.0.0", ["ag-design"]],
  ["sk-spec", "Spec writing", "Acceptance criteria, scope, rollback note.", "1.3.0", ["ag-spec"]],
];
export const skills = () => SKILLS.map(([id, name, desc, version], i) => ({
  id, name, desc, when: desc, owner: "p-lead", body: `# ${name}\n\n${desc}\n\n1. Read the structured result from the previous station.\n2. Apply the steps for this skill.\n`, resources: [], version, projects: "all",
  versions: [{ v: version, at: NOW - (i + 3) * DAY, by: "p-lead", note: "Reviewed edit" }], coverage: { suite: "su-" + ST[i % 9], cases: 6 + (i % 4) * 3, pass: 5 + (i % 4) * 3 }, builtin: i < 6,
}));

const model = (vendor: string, id: string, name: string, inPrice: number, outPrice: number, enabled = true) => ({ id, name, enabled, context: 200000, inPrice, outPrice, vendor, tier: "standard", canonical: id.replace(/^.*?:/, ""), invocable: true });
const vendors = () => [
  { id: "anthropic", name: "Anthropic", product: "Claude API", connected: true, health: "healthy", latency: 640, mtd: 1480, budget: 4000, keyMask: "sk-ant-…a41f", region: "us", endpoint: "https://api.anthropic.com", residency: "US", retention: "30d", version: 2, models: [model("anthropic", "claude-sonnet", "Claude Sonnet", 3, 15), model("anthropic", "claude-opus", "Claude Opus", 15, 75), model("anthropic", "claude-haiku", "Claude Haiku", 0.8, 4)] },
  { id: "bedrock", name: "Amazon Bedrock", product: "Bedrock runtime", connected: true, health: "degraded", latency: 1320, mtd: 410, budget: 1500, keyMask: "AKIA…7Q2", region: "eu", endpoint: "bedrock-runtime.eu-west-1", residency: "EU", retention: "zero", version: 1, models: [model("bedrock", "bedrock:claude-sonnet", "Claude Sonnet (Bedrock)", 3, 15)] },
  { id: "vertex", name: "Google Vertex", product: "Vertex AI", connected: false, health: "offline", latency: 0, mtd: 0, budget: 1000, keyMask: "", region: "us", endpoint: "", residency: "US", retention: "standard", version: 1, models: [model("vertex", "vertex:claude-sonnet", "Claude Sonnet (Vertex)", 3, 15, false)] },
];
const routing = () => ({ defaultModel: "claude-sonnet", overrides: { plan: "claude-opus", spec: "claude-opus", review: "claude-opus", intake: "claude-haiku" }, fallback: ["bedrock:claude-sonnet"], rules: [{ id: "r1", tag: "regulated", use: "bedrock:claude-sonnet", region: "eu", alt: "", note: "EU residency for regulated projects" }], classOverrides: {}, crossModelFallback: false, version: 4 });
const prices = () => ({ current: 3, versions: [3, 2, 1].map((version) => ({ version, effectiveFrom: new Date(NOW - version * 30 * DAY).toISOString(), publishedAt: new Date(NOW - version * 30 * DAY).toISOString(), publishedBy: "p-admin", note: version === 3 ? "Opus price cut" : "Quarterly review", prices: { "claude-sonnet": { in: 3, out: 15 }, "claude-opus": { in: 15, out: 75 }, "claude-haiku": { in: 0.8, out: 4 } } })) });
const budgets = () => ["payments", "storefront", "identity", "risk", "search"].map((project, i) => ({ project, monthly: 4000, alertAt: 0.8, perWorkOrder: 25, spent: 1280 + i * 190, version: 1 }));

const scorecards = () => Object.fromEntries(AG.map((id, i) => [id, { taskSuccess: 0.89 + (i % 4) * 0.02, firstPass: 0.8 + (i % 5) * 0.03, testPass: 0.93, rework: 0.05 + (i % 3) * 0.02, costPerWO: 0.9 + i * 0.15, minutesPerStation: 8 + i, gateRejections: i % 3, overrideRate: 0.04, trend: { success: [0.86, 0.88, 0.9, 0.89, 0.92, 0.91 + (i % 3) * 0.01], cost: [1.1, 1.0, 1.05, 0.98, 0.95, 0.9], n: [12, 14, 15, 13, 16, 18] }, counts: { attempts: 60 + i * 9, decisions: 20 + i, workOrders: 18 + i, tests: 40 } }]));
const suites = () => ST.map((s, i) => ({ id: "su-" + s, name: `${AGN[AG[i]!]} golden set`, station: s, threshold: 0.85, agent: AG[i], version: 1, builtin: true, running: null, cases: [1, 2, 3, 4, 5].map((n) => ({ id: `${s}-c${n}`, name: `Case ${n}: ${s} sample`, task: "Handle the sample request.", golden: n < 3, rules: [{ kind: "contains", text: "ok" }], by: "p-lead", added: NOW - 20 * DAY })) }));
const runs = () => ST.flatMap((s, i) => [0, 1, 2].map((k) => ({ id: `run-${s}-${k}`, suite: "su-" + s, agent: AG[i], version: "1.4.0", model: "claude-sonnet", at: NOW - (k + 1) * DAY * 3, score: 0.86 + ((i + k) % 5) * 0.02, results: [], by: "p-lead", cost: 1.2, status: "completed", count: 5, passed: 4 + (k % 2), range: [0.6, 0.97], finishedAt: NOW - (k + 1) * DAY * 3 + 60000 })));
const evalsFactory = () => ({
  heat: Object.fromEntries(AG.map((a, i) => [a, Object.fromEntries(["feature", "bug", "refactor", "docs"].map((c, j) => [c, 0.7 + ((i + j) % 4) * 0.08]))])),
  confusion: { feature: { feature: 21, bug: 2, refactor: 1 }, bug: { feature: 1, bug: 17, refactor: 0 }, refactor: { feature: 1, bug: 0, refactor: 9 } },
  perClass: { feature: { count: 54, success: 0.91, cycleH: 7.2, rework: 0.06 }, bug: { count: 31, success: 0.94, cycleH: 3.1, rework: 0.04 }, refactor: { count: 18, success: 0.88, cycleH: 5.4, rework: 0.09 } },
  overrideRate: 0.04, onboarding: { attempts: 14, ready: 11, successRate: 0.79, medianDays: 2.1, p90Days: 5, failedReasons: [["No test command", 2], ["Missing CI access", 1]] },
  gateRejections: [["G5", 6], ["G4", 3], ["G2", 2]], humanOverride: { "ag-build": 3, "ag-review": 2 }, onboardingStages: { discovered: 3, assessed: 4, ready: 11 }, counts: { workOrders: 103, classified: 99, decisions: 212, attempts: 540 },
});
const trust = () => ({
  sampleRate: 20, seededAt: NOW - 60 * DAY, nextProposal: 3, levelsAboveL1: true, minRuns: 5, soakDays: 7, maxGrantable: 3, criteriaVersion: 1,
  criteria: { "1": { cleanRuns: 5, evalMin: 0.8, reworkMax: 0.2, incidentsMax: 1, windowD: 14 }, "2": { cleanRuns: 15, evalMin: 0.88, reworkMax: 0.12, incidentsMax: 0, windowD: 30 }, "3": { cleanRuns: 40, evalMin: 0.93, reworkMax: 0.06, incidentsMax: 0, windowD: 60 } },
  ceilings: [{ id: "ce1", text: "Regulated projects are capped at L2", when: { regulated: true }, max: 2, enabled: true, version: 1 },
    // --- work2 (Trust fidelity): the prototype's four ceilings ---
    { id: "ce2", text: "Security fixes never run above L1", when: { cls: "security" }, max: 1, enabled: true, version: 1 },
    { id: "ce3", text: "Hotfixes are capped at L2", when: { cls: "hotfix" }, max: 2, enabled: true, version: 1 },
    { id: "ce4", text: "Release confirmation (G6) is capped at L3 on Payments Platform", when: { project: "payments", gate: "G6" }, max: 3, enabled: true, version: 1 },
    // --- end work2 ---
  ],
  cells: AG.flatMap((agent, i) => ["payments", "storefront", "risk"].flatMap((project, k) => ["feature", "bug"].map((cls, j) => ({ id: `tc-${agent}-${cls}-${project}`, agent, cls, project, repo: null, level: (i + j + k) % 4, since: NOW - (10 + i) * DAY, cleanRuns: 6 + i * 4 + j * 3, history: [{ at: NOW - (10 + i) * DAY, from: 0, to: 1, by: "p-lead", note: "Initial grant" }], rev: 1, gate: "G5", effective: (i + j + k) % 4, evidence: { runs: 12 + i * 3, cleanRuns: 6 + i * 4, evalScore: 0.9, rework: 0.06, incidents: 0, incidentWos: [] }, meets: { ok: (i + j) % 2 === 0, next: 2, missing: (i + j) % 2 ? ["More clean runs"] : [] }, ceiling: { max: 3, ids: [] }, projection: 2, pending: null })))),
  proposals: [],
});
const findings = () => [
  { id: "lf-1", title: "Reviewers keep asking for rollback notes", signal: "rejection", agent: "ag-spec", project: "payments", evidence: ["WO-1004 rejected at G2", "WO-1013 rejected at G2"], count: 7, firstAt: NOW - 20 * DAY, lastAt: NOW - 1 * DAY, status: "open", rev: 1 },
  { id: "lf-2", title: "Builder diffs overridden on migration files", signal: "override", agent: "ag-build", project: "payments", evidence: ["WO-1021 override"], count: 4, firstAt: NOW - 15 * DAY, lastAt: NOW - 2 * DAY, status: "open", rev: 1 },
  { id: "lf-3", title: "Release notes missed a breaking flag", signal: "miss", agent: "ag-close", project: null, evidence: ["WO-1008"], count: 2, firstAt: NOW - 9 * DAY, lastAt: NOW - 3 * DAY, status: "addressed", rev: 1 },
];
const proposals = () => [
  { id: "lp-1", finding: "lf-1", kind: "guideline", title: "Require a rollback note in every spec", owner: "ag-spec", status: "proposed", at: NOW - 2 * DAY, expected: "Fewer G2 rejections", change: {}, history: [], rev: 1, windowDays: 14, metric: { signal: "rejection", project: "payments", agent: "ag-spec", target: 2 }, baseline: { count: 7, from: NOW - 20 * DAY, to: NOW } },
  { id: "lp-2", finding: "lf-3", kind: "skill", title: "Add a breaking-change check to Release notes", owner: "ag-close", status: "verified", at: NOW - 8 * DAY, expected: "No missed breaking flags", change: {}, history: [], rev: 2, appliedAt: NOW - 6 * DAY, appliedBy: "p-lead", verification: { measured: 0, target: 1, baseline: 2, at: NOW - DAY, by: "p-lead" } },
];

export function workforceOverrides(): Record<string, Handler> {
  const j = (f: () => unknown): Handler => (r) => fulfillJson(r, f());
  return {
    skills: j(skills), vendors: j(vendors), routing: j(routing), prices: j(prices), budgets: j(budgets), "routing/versions": j(() => [{ version: 4, publishedAt: new Date(NOW - 5 * DAY).toISOString(), publishedBy: "p-admin", note: "Opus on plan" }]),
    "evals/scorecards": j(scorecards), suites: j(suites), "evals/runs": j(runs), "evals/factory": j(evalsFactory),
    "trust/cells": j(trust), "learning/findings": j(findings), "learning/proposals": j(proposals), "learning/signals": j(() => []),
  };
}
