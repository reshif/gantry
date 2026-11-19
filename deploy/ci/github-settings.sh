#!/usr/bin/env bash
# The one-time GitHub settings the release pipeline needs (design: CICD.md): the three-plus Environments with their reviewers and
# branch rules, the main ruleset with the merge queue, and the immutable version tags. It PRINTS the gh commands by default and
# changes nothing; read them, then run with --apply as a repository admin (gh signed in). Safe to run again.
#
#   deploy/ci/github-settings.sh OWNER/REPO REVIEWER[,REVIEWER...]            # print
#   deploy/ci/github-settings.sh OWNER/REPO REVIEWER[,REVIEWER...] --apply    # do it
# REVIEWER is a GitHub login: the people who may promote to production (at least one who is not the author, if you can).
set -euo pipefail
repo="${1:?usage: github-settings.sh OWNER/REPO REVIEWERS [--apply]}"; reviewers="${2:?comma-separated reviewer logins}"; apply="${3:-}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "OWNER/REPO expected" >&2; exit 2; }
go() { if [ "$apply" = --apply ]; then "$@"; else printf '+'; printf ' %q' "$@"; printf '\n'; fi; }
api() { local method="$1" path="$2"; shift 2; go gh api -X "$method" "repos/$repo/$path" "$@"; }

# Jobs named in the required checks are the CI job names (.github/workflows/ci.yml) and nothing else.
checks=("Lint, typecheck, test, build" "Dependency audit and licences" "Dockerfiles, compose, Caddy, shell" "Migration upgrade from the base")
for i in api worker migrate launcher edge github web runner keycloak backup; do checks+=("Image $i"); done
contexts="$(printf '%s\n' "${checks[@]}" | jq -R '{context: .}' | jq -s .)"

ids="[]"
if [ "$apply" = --apply ]; then
  ids="$(for r in ${reviewers//,/ }; do gh api "users/$r" --jq '{type:"User", id:.id}'; done | jq -s .)"
else ids='[{"type":"User","id":"<id of each reviewer>"}]'; fi

echo "# Environments: staging (no reviewers), production (the approval), production-deploy (secrets and variables; main only)"
for env in staging production production-deploy; do
  body="$(jq -n --argjson ids "$ids" --arg env "$env" '{deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}}
    + (if $env == "production" then {reviewers:$ids, prevent_self_review:false, wait_timer:0} else {} end)')"
  go bash -c "printf '%s' '$body' | gh api -X PUT repos/$repo/environments/$env --input -"
  go gh api -X POST "repos/$repo/environments/$env/deployment-branch-policies" -f name=main -f type=branch
done
echo "# Variables the deploy job reads (non-secret): where Gantry is installed on the host, and where the deploy state lives"
go gh variable set GANTRY_HOME --env production-deploy --repo "$repo" --body /opt/gantry
go gh variable set GANTRY_STATE_DIR --env production-deploy --repo "$repo" --body /var/lib/gantry-release
echo "# Optional secret (a pager or chat webhook): gh secret set PAGER_WEBHOOK_URL --env production-deploy --repo $repo"

echo "# Ruleset on main: pull request + code owner review, required checks, merge queue, no force push or deletion"
ruleset="$(jq -n --argjson c "$contexts" '{
  name: "main", target: "branch", enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [
    { type: "deletion" }, { type: "non_fast_forward" },
    { type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_code_owner_review: true, require_last_push_approval: false, required_review_thread_resolution: true } },
    { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: $c } },
    { type: "merge_queue", parameters: { merge_method: "SQUASH", grouping_strategy: "ALLGREEN", max_entries_to_build: 5, max_entries_to_merge: 5, min_entries_to_merge: 1, min_entries_to_merge_wait_minutes: 1, check_response_timeout_minutes: 60 } }
  ] }')"
go bash -c "printf '%s' '$ruleset' | gh api -X POST repos/$repo/rulesets --input -"
echo "# Ruleset on version tags: a published version never moves or disappears"
tagrules='{"name":"version tags","target":"tag","enforcement":"active","conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},"rules":[{"type":"update"},{"type":"deletion"},{"type":"non_fast_forward"}]}'
go bash -c "printf '%s' '$tagrules' | gh api -X POST repos/$repo/rulesets --input -"
echo "# Actions: forks need approval to run workflows, and the default token is read-only"
go gh api -X PUT "repos/$repo/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
go gh api -X PUT "repos/$repo/actions/permissions" -F enabled=true -f allowed_actions=selected
go gh api -X PUT "repos/$repo/actions/permissions/selected-actions" -F github_owned_allowed=true -F verified_allowed=false -f 'patterns_allowed[]=docker/*' -f 'patterns_allowed[]=anchore/*' -f 'patterns_allowed[]=sigstore/*' -f 'patterns_allowed[]=hadolint/*'
echo "# Not scriptable here: Settings > Actions > General > 'Require approval for all outside collaborators' (fork pull requests), and the runner group (CICD.md)."
