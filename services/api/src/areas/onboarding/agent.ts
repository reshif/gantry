/**
 * Running the Onboarding Agent for a repository (spec 11.3, 13).
 *
 * The agent runs through the same runtime as every other agent: the worker's `attempt.dispatch` starts it in a sandbox seeded read-only with the repository at the commit
 * Gantry observed, the edge gateway meters and fences its model calls, and the kill/halt, budget and wall-clock fences apply. The runtime keys a run to an attempt of a work
 * order (`runs.wo_id` is not null), so each agent step is carried by a hidden *carrier* work order (source 'onboarding', state 'done', never on the floor, in a list or in
 * a count), exactly as eval cases are (evals/engine.ts). The carrier's result is never published and never applied through the flow engine: the worker's collector reads
 * it, validates it against the contract in @gantry/domain and merges it onto the deterministic result, or falls back to that result and says why.
 *
 * The agent is used only when it is set up, promoted and has a model a connected vendor can serve (`onboardingAgentGate`); otherwise onboarding is rule-based, and says so.
 */
import { createHash } from "node:crypto";
import type { Queryable, Tx } from "@gantry/db";
import { ONBOARD_AGENT, ONBOARD_STATION } from "@gantry/domain";
import { job, type BuiltJob } from "../../core/jobs-contract.js";
import { pinRunConfig } from "../agents/compose.js";
import { resolveFor } from "../models/facts.js";

/** `work_orders.source` of a carrier. Every list, count and sweep that skips eval carriers skips these too. */
export const CARRIER_SOURCE = "onboarding";
export type AgentStep = "assess" | "open_pr";

export interface AgentPin {
  agent: string;
  version: number;
  model: string;
  vendor: string;
  skills: Record<string, number>;
  instructionsHash: string;
}
export type Gate = { usable: true; pin: AgentPin } | { usable: false; reason: string };

/**
 * Whether the Onboarding Agent may be used for this repo right now:
 *  - it exists, is active and has a live version;
 *  - the live version has been promoted (the promotion rule: a version goes live only through the eval gate, or ships built in);
 *  - the model it pins (or the project's override) resolves to an enabled model on a connected vendor allowed for this project and repo (the same resolver the edge uses);
 *  - no stop covers the repo.
 * The reason is recorded on the assessment when it falls back to the rules.
 */
export async function onboardingAgentGate(db: Queryable, orgId: string, repo: { id: string; project_id: string }): Promise<Gate> {
  const ag = (await db.query<{ status: string; live_version: number | null; data: Record<string, unknown> }>(`select status, live_version, data from agents where org_id = $1 and id = $2`, [orgId, ONBOARD_AGENT])).rows[0];
  if (!ag) return { usable: false, reason: "The Onboarding Agent is not set up in this factory." };
  if (ag.status !== "active") return { usable: false, reason: `The Onboarding Agent is ${ag.status}.` };
  if (ag.live_version === null) return { usable: false, reason: "The Onboarding Agent has no live version." };
  const promoted = Array.isArray(ag.data.promoted) ? (ag.data.promoted as unknown[]) : [];
  if (!promoted.includes(ag.live_version)) return { usable: false, reason: `Version ${ag.live_version} of the Onboarding Agent has not passed its eval suite.` };
  const v = (await db.query<{ body: Record<string, unknown>; model_id: string | null }>(`select body, model_id from agent_versions where org_id = $1 and agent_id = $2 and version = $3`, [orgId, ONBOARD_AGENT, ag.live_version])).rows[0];
  if (!v) return { usable: false, reason: "The Onboarding Agent's live version is missing." };
  const run = await pinRunConfig(db, { orgId, agentId: ONBOARD_AGENT, agentVersion: ag.live_version, projectId: repo.project_id, repoId: repo.id });
  const model = run?.modelOverride || v.model_id || (typeof v.body.model === "string" ? v.body.model : "");
  if (!model) return { usable: false, reason: "The Onboarding Agent pins no model." };
  const res = await resolveFor(db, orgId, { station: ONBOARD_STATION, project: repo.project_id, repoId: repo.id, pinned: model });
  if (!res.pick) return { usable: false, reason: res.blocked ?? `No connected vendor serves ${model}.` };
  const stop = (await db.query<{ mode: string; scope_type: string }>(
    `select mode, scope_type from stops where org_id = $1 and lifted_at is null and (scope_type = 'factory' or (scope_type = 'project' and project_id = $2) or (scope_type = 'repo' and repo_id = $3)) order by (mode = 'kill') desc limit 1`,
    [orgId, repo.project_id, repo.id],
  )).rows[0];
  if (stop) return { usable: false, reason: `${stop.mode === "kill" ? "A kill" : "A halt"} at ${stop.scope_type} scope is in force.` };
  return { usable: true, pin: { agent: ONBOARD_AGENT, version: ag.live_version, model: res.pick.model, vendor: res.pick.vendor, skills: run?.skillVersions ?? {}, instructionsHash: run?.manifest.hash ?? "" } };
}

