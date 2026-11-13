# Connector authoring guide

This guide is the reference for connector authors. It holds the contracts, rules and patterns to look up while you write a connector in `connectors/<key>/`. [AUTHORING.md](../../../AUTHORING.md) holds the command sequence (scaffold, dev run, scenario capture and replay, `claim.json`, `conformance`). The wire protocol is in [the Collection Profile](../../../docs/spec/collection-profile.md). The runtime entry points and known gaps are in [the runtime note](collection-profile-runtime.md). This guide covers the code between those layers.

Run `bin/...` commands from the repository root with the full path `packages/polyfill-connectors/bin/...`. Connector source and fixture paths are relative to the repository root.

## The entry point: `runConnector()`

Every connector is one call to `runConnector()` from `packages/polyfill-connectors/src/connector-runtime.ts`. The runtime owns the protocol handshake (START, RECORD, STATE, SKIP_RESULT, PROGRESS, DONE), the browser lifecycle, tracing, fixture capture, retryable-error detection and the terminal exit. The connector owns collection logic, which covers what to fetch, how to shape records and what to store as cursor.

```ts
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { validateRecord } from "./schemas.ts";

runConnector({
  name: "notion",
  validateRecord,
  retryablePattern: /ECONN|fetch failed|rate_limited/i,
  async collect({ scope, state, requested, emit, emitRecord, progress, sendInteraction, emittedAt }) {
    // collection logic only
  },
});
```

A browser connector adds `browser: { profileName }`, `ensureSession` and optionally `probeSession`:

```ts
runConnector({
  name: "amazon",
  validateRecord,
  browser: { profileName: "amazon" },
  async ensureSession({ context, page, sendInteraction }) { /* ... */ },
  async collect({ page, scope, state, emitRecord, capture }) { /* ... */ },
});
```

The runtime passes these values to `collect()`:

| param | what it is |
|---|---|
| `scope` | the `START.scope` object |
| `state` | the stream-keyed state map from `START.state` |
| `requested` | `Map<streamName, streamScope>` built from `scope.streams`; test `requested.has("orders")` before work for a stream |
| `emit` | `(msg) => Promise<void>`; raw emit for STATE, PROGRESS and SKIP_RESULT |
| `emitRecord` | `(stream, data) => Promise<void>`; filters, validates and counts a record. A record that fails `validateRecord` becomes a SKIP_RESULT with reason `shape_check_failed` |
| `progress` | `(message, extra?) => Promise<void>`; emits PROGRESS |
| `sendInteraction` | `({ kind, message, schema?, timeout_seconds? }) => Promise<response>`; the runtime fills `type` and `request_id`. `kind` is one of `credentials`, `otp` and `manual_action`, and the manifest declares each one in `capabilities.human_interaction` |
| `reportStreamFailure` | `(stream, message, options?) => Promise<void>`; reports one stream's failure while independent streams finish. The terminal DONE becomes `failed` |
| `capture` | `null` unless `PDPP_CAPTURE_FIXTURES=1` or `PDPP_CAPTURE_ON_FAILURE=1`; otherwise exposes `captureDom(page, label)`, `captureHttp(label, body, meta)` and `captureLocatorProbe(page, label, probes)` |
| `emittedAt` | one ISO timestamp for the run; put it on every record that needs a collection time |
| `page`, `context` | present when `browser` is set |

The runtime owns protocol plumbing, so a connector does not read `process.stdin`, wrap stringify and emit, call `flushAndExit` or write `main().catch`. A protocol need that the runtime does not meet is a change to the runtime.

`retryablePattern` is a regular expression matched against a failure message. A match sets `retryable=true` on the terminal DONE. The default is `/ECONN|ETIMEDOUT|timeout/i` (`DEFAULT_RETRYABLE_PATTERN` in `packages/polyfill-connectors/src/session-establish.ts`). Extend it for transient network, 5xx and 429 failures. Failures from layout changes or rejected credentials stay non-retryable.

## File layout and structure

```
connectors/<key>/
├── index.ts              runConnector({...}), guarded by isMainModule
├── parsers.ts            pure functions, imported by index.ts and tests
├── types.ts              record shapes and cursor types
├── schemas.ts            Zod schemas and validateRecord
├── manifest.json         streams, schemas, bindings, query declarations
├── parsers.test.ts       node:test, table-driven, synthetic input
├── integration.test.ts   collect() invariants (emit order, scope filtering, cursor advance)
├── __fixtures__/         hand-written HTML and JSON, committed
├── fixtures/             captured and scrubbed runs; see §9.1
└── scrub-rules.ts        connector-specific scrub patterns (optional)
```

`packages/polyfill-connectors/AGENTS.md` lists the lint rules that tooling enforces (no `any`, no `@ts-ignore`, no non-null assertions, cognitive complexity of at most 20 per function). Local imports carry explicit `.ts` extensions.

### Guard the bootstrap with `isMainModule`

When tests import `index.ts`, wrap the `runConnector` call so the runtime does not start at import time and block on the stdin handshake:

```ts
import { isMainModule } from "@pdpp/connector-protocol";

if (isMainModule(import.meta.url)) {
  runConnector({ /* ... */ });
}
```

Running the file directly (`tsx connectors/<key>/index.ts`) still starts the runtime.

### Decompose `collect()` when it passes complexity 20

1. Move pure parsers to `parsers.ts`. A parser takes data and returns data, with no `page`, no client and no I/O.
2. Bundle the shared dependencies into one interface, for example `EmitDeps { capture, emit, emitRecord, emittedAt, wantsItems, wantsOrders }`.
3. Split `collect()` into one async helper per stream. Each helper takes `EmitDeps` and the least other context it needs. `connectors/gmail/index.ts`, `connectors/amazon/index.ts` and `connectors/usaa/index.ts` show the pattern.

## Connector options

A connector declares owner-facing options in `options_schema` in its manifest.

1. Name each property after an environment variable. `connectors/claude_code/manifest.json` declares `CLAUDE_CODE_PROJECT_INCLUDE`. Each property carries a type, a description and a default.
2. Read the options with `readOptions(startMsg, { envPrefix, fields })` from `packages/polyfill-connectors/src/connector-options.ts`. It takes each field from `START.connector_options`, then from the environment variable `<envPrefix><FIELD>`, then from the field's default.
3. Give each field one parser: `int`, `bool`, `csv` or `string`.
4. Keep credentials out of options. They use the credential path.

Each option has a kind. The platform decides the kind in `packages/polyfill-connectors/src/connector-config-option-kind-registry.ts`.

