# Wave 3: flow

## Summary
The API internal endpoints (found already built from the earlier attempt) and the new gantry-edge service are done. The API endpoint tests (35) and edge tests (67) pass. I added one endpoint to the API (POST /internal/v1/egress/denied) and wrote the whole edge service (model gateway :8443, forward proxy :8444, trace capture, Dockerfile). The edge image builds and starts hardened (read-only, cap-drop ALL), and /healthz answers inside the container. I did not run the compose stack. Real vendor calls, real MinIO and the runner's use of the proxy are unverified (listed below).

Decisions you may want to veto:
- **Trace storage degrades.** If MinIO is down, the model call still goes through, usage is reported without a trace reference, and the drop is counted and logged. Content is always secret-scanned before anything is stored, and a scan failure also drops the trace.
- **Checkpoints fail closed.** If MinIO is down, /run/v1/checkpoint returns 503 and nothing is recorded, because a checkpoint pointing at nothing is worse than a late one.
- **Model calls fail closed.** If the authorize call to the API fails (down, error, or no decision), the call is refused with 503 and never reaches the vendor.

## Public interface
## API (all under /internal/v1, edge service token as Bearer)

POST endpoints take `{token, ...}` and answer `{ok, msg, ...extra}`.
- **POST /runs/:id/authorize** `{token, model?}` returns `{allow:true, route:{vendor, baseUrl, modelId}, ...}` or `{allow:false, code, reason}`. Denial codes: token, revoked, expired, superseded, ended, stopped, finished, budget, route.
- **POST /runs/:id/usage** `{token, requestId, model, vendor, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, latencyMs, outcome, traceRef}`. Writes run_usage and usage_meter, and sets a system halt with cause budget at the turn boundary.
- **POST /runs/:id/heartbeat**, **/checkpoint**, **/result**, **/mcp-authorize**.
- **GET /runs/:id/spec** with an `x-run-token` header.
- **POST /runs/:id/egress** `{token}` returns the project's allow-list.
- **GET /egress/system** returns the worker's allow-list.
- **GET /vendors/:id/key** returns a decrypted vendor key, edge only.
- **NEW: POST /egress/denied** `{runId?, token?, caller:"run"|"system", host, port, reason}` writes an `egress.denied` audit event.

`issueRunToken(tx, runId, attemptId, fencing)` and `revokeRunTokens(db, target)` are in `services/api/src/areas/internal/tokens.ts`. I did not check whether they are exported from `@gantry/api/core`.

## Edge :8443
- `GET /healthz`.
- `POST /model/v1/messages` and `/model/v1/messages/count_tokens`. The run token goes in `Authorization: Bearer` or `x-api-key`. The model is forwarded to `<route.baseUrl>/v1/messages` with the vendor key injected, and SSE is streamed through.
- `GET /run/v1/spec`, `POST /run/v1/heartbeat`, `/checkpoint`, `/result`, matching the runner wrapper. The wrapper's checkpoint `content` is scanned and stored under `sha256/<hash>`, and only the reference goes to the API. Result output is redacted before it is forwarded.
- Refusals use the Anthropic error envelope with `x-gantry-denial: <code>`. Denials return 403, a model not allowed for the run returns 400, an unreachable API returns 503 with `retry-after: 5`, and vendor rate-limit or busy returns 429 with `retry-after`.
- `/mcp/*` returns 501. The MCP gateway is not built; the API composes no MCP URLs until wave 4.

## Edge :8444 proxy
- CONNECT for HTTPS, plus absolute-URI plain HTTP.
- A runner authenticates with `Proxy-Authorization: Basic base64("run:<runToken>")` and gets its project's allow-list.
- A caller with no credentials from outside the run subnet (the worker) gets the system allow-list.
- A caller with no credentials from inside the run subnet gets 407.
- Everything else gets 403 (not allow-listed, port, or private address) or 503 (allow-list unavailable, fail closed). Refusals are logged and reported once per minute to `/egress/denied`.

## Edge config
- **Environment:** `GANTRY_API_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_REGION`, `EDGE_MODEL_PORT`, `EDGE_PROXY_PORT`, `EDGE_VENDOR_CONCURRENCY` (16), `EDGE_RUN_SUBNET` (`10.213.0.0/16`).
- **Secrets:** `edge_token`, `vendor_keys.json` (`{"<vendorId>":"<key>"}`), `minio_root_password`.
- **Vendor keys:** `vendor_keys.json` is tried first, then user-entered keys from `GET /vendors/:id/key`.

