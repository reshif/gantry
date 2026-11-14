# progress w3flow- (flow engine command side)

Test DB: docker container w3flow-pg (postgres:17-alpine) on :55437.
  export GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55437/postgres
  cd services/api && npx vitest run test/flow-*.test.ts ; npx tsc --noEmit -p .
(if the container is gone: docker run -d --name w3flow-pg -e POSTGRES_PASSWORD=pw -p 55437:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine -c fsync=off -c max_connections=200)

DONE (typechecks):
- migration 0015_flow_engine.sql, core/jobs-contract.ts
- areas/workorders/: model.ts (loader/lockWo/saveWo w/ snapshot no-op), engine.ts (states, slots, attempts, gates, cancelAttempts, bays), conversation.ts, create.ts,
  ctx.ts (begin/guardStop/flowFor/done), intake.ts (submitWO, postMessage, reclassify, decline, parkInto/resumeAt), gates.ts (approve/reject/confirm), moves.ts (move/dryRun/sendBack/park/unpark/reassign/retry/recordSummary), station.ts (applyStationResult, expireLeases, recordMerged, recordNewHead, handleFlowTimer)
NEXT: reads.ts (list, traveler, conversations, record, changes, floor), routes/workorders.ts, routes/floor.ts, areas/stops + routes/stops.ts, home fill, tests (test/flow-*.test.ts), export from core/index.
- reads.ts, routes/workorders.ts written (typecheck ok). NEXT: floor route, stops area+route, home fill, core/index export, tests.
- stops (targets/commands/enforce/reads), routes/stops.ts, routes/floor.ts, migration 0017, core/index exports done. NEXT: home fill, tests (test/flow-*.test.ts), fix issues found.
run tests: sh /tmp/claude-0/-home-user/3bf8cc61-0c99-5cca-957d-e5490300b40f/scratchpad/t.sh test/flow-wo.test.ts
- tests passing so far: test/flow-wo.test.ts, test/flow-engine.test.ts (F1,F2,F3,F5). NEXT tests: F6/I4, command matrix denied+stale, stops, reads/home, station failures
- tests passing: flow-stops.test.ts, flow-engine.test.ts (F1-F6,I4). NEXT: command matrix denied+stale test (flow-commands.test.ts), reads/home/replay/record tests, station failures; then docs/build-notes/wave3-flow.md + typecheck all
- flow-commands.test.ts passing (matrix etc). NEXT: flow-reads.test.ts (list/traveler/floor replay/record/home + gate approve/reject matrix), docs/build-notes/wave3-flow.md, full typecheck+tests
- flow-reads.test.ts passing. NEXT: full suite run, typecheck (src+test), docs/build-notes/wave3-flow.md, cleanup docker w3flow-pg
- DONE: all tests green; notes in docs/build-notes/wave3-flow.md; w3flow-pg removed
