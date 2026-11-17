import { z } from "zod";
import { err, ok, type Result } from "./result.js";

/** What the launcher puts in the runner's environment (spec 4.1). Nothing else is read. */
export interface RunEnv {
  edgeUrl: string;
  runToken: string;
  runId: string;
  workspace: string;
}

const Schema = z.object({
  EDGE_URL: z.string().url(),
  GANTRY_RUN_ID: z.string().min(1),
  GANTRY_WORKSPACE: z.string().min(1).default("/workspace"),
});

/**
 * The run token is not in the environment: the launcher copies it into a file the wrapper takes with takeToken (token.ts). An environment that
 * still carries it is refused, since every process of the same uid could already read it from /proc.
 */
export function readEnv(token: string, env: NodeJS.ProcessEnv = process.env): Result<RunEnv, string> {
  if (env.GANTRY_RUN_TOKEN !== undefined) return err("GANTRY_RUN_TOKEN is in the environment; the run token must arrive in the token file only.");
  if (token.length < 8) return err("The run token is too short.");
  const p = Schema.safeParse(env);
  if (!p.success) return err(p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return ok({ edgeUrl: p.data.EDGE_URL.replace(/\/+$/, ""), runToken: token, runId: p.data.GANTRY_RUN_ID, workspace: p.data.GANTRY_WORKSPACE });
}
