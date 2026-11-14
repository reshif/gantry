# progress w3fl- (floor, work orders, kill/halt/restore dialogs)

Harness (real api on real postgres, seeded with work orders via the flow test helpers):
  docker run -d --name w3fl-pg -e POSTGRES_PASSWORD=pw -p 55441:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine -c fsync=off -c max_connections=200
  cd services/api; GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55441/postgres npx vitest run test/w3fl-harness.test.ts --testTimeout=0   (serves :8123, prints READY {cookies}; cookie name gantry_session)
  web dev: cd apps/web; GANTRY_DEV_API=http://127.0.0.1:8123 npx vite --port 5199
  delete test/w3fl-harness.test.ts at the end.

Plan: apps/web/src/views/floor/ (kit, belt, board, list, replay, drawers), work-orders/, shell/StopDialogs.tsx, then tests + screenshots.
DONE: (nothing yet) read legacy floor.js/workorders.js/shared.js, API shapes.
DONE (typechecks): shell/StopDialogs.tsx + shell/stopActions.tsx (kill w/ impact, restore, halt dialogs), views/floor/{kit,Belt,Board,Replay,Drawers,moves}.tsx + floor.tsx, views/work-orders/{intake,New}.tsx + work-orders.tsx, Shell.tsx registers newWorkOrder command, ops.submitWO takes an idempotency key.
NEXT: run against real api (browser), fix gaps, screenshots vs legacy (/tmp/claude-0/w3fl-*.png), exercise every control, web tests (mocked fetch), home approvals check, final report.
VERIFIED LIVE (real api): belt/board/list render, move menu + park dialog + drag dry-run, andon halt/resume (project, repo), kill (impact, typed confirm) + restore.
Driver scripts live in the scratchpad (h/drive.mjs + s-*.mjs); a web dev server on :5199 proxies to the harness :8123.
NEXT: drawers (station/gate approve+reject), replay, new work order dialog + classification card, work-orders table, home approvals, then vitest tests (apps/web/src/views/floor.test.tsx etc), screenshots vs legacy.
Tests written + passing: apps/web/src/views/floor.test.tsx (12), work-orders.test.tsx (8), shell/StopDialogs.test.tsx (7); helpers in views/floor/testkit.tsx. Run: cd apps/web && npx vitest run
Live-verified too: drawers (gate reject), replay (enter/scrub/prev/next/span/speed/play/exit), new work order (double click = one WO), reclassify, work-orders table sort/filter/search.
NEXT: approve flows as an approver (p-meera) + home approvals, paging with 70 WOs, swimlanes, factory kill/restore on Home, screenshots vs legacy for work-orders/new-wo/kill, full typecheck + web suite, final report. Delete services/api/test/w3fl-harness.test.ts, docker rm -f w3fl-pg, kill my vite (:5199) + harness (:8123).
FINISHED. Harness removed (test/w3fl-harness.test.ts deleted, w3fl-pg removed, my vite and api stopped). Screenshots: /tmp/claude-0/w3fl-*.png (legacy ones are w3fl-legacy-*.png).
Web: `cd apps/web && npx tsc --noEmit -p . && npx vitest run` (125 pass). Shared files touched: api/ops.ts (submitWO idempotency key arg), shell/Shell.tsx (registers newWorkOrder), App.test.tsx (floor placeholder expectation), shell/stopActions.ts -> .tsx.
Known gaps: GET /projects/{id}/repos, /agents, /mcp/servers, /skills, /projects/{id}/routes are not served yet (stubs) so repo names, agent names, MCP counts, kill-route list degrade; trust tables and the gate rule history in the drawers are links only.
