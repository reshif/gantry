# Wave 3: github

## Summary
Built the flow engine command side and reads in gantry-api. The work-order endpoints, gates, moves, station execution, stop controls, floor with replay, record, and the work-order parts of home are in and tested. The full api suite passed against real Postgres 17 (including 32 new flow tests) before I removed the container, and typecheck on the api source is clean. I added two small migrations/edits outside my files: 0017 (stop enforcement markers) and two edits to areas/home/state.ts. A few things are not done or not verified: notification outbox rows, any real container launch, and the GitHub/edge-dependent paths (see below).

## Public interface
Routes (registered in routes/workorders.ts, floor.ts, stops.ts):
- POST /api/v1/projects/{id}/work-orders (idempotent; returns id, wo, classification, route, gates, version); GET /projects/{id}/work-orders (q, cls, where, repo, prio, source, state, sort, dir, cursor, limit -> {items,next,total}); GET /work-orders/{id} (legacy WorkOrder plus version, gateProgress, allowed{approve,moves,can}, stop, route); GET /conversations?project=&awaitingMe=.
- POST /work-orders/{id}/messages (kind answer|question|followup), /reclassify {cls,reason}, /confirm-brief, /decline {reason}, /move {target,reason,dry_run}, /send-back {toStation,note}, /park {bay,reason}, /unpark, /reassign {agent}, /retry; PUT /work-orders/{id}/record/summary {text}.
- POST /gate-instances/{woId}:{gateId}[:{n}]/approve|reject.
- GET /work-orders/{id}/record, /record.md, /record/export (manifest with sha256 per part), /changes.
- GET /projects/{id}/floor[?at=ms] -> {project, workOrders, flowVersion, slots, gates, queue, stop, stops, at, replay?}.
- POST /stops {scope,id,mode,reason,inFlight,confirmText}; DELETE /stops/{scope:target} (resume a halt); POST /stops/{scope:target}/restore (pending:true for the first of two Factory Admins); GET /stops/impact; GET /stops.
Worker-facing, exported from @gantry/api/core, each takes the caller's tx and flushes its own events and jobs: applyStationResult(tx, attemptId, fencing, result) -> {applied:true,woId,station,next} | {applied:false,code:'superseded'|'stopped'|'unknown',reason}, where result = {status: succeeded|failed|interrupted|needs_person, summary?, output?, error?, usage?, observed?{checks,files,headSha,tests}} and observed wins over the agent output; expireLeases(tx); recordMerged(tx, org, wo, {prNumber, mergeSha}); recordNewHead(tx, org, wo, headSha); handleFlowTimer(tx, payload); reconcileStop(tx, stopRowId); pendingStops(db); plus flushFx, startAttempt, attemptIsCurrent, heartbeatAttempt, dispatchQueued. Job contract in core/jobs-contract.ts (job(), parseJob(), JOB_SCHEMAS) with the brief's queues and kinds.

## Integration notes
Details are in docs/build-notes/wave3-flow.md.
1. Stop worker: on a stop.enforce job call reconcileStop(tx, payload.stopId) first. It is idempotent via stops.enforced_at and reconciled_version (migration 0017_flow_stop_enforcement.sql). It cancels attempts and revokes run tokens, releases slots and closes open gate instances on a kill, moves work orders to Killed on kill-cancel, flags heldByKill on kill-hold, and on lift starts fresh attempts. The worker must still terminate containers via the launcher, cancel queued merge.request jobs, and ask the broker to fail the Gantry check or convert PRs to draft.
2. Reaper: each sweep call pendingStops(db) and re-enqueue stop.enforce (dedupe key stop.enforce:{row}:v{version}) for what it returns. The route enqueues post-commit and tolerates a failing jobs table: the stop is committed, the response says enforcement:"pending".
3. Stop ids: the API id is scope:target (workorder is the API name for scope_type wo); row ids are scope:target:n. Events are the legacy halt, resume, kill and restore with category kill and scope in after, so stateAt replays them. The budget halt in internal/runs.ts writes event type stop.set, which the replay does not read.
4. Result intake: the internal run.result job should call applyStationResult(tx, attemptId, fencing, {status, summary, output, error, usage, observed}). It rejects superseded attempts. Pass observed.checks, files, headSha and tests from GitHub and the edge so system-observed values win. Wire flow.timer jobs to handleFlowTimer, github events to recordNewHead and recordMerged, and lease expiry to expireLeases.
5. Gates: instance ids are WO-x:GATE:n and the API also accepts WO-x:GATE for the open one. The instance stores basis.required (N of M when opened); a vote passes only when have >= max(that, current requirement). Approving G5 with an open pull_request row enqueues merge.request {woId, prNumber, headSha} and waits for recordMerged; with no PR it advances directly.
6. Shared-file edits, all minimal: core/index.ts (exports appended), areas/home/state.ts (killed and heldByKill on loaded work orders; killed work orders included), migrations 0015 and 0017. No edits to routes/index.ts, apps/web, or @gantry/domain.
7. Web: ops.ts already matches the bodies (target, toStation, agent, inFlight, confirmText, gate id wo:gate). List and conversations return {items,next,total}. The traveler read adds version, gateProgress and allowed to the legacy fields.
8. Test setup: the tests need GANTRY_TEST_DATABASE_URL. To rerun: start postgres:17-alpine with fsync off and max_connections=200, export the URL, then run npx vitest run test/flow-*.test.ts from services/api. My throwaway container w3flow-pg is removed.

## Unverified
- The test-config typecheck (tsc -p tsconfig.test.json) fails on one line in test/github.test.ts (another engineer's file, a header type). Mine type-check.
- Source typecheck was clean for my files when last run; in-progress files under areas/github from another engineer showed errors at one earlier point and had cleared by the final run.
- No container was launched: attempt.dispatch jobs are enqueued but nothing consumed them. Container teardown, the edge refusing a token within 10 s and the launcher kill times of spec 4.4 were not measured.
- Notification outbox rows (smtp, slack, teams, webhook) for gate waiting, questions, escalation and release are not produced; the routing tables belong to the notifications area. Events gate.waiting, gate.escalated and wo.question exist for it to key on.
- observed checks, commits and PR heads depend on the GitHub broker (no keys). A mixed or automatic gate with no observed checks uses the gate's own check list marked ok.
- Cancelling queued merge.request jobs, failing the Gantry check and converting PRs to draft on a stop belong to the worker and broker; reconcileStop only does the database side.
- Replay reads the last 14 days of a project's work orders and up to 20000 events.
- The unit tests ran on Postgres in a throwaway container with fsync off, not on the compose stack.
