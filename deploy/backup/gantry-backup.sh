#!/usr/bin/env bash
# Gantry backups (spec 3.4): Postgres (Gantry and Keycloak) and the object store, kept as daily sets, with a restore and
# a restore drill that proves a set can be brought back. Runs in the gantry-backup container (deploy/compose.yml).
#
#   gantry-backup.sh schedule        every day at GANTRY_BACKUP_AT (UTC, default 02:00); also at start when the newest set is
#                                    older than a day. The container's default.
#   gantry-backup.sh now             one set now
#   gantry-backup.sh list            the sets, newest first
#   gantry-backup.sh drill [SET]     restores SET (default: the newest) into scratch databases and a scratch bucket, checks it
#                                    against its manifest and the audit hash chain, then removes the scratch copies
#   gantry-backup.sh restore SET --yes
#                                    replaces the live Gantry and Keycloak databases and copies the objects back. Stop
#                                    gantry-api, gantry-worker and keycloak first (deploy/PRODUCTION.md, "Restore").
#
# A set is /backups/<UTC stamp>/: gantry.dump, keycloak.dump (pg_dump custom format), objects/ (the bucket), manifest.json,
# SHA256SUMS. It is written under a .partial name and renamed when complete. Secrets are never in a set: the data_key the
# database's stored secrets are encrypted with is escrowed separately (deploy/PRODUCTION.md, "Keys").
set -euo pipefail
# Sets hold full database dumps: owner-only, never world-readable.
umask 077

ROOT="${GANTRY_BACKUP_DIR:-/backups}"
# last-backup.json and last-drill.json (no data, only "when and did it pass") go to their own volume, which is all the API mounts.
STATUS="${GANTRY_BACKUP_STATUS_DIR:-/status}"
KEEP="${GANTRY_BACKUP_KEEP:-7}"
AT="${GANTRY_BACKUP_AT:-02:00}"
DB="${DATABASE_NAME:-gantry}"
KC_DB="${KEYCLOAK_DATABASE:-keycloak}"
BUCKET="${S3_BUCKET:-gantry}"
# People in Gantry's realm (not the master realm's administrators).
KC_USERS="select count(*) from user_entity u join realm r on r.id = u.realm_id where r.name = '${KEYCLOAK_REALM:-gantry}'"
export PGHOST="${DATABASE_HOST:-postgres}" PGUSER="${PGUSER:-gantry_owner}" PGCONNECT_TIMEOUT=10
PGPASSWORD="$(cat /run/secrets/db_owner_password)"; export PGPASSWORD
S3="${S3_ENDPOINT:-http://minio:9000}"
export MC_CONFIG_DIR=/tmp/mc
MC_HOST_src="${S3%%://*}://${S3_ACCESS_KEY:-gantry}:$(cat /run/secrets/minio_root_password)@${S3#*://}"
export MC_HOST_src
# Off-host copy: the file holds an mc host URL, https://ACCESS_KEY:SECRET@s3.example.com; GANTRY_BACKUP_REMOTE is the
# bucket/prefix there. Without both, sets stay on the backup volume (copy them off the host yourself).
if [ -s /run/secrets/backup_remote ] && [ -n "${GANTRY_BACKUP_REMOTE:-}" ]; then MC_HOST_remote="$(tr -d '\n' </run/secrets/backup_remote)"; export MC_HOST_remote; fi

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
q() { psql -X -v ON_ERROR_STOP=1 -tA -d "${2:-$DB}" -c "$1"; }
has_db() { [ "$(q "select 1 from pg_database where datname = '$1'" postgres)" = "1" ]; }
stamp() { date -u +%Y%m%dT%H%M%SZ; }
sets() { find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -printf '%f\n' | sort -r; }
newest() { sets | head -n1; }

