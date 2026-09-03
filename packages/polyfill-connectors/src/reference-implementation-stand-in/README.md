# `reference-implementation` stand-in (now a permanent local copy — pdpp#284)

Not the real `reference-implementation` package. It USED to live in `PDP-Connect/pdpp`; pdpp#284
(2026-09-02) deleted that directory entirely — the code moved to `PDP-Connect/data-connect`
(pdpp#284's own PR body: "a parallel, now-canonical copy of that same server code already lives"
there). This directory exists to satisfy two test files' imports of `reference-implementation`
modules by monorepo-relative path, paths that no longer resolve once `polyfill-connectors` lives
in its own repository:

- `src/reason-display-messages.test.ts`'s import of `RUNTIME_GENERIC_REASON_CODES`
  (`../../../reference-implementation/runtime/recovery-reason-codes.ts`).
- `src/connector-runtime-session-watchdog.test.ts`'s dynamic `import()` of
  `boundConnectorErrorCode`/`boundConnectorErrorMessage`
  (`../../../reference-implementation/runtime/connector-gap-bounding.ts`).

This is a source-file stand-in, not a vendored npm package like `vendor/pdpp-reference-contract`:
the original import is a relative path into a sibling directory, not a package-name resolution
(there is no `reference-implementation` npm package to shadow), so there is nothing for
`package.json`/`overrides` to do here. The test file's import is rewritten to point at this local
copy instead.

## What's checked in and its exact source

| Stand-in file | Source path | Source commit |
|---|---|---|
| `runtime/recovery-reason-codes.ts` | `reference-implementation/runtime/recovery-reason-codes.ts` | `e6135fb2fc8dbc5ac38dd7609a6c2a544b394e72` (`PDP-Connect/pdpp`, branch `move-r-pdpp-removal`) |
| `runtime/stderr-redact.ts` | `reference-implementation/runtime/stderr-redact.ts` | `c0357945b2f6925f84a4f6c1b23491890f72ee4b` (`PDP-Connect/pdpp`, `origin/main`) |
| `runtime/connector-gap-bounding.ts` | `reference-implementation/runtime/connector-gap-bounding.ts` (PARTIAL — see below) | `c0357945b2f6925f84a4f6c1b23491890f72ee4b` (`PDP-Connect/pdpp`, `origin/main`) |

`recovery-reason-codes.ts` and `stderr-redact.ts` are byte-identical copies, confirmed by diff
against the source commit before copying.

`connector-gap-bounding.ts` here is NOT byte-identical to its source — the real module is
1,000+ lines covering a whole connector-output bounding/projection policy cluster (gap
diagnostics, scope normalization, recovery hints, browser-surface posture, etc.). Only the two
functions `connector-runtime-session-watchdog.test.ts` actually imports —
`boundConnectorErrorCode` and `boundConnectorErrorMessage` — plus their exact, self-contained
dependency chain (the `CONNECTOR_ERROR_MESSAGE_MAX`/`CONNECTOR_ERROR_CODE_RE` constants and the
`redactStderrTail` import) are extracted byte-identical from the source function bodies. See
that file's own header comment for the extraction rationale.

`recovery-reason-codes.ts` is safe to copy in isolation because it is self-documented in the real
`reference-implementation` as a deliberately dependency-free leaf: its own header states "This
module has no external dependencies, allowing test packages to import the authoritative reason
set without pulling in server-side modules (auth, CIMD, etc.) that have incompatible lib
typings." Confirmed independently: the file contains zero `import` statements at the pinned
commit. `stderr-redact.ts` is likewise confirmed to have zero imports at the pinned commit, which
is what makes extracting `connector-gap-bounding.ts`'s two functions safe: their only dependency
outside self-contained local constants is `redactStderrTail`.

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

## Removal trigger — FIRED, now a permanent local copy

The trigger this section used to describe ("once `reference-implementation`'s own repository
move lands") fired with pdpp#284: `reference-implementation/` no longer exists at any pdpp SHA,
so there is no live canonical source left to pin `recovery-reason-codes.ts` or
`stderr-redact.ts` against — the drift comparison's premise (a tracked upstream file) is gone,
not merely stale. `check-reference-contract-drift.mjs` no longer compares these two files for
that reason (see its own header comment).

These files are therefore no longer "stand-ins" tracking an external source — they are this
repo's own permanent local implementation of this small, self-contained, dependency-free
surface. Treat edits to them like any other local source file, not like a resync-from-upstream
task. If `PDP-Connect/data-connect`'s copy of this code (the new home of the server that used to
be pdpp's `reference-implementation/`) ever needs to be pulled in as a real dependency instead,
that would be a deliberate, separate decision — not implied by this note.
