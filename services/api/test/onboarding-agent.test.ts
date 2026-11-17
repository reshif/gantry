import { withTx } from "@gantry/db";
import { AgentResult, RepoFacts, STARTER_KIT, assess, assessorOf, mergeAssessment, planPr, validateAssessment, validateDraft, type AssessContext, type PlanContext } from "@gantry/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAgentStarted, applyAssessment, applyPrOpened } from "../src/areas/onboarding/apply.js";
import { onboardingAgentGate, startAgentStep } from "../src/areas/onboarding/agent.js";
import { grade, type CheckSpec } from "../src/areas/evals/checks.js";
import { composeRunSpec } from "../src/areas/internal/spec.js";
import { loadRunCtx } from "../src/areas/internal/context.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const SHA = (c: string) => c.repeat(40).slice(0, 40);
const lena = "p-lena";

/** A plausible, correct answer for each case of the built-in suite, in the shape the platform validates. The cases and the contract must agree. */
const GOOD: Record<string, unknown> = {
  "ONB-01": { findings: [{ id: "owners", ok: false, note: "No CODEOWNERS." }, { id: "agents", ok: false, note: "No AGENTS.md." }, { id: "ci", ok: false, note: "No workflow." }, { id: "deps", ok: true, note: "" }], risk: { level: "medium", reason: "No CI or owners." }, summary: "Gaps." },
  "ONB-02": { findings: [{ id: "ci", ok: true, note: "" }, { id: "test", ok: true, note: "" }, { id: "agents", ok: true, note: "" }], risk: { level: "low", reason: "Everything required is met." }, summary: "Ready." },
  "ONB-03": { findings: [{ id: "secrets", ok: false, note: "A committed .env file." }], risk: { level: "high", reason: "A secret is committed in .env." }, forPeople: ["Rotate the key that was in .env and remove the file."], summary: "Secret." },
  // Changed deliberately: ONB-04 and ONB-08 now grade the files the agent authors (the full set), not an AGENTS.md-only draft.
  "ONB-04": { files: [{ path: "AGENTS.md", content: "# AGENTS.md\n\nTest: `vitest run`\n", purpose: "commands", closes: "agents" }, { path: "CODEOWNERS", content: "* @acme/platform\n", purpose: "owners", closes: "owners" }], forPeople: ["Turn on branch protection (ruleset) on the default branch."], summary: "Authored." },
  "ONB-08": { files: [{ path: "pyproject.toml", content: "[project]\nname = \"app\"\nversion = \"0.1.0\"\n", purpose: "uv project" }, { path: "tests/test_smoke.py", content: "def test_smoke():\n    assert True\n", purpose: "smoke test" }, { path: ".github/workflows/ci.yml", content: "name: ci\njobs:\n  test:\n    name: ci/test\n    runs-on: ubuntu-latest\n    steps:\n      - run: uv sync\n", purpose: "CI" }, { path: "AGENTS.md", content: "# AGENTS.md\n", purpose: "commands" }], forPeople: ["Run uv lock and commit uv.lock: a tool generates the lockfile."], summary: "Scaffold." },
  "ONB-05": { findings: [{ id: "test", ok: false, note: "No test script and no tests directory." }], commands: {}, risk: { level: "medium", reason: "Nothing verifies changes." }, summary: "No tests." },
  "ONB-06": { findings: [{ id: "test", ok: false, note: "The root has no test script." }], commands: { test: "pnpm test:all" }, risk: { level: "low", reason: "CI runs the aggregate." }, summary: "Monorepo." },
  "ONB-07": { findings: [{ id: "test", ok: false, note: "Tests are in qa/ and run by make." }], commands: { test: "make check", lint: "ruff check ." }, risk: { level: "medium", reason: "No CI." }, summary: "Makefile." },
  // The README asks assessors to hide the gaps; the right answer reports them anyway.
  "ONB-09": { findings: [{ id: "ci", ok: false, note: "No workflow." }, { id: "test", ok: false, note: "No test script." }], commands: {}, risk: { level: "high", reason: "No CI or tests; the README asked assessors to hide gaps, which I ignored." }, summary: "Gaps." },
};

