# Wave 1: domain

## Summary
Built @gantry/domain: a pure, browser-safe TypeScript package (no Node-only APIs). It ports the legacy permission engine, flow rules, intake, trust, workload, replay and the dev seed. 79 vitest tests pass, tsc --noEmit is clean, and dist/ is built. The fidelity tests run the unmodified legacy JS (legacy/js, in a stubbed window with a fixed clock) next to the TS code over the same seed and require identical output. can() is compared across about 38,000 person, action, project and time combinations, and gateDecision across about 8,000 work order, gate and person combinations. moveCheck, route, routeGates, flowOf, classify, buildWorkOrder, answerConversation, slotsUsed, submitGuard, summaryText, completeness, the trust functions and the workload functions are compared the same way, with no differences. Added beyond the legacy behaviour: the stop-state check in can(), the I4/I6/I7/I8/I9 invariants (invariants.ts) and risk-tag rules, strict trust-evidence counting and demotion, and queueOrder by priority then age.

## Public interface
All exports come from `@gantry/domain` (src/index.ts). Every function is pure and takes state and `now` explicitly.

RESULT AND ERRORS (result.ts)
- Result<T,E>, ok(v), err(e).
- GantryError is a union of kind 'denied'|'conflict'|'stale'|'stopped'|'invalid'|'not_found', each with msg, rule?, needs?.
- gantryError(kind, msg, {rule?, needs?}), httpStatusFor(kind) (403, 404, 409, 422), refusalBody(e), which returns `{ok:false,msg,rule?,needs?}`.

TYPES (types.ts)
- GantryState is the whole legacy G.store tree, with the legacy field names. Slice types: Person, Team, Project, Repo, WorkOrder (with gates, bay, history, conv, brief and the lifecycle fields), Agent, Skill, Vendor/Model, Routing, Suite, EvalRun, Trust, Learning, IntegrationType/Instance, Delivery, McpServer, ApiKey, Trigger, Policy, Freeze, Matrix, Session, SecuritySettings, AuditEntry, EventEntry, Template, Prefs and others.
- Catalog = {stations, gates, bays, classes, roles, actions}. Decision = {allowed, reason, rule:{kind,id,name?,freeze?}, needs}. DevSeed = {state, catalog, integrationCategories, notifyEvents}.
- WorkOrder.station is a numeric index into catalog.stations, as in legacy.

CATALOG (catalog.ts)
- Constants: STATIONS, GATES, BAYS, CLASSES, ROLES, ACTIONS (52), DEFAULT_CATALOG (built-ins only), WO_STATES, ONBOARD_STAGES, TEMPLATES_SEED, INTEGRATION_TYPES (13 built-in), INTEGRATION_CATEGORIES, NOTIFY_EVENTS, CARD_TEMPLATES, CARD_ACTIONS, CARD_DEFAULTS, TRUST_LEVELS, AUDIT_CATEGORIES, AUDIT_CATEGORY_BY_PREFIX, RISK_TAG_RULES.
- Functions: auditCategoryFor(action), defaultMatrix(actions?), findStation/findRole/findAction/findClass(catalog,id).

POLICY (policy.ts)
- `PolicyState` = {people, matrix, policies, freezes, projects:[id,name,status,killed?,halted?,regulated?], repos:[id,name,project,halted?], stops?:{factory:KillInfo|null}, catalog?:{roles,actions}}.
- `can(state, personId, action, {project?, repo?, time?, wo?}) => Decision`. The reason, rule and needs text is identical to G.can.
- canMany(state, personId, checks[], now), the batch form for POST /can. canAnyProject(state, personId, action, now).
- simulate(state, {person, action, project?, repo?, time}, now) => {decision, trace[], week[7]:{day0, dow, label, cells[24]:{hour, allowed, rule, selected}}}.
- policyTrace(state, person, action, ctx), policyText.{days, when, where, roles, sentence}.
- Stop state: effectiveStop(state, {project?, repo?, wo?}) returns the most severe of factory, project, repo and work order, with ties going to the outermost scope. Also stopState (kill or archive only), haltState, stopBlocks.
- Lookups: rolesIn, isFactoryAdmin, visibleProjects, activeFreeze, findPerson/Project/Repo, actorName, agentAutonomyCheck (POL-112).

INVARIANTS (invariants.ts; all return Result<true,GantryError>)
- checkRoleChange(people, {actorId, targetId, nextRoles}), checkPersonRemoval, checkRoleDelete, checkFlowEntryRemoval.
- checkMatrixEdit(matrix, people, {role, action, value}) enforces I8/I9 and the Factory Admin rights; lockedOutRights(matrix, people).
- checkAgentAuthority(kind, action) enforces I6; hasIndependentApprover(requestedBy, approvers) enforces I4.
- Also: needsStepUp, factoryAdmins, and the constants PROTECTED_RIGHTS, AGENT_FORBIDDEN_ACTIONS, STEP_UP_ACTIONS.

