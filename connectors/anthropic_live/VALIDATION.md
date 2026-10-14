# Claude live publication validation

The fixture directory and PageShim harness contain synthetic data. They test collection behavior and emitted shape; they do not establish what a signed-in Claude account serves. Keep `public_listing.tier` at `development` and the publish exclusion in place until an operator run supplies the missing evidence. Promotion is a maintainer decision.

## Local checks

Run from the repository root with Node 24 and dependencies installed:

```sh
TZ=UTC node --import tsx --test connectors/anthropic_live/*.test.ts
npm run verify --workspace @pdpp/polyfill-connectors
npm run connector-implementation-index:check
npm run historical-contract:check
npm run manifest-schema:test
TZ=UTC npm test --workspace @pdpp/polyfill-connectors
```

The chat tests must carry the emitted per-stream STATE into later runs. They cover capped and interrupted backfill, timestamp ties, independent consent windows, expanded selections, malformed responses, and session repair. The paging regressions must also show that concurrent changes cannot leave old history permanently behind a saved checkpoint. A synthetic test passing is not evidence that the provider honors its paging parameters.

## Operator run

Obtain the account owner's permission before starting. The current publish exclusion requires a paid account with history. Use a dedicated browser profile and the real connector entry point. This is read-only collection: do not request an export, send messages, modify conversations, revoke a session, or change subscription settings as part of validation.

These commands use the existing developer runner, collect all four streams, and save emitted STATE for the next run. Clear any scenario HAR or storage-state capture variables first, and use a dedicated local browser profile rather than an unrelated remote browser context. Run them from `packages/polyfill-connectors/` in a terminal. The first command opens the connector's browser profile; the owner completes sign-in there. `--no-capture` disables automatic DOM, screenshot, and record capture. The runner prints counts and progress, not chat bodies.

```sh
umask 077
PDPP_CAPTURE_FIXTURES=0 PDPP_CAPTURE_ON_FAILURE=0 node --import tsx bin/connector-dev.ts anthropic_live --no-capture --summary-out runs/anthropic_live/live-first.json
PDPP_CAPTURE_FIXTURES=0 PDPP_CAPTURE_ON_FAILURE=0 node --import tsx bin/connector-dev.ts anthropic_live --no-capture --seed-last-state --summary-out runs/anthropic_live/live-resume.json
```

If the connector reports deferred history, repeat the second command until that backlog clears, retaining a separate summary for each run. Do not treat one capped run as complete collection. Then run once more without changing the account to check settled incremental behavior. Check each summary's DONE status, per-stream record counts, emitted state, and skip reasons. A successful DONE with a skipped stream does not prove that stream works. The summaries deliberately do not claim independent transport observation; the operator must establish that the visible signed-in page and requests belong to the intended provider.

If local record capture is separately authorized, compare a small sample of collected conversations and messages with the owner's Claude history, including an older conversation and any project or attachment variant the account has. Check plan family and subscription dates against the account page, and usage values and reset times against the provider response. Record unavailable variants explicitly. Do not create paid subscriptions, conversations, projects, or attachments just to fill the checklist.

An account with more than one list page tests real paging. More than 200 changed conversations tests the actual per-run cap. If the account is smaller, retain that limitation; the deterministic tests still exercise those cases. A mobile PageShim test proves the bundle against synthetic responses, not live device authentication. Describe the tested host and account class accurately; do not claim universal account or device coverage.

## Evidence and promotion

Keep the browser profile, saved state, and any raw captures local. Disable HAR and storage-state export unless that separate capture is explicitly authorized. Do not include cookies, tokens, account identifiers, chat text, attachment contents, or billing details in PR logs.

The existing fixture capture and scrubber can prepare regression evidence if the owner authorizes local record capture. Scrubbing email addresses and phone numbers alone does not remove private conversation text: review every retained value before sharing. Label a fixture derived from a real run with its actual provenance; keep the existing synthetic fixtures labeled synthetic. Never relabel a mock as a live pilot.

Before removing the publish exclusion, confirm that the export and live Claude profiles build one valid source declaration, that both artifacts verify and load in isolation, and that their shared stream contracts agree. Recheck a trial merge with current main, published artifact version bumps, the full connector suite, generated metadata, historical contracts, and manifest schemas. Set the public lifecycle tier to match the evidence and record the remaining coverage limits in the PR. Do not infer `supported` from green local checks.
