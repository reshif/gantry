# Home redesign

Status: implemented: P1 in full, and from P2 InMotion (aggregate belt, recent completions, shipped vs previous week when meaningful), the Auditor "Waiting on approvers" view, the Viewer variant, the mobile order and a11y landmarks. Not yet: Release Manager windows/freezes split, "one approver" bus-factor attention item, Auditor control-exception items linking to a pre-filtered Audit, e2e and axe passes. Decisions applied: one Home for everyone; Kill/Restore only in the status chip popover and Ctrl K (Attention shows a killed factory with restore progress and a Restore button for those allowed); agent success replaced by real eval health (live versions vs suite threshold, `eligibility`). Original proposal follows.

Scope (original): `apps/web/src/views/home.tsx`, `views/home/*`, `services/api/src/areas/home/*`, `GET /api/v1/home` (spec 8.3).

## 1. Inventory of what Home renders today

One request feeds it: `GET /api/v1/home` (`useHome`, computed by `computeHome`, `services/api/src/areas/home/compute.ts:173`) plus `useProjects()` and, for the factory view, a second `GET /api/v1/activity`. The same `useHome` data already drives the top-bar bell (`shell/TopBar.tsx:179` `InboxBody`: approvals + conversations) and the sidebar badges (`home.badges`, `home.projectBadges`).

Routing (`home.tsx:32`): anyone with a factory-scoped role (Factory Admin, Auditor, and any other factory-scoped role) gets `FactoryView`; everyone else gets `MyWork`. A toggle button flips between them for factory roles.

### 1a. FactoryView (`views/home/Factory.tsx`) - Factory Admin and Auditor

