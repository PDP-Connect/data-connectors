# Claude live publication validation

## Evidence for Preview

On 2026-10-14, an operator completed four terminal runs against a paid Claude account with history, using a dedicated browser profile and the real connector runner. All runs exited 0 and completed successfully. The first run and two seeded resumes read 480 conversations and 8,342 messages in total; the second resume cleared the deferred backlog. A third seeded resume was settled: it read no conversations, messages, or plan records, emitted three usage-limit records, and had no skips. Conversation and message state were unchanged in that settled run; plan and usage state changed. The plan stream recovered after one first-run `http_error` skip and emitted one paid-plan record on the next run. Usage limits emitted three records per run. Schema checks matched record counts, within-run IDs were unique, references resolved, and per-run message counts agreed.

The evidence supports Preview for the tested paid account and host. Cross-run ID deduplication was not instrumented. No owner-UI content/date comparison or independent network tracing was performed. Live mobile, Team/Enterprise accounts, and concurrent edits were not verified; deterministic tests cover paging and edits synthetically. The run does not establish support for every account or device.

The redacted operator summary is retained outside the repository. Do not add raw records, account identifiers, chat content, billing details, profile data, cookies, or saved state to the repository or PR.

## Reproduce local checks

Run from the repository root with Node 24 and dependencies installed:

```sh
TZ=UTC node --import tsx --test connectors/anthropic_live/*.test.ts
npm run verify --workspace @pdpp/polyfill-connectors
npm run connector-implementation-index:check
npm run historical-contract:check
npm run manifest-schema:test
TZ=UTC npm test --workspace @pdpp/polyfill-connectors
```

The chat tests carry emitted per-stream STATE into later runs. They cover capped and interrupted backfill, timestamp ties, independent consent windows, expanded selections, malformed responses, and session repair. Paging regressions test concurrent changes and retryable failures. These synthetic tests do not establish live provider behavior.

## Operator procedure

Obtain the account owner's permission before a live run. Use a dedicated browser profile and the real connector entry point. Collect read-only data: do not request an export, send messages, modify conversations, revoke a session, or change subscription settings.

The commands below collect all four streams and save emitted STATE for each later run. Clear scenario HAR and storage-state capture variables first. Run from `packages/polyfill-connectors/` in a terminal. The first command opens the connector browser profile for owner sign-in. `--no-capture` disables automatic DOM, screenshot, and record capture. The runner prints counts and progress, not chat bodies.

```sh
umask 077
PDPP_CAPTURE_FIXTURES=0 PDPP_CAPTURE_ON_FAILURE=0 node --import tsx bin/connector-dev.ts anthropic_live --no-capture --summary-out runs/anthropic_live/live-first.json
PDPP_CAPTURE_FIXTURES=0 PDPP_CAPTURE_ON_FAILURE=0 node --import tsx bin/connector-dev.ts anthropic_live --no-capture --seed-last-state --summary-out runs/anthropic_live/live-resume.json
```

If history is deferred, repeat the seeded command until the backlog clears, keeping a separate summary for each run. Then run once more without changing the account to check settled incremental behavior. Check each summary's success status, per-stream counts, state, and skip reasons. A successful run with a skipped stream does not prove that stream works.

If the account has more than one list page, the run tests live paging. More than 200 changed conversations tests the per-run cap. If the account is smaller, record that limit; deterministic tests cover these cases. A mobile PageShim test covers synthetic responses, not live device authentication.

## Privacy and promotion

Keep browser profiles, saved state, and raw captures local. Disable HAR and storage-state export unless separately authorized. Scrubbing email addresses and phone numbers does not remove private conversation text; review every retained value before sharing. Label real-run fixtures with their actual provenance and keep synthetic fixtures labeled synthetic.

Before publication, verify that the export and live Claude profiles build one valid source declaration, both artifacts verify and load in isolation, and their shared stream contracts agree. Recheck the trial merge against current main, artifact version rules, the full connector suite, generated metadata, historical contracts, and manifest schemas. Preview is the current evidence-supported tier; green local checks alone do not justify Supported.
