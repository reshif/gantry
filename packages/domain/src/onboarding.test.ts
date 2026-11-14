import { describe, expect, it } from "vitest";
import {
  ALWAYS_REQUIRED, RepoFacts, assess, detectTestCommand, judgeCodeowners, judgeOwners, judgeProtections, judgeRunner, needsDocker, ownersOf, parseCodeowners, planPr, readinessLost, readinessUnknown,
  judgeCanary, judgeGuidelines, lineDelta, prChecksState, type AssessContext, type PlanContext,
} from "./onboarding.js";

const SHA = "a".repeat(40);
const facts = (over: Record<string, unknown> = {}): RepoFacts =>
  RepoFacts.parse({
    repo: "acme/ledger", defaultBranch: "main", headSha: SHA, language: "TypeScript", languages: { TypeScript: 100 },
    files: ["package.json", "package-lock.json", "src/index.ts"], contents: { "package.json": JSON.stringify({ scripts: { test: "vitest run" }, engines: { node: ">=22" } }) },
    secrets: { scanned: 3, complete: true, hits: [] }, protection: null, ...over,
  });

const ctx = (over: Partial<AssessContext> = {}): AssessContext => ({
  guidelines: [
    { id: "gl-1", text: "CI runs on every PR.", required: true }, { id: "gl-2", text: "Test command documented.", required: true }, { id: "gl-3", text: "main is protected.", required: true },
    { id: "gl-4", text: "CODEOWNERS covers top-level dirs.", required: false }, { id: "gl-5", text: "Lint config.", required: false }, { id: "gl-6", text: "No secrets.", required: true },
    { id: "gl-7", text: "Reproducible build.", required: true }, { id: "gl-8", text: "Manifest with lockfile.", required: true }, { id: "gl-9", text: "MCP declared.", required: false },
  ],
  mcp: ["mcp-issues"], requiredChecks: ["ci/test"], ...over,
});

const plan = (): PlanContext => ({
  project: "payments", repoId: "ledger", org: "acme", team: "payments", defaultBranch: "main", branchPrefix: "gantry/", merge: "squash", requiredChecks: ["ci/test"], protectedPaths: [".github/workflows/**"], mcp: ["mcp-issues"],
  org_guidelines: { items: ctx().guidelines, may: "AGENTS.md", mayNot: "Never change application code.", version: 3 }, project_guidelines: { items: [{ id: "pg-1", text: "Signed model card.", required: true }], notes: "", version: 1 },
});

const byId = (f: ReturnType<typeof assess>, id: string) => f.find((x) => x.id === id)!;

describe("assess", () => {
  it("reads real facts: a node repo with no CI, owners or agents file", () => {
    const f = assess(facts(), ctx());
    expect(byId(f, "ci")).toMatchObject({ ok: false, file: ".github/workflows/gantry-ci.yml", required: true });
    expect(byId(f, "test")).toMatchObject({ ok: true, detail: "npm test (package.json scripts.test)" });
    expect(byId(f, "deps")).toMatchObject({ ok: true });
    expect(byId(f, "owners")).toMatchObject({ ok: false, file: "CODEOWNERS", required: false });
    expect(byId(f, "agents")).toMatchObject({ ok: false, file: "AGENTS.md", required: true });
    expect(byId(f, "secrets")).toMatchObject({ ok: true });
    expect(byId(f, "protect")).toMatchObject({ ok: false, manual: true });
    expect(byId(f, "docker")).toMatchObject({ ok: true });
  });

  it("makes the agents and docker checks required whatever the guidelines say", () => {
    const f = assess(facts(), ctx({ guidelines: [] }));
    for (const id of ALWAYS_REQUIRED) expect(byId(f, id).required).toBe(true);
    expect(byId(f, "ci").required).toBe(false);
  });

  it("a secret hit is a manual finding that names the file but never a value", () => {
    const f = assess(facts({ secrets: { scanned: 3, complete: true, hits: [{ path: "src/config.ts", line: 4, rule: "github-token" }] } }), ctx());
    const s = byId(f, "secrets");
    expect(s).toMatchObject({ ok: false, manual: true });
    expect(s.fix).toContain("src/config.ts:4 (github-token)");
  });

  it("an incomplete secret scan does not pass", () => {
    expect(byId(assess(facts({ secrets: { scanned: 9, complete: false, hits: [] } }), ctx()), "secrets").ok).toBe(false);
  });

  it("detects Docker on the test path and refuses to call it fixable", () => {
    const f = facts({ files: ["package.json", "package-lock.json", "docker-compose.test.yml"], contents: { "package.json": JSON.stringify({ scripts: { test: "docker compose -f docker-compose.test.yml run tests" } }) } });
    expect(needsDocker(f)).toMatch(/docker-compose.test.yml/);
    expect(byId(assess(f, ctx()), "docker")).toMatchObject({ ok: false, manual: true, required: true });
  });

  it("has no test command for a repo whose manifests do not say", () => {
    const f = facts({ files: ["package.json"], contents: { "package.json": JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }) } });
    expect(detectTestCommand(f)).toBeNull();
    expect(byId(assess(f, ctx()), "test")).toMatchObject({ ok: false, manual: true });
  });

  it("a Go repo gets go test and a go-version-file workflow, and passes a lockfile check only with go.sum", () => {
    const go = facts({ language: "Go", files: ["go.mod", "main.go"], contents: { "go.mod": "module x\n\ngo 1.22\n" } });
    expect(detectTestCommand(go)?.command).toBe("go test ./...");
    expect(byId(assess(go, ctx()), "deps")).toMatchObject({ ok: false, detail: "go.mod has no lockfile" });
    const p = planPr(go, assess(go, ctx()), plan());
    expect(p.find((x) => x.path === ".github/workflows/gantry-ci.yml")?.content).toContain("go-version-file: go.mod");
    expect(p.find((x) => x.path === ".tool-versions")).toBeUndefined(); // go.mod already pins the toolchain
    expect(p.find((x) => x.path === ".golangci.yml")).toBeTruthy();
  });

  it("an existing workflow is left alone", () => {
    const f = facts({ files: ["package.json", "package-lock.json", ".github/workflows/build.yml"] });
    expect(byId(assess(f, ctx()), "ci").ok).toBe(true);
    expect(planPr(f, assess(f, ctx()), plan()).some((x) => x.path.startsWith(".github/workflows"))).toBe(false);
  });

  it("an unknown stack gets a manual CI finding instead of a guessed workflow", () => {
    const f = facts({ files: ["README.md"], contents: {} });
    expect(byId(assess(f, ctx()), "ci")).toMatchObject({ ok: false, manual: true, file: null });
  });
});

