import { z } from "zod";

/** The run token as the runner presents it. */
export const Token = z.string().min(20).max(700);

/** The body of the station result delivery (POST /internal/v1/runs/:id/result). The prompt manifest derives its "result shape" part from this schema, so a change here changes the hash. */
export const ResultBody = z.looseObject({
  token: Token,
  status: z.enum(["succeeded", "failed", "interrupted", "needs_person"]),
  output: z.unknown().optional(),
  usage: z.array(z.looseObject({ model: z.string() })).default([]),
  error: z.object({ code: z.string(), msg: z.string() }).optional(),
  adapter: z.string().max(100),
  capabilities: z.unknown().optional(),
});
