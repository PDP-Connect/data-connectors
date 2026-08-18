#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Drift job (c): vendored tarball digests in this repo's (and pdpp's) vendor/SHA256SUMS vs
# tarballs packed FRESH from data-connect at the pinned SHA.
#
# Rebuilds @pdpp/collector-runtime and @pdpp/connector-protocol from a data-connect checkout
# pinned to .github/cross-repo-pins.json's data-connect SHA, using the same method documented
# in packages/polyfill-connectors/vendor/README.md (npm run build, then npm pack, from inside
# the data-connect workspace so sibling deps resolve). Compares the resulting SHA-256 digests
# against:
#   - this repo's packages/polyfill-connectors/vendor/SHA256SUMS
#   - pdpp's vendor/SHA256SUMS (if a pdpp checkout is provided)
#
# @pdpp/reference-contract is NOT covered here: it is a hand-maintained minimal stand-in, not
# a tarball packed from data-connect. Its provenance is checked by
# check-reference-contract-drift.mjs (drift job d).
#
# Usage:
#   check-tarball-digest-drift.sh <data-connect-checkout> <data-connectors-checkout> [pdpp-checkout]
set -euo pipefail

DATA_CONNECT_DIR="${1:?usage: check-tarball-digest-drift.sh <data-connect-checkout> <data-connectors-checkout> [pdpp-checkout]}"
DATA_CONNECTORS_DIR="${2:?usage: check-tarball-digest-drift.sh <data-connect-checkout> <data-connectors-checkout> [pdpp-checkout]}"
PDPP_DIR="${3:-}"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "== Installing data-connect's collector-runtime + connector-protocol workspaces (fresh cache) =="
FRESH_CACHE="$WORKDIR/npm-cache"
mkdir -p "$FRESH_CACHE"
(
  cd "$DATA_CONNECT_DIR"
  npm install \
    --cache "$FRESH_CACHE" \
    --ignore-scripts \
    --no-audit --no-fund \
    -w packages/collector-runtime -w packages/connector-protocol
)

REPACK_OUT="$WORKDIR/repack-out"
mkdir -p "$REPACK_OUT"

for pkg in collector-runtime connector-protocol; do
  echo "== Building + packing @pdpp/$pkg from data-connect @ pinned SHA =="
  (
    cd "$DATA_CONNECT_DIR/packages/$pkg"
    npm run build
    npm pack --pack-destination "$REPACK_OUT"
  )
done

echo
echo "== Freshly packed digests =="
(cd "$REPACK_OUT" && sha256sum ./*.tgz)

FAILED=0

check_against_sumfile() {
  local label="$1"
  local sumfile="$2"
  local tarball_dir="$3"

  if [[ ! -f "$sumfile" ]]; then
    echo "FAIL: $label — SHA256SUMS not found at $sumfile"
    FAILED=1
    return
  fi

  while IFS= read -r line; do
    local recorded_hash tarball_name
    recorded_hash="$(awk '{print $1}' <<<"$line")"
    tarball_name="$(awk '{print $2}' <<<"$line")"
    tarball_name="$(basename "$tarball_name")"

    # reference-contract is not produced by this job; skip it here.
    [[ "$tarball_name" == pdpp-reference-contract-*.tgz ]] && continue

    local fresh_tarball="$REPACK_OUT/$tarball_name"
    if [[ ! -f "$fresh_tarball" ]]; then
      echo "FAIL: $label — $tarball_name is recorded in $sumfile but was not produced by a fresh repack"
      FAILED=1
      continue
    fi

    local fresh_hash
    fresh_hash="$(sha256sum "$fresh_tarball" | awk '{print $1}')"
    if [[ "$fresh_hash" != "$recorded_hash" ]]; then
      echo "FAIL: $label — $tarball_name digest mismatch"
      echo "  recorded:       $recorded_hash"
      echo "  fresh repack:   $fresh_hash"
      FAILED=1
    else
      echo "OK: $label — $tarball_name matches fresh repack ($fresh_hash)"
    fi
  done < "$sumfile"
}

check_against_sumfile "data-connectors" "$DATA_CONNECTORS_DIR/packages/polyfill-connectors/vendor/SHA256SUMS" "$DATA_CONNECTORS_DIR/packages/polyfill-connectors/vendor"

if [[ -n "$PDPP_DIR" ]]; then
  check_against_sumfile "pdpp" "$PDPP_DIR/vendor/SHA256SUMS" "$PDPP_DIR/vendor"
else
  echo "SKIP: no pdpp checkout provided — pdpp/vendor/SHA256SUMS not checked"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo
  echo "FAIL: tarball digest drift detected."
  exit 1
fi

echo
echo "OK: all recorded tarball digests match a fresh repack from the pinned data-connect SHA."
