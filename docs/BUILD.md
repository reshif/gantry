# Gantry build conventions

This file is the shared contract for everyone building Gantry: people and agents alike. `spec.md` says **what** to build. This file says **how the code is laid out** so parallel work fits together. If the two disagree, `spec.md` wins and this file gets fixed.

## Decisions taken

| Decision | Choice |
| --- | --- |
| D1 language | TypeScript on Node 22 for every service; React 19 for the frontend |
| Frontend | React + TypeScript + Vite in `apps/web`, built to the Blueprint design (`docs/ui/design-system.md`), with data from the real API. It began as a port of `legacy/`; screens, routes and styles have since been redesigned |
| External systems | GitHub App, model vendors and Slack are built against their real APIs. Keys are added later; until then those paths are marked **unverified** |
| Simulation | None in the shipped product. `legacy/js/sim.js` is reference only. No fake ticks, no fake agents. The stub runtime adapter (spec 10.1) is a real, deterministic adapter used for tests and for stations without a model key |

## Repository layout

```
apps/web/               @gantry/web       React SPA, built to static files, served by gantry-web (nginx-unprivileged)
packages/domain/        @gantry/domain    Pure TS, no IO: types, catalog (roles, actions, stations, classes), can(), flow rules, lifecycle, risk tags
packages/db/            @gantry/db        pg pool, SQL migrations, tx helper, appendEvent (hash chain), secret crypto, data-access modules
services/api/           @gantry/api       Fastify REST API, sessions/OIDC, decision point, commands, SSE, /internal/v1
services/worker/        @gantry/worker    Same codebase as api, different entry: jobs, timers, outbox, flow engine, reaper, reconcile
services/launcher/      @gantry/launcher  start-run / stop-run / list-runs over the Docker socket, fixed template
services/edge/          @gantry/edge      Model gateway :8443, MCP gateway, forward proxy :8444, trace capture
services/github/        @gantry/github    GitHub App broker :9200
runner/                 gantry-runner     Runner base image + wrapper (harness launcher, heartbeat, checkpoint)
deploy/                 compose.yml, Caddyfile, Keycloak realm, secrets generator
legacy/                 The original vanilla-JS prototype: reference for API shapes only. Do not edit it
```

`gantry-migrate` is the `@gantry/db` package's `migrate` entry built as its own image. `gantry-worker` is built from the api's code tree with its own entry (spec 3.2: same code, different command), so shared server code lives in `services/api/src/` and the worker imports it through the `@gantry/api` workspace export `@gantry/api/core`.

## Libraries (use these; do not add alternatives)

