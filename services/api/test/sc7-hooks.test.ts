import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processGithubDelivery, factsFromWebhook } from "../src/areas/github/deliveries.js";
import { createHash } from "node:crypto";
import { applyFacts } from "../src/areas/github/store.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const REPO = "acme/payments-api";

d("sc7 github deliveries out of order, and app removal", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp(); });
  afterAll(() => t.close());
  const w = world(() => t);
  const order = async () => ((await w.call("p-asha", "GET", "/api/v1/catalog")).body.stations as Array<{ id: string }>).map((s) => s.id);
  const atG5 = async (title: string) => {
    const sub = await w.submit("p-tomas", { title });
    const id = sub.body.id as string;
    await w.answerAll(id);
    expect((await w.confirm(id)).status).toBe(200);
    const o = await order();
    await w.walk(id, (x) => o[x.station] === "review" && x.state === "waiting" && x.allowed.approve?.gate === "G5");
    return id;
  };
  const approveG5 = async (id: string) => {
    for (const who of w.APPROVERS) {
      const r = await w.call(who, "POST", await w.gateUrl(id, "G5"), {});
      if (r.status === 200 && r.body.passed) return r;
    }
    throw new Error("G5 not passed");
  };
  /** What a `pull_request` webhook delivery becomes (the same mapping the job uses), applied in its own transaction. */
  const deliver = async (pr: { number: number; head: string; state?: string; merged?: boolean; at: string }) => {
    const payload = { action: "synchronize", repository: { full_name: REPO }, pull_request: { number: pr.number, id: 9000 + pr.number, title: "x", state: pr.state ?? "open", draft: false, merged: pr.merged === true, merged_at: pr.merged ? new Date().toISOString() : null, merge_commit_sha: pr.merged ? "f".repeat(40) : null, updated_at: pr.at, head: { sha: pr.head, ref: "feature/x" }, base: { ref: "main" }, html_url: "https://example.test/pr", labels: [], user: { login: "gantry" } } };
    const m = factsFromWebhook("pull_request", payload);
    if ("ignore" in m) throw new Error(m.ignore);
    return w.tx((tx) => applyFacts(tx, t.orgId, m.facts));
  };
  const H1 = "1".repeat(40); const H2 = "2".repeat(40);

  it("H1: a late delivery for an older head cancels the approval of the newer head and sets the pull request back", async () => {
    const id = await atG5("Late older head");
    await t.db.admin.query(`update repos set github_full_name = $2 where org_id = $1 and id = 'payments-api'`, [t.orgId, REPO]);
    await t.db.admin.query(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, state, head_sha) values ($1,'pr-payments-api-820','payments-api',$2,820,'x','open',$3)`, [t.orgId, id, H1]);
    await deliver({ number: 820, head: H2, at: "2026-01-01T10:05:00Z" }); // the newer push arrives first
    expect((await w.q(`select head_sha from gate_instances where wo_id = $1 and gate_id = 'G5' and status = 'open'`, [id]))[0].head_sha, "G5 reopened on the newer head").toBe(H2);
    await approveG5(id);
    const m1 = (await w.q(`select data->'merging' as m from work_orders where id = $1`, [id]))[0].m;
    expect(m1?.headSha).toBe(H2);
    await deliver({ number: 820, head: H1, at: "2026-01-01T10:00:00Z" }); // the older delivery arrives late
    const wo = (await w.q(`select state, data->'merging' as m from work_orders where id = $1`, [id]))[0];
    const pr = (await w.q(`select head_sha, state from pull_requests where id = 'pr-payments-api-820'`))[0];
    expect(pr.head_sha, "the pull request keeps the newest head").toBe(H2);
    expect(wo.m?.headSha, "the approved merge of the newest head is still approved").toBe(H2);
  });

  it("H2: a late 'open' delivery after the merge sets a merged pull request back to open", async () => {
    const id = await atG5("Late open after merge");
    await t.db.admin.query(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, state, head_sha) values ($1,'pr-payments-api-821','payments-api',$2,821,'x','open',$3)`, [t.orgId, id, H1]);
    await approveG5(id);
    await deliver({ number: 821, head: H1, state: "closed", merged: true, at: "2026-01-01T10:10:00Z" });
    const merged = (await w.q(`select state from pull_requests where id = 'pr-payments-api-821'`))[0];
    expect(merged.state).toBe("merged");
    await deliver({ number: 821, head: H1, state: "open", at: "2026-01-01T10:00:00Z" });
    const after = (await w.q(`select state, merged_at from pull_requests where id = 'pr-payments-api-821'`))[0];
    expect(after.state, "a merged pull request stays merged").toBe("merged");
  });

  it("H1b: a delivery for a newer head still reopens G5, and a real reopen of a closed pull request still applies", async () => {
    const id = await atG5("Newer head reopens");
    await t.db.admin.query(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, state, head_sha, data) values ($1,'pr-payments-api-822','payments-api',$2,822,'x','open',$3,'{"sourceUpdatedAt":"2026-01-01T10:00:00Z"}'::jsonb)`, [t.orgId, id, H1]);
    await approveG5(id);
    expect((await w.q(`select data->'merging' as m from work_orders where id = $1`, [id]))[0].m?.headSha).toBe(H1);
    await deliver({ number: 822, head: H2, at: "2026-01-01T10:05:00Z" });
    expect((await w.q(`select data->'merging' as m from work_orders where id = $1`, [id]))[0].m, "the approval named the old head").toBeNull();
    expect((await w.q(`select head_sha from pull_requests where id = 'pr-payments-api-822'`))[0].head_sha).toBe(H2);
    await deliver({ number: 822, head: H2, state: "closed", at: "2026-01-01T10:06:00Z" });
    await deliver({ number: 822, head: H2, state: "open", at: "2026-01-01T10:07:00Z" });
    expect((await w.q(`select state from pull_requests where id = 'pr-payments-api-822'`))[0].state, "a newer open delivery is a real reopen").toBe("open");
  });

  it("H3: removing a repository from the GitHub App, or uninstalling it, marks the repo not ready and holds its work orders; adding it back resumes nothing", async () => {
    const id = await atG5("Held when the App loses the repo");
    await t.db.admin.query(`update repos set github_full_name = $2 where org_id = $1 and id = 'payments-api'`, [t.orgId, REPO]);
    const deliverRaw = async (ev: string, payload: object) => {
      const delivery = `d-sc7-${ev}-${Math.random().toString(36).slice(2, 8)}`;
      const body = Buffer.from(JSON.stringify(payload));
      const hash = createHash("sha256").update(body).digest("hex");
      await t.db.admin.query(`insert into inbound_deliveries (org_id, id, source, delivery_id, event_type, payload_hash) values ($1,$2,'github',$3,$4,$5)`, [t.orgId, `gh-${delivery}`, delivery, ev, hash]);
      await t.db.admin.query(`insert into github_blobs (org_id, hash, kind, content, size_bytes) values ($1,$2,'payload',$3,$4) on conflict do nothing`, [t.orgId, hash, body, body.length]);
      return w.tx((tx) => processGithubDelivery(tx, t.orgId, delivery));
    };
    const r = await deliverRaw("installation_repositories", { action: "removed", repository_selection: "selected", repositories_removed: [{ full_name: REPO }], installation: { id: 1 } });
    expect(r).toMatchObject({ status: "processed" });
    const repo = (await w.q(`select onboarding_stage, data from repos where id = 'payments-api'`))[0];
    expect(repo.onboarding_stage, "the repo is no longer ready").not.toBe("ready");
    expect(JSON.stringify(repo.data)).toMatch(/GitHub App access removed/);
    expect((await w.q(`select type from events where type = 'github.app.access_removed'`)).length, "the removal is recorded").toBeGreaterThan(0);
    expect((await w.q(`select 1 from stops where repo_id = 'payments-api' and mode = 'halt' and lifted_at is null`)).length, "the repo is halted, which holds its live work orders").toBe(1);
    void id;
    const back = await deliverRaw("installation_repositories", { action: "added", repositories_added: [{ full_name: REPO }], installation: { id: 1 } });
    expect(back).toMatchObject({ status: "processed" });
    expect((await w.q(`select 1 from stops where repo_id = 'payments-api' and mode = 'halt' and lifted_at is null`)).length, "adding it back does not resume").toBe(1);
    // An uninstall is recorded the same way and a second one changes nothing more.
    const un = await deliverRaw("installation", { action: "deleted", installation: { id: 1 }, repositories: [{ full_name: REPO }] });
    expect(un).toMatchObject({ status: "processed" });
  });
});