describe("CODEOWNERS", () => {
  it("parses rules and flags invalid lines", () => {
    const { rules, invalid } = parseCodeowners("# c\n* @acme/payments\n/docs/ docs@acme.io\nbad [x] @a\n/x nobody\n");
    expect(rules.map((r) => r.pattern)).toEqual(["*", "/docs/"]);
    expect(invalid.map((x) => x.line)).toEqual([4, 5]);
  });

  it("last matching rule wins, anchored and directory patterns work", () => {
    const { rules } = parseCodeowners("* @a/all\n/.github/ @a/ci\n*.md @a/docs\n/src/**/gen/ @a/gen\n");
    expect(ownersOf(rules, "src/x.ts")).toEqual(["@a/all"]);
    expect(ownersOf(rules, ".github/workflows/ci.yml")).toEqual(["@a/ci"]);
    expect(ownersOf(rules, "README.md")).toEqual(["@a/docs"]);
    expect(ownersOf(rules, "src/a/b/gen/z.ts")).toEqual(["@a/gen"]);
    expect(ownersOf(rules, "other/.github/x")).toEqual(["@a/all"]);
  });

  it("must cover the CI config, itself and the Gantry config", () => {
    const f = facts({ files: ["CODEOWNERS", ".github/workflows/ci.yml"], contents: { CODEOWNERS: "/src/ @acme/payments\n" } });
    expect(judgeCodeowners(f)).toMatchObject({ path: "CODEOWNERS", valid: true, missing: [".github/workflows/ci.yml", "CODEOWNERS", ".gantry/factory.yml"] });
    const ok = facts({ files: [".github/CODEOWNERS", ".github/workflows/ci.yml"], contents: { ".github/CODEOWNERS": "* @acme/payments\n" } });
    expect(judgeOwners(ok).ok).toBe(true);
  });

  it("the plan edits an existing file by appending entries, and creates one when absent", () => {
    const f = facts({ files: ["package.json", "package-lock.json", "CODEOWNERS"], contents: { CODEOWNERS: "/src/ @acme/payments\n", "package.json": "{}" } });
    const p = planPr(f, assess(f, ctx()), plan()).find((x) => x.path === "CODEOWNERS")!;
    expect(p.mode).toBe("update");
    expect(p.minus).toBe(0); // the file only gains entries
    expect(p.added).toContain("/.gantry/ @acme/payments");
    expect(p.added).not.toContain("/src/ @acme/payments");
    expect(p.content).toContain("/src/ @acme/payments");
    expect(p.content).toContain("/.gantry/ @acme/payments");
    const created = planPr(facts(), assess(facts(), ctx()), plan()).find((x) => x.path === "CODEOWNERS")!;
    expect(created.mode).toBe("create");
    expect(created.content).toContain("* @acme/payments");
  });
});

