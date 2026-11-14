import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type pg from "pg";
import { registerNotificationProducer, registerTriggerSources } from "@gantry/api/core";
import type { Logger } from "pino";
import { brokerClient } from "./clients/broker.js";
import { launcherClient } from "./clients/launcher.js";
import type { WorkerConfig } from "./config.js";
import { realSleep, type Deps } from "./deps.js";
import { errMsg } from "./errors.js";
import { attemptDispatch } from "./handlers/dispatch.js";
import { mergeRequest } from "./handlers/merge.js";
import { chainVerify, flowTimer, githubEvent, githubReconcile, triggerEvaluate, triggerTick } from "./handlers/misc.js";
import { onboardingAssess, onboardingMerge, onboardingOpenPr, onboardingSync, onboardingVerify } from "./handlers/onboarding.js";
import { reaperSweep } from "./handlers/reaper.js";
import { publishJob, runResult } from "./handlers/result.js";
import { stopEnforce } from "./handlers/stop.js";
import { proxiedHttp } from "./outbox/http.js";
import { OutboxDispatcher } from "./outbox/dispatcher.js";
import { smtpMailer } from "./outbox/smtp.js";
import { JobRunner, type Handlers } from "./runner.js";
import { Scheduler } from "./scheduler.js";

/** Handlers by job kind. The `timers` queue's jobs carry the timer's kind, so `flow.timer` serves both the flow queue and fired timers. */
export const HANDLERS: Handlers = {
  "attempt.dispatch": attemptDispatch,
  "run.result": runResult,
  publish: publishJob,
  "merge.request": mergeRequest,
  "flow.timer": flowTimer,
  "stop.enforce": stopEnforce,
  "github.reconcile": githubReconcile,
  "github.event": githubEvent,
  "trigger.evaluate": triggerEvaluate,
  "trigger.tick": triggerTick,
  "chain.verify": chainVerify,
  "reaper.sweep": reaperSweep,
  "onboarding.assess": onboardingAssess,
  "onboarding.open_pr": onboardingOpenPr,
  "onboarding.merge": onboardingMerge,
  "onboarding.verify": onboardingVerify,
  "onboarding.sync": onboardingSync,
};

export function buildDeps(pool: pg.Pool, cfg: WorkerConfig, log: Logger, over: Partial<Deps> = {}): Deps {
  return {
    pool, cfg, log, workerId: `worker-${randomUUID().slice(0, 8)}`,
    launcher: launcherClient(cfg.launcherUrl, cfg.launcherToken),
    broker: brokerClient(cfg.brokerUrl, cfg.brokerToken),
    http: proxiedHttp({ proxy: cfg.egressProxy, ca: cfg.egressCa }),
    mail: smtpMailer(cfg.smtp),
    now: () => new Date(),
    sleep: realSleep,
    ...over,
  };
}

/** The whole worker: job loop with timers, outbox dispatcher, recurring-job scheduler and the liveness file the container healthcheck reads. */
export class Worker {
  readonly runner: JobRunner;
  readonly outbox: OutboxDispatcher;
  readonly scheduler: Scheduler;
  private beat: NodeJS.Timeout | null = null;

  constructor(readonly deps: Deps) {
    // Every event the worker's flow engine and handlers append produces its notifications in the same transaction (spec 12.2).
    registerNotificationProducer({ publicUrl: process.env.GANTRY_PUBLIC_URL || "https://localhost", onError: (err, e) => deps.log.error({ err: errMsg(err), event: e.type }, "notification producer failed") });
    registerTriggerSources();
    this.runner = new JobRunner(deps, HANDLERS, { queues: deps.cfg.concurrency });
    this.outbox = new OutboxDispatcher(deps);
    this.scheduler = new Scheduler(deps);
  }

  async start(): Promise<void> {
    const touch = (): void => void writeFile(this.deps.cfg.heartbeatFile, String(Date.now())).catch((e) => this.deps.log.warn({ err: errMsg(e) }, "heartbeat file"));
    touch();
    this.beat = setInterval(touch, 5_000);
    this.runner.start();
    this.outbox.start();
    this.scheduler.start();
    this.deps.log.info({ worker: this.deps.workerId }, "worker started");
  }

  /** Graceful shutdown: stop claiming, let running jobs finish (their leases cover a hard kill), close the loops. */
  async stop(graceMs = 30_000): Promise<void> {
    if (this.beat) clearInterval(this.beat);
    await Promise.allSettled([this.scheduler.stop(), this.outbox.stop(), this.runner.stop(graceMs)]);
    this.deps.log.info({ worker: this.deps.workerId }, "worker stopped");
  }
}
