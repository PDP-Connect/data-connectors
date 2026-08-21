# Vendored dependency pin: @pdpp/reference-contract stand-in (transitional)

`@pdpp/collector-runtime` and `@pdpp/connector-protocol` used to be vendored here too, as
`.tgz` files built from [PDP-Connect/data-connect](https://github.com/PDP-Connect/data-connect).
As of PDP-Connect/data-connect#32, that repo publishes both packages to npm, so
`packages/polyfill-connectors/package.json` now depends on them via ordinary semver ranges
(`>=0.0.1 <1.0.0`) instead of a checked-in tarball. This directory now vendors only
`@pdpp/reference-contract`, which stays private per pdpp's own policy — see below.

## What's checked in

- `pdpp-reference-contract-0.0.1.tgz`: **not** the real `@pdpp/reference-contract` package.
  `@pdpp/collector-runtime`'s own `package.json` (inherited from the pnpm monorepo it originally
  shipped from) declares `@pdpp/reference-contract` as a dependency at bare `"*"`, which resolves
  against the public registry and 404s (it isn't published, and pdpp's policy keeps it that way
  "unless a future OpenSpec change explicitly makes it publishable"). `@pdpp/reference-contract`
  is a large contract package (route manifests, OpenAPI generation, validators) — this stand-in
  carries only a minimal subset, documented in full in
  `../src/reference-implementation-stand-in/`'s sibling and this file's provenance table below:

  - `common/index.ts` — `canonicalTerminalRunCommitEnvelope`/`canonicalTerminalRunCommitJson`.
    As of data-connect#31, `@pdpp/collector-runtime` no longer imports this function from
    `@pdpp/reference-contract` at all — it inlined its own copy directly
    (`packages/collector-runtime/src/local-device-envelope.ts` in data-connect). This stand-in
    still carries the function because `polyfill-connectors`' own code may reference
    `@pdpp/reference-contract/common` independently of collector-runtime; re-check this note's
    accuracy against a current `grep -r "@pdpp/reference-contract/common"` before assuming it's
    still load-bearing.
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
- `package.json`'s `overrides` field forces npm to substitute this local tarball for
  `@pdpp/reference-contract` wherever `@pdpp/collector-runtime` depends on it (that dependency is
  still declared at bare `"*"` inside the published collector-runtime package, which resolves
  against the public registry and 404s without this override). `polyfill-connectors` ALSO depends
  on `@pdpp/reference-contract` directly (`dependencies`, not just `overrides`) since its own
  restored tests import `@pdpp/reference-contract/evidence` and `/common` by package name, not
  only transitively through `collector-runtime`.
- sha256 (informational, alongside npm's own tarball integrity hash recorded in
  `package-lock.json` once installed):

  ```
  b636fbddb849ea17d66c7e010d9773e97b922de653c54ab4d9d9ba0db53e0c9e  pdpp-reference-contract-0.0.1.tgz
  ```

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

This is transitional. Once the real `@pdpp/reference-contract` becomes consumable by this repo
(pdpp's policy currently keeps it unpublished by design — this is a product/policy decision, not
a technical blocker like the one that used to gate `@pdpp/collector-runtime` and
`@pdpp/connector-protocol`), delete this directory and switch `package.json` back to a normal
semver-range registry dependency. Until then, drift between this tarball and its source commit is
bounded only by re-running the pack step by hand — there is no automated freshness check.
