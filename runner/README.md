# gantry-runner

Base image for one agent run (spec 3.2, 4.1) and the wrapper that runs inside it.

```
docker compose -f deploy/compose.yml build gantry-runner       # or:
docker build -f runner/Dockerfile -t gantry-runner:dev .
```

Build args: `NODE_IMAGE` (default `node:22-bookworm-slim`), `CLAUDE_CODE_VERSION` (overrides the pin in `runner/harness/package.json`, default `2.1.311`; the tree is installed from `runner/harness/package-lock.json` with `npm ci --ignore-scripts`, regenerate it with `runner/harness/relock.sh`; `HARNESS_LOCK=require` fails the build without a lock), `RUNNER_TOOLCHAIN` (`full` installs git, build-essential, python3, jq; `minimal` skips OS packages).
Add `--secret id=cacert,src=/path/ca.crt` behind a TLS-intercepting proxy.

The image holds no secrets and runs as uid 10001. The launcher gives it `EDGE_URL`, a credential-free `HTTPS_PROXY` and `GANTRY_RUN_ID` and nothing else; the run token arrives as `/workspace/.gantry-run-token`, which the wrapper reads and unlinks first thing (it is never in the environment). The image's own `ENV` sets git identity, points `core.hooksPath` at `/dev/null` (repository hooks never run when the agent runs git), and puts `HOME` and the npm cache on the `/tmp` tmpfs.

## Wrapper (`runner/wrapper`)

1. `GET $EDGE_URL/run/v1/spec` with `Authorization: Bearer <run token>` (zod-validated, see `src/spec.ts`).
2. Heartbeat `POST /run/v1/heartbeat` every `spec.heartbeatSeconds` (default 15) with `{runId, at, seq, phase, turn?}`.
3. Run the adapter chosen by `spec.adapter`:
   - `stub`: deterministic station result built from the spec, no model (`spec.stub.output` returns a given object verbatim; `spec.stub.failWith` forces a failure).
   - `claude`: Claude Code headless (`claude -p --output-format stream-json`). Repository settings, hooks, `.mcp.json`, slash commands and CLAUDE.md files do not load: `--setting-sources user` with an empty `CLAUDE_CONFIG_DIR`, `--strict-mcp-config` with an explicit `--mcp-config`, `--disable-slash-commands`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`. Model traffic goes to `ANTHROPIC_BASE_URL=$EDGE_URL/model` authenticated with the run token; the vendor key never enters the runner.
4. At each turn boundary `POST /run/v1/checkpoint` `{runId, at, turn, kind, name, contentType, content}`.
5. `POST /run/v1/result` `{runId, at, status: succeeded|failed|interrupted, output?, usage[], error?, adapter, capabilities}`.

A 401/403/409/410 from the edge means the token was refused (run stopped or superseded): the wrapper aborts the agent at once and exits 71 without posting a result. Wall-clock expiry (`spec.limits.wallClockSeconds`) is enforced inside the wrapper as a backstop to the worker's watchdog and reported as `failed` / `wall_clock`. SIGTERM interrupts the agent and posts `interrupted`.

Exit codes: 0 result delivered (any status), 2 bad environment, 70 spec unavailable or invalid, 71 refused by the edge, 72 result undeliverable.

**Unverified:** the `claude` adapter has never run against a real model (no key was available). Its flags, the stream-json event shapes and the repository-config isolation need the spec 16.2 spikes; its process handling is tested only against a stand-in executable.
