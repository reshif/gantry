import { z } from "zod";

export const IdParam = z.object({ id: z.string().min(1).max(300) });
const reason = z.string().trim().min(1).max(2000);
const cellSpec = z.object({ agent: z.string().min(1).max(100), cls: z.string().min(1).max(100), project: z.string().min(1).max(100), repo: z.string().min(1).max(100).nullish() });

export const GrantBody = z.object({ target: z.union([z.string().min(1).max(300), cellSpec]), level: z.coerce.number().int().min(0).max(4), reason, via: z.string().optional() });
export const DecideBody = z.object({ accept: z.boolean(), reason: z.string().trim().max(2000).optional(), via: z.string().optional() });
export const DemoteBody = z.object({ to: z.coerce.number().int().min(0).max(3), reason, via: z.string().optional() });
const crit = z.object({ cleanRuns: z.coerce.number().int().min(0).max(100000), evalMin: z.coerce.number().min(0).max(1), reworkMax: z.coerce.number().min(0).max(1), incidentsMax: z.coerce.number().int().min(0).max(100000), windowD: z.coerce.number().int().min(1).max(3650) }).partial().strict();
export const CriteriaBody = z.object({ level: z.coerce.number().int().min(2).max(4), patch: crit, note: z.string().max(500).optional(), via: z.string().optional() });
export const CeilingBody = z.object({
  id: z.string().min(1).max(100).optional(),
  text: z.string().trim().min(1).max(300),
  when: z.object({ regulated: z.boolean().optional(), cls: z.string().min(1).max(100).optional(), project: z.string().min(1).max(100).optional(), gate: z.string().min(1).max(100).optional() }).default({}),
  max: z.coerce.number().int().min(0).max(4),
  enabled: z.boolean().default(true),
  via: z.string().optional(),
});
export const RemoveCeilingBody = z.object({ reason: z.string().trim().max(2000).optional() }).partial();
export const SampleBody = z.object({ n: z.coerce.number().int(), via: z.string().optional() });
export const SwitchBody = z.object({ on: z.boolean(), reason: reason.optional(), via: z.string().optional() });
export const CellsQuery = z.object({ project: z.string().min(1).max(100).optional() });
export const OutcomeBody = z.object({
  kind: z.enum(["revert", "incident", "followup"]),
  text: z.string().trim().min(1).max(2000),
  severity: z.enum(["low", "medium", "high"]).optional(),
  attribution: z.union([z.enum(["agent", "spec", "environment", "unrelated"]), z.object({ station: z.string().max(100).optional(), agent: z.string().max(100).optional() })]).optional(),
  station: z.string().max(100).optional(),
  followupTitle: z.string().max(300).optional(),
  via: z.string().optional(),
});
