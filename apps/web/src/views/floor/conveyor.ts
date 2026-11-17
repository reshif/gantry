/** The Floor's conveyor, as data: the real floor read (stations, gates, work orders) mapped onto the Control Room belt. Pure, so it can be tested. */
import { DAY, fmt, gateForWO } from "@gantry/domain";
import type { BeltStation, BeltTok, TokState } from "../../ui/cr";
import { gateOfStation, gateStateOf, isLive, since, stationIdx, type FWo, type FloorCtxValue } from "./kit";

export interface BeltFilter { q: string; cls: string; pri: string; st: string }
export const NO_FILTER: BeltFilter = { q: "", cls: "all", pri: "all", st: "all" };

const CLS_SHORT: Record<string, string> = { feature: "FEAT", bug: "BUG", hotfix: "HOT", epic: "EPIC", chore: "CHORE", refactor: "REF", security: "SEC", docs: "DOCS", spike: "SPIKE" };
const ORDER: Record<TokState, number> = { running: 0, blocked: 1, gate: 2, queued: 3 };

/** Where a work order sits on the belt. A person is needed at a gate, in a bay, or for a failed check; waiting without a gate is just queued. */
export function tokenState(ctx: FloorCtxValue, w: FWo): TokState {
  if (w.bay) return "gate";
  if (w.state === "running") return "running";
  if (w.state === "waiting") return gateForWO(ctx.cat, ctx.project, w) ? "gate" : "queued";
  return "blocked";
}

const toTok = (ctx: FloorCtxValue, w: FWo, f: BeltFilter): BeltTok => {
  const hit = f.q ? `${w.id} ${w.title}`.toLowerCase().includes(f.q.toLowerCase()) : false;
  return { id: w.id, title: w.title, state: tokenState(ctx, w), pri: w.priority, cls: CLS_SHORT[w.cls] ?? w.cls.slice(0, 5).toUpperCase(), age: fmt.dur(Math.max(0, ctx.now - since(w))), hit: !!f.q && hit, dim: !!f.q && !hit };
};

export function liveOnBelt(ctx: FloorCtxValue, f: BeltFilter = NO_FILTER): FWo[] {
  return ctx.wos.filter((w) => isLive(w) && w.bay !== "declined" && (f.cls === "all" || w.cls === f.cls) && (f.pri === "all" || w.priority === f.pri) && (f.st === "all" || tokenState(ctx, w) === f.st));
}

export function buildBelt(ctx: FloorCtxValue, agentName: (id: string) => string, f: BeltFilter = NO_FILTER): { stations: BeltStation[]; released: number; open: FWo[] } {
  const open = liveOnBelt(ctx, f);
  const order = ctx.project.flow.order.filter((id) => ctx.cat.stations.some((s) => s.id === id));
  const stations = order.map((sid, i): BeltStation => {
    const st = ctx.cat.stations.find((s) => s.id === sid)!;
    const idx = stationIdx(ctx.cat, sid);
    const here = open.filter((w) => w.station === idx).map((w) => toTok(ctx, w, f));
    const active = here.filter((t) => t.state !== "queued").sort((a, b) => ORDER[a.state] - ORDER[b.state]);
    // The backend caps only the coding station (project slots); every other station is uncapped, so its bays follow the work (at most four).
    const slots = sid === "build" ? Math.max(1, ctx.project.flow.slots) : Math.max(1, Math.min(4, active.length));
    const lane = active.slice(0, slots);
    const queue = active.slice(slots).concat(here.filter((t) => t.state === "queued")).sort((a, b) => a.age.localeCompare(b.age));
    const g = gateOfStation(ctx.cat, ctx.project, sid);
    return { id: sid, name: st.name, agent: agentName(st.agent), slots, lane, queue, gateAfter: g ? { id: g.id, name: g.name, waiting: gateStateOf(ctx, g.id).waiting } : null, hasNext: i < order.length - 1 };
  });
  const released = ctx.wos.filter((w) => w.state === "done" && (w.doneAt ?? 0) > ctx.now - DAY).length;
  return { stations, released, open };
}
