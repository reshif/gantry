# Wave 2 review

## Fixed
- Open redirect in /auth/login return_to (services/api/src/routes/session.ts safeReturn): the old check only rejected CR/LF, so '/\t/evil.example', '/\n/evil.example' and '/\\evil.example' passed, and browsers resolve those to //evil.example. It now rejects every control character and any backslash. Four bypass cases added to test/oidc.test.ts.
- Audit gap (spec 15.4) in services/api/src/core/command.ts: denied or stopped refusals thrown inside a command body (last Factory Admin, own admin role, matrix lockout, stopped project) rolled back and were never recorded. command() now records them as `<action>.denied` events in their own transaction and returns the original refusal. refuseIfStopped (areas/projects/store.ts) no longer records its own denial, so nothing is recorded twice. Test added.
- Step-up not enforced centrally (spec 14.1): command() now requires a fresh sign-in for any person command whose action is in the domain's STEP_UP_ACTIONS list (kill, restore, policy, role, security, api.keys, people.manage), even if the route forgot stepUp. Invites, accept, teams and on-call for others now need step-up; before, only factory-role grants did. Test added.
- Project role grants (PUT/DELETE /projects/{id}/members/{person}/roles/{role}) had no step-up. They now use stepUp: 300, like factory-role grants. Test added to test/projects.test.ts.
- I8/I9/14.4 bypass through policies (areas/access/policies.ts): a deny policy for roles ['*'] or ['factory_admin'] on policy.edit, role.edit, people.manage, security.manage or restore.factory could lock every admin out, with no way to undo it. Create, edit and enable now refuse it with 403 and rule INV-14.4-ADMIN, and the refusal is audited. Test added.
- Bootstrap Factory Admin (core/auth/signin.ts) was granted when the IdP left out email_verified. It now requires email_verified === true. Test added to test/oidc.test.ts.
- Security screen (apps/web/src/views/security.tsx, api/queries.ts): sessions and sign-in history were fetched without all=1, so an admin saw only their own rows and 'Revoke all other sessions' only reached their own sessions. The legacy screen shows everyone's. It now asks for all=1, and the server still limits that to security.manage.
- Step-up redirect lost the screen: the web app went to /auth/login?step_up=1#hash, and the hash does not survive the IdP round trip. A new stepUpUrl() in apps/web/src/api/ops.ts passes return_to=/#<route>. It is used by govern/data.ts useOutcome and projects/kit.tsx useRes. useRes previously showed the step_up refusal as a plain error toast. govern.test.tsx expectation updated.

## Remaining
- GET /api/v1/people/{id}/effective-permissions lets any signed-in person see anyone's effective permissions (cells limited to the viewer's projects), while POST /access/simulate needs a governing right to ask about others. The legacy people view behaves the same, so I left it, but the two endpoints are inconsistent. Product decision needed.
- If-Match is optional on every versioned endpoint (checked only when sent), as BUILD.md describes. A client that omits it gets last-write-wins.
- Fidelity: legacy G.explainDenial ('why not' button, from ask.js) is missing in security (sec-explain), people effective-permission cells (ppl-cell-explain) and the access simulator (acc-sim-explain). It depends on the console/ask area, which is not built yet.
- Fidelity, removed on purpose because they are simulation: security 'Test sign-in (simulated)' (sec-sso-test), 'Simulate idle' (sec-sim-idle) and home 'Pause simulation' (hm-sim).
- Fidelity, minor: page headers lack the legacy ids prj-head, ppl-head, sec-head, aud-head and hm-head (ViewHead takes no id). Project-config 'Save as template' reuses the projects dialog with ids prj-tplp-name/prj-tplp-ok instead of pcf-tpl-name/pcf-tpl-ok; behaviour is the same. All other legacy control ids and panel titles in the seven screens are present.
- setTeams, setOncall and setAway do not take lockOrgConfig. They rely on the If-Match version bump, which is only checked when the header is sent.
- No stop check for action-null commands (own saved views, own session revoke, own on-call or away). This looks intended: personal data, and access must stay revocable during an incident.
- Workspace typecheck fails in services/edge, services/github and services/worker with TS18003 (no inputs): empty scaffolds outside this wave. Their tests have no files and are skipped.
- Unverified: nothing was run against the full compose stack or a real Keycloak (deploy/smoke.sh not run). OIDC is covered only by the in-process test issuer.

## Endpoint audit
Columns: DP = decision point plus denial audit; TX = state and event in one transaction; IDEM = idempotent create; STOP = refuses in a stopped scope with the reason; T-DEN / T-STALE = has a permission-denied / stale-version test; SHAPE = returns the shape the frontend expects. P = pass, F = fail (now fixed), n/a = not applicable.

Core: every state change goes through command(): transaction, can(), denial recorded in its own transaction, If-Match, events with hash chain, outbox, SSE. Stop state comes from domain can() (stopBlocks) plus refuseIfStopped for project config.

