# @pdpp/connector-manager

The client that resolves connector artifacts from an index, verifies their
Sigstore bundles and digests, pins the result in a lock file, and installs the
verified bytes into a caller-chosen root.

It carries no connector content. Connector bytes come from the artifact
source; this package is the client that fetches, verifies and pins them.

## What this package does today

This is the existing GitHub Releases installer, extracted unchanged so it can
ship on its own release cadence. It is the seed of the connector manager, not
the finished one, and the scope below is the whole of it.

It reads a signed `connector-index.json`, fetches the tarball each entry names,
verifies a Sigstore bundle over it, and unpacks it.

It does **not** consume the OCI artifacts this PR's workflow publishes. There
is no OCI descriptor resolution, no registry blob retrieval, and no support for
the five-layer install layout the builder produces. Those artifacts are
published so the format can be exercised; nothing installs them through this
package yet. Until that lands, the artifacts and this installer are two
separate paths, and the registry one has no consumer.

Consumers that vendor their own copy of a connector should keep doing so,
including whatever checks guard those copies. Nothing here replaces them until
a consumer has actually installed and run a connector through this package.

## Choosing which signer to trust

Nothing here hard-codes a single publisher as policy. The PDP-Connect release
workflow identity is the *default*, exposed as a constant, and the caller may
substitute its own:

```js
import {
  loadConnectorIndex,
  generateLock,
  installFromLock,
  verifyInstalled,
} from "@pdpp/connector-manager";

const source = await loadConnectorIndex({
  indexUrl,
  indexCertificateIdentityResolver: () => theirReleaseWorkflowIdentity,
});
const lock = await generateLock({ dependencies, source });
await installFromLock({ lock, source, installRoot, layout: "snapshot" });
await verifyInstalled({ lock, source, installRoot, layout: "snapshot" });
```

Two signatures are checked on the remote path, and each has its own seam:

- `indexCertificateIdentityResolver` decides which signer may sign the
  **index**. It receives `{ indexUrl }`.
- `artifactCertificateIdentityResolver` decides which signer may sign a given
  **artifact**. It receives `{ artifactUrl, entry }`.

Both default to the PDP-Connect release workflow identity, and both fail
closed: if a resolver returns no identity, the subject is rejected before any
signature is checked. Identity metadata supplied by the index itself is
ignored — an index cannot nominate its own signer.

Supplying only the artifact resolver is not enough to consume another
publisher's index. The two are checked separately and a third-party index needs
the index resolver as well.

The OIDC certificate *issuer* is pinned to GitHub Actions
(`DEFAULT_SIGSTORE_CERTIFICATE_ISSUER`) and is not caller-substitutable, so a
publisher signing through a non-GitHub identity provider is not supported
today. Signer identity is the seam that is open; issuer is not.

Unsigned remote indexes are not an escape hatch for any of this.
`allowUnsignedRemote` exists for local development and turns the check off
rather than redirecting it; it is not the way to consume a third party.

## Contract

- `loadConnectorIndex` — read an index from a URL or a local directory.
- `generateLock` — resolve declared dependencies to exact versions and digests.
- `installFromLock` — fetch, verify and unpack pinned artifacts.
- `verifyInstalled` — re-verify an existing install root against its lock.
- `checkForUpdates` — report newer versions available for a lock.
- `pruneInstalled` — remove entries an install root no longer expects.

Verification is not optional in any of these paths. A digest mismatch, an
unexpected archive member, a path escaping the install root, or an
unrecognised artifact kind all fail closed.

## Requirements

Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`, and a `tar` binary on `PATH` for
artifact unpacking.

This range is not a preference. It is the intersection of the engine ranges
declared by this package's entire production dependency closure: 16 of those
packages, including `sigstore` and the `@sigstore/*` and npm-internal packages
it pulls in, refuse anything lower.

A narrower floor here would be a promise the install cannot keep. Node 20.11
and 22.16 satisfy this package's own code, but `npm install` on them fails on
`sigstore` regardless of what this manifest claims, so those runtimes are not
supported no matter how the range is written.

`scripts/manager-engines.test.mjs` recomputes the intersection from
`package-lock.json` and fails if the declared range and the closure disagree in
either direction, so a dependency bump that moves the floor cannot land quietly.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
