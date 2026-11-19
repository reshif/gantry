import { z } from "zod";
import { AUTONOMY_LEVELS, TOOL_KEYS } from "./config.js";

const id = z.string().trim().min(1).max(100);
const ids = z.array(id).max(200);
export const Via = z.string().max(20).optional();

const Tools = z.object(Object.fromEntries(TOOL_KEYS.map((k) => [k, z.boolean()])) as Record<(typeof TOOL_KEYS)[number], z.ZodBoolean>).partial().strict();
const Autonomy = z.enum(AUTONOMY_LEVELS);
const Override = z.object({ model: z.string().trim().min(1).max(100).optional(), autonomy: Autonomy.optional(), budget: z.number().min(0).max(100000).optional() }).strict();

export const AgentPatch = z
  .object({
    name: z.string().trim().min(1, "The agent needs a name.").max(80),
    model: z.string().trim().max(100),
    fallbacks: ids,
    autonomy: Autonomy,
    tools: Tools,
    skills: ids,
    mcp: ids,
    stations: ids,
    projects: z.union([z.literal("all"), ids]),
    budget: z.number().min(0).max(100000),
    guardrails: z.object({ paths: z.array(z.string().trim().min(1).max(300)).max(200), maxDiff: z.number().int().min(0).max(1_000_000) }).strict(),
    instructions: z.string().max(20000),
    overrides: z.record(id, Override),
    suite: id,
    status: z.enum(["active", "paused"]),
  })
  .partial()
  .strict();

export const SaveBody = z.object({ patch: AgentPatch, note: z.string().trim().max(300).optional(), overrideReason: z.string().trim().max(300).optional(), via: Via });

export const CreateBody = z.object({
  name: z.string().trim().min(1, "Give the agent a name.").max(80),
  station: z.string().trim().min(1).max(64).nullable().optional(),
  model: z.string().trim().max(100).optional(),
  fallbacks: ids.optional(),
  autonomy: Autonomy.optional(),
  tools: Tools.optional(),
  stations: ids.optional(),
  projects: z.union([z.literal("all"), ids]).optional(),
  budget: z.number().min(0).max(100000).optional(),
  instructions: z.string().max(20000).optional(),
  skills: ids.optional(),
  mcp: ids.optional(),
  via: Via,
});

export const VERSION_LABEL = /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/;
export const NewVersionBody = z.object({
  label: z.string().trim().regex(VERSION_LABEL, "Version must look like 1.2.3 or 1.2.3-rc1."),
  note: z.string().trim().max(300).optional(),
  via: Via,
});
export const RollbackBody = z.object({ version: z.union([z.string().min(1).max(60), z.number().int().positive()]), overrideReason: z.string().trim().max(300).optional(), via: Via });
export const IdParam = z.object({ id: id });
export const VersionParam = z.object({ id: id, v: z.string().min(1).max(60) });
export const SkillParam = z.object({ id: id, skill: id });
export const InstructionsBody = z.object({ text: z.string().max(40000), via: Via });
export const EffectiveQuery = z.object({ project: id.optional(), repo: id.optional(), version: z.string().max(60).optional() });
