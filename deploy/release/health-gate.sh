#!/usr/bin/env bash
# The production health gate (and canary soak): exits 0 only when the stack that was just started is healthy AND stays healthy.
# It is deliberately not deploy/smoke.sh: smoke.sh checks the development stack (https://localhost, loopback admin port, run-network
# isolation probes) and runs in the staging rehearsal; this one asks only "is production serving, and does it stay up".
#
#   health-gate.sh                    # uses COMPOSE (a command), GANTRY_HOSTNAME, GATE_TIMEOUT (default 300 s), GATE_SOAK (default 90 s)
# Checks, in order: every service is running (and healthy where it has a health check; one-shots exited 0); the ingress answers
# /healthz and the OIDC discovery document; then for GATE_SOAK seconds nothing restarts and everything stays healthy.
set -uo pipefail

: "${COMPOSE:?COMPOSE must be the docker compose command with its files}"
host="${GANTRY_HOSTNAME:?GANTRY_HOSTNAME is required}"
timeout="${GATE_TIMEOUT:-300}"
soak="${GATE_SOAK:-90}"
oneshots=" gantry-migrate volume-init keycloak-db-init "

problems() { # prints one line per service that is not ready; empty when all are
  local svc state health code
  # shellcheck disable=SC2086
  $COMPOSE ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}' 2>/dev/null | while IFS='|' read -r svc state health code; do
    [ -n "$svc" ] || continue
    if [[ "$oneshots" == *" $svc "* ]]; then [ "$state" = exited ] && [ "$code" = 0 ] || echo "$svc ($state, exit $code)"; continue; fi
    [ "$state" = running ] || { echo "$svc ($state)"; continue; }
    [ -z "$health" ] || [ "$health" = healthy ] || echo "$svc ($health)"
  done
}
restarts() { # total restart count of the project's containers
  # shellcheck disable=SC2086
  $COMPOSE ps -q 2>/dev/null | xargs -r docker inspect -f '{{.RestartCount}}' 2>/dev/null | awk '{s+=$1} END{print s+0}'
}
edge_ok() {
  [ "$(curl -sk --max-time 10 --resolve "$host:443:127.0.0.1" "https://$host/healthz")" = ok ] || return 1
  curl -sk --max-time 10 --resolve "$host:443:127.0.0.1" "https://$host/idp/realms/gantry/.well-known/openid-configuration" | grep -q '"issuer"'
}

deadline=$((SECONDS + timeout)); bad=""
while [ "$SECONDS" -lt "$deadline" ]; do
  bad="$(problems | tr '\n' ' ')"
  if [ -z "$bad" ] && edge_ok; then break; fi
  [ -n "$bad" ] || bad="the ingress does not answer /healthz or the OIDC discovery"
  sleep 3
done
if [ -n "$bad" ] && { [ -n "$(problems)" ] || ! edge_ok; }; then echo "health gate FAILED after ${timeout}s: $bad"; exit 1; fi
echo "health gate: serving; soaking ${soak}s"

base="$(restarts)"; end=$((SECONDS + soak))
while [ "$SECONDS" -lt "$end" ]; do
  now="$(restarts)"
  if [ "$now" != "$base" ]; then echo "health gate FAILED in the soak: a container restarted ($base -> $now restarts)"; exit 1; fi
  if [ -n "$(problems)" ] || ! edge_ok; then echo "health gate FAILED in the soak: $(problems | tr '\n' ' ')"; exit 1; fi
  sleep 5
done
echo "health gate: ok"
