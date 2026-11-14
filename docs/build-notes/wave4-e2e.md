# Wave 4 E2E

## Summary
M5 and M6 integration passed on the real compose stack (project w4e2e, torn down at the end). Workspace build, typecheck and tests were green against real Postgres. The only workspace test failure was a worker test typecheck error, now fixed. Every acceptance check passed; the PASS/FAIL list is in notes_for_integration. Four integration bugs were found and fixed; one is a sandbox-only edge switch (default off, listed in notes_for_integration). T11 was not run. M5 acceptance covered the full onboarding path, the stale-click refusal, replay protection, the changed-MCP-definition disable, public API-key submission and the trigger dry run. M6 acceptance covered the budget halt and resume, the model-change eval gate, learning, trust and workload. The console reports that no model is configured. Every nav screen was walked as Factory Admin (23 screens) and Engineer (8 screens) with no console errors, no failed API calls and no placeholder text. deploy/smoke.sh passed 46 of 46 before and after the acceptance runs. Isolation T5 to T8 and the halt/kill timings passed. The T12 sweep over 131 mutating routes executed nothing.

## Verified
- npm run build, npm run typecheck and npm test across the workspace with real Postgres (db 55, domain 106, api 539, edge 98, github 63 with 3 skipped, launcher 37, worker 92, web 350 tests). Edge, github and worker tests and the workspace typecheck were re-run after the fixes and pass.
- Full compose stack up healthy through https://localhost and Keycloak, with a fake GitHub and a fake Slack and MCP server. deploy/smoke.sh passed 46 of 46 before and after the acceptance runs.
- M5 PASS: onboarding, 13 checks. A new repo is refused with 422 at Connected, Assessed and PR opened. Merge is refused while checks are not green. After merge, verification fails closed and the repo needs a person until GitHub is fixed (ruleset requiring the Gantry check, lockfile, pinned toolchain, test script). The re-verify then makes it Ready, and only then does it take work (WO created).
- M5 PASS: a stale Slack card click is refused and the gate stays open. The current card approves as the linked person with channel, chat user and person recorded on the vote, and a click on the closed gate records nothing. A wrong signature and an out-of-window timestamp both return 401. A replayed Slack delivery is a duplicate and creates nothing new (audited as HOOK-REPLAY).
- M5 PASS: a replayed signed custom-webhook delivery returns duplicate:true and creates exactly one work order and one trigger run. A bad signature returns 401.
- M5 PASS: a changed MCP tool description found on rediscovery disables the server (mcp.server.disabled in the ledger). Switching it back on is refused with 409 until an admin re-approves, and re-approval re-enables it.
- M5 PASS: public submission with an API key. A create without Idempotency-Key returns 422. A keyed create returns a work order and the same key replays the same answer with one work order created. The key reads the work order, is refused 403 in another project and on undeclared routes, and a wrong key gets 401. The submit is recorded against the key.
- M5 PASS: a trigger dry run changes no rows. Work order, run, proposal and job counts are identical before and after.
- M6 PASS: budget breach. A usage report over the $0.50 per-work-order cap sets a system halt with cause budget on that work order only. The edge refuses the run's next call with 409 in about 0.2 s, and the run container is torn down about 22 s later (halt grace 20 s). After the cap is raised and the halt lifted, the work order gets a fresh run and the edge serves it.
- M6 PASS: model change. Changing ag-build from Opus to Haiku and snapshotting a version gives 403 EVAL-GATE before any suite run (audited, live version unchanged). After the suite run (RUN-936, score 0.8 against threshold 0.8) the version is eligible and promotes.
- M6 PASS: learning. Drafting is refused while the switch is off (LEARN-SWITCH, audited). After an admin turns it on, the draft changes nothing, the drafter's own accept is refused (LEARN-TWO-PERSON), and a second person's accept applies the skill change as a new version. Rollback restores the text and a declined proposal changes nothing.
- M6 PASS: trust. Levels above L1 are off in a new install. A seeded L2 cell is held to effective level 1. Granting L2 is refused with 403 TRUST-SWITCH. Setting a cell to L0 works and is audited. A Chore work order went to Done with every gate decided by a person and no automatic gate events.
- M6 PASS: workload is non-empty after the journey (5 rows, totals) for the all scope and the project scope, and a hidden project returns 404.
- M6 PASS: console. Status reports no model configured with actions off and a question gets the 'no model is configured' event. Explain still returns the policy trace.
- Every nav screen as Factory Admin (23 screens) and Engineer (8 screens): 0 console errors, 0 failed /api calls, no placeholder text. Screenshots are /tmp/claude-0/w4e2e-screen-<id>.png and w4e2e-screen-eng-<id>.png.
- Isolation T5 to T8 re-run against a launcher-created runner: all pass, same results as wave 3. Halt: edge refusal 0.2 s, container gone about 21 s. Kill: refusal 0.3 s, container gone 0.9 s.
- T12 sweep over every state-changing /api/v1 route (131) as a least-privileged person (arjun): 24 returned 403 (23 `.denied` events added), 27 returned 404 and 80 returned 422. 0 returned 2xx, 0 returned 5xx, and the database counters were unchanged.
- Slack deliveries to the fake Slack through the edge proxy worked (18 sent) once the fake host was on the org's system egress list.

## Notes
PASS/FAIL per check.

