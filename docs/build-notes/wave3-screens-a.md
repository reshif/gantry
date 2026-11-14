# Wave 3: screens-a

## Summary
Ported the Floor (belt, board, list, replay, drawers, andon, kill/restore), Work orders (table, New work order dialog, classification card, class override) and the shared kill/halt/restore dialogs onto the real flow API. Home's approvals and attention sections (another engineer's port) were checked against the same API and worked without changes. Web typecheck, the 125 web tests and a vite build pass. I exercised every control once against the real API (real Postgres, API served through the Vite dev proxy) and compared Playwright screenshots with legacy; the one control I could not exercise was the second Factory Admin's restore approval. Repo names, agent names, MCP counts, the kill-route list and the trust tables are degraded or links only, because those endpoints are still stubs (details below).

## Public interface
Shell dialogs (apps/web/src/shell/StopDialogs.tsx, opened through makeStopActions in stopActions.tsx):
- `KillDialog({scope: factory|project|workorder, id, onClose})`: shows impact from GET /stops/impact (only read when the viewer has the kill right), notification routes, and the typed phrase (the project name, or KILL FACTORY).
- `RestoreDialog({scope, id, onClose})`.
- `HaltDialog({scope: project|repo, id, projectId, onClose})`: reason needs 20 characters on a regulated project, 4 otherwise.
- `makeStopActions(ui, me)` now returns halt, resume, haltRepo, resumeRepo, kill(scope, id), restore(scope, id). The existing call sites in Home, Palette and Project config are unchanged and work.

Work orders:
- `useNewWorkOrder()` returns `open(preset?)`.
- `useRegisterNewWorkOrder()` registers the `newWorkOrder` palette command, and Shell.tsx calls it.
- `submitBlock` and `projectSubmitBlock` give the reason a submit is blocked (stop, archived, repo not ready).
- Exports from views/work-orders/intake.tsx for Conversations to reuse: `RouteStrip`, `ConfMeter`, `ReclassifyDialog`, `ClassificationCard`, `routeText`, `skipsText`.

Floor kit (views/floor/kit.tsx):
- `useFloorRead(project, at?)` reads GET /projects/{id}/floor, live or at a past time.
- `useFloorState` / `useFloorValue` build the floor context (`FloorCtx`) from that read.
- `WoToken`, `useProjectRepos` (see notes for integration), `layoutFor`, `gateStateOf`, `gateText`.

ops.ts: `ops.submitWO(o, via?, key?)` takes an optional Idempotency-Key.

Endpoints used: GET /projects/{id}/floor[?at], GET /projects/{id}/events (replay marks), GET /projects/{id}/work-orders (q, cls, where, repo, prio, source, state, sort, dir, cursor, limit), GET /work-orders/{id} (allowed.approve and allowed.moves), POST /work-orders/{id}/move with dry_run, POST /gate-instances/{wo}:{gate}/approve|reject, POST /stops, DELETE /stops/{scope:target}, POST /stops/{scope:target}/restore, GET /stops/impact.

## Integration notes
["Shared files touched, each minimally: apps/web/src/api/ops.ts (submitWO takes an optional idempotency key), apps/web/src/shell/Shell.tsx (one hook call registers the newWorkOrder palette command), apps/web/src/App.test.tsx (the shell test relied on the Floor placeholder text; it now expects the floor error state, since the test mocks no floor read). shell/stopActions.ts was renamed to stopActions.tsx (the existing imports still resolve). apps/web/src/shell/useTraveler.tsx shows as modified in git status but it is not mine.", "useProjectRepos (views/floor/kit.tsx) uses GET /projects/{id}/repos when it returns rows, otherwise derives repos from the work orders and from active repo stops on the floor read. When the onboarding area serves that endpoint nothing else needs to change; the fallback repos assume stage \"ready\" so the server's own refusal decides whether a submit is accepted.", "Moves go through the server: the Move to menu reads GET /work-orders/{id} (allowed.moves, route stations and bays only, so stations off the class route are shown as locked), and drag uses POST /move with dry_run. Board moves send no If-Match, the server re-checks under the work-order row lock, so a stale move comes back as 409 and is shown as such.", "Gate approve and reject buttons take their lock from the traveler's allowed.approve (the server's own decision for this person: approver rules, separation of duties, stops), not from a client guess.", "Replay holds its window in the prefs replay object (at, span, from, to, speed, project); the floor is re-read with ?at= for each position and previous data stays visible while it loads.", "For Conversations and the Traveler engineers: RouteStrip, ConfMeter, ReclassifyDialog and ClassificationCard are exported from views/work-orders/intake.tsx. The classification card opens after a submit and \"Answer intake questions\" sets prefs.openConversation and navigates to #conversations.", "The kill dialog reads GET /projects/{id}/routes (every visible project for a factory kill) to list kill notification routes; failures are ignored and it says none are configured. A factory kill therefore fires one such read per project once, which is cheap once the endpoint exists.", "Known API behaviour seen live: a work-order kill only changes the work order to Killed once the worker's stop.enforce runs (no worker in this harness), so the Killed KPI and token did not appear in the live check. The stop row and event were committed and the response said enforcement is queued.", "Progress and run notes are in /home/user/gantry/docs/build-notes/progress-w3fl-.md. The throwaway API harness (services/api/test/w3fl-harness.test.ts), the w3fl-pg container, and my Vite and API processes are all removed."]

## Unverified
- Dragging a card to a bay or station and releasing for a real move was exercised for the refused hint and the dry-run only; the real move was verified through the Move to menu.
- Nothing was exercised with a second Factory Admin session (the harness had no p-omar cookie). The second restore approval is covered by the API tests, not the UI.
- These endpoints are still stubs in the API (they 404), so some data degrades gracefully until they land: /projects/{id}/repos, /agents, /skills, /mcp/servers, /projects/{id}/routes. Repo names show the repo id (no owner prefix), station staffing shows ids such as ag-spec instead of agent names, the MCP count is 0, and the kill dialog says no routes are configured.
- Drawer fidelity: the trust ladder tables and the gate Rule history list are replaced by a button to the Trust screen. The "In bays" figure and the Requested column sorting are not ported because the server list cannot sort by them.
- The simulation controls (Pause simulation, tick text) are not ported on purpose, since the product has no simulation. Replay playback is the replay's own clock, not a simulation.
- The Traveler drawer is still the placeholder owned by another engineer. The floor and the work-orders table open it through useOpenTraveler, and the "Answer" link navigates to Conversations.
- Not tested: mobile and rail layouts, light and dark theme visuals, and real-time updates over SSE (queries are invalidated through the existing stream wiring, but no live stream was observed).
