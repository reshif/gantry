# Wave 3 review

## Fixed
- Stops did not fully supersede attempts at the edge or the broker. guardRun (services/api/src/areas/internal/context.ts) and fenceAttempt (services/api/src/areas/github/fence.ts) only looked at stops still in force. The engine's own rule (attemptIsCurrent, and the comment in migration 0015) is that any stop set after an attempt began supersedes it, even after the stop is lifted. So a halt that was resumed before the worker enforced it left the old run's token working for model calls, heartbeats and spec at the edge, and its publish was accepted. Both checks now refuse in that case, as superseded. Heartbeat, checkpoint and result still pass while a halt is in force, so the run can save its state. Tests: internal-runs (the T7 test was updated, because it had asserted the gap, and one test is new), and the github fence test now covers a lifted stop.
- A stop on a parent epic did not cover its child's runs at the edge or at the broker fence (spec 9.6). RunCtx now carries parentId, and activeStopsFor, guardRun and stopFor include the parent. Test: internal-runs, the epic case.
- Resuming after a halt that was lifted before it was enforced (stops/enforce.ts resume()) saw the old attempt as live and did not start a fresh one. The work order then sat on a superseded attempt until its lease ran out, which also used up one of its bounded retries. Only attempts newer than the stop now count as live, and the fresh attempt replaces the old one. Test: flow-stops, "a halt lifted before it was enforced".
- F5: when the last lost lease parked a Build work order in Needs a person, expireLeases (workorders/station.ts) freed its slot but never handed it to the queue. Queued work waited until some unrelated command came along. It now calls dispatchQueued. The new test in flow-engine fails without the fix and passes with it.
- I7 and spec 8.5: the stop path failed with a 500 when the flow_versions table was unavailable. loadPolicyState (core/read/state.ts) read full projects, including flow versions, approver rules, notification routes and budgets. It now reads only the project and repo columns the decision point uses. Test: flow-stops "I7 / spec 8.5" renames 16 flow-engine tables (work_orders, attempts, runs, slots, gates, jobs, timers, outbox, flow_versions, approver_rules and others), then halts, kills, resumes and restores. Before the fix it returned 500.
- Webhook replay: GitHub signs the body but not X-GitHub-Delivery, so a captured signed body sent again under a new delivery id was accepted and processed. hooks.ts now refuses the same payload hash under a different delivery id. The refusal is audited as github.hook.denied with rule HOOK-REPLAY, and GitHub's own redelivery, which keeps the same id, still works. Migration 0018_github_delivery_payload_hash.sql adds an index for this lookup. Test added in github.test.ts.
- Edge proxy SSRF guard: isPrivateAddress missed several IPv6 forms of private addresses. These were hex-mapped IPv4 (::ffff:7f00:1), IPv4-compatible (::127.0.0.1), NAT64 (64:ff9b::/96), 6to4 (2002::/16), site-local fec0::/10, zone ids, 100::/64 and documentation addresses. Any of them would let an allow-listed name rebound to an AAAA record reach a private address. It now expands IPv6 fully and judges any embedded IPv4 address. The proxy test is extended.
- The edge proxy cached a run's allow-list for 30 s, longer than the 10 s target for refusing a stopped run (spec 4.4). It is now 5 s (services/edge/src/config.ts).
- deploy/compose.yml did not give the edge EDGE_RUN_SUBNET. If RUN_SUBNET_POOL was changed, runners would no longer be in the edge's run subnet. The proxy would then treat them as the credential-less system caller, skipping their own run's allow-list. The edge now takes the same value as the launcher.

## Remaining
- I7 and spec 8.5 are only partly met. The stop path still reads policy data: people, the role matrix, policies, freezes and the catalog for the decision point, plus projects, repos and work_orders to resolve the target, and idempotency_keys. If policy data is unreadable, stop commands fail. Spec 8.5 says only stops and events are touched. Closing this needs a design decision, for example a cached last-known policy state or a break-glass list of Factory Admins.
- Halt versus checkpoint (spec 4.5). reconcileStop cancels attempts and revokes run tokens straight away for a halt. The edge's progress mode, meant to let a halted run checkpoint at the turn boundary, therefore never applies. A halted run cannot save its last checkpoint before teardown.
- Spec 5.3 says API creates require an idempotency key. On the server the key is optional (command() only honours it when present). The web app always sends one, so F1 holds for the UI but not for other callers.
- The run-scoped internal endpoints (authorize, usage, heartbeat, checkpoint, result, spec, egress) accept any service principal, edge or github. The github token is also mounted in the worker. A valid run token is still required, but limiting these endpoints to the edge would add defence in depth. A denied vendor-key read is refused but not audited, because it does not go through command().
- Established CONNECT tunnels through the edge proxy are not cut when a stop lands. They end only at container teardown, which measured about 1-2 s in the E2E run, or at the 300 s idle timeout.
- The GitHub broker passes symlink (120000) and submodule (160000) entries from the workspace into the published tree, and reads untrusted objects with fetch.fsckObjects=false. Neither runs anything, but both are permissive. If .git or .git/objects in the workspace is a symlink, the read can reach the never-started helper container's own root filesystem (the broker image, which holds no secrets). Nothing escapes the host.
- F5 edge case: if a project's slot limit is lowered, slots already held above the new limit stay held until their work orders release them. No new slot is taken above the limit.
- A work-order kill cannot run while the work_orders table is down, because the target lookup needs it. Project, repo and factory stops do work in that case.
- Not verified here, as in the E2E report: real GitHub, real model vendors, the MCP gateway (returns 501), T9 on the runner side, T11, replay at scale, multiple worker replicas, and the 150 s termination-unconfirmed alert against a real container that will not die.