# Exact row counts of every Gantry table: what the drill compares a restored copy with.
counts() { # db
  local tables t out="{"
  tables="$(q "select tablename from pg_tables where schemaname = 'public' order by 1" "$1")"
  for t in $tables; do out+="\"$t\":$(q "select count(*) from public.\"$t\"" "$1"),"; done
  printf '%s' "${out%,}}"
}
chain_breaks() { # db: orgs whose audit hash chain does not verify (packages/db/src/events.ts verifyChain, every org)
  q "select count(*) from (select e.org_id,
       case when e.seq <> coalesce(lag(e.seq) over w, 0) + 1 then 1
            when e.prev_hash <> coalesce(lag(e.hash) over w, repeat('0', 64)) then 1
            when e.hash <> gantry_event_hash(e) then 1 end as bad
     from events e window w as (partition by e.org_id order by e.seq)) s where bad = 1" "$1"
}

backup() {
  mkdir -p "$ROOT"
  local name dir; name="$(stamp)"; dir="$ROOT/.partial-$name"
  mkdir -p "$dir/objects"
  log "backup $name: database $DB"
  pg_dump -Fc -Z 6 -d "$DB" -f "$dir/gantry.dump"
  local kc=false
  if has_db "$KC_DB"; then log "backup $name: database $KC_DB"; pg_dump -Fc -Z 6 -d "$KC_DB" -f "$dir/keycloak.dump"; kc=true; fi
  log "backup $name: objects in $BUCKET"
  # A new installation has no bucket until the first object is stored.
  if mc --quiet ls "src/$BUCKET" >/dev/null 2>&1; then mc --quiet mirror --preserve "src/$BUCKET" "$dir/objects" >/dev/null; else log "backup $name: no bucket $BUCKET yet (no objects stored)"; fi
  local objects bytes head users=null
  objects="$(find "$dir/objects" -type f | wc -l | tr -d ' ')"
  bytes="$(du -sb "$dir/objects" | cut -f1)"
  head="$(q "select coalesce(max(name), '') from schema_migrations")"
  if $kc; then users="$(q "$KC_USERS" "$KC_DB" 2>/dev/null || echo null)"; fi
  cat >"$dir/manifest.json" <<JSON
{"rows":$(counts "$DB"),"set":"$name","createdAt":"$(date -u +%FT%TZ)","gantryVersion":"${GANTRY_VERSION:-dev}","postgres":"$(q "show server_version")","migrationHead":"$head","database":"$DB","keycloak":$kc,"keycloakUsers":$users,"objects":$objects,"objectBytes":$bytes}
JSON
  (cd "$dir" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS)
  mv "$dir" "$ROOT/$name"
  log "backup $name: done ($(du -sh "$ROOT/$name" | cut -f1), $objects objects)"
  printf '{"set":"%s","at":"%s","ok":true}\n' "$name" "$(date -u +%FT%TZ)" >"$STATUS/last-backup.json"
  prune
  if [ -n "${MC_HOST_remote:-}" ]; then
    log "backup $name: copying to remote/${GANTRY_BACKUP_REMOTE}"
    mc --quiet mirror "$ROOT/$name" "remote/${GANTRY_BACKUP_REMOTE%/}/$name" >/dev/null
  fi
}

prune() {
  local n=0 s
  for s in $(sets); do
    n=$((n + 1))
    if [ "$n" -gt "$KEEP" ] && [[ "$s" =~ ^20[0-9]{6}T[0-9]{6}Z$ ]]; then log "prune $s"; rm -rf -- "${ROOT:?}/$s"; fi
  done
  find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name '.partial-*' -mmin +1440 -exec rm -rf -- {} +
}

verify_sums() { (cd "$1" && sha256sum -c --quiet SHA256SUMS) || die "checksums do not match in $1"; }
json() { # file key -> value of a top-level key (numbers and strings). "rows" comes first in a manifest, so the last match is the top-level one.
  sed -E "s/.*\"$2\":(\"([^\"]*)\"|([^,}]*)).*/\2\3/" "$1"
}

