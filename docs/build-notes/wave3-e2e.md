# Wave 3: e2e

## Summary
M3/M4 integration done on the full compose stack (project w3e2e, torn down at the end). Build, typecheck and all workspace tests pass against real Postgres. The browser journey passed end to end through Keycloak, the worker, the launcher, a real runner (stub adapter), the edge, the broker and a fake GitHub. Halt and kill met the spec 4.4 targets by a wide margin, and smoke.sh passed 46 of 46. T1-T8, T10 and T12 pass; T9 passes on the broker side only. Eight integration bugs were fixed (listed in notes). Three sandbox substitutions were needed (MinIO image, runner commits, git in the broker image) and are described in notes.

1. Build, typecheck and tests: `npm run build`, `npm run typecheck` and `npm test` are green across the workspace. The one earlier typecheck failure (a header type in services/api/test/github.test.ts) is fixed. The final run showed the launcher real-Docker integration test failing twice while the compose stack was still up. It passes when run alone (8/8), so it is sensitive to a concurrent stack, not broken. I did not re-run the full workspace test sweep after the last two small web test edits; the traveler suite (13 tests) and the web typecheck pass.

2. Full stack: all images were built (gantry-github needed the sandbox git variant, see notes) and `docker compose -p w3e2e` was brought up healthy (api, web, worker, migrate, launcher, edge, github, ingress, keycloak, mailpit, postgres, minio). gantry-github with a placeholder App key exits at start with a config validation error (fails closed). The E2E used a separate fake GitHub container (services/github/test/e2e/compose.yml). It was never added to deploy/compose.yml.

3. Journey (clean stack, WO-1001, Chore class, ready repo acme/payments-api): sign-in, submit, classify, answer intake, confirm brief, then Plan, Build, Verify, Review and Merge, and Close. A real runner container started per station and talked only to the edge (spec, heartbeat, checkpoint, result). The commit was published, PR #1 was opened on the fake GitHub, and Meera approved G5. The merge was requested and the fake reported merged, and Omar released at G6. The work order ended Done with one commit, one merged PR row and no drift events. Screenshots are /tmp/claude-0/w3e2e-j-01..17-*.png, with the log at /tmp/claude-0/w3e2e/j.log.

4. Halt and kill, measured by probing the edge with the run's own token from inside the runner and polling docker (logs at /tmp/claude-0/w3e2e/s.log). The spec 4.4 targets are 10 s for edge refusal and 60 s for teardown.

| Action | Edge refusal | Container gone | Network gone |
| --- | --- | --- | --- |
| Project halt (2 runs) | 148-267 ms | 0.95-1.5 s | about 1.1 s |
| Work-order kill | 413 ms | 1.1 s | 1.7 s |

Resume started fresh runs with new run ids. The kill left the other work order's run alive, and Restore started a fresh attempt. Screenshots are /tmp/claude-0/w3e2e-s-*.png.

5. Smoke and isolation:

| Test | Result | Notes |
| --- | --- | --- |
| deploy/smoke.sh | PASS 46/46 | |
| T1 | PASS | smoke |
| T2 | PASS | smoke |
| T3 | PASS | smoke |
| T4 | PASS | smoke |
| T10 | PASS | smoke |
| T5 | PASS | in a real launcher-created runner: no docker socket, no /run/secrets, no token or key patterns in env or files. Only `GANTRY_RUN_TOKEN` plus `GIT_CONFIG_KEY_*` names are present. |
| T6 | PASS | every path outside /workspace and /tmp gives EROFS; /workspace and /tmp are writable (after the workspace ownership fix) |
| T7 | PASS | spec, heartbeat, result and model are 403 after the run is stopped, from the control network; the same token was 200 on spec and heartbeat while the run was live |
| T8 | PASS | evil host 403, no credentials 407, link-local address 403, gantry-api:8000 403. `egress.denied` events were audited. |
| T9 | PARTIAL | broker side PASS. The runner side is not runnable here: stub adapter, no git, no tool servers. |
| T12 | PASS | see below |

T9 broker side: a hostile repo (hooks, fsmonitor, diff.external, filter, alias, sshCommand, `.mcp.json`) was planted in the workspace. The publish carried only the committed file, and no marker appeared in the broker or worker /tmp.

T12: 46 state-changing endpoints were called with an under-privileged session (Arjun). None executed, 26 returned 403 with 26 `.denied` audit events added, and the database counts were unchanged. The rest were:
- 422 or 404 on bodies the sweep could not make valid: PATCH policies, saved-views, config, approvers, sessions.
- 404 on payments work-order endpoints, hidden because the caller cannot see that project.

A second pass as Grace (approver on payments) on the work-order endpoints gave 10 denials, and the `messages` endpoint was allowed because the role matrix gives Approver `wo.answer`.

6. Teardown: `docker compose -p w3e2e down -v`, runner containers, ws-* volumes, run-* networks, the w3e2e-pg test database and the extra images I pulled were all removed.

## Public interface
No new runtime API beyond GET /api/v1/projects/{id}/repos (see fix 3). It returns Repo[] with the onboarding stage and halt state, 404 for a project the viewer cannot see, and 401 unauthenticated. The poll facts accept an optional `base: {branch, sha}`, which the API records quietly as repo_config.data.baseSha and baseBranch. Test tooling, never wired into the product, lives under test/e2e/ and services/github/test/e2e/: the fake GitHub, a compose test override, the agent double (selects the stub adapter and commits in the Build workspace), and the journey, halt/kill, isolation and T12 scripts.

