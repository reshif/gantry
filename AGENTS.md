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
- **F-04** A read renders loading, empty, forbidden, failed and stale states inside `<Async>`; a failed read must never look like an empty list (`.data ?? []`). Enforced by: `read-failures`, `e2e-failure-paths`.
- **F-05** No role-name literals: permissions come from server decisions (`useCan` / `useGuard`), never from comparing roles. Enforced by: `role-literals`.
- **F-06** `ui/`, `lib/` and `api/` never import from `views/`. Enforced by: `ui-layering`.
- **F-07** `dangerouslySetInnerHTML` only inside `Icon`. Enforced by: `html-injection`.
- **F-08** No `as unknown as` casts: fix the type. Enforced by: `type-escape`.
- **F-09** No new polling in views: live data comes from the stream; polling only as `pollWhenStreamDown`. The scan counts `refetchInterval` and `setInterval` in views and the ratchet holds the count; it does not see other timer styles, so review still looks for them. Enforced by: `polling`, `polling-scan-test`.
- **F-10** Accessible by construction: jsx-a11y lint, and axe finds no serious or critical issue beyond the listed known ones (`apps/web/e2e/known-issues.json`, a ratchet) at 390 and 1366 px in light and dark. `e2e-canary` seeds a contrast defect and an overflow and proves the detectors catch them. Enforced by: `a11y-lint`, `e2e-a11y`, `e2e-canary`, `e2e-ci`.
- **F-11** No horizontal page overflow at 320, 390, 768, 1024 and 1366 px (known overflows are listed in `known-issues.json`). Enforced by: `e2e-overflow`, `e2e-canary`.
- **F-12** Failure paths are real states, covered by interception tests. Covered today: 401 (signed out), 403, 404, 429 and 500 on a read (shown in the main region, with an empty-list contrast test), 500 on `/me`, 409 and 422 on a write (the New project wizard shows the reason inline), and offline. A lazy chunk that 404s now reloads once and then shows the route error boundary's Retry. Known gap, kept as `test.fixme` so it flips loudly when fixed: a failed `/me` refetch is not yet proven to keep the app mounted. Enforced by: `e2e-failure-paths`.
- **F-13** Persona journeys run end to end against mocked API fixtures. Covered today: signed-out sign-in, admin lands signed in, read-only persona is refused every action. Still `test.fixme` (not yet enforced): create a work order, approve a gate, stop and restore with step-up, hostile markdown rendering inert. Enforced by: `e2e-journeys`.
- **F-14** Screenshots at 390 and 1366 in light and dark are diffed against committed baselines (per platform: `e2e/__screenshots__/<platform>/`). Not blocking yet: the committed baselines were rendered on a developer machine with fallback fonts, so CI runs the diffs as a separate `continue-on-error` step, and `Frontend e2e (Chromium)` is not in branch protection yet. To make it blocking, generate baselines on the CI image (run `npm run e2e:update -w @gantry/web` there, commit `__screenshots__/linux`), then drop `continue-on-error`. Enforced by: `e2e-visual`.
- **F-15** Tabs, filters, sorting, selection and drawers are in the URL (`useRouteState`). Review-enforced: a ticked item in the PR template, no automated check. Enforced by: `review-url-state`.
- **F-16** The lint baseline only shrinks; fewer violations must be locked in the same PR (see "Ratchets and merging" below). Enforced by: `lint-ratchet`.
- **F-17** The per-view definition-of-done report does not regress (`npm run dod` lists which views pass). Enforced by: `dod-report`.
- **F-18** The entry bundle stays within the measured gzip budget, which only goes down (see "Ratchets and merging" below). Enforced by: `bundle-budget`.
- **F-19** `@gantry/domain` stays tree-shakeable (`"sideEffects": false`, subpath exports). Enforced by: `domain-package`.
- **F-20** Routing stays the custom hash router; `react-router` is not a dependency (checked in `package.json` files and the lockfile). Enforced by: `no-router-dependency`.

Rules marked review-enforced (G-01 to G-04, F-15) have no automated check: the PR template item is the enforcement, and a
reviewer ticks it. They are listed so nobody mistakes them for machine-checked.

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

## 5. Ratchets and merging

The lint baseline, the bundle budget and `known-issues.json` are ratchets: they fail when something gets worse, and the lint
ratchet and the bundle budget also fail when something gets better by more than a little (so the gain is locked in).

- When your branch fixes violations or shrinks the entry, run `node scripts/lint-ratchet.mjs --update` and / or
  `node scripts/bundle-budget.mjs --update` and commit the file in the same PR.
- Two PRs that both lower a ratchet conflict in the JSON. After merging the other one, rebase, rerun the `--update` form
  against your merged tree and commit; never hand-edit a number upward.
- Gzip sizes differ between Node / zlib versions. Measure the budget on the Node in `.nvmrc` (CI's), not on a newer local
  Node, or a correct build looks smaller or larger than it is. The slack is 1 kB.
- `known-issues.json` is regenerated with `npm run e2e:known -w @gantry/web`, never grown by hand; additions go through CODEOWNERS.

E2E server: Playwright builds the app and starts `vite preview`. `E2E_SKIP_BUILD=1` reuses `apps/web/dist`, which is only
correct when you rebuilt it after your last change (a stale `dist` tests old code). A server already on the port is never
reused unless you set `E2E_REUSE_SERVER=1`. `GANTRY_E2E_VISUAL=off|only` runs everything but, or only, the screenshot diffs.
