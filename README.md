# Data Connectors

This repository is the source home for PDPP Collection Profile connectors. Each implementation lives in `connectors/<key>/` with its `manifest.json`, code, icon, tests, and reviewed scrubbed fixtures. `packages/polyfill-connectors/` contains shared runtime libraries and local development tools. New connector work starts with [Connector authoring](AUTHORING.md).

## Build and verify

Install from the repository root so TypeScript and runtime imports resolve the declared workspace dependencies:

```bash
npm ci
npm run verify --workspace @pdpp/polyfill-connectors
npm test --workspace @pdpp/polyfill-connectors
npm run connector-implementation-index:check
npm run historical-contract:check
```

The package's `npm run pack-install-run` builds a tarball, installs it in an isolated project, and imports every remaining library export. `scripts/build-connector-oci-artifact.mjs` bundles an individual root connector into an OCI artifact. The [connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md) covers source, manifest, and fixture review.

## Distribution

Collection Profiles are published as individually versioned, signed OCI artifacts. The source manifest at `connectors/<key>/manifest.json` owns its version and runtime bindings. The root [`connector-implementation-index.json`](connector-implementation-index.json) is generated from these implementations; `npm run connector-implementation-index:check` verifies it.

The legacy Playwright source, runner, and registry have been retired. [`scope-catalog.json`](scope-catalog.json), [`SCOPES.md`](SCOPES.md), [`connector-index.json`](connector-index.json), and [`fixture-index.json`](fixture-index.json) remain as historical public contracts. They are frozen along with the schemas and fixtures they reference. `npm run historical-contract:check` verifies their bytes and references. Do not regenerate them from the new Collection Profile manifests or reuse their legacy scope IDs for raw connector streams.

The root layout changes the private `@pdpp/polyfill-connectors` workspace API: connector implementations, manifest discovery, source-dependent registries, and the local device exporter are no longer shipped in its tarball. Consumers of the previous package must migrate those imports before repinning. The existing data-connect tarball pin and signed legacy artifacts are separate release inputs; changing this source tree does not establish replacement Desktop projections by itself.

## Further references

- [Collection Profile cutover contracts](docs/migration/connector-cutover/CONTRACTS.md)
- [Connector capability map](docs/migration/connector-cutover/capability-map.json)
