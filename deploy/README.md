# Running Gantry locally

Everything runs in one Docker Compose project plus per-run containers that `gantry-launcher` creates on demand (spec section 3). Requirements: Docker Engine with Compose v2.24+, `openssl`, `curl`.

This page is the local development stack. For a server, use the production profile: [PRODUCTION.md](PRODUCTION.md).

## Start

```bash
deploy/secrets/generate.sh                           # once: creates deploy/secrets/* (git-ignored, never overwritten)
export DOCKER_GID=$(stat -c %g /var/run/docker.sock)  # the launcher joins the socket's group (macOS/rootless: see below)
docker compose -f deploy/compose.yml build gantry-runner   # the image runs are started from (build-only service)
docker compose -f deploy/compose.yml up -d --build
deploy/smoke.sh                                      # checks health, hardening and isolation (SMOKE_NO_UP=1 to skip bring-up)
```

Open https://localhost. Caddy signs a certificate from its local CA; either accept the warning or trust the root:

```bash
docker compose -f deploy/compose.yml cp ingress:/data/caddy/pki/authorities/local/root.crt ./gantry-local-root.crt
```

Sign in with a seeded demo account, for example `asha` / `gantry-dev` (all 15 people from the legacy seed exist; the username is the email prefix and the `gantry_id` claim is the legacy id such as `p-asha`). **The demo accounts and the shared password are for local development only.** Mail sent by the stack appears at https://localhost/mail/ (only with `GANTRY_INGRESS_PROFILE=dev`, see below). Keycloak's admin console is at http://localhost:8081/idp/admin/ on the host itself (`admin`, password in `deploy/secrets/keycloak_admin_password`); it is not served on the public site.

Stop and wipe: `docker compose -f deploy/compose.yml down -v`.

## Layout

| Network | Internet | Members |
| --- | --- | --- |
| `front` | published port only | ingress (`127.0.0.1:443` is the only published port) |
| `control` (internal) | no | ingress, web, api, worker, migrate, edge, github, postgres, minio, keycloak, mailpit |
| `launch` (internal) | no | worker, launcher |
| `egress` | yes | edge, github |
| `run-<id>` (internal, per run) | no | one runner plus the edge |

Ingress routes: `/api/*`, `/auth/*`, `/hooks/*` to `gantry-api:8000` (no buffering, so server-sent events stream); `/idp/realms/gantry/*` and `/idp/resources/*` to Keycloak `:8081`; any other `/idp/*` path (the admin console, the admin REST API, the `master` realm) answers 404; everything else to `gantry-web:8080`.

`GANTRY_INGRESS_PROFILE` picks the development routes from `caddy/profiles/`. The default is `prod`, which adds nothing: no `/mail`, no `/v3`. `dev` is an explicit opt-in that adds `/mail/*` (Mailpit `:8025`, which holds every invite link and notification mail) and the `/v3` design preview. **To keep Mailpit at `/mail/` and the preview at `/v3/` on a local or preview stack, set `GANTRY_INGRESS_PROFILE=dev`** in the environment `docker compose` runs with (an exported variable, or the compose env file you already use) before the next `up`; recreate only the `ingress` service for it to take effect (`docker compose -p gantry up -d ingress`). Never set it on a stack that binds beyond loopback. The demo accounts are separately tied to a localhost URL (`core/config.ts`).

### Back-channel logout (sessions end with the identity)

The API serves `POST /auth/backchannel-logout` (OIDC Back-Channel Logout 1.0). Keycloak posts a signed logout token there when a user signs out at Keycloak, is disabled, or has sessions revoked; the API verifies it (signature, issuer, audience, age, event) and revokes the matching Gantry sessions. The realm files set the client's `backchannel.logout.url` to `http://gantry-api:8000/auth/backchannel-logout` (container to container, never through the ingress) with session required. A realm that already exists is not re-imported, so on a running stack set it by hand once: Keycloak admin console, realm `gantry`, client `gantry-web`, Settings, Logout settings, "Backchannel logout URL" `http://gantry-api:8000/auth/backchannel-logout`, "Backchannel logout session required" on.

### Vendor LAN ranges (on-prem models)

