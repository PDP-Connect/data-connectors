# GitHub PDPP maintenance

This is a maintainer workflow for the checked-in `github-pdpp` artifact. Start new connector work in `PDP-Connect/pdpp`. See [Connector authoring](../../AUTHORING.md).

## Current contract

The `github-pdpp` bundle contains these contract files:

```text
profile/collection-profile.json
dist/collection-profile.mjs
provenance.json
```

GitHub requires only the `network` binding. `collection-profile.json` declares it as required:

```json
{
  "network": { "required": true }
}
```

The GitHub collector uses a personal access token through the network binding. This artifact does not declare or support a browser binding. The build replaces unreachable browser imports with a fail-fast module.

The artifact kind is `pdpp-collection-profile`. Installer-core installs it under `collection-profiles/github-pdpp`. It does not create a legacy Playwright projection.

The checked-in index entry uses `releaseId: "unpublished"` as source-tree placeholder metadata before CI regenerates the index. The immutable [`connectors-48440fead534` release](https://github.com/PDP-Connect/data-connectors/releases/tag/connectors-48440fead534) contains the signed artifact. The [`connectors-latest` release](https://github.com/PDP-Connect/data-connectors/releases/tag/connectors-latest) also provides it. Use those release assets for published artifact references.

## Maintained source

Maintain these files deliberately:

```text
collection-profile.json
src/connector/index.ts
src/connector/parsers.ts
src/connector/schemas.ts
src/connector/types.ts
```

The profile manifest must remain byte-equal to the pinned upstream PDPP manifest. The build reads runtime source from the exact PDPP commit in `provenance.json`. It uses `git archive`, so worktree changes cannot become build inputs.

GitHub predates the `artifact.json` contract and generic `scripts/build-pdpp-artifact.mjs` builder. Do not copy its special builder for a new connector. The [default authoring workflow](../../AUTHORING.md#default-workflow) explains the target packaging path.

## Rebuild and verify

1. Get a PDPP worktree at the commit recorded in `provenance.json`.
2. Make the intentional GitHub source or manifest change.
3. Build the bundle and regenerate its index entry.

```bash
npm run github-pdpp:build -- --pdpp-root /path/to/pdpp
node scripts/generate-connector-index.mjs
```

For an unpublished draft with same-version source changes, use this explicit command:

```bash
node scripts/generate-connector-index.mjs --allow-unpublished-rebuild
```

4. Verify the source, bundle, provenance, installer path, index, and documentation.

```bash
npm run pdpp:authoring:check
npm run github-pdpp:test
npm run connector-index:check
```

Set `PDPP_GITHUB_SOURCE_ROOT=/path/to/pdpp` to test worktree isolation. That test proves the pinned rebuild stays the same.

Do not hand-edit `provenance.json` or `dist/collection-profile.mjs`. The build generates both files. The artifact and index record their exact digests.
