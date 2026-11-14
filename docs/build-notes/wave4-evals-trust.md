# Wave 4: evals and trust (w4evt-)

## Summary
Evals and the trust ladder are built end to end: the API (spec 8.7 Evals and Trust rows, 13.1 to 13.3), the worker orchestration, and the two screens ported from `legacy/js/views/evals.js` and `trust.js`.

**Evals.** A suite run is real work through the production runtime. Each golden case (repeated N times) becomes one attempt on a hidden *carrier* work order (`work_orders.source = 'eval'`, state `done`), and the worker's ordinary `attempt.dispatch` starts it in a sandbox through the launcher and the edge, exactly as for real work. Differences, on purpose: the workspace is seeded read-only at the case's pinned commit and the result is never published (no write access to any real repository); the run executes the agent version and model the person picked; the suite has its own concurrency cap (`orgs.settings.evals.maxConcurrent`, default 2, organisation-wide) and its jobs run at priority -10, behind every work-order job. The result is graded by deterministic checks only. A model-graded check is stored and shown as advisory and never changes pass or fail. Results carry the number of tasks and a 95% Wilson range; two runs compare task by task. A completed run feeds the agent promotion gate (already built in the agents area) and custom-vendor qualification.

**Trust.** Cells (agent x work class x project, optionally repo) live in `trust_cells`; every level change is a `trust_grants` row (that is the history); evidence is computed live from gate decisions with the domain's strict counting rules (spec 13.3: only a person's decision on a completed attempt counts, clean after the soak period, no attributed revert or incident, not on a fallback model). The level in force and its grant are stored on every gate decision. L0 and L1 are enforced (a person decides every gate). L2 and L3 are built and switched off: runtime switch `orgs.settings.trust.levelsAboveL1`, off in a new install, with its own endpoint and audit. L4 is not grantable. Promotion is only ever proposed by the system and always granted by a permitted person with a reason. Demotion is automatic (attributed revert or incident or guardrail breach or security finding drops the agent's cells to L1; two failures in the last ten reviewed runs drop one level). Criteria and the spot-check rate are versioned (`trust_criteria_versions`). Ceilings are rules with conditions.

## Public interface

### Endpoints (all under /api/v1)
Evals (action `eval.run` for changes, reads for signed-in people):
- `GET /suites` (suites with cases and the run in progress), `GET /suites/{id}/runs`, `GET /evals/runs` (every suite's recent runs in one request; the screen uses it, 13 per-suite calls tripped the rate limit)
- `POST /suites/{id}/runs` `{agent, version, model?, repeats?}` (keyed create), `POST /suites/{id}/runs/{run}/cancel`, `POST /suites/{id}/cases` (keyed create; fields name, task, checks (the person's words, advisory), repo + commit (pinned snapshot; the commit recorded for the repo when omitted), rules, mustMention, mustNotMention, mustNotTouch)
- `GET /evals/scorecards` (per agent, from attempts, gate decisions, usage and test results; with `counts` and weekly `trend.n`), `GET /evals/factory` (heat, intake confusion, per class, onboarding, rejection reasons, override rate; limited to visible projects)

Trust (`trust.grant` on the cell's project, `trust.criteria` for policy):
- `GET /trust/cells[?project=]` (the legacy `Trust` shape plus per-cell `evidence`, `meets`, `ceiling`, `effective`, `projection`, `pending`, `rev`, `gate`; `?project=` adds the cells that do not exist yet, `virtual: true`; plus `levelsAboveL1`, `criteriaVersion`, `minRuns`, `soakDays`, `coverage`)
- `POST /trust/grants` `{target: cellId | {agent, cls, project, repo?}, level, reason}` (If-Match = cell `rev`, 0 for a new cell), `POST /trust/cells/{id}/demote`, `POST /trust/proposals/{id}/decide` `{accept, reason}`
- `PUT /trust/criteria` `{level, patch}` and `PUT /trust/sample-rate` `{n}` (If-Match required: the criteria version), `POST /trust/ceilings` (If-Match on edit), `DELETE /trust/ceilings/{id}`, `PUT /trust/switch` `{on, reason}`
- `POST /work-orders/{id}/outcomes` `{kind: revert|incident|followup, text, attribution: 'agent'|'spec'|'environment'|'unrelated' | {station, agent}}` (action `outcome.record`). **Added here** because the demotion rule needs a source for outcomes and no endpoint existed (spec 13.1 says outcomes carry a person-set attribution). The Record screen can call it (`ops.recordOutcome`).

### Code
- `services/api/src/areas/evals/{engine,commands,store,schemas,scorecards,checks}.ts`, `areas/trust/{config,store,record,read,commands,schemas}.ts`, `routes/evals.ts`, `routes/trust.ts`.
- Exports from `@gantry/api/core` for the worker: `progressEval`, `gradeEvalAttempt`, `failEvalAttempt`, `sweepEvals`, `cancelEvalRun`, `evaluateAllTrust`.
- Jobs: `eval.dispatch` (queue flow, priority -10) and `trust.evaluate` (queue system, daily). Worker: `handlers/evals.ts`; run.result, attempt dispatch failure, the wall-clock watchdog and the reaper sweep branch for eval attempts.
- Migration `0026_evals_trust_runtime.sql`: outcomes get `attribution`, `station`, `data` and the `followup` kind; ceilings get `data`, `enabled`, `version`; cells get `repo_id`; indexes.
- Web: `views/evals.tsx` + `views/evals/{kit,Scorecards,Suites,Factory}.tsx`, `views/trust.tsx` + `views/trust/{kit,Ladder,Tabs}.tsx`; `ops.ts` (runSuite repeats, cancelEvalRun, trust ops carry versions, setTrustSwitch, recordOutcome), `queries.ts` (useSuites, useAllSuiteRuns, useTrustCells(project)), `keys.ts`.

## Integration notes (what other engineers need to know)
1. **Shared-file edits, all small and localized.** `workorders/engine.ts`: `recordDecision` now takes the level and grant from `trustInForce` (was a raw `trust_cells` lookup) and stores `trust_grant_id`, `trustLevelNum`; `openGate` calls `trustDecision` for human and mixed gates (auto pass at L2 and L3 when the switch is on); `finish` calls `trust afterFinish`; the G3G3s failure calls `demoteForBreach`. `workorders/model.ts` (`buildWorkOrders`), `workorders/reads.ts` (`listWorkOrders`), `home/state.ts`, `projects/metrics.ts` ignore `source = 'eval'`. `workorders/station.ts`: `expireLeases` skips eval attempts and `applyStationResult` refuses an eval carrier. `agents/store.ts` eligibility ignores runs with `data.override` (a model other than the version's pinned one does not qualify the version). `core/jobs-contract.ts`, `core/index.ts`, `core/bootstrap.ts` (`seedEvals` option), `packages/db/src/seed.ts` (dev demo suites, runs, trust ladder), `packages/domain` (`types.ts` optional fields, `insight.ts` `meets` passes `soakDays`), worker `dispatch.ts` (version and model of an eval attempt, failed dispatch), `common.ts` (the pinned eval commit first), `result.ts`, `reaper.ts`, `worker.ts`, `scheduler.ts`.
2. **Test helpers:** `startApp` (api) and `startWorld` (worker) now pass `seedEvals: false` by default, so existing tests that assume no suites or cells are unaffected. Pass `seedEvals: true` for the demo ladder.
3. **I fixed another engineer's migration** `0027_learning_findings_proposals.sql` (three quote-stripped literals: `default ''`, `default '[]'`, `coalesce(..., '')`) because it broke every database test. No other change to it.
4. **Eval carriers are real rows.** Anything new that reads `work_orders` should add `source <> 'eval'`. Eval spend lands in `run_usage` and `usage_meter` for the case's project, so it counts toward that project's budget.
5. **Dev seed:** `GANTRY_DEV_SEED=true` loads 13 demo suites, 35 past runs (marked `seeded`) and the legacy ladder (411 cells at their legacy levels, ceilings, criteria). No proposal or evidence is invented: cells show `0 runs` and "insufficient data" until real work goes through. With the switch off, a seeded L3 cell runs at L1 (the screen says so).
6. **SSE:** the worker publishes `evalRuns, suites, agents, scorecards` on every eval transition and `trust, audit` after the daily evaluation; the command pipeline publishes `trust` when a gate or work order moves a cell.

## Verified
- api: `trust.test.ts` (33), `evals.test.ts` (23); full api suite, see the end of this file. Denied, stale (If-Match), stopped-scope (killed factory), idempotent-create and audited-denial cases for every change endpoint.
- worker: `test/evals.test.ts` (9): starts a case at the picked version and model within the cap and behind work orders, grades with the case's checks, never publishes, seeds at the pinned commit, repeats, a case that cannot start ends with an error, lease sweep and stop sweep, wall-clock watchdog, a project stop at dispatch, the trust job.
- web: `evals.test.tsx` (15), `trust.test.tsx` (18), plus the agents tests (the Run suite button now opens the suite).
- Live: real API on a throwaway Postgres with the dev seed, Vite, Playwright against `legacy/index.html` for the same person (Asha). Screenshots `/tmp/claude-0/w4evt-legacy-*.png` and `/tmp/claude-0/w4evt-react-*.png`. Every control exercised once: add a case (and a refused one inline), run a suite (progress, a second run refused with the reason, finish with the range, cancel), carriers hidden from the work-order list, switch on and off, add, edit, toggle and remove a ceiling, save criteria and the spot-check rate, raise and lower a cell with a reason, L4 and levels above L1 locked with reasons, create a cell from a virtual one, record an outcome that demotes, approve and decline a proposal.

## Not ported, on purpose
- Legacy "Runs are simulated locally" timer and its random pass/fail (replaced by real runs and server progress).
- Legacy "Simulate an incoming outcome" (replaced by a real "Record a post-release outcome" dialog on shipped work).
- The legacy deterministic L2 sample (`hash(wo, gate) mod rate`): the draw is random, made after the run finishes, and recorded in `sampling_draws` (spec 13.3).
- Legacy default of one hard-coded agent (`ag-build`): the screen opens on the first agent that has finished attempts.

## Unverified and known limits
- **No real model run.** A case through the launcher, edge and a real runner with a vendor key was not run (no key here). The worker path is tested against the fake launcher and broker (test doubles under `test/`), and the stub adapter path (no model) is what a station without a model key produces. Results from the stub are deterministic and say nothing about an agent.
- **Model-graded checks are advisory records only.** A rubric can be stored on a case and shown; no grader model is called by the platform in this version, so there are no calibration sets or agreement rates yet (spec 13.2). Deterministic checks (`output_equals`, `output_contains`, `output_not_contains`, `output_matches`, `path_not_touched`, `max_files`, `max_seconds`) decide, over what the run reported: an eval run is not published, so the diff is not observed by the system, only reported by the agent.
- Eval cases need a project to run in: the repo's project, the case's `project`, or the agent's first project.
- L2 and L3 passing under trust with a real random draw is tested at the decision function and once through a real flow (either branch is asserted); it is off in a new install.
- The domain's `trust.evidence` counts any attributed-or-not revert or incident as bad for the evidence (conservative); only an outcome attributed to the agent demotes.
- "Halted, killed, budget-held" attempts are excluded because they never produce a human decision; the fallback exclusion is the domain's model-history check.
- L0 "shadow" is enforced as "a person decides every gate" (same as L1); the agent's output is not held back from the work order in shadow mode.
- The 150 s and halt-grace timings of the stop path apply to eval runs as to any run; not re-measured.

## Test results at the end
api 514 passed (full suite, after removing my live-run harness), worker 91 of 92 (the one failure, onboarding "runner check uses the configured toolchains", passes alone: it is timing-sensitive under load and not part of this area), db 55, domain 106, web 327 passed. Typecheck clean for api, worker, web. The Postgres container `w4evt-pg` and the live-run harness were removed.
