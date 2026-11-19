#!/usr/bin/env bash
# Checks that every Gantry image of a release was signed by this repository's CI before you run it, and prints the
# digests to pin (deploy/PRODUCTION.md, "Upgrade"). Needs cosign (https://docs.sigstore.dev/cosign/system_config/installation/).
#
#   GANTRY_IMAGE_PREFIX=ghcr.io/your-org/ GANTRY_VERSION=1.2.3 deploy/verify-images.sh
#   GANTRY_REPOSITORY=your-org/gantry    the GitHub repository whose workflow signed them (default: from the prefix)
set -euo pipefail

prefix="${GANTRY_IMAGE_PREFIX:?set GANTRY_IMAGE_PREFIX, for example ghcr.io/your-org/}"
version="${GANTRY_VERSION:?set GANTRY_VERSION, for example 1.2.3}"
owner="${prefix#ghcr.io/}"; owner="${owner%/}"
repo="${GANTRY_REPOSITORY:-$owner/gantry}"
command -v cosign >/dev/null || { echo "cosign is required" >&2; exit 2; }

[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "GANTRY_REPOSITORY must look like owner/name" >&2; exit 2; }
repo_re="$(printf '%s' "$repo" | sed 's/[][\\.^$*+?(){}|/]/\\&/g')"  # regex-escape: a `.` in the name must not match any character
identity="^https://github.com/${repo_re}/\\.github/workflows/ci\\.yml@refs/(heads/main|tags/v.*)$"
issuer="https://token.actions.githubusercontent.com"
fail=0
for name in api worker migrate launcher edge github web runner keycloak backup; do
  ref="${prefix}gantry-${name}:${version}"
  if out="$(cosign verify --certificate-identity-regexp "$identity" --certificate-oidc-issuer "$issuer" "$ref" 2>&1)"; then
    digest="$(printf '%s' "$out" | grep -o '"docker-manifest-digest":"sha256:[0-9a-f]*"' | head -n1 | cut -d'"' -f4)"
    if cosign verify-attestation --type spdxjson --certificate-identity-regexp "$identity" --certificate-oidc-issuer "$issuer" "$ref" >/dev/null 2>&1; then sbom="SBOM attested"; else sbom="NO SBOM attestation"; fail=1; fi
    # CI builds with buildx `provenance: mode=max`, which stores the SLSA provenance as an attestation manifest inside the image index, and the
    # signature verified above covers that index digest. So: read the provenance from the index and require that it names this repository as the
    # source (a signed image whose provenance names another repository, or has none, is refused).
    # The match is on the structured source fields and exact (deploy/ci/provenance-names-repo.mjs, tested): `<repo>-fork` or a stray mention does not pass.
    if ! command -v docker >/dev/null || ! command -v node >/dev/null; then prov="provenance NOT checked (docker and node are required)"; fail=1
    elif docker buildx imagetools inspect "${ref}${digest:+@$digest}" --format '{{json .Provenance}}' 2>/dev/null | node "$(dirname "$0")/ci/provenance-names-repo.mjs" "$repo"; then prov="provenance names $repo"
    else prov="NO provenance for $repo"; fail=1; fi
    printf 'OK    %-16s %s  (%s, %s)\n' "gantry-$name" "${digest:-?}" "$sbom" "$prov"
  else
    printf 'FAIL  %-16s %s\n' "gantry-$name" "$(printf '%s' "$out" | tail -n1 | cut -c1-160)"
    fail=1
  fi
done
[ "$fail" = 0 ] && echo "all images of $version are signed by $repo CI" || { echo "do not deploy: at least one image is not verified" >&2; exit 1; }
