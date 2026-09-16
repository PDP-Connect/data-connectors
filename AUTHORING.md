# Connector authoring

This repository is the single home of PDPP connector content. Keep connector source and the canonical Collection Profile here, under `packages/polyfill-connectors/`.

`PDP-Connect/pdpp` keeps a copy of `packages/polyfill-connectors`, but production does not build from it. DataConnect builds the production package from this repository, and pdpp's copy does not own the primary implementation of a new connector.

## Default workflow

1. Add or change the collector here, in this repository, under `packages/polyfill-connectors/connectors/<key>/`.

2. Add or update its manifest at `packages/polyfill-connectors/manifests/<key>.json`.

3. Test the connector and its Collection Profile here. Work through the [connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md).

4. Publish the connector as an OCI artifact. `scripts/build-connector-oci-artifact.mjs` produces the layer bytes, `scripts/connector-publish-allowlist.mjs` decides which connectors a run publishes, and `.github/workflows/publish-polyfill-connectors.yml` pushes and Cosign-signs them from `main` as `ghcr.io/pdp-connect/connector/<key>`.

## OCI entrypoint contract

The OCI config sets `entrypoint` to `code/collection-profile.mjs`; installation writes that module to `dist/collection-profile.mjs`.
An OCI config entrypoint has the form `<layer-kind>/<member>`: the first segment selects the `code` layer, and the remainder must exactly match a layer-relative tar member, with no absolute paths, traversal, or empty segments.

## Legacy Playwright exception

Use the legacy Playwright path to maintain an existing `*-playwright` connector. A new legacy connector requires an explicit exception.

The legacy creation tools require `--legacy-exception`. That flag confirms the caller chose the older format on purpose. It does not make a legacy connector a PDPP Collection Profile.
