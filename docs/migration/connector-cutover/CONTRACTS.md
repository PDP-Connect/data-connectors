# Connector hard cutover: contract decisions

Status: lead decisions for the cutover integration branch. The per-scope mapping is in [`capability-map.json`](capability-map.json). A lane that finds evidence against a decision must stop and file a contract-change request in its report. It must not invent a local answer.

Base: `main` at `20bba85`.

## Release model (Tim, 2026-09-22): one coordinated hard cut

- This branch is the review and prep branch for ONE final cut. There is no additive intermediate merge.
- Until the cut lands, main keeps legacy fulfillment and every published public scope. The cut lands only after connector-side data parity is finite (feasible gaps fixed, irretrievable source omissions documented) and the Vana-owned adapter exists.
- Release order: (1) the Vana adapter release; (2) the data-connect vendored-sources and generated-definitions update merges first, pinned to this branch's final sources; (3) the hard-cut merge here (a merge commit), which publishes artifacts; (4) one Vana Desktop smoke. Publishing changed artifacts before the vendor update merges is not allowed.
- YouTube stays at `development` and does not block the cut.

## End state

- `connectors/<key>/` at the repository root is the only home of PDPP Collection Profile implementations. It holds the code, `manifest.json`, icon, tests, and reviewed scrubbed fixtures.
- `packages/polyfill-connectors` holds only the reusable runtime, libraries, and dev tools. It holds no connector-specific code.
- The legacy Playwright format is removed: `*-playwright.{js,json}`, `registry.json`, the legacy runner, skills, scripts, and workflows. This happens only for scopes whose replacement parity is proven and whose Vana-owned binding exists.
- `scope-catalog.json` and `SCOPES.md` are Vana DPv2 contracts. They are NEVER regenerated from PDPP manifests, in any phase: they are frozen with their exact IDs and shapes, or handed over to the Vana owner. Public bindings and projectors are Vana-owned.
- No alias loader, dual discovery, or compatibility runtime exists. A legacy identifier that changed is recorded only as data in the capability map.

## Decisions

## Ownership boundary: public DPv2 scopes are out of scope for this repo (Tim, 2026-09-22)

Flat `platform.scope` strings (for example `claude.conversations` and `instagram.profile`) are Vana DPv2 compatibility vocabulary. This repository does not own, rename, bind, or project them:

- No Vana legacy DCR scope bindings, public-scope projection code, `scope-bindings.json`, or new `scope-catalog.json` fulfillment fields land in PDP-Connect/data-connectors.
- The Vana stack owns the compatibility implementation, likely a shared `unity-surfaces` package used by app.vana.org, Desktop, and the embedded Personal Server runtime, which consume one generated contract. Context Gateway (ODL's commercial wrapper) does not own or define it, and Vana takes no dependency on Context Gateway. Data Gateway remains the issued-grant ledger, not the owner of connector fulfillment.
- Vana derives the protected scope set from production issued-scope records (Context Gateway `connect_sessions.canonical_scopes` as evidence, and Data Gateway `grants.scopes` / `grant_registration_history.scopes`), not from all 54 catalog entries.
- This repo keeps only connector-side evidence: which PDPP connector streams and fields can produce each legacy payload. That evidence lives in the cutover report, not in product code here.
- The cutover does not rename any published scope ID. The fate of the legacy-derived `scope-catalog.json` and `SCOPES.md` (Vana DPv2 vocabulary that currently lives here) is an open decision: hand them over to the Vana owner, or freeze them. They must not be deleted while consumers pin them.

**D1. Identity.** The connector key (`anthropic`, `meta`, `shopify`, `youtube`, `icloud_notes`, ...) is the PDPP implementation identity: directory, manifest `connector_key`, and OCI name. It is not a public DPv2 scope prefix. The earlier proposal to rename public scopes (`claude.*`→`anthropic.*`, etc.) is WITHDRAWN (see the ownership boundary above).

**D2. Stream names** (internal PDPP streams) use snake_case. Legacy camelCase scopes become snake_case streams, for example `playlistItems` → `playlist_items`, `watchLater` → `watch_later`, and `savedTracks` → `saved_tracks`. Existing modern stream and field names stay unchanged, so published names do not churn.

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

During parallel porting, connector lanes used `packages/polyfill-connectors/connectors/<key>/` and `manifests/<key>.json`. The hard cut moved each implementation and manifest to root `connectors/<key>/`. That root directory is the current source layout.

## Per-connector proof gate

1. Every legacy scope maps to explicit streams in the capability map, or to a documented, versioned break.
2. Parser and normalizer tests use real captures. The captures are scrubbed and reviewed, and they come from a source independent of the implementation. Synthetic unit fixtures are labeled synthetic and do not count.
3. START, RECORD, STATE, and DONE are proven, including scope filtering. A stream absent from `scope.streams` emits nothing. `fields`, `time_range`, and `resources` are honored or produce `SKIP_RESULT` with `scope_not_supported`.
4. Two-run scenario replay passes, with a negative control that fails when it should. This uses the tooling in PR #81 when it is available.
5. One fresh live-account run, when an account exists.
6. The OCI artifact builds, and an independent verification of it passes.
7. The manifest lifecycle tier matches the evidence.

## Private data

Raw captures, HAR files, export archives, and browser profiles stay in a private directory outside git (mode 700) on the operator's machine. Header redaction does not make a HAR body safe. Commit only reviewed, scrubbed fixtures under the existing `fixtures/<key>/scrubbed/pilot-real-shape/` convention.
