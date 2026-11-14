# progress w4onb- (repo onboarding)
Status: started. Read BUILD.md, spec 8.6/11.1/11.3, legacy onboarding.js, sim.js ops.
Next: study broker (services/github), worker handlers, api areas/github, then design.
PG: docker run -d --name w4onb-pg -e POSTGRES_PASSWORD=pw -p 55493:5432 --tmpfs /var/lib/postgresql/data mirror.gcr.io/library/postgres:17-alpine -c fsync=off -c max_connections=300
Tests: GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55493/postgres npx vitest run <file> (from services/api etc.)
## Design (decided)
- repos.data.onboarding = current-view doc (legacy shape), written with onboarding_runs/findings/prs/verifications rows by one store module; column onboarding_stage kept in sync.
- Commands (api) only change DB + enqueue jobs; GitHub IO in worker jobs onboarding.assess|open_pr|update_pr|merge|verify|sync via new broker routes /v1/onboarding/*.
- Pure assessment/planning logic in @gantry/domain/onboarding.ts.
- Readiness recheck: scheduler job onboarding.sync for ready repos; definite failure => repo-scope halt cause 'readiness' + stage person; unavailable broker never halts.
## Done
- migration 0020_onboarding_runtime.sql
- packages/domain/src/onboarding.ts (+test, exported from index; built to dist)
## Next
broker onboarding ops (services/github/src/onboarding.ts + routes), api (areas/onboarding + routes/onboarding.ts + readProjects guidelines + seed guideline_versions), worker handlers, web view.
- broker: services/github/src/onboarding.ts + server routes (/v1/onboarding/inspect|pr|merge|canary, /v1/installation/repos), github.ts ops + withInstallation, api.ts fenceOnboarding (-> POST /internal/v1/onboarding/fence on API, TO BUILD), ops.ts mergeCore + gantryCheckPinned; tests test/onboarding.test.ts (17) all pass; fake-github/fake-api extended.
## Next: api (fence endpoint, areas/onboarding, routes, read of guidelines, seed), worker, web.
- domain: judgeCanary, DEFAULT_ORG_GUIDELINES added; types.ts optional fields (finding.required/detail, pr.url/headSha, onboarding.busy/verification/adapter/guidelines); jobs-contract: onboarding.assess|open_pr|merge|verify|sync (queue github)
- api area design: areas/onboarding/{state,commands,apply,guidelines,fence,schemas}.ts; docs: repos.data.onboarding is the current-view doc; apply* functions (exported via core) are the worker's transitions; each re-reads under repo lock and ignores a job whose runId is not the doc's.
- Seeded repos have no github_full_name => never rechecked. Readiness halt: stops row cause 'readiness', set_by 'system'; writes allowed under readiness halts.
- api: areas/onboarding/{state,guidelines,schemas,commands,apply,fence}.ts + routes/onboarding.ts written (typecheck ok, no tests yet); readProjects reads project guideline versions; seed.ts inserts guideline_versions; config.brokerUrl. NEXT: api tests (services/api/test/onboarding.test.ts), worker handlers, scheduler, web.
- api tests DONE: services/api/test/onboarding.test.ts (28 pass). Run: /tmp/w4onb-api.sh test/onboarding.test.ts (sets GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55493/postgres)
- NEXT: full api suite run; worker handlers (services/worker/src/handlers/onboarding.ts + registry + scheduler recurring sync/recheck + broker client methods + config), then web view + screenshots, then docs/build-notes/wave4-onboarding.md
- worker DONE: handlers/onboarding.ts (assess/open_pr/merge/verify/sync), toolchains.ts, broker client methods, scheduler sync, config optional fields; test/onboarding.test.ts 23 pass (run /tmp/w4onb-wrk.sh). NEXT: web view
- web: starting. api: added GET /repos/:id/onboarding/pr (files with added lines), planPr lineDelta/added, ops.saveGuidelines takes Versioned. Web plan: views/onboarding.tsx + views/onboarding/{kit,data,Pipeline,Drawer,Settings,Wizard,Agent}.tsx + views/onboarding.test.tsx
- web DONE: views/onboarding.tsx + views/onboarding/{kit,Settings,Wizard,Pipeline,Drawer,Agent}.tsx; views/onboarding.test.tsx 22 pass; typecheck ok. NEXT: live e2e harness (api+broker+fake github+worker), Playwright screenshots vs legacy, full test runs, wave4-onboarding.md
- live e2e done (api+broker+fake github+worker via temporary harness, removed): connect->assess->PR->request changes->CI green->merge->verify(canary)->Ready->readiness lost->halt->regained->exception->settings->guidelines all exercised in Playwright; screenshots /tmp/claude-0/w4onb-*.png. NEXT: final full test runs, wave4-onboarding.md, remove w4onb-pg
- ALL DONE. Final: domain 106, db 54, github 63(+3 skipped), api 316, worker 77, web onboarding 22 (web suite otherwise passes); notes in docs/build-notes/wave4-onboarding.md; w4onb-pg removed; harness removed.
