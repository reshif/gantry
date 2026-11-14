#!/usr/bin/env bash
# Smoke and isolation checks for the local stack. Prints PASS/FAIL per check; exits non-zero if any FAIL.
#
#   deploy/smoke.sh                       # generate secrets, build, bring the stack up, check
#   SMOKE_NO_UP=1 deploy/smoke.sh         # check an already running stack
#   COMPOSE_PROJECT_NAME=w1plat deploy/smoke.sh
#   SMOKE_SERVICES="postgres mailpit ingress" deploy/smoke.sh   # bring up and check only these services (partial stacks)
#
# Isolation checks cover spec 5.4 T1, T2, T3, T4 and T10 plus the runner template's flags.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project="${COMPOSE_PROJECT_NAME:-gantry}"
export COMPOSE_PROJECT_NAME="$project"
# SMOKE_EXTRA_COMPOSE: extra compose file(s), colon-separated, merged after compose.yml (for partial or test stacks).
compose_files=(-f "$here/compose.yml")
if [ -n "${SMOKE_EXTRA_COMPOSE:-}" ]; then
  IFS=: read -r -a extra <<<"$SMOKE_EXTRA_COMPOSE"
  for f in "${extra[@]}"; do compose_files+=(-f "$f"); done
fi
dc() { docker compose -p "$project" "${compose_files[@]}" "$@"; }

pass=0 fail=0 skip=0
ok()   { printf 'PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf 'FAIL  %s%s\n' "$1" "${2:+ ($2)}"; fail=$((fail + 1)); }
skp()  { printf 'SKIP  %s%s\n' "$1" "${2:+ ($2)}"; skip=$((skip + 1)); }
check() { # check "name" command...   passes when the command succeeds
  local name="$1"; shift
  if out="$("$@" 2>&1)"; then ok "$name"; else bad "$name" "$(printf '%s' "$out" | tail -n1 | cut -c1-160)"; fi
}
refuse() { # refuse "name" command...  passes when the command FAILS (the attempt must not work)
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then bad "$name" "the attempt succeeded"; else ok "$name"; fi
}
has_service() { [ -z "${SMOKE_SERVICES:-}" ] || [[ " ${SMOKE_SERVICES} " == *" $1 "* ]]; }
cid() { dc ps -q "$1" 2>/dev/null | head -n1; }

# ---- up -------------------------------------------------------------------------------------------------------
if [ -z "${SMOKE_NO_UP:-}" ]; then
  "$here/secrets/generate.sh" >/dev/null || { echo "cannot generate secrets"; exit 2; }
  if [ -z "${DOCKER_GID:-}" ]; then DOCKER_GID="$(stat -c %g /var/run/docker.sock 2>/dev/null || echo 999)"; fi
  export DOCKER_GID
  echo "== building runner image"
  dc build gantry-runner >/dev/null 2>&1 || echo "note: gantry-runner image did not build; runner checks that need it will be skipped"
  echo "== bringing the stack up"
  # shellcheck disable=SC2086
  dc up -d --build ${SMOKE_SERVICES:-} || { echo "docker compose up failed"; exit 2; }
fi

# ---- wait for health ------------------------------------------------------------------------------------------
wait_healthy() {
  local deadline=$((SECONDS + ${SMOKE_TIMEOUT:-300})) pending
  while [ $SECONDS -lt $deadline ]; do
    pending=""
    while IFS='|' read -r svc state health code; do
      [ -z "$svc" ] && continue
      has_service "$svc" || continue
      case "$svc" in gantry-migrate|volume-init) [ "$state" = "exited" ] && [ "$code" = "0" ] || pending="$pending $svc"; continue;; esac
      if [ "$state" != "running" ]; then pending="$pending $svc"; continue; fi
      if [ -n "$health" ] && [ "$health" != "healthy" ]; then pending="$pending $svc"; fi
    done < <(dc ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}')
    [ -z "$pending" ] && return 0
    sleep 3
  done
  echo "not healthy after ${SMOKE_TIMEOUT:-300}s:$pending"
  return 1
}
echo "== waiting for health"
if wait_healthy; then ok "all services healthy"; else bad "all services healthy"; fi

