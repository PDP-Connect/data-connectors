#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift job (a): the local-collector definitions snapshot, cross-repository form.
 *
 * data-connect's `packages/local-collector/test/collector-definitions-snapshot-drift.test.ts`
 * is `test.skip`'d there because its generator
 * (`packages/local-collector/scripts/generate-collector-definitions-snapshot.ts`) imports
 * `packages/polyfill-connectors/src/collector-registry.ts`, which is Move A content and does
 * not exist in the data-connect repository. This script is that skipped test's cross-repo
 * form: it runs data-connect's own generator against THIS repo's canonical
 * `collector-registry.ts` and byte-compares the result against data-connect's checked-in
 * `src/generated/collector-definitions.generated.ts`.
 *
 * Usage:
 *   node check-collector-definitions-drift.mjs <data-connect-checkout> <data-connectors-checkout>
 *
 * Exit 0: the generated snapshot is byte-identical to data-connect's committed copy.
 * Exit 1: drift detected, or a structural precondition failed (missing generator/registry).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , dataConnectDir, dataConnectorsDir] = process.argv;

if (!dataConnectDir || !dataConnectorsDir) {
  console.error("usage: check-collector-definitions-drift.mjs <data-connect-checkout> <data-connectors-checkout>");
  process.exit(1);
}

const generatorPath = join(dataConnectDir, "packages/local-collector/scripts/generate-collector-definitions-snapshot.ts");
const committedSnapshotPath = join(dataConnectDir, "packages/local-collector/src/generated/collector-definitions.generated.ts");
const canonicalRegistryPath = join(dataConnectorsDir, "packages/polyfill-connectors/src/collector-registry.ts");

for (const [label, path] of [
  ["data-connect generator script", generatorPath],
  ["data-connect committed snapshot", committedSnapshotPath],
  ["data-connectors canonical collector-registry.ts", canonicalRegistryPath],
]) {
  if (!existsSync(path)) {
    console.error(`FAIL: ${label} not found at ${path}`);
    process.exit(1);
  }
}

// The generator resolves its source as "../polyfill-connectors/src/collector-registry.ts"
// relative to packages/local-collector, i.e. it expects a sibling packages/polyfill-connectors
// directory inside the SAME checkout. We run it in place against data-connect's own
// (duplicate, transitional) packages/polyfill-connectors/src/collector-registry.ts is NOT what
// we want to prove — we want to prove data-connect's generator against THIS repo's canonical
// registry. So we invoke it with an explicit output path and swap its import target via a
// scratch copy: copy data-connectors' canonical collector-registry.ts (and the connector
// definition modules it imports) into a scratch tree shaped like data-connect's workspace,
// then run the unmodified generator against that scratch tree.
const scratchRoot = mkdtempSync(join(tmpdir(), "collector-definitions-drift-"));
try {
  // Mirror data-connect's real layout: scripts/generate-collector-definitions-snapshot.ts
  // lives at packages/local-collector/scripts/, so its own packageDir (one level up from
  // scriptDir) resolves to packages/local-collector, and "../polyfill-connectors" from there
  // resolves to packages/polyfill-connectors — matching data-connect's actual sibling package
  // layout.
  const scratchLocalCollectorScripts = join(scratchRoot, "packages/local-collector/scripts");
  const scratchPolyfillConnectors = join(scratchRoot, "packages/polyfill-connectors");

  execFileSync("mkdir", ["-p", scratchLocalCollectorScripts, scratchPolyfillConnectors], { stdio: "inherit" });

  // The generator imports `isConnectorProtocolCapabilityArray` from
  // `@pdpp/connector-protocol` as a runtime value (data-connect PR #36 added the
  // protocol_capabilities validation loop below), not just as a type — so unlike the
  // LocalCollectorDefinition/LocalCollectorBinding type-only imports elsewhere in this
  // scratch tree, this one DOES need a real, resolvable package. Install it from
  // data-connectors' own vendored tarball: the same artifact drift job (c)
  // (check-tarball-digest-drift.sh) already verifies is a faithful repack of the pinned
  // data-connect commit, so trusting it here does not introduce a second, unverified
  // source of truth for the package's contents.
  const connectorProtocolTarball = join(
    dataConnectorsDir,
    "packages/polyfill-connectors/vendor/pdpp-connector-protocol-0.0.1.tgz",
  );
  if (!existsSync(connectorProtocolTarball)) {
    console.error(`FAIL: vendored @pdpp/connector-protocol tarball not found at ${connectorProtocolTarball}`);
    process.exit(1);
  }
  writeFileSync(
    join(scratchRoot, "package.json"),
    JSON.stringify({
      type: "module",
      dependencies: { "@pdpp/connector-protocol": `file:${connectorProtocolTarball}` },
    }),
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: scratchRoot,
    stdio: "inherit",
  });

  // Mirror only what the generator's import graph needs: collector-registry.ts and every
  // connector's collector-definition.ts it imports, preserving data-connectors' real directory
  // layout so relative imports inside collector-registry.ts resolve unchanged.
  execFileSync(
    "rsync",
    [
      "-a",
      "--include=*/",
      "--include=collector-registry.ts",
      "--include=collector-definition.ts",
      "--exclude=*",
      join(dataConnectorsDir, "packages/polyfill-connectors/") + "/",
      scratchPolyfillConnectors + "/",
    ],
    { stdio: "inherit" },
  );

  // Copy the whole scripts/ directory, not just the generator file: data-connect PR #36
  // split part of the generator into a sibling module (collector-definitions-literal.ts)
  // that it now imports by relative path. Copying the directory wholesale means a future
  // sibling split doesn't silently break this scratch tree again.
  const scratchGeneratorPath = join(scratchLocalCollectorScripts, "generate-collector-definitions-snapshot.ts");
  execFileSync("cp", ["-r", join(dataConnectDir, "packages/local-collector/scripts/") + "/.", scratchLocalCollectorScripts], {
    stdio: "inherit",
  });

  // @pdpp/connector-protocol is imported by collector-registry.ts and every
  // collector-definition.ts ONLY as `import type` (verified: both files import
  // LocalCollectorDefinition/LocalCollectorBinding as types only, never a value), so those
  // sites don't need the npm-installed package above. The generator script itself does need
  // it now (see the npm install above) for its runtime `isConnectorProtocolCapabilityArray`
  // check.
  const outputPath = join(scratchRoot, "generated-collector-definitions.ts");
  execFileSync(process.execPath, ["--experimental-strip-types", scratchGeneratorPath, outputPath], {
    stdio: "inherit",
    cwd: scratchLocalCollectorScripts,
  });

  const generated = readFileSync(outputPath, "utf8");
  const committed = readFileSync(committedSnapshotPath, "utf8");

  if (generated !== committed) {
    console.error("FAIL: collector-definitions snapshot drift detected.");
    console.error(`  data-connect committed: ${committedSnapshotPath}`);
    console.error(`  regenerated from data-connectors canonical collector-registry.ts: ${canonicalRegistryPath}`);
    console.error("  Run data-connect's generator against data-connectors' current collector-registry.ts and commit the result.");
    process.exit(1);
  }

  console.log("OK: collector-definitions snapshot matches the canonical collector-registry.ts.");
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}
