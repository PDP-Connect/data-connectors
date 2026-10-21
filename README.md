# Data Connectors

This repository is the source home for PDPP Collection Profile connectors. Each implementation lives in `connectors/<key>/` with its `manifest.json`, code, icon, tests, and reviewed scrubbed fixtures. `packages/polyfill-connectors/` contains shared runtime libraries and local development tools. New connector work starts with [Connector authoring](AUTHORING.md). The [PDPP Collection Profile](docs/spec/collection-profile.md) defines the normative connector manifest and protocol.

## Build and verify

Install from the repository root so TypeScript and runtime imports resolve the declared workspace dependencies:

```bash
npm ci
npm run verify --workspace @pdpp/polyfill-connectors
npm test --workspace @pdpp/polyfill-connectors
npm run connector-implementation-index:check
npm run legacy-shapes:check
npm run legacy-shapes:test
npm run legacy-retention:test
npm run oura-retention:test
```

The package's `npm run pack-install-run` builds a tarball, installs it in an isolated project, and imports every remaining library export. `scripts/build-connector-oci-artifact.mjs` bundles an individual root connector into an OCI artifact. The [connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md) covers source, manifest, and fixture review.

## Distribution

Collection Profiles are published as individually versioned, signed OCI artifacts. The source manifest at `connectors/<key>/manifest.json` owns its version and runtime bindings. The root [`connector-implementation-index.json`](connector-implementation-index.json) is generated from these implementations; `npm run connector-implementation-index:check` verifies it.

The repository no longer contains the retired `*-playwright` and `claude-code-local` tarballs, root scope and fixture indexes, or their hand-dispatched signing and release workflow. The Oura legacy artifacts remain under `artifacts/oura-playwright/` until F2. Existing GitHub release assets are separate; this change does not modify them. `npm run oura-retention:test` checks the pinned 3.1.2 archive and runs its collection behavior as well as the newest source's tests.

To publish a legacy Oura fix before F2, restore `.github/workflows/publish-connector-release-index.yml` and its required frozen inputs and signing scripts from commit `4beffae01896395a1d953021b64404f370310ac1` on `main`. Keep that exact workflow path and branch: existing clients trust its Sigstore signing identity. Review and test the restored lane before dispatching it.

The permanent [`legacy-shapes.json`](legacy-shapes.json) retains all 54 published old-format scope IDs and their exact schema bytes, including Oura after executable retirement. `npm run legacy-shapes:check` pins only that mapping and its schemas. Frozen release metadata snapshots and 12 fixture proofs live in [`artifacts/legacy-retention/`](artifacts/legacy-retention/README.md); `npm run legacy-retention:check` checks them in the explicit F10 retention lane, independently of Oura executable retirement at F2. These snapshots do not enable publishing.

The root layout changes the private `@pdpp/polyfill-connectors` workspace API: connector implementations, manifest discovery, source-dependent registries, and the local device exporter are no longer shipped in its tarball. Consumers of the previous package must migrate those imports before repinning. This source change does not modify artifacts already published to GitHub Releases.

## Further references

- [Historical Collection Profile cutover log](docs/migration/connector-cutover/CONTRACTS.md)
- [Connector capability map](docs/migration/connector-cutover/capability-map.json)
