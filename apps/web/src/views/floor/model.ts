/**
 * The floor read turned into what the line drawing, the "waiting on you" bar and the parts list all draw: stations with their gauge and
 * balloons, the gates between them, the side-bay trays, the groups of work that need a person (oldest first) and the headline figures.
 * Everything comes from the floor read (FloorCtx) and the agents list; nothing is invented here.
 */
import { gateLabelOf } from "../../lib/gate-label";
import { gateAfter, gateKind, wipLimit, type Agent, type Bay, type Gate, type Station } from "@gantry/domain";
import { gateHaveNeed, gateOfStation, gateStateOf, isLive, since, stationIdx, waitingGateId, type FloorCtxValue, type FWo } from "./kit";

/** What a balloon is: amber = needs a person at a gate, red hatched = stuck or parked for a person, violet = split epic, cyan = running, plain = anything else, green = released. */
export type BKind = "gate" | "stuck" | "split" | "run" | "idle" | "done";

export interface Bal {
  w: FWo;
  kind: BKind;
  /** The two digits drawn in the balloon: the end of the work order's number. */
  n: string;
  /** Time at the current place, in ms (null once released). */
  age: number | null;
  gate: string | null;
  needsYou: boolean;
}

export interface StationModel {
  s: Station;
  idx: number;
  enabled: boolean;
  lim: number;
  items: Bal[];
  /** Work orders parked in a side bay at this station, by bay. */
  bays: Array<{ bay: Bay; items: Bal[]; needsYou: boolean }>;
  over: number;
  ratio: number;
  agent: string;
  state: { t: string; tone: "bad" | "warn" | "split" | "run" | "idle" };
  caption: string;
  oldestWait: number | null;
  gate: ReturnType<typeof gateModel> | null;
}

export interface Group {
  key: string;
  no: number;
  type: "gate" | "bay";
  gid?: string;
  sid?: string;
  bayId?: string;
  title: string;
  detail: string;
  wos: FWo[];
  since: number;
}

export const dur = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};
export const shortDur = (ms: number): string => {
  const m = ms / 60_000;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  const h = m / 60;
  return h < 100 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
};

const isStuck = (w: FWo): boolean => w.state === "blocked" || w.state === "failed" || w.state === "killed";
const numOf = (id: string): string => id.replace(/\D/g, "").slice(-2).padStart(2, "0");
/** Bays whose work waits for a person to answer, decide or take over. The others (on hold, declined, queue) are parked on purpose. */
export const PERSON_BAYS = ["person", "sechold"];

function gateModel(ctx: FloorCtxValue, g: Gate) {
  const gs = gateStateOf(ctx, g.id);
  return { g, kind: gateKind(ctx.cat, ctx.project, g.id), state: gs.state, waiting: gs.waiting, failing: gs.failing };
}

export interface FloorModel {
  stations: StationModel[];
  groups: Group[];
  needYou: number;
  needIds: Set<string>;
  live: FWo[];
  done: FWo[];
  all: Bal[];
  bottleneck: { st: StationModel; over: number } | null;
  oldest: { gate: string; wo: string; ms: number } | null;
  revised: Bal[];
  rework: Record<string, number>;
  byId: Map<string, Bal>;
}

