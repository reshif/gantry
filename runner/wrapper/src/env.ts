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
  GANTRY_RUN_TOKEN: z.string().min(8),
  GANTRY_RUN_ID: z.string().min(1),
  GANTRY_WORKSPACE: z.string().min(1).default("/workspace"),
});

export function readEnv(env: NodeJS.ProcessEnv = process.env): Result<RunEnv, string> {
  const p = Schema.safeParse(env);
  if (!p.success) return err(p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return ok({ edgeUrl: p.data.EDGE_URL.replace(/\/+$/, ""), runToken: p.data.GANTRY_RUN_TOKEN, runId: p.data.GANTRY_RUN_ID, workspace: p.data.GANTRY_WORKSPACE });
}
