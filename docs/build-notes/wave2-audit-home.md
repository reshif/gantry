# Wave 2: audit-home

## Summary
Audit, activity and the home read side are built and verified against a real Postgres and the real API. The API adds 7 read endpoints (GET only, so no command endpoints and no stale-version cases to test), and the web Audit and Home screens are ported. There was no partial work from the interrupted attempt in my files; the route stubs were empty, so I built from scratch. All reads come from the events table and live DB rows. Without GANTRY_DEV_SEED the org returns empty lists and zero figures (tested with a seed-less org). Full API suite 163/163 and web suite 98/98 pass, and both typechecks are clean.

## Public interface
All endpoints below are GET and need a signed-in principal.

- **GET /api/v1/audit**
  - Query filters: `category`, `topic` (trust, learning, catalogue, record), `project` (an id, or `factory` for factory-wide), `actor` (a person id, or `human`, `agent` or `system`), `outcome`, `channel`, `q`, `changes=true`, `cursor` (a seq), `limit` (1 to 200, default 60).
  - Returns `{items, next, total, summary}`, newest first. Each item is `{id, seq, at, actor, actorKind, actorName, action, target, where, project, category, outcome, via, channel, before, after, entity, digest, prev}`.
  - `summary` is `{entries, denied, changes, head, categories, topics, facets:{outcomes, channels, actors}}`.
  - Visibility: a caller with `audit.view` (Auditor, Factory Admin, or an API key scoped to it) sees everything. A person without it sees entries for the projects they can see plus their own actions. An API key without the scope gets a 403, and the denial is audited.
- **GET /api/v1/audit/{seq}**
  - Returns the entry plus `rule`, `onBehalfOf`, `topic`, `session`, `request`, `sourceIp`, `diff` and `history` (up to 12 other entries for the same entity).
  - `diff` is `[{field, before, after, changed}]` when both sides are JSON objects, otherwise null.
  - An entry outside the viewer's visibility returns 404.
- **GET /api/v1/audit/verify**
  - Auditor and Factory Admin only. Returns `{ok, checked, headSeq, head, msg}`, or `{ok:false, broken:{kind,seq}, msg}` on a break. Anyone else gets a 403 with rule `AUDIT-VERIFY`, audited as `audit.view.denied`.
- **GET /api/v1/activity?project=&limit=**
  - Returns `{items, next}` of audit-shaped entries, default 14, scoped like the audit endpoint.
- **GET /api/v1/projects/{id}/events?from=&to=&kinds=&limit=**
  - Returns a plain array in the floor-replay shape `{id, at, type, project, wo, by, repo?, station?, gate?, bay?, scope?, mode?, trust?, from?, to?, cell?, text?}`, oldest first, denials excluded.
  - Payload fields are read from the event's `subject`, then from `after` when that is an object. 404 if the viewer cannot see the project.
- **GET /api/v1/home**
  - Always returns `mode` ("factory" or "mine"), `approvals`, `conversations`, `mine`, `badges` and `projectBadges` (keyed by project id).
  - `approvals` are `{wo, title, gate, gateLabel, gateName, project, projectName, have, need, waitMs}` or `{repo, repoName, pr, project, projectName}`.
  - `conversations` are `{wo, title, project, question}`.
  - `mine` is `{workOrders, projects, factoryRole}`.
  - Callers with a factory-wide role also get `figures`, `attention`, `control`, `human`, `onboarding`, `spend` and `factory`.
  - `attention` items are `{id, sev, icon, title, where, sub, act:{label, route, project?, wo?}}`, sorted critical first.
- **Server helpers**
  - `visibilityFor(req)` and `requireVerifier(req)` in `areas/audit/access.ts`.
  - `listAudit`, `latestAudit`, `getAudit`, `projectEvents` in `areas/audit/read.ts`.
  - `computeHome` and `loadHomeState` in `areas/home`.
  - `seedDemoAudit(pool, orgId, seed)` in `areas/audit/seed.ts`.
- **Web**: `views/audit.tsx` and `views/home.tsx` are default-exported route views.

