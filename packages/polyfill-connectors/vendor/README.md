# Vendored dependency pins (transitional)

`@pdpp/collector-runtime` and `@pdpp/connector-protocol` live in
[PDP-Connect/data-connect](https://github.com/PDP-Connect/data-connect), pinned at commit
`9155e57ae47ab145214eb10551ed2c2185d7098a` (see `.github/cross-repo-pins.json`). This package
needs them at build/test time, but they are not published to any registry yet.

## Why a checked-in `.tgz`, not a git dependency

npm's git-dependency syntax has no equivalent of pnpm's `#commit&path:subdir`. Confirmed by
experiment (2026-08-17): a spec like
`github:PDP-Connect/data-connect#<sha>:packages/collector-runtime` does NOT select the
subdirectory. `npm-package-arg` treats anything after the first `:` in the fragment as an
unrelated, unrecognized key and silently drops it — including the commit SHA itself, since the
whole `<sha>:packages/collector-runtime` string fails to parse as a bare committish. The
observed result installing that exact spec: npm cloned the **whole `data-connect` repo root**
at its **current default-branch HEAD**, not the pinned commit and not the subdirectory. That is
a silent-wrong-version hazard, not just a missing convenience, so the git-dependency approach is
rejected outright rather than treated as a partial win.

## What's checked in

- `pdpp-collector-runtime-0.0.1.tgz` / `pdpp-connector-protocol-0.0.1.tgz`: built with
  `npm run build` then packed with `npm pack` from a clean checkout of
  `PDP-Connect/data-connect@9155e57ae47ab145214eb10551ed2c2185d7098a`, workspace packages
  `packages/collector-runtime` and `packages/connector-protocol`. Resynced 2026-08-20 to pick up
  data-connect PR #30 (port of pdpp's dropped preservation-fixes-0819 hunks: bare-specifier
  package validation, iMessage fixture date fix, connector-spawn tsx-resolution hardening).
  Only collector-runtime's contents changed; connector-protocol's tarball is byte-identical to
  the prior vendored copy.
- `pdpp-reference-contract-0.0.1.tgz`: **not** the real `@pdpp/reference-contract` package.
  `@pdpp/collector-runtime`'s own `package.json` (inherited from the pnpm monorepo) declares
  `@pdpp/connector-protocol` and `@pdpp/reference-contract` as dependencies at bare `"*"`, which
  resolves against the public registry and 404s (neither is published). `@pdpp/connector-protocol`
  is handled by pinning it too (see `overrides` below). `@pdpp/reference-contract` is a large
  contract package (route manifests, OpenAPI generation, validators) — this stand-in carries only
  a minimal subset, documented in full in `../src/reference-implementation-stand-in/`'s sibling
  and this file's provenance table below:

  - `common/index.ts` — `canonicalTerminalRunCommitEnvelope`/`canonicalTerminalRunCommitJson`,
    the one function `collector-runtime`'s non-test code (`src/local-device-client.ts`) actually
    calls.
  - `evidence/index.ts`, `evidence/coherence.ts`, `evidence/collection-scope.ts` — added when
    Gate B finding B2 restored `polyfill-connectors`' excluded semantic/conformance tests
    (`connectors/_conformance/coverage-conformance.test.ts`,
    `connectors/groupme/attachment-detail-coverage.test.ts`,
    `connectors/ynab/collect-terminal-coverage.test.ts`,
    `src/collector-scope-contract.test.ts`), which import `evaluateStreamCoherence` and
    `collectionScopeFingerprint` from `@pdpp/reference-contract/evidence`. `coherence.ts` and
    `collection-scope.ts` are each self-documented in the real package as deliberately
    dependency-free leaves (neither imports anything, not even sibling contract modules —
    confirmed by inspecting both files at the pinned commit). The stand-in's `evidence/index.ts`
    barrel deliberately does NOT re-export the real barrel's other two modules
    (`named-collection-scope.ts`, `scope-narrowing-authority.ts`): no restored test needs them,
    and `scope-narrowing-authority.ts` is not a zero-dependency leaf (it imports
    `collection-scope.ts`), so it was left out rather than speculatively vendored.

  Provenance for every copied file:

  | Stand-in file | Source path | Source commit |
  |---|---|---|
  | `common/index.ts` | `packages/reference-contract/src/common/terminal-run-commit.ts` | `7b46f9a0ee28fafb421018ff283a329e4623e44a` (identical bytes carried forward through `27f6eb6a6fae671a04835c145e869efa8d457c9f`, reconfirmed by diff) |
  | `evidence/coherence.ts` | `packages/reference-contract/src/evidence/coherence.ts` | `27f6eb6a6fae671a04835c145e869efa8d457c9f` (`PDP-Connect/pdpp`, branch `manifest-reconciliation`) |
  | `evidence/collection-scope.ts` | `packages/reference-contract/src/evidence/collection-scope.ts` | `27f6eb6a6fae671a04835c145e869efa8d457c9f` |
  | `evidence/index.ts` | hand-written barrel, not copied from the real package | n/a |

  This tarball remains a minimal private stand-in, not an independent contract implementation.
  Delete it once the real `@pdpp/reference-contract` is available to this repo.
