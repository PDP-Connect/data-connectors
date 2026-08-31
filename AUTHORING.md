# Connector authoring

This repository is the single home of PDPP connector content. Keep source code and the canonical Collection Profile here, under `connectors/`.

`PDP-Connect/pdpp`'s copy of `packages/polyfill-connectors` is frozen for direct edits: it continues to run the product, but is no longer the source of truth for new connector work, and does not own the primary implementation of a new connector.

## Default workflow

1. Add or change the connector here, in this repository.

2. Test the connector and its Collection Profile here.

3. Commit the work and select the exact source commit.

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

GitHub requires only the `network` binding. The checked-in index entry intentionally has `releaseId: "unpublished"` before CI regenerates the source-tree index. The immutable [`connectors-48440fead534` release](https://github.com/PDP-Connect/data-connectors/releases/tag/connectors-48440fead534) contains the signed GitHub artifact. The [`connectors-latest` release](https://github.com/PDP-Connect/data-connectors/releases/tag/connectors-latest) also provides it.

GitHub predates the generic descriptor. It uses a maintainer-only builder and checked-in connector source. See [GitHub PDPP maintenance](connectors/github-pdpp/AUTHORING.md).

### ChatGPT

ChatGPT uses `artifact.json` and the generic builder. The checked-in index entry intentionally has `releaseId: "unpublished"` before CI regenerates the source-tree index. The immutable [`connectors-48440fead534` release](https://github.com/PDP-Connect/data-connectors/releases/tag/connectors-48440fead534) contains the signed ChatGPT artifact. The [`connectors-latest` release](https://github.com/PDP-Connect/data-connectors/releases/tag/connectors-latest) also provides it.

The ChatGPT profile requires both `network` and `browser`. Its host must provide Node 22, `p-queue@^9.3.3`, and `patchright@^1.61.1`. [DataConnect v0.7.54](https://github.com/PDP-Connect/data-connect/releases/tag/v0.7.54) and later provide this browser host.

## Legacy Playwright exception

Use the legacy Playwright path to maintain an existing `*-playwright` connector. A new legacy connector requires an explicit exception.

The legacy creation tools require `--legacy-exception`. That flag confirms the caller chose the older format on purpose. It does not make a legacy connector a PDPP Collection Profile.
