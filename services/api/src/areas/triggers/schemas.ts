import { z } from "zod";
import { WHO } from "./store.js";

const Id = z.string().min(1).max(100);
export const IdParam = z.object({ id: Id });
export const TYPES = ["issue", "comment", "schedule", "ci"] as const;

const Limits = z.object({ perHour: z.number().int().min(1).max(1000), perDay: z.number().int().min(1).max(10000) });
const Fields = {
  name: z.string().trim().min(1, "Name the trigger.").max(100),
  source: z.string().max(100),
  label: z.string().trim().regex(/^[a-z0-9:_ .-]{1,40}$/i, "Enter the label that fires the trigger."),
  labelMap: z.record(z.string().trim().min(1, "Every mapping needs a label.").max(40), z.string().min(1).max(60)),
  command: z.string().trim().regex(/^\/\S{1,39}( \S{1,40}){0,3}$/, "Commands start with a slash, like /factory fix."),
  schedule: z.string().trim().min(1).max(60),
  cls: z.string().max(60).nullable(),
  who: z.enum(WHO),
  reply: z.string().max(1000),
  dedupe: z.boolean(),
  title: z.string().trim().max(300),
  repo: z.string().max(100).nullable(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).nullable(),
  limits: Limits,
};
export const CreateBody = z.looseObject({
  project: Id,
  type: z.enum(TYPES),
  ...Fields,
  source: Fields.source.optional(),
  label: Fields.label.optional(), labelMap: Fields.labelMap.optional(), command: Fields.command.optional(), schedule: Fields.schedule.optional(), cls: Fields.cls.optional(), who: Fields.who.optional(),
  reply: Fields.reply.optional(), dedupe: Fields.dedupe.optional(), title: Fields.title.optional(), repo: Fields.repo.optional(), priority: Fields.priority.optional(), limits: Limits.partial().optional(),
  enabled: z.boolean().optional(),
});
export const PatchBody = z.looseObject({
  name: Fields.name.optional(), source: Fields.source.optional(), label: Fields.label.optional(), labelMap: Fields.labelMap.optional(), command: Fields.command.optional(), schedule: Fields.schedule.optional(), cls: Fields.cls.optional(),
  who: Fields.who.optional(), reply: Fields.reply.optional(), dedupe: Fields.dedupe.optional(), title: Fields.title.optional(), repo: Fields.repo.optional(), priority: Fields.priority.optional(), limits: Limits.partial().optional(),
  enabled: z.boolean().optional(),
});
export type CreateInput = z.infer<typeof CreateBody>;
export type PatchInput = z.infer<typeof PatchBody>;

/** What a person types into "Simulate incoming". `create: true` asks for the work to be made for real (the default is to only report). */
export const DryRunBody = z.looseObject({
  repo: z.string().max(100).optional(),
  title: z.string().max(400).optional(),
  body: z.string().max(10000).optional(),
  labels: z.array(z.string().max(100)).max(50).optional(),
  author: z.string().max(100).optional(),
  comment: z.string().max(10000).optional(),
  check: z.string().max(200).optional(),
  create: z.boolean().optional(),
});
export const FireBody = z.looseObject({
  title: z.string().max(400).optional(),
  body: z.string().max(10000).optional(),
  repo: z.string().max(100).optional(),
  author: z.string().max(100).optional(),
});
export const ProposalsQuery = z.object({ trigger: z.string().max(100).optional(), status: z.enum(["held", "released", "declined"]).optional() });
export const DecideBody = z.looseObject({ note: z.string().max(2000).optional(), reason: z.string().max(2000).optional() });
