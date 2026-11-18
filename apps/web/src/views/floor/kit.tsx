/**
 * Shared pieces of the Floor (legacy floor.js and the work-order token of shared.js): the floor read and its context,
 * work-order token, gate state and the small helpers every view of the floor uses. Same DOM and classes as legacy.
 */
import { createContext, useContext, useMemo } from "react";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { DAY, HOUR, MIN, WO_STATES, requiredFor, bayDef, classesOf, fmt, gateAfter, gateDef, gateForWO, gateKind, type Bay, type Catalog, type EventEntry, type Gate, type Project, type Repo, type StateAt, type WorkOrder } from "@gantry/domain";
import { api, get } from "../../api/client";
import { useRepos } from "../../api/queries";

import { useCatalog } from "../projects/kit";
import { qk } from "../../api/keys";
import { Icon } from "../../ui/Icon";
import { useOpenTraveler } from "../../shell/useTraveler";
import { ClassChip, classOf } from "../projects/kit";
import type { McpServer } from "@gantry/domain";

export { DAY, HOUR, MIN };

/** A work order on the floor. In a replay the server adds the gate it was waiting at. */
export type FWo = WorkOrder & { replayGate?: string | null };

export interface FloorStop {
  id: string;
  mode: "halt" | "kill";
  scope: string;
  reason: string;
  by: string;
  at: number;
  inFlight: string | null;
}
export interface FloorRead {
  project: Project;
  workOrders: FWo[];
  flowVersion: number;
  slots: { used: number; total: number; holders: Array<{ slot: number; wo: string | null }> };
  gates: Array<{ instance: string; wo: string; gate: string; since: number; have?: number; need?: number }>;
  queue: string[];
  stop: FloorStop | null;
  stops: FloorStop[];
  at: number | null;
  replay?: StateAt;
}

/** GET /projects/{id}/floor, live or at a past time. The previous picture stays while the next one loads, so scrubbing does not flash. */
export function useFloorRead(projectId: string | null | undefined, at?: number) {
  return useQuery({
    queryKey: qk.floor(projectId ?? "", at),
    queryFn: () => get<FloorRead>(api(`projects/${encodeURIComponent(projectId ?? "")}/floor`), { at }),
    enabled: !!projectId,
    placeholderData: keepPreviousData,
  });
}

/** Replay window: the last 24 hours or 7 days up to when it was entered. */
export interface ReplayCtx {
  at: number;
  span: "24h" | "7d";
  from: number;
  to: number;
  speed: number;
  state: StateAt;
}

export interface FloorCtxValue {
  cat: Catalog;
  /** The project on the floor. Under All projects: the merged line (stations by id in catalogue order, slots and WIP summed); never a project to act on. Per-work-order facts come from `projectOf`. */
  project: Project;
  /** The projects behind the floor: one, or every visible project under All. */
  projects: Project[];
  /** The All projects floor: each work order keeps its own project's flow, gates and approvers. */
  all?: boolean;
  floor: FloorRead;
  wos: FWo[];
  repos: Repo[];
  replay: ReplayCtx | null;
  /** The time everything is drawn at: now, or the replay time. */
  now: number;
}
/** The project a work order belongs to (its own flow, gates and approvers), not the merged line. */
export function projectOf(ctx: Pick<FloorCtxValue, "project" | "projects">, w: { project: string }): Project {
  return ctx.projects.find((p) => p.id === w.project) ?? ctx.project;
}
export const FloorCtx = createContext<FloorCtxValue | null>(null);
export function useFloorCtx(): FloorCtxValue {
  const v = useContext(FloorCtx);
  if (!v) throw new Error("useFloorCtx outside the floor");
  return v;
}

/* ---------- small helpers ---------- */

export const isLive = (w: Pick<WorkOrder, "state">): boolean => w.state !== "done" && w.state !== "killed";
export const openEntry = (w: Pick<WorkOrder, "history">) => w.history[w.history.length - 1];
/** When the work order got to where it is now. */
export function since(w: WorkOrder): number {
  const e = openEntry(w);
  return w.bay ? (w.bayAt ?? e?.startedAt ?? w.createdAt) : w.state === "waiting" ? (e?.endedAt ?? e?.startedAt ?? w.createdAt) : (e?.startedAt ?? w.createdAt);
}
export const stationId = (cat: Catalog, w: Pick<WorkOrder, "station">): string => cat.stations[w.station]?.id ?? "";
export const stationIdx = (cat: Catalog, sid: string): number => cat.stations.findIndex((s) => s.id === sid);
export const bayName = (cat: Catalog, id: string): string => bayDef(cat, id)?.name ?? id;
export const assigneeOf = (w: WorkOrder): string | null => (w.bay || w.state === "done" || w.state === "killed" ? null : (openEntry(w)?.agent ?? null));

