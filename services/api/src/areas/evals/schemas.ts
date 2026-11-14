import { z } from "zod";
import { CheckSpec } from "./checks.js";

export const IdParam = z.object({ id: z.string().min(1).max(200) });
export const RunParam = z.object({ id: z.string().min(1).max(200), run: z.string().min(1).max(200) });
export const RunBody = z.object({
  agent: z.string().min(1).max(100),
  version: z.union([z.string().min(1).max(60), z.number().int().positive()]),
  model: z.string().min(1).max(200).optional(),
  /** Each task is run this many times; the score counts a task as passed when most of its runs pass. A smoke set uses 1, a full suite on a model change uses more. */
  repeats: z.coerce.number().int().min(1).max(5).default(1),
  via: z.string().optional(),
});
const lines = z.array(z.string().trim().min(1).max(500)).max(50);
export const CaseBody = z.object({
  name: z.string().trim().max(200),
  /** What the agent is asked to do. Defaults to the case name. */
  task: z.string().trim().max(8000).optional(),
  /** The person's own words on what a passing answer must do. Kept with the case, never given to the agent. */
  checks: z.string().trim().max(4000).optional(),
  /** The snapshot the task is pinned to: a repository and a commit. */
  repo: z.string().min(1).max(100).nullish(),
  commit: z.string().regex(/^[0-9a-f]{40}$/).nullish(),
  project: z.string().min(1).max(100).nullish(),
  cls: z.string().min(1).max(100).optional(),
  skill: z.string().min(1).max(100).optional(),
  /** Deterministic checks that decide the case. */
  rules: z.array(CheckSpec).max(30).default([]),
  /** Shorthand lists from the form. */
  mustMention: lines.optional(),
  mustNotMention: lines.optional(),
  mustNotTouch: lines.optional(),
  via: z.string().optional(),
});