## Integration notes
Fixes made, all minimal:

1. services/launcher/src/template.ts now puts the per-run credentials in HTTPS_PROXY (`http://run:<runToken>@gantry-edge:8444`). Without this the edge proxy answered 407 to every runner. The template test was updated.
2. deploy/compose.yml: gantry-github gets the Docker socket, `group_add` DOCKER_GID and GITHUB_HELPER_IMAGE (seed and publish were failing otherwise). gantry-worker gets `HTTPS_PROXY=http://gantry-edge:8444`.
3. Nothing recorded a repo's base commit, so seeding failed with `no_commit`. The broker poll now sends the default branch tip as `base`. facts.ts and store.ts record it quietly as repo_config.data.baseSha and baseBranch; ops.ts sends it. The API and broker each gained a test.
4. `GET /api/v1/projects/{id}/repos` was missing, so the Floor's New work order button said no repo was Ready. It is now served from routes/onboarding.ts, and the onboarding commands still go in that file. The new test is services/api/test/onboarding-repos.test.ts.
5. services/github/Dockerfile now creates `/workspace` owned by 10001. The helper mounts a new ws-<id> volume first and Docker copies its owner, so the volume root was root-owned and the runner could not create files at the repository root (T6 showed EACCES). I verified the fix by running T6 again.
6. apps/web conversations.tsx kept clearing the pending `openConversation` before the new work order was in the list, so answers went to a different work order. It now keeps the request until the work order appears.
7. apps/web traveler/Actions.tsx: Restore on a killed work order locked itself with its own kill ("Restore the wo first"). It now locks only for a wider stop. I added two traveler tests.
8. The test/github.test.ts header type error is fixed.

The sandbox needed three substitutions, all kept out of deploy/compose.yml:

- **MinIO:** quay.io and mirror.gcr.io refused the pinned image. I used `bitnamilegacy/minio:latest` (a real MinIO build, version DEVELOPMENT.2025-05-24) in an override at /tmp/claude-0/w3e2e/override.yml with `entrypoint: [minio]`, the same `server /data` command and a curl health check. The same file points Keycloak at mirror.gcr.io/keycloak/keycloak:26.4. That override is not in the repo.
- **Builds:** compose build secrets need bake permissions here, so images were built with `docker build --secret id=cacert,src=/root/.ccr/ca-bundle.crt` instead.
- **git in the broker image:** the Alpine mirror is unreachable, so I built gantry-github with INSTALL_GIT=false and copied git from alpine/git (the same Alpine release) via services/github/test/e2e/Dockerfile. The local `gantry-github:dev` image is that sandbox variant.

Observed but not fixed:

- The runner exits with code 70 (invalid stub delay) while the attempt stays Running until its lease expires. A retry after about 2 minutes is the existing F9 behaviour.
- Halt keeps the slot reserved as data, but Plan attempts hold no coding slot, so the slot showed free.
- The Floor Belt hides work-order cards when a station is over its WIP, so scripts open the traveler from the Work orders list (`#work-orders`).
- Work orders in a project the caller cannot see return 404, not 403, from the work-order command endpoints. That is by design, but those endpoints produce no `.denied` audit event for the hidden case.
- Dispatch retries three times and then fails the attempt on a broker seed error. A bad base commit therefore surfaces as a failed Plan station, which the Retry button re-queues.

To rerun the E2E: bring up the stack with the override and the fake-GitHub test compose file. Set E2E_TLS_DIR to a directory holding ca.crt, tls.crt, tls.key and bundle.crt (the system CA bundle plus the test CA), and set github_app.json baseUrl to `https://fake-github:8090/api/v3`. Start `node test/e2e/agent-double.mjs` (E2E_T9=1 for T9), then `node test/e2e/journey.mjs <tag>`, `stops.mjs`, `isolation.mjs` and `t12-sweep.mjs`. They read /tmp/claude-0/w3e2e/psql.sh, routes.json and delays.json (stub delay at most 60000 ms). The compose stack itself needs only deploy/compose.yml plus the two overrides above; no other repo changes are required for the runs."

## Unverified
- Real GitHub: only a fake GitHub (REST, git-data, checks, GraphQL, git smart HTTP over TLS with a test CA) was used. App permissions, rate limits, merge rules, rulesets and signed commits were not exercised.
- Real model runs: the dev-seed agents pin a model but no vendor key exists, so the agent double switches each run to the stub adapter. The claude adapter path through the edge (503 without a vendor key) was seen but not completed.
- The runner image here has no git, so the stub makes no commit and the agent double creates the Build commit in the workspace volume. A real agent's commit path and T9 on the runner side were not run.
- Slack, Teams, webhook and SMTP delivery through the edge proxy: nothing produces outbox rows yet, so only the HTTPS_PROXY wiring was added.
- T11 was not run (not asked). MCP gateway is not built (edge returns 501).
- Replay (?at=), multi-replica workers, load and soak, and the 150 s termination-unconfirmed alert with a real undying container.