/** The gate after a station, unless this project took it out of the flow. */
export function gateOfStation(cat: Catalog, p: Project, sid: string): Gate | null {
  const g = gateAfter(cat, sid);
  return g && !p.flow.gates[g.id]?.absent ? g : null;
}

/** Belt geometry from the project's flow: stations up to Plan on the top row, the rest on the bottom row; `order` is the stacking order of the narrow layout. */
export function layoutFor(cat: Catalog, p: Project) {
  const order = p.flow.order.filter((id) => cat.stations.some((s) => s.id === id));
  let pi = order.indexOf("plan");
  if (pi < 0) pi = Math.min(4, order.length - 2);
  const o: Record<string, number> = {};
  let n = 1;
  for (const sid of order) {
    o[sid] = n++;
    const g = gateOfStation(cat, p, sid);
    if (g) o[g.id] = n++;
  }
  return { top: order.slice(0, pi + 1), bottom: order.slice(pi + 1), order: o };
}

export type GateStateId = "clear" | "waiting" | "failing" | "off";
/** One gate over the work orders at its station: clear, waiting, failing or off. */
export function gateStateOf(ctx: FloorCtxValue, gid: string): { state: GateStateId; waiting: number; failing: number } {
  const cfg = ctx.project.flow.gates[gid];
  if (cfg && !cfg.enabled && gid !== "G0G1") return { state: "off", waiting: 0, failing: 0 };
  const g = gateDef(ctx.cat, gid);
  if (!g) return { state: "clear", waiting: 0, failing: 0 };
  const at = stationIdx(ctx.cat, g.after);
  let waiting = 0;
  let failing = 0;
  for (const w of ctx.wos) {
    if (w.station !== at || !isLive(w)) continue;
    const gs = w.gates?.[gid];
    const isWait = ctx.replay ? w.replayGate === gid && w.state === "waiting" : gs?.status === "waiting";
    if (isWait && !w.bay) waiting++;
    if (gs?.status === "failed" && !ctx.replay) failing++;
  }
  return { state: failing ? "failing" : waiting ? "waiting" : "clear", waiting, failing };
}

/** How many approvals a waiting work order has at a gate, and how many it needs. */
export function gateHaveNeed(ctx: FloorCtxValue, w: WorkOrder, gid: string): { have: number; need: number } {
  const row = ctx.floor.gates.find((x) => x.wo === w.id && x.gate === gid);
  const rule = projectOf(ctx, w).approvers[gid];
  return { have: row?.have ?? w.gates?.[gid]?.approvals.length ?? 0, need: row?.need ?? requiredFor(rule, w.cls) };
}

/** The label for the gate column of a card or row. */
export function gateText(ctx: FloorCtxValue, w: WorkOrder): { t: string; c: string } {
  if (w.state === "killed") return { t: "Killed", c: "kill" };
  if (w.bay) return { t: bayName(ctx.cat, w.bay), c: "park" };
  const g = gateForWO(ctx.cat, projectOf(ctx, w), w);
  if (w.state === "waiting" && g) {
    const { have, need } = gateHaveNeed(ctx, w, g.id);
    return { t: `${g.name} waiting${g.id === "G0G1" ? "" : ` ${have}/${need}`}`, c: "wait" };
  }
  if (w.state === "failed") return { t: `${g ? g.name : "check"} failing`, c: "fail" };
  if (w.state === "blocked") return { t: "Blocked", c: "block" };
  return g ? { t: `next: ${g.name}`, c: "" } : { t: "no gate next", c: "" };
}

export const repoName = (repos: Repo[], id: string): string => repos.find((r) => r.id === id)?.name ?? id;
export { gateKind, classesOf };
export type { Bay };

/* ---------- work-order token (legacy G.woToken) ---------- */

