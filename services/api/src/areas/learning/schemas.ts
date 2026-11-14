/** Request shapes for the learning loop (spec 8.7). Changes are strict per kind: nothing outside the listed fields can ride along, so a proposal cannot carry an edit to a grader, an eval case or a trust criterion. */
import { z } from "zod";
import { KINDS, MAX_WINDOW_DAYS } from "./config.js";

const id = z.string().trim().min(1).max(120);
const text = (max: number) => z.string().trim().min(1).max(max);
const Via = z.string().optional();

export const IdParam = z.object({ id });
export const FindingParam = z.object({ id });

const Needs = z.object({ roles: z.array(id).max(10).default([]), people: z.array(id).max(10).default([]), oncall: z.boolean().default(false) }).strict();

export const Changes = {
  skill: z.object({ skill: id, before: z.string().max(100_000).optional(), after: z.string().min(1).max(100_000) }).strict(),
  eval: z.object({
    suite: id,
    case: z.object({
      name: text(200), task: z.string().trim().max(4000).optional(), checks: z.string().trim().max(2000).optional(),
      mustMention: z.array(text(300)).max(20).optional(), mustNotMention: z.array(text(300)).max(20).optional(), mustNotTouch: z.array(text(300)).max(20).optional(), cls: id.optional(),
    }).strict(),
  }).strict(),
  guideline: z.object({ project: id, item: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/).optional(), text: text(500), required: z.boolean() }).strict() }).strict(),
  guardrail: z.object({ agent: id, path: text(300) }).strict(),
  approver: z.object({
    project: id, gate: id,
    condition: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/).optional(), when: z.object({ type: z.enum(["class", "risk", "path"]), value: text(300) }).strict(), needs: Needs, text: text(300) }).strict(),
  }).strict(),
  route: z.object({ project: id, cls: id, addSkip: id }).strict(),
} as const;

const Metric = z.object({ target: z.number().int().min(0).max(100_000) }).strict();

export const DraftBody = z.object({
  finding: id,
  kind: z.enum(KINDS),
  title: text(200),
  expected: z.string().trim().max(1000).default(""),
  change: z.record(z.string(), z.unknown()),
  /** Declared before the change: at most `target` signals of the finding's kind in the `windowDays` after it is applied. */
  metric: Metric,
  windowDays: z.number().int().min(1).max(MAX_WINDOW_DAYS),
  via: Via,
}).strict();

export const AcceptBody = z.object({ note: z.string().trim().max(500).optional(), via: Via }).strict();
export const DeclineBody = z.object({ reason: z.string().trim().min(4, "Say why.").max(1000), via: Via }).strict();
export const VerifyBody = z.object({ via: Via }).strict();
export const RollbackBody = z.object({ reason: z.string().trim().min(4, "Say why.").max(1000), via: Via }).strict();
export const SwitchBody = z.object({ on: z.boolean(), reason: z.string().trim().max(500).optional(), via: Via }).strict();
export const RefreshBody = z.object({ via: Via }).strict();
export const SignalsQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

export type DraftInput = z.infer<typeof DraftBody>;
