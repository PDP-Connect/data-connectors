#!/usr/bin/env bash

# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

# Run only inside the reviewed main workflow, under its existing concurrency group.
# ORAS, Cosign and registry-command.sh are already installed by that job.
set -euo pipefail
if [[ -z "${CATALOG_PUBLISHER_URL:-}" || -z "${CATALOG_PUBLISHER_AUDIENCE:-}" ]]; then
  echo "::error::Catalog publisher must be configured before recovery" >&2
  exit 1
fi
source "${GITHUB_WORKSPACE}/scripts/registry-command.sh"
RECOVERY_DIR="${RUNNER_TEMP}/catalog-ready-recovery"
mkdir -p "$RECOVERY_DIR"
printf '%s' "$GH_TOKEN" | oras login ghcr.io --username "$GITHUB_ACTOR" --password-stdin
LOOKUP_USERNAME="$GITHUB_ACTOR" LOOKUP_PASSWORD="$GH_TOKEN" \
  node "${GITHUB_WORKSPACE}/scripts/lookup-manifest.mjs" \
  --reference ghcr.io/pdp-connect/connector-catalog:latest > "$RECOVERY_DIR/lookup.json"
DIGEST="$(node --input-type=module -e '
  import {readFileSync} from "node:fs";
  const x = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (x.outcome !== "present" || !/^sha256:[0-9a-f]{64}$/.test(x.digest)) process.exit(1);
  console.log(x.digest);
' "$RECOVERY_DIR/lookup.json")"
for bundle_format in true false; do
  cosign verify "ghcr.io/pdp-connect/connector-catalog@${DIGEST}" \
    --new-bundle-format="$bundle_format" \
    --certificate-identity 'https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
done
oras pull "ghcr.io/pdp-connect/connector-catalog@${DIGEST}" --output "$RECOVERY_DIR/pulled"
# Refuse if a writer outside the workflow's concurrency group moved latest while
# recovering. This is a check, not a transactional lock on GHCR.
LOOKUP_USERNAME="$GITHUB_ACTOR" LOOKUP_PASSWORD="$GH_TOKEN" \
  node "${GITHUB_WORKSPACE}/scripts/lookup-manifest.mjs" \
  --reference ghcr.io/pdp-connect/connector-catalog:latest > "$RECOVERY_DIR/recheck.json"
node --input-type=module -e '
  import {readFileSync} from "node:fs";
  const x = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (x.outcome !== "present" || x.digest !== process.argv[2]) process.exit(1);
' "$RECOVERY_DIR/recheck.json" "$DIGEST"
# latest already names these verified bytes. Never regenerate or sign a different
# catalog merely to repair the missing declaration.
node "${GITHUB_WORKSPACE}/scripts/websub-publisher/declare-catalog-ready.mjs" \
  --digest "$DIGEST" --catalog "$RECOVERY_DIR/pulled/catalog.json"