| # | Item (file:line) | Data source | Verdict |
|---|---|---|---|
| F1 | Header sentence (Factory.tsx:60,67) `"Factory running. 1 projects, 0 work orders in flight, 0 waiting on approvers, 1 item need attention."` | `figures`, `attention`, `control.killed` | DUPLICATE of F4, F5 tiles, status chip ("Running"), attention panel. GRAMMAR BUGS: `"1 projects"` (no plural handling), `"1 item need attention"` (`item${s} need`, should be "needs"). Remove the sentence. |
| F2 | Meta box (Factory.tsx:68) `SIGNED IN Asha Raman / ROLE Factory Admin / PROJECTS 1 active · 0 archived` | `me`, `figures.projects` | LOW VALUE. Signed-in name and role are in the user menu; project count is on Projects page (its own meta box, projects.tsx:37) and in the switcher. Remove. |
| F3 | Buttons `New project`, `My work` (71-72) | `useCan("project.create")` | "New project" is useful only as the empty-state next step; otherwise it belongs on Projects. "My work" is a mode toggle that hides the whole factory view; replace with a single page (see 3). |
| F4 | KPI row (76-87), 6 tiles | `figures` | See rows below. |
| F4a | IN FLIGHT 0 (`0 running · 0 in bays`) | `figures.inFlight` | DUPLICATE of F1, F10 (Control "0 work orders in flight"), Control impact "In flight". Keep once, in "In motion". |
| F4b | SHIPPED 0/0 `today / last 7 days` | `figures.shippedToday/Week` | Meaningful only with history. Keep as trend line in Health, hide at zero. |
| F4c | GATES WAITING 0 | `figures.gatesWaiting/oldestWaitMs/lateGates` | DUPLICATE of F1, Human attention "Waiting" + "Oldest" (Human.tsx:~14), attention "past SLA" items, bell count. Keep once, in "Waiting on you"/"Attention" (late gates). |
| F4d | HALTED OR KILLED 0 `all running` | `figures.stops` | DUPLICATE of status chip, attention items (halted/killed), crit callout F5, Control state, project-switcher dot. Remove tile; surfaces only as attention. |
| F4e | SPEND VS BUDGET `0%` `$0 of $2,000` + meter | `figures.spent/budget` | MISLEADING at zero (a "0%" gauge with no spend). DUPLICATE of SpendPanel F9 and budget attention items. Keep in Health only; at zero say "No spend yet". |
| F4f | AGENT SUCCESS `–` `no scored runs yet` | hard-coded `agentSuccess: null`, `agentSuccessTrend: []` (compute.ts, `figures`) | MISLEADING: never populated by the API, permanently "–". Remove until real eval/run data feeds it. |
| F5 | Critical callout `"N critical: ..."` (88-93) | `attention` sev 0 | DUPLICATE of the same items in F7. Becomes the Attention strip. |
| F6 | Section "Portfolio" with full `<Portfolio ctx="hm-pf">` toolbar (95-100): Layout Cards/Rows, View, Save as view, Rename, Delete, Search, Group by, Sort, Ascending, Health, Team, Template | `useProjects`, `views/projects/portfolio.tsx:260`, saved views API | WRONG PLACE. This is the Projects page tool (projects.tsx:46, same component, ctx "prj-pf"). Two separate saved-view contexts for one concept. Replace with a compact project list; link to Projects. |
| F6b | Legend (101-103) `"station, darker = more WIP  gate waiting  blocked work. Select a belt to open its floor."` | static | Noise at 1 project. Move into the Projects page/legend tooltip. |
| F7 | `AttentionPanel` "Needs attention" (Panels.tsx:14-53), `"Nothing needs attention"` empty text is a long list of every category | `attention` (compute.ts:30 `attention()`): factory killed, project killed/halted, budget >= alert, repo halted, onboarding failed/person/red PR, WO blocked/failed/sechold/person, late gates, eval below threshold, vendor >= 85%, integration failing/offline | KEEP, promote to the top, as Attention strip. Fix: "Show the top 8" toggle, long empty text, sev legend `0 critical 0 high 0 watch`. |
| F8 | `HumanPanel` "Human attention" (Human.tsx:7-68) with three sections: Approvals waiting (Waiting/Oldest/One approver + per-person list), Trust, Learning | `human` | Approvals: DUPLICATE of F4c; the per-person list is Workload page content (`#workload`). Trust and Learning: DUPLICATE of sidebar badges (`badges.trust`, `badges.learning`) and their own pages; empty copy "Nobody has approvals waiting." / "No learning proposals waiting for review." is noise. Move all to Workload / Trust / Learning; keep only "one approver" (bus-factor) as a Watch attention item. |
| F9 | `SpendPanel` "Spend this month" (Panels.tsx:149-169), by project and by vendor bars | `spend` | DUPLICATE of F4e and of attention budget items; "By project" duplicates project cards' budget. Vendor spend belongs on Models. Keep as one collapsed Health row. |
| F10 | `ControlPanel` "Factory control" (Control.tsx:13-90): `FACTORY RUNNING 1 projects · 0 work orders in flight · 0 agents running`, tiles PROJECTS 1 / IN FLIGHT 0 / AGENTS 0 / OPEN PRS 0, kill explanation, Kill button, "Factory Admins: ...", "Restore rule in Security" | `control` | DUPLICATE: running state is in the status chip, counts repeat F1/F4a/F2, "1 projects" grammar again, tiles are the kill-confirmation impact (already fetched by `GET /api/v1/stops/impact` in the kill dialog, `StopDialogs.test.tsx:82`). A big red-button panel on a landing page is the wrong default (accident risk, and the Auditor sees a disabled copy). Move kill to the status popover; restore progress shows in the Attention strip when killed. |
| F11 | `ActivityPanel` "Live activity" (Panels.tsx:57-84) last 14 audit entries | `GET /api/v1/activity` (second request) | DUPLICATE of the Audit page; not "live" (no polling/stream). It is not a decision aid. Remove; keep a one-line "Recent: N events, Audit ledger" link only for Auditor. For "recent completions" use the In motion list instead. |
| F12 | `OnboardingPanel` "Onboarding pipeline" (Panels.tsx:86-119): stage counts Connected...Ready, `0 of 1 ready`, stuck list, open list | `onboarding` | DUPLICATE of attention onboarding items, "Merge onboarding PR" approvals, project badge `onboarding`, and the Onboarding page. Nine stage counters for 1 repo is noise. Replace with per-project status line in the Projects summary + next-step card. |

### 1b. MyWork (`views/home/Mine.tsx`) - Project Admin, Engineer, Reviewer, Line Lead, Release Manager, Viewer

