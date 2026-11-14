# w4mdl- progress (models, vendors, routing, prices, budgets)
PG: docker run -d --name w4mdl-pg -e POSTGRES_PASSWORD=pw -p 55531:5432 --tmpfs /var/lib/postgresql/data mirror.gcr.io/library/postgres:17-alpine -c fsync=off -c max_connections=300
Tests: GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55531/postgres npx vitest run <file> (cd services/api | apps/web)
## Design
routing body = legacy {defaultModel, overrides(station), fallback, rules} + classOverrides, projects{pid:{defaultModel,overrides,classOverrides,allowedVendors,allowedRegions,allowedRetention,crossModelFallback}}, crossModelFallback(org switch, off)
precedence default<project<station<class. shared resolver areas/models/resolve.ts used by GET /routing/resolve and areas/internal/route.ts.
price_versions.effective_from (nullable, null=published_at). budgets.wo_limit_micros. vendors.config {custom, retention, qualified{station}}. models.data {inPrice,outPrice,tier,custom,canonical}.
## Status
- [ ] started: read all code, design done
- [x] migration 0025, domain types, areas/models/{resolve,prices,store}.ts written. next: schemas, commands, routes, internal route/metering/runs edits, edge fallback, tests, web
- [x] schemas/commands/facts/routes/models.ts, internal route.ts+metering+runs (fallback flag) edited, api typechecks. next: run internal-runs test, write models.test.ts, edge alternates (services/edge gateway.ts+api.ts Route type), then web
- [x] services/api/test/models.test.ts (24) passes; internal-runs 40 pass. next: edge gateway alternates (services/edge/src/gateway.ts, api.ts Route) + edge test, then web views/models.tsx + tests, live run + screenshots, notes wave4-models.md
- [x] edge: gateway.ts alternates/fallback/keyless/body model rewrite, api.ts Route types, test/fallback.test.ts (7), edge 92 pass. next: WEB views/models.tsx (+models/ subfolder) + tests, live run + screenshots, notes wave4-models.md, regression api full + typecheck, cleanup docker w4mdl-pg
- [x] web: views/models.tsx + views/models/{kit,Dialogs,Callout,Vendor,Routing,Policy,Prices}; api ops/queries/keys edits; typecheck clean. next: web test views/models.test.tsx (mock fetch), live run + screenshots, notes wave4-models.md, regressions
- [x] web test models.test.tsx (20) passes. next: live run + screenshots (see wave4-apikeys-triggers.md for harness), notes wave4-models.md, regressions (api full, edge, web full, domain/db), cleanup w4mdl-pg
- TEMP harness services/api/test/zz-w4mdl-harness.test.ts (REMOVE when done), stop file /tmp/claude-0/w4mdl-stop, live json /tmp/claude-0/w4mdl-live.json, api :18211, vite :5311
- [x] live run done (screens /tmp/claude-0/w4mdl-react-*.png vs w4mdl-legacy-*.png); harness removed; CSS block added to styles/views.css. next: full regressions (api, web, db, domain, edge, typecheck), wave4-models.md, remove w4mdl-pg
- [x] notes wave4-models.md written, web 271 pass, domain 106, edge 92. api full run in /tmp/claude-0/w4mdl-api.log. next: confirm api full pass, worker typecheck, remove w4mdl-pg
- ALL DONE. api 420, edge 92, web 271, domain 106, db 55. notes docs/build-notes/wave4-models.md. w4mdl-pg removed; harness removed.