export function WoToken({ w, compact, idPrefix = "tok-", halted, onOpen }: { w: FWo; compact?: boolean; idPrefix?: string; halted?: string | null; onOpen?: (id: string) => void }) {
  const ctx = useFloorCtx();
  const open = useOpenTraveler();
  const e = openEntry(w);
  const st = w.state;
  const def = (WO_STATES as Record<string, { glyph: string; label: string }>)[st] ?? { glyph: "dots", label: st };
  const live = st !== "done" && st !== "killed";
  const time = st === "done" ? "done" : st === "killed" ? "killed" : fmt.dur(Math.max(0, ctx.now - (w.bay ? (w.bayAt ?? e?.startedAt ?? w.createdAt) : (e?.startedAt ?? w.createdAt))));
  const g = gateForWO(ctx.cat, projectOf(ctx, w), w);
  const note =
    st === "running" ? null : st === "waiting" && g ? `waiting at ${g.name}` : st === "parked" ? bayName(ctx.cat, w.bay ?? "") : st === "killed" ? "Killed" : st === "blocked" ? "Blocked" : st === "failed" ? "Check failed" : st === "done" ? (w.split ? "Split" : "Shipped") : "";
  const cls = classOf(ctx.cat, projectOf(ctx, w), w.cls);
  return (
    <button
      type="button"
      className={`tok tok-${st}${w.heldByKill ? " is-held" : ""}${compact ? " tok-compact" : ""}${halted && live ? " fl-tok-halted" : ""}`}
      id={`${idPrefix}${w.id}`}
      data-wo={w.id}
      data-tip={halted && live ? `${halted} is halted (andon)` : undefined}
      aria-label={`${w.id}, ${w.title}, ${cls.name}, ${def.label}${note ? `, ${note}` : ""}, ${time}`}
      onClick={() => (onOpen ?? open)(w.id)}
    >
      <span className="tok-top">
        <Icon name={def.glyph} className="tok-glyph" />
        <span className="mono tok-id">{w.id}</span>
        <span className="mono tok-time">{time}</span>
      </span>
      {compact ? null : <span className="tok-title">{w.title}</span>}
      <span className={`tok-foot${st === "running" ? "" : " has-note"}`}>
        <ClassChip cls={cls} small />
        {st === "running" ? (
          <span className="tok-prog" role="progressbar" aria-valuenow={Math.round(w.progress)} aria-valuemin={0} aria-valuemax={100} aria-label="Station progress">
            <span style={{ width: `${Math.round(w.progress)}%` }} />
          </span>
        ) : (
          <span className="tok-note">{note}</span>
        )}
      </span>
    </button>
  );
}

/* ---------- replay time helpers ---------- */

export function replayRange(span: "24h" | "7d", now = Date.now()): { from: number; to: number } {
  return { from: now - (span === "7d" ? 7 * DAY : DAY), to: now };
}

export const MARK_TYPES = ["gate.decision", "halt", "resume", "kill", "restore", "release", "trust.auto", "outcome", "wo.state"];
export const EV_LABEL: Record<string, string> = { "gate.decision": "Gate decision", "trust.auto": "Passed under trust", halt: "Andon halt", resume: "Resumed", kill: "Kill", restore: "Restored", release: "Release", "wo.submit": "Submitted", "wo.enter": "Entered station", "wo.bay": "Moved to bay", "wo.done": "Done", "trust.change": "Trust change" };
export const markCls = (e: EventEntry): string => (e.type === "gate.decision" ? "mk-gate" : e.type === "trust.auto" ? "mk-trust" : `mk-${e.type}`);

/** MCP servers a station of a project may use (legacy mcpFor): listed for the station and the project, and attached to the project. */
export function mcpFor(p: Project, sid: string, servers: McpServer[] | undefined): McpServer[] {
  return (servers ?? []).filter((m) => (m.stations === "all" || (Array.isArray(m.stations) && m.stations.includes(sid))) && (m.projects === "all" || (Array.isArray(m.projects) && m.projects.includes(p.id))) && (p.mcp ?? []).includes(m.id));
}

/** The floor of a project as a context value: live, or at the replay time. Null while it loads. */
/**
 * The repos of a project. GET /projects/{id}/repos is the source; until that read exists the repos are what the floor shows:
 * the repo of every work order, with a halt taken from the active repo stops. Their onboarding stage is unknown there, so the
 * server's own refusal decides whether a submission is accepted.
 */
export function useProjectRepos(projectId: string | null | undefined): Repo[] {
  const q = useRepos(projectId);
  const floor = useFloorRead(projectId);
  const f = floor.data;
  return useMemo(() => {
    if (q.data?.length) return q.data;
    if (!f) return [];
    const halts = new Map<string, FloorStop>();
    for (const s of f.stops) if (s.scope === "repo" && s.mode === "halt") halts.set(s.id.split(":")[1] ?? "", s);
    const ids = [...new Set(f.workOrders.map((w) => w.repo))];
    for (const id of halts.keys()) if (id && !ids.includes(id)) ids.push(id);
    return ids.map((id): Repo => {
      const h = halts.get(id);
      return { id, name: id, project: f.project.id, halted: h ? { reason: h.reason, by: h.by, at: h.at } : null, onboarding: { stage: "ready" } } as unknown as Repo;
    });
  }, [q.data, f]);
}