| # | Item (file:line) | Data source | Verdict |
|---|---|---|---|
| M1 | Header "My work", sub `"What is waiting for X across N project(s)."`, meta `SIGNED IN / ON CALL / AWAY` (Mine.tsx:100-102) | `me` | Signed in duplicates user menu. On call / Away: keep Away only if set (it changes who can approve). |
| M2 | Buttons `New work order`, `Factory overview` (105-106) | `useCan("wo.submit")`, `mine.factoryRole` | Keep "New work order" (guarded). Remove mode toggle. |
| M3 | KPI tiles (110-115): MY APPROVALS, MY WORK ORDERS, QUESTIONS FOR ME, MY PROJECTS | `approvals`, `mine`, `conversations` | DUPLICATE of the four panels immediately below (count shown in tile AND in each panel header AND in the bell). `"No ... shipped this week"` copy `"in flight · N shipped this week"` uses `doneAt` window; fine as content. Remove tiles. |
| M4 | Panel "My approvals" (117-119) incl. `ApprovalRow` (47-83), inline Approve / Confirm release | `home.approvals` = `myApprovals()` (compute.ts:100): waiting gates I may decide, onboarding PRs I may merge with green checks, onboarding session updates | KEEP, it is the core. DUPLICATE of the bell popover (same data, TopBar.tsx:179), which is fine: bell = glance, Home = work surface. Row text repeats `have of need approvals` twice in one row (line 74 and 75). Fix. |
| M5 | Panel "Conversations awaiting my answers" | `home.conversations` = `myConversations()` | KEEP, merge into one "Waiting on you" list. |
| M6 | Panel "My work orders" tokens | `mine.workOrders` | KEEP as "In motion" (mine). |
| M7 | Panel "My projects": cards with key, health, your roles, MiniBelt, Floor / Work orders | `mine.projects`, `useProjects` | Mostly duplicates the project switcher and Projects page. Keep compact (name, health, MiniBelt, role chip). |
| M8 | Empty panels `"No approvals waiting"`, `"No questions for you"`, `"No work orders from you"`, `"No projects yet"` (4 empty boxes at once) | static | NOISE. Collapse into one empty state with the single next step. |

Gaps in MyWork (default-deny is respected, but the view is blind): no signal for halted/killed project, blocked/failed WOs, late gates or failing onboarding in the person's projects. `attention()` is computed for factory roles only (compute.ts returns early `if (!factoryRole) return out;`).

### 1c. Per role: what Home shows today

| Role | Today |
|---|---|
| Factory Admin | FactoryView (F1-F12) + toggle to MyWork. Can kill/restore. |
| Auditor | Same FactoryView, read-only: Control panel and "New project" rendered but disabled/locked; Human/Spend/Activity visible. Kill block is pure noise for them. |
| Project Admin | MyWork only; no project health, no blocked WOs, no onboarding signal (the badges only show in sidebar). |
| Engineer / Reviewer / Line Lead / Release Manager | MyWork; four mostly-empty panels. |
| Viewer | MyWork; approvals/conversations always empty; lands on four empty states. |
| No access (no grants) | Never reaches Home: landing redirects to "No access yet" (navigation.md). Fine. |
| Single-project non-factory user | Landing is that project's Floor, Home is reachable but secondary. |

### 1d. Already provided elsewhere (so Home must not repeat)

| Fact | Where it already lives |
|---|---|
| Factory running/killed, time, windows, freezes | Top-bar status chip + popover (`shell/StatusCluster.tsx`) |
| Halted/killed project | Project switcher dot, Floor sidebar badge (`projectBadges.floor`) |
| Approvals / questions count and list | Bell + inbox popover; Work orders / Conversations sidebar badges |
| Trust / learning proposals, failing integrations | Sidebar badges (`badges.trust`, `learning`, `integrations`) |
| Project counts, filters, saved views, templates | Projects page |
| Signed-in identity | User menu |
| Audit | Audit page |
| Per-person approval load | Workload page |

## 2. Principles

1. Order of questions: (1) Is anything wrong or blocked? (2) What needs ME now? (3) What is moving? (4) How are we doing?
2. One fact, one place. Each number appears once on Home, and not at all if the top bar/sidebar already carries it as an always-visible badge.
3. Role-aware by data, not by CSS. The API returns only what the caller's grants allow (default deny, spec 14); the UI renders what is present. No disabled copies of admin controls for people who cannot use them (Auditor).
4. One Home, no mode toggle. Factory roles get extra sections (Factory health, factory-wide attention); everyone gets Waiting on you + In motion + Projects.
5. Empty states give the single next step, in order, and replace the empty sections (not a grid of empty boxes).
6. Progressive detail: Home summarises and links (Projects, Floor, Onboarding, Audit, Workload, Models, Trust). No embedded tools (filters, saved views, kill dialog).
7. Stable layout: Attention strip and next-step card collapse to nothing; the three main blocks keep fixed positions so the page does not jump when something appears.
8. Numbers with context only when meaningful (vs previous 7 days when there were runs; otherwise "No spend yet", "No runs yet"). No gauge at zero, no permanently dashed tile.
9. Correct plurals through one helper (`plural(n, "project")`), used by all strings.

