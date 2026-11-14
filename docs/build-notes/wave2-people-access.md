# Wave 2: people-access

## Summary
People, Access and Security are finished. The API half (routes and areas) already existed from the interrupted attempt. I kept it, got its tests running, and added the three web screens, ported from legacy and run against the real API. Verified: API vitest 137/137 against a real Postgres (the only prior failures were in the tests I fixed), web vitest 70/70 (20 of them new), and both typechecks clean. I ran the real api on a throwaway Postgres with GANTRY_DEV_SEED=true and a minted session, drove each screen in a real browser (Playwright, Chrome) and compared against legacy via file://. Every write succeeded end to end, and each screen matches legacy except the deliberate removals listed below.

## Public interface
Endpoints (all state-changing ones go through command(), step-up where spec 14.4 requires it, If-Match on versioned entities, Idempotency-Key on creates):
- GET /api/v1/people, GET /api/v1/teams, GET /api/v1/people/{id}/effective-permissions?at=
- POST /api/v1/invites (writes the person, team and role rows, an invites row, and an outbox row with destination smtp and kind 'invite'; the worker delivers it later); POST /api/v1/invites/{id}/accept (id is the invited person's id)
- PUT/DELETE /api/v1/people/{id}/factory-roles/{role} (step-up 300 s, checkRoleChange invariants); PUT /api/v1/people/{id}/teams; PUT /api/v1/people/{id}/oncall (self needs no right); PUT /api/v1/people/{id}/away {away|null, project?}
- GET /api/v1/access/matrix -> {matrix, roles, actions, version}; PUT /api/v1/access/matrix/{role}/{action} {on} (If-Match is the matrix version, step-up, checkMatrixEdit, each edit publishes a new immutable role_matrix_versions row)
- POST /api/v1/roles (cloned from a base role), PATCH/DELETE /api/v1/roles/{id} (checkRoleDelete; also refused while an approver rule or a policy names the role)
- GET/POST /api/v1/policies, PATCH /api/v1/policies/{id} (full body, or {enabled}), DELETE (soft delete, ids never reused; POL-110 and POL-112 can only be enabled or disabled; each change is a policy_versions row)
- GET/POST /api/v1/freezes, POST /api/v1/freezes/{id}/end
- POST /api/v1/access/simulate {person, action, project?, repo?, time?} -> {ok, decision, trace, week}. It calls domain simulate(), which calls the same can() as enforcement.
- Web: default exports in views/people.tsx, access.tsx and security.tsx. Shared helpers in views/govern/data.ts: useTeams, useAllRepos, usePolicyWording, useOutcome (toasts the result, and sends a step_up refusal to /auth/login?step_up=1#hash), lockd, versionOf.

## Integration notes
1. Read mappers now return `version` on people, roles, policies and freezes. The web uses it for If-Match, and test/devseed.test.ts was adjusted to strip it.
2. The web shell fix in App.tsx binds the query client in an effect. The web owner should keep it that way, or live refresh breaks in dev under StrictMode.
3. Migration 0012_access_versions.sql (freezes.version, policies.deleted_at) is already in the migrations folder. No new migrations from this pass.
4. The People screen hands a simulator question to Access through sessionStorage key `gantry.accessSim` ({person, action, project}). The Access screen consumes and clears it on mount.
5. The People member detail and the freeze dialog read repos per visible project via GET /projects/{id}/repos. They will light up as soon as the onboarding area ships it.
6. Role grants per project (PUT/DELETE /projects/{id}/members/{person}/roles/{role}, ops.setMemberRole) belong to the projects area. The People screen already calls them.
7. The web's `needs: 'step_up'` handling lives in govern/data.ts useOutcome. Other screens that hit step-up commands (kill, restore, keys) can reuse it.
8. Dev reproduction scripts are in /tmp/w2acc (run-api.mjs mints sessions into sessions.json, shots.mjs and flows.mjs drive Playwright). The docker container w2acc-pg is removed. The api and vite dev processes I started are stopped, and nothing is left running."

## Unverified
- Step-up round trip: the web sends /auth/login?step_up=1#<route>, and core ignores a return_to param, so landing back on the same screen relies on the browser keeping the fragment through the redirect chain. Only the redirect itself is unit-tested; never run against Keycloak.
- Per-project repo counts in People and the repo picker in the freeze dialog and simulator read GET /projects/{id}/repos, which the onboarding area had not implemented yet (404). Until it exists, the team repo counts show 0 and the legacy example presets that name a repo are hidden. I handle the 404 and show nothing; I did not add a competing route.
- The History section on People calls GET /audit?q=<personId>&limit=8. The audit route is still an empty stub (404), so it shows 'The audit log is not available to you.'. The audit engineer should support filtering by entity or text.
- Removed on purpose, because nothing may be simulated: Security's 'Test sign-in (simulated)' button, its 'Simulate idle' demo, and the 'Simulated' footnotes. The SSO, MFA and GitHub fields are still settings the API stores; I added a hint that the identity provider enforces SSO and MFA, and I did not verify that. The IP allow-list and idle timeout are enforced by core.
- Spec 15.4's 'refuses in stopped scope' does not apply to my endpoints. Domain stopBlocks only refuses project-scoped Work, Gates and Onboarding actions, and administration is exempt by design (spec 9.7). A test now asserts that a factory kill does not block access administration.
- Email delivery of invites is the worker's job. I only write the outbox row (destination smtp, payload {kind, to, name, invitedBy, link}). Invited people become active on first sign-in through core, or via 'Mark invite accepted'.
- Not tested in a real browser: mobile widths, dark theme and keyboard focus order of the new dialogs.
