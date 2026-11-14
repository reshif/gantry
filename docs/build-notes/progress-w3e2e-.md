# w3e2e progress
- [x] 1 build/typecheck/test all green (fixed test/github.test.ts header type). Tests: GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres (container w3e2e-pg, postgres:17-alpine fsync=off) ; npm test
- [ ] 2 compose up project w3e2e
- [x] 2 stack up (project w3e2e). Files: /tmp/claude-0/w3e2e/{override.yml (minio=bitnamilegacy/minio:latest, keycloak mirror), build.sh, dc.txt (compose cmd), secrets/}. Fake GitHub: services/github/test/e2e/{compose.yml,fake-server.mjs,Dockerfile}.
  Env: GANTRY_SECRETS_DIR=/tmp/claude-0/w3e2e/secrets DOCKER_GID=996 GANTRY_DEV_SEED=true ; DC=$(cat /tmp/claude-0/w3e2e/dc.txt)
- fixes so far: launcher HTTPS_PROXY creds (template.ts+test), compose github docker socket + worker HTTPS_PROXY, test/github.test.ts header type
- Fixes: github poll records repo_config.data.baseSha (facts.base, store.ts, ops.ts + tests); GET /projects/:id/repos in routes/onboarding.ts (Floor needs a Ready repo); fake GitHub is https (tls dir /tmp/claude-0/w3e2e/tls, E2E_TLS_DIR) and mirrors API-created objects into its bare repo.
- Test doubles (test dirs only): test/e2e/agent-double.mjs (selects stub adapter + delay on runs, commits in Build workspace since runner has no git and stub makes no commits), services/github/test/e2e/*.
- Scripts: /tmp/claude-0/w3e2e/{env.sh,rebuild.sh <svc..>,st.sh,psql.sh}; test/e2e/journey.mjs (Playwright full journey). Run: node test/e2e/agent-double.mjs & ; node test/e2e/journey.mjs j1
- [x] 3 journey PASS on clean stack (WO-1001 chore): screenshots /tmp/claude-0/w3e2e-j-*.png, log /tmp/claude-0/w3e2e/j.log. 46/46 smoke.sh PASS (log smoke.log).
- [ ] 4 halt/kill: node test/e2e/stops.mjs s (delays.json long); [ ] 5 isolation T5-T9,T12; [ ] 6 teardown
- also fixed: web conversations.tsx keeps pending openConversation until the WO is in the list (selection jumped to another WO).
- [x] 4 halt/kill measured on stack (logs /tmp/claude-0/w3e2e/s.log; shots w3e2e-s-*.png). Fixes: traveler Restore button locked itself for a killed WO (Actions.tsx).
- [ ] 5 T5-T9 (in-runner probes), T12 (route sweep), [ ] 6 teardown
- [x] 5 T1-T4,T10 (smoke.sh, 46/46), T5-T8 (test/e2e/isolation.mjs against a launcher-created runner), T9 broker side (journey with E2E_T9=1), T12 (test/e2e/t12-sweep.mjs). T9 runner side not runnable (stub adapter, no git in the runner image).
- [x] 6 torn down (compose project w3e2e, runner containers/volumes/networks, w3e2e-pg, extra pulled images). gantry-github:dev locally is the sandbox variant (git copied from alpine/git, services/github/test/e2e/Dockerfile).
- E2E scripts read /tmp/claude-0/w3e2e/{psql.sh,routes.json,delays.json}: recreate psql.sh (docker exec postgres psql as gantry_owner) to rerun.
