/**
 * PROJ GROUP fixtures (Projects, Onboarding, Project config): the prototype's onboarding list (js/misc.js ONB) in the server's shapes.
 * The first three repositories the source integrations can see are mid-onboarding (assessed, PR opened, PR checks green); the rest wait.
 */
type Seed = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const hash = (s: string): number => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

export function projOnboarding(seed: Seed, projectId: string) {
  const NOW: number = seed.NOW;
  const avail: Array<{ repo: string; lang: string }> = (seed.integration_instances as Seed[]).flatMap((i) => i.available ?? []);
  const items: Seed[] = seed.guidelines.items;
  const findings = (name: string) => items.map((g, i) => ({ id: g.id, check: g.text, ok: (hash(name) >> i) % 3 !== 0, required: g.required, sev: g.required ? "high" : "low", fix: `Bring the repo in line: ${g.text}`, file: null }));
  const stages = ["assessed", "pr_opened", "pr_checks"] as const;
  const idOf = (name: string) => name.replace("/", "--");
  const repos = avail.slice(0, 3).map((a, i) => {
    const stage = stages[i]!;
    const pr = i >= 1 ? { number: 3 + i, state: "open", checks: i === 2 ? "green" : "pending", url: null, files: ["AGENTS.md", "CODEOWNERS", ".gantry/factory.yml"].map((path) => ({ path, plus: 12, minus: 0, finding: "", mode: "create", added: [] })) } : null;
    return {
      id: idOf(a.repo), name: a.repo, project: projectId, team: "payments", tags: [], lang: a.lang, halted: null, mcp: [], notifyOverrides: [], triggers: true, guidelines: "", version: 1,
      config: { defaultBranch: "main", branchPrefix: "gantry/", merge: "squash", tagging: "semver-patch", requiredChecks: ["ci/test"], protectedPaths: [] },
      onboarding: { stage, findings: findings(a.repo), pr, timeline: [{ at: NOW - 3_600_000, who: "ag-onboard", text: `I read ${a.repo} and checked it against the ${items.length} factory guidelines.` }], exception: null, startedAt: NOW - 86_400_000 },
    };
  });
  const waiting = avail.slice(3);
  const session = (repoId: string) => {
    const r = repos.find((x) => x.id === repoId);
    if (!r) return undefined;
    return {
      repoId, repo: r.name, project: projectId,
      messages: [{ id: "m1", role: "assistant", author: "ag-onboard", text: `I read ${r.name} and checked it against the ${items.length} factory guidelines. ${r.onboarding.findings.filter((f) => !f.ok).length} need work.`, at: NOW - 3_600_000, data: { mode: "agent" } }],
      agent: { mode: "agent", model: "claude-sonnet-5-5", vendor: "anthropic", version: 3 }, budget: { spentUsd: 0.4, limitUsd: 5 }, costUsd: 0.4,
      can: { talk: true, merge: true, talkWhy: "" }, steps: [], next: { actor: "you", text: "review the findings" }, stage: r.onboarding.stage, busy: null, prNeedsUpdate: false, waiting: null, prChecks: r.onboarding.pr?.checks ?? null,
    };
  };
  return { repos, waiting, session };
}
