import { createHash } from "node:crypto";
import { applyStationResult, attemptIsCurrent, issueRunToken, parseJob, pinRunConfig, revokeRunTokens, type RunPin } from "@gantry/api/core";
import { enqueue, withTx, type Job, type Tx } from "@gantry/db";
import type { Deps } from "../deps.js";
import { errMsg, PermanentError, TransientError } from "../errors.js";
import type { HandlerCtx } from "../runner.js";
import { coveringStops, loadAttempt, resolveSeedCommit, runIdFor, volumeFor, type AttemptInfo } from "./common.js";
import { failEvalCase } from "./evals.js";
import { teardownRun } from "./teardown.js";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

interface Pinned {
  tupleId: string | null;
  model: string | null;
  adapter: "claude" | "stub";
  wallClockSeconds: number;
  /** The composition recorded on the run (spec 10.2): layer versions, instruction hash, skill versions. */
  record: Record<string, unknown> | null;
}

/** Pins the agent version that will run (spec 13.1: agent version, skill versions, instruction hash, harness, model) and records it on the attempt. */
async function pinTuple(tx: Tx, a: AttemptInfo): Promise<Pinned> {
  const agentId = typeof a.attemptData.agent === "string" ? a.attemptData.agent : "";
  const none: Pinned = { tupleId: null, model: null, adapter: "stub", wallClockSeconds: 3600, record: null };
  if (!agentId) return none;
  const found = (await tx.query<{ live_version: number | null; data: Record<string, unknown> }>(`select live_version, data from agents where org_id = $1 and id = $2`, [a.orgId, agentId])).rows[0];
  // An eval case runs the version (and model) the person picked for the run, which need not be the live one (spec 13.2); real work always runs the live version.
  const evalVersion = a.attemptData.eval && Number.isInteger(a.attemptData.agentVersion) ? Number(a.attemptData.agentVersion) : null;
  const evalModel = a.attemptData.eval && typeof a.attemptData.model === "string" && a.attemptData.model !== "" ? a.attemptData.model : null;
  const ag = found ? { ...found, live_version: evalVersion ?? found.live_version } : found;
  if (!ag || ag.live_version === null) return none;
  const v = (await tx.query<{ body: Record<string, unknown>; harness_version: string; instruction_hash: string | null; model_id: string | null }>(
    `select body, harness_version, instruction_hash, model_id from agent_versions where org_id = $1 and agent_id = $2 and version = $3`, [a.orgId, agentId, ag.live_version],
  )).rows[0];
  if (!v) return none;
  // Spec 10.2: the four-layer composition (factory base, project overlay, this agent version, the repository's guidelines at the pinned commit) and the
  // skills bundle are composed now and pinned, so the version tuple's instruction hash names the whole text the run is given.
  const commit = a.repoId ? await resolveSeedCommit(tx, a.orgId, a.woId, a.repoId).catch(() => null) : null;
  const run: RunPin | null = await pinRunConfig(tx, { orgId: a.orgId, agentId, agentVersion: ag.live_version, projectId: a.projectId, repoId: a.repoId, commit });
  let skillVersions: Record<string, number> = run?.skillVersions ?? {};
  if (!run) {
    const skills = (await tx.query<{ skill_id: string; version: number | null }>(
      `select s.id as skill_id, coalesce(k.pinned_version, s.live_version) as version from agent_skills k join skills s on s.org_id = k.org_id and s.id = k.skill_id where k.org_id = $1 and k.agent_id = $2 order by s.id`,
      [a.orgId, agentId],
    )).rows;
    skillVersions = {};
    for (const s of skills) if (s.version !== null) skillVersions[s.skill_id] = s.version;
  }
  const model = evalModel || run?.modelOverride || v.model_id || (typeof v.body.model === "string" ? v.body.model : null);
  const instruction = run?.composed.hash ?? v.instruction_hash ?? sha(typeof v.body.instructions === "string" ? v.body.instructions : "");
  const id = `tup-${sha([agentId, ag.live_version, instruction, v.harness_version, model ?? "", JSON.stringify(skillVersions)].join("\0")).slice(0, 20)}`;
  await tx.query(
    `insert into agent_version_tuples (org_id, id, agent_id, agent_version, skill_versions, instruction_hash, harness_version, model_id) values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
     on conflict (org_id, id) do nothing`,
    [a.orgId, id, agentId, ag.live_version, JSON.stringify(skillVersions), instruction, v.harness_version, model ?? ""],
  );
  await tx.query(`update attempts set tuple_id = $3, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, a.attemptId, id]);
  const lim = (v.body.limits ?? ag.data.limits ?? {}) as { wallClockSeconds?: unknown };
  const wall = typeof lim.wallClockSeconds === "number" && Number.isInteger(lim.wallClockSeconds) && lim.wallClockSeconds > 0 ? lim.wallClockSeconds : 3600;
  const record = run ? { instructionPin: run.pin, composed: { hash: run.composed.hash, layers: run.composed.layers.map((l) => ({ name: l.name, version: l.version, hash: l.hash })), skills: run.skills.map((x) => ({ id: x.id, version: x.version })), agentVersion: ag.live_version, tupleId: id } } : null;
  return { tupleId: id, model: model && model !== "" ? model : null, adapter: model ? "claude" : "stub", wallClockSeconds: wall, record };
}

/** Records the run, pins the tuple and issues a fresh per-run token (any earlier token of the run is revoked). All in one transaction. */
async function prepareRun(deps: Deps, a: AttemptInfo, runId: string): Promise<{ token: string; pinned: Pinned }> {
  return withTx(deps.pool, async (tx) => {
    const pinned = await pinTuple(tx, a);
    await tx.query(
      `insert into runs (org_id, id, attempt_id, wo_id, state, model_id, data) values ($1,$2,$3,$4,'starting',$5,$6::jsonb)
       on conflict (org_id, id) do update set data = runs.data || excluded.data, model_id = excluded.model_id, updated_at = now()`,
      [a.orgId, runId, a.attemptId, a.woId, pinned.model, JSON.stringify({ adapter: pinned.adapter, wallClockSeconds: pinned.wallClockSeconds, ...(pinned.record ?? {}), dispatch: { phase: "preparing", worker: deps.workerId } })],
    );
    await revokeRunTokens(tx, { orgId: a.orgId, runIds: [runId], reason: "re-dispatched" });
    const t = await issueRunToken(tx, runId, a.attemptId, a.fencing, { orgId: a.orgId });
    return { token: t.token, pinned };
  });
}

async function markStarted(deps: Deps, a: AttemptInfo, runId: string, startupLeaseMs: number): Promise<void> {
  await withTx(deps.pool, async (tx) => {
    await tx.query(`update runs set data = data || $3::jsonb, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, runId, JSON.stringify({ dispatch: { phase: "started", at: deps.now().toISOString() } })]);
    // F9: from here the attempt is a leased external job. A run that never heartbeats loses its lease and is retried.
    await tx.query(
      `update attempts set state = 'running', lease_holder = 'runner', lease_until = $3, started_at = coalesce(started_at, $4), updated_at = now(), version = version + 1
        where org_id = $1 and id = $2 and state in ('queued','running')`,
      [a.orgId, a.attemptId, new Date(deps.now().getTime() + startupLeaseMs), deps.now()],
    );
  });
}

