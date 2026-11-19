import type { Decision } from "@gantry/domain";
import type { FastifyRequest } from "fastify";
import type { PolicyStateLoaded } from "./context.js";
import { lacksEveryRight, policyState, refuseDecision, type Scope } from "./decide.js";
import { readWoRow } from "../areas/workorders/model.js";
import { scopeFromApi, stopAction } from "../areas/stops/targets.js";
import { actionForGate, parseGateId } from "../areas/workorders/gates.js";

/**
 * Authorisation before validation, declared per route (spec 14.3 and the QA review). A write route names the catalogue right(s) it is decided with; a
 * preHandler (enforceWriteGate) refuses a person who holds none of them anywhere, in the factory or in any live project, with the 403 the decision point
 * would give, before the handler reads its body, its ids or any entity. The refusal is audited like any denial. A caller who holds one is let through: the
 * handler validates (the 422 messages are for people who may fill the form) and command() makes the precise, scoped decision (the project, the repo, the
 * work order). A malformed body fails in Fastify before any preHandler; the error handler asks declaredDenial() on that path.
 *
 * The table is the single place a new write route must be listed: test/authorize-before-validate.test.ts fails for a write route that is missing here,
 * for a stale entry, and (in command()) for a command whose action is not one the route declares.
 *
 *   any      the person must hold at least one of these rights, in the factory or in some project (a function: rights that depend on the catalogue)
 *   own      the requester of work order `:id` also passes (the handler gives them their own conversation without a right)
 *   self     the route changes the caller's own data, or is a read-only question: no right is needed, nothing to check before the body
 *   exempt   not decided by the matrix: signature-checked hooks, the service-token /internal/v1 routes, sign-out
 *
 * Service tokens and API keys are not touched: a service answers for its own bodies, and a key already passed its route and scope check in onRequest
 * (areas/apikeys/gate.ts), which refuses before the body is read.
 */
export type WriteGate =
  | {
      any: readonly string[] | ((st: PolicyStateLoaded) => readonly string[]);
      own?: "wo-requester";
      /** Which of `any` this request is for, read from the raw params and body (never validated): only names the right in the denial and its audit row. */
      pick?: (req: FastifyRequest, st: PolicyStateLoaded) => string | null;
      /** A request the route answers for anyone (a question that changes nothing, such as the board's dry run): the gate stands aside. */
      unless?: (req: FastifyRequest) => boolean;
    }
  | { self: string }
  | { exempt: string };

const A = (...any: string[]): WriteGate => ({ any });
const OWN = (...any: string[]): WriteGate => ({ any, own: "wo-requester" });
const PICK = (pick: (req: FastifyRequest, st: PolicyStateLoaded) => string | null, ...any: string[]): WriteGate => ({ any, pick });
const body = (req: FastifyRequest): Record<string, unknown> => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
const param = (req: FastifyRequest, k: string): string => String((req.params as Record<string, unknown> | undefined)?.[k] ?? "");
const stopOf = (verb: "halt" | "resume" | "kill" | "restore", scope: unknown): string | null => (typeof scope === "string" ? stopAction(verb, scopeFromApi(scope)) : null);
const stopIdScope = (req: FastifyRequest): string => param(req, "id").split(":")[0] ?? "";
const SELF = (self: string): WriteGate => ({ self });
const X = (exempt: string): WriteGate => ({ exempt });

const PERSONAL = "own saved data";
const GATE_ACTIONS = (st: PolicyStateLoaded): string[] => [...st.catalog.gates.flatMap((g) => (g.action ? [g.action] : [])), "brief.confirm", "wo.decline", "gate.approve", "release"];

