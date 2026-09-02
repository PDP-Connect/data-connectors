# Vendored dependency pins (transitional)

`@pdpp/collector-runtime` and `@pdpp/connector-protocol` live in
[PDP-Connect/data-connect](https://github.com/PDP-Connect/data-connect), pinned at commit
`82a45176ebe654eee595f06d5fa97de0648e86ba` (see `.github/cross-repo-pins.json`). This package
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
  `PDP-Connect/data-connect@82a45176ebe654eee595f06d5fa97de0648e86ba`, workspace packages
  `packages/collector-runtime` and `packages/connector-protocol`. Resynced 2026-09-02 (second
  time same day): the prior `63a3792` pin was already one commit behind an unrelated dependabot
  npm bump (#37) that touches both packages' `package.json` (devDependency/dependency version
  bumps only — `zod ^4.4.3`→`^4.5.2`, `@biomejs/biome`, `@types/node`, `ultracite`), and
  data-connect#41 (the connector-source-drift fix this pin move otherwise carries) was based on
  top of that bump. Verified locally: a fresh repack from `63a3792` still matched the
  then-committed tarballs, but a fresh repack from `82a45176e` does not match them (only
  `package.json`'s bytes differ — the `dist/` files are unaffected), so this re-vendor was
  required to keep the tarball-digests drift check green once the pin moved for the connector
  fix. Supersedes the prior `63a3792` pin (2026-09-02, same day).
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
  | `common/index.ts` | `packages/reference-contract/src/common/terminal-run-commit.ts` | `8d42fe86eb6bac6cf266b37c451f8b9909539b6e` (`PDP-Connect/pdpp`, PR #238 head; resynced 2026-08-31 for a comment-only change — the connector-id-canonicalization warning documented in the source, no behavior change) |
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
  b26854640fb4acf93f4f394a282a2c8d947e634c76d28b1488cba99a77229072  pdpp-collector-runtime-0.0.1.tgz
  2a0aab13f97ea1ed6ec8173edd22470f78469a898ee66d980ec87d4b3372dbcf  pdpp-connector-protocol-0.0.1.tgz
  8271e75949f85e57de8ca4ed557e73b6706e3680c9ad7a986bd290d94797e8d6  pdpp-reference-contract-0.0.1.tgz
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