## Guarantees
I checked each guarantee against the code and tests, after my fixes.

- **F1:** idempotency_keys is written inside the command transaction under a unique index. A concurrent request with the same key waits for the first, then gets the stored result back or a conflict. The race test exists. The key is optional on the server.
- **F2:** lockWo takes a row lock (FOR UPDATE), and If-Match is checked against the locked row. saveWo bumps the version once per command. There is a concurrent-move test.
- **F3:** the attempts_one_live_idx partial unique index enforces one live attempt per work order and station. startAttempt supersedes older attempts. attemptIsCurrent checks the fencing number, the attempt state and any stop with a higher fencing. Results, heartbeats, the edge and broker publishing now all use that same stop-fencing rule, which before this review covered only applying results and dispatch.
- **F4:** the merge intent is recorded before the call, and its dedupe key covers the work order, pull request and head. The real pull request is read before every try, an already-merged one is not merged again, and only GitHub reporting it merged closes the gate. Tested with a crash between merge and commit.
- **F5:** slots are taken with an atomic upsert (`where state <> 'held'`), and a partial unique index allows one held slot per work order. They are released on finish, send-back, park, decline, kill, needs-person and moving off Build. The queue is re-dispatched on every exit path, including the lease-expiry path fixed here.
- **F6:** votes are unique per instance and voter, with the work order locked. The number of approvals needed is the larger of the rule when the gate opened and the rule now.
- **F7:** the timers table fires into jobs inside a transaction, and escalation pauses under a halt.
- **F8:** waiting work exists only as database rows.
- **F9:** the lease is extended by heartbeat. The reaper calls expireLeases every minute, retries up to 3 times, then moves the work order to Needs a person. The wall-clock watchdog is in the worker.
- **F10:** every route changes state through command() or stopCommand(). The worker uses the engine functions in its own transactions, and each writes its events.

The stop path commits only the stop row and its event, and the stop takes the next fencing number. Enforcement is a separate job that may fail, and the reaper re-enqueues stops that were never enforced. The edge refuses on its next call through the live stop check, token revocation and now fencing. The broker refuses superseded or stopped attempts both before the objects are created and again before the branch moves.

On I2 (no secrets in the runner): the runner's environment is EDGE_URL, HTTPS_PROXY (run:token), GANTRY_RUN_TOKEN, GANTRY_RUN_ID and static git hardening variables. The spec it fetches contains instructions, skills, the handoff, limits and MCP URLs, and no key. The seed clone passes the installation token only through the git child process's environment, so nothing is left in .git/config. Vendor keys stay in the edge and are readable only with the edge's service token.

The edge fails closed: when the API does not answer, model calls get 503 and the proxy refuses. The proxy resolves a name once and connects to the checked address, so DNS rebinding is blocked. It rewrites the Host header from the absolute URI, checks IP literals against the allow-list and the private ranges, and allows only ports 80 and 443.

The webhook signature is compared in constant time (timingSafeEqual), and replays are refused by delivery id and now also by payload hash. Run tokens are stored hashed and bound to the run id, attempt and fencing number. The launcher template is the fixed strict schema: no image, mounts or flags from the caller, read-only root filesystem, all capabilities dropped and an internal network.

Spec 15.4: every new endpoint goes through command(). Denials are audited, including refusals raised inside handlers. Creates support idempotency keys, and stopped scopes are refused with the reason. flow-commands.test.ts has a denied case and a stale case for each work-order command, and the stop tests cover denied and stale cases too.

## Tests
All tests ran against real Postgres 17 (mirror.gcr.io/library/postgres:17-alpine in container w3rev-pg on :55491, removed at the end).

Baseline, before any fix:
- `npm run build` and `npm run typecheck`: green.
- `npm test`: db 52, domain 79, api 254, edge 67, github 44 passed with 2 docker tests skipped, launcher 37 (including the 8 real-Docker integration tests), worker 46, web 155. All passed.

Final, after the fixes:
- `npm run build` exit 0 and `npm run typecheck` exit 0.
- `npm test` exit 0: db 52, domain 79, api 258 (4 new), edge 67, github 44 passed with 2 skipped, launcher 37, worker 46, web 155.

Also run:
- `GANTRY_GITHUB_DOCKER_TEST=1` on services/github test/docker.test.ts: 2 of 2 pass against real Docker.
- runner/wrapper (not a workspace): typecheck plus 23 of 23 pass.
- The new F5 lease-expiry test fails without the fix ("expected 'queue' to be 'build'") and passes with it.
- The new I7 test returned 500 before the state.ts fix. With it, all 16 flow tables can be unavailable and the stop calls still return 200.

The full compose stack was not brought up again, since the E2E run already covered it. My progress log is docs/build-notes/progress-w3rev-.md.
