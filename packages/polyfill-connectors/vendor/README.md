# Vendored dependency pins (transitional)

`@pdpp/collector-runtime` and `@pdpp/connector-protocol` live in
[PDP-Connect/data-connect](https://github.com/PDP-Connect/data-connect), pinned at commit
`48c8364c4627ee8d923f90c98de050eeaff236b3`. This package needs them at build/test time, but they
are not published to any registry yet.

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
  `PDP-Connect/data-connect@48c8364c4627ee8d923f90c98de050eeaff236b3`, workspace packages
  `packages/collector-runtime` and `packages/connector-protocol`.
- `pdpp-reference-contract-0.0.1.tgz`: **not** the real `@pdpp/reference-contract` package.
  `@pdpp/collector-runtime`'s own `package.json` (inherited from the pnpm monorepo) declares
  `@pdpp/connector-protocol` and `@pdpp/reference-contract` as dependencies at bare `"*"`, which
  resolves against the public registry and 404s (neither is published). `@pdpp/connector-protocol`
  is handled by pinning it too (see `overrides` below). `@pdpp/reference-contract` is a large
  contract package (route manifests, OpenAPI generation, validators) — out of scope for this
  move — but `collector-runtime`'s non-test code (`src/local-device-client.ts`) genuinely imports
  one function from it, `canonicalTerminalRunCommitEnvelope` (`@pdpp/reference-contract/common`).
  This tarball is a minimal private stand-in carrying only that function and its sibling
  `canonicalTerminalRunCommitJson`, copied byte-for-byte from the real package's
  `src/common/terminal-run-commit.ts` at the same pinned commit. Delete it once the real
  `@pdpp/reference-contract` is available to this repo.
- Because `@pdpp/collector-runtime`'s dependency declarations point at the public registry
  (`"*"`), not at these vendor files, `package.json`'s `overrides` field is what actually forces
  npm to substitute the local tarballs for `@pdpp/connector-protocol` and `@pdpp/reference-contract`
  wherever `@pdpp/collector-runtime` depends on them — a plain nested `file:` dependency in
  `collector-runtime`'s own `package.json` isn't an option since that file lives inside the
  already-packed tarball we don't control.
- sha256 (informational, alongside npm's own tarball integrity hash recorded in
  `package-lock.json` once installed):

  ```
  34f55c3402e013774a18b688ffcabc559ffdc02d238b19257612c1dc4b813d06  pdpp-collector-runtime-0.0.1.tgz
  931660f8560a7c52cd89fb01a648268b0fb2985f53ba2d4fe99ddcc97690bd1c  pdpp-connector-protocol-0.0.1.tgz
  5c9168ad2a872163b14e98da9cb29b685f474886d661bc2f3e564a8399770aa5  pdpp-reference-contract-0.0.1.tgz
  ```

`package.json` references the two Move A packages directly via `file:./vendor/<name>.tgz`
dependencies, npm's supported local-tarball dependency form, and the transitive
`@pdpp/connector-protocol` / `@pdpp/reference-contract` pins via `overrides`.

## Removal trigger

This is transitional. Once `@pdpp/collector-runtime` and `@pdpp/connector-protocol` publish
(from `PDP-Connect/data-connect`, to whatever registry that repo settles on), delete this
directory and switch `package.json` back to normal semver-range registry dependencies. Until
then, drift between these tarballs and the pinned commit is bounded only by re-running the pack
step by hand — there is no automated freshness check.
