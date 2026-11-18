import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_URL } from "./db.js";
import { startWorld, type World } from "./world.js";

const d = TEST_URL ? describe : describe.skip;

d("attempt.dispatch and run.result", () => {
  let w: World;
  beforeEach(async () => { w = await startWorld(); });
  afterEach(async () => { await w.close(); });

  it("prepares the run, seeds the workspace, then starts the runner with the per-run token", async () => {
    await w.q(`update repos set github_full_name = 'acme/payments-api' where org_id = $1 and id = 'payments-api'`, [w.orgId]);
    await w.q(`insert into repo_config (org_id, repo_id, data) values ($1,'payments-api','{"baseSha":"${"1".repeat(40)}"}') on conflict (org_id, repo_id) do update set data = excluded.data`, [w.orgId]);
    const { attemptId, runId } = await w.workOrderAt("WO-9001");
    await w.drain();
    const starts = w.launcher.calls.filter((c) => c.op === "start");
    expect(starts.map((c) => c.body!.seedComplete)).toEqual([false, true]);
    expect(w.broker.calls.filter((c) => c.op === "seed").map((c) => c.body)).toEqual([{ repo: "acme/payments-api", commit: "1".repeat(40), volume: `ws-${runId}` }]);
    // Order: prepare -> seed -> start.
    const t = [starts[0]!.at, w.broker.calls[0]!.at, starts[1]!.at];
    expect([...t].sort((a, b) => a - b)).toEqual(t);
    const token = starts[1]!.body!.runToken as string;
    expect(token).toMatch(/^grt\./);
    const run = (await w.q(`select * from runs where id = $1`, [runId]))[0];
    expect(run.attempt_id).toBe(attemptId);
    expect(run.data.dispatch.phase).toBe("started");
    const toks = await w.q(`select revoked_at from run_tokens where run_id = $1`, [runId]);
    expect(toks).toHaveLength(1);
    expect(toks[0].revoked_at).toBeNull();
    const att = (await w.q(`select state, lease_until from attempts where id = $1`, [attemptId]))[0];
    expect(att.state).toBe("running");
    expect(att.lease_until).not.toBeNull();
  });

  it("seeds the pull request's head together with the target branch head, and records both on the run so the agents can diff offline", async () => {
    await w.q(`update repos set github_full_name = 'acme/payments-api' where org_id = $1 and id = 'payments-api'`, [w.orgId]);
    await w.q(`insert into repo_config (org_id, repo_id, data) values ($1,'payments-api','{"baseSha":"${"1".repeat(40)}"}') on conflict (org_id, repo_id) do update set data = excluded.data`, [w.orgId]);
    const head = "5".repeat(40);
    w.broker.seedBase = "6".repeat(40);
    const { runId } = await w.workOrderAt("WO-9030", { station: "verify", dispatch: false });
    await w.q(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, state, head_sha, base_branch) values ($1,'pr-9030','payments-api','WO-9030',7,'t','open',$2,'develop')`, [w.orgId, head]);
    await w.enqueue("attempt.dispatch", { woId: "WO-9030", station: "verify", attemptId: "ATT-WO-9030-verify-1", fencing: 1 }, { dedupeKey: "attempt:ATT-WO-9030-verify-1" });
    await w.drain();
    const seed = w.broker.calls.find((c) => c.op === "seed")!;
    expect(seed.body).toEqual({ repo: "acme/payments-api", commit: head, volume: `ws-${runId}`, baseBranch: "develop" });
    expect((await w.q(`select data->'seed' as s from runs where id = $1`, [runId]))[0].s).toEqual({ commit: head, base: "6".repeat(40), baseBranch: "develop" });
  });

  it("records the repository context the broker read at the seeded commit on the run (paths, sizes, hashes, what was inlined), so the run spec can offer it", async () => {
    await w.q(`update repos set github_full_name = 'acme/payments-api' where org_id = $1 and id = 'payments-api'`, [w.orgId]);
    await w.q(`insert into repo_config (org_id, repo_id, data) values ($1,'payments-api','{"baseSha":"${"3".repeat(40)}"}') on conflict (org_id, repo_id) do update set data = excluded.data`, [w.orgId]);
    const h = "d".repeat(64);
    w.broker.repoContext = { commit: "3".repeat(40), hash: h, files: [{ path: "AGENTS.md", bytes: 12, sha256: h, inlined: true, truncated: false, content: "Test: pytest" }, { path: "CLAUDE.md", bytes: 9, sha256: h, inlined: false, truncated: false, withheld: "secret", secretHits: [{ line: 1, rule: "github-token" }] }] };
    const { runId } = await w.workOrderAt("WO-9020");
    await w.drain();
    const rc = (await w.q(`select data->'repoContext' as rc from runs where id = $1`, [runId]))[0].rc;
    expect(rc).toMatchObject({ commit: "3".repeat(40), hash: h, files: [{ path: "AGENTS.md", inlined: true, content: "Test: pytest" }, { path: "CLAUDE.md", withheld: "secret" }] });
    expect(rc.offeredAt).toEqual(expect.any(String));
    // an older broker that sends none is recorded as unavailable, not as an empty repository
    w.broker.repoContext = undefined;
    const { runId: r2 } = await w.workOrderAt("WO-9021");
    await w.drain();
    expect((await w.q(`select data->'repoContext' as rc from runs where id = $1`, [r2]))[0].rc).toMatchObject({ unavailable: true, files: [] });
  });

  it("pins the four-layer instruction composition, the skill versions and the version tuple on the run (spec 10.2)", async () => {
    await w.q(`update repos set guidelines = 'Use pnpm.' where org_id = $1 and id = 'payments-api'`, [w.orgId]);
    await w.q(`insert into repo_config (org_id, repo_id, data) values ($1,'payments-api','{"baseSha":"${"2".repeat(40)}"}') on conflict (org_id, repo_id) do update set data = excluded.data`, [w.orgId]);
    const { attemptId, runId } = await w.workOrderAt("WO-9010", { agent: "ag-build" });
    await w.drain();
    const run = (await w.q(`select data from runs where id = $1`, [runId]))[0].data;
    const tuple = (await w.q(`select t.* from attempts a join agent_version_tuples t on t.id = a.tuple_id where a.id = $1`, [attemptId]))[0];
    expect(tuple).toMatchObject({ agent_id: "ag-build", agent_version: 2 });
    expect(tuple.skill_versions).toEqual({ "sk-testdesign": expect.any(Number) });
    // the tuple's instruction hash is the hash of the whole composition, which the run records with its layer versions
    expect(run.promptManifest.hash).toBe(tuple.instruction_hash); // covers the skills and the runner text too, not only the layers
    expect(run.composed.hash).not.toBe(tuple.instruction_hash);
    expect(run.composed.layers.map((l: { name: string }) => l.name)).toEqual(["Factory base", "Project overlay", "Agent", "Repo guidelines (Gantry)"]);
    expect(run.composed.layers[0].version).toBe(4);
    expect(run.composed.skills).toEqual([{ id: "sk-testdesign", version: tuple.skill_versions["sk-testdesign"] }]);
    expect(run.composed.tupleId).toBe(tuple.id);
    expect(run.instructionPin).toMatchObject({ base: 4, agentVersion: 2, guidelines: { text: "Use pnpm." } });
  });

  it("is idempotent: a retry after a crash finds the running container and does not start a second one", async () => {
    const { runId } = await w.workOrderAt("WO-9002", { repo: null });
    await w.drain();
    expect(w.launcher.calls.filter((c) => c.op === "start")).toHaveLength(2);
    await w.enqueue("attempt.dispatch", { woId: "WO-9002", station: "build", attemptId: "ATT-WO-9002-build-1", fencing: Number((await w.q(`select fencing::text from attempts where wo_id = 'WO-9002'`))[0].fencing) }, { dedupeKey: "again" });
    await w.drain();
    expect(w.launcher.calls.filter((c) => c.op === "start")).toHaveLength(2);
    expect((await w.q(`select count(*)::int as n from run_tokens where run_id = $1`, [runId]))[0].n).toBe(1);
  });

  it("does nothing for a superseded attempt or under a stop", async () => {
    const a = await w.workOrderAt("WO-9003", { repo: null, dispatch: false });
    await w.q(`update attempts set state = 'superseded' where id = $1`, [a.attemptId]);
    await w.enqueue("attempt.dispatch", { woId: "WO-9003", station: "build", attemptId: a.attemptId, fencing: a.fencing });
    const b = await w.workOrderAt("WO-9004", { repo: null, dispatch: false });
    await w.q(`insert into stops (org_id, id, scope_type, wo_id, mode, reason, set_by) values ($1,'wo:WO-9004:1','wo','WO-9004','halt','x','p-asha')`, [w.orgId]);
    await w.enqueue("attempt.dispatch", { woId: "WO-9004", station: "build", attemptId: b.attemptId, fencing: b.fencing });
    await w.drain();
    expect(w.launcher.calls.filter((c) => c.op === "start")).toHaveLength(0);
    expect((await w.jobs("attempt.dispatch")).every((j) => j.status === "done")).toBe(true);
  });

  it("waits for room when the launcher is full, without failing the attempt", async () => {
    w.launcher.capacity = true;
    const { attemptId } = await w.workOrderAt("WO-9005", { repo: null });
    await w.worker.runner.tick();
    await w.worker.runner.drain();
    const js = await w.jobs("attempt.dispatch");
    expect(js.length).toBeGreaterThanOrEqual(2);
    expect(js[0]!.status).toBe("done");
    expect(js[0]!.result.deferred).toBe(1);
    expect((await w.q(`select state from attempts where id = $1`, [attemptId]))[0].state).toBe("queued");
  });

  it("a seed the broker cannot do is retried, then fails the attempt so the flow engine can decide", async () => {
    await w.q(`update repos set github_full_name = 'acme/payments-api' where org_id = $1 and id = 'payments-api'`, [w.orgId]);
    await w.q(`insert into repo_config (org_id, repo_id, data) values ($1,'payments-api','{"baseSha":"${"1".repeat(40)}"}') on conflict (org_id, repo_id) do update set data = excluded.data`, [w.orgId]);
    w.broker.failSeed = 99;
    const { attemptId } = await w.workOrderAt("WO-9006", { station: "build" });
    await w.drain(6);
    const att = (await w.q(`select state, outcome from attempts where id = $1`, [attemptId]))[0];
    expect(att.state).toBe("failed");
    expect(w.broker.count("seed")).toBe(5);
    // The prepared network and volume were torn down.
    expect(w.launcher.runs.size).toBe(0);
    // The reason stays on the run, so System health can say runs are not starting and why.
    const run = (await w.q(`select ended_at, data from runs where attempt_id = $1`, [attemptId]))[0];
    expect(run.ended_at).not.toBeNull();
    expect(run.data.endedBy).toBe("dispatch failed");
    expect(run.data.dispatchError.msg).toMatch(/could not be started/);
  });

  it("fails an agent with no model with a clear reason instead of running the stub", async () => {
    await w.close();
    w = await startWorld({ cfg: { allowStubAdapter: false } });
    await w.q(`insert into agents (org_id, id, name, live_version) values ($1,'ag-nomodel','No model',1)`, [w.orgId]);
    await w.q(`insert into agent_versions (org_id, agent_id, version, body, model_id, published_at) values ($1,'ag-nomodel',1,'{"instructions":"x"}'::jsonb,null,now())`, [w.orgId]);
    const { attemptId } = await w.workOrderAt("WO-9007", { repo: null, agent: "ag-nomodel" });
    await w.drain();
    expect(w.launcher.calls.filter((c) => c.op === "start" && c.body!.seedComplete === true)).toHaveLength(0);
    const att = (await w.q(`select state, outcome from attempts where id = $1`, [attemptId]))[0];
    expect(att).toMatchObject({ state: "failed", outcome: "failed" });
    // the reason is user-visible on the work order
    const wo = JSON.stringify((await w.q(`select data from work_orders where id = 'WO-9007'`))[0].data);
    expect(wo).toMatch(/no model/i);
  });

  it("still runs the stub when stubs are enabled on purpose (tests, local development)", async () => {
    await w.q(`insert into agents (org_id, id, name, live_version) values ($1,'ag-nomodel','No model',1)`, [w.orgId]);
    await w.q(`insert into agent_versions (org_id, agent_id, version, body, model_id, published_at) values ($1,'ag-nomodel',1,'{"instructions":"x"}'::jsonb,null,now())`, [w.orgId]);
    const { runId } = await w.workOrderAt("WO-9008", { repo: null, agent: "ag-nomodel" });
    await w.drain();
    expect((await w.q(`select data from runs where id = $1`, [runId]))[0].data).toMatchObject({ adapter: "stub", dispatch: { phase: "started" } });
  });

  // ---- Lifecycle gap 6 (statechart model: AnAgentThatIsOffNeverRuns): the station's agent must be on for its run to start.
  it("gap 6: an agent that was turned off after the attempt was queued does not run; the order goes to Needs a person with the way forward", async () => {
    await w.q(`update agents set status = 'paused' where org_id = $1 and id = 'ag-build'`, [w.orgId]);
    const { attemptId, runId } = await w.workOrderAt("WO-9040", { agent: "ag-build" });
    await w.drain();
    expect(w.launcher.calls.filter((c) => c.op === "start")).toHaveLength(0);
    expect(w.launcher.runs.has(runId)).toBe(false);
    expect((await w.q(`select count(*)::int as n from runs where id = $1`, [runId]))[0].n).toBe(0);
    expect((await w.q(`select state from attempts where id = $1`, [attemptId]))[0].state).toBe("cancelled");
    const wo = (await w.q(`select state, position, data from work_orders where id = 'WO-9040'`))[0];
    expect(wo).toMatchObject({ state: "parked", position: "person" });
    expect(wo.data.bayReason).toMatch(/agent is turned off; turn it on or reassign the station\./);
    expect(wo.data.bayReason).toContain("Build");
  });

  it("gap 6: a live version that was never promoted does not run either", async () => {
    await w.q(`update agents set data = data || '{"promoted": []}'::jsonb where org_id = $1 and id = 'ag-build'`, [w.orgId]);
    await w.workOrderAt("WO-9041", { agent: "ag-build" });
    await w.drain();
    expect(w.launcher.calls.filter((c) => c.op === "start")).toHaveLength(0);
    const wo = (await w.q(`select state, position, data from work_orders where id = 'WO-9041'`))[0];
    expect(wo).toMatchObject({ state: "parked", position: "person" });
    expect(wo.data.bayReason).toMatch(/eval suite/);
  });

  it("gap 10: the prompt hash recorded at dispatch names the prompt the run is given, repository context included", async () => {
    await w.q(`update repos set github_full_name = 'acme/payments-api' where org_id = $1 and id = 'payments-api'`, [w.orgId]);
    await w.q(`insert into repo_config (org_id, repo_id, data) values ($1,'payments-api','{"baseSha":"${"4".repeat(40)}"}') on conflict (org_id, repo_id) do update set data = excluded.data`, [w.orgId]);
    const h = "e".repeat(64);
    w.broker.repoContext = { commit: "4".repeat(40), hash: h, files: [{ path: "AGENTS.md", bytes: 12, sha256: h, inlined: true, truncated: false, content: "Test: pytest" }] };
    const { runId } = await w.workOrderAt("WO-9050", { agent: "ag-build" });
    await w.drain();
    const run = (await w.q(`select data from runs where id = $1`, [runId]))[0].data;
    expect(run.promptManifest.parts.map((p: { kind: string }) => p.kind)).toContain("repo_context");
    expect(run.promptHash).toBe(run.promptManifest.hash);
    expect(run.dispatchPromptHash).toBe(run.promptManifest.hash);
  });
});
