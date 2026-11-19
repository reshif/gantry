/**
 * Agent-led classification at Intake (owner decision 2026-11-18). Right after a request is submitted with no class named, an asynchronous job asks the Intake agent to classify it
 * (through the work-order session's model path, with the repository and AGENTS.md as tools). The agent's class, confidence and rationale are recorded as its own proposal
 * (`data.clsBy`, a `wo.classify` event whose actor is the agent). A person's requested class always wins and is never queued. The keyword match stays only when no model is usable,
 * and is then labelled as such. Code here only claims the work, checks the rails (still at Intake, no person's choice in the way) and writes what the agent said.
 */
import { appendEvent, withTx } from "@gantry/db";
import { PROVISIONAL_CLS_PREFIX, buildBrief, classOf, classesOf, type Project } from "@gantry/domain";
import type pg from "pg";
import type { Actor } from "../../core/command.js";
import { loadFlowState } from "../../core/read/state.js";
import { makeFx, flowFor } from "./ctx.js";
import { ev, note } from "./engine.js";
import { lockWo, saveWo, stationIdOf } from "./model.js";
import { withBriefEdits, type BriefEdits } from "./intake.js";

export type ClassifyState = "pending" | "running" | "done" | "rule" | "failed" | "skipped";

/** Claims up to `limit` work orders waiting for the agent to classify them. */
export const CLASSIFY_STALE_MS = 5 * 60_000;
/** Sources that are not a person's request: they never trigger a metered classification (same exclusion as the Intake dialogue). */
export const NO_CLASSIFY_SOURCES = ["eval", "onboarding"];

/** Claims up to `limit` work orders waiting for the agent to classify them. A claim left 'running' longer than CLASSIFY_STALE_MS (the API restarted mid-call) is claimed again. */
export async function claimClassifications(pool: pg.Pool, orgId: string, limit = 3, now = new Date()): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `update work_orders set data = jsonb_set(jsonb_set(data, '{classifyPending}', '"running"'), '{classifyClaimedAt}', to_jsonb($4::bigint)) where org_id = $1 and id in (
       select id from work_orders where org_id = $1 and position = 'intake' and state not in ('done','killed','declined') and source <> all($5::text[])
         and ((data->>'classifyPending' = 'pending' and coalesce((data->>'classifyRetryAt')::bigint, 0) <= $4::bigint) or (data->>'classifyPending' = 'running' and coalesce((data->>'classifyClaimedAt')::bigint, 0) < $4::bigint - $3::bigint))
       order by created_at limit $2 for update skip locked) returning id`,
    [orgId, limit, CLASSIFY_STALE_MS, now.getTime(), NO_CLASSIFY_SOURCES],
  );
  return rows.map((r) => r.id);
}