## 3. Proposed Home

### 3a. Factory Admin, live org with one project onboarding (the user's case)

```
Home                                                            [ + New project ]
-------------------------------------------------------------------------------------
! ATTENTION (1)
  [rocket] Nautobot-Jobs onboarding needs you: verification failed       [Open session]
-------------------------------------------------------------------------------------
WAITING ON YOU (1)                          | NEXT STEP
  [rocket] Nautobot-Jobs · repo not ready   |  1 Connect GitHub          done
           Verification failed - 2h ago     |  2 Create a project        done
                       [Open session]       |  3 Onboard a repo          in progress
                                            |    Nautobot-Jobs: verification failed
-------------------------------------------------------------------------------------
IN MOTION                                    PROJECTS (1)               All projects >
  No work orders yet.                       Nautobot-Jobs   Onboarding   repo not ready
  They appear here once a repo is Ready.                                  [Open onboarding]
-------------------------------------------------------------------------------------
> Factory health                                       (collapsed; "No spend yet")
```
When everything is fine and the org is mature, the Attention strip and Next step disappear, and the page is Waiting on you, In motion, Projects, Factory health.

### 3b. Factory Admin, busy factory

```
Home                                                            [ + New project ]
-------------------------------------------------------------------------------------
! ATTENTION (3)   [critical] Payments Platform killed - "incident 42" - 3h  [Open]
                  [high]     WO-218 blocked - Billing - Build            [Traveler]
                  [high]     G4 past SLA on WO-210 - waiting 31h         [Traveler]
                  + 4 more                                              [Show all]
-------------------------------------------------------------------------------------
WAITING ON YOU (4)                              [ Approve all in Workload ]
  G2 Spec approval  WO-231  Billing        1 of 2 approvals  waiting 5h  [Review][Approve]
  G6 Release        WO-225  Payments       waiting 40m       [Review][Confirm release]
  Merge onboarding PR  nautobot-jobs#4  checks green                 [Open onboarding]
  Question  WO-240  "Which environment?"                                   [Answer]
-------------------------------------------------------------------------------------
IN MOTION                                       | PROJECTS (6)               All projects >
  Belt: S0 2 | Res 1 | Spec 3 | Des 1 | Plan 2  |  Billing      healthy   [mini-belt] 7 WO
        | Build 5 | Ver 2 | Rev 1 | Close       |  Payments     killed    [mini-belt] 0
  12 in flight - 5 agents running - 1 gate late |  Nautobot-J.  onboarding repo not ready
  Shipped: 4 today, 19 this week (+3 vs prev)   |  ... (max 6, sorted worst-first)
  Recently done: WO-222, WO-219, WO-214         |
-------------------------------------------------------------------------------------
v Factory health                                      (collapsed, admin/auditor only)
  Spend  $1,240 of $2,000 (62%)  +$180 vs last wk   Agent success 91% (13 runs)  Evals: 1 below threshold
```

### 3c. Auditor
Same as 3b minus: Waiting on you (replaced by "Waiting on approvers": count, oldest, per project, read-only), Kill/Restore, New project. Adds a one-line link "Audit ledger" in Factory health. No disabled buttons.

### 3d. Project Admin / Engineer / Reviewer / Line Lead / Release Manager

```
Home                                                          [ + New work order ]
-------------------------------------------------------------------------------------
! ATTENTION (1)  (only my projects)   WO-218 blocked - Billing - Build       [Traveler]
-------------------------------------------------------------------------------------
WAITING ON YOU (2)
  G2 Spec approval  WO-231 ...                                    [Review][Approve]
  Question  WO-240 ...                                                    [Answer]
-------------------------------------------------------------------------------------
IN MOTION  (my work orders + my projects' belts)    | MY PROJECTS (2)        All >
  WO-240 [Build, running]  WO-231 [Spec, waiting]   |  Billing  [mini-belt] roles: Line Lead
  Your role: Reviewer. Away: until 20 Nov           |  Payments [mini-belt] roles: Reviewer
```
Role differences are data-driven: Reviewer/Release Manager see gate rows only for gates they may decide; Project Admin additionally sees onboarding/budget/halt items for their projects; Engineer sees their own work orders and questions.

