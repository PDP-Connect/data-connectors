# PageShim mobile OCI release

## Progress and implementation

Started from the fetched `origin/main`. PageShim bundles now travel in each enabled connector's existing `assets.tar.gz` layer. The publish workflow attaches the bundle before its local artifact verifier, push, and signing steps. The signed connector OCI digest therefore covers the desktop artifact and mobile bundle together. `config.mobile.pageshim` records the assets layer, archive member path, JavaScript media type, raw bundle SHA-256, and byte size. No separate mobile version or artifact signature was added.

The artifact verifier checks the PageShim metadata, extracts the declared member from the assets layer, and confirms its digest and size. The attach step refuses an artifact whose connector key, connector ID, or version differs from the checked-out source manifest. Publish input hashing follows PageShim entry and injected-shim import closures, so a change to shipped helper code selects the affected connector.

Manifest versions were advanced for the three PageShim-enabled connectors and the generated implementation index was refreshed:

- `anthropic` 0.2.15
- `github-browser` 0.2.9
- `strava-browser` 0.1.4

## unity-surfaces mobile catalog handoff

For each selected connector, resolve its published version to an OCI manifest digest, then use the immutable reference `ghcr.io/pdp-connect/connector/<connector_key>@<artifact_digest>`. Do not fetch the bundle from a mutable tag after this digest is recorded. At catalog build time, verify the root artifact digest with Cosign using the exact certificate identity `https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main` and OIDC issuer `https://token.actions.githubusercontent.com`.

Read `config.json` from that OCI artifact and select its layer whose media type is `application/vnd.pdpp.connector.assets.v1.tar+gzip`. Verify the config and assets layer against their OCI descriptor digests and sizes. Safely extract the member named by `config.mobile.pageshim.path` (relative to the assets archive), then verify the raw JavaScript bytes against `config.mobile.pageshim.digest` and `config.mobile.pageshim.size`. The root OCI digest, compressed assets-layer digest, and raw bundle digest identify different byte sequences; store and verify each in its own field.

Recommended per-connector `index.json` fields for unity-surfaces are:

```json
{
  "connectorId": "<manifest connector_id>",
  "version": "<same release version as desktop>",
  "artifact": {
    "repository": "ghcr.io/pdp-connect/connector/<connector_key>",
    "digest": "sha256:<OCI manifest digest>"
  },
  "mobile": {
    "pageshim": {
      "layerMediaType": "application/vnd.pdpp.connector.assets.v1.tar+gzip",
      "layerDigest": "sha256:<compressed assets layer digest>",
      "layerSize": 123,
      "path": "pageshim/<connector manifest>.js",
      "mediaType": "text/javascript",
      "digest": "sha256:<raw bundle digest>",
      "size": 123
    }
  }
}
```

The mobile admission step should pin `artifact.digest` and the raw `mobile.pageshim.digest` from the generated catalog. It should fetch by the immutable artifact reference, locate the bundle by `path`, and reject bytes whose size or SHA-256 differs. The later catalog generator/schema update is not part of this data-connectors change.

## Verification

- `npm run installer:test` — 321 passed.
- `node --test scripts/connector-oci-artifact.test.mjs` — 44 passed, including bundle digest, connector identity, and version rejection cases.
- `env -u TMPDIR RUNNER_TEMP="$PWD/.task-tmp" node --test scripts/connector-publish-build.test.mjs` — 47 passed across the publish allowlist.
- `node --test scripts/pageshim/pageshim.test.mjs` — 37 passed.
- `node --test scripts/select-publish-connectors.test.mjs` — 22 passed, including entry and injected-shim helper hashing.
- `npm run connector-implementation-index:check`, `npm run historical-contract:check`, and `npm run cross-repo-integrity:test` passed.
- `git diff --check` passed.

The independent review reproduced and then confirmed fixes for missed PageShim helper inputs and cross-connector/connector-ID/version attachment, and found no remaining release-integrity blocker. It also confirmed that the existing assets layer remains compatible with the installer's recognized media type. Registry publication and remote Cosign verification were not run; this task did not publish, deploy, or merge.

STATUS: FINAL
