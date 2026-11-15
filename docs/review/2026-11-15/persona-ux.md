# Persona UX / access review (live app, https://localhost)

Method: Playwright headless Chromium, one browser context per persona, 1440px desktop plus one 390px pass. Scripts and JSON: `review/persona/` (tour.mjs, probe.mjs, urls.mjs, trav2.mjs, mob.mjs, `<user>.json`). Screenshots: `review/persona/shots/` (prefix = persona-route, e.g. `shots/sam-security.png`, `shots/asha-people.png`).
Role model read from `packages/domain/src/catalog.ts` (ROLES, defaultMatrix) and `docs/build-notes/navigation.md`; route gating from `apps/web/src/lib/routes.ts`.
No work orders were created. Data note: a concurrent reviewer changed Tomas's roles mid-run (he gained Project Admin on Sec Probe), so only my pre-change Tomas results are used; his 390px results are contaminated (he saw People/Agents because Project Admin sees those).

## 1. Granting roles (as asha)
Path: Govern > People & teams, pick a person, factory-role dropdown (None / Factory Admin / Auditor) and a per-project switch grid (Project Admin, Line Lead, Engineer, Reviewer, Approver, Release Manager, Viewer). One click per grant, ~2.5 s, toast "Granted Line Lead to Meera Iyer on Nautobot-Jobs.", list row updates immediately, no confirmation, no reason field, no step-up even for the factory-wide Auditor grant. Screens: `shots/grant-daniel-1.png`, `shots/grant-*.png`.
Difficulty: EASY, almost too easy (see F7). Prerequisite hidden from the admin: a person must have signed in once to appear (login page says so: "Not in the organisation yet"). Detail pane also shows "Effective permissions now" with rule explanations, which is a strong feature.

Grants I made: daniel = Project Admin (Nautobot-Jobs); meera = Line Lead; tomas = Engineer (already Engineer on Sec Probe); kenji = Release Manager; sam = Auditor (factory); grace = Approver. fatima left ungranted.
Mapping gaps: there is no "factory manager" role (factory roles are only Factory Admin / Auditor), so Daniel got Project Admin as the nearest non-superuser. There is no Security role/gate-approver role, so Grace got Approver. Both are model gaps, not UI bugs (F9).

## 2. Access matrix
Legend: S = sees (nav item present and page loads), A = can act (enabled controls that work), "-" = hidden/redirected. "OK" = matches role model; "MISMATCH" flagged below.
Factory pages (nav + direct hash):

| Area | asha (FA+PA) | daniel (PA) | meera (Line Lead) | tomas (Engineer) | kenji (Release Mgr) | sam (Auditor) | grace (Approver) | fatima (none) |
|---|---|---|---|---|---|---|---|---|
| Home | S/A | S/A | S/A | S/A | S (no New WO) | S (no New WO) | S (no New WO) | "No access yet" |
| Projects | S/A | S, own project | S | S (2 projects) | S | S (all) | S | - |
| Console | S/A | S | S | S | S | S | S | - |
| Agents/Skills/Evals/Trust/Learning | S/A | S/A (Create agent enabled) | S, Create agent enabled; Models hidden | - | - (even Trust, which routes.ts grants RM) | S, read-only w/ reason | - | - |
| Models | S/A | S | - | - | - | S read-only | - | - |
| Integrations/Notifications/MCP/API | S/A | S | - | - | - | S read-only | - | - |
| People & teams | S/A | S, manage own project only (7 of 14 switches) | - | - | - | S, read-only | - | - |
| Workload | S | S | S | - | - | S | - | - |
| Access | S/A | - | - | - | - | S read-only | - | - |
| Security | S/A | - | - | - | - | listed in nav, page BLANK (F2) | - | - |
| Audit | S/A | - | - | - | - | S | - | - |

Project pages (Nautobot-Jobs):

| Control | asha | daniel | meera | tomas | kenji | sam | grace |
|---|---|---|---|---|---|---|---|
| Floor/WOs/Conversations/Onboarding/Config load | all | all | all | all | all | all | all |
| New work order | on | on | on | on | locked | locked | locked |
| Andon (button) | on | on | on | on | on | ON (F4) | ON (F4) |
| Kill project | on | on | locked | locked | locked | locked | locked |
| Connect repo / Save details | on | on | locked | locked | locked | locked | locked |
| Traveler: Decline/Reassign/Reclassify/Kill WO | on | on | on | locked (Move to bay on = park) | locked | locked | locked |
| Gate approve | not exercised (no WO at an approval gate; WO-1003 is at G0+G1 brief) | | | | | | |
OK vs model: all of the above agree with `defaultMatrix` (Engineer: park yes, decline/kill no; Auditor/Viewer write nothing; Approver cannot submit; Release Manager cannot confirm briefs). Mismatches are about presentation, listed next.

