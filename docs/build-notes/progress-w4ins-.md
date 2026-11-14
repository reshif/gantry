# w4ins- progress (learning + workload)
PG: docker run -d --name w4ins-pg -e POSTGRES_PASSWORD=pw -p 55531:5432 --tmpfs /var/lib/postgresql/data mirror.gcr.io/library/postgres:17-alpine -c fsync=off -c max_connections=300
Tests: cd services/api && GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55531/postgres npx vitest run test/learning.test.ts test/workload.test.ts
## Plan
1 migration (findings/proposals columns, status set) 2 areas/learning/{config,schemas,signals,findings,store,apply,commands}.ts + routes/learning.ts 3 areas/workload/* + routes/workload.ts 4 worker job learning.refresh 5 api tests 6 web ops/queries/types + views learning.tsx workload.tsx + tests 7 live run + screenshots 8 notes wave4-insight.md, rm w4ins-pg
## Done
(nothing yet)
- [x] migration 0027_learning_findings_proposals.sql (status map: open=proposed, applied=accepted, rejected=declined, +verified, rolled_back)
- plan decisions: switch at orgs.settings.learning.proposals; db status map; endpoints: GET /learning/{findings,proposals,signals,settings}, POST /learning/findings/refresh, POST /learning/proposals, POST .../{id}/{accept,decline,verify,rollback}, PUT /learning/switch; workload returns server-computed suggestions
- [x] api areas/learning/* + routes/learning.ts + worker learning.refresh (jobs-contract, scheduler, worker.ts, core export) typecheck. next: workload api, tests, web
- [x] api areas/workload/{compute,suggest}.ts + routes/workload.ts typecheck. next: api tests (test/learning.test.ts, workload.test.ts), then web
- [x] api tests test/learning.test.ts (30) + test/workload.test.ts (7) pass. next: worker test for learning.refresh, web ops/queries/types + views + web tests, live run
- [x] worker test/learning.test.ts + fixed system.test scheduler count (trust.evaluate+learning.refresh). next: WEB
- [x] web: api types/keys/queries/ops edits, ui/SortTable.tsx, views/learning.tsx + learning/{kit,Proposals,Findings,Signals,Draft,Dialogs,focus}.tsx typecheck. next: workload view, learning.css additions, web tests, live run + screenshots
- [x] web: views/workload.tsx + workload/{kit,Tabs,Drawer,Delegate}.tsx typecheck; css additions. next: web tests (learning.test.tsx, workload.test.tsx), run, live run + screenshots
- [x] web: views/learning.test.tsx (14) pass. next: views/workload.test.tsx, live run+screenshots, notes
- [x] web tests learning (14) + workload (9) pass; useWorkload keeps previous data. next: full web test run, live run+screenshots, notes, cleanup
- live harness: services/api/test/zz-w4ins-harness.test.ts (DELETE when done); log /tmp/claude-0/w4ins-harness.log; sessions /tmp/claude-0/w4ins-session.json; vite on :5321 (GANTRY_DEV_API=<api>)
- fixed: model.ts passed gates now carry waitingSince (workload response time was always empty). ledger: api/web/worker tests added. next: restart harness for final screenshots, exercise workload controls, full test runs, notes, cleanup (harness file, vite, w4ins-pg)
- live run done (harness deleted, vite stopped). screenshots /tmp/claude-0/w4ins-{legacy,react}-*.png. next: full typecheck + tests, notes wave4-insight.md, docker rm w4ins-pg
- ALL DONE. api (excl. other engineer's harness) 512/513 pass (stream.test flaky under load, passes alone), domain 106, worker system+learning 12, web learning 14 + workload 9 (full web run: only others' failures); notes docs/build-notes/wave4-insight.md; w4ins-pg removed; harness deleted.