export function buildModel(ctx: FloorCtxValue, agents: Agent[] | undefined): FloorModel {
  const { cat, project: p, now } = ctx;
  const line = p.flow.order.map((id) => cat.stations.find((s) => s.id === id)).filter((s): s is Station => !!s && !!p.flow.stations[s.id]?.enabled);
  const byId = new Map<string, Bal>();
  const bal = (w: FWo): Bal => {
    const gid = waitingGateId(ctx, w);
    const gk = gid ? gateKind(ctx.cat, p, gid) : null;
    let kind: BKind;
    if (w.state === "done") kind = "done";
    else if (w.bay) kind = PERSON_BAYS.includes(w.bay) ? "stuck" : "idle";
    else if (w.split) kind = "split";
    else if (gid && gk !== "auto") kind = "gate";
    else if (isStuck(w)) kind = "stuck";
    else if (w.state === "running" || gid) kind = "run";
    else kind = "idle";
    const needsYou = kind === "gate" || (!!w.bay && PERSON_BAYS.includes(w.bay) && w.state !== "killed");
    const b: Bal = { w, kind, n: numOf(w.id), age: w.state === "done" ? null : Math.max(0, now - since(w)), gate: gid, needsYou };
    byId.set(w.id, b);
    return b;
  };
  const stations: StationModel[] = line.map((s) => {
    const idx = stationIdx(cat, s.id);
    const lim = wipLimit(p, s.id);
    const items = ctx.wos.filter((w) => w.station === idx && !w.bay && w.state !== "done" && (isLive(w) || w.state === "killed")).map(bal).sort((a, b) => (b.age ?? 0) - (a.age ?? 0));
    const parked = ctx.wos.filter((w) => w.station === idx && !!w.bay && w.state !== "killed" && w.state !== "done");
    const bays = cat.bays
      .map((bay) => ({ bay, items: parked.filter((w) => w.bay === bay.id).map(bal).sort((a, b) => (b.age ?? 0) - (a.age ?? 0)), needsYou: PERSON_BAYS.includes(bay.id) }))
      .filter((b) => b.items.length);
    const g = gateOfStation(cat, p, s.id);
    const gate = g ? gateModel(ctx, g) : null;
    const stuck = items.filter((b) => b.kind === "stuck").length;
    const gated = items.filter((b) => b.kind === "gate");
    const run = items.filter((b) => b.kind === "run").length;
    const split = items.filter((b) => b.kind === "split").length;
    const bayNeed = bays.filter((b) => b.needsYou).reduce((n, b) => n + b.items.length, 0);
    const oldestWait = gated.length ? Math.max(...gated.map((b) => b.age ?? 0)) : null;
    let state: StationModel["state"];
    let caption = "";
    if (stuck || bayNeed) {
      const first = items.find((b) => b.kind === "stuck")?.w ?? bays.find((b) => b.needsYou)?.items[0]?.w;
      state = { t: `BLOCKED ${stuck + bayNeed}`, tone: "bad" };
      caption = first ? `${first.id} · ${first.blockReason || first.failReason || first.bayReason || "needs a person"}` : "";
    } else if (gated.length) {
      state = { t: "AT GATE", tone: "warn" };
      caption = `holding ${gated.length}${gate ? ` for ${gate.g.label}` : ""} · oldest ${dur(oldestWait ?? 0)}`;
    } else if (split) {
      state = { t: "SPLIT", tone: "split" };
      caption = `split ${items.find((b) => b.kind === "split")?.w.id ?? ""}`;
    } else if (run) {
      state = { t: "RUNNING", tone: "run" };
      const r = items.find((b) => b.kind === "run");
      caption = r ? `${r.w.id} · ${r.w.title}` : "";
    } else {
      state = { t: "IDLE", tone: "idle" };
      caption = s.purpose;
    }
    const ag = agents?.find((a) => a.id === s.agent);
    return { s, idx, enabled: true, lim, items, bays, over: lim ? Math.max(0, items.length - lim) : 0, ratio: lim ? items.length / lim : 0, agent: ag?.name ?? s.agent, state, caption, oldestWait, gate };
  });

  // groups that need a person, oldest first, numbered
  const groups: Group[] = [];
  for (const st of stations) {
    if (st.gate && st.gate.kind !== "auto") {
      const ws = st.items.filter((b) => b.kind === "gate" && b.gate === st.gate!.g.id);
      if (ws.length) {
        const t0 = Math.min(...ws.map((b) => since(b.w)));
        groups.push({ key: `gate:${st.gate.g.id}`, no: 0, type: "gate", gid: st.gate.g.id, title: `Approve at ${st.gate.g.label} · ${st.s.name}`, detail: `${ws.length} waiting · oldest ${dur(now - t0)}`, wos: ws.map((b) => b.w), since: t0 });
      }
    }
    for (const b of st.bays) {
      if (!b.needsYou) continue;
      const t0 = Math.min(...b.items.map((x) => since(x.w)));
      groups.push({ key: `bay:${st.s.id}:${b.bay.id}`, no: 0, type: "bay", sid: st.s.id, bayId: b.bay.id, title: b.items.length === 1 ? `${b.items[0]!.w.id} · ${b.bay.name}` : `${st.s.name}: ${b.bay.name}`, detail: `${b.items.length} parked · ${dur(now - t0)}`, wos: b.items.map((x) => x.w), since: t0 });
    }
  }
  groups.sort((a, b) => a.since - b.since);
  groups.forEach((g, i) => (g.no = i + 1));
  const needIds = new Set(groups.flatMap((g) => g.wos.map((w) => w.id)));

  const done = ctx.wos.filter((w) => w.state === "done" && !w.split).sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0));
  for (const w of done) bal(w);
  const live = ctx.wos.filter((w) => isLive(w) && w.bay !== "declined");

  // the bottleneck: the fullest station against its limit
  const full = stations.filter((s) => s.items.length > 0).sort((a, b) => b.ratio - a.ratio || b.items.length - a.items.length)[0];
  const bottleneck = full && full.over > 0 ? { st: full, over: full.over } : null;
  const oldestGroup = groups.find((g) => g.type === "gate");
  const oldest = oldestGroup ? { gate: stationGateLabel(stations, oldestGroup.gid!), wo: oldestGroup.wos.slice().sort((a, b) => since(a) - since(b))[0]!.id, ms: now - oldestGroup.since } : null;

  const rework: Record<string, number> = {};
  for (const w of ctx.wos) for (const sb of w.sendbacks ?? []) rework[`${sb.from}>${sb.to}`] = (rework[`${sb.from}>${sb.to}`] ?? 0) + 1;
  const revised = [...byId.values()].filter((b) => b.kind !== "done" && b.age !== null && b.age < 3_600_000).sort((a, b) => (a.age ?? 0) - (b.age ?? 0));
  return { stations, groups, needYou: needIds.size, needIds, live, done, all: [...byId.values()], bottleneck, oldest, revised, rework, byId };
}

const stationGateLabel = (stations: StationModel[], gid: string): string => stations.find((s) => s.gate?.g.id === gid)?.gate?.g.label ?? gid;

/** "At G5", "Parked", "Split ×2": the word the revisions strip and the parts list put after a work order's number. */
export function revWord(b: Bal, bayName: (id: string) => string): string {
  if (b.kind === "gate" || (b.gate && b.kind === "run")) return `At ${gateLabelOf(null, b.gate)}`;
  if (b.w.bay) return bayName(b.w.bay);
  if (b.kind === "split") return `Split ×${b.w.children.length}`;
  if (b.kind === "stuck") return "Stuck";
  if (b.kind === "done") return "Released";
  return b.w.state;
}

/** Approvals so far against what is needed at one gate, over the work orders waiting there. */
export function approvalsAt(ctx: FloorCtxValue, wos: FWo[], gid: string): { ready: number; total: number } {
  let ready = 0;
  for (const w of wos) {
    const { have, need } = gateHaveNeed(ctx, w, gid);
    if (have >= need) ready++;
  }
  return { ready, total: wos.length };
}

export { gateAfter };