Session and security:
- POST /auth/logout: DP n/a (own session; CSRF required, a forged logout is refused); TX P; others n/a.
- DELETE /sessions/{id}: DP P (own = self, others = security.manage); TX P; T-DEN P; T-STALE n/a (not versioned); SHAPE P.
- PATCH /security: DP P; TX P; step-up P; STOP P (can); T-DEN P; T-STALE P; SHAPE P.
- POST /can and POST /access/simulate: read-only, CSRF enforced.

Projects:
- POST /projects: DP P; TX P; IDEM P; STOP P (can); T-DEN P; T-STALE n/a; SHAPE P.
- POST /templates: DP P; TX P; IDEM P; T-DEN P; SHAPE P.
- PATCH /templates/{id}: DP P; TX P; T-DEN P; T-STALE P.
- POST /saved-views: self; TX P; IDEM P; tested.
- PATCH and DELETE /saved-views/{id}: self, owner-scoped; TX P; T-STALE P (the version check is inside the body as well).
- PATCH /projects/{id}/config, both the gate-mode and path forms: DP P (project.config, notify.edit and others via actionFor); TX P; STOP P (killed or archived project and factory kill refused, now audited by the pipeline); T-DEN P; T-STALE P.
- POST /projects/{id}/flow/{stations|gates|bays|classes}: DP P; TX P; IDEM P; STOP P; T-DEN P; T-STALE P.
- DELETE /flow/stations/{id} and PATCH /flow/stations|classes/{id}: DP P; TX P; STOP P; T-DEN P; T-STALE P; the 14.4 'in use' rule is enforced.
- PUT /projects/{id}/approvers/{gate}: DP P; TX P; STOP P (archived only, 'light' by design); T-DEN P; T-STALE P.
- PUT/DELETE /projects/{id}/members/{person}/roles/{role}: DP P; TX P; STOP P (archived); step-up F, fixed; T-DEN P; T-STALE P.
- POST /projects/{id}/archive and /unarchive: DP P; TX P; T-DEN P; T-STALE P.

People:
- POST /invites: DP P; TX P (person, teams, roles, invite row and outbox email together); IDEM P (body conflict returns 409); T-DEN P; step-up F, fixed.
- POST /invites/{id}/accept: DP P; TX P; T-DEN P; T-STALE P.
- PUT/DELETE /people/{id}/factory-roles/{role}: DP P; TX P; step-up P; last-admin and own-admin rules enforced on the server P (denial audit F, fixed); T-DEN P; T-STALE P.
- PUT /people/{id}/teams: DP P; TX P; T-DEN P; T-STALE P.
- PUT /people/{id}/oncall and /away: DP P (own = self, others = people.manage, project away = approvers.edit); TX P; tests cover denied, self and stale.

Access:
- PUT /access/matrix/{role}/{action}: DP P; step-up P; I8/I9 P (denial audit F, fixed); TX P (new immutable version); T-DEN P; T-STALE P.
- POST /roles: DP P; step-up P; IDEM P; TX P.
- PATCH and DELETE /roles/{id}: DP P; step-up P; TX P; delete is refused while the role is held, or named by a rule or policy; T-DEN P; T-STALE P.
- POST /policies: DP P; step-up P; IDEM P; TX P; lockout invariant F, fixed.
- PATCH and DELETE /policies/{id}: DP P; step-up P; T-STALE P; engine-owned policies protected.
- POST /freezes: DP P; step-up P; IDEM P; TX P.
- POST /freezes/{id}/end: DP P; T-STALE P.
- Access administration is exempt under a factory kill (spec 9.7), and that is tested.

Audit and home: reads only. A denied audit read by an API key and a denied chain verify are both recorded.

Security checks:
- CSRF: a session-bound HMAC token plus an Origin check on every cookie-authenticated non-GET under /api/v1, and on /auth/logout. P.
- Session fixation: the server issues a new token on every sign-in; step-up reuses the session only for the same person. P.
- Open redirect: F, fixed.
- Secrets: none returned in scope (invite token hashed, sessions hashed). P.
- /internal/v1 needs a service token (tested). P.
- SQL: audit, signins and events filters are all parameterized; the topic filter maps to a fixed whitelist; LIKE wildcards are escaped; no free-form sort parameter. P.
- I9 and last-admin: enforced on the server, policy loophole fixed. P.

## Tests
Ran against a real Postgres 17 (container w2rev-pg from mirror.gcr.io/library/postgres:17-alpine, removed afterwards) with GANTRY_TEST_DATABASE_URL set.

Before the fixes, npm test passed in every workspace: db 52/52, domain 79/79, api 163/163, launcher 37/37, web 98/98.

After the fixes:
- npm test: db 52/52, domain 79/79, api 168/168 (6 new tests, plus 4 bypass cases inside the existing return_to test), launcher 37/37, web 98/98 (govern.test.tsx step-up expectation updated for return_to).
- npm run typecheck: db, domain, api (src and test), launcher and web are clean. edge, github and worker fail with TS18003 'No inputs were found' (empty scaffolds outside this wave, unchanged).

Not run: docker compose up and deploy/smoke.sh, and sign-in against a real Keycloak.
