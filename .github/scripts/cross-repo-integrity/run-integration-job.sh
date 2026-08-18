#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Integration job (finding B2's "acceptable transitional mechanism" / finding B5's cutover
# mechanism): run connectors/github/index.test.ts from THIS repo's connector content against
# the REAL reference-implementation server, and typecheck bin/orchestrate.ts in that same
# combined context.
#
# Why this is possible without vendoring the RI server: connectors/github/index.test.ts and
# bin/orchestrate.ts import reference-implementation/server/* via relative paths
# (`../../../../reference-implementation/server/db.ts`, etc.), which resolve correctly once
# this repo's packages/polyfill-connectors is placed as a sibling of pdpp's
# reference-implementation/ — the exact layout pdpp itself has pre-move. So instead of
# vendoring RI server code (rejected in the Gate B2 closure report as "a different undertaking
# in kind, not degree"), this job assembles that sibling layout directly: check out pdpp at
# the pinned SHA, then REPLACE its packages/polyfill-connectors with this repo's canonical
# copy, then run pdpp's own reference-implementation and this repo's test/typecheck commands
# unmodified inside that combined tree.
#
# This also satisfies records.ts's OWN relative import of
# ../../packages/polyfill-connectors/src/local-source-inventory.ts (pdpp's transitional
# pre-move copy of polyfill-connectors) — the substitution supplies exactly that sibling path,
# using data-connectors' canonical content instead of pdpp's stale copy, which is the point of
# the drift jobs' connector-source comparison (job b) staying green.
#
# Usage:
#   run-integration-job.sh <pdpp-checkout> <data-connectors-checkout> <workdir>
#
# Requires: pdpp's own dependencies already installed (pdpp is a large pnpm monorepo with
# workspace:* deps and native builds — `pnpm install` at the pdpp root, not repeated here).
# In CI this cost is paid once via a cached pnpm install step; see the workflow.
set -euo pipefail

PDPP_DIR="${1:?usage: run-integration-job.sh <pdpp-checkout> <data-connectors-checkout> <workdir>}"
DATA_CONNECTORS_DIR="${2:?usage: run-integration-job.sh <pdpp-checkout> <data-connectors-checkout> <workdir>}"
WORKDIR="${3:?usage: run-integration-job.sh <pdpp-checkout> <data-connectors-checkout> <workdir>}"

COMBINED="$WORKDIR/pdpp-combined"
rm -rf "$COMBINED"
mkdir -p "$COMBINED"

echo "== Assembling combined tree: pdpp @ pinned SHA + data-connectors' canonical polyfill-connectors =="

# Symlink everything from the pdpp checkout except packages/, so pdpp's node_modules,
# reference-implementation/, and every other workspace package resolve unchanged.
(
  cd "$PDPP_DIR"
  shopt -s dotglob
  for entry in *; do
    [[ "$entry" == "packages" ]] && continue
    ln -s "$PDPP_DIR/$entry" "$COMBINED/$entry"
  done
)

mkdir -p "$COMBINED/packages"
(
  cd "$PDPP_DIR/packages"
  for pkg in *; do
    [[ "$pkg" == "polyfill-connectors" ]] && continue
    ln -s "$PDPP_DIR/packages/$pkg" "$COMBINED/packages/$pkg"
  done
)

# Copy (not symlink) so this step can add a scratch tsconfig without touching either checkout.
cp -a "$DATA_CONNECTORS_DIR/packages/polyfill-connectors" "$COMBINED/packages/polyfill-connectors"

POLYFILL_DIR="$COMBINED/packages/polyfill-connectors"

if [[ ! -d "$POLYFILL_DIR/node_modules" ]]; then
  echo "FAIL: $POLYFILL_DIR/node_modules missing — install data-connectors' own dependencies before running this job (npm ci --ignore-scripts inside packages/polyfill-connectors)."
  exit 1
fi

echo
echo "== Typechecking reference-implementation (sanity: does the substitution break anything upstream?) =="
(cd "$COMBINED/reference-implementation" && npx tsc --noEmit)
echo "OK: reference-implementation typechecks against the substituted polyfill-connectors."

echo
echo "== Typechecking polyfill-connectors INCLUDING connectors/github/index.test.ts and bin/orchestrate.ts =="
cat > "$POLYFILL_DIR/tsconfig.integration.json" <<'EOF'
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "fixtures", "**/__fixtures__"]
}
EOF
(cd "$POLYFILL_DIR" && npx tsc -p tsconfig.integration.json --noEmit)
echo "OK: connectors/github/index.test.ts and bin/orchestrate.ts typecheck against the real reference-implementation server."

echo
echo "== Running connectors/github/index.test.ts against the real reference-implementation (initDb/getDb/closeDb, ingestRecord, drainConnectorInstanceIndexWork) =="
(cd "$POLYFILL_DIR" && node --test --import tsx --test-concurrency=1 --test-timeout=60000 connectors/github/index.test.ts)
echo "OK: connectors/github/index.test.ts passed against the real reference-implementation."

echo
echo "== bin/orchestrate.ts: typecheck proven above; full 'run <connector>' end-to-end needs live connector credentials =="
echo "TODO (not run here — requires real, non-fixture credentials for a real provider; do not wire secrets into this job without an explicit decision on which connector and where its credentials come from):"
echo "  cd $POLYFILL_DIR"
echo "  node --import tsx bin/orchestrate.ts run <connector>   # e.g. ynab, gmail, chatgpt, usaa, amazon — see bin/orchestrate.ts usage"
echo "  # Confirm the printed per-stream record-count verification summary is non-zero/expected, then:"
echo "  node --import tsx bin/orchestrate.ts query <stream>    # against the still-running embedded server from the same process"
echo
echo "Verified manually in this task (2026-08-17): 'run ynab' boots the embedded AS/RS, reconciles all 20 first-party manifests, and reaches the credential-exchange step before requiring real YNAB OAuth credentials this sandbox does not have. Typecheck and process boot are proven; the credentialed data-landing step is not, and should not be until a CI secret is deliberately provisioned for it."
