import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { reconcileStop } from "../src/areas/stops/enforce.js";

const d = TEST_URL ? describe : describe.skip;

/** S-34: layered kills (factory and project) lifted in any order revive the work order once the last one is lifted. */
d("round 4: layered kills restored in any order (S-34)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const stop = (who: string, body: object) => w.call(who, "POST", "/api/v1/stops", body);
  const restore = (who: string, id: string) => w.call(who, "POST", `/api/v1/stops/${encodeURIComponent(id)}/restore`, { reason: "The incident is over" });
  const reconcile = (id: string) => w.tx((tx) => reconcileStop(tx, id));
  const projectName = async () => (await w.q(`select name from projects where id = 'payments'`))[0].name as string;
  const factoryKill = async (inFlight: "cancel" | "hold") => {
    const r = await stop("p-asha", { scope: "factory", mode: "kill", reason: "Layered factory kill", confirmText: "KILL FACTORY", inFlight });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await reconcile(String(r.body.stop));
    return String(r.body.stop);
  };
  const projectKill = async (inFlight: "cancel" | "hold") => {
    const r = await stop("p-asha", { scope: "project", id: "payments", mode: "kill", reason: "Layered project kill", confirmText: await projectName(), inFlight });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await reconcile(String(r.body.stop));
    return String(r.body.stop);
  };
  const restoreProject = async (stopId: string) => {
    expect((await restore("p-asha", "project:payments")).status).toBe(200);
    await reconcile(stopId);
  };
  const restoreFactory = async (stopId: string) => {
    expect((await restore("p-asha", "factory:")).status).toBe(200);
    expect((await restore("p-omar", "factory:")).status).toBe(200);
    await reconcile(stopId);
  };

  for (const order of ["factory-first", "project-first"] as const) {
    it(`cancel + cancel, restored ${order}: the order is revived at its last station`, async () => {
      const id = await w.atStation("research", `Cancel layers ${order}`);
      const f = await factoryKill("cancel");
      const p = await projectKill("cancel");
      expect((await w.get(id)).state).toBe("killed");
      if (order === "factory-first") {
        await restoreFactory(f);
        expect((await w.get(id)).state).toBe("killed"); // the project kill still covers it
        await restoreProject(p);
      } else {
        await restoreProject(p);
        expect((await w.get(id)).state).toBe("killed");
        await restoreFactory(f);
      }
      const back = await w.get(id);
      expect(back.state).toBe("running");
      expect((await w.liveAttempt(id))?.station).toBe("research");
      expect((await w.q(`select count(*)::int n from stops where lifted_at is null`))[0].n).toBe(0);
    });

    it(`hold + hold, restored ${order}: the order is resumed with a fresh attempt`, async () => {
      const id = await w.atStation("research", `Hold layers ${order}`);
      const f = await factoryKill("hold");
      const p = await projectKill("hold");
      expect(await w.liveAttempt(id)).toBeUndefined();
      if (order === "factory-first") {
        await restoreFactory(f);
        expect(await w.liveAttempt(id)).toBeUndefined();
        await restoreProject(p);
      } else {
        await restoreProject(p);
        expect(await w.liveAttempt(id)).toBeUndefined();
        await restoreFactory(f);
      }
      expect((await w.liveAttempt(id))?.station).toBe("research");
      expect((await w.q(`select data from work_orders where id = $1`, [id]))[0].data.heldByKill).toBeUndefined();
    });
  }

  it("project hold under a factory cancel, and a factory hold under a project cancel, also revive", async () => {
    const id = await w.atStation("research", "Mixed layers");
    const f = await factoryKill("hold");
    const p = await projectKill("cancel");
    await restoreProject(p);
    await restoreFactory(f);
    expect((await w.get(id)).state).toBe("running");
    expect((await w.liveAttempt(id))?.station).toBe("research");
  });
});
