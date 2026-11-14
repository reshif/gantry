# Work-order session

Status: implemented (API, web, tests). Spec: 8.4 "The work-order session".

## Why
Intake was a scripted questionnaire labelled "Intake Clerk · AGENT" with no model: free text got no answer, there was no sign a dialogue was open, and the traveler had no way into it. A work order now has one agent conversation for its whole life, and the person lands in it from the traveler.

## Design
- Principle: the agent understands and proposes; deterministic code is observed facts, rails and permission checks; a person approves a card.
- Shared core `services/api/src/areas/session/core.ts`: turn history from a thread, SSE start, turn cost, per-agent budget, and `stationAgentGate` (the generalised "can this agent talk now": active, promoted live version, pinned model served by a connected vendor, no stop). The onboarding session now uses `historyFrom`, `openSse` and `turnCostMicros` from it; its API and tests are unchanged. Web: `views/session/kit.tsx` (question card, progress line, `useLiveTurn`), used by both sessions.
- Rows: `workorder_messages` (migration 0033) and `workorder_session_seen`. The scripted `conversations/messages` rows are read as history (shown first, never mixed into the session afterwards); nothing is migrated or deleted, so existing intake conversations (WO-1001) show their history.
- Model: the station agent's pinned model through routing. The API asks the edge as purpose `console` with the model pick (so no edge change); cost is recorded on each answer (`costMicros`) and summed against the agent's own budget per work order. Output room 16,000 tokens (a brief fits in one tool call).
- Tools (`areas/workorders/session/tools.ts`): `get_work_order`, `get_station_progress`, `list_related_work`, `inspect_repository`, `read_file` (observed, repository and request text marked untrusted), `ask_user` (question card with up to four suggested answers), `propose_brief`, `propose_reclassify`, `propose_decline` (only at Intake before G0+G1; offered only then).
- Approval (`routes/workorder-session.ts`): brief = `confirmAgentBrief` (sets the brief to the validated draft, marks the questionnaire complete, then the ordinary `approveInner` for G0G1 under `brief.confirm`), reclassify = `reclassify` (`wo.classify`), decline = `decline` (`wo.decline`). A stale brief (fingerprint) or an already decided card is a 409. Nothing auto-executes.
- Follow-ups (`areas/workorders/session/updates.ts`): events (`wo.enter`, `wo.station.done`, `gate.waiting`, `gate.decision`, `gate.check`, `wo.bay`, `wo.merged`, `wo.sendback`, `wo.classify`, `wo.state`) are posted once per event id (deterministic message id) for work orders that have a session; `wo.classify` and a send-back to Intake request an agent turn. `openIntakeSessions` opens a session for Intake work orders that have none (the agent speaks first). A 15 s timer in the API runs open, scan and follow-ups (disabled under test; tests call `woSessionJobs`). The bell (`home` conversations) lists unseen updates for the people involved.
- Rule-based fallback: no usable model or budget -> the scripted question is shown as a card with its chips, answers go through the ordinary answer command, the label is "Rule-based (no agent)", and the brief confirms the old way.
- Web: route `#/p/<project>/conversations/<WO>` (same route id as before; the list is the route without a parameter). The list has no forms. The traveler has "Open conversation" with a waiting/unread indicator. Older deep links through the `openConversation` preference redirect to the session. Side panel: work order, belt stepper, brief as it stands, proposals, agent, cost.

## Not done / follow-ups
- Later stations only answer questions read-only; they do not propose.
- The edge meters these calls as purpose `console` (no `agent_id`); per-work-order spend is on the messages.
- The old Conversation thread and Brief panel still exist in the traveler's Conversation tab.
