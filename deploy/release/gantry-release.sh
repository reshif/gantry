#!/usr/bin/env bash
# Deploys one signed release to this host (docker compose project "gantry") and undoes it when it is unhealthy.
# This is the only thing the pipeline runs on the production host. It trusts nothing it is handed: it verifies the release
# manifest's signature and every image's signature against this repository's CI identity, pulls by DIGEST, and refuses anything
# out of order. One deploy at a time (flock), forward-only migrations, a backup before them, and a rollback that knows what the
# schema allows (expand/contract, deploy/ci/migration-safety.mjs).
#
#   gantry-release.sh init [--applied-latest N] [--running-sha C]  once, on the host: record the schema applied today (default: ask the database)
#                                                          and the commit that is running (default: the install checkout's HEAD)
#   gantry-release.sh deploy MANIFEST BUNDLE [--no-soak]   verify, preflight, back up, migrate, start, health gate; roll back or page
#   gantry-release.sh rollback [--reason TEXT]             put the previous release back when the schema allows it, else page
#   gantry-release.sh stage MANIFEST BUNDLE                staging rehearsal: verify and pull by digest, start nothing (GitHub-hosted runner)
#   gantry-release.sh ack ID                               record that a person did a step in preconditions.json
#   gantry-release.sh status                               what is live, what is previous, what the schema is at
#
# Exit codes (deploy.yml turns them into a verdict; 0 is the only success):
#   0 healthy   10 unhealthy and rolled back   20 unhealthy and NOT rolled back: a person is needed   30 refused before changing anything
#   75 another deploy holds the lock   2 usage   1 any other failure (nothing was started unless the log says so)
#
# Environment: GANTRY_REPOSITORY (owner/name; the signer's identity), GANTRY_ENV_FILE (default deploy/prod.env),
#   GANTRY_STATE_DIR (default /var/lib/gantry-release), DRY_RUN=1 (print what would run, change nothing; used by the tests),
#   GATE_SOAK / GATE_TIMEOUT (health-gate.sh), GANTRY_RELEASE_KEEP (releases whose local image tags are kept, default 3).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="${GANTRY_REPO_DIR:-$(cd "$here/../.." && pwd)}"
state_dir="${GANTRY_STATE_DIR:-/var/lib/gantry-release}"
env_file="${GANTRY_ENV_FILE:-$repo_dir/deploy/prod.env}"
dry="${DRY_RUN:-0}"
keep="${GANTRY_RELEASE_KEEP:-3}"
issuer="https://token.actions.githubusercontent.com"
state="$state_dir/state.json"