- Because `@pdpp/collector-runtime`'s dependency declarations point at the public registry
  (`"*"`), not at these vendor files, `package.json`'s `overrides` field is what actually forces
  npm to substitute the local tarballs for `@pdpp/connector-protocol` and `@pdpp/reference-contract`
  wherever `@pdpp/collector-runtime` depends on them. `polyfill-connectors` ALSO depends on
  `@pdpp/reference-contract` directly (`dependencies`, not just `overrides`) since its own
  restored tests import `@pdpp/reference-contract/evidence` and `/common` by package name, not
  only transitively through `collector-runtime`. A plain nested `file:` dependency in
  `collector-runtime`'s own `package.json` isn't an option since that file lives inside the
  already-packed tarball we don't control.
- sha256 (informational, alongside npm's own tarball integrity hash recorded in
  `package-lock.json` once installed):

  ```
  e78fecd8c4ef74860cbeb3eb356b6c738e396f8d00fee21d5fdb8269604215e5  pdpp-collector-runtime-0.0.1.tgz
  0173b91526c4ee5a8ebe8c8c67848758b4112d46cadbd72bb7cf1c90f5389905  pdpp-connector-protocol-0.0.1.tgz
  b636fbddb849ea17d66c7e010d9773e97b922de653c54ab4d9d9ba0db53e0c9e  pdpp-reference-contract-0.0.1.tgz
  ```

  (`pdpp-reference-contract-0.0.1.tgz`'s digest changed from the prior `5c9168ad...` when the
  `evidence/` subpath was added for Gate B finding B2; `package-lock.json` was regenerated in the
  same change — see the closure report for the exact before/after.)

`package.json` references the two Move A packages plus `@pdpp/reference-contract` directly via
`file:./vendor/<name>.tgz` dependencies, npm's supported local-tarball dependency form, and the
transitive `@pdpp/connector-protocol` / `@pdpp/reference-contract` pins for
`@pdpp/collector-runtime` via `overrides`.

## What this vendor tree does NOT cover

Two of the eight tests Gate B finding B2 restored need `reference-implementation` SERVER modules
(`server/db.ts`, `server/records.ts`, `server/postgres-storage.ts`,
`server/stores/connector-instance-store.ts`, and a dynamic import of `runtime/index.ts`), not a
narrow leaf contract. Those are thousands of lines each with deep transitive dependencies into
auth, search indexing, and storage backends — not a minimal-stand-in candidate. See
`../src/reference-implementation-stand-in/README.md` for the full reasoning and the required
cross-repository closure mechanism for those two files
(`connectors/github/index.test.ts`, `bin/orchestrate.ts`).

## Removal trigger

This is transitional. Once `@pdpp/collector-runtime` and `@pdpp/connector-protocol` publish
(from `PDP-Connect/data-connect`, to whatever registry that repo settles on) and the real
`@pdpp/reference-contract` becomes consumable by this repo, delete this directory and switch
`package.json` back to normal semver-range registry dependencies. Until then, drift between
these tarballs and the pinned commit is bounded only by re-running the pack step by hand — there
is no automated freshness check.
