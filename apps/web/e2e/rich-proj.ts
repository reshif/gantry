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

export function richGroupProj(projectIds: string[]): Record<string, Handler> {
  const ov: Record<string, Handler> = {};
  for (const id of projectIds) if (id !== "payments") ov[`projects/${id}/repos`] = (r) => fulfillJson(r, [repo(id, `${id}-api`, "Go"), repo(id, `${id}-web`, "TypeScript")]);
  ov["projects/payments/repos/available"] = (r) => fulfillJson(r, { available: [{ repo: "acme/docs-site", lang: "MDX" }, { repo: "acme/billing-ui", lang: "TypeScript" }, { repo: "acme/ledger-sync-2", lang: "Go" }] });
  ov["freezes"] = (r) => fulfillJson(r, [{ id: "FRZ-1", name: "Quarter-end close", repos: ["payments-api"], from: NOW + DAY, to: NOW + 3 * DAY, by: "p-admin", version: 1 }]);
  return ov;
}
