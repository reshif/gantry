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

identity="^https://github.com/${repo}/\\.github/workflows/ci\\.yml@refs/(heads/main|tags/v.*)$"
issuer="https://token.actions.githubusercontent.com"
fail=0
for name in api worker migrate launcher edge github web runner keycloak backup; do
  ref="${prefix}gantry-${name}:${version}"
  if out="$(cosign verify --certificate-identity-regexp "$identity" --certificate-oidc-issuer "$issuer" "$ref" 2>&1)"; then
    digest="$(printf '%s' "$out" | grep -o '"docker-manifest-digest":"sha256:[0-9a-f]*"' | head -n1 | cut -d'"' -f4)"
    if cosign verify-attestation --type spdxjson --certificate-identity-regexp "$identity" --certificate-oidc-issuer "$issuer" "$ref" >/dev/null 2>&1; then sbom="SBOM attested"; else sbom="NO SBOM attestation"; fail=1; fi
    printf 'OK    %-16s %s  (%s)\n' "gantry-$name" "${digest:-?}" "$sbom"
  else
    printf 'FAIL  %-16s %s\n' "gantry-$name" "$(printf '%s' "$out" | tail -n1 | cut -c1-160)"
    fail=1
  fi
done
[ "$fail" = 0 ] && echo "all images of $version are signed by $repo CI" || { echo "do not deploy: at least one image is not verified" >&2; exit 1; }
