# w4ntf- progress (integrations + notifications)
PG: docker run -d --name w4ntf-pg -e POSTGRES_PASSWORD=pw -p 55495:5432 --tmpfs /var/lib/postgresql/data mirror.gcr.io/library/postgres:17-alpine -c fsync=off -c max_connections=300
Tests: GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55495/postgres npx vitest run <file> (cd services/api | services/worker | apps/web)
## Plan
1. db: event observer hook (packages/db/src/events.ts) + migration for deliveries cols + chat link codes
2. api areas/integrations: connectors registry, types/instances routes, test op
3. api areas/notifications: producer (observer), routing, cards, routes/templates/deliveries routes
4. worker: outbox dispatcher slack bot API + in-place update + delivery log
5. hooks: /hooks/slack (signature, replay), identity link, in-chat approval
6. web: integrations.tsx, notifications.tsx + tests; run real + screenshots
## Status
(nothing done yet)
- [x] db event observer (packages/db/src/events.ts), migration 0021, domain types/catalog additions, api notifications/{events,cards,http,slack}.ts, integrations/{connectors,secrets,store,ops}.ts. next: notifications producer/routing, integrations+notifications commands & routes
- [x] notifications routing/emit/producer, integrations commands/links/schemas/runtime/chat-policy, routes/integrations.ts written (not yet compiled). next: notifications commands+routes, hooks/slack, compile, worker, tests
- [x] notifications commands/store/schemas/routes, hooks/slack (slack-hook.ts) written, api typechecks. next: worker dispatcher (slack bot API, update, delivery log, delivery.failed), compose env, api tests, web
- [x] worker dispatcher rewritten (slack bot api, update in place, delivery log, delivery.failed), producer registered in Worker ctor, compose GANTRY_EGRESS_PROXY on api. next: build dist, write api tests (integrations.test.ts, notifications.test.ts, slack-hook), run, then web
- [x] test/integrations.test.ts (8 tests) + test/notify-doubles.ts. next: notify.test.ts (producer/routes/deliveries/hook)
- [x] api tests notify.test.ts (16) + integrations.test.ts (8) pass. chat policy pre-check in slack-hook. next: db observer test, worker delivery tests (test/notify-delivery.test.ts), full api+worker regression, then web
- [x] worker test/notify-delivery.test.ts (7), db events observer tests. next: full regression api/worker/db (logs /tmp/claude-0/w4ntf-*.log), then web views (integrations.tsx, notifications.tsx)
- [x] web: views/integrations.tsx + integrations/{kit,AddDialog,Instance,Tabs}.tsx, views/notifications.tsx + notifications/{kit,Routes,Other}.tsx written, typecheck clean; shared edits: api/ops.ts, queries.ts, keys.ts. next: web tests (mock fetch), real run + Playwright screenshots, full regressions
- [x] web tests (notify.test.tsx 18), screenshots (/tmp/claude-0/w4ntf-*.png), wave4-notifications.md written, harness removed. next: wait for worker/db/domain suites, final checks, remove docker w4ntf-pg
- [x] DONE: api 17+8 notify/integrations tests, worker 77, db 54, web 195, all typecheck clean; docker w4ntf-pg removed; harness removed