# ---- ingress --------------------------------------------------------------------------------------------------
echo "== ingress"
curl_in() { curl -sk --max-time 10 --resolve localhost:443:127.0.0.1 "$@"; }
if has_service ingress; then
  check "GET https://localhost/healthz answers ok through the ingress" bash -c "[ \"\$(curl -sk --max-time 10 --resolve localhost:443:127.0.0.1 https://localhost/healthz)\" = ok ]"
  ports="$(docker port "$(cid ingress)" 2>/dev/null)"
  if [ "$ports" = "8443/tcp -> 127.0.0.1:443" ]; then ok "ingress publishes only 127.0.0.1:443"; else bad "ingress publishes only 127.0.0.1:443" "$ports"; fi
  published="$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}} {{.Ports}}' | grep -v '^[^ ]*ingress' | grep -c -- '->' || true)"
  if [ "$published" = "0" ]; then ok "no other container publishes a port"; else bad "no other container publishes a port" "$published"; fi
  hdrs="$(curl_in -sI https://localhost/healthz)"
  if printf '%s' "$hdrs" | grep -qi '^x-content-type-options: nosniff' && printf '%s' "$hdrs" | grep -qi '^strict-transport-security'; then ok "security headers present"; else bad "security headers present"; fi
  if has_service keycloak; then
    check "OIDC discovery answers through the ingress" bash -c "curl -sk --max-time 10 --resolve localhost:443:127.0.0.1 https://localhost/idp/realms/gantry/.well-known/openid-configuration | grep -q '\"issuer\":\"https://localhost/idp/realms/gantry\"'"
  fi
else
  skp "ingress checks" "ingress not in SMOKE_SERVICES"
fi

# ---- hardening (spec 3.6) -------------------------------------------------------------------------------------
echo "== hardening"
for svc in gantry-web gantry-api gantry-worker gantry-launcher gantry-edge gantry-github ingress mailpit postgres; do
  has_service "$svc" || continue
  id="$(cid "$svc")"
  [ -n "$id" ] || { bad "$svc hardening" "container not found"; continue; }
  read -r ro caps nnp < <(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}' "$id" | sed 's/ \[/ [/')
  if [ "$ro" = "true" ] && [[ "$caps" == *ALL* ]] && [[ "$nnp" == *no-new-privileges* ]]; then ok "$svc: read-only rootfs, cap_drop ALL, no-new-privileges"; else bad "$svc: read-only rootfs, cap_drop ALL, no-new-privileges" "ro=$ro caps=$caps"; fi
  priv="$(docker inspect -f '{{.HostConfig.Privileged}}' "$id")"
  [ "$priv" = "false" ] && ok "$svc: not privileged" || bad "$svc: not privileged"
done

# ---- network topology -----------------------------------------------------------------------------------------
echo "== networks"
for n in control launch; do
  v="$(docker network inspect -f '{{.Internal}}' "${project}_$n" 2>/dev/null)"
  [ "$v" = "true" ] && ok "network $n is internal" || bad "network $n is internal" "$v"
done
if has_service gantry-launcher; then
  nets="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(cid gantry-launcher)")"
  [ "$nets" = "${project}_launch " ] && ok "launcher is on the launch network only" || bad "launcher is on the launch network only" "$nets"
fi

# ---- isolation from a runner-like container -------------------------------------------------------------------
echo "== isolation (T1 T2 T3 T4 T10)"
PROBE_IMAGE="gantry-runner:dev"
docker image inspect "$PROBE_IMAGE" >/dev/null 2>&1 || PROBE_IMAGE="node:22-alpine"
snet="${project}-smoke-run-a"; snet2="${project}-smoke-run-b"
cleanup() {
  docker rm -f "${project}-smoke-peer" "${project}-smoke-probe" >/dev/null 2>&1
  if [ -n "${edge_id:-}" ]; then
    docker network disconnect -f "$snet" "$edge_id" >/dev/null 2>&1
  fi
  docker network rm "$snet" "$snet2" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup
docker network create --internal --subnet 10.213.250.0/28 --label gantry.smoke=1 "$snet" >/dev/null 2>&1 || bad "create smoke run network a"
docker network create --internal --subnet 10.213.250.16/28 --label gantry.smoke=1 "$snet2" >/dev/null 2>&1 || bad "create smoke run network b"

NODE_PROBE='
const net=require("net"),dns=require("dns");
const [mode,host,port]=process.argv.slice(1);
if(mode==="dns"){dns.lookup(host,(e,a)=>process.exit(e?1:0));setTimeout(()=>process.exit(1),4000);}
else{const s=net.connect({host,port:+port,timeout:3000},()=>process.exit(0));s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1));}'
runner_like() { # runner_like network node-args...  (same restrictions as the launcher template)
  local net="$1"; shift
  docker run --rm --network "$net" --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=8m --memory 128m --pids-limit 64 --entrypoint node "$PROBE_IMAGE" -e "$NODE_PROBE" "$@"
}

refuse "T1 internet: connect to 1.1.1.1:443 fails"              runner_like "$snet" tcp 1.1.1.1 443
refuse "T1 internet: connect to 8.8.8.8:53 fails"               runner_like "$snet" tcp 8.8.8.8 53
refuse "T4 DNS: resolving example.com yields nothing"           runner_like "$snet" dns example.com
for target in "postgres 5432" "gantry-api 8000" "gantry-github 9200" "gantry-launcher 9100" "minio 9000"; do
  set -- $target
  refuse "T2 $1:$2 unreachable from a run network"              runner_like "$snet" tcp "$1" "$2"
