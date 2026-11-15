# Gantry security review (authorized, local dev stack)

Reviewer scope: frontend (apps/web, nginx, Caddy), API authorization (services/api), sessions/OIDC, secrets/agents/runner config, `npm audit`.
Method: code reading plus live proof with curl against https://localhost as `asha` (Factory Admin) and `tomas` (no roles, then Engineer / Project Admin on a probe project I created).
Test scripts and session files: `/tmp/claude-1000/-home-reshif-Downloads-gantry/c3821914-677f-49a0-9d20-175f5f009c4b/scratchpad/review/sec/` (`login.mjs`, `h.sh`).

## Side effects of testing (please read)
- While probing I **halted the whole factory once** (finding 2: the request succeeded when I expected a 403). It was live for about one minute (stop `factory:factory:1`, set by `p-tomas`, fencing 29) and I resumed it immediately as asha (`DELETE /api/v1/stops/factory:`). `GET /api/v1/stops` is empty again. The audit ledger carries the halt and the resume.
- Test data left behind: project `sec-probe` (created by asha); `p-tomas` holds `engineer` + `project_admin` on `sec-probe` (someone also granted tomas `engineer` on `nautobot-jobs` during the review, not me). I set `p-kenji` away with delegate `p-tomas` for finding 3 and reverted it (`away: null`).
- No data deleted, no containers touched, Keycloak untouched.

## Summary table