describe("planPr", () => {
  it("adds the guidelines file, the Gantry config and a CI workflow for a bare node repo, with real line counts", () => {
    const f = facts();
    const files = planPr(f, assess(f, ctx()), plan());
    expect(files.map((x) => x.path).sort()).toEqual([".gantry/factory.yml", ".github/workflows/gantry-ci.yml", ".tool-versions", "AGENTS.md", "CODEOWNERS"]);
    expect(files.find((x) => x.path === ".tool-versions")?.content).toBe("nodejs 22\n");
    const agents = files.find((x) => x.path === "AGENTS.md")!;
    expect(agents.content).toContain("Run `npm test` before opening a PR.");
    expect(agents.content).toContain("Signed model card.");
    expect(agents.plus).toBe(agents.content.replace(/\n$/, "").split("\n").length);
    expect(agents.added).toHaveLength(agents.plus);
    const yml = files.find((x) => x.path === ".gantry/factory.yml")!.content;
    expect(yml).toContain("project: payments");
    expect(yml).toContain("repo: acme/ledger");
    expect(yml).toContain("  - mcp-issues");
    const wf = files.find((x) => x.path.endsWith("gantry-ci.yml"))!.content;
    expect(wf).toContain("name: ci/test");
    expect(wf).toContain("run: npm test");
  });

  it("writes nothing for a repo that already has everything", () => {
    const f = facts({
      files: ["package.json", "package-lock.json", "AGENTS.md", "CODEOWNERS", ".gantry/factory.yml", ".github/workflows/ci.yml", ".eslintrc.json", ".nvmrc"],
      contents: { "AGENTS.md": "# x", CODEOWNERS: "* @acme/payments\n", ".gantry/factory.yml": "repo: acme/ledger\nmcp:\n  - mcp-issues\n", "package.json": JSON.stringify({ scripts: { test: "vitest" } }) },
    });
    const findings = assess(f, ctx());
    expect(findings.filter((x) => !x.ok).map((x) => x.id)).toEqual(["protect"]);
    expect(planPr(f, findings, plan())).toEqual([]);
  });
});

describe("readiness", () => {
  const prot = (over: Record<string, unknown> = {}) => ({
    defaultBranch: "main", branchProtection: null, appOnBypassList: false, requiresGantryCheck: true, gantryCheckPinned: true,
    installation: { id: 1, permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write", checks: "write", actions: "read", statuses: "read", administration: "read" }, repositorySelection: "selected", targetType: "Organization" },
    rulesets: [{ id: 1, name: "gantry", target: "branch", enforcement: "active", ruleTypes: ["pull_request", "required_status_checks"], requiredChecks: ["ci/test", "Gantry gates"], approvals: 1, codeOwners: true, bypassActors: [] }],
    ...over,
  });

  it("passes when the ruleset, pin, bypass list and permissions are right", () => {
    const r = judgeProtections(facts({ protection: prot() }), ["ci/test"]);
    expect(r.every((x) => x.ok)).toBe(true);
    expect(readinessLost(r)).toBe(false);
  });

  it("each failure names its cause", () => {
    const f = (over: Record<string, unknown>) => judgeProtections(facts({ protection: prot(over) }), ["ci/test"]);
    expect(f({ appOnBypassList: true }).find((x) => x.id === "bypass")).toMatchObject({ ok: false });
    expect(f({ gantryCheckPinned: false }).find((x) => x.id === "gantry_check")).toMatchObject({ ok: false });
    expect(f({ rulesets: [] }).find((x) => x.id === "ruleset")).toMatchObject({ ok: false, detail: "No active ruleset on the default branch." });
    expect(f({ rulesets: [{ id: 1, name: "g", target: "branch", enforcement: "evaluate", ruleTypes: ["pull_request"], requiredChecks: [], approvals: 1, codeOwners: true, bypassActors: [] }] }).find((x) => x.id === "ruleset")?.ok).toBe(false);
    const lacking = f({ installation: { id: 1, permissions: { metadata: "read", contents: "read" }, repositorySelection: null, targetType: "Organization" } }).find((x) => x.id === "installation")!;
    expect(lacking.ok).toBe(false);
    expect(lacking.detail).toContain("contents:write");
    expect(f({ installation: { id: 1, permissions: {}, repositorySelection: null, targetType: "User" } }).find((x) => x.id === "installation")?.detail).toMatch(/not an organisation/);
  });

  it("unreadable protections are unknown, not a loss", () => {
    const r = judgeProtections(facts(), ["ci/test"]);
    expect(r.every((x) => x.unknown)).toBe(true);
    expect(readinessLost(r)).toBe(false);
    expect(readinessUnknown(r)).toBe(true);
  });

  it("the runner check needs a variant with the toolchain and no Docker", () => {
    expect(judgeRunner(facts(), { base: ["node", "python"] }).ok).toBe(true);
    expect(judgeRunner(facts({ files: ["go.mod"], contents: { "go.mod": "go 1.22\n" } }), { base: ["node"] })).toMatchObject({ ok: false });
    const docker = facts({ files: ["package.json", "docker-compose.test.yml"], contents: {} });
    expect(judgeRunner(docker, { base: ["node"] }).detail).toMatch(/needs Docker/);
  });
});

describe("prChecksState", () => {
  const c = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });
  it("is pending until something reports, ignoring Gantry's own gate check", () => {
    expect(prChecksState(["ci/test"], [])).toBe("pending");
    expect(prChecksState(["ci/test"], [c("Gantry gates", "completed", "success")])).toBe("pending");
  });
  it("is running while a required check is missing or incomplete, green only when every required check passed, red on any failure", () => {
    expect(prChecksState(["ci/test", "ci/lint"], [c("ci/test", "completed", "success")])).toBe("running");
    expect(prChecksState(["ci/test"], [c("ci/test", "in_progress", null)])).toBe("running");
    expect(prChecksState(["ci/test"], [c("ci/test", "completed", "success"), c("other", "completed", "failure")])).toBe("green");
    expect(prChecksState([], [c("a", "completed", "success"), c("b", "completed", "skipped")])).toBe("green");
    expect(prChecksState(["ci/test"], [c("ci/test", "completed", "failure")])).toBe("red");
    expect(prChecksState([], [c("a", "completed", "success"), c("b", "completed", "timed_out")])).toBe("red");
  });
});