The model gateway (edge) refuses vendor endpoints that are loopback, link-local (metadata), on a Gantry network or private, resolving the name on every call. An on-prem vendor on a private address needs its range listed: Security setting `vendorLanRanges` (IPv4 CIDR inside 10/8, 192.168/16 or 100.64/10), set by a Factory Admin with a fresh sign-in and audited. `EDGE_ALLOW_PRIVATE_UPSTREAMS=true` turns the edge guard off for a development stack.

What is never openable (`CONTROL_CIDRS` in `packages/domain/src/netguard.ts`): the pinned compose networks (control 10.89.17.0/24, front 172.18, dockerapi 172.19, egress 172.20, launch 172.22, wsapi 172.23, all /16) and Docker's whole default pool **172.16.0.0/12** (per-run networks and docker0 come from it). A range that overlaps any of them is refused when saved, so:
- **172.16.0.0/12 is not a LAN range.** A model host on a 172.16-172.31 address stops working at the edge and cannot be listed.
- **10.0.0.0/8 is refused** because it covers 10.89.17.0/24. List the real range instead, for example `10.0.0.0/16`.
- Compose service names (`gantry-*`, `postgres`, `minio`, `keycloak`, `mailpit`, ...) are never a vendor host.

Pinning the compose subnets matches what the existing stack already uses; on a stack created before the pin, `docker compose up` sees a changed network definition and recreates the networks (and the containers on them), so apply it in a maintenance window.

**If your model host really is on 172.16-31:** move Docker's pool away from the corporate LAN, then narrow `CONTROL_CIDRS` to match.
1. Pick a pool the LAN does not use, for example `10.200.0.0/16` split into /24 (it must not overlap the LAN or 10.89.17.0/24).
2. On the Docker host, edit `/etc/docker/daemon.json`: `{ "default-address-pools": [ { "base": "10.200.0.0/16", "size": 24 } ] }`.
3. Stop the stack (`docker compose -p gantry down`), restart the daemon (`systemctl restart docker`), remove the old gantry networks if `down` left any, and change the `ipam` subnets in `deploy/compose.yml` (front, dockerapi, egress, launch, wsapi) to blocks inside the new pool.
4. In `packages/domain/src/netguard.ts` replace `172.16.0.0/12` and the old 172.x /16 entries in `CONTROL_CIDRS` with the new pool and the new subnets, rebuild and redeploy the API and edge.
5. Then list the model host's 172.x range in Security.
Do this only with the owner's agreement: it changes the networks of every container.

### Keycloak admin console

The ingress serves the admin console on a second listener published as `127.0.0.1:8081` only. From another machine, tunnel to it: `ssh -L 8081:127.0.0.1:8081 <host>`, then open http://localhost:8081/idp/admin/. `KC_HOSTNAME_ADMIN` points Keycloak's admin links at this address.

Every Gantry container is read-only with a `/tmp` tmpfs, `cap_drop: ALL`, `no-new-privileges`, uid 10001, a restart policy of `unless-stopped` and a healthcheck. Third-party images get what they can take: Postgres runs as uid 70, MinIO and Mailpit as 10001, and Keycloak keeps a writable root filesystem because `start-dev` rebuilds at boot (the production profile runs an optimized build, read-only). The worker has no HTTP port and relies on the HEALTHCHECK in its own Dockerfile.

## Run networks and the address pool

Docker's default pools allow only a few dozen bridge networks. The launcher therefore gives each run an explicit `/28` taken from a dedicated range, `10.213.0.0/16` by default (`RUN_SUBNET_POOL`), capped at `MAX_CONCURRENT_RUNS` (32). Keep that range free on the host: do not use it for a VPN, a LAN or Docker's own `default-address-pools` in `/etc/docker/daemon.json`. Compose's own networks come from Docker's defaults, which do not overlap it. The launcher also checks every existing network's subnet before choosing one.

## Launcher