drill() {
  local name="${1:-$(newest)}"; [ -n "$name" ] || die "no backup sets in $ROOT"
  local dir="$ROOT/$name" t; t="$(stamp | tr 'A-Z' 'a-z')"
  [ -f "$dir/manifest.json" ] || die "$name is not a backup set"
  # Globals: the exit trap removes the scratch copies after this function has returned.
  scratch="gantry_drill_$t" kscratch="keycloak_drill_$t" sbucket="gantry-drill-$t"
  local fails=0 checks=() started; started="$(date +%s)"
  pass() { checks+=("{\"check\":\"$1\",\"ok\":true}"); log "PASS  $1"; }
  fail() { checks+=("{\"check\":\"$1\",\"ok\":false,\"detail\":\"$2\"}"); log "FAIL  $1 ($2)"; fails=$((fails + 1)); }
  cleanup() {
    q "drop database if exists \"$scratch\"" postgres >/dev/null 2>&1 || true
    q "drop database if exists \"$kscratch\"" postgres >/dev/null 2>&1 || true
    mc --quiet rb --force "src/$sbucket" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT
  log "drill $name"
  if (cd "$dir" && sha256sum -c --quiet SHA256SUMS); then pass "checksums"; else fail "checksums" "SHA256SUMS does not match"; fi

  q "create database \"$scratch\"" postgres >/dev/null
  if pg_restore --exit-on-error --no-owner --role=gantry_owner -d "$scratch" "$dir/gantry.dump" 2>/tmp/restore.err; then pass "restore $DB"; else fail "restore $DB" "$(tail -n1 /tmp/restore.err | tr '"' "'")"; fi
  local head want got bad=""
  head="$(q "select coalesce(max(name), '') from schema_migrations" "$scratch" 2>/dev/null || true)"
  if [ "$head" = "$(json "$dir/manifest.json" migrationHead)" ]; then pass "migration head $head"; else fail "migration head" "restored '$head'"; fi
  want="$(sed -E 's/.*"rows":\{([^}]*)\}.*/\1/' "$dir/manifest.json" | tr ',' '\n')"
  while IFS=: read -r k v; do
    k="${k//\"/}"; [ -n "$k" ] || continue
    got="$(q "select count(*) from public.\"$k\"" "$scratch" 2>/dev/null || echo missing)"
    [ "$got" = "$v" ] || bad+="$k:$v->$got "
  done <<<"$want"
  if [ -z "$bad" ]; then pass "row counts ($(printf '%s\n' "$want" | grep -c .) tables)"; else fail "row counts" "$bad"; fi
  local breaks; breaks="$(chain_breaks "$scratch" 2>/dev/null || echo error)"
  if [ "$breaks" = "0" ]; then pass "audit hash chain ($(q "select count(*) from events" "$scratch") events)"; else fail "audit hash chain" "$breaks breaks"; fi

  if [ "$(json "$dir/manifest.json" keycloak)" = "true" ]; then
    q "create database \"$kscratch\"" postgres >/dev/null
    if pg_restore --exit-on-error --no-owner --role=gantry_owner -d "$kscratch" "$dir/keycloak.dump" 2>/tmp/restore.err; then
      local u; u="$(q "$KC_USERS" "$kscratch")"
      if [ "$u" = "$(json "$dir/manifest.json" keycloakUsers)" ]; then pass "restore $KC_DB ($u users)"; else fail "restore $KC_DB" "$u users, manifest says $(json "$dir/manifest.json" keycloakUsers)"; fi
    else fail "restore $KC_DB" "$(tail -n1 /tmp/restore.err | tr '"' "'")"; fi
  fi

  mc --quiet mb "src/$sbucket" >/dev/null
  mc --quiet mirror "$dir/objects" "src/$sbucket" >/dev/null
  local n; n="$(mc --quiet ls --recursive "src/$sbucket" | wc -l | tr -d ' ')"
  if [ "$n" = "$(json "$dir/manifest.json" objects)" ]; then pass "restore objects ($n)"; else fail "restore objects" "$n restored, manifest says $(json "$dir/manifest.json" objects)"; fi

  local secs=$(( $(date +%s) - started )) result
  result="$( [ "$fails" = 0 ] && echo true || echo false )"
  printf '{"set":"%s","at":"%s","ok":%s,"seconds":%s,"checks":[%s]}\n' "$name" "$(date -u +%FT%TZ)" "$result" "$secs" "$(IFS=,; echo "${checks[*]}")" | tee "$STATUS/last-drill.json" >"$dir/drill-$t.json"
  log "drill $name: $( [ "$fails" = 0 ] && echo PASSED || echo "FAILED ($fails)" ) in ${secs}s"
  [ "$fails" = 0 ]
}

