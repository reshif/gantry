import { auditCategoryFor, needsStepUp, type Decision } from "@gantry/domain";
import {
  appendEvent, enqueue, enqueueOutbox, idempotency, withTx,
  type EventCategory, type EventChannel, type EventOutcome, type EventSubject, type Tx,
} from "@gantry/db";
import type { FastifyRequest } from "fastify";
import { publishChange } from "./changes.js";
import { decideFor, refuseDecision, stepUpSatisfied, type Scope } from "./decide.js";
import { Refusal, refuse } from "./errors.js";
import { readApiSettings } from "../areas/apikeys/config.js";
import { loadPolicyState } from "./read/state.js";
import { loadStopSnapshot, refreshStopSnapshot } from "./stop-snapshot.js";

export interface EventSpec {
  type: string;
  /** Defaults to the audit category of the command's action. */
  category?: EventCategory;
  subject?: EventSubject;
  before?: unknown;
  after?: unknown;
  /** Default: the command's scope. */
  projectId?: string | null;
  woId?: string | null;
  woVersion?: number | null;
  outcome?: EventOutcome;
  occurredAt?: Date;
  onBehalfOf?: string | null;
}

export interface JobSpec {
  kind: string;
  payload?: Record<string, unknown>;
  queue?: string;
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
  dedupeKey?: string;
}

export interface OutboxSpec {
  /** Index into `events`; default the last one. */
  event?: number;
  destination: string;
  payload?: Record<string, unknown>;
}

export interface CommandResult<X extends object = Record<string, never>> {
  msg: string;
  events: EventSpec[];
  /** Extra fields merged into the `{ ok: true, msg }` response. */
  extra?: X;
  jobs?: JobSpec[];
  outbox?: OutboxSpec[];
  /** Legacy store slice names for the SSE `change` message. */
  changes?: string[];
  /** Project the change belongs to (default: the command's scope). Absent = factory-wide. */
  project?: string | null;
}

export interface CommandSpec {
  /** Catalog action id; checked by the decision point. `null`: the caller changes only their own data (own session, own saved view), which needs no catalogue right. */
  action: string | null;
  scope?: Scope;
  /** Reads the entity's current version in the transaction (null = not found). With an `If-Match` header, a different value is a 409. */
  ifMatch?: (tx: Tx) => Promise<number | null>;
  /** Versioned config endpoints: a request without `If-Match` is a 409 "version required" (so a blind overwrite is impossible). Needs `ifMatch`. */
  ifMatchRequired?: boolean;
  /** Creates: the `Idempotency-Key` header makes a retry return the first result. */
  idempotent?: boolean;
  /** Fields of the response that are not kept for replays (a secret shown once): a replay returns the rest. */
  storedOmit?: string[];
  /** Require a sign-in no older than this many seconds (spec 14.1). */
  stepUp?: number;
  /** /internal/v1 handlers: the edge or GitHub broker authenticated with its service token, so the matrix does not apply (the body still checks stop state and budgets). Without this flag a service principal is refused. */
  service?: boolean;
  /** Stop endpoints (spec 8.5): no jobs or outbox, and a smaller default change set. */
  reduced?: boolean;
}

export interface Actor {
  orgId: string;
  /** Event actor id: a person id, `apikey:<id>` or the service name. */
  id: string;
  kind: "person" | "apikey" | "service";
  personId: string | null;
  name: string;
  channel: EventChannel;
  /** The caller's `via` (web, console, slack, teams), when given. */
  via: string | null;
  sessionId: string | null;
  ip: string | null;
  requestId: string;
  decision: Decision;
  /** Parsed `If-Match` header. */
  ifMatch: number | null;
  idempotencyKey: string | null;
  now: Date;
}

const SELF: Decision = { allowed: true, reason: "The caller changes their own data.", rule: { kind: "self", id: "SELF", name: "Own data" }, needs: "" };

const CHANNELS: readonly EventChannel[] = ["web", "console", "slack", "teams", "api", "github", "schedule", "system"];
const VIA: readonly string[] = ["web", "console", "slack", "teams"];

/** A denial found inside the transaction: the transaction rolls back, the denial is audited in its own, and the caller gets 403 or 409. */
class Denied extends Error {
  constructor(readonly decision: Decision, readonly refusal?: Refusal) {
    super(decision.reason);
  }
}