Direct-URL tests (`shots/url-*.png`, `urls-*.txt`):
- Restricted factory route (e.g. #people for grace/meera): redirected to Home with toast "You do not have access to People & teams." Good, but URL stays `#people` (hash not rewritten), so refresh/bookmark repeats it; unknown `#bogus` also silently shows Home with no message.
- Project not held (#/p/sec-probe/floor, and nonexistent project): page "You do not have access to this project. It may not exist, or you hold no role on it." Good (does not leak existence).
- Legacy `#floor`, `#record/WO-1001` redirect to the held project. Good.
- fatima (no grants): every route, including bogus ones, renders "No access yet. Ask a Factory Admin or Project Admin to give you a role." Nav shows only Overview + a disabled Project. Toasts "You do not have access to X" appear too (double messaging). Sidebar still lists Overview group. No leak of data.

## 3. Findings
| # | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| F1 | P2 | Disabled-reason tooltips are not accessible. Locked buttons carry `data-reason` + `aria-disabled`, no `title`/`aria-describedby`; reason appears only on mouse hover as a custom tooltip (`shots/hover-sam-confirm.png`). Keyboard/screen-reader/touch users get "disabled" with no why. The reasons themselves are excellent ("Needs Project Admin or Line Lead... No role held by Grace Liu in Nautobot-Jobs includes 'Confirm briefs (G0+G1)'"). | trav2 output; `button#trv-approve[data-reason]` | Add aria-describedby to a visually hidden reason, show on focus, and a tap-to-reveal on mobile. |
| F2 | P1 | Auditor sees "Security" in nav but the page is blank (no heading, no error, no empty state). GET /api/v1/security returns 403 and the view renders nothing. Nav rule (`routes.ts` FACTORY_READ) and API disagree. | `shots/sam-security.png`; sam.json logs `[http 403] GET /api/v1/security` | Either grant auditors read on /security or hide the route; every view must render a 403 state ("You can't view this") instead of blank. Same 403 on /security also fires from sam's #people. |
| F3 | P2 | Large amounts of 403 console noise for legitimate personas. A person with no role triggers 403 on /policies, /home, /agents, /freezes, /people on every route (fatima). Line Lead hitting Agents: /policies, /routing, /vendors; Kenji/Grace on Floor: /agents, /mcp/servers, /people; Onboarding: /integrations, /integration-types, /teams. Also 401 on /api/v1/me before sign-in (expected). Pages mostly degrade silently, but it pollutes alerting and means the client asks for things it was told it cannot have. | `urls-fatima.txt`, `meera.json`, `kenji.json` logs | Gate queries on the same read permissions as the nav (react-query `enabled`), do not request people/agents/mcp for roles without the read. |
| F4 | P3 | Andon button is enabled for everyone including Auditor and Approver; clicking opens a popover whose two items are both "locked" with no explanation. Kill/New WO next to it are properly disabled with reasons. | `shots/andon-sam-1.png`; probe-sam.txt | Disable Andon with the same reason pattern when no halt right, or show the reason in the popover. |
| F5 | P2 | Raw IDs where names are expected for roles without people.view: Project config shows "OWNER p-asha" and an empty Owner dropdown; "Members & roles 0" for Kenji/Grace although the project has 6 members (wrong number, not "hidden"). | `shots/kenji-_p_nautobot-jobs_project-config.png` | Have the project payload include owner display name; show "Not visible to you" rather than 0. |
| F6 | P2 | Dead end for stakeholders with a project role but no factory visibility: Kenji (Release Manager) and Grace (Approver) see no Trust, Audit, Workload, Security. A security engineer has no security surface at all; a release manager cannot see the audit trail of releases. Nav lists Trust for RM in `routes.ts` but `agents.view` denies it, so the code rule and the matrix contradict (code comment claims RM sees Trust). | kenji.json nav list; `routes.ts:46` | Decide the intended release/security persona and add read rights (e.g. Reviewer/Approver get audit.view scoped to project), or remove the dead role lists in routes.ts. |
| F7 | P2 | Role grants have no friction: no confirm, no reason, no step-up, no "are you sure" even for factory-wide Auditor (read everything), and a Factory Admin can grant Factory Admin the same way. Asha's account shows "No MFA". The sign-in card says "Sensitive actions ask for a fresh sign-in" but grants did not. | t4 output: toast only | Require reason + step-up for factory-level grants, show an undo in the toast. |
| F8 | P3 | Project Admin on any project (Tomas after concurrent grant, Daniel) sees the org-wide People list (all 11 people, names/emails) and teams, not just their project's members. Also Project Admin of project A can open #people but 7 of 14 switches lock correctly. | `shots/mob-tomas-_people.png` (note contamination) | Confirm intended; if not, scope the directory to people on projects they administer. |
| F9 | P2 | Role catalog gaps vs real jobs: no factory-manager (read+operate, not admin), no security/compliance-reviewer role, no way to give an auditor the Security page. Admin must over-grant (Project Admin, Approver) to approximate. Custom roles exist ("Custom roles 0") but the People page does not hint at that when assigning. | grant step | Ship 2-3 factory-level templates (Factory Manager, Security Reviewer) or surface "Create role" inline in the person panel. |
| F10 | P3 | Denied hash routes: URL stays on the forbidden hash; unknown route shows Home silently; the toast is the only message and disappears; new user gets both a "No access yet" panel and a stack of toasts. | urls-*.txt | Rewrite hash to #home on denial and show the explanation inline once. |
| F11 | P3 | Console page header: the sub-caption ("Answers come from claude-sonnet-5-5...") is overlaid by the scrolling transcript (text clipped under it). Also a persisted chat contains the agent contradicting itself ("No, I can't submit..." then "I was wrong earlier"), which is an agent-quality issue, not a UI one. | `shots/asha-console.png` | Make the transcript container start below the caption. |
| F12 | P3 | Breadcrumb duplicates: "Agents > Agents" (Sam). Page eyebrow "AGENTS - SHEET 13" and "SHEET 14..." is inconsistent jargon for enterprise users. | `shots/sam-agents.png` | Drop redundant crumb; hide sheet numbers or explain them. |
| F13 | P3 | Home for Daniel/Kenji "Waiting on you" shows a system card "Onboarding update... Verification failed. The App is installed on a User account, not an organisation. Gantry expects an organisation-level install (spec 11.3)..." - leaks a spec section reference, text truncated ("so org owners c"), and Kenji (no onboarding rights; Connect repo locked) is told to act on it. | `shots/daniel-home.png` | Route onboarding alerts only to people who can act; use plain language, no "spec 11.3". |

Things that worked well: refusal explanations on locked controls are specific and name the missing role and the person; "Read-only for you: ... Needs Factory Admin" banners at top of read-only pages (Agents, People, Project config); project-not-accessible page; landing rule for single-project users; Effective-permissions panel; denied attempts are audited ("Denied 32" in Audit).

## 4. Usability notes per screen
- Sign-in (`shots/00-landing.png`): demo account list with plain-language status per person ("No roles yet - Not in the organisation yet...") is very clear for dev; a long, 14-row list pushes content off-screen; GitHub button locked with no reason.
- Home: clear hierarchy (Waiting on you, In motion, Projects). Pipeline mini-boxes ("0 0 0...") with unlabeled diamonds are cryptic for Asha's project card (labels only in Tomas's In-motion strip). Empty states are good ("Nothing is waiting on you").
- Floor: strong overview; the belt diagram clips station text on gates at 1440px ("ief confirm", "ec approve" truncated, `shots/asha-_p_nautobot-jobs_floor.png`). Jargon: Andon, Kill, bays, gates, "G0+G1" - needs a glossary link for new enterprise staff.
- Work orders / traveler: consistent drawer with Journey History; disabled actions with reasons; good. "WORK ORDER down arrow" header fine.
- People & teams: dense but understandable; "INHERITED FROM TEAMS None" run-together text (missing separator) at `shots/asha-people.png`.
- Access/Audit: Audit has counts per category and verify-chain; filters stack well. At 390px Audit and People overflow horizontally inside tables (scrollWidth ok, 784/398 child elements wider than viewport): usable but tables are not responsive.
- Loading: no skeletons seen; permissions arrive async (nav groups appear before route redirect), fine.
- Mobile 390px (`shots/mob-asha-*.png`): page-level horizontal scroll absent on every route (scrollWidth=390). Top bar compresses to icons; project switcher truncates to "Nauto..." / "Choos...". Drawer shows only five group headers with Project count badge (good). Floor and Work orders stack well. Tables on People/Audit/Agents have internal overflow (P3).
- Console errors: no JS exceptions on any screen for any persona (`pageerror` none). Failed requests are the 403s in F3 and expected 401 on /me.
- Consistency: the "locked" pattern (padlock + reason) is consistent on buttons, toggles, banners. Inconsistent: Andon (F4), Security (F2), counts that show 0 instead of "hidden" (F5).

## 5. Summary of mismatches vs role model
No authorization mismatch found at UI level (everything the model forbids was locked or hidden, and server 403s matched). Actual mismatches: Auditor nav lists Security but it is unusable (F2); Trust listed for Release Manager in code but denied (F6); Andon entry enabled without right (F4). Server-side enforcement of the locked buttons was not forced via API in this pass (the UI-level locks only), recommend the security reviewer confirm.
