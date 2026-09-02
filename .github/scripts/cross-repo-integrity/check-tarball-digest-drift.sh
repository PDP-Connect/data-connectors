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
# the data-connect workspace so sibling deps resolve). Also rebuilds both packages' 1.0.0
# release-boundary artifacts from a SEPARATE, later data-connect checkout (pinned to
# cross-repo-pins.json's "data-connect-1-0-0" SHA — see that entry for why it must differ from
# the SHA above) by reproducing the release pipeline's lockstep version bump (see pdpp's
# vendor/README.md "Current 1.0.0 release-boundary pins") and packing that too, since pdpp's
# own vendor/SHA256SUMS records 1.0.0 tarballs that this repo's own (still-0.0.1) vendor pin
# does not. Compares the resulting SHA-256 digests against:
#   - this repo's packages/polyfill-connectors/vendor/SHA256SUMS
#   - pdpp's vendor/SHA256SUMS (if a pdpp checkout is provided)
#
# @pdpp/reference-contract is NOT covered here: it is a hand-maintained minimal stand-in, not
# a tarball packed from data-connect. Its provenance is checked by
# check-reference-contract-drift.mjs (drift job d).
#
# Usage:
#   check-tarball-digest-drift.sh <data-connect-checkout> <data-connectors-checkout> [pdpp-checkout] [data-connect-1-0-0-checkout]
set -euo pipefail

DATA_CONNECT_DIR="${1:?usage: check-tarball-digest-drift.sh <data-connect-checkout> <data-connectors-checkout> [pdpp-checkout] [data-connect-1-0-0-checkout]}"
DATA_CONNECTORS_DIR="${2:?usage: check-tarball-digest-drift.sh <data-connect-checkout> <data-connectors-checkout> [pdpp-checkout] [data-connect-1-0-0-checkout]}"
PDPP_DIR="${3:-}"
DATA_CONNECT_1_0_0_DIR="${4:-}"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
FRESH_CACHE="$WORKDIR/npm-cache"
mkdir -p "$FRESH_CACHE"

# Neither collector-runtime nor connector-protocol declares `typescript` as its own
# devDependency — it's hoisted from the data-connect workspace ROOT's devDependencies,
# which a -w-scoped install deliberately doesn't pull in (that would drag in the whole
# app: vite, tailwind, vitest, a git-sourced dep, ...). Each package's `build` script
# shells out to `npx tsc`, so without a resolvable `tsc` binary, npx silently
# auto-installs and runs the unrelated npm package literally named `tsc` instead of the
# TypeScript compiler.
#
# This MUST run and land on PATH before the workspace install below, not after: on
# npm 10.x (what Node 22, this job's pinned version, ships — confirmed by reproducing
# locally under nvm's 22.23.2/npm 10.9.8, where npm 12 did not show this), `--ignore-scripts`
# does not suppress a workspace package's own `prepare` lifecycle hook the way it does on
# npm 12 — connector-protocol's `"prepare": "npm run build"` fires DURING `npm install -w
# ...` itself, before this script ever reaches its own build loop. Installing typescript
# into an isolated scratch package (not data-connect's own tree) sidesteps its git-sourced
# root dependency and keeps this job's install narrow.
echo "== Installing typescript into an isolated scratch dir (data-connect's own root devDependency) =="
TSC_SHIM="$WORKDIR/tsc-shim"
mkdir -p "$TSC_SHIM"
TSC_VERSION="$(node -p 'require(require("path").resolve(process.argv[1], "package.json")).devDependencies.typescript' "$DATA_CONNECT_DIR")"
(
  cd "$TSC_SHIM"
  npm init -y > /dev/null
  npm install --cache "$FRESH_CACHE" --no-audit --no-fund --no-save "typescript@$TSC_VERSION"
)
if [[ ! -x "$TSC_SHIM/node_modules/.bin/tsc" ]]; then
  echo "FAIL: typescript shim install did not produce an executable tsc at $TSC_SHIM/node_modules/.bin/tsc" >&2
  ls -la "$TSC_SHIM/node_modules/.bin/" >&2 || echo "(node_modules/.bin does not exist)" >&2
  exit 1
