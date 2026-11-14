import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_URL } from "./db.js";
import { startWorld, type World } from "./world.js";

const d = TEST_URL ? describe : describe.skip;
const SHA = (c: string) => c.repeat(40).slice(0, 40);

/** What the broker's inspect answers for a repo that has everything. */
const goodFacts = (over: Record<string, unknown> = {}) => ({
  defaultBranch: "main", headSha: SHA("a"), archived: false, language: "TypeScript", languages: { TypeScript: 100 }, truncated: false,
  files: ["package.json", "package-lock.json", "AGENTS.md", "CODEOWNERS", ".gantry/factory.yml", ".github/workflows/ci.yml", ".eslintrc.json", ".nvmrc", "src/index.ts"],
  contents: { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "AGENTS.md": "# AGENTS.md\n", CODEOWNERS: "* @acme/platform\n", ".gantry/factory.yml": "repo: acme/x\nmcp: []\n" },
  secrets: { scanned: 5, complete: true, hits: [] },
  protection: {
    defaultBranch: "main", branchProtection: null, appOnBypassList: false, requiresGantryCheck: true, gantryCheckPinned: true,
    installation: { id: 1, permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write", checks: "write", actions: "read", statuses: "read", administration: "read" }, repositorySelection: "selected", targetType: "Organization" },
    rulesets: [{ id: 1, name: "gantry", target: "branch", enforcement: "active", ruleTypes: ["pull_request", "required_status_checks"], requiredChecks: ["ci/test", "Gantry gates"], approvals: 1, codeOwners: true, bypassActors: [] }],
  },
  ...over,
});
/** A bare repo: no CI, no owners, no agents file, no rules. */
const bareFacts = () => goodFacts({ files: ["package.json", "package-lock.json", "src/index.ts"], contents: { "package.json": JSON.stringify({ scripts: { test: "vitest run" }, engines: { node: ">=22" } }) }, protection: null });

d("onboarding jobs (spec 11.3)", () => {
  let w: World;
  let n = 0;
  beforeEach(async () => { w = await startWorld(); });
  afterEach(async () => { await w.close(); });

  const doc = async (id: string) => (await w.q(`select data->'onboarding' as d, onboarding_stage as stage, readiness_state, readiness_failures from repos where org_id = $1 and id = $2`, [w.orgId, id]))[0];

  /** A repo connected through GitHub, as the API's connect command leaves it. */
  async function repo(over: { stage?: string; busy?: string | null; pr?: unknown; exception?: unknown; github?: boolean; mcp?: string[] } = {}) {
    const id = `onb-w-${++n}`;
    const runId = `onb-${id}-1`;
    const stage = over.stage ?? "connected";
    const onboarding = { stage, findings: [], pr: over.pr ?? null, timeline: [], exception: over.exception ?? null, startedAt: Date.now(), busy: over.busy === undefined ? "assessing" : over.busy, runId };
    await w.q(
      `insert into repos (org_id, id, project_id, team_id, name, github_full_name, lang, onboarding_stage, data) values ($1,$2,'identity','platform',$3,$4,'',$5,$6::jsonb)`,
      [w.orgId, id, `acme/${id}`, over.github === false ? null : `acme/${id}`, stage, JSON.stringify({ mcp: over.mcp ?? [], triggers: true, onboarding })],
    );
    await w.q(`insert into repo_config (org_id, repo_id, required_checks) values ($1,$2,'{ci/test}')`, [w.orgId, id]);
    await w.q(`insert into onboarding_runs (org_id, id, repo_id, status) values ($1,$2,$3,'running')`, [w.orgId, runId, id]);
    return { id, runId, full: `acme/${id}` };
  }

  describe("assess", () => {
    it("reads the repo through the broker and records findings from its real facts, the adapter, the base commit and the language", async () => {
      const r = await repo();
      w.broker.inspectFacts = bareFacts();
      await w.enqueue("onboarding.assess", { repoId: r.id, runId: r.runId });
      await w.drain();
      const call = w.broker.calls.find((c) => c.op === "inspect")!;
      expect(call.body).toEqual({ repo: r.full });
      const x = await doc(r.id);
      expect(x.stage).toBe("assessed");
      expect(x.d).toMatchObject({ busy: null, adapter: "stub" });
      const byId = Object.fromEntries(x.d.findings.map((f: any) => [f.id, f]));
      expect(byId.ci).toMatchObject({ ok: false, file: ".github/workflows/gantry-ci.yml", required: true });
      expect(byId.test).toMatchObject({ ok: true, detail: "npm test (package.json scripts.test)" });
      expect(byId.protect).toMatchObject({ ok: false, manual: true });
      expect(byId.agents).toMatchObject({ ok: false, file: "AGENTS.md" });
      expect((await w.q(`select count(*)::int as n from onboarding_findings where org_id = $1 and run_id = $2`, [w.orgId, r.runId]))[0].n).toBe(x.d.findings.length);
      expect((await w.q(`select data->>'baseSha' as sha, default_branch from repo_config where org_id = $1 and repo_id = $2`, [w.orgId, r.id]))[0]).toEqual({ sha: SHA("a"), default_branch: "main" });
      expect((await w.q(`select lang from repos where org_id = $1 and id = $2`, [w.orgId, r.id]))[0].lang).toBe("TypeScript");
      expect((await w.q(`select type, actor, channel from events where type = 'onboarding.assess' and subject->>'id' = $1`, [r.id]))[0]).toMatchObject({ actor: "ag-onboard", channel: "system" });
    });

    it("an app that is not installed is a blocker for a person, not a failure to retry", async () => {
      const r = await repo();
      w.broker.inspectResponse = { status: 404, body: { ok: false, code: "not_installed", msg: `The Gantry GitHub App is not installed on ${r.full}.` } };
      await w.enqueue("onboarding.assess", { repoId: r.id, runId: r.runId });
      await w.drain();
      const x = await doc(r.id);
      expect(x.stage).toBe("person");
      expect(x.d.blocker).toMatch(/not installed/);
      expect((await w.jobs("onboarding.assess"))[0]).toMatchObject({ status: "done", attempts: 1 });
      expect((await w.q(`select status from onboarding_runs where id = $1`, [r.runId]))[0].status).toBe("needs_person");
    });

    it("an archived repo needs a person; a malformed answer fails permanently", async () => {
      const r = await repo();
      w.broker.inspectFacts = goodFacts({ archived: true });
      await w.enqueue("onboarding.assess", { repoId: r.id, runId: r.runId });
      await w.drain();
      expect((await doc(r.id)).d.blocker).toMatch(/archived/);
    });

    it("a broker that keeps failing is retried, and on the last attempt the failure is recorded on the repo instead of thrown", async () => {
      const r = await repo();
      w.broker.inspectResponse = { status: 502, body: { ok: false, msg: "GitHub is down" } };
      await w.enqueue("onboarding.assess", { repoId: r.id, runId: r.runId }, { maxAttempts: 2 });
      await w.drain(2);
      expect(w.broker.calls.filter((c) => c.op === "inspect")).toHaveLength(2);
      const x = (await doc(r.id))!;
      expect(x.stage).toBe("failed");
      expect(x.d.blocker).toMatch(/502/);
      expect((await w.jobs("onboarding.assess"))[0]!.status).toBe("done");
    });

    it("a job of an old run, or for a repo that is not waiting, does nothing and does not call GitHub", async () => {
      const r = await repo();
      await w.enqueue("onboarding.assess", { repoId: r.id, runId: "onb-old-run" });
      const idle = await repo({ busy: null, stage: "assessed" });
      await w.enqueue("onboarding.assess", { repoId: idle.id, runId: idle.runId });
      await w.drain();
      expect(w.broker.calls.filter((c) => c.op === "inspect")).toHaveLength(0);
      expect((await w.jobs("onboarding.assess")).map((j) => j.result?.skipped).every(Boolean)).toBe(true);
      expect((await doc(r.id)).stage).toBe("connected");
    });
  });

  describe("open_pr", () => {
    it("plans from the repo as it is now and asks the broker for one pull request with the files, never application code", async () => {
      const r = await repo({ stage: "assessed", busy: "opening_pr", mcp: ["mcp-issues"] });
      w.broker.inspectFacts = bareFacts();
      await w.enqueue("onboarding.open_pr", { repoId: r.id, runId: r.runId, by: "p-lena" });
      await w.drain();
      const inspect = w.broker.calls.find((c) => c.op === "inspect")!;
      expect(inspect.body).toEqual({ repo: r.full, scan: false });
      const pr = w.broker.calls.find((c) => c.op === "onboarding-pr")!.body!;
      expect(pr).toMatchObject({ repo: r.full, branch: "gantry/onboarding", title: `Prepare ${r.full} for Gantry` });
      const paths = pr.files.map((f: any) => f.path).sort();
      expect(paths).toEqual([".gantry/factory.yml", ".github/workflows/gantry-ci.yml", ".tool-versions", "AGENTS.md", "CODEOWNERS"]);
      expect(pr.files.find((f: any) => f.path === "AGENTS.md").content).toContain("Run `npm test` before opening a PR.");
      expect(pr.files.find((f: any) => f.path === ".gantry/factory.yml").content).toContain("  - mcp-issues");
      expect(pr.files.find((f: any) => f.path === "CODEOWNERS").content).toContain("* @acme/platform");
      expect(pr.body).toContain("Assessment adapter: stub.");
      expect(pr.comment).toBeUndefined();
      const x = await doc(r.id);
      expect(x.stage).toBe("pr_opened");
      expect(x.d).toMatchObject({ busy: null, pr: { number: 12, state: "open", checks: "pending", headSha: SHA("d"), url: "http://gh/pull/12" } });
      expect(x.d.pr.files.map((f: any) => f.path).sort()).toEqual(paths);
      expect((await w.q(`select number, state from onboarding_prs where repo_id = $1`, [r.id]))[0]).toEqual({ number: 12, state: "open" });
    });

    it("a change request is passed on as a comment, and the files are replanned", async () => {
      const r = await repo({ stage: "pr_opened", busy: "updating_pr", pr: { number: 12, title: "t", branch: "gantry/onboarding", files: [], checks: "pending", state: "open", reviewers: [], mergedBy: null } });
      w.broker.inspectFacts = bareFacts();
      await w.enqueue("onboarding.open_pr", { repoId: r.id, runId: r.runId, by: "p-lena", request: "Keep CODEOWNERS to /internal only" });
      await w.drain();
      const pr = w.broker.calls.find((c) => c.op === "onboarding-pr")!.body!;
      expect(pr.comment).toContain("Keep CODEOWNERS to /internal only");
      expect(pr.comment).toContain("p-lena");
      expect((await doc(r.id)).d.timeline.at(-1).text).toMatch(/update to PR #12 for the requested change/);
    });

    it("nothing to add puts the repo back at assessed; a refusal from the stop fence is recorded, not retried", async () => {
      const a = await repo({ stage: "assessed", busy: "opening_pr" });
      w.broker.inspectFacts = goodFacts();
      await w.enqueue("onboarding.open_pr", { repoId: a.id, runId: a.runId, by: null });
      await w.drain();
      expect((await doc(a.id)).stage).toBe("assessed");
      expect((await doc(a.id)).d.timeline.at(-1).text).toMatch(/Nothing to add/);
      expect(w.broker.calls.some((c) => c.op === "onboarding-pr")).toBe(false);
      const b = await repo({ stage: "assessed", busy: "opening_pr" });
      w.broker.inspectFacts = bareFacts();
      w.broker.onboardingPrResponse = { status: 409, body: { ok: false, code: "fenced", msg: "Killed at project scope: drill" } };
      await w.enqueue("onboarding.open_pr", { repoId: b.id, runId: b.runId, by: null });
      await w.drain();
      expect((await doc(b.id)).stage).toBe("assessed");
      expect((await doc(b.id)).d.timeline.at(-1).text).toMatch(/not opened: Killed at project scope/);
      expect(w.broker.calls.filter((c) => c.op === "onboarding-pr")).toHaveLength(1);
    });

    it("a token the App cannot get (no workflows permission) fails the repo with GitHub's reason", async () => {
      const r = await repo({ stage: "assessed", busy: "opening_pr" });
      w.broker.inspectFacts = bareFacts();
      w.broker.onboardingPrResponse = { status: 502, body: { ok: false, code: "token", msg: "GitHub would not issue a onboard_pr_workflows token (422): workflows" } };
      await w.enqueue("onboarding.open_pr", { repoId: r.id, runId: r.runId, by: null }, { maxAttempts: 1 });
      await w.drain();
      expect((await doc(r.id)).stage).toBe("failed");
      expect((await doc(r.id)).d.blocker).toMatch(/workflows/);
    });
  });

  describe("sync and merge", () => {
    const openPr = { number: 12, title: "t", branch: "gantry/onboarding", files: [], checks: "pending", state: "open", reviewers: [], mergedBy: null, headSha: SHA("d") };

    it("follows the pull request's checks, and a merge asked for goes to GitHub at the approved commit", async () => {
      const r = await repo({ stage: "pr_opened", busy: null, pr: openPr });
      w.broker.prs.set(12, { number: 12, state: "open", head: SHA("d"), draft: false, mergeSha: null, checks: [{ name: "ci/test", status: "in_progress", conclusion: null }] });
      await w.enqueue("onboarding.sync", { repoId: r.id });
      await w.drain();
      expect((await doc(r.id)).d.pr.checks).toBe("running");
      expect((await doc(r.id)).stage).toBe("pr_checks");
      w.broker.prs.get(12)!.checks = [{ name: "ci/test", status: "completed", conclusion: "success" }, { name: "Gantry gates", status: "in_progress", conclusion: null }];
      await w.enqueue("onboarding.sync", { repoId: r.id }, { dedupeKey: "again" });
      await w.drain();
      expect((await doc(r.id)).d.pr.checks).toBe("green");

      await w.q(`update repos set data = jsonb_set(data, '{onboarding,busy}', '"merging"') where org_id = $1 and id = $2`, [w.orgId, r.id]);
      await w.enqueue("onboarding.merge", { repoId: r.id, runId: r.runId, prNumber: 12, headSha: SHA("d"), by: "p-kenji" });
      await w.drain();
      expect(w.broker.calls.find((c) => c.op === "onboarding-merge")!.body).toMatchObject({ repo: r.full, number: 12, headSha: SHA("d"), method: "squash" });
      const x = await doc(r.id);
      expect(x.stage).toBe("pr_merged");
      expect(x.d.pr).toMatchObject({ state: "merged", mergedBy: "p-kenji" });
      expect((await w.jobs("onboarding.verify")).some((j) => j.payload.repoId === r.id && j.payload.trigger === "merge")).toBe(true);
    });

    it("GitHub refusing the merge is recorded: a moved head reopens the checks, a rules refusal waits for the person", async () => {
      const moved = await repo({ stage: "pr_checks", busy: "merging", pr: { ...openPr, checks: "green" } });
      w.broker.onboardingMergeResponse = { status: 409, body: { ok: false, code: "head_moved", msg: "head moved", headSha: SHA("f") } };
      await w.enqueue("onboarding.merge", { repoId: moved.id, runId: moved.runId, prNumber: 12, headSha: SHA("d"), by: "p-kenji" });
      await w.drain();
      expect(await doc(moved.id)).toMatchObject({ stage: "pr_opened", d: { busy: null, pr: { checks: "pending", headSha: SHA("f") } } });
      const rules = await repo({ stage: "pr_checks", busy: "merging", pr: { ...openPr, checks: "green" } });
      w.broker.onboardingMergeResponse = { status: 409, body: { ok: false, code: "not_mergeable", msg: "GitHub refuses the merge: 1 approving review is required" } };
      await w.enqueue("onboarding.merge", { repoId: rules.id, runId: rules.runId, prNumber: 12, headSha: SHA("d"), by: "p-kenji" });
      await w.drain();
      const x = await doc(rules.id);
      expect(x.stage).toBe("pr_checks");
      expect(x.d.busy).toBe(null);
      expect(x.d.timeline.at(-1).text).toMatch(/1 approving review is required/);
    });

    it("a merge seen on GitHub (someone merged it there) moves the repo on and starts verification", async () => {
      const r = await repo({ stage: "pr_checks", busy: null, pr: { ...openPr, checks: "green" } });
      w.broker.prs.set(12, { number: 12, state: "merged", head: SHA("d"), draft: false, mergeSha: SHA("c"), checks: [] });
      await w.enqueue("onboarding.sync", { repoId: r.id });
      await w.drain();
      expect(await doc(r.id)).toMatchObject({ stage: "pr_merged" });
      expect((await w.jobs("onboarding.verify")).filter((j) => j.payload.repoId === r.id)).toHaveLength(1);
    });
  });

  describe("verify and readiness", () => {
    const verify = async (id: string, trigger: "merge" | "manual" | "schedule", by: string | null = null) => {
      await w.enqueue("onboarding.verify", { repoId: id, runId: null, trigger, by }, { dedupeKey: `v-${id}-${trigger}-${++n}` });
      await w.drain();
    };
    const mergedPr = { number: 12, title: "t", branch: "gantry/onboarding", files: [], checks: "green", state: "merged", reviewers: [], mergedBy: "p-kenji" };

    it("after the merge: every live check passes, the canary runs, and the repo becomes Ready", async () => {
      const r = await repo({ stage: "pr_merged", busy: "verifying", pr: mergedPr });
      w.broker.inspectFacts = goodFacts();
      await verify(r.id, "merge", "p-lena");
      const x = await doc(r.id);
      expect(x.stage).toBe("ready");
      expect(x.d.verification).toMatchObject({ ok: true, trigger: "merge", unknown: false });
      expect(x.d.verification.checks.map((c: any) => c.id)).toEqual(["installation", "ruleset", "gantry_check", "bypass", "codeowners", "canary", "canary_ci", "direct_push", "runner", "guidelines"]);
      expect(w.broker.calls.filter((c) => c.op === "canary")).toHaveLength(1);
      expect(w.broker.calls.find((c) => c.op === "canary")!.body).toMatchObject({ repo: r.full, prefix: "gantry/" });
      expect((await w.q(`select data->>'canaryAt' as at from repo_config where repo_id = $1`, [r.id]))[0].at).toBeTruthy();
      expect(x.readiness_state).toBe("ok");
    });

    it("without the branch rules in place the canary is not tried (a direct push would prove nothing) and the repo goes to a person", async () => {
      const r = await repo({ stage: "pr_merged", busy: "verifying", pr: mergedPr });
      w.broker.inspectFacts = goodFacts({ protection: { ...goodFacts().protection, rulesets: [] } });
      await verify(r.id, "manual", "p-lena");
      expect(w.broker.calls.some((c) => c.op === "canary")).toBe(false);
      const x = await doc(r.id);
      expect(x.stage).toBe("person");
      expect(x.d.blocker).toMatch(/No active ruleset/);
      expect(x.d.verification.checks.find((c: any) => c.id === "direct_push")).toMatchObject({ unknown: true });
    });

    it("an accepted direct push or a silent CI is a definite failure", async () => {
      const r = await repo({ stage: "pr_merged", busy: "verifying", pr: mergedPr });
      w.broker.inspectFacts = goodFacts();
      w.broker.canaryResponse = { status: 200, body: { ok: true, published: true, draftOpened: true, prNumber: 3, closed: true, cleaned: true, checks: [], directPush: "accepted", directPushDetail: "GitHub accepted a direct push to main.", error: null } };
      await verify(r.id, "manual", "p-lena");
      const x = await doc(r.id);
      expect(x.stage).toBe("person");
      expect(x.d.blocker).toMatch(/accepted a direct push/);
      expect(x.d.blocker).toMatch(/no check on the canary/);
    });

    it("a scheduled re-check is read-only (no canary within a day), strikes twice, then halts the repo with cause readiness", async () => {
      const r = await repo({ stage: "ready", busy: null, pr: mergedPr });
      await w.q(`update repo_config set data = data || jsonb_build_object('canaryAt', now()::text) where repo_id = $1`, [r.id]);
      w.broker.inspectFacts = goodFacts({ protection: { ...goodFacts().protection, appOnBypassList: true } });
      await verify(r.id, "schedule");
      expect(w.broker.calls.some((c) => c.op === "canary")).toBe(false);
      expect(w.broker.calls.find((c) => c.op === "inspect")!.body).toEqual({ repo: r.full, scan: false });
      expect((await doc(r.id)).stage).toBe("ready");
      expect((await doc(r.id)).readiness_failures).toBe(1);
      expect((await w.q(`select count(*)::int as n from stops where repo_id = $1`, [r.id]))[0].n).toBe(0);
      await verify(r.id, "schedule");
      const x = await doc(r.id);
      expect(x.stage).toBe("person");
      expect(x.d.blocker).toMatch(/Readiness lost.*bypass list/);
      const stop = (await w.q(`select * from stops where repo_id = $1`, [r.id]))[0];
      expect(stop).toMatchObject({ scope_type: "repo", mode: "halt", cause: "readiness", set_by: "system", lifted_at: null });
      // The worker enforces it like any halt.
      expect((await w.jobs("stop.enforce")).some((j) => j.payload.stopId === stop.id && j.status === "done")).toBe(true);
      // A pass lifts it when the person has fixed GitHub.
      w.broker.inspectFacts = goodFacts();
      await verify(r.id, "manual", "p-lena");
      expect((await doc(r.id)).stage).toBe("ready");
      expect((await w.q(`select lifted_by from stops where id = $1`, [stop.id]))[0].lifted_by).toBe("system");
    });

    it("a broker that does not answer is not a loss of readiness, whatever the number of attempts", async () => {
      const r = await repo({ stage: "ready", busy: null, pr: mergedPr });
      w.broker.inspectResponse = { status: 502, body: { ok: false, msg: "GitHub is down" } };
      for (let i = 0; i < 4; i++) {
        await w.enqueue("onboarding.verify", { repoId: r.id, runId: null, trigger: "schedule", by: null }, { dedupeKey: `outage-${i}`, maxAttempts: 1 });
        await w.drain();
      }
      const x = await doc(r.id);
      expect(x.stage).toBe("ready");
      expect(x.readiness_state).toBe("unknown");
      expect((await w.q(`select count(*)::int as n from stops where repo_id = $1`, [r.id]))[0].n).toBe(0);
    });

    it("the App removed from the repo is a definite loss (installation), halting at a person's own verification", async () => {
      const r = await repo({ stage: "ready", busy: null, pr: mergedPr });
      w.broker.inspectResponse = { status: 404, body: { ok: false, code: "not_installed", msg: `The Gantry GitHub App is not installed on ${r.full}.` } };
      await verify(r.id, "manual", "p-lena");
      expect((await doc(r.id)).stage).toBe("person");
      expect((await w.q(`select cause from stops where repo_id = $1`, [r.id]))[0].cause).toBe("readiness");
    });

    it("a repo ready by exception is never re-checked", async () => {
      const r = await repo({ stage: "ready", busy: null, exception: { by: "p-lena", at: Date.now(), reason: "accepted" } });
      w.broker.inspectFacts = goodFacts({ protection: null });
      await verify(r.id, "schedule");
      expect(w.broker.calls.some((c) => c.op === "inspect")).toBe(false);
      expect((await doc(r.id)).stage).toBe("ready");
    });

    it("the required guidelines count: a missing test command stops Ready even when every live check passes", async () => {
      const r = await repo({ stage: "pr_merged", busy: "verifying", pr: mergedPr });
      w.broker.inspectFacts = goodFacts({ contents: { "package.json": JSON.stringify({ scripts: {} }), "AGENTS.md": "# a", CODEOWNERS: "* @acme/platform\n", ".gantry/factory.yml": "repo: x\n" } });
      await verify(r.id, "manual", "p-lena");
      const x = await doc(r.id);
      expect(x.stage).toBe("person");
      expect(x.d.blocker).toMatch(/Test command/);
    });

    it("the runner check uses the configured toolchains: a Go repo with only the base variant fails it", async () => {
      const r = await repo({ stage: "pr_merged", busy: "verifying", pr: mergedPr });
      w.broker.inspectFacts = goodFacts({ files: ["go.mod", "go.sum", "AGENTS.md", "CODEOWNERS", ".gantry/factory.yml", ".github/workflows/ci.yml", ".golangci.yml"], contents: { "go.mod": "module x\n\ngo 1.22\n", "AGENTS.md": "# a", CODEOWNERS: "* @acme/platform\n", ".gantry/factory.yml": "repo: x\n" }, language: "Go" });
      await verify(r.id, "manual", "p-lena");
      expect((await doc(r.id)).d.blocker).toMatch(/No runner variant carries go/);
    });
  });

  describe("scheduling", () => {
    it("enqueues a sync for repos with a GitHub identity in a stage that needs one, and for no demo repo", async () => {
      const pr = await repo({ stage: "pr_opened", busy: null });
      const ready = await repo({ stage: "ready", busy: null });
      const idle = await repo({ stage: "assessed", busy: null });
      const demo = await repo({ stage: "ready", busy: null, github: false });
      await w.worker.scheduler.tick();
      const synced = (await w.jobs("onboarding.sync")).map((j) => j.payload.repoId).sort();
      expect(synced).toEqual([pr.id, ready.id].sort());
      expect(synced).not.toContain(idle.id);
      expect(synced).not.toContain(demo.id);
      // seeded demo repos (no github_full_name) are never re-checked
      expect((await w.q(`select count(*)::int as n from jobs where kind = 'onboarding.sync' and payload->>'repoId' = 'payments-api'`))[0].n).toBe(0);
    });

    it("sync of a Ready repo asks for a scheduled verification once per interval", async () => {
      const r = await repo({ stage: "ready", busy: null });
      await w.enqueue("onboarding.sync", { repoId: r.id }, { dedupeKey: "s1" });
      await w.enqueue("onboarding.sync", { repoId: r.id }, { dedupeKey: "s2" });
      w.broker.inspectFacts = goodFacts();
      await w.drain();
      expect((await w.jobs("onboarding.verify")).filter((j) => j.payload.repoId === r.id && j.payload.trigger === "schedule")).toHaveLength(1);
    });
  });
});
