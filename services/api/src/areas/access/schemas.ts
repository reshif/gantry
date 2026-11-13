import { z } from "zod";

const id = z.string().min(1).max(100);
const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "use HH:MM");

export const PolicyBody = z.object({
  name: z.string().trim().min(1, "Name the policy.").max(200),
  effect: z.enum(["allow", "deny"]),
  roles: z.array(id).min(1, "Pick at least one role.").max(100),
  actions: z.array(id).min(1, "Pick at least one action.").max(200),
  where: z
    .object({ projects: z.array(id).max(200).optional(), regulated: z.boolean().optional(), freeze: z.boolean().optional() })
    .passthrough()
    .default({}),
  when: z.object({ days: z.array(z.number().int().min(0).max(6)).max(7), from: hhmm, to: hhmm }).nullable().default(null),
  oncallOnly: z.boolean().default(false),
  extend: z.boolean().optional(),
  enabled: z.boolean().optional(),
  note: z.string().max(500).optional(),
});
export type PolicyInput = z.infer<typeof PolicyBody>;

export const PolicyPatch = z.union([
  z.object({ enabled: z.boolean() }).strict(),
  PolicyBody,
]);

export const FreezeBody = z.object({
  name: z.string().trim().min(1, "Name the freeze.").max(200),
  repos: z.union([z.literal("all"), z.array(id).min(1).max(500)]),
  from: z.number().finite(),
  to: z.number().finite(),
});

export const RoleCreate = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/).optional(),
  name: z.string().trim().min(1, "Name the role.").max(100),
  level: z.enum(["factory", "project"]).default("project"),
  base: id.optional(),
  desc: z.string().trim().max(500).default(""),
});

export const RolePatch = z.object({
  name: z.string().trim().min(1, "Name the role.").max(100).optional(),
  desc: z.string().trim().max(500).optional(),
  level: z.enum(["factory", "project"]).optional(),
});

export const MatrixBody = z.object({ on: z.boolean() });

export const SimulateBody = z.object({
  person: id,
  action: id,
  project: id.nullish(),
  repo: id.nullish(),
  time: z.number().finite().optional(),
});
