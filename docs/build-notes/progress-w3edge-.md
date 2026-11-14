# w3edge progress
- [done] API internal endpoints (services/api/src/areas/internal/*, routes/internal.ts), test services/api/test/internal-runs.test.ts
- [next] verify API tests; build services/edge (gateway :8443, proxy :8444, trace, tests under services/edge/test), Dockerfile
- [done] edge src written (config,api,gateway,proxy,trace,limiter,usage,secrets-scan,main); [next] tests in services/edge/test, API egress/denied endpoint, Dockerfile
- [done] edge tests (67 pass) + API egress/denied; [next] typecheck, Dockerfile build, notes
- [done] Dockerfile builds and runs hardened (healthz ok); API test 35 pass, edge test 67 pass. Run: GANTRY_TEST_DATABASE_URL=... npx vitest run test/internal-runs.test.ts (services/api); npx vitest run (services/edge). COMPLETE.
