import { describe, expect, it } from "vitest";
import { DEFAULT_CATALOG, moveCheck, wipLimit, wipStatus, type WorkOrder } from "./index.js";
import { NOW, seedState } from "./testkit.js";

const C = DEFAULT_CATALOG;
const idx = (id: string) => C.stations.findIndex((s) => s.id === id);

describe("station WIP limits (domain)", () => {
  const st = seedState();
  const project = st.projects.find((p) => p.id === "payments")!;
  const mk = (o: Partial<WorkOrder>): WorkOrder => ({ ...st.workOrders[0]!, project: "payments", bay: null, bayFrom: null, heldByKill: undefined, ...o }) as WorkOrder;

  it("0 or unset is no limit", () => {
    expect(wipLimit({ flow: { ...project.flow, stations: { verify: { enabled: true, wip: 0 } } } }, "verify")).toBe(0);
    expect(wipLimit({ flow: { ...project.flow, stations: {} } }, "verify")).toBe(0);
    expect(wipLimit({ flow: { ...project.flow, stations: { verify: { enabled: true, wip: 3 } } } }, "verify")).toBe(3);
  });
  it("counts running and waiting orders at the station, not parked, done or killed ones; the Queue counts for Build", () => {
    const p = { ...project, flow: { ...project.flow, stations: { ...project.flow.stations, verify: { enabled: true, wip: 3 }, build: { enabled: true, wip: 2 } } } };
    const wos = [
      mk({ id: "a", station: idx("verify"), state: "running" }), mk({ id: "b", station: idx("verify"), state: "waiting" }),
      mk({ id: "c", station: idx("verify"), state: "parked", bay: "hold", bayFrom: "verify" }), mk({ id: "d", station: idx("verify"), state: "done" }), mk({ id: "e", station: idx("verify"), state: "killed" }),
      mk({ id: "f", station: idx("build"), state: "parked", bay: "queue", bayFrom: "build" }), mk({ id: "g", station: idx("build"), state: "running" }),
    ];
    expect(wipStatus(C, p, wos, "verify")).toEqual({ live: 2, limit: 3, full: false });
    expect(wipStatus(C, p, [...wos, mk({ id: "h", station: idx("verify"), state: "waiting" })], "verify")).toEqual({ live: 3, limit: 3, full: true });
    expect(wipStatus(C, p, wos, "build")).toEqual({ live: 2, limit: 2, full: true });
  });
  it("a waiting order cannot be moved ahead by hand; it says why", () => {
    const wo = mk({ id: "w", station: idx("build"), state: "waiting", wipWait: { station: "verify", since: NOW, live: 3, limit: 3 } });
    const m = moveCheck({ ...st, workOrders: [wo] }, "p-asha", wo, "verify", NOW);
    expect(m.allowed).toBe(false);
    expect(m.reason).toMatch(/Waiting: Verify is full/);
  });
});
