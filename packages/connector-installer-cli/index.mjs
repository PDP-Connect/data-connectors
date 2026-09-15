#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0


import {
  generateLock,
  installFromLock,
  loadConnectorIndex,
  lockNeedsIndexSource,
  parseConnectorOciReference,
  readJson,
  verifyInstalled,
  checkForUpdates,
} from "../connector-installer-core/index.mjs";

function usage() {
  console.error(`Usage:
  connector-installer lock --dependencies <path> [--lock <path>] [--index-url <url>] [--from-local <dir>]
  connector-installer install --lock <path> --install-root <dir> --layout <snapshot|source> [--index-url <url>] [--from-local <dir>] [--prune]
  connector-installer install --oci <ref> --connector-id <id> --install-root <dir> --layout <snapshot|source> [--prune]
  connector-installer verify --lock <path> --install-root <dir> --layout <snapshot|source> [--index-url <url>] [--from-local <dir>]
  connector-installer verify --oci <ref> --connector-id <id> --install-root <dir> --layout <snapshot|source>
  connector-installer updates --lock <path> [--index-url <url>] [--from-local <dir>]

An <ref> is ghcr.io/pdp-connect/connector/<key>@sha256:<digest> or
ghcr.io/pdp-connect/connector/<key>:<version>. Prefer the digest form: a
version tag is resolved once and what it resolves to can change, so only a
digest names the same bytes on every run.`);
}

/**
 * Build a one-entry lock from an OCI reference given on the command line.
 *
 * The CLI does not get a second install path. A reference is turned into the
 * same lock entry shape the file would have held and handed to the same
 * `installFromLock`, so a one-off pull and a locked install go through
 * identical verification — there is no "quick" route that checks less.
 */
function lockFromOciReference(options) {
  const reference = parseConnectorOciReference(options.oci);
  const connectorId = options.connectorId ?? `${reference.connectorKey}-pdpp`;
  return {
    lockVersion: "2.0",
    connectors: [
      {
        connectorId,
        connectorKey: reference.connectorKey,
        version: options.version ?? reference.version ?? null,
        artifactKind: "pdpp-collection-profile",
        manifestPath: "profile/collection-profile.json",
        entrypointPath: "dist/collection-profile.mjs",
        provenancePath: "provenance.json",
        oci: {
          registry: reference.registry,
          repository: reference.repository,
          digest: reference.digest,
        },
      },
    ],
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--prune") {
      options.prune = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) =>
      letter.toUpperCase()
    );
    options[key] = rest[i + 1] ?? null;
    i += 1;
  }

  return options;
}

async function loadIndexSource(options) {
  return loadConnectorIndex({
    fromLocal: options.fromLocal ?? null,
    indexUrl: options.indexUrl ?? null,
  });
}

/**
 * The lock to operate on, and the index source it actually requires.
 *
 * The index is loaded because an ENTRY needs it, never because of which flag
 * was typed. A lock whose entries are all digest-pinned OCI references resolves
 * to `source: null` and the index service is not contacted at all — so a pinned
 * install keeps working when that service is down, which is the point of
 * pinning. A lock naming any tarball entry still loads it, once, for those
 * entries.
 */
async function resolveLockAndSource(options) {
  const lock = options.oci ? lockFromOciReference(options) : readJson(options.lock);
  const source = lockNeedsIndexSource(lock) ? await loadIndexSource(options) : null;
  return { lock, source };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.command) {
    usage();
    process.exit(1);
  }

  if (options.command === "lock") {
    if (!(options.dependencies && options.lock)) {
      usage();
      process.exit(1);
    }

    const dependencies = readJson(options.dependencies);
    const source = await loadIndexSource(options);
    const lock = await generateLock({
      dependencies,
      source,
      dependencyFile: options.dependencies,
    });
    process.stdout.write(`${JSON.stringify(lock, null, 2)}\n`);
    return;
  }

  if (options.command === "install") {
    if (!((options.lock || options.oci) && options.installRoot && options.layout)) {
      usage();
      process.exit(1);
    }

    const { lock, source } = await resolveLockAndSource(options);
    const result = await installFromLock({
      lock,
      source,
      installRoot: options.installRoot,
      layout: options.layout,
      prune: Boolean(options.prune),
      // Only a reference typed on the command line may have its tag resolved,
      // and only because that is what a first pin IS. A lock entry is refused
      // unless it already carries a digest (C1.2, C2.3).
      allowTagResolution: Boolean(options.oci),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (options.command === "verify") {
    if (!((options.lock || options.oci) && options.installRoot && options.layout)) {
      usage();
      process.exit(1);
    }

    const { lock, source } = await resolveLockAndSource(options);
    // `verify` deliberately does NOT opt into tag resolution, even for a
    // command-line reference. Verifying is a question about what is installed;
    // answering it by resolving a tag would compare the tree against whatever
    // that tag means now rather than against what was pinned.
    const result = await verifyInstalled({
      lock,
      source,
      installRoot: options.installRoot,
      layout: options.layout,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    // A mismatch is a failed check, so it must be a failed PROCESS: this command
    // is meant to be usable as a gate, and a gate that exits 0 on `ok:false`
    // reports every tampered tree as a pass to whatever runs it.
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (options.command === "updates") {
    if (!options.lock) {
      usage();
      process.exit(1);
    }

    const lock = readJson(options.lock);
    const source = await loadIndexSource(options);
    const result = await checkForUpdates({
      lock,
      indexDoc: source.doc,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  usage();
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
