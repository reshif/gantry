# Gantry production-readiness plan

Owner of this plan: the lead engineering agent, accountable to the product owner. Started 2026-11-15.
Evidence: five independent reviews in [`docs/review/2026-11-15/`](review/2026-11-15/), covering the frontend architecture, a live multi-persona UX test, security, the agent experience and enterprise operations. Each one cites files and lines, HTTP requests and screenshots.

## Where we are

Gantry has the right foundations. The safety model holds up under testing: agents propose and people approve under their own rights. The rest of that foundation:

- an audit ledger with a hash chain
- halt and kill at every scope
- hardened containers
- correct cross-project isolation, which the reviewers proved live

The weaknesses are in the shape of the product:

- **Frontend.** Every feature exists, but each view re-implements tables, forms, loading and error states, chips, dialogs and chat by hand:
  - 67 hand-written tables
  - no shared helper for saving changes
  - about 15 views that show nothing when a request fails
  - four separate chat screens
  - two permission systems that disagree
- **Agent collaboration.** This is roughly 25% of the vision. The Intake dialogue is good. After Intake, each station is a one-shot JSON run:
  - no clarifying questions
  - no web research or research swarm
  - no markdown documents
  - no list of chats and no way to archive them
- **Operations.**
  - no CI
  - Keycloak in dev mode
  - no backups
  - unversioned images
  - no metrics or alerting
  - no operator documentation

## Wave 0: security holes found today (done, on the working tree)

| # | Finding | Fix | Test |
|---|---|---|---|
| S1 (P0) | A percent-encoded path (`/api/v1/%70eople`) skipped the read gate. `/%61pi/...` skipped authentication entirely. A user with no roles could read every person, the role matrix, agent prompts and integration config. | `core/paths.ts` `canonicalPath()` is now the one path every check reads: the auth hook, the read gate, the rate-limit allow-list and the API-key log. A path that doesn't decode gets a 400. | `read-gates.test.ts` |
| S2 (P1) | An engineer on any one project could halt or resume the whole factory. | New factory-scoped rights `halt.factory` and `resume.factory`. Factory Admins always hold them. | `flow-stops.test.ts` |
| S3 (P1) | A Project Admin could mark anyone away (a global setting) and name a delegate who then approves for them. | A project right counts only if it covers every project the person holds a role on. Anything wider needs `people.manage`. | `people-access.test.ts` |
| S4 (P1) | Demo accounts were on by default, so `/api/v1/me` published the whole roster to anyone who wasn't signed in. | Off by default. The API refuses to start with them on unless the public URL is localhost. | config |
| S5 (P2) | Automatic gates ignored risk tags, so changes to CI, dependencies, migrations or code owners could pass G4 with no person deciding. | Spec 9.5 is now enforced: any risk tag sends the gate to a person, with a note naming the tags. | `gate-risk.test.ts` (fails without the fix) |
| S6 (P2) | `people.manage` could create a Factory Admin, including oneself. `policy.edit` could add rights to one's own role. | Only a Factory Admin grants or removes Factory Admin. No one can grant themselves a role. Adding a right to a role you hold needs a Factory Admin. | `role-escalation.test.ts` |
| S7 (P2) | nodemailer 7 had high-severity SMTP injection advisories. | Upgraded to 10.5 in the API and worker. Production `npm audit` reports 2 moderate issues (uuid via dockerode) and no high ones. | outbox, integrations |
| S8 (P3) | A missing `email_verified` claim was accepted when linking an identity. | Only a provider-verified address links or provisions a person. | `oidc.test.ts` |
| — | The API typecheck was red on main (a test importing web source, type drift). | Fixed. | `npm run typecheck` |
| — | Keycloak user IDs changed whenever its container was recreated, which locked everyone out with "linked to a different identity". | `kcdata` volume. | — |

## Wave 1: remaining security and correctness

1. Ingress: block `/idp/admin` and the master realm. Serve Mailpit only in a dev profile.
2. Sign-out ends the Keycloak SSO session (RP-initiated logout).
3. Take the audit channel from the authenticated transport, not from the `via` field in the request body.
4. Audit `summary` counts only rows the caller can see. SSE events with no project carry no slice names for invisible data.
5. Make email read-only in the Keycloak user profile, and link invites by one-time token rather than by address.
6. On-call status that grants rights comes from a schedule, not a self-toggle (needs an owner decision).
7. Rate-limit and sample unsigned webhook denials. Pin `trustProxy` to the ingress.
8. Docker socket: a socket proxy that allows only the launcher's calls.

## Wave 2: frontend framework (the main structural fix)

The target design is in [frontend-architecture.md §7](review/2026-11-15/frontend-architecture.md). In short:

- **Primitives in `ui/`:**
  - async state: `Async` / `Skeleton` / `ErrorState` / `EmptyState`
  - `Badge` with tones
  - `DataTable`, keyboard accessible, rendering as cards on narrow screens
  - `FilterBar`, synced to the URL
  - forms: `Input` / `Select` / `Textarea` / `Toggle`, `Form` + `useForm` with 422 errors mapped to fields
  - `Button` with a permission guard
  - `useConfirm`, `Dialog` / `FormDialog` / `Drawer` / `Menu`
  - `Page` / `Section` / `Split`
  - a shared `Markdown` with tables, code and safe links
  - `Thread` / `Message` / `Composer`
