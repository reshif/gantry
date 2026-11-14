/**
 * `ops`: the typed replacement for legacy G.ops (spec 15.1: the mechanical swap).
 *
 * One function per legacy operation, each mapped to its spec section 8 endpoint. Each resolves to
 * `{ ok: true, msg, ...extra }` or a refusal `{ ok: false, msg, rule?, needs?, status }`; none throws
 * for an expected refusal. On success the right query slices are invalidated so the screen
 * refetches immediately; the SSE stream does the same for other people's changes.
 *
 * Not here on purpose (no browser operation exists in production):
 *  - recordSignInFailure: the server records failures in /auth/callback.
 *  - simulateChecksPass, recordOutcome, change, raiseQuestion (agent side): results arrive from GitHub / runs.
 *  - setReplay, openRecord: view state, kept in local prefs (see lib/prefs.ts).
 *
 * Id conventions the server must honour (integration notes):
 *  - gate instance id = `${woId}:${gateId}`           (POST /gate-instances/{id}/approve|reject)
 *  - stop id          = `${scope}:${targetId}`        (DELETE /stops/{id}, POST /stops/{id}/restore), scope in factory|project|repo|workorder
 */
import { api, del, patch, post, put, command, type ApiResult, type RequestOptions } from "./client";
import { invalidateSlices } from "./keys";

type Obj = Record<string, unknown>;
/** Optimistic concurrency: the entity version from the last read, sent as If-Match. */
export interface Versioned {
  ifMatch?: string | number;
}
type Via = string | undefined;

const enc = encodeURIComponent;

/** Run a request and invalidate `slices` when it succeeded. */
async function run<T extends object = Obj>(slices: readonly string[], req: Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  const r = await req;
  if (r.ok) invalidateSlices([...slices, "audit"]);
  return r;
}

function opts(v?: Versioned, extra: Omit<RequestOptions, "method" | "body"> = {}): Omit<RequestOptions, "method" | "body"> {
  return v?.ifMatch !== undefined ? { ...extra, ifMatch: v.ifMatch } : extra;
}
const create = { idempotent: true } as const;

export type StopScope = "factory" | "project" | "repo" | "workorder";
const stopId = (scope: StopScope, id: string | null) => `${scope}:${id ?? ""}`;

export interface SubmitWorkOrder {
  project: string;
  repo: string;
  title: string;
  body?: string;
  cls?: string;
  priority?: string;
  estimate?: string;
  [extra: string]: unknown;
}
export interface KillOptions {
  reason: string;
  mode?: "hold" | "cancel";
  confirmText?: string | null;
}

