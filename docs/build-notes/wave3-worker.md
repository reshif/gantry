# Wave 3: worker

## Summary
Built the gantry-worker: job loop with leases, retries and per-queue concurrency, timers, all ten job handlers, the outbox dispatcher, recurring-job scheduling, the wall-clock watchdog, the reaper, a Dockerfile with a heartbeat-file healthcheck, and 46 tests against real Postgres. The container build, typecheck and tests were run. I also ran the worker against the real launcher, edge, API and runner image for one stub-adapter run and a kill, and tore it all down. The weakest part is GitHub: nothing here ran against a real broker or real GitHub. Notification outbox rows are consumed here but nothing produces them yet.

## Public interface
Package @gantry/worker (services/worker). Entry: `node dist/main.js` (no HTTP port). Healthcheck: `node dist/healthcheck.js`. It passes while /tmp/worker-heartbeat (override with WORKER_HEARTBEAT_FILE) was touched in the last 30 seconds. The worker touches it every 5 seconds.

Library exports: `Worker`, `HANDLERS`, `buildDeps`, `JobRunner`, `Scheduler`, `ensureRecurring`, `OutboxDispatcher`, `OutboxPayload`, `proxiedHttp`, `smtpMailer`, `launcherClient`, `brokerClient`, `runIdFor`, `volumeFor`, `reapOrphans`, `wallClockWatchdog`, `reaperSweep`, `loadWorkerConfig`.

Config:
- Secrets are read from files: launcher_token, github_token (the broker token), data_key, minio_root_password.
- Environment: LAUNCHER_URL, GITHUB_BROKER_URL, SMTP_HOST, SMTP_PORT, SMTP_FROM, HTTPS_PROXY (egress proxy for slack, teams and webhook), WORKER_EGRESS_CA, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, RUNNER_VARIANT (default `base`), WORKER_*_CONCURRENCY, WORKER_JOB_LEASE_MS, WORKER_POLL_MS, WORKER_REAPER_EVERY_MS, WORKER_RECONCILE_EVERY_MS, WORKER_VERIFY_EVERY_MS, WORKER_WATCHDOG_EVERY_MS, WORKER_TERMINATION_VERIFY_MS.

Queues consumed: flow, stop, github, system, timers. The `timers` queue holds the jobs `fireDue` makes from due timers. Handlers by job kind:
- `attempt.dispatch`
  - Pins the agent tuple, creates the `runs` row (run id `r-<sha256(attemptId)[:24]>`) and issues the run token. A retry revokes the old token and issues a new one only when no container exists yet.
  - Calls the launcher start with `seedComplete:false`, then the broker seed (only when the repo has a GitHub identity), then the launcher start with `seedComplete:true`.
  - Marks the attempt running with a startup lease.
  - Launcher at capacity re-enqueues the job 15 seconds later without using the retry budget, up to WORKER_MAX_DISPATCH_DEFERRALS.
  - A final failure writes a failed station result through `applyStationResult`.
- `run.result`
  - For a Build result, or any result that reports commits, it publishes through the broker first. The observed head sha and files then go into `applyStationResult` and win over the agent's output.
  - Then it calls `applyStationResult` and tears the run down with `keepWorkspace=false`.
  - A superseded attempt is only torn down.
- `publish`: a standalone re-publish.
- `merge.request` (F4)
  - Records the intent as an event keyed `merge:<wo>:<pr>:<sha>:requested`.
  - Reads the pull request from the broker before every call, including retries. Already merged means no second call and only `recordMerged`. A moved head calls `recordNewHead`.
  - Calls the broker merge.
  - `not_mergeable` is retried, and on the last attempt raises a `github.merge.blocked` alert.
- `stop.enforce`, in order:
  - `reconcileStop`.
  - Cancel queued `merge.request` jobs in scope.
  - Launcher stop on every run in scope, then verify gone. A run still present after WORKER_TERMINATION_VERIFY_MS raises a `run.termination_unconfirmed` alert and the job is retried.
  - For a kill only, the broker failing Gantry check; with `in_flight=cancel` also convert to draft.
  - A `stop.enforced` event.
  - A lifted stop only reconciles.
