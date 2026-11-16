import { createServer, type Server } from "node:http";
import { withTx } from "@gantry/db";
import { RepoFacts, assess, judgeCanary, judgeOwners, judgeProtections, judgeRunner, judgeGuidelines, planPr, type AssessContext, type PlanContext, type ReadinessResult } from "@gantry/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAssessment, applyMergeRefused, applyMerged, applyPrFailed, applyPrObservation, applyPrOpened, applyVerification, READINESS_STRIKES } from "../src/areas/onboarding/apply.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const lena = "p-lena"; // project_admin on identity: every onboarding right there
const _kenji = "p-kenji"; // release_manager on identity? no: payments, storefront, risk, mobile ...; used for merge on storefront
const rui = "p-rui"; // engineer on identity: onboarding.manage only
const tomas = "p-tomas"; // engineer on payments only
const admin = "p-asha";
const GH = { authorization: "Bearer github-token-for-tests" };
const SHA = (c: string) => c.repeat(40).slice(0, 40);

d("repo onboarding", () => {
  let t: TestApp;
  let broker: Server;
  let brokerBody: unknown = { ok: true, repos: [] };
  let brokerStatus = 200;
  const q = async (sql: string, p: unknown[] = []) => (await t.db.admin.query(sql, p)).rows;
  const events = (type: string) => q(`select * from events where type = $1 order by seq`, [type]);
  const jobs = (kind: string) => q(`select * from jobs where kind = $1 order by created_at`, [kind]);
  let n = 0;

  type M = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  const call = async (who: string, method: M, url: string, payload?: unknown, extra: Record<string, string> = {}) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method, url, headers: { ...s.headers, ...extra }, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: r.statusCode, body: r.json() as Record<string, any>, headers: r.headers };
  };
  const version = async (repoId: string) => String((await q(`select version from repos where org_id = $1 and id = $2`, [t.orgId, repoId]))[0].version);
  const repoDoc = async (id: string) => (await q(`select onboarding_stage, data, version from repos where org_id = $1 and id = $2`, [t.orgId, id]))[0];
  const doc = async (id: string) => (await repoDoc(id)).data.onboarding as Record<string, any>;
  const asWorker = <T>(fn: (tx: import("@gantry/db").Tx) => Promise<T>): Promise<T> => withTx(t.db.app, fn);

  beforeAll(async () => {
    broker = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.statusCode = brokerStatus;
      res.end(JSON.stringify(brokerBody));
      void req;
    });
    await new Promise<void>((r) => broker.listen(0, "127.0.0.1", r));
    const port = (broker.address() as { port: number }).port;
    t = await startApp({ config: { brokerUrl: `http://127.0.0.1:${port}`, secrets: { sessionKey: Buffer.from("test-session-key-0123456789abcdef"), dataKey: null, edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
  });
  afterAll(async () => {
    await t.close();
    await new Promise<void>((r) => broker.close(() => r()));
  });

  /** A repo connected through the API, as a person would. */
  async function connect(name = `acme/ledger-${++n}`, project = "identity", who = lena) {
    const r = await call(who, "POST", `/api/v1/projects/${project}/repos`, { name }, { "idempotency-key": `k-${name}` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { id: r.body.repo.id as string, name, runId: (await doc(r.body.repo.id)).runId as string };
  }

  const facts = (over: Record<string, unknown> = {}) =>
    RepoFacts.parse({
      repo: "acme/ledger", defaultBranch: "main", headSha: SHA("a"), language: "TypeScript", files: ["package.json", "package-lock.json", "src/index.ts"],
      contents: { "package.json": JSON.stringify({ scripts: { test: "vitest run" }, engines: { node: ">=22" } }) }, secrets: { scanned: 3, complete: true, hits: [] }, protection: null, ...over,
    });
  const actx: AssessContext = { guidelines: [{ id: "gl-1", text: "CI", required: true }, { id: "gl-2", text: "test", required: true }], mcp: [], requiredChecks: ["ci/test"] };
  const pctx = (): PlanContext => ({
    project: "identity", repoId: "ledger", org: "acme", team: "platform", defaultBranch: "main", branchPrefix: "gantry/", merge: "squash", requiredChecks: ["ci/test"], protectedPaths: [], mcp: [],
    org_guidelines: { items: actx.guidelines, may: "", mayNot: "", version: 3 }, project_guidelines: { items: [], notes: "", version: 0 },
  });

  /** The worker's assessment, as `onboarding.assess` would apply it. */
  async function assessed(r: { id: string; runId: string }) {
    const f = assess(facts(), actx);
    const out = await asWorker((tx) => applyAssessment(tx, t.orgId, { repoId: r.id, runId: r.runId, now: new Date(), result: { kind: "ok", findings: f, language: "TypeScript", defaultBranch: "main", headSha: SHA("a") } }));
    expect(out.applied, JSON.stringify(out)).toBe(true);
    return f;
  }
  const opened = async (r: { id: string; runId: string }, number = 7, headSha = SHA("b")) => {
    // The command asks for the pull request; the worker then opens it. (After a request for changes the repo is already waiting for the update.)
    if (!["opening_pr", "updating_pr"].includes((await doc(r.id)).busy)) {
      const ask = await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/open-pr`);
      expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    }
    const files = planPr(facts(), assess(facts(), actx), pctx());
    return asWorker((tx) => applyPrOpened(tx, t.orgId, { repoId: r.id, runId: r.runId, now: new Date(), pr: { number, url: `https://github.test/acme/x/pull/${number}`, headSha, branch: "gantry/onboarding", title: "Prepare for Gantry", created: true, changed: true }, files, request: null, by: lena }));
  };
  const green = (r: { id: string }, headSha = SHA("b")) =>
    asWorker((tx) => applyPrObservation(tx, t.orgId, { repoId: r.id, now: new Date(), gateCheckName: "Gantry gates", obs: { state: "open", headSha, checks: [{ name: "ci/test", status: "completed", conclusion: "success" }] } }));
  const okChecks = (): ReadinessResult[] => [
    ...judgeProtections(facts({
      protection: {
        defaultBranch: "main", branchProtection: null, appOnBypassList: false, requiresGantryCheck: true, gantryCheckPinned: true,
        installation: { id: 1, permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write", checks: "write", actions: "read", statuses: "read", administration: "read" }, repositorySelection: "selected", targetType: "Organization" },
        rulesets: [{ id: 1, name: "g", target: "branch", enforcement: "active", ruleTypes: ["pull_request"], requiredChecks: ["ci/test", "Gantry gates"], approvals: 1, codeOwners: true, bypassActors: [] }],
      },
    }), ["ci/test"]),
    judgeOwners(facts({ files: ["CODEOWNERS", ".github/workflows/ci.yml"], contents: { CODEOWNERS: "* @acme/platform\n" } })),
    ...judgeCanary({ published: true, draftOpened: true, closed: true, cleaned: true, checks: [{ name: "ci/test", status: "completed", conclusion: "success", app: null }], directPush: "rejected", directPushDetail: "403", error: null }),
    judgeRunner(facts(), { base: ["node"] }),
    judgeGuidelines([]),
  ];
  const lostChecks = (): ReadinessResult[] => okChecks().map((x) => (x.id === "bypass" ? { ...x, ok: false, detail: "The Gantry App is on a bypass list." } : x));
  const verify = (r: { id: string }, results: ReadinessResult[], trigger: "merge" | "manual" | "schedule" = "manual") =>
    asWorker((tx) => applyVerification(tx, t.orgId, { repoId: r.id, runId: null, trigger, by: lena, now: new Date(), results }));
  /** A repo taken to Ready through the API and the worker's steps. */
  async function ready(name?: string) {
    const r = await connect(name);
    await assessed(r);
    await opened(r);
    await green(r);
    await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/merge`);
    await asWorker((tx) => applyMerged(tx, t.orgId, { repoId: r.id, runId: r.runId, now: new Date(), prNumber: 7, by: lena, mergeSha: SHA("c") }));
    expect((await verify(r, okChecks())).outcome).toBe("ready");
    return r;
  }

  describe("connect", () => {
    it("connects a repo: stage connected, one assessment job, the event, and the legacy repo shape back; a retry with the same key adds nothing", async () => {
      const r = await call(lena, "POST", "/api/v1/projects/identity/repos", { name: "acme/billing-core", team: "platform" }, { "idempotency-key": "connect-1" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ ok: true, repo: { id: "billing-core", name: "acme/billing-core", project: "identity", team: "platform", onboarding: { stage: "connected", busy: "assessing" } } });
      const row = (await q(`select github_full_name, onboarding_stage from repos where org_id = $1 and id = 'billing-core'`, [t.orgId]))[0];
      expect(row).toMatchObject({ github_full_name: "acme/billing-core", onboarding_stage: "connected" });
      const j = (await jobs("onboarding.assess")).find((x) => x.payload.repoId === "billing-core");
      expect(j).toMatchObject({ queue: "github", status: "queued" });
      const ev = (await events("repo.connect")).find((e) => e.subject?.id === "billing-core");
      expect(ev).toMatchObject({ category: "onboarding", outcome: "ok", actor: lena, project_id: "identity" });
      const again = await call(lena, "POST", "/api/v1/projects/identity/repos", { name: "acme/billing-core", team: "platform" }, { "idempotency-key": "connect-1" });
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect((await q(`select count(*)::int as n from repos where org_id = $1 and name = 'acme/billing-core'`, [t.orgId]))[0].n).toBe(1);
      expect((await q(`select count(*)::int as n from onboarding_runs where org_id = $1 and repo_id = 'billing-core'`, [t.orgId]))[0].n).toBe(1);
    });

    it("refuses a repo that is already connected (any spelling), a bad name and an unknown team", async () => {
      expect((await call(lena, "POST", "/api/v1/projects/identity/repos", { name: "ACME/Billing-Core" })).status).toBe(409);
      const bad = await call(lena, "POST", "/api/v1/projects/identity/repos", { name: "billing" });
      expect(bad.status).toBe(422);
      expect(bad.body.msg).toMatch(/org\/name/);
      expect((await call(lena, "POST", "/api/v1/projects/identity/repos", { name: "acme/x1", team: "nope" })).status).toBe(422);
    });

    it("is denied for a person without the right, audited as repo.onboard.denied", async () => {
      const before = (await events("repo.onboard.denied")).length;
      const r = await call(rui, "POST", "/api/v1/projects/identity/repos", { name: "acme/denied-1" });
      expect(r.status).toBe(403);
      expect(r.body.ok).toBe(false);
      expect((await events("repo.onboard.denied")).length).toBe(before + 1);
      expect((await q(`select 1 from repos where org_id = $1 and name = 'acme/denied-1'`, [t.orgId])).length).toBe(0);
    });

    it("does not reveal a project the viewer cannot see, and refuses an archived or killed project", async () => {
      expect((await call(tomas, "POST", "/api/v1/projects/identity/repos", { name: "acme/hidden-1" })).status).toBe(403); // the decision point answers before visibility
      expect((await call(tomas, "GET", "/api/v1/projects/identity/repos")).status).toBe(404);
      await q(`update projects set status = 'archived' where org_id = $1 and id = 'identity'`, [t.orgId]);
      let arch;
      try {
        arch = await call(lena, "POST", "/api/v1/projects/identity/repos", { name: "acme/arch-1" });
      } finally {
        await q(`update projects set status = 'active' where org_id = $1 and id = 'identity'`, [t.orgId]);
      }
      expect(arch.status).toBe(409); // a stopped scope is a 409 with the reason
      expect(arch.body.msg).toMatch(/archived/);
      await q(`insert into stops (org_id, id, scope_type, project_id, mode, reason, set_by) values ($1,'project:identity:k1','project','identity','kill','incident drill','p-asha')`, [t.orgId]);
      const killed = await call(lena, "POST", "/api/v1/projects/identity/repos", { name: "acme/killed-1" });
      expect(killed.status).toBe(409);
      expect(killed.body.msg).toMatch(/incident drill/);
      expect((await events("repo.onboard.denied")).at(-1)).toMatchObject({ outcome: "denied", rule: "STOP-PROJECT" });
      await q(`update stops set lifted_by = 'p-asha', lifted_at = now() where org_id = $1 and id = 'project:identity:k1'`, [t.orgId]);
    });

    it("lists a connected repo with the project's repos", async () => {
      const r = await call(lena, "GET", "/api/v1/projects/identity/repos");
      expect(r.body.find((x: any) => x.id === "billing-core").onboarding.stage).toBe("connected");
    });
  });

  describe("settings", () => {
    it("saves conventions, MCP and routes; needs the repo's version; refuses stale and missing versions; is denied for a viewer", async () => {
      const r = await connect();
      const v = await version(r.id);
      const ok = await call(lena, "PATCH", `/api/v1/repos/${r.id}/config`, { mcp: ["mcp-issues"], triggers: false, config: { merge: "rebase", requiredChecks: ["ci/test", "ci/lint"], protectedPaths: ["infra/**"], defaultBranch: "trunk" }, team: "security" }, { "if-match": v });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const list = (await call(lena, "GET", "/api/v1/projects/identity/repos")).body.find((x: any) => x.id === r.id);
      expect(list).toMatchObject({ team: "security", mcp: ["mcp-issues"], triggers: false, config: { merge: "rebase", requiredChecks: ["ci/test", "ci/lint"], protectedPaths: ["infra/**"], defaultBranch: "trunk" } });
      const ev = (await events("repo.config")).at(-1)!;
      expect(ev.before).toMatchObject({ team: "platform" });
      expect(ev.after).toMatchObject({ team: "security" });
      const stale = await call(lena, "PATCH", `/api/v1/repos/${r.id}/config`, { triggers: true }, { "if-match": v });
      expect(stale.status).toBe(409);
      expect(stale.body.msg).toMatch(/changed|reload/i);
      const none = await call(lena, "PATCH", `/api/v1/repos/${r.id}/config`, { triggers: true });
      expect(none.status).toBe(409);
      expect(none.body.msg).toMatch(/version required/i);
      expect((await call(lena, "PATCH", `/api/v1/repos/${r.id}/config`, { config: { merge: "fast-forward" } }, { "if-match": await version(r.id) })).status).toBe(422);
      const denied = await call("p-sam", "PATCH", `/api/v1/repos/${r.id}/config`, { triggers: true }, { "if-match": await version(r.id) });
      expect([403, 404]).toContain(denied.status);
    });

    it("is denied for someone without onboarding.manage, and audited", async () => {
      const r = await connect();
      const before = (await events("onboarding.manage.denied")).length;
      const x = await call("p-nikhil", "PATCH", `/api/v1/repos/${r.id}/config`, { triggers: true }, { "if-match": await version(r.id) });
      expect([403, 404]).toContain(x.status);
      if (x.status === 403) expect((await events("onboarding.manage.denied")).length).toBe(before + 1);
    });
  });

  describe("the pipeline", () => {
    it("runs connect, assessment, pull request, checks, merge and verification to Ready, with one event per step", async () => {
      const r = await connect();
      const findings = await assessed(r);
      let dd = await doc(r.id);
      expect(dd).toMatchObject({ stage: "assessed", busy: null, adapter: "rule-based", assessor: { mode: "rule-based" } });
      expect(dd.findings).toHaveLength(findings.length);
      expect(dd.findings.find((f: any) => f.id === "ci")).toMatchObject({ ok: false, required: true });
      expect((await q(`select count(*)::int as n from onboarding_findings where org_id = $1 and run_id = $2`, [t.orgId, r.runId]))[0].n).toBe(findings.length);
      expect((await q(`select status from onboarding_runs where org_id = $1 and id = $2`, [t.orgId, r.runId]))[0].status).toBe("succeeded");
      expect((await q(`select data->>'baseSha' as sha from repo_config where org_id = $1 and repo_id = $2`, [t.orgId, r.id]))[0].sha).toBe(SHA("a"));
      expect((await q(`select lang from repos where org_id = $1 and id = $2`, [t.orgId, r.id]))[0].lang).toBe("TypeScript");

      const open = await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/open-pr`);
      expect(open.status, JSON.stringify(open.body)).toBe(200);
      expect((await doc(r.id)).busy).toBe("opening_pr");
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/open-pr`)).status).toBe(409); // already being opened
      expect((await jobs("onboarding.open_pr")).filter((j) => j.payload.repoId === r.id)).toHaveLength(1);
      expect((await opened(r)).applied).toBe(true);
      dd = await doc(r.id);
      expect(dd).toMatchObject({ stage: "pr_opened", busy: null, pr: { number: 7, state: "open", checks: "pending", headSha: SHA("b") } });
      expect(dd.pr.files.map((f: any) => f.path)).toContain("AGENTS.md");
      expect(dd.pr.reviewers).toContain(lena);
      expect((await q(`select state, number from onboarding_prs where org_id = $1 and repo_id = $2`, [t.orgId, r.id]))[0]).toMatchObject({ state: "open", number: 7 });
      // the pull request tab reads the files with their added lines; the repo list carries only the counts
      const pf = await call(lena, "GET", `/api/v1/repos/${r.id}/onboarding/pr`);
      expect(pf.status).toBe(200);
      expect(pf.body).toMatchObject({ number: 7, branch: "gantry/onboarding", state: "open" });
      expect(pf.body.files.find((f: any) => f.path === "AGENTS.md")).toMatchObject({ mode: "create", finding: "agents", added: expect.arrayContaining(["# AGENTS.md"]) });
      expect(dd.pr.files[0].added).toBeUndefined();
      expect((await call(tomas, "GET", `/api/v1/repos/${r.id}/onboarding/pr`)).status).toBe(404);

      // merge before the checks are green is refused, with the reason
      const early = await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/merge`);
      expect(early.status).toBe(409);
      expect(early.body.msg).toMatch(/not green/);
      expect((await green(r)).changed).toBe(true);
      expect(await doc(r.id)).toMatchObject({ stage: "pr_checks", pr: { checks: "green" } });
      expect((await green(r)).changed).toBe(false); // a quiet poll writes nothing

      const merge = await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/merge`);
      expect(merge.status, JSON.stringify(merge.body)).toBe(200);
      const mj = (await jobs("onboarding.merge")).find((j) => j.payload.repoId === r.id)!;
      expect(mj.payload).toMatchObject({ prNumber: 7, headSha: SHA("b"), by: lena });
      expect((await events("onboarding.merge")).at(-1)).toMatchObject({ actor: lena, outcome: "ok" });

      // GitHub refused: the head moved after approval, so the person must approve again on the new commit
      await asWorker((tx) => applyMergeRefused(tx, t.orgId, { repoId: r.id, runId: r.runId, now: new Date(), prNumber: 7, code: "head_moved", msg: "moved", headSha: SHA("d") }));
      expect(await doc(r.id)).toMatchObject({ stage: "pr_opened", busy: null, pr: { checks: "pending", headSha: SHA("d") } });
      await green(r, SHA("d"));
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/merge`)).status).toBe(200);
      await asWorker((tx) => applyMerged(tx, t.orgId, { repoId: r.id, runId: r.runId, now: new Date(), prNumber: 7, by: lena, mergeSha: SHA("e") }));
      dd = await doc(r.id);
      expect(dd).toMatchObject({ stage: "pr_merged", pr: { state: "merged", mergedBy: lena } });
      expect((await jobs("onboarding.verify")).filter((j) => j.payload.repoId === r.id && j.payload.trigger === "merge")).toHaveLength(1);

      const v = await verify(r, okChecks(), "merge");
      expect(v.outcome).toBe("ready");
      dd = await doc(r.id);
      expect(dd).toMatchObject({ stage: "ready", verification: { ok: true, trigger: "merge" } });
      expect(dd.readyAt).toBeGreaterThan(0);
      expect((await repoDoc(r.id)).onboarding_stage).toBe("ready");
      expect((await q(`select ready_at, readiness_state from repos where org_id = $1 and id = $2`, [t.orgId, r.id]))[0]).toMatchObject({ readiness_state: "ok" });
      expect((await q(`select ok from onboarding_verifications where org_id = $1 and repo_id = $2`, [t.orgId, r.id]))[0].ok).toBe(true);
      for (const type of ["onboarding.assess", "onboarding.pr", "onboarding.merged", "onboarding.verify", "onboarding.ready"]) expect((await events(type)).some((e) => e.subject?.id === r.id), type).toBe(true);
      // Ready repos cannot be re-assessed
      const re = await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/assess`);
      expect(re.status).toBe(409);
      expect(re.body.msg).toMatch(/Already ready/);
    });

    it("the merge needs onboarding.merge: an engineer is denied and audited; a stale version is refused", async () => {
      const r = await connect();
      await assessed(r);
      await opened(r);
      await green(r);
      const before = (await events("onboarding.merge.denied")).length;
      const x = await call(rui, "POST", `/api/v1/repos/${r.id}/onboarding/merge`);
      expect(x.status).toBe(403);
      expect((await events("onboarding.merge.denied")).length).toBe(before + 1);
      const stale = await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/merge`, undefined, { "if-match": "1" });
      expect(stale.status).toBe(409);
      expect((await doc(r.id)).busy).toBe(null);
    });

    it("a halted repo refuses the merge with the halt's reason; a kill refuses every onboarding command", async () => {
      const r = await connect();
      await assessed(r);
      await opened(r);
      await green(r);
      await q(`insert into stops (org_id, id, scope_type, project_id, repo_id, mode, reason, set_by) values ($1,$2,'repo','identity',$3,'halt','andon pulled by hand','p-lena')`, [t.orgId, `repo:${r.id}:1`, r.id]);
      const m = await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/merge`);
      expect(m.status).toBe(409);
      expect(m.body.msg).toMatch(/andon pulled by hand/);
      await q(`update stops set lifted_by = 'p-lena', lifted_at = now() where org_id = $1 and id = $2`, [t.orgId, `repo:${r.id}:1`]);
      await q(`insert into stops (org_id, id, scope_type, project_id, mode, reason, set_by) values ($1,$2,'project','identity','kill','drill','p-asha')`, [t.orgId, `project:identity:k${++n}`]);
      for (const [path, body] of [["assess", undefined], ["open-pr", undefined], ["verify", undefined], ["request-changes", { text: "change this please" }], ["exception", { reason: "accepting the gaps for now" }]] as const) {
        const x = await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/${path}`, body);
        expect(x.status, path).toBe(409);
        expect(x.body.msg, path).toMatch(/drill/);
      }
      await q(`update stops set lifted_by = 'p-asha', lifted_at = now() where org_id = $1 and project_id = 'identity' and mode = 'kill' and lifted_at is null`, [t.orgId]);
    });

    it("re-running the assessment starts a new run, keeps an open pull request, and ignores the old run's late result", async () => {
      const r = await connect();
      await assessed(r);
      await opened(r);
      expect((await doc(r.id)).pr).toMatchObject({ number: 7 });
      const re = await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/assess`);
      expect(re.status, JSON.stringify(re.body)).toBe(200);
      let dd = await doc(r.id);
      // the open PR keeps its place in the lifecycle: a re-assessment never regresses the stage
      expect(dd).toMatchObject({ stage: "pr_opened", busy: "assessing", pr: { number: 7, state: "open" } });
      expect(dd.runId).not.toBe(r.runId);
      expect((await q(`select status from onboarding_runs where org_id = $1 and id = $2`, [t.orgId, r.runId]))[0].status).toBe("cancelled");
      const late = await asWorker((tx) => applyAssessment(tx, t.orgId, { repoId: r.id, runId: r.runId, now: new Date(), result: { kind: "failed", msg: "late" } }));
      expect(late).toMatchObject({ applied: false });
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/assess`)).status).toBe(409); // the assessment is already running
      dd = await doc(r.id);
      const ok = await asWorker((tx) => applyAssessment(tx, t.orgId, { repoId: r.id, runId: dd.runId, now: new Date(), result: { kind: "ok", findings: assess(facts(), actx), language: "TypeScript", defaultBranch: "main", headSha: SHA("a") } }));
      expect(ok.applied).toBe(true);
      expect(await doc(r.id)).toMatchObject({ stage: "pr_opened", prNeedsUpdate: true });
    });

    it("an app that is not installed needs a person; a failure fails the repo; both can be retried with a new assessment", async () => {
      const r = await connect();
      await asWorker((tx) => applyAssessment(tx, t.orgId, { repoId: r.id, runId: r.runId, now: new Date(), result: { kind: "blocked", code: "not_installed", msg: "The Gantry GitHub App is not installed on acme/x." } }));
      expect(await doc(r.id)).toMatchObject({ stage: "person", busy: null, blocker: expect.stringMatching(/not installed/) });
      expect((await q(`select status from onboarding_runs where org_id = $1 and id = $2`, [t.orgId, r.runId]))[0].status).toBe("needs_person");
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/open-pr`)).status).toBe(409);
      const re = await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/assess`);
      expect(re.status).toBe(200);
      const run2 = (await doc(r.id)).runId;
      await asWorker((tx) => applyAssessment(tx, t.orgId, { repoId: r.id, runId: run2, now: new Date(), result: { kind: "failed", msg: "GitHub is down" } }));
      expect(await doc(r.id)).toMatchObject({ stage: "failed", blocker: "GitHub is down" });
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/assess`)).status).toBe(200);
    });

    it("a pull request that cannot be opened goes back to assessed when there is nothing to add, and fails the repo for anything else", async () => {
      const r = await connect();
      await assessed(r);
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/open-pr`)).status).toBe(200);
      await asWorker((tx) => applyPrFailed(tx, t.orgId, { repoId: r.id, runId: r.runId, now: new Date(), code: "nothing_to_add", msg: "every file is there" }));
      expect(await doc(r.id)).toMatchObject({ stage: "assessed", busy: null });
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/open-pr`)).status).toBe(200);
      await asWorker((tx) => applyPrFailed(tx, t.orgId, { repoId: r.id, runId: r.runId, now: new Date(), code: "github", msg: "GitHub refused" }));
      expect(await doc(r.id)).toMatchObject({ stage: "failed", blocker: "GitHub refused" });
    });

    it("a fully compliant repo has nothing for a pull request to add and goes straight to verification", async () => {
      const r = await connect();
      const f = facts({ files: ["package.json", "package-lock.json", "AGENTS.md", "CODEOWNERS", ".gantry/factory.yml", ".github/workflows/ci.yml", ".eslintrc.json", ".nvmrc"], contents: { "AGENTS.md": "# a", CODEOWNERS: "* @acme/platform\n", ".gantry/factory.yml": "repo: acme/x\nmcp: []\n", "package.json": JSON.stringify({ scripts: { test: "vitest" } }) } });
      await asWorker((tx) => applyAssessment(tx, t.orgId, { repoId: r.id, runId: r.runId, now: new Date(), result: { kind: "ok", findings: assess(f, { ...actx, guidelines: [] }), language: "TypeScript", defaultBranch: "main", headSha: SHA("a") } }));
      const open = await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/open-pr`);
      expect(open.status).toBe(409);
      expect(open.body.msg).toMatch(/Nothing to add/);
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/verify`)).status).toBe(200);
      expect((await doc(r.id)).busy).toBe("verifying");
    });

    it("request changes needs 5 characters and an open PR; verify before the merge is refused with the reason", async () => {
      const r = await connect();
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/request-changes`, { text: "no" })).status).toBe(422);
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/request-changes`, { text: "keep owners small" })).body.msg).toMatch(/assessment is running/);
      await assessed(r);
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/request-changes`, { text: "keep owners small" })).body.msg).toMatch(/No onboarding PR/);
      await opened(r);
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/verify`)).body.msg).toMatch(/after the onboarding PR is merged/);
      const ok = await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/request-changes`, { text: "Keep CODEOWNERS to /internal only" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(await doc(r.id)).toMatchObject({ stage: "pr_opened", busy: "updating_pr", pr: { checks: "pending" } });
      expect((await jobs("onboarding.open_pr")).filter((j) => j.payload.repoId === r.id).at(-1)!.payload).toMatchObject({ request: "Keep CODEOWNERS to /internal only" });
      const upd = await opened(r);
      expect(upd.applied).toBe(true);
      expect((await doc(r.id)).timeline.at(-1).text).toMatch(/Pushed an update to PR #7/);
    });

    it("a pull request merged or closed on GitHub moves the repo on", async () => {
      const merged = await connect();
      await assessed(merged); await opened(merged);
      await asWorker((tx) => applyPrObservation(tx, t.orgId, { repoId: merged.id, now: new Date(), gateCheckName: "Gantry gates", obs: { state: "merged", headSha: SHA("b"), mergedBy: "octocat", checks: [] } }));
      expect(await doc(merged.id)).toMatchObject({ stage: "pr_merged", pr: { state: "merged", mergedBy: "github:octocat" } });
      expect((await jobs("onboarding.verify")).some((j) => j.payload.repoId === merged.id)).toBe(true);
      const closed = await connect();
      await assessed(closed); await opened(closed);
      await asWorker((tx) => applyPrObservation(tx, t.orgId, { repoId: closed.id, now: new Date(), gateCheckName: "Gantry gates", obs: { state: "closed", headSha: SHA("b"), checks: [] } }));
      expect(await doc(closed.id)).toMatchObject({ stage: "assessed", pr: null });
    });
  });

  describe("exception", () => {
    it("needs a reason of 10 characters and onboarding.exception; marks the repo ready, audited with before and after", async () => {
      const r = await connect();
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/exception`, { reason: "short" })).status).toBe(422);
      const before = (await events("onboarding.exception.denied")).length;
      expect((await call(rui, "POST", `/api/v1/repos/${r.id}/onboarding/exception`, { reason: "we accept this for now" })).status).toBe(403);
      expect((await events("onboarding.exception.denied")).length).toBe(before + 1);
      const ok = await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/exception`, { reason: "Pilot repo, owner accepts the gaps" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(await doc(r.id)).toMatchObject({ stage: "ready", exception: { by: lena, reason: "Pilot repo, owner accepts the gaps" } });
      const ev = (await events("onboarding.exception")).find((e) => e.subject?.id === r.id)!;
      expect(ev.before).toMatchObject({ stage: "connected" });
      expect(ev.after).toMatchObject({ stage: "ready", exception: true });
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/exception`, { reason: "again, for good measure" })).status).toBe(409);
      // a late job of the old run does nothing to a repo that was accepted
      const late = await asWorker((tx) => applyAssessment(tx, t.orgId, { repoId: r.id, runId: r.runId, now: new Date(), result: { kind: "failed", msg: "late" } }));
      expect(late.applied).toBe(false);
      expect((await doc(r.id)).stage).toBe("ready");
    });
  });

  describe("readiness", () => {
    it(`losing readiness halts the repo with cause readiness after ${READINESS_STRIKES} failed scheduled checks, and regaining it lifts the halt`, async () => {
      const r = await ready();
      const stop = () => q(`select * from stops where org_id = $1 and repo_id = $2 order by set_at`, [t.orgId, r.id]);
      expect(await stop()).toHaveLength(0);

      // One odd read does not halt a repo.
      expect((await verify(r, lostChecks(), "schedule")).outcome).toBe("strike");
      expect((await repoDoc(r.id)).onboarding_stage).toBe("ready");
      expect(await stop()).toHaveLength(0);
      // A pass clears the strike.
      expect((await verify(r, okChecks(), "schedule")).outcome).toBe("held");
      expect((await verify(r, lostChecks(), "schedule")).outcome).toBe("strike");
      // Checks that could not be made never count.
      const unknown = okChecks().map((x) => (x.id === "ruleset" ? { ...x, ok: false, unknown: true, detail: "GitHub did not answer" } : x));
      expect((await verify(r, unknown, "schedule")).outcome).toBe("unknown");
      expect(await stop()).toHaveLength(0);
      expect((await q(`select readiness_failures, readiness_state from repos where org_id = $1 and id = $2`, [t.orgId, r.id]))[0]).toMatchObject({ readiness_failures: 1, readiness_state: "unknown" });

      expect((await verify(r, lostChecks(), "schedule")).outcome).toBe("lost");
      const rows = await stop();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ scope_type: "repo", mode: "halt", cause: "readiness", set_by: "system", lifted_at: null, project_id: "identity" });
      expect(rows[0].reason).toMatch(/Readiness lost.*bypass list/);
      expect(await doc(r.id)).toMatchObject({ stage: "person", blocker: expect.stringMatching(/Readiness lost/) });
      expect((await repoDoc(r.id)).onboarding_stage).toBe("person");
      expect((await jobs("stop.enforce")).some((j) => j.payload.stopId === rows[0].id)).toBe(true);
      expect((await events("onboarding.readiness.lost")).find((e) => e.subject?.id === r.id)).toMatchObject({ outcome: "regression", category: "onboarding" });
      expect((await events("halt")).find((e) => e.after?.stop === rows[0].id)).toMatchObject({ category: "kill", actor: "system" });
      // The Floor and the project read see it as a repo halt.
      const list = (await call(lena, "GET", "/api/v1/projects/identity/repos")).body.find((x: any) => x.id === r.id);
      expect(list.halted).toMatchObject({ by: "system" });
      expect(list.halted.reason).toMatch(/Readiness lost/);
      // No work order can be submitted to a repo that is not Ready.
      expect((await repoDoc(r.id)).onboarding_stage).not.toBe("ready");

      // The person fixes GitHub and verifies again: the onboarding command is allowed under a readiness halt (only the merge is refused under a halt).
      const again = await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/verify`);
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect((await verify(r, okChecks(), "manual")).outcome).toBe("ready");
      const after = (await stop())[0];
      expect(after).toMatchObject({ lifted_by: "system" });
      expect(after.lifted_at).not.toBeNull();
      expect(await doc(r.id)).toMatchObject({ stage: "ready" });
      expect((await events("resume")).find((e) => e.before?.stop === rows[0].id)).toMatchObject({ category: "kill" });
    });

    it("a scheduled re-check that skips the canary keeps the canary's last result, marked with when it was made", async () => {
      const r = await ready();
      await verify(r, okChecks().filter((x) => !["canary", "canary_ci", "direct_push"].includes(x.id)), "schedule");
      const v = (await doc(r.id)).verification;
      expect(v).toMatchObject({ trigger: "schedule", ok: true });
      expect(v.checks.map((c: any) => c.id)).toEqual(["installation", "ruleset", "gantry_check", "bypass", "codeowners", "canary", "canary_ci", "direct_push", "runner", "guidelines"]);
      expect(v.checks.find((c: any) => c.id === "canary")).toMatchObject({ ok: true, at: expect.any(Number) });
      expect(v.checks.find((c: any) => c.id === "installation").at).toBeUndefined();
    });

    it("a person's own verification that finds a loss halts at once; a broker outage never halts; a repo ready by exception is left alone", async () => {
      const r = await ready();
      expect((await verify(r, okChecks().map((x) => ({ ...x, ok: false, unknown: true, detail: "broker down" })), "schedule")).outcome).toBe("unknown");
      expect((await q(`select count(*)::int as n from stops where org_id = $1 and repo_id = $2`, [t.orgId, r.id]))[0].n).toBe(0);
      expect((await verify(r, lostChecks(), "manual")).outcome).toBe("lost");
      expect((await q(`select cause from stops where org_id = $1 and repo_id = $2 and lifted_at is null`, [t.orgId, r.id]))[0].cause).toBe("readiness");
      // An exception accepts the gaps: it lifts the readiness halt too, and later checks skip the repo.
      expect((await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/exception`, { reason: "Owner accepts the missing ruleset" })).status).toBe(200);
      expect((await q(`select lifted_by from stops where org_id = $1 and repo_id = $2`, [t.orgId, r.id]))[0].lifted_by).toBe(lena);
      const skip = await verify(r, lostChecks(), "schedule");
      expect(skip.applied).toBe(false);
    });

    it("a repo that was already halted by a person keeps their halt: readiness loss does not add a second one", async () => {
      const r = await ready();
      await q(`insert into stops (org_id, id, scope_type, project_id, repo_id, mode, reason, set_by) values ($1,$2,'repo','identity',$3,'halt','hand halt','p-lena')`, [t.orgId, `repo:${r.id}:90`, r.id]);
      expect((await verify(r, lostChecks(), "manual")).outcome).toBe("lost");
      expect((await q(`select count(*)::int as n from stops where org_id = $1 and repo_id = $2 and lifted_at is null`, [t.orgId, r.id]))[0].n).toBe(1);
      await q(`update stops set lifted_by = 'p-lena', lifted_at = now() where org_id = $1 and repo_id = $2`, [t.orgId, r.id]);
    });
  });

  describe("Ready gates work orders", () => {
    const submit = (repo: string) => call(rui, "POST", "/api/v1/projects/identity/work-orders", { repo, title: "Add idempotency keys to refund requests", description: "Refunds can be retried by clients; the API should accept an Idempotency-Key header." });

    it("a repo that is not Ready takes no work order; Ready takes one; losing readiness takes none again, with the reason", async () => {
      const r = await connect();
      const before = await submit(r.id);
      expect(before.status).toBe(422); // the submit guard refuses with the reason
      expect(before.body.msg).toMatch(/not ready|Connected|onboarding/i);
      await assessed(r); await opened(r); await green(r);
      await call(lena, "POST", `/api/v1/repos/${r.id}/onboarding/merge`);
      await asWorker((tx) => applyMerged(tx, t.orgId, { repoId: r.id, runId: r.runId, now: new Date(), prNumber: 7, by: lena, mergeSha: SHA("c") }));
      expect((await verify(r, okChecks())).outcome).toBe("ready");
      const ok = await submit(r.id);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await verify(r, lostChecks(), "manual")).outcome).toBe("lost");
      const after = await submit(r.id);
      expect([409, 422]).toContain(after.status);
      expect(after.body.msg).toMatch(/Readiness lost|halted|not ready/i);
    });
  });

  describe("project status", () => {
    it("moves a new project to onboarding when it gets its first repo, and to active when every repo is Ready", async () => {
      const p = await call(admin, "POST", "/api/v1/projects", { name: "Onboard Status", templateId: "tpl-backend", teams: ["payments"] }, { "idempotency-key": "p-onb-status" });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      const pid = p.body.project?.id ?? p.body.id;
      expect((await q(`select status from projects where org_id = $1 and id = $2`, [t.orgId, pid]))[0].status).toBe("new");
      const r = await call(admin, "POST", `/api/v1/projects/${pid}/repos`, { name: "acme/status-one" }, { "idempotency-key": "k-status-1" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await q(`select status from projects where org_id = $1 and id = $2`, [t.orgId, pid]))[0].status).toBe("onboarding");
      const ex = await call(admin, "POST", `/api/v1/repos/${r.body.repo.id}/onboarding/exception`, { reason: "Everything accepted for the test" });
      expect(ex.status, JSON.stringify(ex.body)).toBe(200);
      expect((await q(`select status from projects where org_id = $1 and id = $2`, [t.orgId, pid]))[0].status).toBe("active");
    });
  });

  describe("guidelines", () => {
    it("reads the seeded factory guidelines with their history and publishes the next version, audited", async () => {
      const g = await call(lena, "GET", "/api/v1/guidelines");
      expect(g.status).toBe(200);
      expect(g.body).toMatchObject({ version: 3, items: expect.any(Array), history: [{ v: 1 }, { v: 2 }, { v: 3 }] });
      const items = [...g.body.items, { id: "gl-n1", text: "Pin GitHub Actions by SHA.", required: false }];
      const ok = await call(admin, "PUT", "/api/v1/guidelines", { patch: { items }, note: "Pin actions" }, { "if-match": "3" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.msg).toBe("Guidelines saved as v4.");
      const after = (await call(lena, "GET", "/api/v1/guidelines")).body;
      expect(after).toMatchObject({ version: 4, by: admin, may: g.body.may });
      expect(after.items.at(-1).id).toBe("gl-n1");
      expect(after.history.at(-1)).toMatchObject({ v: 4, by: admin, note: "Pin actions" });
      expect((await q(`select version from guideline_versions where org_id = $1 and scope = 'org' order by version`, [t.orgId])).map((x) => x.version)).toEqual([1, 2, 3, 4]);
      const ev = (await events("guidelines.edit")).at(-1)!;
      expect(ev).toMatchObject({ category: "onboarding", outcome: "ok", actor: admin });
      expect(ev.before.version).toBe(3);
      expect(ev.after.version).toBe(4);
    });

    it("refuses a stale or missing version, an empty or unchanged patch, a missing note and a person without agent.edit", async () => {
      const cur = (await call(lena, "GET", "/api/v1/guidelines")).body;
      const stale = await call(admin, "PUT", "/api/v1/guidelines", { patch: { may: "x" }, note: "stale try" }, { "if-match": "1" });
      expect(stale.status).toBe(409);
      expect(stale.body.msg).toMatch(/changed|reload/i);
      expect((await call(admin, "PUT", "/api/v1/guidelines", { patch: { may: "x" }, note: "no version" })).body.msg).toMatch(/version required/i);
      expect((await call(admin, "PUT", "/api/v1/guidelines", { patch: {}, note: "empty" }, { "if-match": String(cur.version) })).status).toBe(422);
      expect((await call(admin, "PUT", "/api/v1/guidelines", { patch: { may: cur.may }, note: "same" }, { "if-match": String(cur.version) })).status).toBe(409);
      expect((await call(admin, "PUT", "/api/v1/guidelines", { patch: { may: "x" }, note: "ab" }, { "if-match": String(cur.version) })).status).toBe(422);
      expect((await call(admin, "PUT", "/api/v1/guidelines", { patch: { items: [{ id: "a", text: "x", required: true }, { id: "a", text: "y", required: true }] }, note: "dup ids" }, { "if-match": String(cur.version) })).status).toBe(422);
      const before = (await events("agent.edit.denied")).length;
      const denied = await call(lena, "PUT", "/api/v1/guidelines", { patch: { may: "x" }, note: "not allowed" }, { "if-match": String(cur.version) });
      expect(denied.status).toBe(403);
      expect((await events("agent.edit.denied")).length).toBe(before + 1);
    });

    it("saves a project's additions as versions shown on the project, for those with onboarding.guidelines; stale and denied cases", async () => {
      const none = (await call(lena, "GET", "/api/v1/projects/identity")).body;
      expect(none.guidelines).toBeUndefined();
      const ok = await call(lena, "PUT", "/api/v1/projects/identity/guidelines", { patch: { items: [{ id: "pg-1", text: "Auth changes need a threat note.", required: true }], notes: "Identity is regulated by SOC 2." }, note: "First rules" }, { "if-match": "0" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.msg).toMatch(/v1\./);
      const p = (await call(lena, "GET", "/api/v1/projects/identity")).body;
      expect(p.guidelines).toMatchObject({ version: 1, notes: "Identity is regulated by SOC 2.", items: [{ id: "pg-1" }], history: [{ v: 1, by: lena, note: "First rules" }] });
      expect((await call(lena, "PUT", "/api/v1/projects/identity/guidelines", { patch: { notes: "later" }, note: "stale" }, { "if-match": "0" })).status).toBe(409);
      const before = (await events("onboarding.guidelines.denied")).length;
      expect((await call(rui, "PUT", "/api/v1/projects/identity/guidelines", { patch: { notes: "x" }, note: "engineer try" }, { "if-match": "1" })).status).toBe(403);
      expect((await events("onboarding.guidelines.denied")).length).toBe(before + 1);
      // the seeded project's guidelines come through with their history
      const risk = (await call("p-nikhil", "GET", "/api/v1/projects/risk")).body;
      expect(risk.guidelines).toMatchObject({ version: expect.any(Number), items: expect.any(Array), history: expect.any(Array) });
    });
  });

  describe("connect wizard source list", () => {
    it("lists what the GitHub App can see minus what is connected; says why when GitHub cannot be asked; is denied without the right", async () => {
      brokerBody = { ok: true, repos: [{ repo: "acme/billing-core", language: "Go", archived: false }, { repo: "acme/new-service", language: "Go", archived: false }, { repo: "acme/old", language: "Java", archived: true }] };
      const r = await call(lena, "GET", "/api/v1/projects/identity/repos/available");
      expect(r.status).toBe(200);
      expect(r.body.available).toEqual([{ repo: "acme/new-service", lang: "Go" }]);
      brokerStatus = 502; brokerBody = { ok: false, msg: "GitHub would not issue a token" };
      const down = await call(lena, "GET", "/api/v1/projects/identity/repos/available");
      expect(down.body).toMatchObject({ available: null, unavailable: "GitHub would not issue a token" });
      brokerStatus = 200; brokerBody = { ok: true, repos: [] };
      expect((await call(rui, "GET", "/api/v1/projects/identity/repos/available")).status).toBe(403);
    });
  });

  describe("fence for the GitHub broker", () => {
    const fence = (repo: string, purpose: string, headers: Record<string, string> = GH) => t.app.inject({ method: "POST", url: "/internal/v1/onboarding/fence", headers, payload: { repo, purpose } });

    it("only the GitHub service token may ask", async () => {
      expect((await fence("acme/billing-core", "write", { authorization: "Bearer edge-token-for-tests" })).statusCode).toBe(403);
      expect((await fence("acme/billing-core", "write", {})).statusCode).toBe(401);
    });

    it("allows a connected repo, refuses an unknown one, and audits both", async () => {
      const ok = (await fence("acme/billing-core", "write")).json();
      expect(ok).toMatchObject({ ok: true, allow: true, repoId: "billing-core", projectId: "identity" });
      const unknown = (await fence("acme/not-here", "write")).json();
      expect(unknown).toMatchObject({ allow: false, code: "unknown" });
      expect((await events("github.fence.denied")).some((e) => e.after?.repo === "acme/not-here")).toBe(true);
    });

    it("a kill refuses everything, a halt refuses only the merge, and a readiness halt refuses nothing", async () => {
      const r = await connect();
      const insert = (id: string, scope: string, mode: string, cause = "manual") =>
        q(`insert into stops (org_id, id, scope_type, project_id, repo_id, mode, reason, cause, set_by) values ($1,$2,$3,'identity',$4,$5,'because',$6,'p-asha')`, [t.orgId, id, scope, scope === "repo" ? r.id : null, mode, cause]);
      const lift = () => q(`update stops set lifted_by = 'x', lifted_at = now() where org_id = $1 and lifted_at is null and project_id = 'identity'`, [t.orgId]);
      await insert(`repo:${r.id}:h1`, "repo", "halt");
      expect((await fence(r.name, "write")).json().allow).toBe(true);
      expect((await fence(r.name, "canary")).json().allow).toBe(true);
      expect((await fence(r.name, "merge")).json()).toMatchObject({ allow: false, code: "stopped", reason: expect.stringMatching(/Halted at repo scope: because/) });
      await lift();
      await insert(`repo:${r.id}:h2`, "repo", "halt", "readiness");
      for (const p of ["write", "merge", "canary"]) expect((await fence(r.name, p)).json().allow, p).toBe(true);
      await lift();
      await insert(`project:identity:kk${++n}`, "project", "kill");
      for (const p of ["write", "merge", "canary"]) expect((await fence(r.name, p)).json(), p).toMatchObject({ allow: false, code: "stopped", reason: expect.stringMatching(/Killed at project scope/) });
      await lift();
      expect((await fence(r.name, "write")).json().allow).toBe(true);
    });
  });
});
