# Wave 2: core

## Summary
The gantry-api core is built. Real sign-in through Keycloak to the React shell works, and area engineers can add endpoints by writing one route module each. Typecheck is clean and 55 api tests pass against a real Postgres 17, alongside the 52 existing db tests. The full stack (api, web, migrate, postgres, keycloak, caddy, mailpit) came up under compose project w2core, with only MinIO stubbed. Playwright signed in as Asha via Keycloak and landed on the shell: /api/v1/me returned 12 projects, the factory_admin role and a CSRF token, and the nav listed every section. Tomas (engineer on payments) got only his project and a trimmed nav, and GET /security returned 403 for him. Step-up through Keycloak refreshed the same session, after which PATCH /security succeeded. Logout then made /me return 401. The stack is torn down (down -v), and w2core-pg is removed.

## Public interface
Package export @gantry/api/core (services/api/src/core/index.ts). Route convention: services/api/src/routes/<area>.ts exports a FastifyPluginAsync (named <area>Routes, e.g. projectRoutes, workOrderRoutes, stopRoutes), registered in routes/index.ts. Handlers register full paths, e.g. app.get('/api/v1/home', ...), and use req.server.gantry for pool/config/orgId/hub.

Command pipeline: command(req, spec, async (tx, actor) => result). spec = { action: string|null, scope?: {project?,repo?,wo?,time?}, ifMatch?: (tx)=>Promise<number|null>, idempotent?: boolean, stepUp?: seconds, service?: boolean, reduced?: boolean }. action null means the caller changes only their own data, so no catalogue right is checked. service:true is for /internal/v1 handlers authenticated by service token. The body returns { msg, events: EventSpec[], extra?, jobs?, outbox?: [{event?,destination,payload?}], changes?: string[] (legacy slice names for SSE), project?: string|null }. The pipeline returns the { ok, msg, ...extra } body and sets the status. Refusals: throw refuse(kind,msg,{rule?,needs?}), notFound(), invalid(), conflict() or stale(). stopCommand(req, spec, fn) is the reduced path for spec 8.5 (jobs and outbox are refused). Actor = { orgId, id, kind, personId, name, channel, via, sessionId, ip, requestId, decision, ifMatch, idempotencyKey, now }.

Decision point: decide(req, action, {project,repo,wo,time}, db?) returns Decision. decideFor(state, principal, action, scope) and policyState(req, db?) cache per request. requireStepUp(req, maxAgeSec=300) throws a 403 with needs:'step_up'. refuseDecision(d) maps a Decision to a 409 (stop) or 403 refusal.

State loaders: loadPolicyState(db, orgId) and loadFlowState(db, orgId, {workOrders?: loader}). The work-order area supplies its own loader for work_orders rows; the default is none.

Read mappers (read/index.ts): readOrg, readPeople, readTeams, readProjects, readRepos, readTemplates, readMatrix, readRoles, readPolicies, readFreezes, readSecurity, readCatalog, readActiveStops. DEFAULT_SECURITY and reads(db, thunks) live in the same module.

Changes: publishChange(tx, {org, keys, project?}) runs pg_notify on 'gantry_changes' inside the transaction, so it only fires on commit. The worker and other replicas use the same call. parseChange, Hub and openStream are exported too.

Auth helpers: generateApiKey() returns {key, prefix, hash}, hashApiKey, csrfFor(sessionKey, sessionId), listSessions, SecurityCache, ipAllowed, emailDomainAllowed. Principal = person | apikey | service.

buildApp({pool, config, orgId, oidc?, routes?, heartbeatMs?, sweepMs?, rateLimitMax?, logger?}), bootstrapOrg(pool, config, log?, {seedNow?}), loadConfig().

Endpoints implemented: GET /auth/login, GET /auth/callback, POST /auth/logout, GET /healthz, GET /api/v1/me, GET /api/v1/sessions, DELETE /api/v1/sessions/{id}, GET /api/v1/signins, GET and PATCH /api/v1/security, POST /api/v1/can, GET /api/v1/stream, GET /api/v1/catalog.

