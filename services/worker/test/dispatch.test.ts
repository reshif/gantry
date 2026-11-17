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
    expect(run.composed.hash).toBe(tuple.instruction_hash);
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
  });
});
