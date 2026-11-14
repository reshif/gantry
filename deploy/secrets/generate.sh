#!/usr/bin/env bash
# Creates the secret files compose mounts into containers (spec 3.5). Idempotent: an existing non-empty file is never
# touched. Secrets live in a directory outside git (deploy/secrets/* is ignored) with owner-only access.
#
#   deploy/secrets/generate.sh            # into deploy/secrets (or $GANTRY_SECRETS_DIR)
#
# File mode: compose bind-mounts each file, and the containers run as non-root uids (10001, 70) that differ from the
# host user, so a 0600 file would be unreadable inside them. The directory is 0700, which keeps other host users out;
# files are 0644 by default. Set GANTRY_SECRETS_MODE=0600 if your containers run as the file owner (rootless Docker
# with matching user namespace mapping).
set -euo pipefail

dir="${GANTRY_SECRETS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
mode="${GANTRY_SECRETS_MODE:-0644}"
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

umask 077
mkdir -p "$dir"
chmod 0700 "$dir"

made=() kept=()

# write_secret NAME CONTENT  (content is written with a trailing newline)
write_secret() {
  local name="$1" content="$2" path="$dir/$1"
  if [ -s "$path" ]; then
    kept+=("$name")
    return
  fi
  printf '%s\n' "$content" >"$path.tmp.$$"
  chmod "$mode" "$path.tmp.$$"
  mv -f "$path.tmp.$$" "$path"
  made+=("$name")
}

hex() { openssl rand -hex "$1"; }

write_secret db_password            "$(hex 24)"
write_secret db_owner_password      "$(hex 24)"
write_secret session_key            "$(hex 32)"
write_secret data_key               "$(openssl rand -base64 32)"   # AES-256-GCM key, 32 bytes base64
write_secret edge_token             "$(hex 32)"
write_secret github_token           "$(hex 32)"                    # service token between the API and gantry-github
write_secret launcher_token         "$(hex 32)"
write_secret minio_root_password    "$(hex 24)"
write_secret keycloak_admin_password "$(hex 16)"
write_secret oidc_client_secret     "$(hex 32)"
write_secret vendor_keys.json       '{}'
write_secret github_app.pem         '# PLACEHOLDER: replace this whole file with the GitHub App private key (PEM). Until then GitHub paths are unverified and gantry-github refuses to start work.'
write_secret github_app.json        '{"_placeholder":true,"_note":"FILL IN: GitHub App id, installation id and webhook secret from the App settings page","appId":null,"installationId":null,"webhookSecret":null}'

if [ "${#made[@]}" -gt 0 ]; then echo "created: ${made[*]}"; fi
if [ "${#kept[@]}" -gt 0 ]; then echo "kept existing: ${kept[*]}"; fi
echo "secrets directory: $dir"
