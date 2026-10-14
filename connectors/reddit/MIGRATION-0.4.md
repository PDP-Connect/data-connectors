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
cursor. Capped walks report deferred work and do not write `STATE`.

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

## Known gaps

- No tombstones: an item removed from `saved` / `upvoted` / `downvoted` /
  `hidden` (un-save, un-vote, un-hide) is not deleted from the stored stream.
  This remains a separate follow-up.
- `saved`, `upvoted`, `downvoted`, and `hidden` contain membership state. The
  content/stats split does not change how removal from those lists is handled.