fi
export PATH="$TSC_SHIM/node_modules/.bin:$PATH"
echo "== typescript shim ready: $(command -v tsc) ($("$TSC_SHIM/node_modules/.bin/tsc" --version)) =="

# --ignore-scripts does not suppress a -w-targeted workspace's OWN `prepare` script on
# npm 10.x (confirmed via a minimal repro: a workspace with a `prepare` script that
# writes a sentinel runs it despite --ignore-scripts, npm 10.9.8 — a real npm defect for
# this exact case, not this script's own bug). Both packages here declare `"prepare":
# "npm run build"`, and running that mid-install — before npm has finished creating the
# OTHER workspace's node_modules/@pdpp/* symlink — produces a broken, half-typechecked
# dist/ for whichever package installs second, which the drift check would then compare
# against a tarball packed from that same broken dist/ (self-consistent, silently wrong).
# Work around it by neutralizing each package's prepare script for the duration of this
# install only, then restoring the original file with git checkout before packing — the
# packed tarball must contain the SAME package.json data-connect actually ships, or its
# digest won't mean anything.
echo "== Temporarily neutralizing prepare scripts (npm 10.x --ignore-scripts gap for -w installs) =="
node -e '
const fs = require("node:fs");
const path = require("node:path");
for (const pkg of ["collector-runtime", "connector-protocol"]) {
  const pkgJsonPath = path.join(process.argv[1], "packages", pkg, "package.json");
  const data = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  if (data.scripts?.prepare) {
    data.scripts.prepare = "true";
    fs.writeFileSync(pkgJsonPath, JSON.stringify(data, null, 2) + "\n");
  }
}
' "$DATA_CONNECT_DIR"

echo "== Installing data-connect's collector-runtime + connector-protocol workspaces (fresh cache) =="
(
  cd "$DATA_CONNECT_DIR"
  npm install \
    --cache "$FRESH_CACHE" \
    --ignore-scripts \
    --no-audit --no-fund \
    -w packages/collector-runtime -w packages/connector-protocol
)

echo "== Restoring package.json (undoing the prepare neutralization) =="
(
  cd "$DATA_CONNECT_DIR"
  git checkout -- packages/collector-runtime/package.json packages/connector-protocol/package.json
)

REPACK_OUT="$WORKDIR/repack-out"
mkdir -p "$REPACK_OUT"

# Copy the shimmed typescript straight into each package's OWN node_modules instead of
# relying on PATH: npx's local-node_modules/.bin lookup is unconditional (checked first,
# every time), whereas PATH-based resolution proved unreliable in this exact job on the
# hosted GitHub Actions runner even though every element of it (the shim itself, the
# PATH export, the inline PATH= prefix on `npm run build`) reproduced correctly across
# multiple fresh local clones under the identical npm 10.9.8 — never narrowed down beyond
# "works locally, not on the runner". Not committed anywhere; each package's node_modules
# lives only in this ephemeral $WORKDIR-adjacent checkout.
for pkg in connector-protocol collector-runtime; do
  mkdir -p "$DATA_CONNECT_DIR/packages/$pkg/node_modules/.bin"
  cp -r "$TSC_SHIM/node_modules/typescript" "$DATA_CONNECT_DIR/packages/$pkg/node_modules/typescript"
  ln -sf ../typescript/bin/tsc "$DATA_CONNECT_DIR/packages/$pkg/node_modules/.bin/tsc"
done

# connector-protocol first: collector-runtime imports its compiled type declarations, so
# building collector-runtime before connector-protocol's dist/ exists fails typecheck.
for pkg in connector-protocol collector-runtime; do
  echo "== Building + packing @pdpp/$pkg from data-connect @ pinned SHA =="
  (
    cd "$DATA_CONNECT_DIR/packages/$pkg"
    npm run build
    npm pack --pack-destination "$REPACK_OUT"
  )
done

