# Versioning and publishing connectors

A contributor needs the version rule. The rest of this page is for maintainers who publish connectors and keep the published data stable.

## Version rule

1. A new connector starts at version `0.1.0` in `connectors/<key>/manifest.json`.
2. A change to a connector's code or manifest needs a new version. In this repository each change raises the last number, for example `0.6.23` to `0.6.24`.
3. After you change a version or add a connector, run `npm run connector-implementation-index:generate` and commit `connector-implementation-index.json`. Publishing refuses a connector whose manifest version and index version differ, and `npm test` fails while the index is out of date.

`scripts/check-publish-version-bumps.mjs` runs on each PR. It fails when a connector's shipped content changed and its version did not, because one version must never name two different artifacts.

## How a connector is published

Each connector that `scripts/connector-publish-allowlist.mjs` lists as published becomes its own signed artifact in the GitHub container registry, at `ghcr.io/pdp-connect/connector/<key>:<version>`. A connector the allowlist excludes is not published.

1. A PR merges to `main`.
2. `.github/workflows/publish-polyfill-connectors.yml` runs `scripts/select-publish-connectors.mjs`. It refuses the push if a connector's content changed without a new version. It then selects every published connector whose current version is not in the registry yet, including a version that an earlier run failed to publish.
3. The workflow builds each selected connector with `scripts/build-connector-oci-artifact.mjs`, checks it with `scripts/verify-connector-oci-artifact.mjs`, pushes it and signs it. It then publishes an updated connector catalog to `ghcr.io/pdp-connect/connector-catalog`.

The steps a reviewer takes to merge and confirm a publication are in [CONNECTOR-REVIEW.md](../CONNECTOR-REVIEW.md#merge-and-publish).

## Other checks on published content

1. `npm run connector-implementation-index:check` fails when `connector-implementation-index.json` does not match the manifests.
2. In `packages/polyfill-connectors/`, `npm run pack-install-run` builds the package tarball, installs it in an empty project and imports every export.

## Frozen legacy scopes

Connectors published before the Collection Profile used older scope IDs, and stored data still carries them. `legacy-shapes.json` at the repository root keeps all 54 of those scope IDs with their exact schemas, and [SCOPES.md](../SCOPES.md) is generated from it.

1. `npm run legacy-shapes:check` fails when the mapping, a schema or `SCOPES.md` changes.
2. `npm run legacy-shapes:generate` renders `SCOPES.md` again from the mapping and schemas.
3. `scripts/no-legacy-connectors.test.mjs` keeps the retired connector artifacts out of the repository.

A new stream does not replace a legacy scope, and a connector must not write records under a legacy scope ID. To replace one, a maintainer reviews a separate mapping from the new stream to the old scope, and the app that reads the old scope must be changed to use it.
