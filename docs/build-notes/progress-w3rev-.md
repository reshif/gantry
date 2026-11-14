# w3rev- progress (wave 3 independent review)
- [ ] 1 typecheck+tests real PG
- [ ] 2 F1-F10 + stop path
- [ ] 3 security
- [ ] 4 15.4 per endpoint
- [ ] 5 fixes
- [x] 1 baseline: build, typecheck green; npm test green (db 52, domain 79, api 254, edge 67, github 44+2 skipped docker, launcher 37, worker 46, web 155). PG: docker w3rev-pg :55491 (GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55491/postgres)
- fixes in progress: edge isPrivateAddress IPv6 forms (+test), proxy allow-list TTL 5s; guardRun stop-fencing supersession (context.ts); next: fenceAttempt same, enforce.resume superseded live attempt, tests
- [x] fixes: guardRun + fenceAttempt treat a stop with a higher fencing (even lifted) as superseding a live attempt; parent epic stops cover child runs; enforce.resume replaces a superseded live attempt. Tests: internal-runs (2 updated/new), github fence (lifted stop), flow-stops (lifted before enforced).
- next: F1..F10 review (idempotency, F4 merge, F5 slots, F6, F7 timers, F9), broker workspace security, webhook signature, 15.4 sweep
- [x] fix F5: expireLeases now dispatches the queue after parking a Build WO in Needs a person (test flow-engine "loses its lease").
- [x] fix I7/8.5: loadPolicyState reads slim project/repo rows (no flow_versions/approver rules/budgets joins); test flow-stops "I7 / spec 8.5" renames 16 flow tables and halts, kills, resumes, restores.
- [x] fix webhook replay: same signed body under a new X-GitHub-Delivery is refused as a replay (audited HOOK-REPLAY); migration 0018 index on payload_hash; test in github.test.ts.
- [x] compose: edge EDGE_RUN_SUBNET follows RUN_SUBNET_POOL (otherwise a changed pool makes runners "system" proxy callers).
- runner/wrapper: typecheck + 23 tests pass (not a workspace; run in runner/wrapper).
- next: github docker tests, final full workspace run, report
- [x] final: npm run build, typecheck, npm test all green (api 258, edge 67, others unchanged); github docker tests 2/2 with GANTRY_GITHUB_DOCKER_TEST=1. w3rev-pg removed. DONE.
  Rerun: docker run -d --name w3rev-pg -e POSTGRES_PASSWORD=pw -p 55491:5432 --tmpfs /var/lib/postgresql/data mirror.gcr.io/library/postgres:17-alpine -c fsync=off -c max_connections=300
         GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55491/postgres npm test
