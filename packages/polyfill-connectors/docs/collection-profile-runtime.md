# Collection Profile runtime note

This note describes the current `polyfill-connectors` implementation and the `@pdpp/*` packages it installs. The normative protocol is the [PDPP Collection Profile](../../../docs/spec/collection-profile.md). The profile is the target contract, and the current package does not fully conform to it yet. The gaps table below lists the differences.

## Current entry points

| Surface | Entry point |
| --- | --- |
| Connector runtime | `@pdpp/polyfill-connectors/connector-runtime` |
| Connector protocol types | `@pdpp/connector-protocol/connector-runtime-protocol` |
| Connector definition | `@pdpp/connector-protocol/collector-definition` |
| Collector runtime and placement | `@pdpp/collector-runtime` |
| Authentication helpers | `@pdpp/connector-protocol/auth` |
| Option schema resolver | `@pdpp/polyfill-connectors/connector-options-schema` |
| Option-kind registry | `@pdpp/polyfill-connectors/connector-config-option-kind-registry` |
| Manifest schema (bindings) | [`schemas/connector-manifest.schema.json`](../../../schemas/connector-manifest.schema.json) |

`runConnector()` owns standard input, standard output, record validation, scope filtering, counters, interaction messages, and terminal `DONE` output. The runtime in `src/` also owns browser lifecycle, tracing, fixture capture, retryable-error classification and auth resolution.

A connector owns which records it produces, how it parses them, and its stream logic (cursors, tombstones through `isTombstone`). Manifests live at `connectors/<key>/manifest.json`.

`@pdpp/connector-protocol` and `@pdpp/collector-runtime` install from the npm registry at the exact version in `package.json`. The connector wire protocol reports version `0.0.3`. That package version is not the Collection Profile version. It defines two protocol capabilities, `STREAM_EVIDENCE` and `BLOB`. The collector-runtime placement helper can reject a connector whose required protocol capability is absent.

The manifests of `anthropic` and `chatgpt` declare `protocol_capabilities` (`["BLOB"]`). The others omit it, which means the empty set. Local collector definitions carry an explicit empty array because the current TypeScript interface requires one. Both forms are the same declaration.

## TypeScript projection

The TypeScript types are not part of the normative document. They are available from `@pdpp/connector-protocol/connector-runtime-protocol`.

The TypeScript definitions describe what this package does. The Collection Profile remains the authority for portable meaning. A type that admits an extension field does not make that field part of v0.1 conformance.

The definitions differ from the protocol in several places. The `StartMessage` type omits `run_id` and `bindings`, and the record union omits explicit `op: "upsert"`. The gaps table lists the other differences. The normative profile follows the runtime behavior in these cases.

## Current behavior

The connector runtime reads the first input line as `START`. It checks only `type` and a non-empty `scope.streams` array, so it ignores `START` members it does not read. It forwards prior state to the connector. It filters records by resource key and time range. It validates records when the connector supplies a validator. It emits `RECORD`, `STATE`, `SKIP_RESULT`, `PROGRESS`, and final `DONE` messages.

## Runtime-specific fields and messages

The current packages define the extensions in the table below outside portable v0.1. A detail gap is a per-record marker that the detail of a listed record was not collected, so a later run can retry it. A bounded-horizon fact says that the provider stopped serving older history.

| Extension | Purpose |
| --- | --- |
| `START.detail_gaps`, `START.recovery_only` | Start a detail-gap recovery lane. |
| `START.streamsToBackfill` | Select runtime-managed backfill streams. |
| `BLOB` message and capability | Transfer a bounded binary payload to the host. |
| `ASSISTANCE`, `ASSISTANCE_STATUS` | Non-blocking owner assistance. |
| `DETAIL_GAPS_PAGE_REQUEST`, `DETAIL_GAPS_PAGE_RESPONSE` | Page runtime-owned detail gaps. |
| `DETAIL_GAP_ATTEMPTED`, `DETAIL_GAP_RECOVERED` | Record detail-gap lifecycle events. |
| `DETAIL_COVERAGE.considered`, `.covered`, `.optional_skip_keys` | Add implementation coverage projections. |
| `SKIP_RESULT.boundary_claim`, `.continuation`, `.diagnostics` | Add bounded-horizon and diagnostic facts. |
| `PROGRESS.provider_budget`, `.collection_rate` | Report provider and rate-governor state. |

A connector that depends on one of these fields also depends on the package or runtime extension that defines it. It cannot claim that dependency as portable Collection Profile behavior.

## Gaps against the normative profile

`schemas/connector-manifest.schema.json` validates `runtime_requirements` only. No local validator checks the rest of a Collection Profile manifest against Section 3.

