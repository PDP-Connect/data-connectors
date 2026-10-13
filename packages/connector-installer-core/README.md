# @pdpp/connector-manager

The client that resolves signed OCI Collection Profile artifacts, verifies
their cosign signatures, digests and sizes, and installs the verified bytes
into a caller-chosen root. It also fetches the signed connector catalog.

It carries no connector content. Connector bytes come from the registry; this
package is the client that fetches, verifies and pins them.

## Lock entries

Every lock entry is a digest-pinned OCI Collection Profile:

```js
{
  connectorId: "ynab-pdpp",
  connectorKey: "ynab",
  version: "0.3.0",
  artifactKind: "pdpp-collection-profile",
  manifestPath: "profile/collection-profile.json",
  entrypointPath: "dist/collection-profile.mjs",
  provenancePath: "provenance.json",
  oci: { registry: "ghcr.io", repository: "pdp-connect/connector/ynab", digest: "sha256:…" },
}
```

An entry without an `oci` block, without that `artifactKind`, or with a path
that is absolute or escapes its install root is refused before any network
request. A digest-less entry is refused too, unless the caller passes
`allowTagResolution: true` for a first pin.

## Choosing which signer to trust

`ociCertificateIdentityResolver` receives `{ registry, repository }` and
returns the one Sigstore identity that may sign that artifact. The default,
`defaultOciCertificateIdentityResolver`, trusts only
`ghcr.io/pdp-connect/connector/*` signed by
`DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY`. A resolver that returns no
identity refuses the artifact before any signature is checked. The identity
is chosen from the lock's coordinates, never from the artifact, so an artifact
cannot nominate its own signer.

The OIDC certificate issuer is pinned to GitHub Actions
(`DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER`) and is not caller-substitutable.

## Contract

- `fetchCatalog` — fetch and verify the signed connector catalog.
- `fetchResolvedArtifact(null, entry, options)` — fetch and verify one
  artifact without installing it.
- `installFromLock` — fetch, verify and write every pinned artifact.
- `verifyInstalled` — re-verify an install root against its lock, and report
  the signed source declaration digest for each artifact.
- `pruneInstalled` — remove entries an install root no longer expects.

The `source` argument of `fetchResolvedArtifact`, `installFromLock` and
`verifyInstalled` must be `null`; any other value is refused. Verification is
not optional in any of these paths. A digest or size mismatch, an unsigned
manifest, an unexpected layer or archive member, or a path escaping the
install root all fail closed.

## Subpath exports for a bytes-and-verification-only consumer

The default `.` entry (`index.mjs`) is the full installer: it also imports
`node:fs` and writes the install root, which a consumer that only needs to
fetch and verify OCI bytes should not have to pull in. Four modules are
separately reachable so that surface stays out of the import:

- `@pdpp/connector-manager/oci-registry.mjs` — `fetchManifestByDigest`,
  `fetchBlob`, and reference/error primitives. Its only Node builtin is
  `node:crypto` (`createHash`).
- `@pdpp/connector-manager/oci-verify.mjs` — `verifyOciSignature` and the
  Sigstore identity constants. Depends on `oci-registry.mjs` and `sigstore`
  (itself Node-only).
- `@pdpp/connector-manager/oci-catalog.mjs` — `fetchCatalog`.
- `@pdpp/connector-manager/catalog-schema.mjs` — `assertCatalog`, the schema
  guard `fetchCatalog` already applies internally.

None of the four touch `node:fs` or `node:child_process`; the only Node
builtin anywhere in that graph is `node:crypto`, pulled in by
`oci-registry.mjs` and inherited by `oci-verify.mjs`/`oci-catalog.mjs`. That
still makes the whole graph Node-only, not edge-runtime-safe — `sigstore`
declares the same Node engine floor this package does — so a consumer must
reach it from a Node server context, not edge middleware.

## Requirements

Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`. Layers are unpacked in process;
no `tar` binary is needed.

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