export const ops = {
  /* ===== session ===== */
  /** Leaves the SPA for the identity provider (GET /auth/login). */
  signIn(method: "sso" | "github", loginHint?: string): Promise<ApiResult> {
    window.location.assign(loginUrl(method, loginHint));
    return Promise.resolve({ ok: true, msg: "Redirecting to sign in.", status: 302 });
  },
  async signOut(): Promise<ApiResult> {
    const r = await post("/auth/logout");
    if (r.ok) invalidateSlices(["session"]);
    return r;
  },
  revokeSession: (sessionId: string) => run(["sessions"], del(api(`sessions/${enc(sessionId)}`))),
  setSecurity: (path: string, value: unknown, v?: Versioned) => run(["security"], patch(api("security"), { path, value }, opts(v))),

  /* ===== work orders, intake, conversations ===== */
  submitWO: (o: SubmitWorkOrder, via?: Via) =>
    run(["workOrders", "conversations"], post(api(`projects/${enc(o.project)}/work-orders`), { ...o, via }, create)),
  answer: (woId: string, text: string, via?: Via) => run(["workOrders", "conversations"], post(api(`work-orders/${enc(woId)}/messages`), { text, via })),
  raiseQuestionAtIntake: (woId: string, text: string) =>
    run(["workOrders", "conversations"], post(api(`work-orders/${enc(woId)}/messages`), { text, kind: "question" })),
  addFollowup: (woId: string, q: { text: string; chips?: string[]; mode?: string }) =>
    run(["workOrders", "conversations"], post(api(`work-orders/${enc(woId)}/messages`), { ...q, kind: "followup" })),
  reclassify: (woId: string, cls: string, reason: string, v?: Versioned) =>
    run(["workOrders"], post(api(`work-orders/${enc(woId)}/reclassify`), { cls, reason }, opts(v))),
  confirmBrief: (woId: string, via?: Via, v?: Versioned) => run(["workOrders"], post(api(`work-orders/${enc(woId)}/confirm-brief`), { via }, opts(v))),
  decline: (woId: string, reason: string, via?: Via, v?: Versioned) =>
    run(["workOrders"], post(api(`work-orders/${enc(woId)}/decline`), { reason, via }, opts(v))),
  setRecordSummary: (woId: string, text: string, v?: Versioned) =>
    run(["record", "workOrders"], put(api(`work-orders/${enc(woId)}/record/summary`), { text }, opts(v))),

  /* ===== gates ===== */
  approveGate: (woId: string, gateId: string, via?: Via, v?: Versioned) =>
    run(["workOrders", "trust"], post(api(`gate-instances/${enc(`${woId}:${gateId}`)}/approve`), { via }, opts(v))),
  rejectGate: (woId: string, gateId: string, reason: string, via?: Via, v?: Versioned) =>
    run(["workOrders", "trust"], post(api(`gate-instances/${enc(`${woId}:${gateId}`)}/reject`), { reason, via }, opts(v))),

  /* ===== moving work ===== */
  moveTo: (woId: string, target: string, reason?: string, via?: Via, v?: Versioned) =>
    run(["workOrders"], post(api(`work-orders/${enc(woId)}/move`), { target, reason, via }, opts(v))),
  /** The move check (legacy G.moveCheck): same endpoint with dry_run, changes nothing. */
  moveCheck: (woId: string, target: string) => post(api(`work-orders/${enc(woId)}/move`), { target, dry_run: true }),
  sendBack: (woId: string, toStation: string, note: string, via?: Via, v?: Versioned) =>
    run(["workOrders"], post(api(`work-orders/${enc(woId)}/send-back`), { toStation, note, via }, opts(v))),
  park: (woId: string, bay: string, reason: string, via?: Via, v?: Versioned) =>
    run(["workOrders"], post(api(`work-orders/${enc(woId)}/park`), { bay, reason, via }, opts(v))),
  unpark: (woId: string, reason?: string, via?: Via, v?: Versioned) =>
    run(["workOrders"], post(api(`work-orders/${enc(woId)}/unpark`), { reason, via }, opts(v))),
  reassign: (woId: string, agentId: string, via?: Via, v?: Versioned) =>
    run(["workOrders"], post(api(`work-orders/${enc(woId)}/reassign`), { agent: agentId, via }, opts(v))),
  retry: (woId: string, via?: Via, v?: Versioned) => run(["workOrders"], post(api(`work-orders/${enc(woId)}/retry`), { via }, opts(v))),

  /* ===== stop controls ===== */
  haltRepo: (repoId: string, reason: string, via?: Via) =>
    run(["repos", "projects", "workOrders", "factory"], post(api("stops"), { scope: "repo", id: repoId, mode: "halt", reason, via })),
  resumeRepo: (repoId: string, via?: Via) =>
    run(["repos", "projects", "workOrders", "factory"], del(api(`stops/${enc(stopId("repo", repoId))}`), { via })),
  haltProject: (projectId: string, reason: string, via?: Via) =>
    run(["projects", "workOrders", "factory"], post(api("stops"), { scope: "project", id: projectId, mode: "halt", reason, via })),
  resumeProject: (projectId: string, via?: Via) =>
    run(["projects", "workOrders", "factory"], del(api(`stops/${enc(stopId("project", projectId))}`), { via })),
  kill: (scope: StopScope, id: string | null, o: KillOptions, via?: Via) =>
    run(["projects", "workOrders", "factory", "repos"], post(api("stops"), { scope, id, mode: "kill", reason: o.reason, inFlight: o.mode ?? "hold", confirmText: o.confirmText ?? null, via })),
  /** A restore may return `pending: true` when a second approver is needed. */
  restore: (scope: StopScope, id: string | null, reason: string, via?: Via) =>
    run(["projects", "workOrders", "factory", "repos"], post(api(`stops/${enc(stopId(scope, id))}/restore`), { reason, via })),

  /* ===== projects, templates, flow ===== */
  createProject: (o: Obj) => run(["projects", "me", "templates"], post(api("projects"), o, create)),
  archiveProject: (projectId: string, confirmText: string, v?: Versioned) =>
    run(["projects"], post(api(`projects/${enc(projectId)}/archive`), { confirmText }, opts(v))),
  unarchiveProject: (projectId: string, v?: Versioned) => run(["projects"], post(api(`projects/${enc(projectId)}/unarchive`), undefined, opts(v))),
  saveTemplate: (o: Obj) => run(["templates"], post(api("templates"), o, create)),
  updateTemplate: (tplId: string, patchBody: Obj, v?: Versioned) => run(["templates"], patch(api(`templates/${enc(tplId)}`), patchBody, opts(v))),
  /** `approvers.<gate>` paths go to the approvers endpoint; everything else to the config endpoint. */
  setProject: (projectId: string, path: string, value: unknown, v?: Versioned) => {
    const m = /^approvers\.(.+)$/.exec(path);
    const p = enc(projectId);
    return run(["projects"], m?.[1] ? put(api(`projects/${p}/approvers/${enc(m[1])}`), { value }, opts(v)) : patch(api(`projects/${p}/config`), { path, value }, opts(v)));
  },
  setGateMode: (projectId: string, gateId: string, mode: string, v?: Versioned) =>
    run(["projects"], patch(api(`projects/${enc(projectId)}/config`), { gate: gateId, mode }, opts(v))),
  addStation: (projectId: string, def: Obj, afterId?: string, v?: Versioned) =>
    run(["projects", "floor"], post(api(`projects/${enc(projectId)}/flow/stations`), { def, after: afterId ?? null }, opts(v, create))),
  removeStation: (projectId: string, stationId: string, v?: Versioned) =>
    run(["projects", "floor"], del(api(`projects/${enc(projectId)}/flow/stations/${enc(stationId)}`), undefined, opts(v))),
  moveStation: (projectId: string, stationId: string, dir: number, v?: Versioned) =>
    run(["projects", "floor"], patch(api(`projects/${enc(projectId)}/flow/stations/${enc(stationId)}`), { move: dir }, opts(v))),
  addGate: (projectId: string, def: Obj, v?: Versioned) => run(["projects", "floor"], post(api(`projects/${enc(projectId)}/flow/gates`), { def }, opts(v, create))),
  addBay: (projectId: string, def: Obj, v?: Versioned) => run(["projects", "floor"], post(api(`projects/${enc(projectId)}/flow/bays`), { def }, opts(v, create))),
  addClass: (projectId: string, def: Obj, v?: Versioned) => run(["projects", "floor"], post(api(`projects/${enc(projectId)}/flow/classes`), { def }, opts(v, create))),
  updateClass: (projectId: string, clsId: string, patchBody: Obj, v?: Versioned) =>
    run(["projects", "floor"], patch(api(`projects/${enc(projectId)}/flow/classes/${enc(clsId)}`), patchBody, opts(v))),
  setMemberRole: (personId: string, projectId: string, role: string, add: boolean) =>
    run(["people", "projects", "me"], (add ? put : del)(api(`projects/${enc(projectId)}/members/${enc(personId)}/roles/${enc(role)}`))),
  setAway: (personId: string, away: Obj | null, projectId?: string) => run(["people", "me"], put(api(`people/${enc(personId)}/away`), { away, project: projectId ?? null })),

  /* ===== onboarding ===== */
  connectRepo: (projectId: string, repoName: string, team: string, sourceId?: string) =>
    run(["repos", "projects"], post(api(`projects/${enc(projectId)}/repos`), { name: repoName, team, source: sourceId ?? null }, create)),
  configureRepo: (repoId: string, patchBody: Obj, v?: Versioned) => run(["repos"], patch(api(`repos/${enc(repoId)}/config`), patchBody, opts(v))),
  rerunAssessment: (repoId: string) => run(["repos"], post(api(`repos/${enc(repoId)}/onboarding/assess`))),
  openOnboardingPR: (repoId: string) => run(["repos"], post(api(`repos/${enc(repoId)}/onboarding/open-pr`))),
  mergeOnboardingPR: (repoId: string) => run(["repos"], post(api(`repos/${enc(repoId)}/onboarding/merge`))),
  requestChanges: (repoId: string, text: string) => run(["repos"], post(api(`repos/${enc(repoId)}/onboarding/request-changes`), { text })),
  markException: (repoId: string, reason: string) => run(["repos"], post(api(`repos/${enc(repoId)}/onboarding/exception`), { reason })),
  verifyNow: (repoId: string) => run(["repos"], post(api(`repos/${enc(repoId)}/onboarding/verify`))),
  saveGuidelines: (patchBody: Obj, note: string, projectId?: string | null) =>
    run(["guidelines", "projects"], put(api(projectId ? `projects/${enc(projectId)}/guidelines` : "guidelines"), { patch: patchBody, note })),

  /* ===== agents, skills, models, evals ===== */
  createAgent: (o: Obj) => run(["agents"], post(api("agents"), o, create)),
  saveAgent: (agentId: string, patchBody: Obj, note?: string, v?: Versioned) => run(["agents"], patch(api(`agents/${enc(agentId)}`), { patch: patchBody, note }, opts(v))),
  newAgentVersion: (agentId: string, from: number | string, note?: string) => run(["agents"], post(api(`agents/${enc(agentId)}/versions`), { from, note })),
  promoteAgent: (agentId: string, version: number | string) => run(["agents"], post(api(`agents/${enc(agentId)}/versions/${enc(String(version))}/promote`))),
  rollbackAgent: (agentId: string, version: number | string) => run(["agents"], post(api(`agents/${enc(agentId)}/rollback`), { version })),
  attachSkill: (agentId: string, skillId: string, attach: boolean) =>
    run(["agents", "skills"], (attach ? put : del)(api(`agents/${enc(agentId)}/skills/${enc(skillId)}`))),
  saveInstructions: (text: string) => run(["instructions", "agents"], put(api("instructions/base"), { text })),
  /** skillId null creates a skill. */
  saveSkill: (skillId: string | null, patchBody: Obj, note?: string, v?: Versioned) =>
    run(["skills"], skillId ? patch(api(`skills/${enc(skillId)}`), { patch: patchBody, note }, opts(v)) : post(api("skills"), { ...patchBody, note }, create)),
  setSkillProjects: (skillId: string, projects: string[]) => run(["skills"], put(api(`skills/${enc(skillId)}/projects`), { projects })),
  addVendor: (def: Obj) => run(["vendors", "routing"], post(api("vendors"), def, create)),
  setVendor: (vendorId: string, patchBody: Obj, action?: string) => run(["vendors", "routing"], patch(api(`vendors/${enc(vendorId)}`), { patch: patchBody, action })),
  addModel: (vendorId: string, def: Obj) => run(["vendors"], post(api("models"), { vendor: vendorId, def }, create)),
  removeModel: (modelId: string) => run(["vendors", "routing"], del(api(`models/${enc(modelId)}`))),
  setModelEnabled: (modelId: string, on: boolean) => run(["vendors", "routing"], patch(api(`models/${enc(modelId)}`), { enabled: on })),
  setRouting: (next: Obj, label?: string, v?: Versioned) => run(["routing"], put(api("routing"), { routing: next, label }, opts(v))),
  runSuite: (agentId: string, suiteId: string, version: number | string, model?: string) =>
    run(["evalRuns", "scorecards", "evalExtra", "agents"], post(api(`suites/${enc(suiteId)}/runs`), { agent: agentId, version, model }, create)),
  addEvalCase: (suiteId: string, c: Obj) => run(["suites", "evalRuns"], post(api(`suites/${enc(suiteId)}/cases`), c, create)),

  /* ===== trust, learning ===== */
  grantTrust: (target: string | Obj, level: number, reason: string) => run(["trust"], post(api("trust/grants"), { target, level, reason })),
  decideTrustProposal: (proposalId: string, accept: boolean, reason?: string) =>
    run(["trust"], post(api(`trust/proposals/${enc(proposalId)}/decide`), { accept, reason })),
  demoteTrust: (cellId: string, to: number, reason: string) => run(["trust"], post(api(`trust/cells/${enc(cellId)}/demote`), { to, reason })),
  setTrustCriteria: (level: number | string, patchBody: Obj) => run(["trust"], put(api("trust/criteria"), { level, patch: patchBody })),
  saveCeiling: (c: Obj) => run(["trust"], post(api("trust/ceilings"), c)),
  removeCeiling: (id: string) => run(["trust"], del(api(`trust/ceilings/${enc(id)}`))),
  setSampleRate: (n: number) => run(["trust"], put(api("trust/sample-rate"), { n })),
  acceptLearning: (proposalId: string, note?: string) => run(["learning"], post(api(`learning/proposals/${enc(proposalId)}/accept`), { note })),
  declineLearning: (proposalId: string, reason: string) => run(["learning"], post(api(`learning/proposals/${enc(proposalId)}/decline`), { reason })),
  verifyLearning: (proposalId: string) => run(["learning"], post(api(`learning/proposals/${enc(proposalId)}/verify`))),
  draftLearning: (findingId: string, o: Obj = {}) => run(["learning"], post(api("learning/proposals"), { finding: findingId, ...o }, create)),
  refreshFindings: () => run(["learning"], post(api("learning/findings/refresh"))),

  /* ===== integrations, notifications, MCP, keys, triggers ===== */
  addIntegrationType: (def: Obj) => run(["integrationTypes"], post(api("integration-types"), def, create)),
  removeIntegrationType: (id: string) => run(["integrationTypes", "integrationInstances"], del(api(`integration-types/${enc(id)}`))),
  addIntegration: (o: Obj) => run(["integrationInstances"], post(api("integrations"), o, create)),
  updateIntegration: (id: string, patchBody: Obj) => run(["integrationInstances"], patch(api(`integrations/${enc(id)}`), patchBody)),
  removeIntegration: (id: string) => run(["integrationInstances"], del(api(`integrations/${enc(id)}`))),
  testIntegrationInstance: (id: string) => run(["integrationInstances"], post(api(`integrations/${enc(id)}/test`))),
  /** Channel-level connection settings (slack, email, ...). */
  setIntegration: (channel: string, patchBody: Obj) => run(["integrations", "integrationInstances"], patch(api(`integrations/${enc(channel)}`), patchBody)),
  testIntegration: (channel: string) => run(["integrations", "integrationInstances"], post(api(`integrations/${enc(channel)}/test`))),
  /** routeId null creates a route. */
  saveRoute: (projectId: string, routeId: string | null, route: Obj) =>
    run(["notifications", "projects"], routeId ? patch(api(`projects/${enc(projectId)}/routes/${enc(routeId)}`), route) : post(api(`projects/${enc(projectId)}/routes`), route, create)),
  deleteRoute: (projectId: string, routeId: string) => run(["notifications", "projects"], del(api(`projects/${enc(projectId)}/routes/${enc(routeId)}`))),
  sendTest: (projectId: string, dest: string, target: string, event: string) =>
    run(["deliveries"], post(api(`projects/${enc(projectId)}/routes/test`), { dest, target, event })),
  retryDelivery: (deliveryId: string) => run(["deliveries"], post(api(`deliveries/${enc(deliveryId)}/retry`))),
  saveCardTemplate: (tpl: Obj) => run(["cardTemplates"], post(api("card-templates"), tpl)),
  removeCardTemplate: (id: string) => run(["cardTemplates"], del(api(`card-templates/${enc(id)}`))),
  /** Renders a card without saving it: a POST that changes nothing. */
  previewCardTemplate: (tpl: Obj) => post(api("card-templates/preview"), tpl),
  discoverTools: (name: string, url: string) => post(api("mcp/discover"), { name, url }),
  addMCP: (o: Obj) => run(["mcp"], post(api("mcp/servers"), o, create)),
  updateMCP: (id: string, patchBody: Obj) => run(["mcp"], patch(api(`mcp/servers/${enc(id)}`), patchBody)),
  removeMCP: (id: string) => run(["mcp"], del(api(`mcp/servers/${enc(id)}`))),
  /** The secret is in the result's extras, once. */
  createKey: (o: Obj) => run(["apiKeys"], post(api("api-keys"), o, create)),
  revokeKey: (keyId: string) => run(["apiKeys"], del(api(`api-keys/${enc(keyId)}`))),
  setApiConfig: (patchBody: Obj) => run(["apiConfig"], patch(api("api-config"), patchBody)),
  /** Public API try-it: submits with the key the person pastes, as an external client would. */
  apiSubmit: (apiKeySecret: string, projectId: string, body: Obj) =>
    run(["workOrders", "requestLog"], command(api(`projects/${enc(projectId)}/work-orders`), { method: "POST", body, idempotent: true, headers: { Authorization: `Bearer ${apiKeySecret}` } })),
  /** triggerId null creates a trigger. */
  saveTrigger: (triggerId: string | null, patchBody: Obj) =>
    run(["triggers"], triggerId ? patch(api(`triggers/${enc(triggerId)}`), patchBody) : post(api("triggers"), patchBody, create)),
  /** Dry run: evaluates the trigger against an input and changes nothing. */
  simulateTrigger: (triggerId: string, input: Obj) => post(api(`triggers/${enc(triggerId)}/dry-run`), input),

  /* ===== people, access ===== */
  invite: (o: Obj) => run(["people"], post(api("invites"), o, create)),
  acceptInvite: (personId: string) => run(["people", "me"], post(api(`invites/${enc(personId)}/accept`))),
  setFactoryRole: (personId: string, roleId: string, add: boolean) =>
    run(["people", "me"], (add ? put : del)(api(`people/${enc(personId)}/factory-roles/${enc(roleId)}`))),
  setTeams: (personId: string, teams: string[]) => run(["people"], put(api(`people/${enc(personId)}/teams`), { teams })),
  setOncall: (personId: string, on: boolean) => run(["people", "me"], put(api(`people/${enc(personId)}/oncall`), { on })),
  setMatrix: (roleId: string, actionId: string, on: boolean, v?: Versioned) =>
    run(["matrix"], put(api(`access/matrix/${enc(roleId)}/${enc(actionId)}`), { on }, opts(v))),
  addRole: (def: Obj) => run(["matrix"], post(api("roles"), def, create)),
  updateRole: (roleId: string, patchBody: Obj) => run(["matrix"], patch(api(`roles/${enc(roleId)}`), patchBody)),
  removeRole: (roleId: string) => run(["matrix"], del(api(`roles/${enc(roleId)}`))),
  /** policyId null creates a policy. */
  savePolicy: (policyId: string | null, data: Obj, v?: Versioned) =>
    run(["policies"], policyId ? patch(api(`policies/${enc(policyId)}`), data, opts(v)) : post(api("policies"), data, create)),
  setPolicyEnabled: (policyId: string, on: boolean) => run(["policies"], patch(api(`policies/${enc(policyId)}`), { enabled: on })),
  deletePolicy: (policyId: string) => run(["policies"], del(api(`policies/${enc(policyId)}`))),
  saveFreeze: (f: Obj) => run(["freezes"], post(api("freezes"), f, create)),
  endFreeze: (freezeId: string) => run(["freezes"], post(api(`freezes/${enc(freezeId)}/end`))),
  /** The access simulator: the same decision function as enforcement. Changes nothing. */
  simulateAccess: (q: { person: string; action: string; project?: string; repo?: string; time?: number }) => post(api("access/simulate"), q),
  saveSavedView: (view: Obj) => run(["savedViews"], post(api("saved-views"), view, create)),
  updateSavedView: (id: string, patchBody: Obj, v?: Versioned) => run(["savedViews"], patch(api(`saved-views/${enc(id)}`), patchBody, opts(v))),
  deleteSavedView: (id: string, v?: Versioned) => run(["savedViews"], del(api(`saved-views/${enc(id)}`), undefined, opts(v))),

  /* ===== console ===== */
  /** The console endpoint, non-streaming form: the whole answer and any proposed confirm cards. */
  consoleMessage: (body: Obj) => post(api("console/messages"), body),
} as const;

export type Ops = typeof ops;

/** GET /auth/login target for a sign-in method (spec 14.1). `loginHint` is the email of a demo account. */
/** Fresh sign-in for a step-up (spec 14.1), coming back to the same screen: the hash route travels as `return_to`. */
export function stepUpUrl(hash: string = typeof window === "undefined" ? "" : window.location.hash): string {
  return `/auth/login?step_up=1&return_to=${encodeURIComponent(`/${hash}`)}`;
}

export function loginUrl(method: "sso" | "github", loginHint?: string): string {
  const sp = new URLSearchParams();
  if (loginHint) sp.set("login_hint", loginHint);
  else sp.set("method", method);
  return `/auth/login?${sp.toString()}`;
}
