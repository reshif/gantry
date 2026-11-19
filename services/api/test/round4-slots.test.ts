import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { enterStation } from "../src/areas/workorders/engine.js";
import { saveWo, lockWo } from "../src/areas/workorders/model.js";

const d = TEST_URL ? describe : describe.skip;

/** S-32 and S-33: the coding slot limit is the count of live holders, and a change of the limit takes effect at once. */
d("round 4: coding slots follow the limit (S-32, S-33)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const proj = "payments";
  const setSlots = (n: number) => w.call("p-asha", "PATCH", `/api/v1/projects/${proj}/config`, { path: "flow.slots", value: n });
  const toBuild = (id: string) =>
    w.tx(async (tx) => {
      const fx = await w.fxIn(tx);
      const wo = await lockWo(tx, t.orgId, id);
      await enterStation(fx, wo, "build");
      await saveWo(tx, t.orgId, wo);
    });
  const pos = async (id: string) => (await w.q(`select position from work_orders where id = $1`, [id]))[0].position as string;
  const heldCount = async () => (await w.q(`select count(*)::int n from slots where project_id = $1 and state = 'held'`, [proj]))[0].n as number;
  const reset = async () => {
    await w.q(`update slots set state = 'free', wo_id = null where project_id = $1`, [proj]);
    await w.q(`update work_orders set state = 'done' where project_id = $1 and state <> 'done'`, [proj]);
  };

  it("S-32: raising the slots starts queued work at once, highest priority then oldest first", async () => {
    await reset();
    expect((await setSlots(1)).status).toBe(200);
    await w.insertWo("WO-9301", { position: "plan", state: "waiting", priority: "P2" });
    await w.insertWo("WO-9302", { position: "plan", state: "waiting", priority: "P2" });
    await w.insertWo("WO-9303", { position: "plan", state: "waiting", priority: "P0" });
    for (const id of ["WO-9301", "WO-9302", "WO-9303"]) await toBuild(id);
    expect(await pos("WO-9301")).toBe("build");
    expect([await pos("WO-9302"), await pos("WO-9303")]).toEqual(["queue", "queue"]);
    const r = await setSlots(2);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await pos("WO-9303")).toBe("build"); // the P0 takes the new slot, not the older P2
    expect(await pos("WO-9302")).toBe("queue");
    expect(await heldCount()).toBe(2);
    expect((await w.liveAttempt("WO-9303"))?.station).toBe("build");
    const r3 = await setSlots(5);
    expect(r3.status).toBe(200);
    expect(await pos("WO-9302")).toBe("build");
  });

  it("S-33: lowering the slots keeps the old holders running and starts no new builder until live holders are below the limit", async () => {
    await reset();
    expect((await setSlots(3)).status).toBe(200);
    const ids = ["WO-9311", "WO-9312", "WO-9313", "WO-9314"];
    for (const id of ids) await w.insertWo(id, { position: "plan", state: "waiting" });
    for (const id of ids) await toBuild(id);
    expect(await heldCount()).toBe(3);
    expect(await pos(ids[3]!)).toBe("queue");
    expect((await setSlots(1)).status).toBe(200);
    expect(await heldCount()).toBe(3); // nobody is cancelled
    const sendBack = async (id: string) => {
      const ver = (await w.get(id)).version;
      const r = await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/send-back`, { toStation: "spec", note: "Needs a clearer spec" }, w.ifm(ver));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    await sendBack(ids[0]!);
    expect(await heldCount()).toBe(2);
    expect(await pos(ids[3]!)).toBe("queue");
    await sendBack(ids[1]!);
    expect(await heldCount()).toBe(1);
    expect(await pos(ids[3]!)).toBe("queue");
    await sendBack(ids[2]!);
    expect(await pos(ids[3]!)).toBe("build");
    expect(await heldCount()).toBe(1);
  });
});
