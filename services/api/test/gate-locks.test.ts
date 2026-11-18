import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

/** Owner decision 2026-11-19: a Factory Admin can switch off the locked gates (not G5) with a reason, audited; G5 stays a person's decision for everyone. */
d("Factory Admin overrides the gate locks, except G5", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);

  const cfg = (who: string, project: string, path: string, value: unknown, reason?: string) =>
    w.call(who, "PATCH", `/api/v1/projects/${project}/config`, { path, value, ...(reason === undefined ? {} : { reason }) });
  const gate = (who: string, project: string, g: string, on: boolean, reason?: string) => cfg(who, project, `flow.gates.${g}.enabled`, on, reason);
  const mode = (who: string, project: string, g: string, m: string, reason?: string) => w.call(who, "PATCH", `/api/v1/projects/${project}/config`, { gate: g, mode: m, ...(reason === undefined ? {} : { reason }) });
  const proj = async (id: string, who = "p-asha") => (await w.call(who, "GET", `/api/v1/projects/${id}`)).body;
  const stationNow = async (id: string) => {
    const wo = await w.get(id);
    const st = (await w.call("p-asha", "GET", "/api/v1/catalog")).body.stations as Array<{ id: string }>;
    return { wo, station: st[wo.station]?.id };
  };
  const REASON = "Owner asked: no gate for this experiment";

  it("an admin switches off G4 with a reason: audited flow.override event and a visible marker", async () => {
    const r = await gate("p-asha", "payments", "G4", false, REASON);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.msg).toMatch(/turned off by Factory Admin override/);
    const e = (await w.events("flow.override")).at(-1)!;
    expect(e.project_id).toBe("payments");
    expect(e.before).toMatchObject({ project: "payments", gate: "G4", enabled: true });
    expect(e.after).toMatchObject({ project: "payments", gate: "G4", enabled: false, override: true, reason: REASON });
    const p = await proj("payments");
    expect(p.flow.gates.G4.enabled).toBe(false);
    expect(p.flow.gates.G4.override.off).toMatchObject({ by: "p-asha", reason: REASON });
    expect(typeof p.flow.gates.G4.override.off.at).toBe("number");
    expect(p.flowOverride.locks.G4).toMatchObject({ locked: true, overridable: true, viewerMayOverride: true, overridden: { by: "p-asha", reason: REASON } });
  });

  it("G4 off: a work order goes from Verify straight to Review", async () => {
    const id = (await w.submit("p-tomas", { title: "No G4 on this one" })).body.id as string;
    await w.answerAll(id);
    expect((await w.confirm(id)).status).toBe(200);
    const st = (await w.call("p-asha", "GET", "/api/v1/catalog")).body.stations as Array<{ id: string }>;
    await w.walk(id, (x) => st[x.station]?.id === "review");
    expect((await w.q(`select 1 from gate_instances where wo_id = $1 and gate_id = 'G4'`, [id])).length).toBe(0);
    expect((await stationNow(id)).wo.state).not.toBe("failed");
  });

  it("the read model shows the lock to a non-admin without an override right, and an admin who switches it back on clears the marker", async () => {
    const asEngineer = (await proj("payments", "p-tomas")).flowOverride;
    expect(asEngineer.viewerMayOverride).toBe(false);
    expect(asEngineer.locks.G4.viewerMayOverride).toBe(false);
    expect(asEngineer.locks.G5).toMatchObject({ locked: true, overridable: false, viewerMayOverride: false });
    expect((await proj("payments")).flowOverride.locks.G5).toMatchObject({ locked: true, overridable: false, viewerMayOverride: false });
    const on = await gate("p-asha", "payments", "G4", true);
    expect(on.status).toBe(200);
    const p = await proj("payments");
    expect(p.flow.gates.G4.override).toBeUndefined();
    expect(p.flowOverride.locks.G4.overridden).toBeNull();
  });

  it("without a reason the admin is told to give one: needs override_reason, kind gate_lock, naming the lock", async () => {
    for (const reason of [undefined, "too short"]) {
      const r = await gate("p-asha", "payments", "G4", false, reason);
      expect(r.status).toBe(403);
      expect(r.body.needs).toBe("override_reason");
      expect(r.body.overrideKind).toBe("gate_lock");
      expect(String(r.body.msg)).toMatch(/Checks green/);
      expect(String(r.body.msg)).toMatch(/required checks/i);
    }
    expect((await proj("payments")).flow.gates.G4.enabled).toBe(true);
  });

  it("a non-admin is refused as before, even with a reason", async () => {
    const r = await gate("p-daniel", "payments", "G4", false, REASON);
    expect(r.status).toBe(409);
    expect(String(r.body.msg)).toMatch(/cannot be turned off/);
    const m = await mode("p-daniel", "payments", "G3G3s", "auto", REASON);
    expect(m.status).toBe(422);
    expect((await proj("payments")).flow.gates.G4.enabled).toBe(true);
  });

  it("G5 is refused even for an admin with a reason, as a gate and as its station; and never automatic", async () => {
    for (const r of [await gate("p-asha", "payments", "G5", false, REASON), await cfg("p-asha", "payments", "flow.stations.review.enabled", false, REASON)]) {
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(String(r.body.msg)).toMatch(/No agent merges on its own authority|invariant I1/);
    }
    for (const m of ["auto", "mixed"]) {
      const r = await mode("p-asha", "payments", "G5", m, REASON);
      expect(r.status, m).toBe(422);
    }
    const p = await proj("payments");
    expect(p.flow.gates.G5.enabled).toBe(true);
    expect(p.flow.stations.review.enabled).toBe(true);
  });

  it("G3G3s off: Plan goes straight to Build", async () => {
    expect((await gate("p-asha", "payments", "G3G3s", false, REASON)).status).toBe(200);
    const id = (await w.submit("p-tomas", { title: "No plan gate on this one" })).body.id as string;
    await w.answerAll(id);
    expect((await w.confirm(id)).status).toBe(200);
    const st = (await w.call("p-asha", "GET", "/api/v1/catalog")).body.stations as Array<{ id: string }>;
    await w.walk(id, (x) => st[x.station]?.id === "build" && !x.bay);
    expect((await w.q(`select 1 from gate_instances where wo_id = $1 and gate_id = 'G3G3s'`, [id])).length).toBe(0);
    expect((await w.q(`select 1 from gate_decisions where wo_id = $1 and decision = 'auto_failed'`, [id])).length).toBe(0);
    expect((await gate("p-asha", "payments", "G3G3s", true)).status).toBe(200);
  });

  it("G0G1 off: the work order passes from Intake to Research without a person confirming", async () => {
    expect((await gate("p-asha", "payments", "G0G1", false, REASON)).status).toBe(200);
    const id = (await w.submit("p-tomas", { title: "No brief gate on this one" })).body.id as string;
    await w.answerAll(id);
    const { wo, station } = await stationNow(id);
    expect(station).toBe("research");
    expect(wo.state).toBe("running");
    expect((await w.q(`select 1 from gate_instances where wo_id = $1 and gate_id = 'G0G1' and status = 'open'`, [id])).length).toBe(0);
    const dec = (await w.q(`select decision, decided_by, rule, detail from gate_decisions where wo_id = $1 and rule = 'OVERRIDE-G0G1'`, [id]))[0];
    expect(dec).toMatchObject({ decision: "auto_passed", decided_by: null });
    expect(dec.detail).toMatchObject({ override: true, overrideBy: "p-asha", reason: REASON });
    expect((await w.q(`select confirmed_by from brief_versions where wo_id = $1`, [id]))[0]).toMatchObject({ confirmed_by: "system" });
    // the confirm endpoint has nothing left to confirm; the work order is not stuck
    expect((await w.confirm(id)).status).toBeGreaterThanOrEqual(400);
    // a work order that is not finished with its conversation still waits for it
    const id2 = (await w.submit("p-tomas", { title: "Still answering" })).body.id as string;
    expect((await stationNow(id2)).station).toBe("intake");
    // an epic's children keep recording G0G1 themselves
    expect((await gate("p-asha", "payments", "G0G1", true)).status).toBe(200);
  });

  it("a mode change of a locked gate by an admin works with a reason; G0G1 to auto is refused (no checks), G5 is refused", async () => {
    const none = await mode("p-asha", "payments", "G3G3s", "auto");
    expect(none.status).toBe(403);
    expect(none.body.needs).toBe("override_reason");
    expect(none.body.overrideKind).toBe("gate_lock");
    const ok = await mode("p-asha", "payments", "G3G3s", "auto", REASON);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const p = await proj("payments");
    expect(p.flow.gates.G3G3s.mode).toBe("auto");
    expect(p.flow.gates.G3G3s.override.mode).toMatchObject({ by: "p-asha", reason: REASON, from: "mixed" });
    expect((await w.events("flow.override")).at(-1)!.after).toMatchObject({ gate: "G3G3s", mode: "auto", override: true, reason: REASON });
    // a human gate without checks would pass with no evidence: a correctness rule, not a permission one
    const g01 = await mode("p-asha", "payments", "G0G1", "auto", REASON);
    expect(g01.status).toBe(422);
    expect(String(g01.body.msg)).toMatch(/no automatic checks/);
    expect((await mode("p-asha", "payments", "G5", "auto", REASON)).status).toBe(422);
    expect((await mode("p-asha", "payments", "G3G3s", "mixed", REASON)).status).toBe(200);
  });

  it("a regulated project: the admin switches off G2 with a reason, and not without one; G5 stays", async () => {
    await t.db.admin.query(`update projects set regulated = true where id = 'storefront'`);
    const none = await gate("p-asha", "storefront", "G2", false);
    expect(none.status).toBe(403);
    expect(none.body.needs).toBe("override_reason");
    expect(String(none.body.msg)).toMatch(/Regulated projects keep every gate on/);
    const ok = await gate("p-asha", "storefront", "G2", false, REASON);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await proj("storefront")).flow.gates.G2.override.off).toMatchObject({ by: "p-asha", reason: REASON });
    expect((await gate("p-daniel", "storefront", "G3d", false, REASON)).status).toBe(409);
    expect((await gate("p-asha", "storefront", "G5", false, REASON)).status).toBe(409);
  });
});
