import { withTx, type Job } from "@gantry/db";
import { refreshLearningFindings } from "@gantry/api/core";
import { recordEvent } from "../alerts.js";
import type { HandlerCtx } from "../runner.js";

/**
 * learning.refresh (spec 13.4): regroups the signals of the last 30 days into findings. It records evidence only; it never drafts, applies or edits anything, and it does
 * not depend on the proposals switch (findings are recorded from the first work order). An event is written only when something changed.
 */
export async function learningRefresh(job: Job, ctx: HandlerCtx): Promise<unknown> {
  return withTx(ctx.deps.pool, async (tx) => {
    const r = await refreshLearningFindings(tx, job.orgId, ctx.deps.now());
    if (r.created || r.updated) await recordEvent(tx, { orgId: job.orgId, type: "learning.refresh", category: "agents", subject: { type: "learning", id: "findings" }, projectId: null, after: { created: r.created, updated: r.updated, open: r.open }, outcome: "ok" });
    return r;
  });
}