### 3e. Viewer
Attention (their projects, if any) + In motion (read-only belts) + Projects. No "Waiting on you" section (they hold no decide rights; section is omitted, not shown empty). If they have no work: "You have view access to Billing. Open the floor." with a single link.

### 3f. Empty / new org (Factory Admin)
```
Welcome. Three steps to your first work order
  1 Connect GitHub        [Connect]   (links Integrations)
  2 Create a project      [New project]
  3 Onboard a repo        (after 2)
```
Only the first incomplete step has a button. Non-admins in a new org: "Ask a Factory Admin to add you to a project."

### 3g. Mobile order
Attention, Waiting on you, Next step, In motion, Projects, Factory health (collapsed). Single column, 16px gutter; buttons min 44px height; belts become a stacked count list rather than a 9-column strip.

### 3h. Where each removed item goes

| Removed / moved | New home |
|---|---|
| Header sentence, meta box (Signed in / Role / Projects) | Deleted (user menu, Projects meta, status chip) |
| KPI IN FLIGHT | In motion header line |
| KPI SHIPPED | In motion (trend line) |
| KPI GATES WAITING | Waiting on you (own) / Attention (late) / Workload (per-person) |
| KPI HALTED OR KILLED, crit callout | Attention strip; status chip; project switcher dot |
| KPI SPEND VS BUDGET, SpendPanel | Factory health row; per-project budget on Project config; vendors on Models |
| KPI AGENT SUCCESS | Deleted until data exists; then Factory health |
| Portfolio toolbar, Save as view, legend | Projects page only |
| Human attention: Approvals | Waiting on you / Workload |
| Human attention: Trust, Learning | Sidebar badges + Trust / Learning pages |
| Live activity | Audit page; Auditor gets a link in Factory health |
| Onboarding pipeline | Next-step card + project row status + Onboarding page |
| Factory control panel | Kill and Restore move into the status chip popover (one place, Factory Admin only); the existing dialogs (`shell/stopActions`) are reused. While killed, Attention shows "Factory killed - restore needs 1 of 2 approvals" with a Restore button |
| "My work" / "Factory overview" toggle | Deleted; one Home |
| Four KPI tiles on MyWork | Deleted (headers carry counts) |

Decision on kill: the status chip popover already carries factory state, so Kill/Restore live there (Factory Admin only, step-up and typed phrase unchanged). Needs a small addition to `StatusPopover` (StatusCluster.tsx:58): a "Kill the factory" danger link and, when killed, restore progress. Home keeps no destructive control.

## 4. Data/API, components, a11y, perf

### API (`GET /api/v1/home`)
- Reuse `computeHome` pieces: `attention()`, `myApprovals()`, `myConversations()`, `waitingGates`, `figures`, `spend`, `control`.
- Make attention role-scoped: run `attention()` for everyone, filtered to `visibleProjects(st, me.id)` for non-factory roles (project-scoped kinds only: killed/halted, budget for project admins, onboarding, WO blocked/failed/sechold/late gates). Factory-only kinds (evals, vendors, integrations, factory kill) stay factory-gated by their read rights (`agents.view`, `models.view`, `integrations.view`).
- Add `home.nextStep`: `{ steps: [{id: github|project|repo, state: done|todo|active, detail}] | null }` computed from integration instances, projects, repos' onboarding stage. Null once at least one repo is Ready.
- Add `home.motion`: `{ inFlight, running, byStation: {stationId: n}[] (factory/visible), recentDone: [{id,title,doneAt}] (5), shippedToday, shippedWeek, shippedPrevWeek }`. `byPosition` already exists per project on `useProjects().metrics`; the aggregate can be derived client-side to avoid new SQL.
- Add week-over-week: `figures.spentPrevPeriod`, `shippedPrevWeek` only if data exists; otherwise omit (UI shows no delta).
- Drop from the response (after P1): `human`, `onboarding`, `control.impact`, `figures.agentSuccess*` (or keep agentSuccess behind real data). Keep `control` slim (`killed`, `restoreApprovals`, `restoreNeeds`, `admins`) only for the status popover/Attention; consider moving it to `/api/v1/me`'s factory block which StatusCluster already reads (`StatusCluster.tsx:26`).
- "One approver" bus-factor: emit as a sev 2 attention item (`hm-att-sole`) in `computeHome`.
- Remove `GET /api/v1/activity` call from Home (second request saved).

