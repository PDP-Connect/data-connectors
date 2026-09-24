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
