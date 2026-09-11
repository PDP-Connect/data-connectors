# @pdpp/connector-manager

Registry-neutral connector manager. It resolves connector artifacts from an
index, verifies their Sigstore bundles and digests, pins the result in a lock
file, and installs the verified bytes into a caller-chosen root.

It carries no connector content. Connector bytes come from the artifact
source; this package is the client that fetches, verifies and pins them.

## Registry neutrality

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

const source = await loadConnectorIndex({ indexUrl });
const lock = await generateLock({ dependencies, source });
await installFromLock({ lock, source, installRoot, layout: "snapshot" });
await verifyInstalled({ lock, source, installRoot, layout: "snapshot" });
```

Pass `artifactCertificateIdentityResolver` to any of the resolving entrypoints
to decide which signer identity is acceptable for a given artifact. The
resolver fails closed: if it returns no identity the artifact is rejected, and
identity metadata supplied by the index itself is ignored.

The OIDC certificate *issuer* is currently pinned to GitHub Actions
(`DEFAULT_SIGSTORE_CERTIFICATE_ISSUER`) and is not caller-substitutable. Signer
identity is the seam that is open today; issuer neutrality is not yet.

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

Node.js >= 20.11, and a `tar` binary on `PATH` for artifact unpacking.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