| Profile requirement | Current package status |
| --- | --- |
| Binding registry | The packaged collector capability profile advertises `network`, `browser`, `filesystem`, and `local_device`. It does not advertise `desktop_session`, which `signal` requires. `local_device` is a runtime mode in the profile, not a binding. |
| Filesystem inputs | No manifest declares `filesystem.inputs` yet, and no runtime confines a connector to declared inputs. |
| Catalog projection of inputs | The catalog carries no `inputs` or `rationale`. A versioned catalog is needed before it can. |
| Runtime clock | The `StartMessage` type has no `now` field and the connector runtime does not read one. |
| Exactly one `START` | The first line is checked. A later `START` is not rejected by the connector-side runtime. |
| Scope stream enforcement | A non-empty scope is required. `emitRecord()` does not reject an undeclared stream or project `fields`. The parent runtime is expected to enforce both before durable write. |
| Record envelope | The parent runtime is expected to check key, data, operation, and ISO 8601 `emitted_at`. The ingest path remains responsible for schema and record-identity checks. |
| Interaction timeout | The package interaction handler accepts `timeout`. The connector-protocol type declares `error` instead. |
| State durability | The connector-side runtime emits state. The parent runtime owns durable writes and commit decisions. |
| Recovery-hint vocabulary | The package types admit arbitrary action strings. They do not enforce the portable closed set. |
| Protocol capabilities | The `STREAM_EVIDENCE` and `BLOB` types and the placement gate exist. The packaged collector capability profile advertises neither, although `anthropic` declares `BLOB`. |
| `OBSERVATION` (profile 0.2.0) | Implemented in this package only. `@pdpp/connector-protocol` does not list the capability, and no manifest declares it. |
| Recovery-hint gate (Section 5.11) | `connector-dev` and `diagnose` present hints through the gate. This repository applies it nowhere else. |
| Terminal status | Connector-protocol types expose only `succeeded` and `failed`. |

`@pdpp/connector-protocol` is the authority for what this package emits. The parent runtime that spawns connectors lives outside this repository, so the rows that name it describe expected behavior, not code here.

`OBSERVATION` works as follows. `runConnector({ protocolCapabilities: ["OBSERVATION"] })` sends the facts that shared helpers such as `waitForElementExpectation` record, and adds `DONE.error.basis`. `bin/connector-dev.ts` accepts and records them, and `bin/diagnose.ts` applies the cause rules and the recovery-hint gate. `connector-dev` bounds the count and size of facts per run, not their rate or the storage kept across runs.

Where connectors take file input today, seven manifests (`fitbit`, `strava`, `google_maps`, `youtube_takeout`, `whatsapp`, `netflix_export`, `apple_health`) use `setup.manual_or_upload.import_dir_env_var`. `claude_code` and `codex` describe fixed home paths in `runtime_requirements.local_paths`.

The catalog has no `inputs` because `scripts/generate-connector-catalog.mjs` projects each published binding to `required` and `features` only. Installers validate the catalog against the schema bundled in their release, and that schema closes each binding object.

## Connector identifiers

Each manifest carries `connector_key`, a URL-shaped `connector_id` (`https://registry.pdpp.dev/connectors/<connector_key>`), and an equal `manifest_uri`. Signed OCI artifacts are published as `ghcr.io/pdp-connect/connector/<connector_key>`.

The normative rules for these identifiers are below.

1. `connector_key` is the operational identifier.
2. A known compatibility `connector_id` must map to that key.
3. An unknown `connector_id` must equal the key or the manifest is rejected.
4. `manifest_uri` is provenance and never operational identity.

## Option-kind authority

The option schema can declare shape, labels, defaults, and a claimed option kind. It cannot decide whether an option changes collection scope. The platform-owned registry decides the enforced kind. An unknown option defaults to `collection_scope`, which requires owner confirmation.

The manifest claim stays informative until runtime policy accepts it.

## Connector-reported evidence

The runtime cannot verify some evidence from the messages it receives. It cannot see a record that the connector deliberately left out because it had not changed. It cannot tell whether the connector fully checked a source that returned nothing. The normative profile labels these values as connector assertions and prevents them from gating checkpoint commit.

The current `DETAIL_COVERAGE.considered` and `.covered` extension accepts connector-supplied counts. The profile gives `optional_skip_keys` no portable coverage credit. A connector that reports unavailable keys there stays runtime-specific.

## Source-backed fulfillment

`fulfillment.source_backed` is not implemented in this package. The Collection Profile ([docs/spec/collection-profile.md](../../../docs/spec/collection-profile.md)) proposes it as a per-stream capability. It is not a v0.1 conformance requirement.
