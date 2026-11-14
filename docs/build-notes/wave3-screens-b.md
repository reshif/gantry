# Wave 3: screens-b

## Summary
I ported the traveler drawer, the work order record and the conversations screen to React against the real flow API. I exercised the controls against a real api on Postgres and compared screenshots with legacy. Reassign could not be run through the UI because `/agents` does not exist yet. I did not build the legacy "record a post-release outcome" control. The new web tests pass, the full `apps/web` suite passes and typecheck is clean.

**Traveler drawer** (`views/traveler/` and `traveler.tsx`, opened by `useOpenTraveler()` in `shell/useTraveler.tsx`)
- Header, titleblock and stop/halt/kill banners.
- Action rows: approve and reject (decline or confirm at G0+G1), retry, return from a bay, send back, move to bay, reassign, reclassify, repo halt/resume, kill/restore.
- Six tabs: Journey, Lifecycle, Conversation, Brief, Artefacts and History.
- Journey shows gates with N-of-M progress, plus a scrubber built from the record's events.
- Every button's lock reason comes from the traveler read's `allowed` field and `stop`.
- Writes send the traveler's `version` as `If-Match`.

**Record** (`views/record/` and `record.tsx`, route `#record/WO-x`)
- Eleven sections with the completeness meter and a journey scrubber.
- Summary edit saves with `PUT /work-orders/{id}/record/summary`.
- Copy as Markdown uses `record.md`, with a manual-copy dialog when the clipboard is unavailable.
- Export downloads the `/record/export` bundle with its sha256 manifest.
- Without an id it shows a record picker, which is also the fallback for an unseen record.
- The same sections are the traveler's compact Lifecycle tab.

**Conversations** (`views/conversations/` and `conversations.tsx`)
- Inbox tabs (For me, Open, Resolved), the thread with quick-reply chips and a composer, a class card with override, and the live brief panel.
- Actions: answer, add a follow-up question with up to three chips, raise a question to a person, confirm the brief, decline, change class.
- The thread is shared with the traveler's Conversation tab.

**Changes outside my own files**
- `shell/useTraveler.tsx` now takes `(woId, tab?)`.
- I appended `docs/build-notes/progress-w3tr-.md`.

## Public interface
`useOpenTraveler(): (woId: string, tab?: "journey"|"lifecycle"|"conversation"|"brief"|"artefacts"|"history") => void`; the drawer is the default export of `views/traveler.tsx`, `TravelerDrawer({woId, onClose})`. Shared exports for other views: `ConversationThread({woId, idPrefix, head, noActions, noFollowup})`, `BriefPanel({woId})` and `StatusChip` from `views/conversations/`; `Lifecycle({woId, compact})`, `useCopyMarkdown()` and `useExportRecord()` from `views/record/Lifecycle`; `useOpenRecordRoute()` from `views/record/nav`; `useTravelerWo(id)` and the `TWo` type (the traveler read) from `views/traveler/model`. The record route is `#record/WO-x`; `#record` alone shows the picker. The conversations deep link is `updatePrefs({openConversation: id})` then `navigate("conversations")`.

## Integration notes
["Message order is wrong in `GET /work-orders/{id}`, which feeds the thread: the stored conversation shows every question stamped after the answers. The test helper answered quickly, so the thread looks like all the answers, then 'Brief confirmed', then the questions. This is a flow-api fix (messages persisted in `areas/workorders/conversation.ts`, loaded in `model.ts` ordered by `data.at`), not a web one.", "The traveler read is flat: the legacy work order plus `version`, `gateProgress`, `allowed {approve, moves, can}`, `stop` and `route`. The web reads `allowed.can` for the lock reasons instead of calling `/can`, so it follows the server's decision point for each work order.", "The journey scrubber and the timeline come from `record.events`. I added no shared-file edits, and nothing in `ops.ts`, `queries.ts` or `keys.ts` needed changing, because the existing ops already match the real endpoints.", "`useOpenTraveler` now takes an optional tab. Callers that only pass a work order id are unaffected. Opening a drawer in the same tick as `window.location.hash` is reset closes it (the overlay closes drawers on route change), which matters in tests.", "I reuse `ReclassifyDialog`, `ConfMeter` and `RouteStrip` from `work-orders/intake.tsx`, `useNewWorkOrder` from `work-orders/New.tsx`, `makeStopActions` for kill, restore and halt, and `useProjectRepos` from `floor/kit.tsx`."]

## Unverified
- `GET /api/v1/agents` and `GET /api/v1/projects/{id}/repos` return 404 in this API build. Agent names show as ids (a `ag-` prefix is treated as an agent for layout), and the reassign dialog lists only the current agent with a note. It will use the real roster once the endpoint exists.
- No GitHub data was available, so I did not see Changes, Merge, review comments or PR links with real commits, files or patches. The code paths use `/record` and `/changes`, and the empty states are tested.
- The legacy 'Record an outcome' dialog is not ported because the API has no outcome endpoint. The record has no incidents control.
- The conversation view has no AI follow-up suggestion (legacy G.ask). It is a plain follow-up form posting `kind: followup`, and a rewrite of the summary is a plain edit.
- Picker deviations: no 'All my projects' choice, no Project or Record-completeness columns, and the Incidents stage only filters the rows already loaded. The list read is per project and has no completeness field.
- Mobile widths, dark theme and keyboard focus trapping were not checked visually, only the 1440x900 desktop screenshots.
