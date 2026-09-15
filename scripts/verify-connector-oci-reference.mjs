#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The consumer-side counterpart to `verify-connector-oci-artifact.mjs`.
//
// The publisher's verifier takes `--artifact <a directory the build script just
// wrote>`: it answers "did I build this correctly?" and it cannot answer
// anything else, because it never contacts a registry and performs no signature
// check at all. That is the right tool for a pre-push gate and the wrong one
// for every question asked after the push.
//
// This one takes a REFERENCE and answers the question a consumer actually has:
// would the installer accept what is published at these coordinates, right now?
// It runs the real consumer path — resolve, verify the cosign signature against
// the pinned identity, verify every layer digest, cross-check config against
// profile, unpack — and writes nothing to the install tree. So a green run here
// means an install would succeed for the same reason, rather than for a reason
// this script decided to approximate.
//
//   node scripts/verify-connector-oci-reference.mjs \
//     --reference ghcr.io/pdp-connect/connector/ynab@sha256:<digest>
//
// Exit 0 when the artifact verifies, 1 when it is refused, 2 on a usage error.
// The refusal's machine-readable `reason` is printed with it, because "could
// not find out" and "definitely bad" call for different responses from whoever
// is reading the output.

import { fetchResolvedArtifact, parseConnectorOciReference } from "../packages/connector-installer-core/index.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reference = args.reference;

  if (!reference || reference === true) {
    process.stderr.write(
      "usage: verify-connector-oci-reference.mjs --reference <registry>/<repository>@sha256:<digest>\n" +
        "                                          [--connector-id <id>] [--json]\n"
    );
    process.exit(2);
  }

  const parsed = parseConnectorOciReference(reference);
  if (!parsed.digest) {
    process.stderr.write(
      "usage: verify-connector-oci-reference.mjs --reference <registry>/<repository>@sha256:<digest>\n" +
        "                                          [--connector-id <id>] [--json]\n"
    );
    process.exit(2);
  }
  const connectorId = args.connectorId ?? `${parsed.connectorKey}-pdpp`;

  // The same lock-entry shape a real install uses, so this exercises the
  // consumer path rather than a parallel one written for verification.
  const entry = {
    connectorId,
    connectorKey: parsed.connectorKey,
    version: parsed.version ?? null,
    artifactKind: "pdpp-collection-profile",
    manifestPath: "profile/collection-profile.json",
    entrypointPath: "dist/collection-profile.mjs",
    provenancePath: "provenance.json",
    oci: {
      registry: parsed.registry,
      repository: parsed.repository,
      digest: parsed.digest,
    },
  };

  const artifact = await fetchResolvedArtifact(null, entry);

  const report = {
    reference,
    connectorId,
    connectorKey: parsed.connectorKey,
    version: artifact.manifest?.version ?? null,
    digest: artifact.oci.digest,
    configDigest: artifact.oci.configDigest,
    // What it was proven against, not what it was hoped to be.
    verifiedIdentity: artifact.oci.certificateIdentityURI,
    checksums: artifact.checksums,
    installedFiles: [
      entry.manifestPath,
      entry.entrypointPath,
      entry.provenancePath,
      ...artifact.assetFiles.map((file) => file.path),
    ],
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${reference}\n` +
        `  connector      ${report.connectorKey} -> ${report.connectorId}@${report.version}\n` +
        `  digest         ${report.digest}\n` +
        `  signed by      ${report.verifiedIdentity}\n` +
        `  installs       ${report.installedFiles.length} files\n`
    );
  }
}

main().catch((error) => {
  const reason = error?.reason ? ` [${error.reason}]` : "";
  console.error(`${error instanceof Error ? error.message : String(error)}${reason}`);
  process.exit(1);
});
