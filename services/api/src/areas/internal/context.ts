import type { Queryable } from "@gantry/db";
import { findRunToken, type TokenRow } from "./tokens.js";

/** Everything the internal endpoints need to know about one run, in one query. */
export interface RunCtx {
  orgId: string;
  runId: string;
  attemptId: string;
  woId: string;
  station: string;
  fencing: string;
  attemptState: string;
  runState: string;
  runModel: string | null;
  runData: Record<string, unknown>;
  /** When the run started; with `runData.wallClockSeconds` it bounds model calls (S-94). */
  runStartedAt: Date | null;
  attemptData: Record<string, unknown>;
  tupleId: string | null;
  agentId: string | null;
  agentVersion: number | null;
  tupleModel: string | null;
  skillVersions: Record<string, unknown>;
  instructionHash: string | null;
  projectId: string;
  projectName: string;
  projectStatus: string;
  projectConfig: Record<string, unknown>;
  overlay: string;
  repoId: string | null;
  /** The epic this work order belongs to: a stop on the parent covers its children (spec 9.6). */
  parentId: string | null;
  woClass: string;
  woData: Record<string, unknown>;
}

export async function loadRunCtx(db: Queryable, orgId: string, runId: string, lock = false): Promise<RunCtx | null> {
  const { rows } = await db.query(
    `select r.id as run_id, r.attempt_id, r.wo_id, r.state as run_state, r.model_id as run_model, r.data as run_data, r.started_at as run_started_at,
            a.station, a.fencing::text as fencing, a.state as attempt_state, a.data as attempt_data, a.tuple_id,
            t.agent_id, t.agent_version, t.model_id as tuple_model, t.skill_versions, t.instruction_hash,
            w.project_id, w.repo_id, w.parent_id, w.class as wo_class, w.data as wo_data, p.name as project_name, p.status as project_status, p.config as project_config, p.overlay
       from runs r
       join attempts a on a.org_id = r.org_id and a.id = r.attempt_id
       join work_orders w on w.org_id = r.org_id and w.id = r.wo_id
       join projects p on p.org_id = w.org_id and p.id = w.project_id
       left join agent_version_tuples t on t.org_id = a.org_id and t.id = a.tuple_id
      where r.org_id = $1 and r.id = $2 ${lock ? "for update of r, a" : ""}`,
    [orgId, runId],
  );
  const x = rows[0];
  if (!x) return null;
  return {
    orgId, runId: x.run_id, attemptId: x.attempt_id, woId: x.wo_id, station: x.station, fencing: x.fencing, attemptState: x.attempt_state, runState: x.run_state,
    runModel: x.run_model, runData: x.run_data ?? {}, runStartedAt: x.run_started_at ? new Date(x.run_started_at) : null, attemptData: x.attempt_data ?? {}, tupleId: x.tuple_id, agentId: x.agent_id, agentVersion: x.agent_version,
    tupleModel: x.tuple_model, skillVersions: x.skill_versions ?? {}, instructionHash: x.instruction_hash, projectId: x.project_id, projectName: x.project_name,
    projectStatus: x.project_status, projectConfig: x.project_config ?? {}, overlay: x.overlay ?? "", repoId: x.repo_id, parentId: x.parent_id ?? null, woClass: x.wo_class, woData: x.wo_data ?? {},
  };
}

export type Denial = { code: "token" | "revoked" | "expired" | "superseded" | "ended" | "stopped" | "finished" | "budget" | "route"; reason: string };

export interface ActiveStop {
  id: string;
  scopeType: string;
  mode: "halt" | "kill";
  reason: string;
  cause: string;
}

/** Active stops that cover this run (factory, its project, repo or work order), kill before halt. */
export async function activeStopsFor(db: Queryable, c: RunCtx): Promise<ActiveStop[]> {
  const { rows } = await db.query(
    `select id, scope_type, mode, reason, cause from stops
      where org_id = $1 and lifted_at is null
        and (scope_type = 'factory' or (scope_type = 'project' and project_id = $2) or (scope_type = 'repo' and repo_id = $3) or (scope_type = 'wo' and (wo_id = $4 or wo_id = $5)))
      order by (mode = 'kill') desc, set_at`,
    [c.orgId, c.projectId, c.repoId, c.woId, c.parentId],
  );
  return rows.map((r) => ({ id: r.id, scopeType: r.scope_type, mode: r.mode, reason: r.reason, cause: r.cause }));
}

