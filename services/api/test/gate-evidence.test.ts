import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { openGate } from "../src/areas/workorders/engine.js";
import { lockWo } from "../src/areas/workorders/model.js";
import { applyStationResult } from "../src/areas/workorders/station.js";
import { readRecord } from "../src/areas/workorders/reads.js";
import { ciFact } from "../src/areas/internal/spec.js";

const d = TEST_URL ? describe : describe.skip;

/** An automatic gate judges evidence the system holds (GitHub check runs for the PR head), never the agent's own report, and no evidence is not a pass. */
d("automatic gates need real evidence", () => {
  let t: TestApp;
  const w = world(() => t);
  beforeAll(async () => {
    t = await startApp();
    expect((await w.call("p-asha", "PATCH", "/api/v1/projects/payments/config", { gate: "G4", mode: "auto" })).status).toBe(200);
  });
  afterAll(() => t.close());
  const open = (id: string, o: { headSha?: string; checks?: Array<{ name: string; ok: boolean }> } = {}) => w.tx(async (tx) => openGate(await w.fxIn(tx), await lockWo(tx, t.orgId, id), "G4", o));
  const decision = async (id: string) => (await w.q<{ decision: string; detail: any }>(`select decision, detail from gate_decisions where wo_id = $1 and rule like 'AUTO-%'`, [id]))[0] ?? null;
  const pr = async (id: string, n: number, sha: string, required: string[], runs: Array<[string, string, string | null]>) => {
    await w.q(`insert into repo_config (org_id, repo_id, required_checks) values ($1,'payments-api',$2) on conflict (org_id, repo_id) do update set required_checks = excluded.required_checks`, [t.orgId, required]);
    await w.q(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, head_sha) values ($1,$2,'payments-api',$3,$4,'t',$5)`, [t.orgId, `pr-${id}`, id, n, sha]);
    for (const [name, status, conclusion] of runs) await w.q(`insert into checks (org_id, id, repo_id, pr_id, head_sha, name, status, conclusion, github_id) values ($1,$2,'payments-api',$3,$4,$5,$6,$7,$8)`, [t.orgId, `ck-${id}-${name}`, `pr-${id}`, sha, name, status, conclusion, 7000 + n]);
  };

  it("no evidence at all: the gate waits for a person instead of passing", async () => {
    await w.insertWo("WO-9201", { position: "build", state: "running", data: { files: [{ path: "src/a.ts" }] } });
    await open("WO-9201");
    expect(await decision("WO-9201")).toBeNull();
    expect((await w.get("WO-9201")).state).toBe("waiting");
  });

  it("a red required check fails the gate and the evidence names the GitHub check", async () => {
    await w.insertWo("WO-9202", { position: "build", state: "running", data: { files: [{ path: "src/b.ts" }] } });
    await pr("WO-9202", 9202, "sha9202", ["ci/test"], [["ci/test", "completed", "failure"]]);
    await open("WO-9202");
    const dec = await decision("WO-9202");
    expect(dec?.decision).toBe("auto_failed");
    expect(dec?.detail.evidence).toMatchObject({ source: "github", githubCheckIds: ["16202"] });
  });

  it("a required check still running or absent is no evidence (wait); all green passes and records the check ids", async () => {
    await w.insertWo("WO-9203", { position: "build", state: "running", data: { files: [{ path: "src/c.ts" }] } });
    await pr("WO-9203", 9203, "sha9203", ["ci/test", "ci/lint"], [["ci/test", "completed", "success"], ["ci/lint", "in_progress", null]]);
    await open("WO-9203");
    expect(await decision("WO-9203")).toBeNull();
    await w.insertWo("WO-9204", { position: "build", state: "running", data: { files: [{ path: "src/d.ts" }] } });
    await pr("WO-9204", 9204, "sha9204", ["ci/test"], [["ci/test", "completed", "success"]]);
    await open("WO-9204");
    const dec = await decision("WO-9204");
    expect(dec?.decision).toBe("auto_passed");
    expect(dec?.detail.evidence).toMatchObject({ source: "github", headSha: "sha9204", githubCheckIds: ["16204"] });
  });

  it("a gate waiting for evidence reads the CI results when they arrive, and a person's vote is never overridden", async () => {
    const { recheckAutoGate } = await import("../src/areas/workorders/station.js");
    await w.insertWo("WO-9205", { position: "build", state: "running", data: { files: [{ path: "src/e.ts" }] } });
    await open("WO-9205");
    expect(await decision("WO-9205")).toBeNull();
    await pr("WO-9205", 9205, "sha9205", ["ci/test"], [["ci/test", "completed", "success"]]);
    expect((await w.tx((tx) => recheckAutoGate(tx, t.orgId, "WO-9205", "sha9205"))).reopened).toBe(true);
    expect((await decision("WO-9205"))?.decision).toBe("auto_passed");
    expect((await w.tx((tx) => recheckAutoGate(tx, t.orgId, "WO-9205", "sha9205"))).reopened).toBe(false);
  });

  it("no required checks configured: a lone completed check is not enough, a person decides", async () => {
    await w.insertWo("WO-9206", { position: "build", state: "running", data: { files: [{ path: "src/f.ts" }] } });
    await pr("WO-9206", 9206, "sha9206", [], [["ci/fast", "completed", "success"]]);
    await open("WO-9206");
    expect(await decision("WO-9206")).toBeNull();
    expect((await w.get("WO-9206")).state).toBe("waiting");
  });

  it("a required check written as ci/test is satisfied by GitHub's check run named test", async () => {
    await w.insertWo("WO-9210", { position: "build", state: "running", data: { files: [{ path: "src/h.ts" }] } });
    await pr("WO-9210", 9210, "sha9210", ["ci/test"], [["test", "completed", "success"]]);
    await open("WO-9210");
    expect((await decision("WO-9210"))?.decision).toBe("auto_passed");
  });

  it("Verify's report is recorded: counts from the runs it listed and a verdict per criterion", async () => {
    const id = await w.atStation("verify", "Verify records tests");
    const att = await w.liveAttempt(id);
    await w.tx((tx) => applyStationResult(tx, att!.id, Number(att!.fencing), { status: "succeeded", summary: "ran", output: { testsRun: [{ name: "test_a", command: "make test", result: "pass" }, { name: "test_b", command: "make test", result: "pass" }, { name: "test_c", command: "make test", result: "fail" }], criteria: [{ criterion: "x", result: "pass", evidence: "test_a" }] } } as never));
    const row = await w.get(id);
    expect((row as any).tests).toMatchObject({ passed: 2, failed: 1, added: 0 });
    expect((row as any).verification.criteria[0]).toMatchObject({ result: "pass" });
  });

  it("the record page shows Verify's per-criterion verdicts and test counts (the read path, not only the stored row), and a failing observed run overrides a claimed pass", async () => {
    const id = await w.atStation("verify", "Verify shows on the record");
    await w.q(`update work_orders set data = data || $3::jsonb where org_id = $1 and id = $2`, [t.orgId, id, JSON.stringify({ brief: { goal: "g", scopeIn: [], scopeOut: [], ac: ["Lists devices", "Handles empty"], risks: [], open: [], decisions: [], estimate: "M", route: [], children: [] } })]);
    const att = await w.liveAttempt(id);
    await w.tx((tx) => applyStationResult(tx, att!.id, Number(att!.fencing), { status: "succeeded", summary: "ran", output: { testsRun: [{ name: "test_lists", command: "make test", result: "pass", ms: 12 }, { name: "test_empty", command: "make test", result: "fail" }], criteria: [{ criterion: "Lists devices", result: "pass", evidence: "test_lists passed" }, { criterion: "Handles empty", result: "pass", evidence: "test_empty passed" }] } } as never));
    const rec = await w.tx((tx) => readRecord(tx, t.orgId, id));
    expect(rec!.code.tests).toMatchObject({ passed: 1, failed: 1, added: 0 });
    expect(rec!.criteria!.slice(0, 2).map((c) => c.status)).toEqual(["met", "not met"]);
    expect(rec!.criteria![0]!.tests).toEqual([{ name: "test_lists", result: "pass", ms: 12 }]);
  });

  it("a station is handed GitHub's own check results for the PR head, and a note instead of a failure when there are none", async () => {
    await w.insertWo("WO-9211", { position: "verify", state: "running" });
    await pr("WO-9211", 9211, "sha9211", ["ci/test"], [["test", "completed", "success"]]);
    const f = await w.tx((tx) => ciFact(tx, { orgId: t.orgId, woId: "WO-9211" } as never));
    expect(f).toMatchObject({ observedBy: "github", pullRequest: 9211, headSha: "sha9211", requiredChecks: ["ci/test"], checkRuns: [{ name: "test", status: "completed", conclusion: "success", required: true }] });
    await w.insertWo("WO-9212", { position: "verify", state: "running" });
    await pr("WO-9212", 9212, "sha9212", ["ci/test"], []);
    expect(await w.tx((tx) => ciFact(tx, { orgId: t.orgId, woId: "WO-9212" } as never))).toMatchObject({ checkRuns: [], note: expect.stringContaining("not a failure") });
    await w.insertWo("WO-9213", { position: "verify", state: "running" });
    expect(await w.tx((tx) => ciFact(tx, { orgId: t.orgId, woId: "WO-9213" } as never))).toBeNull();
  });

  it("an empty observed checks list is not evidence", async () => {
    await w.insertWo("WO-9207", { position: "build", state: "running", data: { files: [{ path: "src/g.ts" }] } });
    await open("WO-9207", { checks: [] });
    expect(await decision("WO-9207")).toBeNull();
    expect((await w.get("WO-9207")).state).toBe("waiting");
  });

  it("an agent-reported all-green output.checks cannot pass an automatic gate (G1f)", async () => {
    const id = await w.atStation("research", "Agent claims green");
    const att = await w.liveAttempt(id);
    const r = await w.tx((tx) => applyStationResult(tx, att!.id, Number(att!.fencing), { status: "succeeded", summary: "done", output: { checks: [{ name: "Research note attached", ok: true }, { name: "No blocking unknowns", ok: true }] } } as never));
    expect(r.applied).toBe(true);
    // the station wrote no research note, so the claim is not believed: the gate fails on what the system holds
    expect((await decision(id))?.decision).toBe("auto_failed");
    expect((await w.get(id)).state).toBe("failed");
  });
});
