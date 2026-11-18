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

Sign in with a seeded demo account, for example `asha` / `gantry-dev` (all 15 people from the legacy seed exist; the username is the email prefix and the `gantry_id` claim is the legacy id such as `p-asha`). **The demo accounts and the shared password are for local development only.** Mail sent by the stack appears at https://localhost/mail/ (development profile only, see below). Keycloak's admin console is at http://localhost:8081/idp/admin/ on the host itself (`admin`, password in `deploy/secrets/keycloak_admin_password`); it is not served on the public site.

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

`GANTRY_INGRESS_PROFILE` picks the development routes from `caddy/profiles/`. `dev` (the compose default for this local stack) adds `/mail/*` to Mailpit `:8025`. `prod` (the Caddyfile default) adds nothing, so set `GANTRY_INGRESS_PROFILE=prod` for any shared or production install.

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

Non-secret settings come from environment variables in `compose.yml`; override them in your shell or a `deploy/.env` file: `GANTRY_ORG_ID`, `GANTRY_ORG_NAME`, `GANTRY_DEV_SEED`, `GANTRY_BOOTSTRAP_ADMIN_EMAIL`, `OIDC_GITHUB_IDP_ALIAS`, `RUNNER_VARIANTS`, `RUN_SUBNET_POOL`, `MAX_CONCURRENT_RUNS`, `DOCKER_GID`, `DOCKER_SOCKET`, `GANTRY_SECRETS_DIR`, `MINIO_IMAGE`, `KEYCLOAK_IMAGE`, `GANTRY_HOSTNAME`, `GANTRY_TLS`, `GANTRY_IMAGE_PREFIX`, `GANTRY_VERSION`, and the `GANTRY_BACKUP_*` settings (PRODUCTION.md). Set `COMPOSE_PROJECT_NAME` (or `-p`) to run a second copy; the launcher finds the edge through the compose project label.

## Keycloak realm

`keycloak/realm-gantry.json` is imported at start (`start-dev --import-realm`). The confidential client `gantry-web` uses the authorization-code flow with PKCE `S256` required and redirect URI `https://localhost/auth/callback`; direct password grants are off. Its secret is `${GANTRY_OIDC_CLIENT_SECRET}` in the JSON: the container's entrypoint reads `/run/secrets/oidc_client_secret` into that variable inside the container just before starting Keycloak, and Keycloak substitutes it during import (nothing is passed through compose environment). Tokens carry `gantry_id`, `gantry_title`, `acr` and `auth_time`. For step-up (spec 14.1) the API requests `prompt=login` (or `max_age=0`) and checks `auth_time`; Factory Admins also need a second factor (TOTP at level 2 of the realm's `gantry-browser` step-up flow, checked by the API from `acr`/`amr`); the dev stack waives it with `GANTRY_DEV_ADMIN_MFA_OPTIONAL` (default true in compose.yml), see PRODUCTION.md. The issuer is `https://localhost/idp/realms/gantry`; because `localhost` inside a container is the container itself, the API reaches Keycloak at `OIDC_INTERNAL_URL=http://keycloak:8081/idp/realms/gantry` (Keycloak runs with `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`, so discovery fetched there advertises internal back-channel URLs and the public issuer).

People can't change their own email address or username in Keycloak's account console: in the realm's user profile, both are editable by admins only. Gantry links a person by their verified email the first time they sign in, so a self-edited address could otherwise claim someone else's Gantry account. An invited person is claimed only through the invite email's link, which carries a one-time token (valid 14 days, single use).

`--import-realm` skips a realm that already exists, so an existing install picks up realm changes only by hand. For the user-profile change above, put the profile from `realm-gantry.json` (component `UserProfileProvider`) through the admin API on the loopback admin port: `PUT http://localhost:8081/idp/admin/realms/gantry/users/profile`.

## Image sources

Every third-party image is pinned by version and digest in `compose.yml` and the Dockerfiles; Dependabot proposes updates. Gantry's own images are `gantry-<name>:dev` when built locally and `${GANTRY_IMAGE_PREFIX}gantry-<name>:${GANTRY_VERSION}` for a release. Docker Hub rate-limits anonymous pulls; retry or set `KEYCLOAK_IMAGE` / `MINIO_IMAGE` to a mirror. MinIO no longer publishes images, so the default is the community build `pgsty/minio` of the same server.

Backups and the restore drill run locally too: `docker compose -f deploy/compose.yml --profile backup run --rm gantry-backup now`, then `... gantry-backup drill` (PRODUCTION.md, "Backups").

### First sign-in and demo data

A new install starts with an empty organisation: built-in roles, the default role matrix and security settings, and nobody signed in. Set `GANTRY_BOOTSTRAP_ADMIN_EMAIL` to the address of the first administrator; the first sign-in with that email (while the org has no Factory Admin) becomes Factory Admin. People are otherwise created on first sign-in with no roles until an admin grants some.

`GANTRY_DEV_SEED=true` loads the legacy demo organisation (20 people, 12 projects, 23 repos, policies and freezes) once, on the first start of an organisation that does not exist yet. It is for development and demos; the demo IP allow-list is not loaded. On a local stack (public URL on this machine) it also lists the seeded Keycloak users on the sign-in screen (password `gantry-dev`); without the seed there is no demo list.