### Components
- Delete: `Control.tsx` (logic moves to status popover), `Human.tsx`, `OnboardingPanel`, `ActivityPanel`, `SpendPanel` (replaced by one `HealthRow`), `Stat` x2, the `Portfolio` embed in Home, `layoutOf` and the `hm-pf` prefs context, `home.tsx` mode state.
- Merge: `FactoryView` + `MyWork` into one `HomeView` with section components `AttentionStrip` (from `AttentionPanel`), `WaitingOnYou` (from `ApprovalRow` + conversations), `InMotion` (MiniBelt + `Token`), `ProjectsSummary` (cards from `MyWork` My projects, using `HealthChip`, `MiniBelt`), `NextStep`, `FactoryHealth`.
- Add shared `plural()` helper and use it in all Home strings (also the Control copy still left in the status popover).
- Keep `openNewProject` (Factory.tsx:31), used by Next step and the header button.

### Accessibility
- Landmarks: `<main>` with one `h1` "Home"; each section `h2` with `aria-labelledby`; Attention strip `role="status"` only for criticals (not the whole list) to avoid chatty announcements.
- Severity never by colour alone: keep icon + hidden `sr` label as today (Panels.tsx `hm-sev`).
- Inline Approve buttons need accessible names including WO and gate (as at Mine.tsx:79 pattern); confirm for G6 release stays a distinct label.
- Collapsible Factory health: `<details>` or button with `aria-expanded`; state in `localStorage` per viewer, try/catch.
- Empty-state step list is an `<ol>`; the active step has `aria-current="step"`.
- Mobile: no horizontal scroll; belts degrade to a list (overflow audit in progress by another agent should confirm).

### Performance
- One request: `/api/v1/home` (already shared with bell and sidebar badges via the same react-query key; no additional fetch). Drop `/activity`. `useProjects()` remains (shared cache with switcher). Server: remove the three trust/learning/onboarding/people queries unless needed; `attention()` already costs 3 queries (evals, vendors, integrations), run those only when the caller has the read right.
- Cap lists (attention 5 + "show all", waiting 6, projects 6, recent done 5) so payload and DOM stay bounded.
- Poll/refetch: refetch on window focus and every 60s while visible; the bell already needs fresh data.

### Test plan
- Domain/API unit tests (`services/api` home tests): attention visibility per role (admin sees factory kinds; project admin sees only own projects; viewer sees none of the factory kinds); `nextStep` for new org / org with a failing repo / ready org; `motion` aggregate; ensure no sections leak for no-grant callers (default deny).
- Web tests (vitest + testing-library, as `projects.test.tsx`): per-role render snapshots (Admin busy, Admin new org, Admin = Nautobot case, Auditor read-only has no buttons that are disabled, Project Admin, Viewer, killed factory); strings: plural helper cases 0/1/2 ("1 project", "1 item needs attention"); no duplicate facts (assert in-flight count text appears once); Approve action calls `ops.approveGate`; empty states show exactly one primary action.
- e2e (`test/e2e/lib4.mjs` pattern): Factory Admin on a fresh org sees steps; after creating a project the step advances; kill from the status popover and Restore from Attention; Auditor cannot see kill.
- Axe pass on Home (desktop and 375px).

## 5. Effort and phases

| Phase | Scope | Estimate |
|---|---|---|
| P1 | Delete duplicates (sentence, meta, KPI row, Portfolio embed, Human, Onboarding pipeline, Activity, Spend, mode toggle); single `HomeView`; `AttentionStrip` + `WaitingOnYou` + Projects summary + `NextStep` card; `plural()` fix; move Kill/Restore to status popover; role-scoped attention in API; `nextStep` field; web + API tests | 4-5 dev days |
| P2 | `InMotion` with station belt and recent completions; `FactoryHealth` with week-over-week and real agent success / eval trend (needs run data); bus-factor attention item; role variants polish (Auditor, Viewer); mobile layout pass; e2e + axe | 3-4 dev days |

Open questions for the lead/user: (a) confirm Kill/Restore lives only in the status popover; (b) confirm Home becomes a single page for all roles (no toggle); (c) agent success: hide until eval/run data exists, or wire now.

## 6. Per-role Homes (the core; supersedes 3c-3e where they differ)

Method: Home is a function of (a) the person's effective role grants (direct + team, `effective_role_assignments`), (b) default-deny read rights, (c) what that role actually decides in Gantry. Source of rights: built-in role map `packages/domain/src/catalog.ts:1600-1612`. Every section below is returned by the API only if the caller holds the right; the UI never renders a locked placeholder. A person with several roles gets the union of sections, in the fixed order Attention, Waiting on you, In motion, Projects, Health.