- `flow.timer` calls `handleFlowTimer`. `github.event` calls `processGithubDelivery`. `github.reconcile` calls the broker `/v1/reconcile` with `{repo, branchPrefix}`.
- `chain.verify` calls `verifyChain`. A break raises a `ledger.chain_broken` event (category config).
- `reaper.sweep`
  - Re-enqueues lost `stop.enforce` from `pendingStops` (dedupe key `stop.enforce:<row>:sweep`).
  - Calls `expireLeases` (F9).
  - Runs the wall-clock watchdog.
  - Removes launcher runs that have no live lease.

Scheduler (all orgs, one job per interval bucket under an advisory lock):
- `reaper.sweep` every 60 seconds.
- `chain.verify` daily.
- `github.reconcile` per repo every 5 minutes.
- The watchdog runs on its own 15-second loop (`Scheduler.watchdog`).

Outbox dispatcher: claims rows for smtp, slack, teams and webhook. The payload schema is `OutboxPayload`:
- `to`, `subject`, `text`, `html`
- `integration`, `url`
- `card`
- `mandatory`
Behaviour:
- Row retry or dead-letter follows `outbox.max_attempts` and the db backoff.
- An unfixable failure dead-letters at once: malformed payload, unknown integration, 4xx other than 408, 425 and 429, or an SMTP 5xx.
- Webhooks carry `x-gantry-signature: t=<unix>,v1=<hmac_sha256(secret, "<t>.<body>")>`, `x-gantry-event` and `x-gantry-delivery`.
- A disabled integration is skipped, except for kill, restore, halt and resume events, which are always delivered.
- The integration secret is opened with the data key (AAD `integration:<id>`, else none). It may be plain text or JSON `{url|webhookUrl, signingSecret|secret}`.
- slack and teams URLs come from `config.url` or `config.webhookUrl`, or from the sealed secret.

## Integration notes
1. Compose (deploy/compose.yml, not my file):
- Add `HTTPS_PROXY: http://gantry-edge:8444` to gantry-worker so Slack, Teams and webhook delivery go through the edge allow-list (it works as a no-credentials system caller). The worker must stay outside 10.213.0.0/16; it is on control and launch, which is fine.
- The worker's /tmp tmpfs holds the heartbeat file. The healthcheck in the image needs nothing else.
- The worker env already has S3_ENDPOINT, S3_BUCKET and S3_ACCESS_KEY. It creates the bucket at boot in the background and does not block jobs while MinIO comes up.
- gantry-worker has no `depends_on` on gantry-github or gantry-edge. Dispatch needs the broker only when a repo has a GitHub identity.
2. Launcher: it must put per-run credentials in HTTPS_PROXY, `http://run:<runToken>@gantry-edge:8444` (edge notes). The worker passes `runToken` unchanged.
3. Shared files: no edits to routes, apps/web, @gantry/domain or services/api/src. I rebuilt dist for @gantry/domain, @gantry/db and @gantry/api, because the worker imports `@gantry/api/core` from dist, so a stale dist breaks typecheck. package-lock.json gained one line: the @aws-sdk/client-s3 dependency on the worker workspace, matching the version already hoisted for the api. No migration was added.
4. What the worker needs from the flow engine and API, all of which exist: `applyStationResult`, `expireLeases`, `recordMerged`, `recordNewHead`, `handleFlowTimer`, `reconcileStop`, `pendingStops`, `issueRunToken`, `revokeRunTokens`, `attemptIsCurrent`, `processGithubDelivery`, and the job contract (`parseJob`, `job`). The worker writes only through these, `appendEvent`, and plain SQL on `runs`, `attempts` (tuple_id, lease), `agent_version_tuples`, `jobs` (cancelling queued merges) and `outbox`.
5. The worker creates the `runs` row at dispatch; nothing else does. The run id is deterministic per attempt, `r-` plus the first 24 hex characters of the SHA-256 of the attempt id, which matches the launcher's id pattern. `runs.data` carries `adapter`, `wallClockSeconds` (from the agent version's limits, default 3600, read by the watchdog) and `dispatch.phase`. A run row pre-inserted with `data.stub` is honoured by the edge spec (used for the real-stack kill test).
6. Attempt lease: at dispatch the worker sets the attempt `running` with `lease_until` = now + 180 s (WORKER_STARTUP_LEASE_MS). If the runner never heartbeats, `expireLeases` fails it (F9). While publishing a result it holds the lease for 15 minutes. The runner's heartbeat via the API then extends it by 90 s each time.
7. Stop path: the API route already enqueues `stop.enforce`. The worker's reaper sweep enqueues it again with dedupe key `stop.enforce:<row>:sweep` for stops whose job was lost. Events written by the worker, all system actor on the system channel: `run.published`, `github.merge.requested`, `github.merge.completed`, `github.merge.blocked`, `stop.enforced`, `run.termination_unconfirmed`, `ledger.chain_broken`. Alerts are deduplicated by event idempotency key, so a minute-by-minute sweep does not flood the ledger.
8. For the notifications engineer: insert `outbox` rows with `enqueueOutbox(tx, {orgId, eventId, destination, payload})` in the event's transaction, with a payload valid for `OutboxPayload`. Set `mandatory: true` on kill and restore. Integration instances hold the Slack or Teams webhook URL in `config.url` or in the sealed secret, and a webhook's signing secret sealed with AAD `integration:<id>`.
9. For the onboarding and GitHub engineer: record each repo's base commit as `repo_config.data.baseSha` (40-hex), or make `github.reconcile` do it. Without it a GitHub-linked repo cannot be seeded for a work order that has no PR or commits yet. Set `repos.github_full_name` as the broker notes say; the scheduler queues `github.reconcile` only for repos with that column set or a name containing a slash.
10. Test setup: `GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:<port>/postgres npx vitest run` from services/worker, on postgres:17-alpine with fsync off and max_connections=200. The suite needs `openssl` for the TLS proxy test. The tests use `bootstrapOrg` with the dev seed and insert work orders and attempts directly. The doubles live in test/doubles.ts. They are test-only and not wired into the product.
11. A work order whose station has no agent or model gets the stub adapter. That adapter is real and deterministic and carries no model. Stations with an agent version that has a model get the claude adapter, so the edge route and a vendor key are required for them.
12. Everything I created with the w3wrk prefix is removed (containers, networks, volumes, images, secrets dir, scratch Postgres). Remaining state is this wave's files in the repo and the shared dist rebuilds.

