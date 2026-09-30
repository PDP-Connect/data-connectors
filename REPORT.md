# Progress

## Baseline

- Fetched `origin` and based `waspflow/m8-pageshim-streaming-main` on
  `origin/main` at `921ad6868518852b90805c4a0b94ae116d510f0e`.
- Read the streamed result protocol from unity-surfaces PR #1330 and inspected
  the diff. It adds no capability flag for connectors to query.
- PR #265 adds the ChatGPT PageShim entry and modifies `runtime.ts`,
  `harness.mjs`, and `build.mjs`. `git merge-tree` found no textual conflicts
  against its head, but both PRs change overlapping runtime behavior and need
  semantic reconciliation when PR #265 is integrated.
- The repository's referenced canonical code-quality theory file is absent
  from this `origin/main` checkout.
- `TASK.md` is ignored and was not staged or committed.

## Capability and integration contract

The shell protocol uses only the four `result:*` messages and does not expose a
streaming capability flag. Proposed shell API: `page.supportsResultStreaming()`
returns `true` only when all four messages are supported. Until the shell adds
that method, connector builds use `--stream-results` as an explicit opt-in;
the default build keeps `page.setData('result', value)`.

The ChatGPT entry in PR #265 stores each scope as `{ records: [...] }`. To
stream its large message scope while records from both scopes arrive during
collection, the entry should configure `streamScopeRecords.order` as
`['messages', 'conversations']` and provide a count-based summary. The runtime
then streams messages as they arrive and retains only the smaller conversation
scope until collection finishes. The ChatGPT entry is not in `origin/main`, so
it cannot be enabled in this branch without importing the separate connector
feature from PR #265. The existing Strava entry now exercises this production
hook for its single `{ records }` scope.

The exact four-message protocol has no field for the legacy result envelope
(`requestedScopes`, version, timestamp, and structured errors). Streaming keeps
the summary in status and marks partial completion when collection errors
exist; detailed non-fatal error records remain unavailable through this shell
protocol. The harness models the shell's disk-backed spool and sequence,
identical-retry, size, surrogate-boundary, and one-protocol rules.

## Implementation and checks

- [x] Add opt-in bounded chunk serialization for `{ records }` scope payloads.
- [x] Preserve the legacy result path when the build flag is off or no stream
  scope is emitted.
- [x] Extend the harness with the shell-side streamed result protocol.
- [x] Add a 150 MB end-to-end fixture, retry and validation coverage, legacy
  fallback coverage, and terminal protocol and serialization failures.
- [x] Make protocol and record-serialization failures terminal even if the
  connector catches the rejected `emit()` promise.
- [x] Measure runner heap through fresh Chromium CDP samples with precise memory
  reporting; a retained-allocation control exceeds the 64 MiB threshold.
- [x] Mark streamed collection errors with a `Partial:` status.
- [x] Coordinate the ChatGPT entry opt-in with PR #265 in a PR comment.
- [x] `node --test scripts/pageshim/pageshim-streaming.test.mjs`: 12 tests pass.
- [x] `node --test scripts/pageshim/pageshim.test.mjs`: 37 tests pass.
- [x] `npm run verify --workspace @pdpp/polyfill-connectors`: passes. Biome
  reports two expected archived-fixture format findings covered by its existing
  exception list.
- [x] `git diff --check` passes.
- [x] Review final diff and commit signed changes with Tim Nunamaker as author
  and committer, followed by `Signed-off-by` and `Assisted-by: AI` trailers.
- [x] Open draft PR #268: https://github.com/PDP-Connect/data-connectors/pull/268.

Focused command `node --test scripts/pageshim/pageshim-streaming.test.mjs`
passes. It streams 150,034,916 UTF-16 code units across the `chatgpt.messages`
and `chatgpt.conversations` scopes; chunks stay at or below 262,144 code units,
the fresh CDP samples keep runner heap below 64 MiB, and a negative control
detects a retained heap above that threshold. The streamed message file matches
an independently computed SHA-256. This checks connector-to-spool transport.
PR #1330's hosted-page staging path still has a 64 MiB limit per scope, so this
test does not verify uploading a single 150 MB scope. The current `main` branch
does not include the ChatGPT entry from PR #265; that entry must add the
documented stream config before ChatGPT itself opts in. The exact shell protocol
also cannot carry the legacy result envelope or detailed non-fatal errors.

STATUS: FINAL
