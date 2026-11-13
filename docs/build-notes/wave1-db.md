# Wave 1: db

## Summary
Built @gantry/db against a real Postgres 17: 10 ordered SQL migrations (about 107 tables per spec 7.3 plus events, jobs, timers, outbox), a checksummed migration runner and gantry-migrate CLI, the TS data layer, a dev seeder, and the gantry-migrate Docker image. 52 vitest tests pass against real Postgres, typecheck is clean, and the image ran twice against it and exited 0 both times (second run applied nothing). Containers and network are removed.

## Public interface
Package @gantry/db (ESM). Everything is exported from src/index.ts.

Result, secrets, crypto
- Result<T,E>, ok(v), err(e) — same shape as @gantry/domain's Result, defined locally.
- readSecret(name, env?): Promise<string>. Reads $GANTRY_SECRETS_DIR (default /run/secrets)/<name>, strips one trailing newline, throws SecretError{reason: invalid_name|missing|unreadable|empty}.
- loadDataKey(env?): Promise<Buffer>. Reads the data_key secret (hex or base64, 32 bytes).
- encrypt(plaintext, key, aad?): string. AES-256-GCM envelope "v1.iv.tag.ct".
- decrypt(envelope, key, aad?): Result<string, "malformed"|"unsupported_version"|"authentication_failed">.
- mask(secret), fingerprint(secret), parseDataKey(text).

Pool and transactions
- createPool(role: "app"|"owner", {env?, max?, applicationName?}): pg.Pool. Uses DATABASE_HOST, DATABASE_NAME and optional DATABASE_PORT. Users default to gantry_app / gantry_owner; override with DATABASE_APP_USER / DATABASE_OWNER_USER. Passwords come from the db_password / db_owner_password secret files, read per connection.
- withTx(pool, fn: (tx: Tx) => Promise<T>, {isolation?: "serializable"|"read committed", attempts?=5}): Promise<T>. Retries on 40001 and 40P01, so fn may run more than once.
- Types: Tx = pg.PoolClient, Queryable (anything with query).

Events
- appendEvent(tx, EventInput): Promise<{id, seq, hash, prevHash, recordedAt}>.
- EventInput fields: orgId, type, category, actor, channel, plus optional onBehalfOf, subject{type,id}, projectId, woId, woVersion, outcome, rule, before, after, commandId, idempotencyKey, causationId, sessionId, sourceIp, requestId, occurredAt.
- verifyChain(db, orgId): Result<{count, headSeq, headHash}, ChainBreak>. Break kinds: seq_gap | prev_hash_mismatch | hash_mismatch | tail_mismatch. It works as gantry_app.
- EVENT_CATEGORIES, EVENT_CHANNELS, EVENT_OUTCOMES.

Jobs, timers, outbox
- Jobs: enqueue(db, {orgId, kind, payload?, queue?='default', priority?, runAt?, maxAttempts?=5, dedupeKey?}) -> {id, deduped}.
- Jobs: claim(db, {workerId, leaseMs, queues?, limit?=1}) -> Job[]. Uses FOR UPDATE SKIP LOCKED and reclaims expired leases.
- Jobs: heartbeat(db, id, workerId, leaseMs) -> boolean; complete(db, id, workerId, result?) -> boolean.
- Jobs: fail(db, id, workerId, error, {retry?, backoff?}) -> {status: "queued", runAt} | {status: "dead"} | {status: "lost"}.
- Timers: schedule(db, {orgId, kind, fireAt, subject?, payload?, dedupeKey?}) -> {id, created}.
- Timers: cancel(db, {id} | {orgId, dedupeKey} | {orgId, subject, kind?}) -> number.
- Timers: fireDue(tx, limit=100) -> number. It turns due timers into jobs on queue 'timers', with job kind = timer kind and payload {timerId, subject, ...payload}.
- Timers: nextFireAt(db).
- Outbox: enqueueOutbox(db, {orgId, eventId, destination, payload?, maxAttempts?}) -> {id, created}.
- Outbox: claimOutbox(db, {workerId, leaseMs, destinations?, limit?}); markDelivered(db, id, workerId); markFailed(db, id, workerId, error, backoff?) -> "pending"|"dead"|"lost".

Idempotency (exported as the `idempotency` namespace)
- idempotency.begin(tx, {orgId, scope, key, body}) -> {state: "new"} | {state: "replay", status, response} | {state: "conflict"}.
- idempotency.storeResult(tx, key, status, response).
- idempotency.idempotent(tx, k, fn) wraps begin and storeResult.
- idempotency.purgeExpired(tx).
- Also exported at top level: hashBody(body), canonicalJson(v).

Migrations
- loadMigrations(dir), migrate(client, files) -> Result<{applied, alreadyApplied}, MigrateError>, setAppPassword(client, pw), scramVerifier(pw).
- A migration whose first line is "-- migrate:login-role" runs as the login role instead of gantry_owner.

Seeding
- seedDevOrg(tx, SeedState) -> {orgId: uuid, created: boolean}. Idempotent on the org slug (state.org.id becomes orgs.slug). SeedState is a loose, legacy-shaped input type exported as SeedState (with SeedPerson, SeedProject and so on).

