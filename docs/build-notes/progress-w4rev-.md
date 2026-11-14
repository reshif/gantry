# w4rev progress
Postgres: docker w4rev-pg on :55497 (postgres/pw). GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@localhost:55497/postgres
Baseline logs: /tmp/claude-0/w4rev-{build,tc,test}.log (build+typecheck green; test run in progress)
Fixes so far:
- runner egress no longer includes MCP hosts (internal/egress.ts, runs.ts, internal-runs test)
- eval promotion gate: label match now requires data.agent (agents/store.ts eligibility) + agents.test case
- web Empty takes id; legacy empty-state ids on agents/integrations/skills/trust/onboarding
Next: wait for baseline tests, rerun api/web after fixes, more security review (trust, learning, chat), fidelity class check
