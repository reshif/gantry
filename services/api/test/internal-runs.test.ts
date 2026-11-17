import { randomBytes } from "node:crypto";
import { encrypt, verifyChain, withTx } from "@gantry/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueRunToken, revokeRunTokens } from "../src/areas/internal/tokens.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const DATA_KEY = randomBytes(32);
const EDGE = { authorization: "Bearer edge-token-for-tests" };

d("internal runs API", () => {
  let t: TestApp;
  let n = 0;
  const q = async (sql: string, p: unknown[] = []) => (await t.db.admin.query(sql, p)).rows;
  const events = (type: string) => q(`select * from events where type = $1 order by seq`, [type]);
  const call = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = EDGE) =>
    t.app.inject({ method, url, headers: { ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });

  beforeAll(async () => {
    t = await startApp({ config: { secrets: { sessionKey: Buffer.from("test-session-key-0123456789abcdef"), dataKey: DATA_KEY, edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
    const o = t.orgId;
    await q(`insert into vendors (org_id, id, name, product, connected, endpoint, secret_enc) values ($1,'w3-anthropic','W3 Anthropic','Claude API',true,'',$2), ($1,'w3-off','W3 Off','x',false,'https://off.example.com/v1',null), ($1,'w3-local','W3 Local','vLLM',true,'https://gpu.example.org:8000/v1',null)`, [o, encrypt("sk-ant-real-secret-123456789", DATA_KEY, "vendor:w3-anthropic")]);
    await q(`insert into models (org_id, id, vendor_id, name) values ($1,'claude-test-1','w3-anthropic','Test'), ($1,'off-model','w3-off','Off'), ($1,'local-model','w3-local','Local')`, [o]);
    await q(`insert into price_versions (org_id, version, body, published_at, published_by) values ($1, 90, $2::jsonb, now(), 'test')`, [o, JSON.stringify({ "claude-test-1": { in: 3, out: 15 } })]);
    await q(`insert into routing_versions (org_id, version, body, published_at, published_by) values ($1, 90, $2::jsonb, now(), 'test')`, [o, JSON.stringify({ defaultModel: "claude-test-1", overrides: {}, fallback: [], rules: [] })]);
  });
  afterAll(() => t.close());

  interface Made { runId: string; attemptId: string; woId: string; token: string; fencing: string; project: string }
  /** A work order with a running attempt and a starting run, and its token. */
  async function makeRun(o: { project?: string; model?: string | null; woData?: object; runData?: object; attemptData?: object; attemptState?: string } = {}): Promise<Made> {
    const i = ++n;
    const project = o.project ?? "payments";
    const woId = `WO-w3-${i}`;
    const attemptId = `at-w3-${i}`;
    const runId = `run-w3-${i}`;
    const org = t.orgId;
    await q(`insert into work_orders (org_id, id, project_id, title, class, position, state, flow_version, data) values ($1,$2,$3,'Test','feature','build','running',1,$4::jsonb)`, [org, woId, project, JSON.stringify(o.woData ?? {})]);
    const a = await q(`insert into attempts (org_id, id, wo_id, station, visit, state, data) values ($1,$2,$3,'build',1,$4,$5::jsonb) returning fencing::text as fencing`, [org, attemptId, woId, o.attemptState ?? "running", JSON.stringify(o.attemptData ?? {})]);
    await q(`insert into runs (org_id, id, attempt_id, wo_id, model_id, data) values ($1,$2,$3,$4,$5,$6::jsonb)`, [org, runId, attemptId, woId, o.model === undefined ? "claude-test-1" : o.model, JSON.stringify(o.runData ?? {})]);
    const fencing = a[0].fencing as string;
    const tk = await withTx(t.db.app, (tx) => issueRunToken(tx, runId, attemptId, fencing));
    return { runId, attemptId, woId, token: tk.token, fencing, project };
  }
  const authorize = (r: Made, model?: string, token = r.token) => call("POST", `/internal/v1/runs/${r.runId}/authorize`, { token, ...(model ? { model } : {}) });
  const setStop = (scope: string, target: string, mode: "halt" | "kill", id = `${scope}:${target}:t${++n}`) =>
    q(`insert into stops (org_id, id, scope_type, ${scope === "wo" ? "wo_id" : scope === "project" ? "project_id" : "repo_id"}, mode, reason, set_by) values ($1,$2,$3,$4,$5,'test stop','p-asha')`, [t.orgId, id, scope, target, mode]).then(() => id);

  describe("service auth", () => {
    it("refuses a missing or wrong service token and a browser-style caller", async () => {
      const r = await makeRun();
      expect((await call("POST", `/internal/v1/runs/${r.runId}/authorize`, { token: r.token }, {})).statusCode).toBe(401);
      expect((await call("POST", `/internal/v1/runs/${r.runId}/authorize`, { token: r.token }, { authorization: "Bearer nope" })).statusCode).toBe(401);
    });
    it("restricts run-scoped endpoints to the edge: the GitHub broker's token is refused with a valid run token, and the refusal is audited", async () => {
      const r = await makeRun();
      const GH = { authorization: "Bearer github-token-for-tests" };
      const before = Number((await q(`select count(*)::int as n from events where type = 'internal.edge.denied'`))[0].n);
      for (const [m, path, body] of [
        ["POST", `/internal/v1/runs/${r.runId}/authorize`, { token: r.token }],
        ["POST", `/internal/v1/runs/${r.runId}/heartbeat`, { token: r.token }],
        ["POST", `/internal/v1/runs/${r.runId}/egress`, { token: r.token }],
        ["GET", `/internal/v1/egress/system`, undefined],
      ] as const) {
        const x = await call(m, path, body, GH);
        expect(x.statusCode, path).toBe(403);
      }
      expect((await call("GET", `/internal/v1/runs/${r.runId}/spec`, undefined, { ...GH, "x-run-token": r.token })).statusCode).toBe(403);
      expect(Number((await q(`select count(*)::int as n from events where type = 'internal.edge.denied'`))[0].n)).toBe(before + 5);
      expect((await call("POST", `/internal/v1/runs/${r.runId}/authorize`, { token: r.token })).statusCode).toBe(200);
    });
    it("validates bodies (422)", async () => {
      const r = await makeRun();
      expect((await call("POST", `/internal/v1/runs/${r.runId}/authorize`, { token: "short" })).statusCode).toBe(422);
    });
  });

  describe("issueRunToken", () => {
    it("stores only a hash, and refuses a fencing number that is not the attempt's", async () => {
      const r = await makeRun();
      const rows = await q(`select token_hash from run_tokens where run_id = $1`, [r.runId]);
      expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].token_hash).not.toContain(r.token);
      expect(r.token).toMatch(/^grt\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{40,}$/);
      await expect(withTx(t.db.app, (tx) => issueRunToken(tx, r.runId, r.attemptId, "999999999"))).rejects.toThrow(/fencing/);
      await expect(withTx(t.db.app, (tx) => issueRunToken(tx, "nope", r.attemptId, r.fencing))).rejects.toThrow(/no run/);
    });
  });

  describe("authorize", () => {
    it("allows a live run and returns the route", async () => {
      const r = await makeRun();
      const res = await authorize(r, "claude-test-1");
      expect(res.statusCode).toBe(200);
      const b = res.json();
      expect(b).toMatchObject({ ok: true, allow: true, route: { vendor: "w3-anthropic", baseUrl: "https://api.anthropic.com", modelId: "claude-test-1" }, projectId: "payments", woId: r.woId });
    });
    it("uses a vendor's own endpoint for a custom vendor", async () => {
      const r = await makeRun({ model: "local-model" });
      expect((await authorize(r)).json().route).toMatchObject({ vendor: "w3-local", baseUrl: "https://gpu.example.org:8000/v1" });
    });
    it("falls back to the routing default when no model is pinned", async () => {
      const r = await makeRun({ model: null });
      expect((await authorize(r)).json().route.modelId).toBe("claude-test-1");
    });
    it("denies and audits an unknown token, and a token of another run", async () => {
      const a = await makeRun();
      const b = await makeRun();
      const before = (await events("run.authorize.denied")).length;
      const bad = (await authorize(a, undefined, "grt.xx.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).json();
      expect(bad).toMatchObject({ allow: false, code: "token" });
      expect((await authorize(a, undefined, b.token)).json()).toMatchObject({ allow: false, code: "token" });
      const ev = await events("run.authorize.denied");
      expect(ev.length).toBe(before + 2);
      expect(ev.at(-1)).toMatchObject({ outcome: "denied", actor: "edge", wo_id: a.woId });
    });
    it("denies after a stop and allows again when it is lifted (T7)", async () => {
      const r = await makeRun();
      expect((await authorize(r)).json().allow).toBe(true);
      const id = await setStop("wo", r.woId, "halt");
      const denied = (await authorize(r)).json();
      expect(denied).toMatchObject({ allow: false, code: "stopped" });
      expect(denied.reason).toMatch(/Halted at wo scope/);
      await q(`update stops set lifted_at = now(), lifted_by = 'p-asha' where id = $1`, [id]);
      // Spec 4.4 / F3: the stop took a higher fencing number, so the old run stays superseded after the lift (even if the worker never
      // enforced the halt); the resume's fresh attempt is the one that works.
      expect((await authorize(r)).json()).toMatchObject({ allow: false, code: "superseded" });
      expect((await call("POST", `/internal/v1/runs/${r.runId}/heartbeat`, { token: r.token, seq: 1 })).statusCode).toBe(409);
      const fresh = await makeRun();
      expect((await authorize(fresh)).json().allow).toBe(true);
      // project and factory scopes cover the run too
      const p = await setStop("project", "payments", "kill");
      expect((await authorize(fresh)).json()).toMatchObject({ allow: false, code: "stopped" });
      await q(`update stops set lifted_at = now(), lifted_by = 'p-asha' where id = $1`, [p]);
      expect((await authorize(fresh)).json()).toMatchObject({ allow: false, code: "superseded" });
    });
    it("a halt still lets the run save state, but a stop on the parent epic covers the child's run", async () => {
      const r = await makeRun();
      const id = await setStop("wo", r.woId, "halt");
      expect((await authorize(r)).json()).toMatchObject({ allow: false, code: "stopped" });
      expect((await call("POST", `/internal/v1/runs/${r.runId}/heartbeat`, { token: r.token, seq: 1 })).statusCode).toBe(200);
      await q(`update stops set lifted_at = now(), lifted_by = 'p-asha' where id = $1`, [id]);
      const child = await makeRun();
      await q(`insert into work_orders (org_id, id, project_id, title, class, position, state, flow_version, data) values ($1,$2,'payments','Epic','epic','build','running',1,'{}'::jsonb)`, [t.orgId, `EPIC-w3-${n}`]);
      await q(`update work_orders set parent_id = $2 where id = $1`, [child.woId, `EPIC-w3-${n}`]);
      expect((await authorize(child)).json().allow).toBe(true);
      const k = await setStop("wo", `EPIC-w3-${n}`, "kill");
      expect((await authorize(child)).json()).toMatchObject({ allow: false, code: "stopped" });
      await q(`update stops set lifted_at = now(), lifted_by = 'p-asha' where id = $1`, [k]);
    });
    it("denies a superseded attempt (stale fencing) and a revoked token", async () => {
      const r = await makeRun();
      const s = await makeRun();
      await q(`update attempts set state = 'superseded' where id = $1`, [r.attemptId]);
      expect((await authorize(r)).json()).toMatchObject({ allow: false, code: "superseded" });
      await q(`update attempts set state = 'running', fencing = nextval('attempt_fencing_seq') where id = $1`, [r.attemptId]);
      expect((await authorize(r)).json()).toMatchObject({ allow: false, code: "superseded" });
      expect(await withTx(t.db.app, (tx) => revokeRunTokens(tx, { orgId: t.orgId, runIds: [s.runId], reason: "stop" }))).toBe(1);
      expect((await authorize(s)).json()).toMatchObject({ allow: false, code: "revoked" });
    });
    it("denies models other than the pinned one, disabled and disconnected ones, and vendors outside the project's allowed list", async () => {
      const r = await makeRun();
      expect((await authorize(r, "some-other-model")).json()).toMatchObject({ allow: false, code: "route" });
      const off = await makeRun({ model: "off-model" });
      expect((await authorize(off)).json()).toMatchObject({ allow: false, code: "route" });
      await q(`update models set enabled = false where id = 'local-model'`);
      expect((await authorize(await makeRun({ model: "local-model" }))).json().reason).toMatch(/disabled/);
      await q(`update models set enabled = true where id = 'local-model'`);
      await q(`update projects set config = jsonb_set(config, '{extra}', '{"allowedVendors":["w3-local"]}') where id = 'risk'`);
      const risk = await makeRun({ project: "risk" });
      expect((await authorize(risk)).json().reason).toMatch(/not allowed for this project/);
    });
    it("refuses after the run delivered its result", async () => {
      const r = await makeRun();
      expect((await call("POST", `/internal/v1/runs/${r.runId}/result`, { token: r.token, status: "succeeded", adapter: "stub", output: { summary: "ok" } })).statusCode).toBe(200);
      expect((await authorize(r)).json()).toMatchObject({ allow: false, code: "finished" });
    });
  });

  describe("usage and budgets", () => {
    const usage = (r: Made, over: object = {}) => call("POST", `/internal/v1/runs/${r.runId}/usage`, { token: r.token, model: "claude-test-1", vendor: "w3-anthropic", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 100, latencyMs: 420, ...over });

    it("meters tokens and cost at the price version in force", async () => {
      const r = await makeRun();
      const res = await usage(r, { requestId: "req-1", traceRef: `sha256/${"a".repeat(64)}` });
      expect(res.statusCode).toBe(200);
      // 1000*3 + 200*15 + 500*0.3 + 100*3.75 = 3000+3000+150+375
      expect(res.json()).toMatchObject({ ok: true, costMicros: 6525, priceVersion: 90, halted: false });
      const ru = (await q(`select * from run_usage where run_id = $1`, [r.runId]))[0];
      expect(ru).toMatchObject({ project_id: "payments", wo_id: r.woId, cached_tokens: "500", cache_write_tokens: "100", latency_ms: 420, price_version: 90, trace_ref: `sha256/${"a".repeat(64)}` });
      const um = (await q(`select * from usage_meter where run_id = $1`, [r.runId]))[0];
      expect(um).toMatchObject({ station: "build", cost_micros: "6525", vendor_id: "w3-anthropic", cache_write_tokens: "100" });
    });
    it("the run shows the model that actually answered, not the one pinned when it was prepared", async () => {
      const r = await makeRun();
      await q(`update runs set model_id = 'claude-sonnet-5-5' where id = $1`, [r.runId]);
      await usage(r, { requestId: "model-1", model: "claude-test-1" });
      expect((await q(`select model_id from runs where id = $1`, [r.runId]))[0].model_id).toBe("claude-test-1");
    });
    it("is idempotent per request id", async () => {
      const r = await makeRun();
      await usage(r, { requestId: "dup-1" });
      expect((await usage(r, { requestId: "dup-1" })).json().duplicate).toBe(true);
      expect(await q(`select 1 from run_usage where run_id = $1`, [r.runId])).toHaveLength(1);
      expect(await q(`select 1 from usage_meter where run_id = $1`, [r.runId])).toHaveLength(1);
    });
    it("still records cost after a stop or revocation, but refuses an unknown token (audited)", async () => {
      const r = await makeRun();
      await withTx(t.db.app, (tx) => revokeRunTokens(tx, { orgId: t.orgId, runIds: [r.runId], reason: "kill" }));
      expect((await usage(r)).statusCode).toBe(200);
      const res = await usage(r, { token: "grt.xx.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
      expect(res.statusCode).toBe(403);
      expect((await events("run.usage.denied")).length).toBeGreaterThan(0);
    });
    it("an unpriced model costs nothing and is flagged", async () => {
      const r = await makeRun({ model: "local-model" });
      expect((await usage(r, { model: "local-model" })).json()).toMatchObject({ costMicros: 0, unpriced: true });
    });
    it("a work-order budget breach halts the work order with cause budget, enqueues stop.enforce, and the next authorize is refused", async () => {
      const r = await makeRun({ woData: { budgetUsd: 0.005 } });
      expect((await authorize(r)).json().allow).toBe(true);
      const res = await usage(r); // 0.006525 > 0.005
      expect(res.json()).toMatchObject({ halted: true, breach: "wo" });
      const stop = (await q(`select * from stops where wo_id = $1 and lifted_at is null`, [r.woId]))[0];
      expect(stop).toMatchObject({ mode: "halt", cause: "budget", scope_type: "wo", set_by: "system" });
      const jobs = await q(`select * from jobs where kind = 'stop.enforce' and payload->>'stopId' = $1`, [stop.id]);
      expect(jobs[0]).toMatchObject({ queue: "stop", payload: { stopId: stop.id, scope: "wo", targetId: r.woId, mode: "halt" } });
      const ev = await events("stop.set");
      expect(ev.at(-1)).toMatchObject({ category: "kill", wo_id: r.woId });
      expect((await authorize(r)).json()).toMatchObject({ allow: false, code: "stopped" });
      // the same breach does not stack another stop
      await usage(r, { requestId: "again" });
      expect(await q(`select 1 from stops where wo_id = $1 and lifted_at is null`, [r.woId])).toHaveLength(1);
      // halt still lets the run save state: heartbeat and checkpoint are accepted
      expect((await call("POST", `/internal/v1/runs/${r.runId}/heartbeat`, { token: r.token, seq: 1 })).json().stop).toBe("halt");
    });
    it("a project monthly budget is enforced at authorize and at usage", async () => {
      await q(`delete from usage_meter where project_id = 'identity'`); // project spend counts all metered spend: start from none
      await q(`insert into budgets (org_id, project_id, monthly_limit_micros) values ($1,'identity',9000) on conflict (org_id, project_id) do update set monthly_limit_micros = 9000`, [t.orgId]);
      const a = await makeRun({ project: "identity" });
      expect((await authorize(a)).json().allow).toBe(true);
      await usage(a); // 6525 < 9000
      const b = await makeRun({ project: "identity" });
      expect((await authorize(b)).json().allow).toBe(true);
      expect((await usage(b)).json()).toMatchObject({ halted: true, breach: "project" });
      const c = await makeRun({ project: "identity" });
      const denied = (await authorize(c)).json();
      expect(denied).toMatchObject({ allow: false, code: "budget" });
      expect(denied.reason).toMatch(/project budget is spent/);
      await q(`update budgets set monthly_limit_micros = 0 where project_id = 'identity'`); // 0 = no cap configured
      expect((await authorize(c)).json().allow).toBe(true);
    });
  });

  describe("heartbeat, checkpoint, result", () => {
    const hb = (r: Made, over: object = {}) => call("POST", `/internal/v1/runs/${r.runId}/heartbeat`, { runId: r.runId, token: r.token, seq: 1, phase: "working", turn: 1, ...over });

    it("heartbeat starts the run, extends the lease and records only the start as an event", async () => {
      const r = await makeRun();
      const res = await hb(r);
      expect(res.statusCode).toBe(200);
      const lease = new Date(res.json().leaseUntil).getTime();
      expect(lease).toBeGreaterThan(Date.now() + 60_000);
      expect((await q(`select state from runs where id = $1`, [r.runId]))[0].state).toBe("running");
      await hb(r, { seq: 2 });
      expect((await events("run.started")).filter((e) => e.subject.id === r.runId)).toHaveLength(1);
    });
    it("a kill refuses heartbeat, checkpoint and result (409, audited); a superseded run gets 409 stale; unknown token 403", async () => {
      const r = await makeRun();
      await setStop("wo", r.woId, "kill");
      for (const [ep, body] of [["heartbeat", {}], ["checkpoint", { turn: 1, kind: "transcript", name: "t", contentHash: "b".repeat(64) }], ["result", { status: "failed", adapter: "stub" }]] as const) {
        const res = await call("POST", `/internal/v1/runs/${r.runId}/${ep}`, { token: r.token, ...body });
        expect(res.statusCode, ep).toBe(409);
        expect(res.json()).toMatchObject({ ok: false });
      }
      expect((await events("run.heartbeat.denied")).length).toBeGreaterThan(0);
      const s = await makeRun({ attemptState: "superseded" });
      const stale = await hb(s);
      expect(stale.statusCode).toBe(409);
      expect((await hb(s, { token: "grt.xx.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).statusCode).toBe(403);
      expect((await q(`select state from runs where id = $1`, [s.runId]))[0].state).toBe("starting");
    });
    it("checkpoint records a reference, is idempotent, and keeps artefacts by content hash", async () => {
      const r = await makeRun();
      const body = { token: r.token, turn: 2, kind: "artefact", name: "spec.md", contentType: "text/markdown", contentHash: "c".repeat(64), size: 12 };
      const a = await call("POST", `/internal/v1/runs/${r.runId}/checkpoint`, body);
      expect(a.json()).toMatchObject({ ok: true, seq: 1 });
      expect((await call("POST", `/internal/v1/runs/${r.runId}/checkpoint`, body)).json().duplicate).toBe(true);
      const b = await call("POST", `/internal/v1/runs/${r.runId}/checkpoint`, { ...body, turn: 3, kind: "transcript", name: "t.jsonl", contentHash: "d".repeat(64) });
      expect(b.json().seq).toBe(2);
      expect(await q(`select content_hash from checkpoints where run_id = $1 order by seq`, [r.runId])).toEqual([{ content_hash: "c".repeat(64) }, { content_hash: "d".repeat(64) }]);
      expect(await q(`select name, content_hash, size_bytes::int from artefacts where wo_id = $1`, [r.woId])).toEqual([{ name: "spec.md", content_hash: "c".repeat(64), size_bytes: 12 }]);
      expect((await call("POST", `/internal/v1/runs/${r.runId}/checkpoint`, { ...body, contentHash: "nothex" })).statusCode).toBe(422);
    });
    it("result stores the station result once, enqueues run.result with the dedupe key, and a retry is a no-op", async () => {
      const r = await makeRun();
      const body = { token: r.token, status: "succeeded", adapter: "stub", output: { summary: "Built it", commits: 2 }, usage: [{ model: "m", inputTokens: 1, outputTokens: 1 }], capabilities: { cancel: true, resume: false, mcp: false, usageDetail: false } };
      const a = await call("POST", `/internal/v1/runs/${r.runId}/result`, body);
      expect(a.json()).toMatchObject({ ok: true, resultId: `sr-${r.runId}` });
      const sr = (await q(`select * from station_results where attempt_id = $1`, [r.attemptId]))[0];
      expect(sr).toMatchObject({ outcome: "succeeded", summary: "Built it", station: "build", wo_id: r.woId });
      expect(sr.body.output).toEqual({ summary: "Built it", commits: 2 });
      const jobs = await q(`select queue, payload from jobs where kind = 'run.result' and dedupe_key = $1`, [`run.result:${r.runId}`]);
      expect(jobs).toEqual([{ queue: "flow", payload: { runId: r.runId, attemptId: r.attemptId, fencing: Number(r.fencing) } }]);
      expect((await call("POST", `/internal/v1/runs/${r.runId}/result`, body)).json().duplicate).toBe(true);
      expect(await q(`select 1 from jobs where kind = 'run.result' and payload->>'runId' = $1`, [r.runId])).toHaveLength(1);
      expect((await events("run.result")).filter((e) => e.subject.id === r.runId)).toHaveLength(1);
    });
    it("a result from a token of another attempt is refused", async () => {
      const a = await makeRun();
      const b = await makeRun();
      const res = await call("POST", `/internal/v1/runs/${a.runId}/result`, { token: b.token, status: "failed", adapter: "stub" });
      expect(res.statusCode).toBe(403);
      expect(await q(`select 1 from station_results where attempt_id = $1`, [a.attemptId])).toHaveLength(0);
    });
  });

  describe("spec", () => {
    it("composes instructions from the available layers, skills, tool list, limits and handoff", async () => {
      const o = t.orgId;
      await q(`insert into agents (org_id, id, name, station, live_version, data) values ($1,'ag-w3','W3 agent','build',1,$2::jsonb)`, [o, JSON.stringify({ budget: 2.5 })]);
      await q(`insert into agent_versions (org_id, agent_id, version, body, model_id, published_at) values ($1,'ag-w3',1,$2::jsonb,'claude-test-1',now())`, [o, JSON.stringify({ instructions: "Agent says build.", tools: { readRepo: true, writeBranch: true, runTests: true, merge: false }, limits: { turns: 12 } })]);
      await q(`insert into skills (org_id, id, name, live_version) values ($1,'sk-w3','Testing skill',1)`, [o]);
      await q(`insert into skill_versions (org_id, skill_id, version, body, published_at) values ($1,'sk-w3',1,$2::jsonb,now())`, [o, JSON.stringify({ body: "Always run tests." })]);
      await q(`insert into agent_skills (org_id, agent_id, skill_id) values ($1,'ag-w3','sk-w3')`, [o]);
      await q(`insert into instruction_versions (org_id, scope, scope_id, version, body, hash, published_at) values ($1,'base','',90,'Factory rules.',$2,now())`, [o, "f".repeat(64)]);
      await q(`insert into instruction_versions (org_id, scope, scope_id, version, body, hash, published_at) values ($1,'project','payments',90,'Payments overlay.',$2,now())`, [o, "e".repeat(64)]);
      await q(`insert into agent_version_tuples (org_id, id, agent_id, agent_version, skill_versions, instruction_hash, harness_version, model_id) values ($1,'tup-w3','ag-w3',1,'{}','h','1','claude-test-1')`, [o]);
      const r = await makeRun({ model: null });
      await q(`update attempts set tuple_id = 'tup-w3' where id = $1`, [r.attemptId]);
      await q(`insert into brief_versions (org_id, wo_id, version, body) values ($1,$2,1,'{"goal":"ship"}')`, [o, r.woId]);
      const res = await call("GET", `/internal/v1/runs/${r.runId}/spec`, undefined, { ...EDGE, "x-run-token": r.token });
      expect(res.statusCode).toBe(200);
      const s = res.json();
      expect(s).toMatchObject({ runId: r.runId, adapter: "claude", station: "build", model: "claude-test-1", heartbeatSeconds: 15, limits: { turns: 12, costUsd: 2.5, wallClockSeconds: 3600 } });
      expect(s.instructions).toBe("## Factory base\n\nFactory rules.\n\n## Project overlay\n\nPayments overlay.\n\n## Agent\n\nAgent says build.");
      expect(s.instructionsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(s.skills).toEqual([{ name: "Testing skill", content: "Always run tests." }]);
      // the prompt manifest names every part in order, with source, version and hash; its hash is the instruction hash and is recorded on the run
      expect(s.promptManifest.hash).toBe(s.instructionsHash);
      expect(s.promptManifest.parts.map((p: { kind: string; name: string }) => `${p.kind}:${p.name}`)).toEqual(["layer:Factory base", "layer:Project overlay", "layer:Agent", "skill:Testing skill", "station_tools:Station tools", "result_instruction:Result instruction", "result_schema:Station result shape"]);
      expect(s.promptManifest.parts[3]).toMatchObject({ version: 1, bytes: "Always run tests.".length, source: "skill_versions sk-w3" });
      expect(s.promptManifest.parts[0]).toMatchObject({ version: 90 });
      expect(s.promptManifest.handoff.bytes).toBeGreaterThan(10);
      const stored = (await q(`select data from runs where id = $1`, [r.runId]))[0]!.data;
      expect(stored.promptManifest.hash).toBe(s.instructionsHash);
      expect(stored.promptDrift).toBe(true); // the test tuple was pinned with the placeholder hash 'h'
      // serving the same spec again writes nothing new (no repeated update, no new audit rows)
      const stamp = (await q(`select updated_at from runs where id = $1`, [r.runId]))[0]!.updated_at;
      const rows = Number((await q(`select count(*)::int as n from events`))[0].n);
      await call("GET", `/internal/v1/runs/${r.runId}/spec`, undefined, { ...EDGE, "x-run-token": r.token });
      expect((await q(`select updated_at from runs where id = $1`, [r.runId]))[0]!.updated_at).toEqual(stamp);
      expect(Number((await q(`select count(*)::int as n from events`))[0].n)).toBe(rows);
      // "may run tests" is a set of test commands, never a bare shell
      expect(s.toolAllowList).not.toContain("Bash");
      expect(s.toolAllowList.filter((t: string) => !t.startsWith("Bash(")).sort()).toEqual(["Edit", "Glob", "Grep", "NotebookEdit", "Read", "Write"]);
      expect(s.toolAllowList).toContain("Bash(npm test:*)");
      expect(s.toolAllowList.filter((t: string) => t.startsWith("Bash(")).every((t: string) => /^Bash\((npm|npx|pnpm|yarn|pytest|python|go|cargo)[ :]/.test(t))).toBe(true);
      expect(s.input.brief).toEqual({ goal: "ship" });
      // the per-run cost cap (agent budget 2.5) is enforced at authorize
      expect((await authorize(r)).json().allow).toBe(true);
    });
    it("a run's limits and tool allow-list come from its pinned version, never from the agent's draft", async () => {
      const o = t.orgId;
      // the draft (agents.data) has wide limits and an explicit allow-list; the pinned version has neither key
      await q(`insert into agents (org_id, id, name, station, live_version, data) values ($1,'ag-w3d','W3 draft','build',1,$2::jsonb)`, [o, JSON.stringify({ budget: 2, limits: { turns: 500, wallClockSeconds: 99999 }, toolAllowList: ["Bash", "WebFetch"], tools: { readRepo: true, writeBranch: true, runTests: true } })]);
      await q(`insert into agent_versions (org_id, agent_id, version, body, model_id, published_at) values ($1,'ag-w3d',1,$2::jsonb,'claude-test-1',now())`, [o, JSON.stringify({ instructions: "Read only.", tools: { readRepo: true } })]);
      await q(`insert into agent_version_tuples (org_id, id, agent_id, agent_version, skill_versions, instruction_hash, harness_version, model_id) values ($1,'tup-w3d','ag-w3d',1,'{}','h','1','claude-test-1')`, [o]);
      const r = await makeRun({ model: null });
      await q(`update attempts set tuple_id = 'tup-w3d' where id = $1`, [r.attemptId]);
      const s = (await call("GET", `/internal/v1/runs/${r.runId}/spec`, undefined, { ...EDGE, "x-run-token": r.token })).json();
      expect(s.limits).toMatchObject({ turns: 40, wallClockSeconds: 3600 });
      expect(s.toolAllowList).toEqual(["Read", "Glob", "Grep"]);
      // a version that does carry limits and an allow-list wins
      await q(`insert into agent_versions (org_id, agent_id, version, body, model_id, published_at) values ($1,'ag-w3d',2,$2::jsonb,'claude-test-1',now())`, [o, JSON.stringify({ instructions: "Read only.", limits: { turns: 7 }, toolAllowList: ["Read"] })]);
      await q(`insert into agent_version_tuples (org_id, id, agent_id, agent_version, skill_versions, instruction_hash, harness_version, model_id) values ($1,'tup-w3e','ag-w3d',2,'{}','h','1','claude-test-1')`, [o]);
      const r2 = await makeRun({ model: null });
      await q(`update attempts set tuple_id = 'tup-w3e' where id = $1`, [r2.attemptId]);
      const s2 = (await call("GET", `/internal/v1/runs/${r2.runId}/spec`, undefined, { ...EDGE, "x-run-token": r2.token })).json();
      expect(s2.limits.turns).toBe(7);
      expect(s2.toolAllowList).toEqual(["Read"]);
    });
    it("serves a stub run its configured output, and refuses without a valid token or under a stop", async () => {
      const r = await makeRun({ model: null, runData: { adapter: "stub", stub: { output: { x: 1 } } } });
      const s = (await call("GET", `/internal/v1/runs/${r.runId}/spec`, undefined, { ...EDGE, "x-run-token": r.token })).json();
      expect(s).toMatchObject({ adapter: "stub", stub: { output: { x: 1 } } });
      expect((await call("GET", `/internal/v1/runs/${r.runId}/spec`, undefined, { ...EDGE, "x-run-token": "grt.xx.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).statusCode).toBe(403);
      await setStop("wo", r.woId, "halt");
      expect((await call("GET", `/internal/v1/runs/${r.runId}/spec`, undefined, { ...EDGE, "x-run-token": r.token })).statusCode).toBe(409);
    });
    it("422 for a claude run with no model", async () => {
      const r = await makeRun({ model: null, runData: { adapter: "claude" } });
      expect((await call("GET", `/internal/v1/runs/${r.runId}/spec`, undefined, { ...EDGE, "x-run-token": r.token })).statusCode).toBe(422);
    });
    it("never falls back to the stub for a run with no model unless it was marked as a stub", async () => {
      const r = await makeRun({ model: null });
      const res = await call("GET", `/internal/v1/runs/${r.runId}/spec`, undefined, { ...EDGE, "x-run-token": r.token });
      expect(res.statusCode).toBe(422);
      expect(JSON.stringify(res.json())).toMatch(/no model/i);
    });
    it("hands over the latest accepted result per station, without retries, usage or cost, and within a size cap", async () => {
      const r = await makeRun();
      let visit = 10;
      const old = async (id: string, station: string, outcome: string, summary: string, output: object) => {
        await q(`insert into attempts (org_id, id, wo_id, station, visit, state, data) values ($1,$2,$3,$4,$5,'succeeded','{}'::jsonb)`, [t.orgId, id, r.woId, station, ++visit]);
        await q(`insert into station_results (org_id, id, attempt_id, wo_id, station, outcome, summary, body) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
          t.orgId, `sr-${id}`, id, r.woId, station, outcome, summary,
          JSON.stringify({ output, usage: [{ model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0.5 }], capabilities: { cancel: true }, adapter: "claude", error: null }),
        ]);
      };
      await old(`${r.attemptId}-s1`, "spec", "failed", "crashed", {});
      await old(`${r.attemptId}-s2`, "spec", "succeeded", "spec accepted", { summary: "spec accepted", notes: "n".repeat(60_000) });
      const s = (await call("GET", `/internal/v1/runs/${r.runId}/spec`, undefined, { ...EDGE, "x-run-token": r.token })).json();
      expect(s.input.previous.results).toHaveLength(1);
      expect(s.input.previous.results[0]).toMatchObject({ station: "spec", summary: "spec accepted", truncated: { omittedFields: ["notes"] } });
      expect(s.input.previous.omitted.attempts).toBe(1);
      expect(JSON.stringify(s.input.previous.results)).not.toMatch(/costUsd|capabilities|usage/);
      expect(JSON.stringify(s.input.previous).length).toBeLessThan(16_000);
    });
  });

  describe("mcp-authorize", () => {
    const HASHES: Record<string, string> = { search: "h1", delete: "h2", hidden: "h3" };
    // The edge always sends the live definition hash; a call without one is refused (see the fail-closed test below).
    const mcp = (r: Made, body: { tool?: string } & Record<string, unknown>) => call("POST", `/internal/v1/runs/${r.runId}/mcp-authorize`, { token: r.token, server: "w3-mcp", tool: "search", definitionHash: HASHES[body.tool ?? "search"] ?? "hx", ...body });
    beforeAll(async () => {
      const o = t.orgId;
      await q(`insert into mcp_servers (org_id, id, name, url) values ($1,'w3-mcp','docs','https://mcp.example.net/sse')`, [o]);
      await q(`insert into mcp_tools (org_id, server_id, name, definition_hash, tool_class, allowed) values ($1,'w3-mcp','search','h1','read',true), ($1,'w3-mcp','delete','h2','write',true), ($1,'w3-mcp','hidden','h3','read',false)`, [o]);
      await q(`insert into mcp_scopes (org_id, id, server_id, projects, repos, agents, stations) values ($1,'sc-w3','w3-mcp','["payments"]','"all"','"all"','["build"]')`, [o]);
      // Spec 12.4 and the legacy resolver: a project must also enable the server in its own config.
      await q(`update projects set config = jsonb_set(config, '{mcp}', coalesce(config -> 'mcp', '[]'::jsonb) || '["w3-mcp"]'::jsonb) where org_id = $1 and id = 'payments'`, [o]);
    });
    it("allows an in-scope read tool, logs it with the argument hash, and lists the server in the run spec", async () => {
      const r = await makeRun();
      const res = await mcp(r, { argsHash: "e".repeat(64) });
      expect(res.json()).toMatchObject({ allow: true, class: "read" });
      expect((await q(`select * from mcp_calls where run_id = $1`, [r.runId]))[0]).toMatchObject({ server_id: "w3-mcp", tool: "search", outcome: "allowed", args_hash: "e".repeat(64), wo_id: r.woId, station: "build" });
      const spec = (await call("GET", `/internal/v1/runs/${r.runId}/spec`, undefined, { ...EDGE, "x-run-token": r.token })).json();
      expect(spec.mcpServers).toEqual({ docs: { type: "http", url: "http://gantry-edge:8443/mcp/v1/w3-mcp" } });
      // a registry name with spaces and capitals becomes a legal harness name
      await q(`update mcp_servers set name = 'Docs wiki' where id = 'w3-mcp'`);
      expect(Object.keys((await call("GET", `/internal/v1/runs/${r.runId}/spec`, undefined, { ...EDGE, "x-run-token": r.token })).json().mcpServers)).toEqual(["docs-wiki"]);
      await q(`update mcp_servers set name = 'docs' where id = 'w3-mcp'`);
    });
    it("denies (and audits) out-of-scope projects, disallowed and unknown tools", async () => {
      const other = await makeRun({ project: "risk" });
      expect((await mcp(other, {})).json()).toMatchObject({ allow: false, code: "scope" });
      const r = await makeRun();
      expect((await mcp(r, { tool: "hidden" })).json()).toMatchObject({ allow: false, code: "tool" });
      expect((await mcp(r, { tool: "nope" })).json()).toMatchObject({ allow: false, code: "tool" });
      expect((await mcp(r, { server: "nope" })).json()).toMatchObject({ allow: false, code: "server" });
      expect((await events("mcp.call.denied")).length).toBeGreaterThanOrEqual(4);
    });
    it("write tools need the attempt's pre-authorisation", async () => {
      const r = await makeRun();
      expect((await mcp(r, { tool: "delete" })).json()).toMatchObject({ allow: false, code: "preauth" });
      const g = await makeRun({ attemptData: { writeGrants: ["w3-mcp/delete"] } });
      expect((await mcp(g, { tool: "delete" })).json()).toMatchObject({ allow: true, class: "write", retry: false });
    });
    it("a changed tool definition disables the server", async () => {
      const r = await makeRun();
      expect((await mcp(r, { definitionHash: "changed" })).json()).toMatchObject({ allow: false, code: "definition" });
      expect((await q(`select enabled, disabled_reason from mcp_servers where id = 'w3-mcp'`))[0]).toMatchObject({ enabled: false });
      expect((await mcp(r, {})).json()).toMatchObject({ allow: false, code: "server" });
      expect((await q(`select pending_hash from mcp_tools where server_id = 'w3-mcp' and name = 'search'`))[0].pending_hash).toBe("changed");
      await q(`update mcp_servers set enabled = true where id = 'w3-mcp'`);
      await q(`update mcp_tools set pending_hash = null where server_id = 'w3-mcp'`);
    });
    it("fails closed when the edge could not read the live definition: no hash, no call", async () => {
      const r = await makeRun();
      expect((await mcp(r, { definitionHash: undefined })).json()).toMatchObject({ allow: false, code: "definition" });
      const g = await makeRun({ attemptData: { writeGrants: ["w3-mcp/delete"] } });
      expect((await mcp(g, { tool: "delete", definitionHash: undefined })).json()).toMatchObject({ allow: false, code: "definition" });
      expect((await q(`select enabled from mcp_servers where id = 'w3-mcp'`))[0]).toMatchObject({ enabled: true });
    });
    it("is refused under a stop", async () => {
      const r = await makeRun();
      await setStop("wo", r.woId, "halt");
      expect((await mcp(r, {})).json()).toMatchObject({ allow: false, code: "stopped" });
    });
    const MCPBASE = (r: Made, suffix: string) => `/internal/v1/runs/${r.runId}/${suffix}`;
    it("a project that has not enabled the server in its config does not see it, and a class outside the class scope is refused", async () => {
      const r = await makeRun();
      await q(`update projects set config = jsonb_set(config, '{mcp}', '[]') where id = 'payments'`);
      expect((await mcp(r, {})).json()).toMatchObject({ allow: false, code: "scope" });
      await q(`update projects set config = jsonb_set(config, '{mcp}', '["w3-mcp"]') where id = 'payments'`);
      await q(`update mcp_scopes set classes = '["bug"]' where server_id = 'w3-mcp'`);
      expect((await mcp(r, {})).json()).toMatchObject({ allow: false, code: "scope" });
      await q(`update mcp_scopes set classes = '["feature"]' where server_id = 'w3-mcp'`);
      expect((await mcp(r, {})).json()).toMatchObject({ allow: true });
      await q(`update mcp_scopes set classes = '"all"' where server_id = 'w3-mcp'`);
    });
    it("mcp-tools lists what the run may see (a write tool only with its pre-authorisation), mcp-connection releases the sealed credential, and only to the edge for an in-scope server", async () => {
      await q(`update mcp_servers set auth_mode = 'bearer', secret_enc = $1 where id = 'w3-mcp'`, [encrypt("upstream-secret-123456", DATA_KEY, "mcp:w3-mcp")]);
      await q(`update mcp_tools set definition = '{"description":"find","inputSchema":{"type":"object"}}'::jsonb where server_id = 'w3-mcp' and name = 'search'`);
      const r = await makeRun();
      const list = (await call("POST", MCPBASE(r, "mcp-tools"), { token: r.token, server: "w3-mcp" })).json();
      expect(list.tools.map((x: { name: string }) => x.name)).toEqual(["search"]);
      expect(list.tools[0]).toMatchObject({ description: "find", inputSchema: { type: "object" }, class: "read" });
      const g = await makeRun({ attemptData: { writeGrants: ["w3-mcp/delete"] } });
      expect((await call("POST", MCPBASE(g, "mcp-tools"), { token: g.token, server: "w3-mcp" })).json().tools.map((x: { name: string }) => x.name)).toEqual(["delete", "search"]);
      const conn = await call("POST", MCPBASE(r, "mcp-connection"), { token: r.token, server: "w3-mcp" });
      expect(conn.json()).toMatchObject({ ok: true, url: "https://mcp.example.net/sse", auth: { mode: "bearer", secret: "upstream-secret-123456" } });
      expect(conn.headers["cache-control"]).toBe("no-store");
      const other = await makeRun({ project: "risk" });
      expect((await call("POST", MCPBASE(other, "mcp-connection"), { token: other.token, server: "w3-mcp" })).statusCode).toBe(403);
      expect((await call("POST", MCPBASE(r, "mcp-connection"), { token: r.token, server: "w3-mcp" }, { authorization: "Bearer github-token-for-tests" })).statusCode).toBe(403);
      expect((await call("POST", MCPBASE(r, "mcp-connection"), { token: "grt.xx.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", server: "w3-mcp" })).statusCode).toBe(403);
      await q(`update mcp_tools set pending_hash = 'zz' where server_id = 'w3-mcp' and name = 'search'`);
      expect((await call("POST", MCPBASE(r, "mcp-tools"), { token: r.token, server: "w3-mcp" })).json().tools).toEqual([]);
      await q(`update mcp_tools set pending_hash = null where server_id = 'w3-mcp'`);
    });
    it("mcp-result completes the logged call once, records latency, and puts write calls and failures in the ledger", async () => {
      const g = await makeRun({ attemptData: { writeGrants: ["w3-mcp/delete"] } });
      const a = (await mcp(g, { tool: "delete", argsHash: "a".repeat(64) })).json();
      expect(a.callId).toBeGreaterThan(0);
      const done = await call("POST", MCPBASE(g, "mcp-result"), { token: g.token, callId: a.callId, outcome: "ok", ms: 42 });
      expect(done.json()).toMatchObject({ ok: true, recorded: true });
      expect((await q(`select outcome, latency_ms from mcp_calls where id = $1`, [a.callId]))[0]).toMatchObject({ outcome: "ok", latency_ms: 42 });
      expect((await call("POST", MCPBASE(g, "mcp-result"), { token: g.token, callId: a.callId, outcome: "error", ms: 1 })).json()).toMatchObject({ recorded: false });
      expect((await events("mcp.call")).some((e) => e.subject?.id === "w3-mcp/delete")).toBe(true);
      const r = await makeRun();
      const b = (await mcp(r, {})).json();
      await call("POST", MCPBASE(r, "mcp-result"), { token: r.token, callId: b.callId, outcome: "error", ms: 7, error: "upstream 502" });
      expect((await q(`select outcome, reason from mcp_calls where id = $1`, [b.callId]))[0]).toMatchObject({ outcome: "error", reason: "upstream 502" });
      // another run cannot complete this run's call
      const x = await makeRun();
      expect((await call("POST", MCPBASE(x, "mcp-result"), { token: x.token, callId: b.callId, outcome: "ok", ms: 1 })).json()).toMatchObject({ recorded: false });
    });
  });

  describe("egress and vendor keys", () => {
    it("builds the project allow-list: defaults, vendor endpoints, project extras, never MCP hosts (gateway only); refuses a bad token", async () => {
      await q(`update projects set config = jsonb_set(config, '{extra}', '{"allowedHosts":["packages.internal.example"]}') where id = 'payments'`);
      const r = await makeRun();
      const res = await call("POST", `/internal/v1/runs/${r.runId}/egress`, { token: r.token });
      const h: string[] = res.json().hosts;
      for (const x of ["github.com", "registry.npmjs.org", "pypi.org", "api.anthropic.com", "gpu.example.org", "packages.internal.example"]) expect(h, x).toContain(x);
      expect(h).not.toContain("evil.example.com");
      // Spec 12.4: MCP servers are reached only through the edge's gateway (scope, definition hash, write pre-authorisation), never directly.
      expect(h).not.toContain("mcp.example.net");
      expect((await call("POST", `/internal/v1/runs/${r.runId}/egress`, { token: "grt.xx.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).statusCode).toBe(403);
      await setStop("wo", r.woId, "kill");
      expect((await call("POST", `/internal/v1/runs/${r.runId}/egress`, { token: r.token })).statusCode).toBe(409);
    });
    it("system hosts include integration endpoints", async () => {
      await q(`insert into integration_types (org_id, id, name) values ($1,'w3-hook','Hook') on conflict do nothing`, [t.orgId]);
      await q(`insert into integration_instances (org_id, id, type_id, name, config) values ($1,'w3-i','w3-hook','Hook','{"url":"https://hooks.partner.example/x"}')`, [t.orgId]);
      const h: string[] = (await call("GET", "/internal/v1/egress/system")).json().hosts;
      expect(h).toContain("hooks.partner.example");
      expect(h).toContain("hooks.slack.com");
    });
    it("records refused outbound connections in the audit ledger (service token only)", async () => {
      const r = await makeRun();
      const res = await call("POST", "/internal/v1/egress/denied", { runId: r.runId, caller: "run", host: "evil.example.com", port: 443, reason: "Host evil.example.com is not on the allow-list." });
      expect(res.statusCode).toBe(200);
      const ev = (await events("egress.denied")).find((e) => e.after?.host === "evil.example.com");
      expect(ev).toMatchObject({ outcome: "denied", project_id: "payments", wo_id: r.woId });
      expect((await call("POST", "/internal/v1/egress/denied", { caller: "system", host: "x.example.com", port: 443, reason: "no" })).statusCode).toBe(200);
      expect((await call("POST", "/internal/v1/egress/denied", { caller: "system", host: "x.example.com", port: 443, reason: "no" }, {})).statusCode).toBe(401);
      expect((await call("POST", "/internal/v1/egress/denied", { caller: "bogus", host: "x", port: 1, reason: "" })).statusCode).toBe(422);
    });
    it("returns a decrypted vendor key only to the edge", async () => {
      expect((await call("GET", "/internal/v1/vendors/w3-anthropic/key")).json()).toEqual({ ok: true, key: "sk-ant-real-secret-123456789" });
      expect((await call("GET", "/internal/v1/vendors/w3-anthropic/key", undefined, { authorization: "Bearer github-token-for-tests" })).statusCode).toBe(403);
      expect((await q(`select outcome, actor from events where type = 'vendor.key.read.denied'`))).toEqual([{ outcome: "denied", actor: "github" }]);
      expect((await call("GET", "/internal/v1/vendors/w3-off/key")).statusCode).toBe(404);
      expect((await call("GET", "/internal/v1/vendors/missing/key")).statusCode).toBe(404);
    });
  });

  it("the audit chain still verifies after all of the above", async () => {
    const v = await verifyChain(t.db.app, t.orgId);
    expect(v.ok).toBe(true);
  });
});