/** A permission or stop refusal raised by a command body (an invariant such as the last Factory Admin, a stopped project): audited like a decision-point denial. */
const bodyDenial = (e: Refusal): Denied => {
  const er = e.error;
  const rule = er.rule ?? { kind: er.kind === "stopped" ? "stop" : "invariant", id: er.kind === "stopped" ? "STOP" : "INVARIANT", name: er.kind === "stopped" ? "Stop state" : "Invariant" };
  return new Denied({ allowed: false, reason: er.msg, rule, needs: er.needs ?? "" }, e);
};

export function parseIfMatch(req: FastifyRequest): number | null {
  const h = req.headers["if-match"];
  if (h === undefined) return null;
  const m = /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(String(h));
  if (!m) throw refuse("invalid", "If-Match must be the version number you loaded.");
  return Number(m[1]);
}

const bodyVia = (body: unknown): string | null => {
  const v = body && typeof body === "object" ? (body as { via?: unknown }).via : undefined;
  return typeof v === "string" && VIA.includes(v) ? v : null;
};

function actorFor(req: FastifyRequest, decision: Decision, ifMatch: number | null, key: string | null): Actor {
  const p = req.gx.principal!;
  const via = bodyVia(req.body);
  const channel: EventChannel = p.kind === "apikey" ? "api" : p.kind === "service" ? "system" : ((via as EventChannel | null) ?? "web");
  return {
    orgId: req.gx.orgId,
    id: p.kind === "person" ? p.id : p.kind === "apikey" ? `apikey:${p.id}` : p.id,
    kind: p.kind,
    personId: p.kind === "person" ? p.id : null,
    name: p.name,
    channel: CHANNELS.includes(channel) ? channel : "web",
    via,
    sessionId: p.kind === "person" ? p.sessionId : null,
    ip: req.gx.ip || null,
    requestId: req.gx.requestId,
    decision,
    ifMatch,
    idempotencyKey: key,
    now: new Date(),
  };
}

/**
 * The command pipeline (docs/BUILD.md, spec F10 and 15.4). Everything that changes state goes through it:
 * transaction, idempotency, decision point (a denial is audited in its own transaction), stale-version check, the body,
 * events with every audit field and the hash chain, jobs and outbox, and an SSE notification that fires on commit.
 * Returns the response body and sets the status. Refusals thrown from the body (`refuse(...)`) roll everything back.
 */