- **Conventions:**
  - `useCommand`, a wrapper around `useMutation`, replaces about 31 hand-written busy flags and gives one way to show refusals: 403 shows the reason and what's needed, 409 offers a reload, 422 marks the fields.
  - `useGuard` replaces the 37 places that check role names directly, and the nav uses permissions only.
  - Every read lives in `api/queries/*` with typed keys, which also fixes the key collisions.
  - `useRouteState` makes tabs, filters and drawers linkable.
  - Lint rules enforce all of the above.
- **Migration:** move view by view. Primitives emit the legacy ids and classes while views move over, so the existing 441 tests keep passing. Order:
  1. small table and settings views
  2. list views
  3. settings pages
  4. drawers
  5. threads
  6. the custom views: floor, home, traveler
- **Definition of done per view:**
  - no raw `<table>`, `<button>` or `<input>`
  - no literal query keys
  - no role-name checks
  - loads through `<Async>`
  - every write goes through `useCommand`
  - tabs and filters in the URL
  - accessibility check clean

## Wave 3: what each persona sees

From the live persona test (the UI matched the role model; these are the gaps):

- **F2:** an Auditor sees Security in the nav, but the page is blank. Every view must show a "you can't view this" state for a 403.
- **F3:** clients request data the user can't read, causing 403s on every route. Queries are only enabled when the read is allowed.
- **F1:** locked-button reasons appear only on mouse hover. Show them on focus and touch too, and link them with `aria-describedby`.
- **F4:** Andon is enabled for people who have no right to halt.
- **F5:** pages show raw ids and "0" where the honest answer is "not visible to you".
- **F7:** factory-level role grants need a reason and a fresh sign-in, plus an undo.
- **F9:** add Factory Manager and Security Reviewer role templates (owner decision).
- **F10, F12, F13:**
  - denied routes rewrite the URL
  - drop "SHEET n" and spec references from user-facing text
  - send alerts only to people who can act on them

## Wave 4: the agent workspace (the owner's vision)

The design is in [agent-experience.md §4](review/2026-11-15/agent-experience.md). Every piece keeps the rule that agents propose and people approve. Code only gives structure and safety limits; agents decide the content.

- **Phase 0:**
  - fix the contradictory gate label, the red diff of scaffold lines, the cut-off summaries and the duplicate banner
  - add a Console chat list with New chat, rename and search
  - retire the legacy Conversation tab
- **Phase 1:**
  - every station writes a versioned markdown document, shown in one document viewer
  - an `ask` tool for every station, with pause and resume carrying the answers
  - a log of questions, assumptions and decisions that is handed between stations
  - Intake can't propose a brief while a blocking question is open
  - answers show who gave them, and "waiting for you" means the person actually asked
- **Phase 2:**
  - governed web research (allow-listed, snapshotted, audited) with source records and citation chips
  - a research plan card the person approves, covering scope, domains and budget
  - a live run timeline for every station
- **Phase 3:**
  - a research swarm: child runs capped in number and budget, a board of scouts in progress, pause or stop per scout
  - agent-to-agent objections that a person resolves
- **Phase 4:** one Agent Workspace:
  - an inbox, threads and a context pane
  - archive, share and full-text search
  - an operator view of stuck, waiting and over-budget threads

## Wave 5: operating it in production

From [enterprise-readiness.md](review/2026-11-15/enterprise-readiness.md):

- **P0:**
  - CI (lint, typecheck, tests with Postgres, build, audit, image scan, e2e) and branch protection
  - Keycloak in production mode on Postgres
  - a production compose profile without dev services
  - backups and a restore drill
  - versioned, pinned, signed images
- **P1:**
  - retention jobs for every class in spec 7.4
  - `/metrics`, `/readyz`, tracing, alert rules and a runbook
  - resource limits
  - a configurable hostname and real TLS
  - offboarding users and rotating keys
  - a System health view in the UI
  - an upgrade and rollback story
- **P2/P3:**
  - audit export to a SIEM
  - data export and erasure
  - admin tools for dead letters
  - documentation for users, admins and operators, plus OpenAPI
  - self-hosted fonts

## Decisions for the owner

Answered 2026-11-15:

1. **Work-order threads: read-only for the project.** Everyone with read access to the project can read every thread on its work orders. Only the people taking part can post: the requester, the assignees, the approvers of the current gate, and anyone they invite.
2. **Web research: allow-list.** Agents reach only domains on an allow-list kept by an admin. A research plan can propose new domains, and a person approves them when they approve the plan. Every fetch is snapshotted and audited.
5. **Agent-to-agent challenges: only where necessary.** The agent judges whether a challenge is warranted; there is no project-wide switch and no fixed rule that forces one. A challenge always goes to a person, who resolves it. Code limits only how often challenges happen and what they cost.
6. **Role templates: yes.** Ship Factory Manager and Security Reviewer.
4. **Agent documents: no direct editing.** Only the agent that owns a document changes it. People steer it through the dialogue with questions, answers, corrections and send-backs, and the agent writes a new version. Each version records the dialogue turn that caused it, so the gate shows why the document changed. The UI has no editor for station documents, and the API refuses writes to them from anyone but the owning station's run.

Still open:

3. Swarm cost cap: per research plan (assumed until answered), per station, or per work order?
7. On-call: should it come from a schedule instead of a self-toggle? Self-toggle stays until answered, and it grants no extra rights.