describe("judgeCanary", () => {
  const ok = { published: true, draftOpened: true, closed: true, cleaned: true, checks: [{ name: "ci/test", status: "completed", conclusion: "success", app: null }], directPush: "rejected" as const, directPushDetail: "403", error: null };
  it("passes three checks when the canary worked and the push was rejected", () => {
    expect(judgeCanary(ok).map((x) => [x.id, x.ok])).toEqual([["canary", true], ["canary_ci", true], ["direct_push", true]]);
  });
  it("fails the push check when GitHub accepted it, and the CI check when no check appeared", () => {
    const r = judgeCanary({ ...ok, directPush: "accepted", checks: [] });
    expect(r.find((x) => x.id === "direct_push")).toMatchObject({ ok: false });
    expect(r.find((x) => x.id === "canary_ci")).toMatchObject({ ok: false });
    expect(readinessLost(r)).toBe(true);
  });
  it("leaves everything unknown when the canary could not run, and an unclear push unknown", () => {
    expect(readinessLost(judgeCanary(null))).toBe(false);
    expect(judgeCanary({ ...ok, directPush: "unknown" }).find((x) => x.id === "direct_push")).toMatchObject({ unknown: true });
  });
});

describe("judgeGuidelines", () => {
  it("fails on a required gap that has no live check of its own, and ignores advisory gaps", () => {
    const f = assess(facts(), ctx());
    const r = judgeGuidelines(f);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("CI present");
    expect(r.detail).not.toContain("CODEOWNERS"); // advisory, and judged by the live code-owner check anyway
    expect(judgeGuidelines(assess(facts({ files: ["package.json", "package-lock.json", "AGENTS.md", ".github/workflows/ci.yml", ".gantry/factory.yml", ".nvmrc"], contents: { "AGENTS.md": "# a", ".gantry/factory.yml": "repo: x\nmcp:\n  - mcp-issues\n", "package.json": JSON.stringify({ scripts: { test: "vitest" } }) } }), ctx())).ok).toBe(true);
  });
  it("does not judge secrets on a light read", () => {
    const f = assess(facts({ secrets: { scanned: 0, complete: false, hits: [], skipped: true } }), ctx());
    expect(f.find((x) => x.id === "secrets")).toMatchObject({ ok: true, detail: "Not scanned in this check" });
  });
});

describe("lineDelta", () => {
  it("counts added and removed lines as a multiset", () => {
    expect(lineDelta("a\nb\nc\n", "a\nc\nd\ne\n")).toEqual({ plus: 2, minus: 1, added: ["d", "e"] });
    expect(lineDelta("", "x\ny\n")).toEqual({ plus: 2, minus: 0, added: ["x", "y"] });
    expect(lineDelta("same\n", "same\n")).toEqual({ plus: 0, minus: 0, added: [] });
  });
});