const P = "/api/v1";
export const WRITE_GATES: Readonly<Record<string, WriteGate>> = {
  // access
  [`PUT ${P}/access/matrix/:role/:action`]: A("policy.edit"),
  [`POST ${P}/roles`]: A("role.edit"), [`PATCH ${P}/roles/:id`]: A("role.edit"), [`DELETE ${P}/roles/:id`]: A("role.edit"),
  [`POST ${P}/policies`]: A("policy.edit"), [`PATCH ${P}/policies/:id`]: A("policy.edit"), [`DELETE ${P}/policies/:id`]: A("policy.edit"),
  [`POST ${P}/freezes`]: A("policy.edit"), [`POST ${P}/freezes/:id/end`]: A("policy.edit"),
  [`POST ${P}/access/simulate`]: SELF("a question about permissions, answered for oneself or with a right that shows the structure"),
  // agents, skills
  [`PUT ${P}/agents/bindings/console`]: A("agent.edit"), [`POST ${P}/agents`]: A("agent.edit"), [`PATCH ${P}/agents/:id`]: A("agent.edit"),
  [`POST ${P}/agents/:id/versions`]: A("agent.edit"), [`POST ${P}/agents/:id/versions/:v/promote`]: A("agent.edit"), [`POST ${P}/agents/:id/rollback`]: A("agent.edit"),
  [`PUT ${P}/agents/:id/skills/:skill`]: A("agent.edit"), [`DELETE ${P}/agents/:id/skills/:skill`]: A("agent.edit"), [`PUT ${P}/instructions/base`]: A("agent.edit"),
  [`POST ${P}/skills`]: A("skill.edit"), [`PATCH ${P}/skills/:id`]: A("skill.edit"), [`PUT ${P}/skills/:id/projects`]: A("skill.edit"),
  // api keys
  [`POST ${P}/api-keys`]: A("api.keys"), [`DELETE ${P}/api-keys/:id`]: A("api.keys"), [`PATCH ${P}/api-config`]: A("integration.edit"),
  // console: the person's own threads and the assistant's tools, each decided by console rights inside
  [`PUT ${P}/console/model`]: SELF(PERSONAL), [`PUT ${P}/console/settings`]: SELF("retired; always refused"), [`DELETE ${P}/console/threads/:id`]: SELF(PERSONAL),
  [`PATCH ${P}/console/threads/:id`]: SELF(PERSONAL), [`PUT ${P}/console/threads/:id/pinned`]: SELF(PERSONAL), [`PUT ${P}/console/messages/:id/proposals/:pid`]: SELF(PERSONAL), [`POST ${P}/console/messages/:id/proposals/:pid/confirm`]: SELF("runs the card's own endpoint as the person, which decides it"),
  [`POST ${P}/console/tools/:name`]: SELF("decided by console rights per tool"), [`POST ${P}/console/explain`]: SELF("a read-only question"), [`POST ${P}/console/messages`]: SELF("the person's own console conversation"),
  // evals
  [`POST ${P}/suites/:id/runs`]: A("eval.run"), [`POST ${P}/suites/:id/runs/:run/cancel`]: A("eval.run"), [`POST ${P}/suites/:id/cases`]: A("eval.run"),
  // integrations, notifications, system
  [`POST ${P}/integration-types`]: A("integration.add"), [`DELETE ${P}/integration-types/:id`]: A("integration.add"), [`POST ${P}/integration-types/:type/test`]: A("integration.add"),
  [`POST ${P}/integrations`]: A("integration.add"), [`PATCH ${P}/integrations/:id`]: A("integration.edit"), [`POST ${P}/integrations/:id/test`]: A("integration.edit"), [`DELETE ${P}/integrations/:id`]: A("integration.edit"),
  [`POST ${P}/chat-links`]: SELF(PERSONAL), [`DELETE ${P}/chat-links/:id`]: SELF(PERSONAL),
  [`POST ${P}/projects/:id/routes`]: A("notify.edit"), [`PATCH ${P}/projects/:id/routes/:rid`]: A("notify.edit"), [`DELETE ${P}/projects/:id/routes/:rid`]: A("notify.edit"), [`POST ${P}/projects/:id/routes/test`]: A("notify.edit"),
  [`POST ${P}/deliveries/:id/retry`]: A("notify.edit", "integration.edit"),
  [`POST ${P}/card-templates`]: A("notify.edit", "integration.edit"), [`DELETE ${P}/card-templates/:id`]: A("notify.edit", "integration.edit"),
  [`POST ${P}/card-templates/preview`]: SELF("renders a card without saving it; the project must be visible"),
  [`POST ${P}/system/outbox/:id/retry`]: A("integration.edit"),
  // learning
  [`PUT ${P}/learning/switch`]: A("learning.apply"), [`POST ${P}/learning/findings/refresh`]: A("learning.apply"), [`POST ${P}/learning/proposals`]: A("learning.apply"),
  [`POST ${P}/learning/proposals/:id/accept`]: A("learning.apply"), [`POST ${P}/learning/proposals/:id/decline`]: A("learning.apply"),
  [`POST ${P}/learning/proposals/:id/verify`]: A("learning.apply"), [`POST ${P}/learning/proposals/:id/rollback`]: A("learning.apply"),
  // mcp
  [`POST ${P}/mcp/discover`]: A("mcp.edit"), [`POST ${P}/mcp/servers`]: A("mcp.edit"), [`PATCH ${P}/mcp/servers/:id`]: A("mcp.edit"), [`DELETE ${P}/mcp/servers/:id`]: A("mcp.edit"),
  [`POST ${P}/mcp/servers/:id/discover`]: A("mcp.edit"), [`POST ${P}/mcp/servers/:id/approve`]: A("mcp.edit"), [`POST ${P}/mcp/grants`]: A("gate.approve"),
  // models, budgets
  [`POST ${P}/vendors`]: A("model.edit"), [`PATCH ${P}/vendors/:id`]: A("model.edit"), [`POST ${P}/vendors/from-template`]: A("model.edit"), [`POST ${P}/vendors/:id/discover`]: A("model.edit"),
  [`POST ${P}/vendors/:id/qualify`]: A("model.edit"), [`POST ${P}/models`]: A("model.edit"), [`DELETE ${P}/models/:id`]: A("model.edit"), [`PATCH ${P}/models/:id`]: A("model.edit"),
  [`PUT ${P}/routing`]: A("model.edit"), [`POST ${P}/prices`]: A("model.edit"), [`PUT ${P}/budgets/:project`]: A("project.config"),
  // onboarding
  [`POST ${P}/projects/:id/repos`]: A("repo.onboard"), [`PATCH ${P}/repos/:id/config`]: A("onboarding.manage"),
  [`POST ${P}/repos/:id/onboarding/assess`]: A("onboarding.manage"), [`POST ${P}/repos/:id/onboarding/open-pr`]: A("onboarding.manage"), [`POST ${P}/repos/:id/onboarding/verify`]: A("onboarding.manage"),
  [`POST ${P}/repos/:id/onboarding/request-changes`]: A("onboarding.manage"), [`POST ${P}/repos/:id/onboarding/merge`]: A("onboarding.merge"), [`POST ${P}/repos/:id/onboarding/exception`]: A("onboarding.exception"), [`POST ${P}/repos/:id/onboarding/exception/withdraw`]: A("onboarding.exception"),
  [`POST ${P}/repos/:id/onboarding/session/messages`]: A("onboarding.manage"), [`POST ${P}/repos/:id/onboarding/session/seen`]: SELF("marks the caller's own read position"),
  [`POST ${P}/repos/:id/onboarding/session/proposals/:mid/:pid`]: A("onboarding.manage", "onboarding.merge", "onboarding.exception"),
  [`PUT ${P}/guidelines`]: A("agent.edit"), [`PUT ${P}/projects/:id/guidelines`]: A("onboarding.guidelines"),
  // people
  [`POST ${P}/teams`]: A("people.manage"), [`PATCH ${P}/teams/:id`]: A("people.manage"), [`DELETE ${P}/teams/:id`]: A("people.manage"),
  [`POST ${P}/teams/:id/roles`]: A("people.manage"), [`DELETE ${P}/teams/:id/roles/:grant`]: A("people.manage"),
  [`POST ${P}/invites`]: A("people.manage"), [`POST ${P}/invites/:id/accept`]: A("people.manage"), [`POST ${P}/invites/:id/resend`]: A("people.manage"),
  [`PUT ${P}/people/:id/factory-roles/:role`]: A("people.manage"), [`DELETE ${P}/people/:id/factory-roles/:role`]: A("people.manage"),
  [`POST ${P}/people/:id/deactivate`]: A("people.manage"), [`POST ${P}/people/:id/reactivate`]: A("people.manage"), [`PUT ${P}/people/:id/teams`]: A("people.manage"),
  [`PUT ${P}/people/:id/oncall`]: SELF("retired; always answers 410"), [`PUT ${P}/people/:id/away`]: SELF("a person sets their own away status; for someone else the handler needs people.manage or approvers.edit"),
  // projects
  [`POST ${P}/projects`]: A("project.create"), [`POST ${P}/templates`]: A("template.edit"), [`PATCH ${P}/templates/:id`]: A("template.edit"),
  [`POST ${P}/saved-views`]: SELF(PERSONAL), [`PATCH ${P}/saved-views/:id`]: SELF(PERSONAL), [`DELETE ${P}/saved-views/:id`]: SELF(PERSONAL),
  [`PATCH ${P}/projects/:id/config`]: PICK((r) => (String(body(r).path ?? "").split(".")[0] === "notifications" ? "notify.edit" : "project.config"), "project.config", "notify.edit"),
  [`POST ${P}/projects/:id/flow/:kind`]: PICK((r) => (param(r, "kind") === "classes" ? "class.edit" : "flow.edit"), "flow.edit", "class.edit"), [`DELETE ${P}/projects/:id/flow/:kind/:sub`]: A("flow.edit"),
  [`PATCH ${P}/projects/:id/flow/:kind/:sub`]: PICK((r) => (param(r, "kind") === "classes" ? "class.edit" : "flow.edit"), "flow.edit", "class.edit"),
  [`PUT ${P}/projects/:id/approvers/:sub`]: A("approvers.edit"),
  [`PUT ${P}/projects/:id/members/:person/roles/:role`]: A("project.members"), [`DELETE ${P}/projects/:id/members/:person/roles/:role`]: A("project.members"),
  [`PUT ${P}/projects/:id/oncall`]: A("project.members"), [`POST ${P}/projects/:id/oncall/handover`]: SELF("the person on call hands over without a right"),
  [`POST ${P}/projects/:id/archive`]: A("project.archive"), [`POST ${P}/projects/:id/unarchive`]: A("project.archive"),
  // session and security
  [`DELETE ${P}/sessions/:id`]: SELF("own sessions; another person's need security.manage, decided in the handler"), [`PATCH ${P}/security`]: A("security.manage"), [`POST ${P}/security/recovery/confirm`]: A("security.manage"),
  [`POST ${P}/can`]: SELF("a read-only batch question about the caller's own rights"), "POST /auth/logout": X("sign-out clears the caller's own session"),
  // stops
  [`POST ${P}/stops`]: PICK((r) => stopOf(body(r).mode === "kill" ? "kill" : "halt", body(r).scope), "halt.factory", "line.halt", "kill.factory", "kill.project", "kill.workorder"),
  [`DELETE ${P}/stops/:id`]: PICK((r) => stopOf("resume", stopIdScope(r)), "resume.factory", "line.resume"),
  [`POST ${P}/stops/:id/restore`]: PICK((r) => stopOf("restore", stopIdScope(r)), "restore.factory", "restore.project", "restore.workorder"),
  // triggers
  [`POST ${P}/triggers`]: A("triggers.edit"), [`PATCH ${P}/triggers/:id`]: A("triggers.edit"), [`POST ${P}/triggers/:id/dry-run`]: A("triggers.edit"), [`POST ${P}/triggers/:id/fire`]: A("triggers.run"),
  [`POST ${P}/trigger-proposals/:id/release`]: A("wo.submit"), [`POST ${P}/trigger-proposals/:id/decline`]: A("wo.submit"),
  // trust
  [`POST ${P}/trust/grants`]: A("trust.grant"), [`POST ${P}/trust/proposals/:id/decide`]: A("trust.grant"), [`POST ${P}/trust/cells/:id/demote`]: A("trust.grant"),
  [`PUT ${P}/trust/criteria`]: A("trust.criteria"), [`PUT ${P}/trust/sample-rate`]: A("trust.criteria"), [`PUT ${P}/trust/switch`]: A("trust.criteria"),
  [`POST ${P}/trust/ceilings`]: A("trust.criteria"), [`DELETE ${P}/trust/ceilings/:id`]: A("trust.criteria"), [`POST ${P}/work-orders/:id/outcomes`]: A("outcome.record"),
  // work orders
  [`POST ${P}/projects/:id/work-orders`]: A("wo.submit"),
  [`POST ${P}/work-orders/:id/documents/:doc/comments`]: OWN("wo.answer"), [`POST ${P}/work-orders/:id/document-comments/:cid/resolve`]: OWN("wo.answer"),
  [`POST ${P}/work-orders/:id/documents/:doc/edit`]: A("gate.approve"), [`POST ${P}/work-orders/:id/documents/:doc/accept`]: A("gate.approve"),
  [`POST ${P}/work-orders/:id/questions/:qid/answer`]: OWN("wo.answer"), [`POST ${P}/work-orders/:id/assumptions/:aid`]: OWN("wo.answer"),
  [`POST ${P}/work-orders/:id/objections/:oid`]: A("gate.approve"), [`POST ${P}/work-orders/:id/scouts/:sid/stop`]: A("wo.park"), [`POST ${P}/work-orders/:id/research-plan`]: A("gate.approve"),
  [`POST ${P}/work-orders/:id/messages`]: { any: ["wo.answer", "wo.park"], own: "wo-requester", pick: (r) => (body(r).kind === "question" ? "wo.park" : "wo.answer") },
  [`PATCH ${P}/work-orders/:id/brief`]: OWN("wo.answer"),
  [`POST ${P}/work-orders/:id/reclassify`]: A("wo.classify"), [`POST ${P}/work-orders/:id/confirm-brief`]: A("brief.confirm"), [`POST ${P}/work-orders/:id/decline`]: A("wo.decline"),
  [`POST ${P}/gate-instances/:id/approve`]: { any: GATE_ACTIONS, pick: (r, st) => actionForGate(st.catalog, parseGateId(param(r, "id")).gateId) },
  [`POST ${P}/gate-instances/:id/reject`]: { any: GATE_ACTIONS, pick: (r, st) => (parseGateId(param(r, "id")).gateId === "G0G1" ? "wo.decline" : actionForGate(st.catalog, parseGateId(param(r, "id")).gateId)) },
  [`POST ${P}/work-orders/:id/move`]: { any: ["wo.move"], unless: (r) => body(r).dry_run === true }, [`POST ${P}/work-orders/:id/send-back`]: A("wo.sendback"), [`POST ${P}/work-orders/:id/park`]: PICK((r) => (body(r).bay === "declined" ? "wo.decline" : "wo.park"), "wo.park", "wo.decline"),
  [`POST ${P}/work-orders/:id/unpark`]: A("wo.park"), [`POST ${P}/work-orders/:id/reassign`]: A("wo.reassign"), [`POST ${P}/work-orders/:id/retry`]: A("wo.sendback"), [`POST ${P}/work-orders/:id/refresh-context`]: A("wo.sendback"), [`POST ${P}/work-orders/:id/retry-with-limits`]: A("project.config"), [`POST ${P}/work-orders/:id/wip-override`]: A("wo.move"),
  [`PUT ${P}/work-orders/:id/budget`]: A("project.config"), [`PUT ${P}/work-orders/:id/record/summary`]: A("wo.answer"),
  [`POST ${P}/work-orders/:id/session/messages`]: OWN("wo.answer"), [`POST ${P}/work-orders/:id/session/seen`]: SELF("marks the caller's own read position"),
  [`POST ${P}/work-orders/:id/session/proposals/:mid/:pid`]: OWN("wo.answer", "brief.confirm", "wo.classify", "wo.decline"),
  [`POST ${P}/access-requests/:id/dismiss`]: A("project.members"),
  // workspace threads: the caller's own conversations
  [`POST ${P}/workspace/threads`]: SELF(PERSONAL), [`PATCH ${P}/workspace/threads/:key`]: SELF(PERSONAL), [`POST ${P}/workspace/threads/:id/members`]: SELF(PERSONAL), [`DELETE ${P}/workspace/threads/:id/members/:person`]: SELF(PERSONAL),
  // inbound hooks: signature-checked, not behind a session
  "POST /hooks/github": X("GitHub signature"), "POST /hooks/slack": X("Slack signature"), "POST /hooks/teams": X("not available; answers 501"), "POST /hooks/trigger/:instance": X("signed webhook"),
};

