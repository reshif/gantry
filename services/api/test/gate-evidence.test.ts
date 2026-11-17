import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { openGate } from "../src/areas/workorders/engine.js";
import { lockWo } from "../src/areas/workorders/model.js";
import { applyStationResult } from "../src/areas/workorders/station.js";

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
