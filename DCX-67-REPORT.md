# DCX-67 report: publish JavaScript entry points

## Scope and approach

Issue #67 was reproducible from a clean npm consumer. The baseline package points its bin and public exports at `.ts` files, and Node refuses to strip types below `node_modules`.

I evaluated a full package build and a targeted publish build. A full build is not currently viable: it includes the non-published `bin/orchestrate.ts`, whose reference-implementation imports are absent in this repository, and an unrelated Slack type error. The chosen targeted build emits JavaScript for every public export, the published bin, the static-registry generator, and the production connector/runtime closures they invoke. It excludes tests and development-only CLIs from the tarball.

`package.json` now points all 40 bin/export targets to `.js`; `prepack` builds those files and bundles the two vendored runtime packages required by the local-device path. `check-published-entrypoints.mjs` makes the build fail if a bin/export target is not JavaScript or its emitted file is missing, and inspects the known compiled subprocess entrypoints for raw `.ts` paths. The packed-file allowlist excludes package-owned raw TypeScript from `bin`, `connectors`, `scripts`, and `src`.

## Consumer spike

Both spikes used a new scratch npm project, installed the tarball with plain npm (with npm 11's explicit script approval flag so postinstall actually ran), then used plain Node. The baseline was rebuilt from `origin/main`; the final tarball was produced after the verified build and vendored-runtime hydration.

### Before: `origin/main`

Each command exited 1 with this verbatim Node error. The pathname differs only by the entrypoint shown.

| Node | Command / entrypoint | Failure |
| --- | --- | --- |
| v22.23.2 | `node_modules/.bin/pdpp-local-device-exporter --help` | `Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules, for "file:///home/tnunamak/.tmp/dcx67-baseline-repro.VUqFxB/project/node_modules/@pdpp/polyfill-connectors/bin/local-device-exporter.ts"` |
| v22.23.2 | `node .../scripts/generate-static-secret-registry.ts` | `Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules, for "file:///home/tnunamak/.tmp/dcx67-baseline-repro.VUqFxB/project/node_modules/@pdpp/polyfill-connectors/scripts/generate-static-secret-registry.ts"` |
| v22.23.2 | `import "@pdpp/polyfill-connectors/manifests"` | `Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules, for "file:///home/tnunamak/.tmp/dcx67-baseline-repro.VUqFxB/project/node_modules/@pdpp/polyfill-connectors/src/manifest-registry.ts"` |
| v22.23.2 | `import "@pdpp/polyfill-connectors/collectors"` | `Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules, for "file:///home/tnunamak/.tmp/dcx67-baseline-repro.VUqFxB/project/node_modules/@pdpp/polyfill-connectors/src/collector-registry.ts"` |
| v24.19.0 | `node_modules/.bin/pdpp-local-device-exporter --help` | `Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules, for "file:///home/tnunamak/.tmp/dcx67-baseline-repro.VUqFxB/project/node_modules/@pdpp/polyfill-connectors/bin/local-device-exporter.ts"` |
| v24.19.0 | `node .../scripts/generate-static-secret-registry.ts` | `Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules, for "file:///home/tnunamak/.tmp/dcx67-baseline-repro.VUqFxB/project/node_modules/@pdpp/polyfill-connectors/scripts/generate-static-secret-registry.ts"` |
| v24.19.0 | `import "@pdpp/polyfill-connectors/manifests"` | `Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules, for "file:///home/tnunamak/.tmp/dcx67-baseline-repro.VUqFxB/project/node_modules/@pdpp/polyfill-connectors/src/manifest-registry.ts"` |
| v24.19.0 | `import "@pdpp/polyfill-connectors/collectors"` | `Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules, for "file:///home/tnunamak/.tmp/dcx67-baseline-repro.VUqFxB/project/node_modules/@pdpp/polyfill-connectors/src/collector-registry.ts"` |

### After: packed tarball

The final tarball installed 67 packages. It contains zero raw `.ts` files below its package-owned `bin`, `connectors`, `scripts`, and `src` directories. Every listed consumer command exited 0.

```text
Node v22.23.2
usage: local-device-exporter <enroll|run|setup> --base-url <url> [options]
wrote .../static-secret-registry-22.23.2.ts
manifests-imported
collectors-imported

Node v24.19.0
usage: local-device-exporter <enroll|run|setup> --base-url <url> [options]
wrote .../static-secret-registry-24.19.0.ts
manifests-imported
collectors-imported
```

The Node 22 bin probe also printed Node's expected experimental SQLite warning; it did not affect its zero exit status.

## Verification

- `npm run verify` passed.
- `npm run test` passed with recorded exit status `0`.
- `node ../../scripts/check-spdx-headers.mjs` passed: 758 files checked.
- `npm run pack-install-run` passed. It packs, installs with postinstall enabled, and runs the bin, generator, manifests export, and collectors export from the installed package.
- `git diff --check` passed.

## PR

[PDP-Connect/data-connectors#68](https://github.com/PDP-Connect/data-connectors/pull/68)

## Gaps and confidence

High confidence in the four reported consumer paths and the package-owned runtime subprocesses: they have both a metadata/build gate and a clean tarball consumer probe. Node 22 passed the probe but is outside the declared `>=24.15.0 <25` support range. Vendored-runtime hydration uses the standard POSIX `tar` executable; that is exercised here and in the package regression, but a non-POSIX packaging environment would need an equivalent extractor.