export async function command<X extends object = Record<string, never>>(
  req: FastifyRequest,
  spec: CommandSpec,
  fn: (tx: Tx, actor: Actor) => Promise<CommandResult<X>>,
): Promise<Record<string, unknown>> {
  const g = req.server.gantry;
  const principal = req.gx.principal;
  if (!principal) throw refuse("denied", "Sign in to continue.");
  const reply = req.gx.reply;
  const ifMatch = parseIfMatch(req);
  const idemHeader = spec.idempotent ? (req.headers["idempotency-key"] as string | undefined)?.trim() || null : null;
  // Spec 5.3: creates from API keys and other non-browser callers must carry an Idempotency-Key, so a retried request cannot create twice. Browser sessions send one automatically.
  if (spec.idempotent && !idemHeader && principal.kind === "apikey") throw refuse("invalid", "Creates through the API need an Idempotency-Key header, so a retry cannot create twice.", { needs: "Idempotency-Key" });
  if (idemHeader && (idemHeader.length > 200 || /[\r\n]/.test(idemHeader))) throw refuse("invalid", "Idempotency-Key is too long.");
  const route = `${principal.kind}:${principal.id}:${req.method} ${req.routeOptions?.url ?? req.url}`;

  // The public API's idempotency window is a setting (spec 12.5); people get the 24 hours of the column default.
  const ttlHours = idemHeader && principal.kind === "apikey" ? (await readApiSettings(g.pool, g.orgId).catch(() => null))?.value.idempotencyHours : undefined;
  let loaded: Awaited<ReturnType<typeof loadPolicyState>> | null = null;
  try {
    const out = await withTx(g.pool, async (tx) => {
      if (idemHeader) {
        const s = await idempotency.begin(tx, { orgId: g.orgId, scope: route, key: idemHeader, body: { body: req.body ?? null, params: req.params ?? null }, ...(ttlHours ? { ttlHours } : {}) });
        if (s.state === "conflict") throw refuse("conflict", "That Idempotency-Key was already used with a different request.");
        if (s.state === "replay") return { replay: true as const, status: s.status, body: s.response as Record<string, unknown> };
      }
      let st: Awaited<ReturnType<typeof loadPolicyState>>;
      let fallback: { snapshotAt: string; cause: string } | null = null;
      if (spec.reduced) {
        // Spec 8.5, I7: a stop must work when policy data is unreadable. Try the normal load inside a savepoint; if it fails, decide from the last-known-good snapshot.
        await tx.query("savepoint stop_policy");
        try {
          st = await loadPolicyState(tx, g.orgId);
          await tx.query("release savepoint stop_policy");
        } catch (err) {
          await tx.query("rollback to savepoint stop_policy");
          const snap = await loadStopSnapshot(tx, g.orgId).catch(() => null);
          if (!snap) throw err;
          st = snap.state;
          fallback = { snapshotAt: snap.takenAt.toISOString(), cause: String((err as Error)?.message ?? err).slice(0, 200) };
          req.log.error({ err, snapshotAt: fallback.snapshotAt }, "policy data unreadable; stop command decided from the last-known-good snapshot");
        }
      } else {
        st = await loadPolicyState(tx, g.orgId);
      }
      let decision: Decision =
        spec.service && principal.kind === "service"
          ? { allowed: true, reason: `Authenticated service ${principal.id}.`, rule: { kind: "service", id: principal.id, name: `Service ${principal.id}` }, needs: "" }
          : spec.action === null ? SELF : decideFor(st, principal, spec.action, spec.scope ?? {});
      if (fallback) {
        decision = { ...decision, reason: `${decision.reason} (Decided from the policy snapshot of ${fallback.snapshotAt}: policy data was unreadable.)`, ...(decision.allowed ? { rule: { kind: "invariant", id: "I7-SNAPSHOT", name: "Stop path: last-known-good policy" } } : {}) };
      }
      if (!decision.allowed) throw new Denied(decision);
      // Spec 14.1: kill, restore, policy, role, security, people and key operations need a fresh sign-in, whether or not the route asked.
      const stepUp = spec.stepUp ?? (principal.kind === "person" && spec.action && needsStepUp(spec.action) ? 300 : undefined);
      if (stepUp !== undefined && !stepUpSatisfied(req, stepUp)) {
        throw new Denied({ allowed: false, reason: "Sign in again to confirm this change.", rule: { kind: "step-up", id: "STEP-UP", name: "Fresh sign-in required" }, needs: "step_up" });
      }
      if (spec.ifMatch && (ifMatch !== null || spec.ifMatchRequired)) {
        const cur = await spec.ifMatch(tx);
        if (cur === null) throw refuse("not_found", "That no longer exists.");
        if (ifMatch === null) throw refuse("conflict", "Version required: send the version you loaded as If-Match, so this cannot overwrite a newer change.", { needs: "If-Match" });
        if (cur !== ifMatch) throw refuse("stale", "This changed since you loaded it. Reload and try again.");
      }
      const actor = actorFor(req, decision, ifMatch, idemHeader);
      let r: CommandResult<X>;
      try {
        r = await fn(tx, actor);
      } catch (e) {
        if (e instanceof Refusal && (e.error.kind === "denied" || e.error.kind === "stopped")) throw bodyDenial(e);
        throw e;
      }
      if (spec.reduced && (r.jobs?.length || r.outbox?.length)) throw new Error("reduced commands (stop controls) must not enqueue jobs or outbox rows");
      const ids: string[] = [];
      for (const e of r.events) {
        const after = fallback ? { ...(e.after && typeof e.after === "object" ? (e.after as object) : {}), policyFallback: fallback } : e.after;
        const a = await appendEvent(tx, {
          orgId: g.orgId, type: e.type, category: e.category ?? (auditCategoryFor(spec.action ?? "self") as EventCategory), actor: actor.id, onBehalfOf: e.onBehalfOf ?? (actor.via && actor.via !== "web" ? actor.personId : null),
          channel: actor.channel, subject: e.subject ?? null, projectId: e.projectId ?? spec.scope?.project ?? null, woId: e.woId ?? spec.scope?.wo ?? null, woVersion: e.woVersion ?? null,
          outcome: e.outcome ?? "ok", rule: decision.rule.id, before: e.before, after, commandId: actor.requestId, idempotencyKey: idemHeader, sessionId: actor.sessionId, sourceIp: actor.ip, requestId: actor.requestId,
          ...(e.occurredAt ? { occurredAt: e.occurredAt } : {}),
        });
        ids.push(a.id);
      }
      for (const j of r.jobs ?? []) await enqueue(tx, { orgId: g.orgId, ...j });
      for (const o of r.outbox ?? []) {
        const id = ids[o.event ?? ids.length - 1];
        if (!id) throw new Error("outbox rows need an event");
        await enqueueOutbox(tx, { orgId: g.orgId, eventId: id, destination: o.destination, ...(o.payload ? { payload: o.payload } : {}) });
      }
      const body = { ok: true, msg: r.msg, ...(r.extra ?? {}), ...(fallback ? { policyFallback: true } : {}) } as Record<string, unknown>;
      if (idemHeader) {
        const kept = spec.storedOmit?.length ? Object.fromEntries(Object.entries(body).filter(([k]) => !spec.storedOmit!.includes(k))) : body;
        await idempotency.storeResult(tx, { orgId: g.orgId, scope: route, key: idemHeader }, 200, kept);
      }
      const project = r.project === undefined ? spec.scope?.project ?? undefined : r.project ?? undefined;
      await publishChange(tx, { org: g.orgId, keys: [...(r.changes ?? (spec.reduced ? ["stops", "factory", "projects", "repos"] : [])), "audit"], ...(project ? { project } : {}) });
      if (!fallback) loaded = st;
      return { replay: false as const, status: 200, body };
    });
    if (loaded) await refreshStopSnapshot(g.pool, g.orgId, loaded);
    if (out.replay) reply.header("idempotent-replayed", "true");
    reply.code(out.status);
    return out.body;
  } catch (e) {
    if (e instanceof Denied) {
      await auditDenial(req, spec, e.decision).catch((err: unknown) => req.log.error({ err }, "could not audit denial"));
      throw e.refusal ?? refuseDecision(e.decision);
    }
    throw e;
  }
}

