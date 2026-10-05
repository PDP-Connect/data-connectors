# Collection Profile runtime note

Status: Informative

This note describes the current `polyfill-connectors` implementation and the
`@pdpp/*` packages it installs. The normative protocol is the
[PDPP Collection Profile](../../../docs/spec/collection-profile.md).

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

`runConnector()` owns standard input, standard output, record validation,
scope filtering, counters, interaction plumbing, and terminal `DONE` output.
Connector modules supply source-specific collection logic. Manifests live at
`connectors/<key>/manifest.json`.

`@pdpp/connector-protocol` and `@pdpp/collector-runtime` install from the npm
registry at the exact version in `package.json`. The connector wire protocol
reports version `0.0.3`. That package version is not the Collection Profile
version. It defines two protocol capabilities, `STREAM_EVIDENCE` and `BLOB`.
The collector-runtime placement helper can reject a connector whose required
protocol capability is absent.

Of the 51 manifests under `connectors/`, only `anthropic` declares
`protocol_capabilities` (`["BLOB"]`). The others omit it, which means the empty
set. Local collector definitions carry an explicit empty array because the
current TypeScript interface requires one. These are two serializations of the
same declaration, not two capability models.

## TypeScript projection

The TypeScript types are not part of the normative document. They are
available from `@pdpp/connector-protocol/connector-runtime-protocol`.

The types are an implementation projection. The Collection Profile remains the
authority for portable meaning. A type that admits an extension field does not
make that field part of v0.1 conformance.

The current projection is not exact. Its `StartMessage` omits `run_id`,
`bindings`, `now`, and stream-level `fields`. It also declares
`INTERACTION_RESPONSE.status: "error"`, while the package interaction handler
(`src/interaction-handler.ts`) accepts `success`, `cancelled`, and `timeout`.
Its record union omits explicit `op: "upsert"`. The normative profile follows
the runtime behavior in these cases.

## Current behavior

The connector runtime reads the first input line as `START`. It checks only
`type` and a non-empty `scope.streams` array, so it ignores `START` members it
does not read, including `now`. It forwards prior state to the connector. It
filters records by resource key and time range. It validates records when the
connector supplies a validator. It emits `RECORD`, `STATE`, `SKIP_RESULT`,
`PROGRESS`, and final `DONE` messages.

## Runtime-specific fields and messages

The current packages define these extensions outside portable v0.1:

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

A connector that depends on one of these fields also depends on the package or
runtime extension that defines it. It cannot claim that dependency as portable
Collection Profile behavior.

## Gaps against the normative profile

`schemas/connector-manifest.schema.json` validates `runtime_requirements`
only. No local validator checks the rest of a Collection Profile manifest
against Section 3.