## Library exports (`@gantry/edge`)
`buildGateway`, `buildProxy`, `loadConfig`, `ApiClient`, `VendorKeys`, `VendorLimiter`, `scanText`, `scanJson`, `S3ObjectStore`, `NoObjectStore`, `runIdOfToken`, `hostAllowed`.

## Integration notes
1. **Launcher change needed for the proxy.** services/launcher/src/template.ts line ~81 sets `HTTPS_PROXY=${cfg.runnerEnv.proxyUrl}` with no credentials. It should become `http://run:<runToken>@gantry-edge:8444`, since the launcher already receives `runToken` in start-run. The wrapper passes `HTTPS_PROXY` through unchanged (runner/wrapper/src/adapters/claude.ts:82). Until then runners get 407.
2. **Worker proxy use.** The worker sets `HTTPS_PROXY=http://gantry-edge:8444` with no credentials and must not sit inside 10.213.0.0/16. It then gets the system allow-list from `GET /internal/v1/egress/system`: enabled integration URLs, slack.com, hooks.slack.com, api.slack.com, and *.webhook.office.com. Extra hosts come from `orgs.settings.egress.hosts` or `systemHosts`.
3. **Edge compose entry.** It already lists `data_key`, `edge_token`, `vendor_keys.json` and `minio_root_password`. The S3 bucket `gantry` must exist (the platform notes say api or worker create it); the edge does not create it. `GANTRY_ORG_ID` is unused by the edge because the API is single-org.
4. **Dispatch must issue the token.** The worker's dispatch transaction must call `issueRunToken(tx, runId, attemptId, fencing)` and pass the token to the launcher as `runToken`. The stop transaction must call `revokeRunTokens`.
5. **Result handling.** `/runs/:id/result` stores a `station_results` row with id `sr-<runId>` and enqueues `run.result` with a dedupe key. The worker must apply it. I did not call `applyStationResult`, as instructed.
6. **Budget halt.** `/usage` inserts a `stops` row (wo scope, halt, cause budget, set_by system) and enqueues `stop.enforce`.
7. **Migration.** Migration 0014 (run_tokens and usage detail columns) was already in place from the earlier attempt. I added no new migration.
8. **Package metadata.** services/edge/package.json keeps its original dependency list so package-lock.json stays in sync, even though `@gantry/domain` and `undici` are unused. The Dockerfile uses `Dockerfile.dockerignore`.
9. **Fastify content-type parsers.** The edge removes all content-type parsers and takes raw buffers on both routes, so bodies are forwarded byte for byte.
10. **Docker usage here.** I ran the image with `docker run` (published nothing); `--network host` did not work in this sandbox.
11. **Progress file.** docs/build-notes/progress-w3edge-.md has the run commands. The API tests need `GANTRY_TEST_DATABASE_URL`; I started a scratch Postgres 16 with initdb on port 54399 and removed it afterwards.

## Unverified
- Real vendor calls (Anthropic or any other vendor): no keys. Only a fake Messages-API server was used.
- Real MinIO: only a path-style S3 double under test/ was used. The AWS SDK settings (`forcePathStyle`, `requestChecksumCalculation: WHEN_REQUIRED`) are untested against MinIO.
- The edge talking to the real API over HTTP: the edge tests use a fake API that mirrors response shapes pinned by the API tests. No test runs the real edge against the real API process.
- The full compose stack and the runner wrapper through the edge. The proxy cannot identify a runner until the launcher injects credentials into HTTPS_PROXY (see notes).
- The vendor-fallback route and non-Anthropic endpoints (e.g. the vLLM-style base URL ending in /v1) are only exercised through the fake vendor.
- Trace increments are held per edge process: after a restart the first record of a run is full rather than a delta.
- The MCP gateway is not implemented (/mcp/* returns 501). mcp-authorize exists on the API side but nothing calls it yet.
- A repo-wide `npm run typecheck` fails in services/api/src/areas/workorders/engine.ts (missing `EventCategory` export and a `warn` property). That belongs to another engineer's area, not mine.
