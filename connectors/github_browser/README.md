# GitHub browser record contract

This profile keeps the six legacy stream envelopes: `profile` fields, `repositories`,
`starred`, `events`, `contributions`, and `history`. Each record also has a top-level
`id` of `<username>:<stream>`. The ID is the PDPP record key and the manifest primary
key. It does not change when a snapshot is fetched again. `fetchedAt` remains an
observation time in the envelopes that already had it.

The array streams are snapshots under one key per user and stream. Their list items
keep the legacy field names and item IDs. The `profile.repositoryCount` field is the
number displayed on GitHub, which can differ from the collected repository list
length. Consumers that read the legacy envelope should ignore the added top-level
`id`; PDPP consumers must retain it for filtering and upserts. No downstream adapter
is changed in this repository, so a live adapter read remains to be verified.

Repository and starred snapshots need a recognized list or explicit empty message,
and the collector follows GitHub's next link until it ends. Contributions require
count evidence for every date in the covered views. Search history requires GitHub
to report complete results with a consistent total count. Otherwise the stream
emits `SKIP_RESULT` and no completion state.


The contract is checked against main at
`2817254df4c097a8002cc7f7716c3fe6c494ace7`: all six existing streams keep their
aggregate envelopes and snapshot primary keys. Partial runs retain readable rows
in that same envelope and emit `SKIP_RESULT`, without `STATE` or full-scan
`DETAIL_COVERAGE`. Missing mapped fields are omitted rather than fabricated as
zero, empty strings, empty arrays, or null. Consumers must not interpret omitted
fields or a partial snapshot as evidence of source deletion.

A full 300-event window and a search total at or above 1,000 are partial. Counts,
schema acceptance, or reaching a request cap cannot establish completeness.
Inventory continuations must remain on the same unfiltered selection. Blocked
pages veto profile, inventory, and contribution ingestion before valid-looking
chrome or calendar cells are considered.

The session probe and collection bootstrap both accept GitHub's signed-in
`user-login` metadata on the dashboard; profile-only nickname chrome is not a
dashboard requirement. Collection still checks the exact homepage navigation and
known blocking evidence. Synthetic checks cover this parity; a live signed-in
session and downstream Personal Server/OpenPet behavior remain unverified.
