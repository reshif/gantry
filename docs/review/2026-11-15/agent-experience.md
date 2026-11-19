# Agent experience review: distance from the owner's vision, and the target design

Reviewer: product design (human-AI collaboration). Date: 2026-11-15. Evidence: code read (apps/web views, services/api areas/routes, packages/domain starter-kit, spec 8.4/10.3/12.6, build-notes), live stack as asha and daniel (screenshots in `review/ax/`), read-only DB queries. I did not approve the proposal I triggered (WO-1003 is left waiting at Intake, brief unconfirmed). Things I could not verify live are marked (guess) or (code only).

## 0. Verdict in five lines

- The Intake half of the vision is real and good: a live model agent reads the repo, asks via cards, and proposes a brief for human approval (screenshot `ax/20-s1003.png`). That is the best part of the product.
- Everything after Intake is a one-shot, headless, JSON-in/JSON-out run. Research does not talk, does not ask the human, has no web access, has no sub-agents. "Agents have a dialogue" exists only between ONE agent and the human at Intake.
- Agent outputs are not markdown documents. They are JSON blobs in `work_orders.data.outputs`, displayed as `JSON.stringify` in the traveler's Artefacts tab. The `artefacts` table (content-addressed files) is empty (0 rows) in the live DB.
- Chat surfaces are fragmented into four unrelated things (Console, work-order session, onboarding session, traveler Conversation tab) with three different data models, and only the Console has any lifecycle (pin work orders, clear, 90-day expiry), and not even a thread list.
- Distance from vision: roughly 25 percent of the way. The safety model (propose, then human approves, under the approver's own rights) is already the right foundation and should be extended, not replaced.

## 1. What exists (map)

| Vision element | Current state | Evidence |
|---|---|---|
| Intake agent asks questions, no assumptions | Yes, partly. Agent-led, `ask_user` tool with up to 4 suggested answers, max two questions "before you act", then `propose_brief`. It is told to act rather than keep asking, and open questions "may stay open in the brief". Live: with a vague request ("retry sensibly, not sure about limits") the agent proposed a full brief with invented defaults (3 retries, 1s, 30s, jitter) and put the real questions in prose and in a brief's "Open questions" list. No question cards were rendered. | `services/api/src/routes/workorder-session.ts:56` (system prompt), `areas/workorders/session/tools.ts:141`, screenshot `ax/20-s1003.png` |
| Research agent asks questions | No dialogue. Research is a headless run whose result has `findings`, `sources`, `openQuestions` (JSON). A run can end `needs_person` with one `question` string, which is appended to the OLD scripted conversation (`conv.raised`) and parks the work order. There is no resume-with-answer path that continues the same agent context (`resume` exists in the adapter contract 10.1 but station handoff is "artefacts not transcript"). | `areas/workorders/station.ts:131-141`, `packages/domain/src/starter-kit.ts:406-419`, spec 10.1/10.2 |
| Research uses the internet | No. Starter-kit Researcher has `tools: { readRepo: true }` only; instructions say "read the code... search the repository". The egress proxy is an allow-list of vendor hosts. No web search/fetch tool exists anywhere (grep for web_search/web_fetch/subagent/swarm over services, runner, packages: 0 hits outside docs). Live: Researcher on WO-1002 ran "<1m, 2.5k tokens, $0.16" (traveler journey screenshot `ax/21a.png`). | starter-kit.ts:406; `runner/wrapper/src/adapters/claude.ts:68` (`--allowedTools` from spec) |
| Swarm of agents during research | No. One agent per station per attempt. `RES-0x` evals exist but only check repo-reading. Runner is a single harness process. | starter-kit.ts:422-428 |
| Agents dialogue with each other | No. Handoff is the previous station's structured JSON (by design, spec 10.2). No agent-to-agent channel, no shared scratchpad, no review-by-another-agent turn visible to humans. | spec 10.2, `engine.ts` |
| Markdown outputs per agent, displayed | Not really. Outputs are JSON per station (`outputs.research = {findings:[{claim,evidence}], sources, openQuestions, _labels}`). Traveler > Artefacts renders each key as a `<p>` with arrays as raw `JSON.stringify` in mono. Record page has "Copy as Markdown" for the work order record only. `artefacts` table + upload API exist (`internal/runs.ts:216`) but nothing writes station documents there (0 rows). Markdown renderer exists but lives under `views/console/Markdown.tsx` and handles only inline, lists, headings (no tables, no code fences with language, no citations); not used for station output. | `apps/web/src/views/traveler/Tabs.tsx:86-170`; DB: `select count(*) from artefacts` = 0; psql of `outputs.research` |
| Watching a work order live | Partly. Session shows station transitions, gate decisions, merges as system lines (idempotent from the ledger) with a 15 s timer; bell for unseen. No live view of what a running agent is doing (steps, tool calls, files read, tokens), no transcript viewer. The runtime emits ordered events (step/tool call/usage/artefact/question) but no UI surfaces them. | workorder-session.md; spec 10.1; `views/conversations/Session.tsx` |
| Organising chats: create, rename, archive, search | Almost none. Work-order session: exactly one per WO, auto-created, list = three tabs (Waiting on me / Open / Closed), no search, no rename, no archive, no new. Console: threads exist in DB (pin work-order chips, delete, 90-day retention) but the UI auto-opens the latest thread; there is NO thread list, no "new chat" (only "Clear conversation"), no rename, no search. Onboarding session: one per repo. | `views/console.tsx:63-89,343`; `routes/console.ts:99-131`; `views/conversations.tsx:47-49` |
| One coherent place | No. Four surfaces: Console (`#/console`, factory-wide, per-person private), Conversations (`#/p/<project>/conversations/<WO>`, per work order, shared), Onboarding session (`#/p/<project>/onboarding/<repo>`), Traveler "Conversation" tab (the OLD scripted thread + Brief panel still shipped). Different tables: `console_threads/messages`, `workorder_messages`, onboarding messages, legacy `conversations/messages`. Different card vocabularies (console confirm cards vs session proposal cards vs onboarding). | workorder-session.md "Not done"; wave4-console.md |
| Multi-user | Shared by design for WO sessions: any user with `project.view` reads, `wo.answer` talks (daniel, a project admin, sees the identical session and the same "Intake Clerk is waiting for you" banner; `ax/30-daniel.png`). No presence, no attribution of who answered a question card ("answered" stores only text, `workorder-session.ts:369`), no @-mention, no assignment of a question to a person, no private notes. Console is strictly per-person (another person's thread is a 404). | `ax/30-daniel.png`, workorder-session.ts:369 |
| Running and maintaining it | Agents area exists (versions, skills, trust, evals). No per-conversation cost/budget view beyond a side-panel line; no operator view of "all conversations that are stuck / waiting on a human / over budget". Console has no per-person spend cap (wave4-console "Unverified"). | wave4-console.md |

### Live observations (asha, daniel)

1. Submitted WO-1003 via New work order (`ax/12-new.png`, `ax/14`). The intake agent spoke first within ~1 minute (model: claude-haiku-5-5 for Intake, sonnet/opus for later stations). Streaming and proposal card with diff worked.
2. Brief proposal diff shows the OLD scaffold lines as red removals ("UI changes unless stated", "How will we know it is done?") — the template placeholders the system seeded, not anything the human wrote. It reads as the agent deleting the user's content. (P3)
3. Side panel contradiction: "Gate: G0+G1 Brief confirmed" next to "Draft: not confirmed yet" and "Next: You, review the proposal" (`ax/20-s1003.png`). Wrong or stale gate label. (P2)
4. Message pane is a nested scroll box inside the page, opens scrolled to the bottom so the agent's top-of-message text and the "Intake Clerk" header are clipped; the closed WO-1002 session shows a markdown bullet list rendered with bullets outside the text column, and a duplicated "The work order is finished. · The work order is finished." banner (`ax/04-session.png`). (P3)
5. Markdown quality: bold, inline code, lists render; tables, fenced code, numbered lists, blockquotes, footnote-style citations are not supported by the safe renderer (code read, `views/console/Markdown.tsx`, 66 lines). The close-station summary is a truncated run-on ("...the 10 pure te") (`ax/04-session.png`): summaries are cut at 200 chars (`station.ts` `result.summary.slice(0,200)`). (P2)
6. Conversations list for asha shows "No open conversations" while WO-1003 had just been opened: stale until refetch, bell shows 1 (`ax/03-conv.png` taken before submit; list refresh after submit not re-checked, guess).
7. Console (`ax/05-console.png`): works, stateful, but it told asha "I can't submit a work order. Console actions are switched off" then 2 hours later "I was wrong earlier" — a model inconsistency the UI cannot show provenance for. No threads list/new/rename. The console's Context panel is the one good "what can I do" affordance.

## 2. Gap list vs the vision

| # | Gap | Sev | Evidence | Recommendation (short) |
|---|---|---|---|---|
| G1 | Research (and every post-Intake station) cannot hold a dialogue with the human; one question max, parks the WO into the legacy scripted thread | P0 for the vision | station.ts:131; starter-kit | Make every station run able to pause with N structured questions into the same session; resume the same run with the answers (section 4.2) |
| G2 | No web research capability; no sources/citation model beyond repo paths | P0 for the vision | starter-kit.ts:406; edge allow-list | Add governed research tools (search, fetch) via MCP or edge `research` purpose, allow-listed, logged, with citation records (4.3) |
| G3 | No research swarm / sub-agents; no way to show parallel work | P1 | none in repo | Orchestrator run spawns bounded sub-runs (children of the attempt), each with its own budget and result; UI shows a fan-out board (4.3) |
| G4 | Agent outputs are JSON, not markdown documents; `artefacts` table unused; no document viewer, no versions, no diff between versions, no per-section comment | P0 for the vision | Tabs.tsx:86; 0 rows | Every station emits a markdown document (+ structured block) stored as a versioned artefact; one viewer (4.4) |
| G5 | No agent-to-agent dialogue visible to humans (reviewer challenges spec, designer challenges research) | P1 | spec 10.2 | "Challenge" turns: a second agent posts structured objections into the thread; human sees and arbitrates (4.2) |
| G6 | No assumptions log: Intake invented defaults and listed them as proposal text; nothing tracks "assumed vs confirmed vs unknown" across stations | P1 | `ax/20-s1003.png` | First-class Assumption/Question/Decision records, status, owner, source (4.2) |
| G7 | Agent is instructed to ask at most two questions and then act: this directly contradicts "no assumptions" | P1 | workorder-session.ts:56 | Change the contract: agent may not propose a brief while a blocking question is open; it labels each field confirmed/assumed. This is a prompt + validation-rail change, not hardcoded questions |
| G8 | Chat lifecycle: no new/rename/archive/search/share; no Console thread list; one conversation per WO forever | P1 | console.tsx:343; conversations.tsx | Unified conversation model with threads (4.5) |
| G9 | Four fragmented surfaces and four data models; legacy Conversation tab still shipped beside the session | P1 | workorder-session.md | One Agent Workspace shell, per-scope threads, shared card vocabulary (4.1) |
| G10 | No live view of what a working agent is doing (steps, tools, files, cost) | P1 | runtime events exist, no UI | Run timeline panel fed by the existing event stream (4.3) |
| G11 | Multi-user: no attribution of answers, presence, assignment, or notification of the right person for a question | P1 | workorder-session.ts:369; `ax/30-daniel.png` shows non-participants get "waiting for you" | Messages carry author; questions carry `ask_of` (person/role); only they see "waiting for you" |
| G12 | Console actions: spec 12.6 says per-person `console.propose.*` rights; wave4 note says a factory-wide switch; the live console told the user actions were off. Inconsistent docs/behaviour | P2 | spec 12.6 vs wave4-console.md | Reconcile; show rights in the workspace composer (already in Context panel) |
| G13 | Station summary truncated to 200 chars in the ledger and session | P2 | station.ts | Store full summary; truncate only in list previews |
| G14 | Markdown renderer too small for research docs (tables, code, links to sources, anchors) | P2 | Markdown.tsx | Promote to shared `ui/Markdown`, add GFM subset, citation chips (still no raw HTML) |
| G15 | Side-panel gate status wrong during draft; red-diff of scaffold lines | P2/P3 | `ax/20` | Fix label source; diff against human-authored content only |
| G16 | Cost/budget governance of conversations: console has no per-person cap; sessions metered under purpose `console` with no `agent_id` | P2 | workorder-session.md "Not done" | Meter per agent and per thread; show spend in the thread header |
| G17 | Unverified: real model behaviour under injection in research with web content (new attack surface once G2 lands) | P1 when G2 ships | n/a | Treat web content as untrusted exactly like repo/request text; eval suite |

## 3. Design principles for the target

1. One workspace, many scopes. A conversation always belongs to a scope (work order, repo onboarding, project, factory) and has participants (humans and agents). The Console becomes "the factory-scope thread", not a separate product.
2. Agents propose, humans approve, nothing else changes state. Questions, assumptions, research plans, spawn requests, documents moving to "accepted", brief confirmation are all proposals/cards. Approval runs under the approver's own rights (the existing pattern from `confirmAgentBrief`, `reclassify`, `decline`, console confirm cards).
3. No hardcoded content. The product defines the shape (question, assumption, source, document, objection, approval) and the rails (schema validation, untrusted marking, budget caps, permission checks, allow-listed hosts). Which questions to ask, which sources to read, how many sub-agents, and what the documents say are agent decisions. This matches the owner's agent-led principle (MEMORY.md).
4. Provenance on everything: who/what said it, which model/version, which run, observed vs agent-reported vs human-confirmed.
5. Nothing is lost: archive, never delete (except retention policy), every artefact versioned.

## 4. Target interaction model

### 4.1 Information architecture: the Agent Workspace

Top-level nav item "Agents at work" (replaces separate Conversations + Console + traveler Conversation tab + onboarding session as entry points; the old routes redirect). Three-pane layout:

```
+---------------------+--------------------------------------+---------------------------+
| LEFT: inbox         | CENTER: thread                       | RIGHT: context (tabs)     |
|  Needs me (n)       |  header: scope chip, participants,   |  Documents | Sources |      |
|  Active             |  station belt, cost, state           |  Questions | Run |        |
|  Mine / Shared      |  turns: human, agents, system        |  People                   |
|  Archived           |  cards inline: question, proposal,   |                           |
|  Search             |  assumption, research plan, diff     |  (document viewer opens   |
|  [+ New chat]       |  composer: @agent, @person, / cmds   |   here or full-width)     |
+---------------------+--------------------------------------+---------------------------+
```

- Left inbox groups threads by scope: Work orders (one primary "work-order thread" plus any side threads), Repos (onboarding), Factory (console-style chats). Filters: needs me, waiting on agent, mine, shared with me, archived, scope, agent. Search is full text over messages, questions, documents.
- Center: one chronological thread per conversation. Station changes are dividers ("Research started, Researcher v1, sonnet-5-5"); the speaker label always shows agent + version or person.
- Right: tabs bound to the same scope: Documents (all station markdown, versioned), Sources (every URL/file cited, deduped, with who fetched), Questions & Assumptions (the log), Run (live timeline + swarm board), People (participants, who may approve what).
- The work-order Traveler stays as the compact status/gate/ops sheet but its "Conversation" and "Artefacts" tabs become deep links into the workspace (one source of truth). The Record keeps the compliance view.

A work order has a "primary thread" (what exists today as the session) and may have side threads: "Ask the researcher about X", "Review thread with Security", "Why did the designer choose Y". Side threads can carry a single agent or several; the primary thread is the only one that can advance gates.

### 4.2 Dialogue protocol (humans and agents)

Message types (all stored, all rendered as cards in the thread). Existing: text, question card (`ask_user`), proposal card (brief/reclassify/decline), update. New:

| Type | Who emits | Meaning | Human action | Rail |
|---|---|---|---|---|
| Question | any station agent, via `ask` tool with `blocking: true/false`, optional `options[]`, `ask_of: person|role|anyone`, `why_it_matters` | Needed fact, not guessable | answer (free text/option), "I don't know", "delegate to X", "not relevant" (agent must record it) | bounded count per run, schema validated, answer saved with author and time |
| Assumption | agent, via `assume` tool | "I am proceeding as if X because Y" | confirm, correct (becomes a Decision), leave (stays flagged) | An unconfirmed assumption is shown on every downstream document and gate card; a gate approval with open assumptions requires the approver to see the list (not block, but visible and recorded in the gate decision) |
| Decision | human or agent-proposed-human-approved | Resolved question/assumption | n/a | audited |
| Research plan | research orchestrator | Sub-questions, intended sources (repo, docs, web domains), sub-agent count, budget | approve / edit / reduce scope / add a question / skip web | **Plan approval gates the spend and the web access**; hosts must be on the egress allow-list or are listed for approval |
| Findings update | research agent(s) | Claim + evidence + confidence + source ids | accept, challenge ("source weak"), ask follow-up | claims without a source are rendered as "unsupported" |
| Objection | a second agent (reviewer, designer, spec) | "Research says A, but source B says C" / "Acceptance criterion 3 is untestable" | human arbitrates: agree with objector, agree with author, ask both | objections are structured (target artefact + section + reason); an unresolved objection is visible on the gate |
| Document proposal | station agent | A new markdown document or revision | accept as station output, request changes (inline comments on sections), reject | accepted document becomes the station's official output (hash-recorded) |
| Approval/gate card | system (from gate engine) | existing G0..G5 | existing approve/reject with own rights | existing |

Dialogue rules (all enforced as rails, with agent-authored content):
- "No assumptions" is operationalised, not hardcoded: an agent may proceed on an unknown only by emitting an Assumption record; unrecorded assumptions are an eval failure (add `ASSUME-*` cases to each station suite).
- Cross-station continuity: station handoff stays "artefacts, not transcript" (spec 10.2), but the Questions/Assumptions/Decisions log is part of the handoff, so the Spec agent starts with what the Intake and Research dialogues settled and does not re-ask.
- Agents can address each other only through the thread (visible), never privately: `@Designer, research found X`. The orchestrator (existing flow engine) decides who gets a turn; a human can pause or take a turn at any time.
- A blocked run does not hold a runner slot: it checkpoints (adapter `interrupt` + checkpoint tables exist), the WO shows "waiting on <person>", and on answer a `resume(run, input)` starts a fresh run from saved artefacts + log (the existing contract).
- Unanswered question escalation: after SLA, notification to the asked person, then to the project role (reuse existing notification `question` event, `presets.ts:70`).

### 4.3 Research swarm presentation

Flow: (1) Research agent reads the confirmed brief and posts a Research plan card. (2) Human approves/edits. (3) Orchestrator spawns N bounded sub-agents ("scouts"), each owning one sub-question and a tool set (repo read, web search/fetch, docs MCP). (4) Findings stream into the thread as a collapsed "Research swarm" card; (5) the synthesizer writes `research.md`; (6) human reviews the document and the open questions; gate as today.

Swarm card (in thread, expandable; full board in the right "Run" tab):

```
Research swarm  4 scouts running · 2 done · $0.41 of $2.00 · 3m12s        [Pause] [Stop]
 Scout A  "How is retry done elsewhere in this repo"   repo     done   6 findings  2 files
 Scout B  "Nautobot job retry/backoff guidance"        web      running  fetched 5 pages ...
 Scout C  "Known issues with API client timeouts"      web      running
 Scout D  "Existing tests that exercise sync failure"  repo     queued
 Sources (14): docs.nautobot.com/...  [fetched by B, 02:31]  github.com/...  [repo @ a1b2c3d, jobs.py:15-34]
```

Rules:
- Every finding is `{claim, evidence[], source_ids[], confidence, observed|reported, scout}`. Web claims always carry a URL, retrieval time, and a content hash/snapshot id (so the reviewer can see what the agent saw even if the page changes).
- Source panel groups: repository (path, commit, lines), web (URL, title, fetched at, domain), internal (tickets, docs via MCP). Click a source to see the excerpt the agent used. Contradictions between sources are flagged by the synthesizer as Objection cards.
- Citations in markdown use `[^s12]`-style footnote ids resolved against the Sources tab, rendered as chips (not free hyperlinks to arbitrary hosts).
- Controls: pause, stop one scout, add a scout ("also check X"), cap budget, restrict to repo only. All are human actions on the plan, not hidden settings.
- Live run timeline (right "Run" tab) for ANY station: ordered runtime events (step, tool call, tool result summary, usage, artefact, question) already defined in spec 10.1; show them as a compact log with cost ticking.
- Safety: web pages are untrusted data, marked like request/repo text; fetched content never becomes instructions; egress limited to an allow-list plus per-plan approved domains; downloads disabled; the research plan card shows the allow-listed domains; all fetches are audit events with URL (no secrets in URLs, strip query tokens).

### 4.4 Documents (markdown per agent)

- Each station produces one primary markdown document plus its structured result: `intake-brief.md`, `research.md`, `spec.md`, `design.md`, `plan.md`, `build-notes.md`, `verify-report.md`, `review.md`, `release-notes.md`. Filenames are the agent's decision beyond the primary one; additional files allowed (`research/sources.md`, `research/scout-b.md`).
- Stored as content-addressed `artefacts` (table exists; the runner already uploads artefacts) with: version, author (agent version / person edit), supersedes, accepted_by, labels (agent-reported vs system-observed sections stay as fenced metadata).
- Viewer: rendered markdown with outline, source chips, assumption highlights (assumptions inline underlined, click to confirm), version switcher with diff, per-section comments that become messages in the thread, "Request changes" posts a card to the author agent, "Accept as station output" is the human approval (can be fused with the gate approval).
- Humans may edit a document directly; an edit is a new version authored by the person and is flagged for the gate "artefact edited before approval" (the field `artefactEdited` already exists in gate data, `engine.ts:541`, currently always null).
- Export: Copy as Markdown / download bundle (the Record export already has hashes).

### 4.5 Chat lifecycle

| Action | Behaviour |
|---|---|
| New chat | "+ New chat" from the workspace: choose scope (factory / project / work order / repo) and agent(s) (default: the agent of the current station, or "Console assistant"). Pre-fills context chips. A work order's primary thread is created by the system and cannot be deleted. |
| Rename | Any participant with write access to the thread; default title is the agent's one-line summary (agent proposes, human may edit). |
| Pin | Per user (pinned to the top of my inbox). |
| Archive | Thread-level state `archived`, per thread, by owner or project admin; archived threads are read-only and searchable; a work order's primary thread auto-archives (not deletes) at close + N days, reopening on follow-up. Replaces silent 90-day deletion with a configurable retention policy (the existing `retention_days/expires_at` can remain as the hard delete after archive). |
| Search | Full text (Postgres FTS) over messages, documents, questions, sources, filtered by what the user may see (reuse the console's "call the product's own GET endpoints as the person" visibility principle). Filters: scope, agent, person, has-open-question, date. |
| Share | Visibility `private` (only me; console default), `project` (anyone with `project.view`, work-order threads default), `invited` (named people). Sharing a private thread creates a read-only snapshot link or invites participants; sharing never widens what a participant can see in other systems. |
| Participants | Humans (author, invited, mentioned), agents (the station agent, any @-mentioned agent). Mention a person to assign a question to them; they get a bell/Slack item. |
| Handoff between people | "Waiting for you" is computed from the question's `ask_of`, not from "anyone on the project" (fix for the Daniel view). |
| Retention/export | Thread export to markdown/JSON; audit trail keeps message metadata (never text) as the console does today. |

### 4.6 How agents-propose/humans-approve is preserved

| Action | Proposed by | Approved by | Executed as |
|---|---|---|---|
| Brief, reclassify, decline | Intake agent | person with `brief.confirm` / `wo.classify` / `wo.decline` | existing commands, `via: session` |
| Research plan (scope, web access, sub-agent count, budget) | Research agent | person with `wo.answer` (budget raise needs the budget right) | new command `research.plan.approve`; the budget and allowed domains are enforced by the gateway/edge, not by the agent |
| Spawn a sub-agent beyond the plan | orchestrator | same | new, capped |
| Document accepted as station output | station agent | gate approver (existing G-gates) | existing gate approve |
| Answer to a question | human | n/a (humans speak freely) | message |
| Assumption confirmed | human | n/a | Decision record |
| Agent-initiated "start side thread with agent X" | any agent | person who is a participant | creates thread; no state change |
| Console actions (halt, approve, kill...) | console model | the user, with own rights, typed phrase for dangerous | existing confirm cards |

Deterministic code = schemas, caps, allow-lists, untrusted marking, permission checks, audit. Content = agents.

## 5. Backend capabilities required and whether they exist

| Capability | Needed for | Exists? | Gap |
|---|---|---|---|
| Streaming agent turns, tool loop, proposal cards, approval under own rights | Intake dialogue | Yes (`areas/workorders/session`, `routes/workorder-session.ts`, `session/core.ts`) | generalise from Intake-only to all stations; later stations "answer read-only and cannot propose" |
| Question cards | all stations | Partly (`ask_user` at Intake and onboarding) | add `blocking`, `ask_of`, `why`, `answered_by`; store as first-class rows, not only inside message JSON cards |
| Run pause/resume with human input | Research dialogue | Contract only (10.1 `resume`, checkpoints table, `needs_person` result with a single question) | implement `needs_person` with N questions into the session thread; implement resume-with-answers in dispatch; remove dependence on legacy `conversations` rows (`station.ts:131`) |
| Station agent writes through a tool, not only a final JSON | doc proposals | No | runner tool `write_document(name, markdown)`, `ask(...)`, `assume(...)` with schema validation; the Claude harness supports custom tools/MCP |
| Markdown artefact storage | documents | Table + upload exist (`artefacts`, `internal/runs.ts:216`, object storage `sha256/<hash>`); nothing writes station docs; no read API for artefact bodies in the web | add `GET /work-orders/:id/artefacts[/:id]`, versioning columns (version, supersedes, accepted_by, author_kind), full-text index |
| Web research tools | G2 | No | MCP server or edge `research` purpose: `web_search`, `web_fetch` through the egress proxy with per-plan domain allow-list, content size caps, snapshot store, audit event per fetch; keys held by the edge like model keys |
| Sub-agents / swarm | G3 | No | parent/child attempts (`attempts.parent_id`), concurrency cap per org (existing vendor limiter + eval concurrency cap pattern), budget split from the parent, kill/halt fences inherited (existing stop enforcement), per-child result schema; orchestrator can be a single agent run that calls a `spawn_scout` tool (agent-led) with hard rails on N and budget |
| Source/citation records | G2, 4.3 | No (only `sources: string[]` of repo paths in output JSON) | `research_sources` table (id, wo_id, kind, uri, title, fetched_at, content_hash, commit, lines, fetched_by_run) |
| Assumption/Decision log | G6 | No | tables `wo_questions` and `wo_assumptions` (status, owner, ask_of, answered_by, linked doc section) feeding station handoff and gate cards |
| Agent-to-agent turns | G5 | No | `objection` message type; flow engine grants a "challenge turn" to the next/previous station agent on the primary thread; budget per turn; human can disable per project |
| Unified conversations | G8/G9 | No: 4 tables | new `threads` (id, scope_type, scope_id, owner, title, visibility, state, pinned_by[], archived_at) and `thread_messages` (author_kind/id, type, body, cards jsonb, run_id, artefact_id); migrate console_threads/workorder_messages/onboarding by view or backfill; keep old endpoints as read-compat |
| Thread list/rename/archive/search/share endpoints | G8 | Console only: list/get/delete/pin (work orders pins) | add PATCH title/state/visibility, search endpoint (FTS), participants |
| Live run events to the browser | G10 | Events stored per runtime contract; SSE exists for turns | `GET /runs/:id/events` SSE (redacted: tool name + summary, never secrets); reuse `core/stream.ts` |
| Per-person/per-thread budgets | G16 | Per-agent per-WO budget exists; console uncapped | meter with `agent_id`, `thread_id`; per-person daily cap |
| Attribution + `ask_of` routing + notifications | G11 | Notification events exist (`question` preset) | add person targeting and SLA escalation |
| Gate shows open assumptions/objections/doc version | 4.2 | Gate data has `artefactEdited:null` placeholder | populate; show on gate card |
| Evals for dialogue behaviour | quality | Station suites exist | add ASSUME-, ASK-, CITE- cases (no unrecorded assumption, no unsupported claim, question when ownership unknown (RES-03 already)) |
| Untrusted-content handling for web | G17 | Pattern exists (`<untrusted>` wrapping, defanged tags) | apply to fetched pages; strip scripts; sandbox rendering; injection evals |

## 6. Phased build order

Phase 0 (1 week, fixes that remove current confusion; no new concepts)
1. Fix side-panel gate label contradiction, scaffold-line red diff, duplicate banner, summary truncation (G13/G15).
2. Reconcile console rights docs/behaviour (G12). Retire the traveler's legacy Conversation tab: deep-link to the session.
3. Console: thread list, New chat, rename, search by title (backend already has list/get/delete/pin; add PATCH title). This alone fixes the most visible "organizing chats" gap.

Phase 1 (2-3 weeks): Documents and questions across all stations (the foundation everything else needs)
1. Station agents emit a markdown primary document through `write_document`; store as versioned artefacts; viewer with outline, version diff and Copy/Download; shared GFM-lite `ui/Markdown` (G4, G14).
2. `ask` tool for every station with `blocking`, `ask_of`, options; run checkpoint + resume with the answer; remove legacy `conversations` dependency; all post-Intake stations get a session turn that can ask (G1).
3. Questions/Assumptions log as tables; assumption tool; handoff includes the log; gate cards list open assumptions (G6). Change the Intake prompt so a brief is not proposed while a blocking question is open (G7).
4. Attribution of answers and `ask_of`-based "waiting for you" (G11).

Phase 2 (3-4 weeks): Research that thinks and cites
1. Web research tools behind the edge with allow-list, snapshots, audit (G2); `research_sources` table; citation chips in the viewer and a Sources tab.
2. Research plan card (approve/edit/limit web) as a proposal with budget enforced by the gateway.
3. Run timeline panel (SSE of runtime events) for every station (G10).
4. Eval cases: CITE, ASK, ASSUME, injection through web content (G17).

Phase 3 (3-4 weeks): Swarm and agent-to-agent dialogue
1. Parent/child attempts, `spawn_scout` with N and budget rails, fan-out board, pause/stop per scout (G3).
2. Objection turns between adjacent stations (G5); arbitration UI; gate shows unresolved objections.
3. Side threads with a chosen agent, @mention routing.

Phase 4 (3-4 weeks): One workspace
1. Unified `threads/thread_messages` model; workspace shell with inbox groups, scopes, participants; redirect Conversations/Console/Onboarding session routes (G8, G9).
2. Archive/auto-archive, share/visibility, full-text search over messages + documents + sources, export.
3. Operator view: stuck/waiting/over-budget threads, per-thread spend, per-person caps (G16).

Sequencing rationale: documents + questions (P1) are prerequisites for research to be worth watching; web access (P2) before swarm (P3) because the swarm's value is parallel web/repo scouting; the unified shell (P4) is last because it is a re-skin over a model that must first exist, except the cheap console thread list pulled forward in P0. Each phase ships independently under existing human-approval gates.

## 7. Open questions for the owner (do not assume)

1. Should the primary work-order thread continue to be shared with everyone who has `project.view`, or default to invited-only for sensitive projects?
2. Which web sources are acceptable (any public host, an allow-list, or only via an approved search provider)? This determines the egress design and the injection risk posture.
3. Is a "swarm" cost-capped per work order, per station, or per research plan? (Proposed: per plan, human-approved.)
4. Should humans be able to edit agent documents directly (proposed yes, flagged at the gate) or only request changes?
5. Should agent-to-agent challenges be on by default, or opt-in per project/class?

## Appendix: evidence index

- Screenshots in `review/ax/`: `04-session.png` (closed WO session, markdown/summary truncation), `03-conv.png` (conversations list), `05-console.png` (console), `08-record.png` (record), `12-new.png`/`14-submitted.png` (new work order), `20-s1003.png` (live Intake dialogue and brief proposal as asha), `30-daniel.png` (same session as project admin daniel), `21a.png` (traveler journey: Researcher ran <1m, 2.5k tokens).
- DB: `workorder_messages` 72 rows at start; `console_threads` 1; `artefacts` 0; `outputs.research` JSON keys `_labels, sources, findings, openQuestions`.
- Code: `services/api/src/routes/workorder-session.ts` (prompt line 56, answer attribution 369), `services/api/src/areas/workorders/session/tools.ts`, `services/api/src/areas/workorders/station.ts:115-141`, `packages/domain/src/starter-kit.ts:406-428`, `apps/web/src/views/traveler/Tabs.tsx:86-170`, `apps/web/src/views/console.tsx:63-89,343`, `apps/web/src/views/console/Markdown.tsx`, `services/api/src/routes/console.ts:99-131`, `runner/wrapper/src/adapters/claude.ts:68`.
