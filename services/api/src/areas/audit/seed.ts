import type { DevSeed } from "@gantry/domain";
import { EVENT_CATEGORIES, EVENT_CHANNELS, appendEvent, withTx, type EventCategory, type EventChannel, type EventOutcome } from "@gantry/db";
import type pg from "pg";

/** The legacy outcome words the ledger has no column value for: a blocked action was refused, so it is recorded as denied. */
const OUTCOME: Record<string, EventOutcome> = { ok: "ok", denied: "denied", blocked: "denied", failed: "failed", regression: "regression" };

/**
 * Dev and demo only (GANTRY_DEV_SEED=true): the legacy seed's audit history becomes ledger entries, in order, through the same
 * append path as everything else, so the hash chain covers them. Never called without the seed flag.
 */
export async function seedDemoAudit(pool: pg.Pool, orgId: string, seed: Pick<DevSeed, "state">): Promise<number> {
  const entries = [...seed.state.audit].sort((a, b) => a.id - b.id);
  await withTx(pool, async (tx) => {
    for (const e of entries) {
      const channel: EventChannel = (EVENT_CHANNELS as readonly string[]).includes(e.via) ? (e.via as EventChannel) : "system";
      const category: EventCategory = (EVENT_CATEGORIES as readonly string[]).includes(e.category) ? (e.category as EventCategory) : "config";
      await appendEvent(tx, {
        orgId, type: e.action, category, actor: e.actor, channel, subject: { type: e.entity?.type ?? "seed", id: e.entity?.id ?? String(e.id), target: e.target },
        projectId: e.project, outcome: OUTCOME[e.outcome] ?? "ok", before: e.before, after: e.after, occurredAt: new Date(e.at),
      });
    }
  });
  return entries.length;
}