1. A `collection_scope` option changes what the connector collects, for example which projects or folders it reads. It stays inert until the owner confirms it, so the owner approves every change in scope.
2. A `transport` option changes only how the connector runs, for example a timeout or a file skip list. It takes effect without confirmation.
3. An option that the registry does not list is a `collection_scope` option.
4. `declared_option_kind` in a manifest is a claim. A test checks it against the registry.

`connector-dev`, `scenario-record` and `scenario-verify` each load `.env.local` at the repository root and start the connector with their own process environment.

1. Set the same option variables for all three commands, in `.env.local` or exported in the shell.
2. A replay with different option values than the capture runs a different collection than the scenario recorded.

## Standard dependencies

Use these libraries; the connector package declares them in `packages/polyfill-connectors/package.json`.

1. `patchright` is the stealth-patched Playwright drop-in that the launcher imports. Open a persistent context with `viewport: null`.
2. Leave the user agent, the extra browser headers and the Chromium flags that Patchright manages alone.
3. Pass extra Chromium flags only through the operator variable `PDPP_BROWSER_EXTRA_ARGS`.
4. Local macOS runs use Google Chrome, so install or update it before collecting. `PDPP_BROWSER_CHANNEL=<value>` selects another channel.
5. `zod` validates records. Each connector exports one schema per stream in `schemas.ts` (see §3).
6. `p-retry` retries transient network, 5xx and 429 errors with exponential backoff and jitter. Throw its `AbortError` for a failure that must not retry.
7. Playwright tracing is on when `PDPP_TRACE=1` or when fixture capture is on. A trace goes to `/tmp/<name>-<timestamp>.zip`, or to `<capture dir>/traces/<name>-<timestamp>.zip` when capture is on. `<name>` is the `name` passed to `runConnector`.
8. The runtime deletes the trace of a clean run. It discards the trace of any run that registered a credential, because a trace records the arguments of every fill action.

Use a shared helper in `packages/polyfill-connectors/src/` before you write your own. `createConnectorHttpGovernor` (`src/connector-http-governor.ts`) paces HTTP requests and `buildFullScanCoverageMessage` (`src/connector-runtime.ts`) builds coverage messages.

---

## 0. Browser architecture (for scrapers)

A browser connector declares only `browser: { profileName }`. The runtime calls `acquireBrowserForConnector()` from `packages/polyfill-connectors/src/browser-launch.ts`. It attaches to the deployment's managed browser when one is configured. Otherwise it calls `acquireIsolatedBrowser({ profileName })`, which:

1. launches system Chrome on macOS and Patchright's bundled Chromium on other platforms, unless the operator selects a channel.
2. keeps a persistent profile directory at `PDPP_BROWSER_PROFILE_ROOT/<connector>/` (default `~/.pdpp/profiles/<connector>/`), so cookies, local storage and trusted-device state persist across runs of that connector.
3. isolates each connector in its own profile, so connectors share no cookies and no fingerprint.
4. runs several connectors concurrently, one browser process each, with no lock file.

The deployment owns headed or headless mode. Local sessions run headed; `PDPP_BROWSER_HEADLESS=1` selects headless. In a container, a headed launch fails with an error unless the container has a managed display (`PDPP_RUNTIME_BROWSER=1` and `DISPLAY`) or the operator sets `PDPP_ALLOW_HEADED_CONTAINER_BROWSER=1`.

`profileName` defaults to the connector name, which gives one account per connector.

Use a plain HTTP client (`fetch` with session cookies from a stored file) when the connector makes a few HTTP calls behind a session and drives no UI. Use the isolated browser when the connector drives a UI.

### 0a. Browser connector scaffold