/** Whole prefixes decided by something other than the role matrix. */
export const EXEMPT_PREFIXES: Readonly<Record<string, string>> = { "/internal/v1/": "service token (edge or GitHub broker), authenticated in onRequest" };

export const isWriteMethod = (m: string): boolean => m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";

/** The declaration for a route, by the method and the route's URL pattern as registered (not the request URL). */
export function gateFor(method: string, pattern: string): WriteGate | null {
  const hit = WRITE_GATES[`${method} ${pattern}`];
  if (hit) return hit;
  for (const [prefix, exempt] of Object.entries(EXEMPT_PREFIXES)) if (pattern.startsWith(prefix)) return { exempt };
  return null;
}

/** The rights the gate asks for, for a state (empty for self and exempt routes). */
export function gateActions(gate: WriteGate, st: PolicyStateLoaded): readonly string[] {
  if (!("any" in gate)) return [];
  return typeof gate.any === "function" ? gate.any(st) : gate.any;
}

async function isRequester(req: FastifyRequest): Promise<boolean> {
  const id = (req.params as { id?: unknown } | undefined)?.id;
  const p = req.gx.principal;
  if (typeof id !== "string" || p?.kind !== "person") return false;
  const g = req.server.gantry;
  const row = await readWoRow(g.pool, g.orgId, id).catch(() => null);
  return !!row && row.submitter === p.id;
}

