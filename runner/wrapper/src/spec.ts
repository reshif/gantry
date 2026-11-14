import { z } from "zod";

/**
 * The run spec the edge serves at GET /run/v1/spec (spec 10.1: workspace, composed instructions, skills bundle,
 * MCP tool set, tool allow-list, model reference, limits). Unknown extra fields are tolerated so the edge can add
 * data without breaking runners; everything the wrapper acts on is validated here.
 */
export const RunSpec = z.looseObject({
  runId: z.string().min(1).optional(),
  adapter: z.enum(["claude", "stub"]),
  station: z.string().min(1),
  /** Exact model id (never an alias). Required for the claude adapter. */
  model: z.string().min(1).optional(),
  /** Composed instructions: factory base, project overlay, agent, repository guidelines (spec 10.2). */
  instructions: z.string().default(""),
  skills: z.array(z.object({ name: z.string().min(1), content: z.string() })).default([]),
  /** MCP servers, reached through the edge's MCP gateway only. Passed to the harness explicitly. */
  mcpServers: z.record(z.string(), z.looseObject({ type: z.enum(["http", "sse"]), url: z.string().url() })).default({}),
  toolAllowList: z.array(z.string().min(1)).default([]),
  limits: z
    .object({
      turns: z.number().int().positive().default(40),
      costUsd: z.number().positive().optional(),
      wallClockSeconds: z.number().int().positive().default(3600),
    })
    .default({ turns: 40, wallClockSeconds: 3600 }),
  heartbeatSeconds: z.number().positive().default(15),
  /** The previous station's structured result and artefacts (spec 10.2), or the work order brief. */
  input: z.unknown().optional(),
  /** Stub adapter control: when `output` is present it is returned as the station result verbatim. */
  stub: z.object({ output: z.unknown().optional(), failWith: z.string().optional(), delayMs: z.number().int().min(0).max(60_000).optional() }).optional(),
});
export type RunSpec = z.infer<typeof RunSpec>;
