import { enqueue, withTx, type Queryable } from "@gantry/db";
import type { Deps } from "./deps.js";
import { errMsg } from "./errors.js";
import { wallClockWatchdog } from "./handlers/reaper.js";

/**
 * Recurring jobs (spec 6.2): the reaper every minute, a reconcile per GitHub repository, the ledger verifier daily.
 * Each occurrence has a dedupe key that names its time bucket, and the check-then-insert runs under an advisory lock, so any number of workers
 * produce exactly one job per bucket. A bucket missed during downtime is simply the current one on recovery (F7).
 */
export async function ensureRecurring(db: Queryable, o: { orgId: string; queue: string; kind: string; payload: unknown; everyMs: number; scope: string; now: Date }): Promise<boolean> {
  const bucket = Math.floor(o.now.getTime() / o.everyMs);
  const key = `recurring:${o.kind}:${o.scope}:${bucket}`;
  await db.query(`select pg_advisory_xact_lock(hashtext($1))`, [key]);
  const seen = await db.query(`select 1 from jobs where org_id = $1 and dedupe_key = $2 limit 1`, [o.orgId, key]);
  if (seen.rowCount) return false;
  await enqueue(db, { orgId: o.orgId, queue: o.queue, kind: o.kind, payload: o.payload, dedupeKey: key, maxAttempts: 3 });
  return true;
}

export class Scheduler {
  private running = false;
  private loopDone: Promise<void> | null = null;

  constructor(private readonly deps: Deps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopDone = (async () => {
      let lastWatchdog = 0;
      while (this.running) {
        try {
          await this.tick();
          if (this.deps.now().getTime() - lastWatchdog >= this.deps.cfg.watchdogEveryMs) {
            lastWatchdog = this.deps.now().getTime();
            await this.watchdog();
          }
        } catch (e) {
          this.deps.log.error({ err: errMsg(e) }, "scheduler pass failed");
        }
        await this.deps.sleep(Math.min(5_000, this.deps.cfg.watchdogEveryMs));
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopDone;
  }

  async orgs(): Promise<string[]> {
    return (await this.deps.pool.query<{ id: string }>(`select id from orgs order by created_at`)).rows.map((r) => r.id);
  }

  /** Enqueues what is due. Returns the number of jobs created. */
  async tick(): Promise<number> {
    const { deps } = this;
    const now = deps.now();
    let n = 0;
    for (const orgId of await this.orgs()) {
      const make = (queue: string, kind: string, payload: unknown, everyMs: number, scope: string) =>
        withTx(deps.pool, (tx) => ensureRecurring(tx, { orgId, queue, kind, payload, everyMs, scope, now })).then((c) => { if (c) n++; });
      await make("system", "reaper.sweep", {}, deps.cfg.reaperEveryMs, "org");
      await make("system", "chain.verify", {}, deps.cfg.verifyEveryMs, "org");
      const repos = await deps.pool.query<{ id: string }>(
        `select id from repos where org_id = $1 and (github_full_name is not null or name like '%/%') order by id`, [orgId],
      );
      for (const r of repos.rows) await make("github", "github.reconcile", { repoId: r.id }, deps.cfg.reconcileEveryMs, r.id);
    }
    return n;
  }

  /** The wall-clock watchdog (spec 10.5) runs on its own short interval rather than waiting for the minute sweep. */
  async watchdog(): Promise<string[]> {
    const out: string[] = [];
    for (const orgId of await this.orgs()) out.push(...(await wallClockWatchdog(this.deps, orgId)));
    return out;
  }
}