/** The scope the denial is recorded in (the ledger's project and work order columns), from the route's own id parameter. Best effort: none is fine. */
async function auditScope(req: FastifyRequest): Promise<Scope> {
  const pattern = req.routeOptions?.url ?? "";
  const id = param(req, "id");
  if (!id) return {};
  const g = req.server.gantry;
  if (pattern.includes("/projects/:id")) return { project: id };
  if (pattern.includes("/work-orders/:id")) {
    const w = await readWoRow(g.pool, g.orgId, id).catch(() => null);
    return w ? { project: w.project, repo: w.repo, wo: w.id } : {};
  }
  if (pattern.includes("/repos/:id")) {
    const r = (await g.pool.query<{ project_id: string }>(`select project_id from repos where org_id = $1 and id = $2`, [g.orgId, id]).catch(() => ({ rows: [] }))).rows[0];
    return r ? { project: r.project_id } : {};
  }
  return {};
}

/**
 * The denial of a write request, or null: the route declares rights (core/write-gate.ts), the caller is a person, and holds none of them anywhere (and, for a
 * route that lets the requester act, is not the requester). Any failure to read the policy answers null: command() decides, as it always did (the stop
 * path must work while policy tables are unreadable, spec 8.5).
 */
export async function declaredDenial(req: FastifyRequest): Promise<{ action: string; decision: Decision; scope: Scope } | null> {
  const pattern = req.routeOptions?.url;
  const gate = pattern && isWriteMethod(req.method) ? gateFor(req.method, pattern) : null;
  if (!gate || !("any" in gate) || req.gx?.principal?.kind !== "person" || gate.unless?.(req)) return null;
  try {
    const st = await policyState(req);
    const actions = gateActions(gate, st);
    const lacks = await lacksEveryRight(req, actions);
    if (!lacks || (gate.own === "wo-requester" && (await isRequester(req)))) return null;
    const picked = (() => { try { return gate.pick?.(req, st) ?? null; } catch { return null; } })();
    const action = picked && actions.includes(picked) ? picked : lacks.action;
    const decision = action === lacks.action ? lacks.decision : (await lacksEveryRight(req, [action]))?.decision ?? lacks.decision;
    return { action, decision, scope: await auditScope(req) };
  } catch (err) {
    req.log.warn({ err }, "write gate could not decide; command() will");
    return null;
  }
}