# pdpp's vendor/SHA256SUMS additionally records 1.0.0 tarballs (see pdpp's vendor/README.md
# "Current 1.0.0 release-boundary pins"), packed from a LATER data-connect commit than the
# 0.0.1 pin above (cross-repo-pins.json's "data-connect-1-0-0" entry explains why these two
# pins must differ). data-connect's `.releaserc.yaml` semantic-release pipeline publishes both
# packages in lockstep from a single computed `nextRelease.version`, applying exactly two
# mutations before packing — no registry, no other source changes:
#   1. `scripts/pin-collector-runtime-protocol-dependency.ts <version>` (the pipeline's
#      `prepareCmd` step, run first): rewrites collector-runtime's committed
#      `@pdpp/connector-protocol` dependency (a local-install floor, "0.0.1") to the release
#      version, since @semantic-release/npm's own prepare step only bumps each pkgRoot's OWN
#      `version` field and never touches a sibling's `dependencies`.
#   2. `npm version <version> --no-git-tag-version --allow-same-version` in each package (what
#      @semantic-release/npm's prepare step itself runs).
# Reproduce that here, in the SEPARATE data-connect-1-0-0 checkout, then repack.
if [[ -n "$DATA_CONNECT_1_0_0_DIR" ]]; then
  PDPP_1_0_0_PIN_SCRIPT="$DATA_CONNECT_1_0_0_DIR/scripts/pin-collector-runtime-protocol-dependency.ts"
  if [[ ! -f "$PDPP_1_0_0_PIN_SCRIPT" ]]; then
    echo "WARN: $PDPP_1_0_0_PIN_SCRIPT not found — cannot reproduce the 1.0.0 release-pipeline version bump at this data-connect-1-0-0 pin. Any 1.0.0 entries in a SHA256SUMS file below will correctly FAIL as unproduced." >&2
  else
    echo "== Installing typescript into an isolated scratch dir (data-connect-1-0-0's own root devDependency) =="
    TSC_SHIM_1_0_0="$WORKDIR/tsc-shim-1-0-0"
    mkdir -p "$TSC_SHIM_1_0_0"
    TSC_VERSION_1_0_0="$(node -p 'require(require("path").resolve(process.argv[1], "package.json")).devDependencies.typescript' "$DATA_CONNECT_1_0_0_DIR")"
    (
      cd "$TSC_SHIM_1_0_0"
      npm init -y > /dev/null
      npm install --cache "$FRESH_CACHE" --no-audit --no-fund --no-save "typescript@$TSC_VERSION_1_0_0"
    )

    echo "== Temporarily neutralizing prepare scripts (npm 10.x --ignore-scripts gap for -w installs) =="
    node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    for (const pkg of ["collector-runtime", "connector-protocol"]) {
      const pkgJsonPath = path.join(process.argv[1], "packages", pkg, "package.json");
      const data = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      if (data.scripts?.prepare) {
        data.scripts.prepare = "true";
        fs.writeFileSync(pkgJsonPath, JSON.stringify(data, null, 2) + "\n");
      }
    }
    ' "$DATA_CONNECT_1_0_0_DIR"

    echo "== Installing data-connect-1-0-0's collector-runtime + connector-protocol workspaces (fresh cache) =="
    (
      cd "$DATA_CONNECT_1_0_0_DIR"
      npm install \
        --cache "$FRESH_CACHE" \
        --ignore-scripts \
        --no-audit --no-fund \
        -w packages/collector-runtime -w packages/connector-protocol
    )

    echo "== Restoring package.json (undoing the prepare neutralization) =="
    (
      cd "$DATA_CONNECT_1_0_0_DIR"
      git checkout -- packages/collector-runtime/package.json packages/connector-protocol/package.json
    )

    for pkg in connector-protocol collector-runtime; do
      mkdir -p "$DATA_CONNECT_1_0_0_DIR/packages/$pkg/node_modules/.bin"
      cp -r "$TSC_SHIM_1_0_0/node_modules/typescript" "$DATA_CONNECT_1_0_0_DIR/packages/$pkg/node_modules/typescript"
      ln -sf ../typescript/bin/tsc "$DATA_CONNECT_1_0_0_DIR/packages/$pkg/node_modules/.bin/tsc"
    done

    echo "== Reproducing the release-pipeline version bump (1.0.0) for @pdpp/collector-runtime + @pdpp/connector-protocol =="
    (
      cd "$DATA_CONNECT_1_0_0_DIR"
      node --experimental-strip-types scripts/pin-collector-runtime-protocol-dependency.ts 1.0.0
    )
    for pkg in connector-protocol collector-runtime; do
      (
        cd "$DATA_CONNECT_1_0_0_DIR/packages/$pkg"
        npm version 1.0.0 --no-git-tag-version --allow-same-version --ignore-scripts
      )
    done

    for pkg in connector-protocol collector-runtime; do
      echo "== Building + packing @pdpp/$pkg @ 1.0.0 from data-connect-1-0-0 @ pinned SHA =="
      (
        cd "$DATA_CONNECT_1_0_0_DIR/packages/$pkg"
        npm run build
        npm pack --pack-destination "$REPACK_OUT"
      )
    done

    echo "== Restoring package.json (undoing the 1.0.0 version bump) =="
    (
      cd "$DATA_CONNECT_1_0_0_DIR"
      git checkout -- packages/collector-runtime/package.json packages/connector-protocol/package.json
    )
  fi
