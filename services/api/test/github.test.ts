import { randomBytes } from "node:crypto";
import { encrypt, withTx } from "@gantry/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processGithubDelivery } from "../src/areas/github/deliveries.js";
import { signGithubBody } from "../src/areas/github/signature.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const DATA_KEY = randomBytes(32);
const GH = { authorization: "Bearer github-token-for-tests" };
const EDGE = { authorization: "Bearer edge-token-for-tests" };
const HOOK_SECRET = "whsec-test-secret";
const REPO = "acme/payments-api";
const S = (c: string) => c.repeat(40).slice(0, 40);

d("github broker internal API and hooks", () => {
  let t: TestApp;
  let n = 0;
  let repoId = "";
  let project = "";
  const q = async (sql: string, p: unknown[] = []) => (await t.db.admin.query(sql, p)).rows;
  const events = (type: string) => q(`select * from events where type = $1 order by seq`, [type]);
  const post = (url: string, payload: unknown, headers: Record<string, string> = GH) => t.app.inject({ method: "POST", url, headers, payload: payload as object });

  beforeAll(async () => {
    t = await startApp({ config: { secrets: { sessionKey: Buffer.from("test-session-key-0123456789abcdef"), dataKey: DATA_KEY, edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
    const r = (await q(`select id, project_id from repos where org_id = $1 order by id limit 1`, [t.orgId]))[0];
    repoId = r.id;
    project = r.project_id;
    await q(`update repos set github_full_name = $3 where org_id = $1 and id = $2`, [t.orgId, repoId, REPO]);
    await q(`insert into integration_types (org_id, id, name, builtin) values ($1,'github','GitHub',true) on conflict do nothing`, [t.orgId]);
    await q(`insert into integration_instances (org_id, id, type_id, name, secret_enc) values ($1,'gh-1','github','GitHub',$2)`, [t.orgId, encrypt(HOOK_SECRET, DATA_KEY, "integration:gh-1")]);
  });
  afterAll(() => t.close());

  async function makeAttempt(o: { state?: string } = {}) {
    const i = ++n;
    const woId = `WO-gh-${i}`;
    const attemptId = `at-gh-${i}`;
    await q(`insert into work_orders (org_id, id, project_id, repo_id, title, class, position, state, flow_version) values ($1,$2,$3,$4,'GH test','feature','build','running',1)`, [t.orgId, woId, project, repoId]);
    const a = await q(`insert into attempts (org_id, id, wo_id, station, visit, state) values ($1,$2,$3,'build',1,$4) returning fencing::text as fencing`, [t.orgId, attemptId, woId, o.state ?? "running"]);
    return { woId, attemptId, fencing: a[0].fencing as string };
  }
  const fence = (id: string, body: object, h: Record<string, string> = GH) => post(`/internal/v1/attempts/${id}/fence-check`, body, h);

  describe("fence-check", () => {
    it("allows the current attempt, refuses a superseded fencing number, and audits both", async () => {
      const a = await makeAttempt();
      const ok = await fence(a.attemptId, { fencing: a.fencing, repo: REPO });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ ok: true, allow: true, woId: a.woId, repo: REPO, branch: `gantry/${a.woId}` });
      const stale = await fence(a.attemptId, { fencing: Number(a.fencing) + 1000 });
      expect(stale.json()).toMatchObject({ allow: false, code: "superseded" });
      expect((await events("github.fence.passed")).some((e) => e.subject.id === a.attemptId)).toBe(true);
      const den = (await events("github.fence.denied")).filter((e) => e.subject.id === a.attemptId);
      expect(den[0]).toMatchObject({ outcome: "denied", wo_id: a.woId });
    });
    it("refuses a superseded or cancelled attempt even with the right number", async () => {
      const a = await makeAttempt({ state: "superseded" });
      expect((await fence(a.attemptId, { fencing: a.fencing })).json()).toMatchObject({ allow: false, code: "superseded" });
      const b = await makeAttempt({ state: "succeeded" });
      expect((await fence(b.attemptId, { fencing: b.fencing })).json().allow).toBe(true);
    });
    it("refuses in a stopped scope but still allows the restrictive writes a stop needs", async () => {
      const a = await makeAttempt();
      await q(`insert into stops (org_id, id, scope_type, wo_id, mode, reason, set_by) values ($1,$2,'wo',$3,'halt','test','p-asha')`, [t.orgId, `wo:${a.woId}:gh`, a.woId]);
      expect((await fence(a.attemptId, { fencing: a.fencing })).json()).toMatchObject({ allow: false, code: "stopped" });
      expect((await post(`/internal/v1/work-orders/${a.woId}/fence-check`, { purpose: "merge" })).json()).toMatchObject({ allow: false, code: "stopped" });
      expect((await post(`/internal/v1/work-orders/${a.woId}/fence-check`, { purpose: "check_pass" })).json().allow).toBe(false);
      expect((await post(`/internal/v1/work-orders/${a.woId}/fence-check`, { purpose: "check_fail" })).json().allow).toBe(true);
      expect((await post(`/internal/v1/work-orders/${a.woId}/fence-check`, { purpose: "draft" })).json().allow).toBe(true);
      // Spec 4.4 step 2: once lifted, the stop's higher fencing number still supersedes the attempt that was running under it.
      await q(`update stops set lifted_at = now(), lifted_by = 'p-asha' where id = $1`, [`wo:${a.woId}:gh`]);
      expect((await fence(a.attemptId, { fencing: a.fencing })).json()).toMatchObject({ allow: false, code: "superseded" });
      // An attempt that started after the stop publishes normally.
      const b = await makeAttempt();
      expect((await fence(b.attemptId, { fencing: b.fencing })).json().allow).toBe(true);
    });
    it("refuses a repo that is not the work order's, unknown attempts, wrong callers and bad bodies", async () => {
      const a = await makeAttempt();
      expect((await fence(a.attemptId, { fencing: a.fencing, repo: "acme/other" })).json()).toMatchObject({ allow: false, code: "repo_mismatch" });
      expect((await fence("at-nope", { fencing: 1 })).json()).toMatchObject({ allow: false, code: "unknown" });
      expect((await fence(a.attemptId, { fencing: a.fencing }, EDGE)).statusCode).toBe(403);
      expect((await fence(a.attemptId, { fencing: a.fencing }, {})).statusCode).toBe(401);
      expect((await fence(a.attemptId, { fencing: "x" })).statusCode).toBe(422);
    });
  });

  describe("github/events", () => {
    const pr = (o: object = {}) => ({ number: 7, title: "Add thing", state: "open", draft: false, headSha: S("a"), baseBranch: "main", headBranch: "gantry/X", labels: [], ...o });

    it("stores published commits with files and patches once, links the work order and audits", async () => {
      const a = await makeAttempt();
      const body = {
        source: "publish", repo: REPO,
        pullRequests: [pr({ number: 11, headBranch: `gantry/${a.woId}`, headSha: S("b") })],
        publish: { attemptId: a.attemptId, woId: a.woId, branch: `gantry/${a.woId}`, prNumber: 11, commits: [{ sha: S("b"), localSha: S("c"), parents: [S("0")], message: "Add thing\n\nGantry-Work-Order: x", files: [{ path: "src/a.ts", status: "added", additions: 3, deletions: 0 }], patch: "diff --git a/src/a.ts b/src/a.ts\n+x\n" }] },
      };
      const r = await post("/internal/v1/github/events", body);
      expect(r.statusCode).toBe(200);
      expect(r.json().counts).toMatchObject({ commits: 1, pullRequests: 1 });
      const c = (await q(`select * from commits where sha = $1`, [S("b")]))[0];
      expect(c).toMatchObject({ wo_id: a.woId, local_sha: S("c"), repo_id: repoId });
      expect((await q(`select path, additions from changed_files where commit_id = $1`, [c.id]))).toEqual([{ path: "src/a.ts", additions: 3 }]);
      const p = (await q(`select content_hash from patches where commit_id = $1`, [c.id]))[0];
      expect((await q(`select convert_from(content, 'UTF8') as t from github_blobs where hash = $1`, [p.content_hash]))[0].t).toContain("+x");
      expect((await q(`select wo_id, head_sha from pull_requests where number = 11`))[0]).toMatchObject({ wo_id: a.woId, head_sha: S("b") });
      expect((await events("github.commit.published")).length).toBeGreaterThan(0);
      // Idempotent: the same publish again changes nothing.
      const again = await post("/internal/v1/github/events", body);
      expect(again.json().counts).toMatchObject({ commits: 0, pullRequests: 0 });
      expect((await q(`select count(*)::int as n from commits where sha = $1`, [S("b")]))[0].n).toBe(1);
    });

    it("records the default branch tip as the repository's base commit, quietly", async () => {
      const before = (await q(`select count(*)::int as n from events`))[0].n;
      const base = { source: "poll", repo: REPO, base: { branch: "main", sha: S("9") } };
      expect((await post("/internal/v1/github/events", base)).statusCode).toBe(200);
      const cfg = () => q(`select data from repo_config where org_id = $1 and repo_id = $2`, [t.orgId, repoId]);
      expect((await cfg())[0].data).toMatchObject({ baseSha: S("9"), baseBranch: "main" });
      await post("/internal/v1/github/events", { ...base, base: { branch: "main", sha: S("8") } });
      expect((await cfg())[0].data).toMatchObject({ baseSha: S("8") });
      expect((await q(`select count(*)::int as n from events`))[0].n).toBe(before);
      expect((await post("/internal/v1/github/events", { ...base, base: { branch: "main", sha: "nothex" } })).statusCode).toBe(422);
    });

    it("records a head commit that Gantry did not publish as drift", async () => {
      const a = await makeAttempt();
      const base = { source: "poll", repo: REPO };
      await post("/internal/v1/github/events", { ...base, pullRequests: [pr({ number: 21, headBranch: `gantry/${a.woId}`, headSha: S("d") })] });
      const r = await post("/internal/v1/github/events", { ...base, pullRequests: [pr({ number: 21, headBranch: `gantry/${a.woId}`, headSha: S("e") })] });
      expect(r.json().counts.drift).toBe(1);
      const ev = (await events("github.drift")).find((e) => e.wo_id === a.woId);
      expect(ev?.after).toMatchObject({ kind: "head_changed_outside_gantry", headSha: S("e") });
    });

    it("records a merge nobody asked for as drift, and closes a requested merge", async () => {
      const a = await makeAttempt();
      const base = { source: "poll", repo: REPO };
      await post("/internal/v1/github/events", { ...base, pullRequests: [pr({ number: 31, headBranch: `gantry/${a.woId}`, headSha: S("1") })] });
      const merged = (o: object = {}) => ({ ...base, pullRequests: [pr({ number: 31, headBranch: `gantry/${a.woId}`, headSha: S("1"), state: "merged", mergeCommitSha: S("2"), ...o })] });
      const r = await post("/internal/v1/github/events", merged());
      expect(r.json().counts.drift).toBe(1);
      expect((await events("github.drift")).some((e) => e.after.kind === "merged_without_request" && e.after.number === 31)).toBe(true);
    });

    it("closes a requested merge when GitHub reports the pull request merged", async () => {
      const a = await makeAttempt();
      await q(`update work_orders set position = 'close', state = 'waiting', data = jsonb_build_object('merging', jsonb_build_object('prNumber', 61, 'headSha', $3::text)) where org_id = $1 and id = $2`, [t.orgId, a.woId, S("4")]);
      const base = { source: "poll", repo: REPO };
      await post("/internal/v1/github/events", { ...base, pullRequests: [pr({ number: 61, headBranch: `gantry/${a.woId}`, headSha: S("4") })] });
      const r = await post("/internal/v1/github/events", { ...base, pullRequests: [pr({ number: 61, headBranch: `gantry/${a.woId}`, headSha: S("4"), state: "merged", mergeCommitSha: S("5") })] });
      expect(r.json()).toMatchObject({ merged: [61], counts: { drift: 0 } });
      expect((await q(`select data->'merging' as m from work_orders where id = $1`, [a.woId]))[0].m).toBeNull();
      expect((await events("wo.merged")).some((e) => e.wo_id === a.woId)).toBe(true);
    });

    it("stores checks and reviews, and only reports changes", async () => {
      const a = await makeAttempt();
      const base = { source: "poll", repo: REPO };
      await post("/internal/v1/github/events", { ...base, pullRequests: [pr({ number: 41, headBranch: `gantry/${a.woId}`, headSha: S("3") })] });
      const facts = { ...base, checks: [{ headSha: S("3"), name: "ci / test", status: "completed", conclusion: "success", githubId: 5 }], reviews: [{ prNumber: 41, githubId: 9, reviewer: "octocat", state: "approved", submittedAt: "2026-01-01T00:00:00Z" }] };
      const r1 = await post("/internal/v1/github/events", facts);
      expect(r1.json().counts).toMatchObject({ checks: 1, reviews: 1 });
      const r2 = await post("/internal/v1/github/events", facts);
      expect(r2.json().counts).toMatchObject({ checks: 0, reviews: 0 });
      const r3 = await post("/internal/v1/github/events", { ...facts, checks: [{ ...facts.checks[0], conclusion: "failure" }] });
      expect(r3.json().counts.checks).toBe(1);
      expect((await q(`select conclusion from checks where head_sha = $1`, [S("3")]))[0].conclusion).toBe("failure");
    });

    it("remembers a labelled issue once, refuses unknown repos, wrong callers and malformed facts", async () => {
      const f = { source: "poll", repo: REPO, issues: [{ number: 5, title: "Do it", labels: ["gantry"] }] };
      expect((await post("/internal/v1/github/events", f)).json().counts.issues).toBe(1);
      expect((await post("/internal/v1/github/events", f)).json().counts.issues).toBe(0);
      expect((await post("/internal/v1/github/events", { source: "poll", repo: "nobody/nothing" })).statusCode).toBe(404);
      expect((await post("/internal/v1/github/events", f, EDGE)).statusCode).toBe(403);
      expect((await post("/internal/v1/github/events", { source: "poll", repo: "bad repo" })).statusCode).toBe(422);
      expect((await post("/internal/v1/github/events", { source: "poll", repo: REPO, pullRequests: [{ number: 0 }] })).statusCode).toBe(422);
    });

    it("lists the repos the broker polls", async () => {
      const r = await t.app.inject({ method: "GET", url: "/internal/v1/github/repos", headers: GH });
      expect(r.json().repos).toContainEqual(expect.objectContaining({ id: repoId, repo: REPO, branchPrefix: "gantry/" }));
    });
  });

  describe("/hooks/github", () => {
    const hook = (body: object, o: { delivery?: string; event?: string; secret?: string; sig?: string | null } = {}) => {
      const raw = JSON.stringify(body);
      const headers: Record<string, string> = { "content-type": "application/json", "x-github-delivery": o.delivery ?? `d-${randomBytes(6).toString("hex")}`, "x-github-event": o.event ?? "pull_request" };
      if (o.sig !== null) headers["x-hub-signature-256"] = o.sig ?? signGithubBody(raw, o.secret ?? HOOK_SECRET);
      return t.app.inject({ method: "POST", url: "/hooks/github", headers, payload: raw });
    };
    const payload = (num: number, branch: string, sha = S("7")) => ({ action: "opened", repository: { full_name: REPO }, pull_request: { number: num, id: 900 + num, title: "From hook", state: "open", draft: false, head: { sha, ref: branch }, base: { ref: "main" }, html_url: "https://github.example/x", labels: [], user: { login: "app" } } });

    it("accepts a signed delivery, stores it and enqueues github.event; then processes it into a pull request", async () => {
      const a = await makeAttempt();
      const delivery = "delivery-aaaa-1";
      const r = await hook(payload(51, `gantry/${a.woId}`), { delivery });
      expect(r.statusCode).toBe(202);
      expect(r.json()).toMatchObject({ ok: true, duplicate: false });
      const job = (await q(`select queue, payload from jobs where kind = 'github.event' and payload->>'deliveryId' = $1`, [delivery]))[0];
      expect(job).toMatchObject({ queue: "github", payload: { deliveryId: delivery } });
      expect((await q(`select status, event_type from inbound_deliveries where delivery_id = $1`, [delivery]))[0]).toMatchObject({ status: "received", event_type: "pull_request" });
      const out = await withTx(t.db.app, (tx) => processGithubDelivery(tx, t.orgId, delivery));
      expect(out).toMatchObject({ status: "processed" });
      expect((await q(`select wo_id, title from pull_requests where number = 51`))[0]).toMatchObject({ wo_id: a.woId, title: "From hook" });
      expect((await q(`select status from inbound_deliveries where delivery_id = $1`, [delivery]))[0].status).toBe("processed");
      expect(await withTx(t.db.app, (tx) => processGithubDelivery(tx, t.orgId, delivery))).toMatchObject({ status: "ignored" });
    });
    it("replays are acknowledged and never processed twice", async () => {
      const delivery = "delivery-bbbb-2";
      expect((await hook(payload(52, "feature/x"), { delivery })).json().duplicate).toBe(false);
      const again = await hook(payload(52, "feature/x"), { delivery });
      expect(again.statusCode).toBe(202);
      expect(again.json().duplicate).toBe(true);
      expect((await q(`select count(*)::int as n from jobs where kind = 'github.event' and payload->>'deliveryId' = $1`, [delivery]))[0].n).toBe(1);
      // The same signed body under a fresh delivery id (the id is not signed) is a replay too: acknowledged, audited, not stored or processed.
      const forged = await hook(payload(52, "feature/x"), { delivery: "delivery-bbbb-forged" });
      expect(forged.statusCode).toBe(202);
      expect(forged.json().duplicate).toBe(true);
      expect(await q(`select 1 from inbound_deliveries where delivery_id = 'delivery-bbbb-forged'`)).toHaveLength(0);
      expect((await events("github.hook.denied")).at(-1)).toMatchObject({ outcome: "denied", rule: "HOOK-REPLAY" });
    });
    it("refuses a wrong or missing signature and audits the denial", async () => {
      const before = (await events("github.hook.denied")).length;
      expect((await hook(payload(53, "x"), { secret: "wrong" })).statusCode).toBe(401);
      expect((await hook(payload(53, "x"), { sig: null })).statusCode).toBe(401);
      expect((await hook(payload(53, "x"), { sig: "sha256=zz" })).statusCode).toBe(401);
      const denied = await events("github.hook.denied");
      expect(denied.length).toBe(before + 3);
      expect(denied.at(-1)).toMatchObject({ outcome: "denied", channel: "github" });
      expect((await q(`select count(*)::int as n from pull_requests where number = 53`))[0].n).toBe(0);
    });
    it("rejects a malformed delivery and ignores events it does not store", async () => {
      const raw = "not json";
      const res = await t.app.inject({ method: "POST", url: "/hooks/github", headers: { "content-type": "application/json", "x-github-delivery": "delivery-cccc-3", "x-github-event": "push", "x-hub-signature-256": signGithubBody(raw, HOOK_SECRET) }, payload: raw });
      expect(res.statusCode).toBe(400);
      expect((await hook({ zen: "hi" }, { delivery: "delivery-dddd-4", event: "ping" })).statusCode).toBe(202);
      expect(await withTx(t.db.app, (tx) => processGithubDelivery(tx, t.orgId, "delivery-dddd-4"))).toMatchObject({ status: "ignored" });
      expect(await withTx(t.db.app, (tx) => processGithubDelivery(tx, t.orgId, "never-seen"))).toEqual({ status: "missing" });
    });
  });
});
