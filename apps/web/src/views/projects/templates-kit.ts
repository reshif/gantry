/** Template helpers for previews (legacy G.flowFrom and G.templateKit): the server derives the real flow; these only draw it. */
import type { ApproverRule, Catalog, NotificationRoute, Project, ProjectFlow, Template, WorkClass } from "@gantry/domain";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export interface TplCustom {
  stations: { id: string; name: string; agent: string; purpose?: string; wip?: number; after: string }[];
  gates: { id: string; label: string; name: string; after: string; kind?: "human" | "mixed" | "auto"; roles?: string[]; required?: number; purpose?: string }[];
  bays: { id: string; name: string; desc?: string }[];
  classes: WorkClass[];
}
export type Tpl = Template & { custom?: Partial<TplCustom>; version?: number };

export const tplCustom = (t: Pick<Tpl, "custom"> | null | undefined): TplCustom => {
  const c = t?.custom ?? {};
  return { stations: c.stations ?? [], gates: c.gates ?? [], bays: c.bays ?? [], classes: c.classes ?? [] };
};
export const tplCustomCount = (t: Pick<Tpl, "custom">): number => {
  const c = tplCustom(t);
  return c.stations.length + c.gates.length + c.bays.length + c.classes.length;
};
export const customText = (c: TplCustom): string =>
  [...c.stations.map((x) => `station ${x.name}`), ...c.gates.map((x) => `gate ${x.label} ${x.name}`), ...c.bays.map((x) => `bay ${x.name}`), ...c.classes.map((x) => `class ${x.name}`)].join(", ");
export const tplCustomText = (t: Pick<Tpl, "custom">): string => customText(tplCustom(t));

type Cat = Pick<Catalog, "stations" | "gates" | "bays" | "classes">;

/** A flow with an entry for every catalogue station and gate (custom ones are `absent`). */
export function flowFrom(cat: Cat, t: Pick<Template, "stationsOff" | "gatesOff" | "slots" | "classesSkip" | "order" | "bays">): ProjectFlow {
  const off = new Set(t.stationsOff ?? []);
  const gOff = new Set(t.gatesOff ?? []);
  const stations: ProjectFlow["stations"] = {};
  for (const s of cat.stations) stations[s.id] = s.custom ? { enabled: false, wip: 5, absent: true } : { enabled: !off.has(s.id), wip: s.id === "build" ? 4 : 5 };
  const gates: ProjectFlow["gates"] = {};
  for (const g of cat.gates) gates[g.id] = g.custom ? { enabled: false, mode: g.kind, absent: true } : { enabled: !gOff.has(g.id), mode: g.kind };
  const order = (t.order ?? cat.stations.filter((s) => !s.custom).map((s) => s.id)).slice();
  const bays = (t.bays ?? cat.bays.filter((b) => !b.custom).map((b) => b.id)).slice();
  const classes = cat.classes
    .filter((c) => !c.custom)
    .map((c) => {
      const x = clone(c);
      const skip = t.classesSkip?.[c.id];
      if (skip) x.skips = skip.slice();
      x.enabled = true;
      return x;
    });
  return { stations, gates, slots: t.slots, classes, order, bays };
}

/** A stand-in project whose flow is the template's, custom entries included (previews only). */
export function tplFlowProject(cat: Catalog, t: Tpl): Project {
  const flow = flowFrom(cat, t);
  const c = tplCustom(t);
  for (const x of c.stations) {
    if (!cat.stations.some((s) => s.id === x.id)) continue;
    flow.stations[x.id] = { enabled: !(t.stationsOff ?? []).includes(x.id), wip: x.wip || 5 };
    const at = flow.order.indexOf(x.after);
    flow.order = flow.order.filter((y) => y !== x.id);
    flow.order.splice(at < 0 ? flow.order.length - 1 : at + 1, 0, x.id);
  }
  for (const x of c.gates) if (cat.gates.some((g) => g.id === x.id)) flow.gates[x.id] = { enabled: true, mode: x.kind || "human" };
  for (const x of c.bays) if (cat.bays.some((b) => b.id === x.id) && !flow.bays.includes(x.id)) flow.bays.push(x.id);
  for (const x of c.classes) flow.classes.push({ ...clone(x), enabled: true });
  return { id: `tpl:${t.id}`, name: t.name, flow, approvers: {}, teams: [], budget: { monthly: 0, mtd: 0, alertAt: 0.8 } } as unknown as Project;
}

/** The catalogue a template preview needs: built-in entries plus the template's own custom ones (they are not in the org catalogue until a project adopts them). */
export function catalogWithCustom(cat: Catalog, t: Tpl): Catalog {
  const c = tplCustom(t);
  const stations = cat.stations.slice();
  for (const x of c.stations) if (!stations.some((s) => s.id === x.id)) stations.push({ id: x.id, no: `S·${stations.length}`, name: x.name, agent: x.agent, purpose: x.purpose ?? "", custom: true });
  const gates = cat.gates.slice();
  for (const x of c.gates) if (!gates.some((g) => g.id === x.id)) gates.push({ id: x.id, label: x.label, name: x.name, after: x.after, kind: x.kind ?? "human", purpose: x.purpose ?? "", checks: [], custom: true });
  const bays = cat.bays.slice();
  for (const x of c.bays) if (!bays.some((b) => b.id === x.id)) bays.push({ id: x.id, name: x.name, desc: x.desc ?? "", custom: true } as Catalog["bays"][number]);
  return { ...cat, stations, gates, bays };
}

export interface Presets {
  approvers: Record<"standard" | "light" | "strict", Record<string, ApproverRule>>;
  routes: Record<"standard" | "light" | "strict", NotificationRoute[]>;
}