PASS:
- Workspace build, typecheck and tests.
- deploy/smoke.sh 46/46 (re-run at the end).
- T1 to T4 and T10 (inside smoke.sh).
- T5, T6, T7, T8.
- T12, no endpoint executed. 24 of 131 mutating routes were returned as 403 with audit; the remaining 107 returned 404 or 422 without executing. Not shown as denied.
- Halt and kill timings.
- All M5 acceptance checks (15.2).
- All M6 acceptance checks.
- The nav walk (23 admin and 8 engineer screens).
NOT RUN: T11.
PARTIAL: T9 (broker side passed in wave 3, not re-run).

Integration bugs fixed (all minimal):
1. services/worker/test/evals.test.ts line 152: possibly-undefined index in the test. This was the only typecheck failure in the workspace.
2. services/github/Dockerfile and Dockerfile.dockerignore: the broker now imports @gantry/domain (onboarding.ts), but the image neither built nor shipped it, so the build failed with TS2307. The build stage now builds domain, the runtime stage copies its dist, and the dockerignore allows packages/domain/src and tsconfig.json.
3. services/api/package.json and package-lock.json: the api and the worker had asked for different nodemailer versions, so npm nested 7.0.10 under services/api and the api image crashed on start with ERR_MODULE_NOT_FOUND 'nodemailer'. Raised api to ^7.0.13 so the lock deduped (flock npm install).
4. services/edge/src/config.ts: new env EDGE_ALLOW_PRIVATE_UPSTREAMS, default false and sandbox-only. Without it neither the proxy nor the MCP gateway can reach a fake Slack or MCP server in the compose network, because the SSRF guard blocks private addresses. This is a product-code addition that weakens the guard only when set. Revert it if you would rather not carry it. Nothing else depends on it.

To rerun: bring up with deploy/compose.yml plus the sandbox override (MinIO and Keycloak mirrors, build secret), services/github/test/e2e/compose.yml and test/e2e/compose.doubles.yml. The doubles override also sets WORKER_CANARY_WAIT_MS=20000 and the fake-Slack and MCP environment variables. Start test/e2e/agent-double.mjs with delays of at most 55000 ms; the stub exits 70 above 60 s. Org setting `egress.systemHosts` must contain fake-slack. Then run m5.mjs, m6.mjs, walk.mjs and t12-all.mjs. The fake GitHub repo alias for onboarding is acme/billing-core.

Observations, not fixed:
- Onboarding verification takes the canary wait (default 120 s) per verify.
- The broker's poll warns every 5 s per repository it cannot see, 12533 warnings in this run (fake GitHub had one installed repository). A repository that stays 404 should back off.
- github.reconcile jobs for seeded demo repos fail permanently with 404 on a fake that does not have them.
- Failed deliveries with 'no slack/teams/webhook connection is open to this project' are expected before connections exist.
- Chat-click replies only reach Slack through response_url, which the fake handled.
- The agent-double still commits in the Build workspace because the runner image has no git.
- Several dev-seed agents are not routable to a model without a vendor key: an eval run hit 'No API key is configured for vendor anthropic' on some cases when the stub switch raced the dispatch.
- The Trust seed has L2 cells while the levels-above-L1 switch is off; they are correctly held to effective L1.

Teardown done: compose project w4e2e (down -v), runner containers, volumes, run networks, the w4e2e-pg Postgres container, the gantry-github-nogit:dev image I created, and the stray anonymous volumes. No containers, volumes or networks remain. The gantry-*:dev images were rebuilt in place (same tags as before). Progress log: docs/build-notes/progress-w4e2e-.md.

## Unverified
- T11 (prompt injection to exfiltrate or push elsewhere) was not run. It needs a model-driven agent, and the runners here use the stub adapter. The egress deny paths (T8) and broker-side hostile-repo handling (T9, wave 3) are the nearest coverage.
- T9 broker side was not re-run this wave. It needs the hostile-repo journey with E2E_T9=1.
- Real GitHub and a real GitHub Enterprise Server were not used. Everything GitHub-side ran against the fake, including the `workflows` and administration App permissions, ruleset field names, integration_id pinning and the canary rejection message. Onboarding fails with 502 until the App has `workflows` write.
- No real model vendor. The budget breach was driven by the harness acting as the edge and reporting usage with the edge service token, not by a vendor call through the gateway. Seeded Anthropic is a fixed-endpoint vendor, so a fake https vendor was not wired in.
- Eval results are stub-adapter output mixed with 'No API key' failures on some cases. The 0.8 score that cleared the gate says nothing about a model.
- The MCP changed-definition disable was exercised via rediscovery, not at call time through the runner-facing /mcp/v1 gateway with a live agent.
- L0 shadow behaviour at a live gate was not observed. A cell was set to L0 and audited, and the journey showed L1 behaviour (a person decides every gate). The journey did not go through the L0 cell.
- T12 coverage is weak for the 80 routes that returned 422: body validation ran before the permission check, so those were not shown denied. They are covered by per-area denied-case unit tests.
- Multi-replica, load and soak, and the real SMTP relay were not exercised. Slack interactivity and slash-command URLs were not tested against real Slack, and Teams has no delivery path.
- Only the fake-Slack/egress delivery path was exercised for outbound chat. The seeded notification routes record 'no connection' failures for webhook, Slack and Teams before connections exist.