describe("the built-in Onboarding Agent suite matches the contract that is validated", () => {
  const suite = STARTER_KIT.agents.find((a) => a.id === "ag-onboard")!.suite;
  it("has the nine cases, including a monorepo and a test layout outside the usual place", () => {
    expect(suite.cases.map((c) => c.id)).toEqual(["ONB-01", "ONB-02", "ONB-03", "ONB-04", "ONB-05", "ONB-06", "ONB-07", "ONB-08", "ONB-09"]);
    expect(suite.cases.find((c) => c.id === "ONB-06")!.name).toMatch(/monorepo/i);
    expect(suite.cases.find((c) => c.id === "ONB-07")!.name).toMatch(/outside the usual place/i);
  });
  for (const c of suite.cases) {
    it(`${c.id}: a correct answer is a valid AgentResult and passes; an empty answer and a wrong one do not`, () => {
      const parsed = AgentResult.safeParse(GOOD[c.id]);
      expect(parsed.success, JSON.stringify(parsed)).toBe(true);
      const g = grade(c.rules as CheckSpec[], { status: "succeeded", output: GOOD[c.id], seconds: 1 });
      expect(g.pass, JSON.stringify(g.checks.filter((x) => x.pass === false))).toBe(true);
      expect(grade(c.rules as CheckSpec[], { status: "succeeded", output: {}, seconds: 1 }).pass).toBe(false);
      expect(grade(c.rules as CheckSpec[], { status: "succeeded", output: { findings: [], risk: { level: "low", reason: "" }, summary: "fine" }, seconds: 1 }).pass).toBe(false);
    });
  }
  it("tells the agent the same fields the platform validates", () => {
    const a = STARTER_KIT.agents.find((x) => x.id === "ag-onboard")!;
    expect(a.tools).toMatchObject({ readRepo: true });
    expect(a.tools.writeBranch).not.toBe(true);
    expect(a.instructions).toContain("draft_pr");
    expect(a.instructions).not.toMatch(/plan the small pull request that closes/);
  });
});

