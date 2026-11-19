import { createHash } from "node:crypto";
import { applyStationResult, attemptIsCurrent, recordDispatchPrompt, refuseStationRun, stationRunBlock, endCarrierAttempt, isCarrier, issueRunToken, parseJob, pinRunConfig, revokeRunTokens, loadRunLimits, type RunPin } from "@gantry/api/core";
import type { RepoContext } from "@gantry/domain";
import { enqueue, withTx, type Job, type Tx } from "@gantry/db";
import type { Deps } from "../deps.js";
import { errMsg, PermanentError, TransientError } from "../errors.js";
import type { HandlerCtx } from "../runner.js";
import { coveringStops, loadAttempt, resolveSeedBase, resolveSeedCommit, runIdFor, volumeFor, type AttemptInfo } from "./common.js";
import { failEvalCase } from "./evals.js";
import { teardownRun } from "./teardown.js";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

interface Pinned {
  tupleId: string | null;
  model: string | null;
  adapter: "claude" | "stub";
  wallClockSeconds: number;
  /** The limits the run is bound by, recorded on the run so a stop can say "used 40 of 40 turns". */
  limits: { turns: number; wallClockSeconds: number; costUsd?: number };
  /** The composition recorded on the run (spec 10.2): layer versions, instruction hash, skill versions. */
  record: Record<string, unknown> | null;
}

/** Pins the agent version that will run (spec 13.1: agent version, skill versions, instruction hash, harness, model) and records it on the attempt. */
async function pinTuple(tx: Tx, a: AttemptInfo): Promise<Pinned> {
  const agentId = typeof a.attemptData.agent === "string" ? a.attemptData.agent : "";
  const found = agentId ? (await tx.query<{ live_version: number | null; data: Record<string, unknown> }>(`select live_version, data from agents where org_id = $1 and id = $2`, [a.orgId, agentId])).rows[0] : undefined;
  // The run's limits are frozen here (runs.data.limits): the spec, the meter and the watchdog all read what is written now. A run with no agent or no agent version still honours the station override.
  const limitsFor = async (body: Record<string, unknown>, data: Record<string, unknown>): Promise<Pick<Pinned, "wallClockSeconds" | "limits">> => {
    const r = await loadRunLimits(tx, { orgId: a.orgId, projectId: a.projectId, station: a.station, attemptData: a.attemptData }, { body, data, budgetUsd: body.budget ?? data.budget });
    return { wallClockSeconds: r.wallClockSeconds, limits: { turns: r.turns, wallClockSeconds: r.wallClockSeconds, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) } };
  };
  const none = async (): Promise<Pinned> => ({ tupleId: null, model: null, adapter: "stub", ...(await limitsFor({}, found?.data ?? {})), record: null });
  if (!agentId) return none();
  // An eval case runs the version (and model) the person picked for the run, which need not be the live one (spec 13.2); real work always runs the live version.
  const evalVersion = a.attemptData.eval && Number.isInteger(a.attemptData.agentVersion) ? Number(a.attemptData.agentVersion) : null;
  const evalModel = a.attemptData.eval && typeof a.attemptData.model === "string" && a.attemptData.model !== "" ? a.attemptData.model : null;
  const ag = found ? { ...found, live_version: evalVersion ?? found.live_version } : found;
  if (!ag || ag.live_version === null) return none();
  const v = (await tx.query<{ body: Record<string, unknown>; harness_version: string; instruction_hash: string | null; model_id: string | null }>(
    `select body, harness_version, instruction_hash, model_id from agent_versions where org_id = $1 and agent_id = $2 and version = $3`, [a.orgId, agentId, ag.live_version],
  )).rows[0];
  if (!v) return none();
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
  const instruction = run?.manifest.hash ?? v.instruction_hash ?? sha(typeof v.body.instructions === "string" ? v.body.instructions : "");
  const id = `tup-${sha([agentId, ag.live_version, instruction, v.harness_version, model ?? "", JSON.stringify(skillVersions)].join("\0")).slice(0, 20)}`;
  await tx.query(
    `insert into agent_version_tuples (org_id, id, agent_id, agent_version, skill_versions, instruction_hash, harness_version, model_id) values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
     on conflict (org_id, id) do nothing`,
    [a.orgId, id, agentId, ag.live_version, JSON.stringify(skillVersions), instruction, v.harness_version, model ?? ""],
  );
  await tx.query(`update attempts set tuple_id = $3, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, a.attemptId, id]);
  const frozen = await limitsFor(v.body, ag.data);
  const record = run ? { instructionPin: run.pin, promptManifest: run.manifest, composed: { hash: run.composed.hash, layers: run.composed.layers.map((l) => ({ name: l.name, version: l.version, hash: l.hash })), skills: run.skills.map((x) => ({ id: x.id, version: x.version })), agentVersion: ag.live_version, tupleId: id } } : null;
  return { tupleId: id, model: model && model !== "" ? model : null, adapter: model ? "claude" : "stub", ...frozen, record };
}

/** Records the run, pins the tuple and issues a fresh per-run token (any earlier token of the run is revoked). All in one transaction. */
async function prepareRun(deps: Deps, a: AttemptInfo, runId: string): Promise<{ token: string; pinned: Pinned }> {
  return withTx(deps.pool, async (tx) => {
    const pinned = await pinTuple(tx, a);
    await tx.query(
      `insert into runs (org_id, id, attempt_id, wo_id, state, model_id, data) values ($1,$2,$3,$4,'starting',$5,$6::jsonb)
       on conflict (org_id, id) do update set data = runs.data || excluded.data, model_id = excluded.model_id, updated_at = now()`,
      [a.orgId, runId, a.attemptId, a.woId, pinned.model, JSON.stringify({ adapter: pinned.adapter, wallClockSeconds: pinned.wallClockSeconds, limits: pinned.limits, ...(pinned.record ?? {}), dispatch: { phase: "preparing", worker: deps.workerId } })],
    );
    await revokeRunTokens(tx, { orgId: a.orgId, runIds: [runId], reason: "re-dispatched" });
    const t = await issueRunToken(tx, runId, a.attemptId, a.fencing, { orgId: a.orgId });
    return { token: t.token, pinned };
  });
}

async function recordRepoContext(deps: Deps, a: AttemptInfo, runId: string, rc: RepoContext | null): Promise<void> {
  const value = rc ? { ...rc, offeredAt: deps.now().toISOString() } : { commit: null, files: [], hash: null, offeredAt: deps.now().toISOString(), unavailable: true };
  await withTx(deps.pool, async (tx) => {
    await tx.query(`update runs set data = data || $3::jsonb, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, runId, JSON.stringify({ repoContext: value })]);
    // The prompt is now fully known: the hash recorded for the run names exactly what it will be given, repository context included.
    if (!a.woData.eval && !isCarrier(a.woData)) await recordDispatchPrompt(tx, a.orgId, runId);
  });
}