## Unverified
- Everything that touches GitHub: no broker and no GitHub App key. The worker's seed, publish, gate check, draft, pull-state, merge and reconcile calls ran only against my fake HTTP broker. Its request and response shapes are copied from services/github but never exercised against the real broker. In the real stack the scheduled `github.reconcile` jobs failed with 'fetch failed' because the broker was not running, and retried to their limit.
- Seeding needs a recorded commit, and nothing in the system records one yet. `resolveSeedCommit` uses the PR head, then the work order's latest commit, then `repo_config.data.baseSha` or `repos.data.baseSha`. If none exists and the repo has a GitHub identity, dispatch fails with `no_commit`, which after 3 failures parks the work order at Needs a person. Onboarding or reconcile must write `baseSha`.
- Slack and Teams card formats and real vendor endpoints: delivery is verified against local servers only. Message cards update in place via a stored message reference: not built.
- Outbox rows are consumed here, but nothing produces them yet. Notification routing (event to destination, card templates, conditions, repo overrides) belongs to the notifications area. The payload contract is `OutboxPayload` in `src/outbox/dispatcher.ts`.
- Via SMTP I tested only an SMTP double (EHLO, MAIL, RCPT, DATA, tempfail, reject), not mailpit or STARTTLS or auth. In compose the worker does not have HTTPS_PROXY set, so Slack, Teams and webhooks would go out directly rather than through the edge proxy until it is added.
- The kill-time target (within 60 s) and the 150 s verification window were only observed in one case: one run killed in about 1.3 s. Termination-unconfirmed was tested with a stuck-container double, not a real undying container.
- Real model runs: the real-stack run used the stub adapter. A claude-adapter run needs a vendor key. Runs started by the worker use the stub adapter whenever the agent version has no model.
- Per-run proxy credentials: the launcher does not yet put credentials in HTTPS_PROXY (edge notes), so runners that use the proxy would get 407. The stub run did not use the proxy.
- The object-storage bucket ensure ran only against an S3 double and against a stubbed MinIO in compose (so it logged 'not ready' and retried). Never against real MinIO.
- Multi-replica behaviour is tested with two runner instances in one process and an advisory-lock scheduler, not with two worker containers.
- Load and soak: concurrency, lease heartbeat under load, and very long waits (F8) were not measured.
- The unit tests ran on a throwaway Postgres container with fsync off, not on the compose Postgres.
