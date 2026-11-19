#!/usr/bin/env bash
# Upgrade test (CI): applies the migrations of BASE (a git revision, default origin/main) to an empty database, then this
# tree's migrations on top, with the real runner (packages/db/dist/bin/migrate.js). Fails when an applied migration was
# edited or removed (the runner refuses) or when a new migration fails on a database the old ones built.
#   GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:5432/postgres deploy/ci/migration-upgrade.sh [BASE]
# Needs: npm ci and npm run build (for the runner and pg), and BASE fetched (actions/checkout with fetch-depth: 0).
# shellcheck disable=SC2154  # host, port, user and pass are assigned by an eval below
set -euo pipefail

base="${1:-origin/main}"
url="${GANTRY_TEST_DATABASE_URL:?set GANTRY_TEST_DATABASE_URL}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

if ! git -C "$here" rev-parse --verify --quiet "$base^{commit}" >/dev/null; then echo "base $base not found; nothing to compare"; exit 0; fi
if ! git -C "$here" cat-file -e "$base:packages/db/migrations" 2>/dev/null; then echo "base $base has no migrations; nothing to compare"; exit 0; fi
git -C "$here" archive "$base" packages/db/migrations | tar -x -C "$work"

# Connection pieces from the URL; the runner reads passwords from secret files.
eval "$(node -e 'const u=new URL(process.argv[1]);console.log(`host=${u.hostname} port=${u.port||5432} user=${decodeURIComponent(u.username)} pass=${JSON.stringify(decodeURIComponent(u.password))}`)' "$url")"
mkdir -p "$work/secrets"
printf '%s\n' "$pass" >"$work/secrets/db_owner_password"
printf '%s\n' "upgrade-test-app-password" >"$work/secrets/db_password"

db="gantry_upgrade_$$"
sql() { (cd "$here/packages/db" && node -e 'const pg=require("pg");const c=new pg.Client({connectionString:process.argv[1]});c.connect().then(()=>c.query(process.argv[2])).then(()=>c.end(),(e)=>{console.error(e.message);process.exit(1)})' "$url" "$1"); }
sql "create database $db"
cleanup_db() { sql "drop database if exists $db" >/dev/null 2>&1 || true; rm -rf -- "$work"; }
trap cleanup_db EXIT

export DATABASE_HOST="$host" DATABASE_PORT="$port" DATABASE_NAME="$db" DATABASE_OWNER_USER="$user" GANTRY_SECRETS_DIR="$work/secrets"
echo "== migrations at $base ($(ls "$work/packages/db/migrations" | wc -l) files)"
GANTRY_MIGRATIONS_DIR="$work/packages/db/migrations" node "$here/packages/db/dist/bin/migrate.js"
echo "== this tree ($(ls "$here/packages/db/migrations" | wc -l) files)"
node "$here/packages/db/dist/bin/migrate.js"
echo "upgrade from $base: ok"