log()  { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die()  { log "ERROR: $*"; printf '::error title=Gantry release::%s\n' "$*"; exit "${2:-1}"; }
run()  { if [ "$dry" = 1 ]; then log "+ (dry run) $*"; else "$@"; fi; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required on the host"; }
need jq; need git; need node; need flock
[ "$dry" = 1 ] || { need docker; need cosign; need curl; }

mkdir -p "$state_dir/releases"
[ -f "$state" ] || printf '{"live":null,"previous":null,"highestStarted":null,"applied":{"latest":0,"lastContract":0},"lastBackup":null,"acks":[]}\n' >"$state"
sget() { jq -r "$@" "$state"; }
sset() { local t; t="$(mktemp "$state_dir/.state.XXXXXX")"; jq "$@" "$state" >"$t" && mv "$t" "$state"; }  # sset FILTER [--arg ...]
mget() { jq -r "$2" "$1"; }

identity() {
  local repo="${GANTRY_REPOSITORY:?set GANTRY_REPOSITORY, for example acme/gantry}" re
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "GANTRY_REPOSITORY must look like owner/name" 2
  re="$(printf '%s' "$repo" | sed 's/[][\\.^$*+?(){}|/]/\\&/g')"
  # Only the CI workflow on main may have produced a release (never a pull request, a fork or a branch).
  printf '^https://github.com/%s/\\.github/workflows/ci\\.yml@refs/heads/main$' "$re"
}

# The compose command (its images are the local tags rel-<sha12>, selected with GANTRY_VERSION by with_release).
dc() { docker compose -p gantry --env-file "$env_file" -f "$repo_dir/deploy/compose.yml" -f "$repo_dir/deploy/compose.prod.yml" "$@"; }
compose_cmd() { echo "docker compose -p gantry --env-file $env_file -f $repo_dir/deploy/compose.yml -f $repo_dir/deploy/compose.prod.yml"; }
prefix_of() { local r; r="$(mget "$1" '.images.api.ref')"; echo "${r%gantry-api}"; }
tag_of() { echo "rel-$(mget "$1" '.sha' | cut -c1-12)"; }
with_release() { # with_release MANIFEST cmd... : run cmd with the compose variables pointing at the release
  local m="$1"; shift
  GANTRY_IMAGE_PREFIX="$(prefix_of "$m")" GANTRY_VERSION="$(tag_of "$m")" "$@"
}

verify() { # verify MANIFEST BUNDLE : the manifest's signature, its shape, then every image's signature
  local m="$1" b="$2" id; id="$(identity)"
  node "$here/release-manifest.mjs" validate "$m" || die "the release manifest is malformed" 30
  if [ "$dry" = 1 ]; then log "+ (dry run) cosign verify-blob + verify of each image"; return 0; fi
  cosign verify-blob --bundle "$b" --certificate-identity-regexp "$id" --certificate-oidc-issuer "$issuer" "$m" >/dev/null 2>&1 \
    || die "the manifest's signature does not verify against $GANTRY_REPOSITORY's ci.yml on main" 30
  local n
  for n in $(jq -r '.images | keys[]' "$m"); do
    cosign verify --certificate-identity-regexp "$id" --certificate-oidc-issuer "$issuer" "$(mget "$m" ".images.$n.ref")@$(mget "$m" ".images.$n.digest")" >/dev/null 2>&1 \
      || die "image gantry-$n is not signed by $GANTRY_REPOSITORY's CI at that digest" 30
  done
  log "verified: manifest and $(jq '.images | length' "$m") images"
}

pull_and_tag() { # by digest; the tag is local only, so what compose starts is exactly what was verified
  local m="$1" n ref dg t; t="$(tag_of "$m")"
  for n in $(jq -r '.images | keys[]' "$m"); do
    ref="$(mget "$m" ".images.$n.ref")"; dg="$(mget "$m" ".images.$n.digest")"
    run docker pull --quiet "$ref@$dg" >/dev/null || die "docker pull of gantry-$n failed" 1
    run docker tag "$ref@$dg" "$ref:$t" || die "docker tag of gantry-$n failed" 1
  done
}

fetch_source() { # bring the release's commit (and the history the order check needs) into the install checkout from the job's workspace
  [ -n "${GANTRY_SOURCE_DIR:-}" ] || return 0
  run git -C "$repo_dir" fetch --quiet "$GANTRY_SOURCE_DIR" "$1" || die "fetching $1 into $repo_dir failed" 1
}
checkout_release() { run git -C "$repo_dir" checkout --quiet --detach "$1" || die "checking out $1 in $repo_dir failed" 1; } # the compose files, Caddyfile and realm of the release

ordered() { # ordered NEW_SHA : the commit must be newer than everything this host ever started
  local new="$1" hs live; hs="$(sget '.highestStarted // empty')"; live="$(sget '.live.sha // empty')"
  [ "$new" != "$live" ] || die "$new is already live" 30
  if [ -z "$hs" ]; then
    # A host that was adopted (init) but whose running commit was never recorded cannot be order-checked: refuse rather than guess.
    [ "$(sget '.applied.latest')" = 0 ] || die "this host has applied migrations but no recorded running commit: run init --running-sha <commit> once, so the order of releases can be checked" 30
    return 0
  fi
  [ "$new" != "$hs" ] || die "$new was already started on this host and did not stay live (rolled back or paged): fix forward with a new commit" 30
  git -C "$repo_dir" cat-file -e "$hs^{commit}" 2>/dev/null || die "the checkout does not have $hs; fetch full history (fetch-depth: 0) so the order can be checked" 30
  git -C "$repo_dir" merge-base --is-ancestor "$hs" "$new" || die "$new is not a descendant of $hs, which this host already started: it is superseded, nothing is changed" 30
}

contract_ok() { # a contract migration is applied only while the RUNNING release already contains the commit that stopped using what it removes
  local m="$1" app_latest latest live_sha n after
  app_latest="$(sget '.applied.latest')"; latest="$(mget "$m" '.migrations.latest')"; live_sha="$(sget '.live.sha // empty')"
  while IFS=$'\t' read -r n after; do
    [ -n "$n" ] || continue
    [ -n "$live_sha" ] || die "this release applies contract migration $n but no running release is recorded on this host, so it cannot be shown that the running code stopped using what it removes: a person must decide (init --running-sha)" 30
    git -C "$repo_dir" cat-file -e "$after^{commit}" 2>/dev/null || die "contract migration $n names commit $after, which the checkout does not have (fetch full history)" 30
    git -C "$repo_dir" cat-file -e "$live_sha^{commit}" 2>/dev/null || die "the running release's commit $live_sha is not in the checkout" 30
    git -C "$repo_dir" merge-base --is-ancestor "$after" "$live_sha" \
      || die "contract migration $n drops or tightens something the running release ($live_sha) may still use: it is safe only once a release containing ${after:0:12} is live. Deploy that release first (expand, then contract)" 30
    log "contract migration $n: the running release contains ${after:0:12}; applying it (schema $app_latest -> $latest) means no automatic rollback past it"
  done < <(jq -r --argjson a "$app_latest" --argjson l "$latest" '.migrations.contracts[] | select(.n > $a and .n <= $l) | [.n, .after] | @tsv' "$m")
}

preconditions() { # person-only steps (preconditions.json) that this release newly requires
  local m="$1" id from text secrets s latest applied
  latest="$(mget "$m" '.migrations.latest')"; applied="$(sget '.applied.latest')"
  while IFS=$'\t' read -r id from text secrets; do
    [ "$latest" -ge "$from" ] && [ "$applied" -lt "$from" ] || continue
    if [ "$(sget --arg i "$id" '.acks | index($i) != null')" != true ]; then die "a person must do this first ($id): $text" 30; fi
    for s in ${secrets//,/ }; do [ "$dry" = 1 ] || [ -s "$repo_dir/deploy/secrets/$s" ] || die "the secret $s is not on the host ($id)" 30; done
  done < <(jq -r '.requires[] | [.id, .fromMigration, .text, (.secrets | join(","))] | @tsv' "$here/preconditions.json")
}

preflight() { # the compose files are valid for this release, the pinned networks match the host's, the host is sized
  local m="$1" net want have
  with_release "$m" dc config -q >/dev/null 2>&1 || [ "$dry" = 1 ] || die "docker compose config fails for this release" 30
  if [ "$dry" != 1 ]; then
    # A pinned subnet that differs from the existing network cannot be applied by an `up`: it needs the network recreated (downtime).
    while IFS=$'\t' read -r net want; do
      have="$(docker network inspect "gantry_$net" -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null | awk '{print $1}' || true)"
      [ -z "$have" ] || [ "$have" = "$want" ] || die "network $net is $have on this host but the compose file pins $want: schedule a maintenance window (docker compose down, then up) and deploy again" 30
    done < <(with_release "$m" dc config --format json | jq -r '.networks | to_entries[] | select(.value.ipam.config[0].subnet) | [.key, .value.ipam.config[0].subnet] | @tsv')
    grep -Eq '^MAX_CONCURRENT_RUNS=[0-9]+' "$env_file" || log "warning: MAX_CONCURRENT_RUNS is not set in $env_file; the launcher chooses (it refuses a value that does not fit the host)"
  fi
}

backup_now() { # a migration never runs unless THIS run made a backup set: lastBackup is cleared first and set only from this run's backup
  local set
  sset '.lastBackup = null'
  run dc exec -T gantry-backup gantry-backup.sh now || die "the backup failed: nothing was migrated and the old release is still serving" 1
  if [ "$dry" = 1 ]; then set="dry-run"; else set="$(dc exec -T gantry-backup gantry-backup.sh list | head -n1 | awk '{print $1}')" || set=""; fi
  [ -n "$set" ] || die "no backup set is listed after the backup: nothing was migrated" 1
  sset --arg s "$set" '.lastBackup = $s'; log "backup set: $set"
}

gate() { # the health gate; $1 = manifest the stack should be running
  if [ "$dry" = 1 ]; then log "+ (dry run) health-gate.sh"; return 0; fi
  COMPOSE="$(compose_cmd)" GANTRY_HOSTNAME="${GANTRY_HOSTNAME:-$(grep -E '^GANTRY_HOSTNAME=' "$env_file" | cut -d= -f2-)}" GATE_SOAK="${SOAK:-${GATE_SOAK:-90}}" \
    with_release "$1" "$here/health-gate.sh"
}

services_without_migrate() { with_release "$1" dc config --services | grep -vx gantry-migrate; }

prune() { # keep the local tags of the newest few releases; older images go
  [ "$dry" = 1 ] && return 0
  local f; for f in $(ls -1t "$state_dir/releases"/*.json 2>/dev/null | tail -n +$((keep + 1))); do
    local m="$f" n; for n in $(jq -r '.images | keys[]' "$m"); do docker rmi "$(mget "$m" ".images.$n.ref"):$(tag_of "$m")" >/dev/null 2>&1 || true; done
  done
}

cmd_rollback() {
  local reason="${1:-health gate failed}" prev pm applied_c need
  prev="$(sget '.previous.sha // empty')"
  if [ -z "$prev" ]; then log "no previous release is recorded: a person has to decide (the backup set is $(sget '.lastBackup // "none"'))"; return 20; fi
  pm="$(sget '.previous.manifest')"
  applied_c="$(sget '.applied.lastContract')"; need="$(mget "$pm" '.migrations.latest')"
  if [ "$applied_c" -gt "$need" ]; then
    log "cannot roll back to $prev: contract migration $applied_c is applied and that release only knows schema $need. The new release stays up. Backup set $(sget '.lastBackup // "none"') was taken before the migration."
    return 20
  fi
  ( checkout_release "$prev" ) || return 20
  log "rolling back to $prev ($reason); migrations are not reverted, the old release runs on the schema it was built for plus additions"
  [ "$dry" = 1 ] || { docker image inspect "$(mget "$pm" '.images.api.ref'):$(tag_of "$pm")" >/dev/null 2>&1 || ( pull_and_tag "$pm" ) || return 20; }
  # No gantry-migrate: the old runner refuses a database that has migrations it does not know.
  local svcs=()
  if [ "$dry" = 1 ]; then svcs=(every-service-except-the-migration-job); else mapfile -t svcs < <(services_without_migrate "$pm"); fi
  with_release "$pm" run dc up -d --no-deps "${svcs[@]}" || { log "starting the previous release failed"; return 20; }
  gate "$pm" || { log "the previous release is not healthy either"; return 20; }
  sset '.live = .previous | .previous = null'
  return 10
}

cmd_deploy() {
  local m="${1:?manifest}" b="${2:?bundle}" soak_flag="${3:-}" sha rel
  [ "$soak_flag" = --no-soak ] && export SOAK=0
  exec 9>"$state_dir/lock"
  flock -n 9 || die "another deploy holds the lock" 75
  verify "$m" "$b"
  sha="$(mget "$m" '.sha')"; rel="$state_dir/releases/$sha.json"
  fetch_source "$sha"
  ordered "$sha"; contract_ok "$m"; preconditions "$m"
  checkout_release "$sha"; preflight "$m"
  cp "$m" "$rel"
  pull_and_tag "$m"
  backup_now
  # From here the host may change: record that this commit was started, so nothing older ever starts after it.
  sset --arg s "$sha" '.highestStarted = $s'
  if [ "$dry" = 1 ]; then log "+ (dry run) gantry-migrate, up -d"; elif ! with_release "$m" dc run --rm gantry-migrate; then
    migrate_failed "$m"
    die "gantry-migrate failed; the old release is still serving; backup set $(sget '.lastBackup')" 1
  fi
  # The migrations are in: the schema moved even if the app then fails, so record it before anything else can fail.
  sset --slurpfile mg <(mget "$m" '.migrations' | jq -c .) '.applied.latest = ([.applied.latest, $mg[0].latest] | max) | .applied.lastContract = ([.applied.lastContract, $mg[0].lastContract] | max)'
  sset '.previous = .live'
  sset --arg s "$sha" --arg r "$rel" --slurpfile mg <(mget "$m" '.migrations' | jq -c .) '.live = {sha: $s, manifest: $r, migrations: $mg[0]}'
  # A failed `up` is an unhealthy release like any other: it ends in a rollback or a page.
  if with_release "$m" run dc up -d && gate "$m"; then log "release $sha is healthy"; prune; return 0; fi
  log "release $sha is NOT healthy"
  local rc=0; cmd_rollback "health gate failed after $sha" || rc=$?
  return "$rc"
}

migrate_failed() { # a failed migrate may have applied some files (each file is its own transaction): record what the database says
  local m="$1" db
  db="$(dc exec -T postgres psql -U gantry_owner -d gantry -Atc "select coalesce(max(left(name,4)::int),0) from schema_migrations" 2>/dev/null)" || db=""
  if [[ "$db" =~ ^[0-9]+$ ]]; then
    sset --argjson lat "$db" --slurpfile mg <(mget "$m" '.migrations' | jq -c .) '.applied.latest = ([.applied.latest, $lat] | max) | .applied.lastContract = ([.applied.lastContract] + [$mg[0].contracts[] | select(.n <= $lat) | .n] | max)'
    log "the database says schema $db is applied"
  else
    # Cannot ask: assume the worst, so a rollback past a contract migration that may have applied is never allowed.
    sset --slurpfile mg <(mget "$m" '.migrations' | jq -c .) '.applied.latest = ([.applied.latest, $mg[0].latest] | max) | .applied.lastContract = ([.applied.lastContract, $mg[0].lastContract] | max)'
    log "could not read schema_migrations: assuming every migration of this release applied"
  fi
}

cmd_stage() { # staging rehearsal (a GitHub-hosted runner): verify, pull by digest, tag locally. Starts nothing.
  local m="${1:?manifest}" b="${2:?bundle}"
  verify "$m" "$b"; pull_and_tag "$m"
  # smoke.sh's launcher checks use the development runner tag.
  run docker tag "$(mget "$m" '.images.runner.ref')@$(mget "$m" '.images.runner.digest')" gantry-runner:dev
  log "staged $(mget "$m" '.sha' | cut -c1-12) as tag $(tag_of "$m")"
}

cmd_init() { # init [--applied-latest N] [--running-sha SHA] : adopt the running stack. Records the schema and the commit that is running.
  local n="" sha=""
  while [ $# -gt 0 ]; do
    case "$1" in --applied-latest) n="${2:?a number}"; shift 2;; --running-sha) sha="${2:?a commit}"; shift 2;; *) die "usage: init [--applied-latest N] [--running-sha SHA]" 2;; esac
  done
  if [ -z "$n" ]; then
    if [ "$dry" = 1 ]; then n=0; else n="$(dc exec -T postgres psql -U gantry_owner -d gantry -Atc "select coalesce(max(left(name,4)::int),0) from schema_migrations")"; fi
  fi
  [[ "$n" =~ ^[0-9]+$ ]] || die "the applied schema level is not a number: $n" 2
  [ -n "$sha" ] || sha="$(git -C "$repo_dir" rev-parse HEAD)"
  sha="$(git -C "$repo_dir" rev-parse --verify "$sha^{commit}")" || die "$sha is not a commit in $repo_dir" 2
  sset --argjson n "$n" --arg s "$sha" '.applied.latest = $n | .applied.lastContract = 0 | .highestStarted = $s'
  log "recorded: schema $n applied, commit $sha is what runs now (releases older than it are refused); no contract migrations before this pipeline (none carried the mark)"
}

require_install() { # fail closed when the host is not set up: a missing variable must not fall back to a default checkout
  [ "$dry" = 1 ] && return 0
  [ -n "${GANTRY_REPO_DIR:-}" ] || die "GANTRY_REPO_DIR is not set (the install checkout, for example /opt/gantry)" 2
  [ -f "$env_file" ] || die "$env_file does not exist" 2
  [ -n "${GANTRY_STATE_DIR:-}" ] || die "GANTRY_STATE_DIR is not set" 2
}

case "${1:-}" in
  init) shift; cmd_init "$@";;
  stage) shift; cmd_stage "$@";;
  # `set -e` is off inside a function that is the left side of `||` or an `if`: run the whole deploy in a subshell with it on, take its code.
  deploy) shift; require_install; set +e; ( set -e; cmd_deploy "$@" ); rc=$?; set -e; echo "{\"exit\":$rc,\"at\":\"$(date -u +%FT%TZ)\"}" >"$state_dir/last-result.json"; exit "$rc";;
  rollback) shift; [ "${1:-}" = --reason ] && shift; require_install; exec 9>"$state_dir/lock"; flock -n 9 || die "another deploy holds the lock" 75; set +e; ( set -e; cmd_rollback "${1:-manual}" ); rc=$?; set -e; exit "$rc";;
  ack) [ -n "${2:-}" ] || die "usage: ack ID" 2; sset --arg i "$2" '.acks = ((.acks + [$i]) | unique)'; log "acknowledged: $2";;
  status) jq . "$state";;
  *) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2;;
esac