/** Wall-clock the collector gives an agent step before it stops the run and falls back. */
export const AGENT_STEP_DEADLINE_MS = 15 * 60_000;
/** How often the collector looks at a running step. */
export const COLLECT_EVERY_MS = 10_000;

const short = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 10);

export interface CarrierInput {
  repo: { id: string; project_id: string };
  runId: string;
  step: AgentStep;
  /** Makes a re-requested step (a change request on the pull request) a new carrier. */
  key: string;
  commit: string;
  /** What the agent is given. Data, not instructions. */
  input: Record<string, unknown>;
  /** Kept with the carrier for the collector (the deterministic result for the assessment; the request for the pull request step). */
  carry: Record<string, unknown>;
  now: Date;
}

/** The carrier work order and its queued attempt for one agent step, and the jobs that start and watch it. Idempotent for the same (run, step, key). */
export async function startAgentStep(tx: Tx, orgId: string, o: CarrierInput): Promise<{ woId: string; attemptId: string; jobs: BuiltJob[] }> {
  const woId = `OB-${short(`${o.runId}:${o.step}:${o.key}`)}`;
  const attemptId = `ATT-${woId}-${ONBOARD_STATION}-1`;
  const fv = (await tx.query<{ v: number | null }>(`select current_flow_version as v from projects where org_id = $1 and id = $2`, [orgId, o.repo.project_id])).rows[0]?.v ?? 1;
  await tx.query(
    `insert into work_orders (org_id, id, project_id, repo_id, title, class, priority, source, position, state, flow_version, data, closed_at)
     values ($1,$2,$3,$4,$5,'chore','P3',$6,$7,'done',$8,$9::jsonb,$10) on conflict (org_id, id) do nothing`,
    [orgId, woId, o.repo.project_id, o.repo.id, `Onboarding agent (${o.step}) for ${o.repo.id}`.slice(0, 200), CARRIER_SOURCE, ONBOARD_STATION, fv, JSON.stringify({ onboarding: { repoId: o.repo.id, runId: o.runId, step: o.step, commit: o.commit, ...o.carry } }), o.now],
  );
  const { rows } = await tx.query<{ fencing: string }>(
    `insert into attempts (org_id, id, wo_id, station, visit, state, data) values ($1,$2,$3,$4,1,'queued',$5::jsonb) on conflict (org_id, id) do update set updated_at = now() returning fencing`,
    [orgId, attemptId, woId, ONBOARD_STATION, JSON.stringify({ agent: ONBOARD_AGENT, onboarding: { repoId: o.repo.id, runId: o.runId, step: o.step, startedAt: o.now.toISOString() }, input: o.input })],
  );
  return {
    woId, attemptId,
    jobs: [
      job("attempt.dispatch", { woId, station: ONBOARD_STATION, attemptId, fencing: Number(rows[0]!.fencing) }, { dedupeKey: `attempt:${attemptId}` }),
      job("onboarding.agent_collect", { repoId: o.repo.id, runId: o.runId, step: o.step, attemptId, tick: 0 }, { dedupeKey: `onboarding.agent_collect:${attemptId}:0`, runAt: new Date(o.now.getTime() + COLLECT_EVERY_MS) }),
    ],
  };
}

/** True for a work order that only carries an onboarding agent step. */
export const isCarrier = (woData: Record<string, unknown> | null | undefined): boolean => !!woData && typeof woData.onboarding === "object" && woData.onboarding !== null;

/**
 * An onboarding agent attempt ends without a result the flow engine should hear about (it could not start, lost its lease, ran past its limit, a stop cancelled it): it is
 * marked ended and the collector is asked to look now. Returns the collector job, or null when the attempt was already over.
 */
export async function endCarrierAttempt(tx: Tx, orgId: string, attemptId: string, why: { code: string; msg: string; cancelled?: boolean; delivered?: boolean }, now: Date): Promise<BuiltJob | null> {
  const a = (await tx.query<{ state: string; data: { onboarding?: { repoId?: string; runId?: string; step?: AgentStep } } }>(`select state, data from attempts where org_id = $1 and id = $2 for update`, [orgId, attemptId])).rows[0];
  if (!a) return null;
  const ob = a.data.onboarding;
  if (a.state === "queued" || a.state === "running") {
    await tx.query(
      `update attempts set state = $3, outcome = $4, ended_at = $5, lease_until = null, data = data || $6::jsonb, updated_at = now(), version = version + 1 where org_id = $1 and id = $2`,
      [orgId, attemptId, why.delivered ? "succeeded" : why.cancelled ? "cancelled" : "failed", why.code, now, JSON.stringify({ endedWhy: why.msg })],
    );
  }
  return ob?.repoId && ob.runId && ob.step ? job("onboarding.agent_collect", { repoId: ob.repoId, runId: ob.runId, step: ob.step, attemptId, tick: 1 }, { dedupeKey: `onboarding.agent_collect:${attemptId}:end` }) : null;
}