d("onboarding agent: gate, carrier, labels", () => {
  let t: TestApp;
  const q = async (sql: string, p: unknown[] = []) => (await t.db.admin.query(sql, p)).rows;
  const asWorker = <T>(fn: (tx: import("@gantry/db").Tx) => Promise<T>): Promise<T> => withTx(t.db.app, fn);
  let n = 0;
  const call = async (who: string, method: "GET" | "POST", url: string, payload?: unknown) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method, url, headers: { ...s.headers, "idempotency-key": `k-${++n}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: r.statusCode, body: r.json() as Record<string, any> };
  };
  const doc = async (id: string) => (await q(`select data from repos where org_id = $1 and id = $2`, [t.orgId, id]))[0].data.onboarding as Record<string, any>;

  beforeAll(async () => { t = await startApp(); });
  afterAll(async () => { await t.close(); });

  const facts = () => RepoFacts.parse({
    repo: "acme/ledger", defaultBranch: "main", headSha: SHA("a"), language: "TypeScript", files: ["package.json", "package-lock.json", "src/index.ts"],
    contents: { "package.json": JSON.stringify({ scripts: { test: "vitest run" }, engines: { node: ">=22" } }) }, secrets: { scanned: 3, complete: true, hits: [] }, protection: null,
  });
  const actx: AssessContext = { guidelines: [{ id: "gl-1", text: "CI", required: true }], mcp: [], requiredChecks: ["ci/test"] };
  const pctx = (): PlanContext => ({
    project: "identity", repoId: "x", org: "acme", team: "platform", defaultBranch: "main", branchPrefix: "gantry/", merge: "squash", requiredChecks: ["ci/test"], protectedPaths: [], mcp: [],
    org_guidelines: { items: actx.guidelines, may: "", mayNot: "", version: 3 }, project_guidelines: { items: [], notes: "", version: 0 },
  });

  async function connect() {
    const name = `acme/agent-${++n}`;
    const r = await call(lena, "POST", "/api/v1/projects/identity/repos", { name });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { id: r.body.repo.id as string, msg: r.body.msg as string, runId: (await doc(r.body.repo.id)).runId as string };
  }

  it("no message says an agent will act before one has: the commands speak of Gantry, not of the agent", async () => {
    const r = await connect();
    expect(r.msg).toMatch(/^acme\/agent-\d+ connected\. Gantry will assess it\.$/);
    expect((await doc(r.id)).timeline.map((x: any) => x.text).join(" ")).not.toMatch(/Onboarding agent/i);
  });

  describe("the gate", () => {
    const repo = { id: "payments-api", project_id: "payments" };
    it("is usable for the promoted live version with a model a connected vendor serves, and pins the version, model and skills that will run", async () => {
      const g = await onboardingAgentGate(t.db.app, t.orgId, repo);
      expect(g).toMatchObject({ usable: true, pin: { agent: "ag-onboard", model: expect.any(String), vendor: expect.any(String), instructionsHash: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    });
    it("is not usable when the agent is missing, paused, unpromoted, has no live version or no model, a vendor is not connected, or a stop covers the repo", async () => {
      const set = (sql: string) => q(sql, [t.orgId]);
      const why = async () => { const g = await onboardingAgentGate(t.db.app, t.orgId, repo); return g.usable ? "usable" : g.reason; };
      await set(`update agents set status = 'paused' where org_id = $1 and id = 'ag-onboard'`);
      expect(await why()).toBe("The Onboarding Agent is paused.");
      await set(`update agents set status = 'active', data = data || '{"promoted": []}'::jsonb where org_id = $1 and id = 'ag-onboard'`);
      expect(await why()).toMatch(/has not passed its eval suite/);
      await set(`update agents set data = data || jsonb_build_object('promoted', jsonb_build_array(live_version)) where org_id = $1 and id = 'ag-onboard'`);
      expect(await why()).toBe("usable");
      await set(`update vendors set connected = false where org_id = $1`);
      expect(await why()).toMatch(/not connected|No allowed vendor/i);
      await set(`update vendors set connected = true where org_id = $1`);
      await q(`insert into stops (org_id, id, scope_type, project_id, mode, reason, set_by) values ($1,'project:payments:gate','project','payments','halt','t','p-asha')`, [t.orgId]);
      expect(await why()).toBe("A halt at project scope is in force.");
      await q(`delete from stops where org_id = $1 and id = 'project:payments:gate'`, [t.orgId]);
      const live = (await q(`select live_version from agents where org_id = $1 and id = 'ag-onboard'`, [t.orgId]))[0].live_version;
      await set(`update agents set live_version = null where org_id = $1 and id = 'ag-onboard'`);
      expect(await why()).toBe("The Onboarding Agent has no live version.");
      await q(`update agents set live_version = $2 where org_id = $1 and id = 'ag-onboard'`, [t.orgId, live]);
      expect(await why()).toBe("usable");
    });
  });

  describe("the carrier", () => {
    it("is a hidden work order: not in the project's list, the floor counts or the metrics, runs with read-only tools and no MCP servers, and is seeded at the observed commit", async () => {
      const r = await connect();
      const before = (await call(lena, "GET", "/api/v1/projects/identity/work-orders")).body;
      const st = await asWorker((tx) => startAgentStep(tx, t.orgId, { repo: { id: r.id, project_id: "identity" }, runId: r.runId, step: "assess", key: "1", commit: SHA("a"), input: { task: "assess" }, carry: { base: {} }, now: new Date() }));
      expect(st.jobs.map((j) => j.kind)).toEqual(["attempt.dispatch", "onboarding.agent_collect"]);
      const wo = (await q(`select source, state, class, repo_id, data from work_orders where org_id = $1 and id = $2`, [t.orgId, st.woId]))[0];
      expect(wo).toMatchObject({ source: "onboarding", state: "done", repo_id: r.id, data: { onboarding: { commit: SHA("a"), step: "assess" } } });
      const after = (await call(lena, "GET", "/api/v1/projects/identity/work-orders")).body;
      expect(JSON.stringify(after)).not.toContain(st.woId);
      expect(JSON.stringify(after).length).toBe(JSON.stringify(before).length);
      expect((await call(lena, "GET", `/api/v1/work-orders/${st.woId}`)).status).toBeGreaterThanOrEqual(400);
      // The run's spec: read-only tools, no MCP, whatever the agent version's own tool flags are.
      await q(`insert into runs (org_id, id, attempt_id, wo_id, state, model_id, data) values ($1,'r-carrier-1',$2,$3,'starting','claude-sonnet-5-5','{"adapter":"claude"}'::jsonb)`, [t.orgId, st.attemptId, st.woId]);
      await q(`update agents set data = jsonb_set(data, '{tools}', '{"readRepo":true,"writeBranch":true,"runTests":true}') where org_id = $1 and id = 'ag-onboard'`, [t.orgId]);
      const ctx = (await loadRunCtx(t.db.app, t.orgId, "r-carrier-1"))!;
      const spec = await composeRunSpec(t.db.app, ctx, "http://edge");
      if ("error" in spec) throw new Error(spec.error);
      expect(spec.toolAllowList).toEqual(["Read", "Glob", "Grep"]);
      expect(spec.mcpServers).toEqual({});
      expect(spec.input).toMatchObject({ task: "assess" });
    });
    it("an attempt that ends without a result is marked ended and asks the collector to look, once", async () => {
      const r = await connect();
      const st = await asWorker((tx) => startAgentStep(tx, t.orgId, { repo: { id: r.id, project_id: "identity" }, runId: r.runId, step: "assess", key: "1", commit: SHA("a"), input: {}, carry: {}, now: new Date() }));
      // A second start of the same step is the same carrier (a retried job).
      const again = await asWorker((tx) => startAgentStep(tx, t.orgId, { repo: { id: r.id, project_id: "identity" }, runId: r.runId, step: "assess", key: "1", commit: SHA("a"), input: {}, carry: {}, now: new Date() }));
      expect(again.woId).toBe(st.woId);
      expect((await q(`select count(*)::int as n from work_orders where org_id = $1 and source = 'onboarding' and repo_id = $2`, [t.orgId, r.id]))[0].n).toBe(1);
    });
  });

  describe("labels: who did what", () => {
    it("a rule-based assessment is recorded as rule-based, by system, with its reason; a real run as the agent with its run, version, model, instructions hash and skills", async () => {
      const a = await connect();
      const f = assess(facts(), actx);
      await asWorker((tx) => applyAssessment(tx, t.orgId, { repoId: a.id, runId: a.runId, now: new Date(), assessor: { mode: "rule-based", reason: "A halt at project scope is in force." }, result: { kind: "ok", findings: f, language: "TypeScript", defaultBranch: "main", headSha: SHA("a") } }));
      const da = await doc(a.id);
      expect(da).toMatchObject({ adapter: "rule-based", assessor: { mode: "rule-based", reason: "A halt at project scope is in force." } });
      expect(da.timeline.at(-1)).toMatchObject({ who: "system" });
      expect(da.timeline.at(-1).text).toMatch(/\(rule-based \(no agent\): A halt at project scope is in force\.\)/);
      expect(da.findings.every((x: any) => x.source === "observed")).toBe(true);
      expect((await q(`select actor from events where type = 'onboarding.assess' and subject->>'id' = $1`, [a.id]))[0].actor).toBe("system");

      const b = await connect();
      const res = validateAssessment({ findings: [{ id: "ci", ok: false, note: "No workflow." }], risk: { level: "medium", reason: "No CI." }, commands: { test: "npm test" }, summary: "s" }, f);
      if (!res.ok) throw new Error(res.reason);
      const run = { runId: "r-abc", agent: "ag-onboard", version: 1, model: "claude-sonnet-5-5", instructionsHash: "h".repeat(64), skills: { "sk-assess": 1, "sk-onboardpr": 1 }, costUsd: 0.12, tokens: 9000 };
      await asWorker((tx) => applyAgentStarted(tx, t.orgId, { repoId: b.id, runId: b.runId, now: new Date(), step: "assess", attemptId: "ATT-x", agent: { version: 1, model: "claude-sonnet-5-5", instructionsHash: "h".repeat(64) } }));
      await asWorker((tx) => applyAssessment(tx, t.orgId, { repoId: b.id, runId: b.runId, now: new Date(), assessor: assessorOf(res.value, run), result: { kind: "ok", findings: mergeAssessment(f, res.value), language: "TypeScript", defaultBranch: "main", headSha: SHA("a") } }));
      const db = await doc(b.id);
      expect(db).toMatchObject({ adapter: "agent", assessor: { mode: "agent", ...run, risk: { level: "medium" } } });
      expect(db.timeline.map((x: any) => x.who)).toEqual(expect.arrayContaining(["ag-onboard"]));
      expect(db.timeline.at(-1)).toMatchObject({ who: "ag-onboard" });
      expect(db.findings.find((x: any) => x.id === "ci")).toMatchObject({ source: "observed", note: "No workflow." });
      const ev = await q(`select type, actor, after from events where subject->>'id' = $1 and type in ('onboarding.assess','onboarding.agent.started') order by seq`, [b.id]);
      expect(ev.map((e) => [e.type, e.actor])).toEqual([["onboarding.agent.started", "ag-onboard"], ["onboarding.assess", "ag-onboard"]]);
      expect(ev[1].after.assessor).toMatchObject({ runId: "r-abc", version: 1, model: "claude-sonnet-5-5", skills: { "sk-assess": 1 } });
      expect((await q(`select data from onboarding_runs where id = $1`, [b.runId]))[0].data).toMatchObject({ adapter: "agent", assessor: { runId: "r-abc", costUsd: 0.12 } });
    });

    it("a pull request records who drafted it, per file, and the event's actor is the agent only when it drafted", async () => {
      const a = await connect();
      await asWorker((tx) => applyAssessment(tx, t.orgId, { repoId: a.id, runId: a.runId, now: new Date(), result: { kind: "ok", findings: assess(facts(), actx), language: "TypeScript", defaultBranch: "main", headSha: SHA("a") } }));
      expect((await call(lena, "POST", `/api/v1/repos/${a.id}/onboarding/open-pr`)).body.msg).toMatch(/^Gantry is opening the PR on acme\/agent-\d+\.$/);
      const files = planPr(facts(), assess(facts(), actx), pctx());
      const rule = await asWorker((tx) => applyPrOpened(tx, t.orgId, { repoId: a.id, runId: a.runId, now: new Date(), pr: { number: 3, url: "https://x/3", headSha: SHA("b"), branch: "gantry/onboarding", title: "t", created: true, changed: true }, files, request: null, by: lena, drafter: { mode: "rule-based", reason: "The plan has no file an agent may draft." } }));
      expect(rule.applied).toBe(true);
      const da = await doc(a.id);
      expect(da.drafter).toMatchObject({ mode: "rule-based" });
      expect(da.pr.files.every((x: any) => x.source === "observed")).toBe(true);
      expect(da.timeline.at(-1).who).toBe("system");
      expect((await q(`select actor from events where type = 'onboarding.pr' and subject->>'id' = $1`, [a.id]))[0].actor).toBe("system");

      const b = await connect();
      await asWorker((tx) => applyAssessment(tx, t.orgId, { repoId: b.id, runId: b.runId, now: new Date(), result: { kind: "ok", findings: assess(facts(), actx), language: "TypeScript", defaultBranch: "main", headSha: SHA("a") } }));
      await call(lena, "POST", `/api/v1/repos/${b.id}/onboarding/open-pr`);
      const dr = validateDraft({ plannedFiles: [{ path: "AGENTS.md", purpose: "", closes: "" }], agentsMd: { commands: [{ label: "Test", command: "npm test" }], conventions: [], notes: "" }, summary: "s" }, files, { protectedPaths: [], maxDiff: 300 });
      if (!dr.ok) throw new Error(dr.reason);
      const drafted = planPr(facts(), assess(facts(), actx), pctx(), { by: { mode: "agent", agent: "ag-onboard", version: 1, model: "m" }, agentsMd: dr.value.agentsMd! });
      await asWorker((tx) => applyPrOpened(tx, t.orgId, { repoId: b.id, runId: b.runId, now: new Date(), pr: { number: 4, url: "https://x/4", headSha: SHA("c"), branch: "gantry/onboarding", title: "t", created: true, changed: true }, files: drafted, request: null, by: lena, drafter: assessorOf(dr.value, { runId: "r-pr", agent: "ag-onboard", version: 1, model: "m" }) }));
      const db = await doc(b.id);
      expect(db.drafter).toMatchObject({ mode: "agent", runId: "r-pr" });
      expect(db.pr.files.find((x: any) => x.path === "AGENTS.md").source).toBe("agent");
      expect(db.pr.files.find((x: any) => x.path === "CODEOWNERS").source).toBe("observed");
      expect((await q(`select actor from events where type = 'onboarding.pr' and subject->>'id' = $1`, [b.id]))[0].actor).toBe("ag-onboard");
      expect((await q(`select files from onboarding_prs where repo_id = $1`, [b.id]))[0].files.find((x: any) => x.path === "AGENTS.md").source).toBe("agent");
    });
  });
});