/** preHandler: authorisation comes before the handler reads its body, ids or entities. Audits the denial like the decision point does, then refuses. */
export async function enforceWriteGate(req: FastifyRequest): Promise<void> {
  const denied = await declaredDenial(req);
  if (!denied) return;
  const { auditDenial } = await import("./command.js");
  await auditDenial(req, { action: denied.action, scope: denied.scope }, denied.decision).catch((err: unknown) => req.log.error({ err }, "could not audit denial"));
  throw refuseDecision(denied.decision);
}

/**
 * Called by command(): the right a command is decided with must be one its route declares, or the gate in front of it would refuse people the command
 * allows (or let through people it refuses). A mismatch is a programming error: it throws under test and is logged loudly everywhere else.
 */
export async function checkDeclared(req: FastifyRequest, action: string | null): Promise<void> {
  const pattern = req.routeOptions?.url;
  const gate = pattern && isWriteMethod(req.method) ? gateFor(req.method, pattern) : null;
  if (!action || !gate || !("any" in gate) || req.gx?.principal?.kind !== "person") return;
  // Policy data may be unreadable (the stop path decides from a snapshot): a static declaration needs none, and a catalogue-dependent one is skipped then.
  const declared = typeof gate.any === "function" ? await policyState(req).then((st) => gateActions(gate, st)).catch(() => null) : gate.any;
  if (!declared || declared.includes(action)) return;
  const msg = `${req.method} ${pattern} is decided with "${action}", which its write gate (core/write-gate.ts) does not declare.`;
  if (process.env.VITEST) throw new Error(msg);
  req.log.error({ route: pattern, action }, msg);
}
