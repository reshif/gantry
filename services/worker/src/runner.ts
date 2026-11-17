import { jobSeconds, jobsTotal } from "./metrics.js";
import { claim, complete, fail, fireDue, heartbeat, nextFireAt, withTx, type Job } from "@gantry/db";
import type { Deps } from "./deps.js";
import { errMsg, PermanentError } from "./errors.js";

export interface HandlerCtx {
  deps: Deps;
  /** Aborts when the lease on the job was lost (another worker may now run it) or the worker is shutting down hard. */
  signal: AbortSignal;
  /** True on the last attempt the queue will make: handlers that must record an outcome instead of failing use it. */
  last: boolean;
}

/** A handler returns the job's result (stored on the row) or throws: `PermanentError` is not retried, anything else is retried with backoff. */
export type Handler = (job: Job, ctx: HandlerCtx) => Promise<unknown>;
export type Handlers = Record<string, Handler>;

/** Queues the job runner consumes, with their concurrency. The `timers` queue holds jobs made from due timers (`fireDue`). */
export interface RunnerOptions {
  queues: Record<string, number>;
}

/**
 * Job loop over the Postgres queue (spec 6.2): claims with leases, runs handlers with per-queue concurrency, heartbeats the lease while a handler runs,
 * retries with capped exponential backoff and jitter, and shuts down gracefully (stops claiming, waits for what is running).
 * Timers are fired here too: a timer due while the worker was down is fired on the first pass after recovery (F7).
 */
export class JobRunner {
  private running = false;
  private loopDone: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private readonly inflight = new Map<string, Set<Promise<void>>>();
  private readonly aborters = new Set<AbortController>();

  constructor(private readonly deps: Deps, private readonly handlers: Handlers, private readonly opts: RunnerOptions) {
    for (const q of Object.keys(opts.queues)) this.inflight.set(q, new Set());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopDone = this.loop();
  }

  /** Stops claiming, then waits for running jobs up to `graceMs`; the rest are aborted and left to their lease (they are claimed again). */
  async stop(graceMs = 30_000): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loopDone;
    const all = [...this.inflight.values()].flatMap((s) => [...s]);
    if (all.length) {
      const timer = setTimeout(() => this.aborters.forEach((a) => a.abort()), graceMs);
      await Promise.allSettled(all);
      clearTimeout(timer);
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        await this.fireTimers();
        claimed = await this.tick();
      } catch (e) {
        this.deps.log.error({ err: errMsg(e) }, "job loop pass failed");
      }
      if (!this.running) break;
      if (claimed === 0) await this.idle();
    }
  }

  private async idle(): Promise<void> {
    let ms = this.deps.cfg.pollMs;
    try {
      const next = await nextFireAt(this.deps.pool);
      if (next) ms = Math.max(0, Math.min(ms, next.getTime() - this.deps.now().getTime()));
    } catch {
      /* poll interval */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    this.wake = null;
  }

  /** Fires every due timer into a job. Safe from several workers: each timer fires once (SKIP LOCKED). */
  async fireTimers(): Promise<number> {
    return withTx(this.deps.pool, (tx) => fireDue(tx, 100));
  }

  /** One claim pass over all queues. Returns the number of jobs claimed; handlers keep running in the background. */
  async tick(): Promise<number> {
    let n = 0;
    for (const [queue, conc] of Object.entries(this.opts.queues)) {
      const set = this.inflight.get(queue)!;
      const free = conc - set.size;
      if (free <= 0) continue;
      const jobs = await claim(this.deps.pool, { workerId: this.deps.workerId, leaseMs: this.deps.cfg.jobLeaseMs, queues: [queue], limit: free });
      for (const job of jobs) {
        n++;
        const p: Promise<void> = this.execute(job).finally(() => {
          set.delete(p);
          this.wake?.();
        });
        set.add(p);
      }
    }
    return n;
  }

  /** Claims and runs until nothing is claimable and nothing is running (tests, and a clean drain at shutdown). */
  async drain(maxPasses = 200): Promise<void> {
    for (let i = 0; i < maxPasses; i++) {
      await this.fireTimers();
      const n = await this.tick();
      const running = [...this.inflight.values()].flatMap((s) => [...s]);
      if (n === 0 && running.length === 0) return;
      await Promise.allSettled(running);
    }
  }

  private async execute(job: Job): Promise<void> {
    const { pool, workerId, cfg, log } = this.deps;
    const ctl = new AbortController();
    this.aborters.add(ctl);
    let lost = false;
    const t0 = Date.now();
    const outcome = (o: "done" | "retried" | "dead" | "lost"): void => {
      jobsTotal.inc({ kind: job.kind, outcome: o });
      jobSeconds.observe((Date.now() - t0) / 1000, { kind: job.kind });
    };
    const hb = setInterval(() => {
      heartbeat(pool, job.id, workerId, cfg.jobLeaseMs).then(
        (ok) => {
          if (!ok) {
            lost = true;
            ctl.abort();
          }
        },
        () => undefined,
      );
    }, Math.max(1_000, Math.floor(cfg.jobLeaseMs / 3)));
    try {
      const h = this.handlers[job.kind];
      if (!h) throw new PermanentError(`no handler for job kind ${job.kind}`, "unknown_kind");
      const result = await h(job, { deps: this.deps, signal: ctl.signal, last: job.attempts >= job.maxAttempts });
      if (lost) return outcome("lost");
      const ok = await complete(pool, job.id, workerId, result === undefined ? null : result);
      outcome(ok ? "done" : "lost");
      if (!ok) log.warn({ job: job.id, kind: job.kind }, "job lease was lost before completion; the result was not recorded");
    } catch (e) {
      if (lost) return outcome("lost");
      const permanent = e instanceof PermanentError;
      log.warn({ job: job.id, kind: job.kind, attempt: job.attempts, err: errMsg(e), permanent }, "job failed");
      const f = await fail(pool, job.id, workerId, errMsg(e), { retry: !permanent }).catch((x) => {
        log.error({ err: errMsg(x) }, "could not record job failure");
        return null;
      });
      outcome(f === null || f.status === "lost" ? "lost" : f.status === "queued" ? "retried" : "dead");
    } finally {
      clearInterval(hb);
      this.aborters.delete(ctl);
    }
  }
}
