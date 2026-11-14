import { z } from "zod";

const id = z.string().trim().min(1).max(120);

export const Destination = z.object({
  channel: z.string().trim().min(1).max(40),
  target: z.string().trim().max(300).default(""),
  integration: id.nullish(),
  override: z.string().max(200).nullish(),
});

export const Condition = z.object({
  classes: z.array(z.string().max(60)).max(40).default([]),
  priority: z.array(z.string().max(10)).max(10).default([]),
  hours: z.enum(["any", "business"]).default("any"),
});

export const Fields = z.object({
  title: z.boolean().default(true), repo: z.boolean().default(true), class: z.boolean().default(true), priority: z.boolean().default(true), approvers: z.boolean().default(true), link: z.boolean().default(true), actions: z.boolean().default(true),
});

export const RouteBody = z.object({
  event: z.string().trim().min(1).max(60),
  dest: z.array(Destination).min(1, "A route needs at least one destination.").max(10),
  template: z.string().trim().max(60).default(""),
  cond: Condition.default({ classes: [], priority: [], hours: "any" }),
  enabled: z.boolean().default(true),
  fields: Fields.default({ title: true, repo: true, class: true, priority: true, approvers: true, link: true, actions: true }),
  via: z.string().optional(),
});
export const RoutePatch = RouteBody.partial();

export const ProjectParam = z.object({ id });
export const RouteParam = z.object({ id, rid: id });

export const TestBody = z.object({
  dest: z.union([z.string().trim().min(1).max(40), Destination]),
  target: z.string().trim().max(300).optional(),
  integration: id.nullish(),
  event: z.string().trim().max(60).optional(),
  via: z.string().optional(),
});

export const DeliveryQuery = z.object({
  project: id.optional(), status: z.enum(["delivered", "failed", "pending", "all"]).optional(), integration: id.optional(), event: id.optional(),
  cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(40),
});

export const CardTemplateBody = z.object({
  id: id.optional(),
  name: z.string().trim().max(80).default(""),
  kind: z.string().trim().max(40).default(""),
  fields: z.array(z.string().max(30)).max(20).default([]),
  actions: z.array(z.string().max(30)).max(20).default([]),
  integration: id.nullish(),
  project: id.nullish(),
  via: z.string().optional(),
});

export const PreviewBody = z.object({
  project: id,
  event: z.string().trim().min(1).max(60),
  template: z.string().trim().max(60).optional(),
  fields: Fields.partial().optional(),
  actions: z.array(z.string().max(30)).max(20).optional(),
  wo: id.optional(),
});