The browser scaffold (step 1 of [AUTHORING.md](../../../AUTHORING.md#steps), with the `--browser` option) creates a browser-session connector that follows `connectors/github_browser/index.ts`. It sets these defaults.

1. The manifest declares the `browser` and `network` bindings and `capabilities.human_interaction: ["manual_action"]`, and declares no `auth` block, because the connector signs in through the owner's browser profile.
2. `index.ts` passes `browser`, `ensureSession`, `probeSession`, `probeSessionIsAuthoritative: true` and `collect` to `runConnector`. The session probe loads `LOGIN_CHECK_URL` and waits for `LOGIN_CHECK_SELECTOR`. When the probe fails, `manualBrowserLogin` (`src/browser-handoff.ts`) hands the sign-in to the owner.
3. `LOGIN_CHECK_URL`, `LOGIN_CHECK_SELECTOR`, `LISTING_URL`, `ROWS_CONTAINER_SELECTOR` and `ROW_SELECTOR` start as `TODO` placeholders. `requireConfigured()` throws a named error when a run reads a placeholder. Set every placeholder before the first run.
4. The manifest declares `protocol_version: "0.2.0"`, `protocol_capabilities: ["OBSERVATION"]` and `diagnostic_descriptors`.
5. `index.ts` passes `protocolCapabilities: ["OBSERVATION"]` and routes the session check and the rows-container check through `waitForElementExpectation` (`src/auto-login/locator-helpers.ts`).
6. A missing or hidden rows container fails the run with an `expectation_mismatch` fact that `bin/diagnose.ts` can read. A present container with no rows is a valid empty result.
7. A configured `ROW_SELECTOR` that matches nothing also looks like an empty list, so check the selector against a real page.
8. `bin/connector-doctor.ts` checks Node, installed dependencies, the browser, the display, `.env.local` at the repository root and the profile directory before a real browser run.

A scaffolded connector has `public_listing.tier: "development"`. Publication is gated by `CONNECTOR_PUBLISH_INVENTORY` in `scripts/connector-publish-allowlist.mjs`, which lists every connector with its publish policy. Check that the connector has the intended entry there.

---

## 1. Sources of ground truth, ranked

Choose the data source in this order:

1. Official API (OAuth, API key or equivalent), which is stable, versioned and contract-respecting. Examples are `ynab` and `oura`.
2. Archive or compliance export ("download your data"), which has high latency and is stable and complete. Examples are `google_takeout` and `twitter_archive`.
3. Structured web endpoints, the JSON that the site's own front end consumes. The shape changes rarely.
4. HTML scrape, which depends on locale and A/B tests and sits close to the platform's terms of service. Examples are `amazon`, `chase` and `usaa`.

When one stream can come from an API and from a scrape, decide which source wins on conflict before you write either path (see §4 on record keys).

---

## 2. For scrapers, structure over text

Regular expressions over concatenated `innerText` are the most common source of connector breakage. Text depends on locale, A/B tests and accessibility settings; structure does not.

Select elements in this order:

1. Stable structural attributes: `id`, `data-component`, `data-testid`, `data-automation-id`, ARIA roles. They are English identifiers in code, whatever the page language.
2. Stable CSS classes, which are less durable than attributes and often last for years.
3. Semantic hierarchy. Walk up from a known anchor (an item's `<a href="/dp/...">`) to the nearest structural parent.
4. Visible text, only when none of the above exists.

Avoid these patterns:

1. Regular expressions over the `innerText` of a large container. "Grand Total: $12.34" does not exist on a German page.
2. Card-brand lists (`Visa|Mastercard|Amex`). Match the structure instead, a `<span>` that ends in digits.
3. Line-based parsing (`text.split("\n")[3]`), because whitespace changes across browsers and locales.
4. A leading-digit regular expression for a quantity. A product title that starts with a digit then reads as a quantity. Select the quantity element (`.od-item-view-qty span` in `connectors/amazon/parsers.ts`).
5. A flat-DOM assumption. A site built on web components with shadow roots needs locators that pierce them (`getByRole`, or `text=` selectors).

```js
// Fragile: text regex
const shipMatch = summaryBox.innerText.match(/Ship to\s+(.+?)\s+Payment method/i);

// Better: structural lookup
const shipBlock = summaryBox.querySelector('[data-component="shipTo"]');
const shipping_address = shipBlock?.innerText.trim() || null;

// Best: field-specific children
const recipient_name = shipBlock?.querySelector(".recipient")?.innerText.trim() || null;
const street = shipBlock?.querySelector(".line1")?.innerText.trim() || null;
```

Locale does not change `data-component` values or class names.

To design a selector from a real page, capture the ARIA tree and locator probes (see §9.1, "Using captures to improve selectors").

---

## 3. Fail loud, fail null, never fail wrong

A connector never emits a record that looks right and is wrong. A null field is a clear signal. A string that looks like a recipient and is a parsing artifact poisons every consumer.

You cannot run a new connector against a new user's account ahead of time. Tight shape assertions replace that test, because a connector that works on your account and asserts tight shapes either works on another account or fails visibly.

### One Zod schema per stream, validated before emit

1. Define the schemas in `schemas.ts`, next to `index.ts`.
2. Build `validateRecord(stream, data)` with `makeValidateRecord(SCHEMAS)` from `packages/polyfill-connectors/src/schema-registry.ts`. It returns `{ ok: true, data }` or `{ ok: false, issues }`.
3. Pass it to `runConnector`. `emitRecord` runs it and converts a failure into a SKIP_RESULT.
4. A record whose only defect is a value outside an open vocabulary (an enum that the source extended) is kept and reported as a shape anomaly. Any other fault skips the record.

`connectors/amazon/schemas.ts` is the canonical example.

```ts
export const orderSchema = z.object({
  id: z.string().min(5).max(40),
  recipient_name: pdppSafeText.min(2).max(80)
    .refine((s) => !/[$\t\n]|Buy it again/i.test(s), { message: "cruft" })
    .nullable(),
  payment_method_summary: pdppSafeText
    .refine((s) => !/Unable to display|\$\d/i.test(s), { message: "non-answer" })
    .nullable(),
  order_total_cents: z.number().int().min(0).max(10_000_000).nullable(),
});
```

### Schema wiring is a build-time rule

`validateRecord` is optional in the `runConnector` type, because the runtime has no Zod dependency. Authoring policy requires more, namely that a connector whose manifest declares any stream wires `validateRecord`, or appears in `SCHEMALESS_CONNECTOR_ALLOWLIST` in `packages/polyfill-connectors/src/connector-schema-allowlist.ts` with a justification.

`packages/polyfill-connectors/src/connector-schema-validation-honesty.test.ts` enforces this in `npm test` and in CI. A connector with manifest streams, no `validateRecord` and no allowlist entry fails the build by name. The allowlist can only shrink, so when you add `schemas.ts` to a listed connector the test requires you to delete its entry. A new allowlist entry is a reviewed exception, and a new connector validates.

---

## 4. Naming and schema discipline

1. Record keys are stable across runs. Use the platform's canonical ids (ASIN, order id, message id, the platform's own timestamp key). Do not embed wall-clock time, random ids generated at scrape time or hashes of volatile content.
2. Record keys are unique within a stream. A second record with the same key upserts the first.
3. A nullable field holds `null` when the value is unknown. Do not use `""`, `"unknown"` or the platform's "Unable to display".
4. A boolean holds `true`, `false` or `null`. `null` means unknown and `false` means confirmed no. Do not use `"yes"` or `0`/`1`.
5. Currency amounts are integers in the smallest unit (cents). Put the raw display string in a parallel `*_display` field when it helps debugging.
6. Timestamps are ISO-8601 strings and dates are `YYYY-MM-DD`.
7. Stream names are plural nouns in the platform's own vocabulary: `orders`, `messages`, `transactions`.

---

## 4a. Text fields and `pdppSafeText`

Every schema field that holds text (previews, snippets, message bodies, tool-result summaries) holds only text that a Postgres JSONB column can store. That means no U+0000 and no other forbidden control character. Binary or control-rich payloads go to the `blobs` table, and `record_json` holds `null` or a typed reference.

1. At parse time, pass each such value through `safeTextPreview()`. It decides whether a captured value is text or belongs in a blob.
2. In the schema, type the field with `pdppSafeText` (or a type derived from it). It rejects a value with a forbidden character, so a parser that inlined binary content fails validation.

Reasons for the rule:

1. Postgres JSONB rejects U+0000 with SQLSTATE `22P05`. SQLite stores NUL bytes, so a connector that works against SQLite fails in production on the first stray NUL.
2. Binary content belongs in `blobs`, which stores each blob by its sha256 hash. Route the bytes to a blob and set the preview to `null`.
3. A preview is a human-readable summary of at most `PDPP_PREVIEW_MAX_CHARS` (4000) characters. It holds no C0 controls other than `\t`, `\n` and `\r`, no DEL and no C1 controls. `safeTextPreview()` cuts a longer value with a `…` and never splits a surrogate pair.

### Schema-level enforcement

Use `pdppSafeText` instead of bare `z.string()` for every text field in `schemas.ts`. It composes with `.max()`, `.min()`, `.nullable()` and `.optional()`. Both helpers come from `@pdpp/connector-protocol`:

```ts
import { z } from "zod";
import { pdppSafeText, nullablePdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";

const titleSchema = pdppSafeText.max(500).nullable();
const bodyTextSchema = pdppSafeText.max(10_000_000).nullable();
const snippetSchema = nullablePdppSafeText;
const sessionIdSchema = z.string().regex(/^[0-9a-f-]{36}$/); // structural string: the regex is enough
```

Each text field declares its intent: `pdppSafeText` for human-readable text, `z.string().regex(...)` for a structurally constrained string, `z.string().url()` for a URL. Review a bare `z.string()` in a record schema.

### Parse-time pattern

```ts
import { safeTextPreview, PDPP_PREVIEW_MAX_CHARS } from "@pdpp/connector-protocol/safe-text-preview";

export function textPreview(s: unknown, max = PDPP_PREVIEW_MAX_CHARS): string | null {
  return safeTextPreview(s, max).preview;
}

export function payloadOutputPreview(
  output: unknown,
  max = PDPP_PREVIEW_MAX_CHARS,
): { preview: string | null; binaryReason: string | null } {
  let toPreview: unknown = output;
  if (typeof output !== "string" && output !== null && output !== undefined) {
    toPreview = JSON.stringify(output);
  }
  const r = safeTextPreview(toPreview, max);
  return { preview: r.preview, binaryReason: r.kind === "binary" ? r.reason : null };
}
```

`connectors/codex/parsers.ts` and `connectors/claude_code/parsers.ts` show established usage.

### The `_binary_reason` companion field

When a payload can be binary (shell stdout, a tool result, a clipboard capture, an attachment), pair the preview field with a sibling `<field>_binary_reason` field.

| field | type | value |
|---|---|---|
| `output` | text | `safeTextPreview().preview`, or `null` |
| `output_binary_reason` | text | the helper's `reason` string (for example `"U+0000 at offset 342"`) when it returned `kind: "binary"`; otherwise `null` |

1. When `safeTextPreview()` returns `kind: "binary"`, set the preview to `null` and `<field>_binary_reason` to `result.reason`.
2. When it returns `kind: "text"` or `kind: "empty"`, set the preview to `result.preview` and `<field>_binary_reason` to `null`.
3. Send bytes that you want to keep to the `blobs` table (see §12), and never inline them in the record.
4. The reason string is short ASCII diagnostic text that is safe to render.

Three practices break the invariant:

1. Stringifying a `Buffer` into a preview field produces forbidden control bytes.
2. `String(value).replace(/\0/g, "")` hides the binary leak and corrupts real data. Use `safeTextPreview()` and route binary to a blob.
3. A custom truncation helper skips the surrogate-pair and control-character handling, so call `safeTextPreview(value, 200)` instead.

---

## 4b. Search and filter declarations

A readable field is not a queryable field. The reference server acts on what the manifest declares and never infers query behavior from field names. A natural-language field that the manifest does not declare as searchable is invisible to search clients, and a date that the manifest does not declare as range-filterable cannot bound a read. `packages/polyfill-connectors/src/query-affordance-manifest-honesty.test.ts` enforces the declarations.

A stream's `query` block has independent axes. None implies another:

| Axis | Declaration | Enables |
|---|---|---|
| Lexical search | `query.search.lexical_fields: [field, ...]` | keyword match on a string field |
| Semantic search | `query.search.semantic_fields: [field, ...]` | meaning-based match on title, body, note, memo, caption or description text |
| Range filter | `query.range_filters: { field: ["gte","gt","lte","lt"] }` | bounded reads over a numeric or date field |
| Time buckets | `query.aggregations.group_by_time: [field, ...]` | count-over-time charts |
| Facet | `query.aggregations.group_by: [field, ...]` | grouped counts over a stable scalar field |

### Rules for valid declarations

1. `group_by_time` applies to a field whose schema is `{ "type": "string", "format": "date" | "date-time" }`. An integer epoch field (`mtime_epoch`) can use `range_filters`; the aggregate engine rejects it for time buckets.
2. `group_by` and `group_by_time` run as `metric=count`, so the stream declares `query.aggregations.count: true`.
3. A `group_by` field is a single-type `boolean`, `integer`, `number` or `string`. An `enum` fits best. Do not facet free text or high-cardinality identifiers.
4. Declare `group_by_time` on the field that says when the record's event happened, its creation or start time. Secondary state markers (`updated_at`, `closed_at`, `merged_at`, `completed_at`, `last_*`), interval ends (`end_*`), ingest markers (`fetched_at`) and the stream's own `cursor_field` can carry `range_filters` and need no `group_by_time`.
5. `x_pdpp_role` is a field annotation in the manifest that tells clients how to show the field. `x_pdpp_role: event-time` marks the field that a card shows as the record's time. It does not make a field filterable, groupable or searchable. Declare `group_by_time` to chart a message, transaction or metric timestamp. Use the `event-time` role only for a stream that is an event card (a calendar event start, a media capture time). A grant's time range applies to the field that `consent_time_field` names (see the Collection Profile).

### Declared non-support

When a field looks useful for a search, filter or chart declaration and you choose not to expose it (privacy-sensitive addresses, accounting periods, job timing), add an entry with a one-line reason to `QUERY_AFFORDANCE_ALLOWLIST` in `packages/polyfill-connectors/src/query-affordance-allowlist.ts`. The key is `${connectorKey}.${stream}.${field}.${affordance}`, with `connectorKey` the manifest's hyphenated `connector_key`. The test fails on a useful field that is neither declared nor allowlisted, and on an entry whose affordance is declared or whose field was removed from the manifest.

---

## 5. Session-state pattern

1. Probe the session before login, because a cheap auth check saves rate-limit budget and human attention.
2. Log in before a challenge. Drive credentials from the declared auth source. When a challenge (OTP, two-factor, SMS) fires, call `sendInteraction({ kind: "otp", ... })` and wait for the answer.
3. Assume no human is present. A connector that runs unattended must finish or send an interaction request. It does not hang, retry without limit or return partial output.
4. Treat session elevation as its own state. Some platforms require a recent password entry even for a signed-in session. Handle it separately from a dead session.
5. Plan for session-only cookies. Chromium drops a cookie with no `Expires` or `Max-Age` when the process exits, even inside the persistent profile. Only a cookie with an expiry survives.
6. If a connector reports "signed out" on every run despite a real earlier sign-in, check the auth cookie's `Expires` or `Max-Age` in devtools before you suspect a selector or a credential.
7. For a platform with such cookies (`connectors/usaa/`), `ensureSession` signs in again on every run.
8. Build no connector-local session persistence. Runs for one connector are serialized and scheduled well outside any in-memory cookie window.

---

## 6. Cursor and incremental discipline

### Incremental cursors

1. Use the platform's native cursor when one exists (timestamps, opaque next-page tokens, the highest message id). Invent no cursor where the platform has none.
2. Persist the cursor in a STATE message, which the runtime makes durable.
3. Keep secrets, session tokens and personal data out of STATE.
4. Write only values to STATE that replay reproduces. A value from a fresh clock read (`nowIso()`, `Date.now()`) breaks replay.
5. Derive STATE values from the source data, from `scope`, from prior `state`, or from `emittedAt`, which the runtime reads once per run.
6. The reason is that `scenario-verify` compares the final STATE of a replay with the recorded one. During replay, `Date.now()` and `new Date()` read from a recorded clock trace in call order, and after the trace ends each call adds one millisecond. When the number or order of clock reads differs from the capture, a fresh clock value differs and the replay fails with a `final_state` mismatch.
7. The `emitted_at` field of a RECORD is excluded from the comparison.

### Per-record fingerprint cursors (skip records that did not change)

Use this pattern when a stream re-derives full records on every run from a source with no usable change feed, such as archive rebuilds, full-collection refetches, IMAP `1:*` re-aggregations, file-mtime triggers. Without an emit-side gate, every run emits a new RECORD for every record, even when the source has not changed.

`openFingerprintCursor` in `packages/polyfill-connectors/src/fingerprint-cursor.ts` implements the gate. Connectors under `connectors/<key>/` import it as `../../packages/polyfill-connectors/src/fingerprint-cursor.ts`; the package also exports it as `@pdpp/polyfill-connectors/fingerprint-cursor`.

```ts
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";

const cursor = openFingerprintCursor(state.workspace, {
  excludeFromFingerprint: ["fetched_at"],
});

for (const row of workspaceRows) {
  const record = buildWorkspaceRecord(row);
  if (cursor.shouldEmit(record)) {
    await emitRecord("workspace", record);
  }
}

cursor.dropUnseenIds(); // full-scan streams only

await emit({
  type: "STATE",
  stream: "workspace",
  cursor: { synced_at: emittedAt, fingerprints: cursor.toState() },
});
```

Rules:

1. The record `id` is stable from the source's side across runs (`r.TEAM_ID`, the platform's row primary key). A synthetic id that includes a timestamp defeats the gate.
2. The fingerprint covers the emitted record with deterministic key order. Keep the record builder deterministic (sorted participant arrays, sorted label sets, stable field projections), or incidental shape changes re-emit records.
3. Put every field that advances on each run by design (`fetched_at` from `emittedAt`, a derived view-state timestamp) in `excludeFromFingerprint`. Otherwise the fingerprint never matches across runs.
4. Call `cursor.dropUnseenIds()` after the loop and before STATE when the stream re-fetches the complete source set. Without it a deleted record keeps its fingerprint, and a later re-add is skipped. A stream whose run is a partial paginated tail does not call it, so earlier fingerprints carry forward.
5. Use the gate only for sources that rebuild every record on each run. A source with a strong cursor (a `since` parameter, incremental ids, IMAP `UIDNEXT` past the high-water mark) needs no fingerprinting.
6. The storage layer's byte-equivalence check catches duplicate writes the connector missed. Keep the emit-side gate anyway, because it saves the scrape and parse work.
7. A connector with a derived-field carry-forward policy reads the prior value through `cursor.priorFingerprint(id)`. The primitive encodes no policy.

### Parent-first emit order

When a connector emits related streams (orders and order_items, accounts and transactions, conversations and messages, threads and messages), the parent record emits before any of its children. Downstream consumers that upsert while streaming rely on this for referential integrity, and incremental consumers need no buffering. `connectors/amazon/index.ts` (`emitOrderAndItems`), `connectors/chatgpt/index.ts` (`processConversationDetail`) and `connectors/gmail/index.ts` (`runAllMailPasses`) follow the rule.

When the parent is an aggregate that the connector builds by observing children, use one of two patterns:

1. A self-contained fetch that enumerates the parent independently of the child pass. Gmail threads come from a separate fetch that does not read message bodies.
2. A two-pass split. Pass one accumulates parent data and emits nothing for children, and pass two emits children. `processJsonlLine` in `connectors/claude_code/index.ts` takes a `buildOnly` flag that suppresses emits while it updates the accumulator.

The connector's `integration.test.ts` asserts that the parent's position in the emit sequence is before its first child. `connectors/amazon/integration.test.ts` and `connectors/gmail/integration.test.ts` show the assertion.

### Coverage and gap evidence (list-plus-detail connectors)

A connector that fetches a list and then hydrates per-item detail (conversations then messages, accounts then transactions, orders then order_items) emits two signals, so the runtime tells a partial run from a complete one without guessing from record counts. Use the builders in `packages/polyfill-connectors/src/connector-runtime.ts`, and do not hand-write the message shapes. The Collection Profile section 5.6 defines both messages.

1. `emitDetailCoverage(ctx, { stream, stateStream, requiredKeys, hydratedKeys, gapKeys })` reports, once after the detail pass, what the run considered (`requiredKeys`, the denominator) and what it hydrated (`hydratedKeys`, the numerator). Without it, a run reads as `considered: unknown` and never as proven complete. `considered` and `covered` are optional explicit counts. Measure `considered` at the enumeration site and never alias it to the emitted count. A full-scan stream with no detail phase uses `buildFullScanCoverageMessage(stream, considered)`. Emit coverage only after a successful enumeration, because a failed fetch proves nothing about the boundary.
2. `emitDetailGap(ctx, { stream, recordKey, reason, locator, parentStream?, listCursor?, error? })` records one record whose detail could not be hydrated and that a later run retries. `stream`, `recordKey`, `reason` and `locator` are required. The helper fixes `status: "pending"`, `retryable: true` and `reference_only: true`. `parentStream` names the list stream the detail hangs off, `listCursor` lets the next run resume the parent list at the gap, and `error` carries bounded context (`class`, optional `httpStatus`, optional `networkPressure`, optional `message` on `last_error` only). A gap with no `error` carries neither `detail` nor `last_error`. The valid reasons are `rate_limited`, `upstream_pressure`, `retry_exhausted` and `temporary_unavailable`.

The helper copies `error` onto the wire without redaction. Pass endpoint route, method and error class in `networkPressure`, and strip the attempt budget and secret-bearing headers before the call. `omitAttemptBudget` in `connectors/chatgpt/index.ts` shows the stripping, and `connectors/chatgpt/integration.test.ts` pins the emitted shapes.

A connector that emits only RECORD, STATE and DONE still yields a valid collection report whose coverage axis reads `unknown`. Emit coverage and gaps when you hold the evidence, and never state a `considered` count you cannot substantiate.

### Year-freezing and other immutability shortcuts

1. Freeze only data that cannot change, such as orders from 2010.
2. Never freeze data that changes after the fact, such as refund status, delivery updates, review edits and message reactions. Freezing it makes the stored version silently wrong.
3. Provide a force re-scrape path (an environment variable, a manifest option or a documented state-edit procedure), because frozen records block reprocessing after a parser fix.
4. State the platform contract that justifies trusting immutability in the connector header. This applies to year-freezing and to any "freeze on the second stable observation" pattern.

---

## 7. Rate-limiting and politeness

1. Sleep between navigations with `politeDelay(ms)` from `packages/polyfill-connectors/src/connector-runtime.ts`. Take the delay from what the platform tolerates, and adjust it after you observe the platform's behavior.
2. Treat a captcha as a stop signal. Retrying through a captcha makes the block worse. Stop the stream and report it with `reportStreamFailure`.
3. Mark transient failures (network errors, DNS, 5xx) retryable through `retryablePattern`. Failures from an unknown layout or from rejected credentials are non-retryable.
4. Log a rate-limit hit as its own event ("HTTP 429"), because "connection failed" carries no diagnostic value.

### Terms of service and data ownership

1. The connector header states what data the connector reads, why, and whose account it targets (the owner's own).
2. A connector reads only data that the calling user owns.
3. When a platform's terms prohibit scraping, the connector header says so and states the user's legal basis for collecting the data (a data-access right under GDPR or CCPA).

---

## 8. What to capture, what to skip

### Stream scope

1. Capture canonical ids (`asin`, `order_id`, `message_id`, `transaction_id`) in place of display strings.
2. Capture the platform's own fields as the platform shows them. If the platform shows "delivered on Monday, April 20", store that raw string and do not convert it at scrape time.
3. Skip interface cruft: "Buy it again" buttons, "View your item" anchors, banners and "Customers who bought" carousels. They sit in the DOM around the real data and leak into records. A text marker such as "Sold by" does not identify a real item, because recommendation cards contain it too. Identify real items by structural siblings.

### Stream design

1. Prefer thin streams. A join is cheap at query time and a split is not, so `orders` plus `order_items` is easier to query than one `orders_with_items` stream.
2. Declare every stream in the manifest, even when the connector fills it only partly. A declared stream with null fields is better than a silent manifest.
3. Cover the platform. List what its API reference or data export holds and collect what a user expects to find.

---

## 9. Testing

Connectors depend on live third-party surfaces, so the unit tests you can write are limited. Use these tools:

1. Fixtures. Keep a handful of representative DOM snapshots or API bodies per connector, enough to cover the layout variants you met, and use the capture pipeline in §9.1.
2. Shape checks (§3) on every emit in production. They replace the tests you cannot write.
3. `parsers.test.ts`: table-driven tests over synthetic fixtures. A test that reads a local raw capture checks `existsSync` first and skips when the directory is absent, because `raw/` is never committed:

   ```ts
   test("parseX: local real fixture parses at least N records", {
     skip: !existsSync(LOCAL_RAW_DIR),
   }, () => { /* ... */ });
   ```

4. `integration.test.ts`: invariants of `collect()` that consumers depend on. Mock `emitRecord` with `makeRecordingEmit(validateRecord)` from `packages/polyfill-connectors/src/test-harness.ts`, so records pass through the real shape check. Assert emit order, scope filtering and cursor advancement. Import the testable helpers from `./index.ts`; the `isMainModule` guard keeps the runtime from starting. `connectors/amazon/integration.test.ts` shows the full pattern. `conformance` reports a connector with no test file as unchecked.
5. A manual spot check after the first full run. Compare 5 to 10 random records with the platform's own interface.
6. A known-failure-modes log in the connector's design note. Each platform change is a data point for the next author.

### 9.1 Capturing fixtures from a live run

A live run is the only chance to snapshot real DOM and API shapes. Capture fixtures on every live run, because future parser tests depend on them.

Every connector that uses `runConnector()` captures when `PDPP_CAPTURE_FIXTURES=1` is set. `PDPP_CAPTURE_ON_FAILURE=1` captures during the run and deletes the raw directory when the run succeeds; with both set, `PDPP_CAPTURE_FIXTURES` wins. The root is `connectors/<key>/fixtures/raw/<runId>/`, or `<PDPP_CAPTURE_ROOT_DIR>/<key>/raw/<runId>/` when `PDPP_CAPTURE_ROOT_DIR` is set. The capture directory holds these paths.

| Path | What it holds |
|---|---|
| `records/<stream>.jsonl` | every emitted RECORD.data, captured automatically |
| `dom/<label>.html` | DOM snapshots, when the connector calls `capture.captureDom(page, label)` |
| `aria/<label>.aria.yml` | ARIA snapshots for semantic selector design, to the depth in `PDPP_CAPTURE_ARIA_DEPTH` (default 8) |
| `locators/<label>.json` | locator probe results, when the connector calls `capture.captureLocatorProbe(page, label, probes)` |
| `http/<nnnn>-<label>.json` | HTTP response bodies, when an API connector calls `capture.captureHttp(label, body, meta)` |
| `traces/` | Playwright trace chunks, flushed at each capture checkpoint |

Opt in to DOM capture from a browser connector, and guard the handle because it is `null` when capture is off:

```ts
async collect({ page, capture, emitRecord }) {
  await page.goto("https://example.com/orders");
  await capture?.captureDom(page, "orders-list-page-1");
}
```

#### Using captures to improve selectors

Captured DOM supports parser tests and structural-selector drift checks. It does not always prove a Playwright semantic locator, because shadow DOM and accessibility-tree behavior can differ from static HTML. Before a selector change:

1. Read the raw run's `aria/<label>.aria.yml` for roles and accessible names.
2. Add or read `locators/<label>.json` probes for the semantic candidate and for the current structural fallback.
3. Replace a working structural selector only when the semantic candidate is unique, visible (and enabled when needed) and at least as stable in the captured evidence.
4. Keep the structural fallback when the component exposes weak or duplicate accessible names.

Raw locator and ARIA captures can contain owner data. Treat them like raw DOM: debug locally, then scrub and review before you promote anything.

#### Scrub before commit

Raw captures hold your real personal data (emails, addresses, order ids, account numbers). `.gitignore` excludes `connectors/*/fixtures/**/raw/` and `connectors/*/fixtures/fixture_capture*/`, so a raw capture cannot be staged by accident. Run the scrubber:

```bash
node --import tsx packages/polyfill-connectors/bin/scrub-fixtures.ts <key> [runId] [--llm-redactions-dir <dir>]
```

The scrubber applies the shared defaults in `packages/polyfill-connectors/src/scrub-defaults.ts` (emails, SSNs, credit-card-shaped digit runs, US phone numbers, labeled account numbers, street-address patterns and labeled names) and then the rules in `connectors/<key>/scrub-rules.ts`. Output goes to `connectors/<key>/fixtures/scrubbed/<runId>/`.

Git does not ignore `scrubbed/`, so review is the only gate. Commit scrubbed output only after the review in "Review before commit" below. Never commit `raw/` or a redaction-plan directory, unless a plan is synthetic and useful as test data.

For free-form text that deterministic rules cannot classify, have a reviewer (a person or a model) write a structured redaction plan, and pass the plan directory with `--llm-redactions-dir`. The scrubber makes no network call and reads one plan file per raw file, named after the raw relative path plus `.redactions.json` (for example `dom/orders-list.html.redactions.json`):

```json
{
  "version": 1,
  "redactions": [
    { "text": "Alice Example", "replacement": "[REDACTED_NAME]", "reason": "person name in delivery status" }
  ]
}
```

The mode stops on any gap. Every raw file needs a plan, every replacement matches `[REDACTED_*]`, and every target string must still exist after deterministic scrubbing. A missing, invalid or stale plan stops the run before it writes that run's output.

#### Connector-specific scrub rules

`connectors/<key>/scrub-rules.ts` exports a `scrubRules` array. `scope` is `"all"`, `"html"` or `"json"` (`.jsonl` counts as `json`). Defaults run first, then the rules in order.

```ts
export const scrubRules = [
  { pattern: /\b\d{3}-\d{7}-\d{7}\b/g, replacement: "111-2222222-3333333", scope: "all" },
  { pattern: /u\/[A-Za-z0-9_-]+/g, replacement: "u/anon", scope: "all" },
];
```

#### Review before commit

1. Read the whole scrubbed tree. The defaults miss free-form notes, merchant names, unlabeled people's names and platform-specific ids. Add a connector rule for each pattern you find.
2. For a connector whose raw fixtures are HTML, the human review (or the `--llm-redactions-dir` path) is required. The default name rule fires only on labeled or keyed fields (`name: value`, `"customerName": "..."`). A bare name in an HTML text node, such as `<span> Jane Doe </span>`, matches no rule and survives scrubbing.
3. Confirm the scrubbed fixture keeps what parsers need, which covers selectors, object keys, stream names, safe timestamps and representative non-sensitive values.
4. Redact or replace every owner identifier, free-form note, account number, address, email, phone number and platform id that identifies the owner. If review finds sensitive content that no rule covers, do not commit the fixture until a connector rule or a reviewed manual redaction covers it.
5. Commit only `connectors/<key>/fixtures/scrubbed/...` and the tests that consume it.

#### The `pilot-real-shape` fixture (schema-drift lock)

A schema-bearing connector ships one canonical fixture at `connectors/<key>/fixtures/scrubbed/pilot-real-shape/`. It locks the emitted-record shape, so a later change to `schemas.ts` that rejects a row fails a test before it reaches production. One line wires it:

```ts
// connectors/<key>/pilot-fixture.test.ts
import { registerPilotFixtureTests } from "../../packages/polyfill-connectors/src/pilot-fixture-test-helper.ts";
import { validateRecord } from "./schemas.ts";

registerPilotFixtureTests({ connector: "<key>", validateRecord });
```

The helper (`packages/polyfill-connectors/src/pilot-fixture-test-helper.ts`) registers these checks:

1. The `records/` directory holds exactly one `<stream>.jsonl` file for every manifest stream. `exemptStreams: { <stream>: "<reason>" }` excludes a stream that has no reviewed real-derived capture yet. Cover an exempt stream with a test fixture that is labeled synthetic and lives outside `pilot-real-shape/`.
2. Each stream file has at least one row, and `validateRecord(stream, row).ok` is true for every row.
3. A missing fixture directory fails the test. `expectMissing: true` opts out and needs a justification.

The fixture holds records with real field shapes and non-identifying values, with `[REDACTED_*]` placeholders where a capture carries owner identity. A reviewed capture can calibrate the rows. Committed owner rows never appear under `pilot-real-shape/`. To keep a scrubbed real run as separate evidence, store it under a run-specific `connectors/<key>/fixtures/scrubbed/<runId>/` path and apply the redaction review above.

Three committed pilots show the shapes.

1. DOM shape: `connectors/amazon/fixtures/scrubbed/pilot-real-shape/dom/` holds scrubbed `page.content()` HTML for a browser-scraped connector.
2. API JSON shape: `connectors/github/fixtures/scrubbed/pilot-real-shape/api/` holds scrubbed HTTP bodies, and `records/*.jsonl` holds the records derived from them.
3. Record-stream shape: `connectors/reddit/fixtures/scrubbed/pilot-real-shape/records/` holds records that the connector emits straight from JSON responses, with no DOM or stored HTTP layer. It is the reference for a connector whose only durable output is a record stream.

#### Smoke-test the capture pipeline

`node --import tsx packages/polyfill-connectors/bin/test-fixture-capture.ts` runs a self-contained check (no network, no browser, no live account) that capture and scrub produce sanitized output from input that holds personal data. Run it after you change `src/fixture-capture.ts`, `src/scrub-defaults.ts` or `bin/scrub-fixtures.ts`.

### 9.2 Scenario replay evidence (`claim.json`)

The commands are steps 3 to 5 of [AUTHORING.md](../../../AUTHORING.md#steps). Recording is live collection with your credentials. Replay is offline against the captured interactions and checks the current connector's output against that scenario. Replay does not test provider freshness or stability under provider churn. For browser replay, confirm that capture produced usable HAR and storage-state files. Keep both private, because they can hold credentials or account data.

`--json` writes to the path relative to the process working directory. Neither the scaffold nor the verifier creates `connectors/<key>/evidence/`, so create it first. If the write fails, the verifier prints a warning and keeps its replay exit code. A file that exists after the run does not prove the write succeeded. Delete the old claim before verification, or check that the new claim has the current `verified_at` and the expected digests, and review the content.

The file uses the schema `pdpp.connector-claim/1` and holds the claim and its limitations, capture and verification timestamps, the coverage labels earned (for example `empty_state_run` or `state_seeded_second_run_with_changed_requests`), the run count, the names of the drivers used, the captured and verified source and declaration digests, and the scenario file name. It holds no per-stream coverage, because the `streams exercised` summary prints to the verifier's stdout only. Commit the claim file, and keep scenario JSON, HAR files, storage state and diagnostic dumps local, because they can hold account data or credentials.

#### Path and freshness

1. Keep exactly one committed claim at `connectors/<key>/evidence/claim.json`, the latest, and overwrite it when you re-verify instead of adding timestamped files.
2. Regenerate it when the connector source or manifest changes materially. CI compares the claim's `captured_with` source and declaration digests with the PR's connector source and manifest. Matching digests (the claim was made for this code) report as BOUND. Differing digests (the code changed after the claim) report as STALE.
3. Re-verifying an existing scenario refreshes `verified_at` and `verified_subject` and keeps `captured_with` from the original capture. A claim whose connector source or manifest changed after capture stays STALE. Capture again with `scenario-record` and verify the new scenario to bind the claim to the changed code.
4. A connector with no claim file has no established replay claim. CI reports `evidence: none` and does not fail.

#### What CI does with it

For a PR that touches a connector, the workflow prints an informational summary per changed connector and applies the label `evidence: author-replay`, `evidence: stale` or `evidence: none` on same-repository PRs. The summary reports whether a claim exists, whether its captured digests match the PR's source and manifest, and that CI did not re-run a provider session. The check is informational and never blocks a merge. `.github/workflows/polyfill-connectors.yml` and `packages/polyfill-connectors/scripts/connector-evidence-summary.ts` define the table and the labels.

#### Claim levels and coverage names

A claim has a level. `recorded_replay` is the stronger level and `diagnostic_replay` the weaker one. The verifier cannot yet prove that a replay is isolated from the network and the live account (`isolationEvidenceBoundaryProven: false` in `packages/polyfill-connectors/bin/scenario-verify.ts`), so it never grants `recorded_replay`. A passing replay earns `diagnostic_replay`. A driver that the verifier does not support fails replay.

Coverage names have narrow conditions. `empty_state_run` requires run 0 to start with null state, perform an interaction and expect at least one record. `state_seeded_second_run_with_changed_requests` requires a later run seeded from an earlier run with non-trivial final state, and requests that differ from run 1. A capture with two runs meets neither condition by default and does not prove full-refresh or incremental semantics. A generated claim is a candidate for review and does not guarantee the connector's behavior. Digest binding describes the code at capture and verification time and is not a live-provider check.

### 9.3 Pre-ship checklist

Check these before another user relies on a connector.

1. It runs end to end on at least one owner account, the author's.
2. It wires `validateRecord`, or has a justified `connector-schema-allowlist.ts` entry (§3).
3. The manifest declares every stream, including streams that return null fields.
4. It sends a SKIP_RESULT or reports a stream failure on selector drift. A list page that returns zero records while its container is absent or hidden is a drift signal. A present container with no rows is a legitimate empty result.
5. The connector header states the locale and account-type assumptions (§11).
6. It ran at least twice, and you reviewed the captured state and request differences before claiming incremental behavior.

---

## 10. Versioning and drift

1. The manifest declares the connector version. Bump it when schemas change, when selector strategies change materially or when the STATE cursor shape changes. Before 1.0.0, a breaking schema change (a removed property or a newly required field) bumps the minor version. A maintainer promotes a connector to 1.0.0 after it works well in production; after that, a breaking change bumps the major version. A new connector starts at `0.1.0`.
2. Keep a short `CHANGES` section in the connector header or an adjacent `.md`, with one line per change: "v0.3: switched item extraction from innerText regex to data-component".
3. When a selector breaks, bump the connector version and name the observed drift in the commit message instead of editing selectors silently.

---

## 11. Locale and account-type honesty

A connector that works on the author's account works on another account only where you tested it, and across locales only where you tested those. State the tested surfaces in the connector header:

```
 * Tested surfaces:
 *   - US / EN consumer account, card-or-giftcard payment
 *   - Orders 2005-2025, about 1,200 orders
 *
 * Known untested:
 *   - EU / non-EN locales
 *   - Business / Prime Student accounts
 *   - Non-card payments (PayPal, Affirm)
```

The header is a contract that tells the next user whether to trust the connector for their case.

---

## 12. Blob hydration (file and attachment bytes)

When a stream carries binary payload (attachments, statement PDFs, uploaded files, message media), the connector puts no bytes in the record and defines no stream-specific download URL. The flow is fixed:

1. The connector fetches bytes from the source under the owner-authorized session it already holds (IMAP, a signed token, a scrape session, a filesystem path).
2. The connector uploads the bytes to the reference resource server (RS) with `POST /v1/blobs?connector_id=...&stream=...&record_key=...&mime_type=...`, through `makeReferenceBlobUploader` in `packages/polyfill-connectors/src/reference-blob-uploader.ts`.
3. The connector emits a record whose `data.blob_ref` is `{ blob_id, mime_type, size_bytes, sha256 }`, plus `content_sha256` (the blob's sha256) and `hydration_status`.

The uploader helper behaves as follows.

1. It hashes the stream inline and returns `{ blob_id, mime_type, sha256, size_bytes }`. It fails when the server's hash or size differs from its own.
2. It reads the server address from `PDPP_RS_URL` (or `RS_URL`) and the token from `PDPP_OWNER_TOKEN`. `runtimeBlobUploadAvailable()` reports whether both are set.
3. It takes `connectorInstanceId` (`PDPP_CONNECTOR_INSTANCE_ID`) when the run is connection-scoped, so blobs land with the same connection as record ingest and state checkpoints.
4. It accepts any `AsyncIterable` or `Iterable` of `Buffer | Uint8Array | string`.

### Manifest fields for a hydratable stream

```json
{
  "blob_ref": {
    "type": ["object", "null"],
    "properties": {
      "blob_id":    { "type": "string" },
      "mime_type":  { "type": "string" },
      "size_bytes": { "type": "integer" },
      "sha256":     { "type": "string" }
    },
    "required": ["blob_id", "mime_type", "size_bytes", "sha256"],
    "additionalProperties": true
  },
  "content_sha256":   { "type": ["string", "null"] },
  "hydration_status": { "type": "string", "enum": ["hydrated", "failed", "deferred", "too_large"] },
  "hydration_error":  { "type": ["string", "null"] }
}
```

Add further status values (`unavailable`, `blocked`, `skipped`) only when the connector runs that branch. A status value that no code path reaches misstates observable behavior.

### Reference implementation (Gmail)

`connectors/gmail/index.ts` is the reference. It builds the uploader through `makeReferenceBlobUploader`, and it defines these connector-local helpers:

1. `enforceMaxBytes(content, maxBytes)` wraps an async iterable and throws when the running byte count passes the cap.
2. `hydrationFailureResult(attachment, status, err)` keeps the metadata, sets `blob_ref: null` and `hydration_status`, and bounds the error text with `boundedHydrationError`, which truncates to 240 characters.

### Size policy

1. Pick a conservative default that matches the source's per-item cap, and expose an operator override variable named `PDPP_<CONNECTOR>_MAX_<ARTIFACT>_BYTES` (Gmail uses `PDPP_GMAIL_MAX_ATTACHMENT_BYTES`).
2. Enforce the cap twice. Check the size the upstream reports before download, and count bytes during streaming to catch sources that under-report. Both checks are required.

### Failure handling

1. When bytes are unavailable, emit a metadata-only record with a truthful `hydration_status` instead of dropping the row.
2. `hydration_error` is a public record field. Keep out of it signed URLs, tokens, file paths that leak filenames and stack traces. A connector that downloads through signed URLs strips query strings before it fills the field.

### Idempotency

Uploading the same bytes again produces the same `blob_id`, because a blob is stored by its hash, so a connector needs no deduplication of its own.
