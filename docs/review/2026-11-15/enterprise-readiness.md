# Gantry enterprise-readiness assessment (SRE view)

Verdict: NOT ready for enterprise production. Strong security posture and a sound transactional core (event log, outbox, idempotency, reaper), but there is no CI, a red typecheck and 2 failing tests on main, a dev-only identity provider, `:dev`-tagged unversioned images, no backup/restore/upgrade/retention tooling, and no metrics/tracing/alerting. Spec 5.5 itself scopes this as a "local stack".

## 1. Build and test evidence
- `npm run typecheck`: FAIL in @gantry/api (others pass). Errors:
  - `apps/web/src/lib/demo.ts(9,34) TS2835` relative import needs `.js` extension (nodenext), and `services/api/test/personas-signin.test.ts(9,31) TS6059` (imports apps/web source outside api rootDir) - a cross-workspace import from an API test into the web app.
  - `test/personas-signin.test.ts(127,43) TS2322`: `project: null` vs `string` (type drift).
- `npm test` with a throwaway postgres:17-alpine (`GANTRY_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres`; documented in README.md:43, helpers at services/api/test/helpers.ts:11): 8 workspaces, ~1,705 tests, 1,700 pass, 2 FAIL, 3 skipped.
  - FAIL services/api/test/read-gates.test.ts: "default deny for reads > a person with no grants reads none of the registers, and gets the reason" and "a percent-encoded prefix does not skip authentication". These are authorization default-deny tests; regressions here are security-relevant. (I did not root-cause; the working tree has uncommitted edits only to deploy/compose.yml, so main itself is red.)
  - Per workspace: db 55/55, domain 152/152, api 739/741, edge 99/99, github 63 pass/3 skip, launcher 37/37, worker 114/114, web 441/441.