Wire shapes: GET /api/v1/signins returns {items, next}, which the web hook already accepts. GET /security returns the settings plus a `version` field. PATCH /security takes {path, value} with If-Match.

## Integration notes
1. Org identity: GANTRY_ORG_ID is the org slug ('acme'); the uuid is resolved by bootstrapOrg and exposed as req.gx.orgId and app.gantry.orgId. The worker should call bootstrapOrg or look up orgs by slug, then use the core helpers with the same orgId.

2. Dev seed behaviour: GANTRY_DEV_SEED=true loads devSeed() only if the org does not exist yet, so it is a first-start action; an org first created without the flag is never seeded. The seed's demo IP allow-list (10.0.0.0/8, 203.0.113.0/24) is dropped on load, because it would lock out every real browser address. Seed halts and kills become active rows in `stops`.

3. Single source of stop state: the `stops` table (active = lifted_at is null). projects.halted, projects.killed, repos.halted and orgs.factory_stop are no longer written or read; readProjects and readRepos derive halted and killed from stops, and loadPolicyState derives the factory kill. The stop-area engineer should insert into `stops` (partial unique index: one active stop per scope and mode) and use stopCommand(). Stop ids in this code use `${scope}:${target}:${n}`; the web's DELETE /stops/{scope:target} convention needs the stop route to resolve the active stop by scope and target.

4. Seeded storage conventions the area engineers must keep: orgs.settings.catalog holds the ordered stations, gates, bays, classes and actions (built-in plus custom; WorkOrder.station indexes into it, so only append). Roles come from the roles table (builtin=false means custom). people.data, repos.data, teams.data and templates.body hold legacy fields that have no column and are spread first. projects.config = {mcp, mtd, extra: {...other legacy fields}}; flow comes from flow_versions at current_flow_version, approvers from approver_rule_versions at current_version, notifications from notification_routes with id prefix `${projectId}:`, budget from budgets (mtd stays in config until usage metering exists). Repo onboarding stage and readyAt are columns and override data.onboarding. Policies hold the full legacy body in policy_versions.body at current_version. Freezes use data.repos and created_by, and a lifted_at caps `to`.

5. Migration 0011_api_core.sql: sessions gets auth_time, method and acr; created_at defaults become clock_timestamp() on several tables so rows inserted in one transaction keep their order; projects.position orders seeded projects (nulls last, then created_at); the notification_routes, project_teams and team_members defaults changed the same way. seedDevOrg was extended with data and extra round-tripping, stops rows, factory kill, org catalog and project position.

6. Sessions: the cookie is __Host-gantry_session over https (gantry_session over http) and holds an opaque token. The DB stores an HMAC of it keyed by session_key. CSRF is HMAC(session_key, 'csrf:'+sessionId), returned in /me, sent as X-CSRF-Token, and an Origin header, when present, must equal GANTRY_PUBLIC_URL. The OIDC login state travels in a sealed (AES-GCM, key derived from session_key) HttpOnly cookie `gantry_oidc` scoped to /auth, so there is no server-side pending-auth table and any replica can finish a login. Auth errors are redirected to /?auth_error=<human sentence>, which the sign-in screen shows verbatim.

7. Step-up: GET /auth/login?step_up=1 sends prompt=login. If the browser holds a session of the same person, the callback refreshes that session's auth_time rather than creating a new one. Keycloak with prompt=login shows only the password field. Use command spec stepUp (seconds) or requireStepUp(req, sec); the 403 body has needs:'step_up'. The web should send people to /auth/login?step_up=1&return_to=<path> when it sees needs:'step_up'; the current client does not handle that yet.

