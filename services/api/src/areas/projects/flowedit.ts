import { gateLock, gateModeLock, type ApproverRule, type Bay, type Catalog, type Gate, type GateKind, type ProjectFlow, type Station, type WorkClass } from "@gantry/domain";
import { conflict, invalid, refuse } from "../../core/errors.js";

/**
 * Pure flow editing (legacy `G.catalog.*` and the checks in `ops3.js`). A `FlowDraft` is a deep copy of one project's flow, its approver
 * rules and the org catalogue; edits mutate the draft and throw a refusal for a rule violation. The caller persists the result in one
 * transaction: a new flow version, changed approver rules, and the catalogue when an entry was appended (stations only ever append,
 * because a work order's station is an index into the catalogue).
 */

export type CatalogParts = Pick<Catalog, "stations" | "gates" | "bays" | "classes">;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export interface FlowDraft {
  projectId: string;
  flow: ProjectFlow;
  approvers: Record<string, ApproverRule>;
  catalog: CatalogParts;
  catalogChanged: boolean;
  /** Gates whose approver rule changed (to be published as a new rule version). */
  rulesChanged: Set<string>;
}

export function draftOf(projectId: string, flow: ProjectFlow, approvers: Record<string, ApproverRule>, catalog: CatalogParts): FlowDraft {
  const d: FlowDraft = { projectId, flow: clone(flow), approvers: clone(approvers), catalog: clone(catalog), catalogChanged: false, rulesChanged: new Set() };
  normalize(d);
  return d;
}

/** Every catalogue station and gate has an entry; custom ones the project has not adopted are `absent` (so route lookups never fail). */
export function normalize(d: FlowDraft): void {
  for (const s of d.catalog.stations) d.flow.stations[s.id] ??= s.custom ? { enabled: false, wip: 5, absent: true } : { enabled: true, wip: 5 };
  for (const g of d.catalog.gates) d.flow.gates[g.id] ??= g.custom ? { enabled: false, mode: g.kind, absent: true } : { enabled: true, mode: g.kind };
}

export const slug = (s: unknown): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

const station = (d: FlowDraft, id: string): Station | undefined => d.catalog.stations.find((s) => s.id === id);
const gate = (d: FlowDraft, id: string): Gate | undefined => d.catalog.gates.find((g) => g.id === id);
const present = (d: FlowDraft, id: string): boolean => d.flow.order.includes(id);
const gateLive = (d: FlowDraft, id: string): boolean => !!d.flow.gates[id] && !d.flow.gates[id]!.absent;

export interface StationDef {
  id?: string | undefined;
  name: string;
  agent: string;
  purpose?: string | undefined;
  wip?: number | undefined;
}

/** `agentKnown`: the staffing agent exists (the caller checks the agents table). */
export function addStation(d: FlowDraft, def: StationDef, afterId: string, agentKnown: boolean): Station {
  const name = def.name.trim();
  if (!name) throw invalid("Name the station.");
  if (!agentKnown) throw invalid("Pick the agent that staffs it.");
  if (!present(d, afterId)) throw invalid("Pick where it goes in the flow.");
  if (afterId === "close") throw invalid("Close is always last.");
  let id = def.id || slug(name);
  if (!id) throw invalid("Name the station.");
  if (station(d, id) && present(d, id)) throw conflict(`This project already has a station called ${name}.`);
  if (station(d, id) && !station(d, id)!.custom) id = `${id}-${d.projectId.slice(0, 4)}`;
  let st = station(d, id);
  if (!st) {
    const after = station(d, afterId);
    const customCount = d.catalog.stations.filter((s) => s.custom).length;
    st = { id, no: `${after ? after.no : "S"}·${customCount + 1}`, name, agent: def.agent, purpose: def.purpose ?? "", custom: true, project: d.projectId };
    d.catalog.stations.push(st);
    d.catalogChanged = true;
    for (const g of d.catalog.gates) if (g.after === id) d.flow.gates[g.id] ??= { enabled: false, mode: g.kind, absent: true };
  }
  d.flow.stations[id] = { enabled: true, wip: def.wip && def.wip >= 1 ? Math.min(30, Math.round(def.wip)) : 5 };
  const at = d.flow.order.indexOf(afterId);
  d.flow.order.splice(at + 1, 0, id);
  return st;
}

