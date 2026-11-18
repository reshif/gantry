# Secrets

`generate.sh` writes one file per secret into this directory (or `$GANTRY_SECRETS_DIR`). The files are git-ignored; compose mounts each one at `/run/secrets/<name>` into the containers listed below and no others. It never overwrites an existing non-empty file, so rerunning is safe; delete a file to rotate it, then recreate the containers that mount it.

Permissions: the directory is `0700`. Files are `0644` by default because compose bind-mounts them and the containers run as uids (10001, 70) that are not the host user, so `0600` files would be unreadable inside them (checked with `docker compose` 5.x: the `uid`/`mode` options of file secrets are ignored outside Swarm). The `0700` directory keeps other host users out. Set `GANTRY_SECRETS_MODE=0600` when the containers run as the file owner (rootless Docker with a matching uid mapping).

| File | Contents | Mounted into |
| --- | --- | --- |
| `db_password` | Password for the `gantry_app` Postgres role | postgres, gantry-api, gantry-worker, gantry-migrate |
| `db_owner_password` | Password for `gantry_owner` (schema owner, runs migrations) | postgres, gantry-migrate |
| `session_key` | Signs session cookies | gantry-api |
| `data_key` | Base64 AES-256 key for secrets users enter in the UI | gantry-api, gantry-worker, gantry-edge, gantry-github |
| `edge_token` | Service token the edge presents to the API | gantry-api, gantry-edge |
| `github_token` | Service token between the API and `gantry-github` | gantry-api, gantry-worker, gantry-github |
| `launcher_token` | Bearer token for `gantry-launcher` | gantry-worker, gantry-launcher |
| `vendor_keys.json` | Model vendor API keys. Starts as `{}`; fill it in to enable model calls | gantry-edge |
| `github_app.pem` | GitHub App private key. **Placeholder until you replace it** | gantry-github |
| `github_app.json` | GitHub App id, installation id, webhook secret. **Placeholder until you fill it in** | gantry-github |
| `minio_root_password` | MinIO root password (user `gantry`) | minio, gantry-api, gantry-worker, gantry-edge |
| `keycloak_admin_password` | Keycloak bootstrap admin (user `admin`) | keycloak, gantry-api (to create the bootstrap admin user) |
| `bootstrap_admin_password` | **You write it.** Initial password of the first Factory Admin (`GANTRY_BOOTSTRAP_ADMIN_USERNAME`); at least 12 characters, not a default. `generate.sh` only creates it empty; empty turns the username bootstrap off | gantry-api |
| `oidc_client_secret` | Secret of the `gantry-web` OIDC client | keycloak (realm import), gantry-api |

Whoever can read this directory can read every secret (spec 5.5). The values never go in environment variables or images.
