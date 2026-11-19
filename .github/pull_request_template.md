## What and why

<!-- One or two sentences. Link the issue or audit finding. -->

## Checklist (the bar; rules and enforcing checks are in AGENTS.md)

- [ ] A test fails without the change (name it below).
- [ ] `npm run lint`, `npm run typecheck`, `npm test` pass; `npm run lint:ratchet` and `npm run check:agents` pass.
- [ ] No secrets, tokens or credentials in code, fixtures or logs.
- [ ] Agents author and propose; code only gathers facts, enforces a safety rail, and asks a person to approve. No safety rail weakened.
- [ ] No hard-coded agent-voice copy (suggested prompts, advice, coaching keyed by role).

### Database migrations (packages/db/migrations)

- [ ] Expand only, or a `-- gantry:contract after <sha>` migration alone in its file, and I checked that the code at `<sha>` no longer uses what it drops or tightens (CI cannot check this).

### Frontend changes (apps/web)

- [ ] No raw table, button, input, textarea or select in views; no react-query, api client or ops import in views; no literal query keys; no role-name literals.
- [ ] Reads render loading, empty, forbidden, failed and stale states; a failed read is never an empty list.
- [ ] Tab, filter, sort, selection and drawer state is in the URL.
- [ ] Checked at 390 and 1366 px in light and dark: no horizontal overflow, no clipped text, axe clean.
- [ ] Lint baseline and bundle budget did not grow (they only shrink; run the `--update` form to lock in a gain).
- [ ] Screenshot baselines updated and reviewed if the look changed (`npm run e2e:update -w @gantry/web`).

## Test evidence

<!-- The test that fails without this change, and the command output or screenshots. -->