| # | Sev | Finding | Proven live |
|---|-----|---------|-------------|
| 1 | P0 | Authentication and read-gate decided on the raw URL: percent-encoding a path character skips both | yes |
| 2 | P1 | Any project-level `line.halt` / `line.resume` holder can halt or resume the **whole factory** | yes |
| 3 | P1 | Project Admin of any project can set away/delegate on any person in any project | yes |
| 4 | P1 (prod default) | Demo accounts default to ON in compose; unauthenticated `/api/v1/me` publishes the roster (names, emails, roles) | yes |
| 5 | P2 | Auto gates ignore risk tags (CI/auth/migration/CODEOWNERS changes can pass G4 with no human) | code only |
| 6 | P2 | Mailpit UI and Keycloak master/admin console are reachable through the public ingress | yes |
| 7 | P2 | `people.manage` holder can grant Factory Admin (incl. to self); `policy.edit` is self-elevating | code only |
| 8 | P2 | Docker socket mounted into launcher and github broker (root-equivalent) | config |
| 9 | P2 | nodemailer 7.0.13 high-severity advisories (`npm audit`) | audit |
| 10 | P3 | Identity linking: `email_verified` absent is accepted; link-by-email to unclaimed persons; Keycloak lets users edit their own email | code |
| 11 | P3 | Sign-out does not end the Keycloak SSO session | code/live cookies |
| 12 | P3 | Info leaks: audit `summary` counts for invisible projects; SSE key names for invisible projects; unauthenticated `/api/v1/catalog` (via #1) | yes |
| 13 | P3 | Hardening: CSP `style-src 'unsafe-inline'`, Google Fonts third party, HSTS without includeSubDomains/preload, `via` field spoofs audit channel, on-call self-toggle, unauthenticated webhook failures write audit rows | code |

What I checked and found sound is listed at the end.

---

## 1. P0: raw-URL path matching lets a percent-encoded path skip authentication and the read gate

**Where**
- `services/api/src/core/app.ts` onRequest hook: `const path = req.url.split("?")[0]; if (path.startsWith("/internal/v1/")) ...; if (path.startsWith("/api/v1/")) { await authApi(...); await enforceReadGate(...) }`
- `services/api/src/core/read-gates.ts`: `readGateFor(req.url.split("?")[0])` matches regexes such as `^/api/v1/(people|teams)(\/|$)` on the raw string.

Fastify's router decodes percent-escapes, so `/api/v1/%70eople` routes to the `/api/v1/people` handler, but the string checks above no longer match. Two distinct bypasses:

**1a. Read gate bypass (default-deny reads).** tomas has no roles.
```
GET /api/v1/people            -> 403 "No role held ... includes 'See people and teams'"
GET /api/v1/%70eople          -> 200  [{"id":"p-asha","name":"Asha Raman","email":"asha@acme.dev","roles":[{"role":"factory_admin",...}],...}, ...]
GET /api/v1/%61ccess/matrix   -> 200 full role/action matrix
GET /api/v1/%61gents          -> 200 agent definitions
GET /api/v1/%73kills          -> 200 skill bodies (agent instructions)
GET /api/v1/%76endors         -> 200 vendors (keyMask only, endpoints, spend)
GET /api/v1/%69ntegrations    -> 200 integration instances (config, secretMask, createdBy)
GET /api/v1/%74eams, %63atalog, %63onsole/status, %65vals/runs, %74rust/cells, %74riggers, %64eliveries ... -> 200
```
All the factory-wide registers listed in `READ_GATES` are exposed to a person with zero roles. Project-scoped data stayed protected because those handlers do their own visibility check (`/api/v1/%70rojects/nautobot-jobs/*` -> 404), so the leak is the factory registers (people and emails, role matrix, agent prompts, integration config, models and spend).

**1b. Authentication skipped entirely.** With no cookie at all:
```
curl -sk --path-as-is https://localhost/%61pi/v1/catalog   -> 200 {"stations":[...],"gates":[...]}
curl -sk --path-as-is https://localhost/%61pi/v1/people    -> 403 "This view is for signed-in people."   (handler's own principal check)
```
`authApi` never runs, so `req.gx.principal` is null and the CSRF, session, IP-allow-list and API-key gate are all skipped. Today every handler happens to refuse a null principal except `catalog`, so the live impact is small, but any handler (existing or future) that trusts the central hook is public. The same applies to `/internal/v1/` (`authInternal` is skipped); Caddy does not route `/internal` and `gantry-api` is only on the internal `control` network, so this is reachable only from inside it, and the handlers use `requireEdge`/`command` which refuse a null principal.

**Fix**
- Authenticate on route registration, not on a string: use a Fastify `onRequest` hook scoped by plugin (`app.register(productApi, { prefix: "/api/v1" })` with the auth hook inside it) so routing decides, or normalise first (`decodeURIComponent`, collapse `//`, reject any request whose decoded path differs from raw for `/api`).
- Make the read gate data-driven from the matched route: `config: { read: "people.view" }` on each route and read `req.routeOptions.config` (as `gateApiKey` already does with `routeOptions.config`). Add a startup test that every GET route under `/api/v1` is either declared public/own-data or has a read action. A deny-by-default hook (`403` when a GET route declares nothing) removes this whole class.
- Add a regression test that sends `/api/v1/%70eople`, `/%61pi/v1/people` and `/api/v1/people/%2e%2e/...` as a no-role user and expects 403/404.

---

## 2. P1: factory-wide halt and resume by any project-level holder of `line.halt` / `line.resume`

**Where**: `services/api/src/areas/stops/targets.ts` `stopAction()` maps every halt to `line.halt` and every resume to `line.resume` regardless of scope; `routes/stops.ts` passes `scope: { project: null }` for a factory target. `can()` (`packages/domain/src/policy.ts` ~line 248) treats a project-scoped action with no project as "any grant held anywhere counts" (`!scoped || !projectId || g.scope === projectId`; the catalog comment at `catalog.ts:341` documents this as intended for read/console only).

Default roles holding `line.halt`: Engineer, Reviewer, Release Manager, Line Lead (`defaultMatrix`). `line.resume`: Line Lead, Release Manager, Project Admin.

**Reproduction (executed)**: tomas is `engineer` on `sec-probe` only.
```
POST /api/v1/stops {"scope":"project","id":"nautobot-jobs","mode":"halt","reason":"probe"}  -> 403 (correct: not his project)
POST /api/v1/stops {"scope":"factory","mode":"halt","reason":"probe"}
 -> 200 {"ok":true,"msg":"the factory halted. Agents on every project stop at the next turn boundary; slots stay reserved.","stop":"factory:factory:1","fencing":29,...}
```
Any engineer on any one project can stop every agent on every project (and any line lead/release manager can lift a factory halt that an admin set).

**Fix**: add a factory-scoped action (`halt.factory`, `resume.factory`, mirroring `kill.factory`/`restore.factory`, which are already factory-scoped) and have `stopAction` return it when `scope === "factory"`. Generally: a project-scoped action must never be evaluated with a null project on a write path. In `command()` assert `scope.project` is set when the action's catalog scope is `project`, and fail closed. Grep for other uses: only the stop routes hit it in the current tree (I reviewed every `command(` and `decide(` call in routes/ and areas/).

---

## 3. P1: Project Admin can write away/delegate status on any person in any project

**Where**: `routes/people.ts` `PUT /api/v1/people/:id/away` authorizes with `approvers.edit` scoped to the **body's** `project`, but `setAway` (`areas/people/people.ts:147`) writes `people.away`, which is global. The `project` field is only audit metadata. `gateDecision` (`packages/domain/src/flow.ts`, `delegateFor`) lets the delegate stand in for the away person on every project's gates.

**Reproduction (executed)**: tomas is Project Admin of `sec-probe` only; Kenji is Release Manager on `nautobot-jobs` (a project tomas does not administer).
```
PUT /api/v1/people/p-kenji/away {"project":"sec-probe","away":{"to":<now+1h>,"delegate":"p-tomas"}}
 -> 200 "Kenji Watanabe is away; Tomás Ferreira approves instead."
GET /api/v1/people (asha) -> p-kenji.away = {"delegate":"p-tomas",...}
```
(Reverted afterwards.) The delegate still needs the underlying matrix right on the gate's project (`base = can(...)` runs first), so this does not mint approvals from nothing, but it lets a project admin of A mark approvers of B away, name a delegate who then qualifies under B's approver rules, and put false "away" state on arbitrary people (including Factory Admins).

**Fix**: when `project` is given, require that the target person actually holds a role on that project and scope the away to it (store per project), or authorize `people.manage` (factory) for anyone but self. Reject `project` for persons outside the project.

---

## 4. P1 (as a production default) / P2 in dev: demo accounts on by default and an unauthenticated roster

`deploy/compose.yml`: `GANTRY_DEV_DEMO_ACCOUNTS: ${GANTRY_DEV_DEMO_ACCOUNTS:-true}`. When on, any unauthenticated 401 body from `/api/v1/*` (for example `GET /api/v1/me`) carries `config.demoAccountList`: every person's id, name, email and a plain-language description of their roles ("Factory Admin; Project Admin on Nautobot-Jobs"). Verified live. Password is still required (`login_hint` plus `prompt=login`), so this is reconnaissance and a phishing aid, and a default that is easy to ship by accident.

**Fix**: default `false`; require an explicit opt-in that also refuses to start when `GANTRY_PUBLIC_URL` is not localhost.

---

## 5. P2: automatic gates ignore risk tags (code review, not exercised live)

`services/api/src/areas/workorders/engine.ts` `openGate`: risk tags are computed (`riskTagsOf`) and stored as `basis.forcedHuman`, but the `kind === "auto"` branch passes the gate when the checks are green without consulting `tags`. Only the trust-ladder path (`trustDecision`) receives `riskTags`. Spec 9.5 says any tag (`ci`, `dependencies`, `codeowners`, `auth-crypto`, `gantry-config`, `migration`, `agent-tests`) forces a human vote. In the blank template G4 (CI) is `auto`, so an agent PR (or one steered by prompt injection) that edits workflow files, CODEOWNERS or the tests it is judged by can pass G4 on the CI result it influenced.

**Fix**: in `openGate`, if `tags.length > 0` and kind is `auto`, downgrade to a waiting human gate (or `mixed`), and record `forcedHuman` in the decision. Add a test per tag.

---

## 6. P2: Mailpit and the Keycloak master realm / admin console are served by the ingress

`deploy/caddy/Caddyfile` routes `/mail/*` to Mailpit and `/idp/*` (everything) to Keycloak.
```
GET https://localhost/mail/                              -> 200 (Mailpit UI, no auth; invites and notification mail readable by anyone who reaches the host)
GET https://localhost/idp/admin/master/console/          -> 200
GET https://localhost/idp/realms/master/.well-known/openid-configuration -> 200
```
Bound to 127.0.0.1 here, so dev-only exposure, but the Caddyfile is the template for deployment.

**Fix**: split a `Caddyfile.dev`; in the production file proxy only `/idp/realms/gantry/*` and `/idp/resources/*`, return 404 for `/idp/admin*`, `/idp/realms/master*`, and drop `/mail`. Also note Keycloak runs `start-dev` (H2, no read-only root), already flagged in compose.

---

## 7. P2: role-grant escalation paths (design)

- `PUT /api/v1/people/:id/factory-roles/:role` needs only `people.manage` (+ step-up). `checkRoleChange` guards removal of the last/own admin but never restricts who may **grant** `factory_admin`. Any custom factory role given `people.manage` can make itself (or a friend) Factory Admin. By default only Factory Admin holds `people.manage`, so this needs an admin to hand it out. Verified project-level paths are tight: `PUT /projects/:id/members/:person/roles/:role` only accepts project-level roles (`setMemberRole`), so a Project Admin cannot grant `factory_admin`; tomas got 403 for both factory-admin self-grant and for granting himself project_admin on a project he did not administer.
- Likewise `policy.edit` (matrix edit, step-up) lets its holder give its own role any right.
- **Fix**: require the grantor to be Factory Admin to grant or revoke `factory_admin`, and refuse a grantor adding to their own grants (self-grant), with the audit event flagged.

---

## 8. P2: Docker socket in two services

`gantry-launcher` and `gantry-github` mount `/var/run/docker.sock` (comment in compose already says root-equivalent). A bug in either is host compromise. They are on internal networks and hardened (cap_drop ALL, read-only). Recommend a socket proxy that allows only the container/network/volume calls actually used, or rootless Docker/Podman for the launcher.

Runner template (`services/launcher/src/template.ts`) is good: unprivileged, read-only rootfs, cap_drop ALL, no-new-privileges, no binds, `Binds: []`, mem/pids limits, per-run /28 internal network. The only credentials in the runner are its own run token (env and proxy URL); vendor keys are injected by the edge, not the runner. Egress goes through the edge proxy with per-run allow-list, port allow-list and private/loopback/link-local/NAT64/6to4 address blocking (`services/edge/src/proxy.ts`). I only reviewed config and code, did not attack containers.

---

## 9. P2: dependency audit (`npm audit --omit=dev`, root)

3 vulnerabilities (2 moderate, 1 high):
- **nodemailer <= 10.1.3 (high)**, installed 7.0.13 (used in `services/api/src/areas/integrations/ops.ts` and `services/worker/src/outbox/smtp.ts`): SMTP command injection (`envelope.size`, transport name), CRLF header injection in List-* headers, recipient-domain validation bypass (delivery to attacker domain), `raw` / `jsonTransport` file-read bypass, quadratic-time DoS in address parsing, and more. Notification recipient addresses can come from user-editable data, so address-parser and header-injection issues are reachable. Audit suggests `nodemailer@10.5.0` (breaking); test the worker's SMTP outbox and the integration email test after upgrading.
- **uuid < 11.1.1 (moderate)** via `dockerode` (launcher/github broker): bounds check when a buffer is supplied; low practical risk.

---

## 10. P3: identity linking and Keycloak settings

`services/api/src/core/auth/signin.ts`:
- `emailVerified === false` is refused but `undefined` is accepted (an IdP that omits the claim, for example a GitHub-federated flow, passes). The bootstrap admin path correctly requires `=== true`; use the same rule for linking.
- Lookup order is `idp_subject`, then `gantry_id` claim plus matching email, then plain email. A person row with `idp_subject = null` (every provisioned-but-never-signed-in person, invites included) is claimed by whoever first presents a matching email. Realm `realm-gantry.json` lets users edit their own email in the account console (`email` permission `edit: user`) with `verifyEmail` unset, so a Keycloak user who has no Gantry person yet could set an invitee's email and inherit that person's roles. Needs an existing Keycloak account without a Gantry person, so low likelihood. Fix: make `email` read-only for users in the realm user profile (or force verify-email on change), and require the claim to be verified for linking; link invites by a one-time token rather than address.
- `gantry_id` / `gantry_title` are admin-only in the user profile (good), so the `gantryId` claim cannot be self-set. `freePersonId` appends `-2` on collision, so it cannot capture an existing id.
- Provisioning on first sign-in creates a person with no roles (safe default).

Sessions (all verified live or in code): cookie `__Host-gantry_session`, HttpOnly, Secure, SameSite=Lax, Path=/, 12 h absolute expiry (`sessionHours`), idle window enforced in `findSession` and by the SSE sweeper, token stored only as HMAC, new random token every sign-in (no fixation), logout revokes server-side and requires the CSRF token, deactivated accounts revoke all sessions on next request, step-up requires `auth_time` within the window and `different_person` is refused. OIDC: PKCE S256, state and nonce in a sealed httpOnly cookie, `return_to` validated by `safeReturn` (tested `//evil.example`, `/\evil.example`, `https://evil.example`, `/%09/evil.example`: none reflected), callback with a bad state returns a fixed message.

---

## 11. P3: sign-out leaves the Keycloak SSO session

`POST /auth/logout` revokes the Gantry session only. The browser keeps `KEYCLOAK_IDENTITY`; the next "Sign in" (no `login_hint`/step-up, so no `prompt=login`) silently signs the same person back in. On a shared machine this undermines sign-out. **Fix**: RP-initiated logout (`end_session_endpoint` with `id_token_hint`, `post_logout_redirect_uri` registered in the client) or always send `prompt=login`.

---

## 12. P3: small information leaks

- `GET /api/v1/audit?project=nautobot-jobs` as a user who cannot see that project returns `items: []` but `summary.entries: 4` and the chain `head` hash. Trim the summary to visible rows.
- SSE (`/api/v1/stream`): events without a project are broadcast to everyone, with the changed slice names (`people`, `apiKeys`, ...). Metadata only; project-tagged events are filtered correctly.
- `/api/v1/catalog` is public through finding 1b.
- `/auth/login`, `/auth/callback` errors are shown from `?auth_error=` and `?msg=` (React text nodes, so no XSS, but an attacker can show arbitrary text on the real sign-in page; limit to a code mapped to fixed text).

---

## 13. P3: hardening list

- CSP on the SPA: `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` and Google Fonts as a third party (leaks the user's IP and referrer-less visits to Google, and is a CSP gap if the fonts host were compromised). Self-host the fonts and drop `unsafe-inline` (needs nonce/hash for the few inline styles). `script-src 'self'` and `frame-ancestors 'none'` are right.
- `Strict-Transport-Security: max-age=31536000` without `includeSubDomains`, and set with `?` (kept if upstream sets its own); fine for a single host, add `includeSubDomains; preload` when the domain is final.
- nginx `Referrer-Policy: same-origin` vs Caddy `no-referrer`: Caddy's `?` prefix keeps the upstream value, so the SPA gets `no-referrer` from Caddy (it printed `no-referrer` live); no action, just harmonise.
- `via` in command bodies (`web|console|slack|teams`) selects the audit `channel` and sets `onBehalfOf` for non-web values. A user can label their own web action as `slack`. Take the channel from the authenticated transport, not the body.
- `PUT /people/:id/oncall` for self needs no right, and oncall-only `extend` policies (for example POL-106 in the seed) grant extra rights while on call: a person can self-assert the condition. If on-call matters for security, source it from a schedule.
- Unsigned webhook requests to `/hooks/github` and `/hooks/trigger/:id` write an audit event each (rate limit 600/min global, 120/min trigger). An attacker can grow the ledger; rate-limit and sample denials.
- `GANTRY_TRUST_PROXY` defaults to true: if the API is ever reachable without Caddy, `X-Forwarded-For` becomes spoofable (IP allow-list, rate limit, audit IP). I could not demonstrate spoofing through Caddy (Caddy 2 replaces untrusted XFF); set `trustProxy` to the ingress address.
- Rate limit allow-list matches `url.startsWith("/api/v1/stream")` and `/internal/v1/` on the raw URL (same pattern as finding 1; low impact).

---

## Verified sound (no finding)

- **Frontend**: no `dangerouslySetInnerHTML` with data: only `ui/charts.tsx`, `ui/Icon.tsx` and `views/floor/Belt.tsx` build SVG strings, and every data-derived string goes through `esc()`. Console Markdown (`views/console/Markdown.tsx`) parses to React elements, raw tags stay literal, links limited to `https?://` and `#`. `href` values from data (`p.url`) are PR links from the broker with `rel=noreferrer`. No tokens in localStorage (only UI prefs and nav state; the CSRF token lives in memory and is fetched from `/me`), no secrets in URLs, `console.error` only for React boundary. Step-up popup `postMessage` is origin-checked. Source maps off.
- **CSRF**: every mutating cookie request needs `X-CSRF-Token` (HMAC bound to the session) plus an Origin check; SameSite=Lax and `__Host-` cookie. No CORS headers are sent (preflight from evil.example gets 401 and no ACAO).
- **Cross-project IDOR (live, tomas with a role only on `sec-probe`)**: WO read, record, record.md, changes, session, gate approvers, messages, decline, park, gate approve, project, floor, events, repos, onboarding session/PR, conversations, work-order-sessions, console tool with another project: all 404/empty. Writes needing a project role (`wo.submit`, `api.keys`, budgets, project config, member grants, `project.create`, matrix/roles/security/teams): 403 with decision-point reasons. Gate approval enforces SoD, requester-never-sole-approver (I4) and one-vote-per-person; Factory Admin override needs a reason and is flagged (documented product decision).
- **API keys**: only routes that declare `config.apiKey` are reachable, keys are project-bound, scopes limited to four values, `Idempotency-Key` required for creates, key `onBehalfOf` forced to the creator, hash-only storage, expiry default 90 d, rate limit and audited denials.
- **Webhooks**: GitHub (HMAC over raw body, replay by delivery id and body hash), generic trigger hook (signature with five-minute window), Slack (signature, window, replay) all verify before processing. MCP gateway and run endpoints require edge service token plus live run token, `requireEdge` blocks the GitHub broker token; `/internal` is not routed by Caddy (nginx returns 404 as well).
- **Agents and prompt injection**: agent output does not act on its own. Work-order session and onboarding agents only create proposal cards that a human approves, executed under the approver's own rights (`session/proposals`); console propose tools need per-kind console rights; agents cannot approve config (I6); secrets scan at the edge; repo/web content is marked untrusted in prompts (`UNTRUSTED_NOTE`). Caveat: the system prompt interpolates the user's display name and project name verbatim (`workorder-session.ts` `system()`), so a person's Keycloak name is an injection vector into their own session; low impact because of the approval rails. The one rail that fails is finding 5.
- **Secrets**: integration/vendor/MCP secrets are sealed with the data key (AAD bound to the row) and returned only as masks; vendor keys live in the edge, not in runners; the runner sees only its run token.
- **SQL**: queries are parameterized; dynamic fragments are column lists or enum-validated sort fields.
- **Headers**: API responses `Cache-Control: no-store`, `CSP default-src 'none'`, `nosniff`; SPA CSP, XFO DENY, COOP, Permissions-Policy present.