## Integration notes
["Dev seed audit: legacy audit history (52 entries) is now appended to the real hash chain on first dev-seed start, through `seedDemoAudit` called from bootstrapOrg. This is the only way the audit screen has demo content. It is skipped when `seedAudit:false` is passed. I changed `startApp` in test/helpers.ts so tests default to `seedAudit:false` (otherwise the other areas' tests that count events by type, such as policy.edit and freeze.create, start non-empty). audit-home.test.ts passes `seedAudit: true`. Legacy outcome 'blocked' is stored as 'denied' because the events table has no 'blocked' value.", "The work-order area should replace `loadHomeWorkOrders` (areas/home/state.ts) with its own loader once it exists (the same `{workOrders}` option `loadFlowState` already accepts), then `gateDecision` and `gateProgress` run on full records. `HomeWorkOrder` only adds `waitingSince`.", "Event types the wave-3 flow engine must write for the floor replay and Home figures to match the legacy names: wo.submit, wo.enter, gate.decision, trust.auto, release, kill, restore, trust.change, halt, resume, wo.state and wo.bay. Their payload fields (station, gate, bay, mode, trust, from, to, cell, text, repo, scope) go in the event's `subject` or object `after`. `by` is the event actor, `wo` is wo_id.", "`GET /home` carries nav badges in two parts. Global ones are in `badges`, and the floor/work-orders/onboarding ones are in `projectBadges[projectId]`. I changed `useNavBadges` in apps/web/src/api/queries.ts to merge `projectBadges[prefs.project]` into the nav, and `audit` now invalidates `activity` in keys.ts (DEPENDENTS). `useNavBadges` now imports `usePrefs`.", "`/api/v1/activity` returns `{items,next}` of audit-shaped entries (not the legacy event type that the `useActivity` hook is typed with). The home view casts it. If someone else needs the project-events replay they use `useProjectEvents`.", "Audit visibility follows the legacy `visibleProjects` rule for people without `audit.view`. A person who cannot see the #audit route (such as a plain engineer) never reaches it in the nav, but the API still answers them with their own entries.", "Actor-id convention the audit and home screens rely on: person ids, agent ids, `apikey:<id>` and 'system'. `actorKind` is derived from joining people and agents, so anything else is 'system'. The audit ledger shows names for ids the people and agents lists do not know via the resolved `actorName`.", "The attention buttons (`act.route`) map to web routes: floor, project-config, onboarding, traveler (opens the drawer with the work order id), evals, models, integrations, and `home` with tab 'control' (scrolls to the factory control panel)."]

## Unverified
- Playwright comparison details: the legacy screen could not be driven to its audit detail drawer in my harness, so I compared my drawer against the legacy markup rather than a legacy screenshot. Legacy My work was captured for Meera only; the legacy sample data differs from the real DB (legacy has 35 work orders, the real DB has none until wave 3), so figures and attention lists differ by design.
- Home: work-order-dependent sections (WIP, gates, SLA, blocked, shipped, my approvals) are exercised only with rows I inserted by hand into work_orders, gate_instances and gate_votes. The wave-3 work-order loader and writers have never run against this code. The gate and conversation loader assumes `work_orders.data` may carry legacy fields (blockReason, failReason, bayReason, paths, history, conv.raised).
- Home: 'Agent success' is always '–' (no scorecards yet), and median response time and workload per person are omitted because no workload endpoint exists. Vendor spend uses vendors.monthly_budget_micros and usage_meter, and the attention items for evals, vendors and integrations read suites/eval_runs/integration_instances.health with assumed column meanings (suite threshold in suites.data.threshold, health 'failing' or 'offline'); none were exercised with data. Trust and learning proposals count rows with status 'open'.
- The home 'Approve' button calls ops.approveGate (POST /gate-instances/{woId:gateId}/approve), which belongs to the work-order area and is not built yet; it is mocked in the web test only. 'New work order' appears only once a screen registers the newWorkOrder command.
- Screens that other areas own were 404 during the real run: GET /api/v1/agents, so actor avatars show '?' for agents. I did not touch them.
- Project config cannot deep-link to its budget tab, so the budget attention button opens the Project config screen without selecting the tab.
