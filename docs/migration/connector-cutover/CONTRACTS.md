# Connector hard cutover: contract decisions

Status: lead decisions for the cutover integration branch. The per-scope mapping is in [`capability-map.json`](capability-map.json). A lane that finds evidence against a decision must stop and file a contract-change request in its report. It must not invent a local answer.

Base: `main` at `20bba85`.

## End state

- `connectors/<key>/` at the repository root is the only home of PDPP Collection Profile implementations. It holds the code, `manifest.json`, icon, tests, and reviewed scrubbed fixtures.
- `packages/polyfill-connectors` holds only the reusable runtime, libraries, and dev tools. It holds no connector-specific code.
- The legacy Playwright format is removed: `*-playwright.{js,json}`, `registry.json`, the legacy runner, skills, scripts, and workflows. `scope-catalog.json` is generated from PDPP manifests.
- No alias loader, dual discovery, or compatibility runtime exists. A legacy identifier that changed is recorded only as data in the capability map.

## Decisions

**D1. Identity.** The connector key is the single identity. It is used for the directory, the manifest `connector_key`, the OCI name (`ghcr.io/pdp-connect/connector/<key with _ as ->`), and the public scope prefix. The public scope ID is `<connector_key>.<stream>`. The existing keys are already published to GHCR, so they are kept. The legacy source IDs map as follows:

| Legacy source | Connector key | Reason |
|---|---|---|
| `claude` | `anthropic` | Published key. `claude_code` is a separate source. |
| `instagram` (two legacy connectors) | `meta` | Published key. One connector covers instagram.com and the Accounts Center ads surfaces. A future Facebook source is a different key. |
| `shop` | `shopify` | Published key. |
| `youtube` | `youtube` (new) | Unchanged. |
| `icloud_notes` | `icloud_notes` (new, OCI `icloud-notes`) | Unchanged. The name states the acquisition surface (iCloud web), unlike the local `apple_*` connectors. |

The capability map records every legacy-to-new scope change. That record is the explicit migration marker that `HC-COMPAT-SOURCE-ID-001` requires. Downstream impact: Vana Desktop must key grants and preferences on the new scope IDs, and the catalog major version increments. Connector code does not depend on D1. If Tim chooses legacy public source IDs, only the catalog projection changes.

**D2. Stream names** use snake_case. Legacy camelCase scopes become snake_case streams, for example `playlistItems` → `playlist_items`, `watchLater` → `watch_later`, and `savedTracks` → `saved_tracks`. Existing modern stream and field names stay unchanged, so published names do not churn.

**D3. Record granularity.** Legacy scopes emitted one aggregate document. A PDPP stream emits one RECORD per entity, each with a `primary_key`.
- A nested array whose elements have their own identity becomes a child stream with a parent foreign key. Examples: messages, order items, playlist items, post likes.
- A nested array without its own identity stays an array field. Examples: `line_item_titles` and `fare_breakdown`.
- Envelope counters and totals (`total`, `totalItems`, `coverage`, `source`) are not records. Report them as PROGRESS or run evidence.

**D4. Values.**
- Money is an integer in minor units (`*_cents`) plus `currency`.
- Distance is in meters and duration is in seconds.
- Timestamps are ISO-8601 in `*_at` fields, unless the manifest already uses `*_time`.
- A partial date is a string at source precision (`YYYY`, `YYYY-MM`, or `YYYY-MM-DD`). Do not invent a day or a time.
- Do not keep a display string beside the parsed value. An unparseable value is `null`, reported as a shape anomaly, and never guessed.

**D5. Uber receipts** stay a separate stream. `trips` holds list-level fields. `receipts` is 1:1 with trips (`primary_key: ["trip_id"]`) and holds the per-trip detail and `fare_breakdown`. A trips-only grant must not pay for N detail fetches. Declare the dependency with the Collection Profile checkpoint-dependency fields.

**D6. Meta.** One connector and one browser profile. `ads` is one stream with `kind` ∈ {`advertiser`, `ad_topic`, `ad_category`}. Its `id` is the native ID when one exists, else a stable hash of `kind|name`. `following` must be complete (the legacy cap was 1000) or must report honest coverage. Liker lists become `post_likes`.

**D7. LinkedIn** adds the `languages` and `connections` streams. Experience and education dates follow D4.

**D8. Whole Foods.**
- `profile` stays, because the scope is advertised. It holds the name and email of the Amazon account used for the orders.
- `nutrition` is a typed stream keyed by `product_id` and replaces the untyped `order_items.nutrition`. The sources are the Whole Foods product page first, then USDA FDC. A USDA key is an optional manifest option, with `DEMO_KEY` rate limits stated.
- Amazon session code that `amazon` and `wholefoods` both need moves into the runtime library (`src/auto-login/amazon.ts` or a sibling). A connector never imports another connector.

**D9. YouTube** is a manual import of a Google Takeout "YouTube and YouTube Music" export. Google browser scraping is out of scope unless the real export lacks a scope and a recorded decision approves a narrow fallback. The watch-history parser is one library module shared with `google_takeout.youtube_watch_history`.

**D10. Shop** is implemented from contract and fixtures. It stays `development` until independent live evidence exists.

**D11. Lifecycle tier.** Every new or rewritten connector ships as `development`. Promotion requires the full proof gate below, including a fresh live run. Legacy "stable" does not transfer.

**D12. Unregistered legacy code** (`tinder`, `goodreads`, and the legacy Playwright `_conformance`) is not an advertised capability. It is deleted at the hard cut and recorded in the capability map.

## Layout during the parallel phase

Connector lanes work in the current layout: `packages/polyfill-connectors/connectors/<key>/` and `manifests/<key>.json`. The `cut-mechanics` lane owns the scripted, re-runnable move to root `connectors/<key>/`. The move runs once at the hard cut, after every replacement is proven. This avoids a moving target for the connector lanes and keeps the move reviewable as one deterministic diff.

## Per-connector proof gate

1. Every legacy scope maps to explicit streams in the capability map, or to a documented, versioned break.
2. Parser and normalizer tests use real captures. The captures are scrubbed and reviewed, and they come from a source independent of the implementation. Synthetic unit fixtures are labeled synthetic and do not count.
3. START, RECORD, STATE, and DONE are proven, including scope filtering. A stream absent from `scope.streams` emits nothing. `fields`, `time_range`, and `resources` are honored or produce `SKIP_RESULT` with `scope_not_supported`.
4. Two-run scenario replay passes, with a negative control that fails when it should. This uses the tooling in PR #81 when it is available.
5. One fresh live-account run, when an account exists.
6. The OCI artifact builds, and an independent verification of it passes.
7. The manifest lifecycle tier matches the evidence.

## Private data

Raw captures, HAR files, export archives, and browser profiles stay under `/home/tnunamak/.tmp/connector-cutover-0922/private/` (mode 700, outside git). Header redaction does not make a HAR body safe. Commit only reviewed, scrubbed fixtures under the existing `fixtures/<key>/scrubbed/pilot-real-shape/` convention.
