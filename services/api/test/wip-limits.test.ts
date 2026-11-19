import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { advance, enterStation, finish, flushFx } from "../src/areas/workorders/engine.js";
import { lockWo, saveWo } from "../src/areas/workorders/model.js";

const d = TEST_URL ? describe : describe.skip;

/** Per-station WIP limits are enforced: a full station keeps the next order waiting where it is, and a place that frees lets the next one in. */
d("station WIP limits", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const proj = "payments";
  const setWip = (n: number, station = "verify") => w.call("p-asha", "PATCH", `/api/v1/projects/${proj}/config`, { path: `flow.stations.${station}.wip`, value: n });
  const setSlots = (n: number) => w.call("p-asha", "PATCH", `/api/v1/projects/${proj}/config`, { path: "flow.slots", value: n });
  const pos = async (id: string) => (await w.q(`select position, state, data from work_orders where id = $1`, [id]))[0] as { position: string; state: string; data: Record<string, any> };
  const liveAt = async (station: string) => (await w.q(`select count(*)::int n from work_orders where project_id = $1 and position = $2 and state in ('running','waiting')`, [proj, station]))[0].n as number;
  const held = async () => (await w.q(`select count(*)::int n from slots where project_id = $1 and state = 'held'`, [proj]))[0].n as number;
  /** The order finishes Build and moves on (the engine's own advance, as the worker does it). */
  const finishBuild = (id: string) =>
    w.tx(async (tx) => {
      const fx = await w.fxIn(tx);
      const wo = await lockWo(tx, t.orgId, id);
      await advance(fx, wo, "system");
      await saveWo(tx, t.orgId, wo);
      await flushFx(fx);
    });
  const toBuild = (id: string) =>
    w.tx(async (tx) => {
      const fx = await w.fxIn(tx);
      const wo = await lockWo(tx, t.orgId, id);
      await enterStation(fx, wo, "build");
      await saveWo(tx, t.orgId, wo);
    });
  const reset = async () => {
    await w.q(`update slots set state = 'free', wo_id = null where project_id = $1`, [proj]);
    await w.q(`update work_orders set state = 'done' where project_id = $1 and state <> 'done'`, [proj]);
    expect((await setSlots(8)).status).toBe(200);
    expect((await setWip(0)).status).toBe(200);
  };
  /** An order at Build holding a coding slot, ready to finish. */
  const building = async (id: string, priority = "P2") => {
    await w.insertWo(id, { position: "plan", state: "waiting", priority });
    await toBuild(id);
  };
  const inVerify = (id: string) => w.insertWo(id, { position: "verify", state: "waiting" });
  const evs = (type: string, id: string) => w.q(`select after from events where type = $1 and wo_id = $2 order by seq`, [type, id]);

  it("a full station keeps the order waiting where it is, holds no coding slot, and says why", async () => {
    await reset();
    await setWip(1);
    await inVerify("WO-9401");
    await building("WO-9402");
    expect(await held()).toBe(1);
    await finishBuild("WO-9402");
    const b = await pos("WO-9402");
    expect([b.position, b.state]).toEqual(["build", "waiting"]);
    expect(b.data.wipWait).toMatchObject({ station: "verify", live: 1, limit: 1 });
    expect(b.data.blockReason).toBe("Waiting: Verify is full (1/1)");
    expect(await held()).toBe(0);
    expect(await evs("wo.wip.wait", "WO-9402")).toHaveLength(1);
    const wo = await w.get("WO-9402");
    expect(wo.wipWait).toMatchObject({ station: "verify", live: 1, limit: 1 });
    await w.q(`update work_orders set state = 'done' where id = 'WO-9401'`); // an occupant that left without the engine: the read shows today's count, not the one from when it began to wait
    expect((await w.get("WO-9402")).wipWait).toMatchObject({ live: 0, limit: 1 });
    expect(wo.allowed.moves.verify.allowed).toBe(false);
    expect(wo.log.some((l: { text: string }) => l.text.includes("Verify is full (1/1)"))).toBe(true);
  });

  it("a WIP of 0 means no limit", async () => {
    await reset();
    await inVerify("WO-9411");
    await inVerify("WO-9412");
    await building("WO-9413");
    await finishBuild("WO-9413");
    expect((await pos("WO-9413")).position).toBe("verify");
    expect(await liveAt("verify")).toBe(3);
  });

  it("a coding slot freed by the waiting order goes to the Queue at once", async () => {
    await reset();
    await setSlots(1);
    await setWip(1);
    await inVerify("WO-9421");
    await building("WO-9422");
    await w.insertWo("WO-9423", { position: "plan", state: "waiting" });
    await toBuild("WO-9423");
    expect((await pos("WO-9423")).position).toBe("queue");
    await finishBuild("WO-9422");
    expect((await pos("WO-9422")).state).toBe("waiting");
    expect((await pos("WO-9423")).position).toBe("build");
    expect(await held()).toBe(1);
  });

  it("a place frees when an order leaves, is parked or is declined: the highest priority waiter goes in, then the oldest", async () => {
    await reset();
    await setWip(1);
    await inVerify("WO-9431");
    for (const [id, p] of [["WO-9432", "P2"], ["WO-9433", "P2"], ["WO-9434", "P0"]] as const) {
      await building(id, p);
      await finishBuild(id);
    }
    expect((await pos("WO-9432")).data.wipWait).toBeTruthy();
    // park the occupant: the P0 goes in, not the older P2
    const park = await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9431/park`, { bay: "hold", reason: "Needs a person to look at it" });
    expect(park.status, JSON.stringify(park.body)).toBe(200);
    expect((await pos("WO-9434")).position).toBe("verify");
    expect((await pos("WO-9432")).state).toBe("waiting");
    expect((await evs("wo.wip.enter", "WO-9434"))).toHaveLength(1);
    // decline the occupant: the oldest waiter goes in
    const decl = await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9434/park`, { bay: "declined", reason: "Not needed any more" });
    expect(decl.status, JSON.stringify(decl.body)).toBe(200);
    expect((await pos("WO-9432")).position).toBe("verify");
    expect((await pos("WO-9433")).state).toBe("waiting");
    // the occupant is released (done): the last one goes in
    await w.tx(async (tx) => {
      const fx = await w.fxIn(tx);
      const wo = await lockWo(tx, t.orgId, "WO-9432");
      await finish(fx, wo, "system");
      await saveWo(tx, t.orgId, wo);
      await flushFx(fx);
    });
    expect((await pos("WO-9433")).position).toBe("verify");
    expect(await liveAt("verify")).toBe(1);
  });

  it("raising the limit moves waiters in at once, only as many as there is room for", async () => {
    await reset();
    await setWip(1);
    await inVerify("WO-9441");
    for (const id of ["WO-9442", "WO-9443", "WO-9444"]) {
      await building(id);
      await finishBuild(id);
    }
    expect(await liveAt("verify")).toBe(1);
    const r = await setWip(3);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await liveAt("verify")).toBe(3);
    expect((await pos("WO-9442")).position).toBe("verify");
    expect((await pos("WO-9443")).position).toBe("verify");
    expect((await pos("WO-9444")).state).toBe("waiting");
    // lifting the limit altogether (0) lets the rest in
    expect((await setWip(0)).status).toBe(200);
    expect((await pos("WO-9444")).position).toBe("verify");
  });

  it("lowering the limit never evicts anyone; it only stops new entries until the count is below the limit", async () => {
    await reset();
    await inVerify("WO-9451");
    await inVerify("WO-9452");
    await inVerify("WO-9453");
    expect((await setWip(1)).status).toBe(200);
    expect(await liveAt("verify")).toBe(3);
    await building("WO-9454");
    await finishBuild("WO-9454");
    expect((await pos("WO-9454")).state).toBe("waiting");
    await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9451/park`, { bay: "hold", reason: "Parked to free a place" });
    await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9452/park`, { bay: "hold", reason: "Parked to free a place" });
    expect((await pos("WO-9454")).state).toBe("waiting"); // 1 live, limit 1
    await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9453/park`, { bay: "hold", reason: "Parked to free a place" });
    expect((await pos("WO-9454")).position).toBe("verify");
  });

  it("two orders finishing at once for one free place: exactly one goes in", async () => {
    await reset();
    await setWip(1);
    for (const id of ["WO-9461", "WO-9462"]) await building(id);
    await Promise.all([finishBuild("WO-9461"), finishBuild("WO-9462")]);
    expect(await liveAt("verify")).toBe(1);
    const states = [await pos("WO-9461"), await pos("WO-9462")].map((x) => `${x.position}:${x.state}`).sort();
    expect(states).toEqual(["build:waiting", "verify:running"]);
    expect(await held()).toBe(0);
  });

  it("the limit raised while orders wait, with another finishing in the same moment: no order is lost and the limit holds", async () => {
    await reset();
    await setWip(1);
    await inVerify("WO-9471");
    for (const id of ["WO-9472", "WO-9473"]) {
      await building(id);
      await finishBuild(id);
    }
    await building("WO-9474");
    const [r] = await Promise.all([setWip(2), finishBuild("WO-9474")]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await liveAt("verify")).toBe(2);
    const waiting = (await w.q(`select id from work_orders where project_id = $1 and state = 'waiting' and data ? 'wipWait'`, [proj])).length;
    expect(waiting).toBe(2);
    await setWip(0);
    expect(await liveAt("verify")).toBe(4);
  });

  it("a Factory Admin moves one waiting order in anyway with an audited reason; others cannot", async () => {
    await reset();
    await setWip(1);
    await inVerify("WO-9481");
    await building("WO-9482");
    await finishBuild("WO-9482");
    const url = "/api/v1/work-orders/WO-9482/wip-override";
    const wo = await w.get("WO-9482", "p-asha");
    expect(wo.allowed.wipOverride.allowed).toBe(true);
    expect((await w.get("WO-9482", "p-meera")).allowed.wipOverride.allowed).toBe(false);
    const denied = await w.call("p-meera", "POST", url, { reason: "Because I would like it to go" });
    expect(denied.status).toBe(403);
    const noReason = await w.call("p-asha", "POST", url, { reason: "no" });
    expect(noReason.status).toBe(403);
    expect(noReason.body.needs).toBe("override_reason");
    expect(noReason.body.overrideKind).toBe("wip_limit");
    expect((await pos("WO-9482")).state).toBe("waiting");
    const ok = await w.call("p-asha", "POST", url, { reason: "Hotfix for the payments outage" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await pos("WO-9482")).position).toBe("verify");
    expect(await liveAt("verify")).toBe(2);
    const e = await evs("wo.wip.override", "WO-9482");
    expect(e).toHaveLength(1);
    expect(e[0].after).toMatchObject({ station: "verify", text: "Hotfix for the payments outage" });
    expect((await w.get("WO-9482")).log.some((l: { text: string }) => l.text.includes("past its WIP limit"))).toBe(true);
    // nothing waits any more: another override is refused
    expect((await w.call("p-asha", "POST", url, { reason: "Hotfix for the payments outage" })).status).toBe(409);
  });

  it("an order leaving a station by advancing lets the one waiting behind it in (Build as the limited station)", async () => {
    await reset();
    await setWip(1, "build");
    await w.insertWo("WO-9491", { position: "plan", state: "waiting" });
    await toBuild("WO-9491");
    await w.insertWo("WO-9492", { position: "plan", state: "running" });
    await finishBuild("WO-9492"); // Plan finished: Build is full
    const b = await pos("WO-9492");
    expect([b.position, b.state, b.data.wipWait?.station]).toEqual(["plan", "waiting", "build"]);
    expect(await held()).toBe(1);
    await finishBuild("WO-9491"); // Build finished: it moves to Verify and the place is free
    expect((await pos("WO-9492")).position).toBe("build");
    expect(await held()).toBe(1);
    expect((await w.liveAttempt("WO-9492"))?.station).toBe("build");
    await setWip(0, "build");
  });
});