done

# T3: a second runner on another run network cannot reach the first.
docker run -d --name "${project}-smoke-peer" --network "$snet2" --user 10001:10001 --cap-drop ALL --read-only --entrypoint node "$PROBE_IMAGE" \
  -e 'require("net").createServer(s=>s.end()).listen(7777,"0.0.0.0");setTimeout(()=>{},60000)' >/dev/null 2>&1
sleep 1
peer_ip="$(docker inspect -f '{{(index .NetworkSettings.Networks "'"$snet2"'").IPAddress}}' "${project}-smoke-peer" 2>/dev/null)"
if [ -n "$peer_ip" ]; then
  refuse "T3 another runner's address is unreachable" runner_like "$snet" tcp "$peer_ip" 7777
  # control: the peer really listens, so the refusal above is the isolation and not a dead server
  check "T3 control: the peer is reachable from its own network" runner_like "$snet2" tcp "$peer_ip" 7777
else
  bad "T3 peer container started"
fi

# What the edge attachment gives a runner: the edge and nothing else.
if has_service gantry-edge && [ -n "$(cid gantry-edge)" ]; then
  edge_id="$(cid gantry-edge)"
  docker network connect --alias gantry-edge "$snet" "$edge_id" >/dev/null 2>&1
  check "edge is reachable from the run network it is attached to" runner_like "$snet" tcp gantry-edge 8443
  refuse "gantry-api still unreachable with the edge attached"    runner_like "$snet" tcp gantry-api 8000
  docker network disconnect -f "$snet" "$edge_id" >/dev/null 2>&1
  edge_id=""
else
  skp "edge attachment checks" "gantry-edge not running"
fi

# T10: the launcher has no route from the API or from a runner.
if has_service gantry-api && [ -n "$(cid gantry-api)" ]; then
  refuse "T10 gantry-api cannot reach gantry-launcher:9100" docker exec "$(cid gantry-api)" wget -q -T 3 -O /dev/null http://gantry-launcher:9100/healthz
fi
refuse "T10 a runner cannot reach gantry-launcher:9100" runner_like "$snet" tcp gantry-launcher 9100

# ---- launcher end to end: a real start-run and stop-run -------------------------------------------------------
echo "== launcher"
if has_service gantry-launcher && [ -n "$(cid gantry-launcher)" ] && docker image inspect gantry-runner:dev >/dev/null 2>&1; then
  L="$(cid gantry-launcher)"
  # busybox wget cannot send DELETE, so the launcher image's node does the calls (token read inside the container).
  api() { # api METHOD PATH [JSON]  -> prints the response body, exit 1 on a non-2xx status
    docker exec "$L" node -e '
      const fs=require("fs");const [m,p,b]=process.argv.slice(1);
      fetch("http://127.0.0.1:9100"+p,{method:m,headers:{authorization:"Bearer "+fs.readFileSync("/run/secrets/launcher_token","utf8").trim(),...(b?{"content-type":"application/json"}:{})},body:b||undefined})
        .then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)},()=>process.exit(1))' "$@"
  }
  refuse "launcher refuses a request without the token" docker exec "$L" wget -q -O /dev/null http://127.0.0.1:9100/v1/runs
  body='{"runId":"smoke1","workspaceRef":"smoke/none","variant":"base","runToken":"smoke-token-0123456789"}'
  if api POST /v1/runs "$body" | grep -q '"ok":true'; then
    ok "start-run created the run"
    n="$(docker network inspect -f '{{.Internal}}' run-smoke1 2>/dev/null)"
    [ "$n" = "true" ] && ok "run network run-smoke1 is internal" || bad "run network run-smoke1 is internal" "$n"
    flags="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}} {{.Config.User}} {{json .HostConfig.CapDrop}}' gantry-runner-smoke1 2>/dev/null)"
    [ "$flags" = 'true false 10001:10001 ["ALL"]' ] && ok "runner container carries the fixed template flags" || bad "runner container carries the fixed template flags" "$flags"
    api DELETE "/v1/runs/smoke1?keepWorkspace=false" >/dev/null
    if ! docker network inspect run-smoke1 >/dev/null 2>&1 && ! docker inspect gantry-runner-smoke1 >/dev/null 2>&1 && ! docker volume inspect ws-smoke1 >/dev/null 2>&1; then ok "stop-run removed container, network and volume"; else bad "stop-run removed container, network and volume"; fi
  else
    bad "start-run created the run"
  fi
else
  skp "launcher start-run/stop-run" "launcher or gantry-runner:dev image not available"
fi

echo
echo "passed: $pass  failed: $fail  skipped: $skip"
[ "$fail" -eq 0 ]