else
  echo "SKIP: no data-connect-1-0-0 checkout provided — cannot reproduce a 1.0.0 repack. Any 1.0.0 entries in a SHA256SUMS file below will FAIL as unproduced."
fi

echo
echo "== Freshly packed digests =="
(cd "$REPACK_OUT" && sha256sum ./*.tgz)

FAILED=0

# Why content-manifest comparison instead of raw tarball digest equality:
#
# `npm pack` output is NOT byte-reproducible across npm versions for identical package
# contents — the gzip layer and tar/pack metadata (e.g. mtimes, header padding, gzip
# compression-level/OS-byte defaults) vary between npm releases even when every file inside
# is byte-for-byte the same. The tarballs committed under vendor/ here were packed locally
# with a different npm than this CI job's pinned Node/npm, so comparing raw sha256sum of the
# .tgz files is comparing packer-metadata noise, not the thing we actually care about.
#
# The real invariant is CONTENT identity: does the fresh repack from the pinned data-connect
# SHA contain the exact same files with the exact same bytes as the committed tarball? So
# instead of hashing the .tgz as a blob, extract both tarballs and compare a sorted manifest
# of per-file sha256 over their extracted contents. This is portable across npm/tar versions
# by construction and gives a useful per-file diff on failure instead of one opaque digest
# mismatch.
#
# vendor/SHA256SUMS is NOT redundant with this: it stays as the provenance record attesting
# to the exact committed artifact bytes (what was actually vendored, sha256'd at commit
# time) — a fixed reference for "is the file in this repo still the file we vendored, bit for
# bit". This check answers a different question: "does that committed artifact's CONTENT
# still match what data-connect's pinned SHA produces today", independent of which npm
# version did the packing on either side.
# Per reviewer hardening finding "safely inspect tarballs before extraction"
# (2026-08-18 final-v2 red-team): both operands here can be PR-controlled (the "committed"
# tarball is read straight from the checkout being tested, which is exactly the untrusted
# input a malicious PR could replace) and this workflow has no secrets to protect, but a
# malformed archive can still attack the ephemeral runner (path traversal writing outside
# $dest, absolute-path overwrite, symlink/hardlink/device-node tricks, a decompression-bomb
# member) or make this required check unreliable. Inspect every member's path/type/size with
# `tar -tvzf` BEFORE any extraction, rejecting anything that isn't a plain file or directory
# at a safe relative path, then extract with restrictive options as defense in depth.
MAX_MEMBER_BYTES=$((256 * 1024 * 1024))

preflight_tarball() {
  local tarball="$1"
  local listing
  listing="$(tar -tvzf "$tarball")"

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue

    local type_char="${line:0:1}"
    # GNU tar -tv format: "<perms> <owner>/<group> <size> <date> <time> <path>[ -> <link target>]"
    local size
    size="$(awk '{print $3}' <<<"$line")"
    local path
    path="$(awk '{ for (i=6; i<NF; i++) printf "%s ", $i; print $NF }' <<<"$line")"
    path="${path%% -> *}"

    case "$type_char" in
      d) ;; # directory
      -) ;; # regular file
      *)
        echo "FAIL: $tarball — member '$path' has disallowed type '$type_char' (only regular files and directories are allowed; no symlinks, hardlinks, or device/special files)" >&2
        return 1
        ;;
    esac

    if [[ "$path" == /* ]]; then
      echo "FAIL: $tarball — member '$path' has an absolute path" >&2
      return 1
    fi
    if [[ "$path" == *".."* ]]; then
      echo "FAIL: $tarball — member '$path' contains a '..' path segment" >&2
      return 1
    fi
    if [[ "$size" =~ ^[0-9]+$ ]] && (( size > MAX_MEMBER_BYTES )); then
      echo "FAIL: $tarball — member '$path' is $size bytes, exceeding the $MAX_MEMBER_BYTES-byte preflight limit" >&2
      return 1
    fi
  done <<<"$listing"
}

extracted_manifest() {
  local tarball="$1"
  local dest="$2"
  mkdir -p "$dest"
  if ! preflight_tarball "$tarball"; then
    echo "FAIL: $tarball failed archive preflight validation — refusing to extract" >&2
    return 1
  fi
  tar -xzf "$tarball" -C "$dest" --no-same-owner --no-same-permissions --no-overwrite-dir
  ( cd "$dest" && find . -type f -print0 | sort -z | xargs -0 sha256sum )
}

check_against_sumfile() {
  local label="$1"
  local sumfile="$2"

  if [[ ! -f "$sumfile" ]]; then
    echo "FAIL: $label — SHA256SUMS not found at $sumfile"
    FAILED=1
    return
  fi

  local sumfile_dir
  sumfile_dir="$(dirname "$sumfile")"

  while IFS= read -r line; do
    local tarball_name
    tarball_name="$(awk '{print $2}' <<<"$line")"
    tarball_name="$(basename "$tarball_name")"

    # reference-contract is not produced by this job; skip it here.
    [[ "$tarball_name" == pdpp-reference-contract-*.tgz ]] && continue

    local fresh_tarball="$REPACK_OUT/$tarball_name"
    local committed_tarball="$sumfile_dir/$tarball_name"

    if [[ ! -f "$fresh_tarball" ]]; then
      echo "FAIL: $label — $tarball_name is recorded in $sumfile but was not produced by a fresh repack"
      FAILED=1
      continue
    fi
    if [[ ! -f "$committed_tarball" ]]; then
      echo "FAIL: $label — $tarball_name is recorded in $sumfile but not present at $committed_tarball"
      FAILED=1
      continue
    fi

    local committed_extract_dir="$WORKDIR/extract/$label-committed-$tarball_name"
    local fresh_extract_dir="$WORKDIR/extract/$label-fresh-$tarball_name"
    local committed_manifest="$WORKDIR/manifest-$label-committed-$tarball_name.txt"
    local fresh_manifest="$WORKDIR/manifest-$label-fresh-$tarball_name.txt"

    extracted_manifest "$committed_tarball" "$committed_extract_dir" > "$committed_manifest"
    extracted_manifest "$fresh_tarball" "$fresh_extract_dir" > "$fresh_manifest"

    if ! diff -u "$committed_manifest" "$fresh_manifest" > "$WORKDIR/manifest-diff-$label-$tarball_name.txt"; then
      echo "FAIL: $label — $tarball_name content manifest mismatch (committed vs fresh repack)"
      echo "  committed tarball:  $committed_tarball"
      echo "  fresh repack:       $fresh_tarball"
      echo "  per-file diff (path sha256sum format, committed vs fresh):"
      sed 's/^/    /' "$WORKDIR/manifest-diff-$label-$tarball_name.txt"
      FAILED=1
    else
      echo "OK: $label — $tarball_name content matches fresh repack (per-file sha256 manifest identical)"
    fi
  done < "$sumfile"
}

check_against_sumfile "data-connectors" "$DATA_CONNECTORS_DIR/packages/polyfill-connectors/vendor/SHA256SUMS"

if [[ -n "$PDPP_DIR" ]]; then
  check_against_sumfile "pdpp" "$PDPP_DIR/vendor/SHA256SUMS"
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
