# progress w3gh- (github broker)
Plan: services/github (config, github client, ratelimit, workspace(docker), fence, publish, ops, poller, server, main, Dockerfile, test/ fake GitHub) ; api: areas/github (signature, hooks ingest, events store, fence), routes/internal-github.ts, hooks.ts; migration 0016.
- [done] migration 0016_github_blobs_deliveries.sql
- [done] api areas/github/facts.ts, store.ts (applyFacts). next: fence.ts, signature/hooks/deliveries, routes/internal-github.ts, then broker
- [done] api: fence.ts routes.ts hooks.ts deliveries.ts signature.ts, routes/internal-github.ts+index+hooks wired. next: api tests (test/github-*.test.ts), then broker (services/github)
- [done] api tests test/github.test.ts (15 pass; GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55441/postgres, container w3gh-pg), core export. next: broker services/github
- [done] broker: config ratelimit api github(app+perms) tar git errors workspace(docker helper). next: seed.ts publish.ts ops.ts poller.ts server.ts main.ts Dockerfile, test/fake-github.ts + tests
- [done] broker: seed.ts publish.ts (compile). next: ops.ts (checks, pr-state, draft, merge, protections, deliveries, reconcile) poller.ts server.ts main.ts index.ts Dockerfile, test/fake-github.ts + tests
- [done] broker server/main/index. next: test/fake-github.ts + tests, Dockerfile, docker real tests of workspace store, notes
- [wip] broker tests: test/fake-github.ts fake-api.ts harness.ts written; next test/*.test.ts (broker.test.ts, units), vitest config
- [done] broker tests test/broker.test.ts (33). next: unit tests (tar, limiter, git redact, DockerWorkspaceStore real docker), Dockerfile, typecheck, notes
- [done] units+docker tests (real docker passes). next: Dockerfile, typecheck, notes, cleanup
- [DONE] all sub-steps complete. Dockerfile builds (INSTALL_GIT=false here: apk unreachable) and runs hardened, healthz ok.
Run: broker `cd services/github && npx vitest run` (43 pass, 2 docker tests skipped; GANTRY_GITHUB_DOCKER_TEST=1 runs them against real Docker, uses busybox helper image);
     api `cd services/api && GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55441/postgres npx vitest run test/github.test.ts` (container w3gh-pg, removed at end; recreate: docker run -d --name w3gh-pg -e POSTGRES_PASSWORD=pw -p 55441:5432 --tmpfs /var/lib/postgresql/data mirror.gcr.io/library/postgres:17-alpine).
Compose follow-up (not my file): gantry-github needs the Docker socket + group_add ${DOCKER_GID}, env GITHUB_HELPER_IMAGE=gantry-github:dev (default), a writable /tmp tmpfs; webhook secret lives in integration_instances (type 'github', secret_enc sealed with data_key, aad integration:<id>).