/** The attempt cannot be started and will not be: record a failed station result so the flow engine retries it (bounded) or parks the work order. */
async function failDispatch(deps: Deps, a: AttemptInfo, runId: string, code: string, msg: string): Promise<unknown> {
  await teardownRun(deps, a.orgId, runId, "failed", { by: "dispatch failed" }).catch((e) => deps.log.warn({ run: runId, err: errMsg(e) }, "teardown after failed dispatch"));
  // An eval case that cannot start ends with an error on its item; it never touches the flow.
  if (a.woData.eval) return failEvalCase(deps, a, code, msg);
  const out = await withTx(deps.pool, (tx) => applyStationResult(tx, a.attemptId, a.fencing, { status: "failed", summary: msg, error: { code, msg } }));
  return { failed: code, applied: out.applied };
}

/** Launcher at capacity: wait for room without spending the queue's retry budget. A new job carries the count of deferrals. */
async function defer(deps: Deps, job: Job, a: AttemptInfo, runId: string, reason: string): Promise<unknown> {
  const n = Number((job.payload as { deferrals?: unknown }).deferrals ?? 0) + 1;
  await deps.launcher.stop(runId, { keepWorkspace: false }).catch(() => undefined);
  if (n > deps.cfg.maxDispatchDeferrals) return failDispatch(deps, a, runId, "capacity", `No room to start the run after ${n - 1} waits: ${reason}`);
  await enqueue(deps.pool, {
    orgId: a.orgId, queue: "flow", kind: "attempt.dispatch", payload: { ...(job.payload as object), deferrals: n }, runAt: new Date(deps.now().getTime() + 15_000), dedupeKey: `attempt:${a.attemptId}:defer:${n}`,
  });
  return { deferred: n, reason };
}

