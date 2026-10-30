# Data Connectors

This repository is the source home for PDPP Collection Profile connectors. Each implementation lives in `connectors/<key>/` with its `manifest.json`, code, icon, tests, and reviewed scrubbed fixtures. `packages/polyfill-connectors/` contains shared runtime libraries and local development tools. New connector work starts with [Connector authoring](AUTHORING.md). The [PDPP Collection Profile](docs/spec/collection-profile.md) defines the normative connector manifest and protocol.

## Build and verify

Start with the [connector authoring loop](AUTHORING.md) for the scaffold, local run, capture, replay, and safe evidence workflow.

Install from the repository root so TypeScript and runtime imports resolve the declared workspace dependencies:

```bash
npm ci
npm ci --ignore-scripts --prefix packages/polyfill-connectors/test-tools
npm run verify --workspace @pdpp/polyfill-connectors
npm test --workspace @pdpp/polyfill-connectors
npm run connector-implementation-index:check
npm run legacy-shapes:check
npm run legacy-shapes:test
```

The package's `npm run pack-install-run` builds a tarball, installs it in an isolated project, and imports every remaining library export. `scripts/build-connector-oci-artifact.mjs` bundles an individual root connector into an OCI artifact. The [connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md) covers source, manifest, and fixture review.

## Distribution

Collection Profiles are published as individually versioned, signed OCI artifacts. The source manifest at `connectors/<key>/manifest.json` owns its version and runtime bindings. The root [`connector-implementation-index.json`](connector-implementation-index.json) is generated from these implementations; `npm run connector-implementation-index:check` verifies it.

The repository no longer contains the retired `*-playwright` and `claude-code-local` tarballs, root `scope-catalog.json`, `connector-index.json`, and `fixture-index.json`, or their hand-dispatched signing and release workflow. Existing GitHub release assets are separate; this change does not modify them.

The permanent [`legacy-shapes.json`](legacy-shapes.json) retains all 54 published old-format scope IDs and their exact schema bytes. `npm run legacy-shapes:check` pins only that mapping and its schemas, and checks the generated [scope index](SCOPES.md) for drift. `npm run legacy-shapes:generate` renders the index from the same mapping and schemas; the generated document is not a separate definition. `scripts/no-legacy-connectors.test.mjs` keeps every other legacy connector artifact out of the repository.

The root layout changes the private `@pdpp/polyfill-connectors` workspace API: connector implementations, manifest discovery, source-dependent registries, and the local device exporter are no longer shipped in its tarball. Consumers of the previous package must migrate those imports before repinning. This source change does not modify artifacts already published to GitHub Releases.

## Further references