/** `busy`: open work orders at the station. A work order's station is never silently removed (spec 14.4). */
export function removeStation(d: FlowDraft, stationId: string, busy: number): Station {
  const s = station(d, stationId);
  if (!s || !present(d, stationId)) throw invalid("Unknown station.");
  if (!s.custom) throw conflict(`${s.name} is built in. Turn it off in the flow instead.`);
  if (busy) throw conflict(`${busy} work order${busy > 1 ? "s are" : " is"} at ${s.name}. Move ${busy > 1 ? "them" : "it"} first.`);
  d.flow.order = d.flow.order.filter((x) => x !== stationId);
  d.flow.stations[stationId] = { enabled: false, wip: 5, absent: true };
  for (const g of d.catalog.gates) if (g.after === stationId) d.flow.gates[g.id] = { enabled: false, mode: g.kind, absent: true };
  return s;
}

/** Moves a station one place earlier (-1) or later (+1). Intake stays first and Close last. */
export function moveStation(d: FlowDraft, stationId: string, dir: number): { before: string[]; after: string[]; name: string } {
  const o = d.flow.order;
  const i = o.indexOf(stationId);
  if (i < 0) throw invalid("Not in this flow.");
  const j = i + (dir < 0 ? -1 : 1);
  if (stationId === "intake" || stationId === "close" || o[j] === "intake" || o[j] === "close" || j < 0 || j >= o.length) throw conflict("Intake stays first and Close stays last.");
  const before = o.slice();
  o[i] = o[j] as string;
  o[j] = stationId;
  return { before, after: o.slice(), name: station(d, stationId)?.name ?? stationId };
}

export interface GateDef {
  id?: string | undefined;
  label?: string | undefined;
  name: string;
  after: string;
  kind?: GateKind | undefined;
  roles?: string[] | undefined;
  required?: number | undefined;
  purpose?: string | undefined;
}

export function addGate(d: FlowDraft, def: GateDef): Gate {
  const name = def.name.trim();
  if (!name) throw invalid("Name the gate.");
  if (!present(d, def.after)) throw invalid("Pick the station it follows.");
  if (d.catalog.gates.some((g) => g.after === def.after && g.id !== def.id)) {
    throw conflict(`${station(d, def.after)?.name ?? def.after} already has a gate after it.`);
  }
  const kind: GateKind = def.kind ?? "human";
  const roles = def.roles ?? [];
  if (kind !== "auto" && !roles.length) throw invalid("Pick at least one approver role.");
  let id = def.id || def.label || `G${name.split(/\s+/).map((w) => w[0]).join("").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3)}`;
  const existing = gate(d, id);
  if (existing && (!def.id || existing.after !== def.after || gateLive(d, id))) {
    if (def.id) throw conflict(`This project already has gate ${id}.`);
    while (gate(d, id)) id += "X";
  }
  let g = gate(d, id);
  if (!g) {
    g = { id, label: def.label || id, name, after: def.after, kind, purpose: def.purpose ?? "", checks: [], custom: true, project: d.projectId };
    d.catalog.gates.push(g);
    d.catalogChanged = true;
  }
  d.flow.gates[id] = { enabled: true, mode: kind };
  const rule = d.approvers[id] ?? { roles: ["line_lead", "project_admin"], people: [], required: 1, sod: true, conditions: [], escalateH: 24, fallback: null };
  if (def.roles) rule.roles = def.roles.slice();
  if (def.required) rule.required = def.required;
  d.approvers[id] = rule;
  d.rulesChanged.add(id);
  return g;
}

export function addBay(d: FlowDraft, def: { id?: string | undefined; name: string; desc?: string | undefined }): Bay {
  const name = def.name.trim();
  if (!name) throw invalid("Name the bay.");
  const id = def.id || slug(name);
  if (!id) throw invalid("Name the bay.");
  if (d.flow.bays.includes(id)) throw conflict("This project already has that bay.");
  let b = d.catalog.bays.find((x) => x.id === id);
  if (!b) {
    b = { id, name, desc: def.desc ?? "", custom: true, project: d.projectId };
    d.catalog.bays.push(b);
    d.catalogChanged = true;
  }
  d.flow.bays.push(id);
  return b;
}

