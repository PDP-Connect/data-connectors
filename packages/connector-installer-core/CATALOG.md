# Signed connector catalog

The discovery artifact is `ghcr.io/pdp-connect/connector-catalog:latest`. It has one JSON layer with media type `application/vnd.pdpp.connector-catalog.v1+json`. Its schema is [`schemas/connector-catalog.schema.json`](../../schemas/connector-catalog.schema.json), using JSON Schema draft 2020-12.

The catalog lists published versions of connectors in `PUBLISHABLE_CONNECTORS`. Each version names an OCI manifest digest. A connector with no published versions is omitted. Legacy connectors and the allowlist's excluded external-tool connectors are not catalog entries. Source manifests without `setup.modality` produce `setup: { modality: null }`; the generator does not infer a setup flow.

## Generate

```sh
node scripts/generate-connector-catalog.mjs --out catalog.json
```

The generator reads the anonymous registry tag listing, follows pagination, and resolves each version through the publisher's three-outcome manifest lookup. An unknown lookup aborts generation. The output is schema-validated before it is written.

For an initial catalog, `source_commit` defaults to the checked-out commit and `generated_at` to that commit's timestamp. The workflow passes both explicitly. Before replacing an existing catalog, it resolves, verifies, and pulls the previous catalog by digest, then supplies `--previous-catalog <path>`. An unknown lookup or failed signature stops publication.

Unchanged content reuses the previous timestamp. Changed source metadata or connector entries get the later of the source timestamp and the previous timestamp plus one millisecond. This gives changed catalogs a strictly newer timestamp even when multiple connectors publish from the same commit. Identical registry state, source metadata, and previous catalog produce identical bytes; publication retries preserve that output. Direct generator callers must also supply the verified previous catalog when replacing one. The workflow's concurrency group serializes this read and replacement.

The workflow pushes the new artifact without moving `latest`, signs and verifies the returned digest, then tags that digest as `latest`. A signing or verification failure leaves the last signed catalog available, so the next run can retry.

## Fetch

```js
import { fetchCatalog } from "./oci-catalog.mjs";

const { catalog, digest } = await fetchCatalog({
  lastAcceptedGeneratedAt: savedCatalog?.generated_at,
});
// Persist catalog.generated_at only after acceptance.
```

`registry` defaults to `ghcr.io`. `identity` defaults to `https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main`. An explicit identity is caller-owned trust policy; never take it from the downloaded catalog.

The helper resolves `latest` once, fetches the manifest by digest, and verifies its Cosign signature through `oci-verify.mjs` before parsing the JSON layer. It verifies layer bytes and size, validates the catalog schema, and refuses a `generated_at` older than `lastAcceptedGeneratedAt`. Equal timestamps permit retries. Callers must persist the last accepted timestamp to retain rollback protection across process restarts.

Catalog acceptance does not install a connector or verify the separate signatures of every listed connector. Installation must fetch each chosen connector by its catalog digest and verify that artifact's signature. This helper is not connected to installation or update selection yet.

Local fixture tests cover the transport, signed digest, identity, schema, and rollback checks. They use local certificates and an injected verifier, so they do not prove a live GHCR/Fulcio/Rekor exchange.