| Profile requirement | Current package status |
| --- | --- |
| Binding registry | The packaged collector capability profile advertises `network`, `browser`, `filesystem`, and `local_device`. It does not advertise `desktop_session`, which `signal` requires. `local_device` is a runtime mode in the profile, not a binding. |
| Filesystem inputs | No manifest declares `filesystem.inputs` yet, and no runtime confines a connector to declared inputs. Six manifests still use `setup.manual_or_upload.import_dir_env_var`. `claude_code` and `codex` describe fixed home paths in `runtime_requirements.local_paths`. |
| Catalog projection of inputs | `scripts/generate-connector-catalog.mjs` projects each published binding to `required` and `features`, so the catalog carries no `inputs` or `rationale`. Installers validate the catalog against the schema bundled in their release, which closes each binding object. A versioned catalog is needed before the catalog can carry inputs. |
| Runtime clock | No runtime sends `START.now`, and no connector reads it. |
| Collection time in record data | Seven connectors (`amazon`, `chase`, `heb`, `jellyfin`, `reddit`, `slack`, `usaa`) declare a `fetched_at` field in record data. A separate change removes them. |
| Manifest validation before spawn | Placement checks bindings and protocol capabilities, but no local validator checks the full Collection Profile manifest. |
| Exactly one `START` | The first line is checked. A later `START` is not rejected by the connector-side runtime. |
| Scope stream enforcement | A non-empty scope is required. `emitRecord()` does not reject an undeclared stream or project `fields`. The parent runtime is expected to enforce both before durable write. |
| Record envelope | The parent runtime is expected to check key, data, operation, and ISO 8601 `emitted_at`. The ingest path remains responsible for schema and record-identity checks. |
| Delete records | `emitRecord()` builds a tombstone from `data.id` alone: `key` is `String(data.id)` and `data` is `{ id }`. That meets the profile only for a stream whose primary key is the single field `id`. |
| Consent time | Time-bounded runs reject absent or unparseable values. Three Steam streams (`owned_games`, `recently_played_games`, `friends`) declare integer Unix-time consent fields instead of ISO 8601 strings. |
| Interaction timeout | The package interaction handler accepts `timeout`. The connector-protocol type declares `error` instead. |
| State durability | The connector-side runtime emits state. The parent runtime owns durable writes and commit decisions. |
| Recovery-hint vocabulary | The package types admit arbitrary action strings. They do not enforce the portable closed set. |
| Protocol capabilities | The `STREAM_EVIDENCE` and `BLOB` types and the placement gate exist. The packaged collector capability profile advertises neither, although `anthropic` declares `BLOB`. |
| `OBSERVATION` (profile 0.2.0) | Implemented in this package only. `runConnector({ protocolCapabilities: ["OBSERVATION"] })` sends the facts that shared helpers such as `waitForElementExpectation` record, and adds `DONE.error.basis`. `bin/connector-dev.ts` accepts and records them, and `bin/diagnose.ts` applies the cause rules and the recovery-hint gate. `@pdpp/connector-protocol` does not list the capability, and the parent runtime does not accept the message, so no production connector declares it yet. `connector-dev` bounds the count and size of facts per run, not their rate or the storage kept across runs. |
| Recovery-hint gate (Section 5.11) | `connector-dev` and `diagnose` present hints through the gate. The parent runtime does not yet apply it. |
| Terminal status | Connector-protocol types expose only `succeeded` and `failed`. |

The parent runtime that spawns connectors lives outside this repository. The
statements about it above come from the earlier revision of this note and were
not re-verified against its current code.

The normative profile is the target contract. Do not describe the current
package as fully conforming until these gaps close.

## Identifier migration

Each manifest carries `connector_key`, a URL-shaped `connector_id`
(`https://registry.pdpp.dev/connectors/<connector_key>`), and an equal
`manifest_uri`. Signed OCI artifacts are published as
`ghcr.io/pdp-connect/connector/<connector_key>`.

The normative rule:

- `connector_key` is the operational identifier.
- A known compatibility `connector_id` must map to that key.
- An unknown `connector_id` must equal the key or the manifest is rejected.
- `manifest_uri` is provenance and never operational identity.

## Option-kind authority

The option schema can declare shape, labels, defaults, and a claimed option
kind. It cannot decide whether an option changes collection scope. The
platform-owned registry decides the enforced kind. An unknown option defaults
to `collection_scope`, which requires owner confirmation.

This resolves the self-classification defect for the current implementation.
The manifest claim remains informative until runtime policy accepts it.

## Connector-reported evidence

Some evidence cannot be verified from the wire. In particular, the runtime
cannot observe a suppressed unchanged record or prove that a connector walked
an empty source boundary. The normative profile labels these values as
connector assertions and prevents them from gating checkpoint commit.

The current `DETAIL_COVERAGE.considered` and `.covered` extension accepts
connector-supplied counts. A separate decision is still needed on whether that
extension should reconcile counts with runtime-observed records or remain an
explicitly non-portable assertion.

GroupMe (`connectors/groupme/index.ts`) reports unavailable attachment keys as
`optional_skip_keys` without the portable `DETAIL_GAP` evidence required for
`gap_keys`. The profile gives `optional_skip_keys` no portable coverage credit.
That connector remains runtime-specific until the evidence is reconciled.

## Provisional source-backed fulfillment

`fulfillment.source_backed` is not implemented in this package. Accepted design
work proposes a static per-stream capability and an owner-selected,
per-connection posture. It also proposes an accepted-not-collected health
disposition for a stream served on demand.

This work remains provisional pending OD-4. It is not a v0.1 conformance
requirement. This note does not decide its permanent document or schema home.