restore() {
  local name="${1:-}" yes="${2:-}"; [ -n "$name" ] || die "restore needs a set name (gantry-backup.sh list)"
  local dir="$ROOT/$name"; [ -f "$dir/manifest.json" ] || die "$name is not a backup set"
  [ "$yes" = "--yes" ] || die "restore replaces the live databases and objects; add --yes"
  verify_sums "$dir"
  local live; live="$(q "select count(*) from pg_stat_activity where datname in ('$DB', '$KC_DB') and pid <> pg_backend_pid() and usename <> 'gantry_owner'" postgres)"
  [ "$live" = "0" ] || die "$live connections are still open to $DB/$KC_DB: stop gantry-api, gantry-worker, gantry-edge, gantry-github and keycloak first"
  log "restore $name: $DB"
  pg_restore --exit-on-error --clean --if-exists --single-transaction -d "$DB" "$dir/gantry.dump"
  if [ -f "$dir/keycloak.dump" ] && has_db "$KC_DB"; then log "restore $name: $KC_DB"; pg_restore --exit-on-error --clean --if-exists --single-transaction -d "$KC_DB" "$dir/keycloak.dump"; fi
  log "restore $name: objects into $BUCKET"
  mc --quiet mb --ignore-existing "src/$BUCKET" >/dev/null
  mc --quiet mirror --overwrite "$dir/objects" "src/$BUCKET" >/dev/null
  log "restore $name: done. Start the services again; gantry-migrate applies any migration newer than the set."
}

secs_until() { # HH:MM UTC -> seconds until its next occurrence
  local now next; now="$(date -u +%s)"; next="$(date -u -d "$(date -u +%F) $1" +%s)"
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  echo $((next - now))
}

schedule() {
  [[ "$AT" =~ ^[0-2][0-9]:[0-5][0-9]$ ]] || die "GANTRY_BACKUP_AT must be HH:MM (UTC)"
  local last; last="$(newest)"
  if [ -z "$last" ] || [ $(( $(date -u +%s) - $(date -u -d "$(echo "$last" | sed -E 's/^(....)(..)(..)T(..)(..)(..)Z$/\1-\2-\3 \4:\5:\6/')" +%s) )) -gt 86400 ]; then
    backup || log "backup failed; next attempt at $AT UTC"
  fi
  while true; do
    local wait; wait="$(secs_until "$AT")"
    log "next backup at $AT UTC (in ${wait}s)"
    sleep "$wait"
    backup || { log "backup failed"; printf '{"at":"%s","ok":false}\n' "$(date -u +%FT%TZ)" >"$STATUS/last-backup.json"; }
    if [ "${GANTRY_BACKUP_DRILL:-weekly}" = "daily" ] || { [ "${GANTRY_BACKUP_DRILL:-weekly}" = "weekly" ] && [ "$(date -u +%u)" = "7" ]; }; then drill || true; fi
  done
}

case "${1:-schedule}" in
  schedule) schedule ;;
  now) backup ;;
  list) sets ;;
  drill) drill "${2:-}" ;;
  restore) restore "${2:-}" "${3:-}" ;;
  *) die "usage: gantry-backup.sh schedule|now|list|drill [SET]|restore SET --yes" ;;
esac
