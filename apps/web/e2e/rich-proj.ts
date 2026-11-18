/**
 * Group proj (projects, onboarding, project config) fixtures for the fidelity harness: repos for every project (the Repos column),
 * the repos the GitHub App could still connect (onboarding wizard step 1) and a freeze. Merged last into richOverrides().
 */
import { fulfillJson, type Handler } from "./fixtures";

const NOW = Date.parse("2026-01-15T10:00:00Z");
const DAY = 86_400_000;

const repo = (project: string, name: string, lang: string) => ({
  id: name, name: `acme/${name}`, project, team: "platform", tags: [], lang, halted: null,
  config: { defaultBranch: "main", branchPrefix: "gantry/", merge: "squash", tagging: "semver", requiredChecks: ["ci/test"], protectedPaths: [".github/workflows/**", "CODEOWNERS"] },
  mcp: [], notifyOverrides: [], triggers: true, guidelines: "", version: 1,
  onboarding: { stage: "ready", startedAt: NOW - 9 * DAY, readyAt: NOW - 8 * DAY, exception: null, timeline: [], busy: null, verification: null, findings: [], pr: null },
});

const member = (id: string, name: string, title: string, role: string, scope = "payments") => ({ id, name, title, email: `${id}@acme.dev`, teams: ["platform"], roles: [{ role, scope }], status: "active", oncall: false, github: id, away: null });
const admin = { id: "p-admin", name: "Asha Raman", title: "Engineering Director", email: "p-admin@acme.dev", teams: ["platform"], roles: [{ role: "factory_admin", scope: "factory" }, { role: "project_admin", scope: "payments" }], status: "active", oncall: false, github: "p-admin", away: null };
const lead = { ...member("p-lead", "Meera Iyer", "Engineering Lead, Payments", "line_lead") };

export function richGroupProj(projectIds: string[]): Record<string, Handler> {
  const ov: Record<string, Handler> = {};
  for (const id of projectIds) if (id !== "payments") ov[`projects/${id}/repos`] = (r) => fulfillJson(r, [repo(id, `${id}-api`, "Go"), repo(id, `${id}-web`, "TypeScript")]);
  ov["projects/payments/repos/available"] = (r) => fulfillJson(r, { available: [{ repo: "acme/docs-site", lang: "MDX" }, { repo: "acme/billing-ui", lang: "TypeScript" }, { repo: "acme/ledger-sync-2", lang: "Go" }] });
  ov["freezes"] = (r) => fulfillJson(r, [{ id: "FRZ-1", name: "Quarter-end close", repos: ["payments-api"], from: NOW + DAY, to: NOW + 3 * DAY, by: "p-admin", version: 1 }]);
  ov["people"] = (r) => fulfillJson(r, [admin, lead, member("p-tomas", "Tomas Ferreira", "Software Engineer", "engineer"), member("p-lena", "Lena Fischer", "Engineering Lead, Platform", "project_admin"), member("p-nikhil", "Nikhil Rao", "Engineering Lead, Data", "project_admin"), member("p-diego", "Diego Alvarez", "Engineering Manager, Data", "line_lead"), member("p-reader", "Rae Reader", "Auditor", "auditor", "factory"), member("p-arjun", "Arjun Mehta", "Software Engineer", "engineer", "search")]);
  ov["guidelines"] = (r) => fulfillJson(r, { version: 2, by: "p-admin", at: NOW - 6 * DAY, items: [{ id: "g1", text: "Every change ships with a test that fails without it.", required: true }, { id: "g2", text: "Never touch CODEOWNERS or workflow files without a person's tick.", required: true }], may: "Open pull requests, run the test suites, propose guideline changes.", mayNot: "Merge without approval, read secrets, change protected paths.", history: [{ v: 1, at: NOW - 30 * DAY, by: "p-admin", note: "First pack" }, { v: 2, at: NOW - 6 * DAY, by: "p-admin", note: "Added the protected-path rule" }] });
  for (const r of ["payments-api", "ledger-sync", "merchant-portal", "refund-worker", "payout-batch", "notify-worker", "fraud-rules"]) {
    ov[`repos/${r}/onboarding/session`] = (q) => fulfillJson(q, {
      repoId: r, repo: `acme/${r}`, project: "payments", stage: "assessed", busy: null, prNeedsUpdate: false, prChecks: null, waiting: null,
      messages: [{ id: `m-${r}`, role: "assistant", author: "ag-onboard", text: `Assessment done for acme/${r}: tests run in 4m, coverage 71%, one flaky suite. I propose a guideline pack v2 and an onboarding PR.`, at: NOW - 2 * DAY, data: {} }],
      agent: { mode: "rule-based", reason: "Fixture: no model call" }, budget: { spentUsd: 0.4, limitUsd: 20 }, costUsd: 0.4, can: { talk: true, merge: false, talkWhy: "" }, steps: [], next: { actor: "agent", text: "The Onboarding Agent is proposing the PR." },
    });
  }
  return ov;
}
