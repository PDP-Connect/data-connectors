# `reference-implementation` stand-in (transitional, Gate B finding B2)

Not the real `reference-implementation` package (that stays in `PDP-Connect/pdpp` and is out of
scope for this move). This directory exists only to satisfy
`src/reason-display-messages.test.ts`'s import of `RUNTIME_GENERIC_REASON_CODES`, which the real
test imports by monorepo-relative path
(`../../../reference-implementation/runtime/recovery-reason-codes.ts`) — a path that no longer
resolves once `polyfill-connectors` lives in its own repository.

This is a source-file stand-in, not a vendored npm package like `vendor/pdpp-reference-contract`:
the original import is a relative path into a sibling directory, not a package-name resolution
(there is no `reference-implementation` npm package to shadow), so there is nothing for
`package.json`/`overrides` to do here. The test file's import is rewritten to point at this local
copy instead.

## What's checked in and its exact source

| Stand-in file | Source path | Source commit |
|---|---|---|
| `runtime/recovery-reason-codes.ts` | `reference-implementation/runtime/recovery-reason-codes.ts` | `27f6eb6a6fae671a04835c145e869efa8d457c9f` (`PDP-Connect/pdpp`, branch `manifest-reconciliation`) |

Byte-identical copy, confirmed by diff against the source commit before copying.

This module is safe to copy in isolation because it is self-documented in the real
`reference-implementation` as a deliberately dependency-free leaf: its own header states "This
module has no external dependencies, allowing test packages to import the authoritative reason
set without pulling in server-side modules (auth, CIMD, etc.) that have incompatible lib
typings." Confirmed independently: the file contains zero `import` statements at the pinned
commit.

## Why NOT `bin/orchestrate.ts` or `connectors/github/index.test.ts`

Both also reference `reference-implementation` paths, but their imports
(`reference-implementation/server/db.ts`, `server/records.ts`,
`server/postgres-storage.ts`, `server/stores/connector-instance-store.ts`, and a dynamic
`import()` of `runtime/index.ts`) are the actual reference-implementation SERVER — thousands of
lines each (`db.ts` 6,107 lines, `records.ts` 8,731 lines, `postgres-storage.ts` 5,277 lines,
`connector-instance-store.ts` 2,640 lines at the pinned commit), with a deep transitive
dependency tree into auth, search indexing, and both SQLite/Postgres storage backends. Unlike
`recovery-reason-codes.ts`, none of these files is a documented, zero-dependency leaf module.

Vendoring that surface "byte-for-byte" would mean copying a large fraction of a live server, not
bridging a small authoring contract — a fundamentally different and much larger undertaking than
the minimal-stand-in pattern this directory and `vendor/pdpp-reference-contract` follow. Doing so
would also misrepresent what `github/index.test.ts` actually tests: it drives GitHub connector
collection against a REAL in-memory instance of the reference implementation's own ingest
pipeline (`initDb`/`getDb`/`closeDb`, `ingestRecord`, `drainConnectorInstanceIndexWork`) — a
stand-in re-implementation of that pipeline would no longer be testing the real production
behavior, only a parallel guess at it.

These two remain excluded from this repository's typecheck/test surface. Per Gate B finding B2's
own "acceptable transitional mechanism," their closure is the required cross-repository semantic
CI job (finding B5's cutover mechanism): check out `PDP-Connect/pdpp` (or its
`reference-implementation`-owning successor) at an exact pinned SHA, run these two files against
the real server they need, and record the artifact digest and test transcript. See the Gate B2
closure report for the exact job shape.

## Removal trigger

Delete this directory once `reference-implementation`'s own repository move lands and
`recovery-reason-codes.ts` (or its replacement) is available to this repo as a real package
dependency or its own pinned vendor tarball.
