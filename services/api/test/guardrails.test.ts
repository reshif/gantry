import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { openGate } from "../src/areas/workorders/engine.js";
import { lockWo } from "../src/areas/workorders/model.js";

const d = TEST_URL ? describe : describe.skip;

/** Guardrails are checked in code from the files the system saw, not left to the agent's prompt (spec 13.3). */
d("guardrails enforced from observed files", () => {
  let t: TestApp;
  const w = world(() => t);
  beforeAll(async () => {
    t = await startApp();
    expect((await w.call("p-asha", "PATCH", "/api/v1/projects/payments/config", { gate: "G4", mode: "auto" })).status).toBe(200);
  });
  afterAll(() => t.close());
  const guardrail = async (id: string) => (await w.q<{ g: any }>(`select data->'guardrail' as g from work_orders where id = $1`, [id]))[0]?.g;

  it("a build that touches a protected path or exceeds the agent's maxDiff is recorded as a breach", async () => {
    const id = await w.atStation("build", "Guardrail breach");
    const att = (await w.liveAttempt(id))!;
    const agent = (await w.q<{ a: string }>(`select data->>'agent' as a from attempts where id = $1`, [att.id]))[0]!.a;
    await w.q(`update agents set data = jsonb_set(data, '{guardrails}', '{"paths":["infra/**"],"maxDiff":10}'::jsonb) where id = $1`, [agent]);
    await w.q(`insert into repo_config (org_id, repo_id, protected_paths) values ($1,'payments-api','{src/secret/**}') on conflict (org_id, repo_id) do update set protected_paths = excluded.protected_paths`, [t.orgId]);
    const r = await w.apply(att, { status: "succeeded", summary: "built", observed: { files: [{ path: "src/secret/key.ts", additions: 30, deletions: 0 }, { path: "infra/main.tf", additions: 1, deletions: 0 }] } });
    expect(r.applied).toBe(true);
    expect(await guardrail(id)).toMatchObject({ over: true, size: 31, protectedTouched: ["src/secret/key.ts"], forbiddenTouched: ["infra/main.tf"] });
  });

  it("the recorded diff is what the platform observed in the published commits, never the agent's own files list", async () => {
    const a = await w.atStation("build", "Observed diff");
    const attA = (await w.liveAttempt(a))!;
    await w.apply(attA, { status: "succeeded", summary: "built", output: { files: [{ path: "claimed.ts", additions: 999, deletions: 5 }] }, observed: { files: [{ path: "README.md", additions: 1, deletions: 1 }] } });
    expect((await w.q<{ d: any; f: any }>(`select data->'diff' as d, data->'files' as f from work_orders where id = $1`, [a]))[0]).toEqual({ d: { plus: 1, minus: 1, files: 1 }, f: [{ path: "README.md", plus: 1, minus: 1 }] });
    // no platform observation: the agent's claim is not recorded as stats
    const b = await w.atStation("build", "Claimed diff only");
    const attB = (await w.liveAttempt(b))!;
    await w.apply(attB, { status: "succeeded", summary: "built", output: { files: [{ path: "claimed.ts", additions: 999, deletions: 5 }] } });
    expect((await w.q<{ d: any; f: any }>(`select data->'diff' as d, data->'files' as f from work_orders where id = $1`, [b]))[0]).toEqual({ d: { plus: 0, minus: 0, files: 0 }, f: null });
  });

  it("a guardrail breach sends an automatic gate to a person even when every check is green", async () => {
    await w.insertWo("WO-9301", { position: "build", state: "running", data: { files: [{ path: "src/a.ts" }], guardrail: { over: true, size: 500, protectedTouched: [], forbiddenTouched: [] } } });
    await w.tx(async (tx) => openGate(await w.fxIn(tx), await lockWo(tx, t.orgId, "WO-9301"), "G4", { checks: [{ name: "Required checks", ok: true }] }));
    expect(await w.q(`select 1 from gate_decisions where wo_id = 'WO-9301'`)).toHaveLength(0);
    expect((await w.get("WO-9301")).state).toBe("waiting");
    await w.insertWo("WO-9302", { position: "build", state: "running", data: { files: [{ path: "src/a.ts" }] } });
    await w.tx(async (tx) => openGate(await w.fxIn(tx), await lockWo(tx, t.orgId, "WO-9302"), "G4", { checks: [{ name: "Required checks", ok: true }] }));
    expect(await w.q(`select 1 from gate_decisions where wo_id = 'WO-9302' and decision = 'auto_passed'`)).toHaveLength(1);
  });

  it("G-X1: a convention file written in Build round 1 keeps the repo-conventions tag after a round 2 that does not touch it, and the automatic gate waits for a person", async () => {
    // round 1 published AGENTS.md and src/a.ts; round 2 published only src/a.ts: `files` is the latest publish, `paths` is everything the work order changed
    await w.insertWo("WO-9303", { position: "build", state: "running", data: { files: [{ path: "src/a.ts" }], paths: ["AGENTS.md", "src/a.ts"] } });
    await w.tx(async (tx) => openGate(await w.fxIn(tx), await lockWo(tx, t.orgId, "WO-9303"), "G4", { checks: [{ name: "Required checks", ok: true }] }));
    expect(await w.q(`select 1 from gate_decisions where wo_id = 'WO-9303'`)).toHaveLength(0);
    const basis = (await w.q<{ basis: { riskTags: string[]; forcedHuman: boolean } }>(`select basis from gate_instances where wo_id = 'WO-9303' order by opened_at desc limit 1`))[0]!.basis;
    expect(basis.riskTags).toContain("repo-conventions");
    expect(basis.forcedHuman).toBe(true);
    // the same gap closed for the other path tags: a migration or workflow written in round 1
    await w.insertWo("WO-9304", { position: "build", state: "running", data: { files: [{ path: "src/a.ts" }], paths: ["db/migrations/001.sql", ".github/workflows/ci.yml", "src/a.ts"] } });
    await w.tx(async (tx) => openGate(await w.fxIn(tx), await lockWo(tx, t.orgId, "WO-9304"), "G4", { checks: [{ name: "Required checks", ok: true }] }));
    const b2 = (await w.q<{ basis: { riskTags: string[] } }>(`select basis from gate_instances where wo_id = 'WO-9304' order by opened_at desc limit 1`))[0]!.basis;
    expect(b2.riskTags).toEqual(expect.arrayContaining(["migration", "ci"]));
  });
});
