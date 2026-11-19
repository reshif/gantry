import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { advance, dispatchQueued, enterStation, finish, flushFx, promoteWip } from "../src/areas/workorders/engine.js";
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

  /** Orders sent back, retried or returned from a bay are held by a full station too, and the cycle of going back against going forward resolves. */
  describe("the other ways in: send-back, redo, retry and return from a bay", () => {
    const sendBack = (id: string, to: string, who = "p-meera") => w.call(who, "POST", `/api/v1/work-orders/${id}/send-back`, { toStation: to, note: "Needs another look at the build" });
    const park = (id: string) => w.call("p-meera", "POST", `/api/v1/work-orders/${id}/park`, { bay: "hold", reason: "Parked to free a place" });

    it("a send-back into a full station waits where the order is, with the same chip, and goes in when a place frees", async () => {
      await reset();
      await setWip(1, "build");
      await w.insertWo("WO-9501", { position: "build", state: "running" });
      await w.insertWo("WO-9502", { position: "verify", state: "waiting" });
      const r = await sendBack("WO-9502", "build");
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const b = await pos("WO-9502");
      expect([b.position, b.state, b.data.wipWait?.station, b.data.wipWait?.kind]).toEqual(["verify", "waiting", "build", "back"]);
      expect(b.data.blockReason).toBe("Waiting: Build is full (1/1)");
      expect(await evs("wo.wip.wait", "WO-9502")).toHaveLength(1);
      expect((await w.get("WO-9502")).wipWait).toMatchObject({ station: "build", kind: "back" });
      expect((await park("WO-9501")).status).toBe(200);
      const a = await pos("WO-9502");
      expect([a.position, a.state]).toEqual(["build", "running"]);
      expect((await evs("wo.wip.enter", "WO-9502"))[0].after).toMatchObject({ kind: "back", station: "build" });
      await setWip(0, "build");
    });

    it("a redo of the station the order is live at takes no new place, so a full or over-limit station never holds it", async () => {
      await reset();
      await w.insertWo("WO-9511", { position: "verify", state: "waiting" });
      await w.insertWo("WO-9512", { position: "verify", state: "waiting" });
      await setWip(1, "verify");
      const r = await sendBack("WO-9512", "verify");
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const b = await pos("WO-9512");
      expect([b.position, b.state, b.data.wipWait]).toEqual(["verify", "running", undefined]);
    });

    it("a retry of an order Needs a person (a bay) into a full station waits there; a failed order already at its station is never held", async () => {
      await reset();
      await setWip(1);
      await w.insertWo("WO-9521", { position: "verify", state: "running" });
      await w.insertWo("WO-9522", { position: "person", state: "parked", data: { bayFrom: "verify", bayCause: "failed", bayReason: "Failed three times", history: [], log: [] } });
      const r = await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9522/retry`, {});
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.msg).toMatch(/Verify is full \(1\/1\)/);
      const b = await pos("WO-9522");
      expect([b.position, b.state, b.data.wipWait?.kind]).toEqual(["person", "parked", "retry"]);
      expect((await park("WO-9521")).status).toBe(200);
      const a = await pos("WO-9522");
      expect([a.position, a.state, a.data.wipWait]).toEqual(["verify", "running", undefined]);
      expect((await w.liveAttempt("WO-9522"))?.station).toBe("verify");
      // G-W8: a failed order at its own full station is not counted, so its retry waits like any other entry
      await w.q(`update work_orders set state = 'done' where id = 'WO-9522'`);
      await w.insertWo("WO-9523", { position: "verify", state: "failed" });
      await w.insertWo("WO-9524", { position: "verify", state: "running" });
      const r2 = await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9523/retry`, {});
      expect(r2.status, JSON.stringify(r2.body)).toBe(200);
      expect([(await pos("WO-9523")).state, (await pos("WO-9523")).data.wipWait?.kind]).toEqual(["failed", "retry"]);
      expect(await liveAt("verify")).toBe(1);
      expect((await park("WO-9524")).status).toBe(200);
      expect([(await pos("WO-9523")).state, (await pos("WO-9523")).data.wipWait]).toEqual(["running", undefined]);
    });

    it("a return from a bay into a full station waits in the bay and goes in when a place frees", async () => {
      await reset();
      await setWip(1);
      await w.insertWo("WO-9531", { position: "verify", state: "running" });
      await w.insertWo("WO-9532", { position: "hold", state: "parked", data: { bayFrom: "verify", bayReason: "Waiting for a part", history: [], log: [] } });
      const r = await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9532/unpark`, { reason: "The part arrived" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.msg).toMatch(/Verify is full \(1\/1\)/);
      const b = await pos("WO-9532");
      expect([b.position, b.state, b.data.wipWait?.kind]).toEqual(["hold", "parked", "unpark"]);
      expect((await park("WO-9531")).status).toBe(200);
      const a = await pos("WO-9532");
      expect([a.position, a.state]).toEqual(["verify", "running"]);
    });

    it("the Factory Admin override works for a send-back that waits", async () => {
      await reset();
      await setWip(1, "build");
      await w.insertWo("WO-9541", { position: "build", state: "running" });
      await w.insertWo("WO-9542", { position: "verify", state: "waiting" });
      expect((await sendBack("WO-9542", "build")).status).toBe(200);
      expect((await w.get("WO-9542", "p-asha")).allowed.wipOverride.allowed).toBe(true);
      const ok = await w.call("p-asha", "POST", "/api/v1/work-orders/WO-9542/wip-override", { reason: "Rework is blocking the release" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await pos("WO-9542")).position).toBe("build");
      expect(await evs("wo.wip.override", "WO-9542")).toHaveLength(1);
      await setWip(0, "build");
    });

    it("a send-back takes the next free place before work going forward, whatever its priority", async () => {
      await reset();
      await setWip(1, "verify");
      await w.insertWo("WO-9551", { position: "verify", state: "waiting" });
      await building("WO-9552", "P0");
      await finishBuild("WO-9552"); // forward, P0, waits for Verify
      await w.insertWo("WO-9553", { position: "review", state: "waiting", priority: "P3" });
      expect((await sendBack("WO-9553", "verify")).status).toBe(200); // back, P3, also waits for Verify
      expect((await pos("WO-9552")).data.wipWait?.kind).toBe("forward");
      expect((await pos("WO-9553")).data.wipWait?.kind).toBe("back");
      expect((await park("WO-9551")).status).toBe(200);
      expect((await pos("WO-9553")).position).toBe("verify");
      expect((await pos("WO-9552")).state).toBe("waiting");
      await setWip(0, "verify");
    });

    it("the cycle: one order waits to go back to a station that is full of orders waiting to go forward; they swap at once and no count changes", async () => {
      await reset();
      await setWip(1, "build");
      await setWip(1, "verify");
      await w.insertWo("WO-9561", { position: "verify", state: "waiting" }); // holds Verify
      await building("WO-9562"); // holds Build and holds a coding slot
      await finishBuild("WO-9562"); // forward: Verify is full, so it waits at Build (and gives up its coding slot)
      expect((await pos("WO-9562")).data.wipWait?.station).toBe("verify");
      const r = await sendBack("WO-9561", "build"); // back: Build is full of the order waiting to go forward
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const [a, b] = [await pos("WO-9562"), await pos("WO-9561")];
      expect([a.position, a.state, a.data.wipWait]).toEqual(["verify", "running", undefined]);
      expect([b.position, b.state, b.data.wipWait]).toEqual(["build", "running", undefined]);
      expect(await liveAt("verify")).toBe(1);
      expect(await liveAt("build")).toBe(1);
      expect(await held()).toBe(1);
      expect(await evs("wo.wip.enter", "WO-9561")).toHaveLength(1);
      expect(await evs("wo.wip.enter", "WO-9562")).toHaveLength(1);
      await setWip(0, "build");
      await setWip(0, "verify");
    });
  });

  /** The statechart gate's replays (G-W1 to G-W5). */
  describe("every way into a station is checked", () => {
    const park = (id: string) => w.call("p-meera", "POST", `/api/v1/work-orders/${id}/park`, { bay: "hold", reason: "Parked to free a place" });
    const adv = (id: string) => w.tx(async (tx) => { const fx = await w.fxIn(tx); const wo = await lockWo(tx, t.orgId, id); await advance(fx, wo, "system"); await saveWo(tx, t.orgId, wo); await flushFx(fx); });

    it("G-W1: answering a question in Needs a person waits in the bay when the station is full, and goes in when a place frees", async () => {
      await reset();
      await setWip(1);
      await w.insertWo("WO-9601", { position: "verify", state: "running" });
      await w.insertWo("WO-9602", { position: "person", state: "parked", data: { bayFrom: "verify", bayReason: "q", waitingOn: { station: "verify", questions: [] }, history: [], log: [] } });
      const { maybeResume } = await import("../src/areas/workorders/dialogue.js");
      const resumed = await w.tx(async (tx) => { const fx = await w.fxIn(tx); const wo = await lockWo(tx, t.orgId, "WO-9602"); const r = await maybeResume(fx, wo, "p-asha"); await saveWo(tx, t.orgId, wo); await flushFx(fx); return r; });
      expect(resumed).toBe(false);
      expect(await liveAt("verify")).toBe(1);
      const b = await pos("WO-9602");
      expect([b.position, b.data.wipWait?.kind]).toEqual(["person", "unpark"]);
      expect((await park("WO-9601")).status).toBe(200);
      expect((await pos("WO-9602")).position).toBe("verify");
      expect(await liveAt("verify")).toBe(1);
    });

    it("G-W1: a new head commit that returns an order from a bay does not push a full station over its limit", async () => {
      await reset();
      await setWip(1, "review");
      await w.insertWo("WO-9605", { position: "review", state: "waiting" });
      await w.insertWo("WO-9606", { position: "person", state: "parked", data: { bayFrom: "review", bayCause: "merge", bayReason: "Merge blocked", merging: { prNumber: 7, headSha: "aaaaaaa" }, history: [], log: [] } });
      const { recordNewHead } = await import("../src/areas/workorders/station.js");
      await w.tx((tx) => recordNewHead(tx, t.orgId, "WO-9606", "bbbbbbb"));
      expect(await liveAt("review")).toBe(1);
      expect((await pos("WO-9606")).position).toBe("person");
      await setWip(0, "review");
    });

    it("G-W2: restoring a killed order into a station that filled meanwhile waits (kind restore) and resumes when a place frees", async () => {
      await reset();
      await setWip(1);
      await w.insertWo("WO-9611", { position: "verify", state: "running" });
      await w.insertWo("WO-9612", { position: "build", state: "running" });
      await adv("WO-9612");
      expect((await pos("WO-9612")).data.wipWait?.station).toBe("verify");
      const k = await w.call("p-asha", "POST", "/api/v1/stops", { scope: "wo", id: "WO-9611", mode: "kill", reason: "Bad output seen", inFlight: "cancel", confirmText: "WO-9611" });
      expect(k.status, JSON.stringify(k.body)).toBeLessThan(300);
      const { reconcileStop } = await import("../src/areas/stops/enforce.js");
      const stopId = (await w.q<{ id: string }>(`select id from stops where lifted_at is null order by set_at desc limit 1`))[0]!.id;
      await w.tx((tx) => reconcileStop(tx, stopId));
      expect((await pos("WO-9612")).position).toBe("verify"); // the freed place went to the waiter
      const r = await w.call("p-asha", "POST", `/api/v1/stops/${encodeURIComponent("workorder:WO-9611")}/restore`, { reason: "The incident is over" });
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
      const row2 = (await w.q<{ id: string }>(`select id from stops where org_id = $1 order by set_at desc limit 1`, [t.orgId]))[0]!.id;
      await w.tx((tx) => reconcileStop(tx, row2));
      expect(await liveAt("verify")).toBe(1);
      const a = await pos("WO-9611");
      expect([a.state, a.data.wipWait?.kind]).toEqual(["parked", "restore"]);
      expect((await park("WO-9612")).status).toBe(200);
      const b = await pos("WO-9611");
      expect([b.position, b.state, b.data.wipWait]).toEqual(["verify", "running", undefined]);
      expect(await liveAt("verify")).toBe(1);
    });

    it("G-W3: a waiter that holds while the occupant leaves for an unlimited station is not stranded (the promotion takes the lock first)", async () => {
      await reset();
      await setWip(1);
      await w.insertWo("WO-9621", { position: "verify", state: "running" }); // occupant
      await w.insertWo("WO-9622", { position: "build", state: "running" }); // will wait for verify
      const { withTx } = await import("@gantry/db");
      let releaseW!: () => void;
      const gate = new Promise<void>((r) => (releaseW = r));
      let wHeld!: () => void;
      const wReady = new Promise<void>((r) => (wHeld = r));
      const txW = withTx(t.db.app, async (tx) => {
        const fx = await w.fxIn(tx);
        const wo = await lockWo(tx, t.orgId, "WO-9622");
        await advance(fx, wo, "system");
        await saveWo(tx, t.orgId, wo);
        await flushFx(fx);
        wHeld();
        await gate;
      });
      await wReady;
      const yP = adv("WO-9621"); // the occupant advances to an unlimited station; its promotion must wait for the waiter's commit
      await new Promise((r) => setTimeout(r, 1500));
      releaseW();
      await txW;
      await yP;
      const wv = await pos("WO-9622");
      expect([wv.position, wv.state, wv.data.wipWait]).toEqual(["verify", "running", undefined]);
    });

    it("G-W4: a backed-up line (7 stations, 15 waiters at each) promotes in well under a second", async () => {
      await reset();
      const stations = ["research", "spec", "design", "plan", "build", "verify", "review"];
      const k = 15;
      for (const st of stations) expect((await setWip(k, st)).status).toBe(200);
      let n = 0;
      for (let i = 0; i < stations.length - 1; i++) {
        for (let j = 0; j < k; j++) {
          const id = `WO-97${String(++n).padStart(3, "0")}`;
          await w.insertWo(id, { position: stations[i]!, state: "waiting", data: { wipWait: { station: stations[i + 1], since: 1000 + n, live: k, limit: k, kind: i % 2 ? "forward" : "back" } } });
        }
      }
      for (let j = 0; j < k; j++) await w.insertWo(`WO-98${String(j).padStart(3, "0")}`, { position: "review", state: "running" });
      const t0 = Date.now();
      await w.tx(async (tx) => { const fx = await w.fxIn(tx); await promoteWip(fx, proj); });
      const ms = Date.now() - t0;
      expect(ms, `promotion took ${ms} ms`).toBeLessThan(1000);
      for (const st of stations) await setWip(0, st);
    });

    it("G-W8: a redo of a failed order at its own full station waits like a retry (it is not counted); a redo of a live order is never held", async () => {
      await reset();
      await setWip(1);
      await w.insertWo("WO-9651", { position: "verify", state: "running" });
      await w.insertWo("WO-9652", { position: "verify", state: "failed" });
      const r = await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9652/send-back`, { toStation: "verify", note: "Redo the checks please" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const b = await pos("WO-9652");
      expect([b.state, b.data.wipWait?.kind]).toEqual(["failed", "back"]);
      expect(await liveAt("verify")).toBe(1);
      expect((await park("WO-9651")).status).toBe(200);
      expect([(await pos("WO-9652")).state, (await pos("WO-9652")).data.wipWait]).toEqual(["running", undefined]);
    });

    it("G-W7: a restore that waits, killed and restored again, goes through the check again", async () => {
      await reset();
      await setWip(1);
      await w.insertWo("WO-9661", { position: "verify", state: "running" });
      await w.insertWo("WO-9662", { position: "build", state: "running" });
      await adv("WO-9662");
      const { reconcileStop } = await import("../src/areas/stops/enforce.js");
      const rec = async () => { const row = (await w.q<{ id: string }>(`select id from stops order by set_at desc limit 1`))[0]!.id; await w.tx((tx) => reconcileStop(tx, row)); };
      const kill = async (id: string) => { expect((await w.call("p-asha", "POST", "/api/v1/stops", { scope: "wo", id, mode: "kill", reason: "Bad output seen", inFlight: "cancel", confirmText: id })).status).toBeLessThan(300); await rec(); };
      const restore = async (id: string) => { expect((await w.call("p-asha", "POST", `/api/v1/stops/${encodeURIComponent(`workorder:${id}`)}/restore`, { reason: "The incident is over" })).status).toBe(200); await rec(); };
      await kill("WO-9661"); // the waiter takes the freed place
      expect((await pos("WO-9662")).position).toBe("verify");
      await restore("WO-9661"); // waits (parked)
      expect((await pos("WO-9661")).data.wipWait?.kind).toBe("restore");
      await kill("WO-9661"); // killed while waiting
      await restore("WO-9661"); // restored again: must wait again, not walk in
      expect(await liveAt("verify")).toBe(1);
      expect((await pos("WO-9661")).data.wipWait?.kind).toBe("restore");
      expect((await park("WO-9662")).status).toBe(200);
      expect([(await pos("WO-9661")).position, (await pos("WO-9661")).state]).toEqual(["verify", "running"]);
    });

    it("G-W9: an epic child created into a full Build waits; Intake creation stays unlimited", async () => {
      await reset();
      await setWip(1, "build");
      await setWip(1, "intake");
      await w.insertWo("WO-9671", { position: "build", state: "running" });
      await w.insertWo("WO-9672", { position: "intake", state: "waiting" });
      await w.insertWo("WO-9670", { position: "plan", state: "waiting", cls: "epic" });
      const { createWorkOrder } = await import("../src/areas/workorders/create.js");
      await w.tx(async (tx) => {
        const fx = await w.fxIn(tx);
        await createWorkOrder(fx, { id: "WO-9673", project: proj, repo: "payments-api", title: "Child one", requestedBy: "p-tomas", source: "epic", parent: "WO-9670", forceCls: "feature", childOf: { by: "p-tomas", parent: "WO-9670" } });
        await createWorkOrder(fx, { id: "WO-9674", project: proj, repo: "payments-api", title: "A new request", requestedBy: "p-tomas", source: "web", forceCls: "feature" });
        await flushFx(fx);
      });
      const c = await pos("WO-9673");
      expect([c.position, c.state, c.data.wipWait?.station]).toEqual(["intake", "parked", "build"]);
      expect(await liveAt("intake")).toBe(2); // WO-9672 and the new request; the waiting child holds no Intake seat
      expect((await pos("WO-9674")).position).toBe("intake"); // unlimited at creation, though Intake is at its limit
      expect((await park("WO-9671")).status).toBe(200);
      expect([(await pos("WO-9673")).position, (await pos("WO-9673")).state]).toEqual(["build", "running"]);
      await setWip(0, "build");
      await setWip(0, "intake");
    });

    it("G-W9: Retry merge from the person bay waits in the bay when Review is full", async () => {
      await reset();
      await setWip(1, "review");
      await w.insertWo("WO-9681", { position: "review", state: "waiting" });
      await w.insertWo("WO-9682", { position: "person", state: "parked", data: { bayFrom: "review", bayCause: "merge", bayReason: "Merge blocked", merging: { prNumber: 9, headSha: "abc1234" }, history: [], log: [] } });
      await w.q(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, head_sha) values ($1,'pr-t-9682','payments-api','WO-9682',9,'t','abc1234')`, [t.orgId]);
      const r = await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9682/retry`, {});
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.msg).toMatch(/Review and merge is full \(1\/1\)/);
      expect([(await pos("WO-9682")).position, (await pos("WO-9682")).data.wipWait?.kind]).toEqual(["person", "merge"]);
      expect(await liveAt("review")).toBe(1);
      await w.q(`update work_orders set state = 'done' where id = 'WO-9681'`);
      await w.tx(async (tx) => { const fx = await w.fxIn(tx); await dispatchQueued(fx, proj); await flushFx(fx); });
      const a = await pos("WO-9682");
      expect([a.position, a.state, a.data.wipWait]).toEqual(["review", "waiting", undefined]);
      expect((await w.q(`select 1 from jobs where kind = 'merge.request' and payload->>'woId' = 'WO-9682'`)).length).toBeGreaterThan(0);
      await setWip(0, "review");
    });

    it("G-W9: a recorded merge from the person bay is the exception, and leaves an explicit over-limit event", async () => {
      await reset();
      await setWip(1, "review");
      await setWip(1, "close");
      await w.insertWo("WO-9691", { position: "review", state: "waiting" });
      await w.insertWo("WO-9692", { position: "close", state: "running" });
      await w.insertWo("WO-9693", { position: "person", state: "parked", data: { bayFrom: "review", bayCause: "merge", bayReason: "Merge blocked", merging: { prNumber: 11, headSha: "abc1234" }, history: [], log: [] } });
      const { recordMerged } = await import("../src/areas/workorders/station.js");
      expect((await w.tx((tx) => recordMerged(tx, t.orgId, "WO-9693", { prNumber: 11 }))).applied).toBe(true);
      const b = await pos("WO-9693");
      expect([b.position, b.state, b.data.wipWait?.station]).toEqual(["review", "waiting", "close"]);
      const e = await evs("wo.wip.over_limit", "WO-9693");
      expect(e).toHaveLength(1);
      expect(e[0].after).toMatchObject({ station: "review", live: 2, limit: 1 });
      await setWip(0, "review");
      await setWip(0, "close");
    });

    it("G-W10: a waiting epic child does not block a real send-back into a full-looking Intake, and enters Build in promotion order", async () => {
      await reset();
      await setWip(1, "build");
      await setWip(1, "intake");
      await w.insertWo("WO-9701", { position: "build", state: "running" });
      await w.insertWo("WO-9702", { position: "plan", state: "waiting", cls: "epic" });
      await w.insertWo("WO-9703", { position: "spec", state: "waiting" });
      const { createWorkOrder } = await import("../src/areas/workorders/create.js");
      await w.tx(async (tx) => {
        const fx = await w.fxIn(tx);
        await createWorkOrder(fx, { id: "WO-9704", project: proj, repo: "payments-api", title: "Child", requestedBy: "p-tomas", source: "epic", parent: "WO-9702", forceCls: "feature", childOf: { by: "p-tomas", parent: "WO-9702" } });
        await flushFx(fx);
      });
      expect((await pos("WO-9704")).state).toBe("parked");
      const r = await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9703/send-back`, { toStation: "intake", note: "Needs the brief again" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const b = await pos("WO-9703");
      expect([b.position, b.data.wipWait]).toEqual(["intake", undefined]); // not held by the child
      expect((await park("WO-9701")).status).toBe(200);
      expect([(await pos("WO-9704")).position, (await pos("WO-9704")).state]).toEqual(["build", "running"]);
      await setWip(0, "build");
      await setWip(0, "intake");
    });

    it("G-W11: a failed order waiting to go back to a full earlier station stays failed and uncounted at its own station", async () => {
      await reset();
      await setWip(1, "build");
      await w.insertWo("WO-9711", { position: "build", state: "running" });
      await w.insertWo("WO-9712", { position: "verify", state: "failed" });
      const r = await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9712/send-back`, { toStation: "build", note: "Back to build" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const b = await pos("WO-9712");
      expect([b.position, b.state, b.data.wipWait?.kind]).toEqual(["verify", "failed", "back"]);
      expect(await liveAt("verify")).toBe(0);
      expect((await park("WO-9711")).status).toBe(200);
      expect([(await pos("WO-9712")).position, (await pos("WO-9712")).state]).toEqual(["build", "running"]);
      await setWip(0, "build");
    });
  });
});
