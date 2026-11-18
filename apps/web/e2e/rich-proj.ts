/**
 * Group proj (projects, onboarding, project config) fixtures for the fidelity harness. Merged last into richOverrides().
 * Mirrors the prototype's data: 20 people with owners and members per project, the prototype's repos (3 for payments, 2 for each other
 * project, one still assessing), the four repos the GitHub App could still connect, two freezes and the seven work-order classes.
 * Connecting a repo, opening its onboarding PR and merging it are stateful here, so the wizard runs end to end.
 */
import { fulfillJson, type Handler } from "./fixtures";

const NOW = Date.parse("2026-01-15T10:00:00Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Prototype owners and regulated flags (used by rich.ts project()). */
export const PROJ_OWNER: Record<string, string> = { payments: "p-lead", storefront: "p-chloe", risk: "p-grace", identity: "p-lena", mobile: "p-hana", "data-platform": "p-nikhil", search: "p-sofia", "internal-tools": "p-ines" };
export const PROJ_REGULATED = new Set(["payments", "risk", "identity"]);

const PROJECT_IDS = ["payments", "storefront", "risk", "identity", "mobile", "data-platform", "search", "internal-tools"];
/** [id, name, title, role] in the prototype's order; the first is the signed-in admin. */
const PEOPLE: Array<[string, string, string, string]> = [
  ["p-admin", "Asha Raman", "Head of Engineering", "factory_admin"], ["p-omar", "Omar Haddad", "VP Platform", "factory_admin"], ["p-daniel", "Daniel Okafor", "Factory Manager", "project_admin"],
  ["p-lead", "Meera Iyer", "Engineering Lead, Payments", "line_lead"], ["p-tomas", "Tomás Ferreira", "Software Engineer", "engineer"], ["p-priya", "Priya Nair", "Staff Engineer", "reviewer"],
  ["p-kenji", "Kenji Watanabe", "Release Manager", "release_manager"], ["p-sam", "Sam Whitfield", "Compliance Auditor", "auditor"], ["p-lena", "Lena Fischer", "Engineering Lead, Platform", "project_admin"],
  ["p-chloe", "Chloe Martin", "Engineering Lead, Growth", "line_lead"], ["p-arjun", "Arjun Mehta", "Frontend Engineer", "engineer"], ["p-fatima", "Fatima Zahra", "Senior Engineer", "reviewer"],
  ["p-nikhil", "Nikhil Rao", "Engineering Lead, Data", "project_admin"], ["p-grace", "Grace Liu", "Security Engineer", "approver"], ["p-rui", "Rui Costa", "Platform Engineer", "engineer"],
  ["p-hana", "Hana Sato", "Engineering Lead, Mobile", "project_admin"], ["p-diego", "Diego Alvarez", "Engineering Manager, Data", "line_lead"], ["p-ines", "Ines Moreau", "Engineering Lead, Internal Tools", "project_admin"],
  ["p-kwame", "Kwame Mensah", "Engineering Lead, Partners", "project_admin"], ["p-sofia", "Sofia Rossi", "Senior Engineer, Search", "reviewer"],
];

function people() {
  return PEOPLE.map(([id, name, title, role], i) => {
    const grants: Array<{ role: string; scope: string }> = role === "factory_admin" ? [{ role, scope: "factory" }] : [];
    PROJECT_IDS.forEach((pid, j) => {
      if (PROJ_OWNER[pid] === id || (i + j) % 4 === 0) grants.push({ role: role === "factory_admin" ? "project_admin" : role === "auditor" ? "viewer" : role, scope: pid });
    });
    if (!grants.length) grants.push({ role, scope: "factory" });
    return { id, name, title, email: `${id.slice(2)}@acme.dev`, teams: ["platform"], roles: grants, status: i === 19 ? "deactivated" : i === 15 ? "invited" : "active", oncall: false, github: id.slice(2), away: null };
  });
}

interface RepoSpec { project: string; name: string; lang: string; tests: number; frozen?: boolean; stage?: string }
const BASE: RepoSpec[] = [
  { project: "payments", name: "payments-api", lang: "Go", tests: 83 }, { project: "payments", name: "payouts-worker", lang: "TypeScript", tests: 91, frozen: true }, { project: "payments", name: "ledger-core", lang: "Swift", tests: 80 },
  { project: "storefront", name: "storefront-web", lang: "Go", tests: 75 }, { project: "storefront", name: "checkout-ui", lang: "TypeScript", tests: 83 },
  { project: "risk", name: "risk-rules", lang: "Python", tests: 90 }, { project: "risk", name: "kyc-service", lang: "TypeScript", tests: 88 },
  { project: "identity", name: "identity-gateway", lang: "Kotlin", tests: 72 }, { project: "identity", name: "session-store", lang: "Go", tests: 85 },
  { project: "mobile", name: "ios-app", lang: "Go", tests: 87 }, { project: "mobile", name: "android-app", lang: "Go", tests: 79 },
  { project: "data-platform", name: "pipelines", lang: "Python", tests: 77 }, { project: "data-platform", name: "metrics-lake", lang: "Go", tests: 74 },
  { project: "search", name: "search-service", lang: "Go", tests: 92 }, { project: "search", name: "relevance-lab", lang: "Python", tests: 71, stage: "connected" },
  { project: "internal-tools", name: "support-console", lang: "TypeScript", tests: 81 }, { project: "internal-tools", name: "ops-portal", lang: "Go", tests: 96 },
];

const PR_FILES = [".github/workflows/gantry.yml", "CODEOWNERS", "gantry/guidelines.md", "gantry/stations.yml", "gantry/gates.yml", "README.md"];
const finding = (i: number, check: string, detail: string) => ({ id: `f${i}`, check, ok: true, sev: "medium", fix: "", file: null, detail, source: "observed" });
const findingsFor = (tests: number, flaky = false) => [
  finding(0, "Tests run in CI", "Run in 4m 12s"), finding(1, "Coverage reported", `${tests}%`), flaky ? { ...finding(2, "Flaky suites", "1 (integration/queue)"), ok: false, fix: "Builds retry the flaky suite once." } : finding(2, "Flaky suites", "1 (integration/queue)"),
  finding(3, "CI checks", "GitHub Actions, green on main"), finding(4, "Secrets scan", "Clean"), finding(5, "Sensitive paths", ".github/workflows, CODEOWNERS"),
];

const repoOf = (s: RepoSpec, over: { stage?: string; pr?: unknown; flaky?: boolean } = {}) => {
  const stage = over.stage ?? s.stage ?? "ready";
  return {
    id: s.name, name: `acme/${s.name}`, project: s.project, team: "platform", tags: [], lang: s.lang, halted: null, freeze: !!s.frozen,
    config: { defaultBranch: "main", branchPrefix: "gantry/", merge: "squash", tagging: "semver", requiredChecks: ["ci/test"], protectedPaths: [".github/workflows/**", "CODEOWNERS"] },
    mcp: [], notifyOverrides: [], triggers: true, guidelines: "", version: 1,
    onboarding: { stage, startedAt: NOW - 9 * DAY, readyAt: stage === "ready" ? NOW - 8 * DAY : undefined, exception: null, timeline: [], busy: null, verification: null, findings: stage === "connected" ? [] : findingsFor(s.tests, over.flaky), pr: over.pr ?? null },
  };
};

const mkPr = (state: "open" | "merged") => ({ number: 3, title: "Onboard to Gantry", branch: "gantry/onboarding", checks: "green", state, reviewers: [], mergedBy: state === "merged" ? "p-admin" : null, files: PR_FILES.map((path, i) => ({ path, plus: 20 + i, minus: i < 2 ? 1 : 0, finding: "f0" })) });

const AVAILABLE = [{ repo: "acme/docs-site", lang: "MDX" }, { repo: "acme/billing-ui", lang: "TypeScript" }, { repo: "acme/ledger-sync", lang: "Go" }, { repo: "acme/notify-worker", lang: "Python" }];

export function richGroupProj(): Record<string, Handler> {
  const ov: Record<string, Handler> = {};
  /** Repos connected through the wizard in this page's life, with their stage and pull request. */
  const added: Array<{ spec: RepoSpec; stage: string; pr: unknown }> = [];
  const all = () => [...BASE.map((s) => repoOf(s)), ...added.map((a) => repoOf(a.spec, { stage: a.stage, pr: a.pr, flaky: true }))];
  for (const id of PROJECT_IDS) ov[`projects/${id}/repos`] = (r) => fulfillJson(r, all().filter((x) => x.project === id));
  ov["POST projects/payments/repos"] = (r) => {
    const body = r.request().postDataJSON() as { name?: string };
    const name = String(body?.name ?? "acme/new-repo");
    const spec: RepoSpec = { project: "payments", name: name.split("/")[1] ?? name, lang: AVAILABLE.find((a) => a.repo === name)?.lang ?? "Go", tests: 71 };
    // the Onboarding Agent has already opened PR #3 (the prototype's step 4 shows it)
    added.push({ spec, stage: "pr_checks", pr: mkPr("open") });
    return fulfillJson(r, { ok: true, repo: repoOf(spec, { stage: "pr_checks", pr: mkPr("open"), flaky: true }) });
  };
  ov["projects/payments/repos/available"] = (r) => fulfillJson(r, { available: AVAILABLE.filter((a) => !added.some((x) => `acme/${x.spec.name}` === a.repo)) });
  const sessionFor = (id: string, project: string) => ({
    repoId: id, repo: `acme/${id}`, project, stage: "assessed", busy: null, prNeedsUpdate: false, prChecks: null, waiting: null,
    // the author is the agent's display name: this fixture registers no agent-list entry for the onboarding agent
    messages: [{ id: `m-${id}`, role: "assistant", author: "Onboarding Agent", text: `Assessment done for ${id}: tests run in 4m, coverage 71%, one flaky suite. I propose a guideline pack v2 and an onboarding PR.`, at: NOW - 95 * 60_000, data: {} }],
    agent: { mode: "rule-based", reason: "Fixture: no model call" }, budget: { spentUsd: 0.4, limitUsd: 20 }, costUsd: 0.4, can: { talk: true, merge: false, talkWhy: "" }, steps: [], next: { actor: "agent", text: "The Onboarding Agent is proposing the PR." },
  });
  for (const spec of [...BASE, ...AVAILABLE.map((a) => ({ project: "payments", name: a.repo.split("/")[1]!, lang: a.lang, tests: 78 }))]) {
    const id = spec.name;
    ov[`POST repos/${id}/onboarding/open-pr`] = (r) => { const a = added.find((x) => x.spec.name === id); if (a) { a.stage = "pr_checks"; a.pr = mkPr("open"); } return fulfillJson(r, { ok: true }); };
    ov[`POST repos/${id}/onboarding/merge`] = (r) => { const a = added.find((x) => x.spec.name === id); if (a) { a.stage = "ready"; a.pr = mkPr("merged"); } return fulfillJson(r, { ok: true }); };
    ov[`repos/${id}/onboarding/session`] = (q) => fulfillJson(q, sessionFor(id, spec.project));
  }
  ov["freezes"] = (r) => fulfillJson(r, [
    { id: "FRZ-07", name: "Payout batch cutover", repos: ["payouts-worker"], from: NOW - 2 * HOUR, to: NOW + 90 * HOUR, by: "p-lead", version: 1 },
    { id: "FRZ-08", name: "Year-end change freeze", repos: "all", from: NOW + 34 * DAY, to: NOW + 49 * DAY, by: "p-admin", version: 1 },
  ]);
  ov["people"] = (r) => fulfillJson(r, people());
  ov["guidelines"] = (r) => fulfillJson(r, { version: 2, by: "p-admin", at: NOW - 6 * DAY, items: [{ id: "g1", text: "Every change ships with a test that fails without it.", required: true }, { id: "g2", text: "Never touch CODEOWNERS or workflows without a person's approval.", required: true }] });
  return ov;
}

/** Prototype's seven work-order classes (id, name, SLA hours, skipped stations, default priority). */
export const PROJ_CLASSES = [
  { id: "feature", name: "Feature", slaH: 120, skips: [], priority: "P2" }, { id: "bug", name: "Bug", slaH: 48, skips: ["research", "design"], priority: "P2" }, { id: "hotfix", name: "Hotfix", slaH: 6, skips: ["research", "design"], priority: "P1" },
  { id: "epic", name: "Epic", slaH: 480, skips: [], priority: "P2" }, { id: "chore", name: "Chore", slaH: 168, skips: ["research", "spec", "design"], priority: "P3" }, { id: "refactor", name: "Refactor", slaH: 168, skips: ["research"], priority: "P3" },
  { id: "security", name: "Security fix", slaH: 24, skips: [], priority: "P1" },
];
