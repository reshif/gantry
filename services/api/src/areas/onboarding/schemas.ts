import { MAX_TEST_COMMANDS, checkTestCommand } from "./testcmd.js";
import { NOTIFY_EVENTS } from "@gantry/domain";
import { z } from "zod";

const id = z.string().min(1).max(100);
const names = new Set(NOTIFY_EVENTS.map((e) => e.id));

/** `owner/name` on GitHub. */
export const RepoFullName = z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use the form org/name.").max(200);

export const ConnectBody = z.object({
  name: RepoFullName,
  team: id.nullish(),
  /** An integration instance of a source-control type, or null for the GitHub App itself. */
  source: id.nullish(),
}).strict();

const Override = z.object({
  id: id,
  event: z.string().min(1).max(60).refine((e) => names.has(e), "Unknown event."),
  dest: z.array(z.object({ channel: z.string().min(1).max(40), target: z.string().trim().min(1).max(200), integration: id.nullish(), override: z.string().max(200).nullish() })).min(1).max(10),
  template: z.string().max(100),
  mode: z.enum(["also", "instead"]).default("also"),
});

/** Per-repo settings (legacy `configureRepo` patch keys). Only the keys present change. */
export const ConfigBody = z.object({
  team: id.optional(),
  mcp: z.array(id).max(100).optional(),
  notifyOverrides: z.array(Override).max(50).optional(),
  triggers: z.boolean().optional(),
  source: id.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  guidelines: z.string().max(20000).optional(),
  config: z.object({
    defaultBranch: z.string().trim().min(1).max(250).regex(/^[A-Za-z0-9._/-]+$/, "Not a valid branch name.").optional(),
    branchPrefix: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._/-]+$/, "Not a valid branch prefix.").optional(),
    merge: z.enum(["squash", "merge", "rebase"]).optional(),
    tagging: z.enum(["semver-patch", "semver-minor", "calver", "none"]).optional(),
    requiredChecks: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    protectedPaths: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
    /** The project's own test commands, confirmed by the person saving this. They become narrow shell permissions for the stations that may run tests. */
    testCommands: z.array(z.string()).max(MAX_TEST_COMMANDS).superRefine((list, ctx) => {
      list.forEach((c, i) => { const r = checkTestCommand(c); if (!r.ok) ctx.addIssue({ code: "custom", path: [i], message: r.reason }); });
    }).transform((list) => list.map((c) => (checkTestCommand(c) as { command: string }).command)).optional(),
  }).strict().optional(),
  via: z.string().optional(),
}).strict().refine((b) => Object.keys(b).filter((k) => k !== "via").length > 0, "Nothing to change.");
export type ConfigBody = z.infer<typeof ConfigBody>;

export const ChangesBody = z.object({ text: z.string().trim().min(5, "Describe the change you want.").max(5000), via: z.string().optional() }).strict();
export const ExceptionBody = z.object({ reason: z.string().trim().min(10, "Give a reason of at least 10 characters.").max(2000), via: z.string().optional() }).strict();
export const EmptyBody = z.object({ via: z.string().optional() }).strict().nullish();
