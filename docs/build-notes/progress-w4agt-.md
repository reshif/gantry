# w4agt- progress (agents, skills, instructions)
## Status
- [ ] started: read legacy agents.js/skills.js, spec 8.7/10.2/13.2, existing spec composition (areas/internal/spec.ts), worker dispatch pinTuple
Plan: areas/agents/{schemas,store,read,compose,commands}.ts, areas/skills/*, routes/agents.ts+skills.ts, spec.ts/dispatch.ts use compose, web views/agents.tsx+skills.tsx (+agents/ subfolder), tests.
- [x] migration 0024_agents_skill_order_instructions.sql (agent_skills.position)
PG: docker run -d --name w4agt-pg -e POSTGRES_PASSWORD=pw -p 55511:5432 --tmpfs /var/lib/postgresql/data mirror.gcr.io/library/postgres:17-alpine -c fsync=off -c max_connections=300
Tests: cd services/api && GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55511/postgres npx vitest run test/agents.test.ts
- [x] api: areas/agents/{config,schemas,store,compose,effective,commands}.ts, areas/skills/{schemas,store,commands}.ts, routes/agents.ts+skills.ts, internal/spec.ts uses compose (typechecks). next: core export + worker dispatch pinTuple (pinRunConfig), seed.ts config, api tests (test/agents.test.ts), web ops edits + views
- [x] core export, worker dispatch pinTuple uses pinRunConfig, seed.ts richer agents/skills; api test/agents.test.ts 29 pass. next: run internal-runs + worker dispatch tests, then WEB (ops edits, views/agents.tsx, skills.tsx, tests), live run + screenshots
- [x] worker dispatch test for pin added+passing; worker suite 81 pass; api suites internal-runs/devseed/core pass. next: WEB
- web: ops.ts/queries.ts/types.ts edits done; views/agents/kit.tsx written. next: Config/Instructions/SkillsMcp/Versions/Trust/Create + agents.tsx, skills.tsx, tests
- web: views/agents.tsx + agents/{kit,Config,Instructions,SkillsMcp,Versions,Trust,Create}.tsx typecheck clean. next: skills.tsx, web tests (agents.test.tsx, skills.test.tsx), live run + screenshots, wave4-agents.md, cleanup docker w4agt-pg
- [x] web: views/skills.tsx, views/agents.test.tsx (28 pass), web typecheck clean. next: full web test+typecheck run, live run (api+vite, GANTRY_DEV_SEED, session helper) + Playwright screenshots vs legacy, fixes, wave4-agents.md, rm w4agt-pg
- [x] live e2e done (harness removed); notes written docs/build-notes/wave4-agents.md. next: final full runs (api full, web agents, typecheck all), then rm w4agt-pg and report
- ALL DONE. api full 415 pass (5 failures only in another engineer's models.test.ts, which passes when rerun alone), web 251+ pass, worker 81+1, db 54, domain 106; notes docs/build-notes/wave4-agents.md; w4agt-pg removed; harness removed.
