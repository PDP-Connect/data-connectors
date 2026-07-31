# Connector authoring

Use PDPP for new connector work by default. Keep source code and the canonical Collection Profile in the `PDP-Connect/pdpp` repository.

This repository packages a pinned PDPP commit for DataConnect. It does not own the primary implementation of a new connector.

## Default workflow

1. Add or change the connector in `PDP-Connect/pdpp` under `packages/polyfill-connectors/`.

2. Test the connector and its Collection Profile in that repository.

3. Commit the PDPP work and select the exact source commit.

4. Add an `artifact.json` descriptor in this repository.

5. Build the pinned artifact with `scripts/build-pdpp-artifact.mjs`.

6. Verify the manifest, bundle, provenance, installer path, and required host bindings.

7. Publish the artifact only after its DataConnect host bindings are available.

The ChatGPT artifact uses the generic descriptor and builder. Do not copy the GitHub-specific builder to create a new artifact.

## Artifact descriptor

`artifact.json` records packaging facts. It identifies the artifact, pinned PDPP commit, manifest, entrypoint, connector files, runtime root, build target, and external packages.

The generic builder archives the pinned commit. Dirty and untracked files in the PDPP worktree do not become build inputs. The builder generates these files:

```text
collection-profile.json
dist/collection-profile.mjs
provenance.json
```

Do not hand-edit generated files. Review the recorded input and output hashes after each build.

## Binding and publication status

### GitHub

GitHub requires only the `network` binding. The checked-in index entry intentionally has `releaseId: "unpublished"` before CI regenerates the source-tree index. The immutable [`connectors-cc744cbf5782` release](https://github.com/PDP-Connect/data-connectors/releases/tag/connectors-cc744cbf5782) contains the signed GitHub artifact. The [`connectors-latest` release](https://github.com/PDP-Connect/data-connectors/releases/tag/connectors-latest) also provides it.

GitHub predates the generic descriptor. It uses a maintainer-only builder and checked-in connector source. See [GitHub PDPP maintenance](connectors/github-pdpp/AUTHORING.md).

### ChatGPT

ChatGPT uses `artifact.json` and the generic builder. The checked-in index entry intentionally has `releaseId: "unpublished"` before CI regenerates the source-tree index. The immutable [`connectors-cc744cbf5782` release](https://github.com/PDP-Connect/data-connectors/releases/tag/connectors-cc744cbf5782) contains the signed ChatGPT artifact. The [`connectors-latest` release](https://github.com/PDP-Connect/data-connectors/releases/tag/connectors-latest) also provides it.

The ChatGPT profile requires both `network` and `browser`. Its host must provide Node 22, `p-queue@^9.3.3`, and `patchright@^1.61.1`. DataConnect support remains pending until the browser-host PR lands. Do not describe ChatGPT PDPP collection as supported before that host work lands.

## Legacy Playwright exception

Use the legacy Playwright path to maintain an existing `*-playwright` connector. A new legacy connector requires an explicit exception.

The legacy creation tools require `--legacy-exception`. That flag confirms the caller chose the older format on purpose. It does not make a legacy connector a PDPP Collection Profile.
