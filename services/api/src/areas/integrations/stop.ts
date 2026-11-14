import type { Tx } from "@gantry/db";
import { refuseDecision } from "../../core/decide.js";

/** Spec 15.4: a killed factory is read-only for configuration. The refusal is audited as a denial by the pipeline. */
export async function refuseIfFactoryKilled(tx: Pick<Tx, "query">, orgId: string, what: string): Promise<void> {
  const s = (await tx.query<{ reason: string }>(`select reason from stops where org_id = $1 and lifted_at is null and mode = 'kill' and scope_type = 'factory'`, [orgId])).rows[0];
  if (!s) return;
  throw refuseDecision({ allowed: false, reason: `The factory is killed: ${s.reason || "no reason given"}. Restore it to change ${what}.`, rule: { kind: "stop", id: "STOP", name: "Stop state" }, needs: "" });
}
