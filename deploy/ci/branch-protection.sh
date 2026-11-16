#!/usr/bin/env bash
# Protects main: changes land only through pull requests that pass every CI gate and have one approving review; no force
# pushes, no deletion, and the rule applies to admins too. Run once by a repository admin (needs gh, authenticated):
#   deploy/ci/branch-protection.sh your-org/gantry
set -euo pipefail
repo="${1:?usage: branch-protection.sh OWNER/REPO}"

# The check names are the CI job names (.github/workflows/ci.yml). Image checks run per image.
checks=("Lint, typecheck, test, build" "Dependency audit and licences" "Dockerfiles, compose, Caddy, shell" "Migration upgrade from the base")
for i in api worker migrate launcher edge github web runner keycloak backup; do checks+=("Image $i"); done
contexts="$(printf '%s\n' "${checks[@]}" | jq -R . | jq -s 'map({context: .})')"

jq -n --argjson checks "$contexts" '{
  required_status_checks: { strict: true, checks: $checks },
  enforce_admins: true,
  required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_code_owner_reviews: false },
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: true
}' | gh api -X PUT "repos/$repo/branches/main/protection" --input - >/dev/null
echo "main is protected on $repo: ${#checks[@]} required checks, one review, no force pushes"