- README claims "1,363 tests" - stale; also claims verified state that main no longer meets.
- `deploy/smoke.sh` (46 checks) and test/e2e/*.mjs exist but are manual scripts, not wired to anything.

## 2. Deploy
Good: all Gantry containers read_only, tmpfs /tmp noexec, cap_drop ALL, no-new-privileges, uid 10001; secrets as files not env (compose.yml `secrets:`); networks `control`/`launch` internal, only 127.0.0.1:443 published; healthchecks on every service; `restart: unless-stopped`; Postgres scram + data-checksums; separate owner/app DB roles; one-shot `gantry-migrate` runs on every `up` (migrations apply on upgrade); MinIO pinned to a release (quay.io/...RELEASE.2025-09-07), mailpit pinned (v1.33.1). Note: the brief's `pgsty/minio:latest` is NOT used.
Gaps:
- Images: own services tagged `gantry-*:dev` built locally (compose.yml, e.g. `image: gantry-api:dev`) - no registry, no version/digest, no rollback target. Base images `node:22-alpine`, `caddy:2-alpine`, `postgres:17-alpine`, `keycloak:26.4`, `nginxinc/nginx-unprivileged:1.27-alpine` are floating tags, not digests. No image scan/SBOM/signing.
- No resource limits anywhere (no `mem_limit`/`cpus`/`pids_limit`); `MAX_CONCURRENT_RUNS=32` runners on the same host can starve postgres/api. Runner containers' limits are in the launcher template (not audited here).
- Keycloak runs `start-dev` with embedded H2 on `kcdata` (compose.yml, keycloak service; uncommitted diff adds the volume). Dev mode: no caching/clustering, H2 not supported for production, hostname strictness off, `GANTRY_DEV_DEMO_ACCOUNTS` default `true` shows seeded accounts with shared password `gantry-dev` (compose.yml gantry-api env). Realm edits only apply after deleting the volume (loses user ids = the OIDC `sub` links). Keycloak container is not read_only and `user: 10001:0`.
- Mailpit is the only SMTP and is routed at `/mail/*` on the public ingress (Caddyfile) with no auth; mail with notifications readable by anyone who can reach the ingress. Dev-only, must be removed/blocked.
- Backups: spec 3.4 says pg_dump on schedule, 7 dailies - nothing implements it. No backup service, no restore doc/test, nothing for `objdata`, `kcdata`, `caddydata` (CA/certs), `deploy/secrets`. The `data_key` encrypts user-entered secrets in DB: losing it makes backups of those unusable; it is not backed up/escrowed by any tooling.
- Zero-downtime: `gantry-migrate` is `service_completed_successfully` dependency of api and worker; migrations run before the new api starts, but there is a single api/worker/ingress instance, `up -d --build` recreates containers (brief outage), no expand/contract migration policy, no down-migrations, no rollback story. Spec 6.1 says api is stateless and can run 2+ copies, but compose has no replicas and the SSE hub (`hub` in core/app.ts) is in-process (cross-instance fan-out is unverified; guess: needs LISTEN/NOTIFY - check).
- Non-local changes needed (spec 5.5 and README): Docker-socket-mounted launcher and github broker are root-equivalent on the host (group_add DOCKER_GID); no gVisor/Kata runner option; local polling instead of GitHub webhooks (webhook ingress `/hooks/*` exists but the broker polls); `tls internal` self-signed CA and hard-coded `GANTRY_PUBLIC_URL: https://localhost`, `KC_HOSTNAME https://localhost/idp`, Caddy site `https://localhost:8443`, realm redirect URI `https://localhost/auth/callback` - the hostname is hard-coded in 4 places; no Postgres HA/PITR/managed DB path; MinIO single-node single-drive; no external SMTP/secret manager/KMS integration; repos needing Docker cannot run.
- Secrets: generate.sh writes 0644 files in a 0700 dir (secrets/README.md) - acceptable for local only; no rotation procedure beyond "delete a file and recreate"; data_key rotation impossible (no key id in ciphertext - services/api/src/core/crypto.ts has no kid/rotate code); `vendor_keys.json` secret is a flat file.
- Ingress: Caddy has no rate limiting/WAF, request size limits or access-log shipping; `response_header_timeout 0`/`read_timeout 0` for /api/* (Slowloris-style exposure on all API routes, not just SSE). CSP allows Google Fonts (external dependency/privacy).

## 3. Observability (what an operator has at 3am)
- Logging: Fastify pino JSON with `x-request-id` (genReqId, core/app.ts:64; header echoed in onSend), authorization/cookie redaction (app.ts:62); worker pino with redaction (worker/src/main.ts). Caddy JSON access log, nginx plain access log. `docker compose logs` only - no log shipping, retention, or correlation across edge/launcher/github (request id propagation to downstream services not verified; guess: partial).
- Metrics: none. No `/metrics`, no prom-client; no queue depth, job age, outbox backlog, dead-letter count, lease/reaper counts, SSE connections, DB pool stats.
- Tracing: no OpenTelemetry/traceparent. ("traces" in the product = agent run traces, not ops tracing.)
- Health: api `/healthz` checks DB only (app.ts:133); no `/readyz` (MinIO, edge, github, launcher, worker liveness, migrations version). Worker health = heartbeat file mtime < 30 s (worker/src/healthcheck.ts), which proves the process loop, not that jobs flow. github /healthz returns poll state (`poller.lastRun`) but nothing evaluates staleness. Compose healthchecks only restart nothing (`unless-stopped` does not restart on unhealthy) - there is no autoheal.
- Audit: strong. Append-only `events` with hash chain, `GET /api/v1/audit/verify` (routes/audit.ts, `verifyChain`), categories/outcomes. But not tamper-evident against the host admin (spec 5.5), no external anchoring/WORM export, and verify is on-demand, not scheduled/alerted.
- Alerting hooks: `raiseAlert` (worker/src/alerts.ts) writes deduped system events; failed deliveries notify; users can configure Slack/Teams/webhook/email notifications (area notifications). There is no operator-facing alert channel for platform faults (DB down, worker stalled, outbox dead letters growing, disk full, cert expiry) and no runbook/alert rules.

## 4. Reliability
- Jobs/outbox: DB-backed job queue with leases ("their leases cover a hard kill", worker.ts:90), graceful SIGTERM shutdown, outbox with attempts and a `dead` state, dead-letter creates a failure-notice notification (outbox/dispatcher.ts:170-188). Idempotency-Key support on creates (core/command.ts:69, packages/db/src/idempotency.ts). Reaper reconciles containers/networks/volumes via launcher every minute (handlers/reaper.ts; spec 4.6). Halt/kill enforcement ordered DB -> launcher -> GitHub; README claims <0.5 s edge refusal.
- Missing: no dead-letter replay/inspect tool beyond UI retry of deliveries (a "retry works once fixed" test exists); no job-queue admin (stuck/poison jobs, max-attempts visibility) - not found; no documented behaviour for DB failover/connection loss in the worker (pool 'error' is just logged).
- Dependency-down behaviour: console model checks return `edge_unreachable` with a message (areas/console/model.ts:35,144) so the UI degrades for chat. There is no platform-wide service-status surface: I found no UI/API that reports edge, launcher, github broker, MinIO, or worker state (grep of apps/web/src/shell found nothing). A launcher outage manifests only as failed/stuck runs; worker `depends_on launcher healthy` only gates startup.
- Single points of failure: one of each service, one Postgres, one MinIO, one Keycloak (H2).

## 5. Tenancy, retention, export, admin ops
- Org model: single organisation per deployment (`GANTRY_ORG_ID`, `GANTRY_ORG_NAME`; org_id column on rows plus `gantry_app` role). It is multi-tenant-shaped but not operated as multi-tenant: one realm, one bucket, one GitHub App; no org lifecycle (create/suspend/delete), no per-org quotas. State as single-tenant per install. RLS use on org_id not verified.
- Retention (spec 7.4): defined as proposals but NOT enforced - the only purge implemented is console threads (`purgeExpired`, areas/console/threads.ts, run opportunistically on message send, console/config.ts THREAD_RETENTION_DAYS). No jobs for traces (90 d), runner/build logs (30 d), patches (90 d after close), inbound deliveries/API request log (30 d), or workspace volumes. objdata and events will grow unbounded. 7-year event retention vs. hash chain: no archival/partitioning plan.
- Export: audit has filtered read (cursor) in the UI/API; no bulk export (CSV/JSON/SIEM streaming), no per-user data export/erasure (GDPR-style), no org export.
- Admin ops: roles/teams grant+revoke exist with step-up (routes/people.ts: `people.manage`, `stepUp: true`); stops: halt/kill/restore at factory/project/repo/workorder scope (routes/stops.ts) - good emergency halt. Gaps: no user deactivate/offboard flow in the API (greps found only "disable" for triggers/projects/models; sessions revoke not found); deactivating in Keycloak does not clear Gantry sessions (guess); no key rotation for data_key/session_key/edge_token/launcher_token (manual file edit + recreate, forced logout/loss of encrypted secrets for data_key); API keys exist (areas/apikeys) with mask/fingerprint but rotation UX not verified; IP allow-list exists in security settings (core/app.ts authApi).

## 6. CI
- None: no `.github/`, no other CI config. Root scripts `lint` exists but `grep` finds no lint script in any workspace (the `--if-present` makes `npm run lint` a silent no-op); no eslint/prettier config.
- Current main fails typecheck and 2 tests, which a gate would have caught.
- Required gates: install with `npm ci`; lint; `npm run typecheck`; `npm test` with a postgres:17 service container (GANTRY_TEST_DATABASE_URL); `npm run build`; `npm audit --omit=dev`/OSV + license check; Dockerfile lint (hadolint); build all images, Trivy/Grype scan (fail on high/critical), SBOM + cosign; compose `config` validation; nightly e2e (deploy/smoke.sh + test/e2e journey on a real stack with the test doubles `test/e2e/compose.doubles.yml`); migration test (apply all migrations to a prior-release dump); Dependabot/Renovate; branch protection requiring all of the above.
- Other hygiene: an untracked `undefined/` directory at repo root (git status) - a stray artefact from a bad path variable; delete and gitignore.

## 7. Documentation
Exists: README.md (quick start, layout), deploy/README.md (stack, networks, launcher API, config, Keycloak, first sign-in), deploy/secrets/README.md, spec.md, docs/BUILD.md, ~55 build-notes (developer-oriented per-wave notes).
Missing: operator runbook (backup/restore, upgrade/rollback, cert/secret rotation, scaling, DR, common failure triage and the 3am checklist); production deployment guide (real DNS/TLS, external IdP/Keycloak prod mode, external DB/object store, SMTP); admin guide (roles matrix, onboarding an org, halt/kill procedures, key rotation, user offboarding); user guide (work orders, gates, agents); security whitepaper/threat model hand-off (spec 5.x exists but is internal) and SOC2-style control mapping; data-retention/privacy statement; API reference/OpenAPI (not found); changelog/versioning/support policy.

## Ranked checklist

### P0 (block production)
1. Fix red main: typecheck errors in api (demo.ts import, personas-signin.test.ts rootDir/type) and 2 failing default-deny tests in services/api/test/read-gates.test.ts - investigate as a possible authorization regression before anything else.
2. Add CI (GitHub Actions) with gates in section 6 and branch protection.
3. Replace Keycloak `start-dev`/H2: build an optimized image (`kc.sh build`), external Postgres schema, read_only root, `KC_HOSTNAME` from config, no demo accounts, realm without `gantry-dev` password; set `GANTRY_DEV_DEMO_ACCOUNTS=false` default; remove/guard Mailpit and `/mail/*` route in production profile (e.g. a `compose.prod.yml` override).
4. Backups and restore: scheduled pg_dump/WAL archiving (PITR) off-host, MinIO bucket replication/mc mirror, Keycloak DB, `data_key` escrow; automated restore drill; document RPO/RTO.
5. Versioned, immutable images: build+push `gantry-*:<semver>@sha256`, pin third-party digests, scan/sign in CI; compose uses `${GANTRY_VERSION}`.

### P1 (must fix)
6. Retention enforcement worker job for every spec 7.4 class (traces, logs, patches, deliveries, ws volumes), with pinning rules and an event recording each purge; plan event archival for the 7-year ledger.
7. Observability: `/metrics` (Prometheus) on api/worker/edge (queue depth/age, outbox pending+dead, reaper actions, run counts, SSE clients, pool), `/readyz` covering DB+MinIO+migration version, OTel traces with request id propagated to edge/github/launcher, ship JSON logs to a collector, alert rules (worker heartbeat stale, dead letters > 0, DB/disk, cert expiry, audit verify failure) and an operator runbook. Add an autoheal/orchestrator-level restart on unhealthy.
8. Resource limits (`mem_limit`, `cpus`, `pids_limit`) for every service and a host-capacity formula for MAX_CONCURRENT_RUNS; Postgres tuning.
9. Parameterise public hostname (GANTRY_PUBLIC_URL, KC_HOSTNAME, Caddy site, realm redirect URIs) and support real TLS (ACME or provided cert); add Caddy request size/timeouts (limit the `read_timeout 0` to the SSE path only), rate limits.
10. Admin operations: user deactivate/offboard (revoke sessions + block sign-in + reassign work), secret/key rotation procedures and data_key re-encryption with key ids, session revocation.
11. Platform status surface: an admin "System health" view/API reporting edge, launcher, github broker, worker heartbeat, MinIO, queue lag, last poll; and a banner when degraded.
12. Upgrade story: documented expand/contract migration policy, pre-upgrade backup step, migration test in CI against previous schema, rollback procedure; run >=2 API replicas and confirm SSE fan-out works across instances.

### P2
13. Bulk audit export (JSON/CSV/SIEM syslog/webhook), scheduled `audit/verify` with alert, optional external anchoring of the chain head.
14. Per-user data export/erasure and org export; define tenancy statement (single-tenant per install) or implement org lifecycle.
15. Dead-letter and stuck-job admin tooling (list, replay, purge, max-attempt visibility).
16. Docker-socket exposure: document rootless Docker/socket proxy, evaluate gVisor/Kata/Firecracker runner runtime for non-local deployments; GitHub webhook mode instead of polling.
17. Documentation set from section 7 (operator runbook, prod deploy guide, admin guide, user guide, OpenAPI).
18. Add a lint config and `lint` scripts (eslint + typescript-eslint) so `npm run lint` is not a no-op; fix stale README test count.

### P3
19. Remove stray `undefined/` directory and gitignore it; commit or discard the compose.yml kcdata diff.
20. Self-host fonts (CSP currently allows fonts.googleapis.com / gstatic) for air-gapped enterprises.
21. Secrets files at 0644: supply a 0600 + uid-aligned option by default for non-rootless hosts or move to a secret manager (Vault/SOPS/Docker swarm secrets).
22. Changelog, semantic versioning and support policy.