| Concern | Library |
| --- | --- |
| HTTP server | `fastify` 5, `@fastify/cookie`, `@fastify/rate-limit` |
| Validation | `zod` 4 at every boundary. Parse unknown input, never cast |
| Postgres | `pg` (node-postgres). Plain SQL migrations in `packages/db/migrations/NNNN_name.sql`, run by our own small runner. No ORM |
| OIDC | `openid-client` 6 (auth-code + PKCE) |
| Object storage | `@aws-sdk/client-s3` against MinIO |
| Docker (launcher only) | `dockerode` |
| GitHub (broker only) | `@octokit/app`, `@octokit/rest` |
| Logging | `pino` (Fastify's logger). Never log secrets |
| Tests | `vitest`. DB tests run against a real Postgres (`GANTRY_TEST_DATABASE_URL`) |
| Frontend | `react` 19, `react-dom`, `react-router` 7 (hash routes, matching legacy `#name`), `@tanstack/react-query` 5, `vite` 7 |

## TypeScript

- Every package extends `../../tsconfig.base.json` (strict, `NodeNext`, ESM). `"type": "module"`.
- Each package has scripts `build` (tsc to `dist/`), `typecheck`, `test`.
- Packages export from `src/index.ts`; `package.json` `exports` points at `./dist/index.js` with `types`. In dev, workspaces resolve via `npm install` at the root.
- Expected failures are values: `type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }` from `@gantry/domain`. Throw only for bugs.

## The API contract

The API contract started from the legacy app: `G.store` slices and `G.ops.*` functions in `legacy/js/`. Spec section 8 maps each op to an endpoint.

- **Reads return the legacy shapes.** A `GET` returns objects with the same field names as the matching `G.store` slice (`workOrders`, `projects`, `people`, ...), so the React port reads the same fields the legacy views read. Shared shapes are TypeScript types in `@gantry/domain` (`src/types.ts`), used by both the API and the web app.
- **Commands return `{ ok, msg, ...extra }`.** Refusals: 403 permission, 409 conflict, stale version or stopped scope, 422 validation; body `{ ok: false, msg, rule?, needs? }`.
- Base path `/api/v1`; internal `/internal/v1`; auth `/auth/*`; hooks `/hooks/*`.
- Every command body may carry `via`. Creates take an `Idempotency-Key` header. Versioned entities take `If-Match: <version>`.
- `POST /api/v1/can` takes `{ checks: [{ action, project?, repo?, time? }] }` and returns `{ results: [{ allowed, reason, rule, needs }] }`.
- `GET /api/v1/stream` is SSE. Each message is `event: change`, `data: {"keys":["workOrders","audit"],"project":"p1"}`; keys are legacy store slice names. The client invalidates those query keys.

## The command pipeline (api)

Every state-changing handler goes through one helper. Nothing writes state any other way (spec F10, 15.4):

```ts
command(req, {
  action: "wo.approve",            // catalog action id, checked by can()
  scope: { project, repo, wo },    // for can() and the stop check
  ifMatch?: version,               // optional optimistic concurrency
  idempotent?: true,               // creates: uses the Idempotency-Key header
}, async (tx, actor) => {
  // change state with tx
  // return { msg, events: [{ type, category, subject, before?, after? }], extra?, jobs? }
})
```

It opens a transaction, runs `can()` (a denial is audited in its own transaction and returns 403), checks the stop state, runs the body, appends the events with their audit fields and hash chain, enqueues jobs and outbox rows, commits, then publishes SSE change keys. Stop endpoints use a reduced path that touches only `stops` and `events` (spec 8.5).

## Database

- Every table has `org_id uuid not null`. Ids are `text` primary keys that keep the legacy id style (`WO-1042`, `p1`, `u-ana`), so the frontend's ids and routes stay the same.
- `events` is append-only: the app role `gantry_app` has `INSERT, SELECT` only. A trigger computes `seq` per org and a `sha256` hash chain (`prev_hash`, `hash`).
- Migrations run as `gantry_owner`; services connect as `gantry_app`.
- Large content goes to MinIO under `sha256/<hash>`.
- User-entered secrets are encrypted with AES-256-GCM using the key from `/run/secrets/data_key`; the API returns only masked forms.

## Containers

- Dockerfiles live in `services/<name>/Dockerfile`, `apps/web/Dockerfile`, `runner/Dockerfile`, `packages/db/Dockerfile`. **Build context is the repository root.**
- Multi-stage, `node:22-alpine`, `npm ci` at the root with workspace filters, runtime stage copies only `dist` and production `node_modules`.
- Runtime: user `10001:10001`, read-only root, `tmpfs /tmp`, `cap_drop: [ALL]`, `no-new-privileges`, a healthcheck (`GET /healthz` for HTTP services).
- Secrets are files at `/run/secrets/<name>`, read with `readSecret(name)` from `@gantry/db`. Never put secrets in env vars.

| Secret file | Mounted into |
| --- | --- |
| `db_password` (app), `db_owner_password` | postgres, api, worker, migrate (owner: postgres, migrate only) |
| `session_key` | api |
| `data_key` | api, worker, edge, github |
| `edge_token` | api, edge |
| `github_token` | api, github, worker |
| `launcher_token` | worker, launcher |
| `vendor_keys.json` | edge |
| `github_app.pem`, `github_app.json` | github |
| `minio_root_password` | minio, api, worker, edge |
| `keycloak_admin_password` | keycloak only (the API never gets the master-admin password) |
| `oidc_client_secret` | keycloak; api |
| `idp_admin_client_secret` | keycloak (realm import); api (the scoped `gantry-admin` service account: manage-users in the gantry realm) |
| `bootstrap_admin_password` | api (written by the owner, never generated; the first Factory Admin's initial password, with `GANTRY_BOOTSTRAP_ADMIN_USERNAME`) |

## Ports and hostnames (compose service names)

| Service | Port |
| --- | --- |
| ingress (caddy) | 443 published on `127.0.0.1` only |
| gantry-web | 8080 |
| gantry-api | 8000 |
| gantry-launcher | 9100 |
| gantry-edge | 8443 model and MCP gateway, 8444 forward proxy |
| gantry-github | 9200 |
| postgres | 5432 |
| minio | 9000 |
| keycloak | 8081 (served at `https://localhost/idp`) |
| mailpit | 1025 SMTP, 8025 UI |

Caddy routes: `/api/*`, `/auth/*`, `/hooks/*` → api; `/idp/*` → keycloak; `/mail/*` → mailpit UI (dev); everything else → web.

## Environment variables (non-secret config only)

`GANTRY_ORG_ID`, `GANTRY_PUBLIC_URL` (`https://localhost`), `DATABASE_HOST`, `DATABASE_NAME`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `S3_ENDPOINT`, `S3_BUCKET`, `EDGE_URL`, `GITHUB_BROKER_URL`, `LAUNCHER_URL`, `SMTP_HOST`, `SMTP_PORT`, `GANTRY_DEV_SEED` (`true` loads the demo organisation and, on localhost, lists its users on the sign-in screen).

## Verification

- Run `npm run typecheck` and `npm test` for what you touched.
- Integration: `docker compose -f deploy/compose.yml up -d --build`, then `deploy/smoke.sh`.
- Report what you ran and what passed. Anything not run, or depending on missing GitHub/vendor/Slack keys, is listed as **unverified**.