async function markStarted(deps: Deps, a: AttemptInfo, runId: string, startupLeaseMs: number): Promise<void> {
  await withTx(deps.pool, async (tx) => {
    // G-S9: the wall clock runs from the moment the runner starts, not from the run row (which a wait for a slot may have made old).
    await tx.query(`update runs set data = (data - 'dispatchWait') || $3::jsonb, started_at = now(), updated_at = now() where org_id = $1 and id = $2`, [a.orgId, runId, JSON.stringify({ dispatch: { phase: "started", at: deps.now().toISOString() } })]);
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
  // The reason stays on the run, so System health can show that runs are not starting and why (before the teardown, which may itself fail).
  await withTx(deps.pool, (tx) => tx.query(
    `update runs set data = data || $3::jsonb, ended_at = coalesce(ended_at, now()), updated_at = now() where org_id = $1 and id = $2`,
    [a.orgId, runId, JSON.stringify({ dispatchError: { code, msg: msg.slice(0, 500) }, endedBy: "dispatch failed" })],
  )).catch((e) => deps.log.warn({ run: runId, err: errMsg(e) }, "recording the dispatch failure on the run"));
  await teardownRun(deps, a.orgId, runId, "failed", { by: "dispatch failed" }).catch((e) => deps.log.warn({ run: runId, err: errMsg(e) }, "teardown after failed dispatch"));
  // An eval case that cannot start ends with an error on its item; it never touches the flow.
  if (a.woData.eval) return failEvalCase(deps, a, code, msg);
  // An onboarding agent step ends with the reason; the collector falls back to the rule-based result and records it.
  if (isCarrier(a.woData)) {
    const end = await withTx(deps.pool, async (tx) => {
      const j = await endCarrierAttempt(tx, a.orgId, a.attemptId, { code, msg }, deps.now());
      if (j) await enqueue(tx, { orgId: a.orgId, kind: j.kind, queue: j.queue, payload: j.payload, ...(j.dedupeKey ? { dedupeKey: j.dedupeKey } : {}) });
      return j !== null;
    });
    return { onboarding: true, failed: code, ended: end };
  }
  const out = await withTx(deps.pool, (tx) => applyStationResult(tx, a.attemptId, a.fencing, { status: "failed", summary: msg, error: { code, msg, phase: "start" } }));
  return { failed: code, applied: out.applied };
}

/** Why this attempt must not (or no longer) start a runner: superseded, or covered by a stop. Undefined when it may. */
async function startBlock(deps: Deps, orgId: string, a: AttemptInfo): Promise<string | undefined> {
  const cur = await attemptIsCurrent(deps.pool, orgId, a.attemptId, a.fencing);
  if (!cur.current) return cur.reason;
  const stops = await coveringStops(deps.pool, orgId, a);
  return stops.length ? `${stops[0]!.mode} at ${stops[0]!.scopeType} scope` : undefined;
}

/** A dispatch that is skipped because the attempt was stopped or superseded: a runner an earlier try left behind (G-S4: its removal failed) goes now. */
async function skipClean(deps: Deps, a: AttemptInfo, why: string): Promise<unknown> {
  const runId = runIdFor(a.attemptId);
  const left = (await deps.launcher.list().catch(() => [])).find((r) => r.runId === runId);
  if (left?.container) await abandonStart(deps, runId, why);
  return { skipped: why };
}

async function abandonStart(deps: Deps, runId: string, why: string): Promise<unknown> {
  // G-S4: a stop that fails (the launcher is down) is retried by the job queue, not only logged: the runner must not wait for the reaper.
  try {
    await deps.launcher.stop(runId, { keepWorkspace: false });
  } catch (e) {
    throw new TransientError(`removing a run that was stopped while it started failed: ${errMsg(e)}`, "stop_failed");
  }
  return { skipped: why, abandonedStart: true };
}

/** S-96: a token issued for a start that did not happen is revoked now, not at the retry's prepareRun or teardown (a new one is issued on the retry). */
async function revokeUnused(deps: Deps, orgId: string, runId: string, reason: string): Promise<void> {
  await withTx(deps.pool, (tx) => revokeRunTokens(tx, { orgId, runIds: [runId], reason })).catch((e) => deps.log.warn({ run: runId, err: errMsg(e) }, "revoking the token of a run that did not start"));
}

/**
 * Launcher at capacity (no run slot, or the host disk under its floor): wait for room, for as long as it takes (G-S3). Waiting is never a failure and
 * never spends a retry budget; only a real start failure does. The order shows why it waits: "Waiting for a run slot (n queued)" or "Waiting: host disk low".
 */
async function defer(deps: Deps, job: Job, a: AttemptInfo, runId: string, reason: string): Promise<unknown> {
  const n = Number((job.payload as { deferrals?: unknown }).deferrals ?? 0) + 1;
  await deps.launcher.stop(runId, { keepWorkspace: false }).catch(() => undefined);
  await revokeUnused(deps, a.orgId, runId, "dispatch deferred");
  const disk = /disk/i.test(reason);
  await withTx(deps.pool, async (tx) => {
    const q = Number((await tx.query(`select count(*)::int as n from runs where org_id = $1 and data ? 'dispatchWait' and id <> $2`, [a.orgId, runId])).rows[0]?.n ?? 0) + 1;
    const label = disk ? "Waiting: host disk low" : `Waiting for a run slot (${q} queued)`;
    await tx.query(`update runs set data = data || $3::jsonb, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, runId, JSON.stringify({ dispatchWait: { label, reason: reason.slice(0, 300), deferrals: n, since: deps.now().toISOString() } })]);
  }).catch((e) => deps.log.warn({ run: runId, err: errMsg(e) }, "recording why a dispatch waits"));
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
  if (!cur.current) return await skipClean(deps, a, cur.reason);
  const stops = await coveringStops(deps.pool, job.orgId, a);
  if (stops.length) return await skipClean(deps, a, `${stops[0]!.mode} at ${stops[0]!.scopeType} scope`);

  // A station's agent that is turned off (or whose live version never passed its eval suite) does not run: the order waits for a person with the way forward.
  // Eval cases run the version the person picked and onboarding steps have their own gate, so neither is held here.
  if (!a.woData.eval && !isCarrier(a.woData)) {
    const block = await stationRunBlock(deps.pool, a.orgId, typeof a.attemptData.agent === "string" ? a.attemptData.agent : "");
    if (block) {
      const r = await withTx(deps.pool, (tx) => refuseStationRun(tx, a.attemptId, a.fencing, block));
      return { skipped: "agent not available", reason: block, parked: r.applied };
    }
  }

  const runId = runIdFor(a.attemptId);
  // The launcher is the truth about containers: one that already runs means an earlier try got through and only the bookkeeping is missing.
  const running = (await deps.launcher.list()).find((r) => r.runId === runId);
  if (running?.container) {
    await markStarted(deps, a, runId, deps.cfg.startupLeaseMs);
    return { alreadyRunning: true, runId };
  }

  const { token, pinned } = await prepareRun(deps, a, runId);
  // An agent with no model must not quietly run the canned stub: the run fails with the reason, unless stubs were enabled on purpose (tests, local development).
  if (pinned.adapter === "stub" && !deps.cfg.allowStubAdapter) {
    return failDispatch(deps, a, runId, "no_model", "This agent has no model, so the run was not started. Choose a model for the agent on the Agents page, then run the station again.");
  }
  const base = { runId, workspaceRef: `${a.woId}/${a.station}`.slice(0, 200), variant: deps.cfg.runnerVariant, runToken: token };
  try {
    const prep = await deps.launcher.start({ ...base, seedComplete: false });
    if (prep.state === "capacity") return await defer(deps, job, a, runId, prep.msg);
    if (a.repo?.full) {
      const commit = await resolveSeedCommit(deps.pool, a.orgId, a.woId, a.repo.id);
      const baseBranch = await resolveSeedBase(deps.pool, a.orgId, a.woId, a.repo.defaultBranch);
      const seeded = await deps.broker.seed({ repo: a.repo.full, commit, volume: volumeFor(runId), ...(baseBranch ? { baseBranch } : {}) });
      // What the workspace holds, as a fact on the run: the seed commit (the publisher's base) and the target branch head the agents diff against (null: none could be read).
      await withTx(deps.pool, (tx) => tx.query(`update runs set data = data || $3::jsonb, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, runId, JSON.stringify({ seed: { commit, base: seeded.base, baseBranch: seeded.baseBranch } })]));
      // What the repository's convention files said at this commit, recorded on the run before the runner starts: the run spec's prompt is built from it,
      // and the record (paths, sizes, hashes, what was inlined or withheld) shows later exactly what the agent was offered.
      await recordRepoContext(deps, a, runId, seeded.repoContext);
    }
    // S-95: a kill that landed while the workspace was being seeded must not get a runner. Checked again right before the start.
    const before = await startBlock(deps, job.orgId, a);
    if (before) return await abandonStart(deps, runId, before);
    const go = await deps.launcher.start({ ...base, seedComplete: true });
    if (go.state === "capacity") return await defer(deps, job, a, runId, go.msg);
    // ...and once more after it: a kill that landed between that check and the start has already been enforced (tokens revoked, the run removed),
    // so the start has just recreated a runner nobody owns. Remove it now instead of leaving it to the next reaper pass.
    const after = await startBlock(deps, job.orgId, a);
    if (after) return await abandonStart(deps, runId, after);
    await markStarted(deps, a, runId, deps.cfg.startupLeaseMs);
    return { started: true, runId, seeded: a.repo?.full ?? null };
  } catch (e) {
    const transient = e instanceof TransientError;
    if (transient && !ctx.last) {
      await revokeUnused(deps, a.orgId, runId, "dispatch retry");
      throw e;
    }
    const code = e instanceof PermanentError || e instanceof TransientError ? e.code : "dispatch_error";
    deps.log.warn({ attempt: a.attemptId, err: errMsg(e), code }, "dispatch gave up");
    return failDispatch(deps, a, runId, code, `The run could not be started: ${errMsg(e)}`);
  }
}
