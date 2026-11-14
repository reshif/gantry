import { evaluateEvent, evaluateTick, handleFlowTimer, parseJob, processGithubDelivery } from "@gantry/api/core";
import { verifyChain, withTx, type Job } from "@gantry/db";
import { raiseAlert } from "../alerts.js";
import { PermanentError } from "../errors.js";
import type { HandlerCtx } from "../runner.js";
import { loadRepo } from "./common.js";

/** flow.timer (spec 9, F7): escalation, soak and lease expiry. A timer that came due while the worker was down is handled here on recovery. */
export async function flowTimer(job: Job, ctx: HandlerCtx): Promise<unknown> {
  const p = parseJob("flow.timer", job.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  return withTx(ctx.deps.pool, (tx) => handleFlowTimer(tx, p.value, { now: ctx.deps.now() }));
}

/** github.event: a stored webhook delivery is processed into facts (spec 11.6). Replays are no-ops inside `processGithubDelivery`. */
export async function githubEvent(job: Job, ctx: HandlerCtx): Promise<unknown> {
  const p = parseJob("github.event", job.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  return withTx(ctx.deps.pool, (tx) => processGithubDelivery(tx, job.orgId, p.value.deliveryId));
}

/** github.reconcile: ask the broker to re-read a repository's pull requests, checks and reviews; the broker posts any drift to the API. */
export async function githubReconcile(job: Job, ctx: HandlerCtx): Promise<unknown> {
  const p = parseJob("github.reconcile", job.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const repo = await loadRepo(ctx.deps.pool, job.orgId, p.value.repoId);
  if (!repo?.full) return { skipped: "the repository has no GitHub identity" };
  const r = await ctx.deps.broker.reconcile({ repo: repo.full, branchPrefix: repo.branchPrefix });
  return { repo: repo.full, ...r };
}

/** chain.verify (spec 7.2): walk the organisation's hash chain; a break raises an alert event and is logged. */
export async function chainVerify(job: Job, ctx: HandlerCtx): Promise<unknown> {
  const { deps } = ctx;
  const r = await verifyChain(deps.pool, job.orgId);
  if (r.ok) return { ok: true, count: r.value.count, headSeq: r.value.headSeq };
  deps.log.error({ org: job.orgId, break: r.error }, "event chain verification failed");
  await withTx(deps.pool, (tx) => raiseAlert(tx, {
    orgId: job.orgId, type: "ledger.chain_broken", category: "config", subject: { type: "ledger", id: "events" }, after: { break: r.error },
    key: `chain.verify:${JSON.stringify(r.error)}:${deps.now().toISOString().slice(0, 10)}`,
  }));
  return { ok: false, break: r.error };
}

/** trigger.evaluate (spec 11.7): an event from a source is offered to the project's triggers. Replays of the same event make nothing new (per trigger, by the event's identity). */
export async function triggerEvaluate(job: Job, ctx: HandlerCtx): Promise<unknown> {
  const p = parseJob("trigger.evaluate", job.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  return withTx(ctx.deps.pool, (tx) => evaluateEvent(tx, job.orgId, p.value, { now: ctx.deps.now() }));
}

/** trigger.tick: a schedule trigger came due. */
export async function triggerTick(job: Job, ctx: HandlerCtx): Promise<unknown> {
  const p = parseJob("trigger.tick", job.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  return withTx(ctx.deps.pool, (tx) => evaluateTick(tx, job.orgId, p.value, { now: ctx.deps.now() }));
}
