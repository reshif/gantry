# Gantry

Gantry is a software factory: work orders move through stations staffed by AI agents and gated by people, with every action permission-checked and recorded in an append-only audit ledger. This repository holds the React frontend and the full local Docker backend described in [spec.md](spec.md).

## Quick start

```bash
deploy/secrets/generate.sh
export DOCKER_GID=$(stat -c %g /var/run/docker.sock)
docker compose -f deploy/compose.yml build gantry-runner
GANTRY_DEV_SEED=true docker compose -f deploy/compose.yml up -d --build
deploy/smoke.sh
```

Open https://localhost and sign in with a demo account such as `asha` / `gantry-dev`. Details, including trusting the local certificate, are in [deploy/README.md](deploy/README.md). New to Gantry? Start with the [guides](docs/guide/README.md). To run it on a server, see [deploy/PRODUCTION.md](deploy/PRODUCTION.md).

- `GANTRY_DEV_SEED=true` loads the legacy demo organisation (people, projects, repos, work orders). It is for development and demos only.
- Without it the organisation starts empty, and the first sign-in with `GANTRY_BOOTSTRAP_ADMIN_EMAIL` (a verified email) becomes Factory Admin.

## Layout

| Path | What it is |
| --- | --- |
| `apps/web` | React 19 + Vite frontend, a faithful port of `legacy/` against the real API |
| `packages/domain` | Pure TypeScript domain logic: permission engine, flow rules, lifecycle, trust, workload |
| `packages/db` | Postgres schema and migrations, event ledger with hash chain, job queue, timers, outbox |
| `services/api` | `gantry-api`: REST API, sign-in, the decision point, all commands, live updates |
| `services/worker` | `gantry-worker`: flow engine jobs, timers, outbox delivery, reaper, reconciler, evals |
| `services/launcher` | `gantry-launcher`: starts and stops sandboxed runner containers from a fixed template |
| `services/edge` | `gantry-edge`: model gateway, MCP gateway, allow-listed forward proxy, trace capture |
| `services/github` | `gantry-github`: GitHub App broker (seed, publish, PRs, checks, merge, reconcile) |
| `runner` | `gantry-runner` image and wrapper (Claude Code headless adapter and a deterministic stub adapter) |
| `deploy` | Compose stack, Caddy, Keycloak realm, secrets generator, smoke and isolation checks |
| `legacy` | The original vanilla-JS frontend, kept as the behavioural reference |
| `docs/guide` | [User guide](docs/guide/user-guide.md) and [admin guide](docs/guide/admin-guide.md) for people new to Gantry, with an [overview](docs/guide/README.md) |
| `docs/BUILD.md` | Build conventions; `docs/build-notes/` has per-area interfaces, verification and open items |

## Development

```bash
npm ci
npm run build
npm run typecheck
GANTRY_TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres npm test
npm run dev -w @gantry/web    # proxies /api, /auth, /hooks to GANTRY_DEV_API (default http://localhost:8000)
```

Database tests need a real Postgres 17 superuser connection; each test file creates and drops its own database.

## Verification status

Verified locally:

- 1,363 automated tests across all packages, against a real Postgres.
- On the full compose stack, through a real browser and Keycloak sign-in:
  - a work order ran from submission to merge, each station in its own sandboxed runner;
  - every screen loaded without errors for a Factory Admin and an Engineer;
  - the M3 to M6 acceptance checks from spec section 15.2 passed.
- Halt and kill met the spec 4.4 targets: the edge refused a stopped run within 0.5 s and its container was gone within 2 s.
- Smoke checks passed 46 of 46, along with isolation tests T1 to T8, T10 and T12.

Not yet verified, because they need credentials:

| Needs | What it unlocks | Where it goes |
| --- | --- | --- |
| A GitHub App (cloud or GHES) with the permissions in spec 11.1, including `workflows` write for onboarding | Real repo onboarding, publish, PRs, checks and merge | `deploy/secrets/github_app.pem`, `deploy/secrets/github_app.json` |
| A model vendor key (for example Anthropic) | Real agent runs through the edge, real evals, the console, and isolation test T11 | `deploy/secrets/vendor_keys.json`, or the Models screen |
| A Slack app (bot token, signing secret) | Chat notifications, cards and in-chat approval | The Integrations screen |

Until then GitHub, model and Slack behaviour has only been exercised against test doubles that live under `test/` directories and are never wired into `deploy/compose.yml`. Microsoft Teams is listed as not yet available.

Open items from the reviews are listed under "Remaining" in [docs/build-notes/wave2-review.md](docs/build-notes/wave2-review.md), [wave3-review.md](docs/build-notes/wave3-review.md) and [wave4-review.md](docs/build-notes/wave4-review.md).
