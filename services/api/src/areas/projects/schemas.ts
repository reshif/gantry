import { z } from "zod";

/** Wire schemas for the projects area (zod at every boundary; handlers never cast). */

const id = z.string().min(1).max(100);
const str = (max: number) => z.string().max(max);
const ids = z.array(id).max(200);

export const Needs = z.object({ roles: ids, people: ids, oncall: z.boolean() });
export const Condition = z.object({
  id: id,
  when: z.object({ type: z.enum(["class", "risk", "path"]), value: str(200) }),
  needs: Needs,
  text: str(400),
});
export const RuleSchema = z.object({
  roles: ids,
  people: ids,
  required: z.number().int().min(0).max(9),
  /** Per-class override of the approvals count (class id -> count). Whole numbers; range and class ids are checked with the rule. */
  classRequired: z.record(z.string().min(1).max(60), z.number().int()).optional(),
  sod: z.boolean(),
  conditions: z.array(Condition).max(20),
  escalateH: z.number().int().min(0).max(240),
  fallback: id.nullable(),
  note: str(400).optional(),
});

export const RouteSchema = z.object({
  id: id,
  event: str(60).min(1),
  dest: z.array(z.object({ channel: str(40).min(1), target: str(200), integration: id.nullish(), override: str(200).nullish() })).max(20),
  template: str(60),
  cond: z.object({ classes: z.array(str(60)).max(50), priority: z.array(str(10)).max(10), hours: z.enum(["any", "business"]) }),
  enabled: z.boolean(),
  fields: z.record(z.string(), z.boolean()),
});

export const ClassSchema = z.object({
  id: id,
  name: str(80).min(1),
  skips: ids,
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  slaH: z.number().min(1).max(10_000),
  est: z.enum(["S", "M", "L", "XL"]).transform((v) => v as "S" | "M" | "L"),
  splits: z.boolean().optional(),
  endsAfter: id.optional(),
  enabled: z.boolean().optional(),
  token: str(40).optional(),
  shape: str(20).optional(),
  hints: z.array(str(60)).max(50).optional(),
  gates: ids.optional(),
  custom: z.boolean().optional(),
  project: id.optional(),
});

/** PATCH /projects/{id}/config: a path/value edit or a gate mode change. */
export const ConfigBody = z.union([z.object({ path: str(200).min(1), value: z.unknown(), reason: str(1000).optional() }), z.object({ gate: id, mode: str(20), reason: str(1000).optional() })]);

export const NewProject = z.object({
  name: str(80),
  key: str(8).nullish(),
  templateId: id,
  owner: id.nullish(),
  teams: ids.default([]),
  desc: str(2000).nullish(),
  budget: z.number().min(0).max(10_000_000).nullish(),
  approvers: z.record(z.string(), RuleSchema).nullish(),
  notifications: z.array(RouteSchema).max(100).nullish(),
});

export const StationBody = z.object({
  def: z.object({
    id: id.optional(),
    name: str(80),
    agent: id,
    purpose: str(400).optional(),
    wip: z.number().min(1).max(30).optional(),
    gate: z
      .object({ name: str(80), label: str(5).optional(), kind: z.enum(["human", "mixed", "auto"]).optional(), roles: ids.optional(), required: z.number().int().min(1).max(9).optional(), purpose: str(400).optional() })
      .nullish(),
  }),
  after: id.nullish(),
});
export const MoveBody = z.object({ move: z.number().int().min(-1).max(1) });
export const GateBody = z.object({
  def: z.object({ id: id.optional(), label: str(5).optional(), name: str(80), after: id, kind: z.enum(["human", "mixed", "auto"]).optional(), roles: ids.optional(), required: z.number().int().min(1).max(9).optional(), purpose: str(400).optional() }),
});
export const BayBody = z.object({ def: z.object({ id: id.optional(), name: str(80), desc: str(400).optional() }) });
export const ClassBody = z.object({ def: ClassSchema.omit({ id: true }).partial().extend({ id: id.optional(), name: str(80) }) });
export const ClassPatch = ClassSchema.omit({ id: true, custom: true, project: true }).partial().strict();

export const ArchiveBody = z.object({ confirmText: str(200) }).strict();
export const RuleBody = z.object({ value: RuleSchema });

/* ---------------------------------------------------------------- templates -- */

const CustomEntries = z.object({
  stations: z.array(z.object({ id, name: str(80), agent: id, purpose: str(400).optional(), wip: z.number().optional(), after: id })).max(50),
  gates: z.array(z.object({ id, label: str(5), name: str(80), after: id, kind: z.enum(["human", "mixed", "auto"]).optional(), roles: ids.optional(), required: z.number().int().optional(), purpose: str(400).optional() })).max(50),
  bays: z.array(z.object({ id, name: str(80), desc: str(400).optional() })).max(50),
  classes: z.array(ClassSchema).max(50),
});
const Preset = z.enum(["standard", "light", "strict"]);

export const TemplateCreate = z.union([
  z.object({ fromTemplate: id, name: str(80).optional() }),
  z.object({ fromProject: id, name: str(80).optional() }),
]);
export const TemplatePatch = z
  .object({
    name: str(80),
    desc: str(400),
    stationsOff: ids,
    gatesOff: ids,
    slots: z.number().int().min(1).max(8),
    classesSkip: z.record(z.string(), ids),
    custom: CustomEntries,
    approverPreset: Preset,
    notify: Preset,
    mcp: ids,
  })
  .partial()
  .strict();

/* ---------------------------------------------------------------- saved views - */

const Scalar = z.union([z.string().max(100), z.number().finite(), z.boolean(), z.null()]);
export const ViewState = z.record(z.string().max(40), Scalar).refine((o) => Object.keys(o).length <= 20, "too many keys");
export const ViewCreate = z.object({ name: str(60), screen: str(40).default("portfolio"), project: id.nullish(), s: ViewState });
export const ViewPatch = z.object({ name: str(60).optional(), s: ViewState.optional() }).strict();
