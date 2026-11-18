# AGENTS.md

Guidance for coding agents working in this repository. Humans should read README.md first. Where this file and the code disagree, trust the code and flag the difference in the pull request.

## What this repository is

Gantry is a software factory. Work orders move through stations staffed by AI agents and gated by people. Every action is permission-checked and recorded in an append-only audit ledger with a hash chain. The repository is an npm workspaces monorepo written mostly in TypeScript (workspaces: `packages/*`, `services/*`, `apps/*`).

## Toolchain

- Node 22. `.nvmrc` pins it and `package.json` requires `>=22`.
- npm with a committed lockfile. Install with `npm ci`, not `npm install`.
- TypeScript, and Vitest as the test runner.
- Postgres 17 for the database tests.

## Commands

Run all of these from the repository root.

| Task | Command |
| --- | --- |
| Install | `npm ci` |
| Build | `npm run build` |
| Typecheck | `npm run typecheck` |
| Test | `npm test` |
| Lint | `npm run lint` |
| Run one workspace's tests | `npm test -w <workspace-name>` |
| Frontend dev server | `npm run dev -w @gantry/web` |

Notes on the commands:

- Each root script runs the same script in every workspace that defines it (`--workspaces --if-present`). A workspace without the script is skipped silently.
- Workspace tests run `vitest run --passWithNoTests`. A workspace with no tests passes, so a green run does not prove a package is tested.
- Database tests need a Postgres 17 superuser connection. Set the environment variable `GANTRY_TEST_DATABASE_URL` to that connection string before `npm test`. Each test file creates and drops its own database, so never point it at a database you care about.
- `npm run lint` only delegates to workspace `lint` scripts. No linter configuration was found when this file was written, so it may do nothing. `npm run typecheck` is the real static check.
- The frontend dev server proxies `/api`, `/auth` and `/hooks` to the address in `GANTRY_DEV_API` (default `http://localhost:8000`).
- Before opening a pull request run `npm run build`, `npm run typecheck` and `npm test`. CI runs the same three.

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/web` | React 19 and Vite frontend, ported from `legacy/` against the real API |
| `packages/domain` | Pure TypeScript domain logic: permission engine, flow rules, lifecycle, trust, workload |
| `packages/db` | Postgres schema and migrations, event ledger with hash chain, job queue, timers, outbox |
| `services/api` | REST API, sign-in, the decision point, all commands, live updates |
| `services/worker` | Flow engine jobs, timers, outbox delivery, reaper, reconciler, evals |
| `services/launcher` | Starts and stops sandboxed runner containers from a fixed template |
| `services/edge` | Model gateway, MCP gateway, allow-listed forward proxy, trace capture |
| `services/github` | GitHub App broker: seed, publish, pull requests, checks, merge, reconcile |
| `runner` | Runner image and wrapper (Claude Code headless adapter and a deterministic stub adapter) |
| `deploy` | Compose stack, Caddy, Keycloak realm, secrets generator, smoke and isolation checks |
| `legacy` | The original vanilla-JS frontend, kept as the behavioural reference. Do not modify it. |
| `docs/BUILD.md` | Build conventions and per-area notes. Read it before changing an area. |

## Conventions

- Keep `packages/domain` pure: no I/O, no database or network access. Side effects belong in `services/*`.
- Every state change goes through the API commands and is written to the audit ledger. Do not write around the ledger or edit ledger rows.
- Database changes are migrations in `packages/db`. Never edit a migration that has already been merged. Add a new one.
- Add or update tests next to the code you change. Existing tests sit beside the source as `*.test.ts` and `*.test.tsx`.
- Do not add a dependency without saying why in the pull request. Commit the lockfile change that comes with it.
- Keep changes small and focused on one concern. Do not reformat files you are not otherwise changing.
- Use TypeScript types rather than `any`. Fix typecheck errors instead of suppressing them.

## Protected paths: do not edit without a named human owner's approval

- `.github/` (CI and workflow files)
- `deploy/` (the Compose stack, Caddy, the Keycloak realm, the secrets generator)
- `runner/` and `services/launcher/` (the sandbox boundary)
- `CODEOWNERS`, `AGENTS.md` and `.gantry/`
- `legacy/` (reference only)

## Secrets and credentials

- Never commit secrets, private keys, tokens, `.env` files or real credentials. Secret material lives under `deploy/secrets/` and is created by a script. It is not committed.
- Never print a secret value in a log, a test, a comment or a pull request. Name the file or the variable instead.
- Test fixtures must be obviously fake and must not look like real provider keys. A secret scanner already flagged key-shaped strings in test files, so do not add more. Build fake values from clearly non-key text.
- GitHub App credentials, model vendor keys and Slack credentials are supplied from outside the repository.

## Docker and the sandbox

- The default `npm test` is plain Vitest. The end-to-end suites under `services/github/test/e2e/` use Docker Compose and probably cannot run in a sandbox without Docker. Do not make the default test path depend on Docker.
- The full local stack is started with Docker Compose from `deploy/compose.yml`, as the README describes. Do not start it from an agent run.

## Pull requests

- One concern per pull request, with a short description of what changed and why.
- State which of build, typecheck and tests you ran and what they showed. Do not claim a check passed if you did not run it.
- Do not merge. A person with the right reviews and merges.

## Known gaps

These were true when this file was written. Update the file when they change.

- Lint is probably not enforced (see above).
- The scanner flagged 6 key-shaped strings in test files. A person is checking whether they are real.
- Branch protection on `main` was not set. A person sets it in GitHub.
- Whether the e2e tests are excluded from `npm test` has not been confirmed.
