# Real cosign v3 bundle response shapes

Captured against a live `registry:3.1.1` container, from a real `oras push`
followed by a real `cosign sign --key ... --yes` run with cosign v3.1.3, on
2026-09-23. Not hand-written and not derived from this package's own
understanding of the format — they exist because an earlier revision of
`oci-fixture.mjs` encoded the same misunderstanding the production code had
(that the `sha256-<hex>` fallback tag resolves directly to the bundle
manifest), so its own test suite could not catch that bug. These three files
are what a real client actually receives, independent of any belief this
codebase holds about the wire format.

- `tag-index.json` — `GET /v2/<repo>/manifests/sha256-<hex>` (the fallback
  tag, no `.sig` suffix). An OCI image index, NOT the bundle manifest: this
  is the file that catches the historical bug if it recurs, since a
  hand-rolled fixture that skips the index wrapping cannot fail this check.
- `inner-manifest.json` — the manifest one of `tag-index.json`'s descriptors
  points at, fetched by digest. Carries `subject` (naming the signed
  artifact) and one layer (the bundle itself).
- `bundle-blob.json` — the layer blob, fetched by digest. A Sigstore
  protobuf bundle (`verificationMaterial` + `dsseEnvelope`), key-based
  (`publicKey.hint`, not a Fulcio certificate) since this was signed
  key-locally rather than through a real Actions OIDC token.

All digests inside these files are internally consistent with each other
(the index names the inner manifest's real digest; the inner manifest names
the blob's real digest; the inner manifest's `subject` names the real signed
artifact's digest) but do not correspond to any artifact that still exists —
capturing them did not require keeping the artifact or the signing key.

Used by `oci-fixture-shape.test.mjs` to assert that `oci-fixture.mjs`'s
programmatically-built bundle fixture has the same shape (same top-level
keys, same nesting, same media types) as these real captures, independent
of the specific digests and keys each test run generates.
