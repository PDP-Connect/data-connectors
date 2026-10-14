# Reddit connector 0.4.0: content / current-stats split

Breaking change for consumers of the Reddit streams. Manifest `0.3.13` →
`0.4.0`.

## What changed

Volatile source metrics moved out of the content streams into per-parent
`*_stats` streams. Both records use the same Reddit fullname (`id`).

| Content stream | Removed fields | New stats stream | Stats fields |
| --- | --- | --- | --- |
| `submitted` | `score`, `num_comments`, `upvote_ratio`, `gilded` | `submitted_stats` | same four |
| `comments` | `score`, `gilded` | `comments_stats` | same two |
| `upvoted` | `score`, `num_comments` | `upvoted_stats` | same two |
| `downvoted` | `score`, `num_comments` | `downvoted_stats` | same two |
| `hidden` | `score`, `num_comments` | `hidden_stats` | same two |
| `saved` | none | none | |

Stats records also carry `created_utc`, the item's creation time. It is not a
measurement time. When a value was read is run metadata (`emitted_at`,
freshness), not a field. `range_filters` on `score` / `num_comments` moved to
the stats streams. Stats streams declare `count` aggregation only.

## Consumer migration

- A query that filtered or sorted `submitted` by `score` now queries
  `submitted_stats` by `score`, then uses each row's `id` to look up title or
  text in `submitted`. This is two queries. Do not assume the API supports a
  cross-stream SQL join. The same applies to the other four content/stats
  pairs.
- A grant that reads score data needs the matching `*_stats` stream added.
- Stats streams are optional (`required: false`) and need a matching grant.
  Shared listing or runtime failures may still fail the run. This release adds
  no separate failure isolation for stats.

## Refresh and storage limits

Each requested stream walks the currently listed observations from the
beginning on every run, up to 100 pages. A combined content/stats request uses
one listing walk. This also revisits observations below any old creation-time
cursor. A walk that reaches the 100-page limit has not seen the end of the
listing. It reports a stream failure for each requested output, and the run
ends as failed (`stream_collection_failed`, not retryable because the next run
hits the same limit). Records already read in that run stay offered. No `STATE`
is written. Every run restarts from the newest item, so items beyond the limit
are not guaranteed to be collected. A listing that ends exactly at page 100
completes normally.

The connector emits the current payload for every observation it reaches. It
does not persist a repair marker or an unchanged-record fingerprint. This
means an old payload can be offered again on later runs, including after an
earlier partial attempt. It does not prove that the host accepted or stored
each record. Therefore this release does not guarantee that every stored
legacy payload has been replaced. Records not returned by Reddit, including
items outside the 100-page cap, are not visited. The same caveat applies when
only stats are requested: that run does not refresh content records.

At data-connect commit `36380c838426a13acacfc3f4696aa9bbf93a2481`,
`records.ts` serializes the full incoming `data` object for the SQLite upsert,
and `postgres-records.ts` assigns `EXCLUDED.record_json` on Postgres upsert.
These source paths replace the record JSON on an accepted upsert. They do not
establish that a particular record was accepted in a real run. No live
database or external consumer was tested for this change. Re-emitting
unchanged rows may create version history according to host behavior; this
release does not promise to eliminate all version history.

## Before you accept this release: preserve legacy metrics

The 0.4.0 content streams no longer carry `score`, `num_comments`,
`upvote_ratio`, or `gilded`. Accepting a content replacement can erase those
values already stored on legacy content rows.

- A grant that upgrades to 0.4.0 but only requests content streams (for
  example `submitted` without `submitted_stats`) can lose its legacy counters
  without ever collecting replacements. The connector does not expand grants
  automatically.
- Authorize the matching `*_stats` streams and query the stats streams BEFORE
  you accept content replacement. Export any legacy metrics you need to keep
  first.
- Stats acceptance can fail after a content stream was accepted, or the
  reverse. That leaves a content row and a stats row temporarily unmatched.
  Treat an unmatched pair as incomplete, not as a deletion.
- Source items that Reddit no longer lists, and items beyond the 100-page
  limit, are never visited. Their historical metrics cannot be recovered from
  this connector.
- This release does not guarantee lossless migration.

## Request all fields: field subsets are not supported

No Reddit output supports a restricted field list (`selection.fields` is
`false` in the manifest for every Reddit stream). A START request that names a
proper subset of an output's fields is refused. Absent `fields`, or a list that
names every field of the output, works as before.

Why: the host replaces the whole stored row with each record it accepts. It
does not merge partial records. A record cut down to a few fields would drop
the other current fields from the stored row, and a later full run would
restore them as new row versions. Reddit therefore fails the run instead of
emitting a cut-down record.

What a refused request does:

- The run fails (`stream_collection_failed`, not retryable) before any
  listing is fetched. No record, `STATE` or coverage claim is written.
- The check covers the whole request. If one requested output asks for a
  subset, no output of that request writes anything, including outputs that
  asked for all fields.
- Unreadable `fields` values (null, an empty list, a non-list, non-text
  entries) are refused as well, because reading them as "all fields" could
  widen the request without the owner's say.
- The failure text names the stream, never the requested field names or any
  item data.

This is a limit, not a migration path. It does not resume partial tails, does
not make the metric migration lossless, and does not change the 100-page
rule. To read only some columns, request all fields and select them in the
consumer.

## Known gaps

- No tombstones: an item removed from `saved` / `upvoted` / `downvoted` /
  `hidden` (un-save, un-vote, un-hide) is not deleted from the stored stream.
  This remains a separate follow-up.
- `saved`, `upvoted`, `downvoted`, and `hidden` contain membership state. The
  content/stats split does not change how removal from those lists is handled.