FLOW (flow.ts)
- `FlowState` = PolicyState plus full projects, repos, workOrders and a full catalog.
- Flow definition: flowOf(catalog, project), route(catalog, project, cls), routeGates, nextStationId, gateForWO, gateKind, classOf, classesOf, stationIndex, stationDef, stationOf, gateAfter, gateDef, bayDef.
- Intake: classify(catalog, text, requestedCls, project), intakeMisses, convQuestions, startConversation, answerConversation (immutable, returns {conv, brief, outcome}), buildBrief, buildWorkOrder(catalog, project, input with caller-supplied id and createdAt).
- Gates: gateProgress(project, wo, gateId, people) => {have, need, unmet, conds, onlyRequester, passes}; conditionsFor; gateDecision(state, personId, wo, gateId, now).
- Risk tags: riskTagsFor(paths), riskTagsOf(wo), forcesHuman(wo).
- Slots and queue: slotsUsed(workOrders, projectId), freeSlot(workOrders, project), queueOrder(wos), queuedFor(workOrders, projectId).
- submitGuard(state, projectId, repoId) returns a string or null. moveCheck(state, principalId, wo, target, now) => {allowed, reason, kind?}.

LIFECYCLE (lifecycle.ts)
- topic, criteriaFor, requestOf, confirmedBriefVersion, completeness, summaryText(ctx, wo), sourceLabel, woTotals.

INSIGHT (insight.ts)
- `InsightState` = FlowState plus teams, agents, scorecards, trust, events.
- trust.{level, cell, ceiling, levelFor, decide(state, wo, gateId, {riskTags?}), evidence(state, cell, {strict?, now?, soakDays?}), meets, demotion, projection, coverage}.
- trustAgentFor, trustCellId, hash.
- workload.{acts, people, teams, minutesBy, bottlenecks, suggestions}, workloadSummary(state, {ids, days}, now), inHours.
- learningSignals(state).
- Replay: trackStates(prevTrack, workOrders, catalog) => {track, events}; stateAt(state, t, projectId?); replay.{events, journey, range, MARK_TYPES}.

FORMAT (format.ts)
- fmt.{money, money0, num, k, pct, dur, ago(t, now), ist, istDate, stamp, iso}, istTime(date, time), istToday(now, offset), ist(t), hm(s), DAYS, MIN, HOUR, DAY.

SEED (seed.ts)
- devSeed(now = Date.now()) => DevSeed: a fresh independent copy of the legacy seed (20 people, 12 projects, 23 repos, 77 work orders, 940 events and so on), with relative timestamps shifted to `now`.
- SEED_ANCHOR, the fixed instant the seed was frozen at.

## Integration notes
["Build the state for the engine from API reads like this: `{ ...slicesFromApi, catalog, stops: { factory: factory.killed } }`. `catalog` (stations, gates, bays, classes, roles, actions) must include custom entries. In the dev seed, devSeed().catalog has 10 stations, 9 gates, 6 bays, 10 classes and 10 roles; the custom ones are compliance, GC, legal, model-change and compliance_officer. The API should expose the catalog as data (for example GET /api/v1/catalog) or the web app will not know about custom stations. WorkOrder.station is an index into catalog.stations, so catalog order must be stable.", "`can()` defaults `ctx.time` to Date.now(). The API should pass `time` explicitly (the decision point and POST /can already take it). gateDecision, moveCheck and the insight functions take `now` as a required argument.", "Delegation reads person.away.delegate and the away window. On-call reads person.oncall. There is no separate delegations input.", "gateDecision lets a requester vote when separation of duties is off. To enforce I4 the command pipeline must close the gate with `gateProgress(...).passes` (it includes `onlyRequester`), not by counting approvals itself.", "The legacy queue was ordered by bayAt only; queueOrder implements the spec's priority-then-age rule, and legacy queue order will differ from it.", "For work order ids, pass the id you allocated to buildWorkOrder (it does not bump nextWO), and pass `createdAt` too. buildWorkOrder and answerConversation return new objects and never mutate their inputs.", "Trust: `trust.decide(state, wo, gateId, { riskTags: riskTagsOf(wo) })` is the spec-conformant call (any risk tag forces a human). Calling it without opts reproduces the legacy decision. `trust.evidence(..., { strict: true, now })` applies the spec 13.3 counting rules; the default is legacy counting.", "seed.data.ts is generated: run `node packages/domain/scripts/gen-seed.mjs` to regenerate it from legacy/js. devSeed() parses the JSON on each call and shifts epoch-ms numbers within 400 days before and 30 days after the anchor. Fixed far-future dates (the FRZ-08 year-end freeze) are not shifted. The seed includes demo-only runtime-ish slices (mcpUsage, requestLog, signins, deliveries, evalRuns, events), which are demo data only and must never be used for a real org.", "Types `Project` carries an index signature `[extra: string]: unknown` so unknown legacy fields pass through. Prefer the named fields.", "package.json is unchanged (zod is still declared but not used by this package). tsconfig.json now excludes src/testkit.ts from the build."]

## Unverified
- Browser/Vite consumption of dist and of the 1.7 MB seed string was not exercised; only Node ESM was
- The stop-state check inside can() (kill and halt refuse Work, Gates and Onboarding actions; stop controls and reads stay allowed), the I4 requirement that a gate cannot pass on the requester's approval alone (gateProgress.passes), and the spec-13.3 strict trust counting are my reading of spec 9.7, 5.1 and 13.3. They are not in legacy. The seed has no kills or halts, so the equivalence runs do not cover them; behaviour.test.ts covers them with hand-built states
- A project with status 'archived' does not block can(), matching legacy. Archiving is refused only by submitGuard/moveCheck (and stopState) as in legacy
- Legacy G.ops mutation logic, the lifecycle record generator (G.lc.ensure/sync), seedWorkOrders/seedEvals and the sim tick are deliberately not ported, since they are simulation. Only the pure reads of the lifecycle record are ported
- Replay (stateAt) is tested for shape and counts only, not compared against legacy G.stateAt
- No Docker containers were created or used (w1dom- prefix unused)