const describeStop = (s: ActiveStop): string => `${s.mode === "kill" ? "Killed" : "Halted"} at ${s.scopeType} scope${s.cause === "budget" ? " (budget)" : ""}${s.reason ? `: ${s.reason}` : "."}`;

export interface GuardOptions {
  /** 'model': any stop refuses. 'progress' (heartbeat, checkpoint, result): a halt still lets the run save its state; only a kill refuses. 'usage': cost already incurred is recorded even after a stop. */
  mode: "model" | "progress";
}

/**
 * The checks every run-scoped internal call shares (spec 4.4, 5.3): token known, bound to this run, not revoked or expired,
 * its fencing number is the attempt's current one, the attempt and run are live, and no stop covers the scope.
 */
export async function guardRun(db: Queryable, c: RunCtx, tok: TokenRow | null, o: GuardOptions): Promise<Denial | null> {
  if (!tok) return { code: "token", reason: "The run token is not valid for this run." };
  if (tok.revoked) return { code: "revoked", reason: `The run token was revoked${tok.revoked_reason ? `: ${tok.revoked_reason}` : "."}` };
  if (tok.expired) return { code: "expired", reason: "The run token has expired." };
  if (tok.attempt_id !== c.attemptId || tok.fencing !== c.fencing) return { code: "superseded", reason: "This run was superseded by a newer attempt (fencing number changed)." };
  if (!["queued", "running"].includes(c.attemptState)) return { code: "superseded", reason: `The attempt is ${c.attemptState}, not current.` };
  if (["stopped", "reaped", "succeeded", "failed"].includes(c.runState)) return { code: "ended", reason: `The run has ended (${c.runState}).` };
  // S-94: past its wall clock a run gets no model calls or egress, whether or not the launcher has managed to stop it yet (the watchdog also revokes the token).
  if (o.mode === "model") {
    const limit = Number(c.runData.wallClockSeconds);
    if (c.runStartedAt && Number.isFinite(limit) && limit > 0 && Date.now() > c.runStartedAt.getTime() + limit * 1000) {
      return { code: "ended", reason: `The run is past its wall-clock limit of ${limit} seconds.` };
    }
  }
  const stops = await activeStopsFor(db, c);
  const blocking = o.mode === "model" ? stops[0] : stops.find((s) => s.mode === "kill");
  if (blocking) return { code: "stopped", reason: describeStop(blocking) };
  // F3 / spec 4.4 step 1: a stop set after this attempt began supersedes it, even once the stop is lifted (the same rule as the engine's
  // attemptIsCurrent). Without this, a halt lifted before the worker enforced it would leave the old run's token working.
  // Progress calls (heartbeat, checkpoint, result) stay open only while that halt is still in force, so the run can save its state.
  const sup = await db.query<{ lifted: boolean; mode: string }>(
    `select lifted_at is not null as lifted, mode from stops
      where org_id = $1 and fencing > $2
        and (scope_type = 'factory' or (scope_type = 'project' and project_id = $3) or (scope_type = 'repo' and repo_id = $4) or (scope_type = 'wo' and (wo_id = $5 or wo_id = $6)))`,
    [c.orgId, c.fencing, c.projectId, c.repoId, c.woId, c.parentId],
  );
  if (sup.rows.some((s) => o.mode === "model" || s.lifted || s.mode === "kill")) return { code: "superseded", reason: "A stop superseded this run; a fresh attempt replaces it." };
  return null;
}

export async function guardByToken(db: Queryable, c: RunCtx, token: string, o: GuardOptions): Promise<Denial | null> {
  return guardRun(db, c, await findRunToken(db, c.orgId, c.runId, token), o);
}
