import type { Project, Template, WorkClass } from "@gantry/domain";
import { Refusal, invalid } from "../../core/errors.js";
import { addBay, addClass, addGate, addStation, type FlowDraft } from "./flowedit.js";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Custom flow entries a template carries (legacy `G.templateKit`): everything beyond the built-in stations, gates, bays and classes. */
export interface TemplateCustom {
  stations: { id: string; name: string; agent: string; purpose?: string | undefined; wip?: number | undefined; after: string }[];
  gates: { id: string; label: string; name: string; after: string; kind?: "human" | "mixed" | "auto" | undefined; roles?: string[] | undefined; required?: number | undefined; purpose?: string | undefined }[];
  bays: { id: string; name: string; desc?: string | undefined }[];
  classes: WorkClass[];
}

export const emptyCustom = (): TemplateCustom => ({ stations: [], gates: [], bays: [], classes: [] });

export function customOf(t: { custom?: unknown } | null | undefined): TemplateCustom {
  const c = (t?.custom ?? {}) as Partial<TemplateCustom>;
  return { stations: c.stations ?? [], gates: c.gates ?? [], bays: c.bays ?? [], classes: c.classes ?? [] };
}

export const customCount = (c: TemplateCustom): number => c.stations.length + c.gates.length + c.bays.length + c.classes.length;

/** The project's custom entries in a form `applyCustom` can replay into another project. */
export function customFromProject(draft: FlowDraft, project: Pick<Project, "approvers" | "flow">): TemplateCustom {
  const order = project.flow.order;
  const gateIds = new Set(Object.entries(project.flow.gates).filter(([, g]) => !g.absent).map(([k]) => k));
  return {
    stations: draft.catalog.stations
      .filter((s) => s.custom && order.includes(s.id))
      .map((s) => ({ id: s.id, name: s.name, agent: s.agent, purpose: s.purpose || "", wip: project.flow.stations[s.id]?.wip ?? 5, after: order[order.indexOf(s.id) - 1] ?? "review" })),
    gates: draft.catalog.gates
      .filter((g) => g.custom && gateIds.has(g.id))
      .map((g) => {
        const r = project.approvers[g.id];
        return { id: g.id, label: g.label, name: g.name, after: g.after, kind: project.flow.gates[g.id]?.mode ?? g.kind, roles: (r?.roles ?? []).slice(), required: r?.required ?? 1, purpose: g.purpose || "" };
      }),
    bays: draft.catalog.bays.filter((b) => b.custom && project.flow.bays.includes(b.id)).map((b) => ({ id: b.id, name: b.name, desc: b.desc || "" })),
    classes: project.flow.classes.filter((c) => c.custom).map(clone),
  };
}

/** Template body (the `templates.body` jsonb) saved from a project: built-in ids in the lists, custom entries beside them. */
export function templateBodyFromProject(draft: FlowDraft, project: Project): Omit<Template, "id" | "name" | "desc" | "builtIn"> & { custom: TemplateCustom } {
  const builtSt = (id: string) => draft.catalog.stations.some((s) => s.id === id && !s.custom);
  const builtG = (id: string) => draft.catalog.gates.some((g) => g.id === id && !g.custom);
  const classesSkip: Record<string, string[]> = {};
  for (const c of project.flow.classes) {
    const def = draft.catalog.classes.find((x) => x.id === c.id);
    if (def && !def.custom && JSON.stringify(def.skips) !== JSON.stringify(c.skips)) classesSkip[c.id] = c.skips.slice();
  }
  return {
    stationsOff: Object.entries(project.flow.stations).filter(([k, s]) => !s.enabled && !s.absent && builtSt(k)).map(([k]) => k),
    gatesOff: Object.entries(project.flow.gates).filter(([k, g]) => !g.enabled && !g.absent && builtG(k)).map(([k]) => k),
    slots: project.flow.slots,
    classesSkip,
    mcp: project.mcp.slice(),
    approverPreset: project.regulated ? "strict" : "standard",
    notify: "standard",
    order: project.flow.order.filter(builtSt),
    bays: project.flow.bays.filter((id) => draft.catalog.bays.some((b) => b.id === id && !b.custom)),
    custom: customFromProject(draft, project),
  };
}

/** Adds a template's custom entries to a project through the flow edits: `{ done, failed }` (a failure does not stop the rest). */
export function applyCustom(draft: FlowDraft, custom: TemplateCustom, agents: ReadonlySet<string>): { done: string[]; failed: string[] } {
  const done: string[] = [];
  const failed: string[] = [];
  const run = (label: string, f: () => void): void => {
    try {
      f();
      done.push(label);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      failed.push(`${label}: ${e.error.msg}`);
    }
  };
  for (const x of custom.stations) {
    run(x.name, () => {
      const order = draft.flow.order;
      const after = order.includes(x.after) && x.after !== "close" ? x.after : (order[order.length - 2] as string);
      addStation(draft, { id: x.id, name: x.name, agent: x.agent, purpose: x.purpose, wip: x.wip }, after, agents.has(x.agent));
    });
  }
  for (const x of custom.gates) run(`${x.label} ${x.name}`, () => addGate(draft, x));
  for (const x of custom.bays) run(x.name, () => addBay(draft, x));
  for (const x of custom.classes) {
    run(x.name, () => {
      const { custom: _c, project: _p, enabled: _e, id, name, ...rest } = clone(x);
      const live = (g: string) => !!draft.flow.gates[g] && !draft.flow.gates[g]!.absent;
      addClass(draft, { ...rest, id, name, skips: (rest.skips ?? []).filter((s) => draft.flow.order.includes(s) && s !== "intake" && s !== "close"), gates: (rest.gates ?? []).filter(live) });
    });
  }
  return { done, failed };
}

/** A template patch must only name built-in stations, gates and classes (custom entries travel in `custom`), and keep Intake and G0+G1 on. */
export function checkTemplatePatch(
  p: { stationsOff?: string[] | undefined; gatesOff?: string[] | undefined; classesSkip?: Record<string, string[]> | undefined },
  c: { stations: { id: string; custom?: boolean | undefined }[]; gates: { id: string; custom?: boolean | undefined }[]; classes: { id: string; custom?: boolean | undefined }[] },
): void {
  const st = (id: string) => c.stations.some((s) => s.id === id && !s.custom);
  const bad = (p.stationsOff ?? []).filter((id) => !st(id));
  if (bad.length) throw invalid(`Unknown or custom stations: ${bad.join(", ")}.`);
  if (p.stationsOff?.includes("intake")) throw invalid("Intake is always on.");
  const badG = (p.gatesOff ?? []).filter((id) => !c.gates.some((g) => g.id === id && !g.custom));
  if (badG.length) throw invalid(`Unknown or custom gates: ${badG.join(", ")}.`);
  if (p.gatesOff?.includes("G0G1")) throw invalid("G0+G1 is always on.");
  for (const [cls, skips] of Object.entries(p.classesSkip ?? {})) {
    if (!c.classes.some((x) => x.id === cls && !x.custom)) throw invalid(`Unknown or custom class ${cls}.`);
    if (skips.some((s) => s === "intake" || s === "close" || !st(s))) throw invalid(`${cls} can only skip built-in stations other than Intake and Close.`);
  }
}