/** After a vendor-unreachable failure: puts the claim back to pending for one more attempt at `at` (ms). Returns false when it was already retried once, so the caller settles it as failed. */
export async function retryClassification(pool: pg.Pool, orgId: string, woId: string, at: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update work_orders set data = jsonb_set(jsonb_set(jsonb_set(data, '{classifyPending}', '"pending"'), '{classifyRetried}', 'true'), '{classifyRetryAt}', to_jsonb($3::bigint)) where org_id = $1 and id = $2 and data->>'classifyPending' = 'running' and coalesce(data->>'classifyRetried', '') <> 'true'`,
    [orgId, woId, at],
  );
  return (rowCount ?? 0) > 0;
}

/** Records how the classification ended when the agent did not set a class (no usable model, a failed call, a person got there first). */
export async function settleClassification(pool: pg.Pool, orgId: string, woId: string, state: Exclude<ClassifyState, "pending" | "running" | "done">, why: string): Promise<void> {
  await withTx(pool, async (tx) => {
    const w = await lockWo(tx, orgId, woId);
    if (w.data.classifyPending !== "running" && w.data.classifyPending !== "pending") return;
    w.data.classifyPending = state;
    w.data.classifyNote = why.slice(0, 400);
    // The keyword match stands only because no model could do better: say so on the class itself.
    if (state !== "skipped" && typeof w.data.clsRationale === "string" && w.data.clsRationale.startsWith(PROVISIONAL_CLS_PREFIX)) {
      w.data.clsRationale = `Rule-based keyword match: no agent set the class (${why.slice(0, 200)}). ${w.data.clsRationale.slice(PROVISIONAL_CLS_PREFIX.length)}`;
      const st = await loadFlowState(tx, orgId);
      const project = st.projects.find((p) => p.id === w.project);
      const name = project ? classOf(st.catalog, project, w.cls).name : w.cls;
      await tx.query(`update messages set body = $3 where org_id = $1 and id = $2 and author_kind = 'system'`, [orgId, `${woId}:m00000`, `Class: ${name}. ${w.data.clsRationale}`]);
    }
    await saveWo(tx, orgId, w);
  });
}

const serviceActor = (orgId: string, id: string, name: string, now: Date): Actor => ({
  orgId, id, kind: "service", personId: null, name, channel: "system", via: null, sessionId: null, ip: null, requestId: `classify-${id}-${now.getTime()}`,
  decision: { allowed: true, reason: "The Intake agent proposes the class; Gantry applies it only while the work order is at Intake and no person chose a class.", rule: { kind: "service", id: "intake-classify", name: "Intake classification" }, needs: "" }, ifMatch: null, idempotencyKey: null, now,
});

export interface AgentClass { cls: string; confidence: number; rationale: string; agent: { id: string; name: string; version: number; model: string } }
export type ApplyResult = { applied: true; from: string; to: string; name: string } | { applied: false; why: string };

/** Writes the agent's class on the work order when the rails allow it: still at Intake, G0+G1 not passed, no person's choice or override in the way. */
export async function applyAgentClass(pool: pg.Pool, orgId: string, woId: string, r: AgentClass, now = new Date()): Promise<ApplyResult> {
  return withTx(pool, async (tx) => {
    const w = await lockWo(tx, orgId, woId);
    const fx = await makeFx(tx, serviceActor(orgId, r.agent.id, r.agent.name, now));
    const st = await loadFlowState(tx, orgId);
    const project = st.projects.find((p) => p.id === w.project) as Project | undefined;
    const fail = async (why: string): Promise<ApplyResult> => { w.data.classifyPending = "skipped"; w.data.classifyNote = why; await saveWo(tx, orgId, w); return { applied: false, why }; };
    if (!project) return fail("The project no longer exists.");
    if (w.data.requestedCls || w.data.clsOverridden || (w.data.clsBy as { kind?: string } | undefined)?.kind === "person") return fail("A person chose the class, and that always wins.");
    if (stationIdOf(fx.catalog, w) !== "intake" || w.position !== "intake" || w.state === "done" || w.state === "killed") return fail("The work order is no longer waiting at Intake.");
    const { wo } = await flowFor(fx, w);
    if (wo.gates.G0G1?.status === "passed") return fail("The brief was already confirmed.");
    if (!classesOf(fx.catalog, project).some((c) => c.id === r.cls)) return fail(`${r.cls} is not a class of this project.`);
    const from = w.cls;
    const oldDefault = classOf(fx.catalog, project, from).priority;
    w.cls = r.cls;
    if (r.cls !== from && w.priority === oldDefault) w.priority = classOf(fx.catalog, project, r.cls).priority;
    w.data.clsConfidence = r.confidence;
    w.data.clsRationale = r.rationale;
    w.data.clsBy = { kind: "agent", agent: r.agent.id, name: r.agent.name, version: r.agent.version, model: r.agent.model, at: now.getTime() };
    w.data.classifyPending = "done";
    const edits = (w.data.briefEdits && typeof w.data.briefEdits === "object" ? (w.data.briefEdits as BriefEdits) : undefined);
    w.data.brief = withBriefEdits(buildBrief(fx.catalog, project, { cls: r.cls, title: w.title, conv: wo.conv }), edits, r.cls);
    // The scripted first note named the keyword guess: it now carries the agent's class and its own rationale.
    await tx.query(`update messages set body = $3 where org_id = $1 and id = $2 and author_kind = 'system'`, [orgId, `${woId}:m00000`, `Class: ${classOf(fx.catalog, project, r.cls).name}. ${r.rationale}`]);
    note(w, fx, r.agent.id, `Classified by ${r.agent.name}: ${r.cls}${r.cls !== from ? ` (the keyword guess was ${from})` : ""}.`);
    ev(fx, w, "wo.classify", { text: r.rationale, from, to: r.cls, initial: true, source: "agent", confidence: r.confidence, agent: r.agent.id, model: r.agent.model, version: r.agent.version }, { before: { cls: from } });
    await saveWo(tx, orgId, w);
    for (const e of fx.events) {
      await appendEvent(tx, { orgId, type: e.type, category: e.category ?? "flow", actor: r.agent.id, channel: "system", subject: e.subject ?? null, projectId: e.projectId ?? null, woId: e.woId ?? null, woVersion: e.woVersion ?? null, outcome: e.outcome ?? "ok", before: e.before, after: e.after, occurredAt: now });
    }
    return { applied: true, from, to: r.cls, name: classOf(fx.catalog, project, r.cls).name };
  });
}
