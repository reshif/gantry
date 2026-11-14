# progress w3wrk- (gantry-worker)
Plan: services/worker/src: config, clients (launcher, broker, proxy http), runner (job loop + timers), handlers (dispatch, result, publish, merge, stop, timer, github, system), reaper, watchdog, outbox (smtp/webhook/slack/teams), scheduler, main, healthcheck; Dockerfile; test/ (doubles + tests).
Tests: `docker run -d --name w3wrk-pg -e POSTGRES_PASSWORD=pw -p 55471:5432 --tmpfs /var/lib/postgresql/data mirror.gcr.io/library/postgres:17-alpine -c fsync=off -c max_connections=200`
       `cd services/worker && GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55471/postgres npx vitest run`
- [started] nothing written yet
- [done] src: config, errors, clients (http, launcher, broker), deps, alerts, runner (JobRunner), handlers (common, dispatch, result(+publish), merge, stop, misc, reaper/watchdog, teardown), outbox (http proxy client, smtp, dispatcher), scheduler, worker, main, healthcheck, index. Source typecheck: see next line.
- next: fix typecheck, tests (test/ doubles: launcher, broker, proxy/webhook; tests per task list), Dockerfile, S3 bucket ensure (maybe), real launcher+docker stub run, notes
- [done] test infra (db.ts, doubles.ts, world.ts) + test/dispatch.test.ts (5 pass). next: result/publish/F9/watchdog tests (result.test.ts), merge F4, stop, outbox, reaper/scheduler, runner/F7
- [done] test/result.test.ts (7 pass: result, publish, F3, F9, watchdog). next: merge F4, stop, outbox, reaper/scheduler/runner/F7 tests; Dockerfile; notes
- [done] test/merge.test.ts (5, F4), test/stop.test.ts (6, ordering/termination unconfirmed/lost job/lift). next: outbox, runner/F7/scheduler/reaper/chain tests; Dockerfile; typecheck test config; notes
- [done] test/outbox.test.ts (10), test/system.test.ts (11: runner, F7, scheduler, reaper, chain.verify, loops). next: typecheck tests, full run, Dockerfile (+build), run with real launcher + docker, S3 bucket ensure?, notes
- [done] bucket.ts(+test), Dockerfile + Dockerfile.dockerignore written. next: docker build, full test run, real launcher+docker stub run, notes
- [wip] real-stack run: compose project w3wrk (override at scratchpad w3wrk-override.yml, secrets /tmp/w3wrk-secrets, images w3wrk-{api,edge,migrate,worker}:dev); teardown: docker compose -p w3wrk ... down -v; docker rm -f w3wrk-pg; docker rmi w3wrk-*
- [done] real stack run (launcher+edge+api+runner stub adapter) verified and torn down; images/secrets removed. next: final full test run, root typecheck, notes file, final report
- [DONE] all sub-steps. 46 worker tests pass (7 files), typecheck clean (src + test). Real-stack run verified and torn down.
Run tests: start postgres:17-alpine (fsync=off, max_connections=200), `cd services/worker && GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:<port>/postgres npx vitest run`. `npm run build -w @gantry/api` first if @gantry/api/core's dist is stale.
Compose follow-ups (not my files): worker needs HTTPS_PROXY=http://gantry-edge:8444 for slack/teams/webhook egress; launcher template must put run credentials in HTTPS_PROXY (edge notes); worker tmpfs /tmp is where the heartbeat file lives.
