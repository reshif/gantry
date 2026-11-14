import { z } from "zod";
import { Via } from "../agents/schemas.js";

const id = z.string().trim().min(1).max(100);
const Res = z.array(z.string().trim().min(1).max(200)).max(50);
export const SkillPatch = z
  .object({
    name: z.string().trim().min(1, "Name the skill.").max(100),
    desc: z.string().max(1000),
    when: z.string().max(1000),
    body: z.string().max(20000),
    resources: Res,
  })
  .partial()
  .strict();
export const SaveSkillBody = z.object({ patch: SkillPatch, note: z.string().trim().max(300).optional(), via: Via });
export const CreateSkillBody = z.object({
  name: z.string().trim().min(1, "Name the skill.").max(100),
  desc: z.string().max(1000).optional(),
  when: z.string().max(1000).optional(),
  body: z.string().max(20000).optional(),
  resources: Res.optional(),
  note: z.string().trim().max(300).optional(),
  via: Via,
});
export const ProjectsBody = z.object({ projects: z.union([z.literal("all"), z.array(id).max(500)]), via: Via });
export const SkillIdParam = z.object({ id: id });
