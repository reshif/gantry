# Running Gantry in production

This guide is for the person who installs and operates Gantry on a server. It covers the production profile
(`deploy/compose.prod.yml`), release images, TLS, sign-in, mail, backups, restore, keys, upgrades and CI. For the
local development stack, see [README.md](README.md).

## What the production profile changes

`deploy/compose.prod.yml` is merged over `deploy/compose.yml`:

| | Development (`compose.yml`) | Production (`+ compose.prod.yml`) |
| --- | --- | --- |
| Site | `https://localhost`, loopback only | `https://$GANTRY_HOSTNAME` on :443 (and :80 for Let's Encrypt) |
| TLS | Caddy's local CA | Let's Encrypt, or your own certificate |
| Keycloak | `start-dev`, H2 database, writable root | optimized build on Postgres (own role and database), read-only root, strict hostname |
| Realm | 15 demo accounts with a shared password | no accounts; password policy; `sslRequired: all` |
| Mail | Mailpit catches everything | your relay, for Gantry and Keycloak |
| Demo sign-in cards, demo seed | configurable | forced off |
| Second factor (MFA) | required for everyone; `GANTRY_DEV_ADMIN_MFA_OPTIONAL=true` is an explicit local opt-in, off by default | required for everyone, cannot be waived |
| Backups | on request (`--profile backup`) | always: daily, with a weekly restore drill |
| Limits | none | memory and process limits on every container |

## Before you start

- A Linux host with Docker Engine 27 or later and Compose v2.24 or later (the profile uses `!reset` and `!override`).
  4 CPUs and 8 GB of memory are enough for a small team; agent runs need more.
- A DNS name for the site (for example `gantry.example.com`) pointing at the host. For Let's Encrypt, ports 443 and 80
  must reach it from the internet. With your own certificate, only 443 is needed.
- A mail relay (SMTP) for notifications and for Keycloak's password-reset mail.
- Somewhere off the host to keep backups (an S3 bucket, or a disk you copy them to).

## Install

1. **Secrets.** Create them on the host, outside the repository if you can, and keep the directory owner-only:

   ```sh
   export GANTRY_SECRETS_DIR=/srv/gantry/secrets
   deploy/secrets/generate.sh
   ```

   Then fill in the files that start empty or as placeholders: `github_app.pem` and `github_app.json` (the GitHub App),
   `vendor_keys.json` (model vendors), and `smtp_password` if your relay needs a login. Also write
   `bootstrap_admin_password` yourself: the initial password of the first Factory Admin (at least 12 characters, not a
   default such as `admin` or `password`). `generate.sh` never generates it and leaves it as an empty file.

2. **Settings.** Copy `deploy/prod.env.example` to `deploy/prod.env` (git ignores it) and fill it in. The ones you must
   set: `GANTRY_HOSTNAME`, `GANTRY_TLS`, `GANTRY_SMTP_HOST`, `GANTRY_SMTP_FROM_ADDRESS`, `GANTRY_BOOTSTRAP_ADMIN_USERNAME`,
   `GANTRY_IMAGE_PREFIX`, `GANTRY_VERSION`, `DOCKER_GID`. Compose refuses to start and names the setting if one is missing.

3. **Check the images.** Every release image is signed by this repository's CI. Check them before you run them
   (needs [cosign](https://docs.sigstore.dev/cosign/system_config/installation/)):

   ```sh
   GANTRY_IMAGE_PREFIX=ghcr.io/your-org/ GANTRY_VERSION=1.2.3 deploy/verify-images.sh
   ```

4. **Start.**

   ```sh
   P="-f deploy/compose.yml -f deploy/compose.prod.yml --env-file deploy/prod.env"
   docker compose $P pull
   docker compose $P up -d
   docker compose $P ps     # everything healthy; gantry-migrate and keycloak-db-init exit 0
   ```

## First sign-in

The production realm has no accounts. Create people in Keycloak, or connect Keycloak to your company's identity provider.

- **Keycloak admin console.** It is served only on the host's loopback, never on the public site. From your machine:
  `ssh -L 8081:127.0.0.1:8081 you@gantry-host`, then open `http://localhost:8081/idp/admin/`. Sign in as `admin` with the
  password in the `keycloak_admin_password` secret file.
- **Your identity provider.** In the console: realm `gantry` > Identity providers (OIDC or SAML) or User federation (LDAP
  or Active Directory).
- **The first Factory Admin.** Set `GANTRY_BOOTSTRAP_ADMIN_USERNAME`, `GANTRY_BOOTSTRAP_ADMIN_EMAIL` (an address you read: the
  enrolment link goes there) and write the initial password to the `bootstrap_admin_password` secret file. While the
  organisation has no Factory Admin, the API creates that user in the `gantry` realm (as the scoped `gantry-admin` service
  account, see "Identity-provider account" below) with the password marked temporary and the required actions `UPDATE_PASSWORD`,
  `CONFIGURE_TOTP` and `CONFIGURE_RECOVERY_AUTHN_CODES`, and Keycloak emails that address a **one-time link, valid one hour**.
  The identity provider refuses a sign-in with only a password, so that link is the only way in: it makes them choose a
  password, set up an authenticator app and save recovery codes. After it, they sign in with password and code and become
  Factory Admin of an empty organisation ("Set up the factory"). If the link expired before it was used, restart `gantry-api`:
  while the user has no second factor and no Factory Admin exists, a fresh link is emailed. Without an address no link can be
  sent and the API log says so. A weak or missing password (under 12 characters or a default) is refused with a reason in
  the API log and no user is created. Once any Factory Admin exists, changing or removing the secret does nothing. After the
  first sign-in, delete the secret file's content. The `GANTRY_BOOTSTRAP_ADMIN_EMAIL` setting alone (no username) is the
  deprecated way to name the first admin.

### Second sign-in factor (MFA is required for everyone)

**Every person** signs in with a password and a second factor: a one-time code from an authenticator app (TOTP), a security
key or passkey (WebAuthn), or a single-use recovery code. There is no per-role policy and nothing to switch off. API keys and
run or service tokens are not people and are unaffected; the allow-list recovery command still opens its own window, but the
admin it lets in still signs in with both factors.

- **Who decides.** Gantry does, not Keycloak alone. The API checks the sign-in's ID token for evidence of a second factor
  (`amr` containing `otp`, `mfa`, `hwk`, `webauthn` and so on, or an `acr` of `2`, `3` or `mfa`; change the accepted `acr`
  values with `OIDC_MFA_ACR_VALUES`, the first one is what is requested). A person without it is refused at sign-in and on
  every request, and sees the "Two-step sign-in" screen. Every sign-in sends `acr_values=2` and `prompt=login`, and every
  step-up re-asks both factors (`max_age=0`); a step-up whose token has no `auth_time`, or one older than the step-up window, is refused.
- **What Keycloak does.** The realm's `gantry-browser` flow is: password, then any second factor the person already has,
  then level 2 is recorded (`acr` 2). A person with **no** second factor is refused (`gantry-no-factor`); the sign-in never
  offers to set one up from a password alone, and there is no "forgot password" self-service. The whole flow is in
  `realm-gantry.json` (the production realm is generated from it by `prod-realm.mjs`, which CI checks).
- **Enrolment (S-122).** A first authenticator is set up only from a **one-time link emailed by Keycloak** (an
  `executeActionsEmail` with `UPDATE_PASSWORD`, `CONFIGURE_TOTP`, `CONFIGURE_RECOVERY_AUTHN_CODES`; admin links live at most one
  hour, the realm caps `actionTokenGeneratedByAdminLifespan` at 3600 s). Gantry sends it when a person is invited (and
  again on a resend), and from People > Reset authenticator. After that, a person adds a security key or replaces a device in the Keycloak
  account console, which asks for their existing factor first (every sign-in there is two-step too), or an administrator resets them.
- **Reset (S-124).** People > Reset authenticator (`POST /api/v1/people/{id}/mfa-reset`): needs `people.manage`, a fresh two-factor
  sign-in and a reason, is refused for yourself, removes the person's second factors at Keycloak, ends their Keycloak and Gantry
  sessions, emails a new one-time link and records `people.mfa_reset` in the ledger. A reset done directly in the Keycloak console
  is noticed at that person's next sign-in (their authenticator ids changed) and recorded as `auth.mfa_changed`; their open
  Gantry sessions run until they end (back-channel logout, S-72, would end them at once). A sole Factory Admin who lost their device
  cannot reset themselves from Gantry: use the Keycloak console as `admin` (Users > Credentials > delete the OTP, then Credential
  reset > send the actions email with Update Password and Configure OTP), then they sign in with the one-time link.
- **Identity-provider account (S-125).** The API never has the Keycloak master-admin password. It uses the realm client
  `gantry-admin` (a service account that can manage users in the `gantry` realm and nothing else: not the realm, its flows or
  its clients) with the secret file `idp_admin_client_secret`. Only the `keycloak` service reads `keycloak_admin_password`, to start.
- **Sign-out (S-130).** Signing out of Gantry also sends the browser to Keycloak's end-session endpoint, with or without the
  stored id-token, and every sign-in is `prompt=login`, so a leftover Keycloak session cannot sign anyone back in silently.
  The Keycloak session itself lasts up to 30 minutes idle / 10 hours (realm `ssoSessionIdleTimeout`, `ssoSessionMaxLifespan`) if
  the browser is closed without signing out; Gantry ignores it for sign-in, but someone at that browser could use Keycloak's own
  account console until it ends, where every action needs the existing factor.
- **GitHub sign-in** cannot show a second factor to Gantry (a brokered login skips the realm's browser flow): it is refused unless
  that identity provider's *post-login flow* in Keycloak requires the second factor. Use single sign-on.
- **Upgrading a running realm.** Keycloak's `--import-realm` skips a realm that exists, so editing the JSON does not change a live
  one. Run the one-off migration once (see "Switching MFA on for an existing install" below).
- **Development.** `GANTRY_DEV_ADMIN_MFA_OPTIONAL=true` (default **false** in `compose.yml` and always false in
  `compose.prod.yml`) waives the check on a throwaway local stack with password-only demo users. The API refuses to start with it
  on unless `GANTRY_PUBLIC_URL` is localhost.

### Switching MFA on for an existing install

1. Create the secret file `deploy/secrets/idp_admin_client_secret` (a long random string; the file is not generated for you). It
   must be the same file the `keycloak` and `gantry-api` services mount (compose does this).
2. Apply the realm configuration to the running Keycloak, once, from the host (the admin console is on loopback):
   `node deploy/keycloak/apply-mfa-realm.mjs --url http://127.0.0.1:8081/idp --realm gantry --master-password-file deploy/secrets/keycloak_admin_password --admin-secret-file deploy/secrets/idp_admin_client_secret --realm-json deploy/keycloak/realm-gantry.prod.json --public-url https://$GANTRY_HOSTNAME`
   (add `--dry-run` first to see the calls; use `realm-gantry.json` on a dev stack). It reads both files itself and prints neither. It
   builds the new browser flow beside the old, switches, then removes the old; it registers the required actions, sets the OTP / WebAuthn
   policy, adds the `gantry-admin` client with only `manage-users`, and does not touch users or their credentials. Safe to run again.
3. Redeploy: `docker compose ... up -d` (the API image has migration 0053; `gantry-api` now mounts `idp_admin_client_secret` instead of
   `keycloak_admin_password`, and `GANTRY_DEV_ADMIN_MFA_OPTIONAL` is false).
4. Everyone is asked to enrol at their next sign-in: a person with no authenticator is refused with "Two-step sign-in" and needs a
   one-time link. In People, use **Reset authenticator** on each person (or invite them again) so Keycloak emails it. People who already
   have an authenticator app are unaffected. Gantry sessions made without a second factor end at their next request.

## TLS

`GANTRY_TLS` chooses the certificate:

- an email address: Caddy gets a Let's Encrypt certificate for `GANTRY_HOSTNAME` and renews it. The address receives
  expiry warnings. Certificates are kept in the `caddydata` volume.
- `/certs/tls.crt /certs/tls.key`: your own certificate (full chain) and key, put in `deploy/tls/` or in the directory
  named by `GANTRY_TLS_DIR`. Replace the files and run `docker compose $P restart ingress` to renew.
- `internal`: Caddy's own CA. Use it only for a private test install.

## Mail

Gantry's worker sends notifications, and Keycloak sends password-reset and verification mail. Both go to
`GANTRY_SMTP_HOST:GANTRY_SMTP_PORT` from `GANTRY_SMTP_FROM_ADDRESS`. For a relay that needs a login, set `GANTRY_SMTP_AUTH=true`
and `GANTRY_SMTP_USER`, and put the password in the `smtp_password` secret file. Use port 587 with STARTTLS, or set
`GANTRY_SMTP_SSL=true` for port 465.

## Backups

`gantry-backup` takes a **set** every day at `GANTRY_BACKUP_AT` (UTC). It also takes one at start when the newest set is
more than a day old. Each set holds:

- `gantry.dump` and `keycloak.dump`: both databases, as a consistent `pg_dump` each
- `objects/`: the object store (documents, traces, checkpoints)
- `manifest.json`: version, migration head, the row count of every table, object count
- `SHA256SUMS`: a checksum for every file

It keeps the newest `GANTRY_BACKUP_KEEP` sets (default 7). Sets go to the `backups` volume, or to `GANTRY_BACKUP_VOLUME`,
a host path owned by uid 10001. Sets are written owner-only (`umask 077`). The API does not mount that volume: it reads
`last-backup.json` and `last-drill.json` from the small `backupstatus` volume the backup service also writes.

**Audit checkpoints.** The API signs the audit chain head every five minutes (HMAC, key derived from `session_key`) into
`/anchors/audit-anchors.jsonl` on the `auditanchors` volume, and `GET /api/v1/audit/verify` checks every checkpoint against the
ledger. The database cannot write that volume. Copy it off the host with the backups (object lock or a SIEM) so a restored or
rewritten database cannot be paired with a rewritten checkpoint file. Rotating `session_key` invalidates old checkpoints.

To rotate `session_key` (or reset after a restore): first run `GET /api/v1/audit/verify` and confirm the chain is intact, copy
`audit-anchors.jsonl` off the host as the record of the old key, then stop the API, move the file aside on the `auditanchors`
volume, change the secret and start the API. It writes a fresh first checkpoint at start. Without that step `/audit/verify`
reports a break (`bad_mac`) at the first old checkpoint. If the file is missing while the ledger has entries, verify returns
`anchorFileMissing: true` with a warning instead of passing silently.

- **Off the host.** Put an S3 endpoint in the `backup_remote` secret file as `https://ACCESS_KEY:SECRET@s3.example.com`,
  and the bucket/prefix in `GANTRY_BACKUP_REMOTE`. Each set is then copied there after it is taken. Turn on versioning
  or object lock on that bucket, and expire old sets with the bucket's own lifecycle rule.
- **What a set does not contain:** secrets. The database's stored integration secrets are encrypted with the `data_key`
  secret, so a set is useless for those without it. See [Keys](#keys).
- **Encryption at rest:** the sets contain people's names, emails and the work itself. Keep them on encrypted storage.
- **Restore drill.** Every Sunday (`GANTRY_BACKUP_DRILL=weekly`; `daily` or `off` also work) the newest set is restored
  into scratch databases and a scratch bucket. The drill checks the checksums, the migration head, every table's row
  count, the audit log's hash chain, the Keycloak users and the objects, then deletes the scratch copies. The result is
  in `last-drill.json` on the backup volume. Run one yourself at any time:

  ```sh
  docker compose $P exec gantry-backup gantry-backup.sh drill
  ```

- **Health.** The container turns unhealthy when the newest backup failed or is more than 26 hours old. The monitoring profile alerts on it (`GantryBackupStale`).
- **Recovery point and time.** You can lose up to 24 hours of work (one set a day). Restoring took under a minute on a
  test install, plus a minute for the services to start; it grows with the size of the data. Point-in-time recovery
  (WAL archiving) is not set up.

### Restore

A restore replaces the live databases and copies the objects back.

```sh
docker compose $P exec gantry-backup gantry-backup.sh list                      # the sets, newest first
docker compose $P stop gantry-api gantry-worker gantry-edge gantry-github keycloak
docker compose $P exec gantry-backup gantry-backup.sh restore 20261116T020000Z --yes
docker compose $P up -d                                                        # gantry-migrate applies newer migrations
```

The restore checks the set's checksums first. It refuses while anything is still connected to the databases.

## Monitoring and alerts

The API, the worker and the launcher each serve Prometheus metrics. An optional profile adds Prometheus and Alertmanager
with alert rules, so a stuck queue, a stale backup or a dead service reaches you before a user notices.

```sh
docker compose $P --profile monitoring up -d
```

- **Prometheus** is at `http://127.0.0.1:9090` and **Alertmanager** at `http://127.0.0.1:9093`, on the host's loopback
  only (`GANTRY_PROMETHEUS_PORT`, `GANTRY_ALERTMANAGER_PORT`). Reach them with an SSH tunnel. Metrics are kept
  `GANTRY_METRICS_RETENTION` long (default 30 days) on the `promdata` volume.
- **Who can scrape.** `/metrics` is never served through the site. Each service answers a peer on the internal Docker
  networks that did not come through a proxy, and anyone holding the metrics token. To scrape from another host, create
  the secret `metrics_token` (`openssl rand -hex 32 > $GANTRY_SECRETS_DIR/metrics_token`), add it to the `secrets:` list
  of `gantry-api`, `gantry-worker` and `gantry-launcher` in an override file, publish the port you need, and send
  `Authorization: Bearer <token>`. Without the secret, only the internal network is allowed.
- **Where the metrics come from.** The API serves `/metrics` on port 8000, the worker on 9464 (`WORKER_METRICS_PORT`,
  0 turns it off) and the launcher on 9100.

What is measured:

| Metric | Meaning |
|---|---|
| `gantry_http_requests_total`, `gantry_http_errors_total`, `gantry_http_request_duration_seconds` | API request rate, server errors and latency, by route pattern |
| `gantry_jobs`, `gantry_jobs_queue_depth`, `gantry_jobs_oldest_due_seconds`, `gantry_jobs_stuck` | Background jobs by status, work waiting for a worker, jobs that lost their lease or ran too long |
| `gantry_worker_jobs_total`, `gantry_worker_job_duration_seconds`, `gantry_worker_heartbeat_age_seconds` | What the worker finished (done, retried, dead, lost) and whether it is alive |
| `gantry_runs_finished_24h` | Runs that ended in the last 24 hours, by outcome |
| `gantry_spend_month_micros`, `gantry_budget_used_ratio`, `gantry_budget_halts_active` | Model spend this month, each project's share of its budget, work orders halted at their cap |
| `gantry_outbox`, `gantry_outbox_dead_letters`, `gantry_worker_deliveries_total` | Notifications by status, ones that failed every attempt, deliveries by transport |
| `gantry_backup_age_seconds`, `gantry_backup_last_ok`, `gantry_restore_drill_last_ok` | The newest backup's age and result, the last restore drill |
| `gantry_launcher_runs_active`, `gantry_launcher_run_refusals_total`, `gantry_launcher_docker_up` | Runs the launcher holds, starts it refused, whether Docker answers |

Alert rules are in `deploy/monitoring/alerts.yml` (tested with `promtool test rules`, see `alerts.test.yml`):

| Alert | Fires when | First thing to do |
|---|---|---|
| `GantryServiceDown` | API, worker or launcher not scraped for 2 minutes | `docker compose $P ps`, then the service log |
| `GantryDatabaseUnreachable` | The API cannot reach Postgres for 2 minutes | Check the postgres container and its disk |
| `GantryWorkerHeartbeatLate` | No worker heartbeat for 90 seconds | Restart `gantry-worker`, read its log |
| `GantryApiErrorRate` | More than 5% of API requests fail (5xx) for 5 minutes | `docker compose $P logs gantry-api` |
| `GantryJobsStuck` | A job lost its lease or ran past the limit for 10 minutes | The System health page lists the jobs |
| `GantryQueueBacklog` | Due work waited over 5 minutes for 5 minutes | Is the worker running and not saturated? |
| `GantryDeadLetters` | A notification failed every attempt, for 5 minutes | System health lists them; fix the integration, retry |
| `GantryBudgetHalt` | A work order is halted at its spending cap | Raise the cap or leave it halted |
| `GantryBackupStale` | The newest backup is over 26 hours old | `docker compose $P logs gantry-backup` |
| `GantryBackupFailed` | The last backup attempt failed | Same, before the next run |

The file also has alerts for a slow API, a launcher that cannot reach Docker, failing runs, projects over budget, a
halted factory, a missing backup status and a failed restore drill.

**Being told.** Alertmanager starts with no receiver: alerts are kept and shown in its page. Edit
`deploy/monitoring/alertmanager.yml` to add an email, Slack or webhook receiver under `default` (see the Alertmanager
configuration reference), then `docker compose $P --profile monitoring restart alertmanager`. Mail and chat go out
through the `egress` network; Alertmanager has no access to your secrets, so put any password in the file and keep it
out of version control.

Check the rules after editing them:

```sh
docker run --rm --entrypoint promtool -v "$PWD/deploy/monitoring:/m:ro" prom/prometheus:v3.5.0 check rules /m/alerts.yml
docker run --rm --entrypoint promtool -v "$PWD/deploy/monitoring:/m:ro" prom/prometheus:v3.5.0 test rules /m/alerts.test.yml
```

## Keys

These secret files cannot be recovered from a backup. Keep a copy of each in your password manager or key vault,
separate from the backups:

| File | If you lose it |
| --- | --- |
| `data_key` | Every stored integration secret (Slack, webhooks, API keys, model vendor keys saved in the UI) is unreadable and must be entered again |
| `db_owner_password`, `db_password` | Reset them in Postgres, then update the files |
| `session_key` | Everyone is signed out; nothing else is lost |
| `oidc_client_secret` | Set a new one on the `gantry-web` client in Keycloak and in the file |
| `keycloak_admin_password` | Reset it with Keycloak's admin recovery (only the `keycloak` service reads it; the API never does) |
| `idp_admin_client_secret` | Set a new one on the `gantry-admin` client in Keycloak (Clients > gantry-admin > Credentials) and in the file, then restart `gantry-api` |
| `github_app.pem` | Generate a new private key in the GitHub App's settings |

Rotation without loss (re-encrypting under a new `data_key`) is not built yet. Until then, changing `data_key` means
entering the stored integration secrets again.

## Upgrade and rollback

Releases are tagged `vX.Y.Z`. CI publishes `ghcr.io/<owner>/gantry-<name>:X.Y.Z` for every image, signed, with an SBOM.

1. Read the release notes for the version.
2. Check its images: `GANTRY_VERSION=X.Y.Z deploy/verify-images.sh`.
3. Take a set: `docker compose $P exec gantry-backup gantry-backup.sh now`.
4. Set `GANTRY_VERSION=X.Y.Z` in `deploy/prod.env`, then `docker compose $P pull && docker compose $P up -d`.
   `gantry-migrate` applies the new migrations before the API and worker start.

Migrations only go forward, and an applied migration is never edited (CI checks both). To roll back:

- if the release added no migrations, set `GANTRY_VERSION` back and run `up -d`
- if it did, set it back and restore the set from step 3

## CI and releases

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

- lint, typecheck, every test suite against Postgres, and the build
- `npm audit` (high and critical fail the build for anything that ships) and the licence allow-list
- hadolint, `docker compose config` for both profiles (production must not mention Mailpit, demo accounts or
  `start-dev`), `caddy validate` and shellcheck
- the migration upgrade test (the base's migrations, then this tree's, on one database)
- every image built and scanned with Grype (a fixable high or critical fails), with an SBOM

On `main` and on `v*` tags it also pushes the images to GHCR, signs them with cosign (keyless, the workflow's identity),
and attaches the SBOM as an attestation. Every night, and on demand, it brings the whole stack up, runs
`deploy/smoke.sh`, and takes a backup with a restore drill. Dependabot proposes updates to npm packages, GitHub Actions
and base images every week.

A repository admin turns on branch protection for `main` once: pull requests only, every check above required, one
approving review, no force pushes. Run `deploy/ci/branch-protection.sh your-org/gantry` (needs `gh` signed in as an admin).

## Known limits

- One node: one Postgres, one MinIO, one Keycloak. There is no high availability and no point-in-time recovery.
- `gantry-launcher` (through `gantry-sockproxy`) and `gantry-github` use the host's Docker socket. That makes them
  equivalent to root on the host (spec 5.5). Run Gantry on a host of its own.
- MinIO no longer publishes images. The default is the community build `pgsty/minio`, pinned by digest. Set
  `MINIO_IMAGE` to use another S3-compatible server's image.
- Until the GitHub App files are filled in, `gantry-github` restarts in a loop with a configuration error. Nothing else
  waits for it.
