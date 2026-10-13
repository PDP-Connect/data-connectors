# Data Connectors

This repository is the source home for PDPP Collection Profile connectors. Each implementation lives in `connectors/<key>/` with its `manifest.json`, code, icon, tests, and reviewed scrubbed fixtures. `packages/polyfill-connectors/` contains shared runtime libraries and local development tools. New connector work starts with [Connector authoring](AUTHORING.md). The [PDPP Collection Profile](docs/spec/collection-profile.md) defines the normative connector manifest and protocol.

## Build and verify

Install from the repository root so TypeScript and runtime imports resolve the declared workspace dependencies:

```bash
npm ci
npm run verify --workspace @pdpp/polyfill-connectors
npm test --workspace @pdpp/polyfill-connectors
npm run connector-implementation-index:check
```

The package's `npm run pack-install-run` builds a tarball, installs it in an isolated project, and imports every remaining library export. `scripts/build-connector-oci-artifact.mjs` bundles an individual root connector into an OCI artifact. The [connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md) covers source, manifest, and fixture review.

## Distribution

Collection Profiles are published as individually versioned, signed OCI artifacts. The source manifest at `connectors/<key>/manifest.json` owns its version and runtime bindings. The root [`connector-implementation-index.json`](connector-implementation-index.json) is generated from these implementations; `npm run connector-implementation-index:check` verifies it.

The legacy Playwright collector source left this repository earlier, and this tree no longer carries what only served it: the frozen scope catalog (`scope-catalog.json`, `SCOPES.md`), `connector-index.json`, `fixture-index.json`, their schemas and fixtures, the tarballs under `artifacts/`, and the hand-dispatched release-index workflow that signed them. Their exact bytes stay in Git history (for example at commit `d0fabd8d3`). Vana owns the scope contracts that Vana products still read. Vana Desktop still installs those collectors from its own pins and from GitHub release assets that were already published (`connectors-latest`, `connectors-<sha12>`). Those are separate objects; removing these files does not change them or retire any Desktop collector.

The root layout changes the private `@pdpp/polyfill-connectors` workspace API: connector implementations, manifest discovery, source-dependent registries, and the local device exporter are no longer shipped in its tarball. Consumers of the previous package must migrate those imports before repinning. The existing data-connect tarball pin and signed legacy artifacts are separate release inputs; changing this source tree does not establish replacement Desktop projections by itself.

## Further references

- [Collection Profile cutover contracts](docs/migration/connector-cutover/CONTRACTS.md)
