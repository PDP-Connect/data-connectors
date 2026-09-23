# Connector authoring

Create and maintain PDPP Collection Profile implementations in this repository under `connectors/<key>/`. Keep the connector's code, `manifest.json`, icon, tests, and reviewed scrubbed fixtures together. Use the shared runtime in `packages/polyfill-connectors/src/`.

1. Add or change the connector under `connectors/<key>/` and update its manifest version when the implementation or manifest contract changes.
2. Follow the [connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md) for collection, schema, coverage, and fixture evidence.
3. Install dependencies from the repository root with `npm ci`, then run the package verify gate and focused connector tests.
4. Build and verify its OCI artifact with `scripts/build-connector-oci-artifact.mjs` and `scripts/verify-connector-oci-artifact.mjs`. Publication is selected by `scripts/select-publish-connectors.mjs` and signed from the protected main workflow.

The historical Playwright scope catalog is frozen. A new Collection Profile stream does not automatically replace a Desktop scope or authorize writing raw records under a legacy scope ID. Such a replacement needs a separately reviewed projection and consumer activation.
