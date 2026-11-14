import { revokeRunTokens } from "@gantry/api/core";
import { withTx } from "@gantry/db";
import type { Deps } from "../deps.js";

/**
 * Spec 4.3 steps 7-8: tell the launcher to stop the run and remove its network, container and (after publishing) its volume, then mark the run row.
 * Throws when the launcher could not finish (the caller retries; stop-run is idempotent).
 */
export async function teardownRun(deps: Deps, orgId: string, runId: string, end: "succeeded" | "failed" | "stopped", o: { by?: string } = {}): Promise<void> {
  await deps.launcher.stop(runId, { keepWorkspace: false });
  await withTx(deps.pool, async (tx) => {
    await revokeRunTokens(tx, { orgId, runIds: [runId], reason: o.by ?? "run ended" });
    await tx.query(
      `update runs set state = case when state in ('starting','running') then $3 else state end, ended_at = coalesce(ended_at, now()), updated_at = now(),
              data = data || $4::jsonb where org_id = $1 and id = $2`,
      [orgId, runId, end, JSON.stringify(o.by ? { endedBy: o.by } : {})],
    );
  });
}
