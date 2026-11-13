import type { ApproverRule, Catalog, NotificationRoute, ProjectFlow, Template } from "@gantry/domain";

/**
 * Template-driven defaults for a new project (legacy `G.flowFrom`, `G.approversPreset`, `G.routesPreset`).
 * The server owns these: the browser sends a template id and the server derives the flow, approver rules and routes.
 */

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export type Preset = "standard" | "light" | "strict";
export const isPreset = (v: unknown): v is Preset => v === "standard" || v === "light" || v === "strict";

/** A flow with an entry for every catalogue station and gate. Custom entries a project has not adopted are `absent`, so lookups never fail. */
export function flowFrom(catalog: Pick<Catalog, "stations" | "gates" | "bays" | "classes">, tpl: Pick<Template, "stationsOff" | "gatesOff" | "slots" | "classesSkip" | "order" | "bays">): ProjectFlow {
  const off = new Set(tpl.stationsOff ?? []);
  const gOff = new Set(tpl.gatesOff ?? []);
  const stations: ProjectFlow["stations"] = {};
  for (const s of catalog.stations) stations[s.id] = s.custom ? { enabled: false, wip: 5, absent: true } : { enabled: !off.has(s.id), wip: s.id === "build" ? 4 : 5 };
  const gates: ProjectFlow["gates"] = {};
  for (const g of catalog.gates) gates[g.id] = g.custom ? { enabled: false, mode: g.kind, absent: true } : { enabled: !gOff.has(g.id), mode: g.kind };
  const order = (tpl.order ?? catalog.stations.filter((s) => !s.custom).map((s) => s.id)).slice();
  const bays = (tpl.bays ?? catalog.bays.filter((b) => !b.custom).map((b) => b.id)).slice();
  const classes = catalog.classes
    .filter((c) => !c.custom)
    .map((c) => {
      const x = clone(c);
      const skip = tpl.classesSkip?.[c.id];
      if (skip) x.skips = skip.slice();
      x.enabled = true;
      return x;
    });
  return { stations, gates, slots: tpl.slots, classes, order, bays };
}

export function approversPreset(kind: Preset, catalog: Pick<Catalog, "gates">): Record<string, ApproverRule> {
  const strict = kind === "strict";
  const light = kind === "light";
  const out: Record<string, ApproverRule> = {
    G0G1: { roles: ["engineer", "line_lead", "project_admin"], people: [], required: 1, sod: false, conditions: [], escalateH: 24, fallback: null, note: "Submitter confirms. Engineers may confirm only briefs they submitted." },
    G1f: { roles: [], people: [], required: 0, sod: false, conditions: [], escalateH: 0, fallback: null },
    G2: { roles: ["line_lead", "project_admin"], people: [], required: strict ? 2 : 1, sod: true, conditions: [], escalateH: 24, fallback: null },
    G3d: { roles: ["reviewer", "line_lead"], people: [], required: 1, sod: true, conditions: [], escalateH: 24, fallback: null },
    G3G3s: {
      roles: ["line_lead", "project_admin"], people: [], required: 1, sod: true, escalateH: 12, fallback: null,
      conditions: light ? [] : [{ id: "c1", when: { type: "path", value: "/payments" }, needs: { roles: ["approver"], people: [], oncall: false }, text: "Changes under /payments need Security" }],
    },
    G4: { roles: [], people: [], required: 0, sod: false, conditions: [], escalateH: 0, fallback: null },
    G5: {
      roles: light ? ["reviewer", "line_lead", "engineer"] : ["reviewer", "line_lead"], people: [], required: strict ? 2 : 1, sod: true, escalateH: 8, fallback: null,
      conditions: [
        { id: "c2", when: { type: "class", value: "hotfix" }, needs: { roles: ["release_manager"], people: [], oncall: true }, text: "Hotfix needs a Release Manager who is on call" },
        ...(strict ? [{ id: "c3", when: { type: "risk" as const, value: "high" }, needs: { roles: ["approver"], people: [], oncall: false }, text: "High-risk changes need an Approver (Security)" }] : []),
      ],
    },
    G6: { roles: ["release_manager"], people: [], required: 1, sod: false, conditions: [], escalateH: 24, fallback: null },
  };
  // Rules for custom gates exist in every project (unused unless the gate is in that project's flow).
  for (const g of catalog.gates) if (g.custom && !out[g.id]) out[g.id] = { roles: ["line_lead", "project_admin"], people: [], required: 1, sod: true, conditions: [], escalateH: 24, fallback: null };
  return out;
}

const ALL = { classes: [] as string[], priority: [] as string[], hours: "any" as const };
const FIELDS = { title: true, repo: true, class: true, priority: true, approvers: true, link: true };

/** Notification routes for a preset. Ids are `NR-n`; the store prefixes them with the project id. */
export function routesPreset(kind: Preset): NotificationRoute[] {
  const mk = (event: string, dest: { channel: string; target: string }[], template: string, hours: "any" | "business" = "any") => ({ event, dest, template, cond: { ...ALL, hours } });
  let list = [
    mk("gate.waiting", [{ channel: "slack", target: "#factory-gates" }], "gate"),
    mk("question", [{ channel: "slack", target: "@submitter" }, { channel: "email", target: "submitter" }], "question", "business"),
    mk("andon", [{ channel: "slack", target: "#incidents" }, { channel: "paging", target: "payments-oncall" }], "incident"),
    mk("kill", [{ channel: "slack", target: "#incidents" }, { channel: "paging", target: "factory-oncall" }, { channel: "email", target: "project admins" }], "kill"),
    mk("restore", [{ channel: "slack", target: "#incidents" }, { channel: "email", target: "project admins" }], "kill"),
    mk("released", [{ channel: "slack", target: "#releases" }, { channel: "teams", target: "Releases" }], "release"),
    mk("onboarding.pr", [{ channel: "slack", target: "#factory-onboarding" }], "onboarding"),
    mk("security.hold", [{ channel: "slack", target: "#security" }, { channel: "webhook", target: "siem" }], "incident"),
    mk("submitted", [{ channel: "webhook", target: "jira-sync" }], "submitted"),
    mk("budget", [{ channel: "email", target: "project admins" }], "budget"),
  ];
  if (kind === "strict") list.push(mk("gate.decided", [{ channel: "email", target: "compliance@acme.dev" }], "gate"));
  if (kind === "light") list = list.filter((x) => ["gate.waiting", "question", "andon", "kill", "restore", "released"].includes(x.event));
  return list.map((x, i) => ({ ...x, id: `NR-${i + 1}`, enabled: true, fields: { ...FIELDS } }) as NotificationRoute);
}
