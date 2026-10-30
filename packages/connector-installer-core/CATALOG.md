# Signed connector catalog

The discovery artifact is `ghcr.io/pdp-connect/connector-catalog:latest`. It has one JSON layer with media type `application/vnd.pdpp.connector-catalog.v1+json`. Its schema is [`schemas/connector-catalog.schema.json`](../../schemas/connector-catalog.schema.json), using JSON Schema draft 2020-12.

The catalog lists published versions of connectors in `PUBLISHABLE_CONNECTORS`. Each version names an OCI manifest digest. A connector with no published versions is omitted. Legacy connectors and the allowlist's excluded external-tool connectors are not catalog entries. Source manifests without `setup.modality` produce `setup: { modality: null }`; the generator does not infer a setup flow.

## Generate

```sh
node scripts/generate-connector-catalog.mjs --out catalog.json
```

The generator reads the anonymous registry tag listing, follows pagination, and resolves each version through the publisher's three-outcome manifest lookup. An unknown lookup aborts generation. The output is schema-validated before it is written.

For an initial catalog, `source_commit` defaults to the checked-out commit and `generated_at` to that commit's timestamp. The workflow passes both explicitly. Before replacing an existing catalog, it resolves, verifies, and pulls the previous catalog by digest, then supplies `--previous-catalog <path>`. An unknown lookup or failed signature stops publication.

Unchanged connector entries reuse the previous source commit and timestamp, so an unrelated source commit does not publish or notify again. Changed connector entries get the later of the source timestamp and the previous timestamp plus one millisecond. This gives changed catalogs a strictly newer timestamp even when multiple connectors publish from the same commit. Direct generator callers must also supply the verified previous catalog when replacing one. The workflow's concurrency group serializes this read and replacement.

On every main release event, including after a partial publication failure, the workflow reconciles registry tags with the last signed catalog. It treats prior version-to-digest mappings as authoritative, even if a mutable tag disappears or is moved. It resolves only newly discovered version tags; this avoids rechecking every historical tag on each push, so a changed old tag is not detected by reconciliation. The publisher's version guard refuses to overwrite an existing tag. Before adding a version, the workflow fetches that exact digest and verifies the artifact and its signed source declaration through the installer. Versions already in the prior catalog are retained without repeating this new check; consumers must still verify every artifact they install. Removing a connector from the reviewed publish allowlist removes it from a future catalog.

If the latest release did not change, reconciliation reuses its metadata from the verified previous catalog. Policy changes and manual recovery re-read it from the published artifact; direct generator callers can do the same with `--refresh-metadata true`.

If the catalog changed, the workflow pushes the new artifact without moving `latest`, signs and verifies the returned digest, checks that `latest` has not changed since reconciliation, then tags that digest as `latest`. A verification or publication failure leaves the last signed catalog available. Reconciliation can recover on a later release event or manual dispatch; it cannot guarantee recovery without another event.

## Subscribe to updates

When configured, the [WebSub publisher](../../scripts/websub-publisher/README.md) exposes a public Atom topic and notifies its hub after the signed catalog is tagged. Any consumer can subscribe through that hub. Notifications are hints: fetch and verify the catalog by digest before using it. The topic and hub are deployment configuration, so no public topic URL is assumed here.

## Fetch

```js
import { fetchCatalog } from "./oci-catalog.mjs";

const { catalog, digest } = await fetchCatalog({
  lastAcceptedGeneratedAt: savedCatalog?.generated_at,
});
// Persist catalog.generated_at only after acceptance.
```

`registry` defaults to `ghcr.io`. `identity` defaults to `https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main`. An explicit identity is caller-owned trust policy; never take it from the downloaded catalog.

By default, the helper resolves `latest` once, fetches the manifest by digest, and verifies its Cosign signature through `oci-verify.mjs` before parsing the JSON layer. It verifies layer bytes and size, validates the catalog schema, and refuses a `generated_at` older than `lastAcceptedGeneratedAt`. Equal timestamps permit retries. Callers must persist the last accepted timestamp to retain rollback protection across process restarts.

To use a catalog digest obtained earlier, pass `catalogDigest` to `fetchCatalog`. The helper fetches that exact manifest instead of resolving `latest`, and applies the same signature, schema, and rollback checks. An invalid or unavailable digest fails; it does not fall back to `latest`. A digest identifies bytes, not freshness: callers still need to enforce their own last accepted timestamp.

Catalog acceptance does not install a connector or verify the separate signatures of every listed connector. Installation must fetch each chosen connector by its catalog digest and verify that artifact's signature. This helper is not connected to installation or update selection yet.

Local fixture tests cover the transport, signed digest, identity, schema, and rollback checks. They use local certificates and an injected verifier, so they do not prove a live GHCR/Fulcio/Rekor exchange.