`gantry-launcher` listens on `launch` and holds no Docker socket. Every Docker call goes to `gantry-sockproxy` over the internal `dockerapi` network. The proxy containers (`gantry-sockproxy` for the launcher, `gantry-sockproxy-ws` for the GitHub broker's workspace helper) are the only containers with the socket, which is root-equivalent on the host (spec 5.5; rootless Docker narrows it further). It lets through only the launcher's own calls (`services/launcher/src/sockpolicy.ts`), only on containers, networks and volumes carrying the `gantry.managed-by=gantry-launcher` label. It accepts a container create only when it matches the fixed runner template: an allow-listed image, its own `run-<id>` network and `ws-<id>` volume, a read-only root, all capabilities dropped, `no-new-privileges`, and no privileged mode, binds, devices, host namespaces, published ports or other runtimes. It refuses exec, build, image pulls and everything else with a 403 and logs the reason. `DOCKER_GID` must be the socket's group id (`stat -c %g /var/run/docker.sock`; Docker Desktop on macOS usually needs `0`; for a non-default socket set `DOCKER_SOCKET`). API, authenticated with `launcher_token`:

| Call | Effect |
| --- | --- |
| `POST /v1/runs` `{runId, workspaceRef, variant, runToken, seedComplete?}` | Creates `run-<id>` (internal, own `/28`) and `ws-<id>`, attaches the edge as alias `gantry-edge`, starts the runner from the fixed template. `variant` must be in `RUNNER_VARIANTS` (`name=image,...`). Any other field is refused with 422. |
| `DELETE /v1/runs/<id>?keepWorkspace=true\|false` | SIGTERM, grace (10 s), SIGKILL, remove the container, detach the edge, remove the network. The volume is kept unless `keepWorkspace=false`. Idempotent. |
| `GET /v1/runs` | Containers, networks and volumes labelled `gantry.run`, grouped by run, plus capacity. For the reaper. |

Seeding order (spec 4.3): the launcher does not clone. Call `POST /v1/runs` with `seedComplete: false` first: it creates the network and volume and returns `state: "prepared"` without starting a runner. Have `gantry-github` seed `ws-<id>` (it must write as uid and gid 10001, the runner's user), then call `POST /v1/runs` again with `seedComplete: true` (or omit it) to start the runner. Omitting `seedComplete` on the first call starts immediately, for an unseeded or already seeded workspace.

## Configuration

Non-secret settings come from environment variables in `compose.yml`; override them in your shell or a `deploy/.env` file: `GANTRY_ORG_ID`, `GANTRY_ORG_NAME`, `GANTRY_DEV_SEED`, `GANTRY_BOOTSTRAP_ADMIN_USERNAME`, `GANTRY_BOOTSTRAP_ADMIN_EMAIL` (deprecated), `OIDC_GITHUB_IDP_ALIAS`, `RUNNER_VARIANTS`, `RUN_SUBNET_POOL`, `MAX_CONCURRENT_RUNS`, `DOCKER_GID`, `DOCKER_SOCKET`, `GANTRY_SECRETS_DIR`, `MINIO_IMAGE`, `KEYCLOAK_IMAGE`, `GANTRY_HOSTNAME`, `GANTRY_TLS`, `GANTRY_IMAGE_PREFIX`, `GANTRY_VERSION`, and the `GANTRY_BACKUP_*` settings (PRODUCTION.md). Set `COMPOSE_PROJECT_NAME` (or `-p`) to run a second copy; the launcher finds the edge through the compose project label.

## Keycloak realm

`keycloak/realm-gantry.json` is imported at start (`start-dev --import-realm`). The confidential client `gantry-web` uses the authorization-code flow with PKCE `S256` required and redirect URI `https://localhost/auth/callback`; direct password grants are off. Its secret is `${GANTRY_OIDC_CLIENT_SECRET}` in the JSON: the container's entrypoint reads `/run/secrets/oidc_client_secret` into that variable inside the container just before starting Keycloak, and Keycloak substitutes it during import (nothing is passed through compose environment). Tokens carry `gantry_id`, `gantry_title`, `acr` and `auth_time`. For step-up (spec 14.1) the API requests `prompt=login` (or `max_age=0`) and checks `auth_time`; Factory Admins also need a second factor (TOTP at level 2 of the realm's `gantry-browser` step-up flow, checked by the API from `acr`/`amr`); the dev stack waives it with `GANTRY_DEV_ADMIN_MFA_OPTIONAL` (default true in compose.yml), see PRODUCTION.md. The issuer is `https://localhost/idp/realms/gantry`; because `localhost` inside a container is the container itself, the API reaches Keycloak at `OIDC_INTERNAL_URL=http://keycloak:8081/idp/realms/gantry` (Keycloak runs with `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`, so discovery fetched there advertises internal back-channel URLs and the public issuer).

People can't change their own email address or username in Keycloak's account console: in the realm's user profile, both are editable by admins only. Gantry links a person by their verified email the first time they sign in, so a self-edited address could otherwise claim someone else's Gantry account. An invited person is claimed only through the invite email's link, which carries a one-time token (valid 14 days, single use).

`--import-realm` skips a realm that already exists, so an existing install picks up realm changes only by hand. For the user-profile change above, put the profile from `realm-gantry.json` (component `UserProfileProvider`) through the admin API on the loopback admin port: `PUT http://localhost:8081/idp/admin/realms/gantry/users/profile`.

## Image sources

Every third-party image is pinned by version and digest in `compose.yml` and the Dockerfiles; Dependabot proposes updates. Gantry's own images are `gantry-<name>:dev` when built locally and `${GANTRY_IMAGE_PREFIX}gantry-<name>:${GANTRY_VERSION}` for a release. Docker Hub rate-limits anonymous pulls; retry or set `KEYCLOAK_IMAGE` / `MINIO_IMAGE` to a mirror. MinIO no longer publishes images, so the default is the community build `pgsty/minio` of the same server.

Backups and the restore drill run locally too: `docker compose -f deploy/compose.yml --profile backup run --rm gantry-backup now`, then `... gantry-backup drill` (PRODUCTION.md, "Backups").

### First sign-in and demo data

A new install starts with an empty organisation: built-in roles, the default role matrix and security settings, and nobody signed in. The first administrator is a username and an initial password you set: put `GANTRY_BOOTSTRAP_ADMIN_USERNAME` in `deploy/.env` and write the initial password into the file `deploy/secrets/bootstrap_admin_password` (at least 12 characters, not a default; `generate.sh` leaves it empty and never generates it). While the org has no Factory Admin, the API creates that user in the Keycloak `gantry` realm with a temporary password and the required actions to change it and set up an authenticator app (TOTP); the first sign-in by that user becomes Factory Admin, with the same second-factor requirement as every Factory Admin. A weak or missing password is refused and logged, and nothing is created. Once a Factory Admin exists, the settings do nothing and a changed secret never resets the account. `GANTRY_BOOTSTRAP_ADMIN_EMAIL` (first verified sign-in with that email) still works but is deprecated. People are otherwise created on first sign-in with no roles until an admin grants some.

`GANTRY_DEV_SEED=true` loads the legacy demo organisation (20 people, 12 projects, 23 repos, policies and freezes) once, on the first start of an organisation that does not exist yet. It is for development and demos; the demo IP allow-list is not loaded. On a local stack (public URL on this machine) it also lists the seeded Keycloak users on the sign-in screen (password `gantry-dev`); without the seed there is no demo list. Keycloak imports the demo users (`deploy/keycloak/realm-gantry.json`) only when `GANTRY_DEV_SEED=true`; otherwise it imports `realm-gantry.empty.json`, the same realm with no users, and the first account is the bootstrap admin.

## Operations

### A Factory Admin locked out by the IP allow-list

If the IP allow-list is on and the only Factory Admin is away from an allowed network, nothing in the app can help: the list is checked before sign-in. The operator, on the server host (never through the web or the API), can open a one-time recovery for that admin:

```
docker compose -f deploy/compose.yml exec gantry-api node dist/cli/allowlist-recovery.js --person <person id> --minutes 30
```

- It records a window for that admin's NEXT sign-in from any address. The window is used once and expires after 30 minutes by default (`--minutes`, 60 at most). It lets nobody else in, and it does not change the allow-list.
- The admin still signs in with their second factor, and every step-up applies as usual. The session that sign-in creates may use the API from that one address for 30 minutes, which is time enough to confirm in the app whether the address joins the allow-list (`POST /api/v1/security/recovery/confirm`, step-up required; `GET /api/v1/security/recovery` says what is waiting). Without that confirmation the allow-list stays as it was.
- The command refuses a person who is not an active Factory Admin, and an allow-list that is empty. A second run replaces the admin's earlier unused window.
- Audited: `auth.allowlist_recovery.opened` (actor `operator`), `auth.allowlist_recovery.used` (the admin, with the address) and `auth.allowlist_recovery.address_added` or `.address_declined`, all in Audit under Auth.
- No HTTP route opens a window. Nobody without shell access to the server host can use it.
