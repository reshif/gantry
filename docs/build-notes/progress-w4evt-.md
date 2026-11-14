# Progress w4evt- (evals and trust)
Started. Done: read BUILD.md, spec 13, legacy views. Next: read legacy ops (insight.js, ops3.js), design, build api areas/evals, areas/trust, worker handlers, web views.
## Design decisions (w4evt-)
- Eval cases run as hidden carrier work orders (work_orders.source='eval', state done, hidden from reads) + an attempt + the existing attempt.dispatch handler; run.result branches for eval attempts (grade, no publish). Own cap via orgs.settings.evals.maxConcurrent, jobs priority negative.
- Trust cells in trust_cells (id agent|cls|project[|repo], level 'L1'), history = trust_grants rows, evidence computed live from gate_decisions; criteria versioned in trust_criteria_versions body {criteria,sampleRate,soakDays}; switch orgs.settings.trust.levelsAboveL1 (off).
- Migration needed: outcomes.attribution, trust_ceilings data/enabled.
## Status log
PG: docker run -d --name w4evt-pg -e POSTGRES_PASSWORD=pw -p 55510:5432 --tmpfs /var/lib/postgresql/data mirror.gcr.io/library/postgres:17-alpine -c fsync=off -c max_connections=300
Tests: GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55510/postgres npx vitest run <file> (cd services/api | services/worker | apps/web)
- [x] migration 0026_evals_trust_runtime.sql
- [x] api areas/trust/{config,store,record,commands,schemas,read}.ts, areas/evals/{scorecards,checks}.ts written (untyped-checked)
- next: areas/evals/{engine,commands,store,schemas}.ts, routes evals.ts + trust.ts, engine.ts hooks (recordDecision trust level, openGate trustDecision, finish afterFinish), worker (eval.dispatch handler, run.result eval branch, dispatch.ts pin override, reaper), seed, web, tests
- [x] api areas/evals/{engine,commands,store,schemas,scorecards,checks}.ts + areas/trust/* + routes/evals.ts + routes/trust.ts (typecheck clean)
- [x] engine hooks (workorders/engine.ts recordDecision/openGate/finish/G3G3s; model.ts/reads.ts/home/state.ts/metrics.ts hide source='eval'; station.ts expireLeases+applyStationResult guards; agents/store.ts eligibility ignores override runs), jobs-contract eval.dispatch + trust.evaluate, core/index.ts exports
- [x] worker handlers/evals.ts (+dispatch.ts pin override, common.ts eval commit, result.ts eval branch, reaper.ts eval sweep/watchdog, worker.ts HANDLERS, scheduler.ts trust.evaluate daily)
- next: domain types, dev seed (suites/cases/cells/criteria/ceilings), api tests (services/api/test/evals.test.ts, trust.test.ts), worker test (eval run end to end with fake launcher), web (evals.tsx, trust.tsx, queries/ops), run live + screenshots, notes doc docs/build-notes/wave4-evals-trust.md
- [x] domain types extended; dev seed (suites/cases/runs/trust, bootstrap seedEvals opt, startApp seedEvals default false); worker publishChange on eval transitions
- [x] api tests written: services/api/test/trust.test.ts, evals.test.ts (NOT yet run: another engineer's migration 0027 was broken (quote-stripped) at the time; rerun when fixed)
- [x] web: api/{ops,queries,keys}.ts edits; views/evals.tsx + views/evals/{kit,Scorecards,Suites,Factory}.tsx written (typecheck clean)
- next: views/trust.tsx (+ trust/ folder), web tests (evals.test.tsx, trust.test.tsx), run api tests, worker e2e test, live run + screenshots, notes doc
- [x] FIXED other engineer's broken migration 0027 (quote-stripped defaults) so DB tests run. api tests PASS: trust.test.ts (33), evals.test.ts (22); worker test/evals.test.ts (9) PASS (world.ts seedEvals:false)
- next: views/trust.tsx (+trust/ folder), web tests (evals.test.tsx, trust.test.tsx), full regressions (api/worker/db/domain/web), live run + screenshots, notes doc docs/build-notes/wave4-evals-trust.md, rm w4evt-pg
- [x] web views/trust.tsx + views/trust/{kit,Ladder,Tabs}.tsx; web tests evals.test.tsx (15) trust.test.tsx (18) pass; worker evals.test.ts (9) pass
- next: full regressions (api, worker, db, domain, web + typecheck), live run + screenshots, fix gaps, notes doc docs/build-notes/wave4-evals-trust.md, rm w4evt-pg
- ALL DONE. api 514, worker 91/92 (onboarding toolchains test flaky under load, passes alone), db 55, domain 106, web 327. Notes: docs/build-notes/wave4-evals-trust.md. Harness removed (backup in /tmp/claude-0/w4evt-pw), w4evt-pg removed.
