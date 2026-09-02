# Collection Profile runtime note

Status: Informative

This note describes the current `polyfill-connectors` implementation. The
normative protocol is the [PDPP Collection Profile](../../../docs/spec/collection-profile.md).

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
| Manifest reader | `@pdpp/polyfill-connectors/manifests` |

`runConnector()` owns standard input, standard output, record validation,
scope filtering, counters, interaction plumbing, and terminal `DONE` output.
Connector modules supply source-specific collection logic.

The vendored connector wire protocol reports version `0.0.2`. That package
version is not the Collection Profile version. It adds the
`STREAM_EVIDENCE` type and capability. The collector-runtime placement helper
can reject a connector whose required protocol capability is absent.

The 45 checked-in Collection Profile manifests omit `protocol_capabilities`,
which means the empty set. Local collector definitions carry an explicit empty
array because the current TypeScript interface requires one. These are two
serializations of the same declaration, not two capability models.

## TypeScript projection

The TypeScript types moved out of the normative document. They are available
from `@pdpp/connector-protocol/connector-runtime-protocol`. The compiled
declarations are in the vendored `pdpp-connector-protocol-0.0.1.tgz` package.

The types are an implementation projection. The Collection Profile remains the
authority for portable meaning. A type that admits an extension field does not
make that field part of v0.1 conformance.

The current projection is not exact. Its `StartMessage` omits `run_id`,
`bindings`, and stream-level `fields`, although the parent runtime sends and
validates them. It also declares `INTERACTION_RESPONSE.status: "error"`, while
the parent runtime sends and accepts `timeout`. Its record union omits explicit
`op: "upsert"`, which the parent runtime accepts. The normative profile follows
the parent runtime behavior in these cases.

## Current behavior

The connector runtime reads the first input line as `START` and requires a
non-empty `scope.streams` array. It forwards prior state to the connector. It
filters records by resource key and time range. It validates records when the
connector supplies a validator. It emits `RECORD`, `STATE`, `SKIP_RESULT`,
`PROGRESS`, and final `DONE` messages.

The subprocess test harness covers a successful `START`-to-`DONE` run and a
missing terminal message. It also covers non-zero exit after `DONE` and a stream
failure that preserves output from an independent stream.

## Runtime-specific fields and messages

The current packages define these extensions outside portable v0.1:

| Extension | Purpose |
| --- | --- |
| `START.detail_gaps`, `START.recovery_only` | Start a detail-gap recovery lane. |
| `START.streamsToBackfill` | Select runtime-managed backfill streams. |
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

`data-connectors` does not yet contain a schema or validator for the Collection
Profile manifest. The root `schemas/manifest.schema.json` validates only legacy
`*-playwright` manifests.

| Profile requirement | Current package status |
| --- | --- |
| Five standard bindings | The vendored collector runtime advertises `network`, `browser`, `filesystem`, and `local_device`. It does not advertise `desktop_session` or `interactive`. `local_device` is not a v0.1 standard binding. |
| Manifest validation before spawn | Placement checks bindings and protocol capabilities, but no local validator checks the full Collection Profile manifest. |
| Stream semantics | Five checked-in streams use the legacy value `append` instead of `append_only`: `github.user_stats`, `slack.channel_stats`, `usaa.account_stats`, `usaa.credit_card_billing_stats`, and `ynab.account_stats`. |
| Exactly one `START` | The first line is checked. A later `START` is not rejected by the connector-side runtime. |
| Scope stream enforcement | A non-empty scope is required. `emitRecord()` does not reject an undeclared stream or project `fields`. The parent runtime enforces both before durable write. |
| Record envelope | The parent runtime checks key, data, operation, and ISO 8601 `emitted_at`. It does not reject delete for an `append_only` stream. The ingest path remains responsible for schema and record-identity checks. |
| Consent time | Time-bounded runs reject absent or unparseable values. Three Steam streams declare integer Unix-time fields instead of ISO 8601 strings, and the runtime does not define their unit. |
| Interaction timeout | The parent runtime creates a `timeout` response. The vendored connector-protocol type incorrectly declares `error` instead. |
| State durability | The connector-side runtime emits state. The parent runtime owns durable writes and commit decisions. |
| Recovery-hint vocabulary | The package types admit arbitrary action strings. They do not enforce the portable closed set. |
| `STREAM_EVIDENCE` capability | The type and placement gate exist. Current runtime capability profiles advertise no support, and current connectors declare none. |
| Terminal status | Connector-protocol types expose only `succeeded` and `failed`. The parent runtime also accepts connector-emitted `cancelled` for compatibility, although cancellation is a runtime event in this profile. |

The normative profile is the target contract. Do not describe the current
package as fully conforming until these gaps close.

## Identifier migration

Current profile artifacts carry `connector_key`, a URL-shaped `connector_id`,
and `manifest_uri`. The artifact registry uses a separate package identifier,
such as `github-pdpp`.

The normative rule follows the current reference validator:

- `connector_key` is the operational identifier.
- A known compatibility `connector_id` must map to that key.
- An unknown `connector_id` must equal the key or the manifest is rejected.
- `manifest_uri` is provenance and never operational identity.

The three checked-in profile artifacts have not been validated against one
local Collection Profile schema because no such schema exists here. The GitHub
artifact also uses a different registry host from the other two. Validator and
artifact convergence remains unverified.

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

The Chase and Amazon implementations also use `optional_skip_keys` without the
portable `DETAIL_GAP` evidence required for `gap_keys`. The profile gives
`optional_skip_keys` no portable coverage credit. These implementations remain
runtime-specific until the evidence is reconciled.

## Provisional source-backed fulfillment

`fulfillment.source_backed` is not implemented in this package. Accepted design
work proposes a static per-stream capability and an owner-selected,
per-connection posture. It also proposes an accepted-not-collected health
disposition for a stream served on demand.

This work remains provisional pending OD-4. It is not a v0.1 conformance
requirement. This note does not decide its permanent document or schema home.

## Section map from the previous document

| Previous section | New location | Treatment |
| --- | --- | --- |
| Overview and collection method | Profile Sections 1 and 2 | Kept as scope and Core relationship. |
| Manifest extensions and bindings | Profile Section 3 | Rewritten as a self-contained manifest contract. |
| Checkpoint dependency and validation | Profile Sections 3.6 and 5.3-5.8 | Kept and separated from implementation projections. |
| Run lifecycle | Profile Section 4 | Kept. Cancellation and restart are external failed outcomes. |
| Portable messages | Profile Section 5 | Kept and reconciled with runtime behavior; projection gaps remain in this note. |
| Runtime-specific message fields | This note | Moved out of normative v0.1. |
| Connector and runtime conformance | Profile Section 6 | Kept as separate claims. |
| TypeScript types | `@pdpp/connector-protocol/connector-runtime-protocol` | Moved to the runtime package. |
| Profile versioning | Profile Section 8 | Added for the independent normative document. |
| Source-backed fulfillment | Profile Section 9 and this note | Marked provisional pending OD-4. |