/** Stop controls (spec 8.5): same pipeline with jobs and outbox disallowed, so the path stays small and only touches `stops` and `events`. */
export function stopCommand<X extends object = Record<string, never>>(
  req: FastifyRequest,
  spec: Omit<CommandSpec, "reduced">,
  fn: (tx: Tx, actor: Actor) => Promise<CommandResult<X>>,
): Promise<Record<string, unknown>> {
  return command(req, { ...spec, reduced: true }, fn);
}

/** Records a denial in its own transaction (the command's transaction rolled back). */
export async function auditDenial(req: FastifyRequest, spec: { action: string | null; scope?: Scope }, d: Decision): Promise<void> {
  const g = req.server.gantry;
  const p = req.gx.principal;
  if (!p) return;
  const via = bodyVia(req.body);
  const channel: EventChannel = p.kind === "apikey" ? "api" : p.kind === "service" ? "system" : ((via as EventChannel | null) ?? "web");
  await withTx(g.pool, (tx) =>
    appendEvent(tx, {
      orgId: g.orgId, type: `${spec.action ?? "self"}.denied`, category: auditCategoryFor(spec.action ?? "self") as EventCategory, actor: p.kind === "apikey" ? `apikey:${p.id}` : p.id,
      onBehalfOf: via && via !== "web" && p.kind === "person" ? p.id : null, channel, subject: { type: "action", id: spec.action ?? "self" }, projectId: spec.scope?.project ?? null, woId: spec.scope?.wo ?? null,
      outcome: "denied", rule: d.rule.id, after: { reason: d.reason, rule: d.rule, ...(d.needs ? { needs: d.needs } : {}) }, commandId: req.gx.requestId, sessionId: p.kind === "person" ? p.sessionId : null,
      sourceIp: req.gx.ip || null, requestId: req.gx.requestId,
    }),
  );
}

export { Refusal };