CLI / container
- node packages/db/dist/bin/migrate.js, image gantry-migrate. Environment: DATABASE_HOST, DATABASE_NAME, optional DATABASE_PORT, DATABASE_OWNER_USER (default gantry_owner), GANTRY_MIGRATIONS_DIR (default ../../migrations relative to dist/bin).
- Secrets: db_owner_password (login) and db_password (becomes the gantry_app password).
- Exit codes: 0 on success, 1 on failure or a refused migration, 2 on missing configuration.

## Integration notes
1. Schema conventions.
- Entity tables use a primary key of (org_id, id) with text ids in the legacy style, and composite foreign keys such as (org_id, project_id) -> projects(org_id, id).
- Queue tables (jobs, timers, outbox) use a globally unique text id.
- orgs.id is a uuid; the legacy org id ('acme') is stored as orgs.slug. Callers get the uuid back from seedDevOrg.
- High-volume logs (run_usage, usage_meter, mcp_calls, api_requests, signins) use bigint identity ids.
- Version-valued fields are ints. The legacy semver labels ("1.4.0") are kept inside the version rows' body jsonb as label.
2. Immutable versioned tables: flow_versions, role_matrix_versions, policy_versions, approver_rule_versions, agent_versions, skill_versions, instruction_versions, guideline_versions, routing_versions, price_versions, trust_criteria_versions, security_settings. A row is a mutable draft until published_at is set. After that, UPDATE and DELETE raise SQLSTATE 23000. Publishing means inserting a new version row (with published_at) and then moving the head pointer on the parent table (projects.current_flow_version, agents.live_version, policies.current_version, approver_rules.current_version, skills.live_version).
3. Events are written only via appendEvent in the command transaction. A bad category, channel or outcome raises 23514. A denied or forbidden update raises 42501. The events table has a trigger that also blocks UPDATE, DELETE and TRUNCATE for the owner; tampering tests disable it with ALTER TABLE events DISABLE TRIGGER events_no_update_delete.
4. The event hash covers (id, org_id, seq, prev_hash, occurred_at, recorded_at, type, category, actor, on_behalf_of, channel, subject, project_id, wo_id, wo_version, outcome, rule, before, after, command_id, idempotency_key, causation_id, session_id, source_ip, request_id). It is computed by the SQL function gantry_event_hash(events). The verifier shares that function, so a daily verifier job can call verifyChain(db, orgId) as gantry_app.
5. Outbox rows reference events(id), a uuid. enqueueOutbox needs the id that appendEvent returns, so call it in the same transaction as appendEvent.
6. Timers: the worker loop should call fireDue(tx) inside withTx, then claim(db, {queues: ['timers', ...]}) for the resulting jobs. nextFireAt() tells it how long to sleep.
7. Attempts carry a global fencing number: attempts.fencing is a bigint default nextval('attempt_fencing_seq'), unique. The stops table has a partial unique index allowing only one active stop per scope and mode.
8. Compose wiring:
- gantry-migrate runs as a one-shot service with DATABASE_HOST=postgres and DATABASE_NAME.
- Secrets db_owner_password and db_password go in /run/secrets. If POSTGRES_USER is gantry_owner (a superuser), DATABASE_OWNER_USER defaults correctly. Otherwise set DATABASE_OWNER_USER.
- Services depend_on migrate with condition service_completed_successfully.
- Healthcheck is not applicable (it exits).
- Postgres is only needed with the pgcrypto extension, which postgres:17-alpine ships.
9. Docker build behind a TLS-intercepting proxy: add --secret id=cacert,src=<ca-bundle.crt>. It is optional and used only for npm ci. packages/db/Dockerfile.dockerignore (BuildKit per-Dockerfile ignore) restricts the context to the db package, root manifests and packages/domain/package.json. If new workspaces are added, nothing changes here, because npm ci -w @gantry/db only needs workspaces the lockfile references; it passed with just db and domain manifests present.
10. Tests: set GANTRY_TEST_DATABASE_URL to a superuser connection; the helper creates and drops a throwaway database per test file. Without it, DB tests are skipped. vitest runs files serially because roles are cluster-wide. Other workspaces needing a DB can import createTestDb from packages/db/test/helpers.ts only by copying it; it is not exported from the package.
11. Dependencies: @gantry/domain stays in package.json (it was already there, and removing it would desync the lockfile) but is not imported at runtime. packages/db/package.json now has typecheck covering test/, and files: [dist, migrations].
12. Note: packages/domain/tsconfig.json shows as modified in git status, but that came from another engineer, not from this work.

## Unverified
- Running against the compose Postgres with POSTGRES_USER=gantry_owner as superuser: only the postgres-superuser plus SET ROLE path was run, not that exact setup
- Building the image without the optional --secret id=cacert flag. It was only built with the sandbox CA passed through, because the sandbox TLS-intercepts npm
- Full-chain verifyChain performance on very large event tables. The scan runs in SQL with window functions but was only run on tens of rows
- seedDevOrg against the real @gantry/domain devSeed output. It uses its own minimal input type and was tested with a hand-written legacy-shaped fixture
- Row-level security: not implemented, tenant isolation relies on org_id and composite foreign keys
- Retention and purge jobs. gantry_app has full DML on log-like tables such as usage_meter and api_requests; only events and gate_decisions are INSERT and SELECT only