/**
 * attempt.dispatch (spec 4.3 steps 1-3): prepare the run's network and volume, have gantry-github seed the workspace at the recorded commit,
 * then start the runner with a per-run token. Idempotent: a retry finds the run by its deterministic id.
 */
export async function attemptDispatch(job: Job, ctx: HandlerCtx): Promise<unknown> {
  const { deps } = ctx;
  const p = parseJob("attempt.dispatch", job.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const a = await loadAttempt(deps.pool, job.orgId, p.value.attemptId);
  if (!a) return { skipped: "unknown attempt" };
  const cur = await attemptIsCurrent(deps.pool, job.orgId, a.attemptId, p.value.fencing);
  if (!cur.current) return { skipped: cur.reason };
  const stops = await coveringStops(deps.pool, job.orgId, a);
  if (stops.length) return { skipped: `${stops[0]!.mode} at ${stops[0]!.scopeType} scope` };

  const runId = runIdFor(a.attemptId);
  // The launcher is the truth about containers: one that already runs means an earlier try got through and only the bookkeeping is missing.
  const running = (await deps.launcher.list()).find((r) => r.runId === runId);
  if (running?.container) {
    await markStarted(deps, a, runId, deps.cfg.startupLeaseMs);
    return { alreadyRunning: true, runId };
  }

  const { token } = await prepareRun(deps, a, runId);
  const base = { runId, workspaceRef: `${a.woId}/${a.station}`.slice(0, 200), variant: deps.cfg.runnerVariant, runToken: token };
  try {
    const prep = await deps.launcher.start({ ...base, seedComplete: false });
    if (prep.state === "capacity") return await defer(deps, job, a, runId, prep.msg);
    if (a.repo?.full) {
      const commit = await resolveSeedCommit(deps.pool, a.orgId, a.woId, a.repo.id);
      await deps.broker.seed({ repo: a.repo.full, commit, volume: volumeFor(runId) });
    }
    const go = await deps.launcher.start({ ...base, seedComplete: true });
    if (go.state === "capacity") return await defer(deps, job, a, runId, go.msg);
    await markStarted(deps, a, runId, deps.cfg.startupLeaseMs);
    return { started: true, runId, seeded: a.repo?.full ?? null };
  } catch (e) {
    const transient = e instanceof TransientError;
    if (transient && !ctx.last) throw e;
    const code = e instanceof PermanentError || e instanceof TransientError ? e.code : "dispatch_error";
    deps.log.warn({ attempt: a.attemptId, err: errMsg(e), code }, "dispatch gave up");
    return failDispatch(deps, a, runId, code, `The run could not be started: ${errMsg(e)}`);
  }
}