/** A class route may not drop a locked gate: not by skipping its station, and not by leaving it out of a gate list. */
export function assertRouteKeepsLockedGates(d: FlowDraft, c: { name: string; skips?: string[] | undefined; gates?: string[] | undefined }, o: { regulated?: boolean } = {}): void {
  for (const g of d.catalog.gates) {
    if (g.id === "G0G1" || !gateLive(d, g.id) || !gateLock(g, o).locked) continue;
    if (c.skips?.includes(g.after)) throw conflict(`${c.name} cannot skip ${station(d, g.after)?.name ?? g.after}: it carries ${g.name} (${g.label}). ${gateLock(g, o).reason}`);
    if (c.gates && c.gates.length && !c.gates.includes(g.id)) throw conflict(`${c.name} must keep ${g.name} (${g.label}) on its route. ${gateLock(g, o).reason}`);
  }
}

export type ClassDef = Partial<Omit<WorkClass, "id" | "name">> & { id?: string | undefined; name: string };

export function addClass(d: FlowDraft, def: ClassDef, o: { regulated?: boolean } = {}): WorkClass {
  const name = def.name.trim();
  if (!name) throw invalid("Name the work class.");
  const id = def.id || slug(name);
  if (!id) throw invalid("Name the work class.");
  if (d.flow.classes.some((c) => c.id === id)) throw conflict(`This project already has ${name}.`);
  const bad = (def.skips ?? []).filter((s) => s === "intake" || s === "close" || !present(d, s));
  if (bad.length) throw invalid(`Can't skip ${bad.join(", ")}.`);
  assertRouteKeepsLockedGates(d, { name, skips: def.skips, gates: def.gates }, o);
  const c: WorkClass = { skips: [], priority: "P2", slaH: 72, est: "M", token: "cls-chore", shape: "bar", hints: [], gates: [], enabled: true, ...clone(def), id, name, custom: true, project: d.projectId };
  if (!d.catalog.classes.some((x) => x.id === id)) {
    d.catalog.classes.push(clone(c));
    d.catalogChanged = true;
  }
  d.flow.classes.push(clone(c));
  return c;
}

/** `open`: open work orders using the class. Turning a class off while work is in it is refused (spec 14.4). */
export function updateClass(d: FlowDraft, clsId: string, patch: Partial<WorkClass>, open: number, o: { regulated?: boolean } = {}): { before: WorkClass; after: WorkClass } {
  const c = d.flow.classes.find((x) => x.id === clsId);
  if (!c) throw invalid("No such class in this project.");
  if (patch.enabled === false && open) throw conflict(`Open work orders use ${c.name}. Reclassify or finish them first.`);
  if (patch.skips?.some((s) => s === "intake" || s === "close")) throw invalid("Intake and Close can't be skipped.");
  if (patch.skips?.some((s) => !present(d, s))) throw invalid("A skipped station is not in this flow.");
  if (patch.skips || patch.gates) {
    const added = (patch.skips ?? []).filter((s) => !c.skips.includes(s));
    assertRouteKeepsLockedGates(d, { name: c.name, skips: added, gates: patch.gates }, o);
  }
  const before = clone(c);
  Object.assign(c, clone(patch));
  const g = d.catalog.classes.find((x) => x.id === clsId);
  if (g?.custom && g.project === d.projectId) {
    const { enabled: _e, ...rest } = clone(patch);
    Object.assign(g, rest);
    d.catalogChanged = true;
  }
  return { before, after: clone(c) };
}

const MODES: readonly GateKind[] = ["auto", "human", "mixed"];