### 6.0 Home vs the bell: decision
- Bell (inbox) = chronological, per-item notifications; it is the "ping" channel (onboarding session follow-ups on CI/merge/verification, new approval, new question). Small, always one click away, drains as you act.
- Home = the same underlying facts, but prioritised, grouped by kind and by project, with inline actions, and enriched with things that are never notifications (blocked work, late gates, kills, budgets, setup progress). Home never shows a count the bell badge already shows in isolation; its "Waiting on you" is the bell's content grouped (Approvals / Merges / Questions / Onboarding follow-ups) and sorted by urgency (late first, then age), not by time.
- Rule: an item may appear in both (it is the same row, same id, same state; acting in one clears the other), but Home has no "notifications" section, no read/unread, and no history. Chronology lives only in the bell; audit trail in Audit. Both read one `useHome` cache, so they cannot disagree.

### 6.1 Factory Admin (all rights, console propose all, kill/restore)
Responsibility: keep the factory safe, configured and moving; unblock people; decide setup and policy.
- First: Attention. Factory killed/restore progress, project killed/halted, security-held WOs, onboarding failed/needs a person, integration failing, budget >= alert, vendor budget, eval below threshold, a gate with a single possible approver, an agent/model not callable (vendor discovered but not callable through the gateway), step-up expired is NOT shown (handled at the action).
- Second: Waiting on you, only what they may decide as an admin (gates they are an approver for, onboarding PRs to merge, session proposals awaiting approval, trust/learning proposals, restore approvals).
- Then: In motion (belt, agents running, recent completions), Projects summary, Factory health (spend, vendors, agent success, eval trend; collapsed).
- Setup checklist (6.9) while the factory is not fully set up.
- Never: other people's personal inbox items they cannot act on (Workload page covers that), raw audit feed.
- Kill/Restore: status popover only.

### 6.2 Auditor (read-only: project.view, audit.view, factory read rights, console.use)
Responsibility: assure that controls worked; never act.
- First: Control exceptions: kills/halts in the period, gates approved by the requester only or by single approvers, past-SLA gates, security holds, step-up/denied outcomes, failed sign-ins (read via `audit.view`), freezes overridden. Each links to Audit pre-filtered.
- Second: "Waiting on approvers" (read-only count, oldest, by project) so they can see the human bottleneck.
- Then: Projects summary (health, kills), Factory health (spend vs budget, eval trend).
- Never: any button that mutates (New project, approve, kill, restore); Waiting on you; setup checklist; console proposals. One "Audit ledger" link, no embedded feed.

### 6.3 Project Admin (all project actions + eval.run + audit.view for their projects)
Responsibility: one project's setup, approvers, budget, onboarding, health.
- First: Attention scoped to their projects: halted/killed, onboarding needs a person/failed (with a link to the session), budget at alert, gate with no valid approver or one approver, away approvers, blocked/failed WOs, locked-gate disabled attempts needing step-up.
- Second: Waiting on you: gates they approve, onboarding PRs/proposals to approve in the session, brief confirmations, questions.
- Then: In motion per project (belt per project); Projects summary with their roles; project spend vs budget (project only).
- Never: factory-wide spend, other projects, factory kill, vendors/integrations health (unless they also hold those read rights), evals not for their agents.

### 6.4 Line Lead (approve gates, classify, decline, move, park, halt/resume, kill WO, onboarding.manage, eval.run)
Responsibility: the flow of work on a line.
- First: Attention scoped to the line: blocked/failed WOs, late gates, bays (person, security hold), halt state.
- Second: Waiting on you: G0/G1 brief confirmation, classify/decline/reassign at intake, gate approvals, raised questions (`wo.answer`).
- Then: In motion: the belt with stuck WOs highlighted, WOs they submitted; run "Halt this line" is on Floor, not Home.
- Never: budget/vendor/people config, kill project.

### 6.5 Engineer (submit, answer, confirm brief, park, send back, halt, onboarding.manage)
Responsibility: get their own work through.
- First: Waiting on you: questions on their WOs, briefs to confirm, send-backs, onboarding session where they are involved.
- Second: In motion: their WOs with station and state; blocked/failed ones sorted first (an Attention item only for their WOs).
- Then: New work order button; their projects.
- Never: gate approve buttons (they hold no `gate.approve`), project/factory health, spend.

