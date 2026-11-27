#!/usr/bin/env bash

# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

# The Pages publisher holds the release/Pages concurrency group while this runs.
# Resolve and verify current latest; never treat a workflow event as authority.
set -euo pipefail
: "${GITHUB_WORKSPACE:?}" "${RUNNER_TEMP:?}" "${GITHUB_ACTOR:?}" "${GH_TOKEN:?}"
if [[ $# -ne 1 ]]; then
  echo "usage: materialize-catalog.sh OUTPUT" >&2
  exit 1
fi
OUTPUT="$1"
CATALOG_DIR="${RUNNER_TEMP}/pages-catalog"
mkdir -p "$CATALOG_DIR"
source "${GITHUB_WORKSPACE}/scripts/registry-command.sh"

lookup_latest() {
  LOOKUP_USERNAME="$GITHUB_ACTOR" LOOKUP_PASSWORD="$GH_TOKEN" \
    node "${GITHUB_WORKSPACE}/scripts/lookup-manifest.mjs" \
    --reference ghcr.io/pdp-connect/connector-catalog:latest
}
lookup_latest > "$CATALOG_DIR/lookup.json"
DIGEST="$(node --input-type=module -e '
  import {readFileSync} from "node:fs";
  const x = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (x.outcome !== "present" || !/^sha256:[0-9a-f]{64}$/.test(x.digest)) process.exit(1);
  console.log(x.digest);
' "$CATALOG_DIR/lookup.json")"

printf '%s' "$GH_TOKEN" | oras login ghcr.io --username "$GITHUB_ACTOR" --password-stdin
for bundle_format in true false; do
  cosign verify "ghcr.io/pdp-connect/connector-catalog@${DIGEST}" \
    --new-bundle-format="$bundle_format" \
    --certificate-identity 'https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
done
oras pull "ghcr.io/pdp-connect/connector-catalog@${DIGEST}" --output "$CATALOG_DIR/pulled"

# This detects an external writer, but cannot lock writers outside this workflow.
lookup_latest > "$CATALOG_DIR/recheck.json"
node --input-type=module -e '
  import {readFileSync} from "node:fs";
  const x = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (x.outcome !== "present" || x.digest !== process.argv[2]) process.exit(1);
' "$CATALOG_DIR/recheck.json" "$DIGEST"
node "${GITHUB_WORKSPACE}/scripts/websub-publisher/static-feed.mjs" \
  --catalog "$CATALOG_DIR/pulled/catalog.json" --digest "$DIGEST" --out "$OUTPUT"
