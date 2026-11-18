import { describe, expect, it } from "vitest";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { NO_FILTER, buildBelt, tokenState } from "./conveyor";
import type { FloorCtxValue, FWo } from "./kit";

const NOW = 1_000_000_000_000;
const order = DEFAULT_CATALOG.stations.map((s) => s.id);
const wo = (id: string, station: string, state: string, extra: Partial<FWo> = {}): FWo =>
  ({ id, title: id, cls: "feature", priority: "P1", station: order.indexOf(station), state, bay: null, createdAt: NOW - 1e6, doneAt: null, history: [{ station, agent: "a", startedAt: NOW - 3_600_000, endedAt: null }], gates: {}, ...extra }) as unknown as FWo;
const ctx = (wos: FWo[]): FloorCtxValue => {
  const project = { id: "p", flow: { order, slots: 2, gates: Object.fromEntries(DEFAULT_CATALOG.gates.map((g) => [g.id, { enabled: true, mode: g.kind }])), stations: {}, classes: DEFAULT_CATALOG.classes, bays: [] }, approvers: {} };
  return { cat: DEFAULT_CATALOG, project, projects: [project], floor: { gates: [] }, wos, repos: [], replay: null, now: NOW } as unknown as FloorCtxValue;
};
const agent = (id: string) => id;

describe("buildBelt", () => {
  it("puts running work in the bays up to the slots, and the rest in the queue", () => {
    const c = ctx([wo("WO-1", "build", "running"), wo("WO-2", "build", "running"), wo("WO-3", "build", "running"), wo("WO-4", "build", "waiting")]);
    const b = buildBelt(c, agent).stations.find((s) => s.id === "build")!;
    expect(b.slots).toBe(2);
    expect(b.lane.map((t) => t.id)).toEqual(["WO-1", "WO-2"]);
    expect(b.queue.map((t) => t.id).sort()).toEqual(["WO-3", "WO-4"]);
  });
  it("shows a work order waiting at a gate as a gate token and counts it on the gate", () => {
    const w = wo("WO-5", "intake", "waiting", { gates: { G0G1: { status: "waiting", approvals: [], rejections: [], checks: [] } } as never });
    const c = ctx([w]);
    expect(tokenState(c, w)).toBe("gate");
    const s = buildBelt(c, agent).stations.find((x) => x.id === "intake")!;
    expect(s.gateAfter).toMatchObject({ id: "G0G1", waiting: 1 });
  });
  it("marks blocked work, filters by state and flags search hits", () => {
    const c = ctx([wo("WO-6", "plan", "blocked"), wo("WO-7", "plan", "running")]);
    expect(tokenState(c, c.wos[0]!)).toBe("blocked");
    expect(buildBelt(c, agent, { ...NO_FILTER, st: "blocked" }).open.map((w) => w.id)).toEqual(["WO-6"]);
    const hit = buildBelt(c, agent, { ...NO_FILTER, q: "WO-7" }).stations.find((s) => s.id === "plan")!.lane;
    expect(hit.find((t) => t.id === "WO-7")?.hit).toBe(true);
    expect(hit.find((t) => t.id === "WO-6")?.dim).toBe(true);
  });
  it("counts what shipped in the last 24 hours on the OUT cap", () => {
    const c = ctx([wo("WO-8", "close", "done", { doneAt: NOW - 3_600_000 }), wo("WO-9", "close", "done", { doneAt: NOW - 3 * 86_400_000 })]);
    expect(buildBelt(c, agent).released).toBe(1);
  });
});
