#!/usr/bin/env bash
# Deploys one signed release to this host (docker compose project "gantry") and undoes it when it is unhealthy.
# This is the only thing the pipeline runs on the production host. It trusts nothing it is handed: it verifies the release
# manifest's signature and every image's signature against this repository's CI identity, pulls by DIGEST, and refuses anything
# out of order. One deploy at a time (flock), forward-only migrations, a backup before them, and a rollback that knows what the
# schema allows (expand/contract, deploy/ci/migration-safety.mjs).
#
#   gantry-release.sh init [--applied-latest N]            once, on the host: record what is applied today (default: ask the database)
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
    run docker pull --quiet "$ref@$dg" >/dev/null
    run docker tag "$ref@$dg" "$ref:$t"
  done
}

fetch_source() { # bring the release's commit (and the history the order check needs) into the install checkout from the job's workspace
  [ -n "${GANTRY_SOURCE_DIR:-}" ] || return 0
  run git -C "$repo_dir" fetch --quiet "$GANTRY_SOURCE_DIR" "$1"
}
checkout_release() { run git -C "$repo_dir" checkout --quiet --detach "$1"; } # the compose files, Caddyfile and realm of the release

ordered() { # ordered NEW_SHA : the commit must be newer than everything this host ever started
  local new="$1" hs live; hs="$(sget '.highestStarted // empty')"; live="$(sget '.live.sha // empty')"
  [ "$new" != "$live" ] || die "$new is already live" 30
  [ -n "$hs" ] || return 0
  [ "$new" != "$hs" ] || die "$new was already started on this host and did not stay live (rolled back or paged): fix forward with a new commit" 30
  git -C "$repo_dir" cat-file -e "$hs^{commit}" 2>/dev/null || die "the checkout does not have $hs; fetch full history (fetch-depth: 0) so the order can be checked" 30
  git -C "$repo_dir" merge-base --is-ancestor "$hs" "$new" || die "$new is not a descendant of $hs, which this host already started: it is superseded, nothing is changed" 30
}

contract_ok() { # a contract migration is applied only while the image that is running already stopped using what it removes
  local m="$1" lc latest live_latest app_latest
  lc="$(mget "$m" '.migrations.lastContract')"; app_latest="$(sget '.applied.latest')"
  [ "$lc" -gt "$app_latest" ] || return 0
  live_latest="$(sget '.live.migrations.latest // 0')"
  [ "$live_latest" -ge $((lc - 1)) ] || die "release carries contract migration $lc but the running release is at schema $live_latest: deploy a release that stops using it first (expand, then contract)" 30
  latest="$(mget "$m" '.migrations.latest')"; log "contract migration $lc is applied by this release (schema $app_latest -> $latest): no automatic rollback past it"
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

backup_now() {
  local set
  run dc exec -T gantry-backup gantry-backup.sh now
  if [ "$dry" = 1 ]; then set="dry-run"; else set="$(dc exec -T gantry-backup gantry-backup.sh list | head -n1 | awk '{print $1}')"; fi
  [ -n "$set" ] || die "no backup set exists after the backup" 1
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
  checkout_release "$prev"
  log "rolling back to $prev ($reason); migrations are not reverted, the old release runs on the schema it was built for plus additions"
  [ "$dry" = 1 ] || { docker image inspect "$(mget "$pm" '.images.api.ref'):$(tag_of "$pm")" >/dev/null 2>&1 || pull_and_tag "$pm"; }
  # No gantry-migrate: the old runner refuses a database that has migrations it does not know.
  local svcs=()
  if [ "$dry" = 1 ]; then svcs=(every-service-except-the-migration-job); else mapfile -t svcs < <(services_without_migrate "$pm"); fi
  with_release "$pm" run dc up -d --no-deps "${svcs[@]}"
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
  if [ "$dry" = 1 ]; then log "+ (dry run) gantry-migrate, up -d"; else
    with_release "$m" dc run --rm gantry-migrate || die "gantry-migrate failed; the old release is still serving; backup set $(sget '.lastBackup')" 1
  fi
  # The migrations are in: the schema moved even if the app then fails, so record it before anything else can fail.
  sset --slurpfile mg <(mget "$m" '.migrations' | jq -c .) '.applied.latest = ([.applied.latest, $mg[0].latest] | max) | .applied.lastContract = ([.applied.lastContract, $mg[0].lastContract] | max)'
  sset '.previous = .live'
  with_release "$m" run dc up -d
  sset --arg s "$sha" --arg r "$rel" --slurpfile mg <(mget "$m" '.migrations' | jq -c .) '.live = {sha: $s, manifest: $r, migrations: $mg[0]}'
  if gate "$m"; then log "release $sha is healthy"; prune; return 0; fi
  log "release $sha is NOT healthy"
  local rc=0; cmd_rollback "health gate failed after $sha" || rc=$?
  return "$rc"
}

cmd_stage() { # staging rehearsal (a GitHub-hosted runner): verify, pull by digest, tag locally. Starts nothing.
  local m="${1:?manifest}" b="${2:?bundle}"
  verify "$m" "$b"; pull_and_tag "$m"
  # smoke.sh's launcher checks use the development runner tag.
  run docker tag "$(mget "$m" '.images.runner.ref')@$(mget "$m" '.images.runner.digest')" gantry-runner:dev
  log "staged $(mget "$m" '.sha' | cut -c1-12) as tag $(tag_of "$m")"
}

cmd_init() {
  local n=""
  [ "${1:-}" = --applied-latest ] && n="${2:?a number}"
  if [ -z "$n" ]; then
    if [ "$dry" = 1 ]; then n=0; else n="$(dc exec -T postgres psql -U gantry_owner -d gantry -Atc "select coalesce(max(left(name,4)::int),0) from schema_migrations")"; fi
  fi
  sset --argjson n "$n" '.applied.latest = $n | .applied.lastContract = 0'
  log "recorded: schema $n applied; no contract migrations before this pipeline (none carried the mark)"
}

case "${1:-}" in
  init) shift; cmd_init "$@";;
  stage) shift; cmd_stage "$@";;
  deploy) shift; rc=0; cmd_deploy "$@" || rc=$?; echo "{\"exit\":$rc,\"at\":\"$(date -u +%FT%TZ)\"}" >"$state_dir/last-result.json"; exit "$rc";;
  rollback) shift; [ "${1:-}" = --reason ] && shift; exec 9>"$state_dir/lock"; flock -n 9 || die "another deploy holds the lock" 75; rc=0; cmd_rollback "${1:-manual}" || rc=$?; exit "$rc";;
  ack) [ -n "${2:-}" ] || die "usage: ack ID" 2; sset --arg i "$2" '.acks = ((.acks + [$i]) | unique)'; log "acknowledged: $2";;
  status) jq . "$state";;
  *) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2;;
esac