/** The merged line of several projects: stations by id in catalogue order, slots and WIP summed, a gate on when any project has it on. A gate whose mode differs between projects reads as a person's (the safe reading). */
export function mergeProjects(cat: Catalog, projects: Project[]): Project {
  const base = projects[0] as Project;
  if (projects.length === 1) return base;
  const inAny = (id: string) => projects.some((p) => p.flow.order.includes(id));
  const order = cat.stations.map((st) => st.id).filter(inAny);
  const stations: Project["flow"]["stations"] = {};
  for (const id of order) {
    const cfgs = projects.filter((p) => p.flow.order.includes(id)).map((p) => p.flow.stations[id] ?? { enabled: true, wip: 5 });
    stations[id] = { enabled: cfgs.some((c) => c.enabled), wip: cfgs.reduce((n, c) => n + (c.enabled ? c.wip : 0), 0) };
  }
  const gates: Project["flow"]["gates"] = {};
  for (const g of cat.gates) {
    const cfgs = projects.map((p) => p.flow.gates[g.id]).filter((c): c is NonNullable<typeof c> => !!c);
    if (!cfgs.length) continue;
    const modes = new Set(cfgs.map((c) => c.mode));
    gates[g.id] = { ...cfgs[0]!, enabled: cfgs.some((c) => c.enabled), ...(cfgs.every((c) => c.absent) ? { absent: true } : { absent: false }), mode: modes.size === 1 ? cfgs[0]!.mode : "human" } as Project["flow"]["gates"][string];
  }
  const classes: Project["flow"]["classes"] = [];
  for (const p of projects) for (const c of p.flow.classes) if (!classes.some((x) => x.id === c.id)) classes.push(c);
  return { ...base, id: "", name: "All projects", key: "ALL", halted: null, killed: null, flow: { ...base.flow, order, slots: projects.reduce((n, p) => n + p.flow.slots, 0), stations, gates, classes } };
}

/** The floors of several projects as one read (live only). Every row keeps the project it came from. */
export function mergeFloors(cat: Catalog, reads: FloorRead[]): FloorRead {
  const project = mergeProjects(cat, reads.map((r) => r.project));
  const stops: FloorStop[] = [];
  for (const r of reads) for (const s of r.stops) if (!stops.some((x) => x.id === s.id)) stops.push(s);
  const top = stops.slice().sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "kill" ? -1 : 1))[0] ?? null;
  return {
    project,
    workOrders: reads.flatMap((r) => r.workOrders),
    flowVersion: 0,
    slots: { used: reads.reduce((n, r) => n + r.slots.used, 0), total: reads.reduce((n, r) => n + r.slots.total, 0), holders: reads.flatMap((r) => r.slots.holders) },
    gates: reads.flatMap((r) => r.gates),
    queue: reads.flatMap((r) => r.queue),
    stop: top,
    stops,
    at: null,
  };
}

/** What the floor of a scope is made of: one project (with an optional replay time) or every visible project. */
export type FloorSource = { all: false; projectId: string | null | undefined } | { all: true; projectIds: string[] };

export function useFloorState(projectId: string | null | undefined, rp: Omit<ReplayCtx, "state"> | null): { value: FloorCtxValue | null; error: unknown } {
  return useScopedFloorState({ all: false, projectId }, rp);
}

/** The floor for a scope. Under All it is each visible project's own floor read (the same read, so the same per-project visibility), merged; replay is project-only. */
export function useScopedFloorState(src: FloorSource, rp: Omit<ReplayCtx, "state"> | null): { value: FloorCtxValue | null; error: unknown } {
  const cat = useCatalog();
  const projectId = src.all ? null : src.projectId;
  const floor = useFloorRead(projectId, rp?.at);
  const ids = src.all ? src.projectIds : [];
  const many = useQueries({
    queries: ids.map((id) => ({ queryKey: qk.floor(id, undefined), queryFn: () => get<FloorRead>(api(`projects/${encodeURIComponent(id)}/floor`)), placeholderData: keepPreviousData })),
  });
  const repos = useProjectRepos(projectId);
  const manyData = many.map((q) => q.data);
  const merged = useMemo(() => (src.all && cat && manyData.length && manyData.every(Boolean) ? mergeFloors(cat, manyData as FloorRead[]) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [src.all, cat, ...manyData]);
  if (src.all) {
    const failed = many.find((q) => q.isError);
    if (!cat || !merged) return { value: null, error: failed?.error ?? null };
    return { value: { cat, project: merged.project, projects: manyData.map((r) => (r as FloorRead).project), all: true, floor: merged, wos: merged.workOrders, repos: [], replay: null, now: Date.now() }, error: null };
  }
  const f = floor.data;
  if (!cat || !f) return { value: null, error: floor.isError ? floor.error : null };
  const replay: ReplayCtx | null = rp ? { ...rp, state: f.replay ?? { at: rp.at, workOrders: [], halted: null, killed: null, haltedRepos: {} } } : null;
  return { value: { cat, project: f.project, projects: [f.project], floor: f, wos: f.workOrders, repos, replay, now: replay ? replay.at : Date.now() }, error: null };
}

export const useFloorValue = (projectId: string | null | undefined, rp: Omit<ReplayCtx, "state"> | null): FloorCtxValue | null => useFloorState(projectId, rp).value;