### 6.6 Reviewer and Approver (gate.approve, answer, send back)
Responsibility: decide gates quickly.
- First: Waiting on you = a gate queue ordered late-first, with approvals so far (`1 of 2`) shown once, inline Approve and Review. One-approver risk is surfaced as "You are the only approver for N gates".
- Second: Attention only for gates past SLA that they can decide.
- Then: In motion: read-only belt of their projects.
- Never: New work order (no `wo.submit`), onboarding merge, health/spend.

### 6.7 Release Manager (gate.approve, release, line halt/resume, onboarding.merge, outcome.record)
Responsibility: ship safely.
- First: Waiting on you: G6 "Confirm release" items split into "Open now" and "Window closed / freeze until ..." using the status data (windows, freezes) so they see what they can actually release; onboarding PRs with green checks to merge.
- Second: Attention: freezes active, release blocked by window, halted line.
- Then: Recently shipped with outcome to record ("record outcome" for done WOs missing one).
- Never: setup/approver config, spend.

### 6.8 Viewer (project.view, console.use only)
Responsibility: understand status.
- First: In motion (read-only belt and counts) for their projects, and Attention items that are public to project viewers (halted/killed).
- No "Waiting on you" section at all. One line: "You can view Billing. Ask a Project Admin for more access." Console is available from the top bar.
- Never: any button except open Floor / Work orders.

Custom roles and team grants: the rule is the same; sections show when the corresponding right resolves for the caller (e.g. a custom role with only `onboarding.merge` sees merge items; `models.view` adds the vendor attention items).

### 6.9 First-run (Factory Admin, new org): setup checklist that disappears when done
Replaces everything below Attention until complete, then vanishes (state derived from data, not stored):
1. Connect the GitHub App (Integrations; done when an enabled GitHub integration instance exists).
2. Add a model vendor (Models; done when a vendor is connected and callable). Note which vendors are only discoverable: "Anthropic is ready to call; Bedrock, OpenAI, Azure and Gemini can be discovered but cannot run agents yet." Console calls are not budgeted; mention only in Models, not Home.
3. Create a project (done when one exists; New project wizard).
4. Onboard a repo (done when a repo is `ready`; in progress shows the agent session status: waiting for you / checks running / verification failed, with Open session; no-CI repos show "no CI configured" as a normal state, not a failure).
5. Submit the first work order (done when any WO exists).
Optional later hints (not steps): set approvers/gates, add a second Factory Admin (restore needs two), trust ladder starts at L1, triggers are off by default. These are one-liners inside the steps, not extra cards. Only the first incomplete step has a primary button. Progress "3 of 5" is the only number. When all done, the card is replaced by nothing (no "setup complete" banner).
For the user's case (Nautobot-Jobs, onboarding, repo not ready): steps 1-3 done, step 4 active, Attention carries "Nautobot-Jobs onboarding needs you: verification failed" with Open session, and Waiting on you carries the same item once (Attention for severity, Waiting for the action; Home de-duplicates by id: an item in Attention is not repeated in Waiting; the bell still lists it).

### 6.10 "No access yet" Home (no grants)
Landing already routes here (navigation.md). Content: one sentence "Your account is signed in but has no role yet." Who to ask ("Factory Admins: Asha Raman" read from `control.admins` only if their directory read is allowed, otherwise generic text); account name and a Sign out link; nothing else (no sidebar groups, no KPIs, no console). When a person later gets access, Home refetches on focus and routes by 6.1-6.8.

### 6.11 Section visibility matrix (rows = sections; X = shown if data)
| Section | FA | Aud | PA | LL | Eng | Rev/Appr | RM | View |
|---|---|---|---|---|---|---|---|---|
| Setup checklist | X (until done) | | | | | | | |
| Attention (factory-wide kinds) | X | X (controls) | | | | | | |
| Attention (project-scoped) | X | X | X | X | own WOs | late gates | X | halted/killed |
| Waiting on you | X | | X | X | X | X (gates) | X (release, merge) | |
| Waiting on approvers (read-only) | | X | | | | | | |
| In motion | X | X | X | X | X (own) | X (read) | X | X (read) |
| Projects summary | X | X | X (mine) | X (mine) | X (mine) | X (mine) | X (mine) | X (mine) |
| Factory health | X | X | project only | | | | | |
API shape follows: `home.sections` is built server-side by right; the client renders what is present and never checks roles itself (still uses `useCan` for button guards).
