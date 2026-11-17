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
import { clearDrafts } from "./drafts";
import { api, del, patch, post, put, command, type ApiResult, type RequestOptions } from "./client";
import { invalidateSlices } from "./keys";

type Obj = Record<string, unknown>;
/** Optimistic concurrency: the entity version from the last read, sent as If-Match. */
export interface Versioned {
  ifMatch?: string | number;
}
/** Open work a deactivated person leaves behind: why they matter to it is `roles` (requester, assignee, sole_approver). */
export interface OpenWorkItem { id: string; title?: string; project?: string; state?: string; roles?: string[]; gate?: string }
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
  /**
   * Ends the Gantry session, then sends the browser to the identity provider's end-session page (`logoutUrl`) so its SSO
   * session ends too; the provider redirects back to the app. Without a `logoutUrl`, the app just shows the signed-out screen.
   */
  async signOut(): Promise<ApiResult<{ logoutUrl?: string }>> {
    const r = await post<{ logoutUrl?: string }>("/auth/logout");
    if (r.ok) clearDrafts();
    if (r.ok && typeof r.logoutUrl === "string" && /^https?:\/\//.test(r.logoutUrl)) {
      window.location.assign(r.logoutUrl);
      return r;
    }
    if (r.ok) invalidateSlices(["session"]);
    return r;
  },
  revokeSession: (sessionId: string) => run(["sessions"], del(api(`sessions/${enc(sessionId)}`))),
  setSecurity: (path: string, value: unknown, v?: Versioned) => run(["security"], patch(api("security"), { path, value }, opts(v))),

  /* ===== work orders, intake, conversations ===== */
  /** `key` is the Idempotency-Key: reuse it when a submit is retried so the work order is created once. */
  submitWO: (o: SubmitWorkOrder, via?: Via, key?: string) =>
    run(["workOrders", "conversations"], post(api(`projects/${enc(o.project)}/work-orders`), { ...o, via }, key ? { idempotent: key } : create)),
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
  /** Who is on call for a project (its admins choose; Factory Admins always count and are never listed). */
  setProjectOncall: (projectId: string, people: string[], v?: Versioned) => run<{ oncall: string[]; version: number }>(["projects", "people", "me"], put(api(`projects/${enc(projectId)}/oncall`), { people }, opts(v))),
  /** The person on call hands over to someone with a role on the same project. */
  handOverOncall: (projectId: string, to: string, v?: Versioned) => run<{ oncall: string[]; version: number }>(["projects", "people", "me"], post(api(`projects/${enc(projectId)}/oncall/handover`), { to }, opts(v))),
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
  saveGuidelines: (patchBody: Obj, note: string, projectId?: string | null, v?: Versioned) =>
    run(["guidelines", "projects"], put(api(projectId ? `projects/${enc(projectId)}/guidelines` : "guidelines"), { patch: patchBody, note }, opts(v))),

  /* ===== agents, skills, models, evals ===== */
  createAgent: (o: Obj) => run(["agents", "suites"], post(api("agents"), o, create)),
  /** `v.ifMatch` is the agent's `rev` from the last read. */
  saveAgent: (agentId: string, patchBody: Obj, note?: string, v?: Versioned) => run(["agents"], patch(api(`agents/${enc(agentId)}`), { patch: patchBody, note }, opts(v))),
  /** A candidate version snapshotting the saved configuration; `label` looks like 1.2.3 or 1.2.3-rc1. */
  newAgentVersion: (agentId: string, label: string, note?: string, v?: Versioned) => run(["agents"], post(api(`agents/${enc(agentId)}/versions`), { label, note }, opts(v))),
  promoteAgent: (agentId: string, version: number | string, v?: Versioned) => run(["agents"], post(api(`agents/${enc(agentId)}/versions/${enc(String(version))}/promote`), undefined, opts(v))),
  rollbackAgent: (agentId: string, version: number | string, v?: Versioned) => run(["agents"], post(api(`agents/${enc(agentId)}/rollback`), { version }, opts(v))),
  attachSkill: (agentId: string, skillId: string, attach: boolean) =>
    run(["agents", "skills"], (attach ? put : del)(api(`agents/${enc(agentId)}/skills/${enc(skillId)}`))),
  /** `v.ifMatch` is the base version from GET /instructions/base. */
  saveInstructions: (text: string, v?: Versioned) => run(["instructions", "agents"], put(api("instructions/base"), { text }, opts(v))),
  /** skillId null creates a skill. */
  saveSkill: (skillId: string | null, patchBody: Obj, note?: string, v?: Versioned) =>
    run(["skills"], skillId ? patch(api(`skills/${enc(skillId)}`), { patch: patchBody, note }, opts(v)) : post(api("skills"), { ...patchBody, note }, create)),
  setSkillProjects: (skillId: string, projects: string[] | "all") => run(["skills"], put(api(`skills/${enc(skillId)}/projects`), { projects })),
  addVendor: (def: Obj) => run(["vendors", "routing"], post(api("vendors"), def, create)),
  setVendor: (vendorId: string, patchBody: Obj, action?: string) => run(["vendors", "routing"], patch(api(`vendors/${enc(vendorId)}`), { patch: patchBody, action })),
  /** Adds a vendor from a template (spec 10.4): the server lists its models with the credentials and stores them with the vendor. */
  addVendorFromTemplate: (def: { template: string; name?: string; fields: Record<string, string>; retention?: string }) => run(["vendors", "routing"], post(api("vendors/from-template"), def, create)),
  /** Lists the vendor's models again and adds the new ones; switches and prices already set are kept. */
  discoverVendorModels: (vendorId: string) => run(["vendors", "routing"], post(api(`vendors/${enc(vendorId)}/discover`), {})),
  addModel: (vendorId: string, def: Obj) => run(["vendors"], post(api("models"), { vendor: vendorId, def }, create)),
  removeModel: (modelId: string) => run(["vendors", "routing"], del(api(`models/${enc(modelId)}`))),
  setModelEnabled: (modelId: string, on: boolean) => run(["vendors", "routing"], patch(api(`models/${enc(modelId)}`), { enabled: on })),
  setRouting: (next: Obj, label?: string, v?: Versioned) => run(["routing"], put(api("routing"), { routing: next, label }, opts(v))),
  /** Records that a custom vendor passed a station's suite (the server checks the eval run). */
  qualifyVendor: (vendorId: string, station: string, v?: Versioned) => run(["vendors", "routing"], post(api(`vendors/${enc(vendorId)}/qualify`), { station }, opts(v))),
  /** prices: model id -> USD per million tokens. effectiveFrom is an ISO timestamp, now or later. */
  publishPrices: (prices: Record<string, { in: number; out: number; cacheRead?: number; cacheWrite?: number }>, effectiveFrom?: string, note?: string) =>
    run(["vendors"], post(api("prices"), { prices, ...(effectiveFrom ? { effectiveFrom } : {}), ...(note ? { note } : {}) }, create)),
  /** The default cost cap for each work order of a project, in USD (0 = none). The monthly budget is set in project config. */
  setWoBudget: (project: string, perWorkOrder: number) => run(["vendors", "projects"], put(api(`budgets/${enc(project)}`), { perWorkOrder })),
  /** Starts a real run of the suite through the production runtime (sandboxes, no write access to real repos). `repeats` runs each task that many times. */
  runSuite: (agentId: string, suiteId: string, version: number | string, model?: string, repeats?: number) =>
    run(["evalRuns", "suites", "scorecards", "evalExtra", "agents"], post(api(`suites/${enc(suiteId)}/runs`), { agent: agentId, version, ...(model ? { model } : {}), ...(repeats && repeats > 1 ? { repeats } : {}) }, create)),
  cancelEvalRun: (suiteId: string, runId: string) => run(["evalRuns", "suites"], post(api(`suites/${enc(suiteId)}/runs/${enc(runId)}/cancel`))),
  addEvalCase: (suiteId: string, c: Obj) => run(["suites", "evalRuns", "skills"], post(api(`suites/${enc(suiteId)}/cases`), c, create)),

  /* ===== trust, learning ===== */
  /** A cell id, or `{ agent, cls, project, repo? }` to create the cell. `v` is the cell's `rev` (0 or absent for a cell that does not exist yet). */
  grantTrust: (target: string | Obj, level: number, reason: string, v?: Versioned) => run(["trust"], post(api("trust/grants"), { target, level, reason }, opts(v))),
  decideTrustProposal: (proposalId: string, accept: boolean, reason?: string) =>
    run(["trust"], post(api(`trust/proposals/${enc(proposalId)}/decide`), { accept, reason })),
  demoteTrust: (cellId: string, to: number, reason: string, v?: Versioned) => run(["trust"], post(api(`trust/cells/${enc(cellId)}/demote`), { to, reason }, opts(v))),
  /** `v` is the criteria version (Trust.criteriaVersion): a change publishes the next version. */
  setTrustCriteria: (level: number | string, patchBody: Obj, v?: Versioned) => run(["trust"], put(api("trust/criteria"), { level, patch: patchBody }, opts(v))),
  saveCeiling: (c: Obj, v?: Versioned) => run(["trust"], post(api("trust/ceilings"), c, c.id ? opts(v) : { ...create, ...opts(v) })),
  removeCeiling: (id: string, v?: Versioned) => run(["trust"], del(api(`trust/ceilings/${enc(id)}`), undefined, opts(v))),
  setSampleRate: (n: number, v?: Versioned) => run(["trust"], put(api("trust/sample-rate"), { n }, opts(v))),
  /** A post-release outcome on a shipped work order, with who or what it is attributed to. An attributed revert or incident lowers the agent's trust cells to L1. */
  recordOutcome: (woId: string, o: Obj) => run(["trust", "workOrders", "learning"], post(api(`work-orders/${enc(woId)}/outcomes`), o, create)),
  /** The runtime switch for trust levels above L1 (off in a new install). Turning it on needs a reason. */
  setTrustSwitch: (on: boolean, reason?: string) => run(["trust"], put(api("trust/switch"), { on, ...(reason ? { reason } : {}) })),
  acceptLearning: (proposalId: string, note?: string) => run(["learning", "skills", "agents", "suites", "projects", "guidelines"], post(api(`learning/proposals/${enc(proposalId)}/accept`), { note })),
  declineLearning: (proposalId: string, reason: string) => run(["learning"], post(api(`learning/proposals/${enc(proposalId)}/decline`), { reason })),
  verifyLearning: (proposalId: string) => run(["learning"], post(api(`learning/proposals/${enc(proposalId)}/verify`))),
  draftLearning: (findingId: string, o: Obj = {}) => run(["learning"], post(api("learning/proposals"), { finding: findingId, ...o }, create)),
  refreshFindings: () => run(["learning"], post(api("learning/findings/refresh"))),
  rollbackLearning: (proposalId: string, reason: string) => run(["learning", "skills", "agents", "suites", "projects", "guidelines"], post(api(`learning/proposals/${enc(proposalId)}/rollback`), { reason })),
  /** Learning proposals are off in a new install (spec 15.3). Turning them on needs a reason. */
  setLearningSwitch: (on: boolean, reason?: string) => run(["learning"], put(api("learning/switch"), { on, ...(reason ? { reason } : {}) })),

  /* ===== integrations, notifications, MCP, keys, triggers ===== */
  addIntegrationType: (def: Obj) => run(["integrationTypes"], post(api("integration-types"), def, create)),
  removeIntegrationType: (id: string) => run(["integrationTypes", "integrationInstances"], del(api(`integration-types/${enc(id)}`))),
  addIntegration: (o: Obj) => run(["integrationInstances"], post(api("integrations"), o, create)),
  updateIntegration: (id: string, patchBody: Obj, v?: Versioned) => run(["integrationInstances"], patch(api(`integrations/${enc(id)}`), patchBody, opts(v))),
  removeIntegration: (id: string) => run(["integrationInstances"], del(api(`integrations/${enc(id)}`))),
  testIntegrationInstance: (id: string) => run(["integrationInstances"], post(api(`integrations/${enc(id)}/test`))),
  /** The Add dialog's connection test: settings that are not saved yet. Nothing is stored; the result's `test` has the lines. */
  testIntegrationDraft: (type: string, body: Obj) => post(api(`integration-types/${enc(type)}/test`), body),
  /** The recorded link step (spec 12.3): a one-time code the person sends from the chat app. */
  requestChatLink: (channel = "slack", integration?: string) => run(["chatLinks"], post(api("chat-links"), { channel, ...(integration ? { integration } : {}) }, create)),
  removeChatLink: (id: string) => run(["chatLinks"], del(api(`chat-links/${enc(id)}`))),
  /** Channel-level connection settings (slack, email, ...). */
  setIntegration: (channel: string, patchBody: Obj) => run(["integrations", "integrationInstances"], patch(api(`integrations/${enc(channel)}`), patchBody)),
  testIntegration: (channel: string) => run(["integrations", "integrationInstances"], post(api(`integrations/${enc(channel)}/test`))),
  /** routeId null creates a route. */
  saveRoute: (projectId: string, routeId: string | null, route: Obj, v?: Versioned) =>
    run(["notifications", "projects"], routeId ? patch(api(`projects/${enc(projectId)}/routes/${enc(routeId)}`), route, opts(v)) : post(api(`projects/${enc(projectId)}/routes`), route, create)),
  deleteRoute: (projectId: string, routeId: string, v?: Versioned) => run(["notifications", "projects"], del(api(`projects/${enc(projectId)}/routes/${enc(routeId)}`), undefined, opts(v))),
  /** `dest` is a channel with `target`, or a destination object `{ channel, target, integration }` with the event as the second argument (legacy sendTest). */
  sendTest: (projectId: string, dest: string | Obj, target: string, event?: string) =>
    run(["deliveries"], post(api(`projects/${enc(projectId)}/routes/test`), typeof dest === "object" ? { dest, event: event ?? target } : { dest, target, event })),
  retryDelivery: (deliveryId: string) => run(["deliveries"], post(api(`deliveries/${enc(deliveryId)}/retry`))),
  saveCardTemplate: (tpl: Obj) => run(["cardTemplates"], post(api("card-templates"), tpl)),
  removeCardTemplate: (id: string, project?: string | null) => run(["cardTemplates"], del(api(`card-templates/${enc(id)}${project ? `?project=${enc(project)}` : ""}`))),
  /** Renders a card without saving it: a POST that changes nothing. */
  previewCardTemplate: (tpl: Obj) => post(api("card-templates/preview"), tpl),
  /** The edge connects to the server and lists its tools (spec 12.4). Saves nothing; the result carries `tools`. */
  discoverTools: (o: Obj) => post(api("mcp/discover"), o),
  addMCP: (o: Obj) => run(["mcp"], post(api("mcp/servers"), o, create)),
  updateMCP: (id: string, patchBody: Obj, v?: Versioned) => run(["mcp"], patch(api(`mcp/servers/${enc(id)}`), patchBody, opts(v))),
  removeMCP: (id: string, v?: Versioned) => run(["mcp"], del(api(`mcp/servers/${enc(id)}`), undefined, opts(v))),
  /** Connects again and compares the tool definitions; a changed one disables the server until it is re-approved. */
  rediscoverMCP: (id: string, v?: Versioned) => run(["mcp"], post(api(`mcp/servers/${enc(id)}/discover`), {}, opts(v))),
  /** Accepts the changed tool definitions the server now reports and switches it back on. */
  approveMCP: (id: string, v?: Versioned) => run(["mcp"], post(api(`mcp/servers/${enc(id)}/approve`), {}, opts(v))),
  /** Pre-authorises write tools (`server/tool`) for the work order's live attempt. */
  grantMcpWrites: (wo: string, tools: string[]) => run(["mcp"], post(api("mcp/grants"), { wo, tools }, create)),
  /** The secret is in the result's extras, once. */
  createKey: (o: Obj) => run(["apiKeys"], post(api("api-keys"), o, create)),
  revokeKey: (keyId: string) => run(["apiKeys"], del(api(`api-keys/${enc(keyId)}`))),
  setApiConfig: (patchBody: Obj, v?: Versioned) => run(["apiConfig"], patch(api("api-config"), patchBody, opts(v))),
  /** Public API try-it: submits with the key the person pastes, as an external client would. */
  apiSubmit: (apiKeySecret: string, projectId: string, body: Obj) =>
    run(["workOrders", "requestLog"], command(api(`projects/${enc(projectId)}/work-orders`), { method: "POST", body, idempotent: true, headers: { Authorization: `Bearer ${apiKeySecret}` } })),
  /** triggerId null creates a trigger. */
  saveTrigger: (triggerId: string | null, patchBody: Obj, v?: Versioned) =>
    run(["triggers"], triggerId ? patch(api(`triggers/${enc(triggerId)}`), patchBody, opts(v)) : post(api("triggers"), patchBody, create)),
  /** "Simulate incoming": evaluates the trigger against a sample event and changes nothing, unless `create: true` asks for the work to be made for real. */
  simulateTrigger: (triggerId: string, input: Obj) => run(input.create === true ? ["triggers", "workOrders"] : [], post(api(`triggers/${enc(triggerId)}/dry-run`), input, input.create === true ? create : {})),
  /** A person who may submit to the project releases or declines a work order a trigger held (spec 11.7). */
  releaseProposal: (proposalId: string, note?: string) => run(["triggers", "workOrders"], post(api(`trigger-proposals/${enc(proposalId)}/release`), { note: note ?? "" })),
  declineProposal: (proposalId: string, reason: string) => run(["triggers"], post(api(`trigger-proposals/${enc(proposalId)}/decline`), { reason })),

  /* ===== people, access ===== */
  invite: (o: Obj) => run(["people"], post(api("invites"), o, create)),
  acceptInvite: (personId: string) => run(["people", "me"], post(api(`invites/${enc(personId)}/accept`))),
  /** A factory role reaches every project: the server wants a reason (recorded on the ledger) and a fresh sign-in. */
  setFactoryRole: (personId: string, roleId: string, add: boolean, reason: string) =>
    run(["people", "me"], (add ? put : del)(api(`people/${enc(personId)}/factory-roles/${enc(roleId)}`), { reason })),
  /** Removes a person's access (spec 14.4): sessions end, their keys are revoked unless `keepKeys`, and the response lists the work they leave open. Needs a fresh sign-in and the person's version (If-Match). */
  deactivatePerson: (personId: string, reason: string, keepKeys?: boolean, v?: Versioned) =>
    run<{ openWork?: OpenWorkItem[] }>(
      ["people", "me", "sessions", "apiKeys", "projects", "workOrders", "trust", "matrix"],
      post(api(`people/${enc(personId)}/deactivate`), { reason, ...(keepKeys ? { keepKeys: true } : {}) }, opts(v)),
    ),
  reactivatePerson: (personId: string, reason: string, v?: Versioned) =>
    run(["people", "me", "matrix"], post(api(`people/${enc(personId)}/reactivate`), { reason }, opts(v))),
  setTeams: (personId: string, teams: string[]) => run(["people"], put(api(`people/${enc(personId)}/teams`), { teams })),
  createTeam: (o: { name: string; desc?: string; id?: string }) => run(["teams", "people"], post(api("teams"), o, create)),
  updateTeam: (teamId: string, o: { name?: string; desc?: string }) => run(["teams", "people", "projects"], patch(api(`teams/${enc(teamId)}`), o)),
  deleteTeam: (teamId: string) => run(["teams", "people"], del(api(`teams/${enc(teamId)}`))),
  /** Team role grants (spec 8.9): members inherit them. `scope` is "factory" or a project id. */
  addTeamRole: (teamId: string, g: { role: string; scope: string; expiresAt?: number | null; reason?: string }) => run(["teams", "people", "me", "matrix"], post(api(`teams/${enc(teamId)}/roles`), g)),
  removeTeamRole: (teamId: string, grantId: string, reason?: string) => run(["teams", "people", "me", "matrix"], del(api(`teams/${enc(teamId)}/roles/${enc(grantId)}`), reason ? { reason } : undefined)),
  setMatrix: (roleId: string, actionId: string, on: boolean, v?: Versioned) =>
    run(["matrix"], put(api(`access/matrix/${enc(roleId)}/${enc(actionId)}`), { on }, opts(v))),
  addRole: (def: Obj) => run(["matrix"], post(api("roles"), def, create)),
  updateRole: (roleId: string, patchBody: Obj, v?: Versioned) => run(["matrix"], patch(api(`roles/${enc(roleId)}`), patchBody, opts(v))),
  removeRole: (roleId: string, v?: Versioned) => run(["matrix"], del(api(`roles/${enc(roleId)}`), undefined, opts(v))),
  /** policyId null creates a policy. */
  savePolicy: (policyId: string | null, data: Obj, v?: Versioned) =>
    run(["policies"], policyId ? patch(api(`policies/${enc(policyId)}`), data, opts(v)) : post(api("policies"), data, create)),
  setPolicyEnabled: (policyId: string, on: boolean, v?: Versioned) => run(["policies"], patch(api(`policies/${enc(policyId)}`), { enabled: on }, opts(v))),
  deletePolicy: (policyId: string, v?: Versioned) => run(["policies"], del(api(`policies/${enc(policyId)}`), undefined, opts(v))),
  saveFreeze: (f: Obj) => run(["freezes"], post(api("freezes"), f, create)),
  endFreeze: (freezeId: string, v?: Versioned) => run(["freezes"], post(api(`freezes/${enc(freezeId)}/end`), undefined, opts(v))),
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
