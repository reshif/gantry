import { can, effectiveStop, stopBlocks, type Decision, type KillInfo, type Person } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import type { FastifyRequest } from "fastify";
import type { PolicyStateLoaded, Principal } from "./context.js";
import { Refusal, refuse } from "./errors.js";
import { loadPolicyState } from "./read/state.js";
import { refreshStopSnapshot } from "./stop-snapshot.js";

export interface Scope {
  project?: string | null;
  repo?: string | null;
  /** Work order id: its stop (if any) is read from `stops`. */
  wo?: string | null;
  /** Epoch ms of the question; defaults to now. */
  time?: number;
}

/** Policy state for this request, loaded once (spec 14.3: cached per request). Inside a transaction pass `tx` to read the transaction's view (uncached). */
export function policyState(req: FastifyRequest, db?: Queryable): Promise<PolicyStateLoaded> {
  const g = req.server.gantry;
  if (db && db !== g.pool) return loadPolicyState(db, g.orgId);
  req.gx.state ??= loadPolicyState(g.pool, g.orgId).then(async (st) => {
    await refreshStopSnapshot(g.pool, g.orgId, st);
    return st;
  });
  return req.gx.state;
}

export async function currentPerson(req: FastifyRequest): Promise<Person | null> {
  const p = req.gx.principal;
  if (p?.kind !== "person") return null;
  const st = await policyState(req);
  return st.people.find((x) => x.id === p.id) ?? null;
}

/** The decision point. Every command, the simulator, the batch `can` endpoint and the console's tools call this (spec 14.3). */
export async function decide(req: FastifyRequest, action: string, scope: Scope = {}, db?: Queryable): Promise<Decision> {
  const st = await policyState(req, db);
  return decideFor(st, req.gx.principal, action, scope);
}

/** Same decision for an explicit principal and already-loaded state. */
export function decideFor(st: PolicyStateLoaded, principal: Principal | null, action: string, scope: Scope = {}): Decision {
  const time = scope.time ?? Date.now();
  if (!principal) return deny("Sign in to continue.", "NO-PRINCIPAL", "Not signed in");
  if (principal.kind === "service") return deny("Services use /internal/v1, not the product API.", "SERVICE", "Service principal");
  if (principal.kind === "apikey") return decideApiKey(st, principal, action, scope);
  const woStop = scope.wo ? st.activeStops.find((s) => s.scope === "wo" && s.wo === scope.wo && s.mode === "kill") : undefined;
  const killed: KillInfo | undefined = woStop ? { by: woStop.by, at: woStop.at, reason: woStop.reason, scope: "workorder", mode: woStop.inFlight ?? "hold" } : undefined;
  return can(st, principal.id, action, {
    project: scope.project ?? null,
    repo: scope.repo ?? null,
    time,
    ...(scope.wo ? { wo: { id: scope.wo, state: killed ? "killed" : "running", ...(killed ? { killed } : {}) } as never } : {}),
  });
}

const deny = (reason: string, id: string, name: string, kind = "apikey", needs = ""): Decision => ({ allowed: false, reason, rule: { kind, id, name }, needs });

/** API keys carry explicit scopes (action ids) and may be bound to one project. Stops apply to them like to anyone. */
/** Scopes that exist only for keys (spec 8.10): reading work orders and firing triggers are not rights a person holds through the matrix. */
const KEY_ONLY_ACTIONS: ReadonlyArray<{ id: string; name: string }> = [{ id: "wo.read", name: "Read work orders" }, { id: "triggers.run", name: "Fire triggers" }];

function decideApiKey(st: PolicyStateLoaded, p: Extract<Principal, { kind: "apikey" }>, action: string, scope: Scope): Decision {
  const act = st.catalog.actions.find((a) => a.id === action) ?? KEY_ONLY_ACTIONS.find((a) => a.id === action);
  if (!act) return deny(`Unknown action ${action}.`, "APIKEY-ACTION", "API key", "invariant");
  if (!p.scopes.includes(action) && !p.scopes.includes("*")) return deny(`This API key is not scoped for ${act.name.toLowerCase()}.`, p.id, `API key ${p.name}`, "apikey", action);
  const repo = scope.repo ? st.repos.find((r) => r.id === scope.repo) : undefined;
  const project = scope.project || repo?.project || null;
  if (p.projectId && project !== p.projectId) return deny(`This API key is limited to project ${p.projectId}.`, p.id, `API key ${p.name}`);
  const stop = effectiveStop(st, { project, repo: scope.repo ?? null });
  if (stop && stop.mode !== "archived" && stopBlocks(st, action, stop)) return deny(stop.reason, "STOP", "Stop state", "stop");
  return { allowed: true, reason: `Allowed by the scope of API key ${p.name}.`, rule: { kind: "apikey", id: p.id, name: `API key ${p.name}` }, needs: "" };
}

/** Throws the refusal for a denied decision: 409 for a stopped scope, 403 otherwise. */
export function refuseDecision(d: Decision): Refusal {
  return refuse(d.rule.kind === "stop" ? "stopped" : "denied", d.reason, { rule: d.rule, ...(d.needs ? { needs: d.needs } : {}) });
}

/**
 * Spec 14.1: a fresh sign-in for kill, restore, policy, role, security and key operations. "Fresh" means auth_time is inside the window.
 * It is a password re-entry unless the identity provider's browser flow requires a second factor (OTP, WebAuthn); we do not check acr or amr.
 */
export function stepUpSatisfied(req: FastifyRequest, maxAgeSec = 300): boolean {
  const s = req.gx.session;
  return !!s?.authTime && Date.now() - s.authTime <= maxAgeSec * 1000;
}

/** Throws a 403 with `needs: "step_up"` when the session's sign-in is older than `maxAgeSec`. The client sends the person to `/auth/login?step_up=1`. */
export function requireStepUp(req: FastifyRequest, maxAgeSec = 300): void {
  if (stepUpSatisfied(req, maxAgeSec)) return;
  throw refuse("denied", "Sign in again to confirm this change.", { rule: { kind: "step-up", id: "STEP-UP", name: "Fresh sign-in required" }, needs: "step_up" });
}