8. Idempotency: only when spec.idempotent is set and an Idempotency-Key header is present (a missing header proceeds unkeyed). Scope = principal + method + route pattern, body hash covers body and params. A denial rolls the key back. Only denials (403 and the 409 stop refusals) are audited; stale-version, validation and conflict refusals are not.

9. Events written by the core: auth.signin (outcome ok or denied), auth.signin_failed, auth.stepup, auth.signout, session.revoked, security.saved, people.provisioned, people.role_granted (bootstrap admin), and `<action>.denied` from the pipeline. SSE keys published: signins, sessions, people (on provisioning), security, and `audit` on every command. Route modules must pass legacy store slice names in `changes`. A key named people, projects, matrix, roles, session, sessions, factory or * makes the hub recompute each subscriber's visible projects.

10. Internal routes: any /internal/v1/* request is authenticated by the edge_token or github_token in the onRequest hook (principal.kind 'service', id edge|github). Use command(req, {action: null, service: true}, ...) for writes there. A service principal is refused on /api/v1, and browsers or API keys on /internal.

11. Not mine and left for others: GET /api/v1/home, /policies, /freezes, /people, /agents and the other area reads still 404 (the web's queries fire them). The worker entry (src/worker-main.ts) was left alone as instructed. The Dockerfile builds the api image, and the worker image can reuse the tree and import @gantry/api/core.

12. Deploy: compose.yml now passes GANTRY_DEV_SEED (default false), GANTRY_BOOTSTRAP_ADMIN_EMAIL, GANTRY_ORG_NAME and OIDC_GITHUB_IDP_ALIAS to the api; the default of GANTRY_DEV_SEED=false makes a plain `up` an empty org. To reproduce the demo: `GANTRY_DEV_SEED=true GANTRY_SECRETS_DIR=... KEYCLOAK_IMAGE=mirror.gcr.io/keycloak/keycloak:26.4 docker compose -p w2core -f deploy/compose.yml -f <minio stub override> up -d ingress`. The api Dockerfile built behind the proxy with the cacert secret and `npm ci --ignore-scripts`; the lockfile gained only @types/pg under the api workspace.

13. Logging: Fastify pino logs request lines at info (healthz at warn). Authorization, cookie and set-cookie are redacted. Request ids come from a valid incoming x-request-id or a UUID, are echoed in the response and stored as events.request_id and command_id.

## Unverified
- MinIO, edge, github, worker and launcher were not part of the bring-up. minio was replaced by a no-op healthy busybox via a scratch override (/tmp/claude-0/w2core-override.yml); nothing in the api core uses object storage yet, and the S3 bucket creation noted in the platform notes is not implemented
- The empty-org bootstrap path (GANTRY_DEV_SEED unset, GANTRY_BOOTSTRAP_ADMIN_EMAIL) is covered with the mocked issuer and a real DB, not with real Keycloak. The Keycloak realm has no user for an arbitrary bootstrap email
- GitHub sign-in with a real Keycloak GitHub identity provider (kc_idp_hint) was not run; only URL construction and the refusal paths are tested
- Multi-replica NOTIFY fan-out was tested with a second connection publishing, not with two api processes
- Load and performance (policy-state loads per request, SSE with many subscribers) were not measured. loadPolicyState is a handful of queries per request, cached only within a request
- trustProxy defaults to true because the api is reachable only through Caddy. Direct exposure of the api port would let a client spoof X-Forwarded-For and so the IP allow-list. Set GANTRY_TRUST_PROXY=false otherwise
- Idle timeout counts requests as activity, not the open stream, and an open stream is closed by a 60 s sweep when the session is idle, expired or revoked. The sweep and the idle check are tested, but there was no long-duration run
- Cross-browser behaviour was not tested (chrome only). The web client was not changed, and the screens other than shell, nav, me, can and stream still 404 on their reads until the area engineers fill in their route modules
- No domain envelope types (Me, CanResult) were added to @gantry/domain; the web keeps its own in apps/web/src/api/types.ts
