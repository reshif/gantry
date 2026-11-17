# Engineering rules for Gantry

This file is for every engineer and every coding agent working in this repository. It states the rules, and **each rule
names the check that enforces it** (`Enforced by:`). The check ids live in `scripts/enforcement.json`;
`npm run check:agents` fails CI when a rule names no check, names an unknown one, or a check no longer exists. To add a
rule, add its check first.

Background: `docs/ui/design-system.md` (UI rules and the per-view checklist), `docs/production-readiness.md` (Wave 2
conventions), `docs/review/` (audits), `spec.md`.

## 1. Principles

- **G-01** Agents author and propose; code only gathers facts, enforces safety rails and asks a person to approve.
  Never hard-code a plan an agent is supposed to produce, and never forbid what an agent may propose (flag sensitive
  files on the approval card instead). Dead ends come with the agent's proposed way forward. Enforced by: `review-agent-led`.
- **G-02** Safety rails stay and are never weakened to make a feature work: secrets, protected paths, diff size, unsafe
  commands, and never merge or write without a person's approval. Enforced by: `review-safety-rails`.
- **G-03** No hard-coded agent-voice copy in the UI (suggested prompts, advice or coaching keyed by role); the agent or the
  server supplies it. Enforced by: `review-agent-copy`.
- **G-04** No secrets, tokens or credentials in the repository, logs or fixtures. Enforced by: `review-secrets`.
- **G-05** Every change ships with a test that fails without the change. Enforced by: `review-tests-fail-without`, `tests`.
- **G-06** Typecheck, lint and tests pass before merge. Enforced by: `typecheck`, `lint`, `tests`.
- **G-07** Rules in this file are enforced; this file is owned by the maintainers. Enforced by: `agents-rules`, `codeowners`.

## 2. Frontend (apps/web): the production bar

The bar is per screen and checkable (`docs/ui/design-system.md` section 6). Violations of F-01 to F-09 are lint warnings
held by a shrinking baseline (`apps/web/lint-baseline.json`): a view may fix its count, never raise it, and a migrated
view should reach zero and then flip to an error (Wave 3).

- **F-01** No raw `<table>`, `<button>`, `<input>`, `<textarea>` or `<select>` in views: use `DataTable`, `Btn` / `IconBtn`, `Field`. Enforced by: `raw-elements`.
- **F-02** Views do not import `@tanstack/react-query`, `api/client` or `api/ops`: reads go through typed hooks in `api/queries`, writes through `useCommand`. Enforced by: `view-imports`.
- **F-03** No literal `queryKey` arrays: keys come from the typed key factories. Enforced by: `query-keys`.
- **F-04** A read renders loading, empty, forbidden, failed and stale states inside `<Async>`; a failed read must never look like an empty list (`.data ?? []`). Enforced by: `read-failures`.
- **F-05** No role-name literals: permissions come from server decisions (`useCan` / `useGuard`), never from comparing roles. Enforced by: `role-literals`.
- **F-06** `ui/`, `lib/` and `api/` never import from `views/`. Enforced by: `ui-layering`.
- **F-07** `dangerouslySetInnerHTML` only inside `Icon`. Enforced by: `html-injection`.
- **F-08** No `as unknown as` casts: fix the type. Enforced by: `type-escape`.
- **F-09** No new polling in views: live data comes from the stream; polling only as `pollWhenStreamDown`. Enforced by: `polling`.
- **F-10** Accessible by construction: jsx-a11y lint, and axe finds zero serious or critical issues at 390 and 1366 px in light and dark. Enforced by: `a11y-lint`, `e2e-a11y`, `e2e-ci`.
- **F-11** No horizontal page overflow at 320, 390, 768, 1024 and 1366 px. Enforced by: `e2e-overflow`.
- **F-12** Failure paths are real states, covered by interception tests (401, 403, 404, 409, 422, 429, 500, offline, chunk 404). Enforced by: `e2e-failure-paths`.
- **F-13** Persona journeys (sign-in, read-only persona, create and approve) run end to end against mocked API fixtures. Enforced by: `e2e-journeys`.
- **F-14** Screenshots at 390 and 1366 in light and dark are diffed against committed baselines. Enforced by: `e2e-visual`.
- **F-15** Tabs, filters, sorting, selection and drawers are in the URL (`useRouteState`). Enforced by: `review-url-state`.
- **F-16** The lint baseline only shrinks; fewer violations must be locked in the same PR. Enforced by: `lint-ratchet`.
- **F-17** The per-view definition-of-done report does not regress (`npm run dod` lists which views pass). Enforced by: `dod-report`.
- **F-18** The entry bundle stays within the measured gzip budget, which only goes down. Enforced by: `bundle-budget`.
- **F-19** `@gantry/domain` stays tree-shakeable (`"sideEffects": false`, subpath exports). Enforced by: `domain-package`.
- **F-20** Routing stays the custom hash router; `react-router` is not a dependency. Enforced by: `no-router-dependency`.

## 3. How to run the checks

```
npm ci
npm run lint                      # eslint, whole repo (warnings are the baselined architecture rules)
npm run lint -w @gantry/web       # eslint, web only
npm run lint:ratchet              # architecture warnings against apps/web/lint-baseline.json
node scripts/lint-ratchet.mjs --update   # lock in fewer warnings (refuses to raise any count)
npm run dod                       # per-view definition-of-done report (--json for machines)
npm run typecheck
npm test                          # vitest in every workspace, plus the script tests
npm run build -w @gantry/web && npm run check:bundle   # gzip entry budget (--update only lowers it)
npm run check:agents              # every rule in this file has an enforcing check
npm run e2e -w @gantry/web        # Playwright harness on mocked API fixtures (no live stack)
npm run e2e:update -w @gantry/web # regenerate screenshot baselines (review the images)
```

The Playwright harness (`apps/web/e2e`) needs Chromium: `npx playwright install chromium`, or point
`GANTRY_E2E_CHROMIUM` at an installed browser. It serves the built app and fulfils every `/api` call from fixtures, so it runs
with no database, identity provider or API.

## 4. Working rules

- Work in a branch or worktree; do not push to a branch you do not own or touch a running deployment.
- Primitives live in `apps/web/src/ui`, tokens in `apps/web/src/styles/tokens.css`; change them through their owners (`.github/CODEOWNERS`).
- Migrate views one at a time; do not restyle a view you are not migrating.