export function setGateMode(d: FlowDraft, gateId: string, mode: string, o: { regulated?: boolean } = {}): { before: GateKind; after: GateKind; gate: Gate } {
  const g = gate(d, gateId);
  if (!g || !gateLive(d, gateId)) throw invalid("Unknown project or gate.");
  if (!MODES.includes(mode as GateKind)) throw invalid("Mode is auto, human or mixed.");
  const refusal = gateModeLock(g, mode as GateKind, o);
  if (refusal) throw invalid(refusal);
  const cfg = d.flow.gates[gateId]!;
  const before = cfg.mode || g.kind;
  cfg.mode = mode as GateKind;
  const r = d.approvers[gateId];
  if (mode !== "auto" && r && !r.roles.length && !r.people.length) {
    r.roles = ["line_lead", "project_admin"];
    r.required = 1;
    d.rulesChanged.add(gateId);
  }
  return { before, after: mode as GateKind, gate: g };
}

/** A station or gate toggled on or off. Intake and G0+G1 are always on. */
export function setEnabled(d: FlowDraft, kind: "stations" | "gates", id: string, on: boolean, o: { regulated?: boolean } = {}): { name: string; before: boolean } {
  const cfg = d.flow[kind][id];
  const def = kind === "stations" ? station(d, id) : gate(d, id);
  if (!cfg || cfg.absent || !def) throw invalid(`This project has no ${kind === "stations" ? "station" : "gate"} ${id}.`);
  if (kind === "stations" && id === "intake" && !on) throw conflict("Intake is always on: every work order starts there.");
  if (kind === "stations" && !on) {
    // A station's gate leaves the route with it: a locked gate keeps its station on.
    const lockedGate = d.catalog.gates.find((g) => g.after === id && gateLive(d, g.id) && gateLock(g, o).locked);
    if (lockedGate) throw conflict(`${(def as Station).name} cannot be turned off: it carries ${lockedGate.name} (${lockedGate.label}). ${gateLock(lockedGate, o).reason}`);
  }
  if (kind === "gates" && !on) {
    const lock = gateLock(def as Gate, o);
    if (lock.locked) throw conflict(`${(def as Gate).name} (${(def as Gate).label}) cannot be turned off. ${lock.reason}`);
  }
  const before = cfg.enabled;
  cfg.enabled = on;
  return { name: kind === "stations" ? (def as Station).name : (def as Gate).label, before };
}

export function setWip(d: FlowDraft, stationId: string, wip: number): { name: string; before: number } {
  const cfg = d.flow.stations[stationId];
  const def = station(d, stationId);
  if (!cfg || cfg.absent || !def) throw invalid(`This project has no station ${stationId}.`);
  const before = cfg.wip;
  cfg.wip = wip;
  return { name: def.name, before };
}

/** The whole class list replaced (route edits, reset to template). Classes cannot disappear or turn off while open work uses them. */
export function replaceClasses(d: FlowDraft, next: WorkClass[], openByClass: Record<string, number>, o: { regulated?: boolean } = {}): { before: WorkClass[]; after: WorkClass[] } {
  const ids = new Set<string>();
  for (const c of next) {
    if (ids.has(c.id)) throw invalid(`Class ${c.id} appears twice.`);
    ids.add(c.id);
    // Only a route that changed is checked: a built-in class may already end early (Spike skips Close).
    const cur = d.flow.classes.find((x) => x.id === c.id);
    if (!cur || JSON.stringify(cur.gates ?? []) !== JSON.stringify(c.gates ?? [])) assertRouteKeepsLockedGates(d, { name: c.name, skips: [], gates: c.gates }, o);
    assertRouteKeepsLockedGates(d, { name: c.name, skips: c.skips.filter((x) => !cur?.skips.includes(x)) }, o);
    if (cur && JSON.stringify(cur.skips) === JSON.stringify(c.skips)) continue;
    if (c.skips.some((s) => s === "intake" || s === "close")) throw invalid("Intake and Close can't be skipped.");
    if (c.skips.some((s) => !present(d, s))) throw invalid(`${c.name} skips a station that is not in this flow.`);
  }
  for (const c of d.flow.classes) {
    const used = openByClass[c.id] ?? 0;
    const n = next.find((x) => x.id === c.id);
    if (used && (!n || n.enabled === false)) throw refuse("conflict", `Open work orders use ${c.name}. Reclassify or finish them first.`);
  }
  const before = clone(d.flow.classes);
  d.flow.classes = clone(next);
  return { before, after: clone(next) };
}
