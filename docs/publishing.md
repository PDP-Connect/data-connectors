# Packaging and publishing connectors

This page is for maintainers. It says how a connector in `connectors/<key>/` becomes a published artifact, and which checks keep the published data stable. A contributor needs only the version rule below.

## Version rule

A change to a connector's code or to its manifest contract needs a version bump in `connectors/<key>/manifest.json`. A new connector starts at `0.1.0`. The PR check `scripts/check-publish-version-bumps.mjs` runs the same selection rule as the publish workflow and fails a PR that changes a connector's artifact content without a bump.

## Artifacts

Each connector is published as its own versioned, signed OCI artifact. The manifest at `connectors/<key>/manifest.json` owns the version and the runtime bindings.

1. `scripts/build-connector-oci-artifact.mjs` bundles one connector into an artifact. `scripts/verify-connector-oci-artifact.mjs` checks one.
2. `scripts/connector-publish-allowlist.mjs` classifies every manifest as published or excluded. An excluded connector does not publish.
3. After a merge to `main`, `.github/workflows/publish-polyfill-connectors.yml` runs `scripts/select-publish-connectors.mjs` to pick the connectors whose content changed, then builds, signs and publishes them.
4. `connector-implementation-index.json` at the repository root is generated from the connectors. `npm run connector-implementation-index:check` fails when it is out of date, and `npm run connector-implementation-index:generate` rewrites it.
5. In `packages/polyfill-connectors/`, `npm run pack-install-run` builds the package tarball, installs it in an empty project and imports every export.

The steps a reviewer takes to merge and confirm a publication are in [CONNECTOR-REVIEW.md](../CONNECTOR-REVIEW.md#merge-and-publish).

## Frozen legacy scopes

Connectors published before the Collection Profile used old-format scope IDs, and existing data still carries them. `legacy-shapes.json` at the repository root keeps all 54 of those scope IDs with their exact schema bytes, and [SCOPES.md](../SCOPES.md) is generated from it.

1. `npm run legacy-shapes:check` fails when the mapping, a schema or `SCOPES.md` drifts.
2. `npm run legacy-shapes:generate` renders `SCOPES.md` again from the mapping and schemas.
3. `scripts/no-legacy-connectors.test.mjs` keeps the retired connector artifacts out of the repository.

A new Collection Profile stream does not replace a legacy scope and must not write records under a legacy scope ID. Such a replacement needs its own reviewed projection and a consumer that turns it on.
