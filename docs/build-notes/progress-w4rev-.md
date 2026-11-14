# w4rev progress
Postgres: docker w4rev-pg on :55497 (postgres/pw). GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@localhost:55497/postgres
Baseline logs: /tmp/claude-0/w4rev-{build,tc,test}.log (build+typecheck green; test run in progress)
Fixes so far:
- runner egress no longer includes MCP hosts (internal/egress.ts, runs.ts, internal-runs test)
- eval promotion gate: label match now requires data.agent (agents/store.ts eligibility) + agents.test case
- web Empty takes id; legacy empty-state ids on agents/integrations/skills/trust/onboarding
Next: wait for baseline tests, rerun api/web after fixes, more security review (trust, learning, chat), fidelity class check
- api typecheck + web typecheck green after fixes; internal-runs/mcp/mcp-e2e/agents tests green
- wave4-mcp.md note updated for the egress fix
- more fixes: API keys always expire (apikeys schemas/commands + test); chat link code kept out of stored idempotent reply and msg (links.ts + notify test); stream.test race fixed
- final: api 539/539 pass, web 350/350, api+web typecheck green. w4rev-pg removed. DONE (report delivered)
