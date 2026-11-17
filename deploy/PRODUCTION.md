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
   `vendor_keys.json` (model vendors), and `smtp_password` if your relay needs a login.

2. **Settings.** Copy `deploy/prod.env.example` to `deploy/prod.env` (git ignores it) and fill it in. The ones you must
   set: `GANTRY_HOSTNAME`, `GANTRY_TLS`, `GANTRY_SMTP_HOST`, `GANTRY_SMTP_FROM_ADDRESS`, `GANTRY_BOOTSTRAP_ADMIN_EMAIL`,
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
- **The first Factory Admin.** Create (or federate) the person whose email is `GANTRY_BOOTSTRAP_ADMIN_EMAIL`. The first
  time they sign in, they become Factory Admin of an empty organisation and see "Set up the factory". Everyone after
  them gets access only when a Factory Admin invites them or grants them a role.

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

- **Health.** The container turns unhealthy when the newest backup failed or is more than 26 hours old. Alert on it.
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

## Keys

These secret files cannot be recovered from a backup. Keep a copy of each in your password manager or key vault,
separate from the backups:

| File | If you lose it |
| --- | --- |
| `data_key` | Every stored integration secret (Slack, webhooks, API keys, model vendor keys saved in the UI) is unreadable and must be entered again |
| `db_owner_password`, `db_password` | Reset them in Postgres, then update the files |
| `session_key` | Everyone is signed out; nothing else is lost |
| `oidc_client_secret` | Set a new one on the `gantry-web` client in Keycloak and in the file |
| `keycloak_admin_password` | Reset it with Keycloak's admin recovery |
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
