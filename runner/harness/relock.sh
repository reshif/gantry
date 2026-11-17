#!/usr/bin/env bash
# Regenerates runner/harness/package-lock.json for the pinned harness version (needs the npm registry; run by a maintainer, then review and
# commit the lock). The runner image installs from the lock with `npm ci --ignore-scripts`, so the transitive tree and its integrity hashes
# only change when this lock does.
#   runner/harness/relock.sh [version]     (default: the version in package.json)
set -euo pipefail
cd "$(dirname "$0")"
[ -z "${1:-}" ] || npm pkg set "dependencies.@anthropic-ai/claude-code=$1"
rm -f package-lock.json
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
echo "wrote $(pwd)/package-lock.json: review the diff, then commit it"
