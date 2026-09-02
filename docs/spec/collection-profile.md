# PDPP Collection Profile v0.1.0

Status: Normative draft

Date: 2026-09-02

## 1. Scope

The Collection Profile defines a connector manifest and a JSON Lines protocol
between a connector and a connector runtime. A connector is a bounded program
that reads data from a source and emits records. A connector runtime selects a
connector, supplies its collection scope and prior state, and processes its
messages.

This profile does not standardize a source platform API, process sandbox,
package format, artifact registry, or resource-server ingest transport.
Legacy `*-playwright` artifacts use a different manifest, page API, and runner.
They do not implement this profile.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and
**OPTIONAL** in this document are to be interpreted as described in
[BCP 14](https://www.rfc-editor.org/info/bcp14),
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119), and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they
appear in all capitals.

This document is normative except where a section is marked non-normative.

## 2. Relationship to PDPP Core

The [PDPP Core specification](https://github.com/PDP-Connect/pdpp/blob/main/spec-core.md)
defines source identity, stream schemas, record identity, and grants. It also
defines the resource-server query interface. This profile uses the same stream
and record semantics. It restates the connector-facing fields needed to write a
connector, so a connector author does not need to read Core.

Core does not require this profile. A resource server can serve pre-collected,
imported, or provider-native data without a connector runtime. Core does not
assume that a connector exists or that a record was collected through this
protocol.

This profile does not delegate authorization to a connector. For a grant-driven
run, the runtime derives `START.scope` from the grant and local policy before it
starts the connector. The connector does not receive the grant, an access
token, or an owner token. The resource server remains responsible for grant
enforcement and treats connector output as untrusted input.

`connector_key` identifies executable connector behavior. It is not a Core
`source.id`. A deployment maps a connector to a source declaration and a
connection outside this wire protocol.

## 3. Connector manifest

A Collection Profile manifest identifies a connector, declares the runtime
features it needs, and describes the streams it can emit.

```json
{
  "protocol_version": "0.1.0",
  "connector_key": "example",
  "version": "1.0.0",
  "display_name": "Example",
  "runtime_requirements": {
    "bindings": {
      "network": { "required": true }
    }
  },
  "protocol_capabilities": [],
  "capabilities": {
    "human_interaction": []
  },
  "streams": [
    {
      "name": "items",
      "semantics": "mutable_state",
      "schema": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"]
      },
      "primary_key": ["id"],
      "incremental": true,
      "coverage_strategy": "checkpoint_window",
      "freshness_strategy": "scheduled_window"
    }
  ]
}
```

### 3.1 Identity and required fields

| Field | Requirement |
| --- | --- |
| `protocol_version` | REQUIRED. It MUST be `"0.1.0"` for this profile version. |
| `connector_key` | REQUIRED operational identifier. It MUST match `^[a-z0-9][a-z0-9._-]*$`. |
| `version` | REQUIRED non-empty connector version string. |
| `display_name` | REQUIRED non-empty display name. |
| `runtime_requirements.bindings` | OPTIONAL binding-requirement map. Absence means no required binding. |
| `protocol_capabilities` | OPTIONAL array of required optional wire capabilities. Absence means the empty set. |
| `streams` | REQUIRED non-empty array of stream declarations. |

Current manifests can also contain `connector_id` and `manifest_uri` during the
identity migration. These are compatibility fields:

- `connector_id`, when present, MUST resolve to `connector_key` through the
  explicit connector registry of the runtime. If the runtime has no such mapping,
  `connector_id` MUST equal `connector_key` or the runtime MUST reject the
  manifest.
- `manifest_uri`, when present, identifies the manifest document or its
  provenance. A runtime MUST NOT use it as the operational connector key,
  source identity, authorization identity, or state namespace.
- An artifact registry can assign a separate package identifier. That
  identifier is outside this profile and MUST NOT replace `connector_key` on
  the wire.

### 3.2 Stream declarations

Each stream declaration has these connector-facing fields:

| Field | Requirement |
| --- | --- |
| `name` | REQUIRED non-empty name. It is unique within the manifest. |
| `semantics` | REQUIRED `append_only` or `mutable_state`. |
| `schema` | REQUIRED JSON Schema for `RECORD.data`. It MUST contain `properties`. |
| `primary_key` | REQUIRED non-empty field-name array. Each field MUST exist in `schema.properties`. |
| `incremental` | OPTIONAL boolean. `true` means the connector can consume prior state and emit a later checkpoint. |
| `cursor_field` | OPTIONAL schema field used for stable ordering and incremental collection. |
| `consent_time_field` | OPTIONAL schema field against which `START.scope.time_range` is applied. |
| `state_stream` | OPTIONAL name of one checkpoint-parent stream. See Section 3.6. |
| `parent_streams` | OPTIONAL non-empty list of checkpoint-parent streams. See Section 3.6. |
| `coverage_strategy` | REQUIRED coverage strategy from Section 3.5. |
| `freshness_strategy` | REQUIRED freshness strategy from Section 3.5. |

The manifest can contain Core declaration fields such as `description`,
`display`, `selection`, `views`, `relationships`, and `query`. A connector
runtime MAY preserve them for a resource server, but this profile does not
change their Core meaning.

### 3.3 Standard bindings

`runtime_requirements.bindings` maps a binding name to an object with a
`required` boolean. Before spawn, a runtime MUST provide every binding whose
declaration has `required: true`. It MAY ignore a binding with
`required: false`.

The standard unqualified binding names are:

| Binding | Meaning |
| --- | --- |
| `browser` | A runtime-managed browser surface. |
| `desktop_session` | The active local desktop session and its operating-system facilities. |
| `filesystem` | Local filesystem access. |
| `interactive` | Handling for `INTERACTION` messages. |
| `network` | Outbound network access. |

A binding declaration can contain binding-specific fields. A connector MUST
ignore declaration fields it does not understand. The binding-name set is
closed in v0.1. A runtime MUST reject any other binding name, whether the
binding is required or optional. It MUST fail a missing required binding before
it starts the connector.

### 3.4 Human interaction and protocol capabilities

`capabilities.human_interaction` is an OPTIONAL array. Its values are
`credentials`, `otp`, and `manual_action`. A connector MUST NOT emit an
`INTERACTION.kind` that the manifest does not declare.

`protocol_capabilities` declares optional wire features that the connector
requires. A runtime MUST advertise its supported protocol version and
capabilities before placement. It MUST reject a connector with an unsupported
required capability before spawn.

The only v0.1 capability is `STREAM_EVIDENCE`. A connector that can emit
`STREAM_EVIDENCE` MUST declare that value. A runtime that does not advertise it
MUST NOT start that connector.

### 3.5 Coverage and freshness strategies

`coverage_strategy` defines checkpoint evidence. This profile constrains these
two values. A runtime can define other values:

| `coverage_strategy` | Meaning |
| --- | --- |
| `checkpoint_window` | A cursor and its evidence account for the completed incremental window. |
| `parent_detail_accounting` | A parent checkpoint depends on detail-record accounting. |

`freshness_strategy` is also a closed set:

| `freshness_strategy` | Meaning |
| --- | --- |
| `device_heartbeat` | Device contact establishes the latest observation time. |
| `manual_as_of` | A manual run supplies the observation time. |
| `not_trackable` | The source provides no useful freshness signal. |
| `scheduled_window` | A scheduled collection window establishes freshness. |
| `source_reported_as_of` | The source supplies an explicit observation time. |

A strategy is a claim about the evidence shape. It does not prove that a run
produced the required evidence.

### 3.6 Checkpoint dependencies

A stream is its own checkpoint parent unless it declares one of these fields:

- `state_stream` names one other stream. The declaring stream MUST use
  `coverage_strategy: "checkpoint_window"`. The stream inherits the checkpoint
  outcome of that parent and MUST NOT emit `DETAIL_COVERAGE` for itself.
- `parent_streams` names one or more other streams. The declaring stream MUST
  use `coverage_strategy: "parent_detail_accounting"`. It emits one
  `DETAIL_COVERAGE` for each parent boundary that it evaluates.

A stream MUST NOT declare both fields. Before spawn, a runtime MUST reject a
manifest with a self-reference, unknown parent, duplicate parent, empty
`parent_streams`, strategy mismatch, or cycle of any length. A valid dependency
graph is acyclic and ends at one or more self-mapped streams.

### 3.7 Implementation metadata

Current artifacts can contain `setup`, `profiles`, `reason_display_messages`,
`options_schema`, `capabilities.refresh_policy`,
`capabilities.public_listing`, and `capabilities.proven`. Stream declarations
can contain `required`, `compaction_fingerprint`, `availability`, and
`coverage_policy`. These members are not part of portable v0.1 conformance. A
runtime MAY support them as implementation metadata. A connector MUST NOT use
such a declaration to grant itself authority, widen collection scope, or bypass
owner approval.

In particular, a connector-authored option kind is only a claim. Runtime or
operator policy decides whether an option changes collection scope. An unknown
option MUST default to the more restrictive collection-scope treatment.

## 4. Run protocol

The runtime and connector exchange one JSON object per line. The runtime writes
to connector standard input. The connector writes to standard output.
Standard error is diagnostic only and MUST NOT contain protocol messages.

Before spawn, the runtime MUST match the bindings required by the connector and
protocol capabilities against its advertised support. A mismatch fails the run
before any connector code executes.

The runtime sends exactly one `START` message. It is the first message on
standard input. The connector reads it before it emits any message. A connector
that receives a second `START` MUST fail.

The connector states are:

| State | Meaning |
| --- | --- |
| `initializing` | The connector is waiting for `START`. |
| `collecting` | The connector is collecting data and emitting messages. |
| `waiting_for_interaction` | The connector has one pending `INTERACTION`. |
| `succeeded` | The connector emitted successful `DONE` and exited 0. Terminal. |
| `failed` | The connector failed or the runtime terminated it. Terminal. |

| Current state | Event | Next state |
| --- | --- | --- |
| `initializing` | Receive valid `START` | `collecting` |
| `collecting` | Emit `INTERACTION` | `waiting_for_interaction` |
| `waiting_for_interaction` | Receive matching `INTERACTION_RESPONSE` | `collecting` |
| `collecting` | Emit successful `DONE`, then exit 0 | `succeeded` |
| Any active state | Fatal error, failed `DONE`, cancellation, supervisor loss, or invalid exit | `failed` |

A connector with a pending interaction MUST NOT emit a second `INTERACTION`.
A runtime that receives one MUST terminate the connector and fail the run. A
connector that receives an interaction response with no matching pending
request MUST fail.

Cancellation and supervisor restart are runtime events. A cancelled run can use
`DONE.status: "cancelled"`. After a supervisor restart, the prior run remains
failed or abandoned and does not commit staged state.

## 5. Messages

### 5.1 `START`

The runtime sends `START` to initialize one run.

```json
{
  "type": "START",
  "run_id": "run-abc123",
  "collection_mode": "incremental",
  "scope": {
    "streams": [
      {
        "name": "items",
        "resources": ["item-1"],
        "fields": ["id", "name"],
        "time_range": { "since": "2026-01-01T00:00:00Z" }
      }
    ]
  },
  "state": { "items": { "cursor": "abc" } },
  "bindings": { "network": {} }
}
```

| Field | Requirement |
| --- | --- |
| `type` | REQUIRED `"START"`. |
| `run_id` | REQUIRED non-empty identifier for this run. |
| `scope.streams` | REQUIRED non-empty array of stream targets. |
| `collection_mode` | REQUIRED `full_refresh` or `incremental`. |
| `state` | REQUIRED map of prior connector-owned state, or `null` when no prior state applies. |
| `bindings` | REQUIRED map of binding names to descriptors available for this run. |

Each scope stream has a REQUIRED `name`. `resources` is an OPTIONAL array of
canonical record-key strings. `fields` is an OPTIONAL array of top-level record
fields. `time_range` is an OPTIONAL object with `since` and `until` timestamps.
A runtime MUST resolve wildcards and view names before `START`. It MUST NOT send
a wildcard stream name or an issuance-time `necessity` value.

The runtime MUST include a descriptor for each required manifest binding. A
connector MUST fail if a required descriptor is missing. It MUST ignore
additional binding descriptors.

A connector MUST emit records only for streams in `scope.streams`. If
`resources`, `fields`, or `time_range` is present, the connector MUST apply it
before emission. The runtime MUST add schema-required and ingest-required fields
to a requested `fields` list before it sends `START`. A connector that cannot
apply a constraint MUST emit `SKIP_RESULT` with
`reason: "scope_not_supported"` for that stream or fail the run. It MUST NOT
silently broaden scope.

The runtime and durable write path MUST reject or discard an out-of-scope
record. A connector can read broader source-side data when the source cannot
filter precisely, but it MUST restrict what it emits.

Runtime-specific `START` members for backfill and detail-gap recovery are
defined in the runtime note. They are not portable v0.1 fields.

### 5.2 `RECORD`

```json
{
  "type": "RECORD",
  "stream": "items",
  "key": "item-1",
  "data": { "id": "item-1", "name": "Example" },
  "emitted_at": "2026-09-02T00:00:00Z"
}
```

`stream`, `key`, `data`, and `emitted_at` are REQUIRED. `key` is a string or
an array of strings. An array preserves composite-key field order. `data` MUST
conform to the stream schema.

`op` is OPTIONAL. The only explicit value is `delete`. Absence means upsert.
A delete identifies a record by `stream` and `key`. Its `data` object MAY
contain only key fields.

### 5.3 `STATE`

```json
{ "type": "STATE", "stream": "items", "cursor": { "cursor": "abc" } }
```

`stream` and `cursor` are REQUIRED. The cursor is opaque to the runtime. Only
the connector interprets it on a later run.

The runtime stages `STATE` only after it durably writes all prior records. It
commits staged state only after successful `DONE`, except for the certified
stream-scoped failure in Section 5.8. It MUST NOT commit state after
cancellation, supervisor loss, a protocol violation, an invalid exit, or an
uncertified failed `DONE`.

A connector MUST NOT put a credential, access token, owner token, or other
secret in state.

### 5.4 `INTERACTION` and `INTERACTION_RESPONSE`

```json
{
  "type": "INTERACTION",
  "request_id": "request-1",
  "kind": "otp",
  "message": "Enter the verification code",
  "timeout_seconds": 300
}
```

`request_id`, `kind`, and `message` are REQUIRED. `schema` and
`timeout_seconds` are OPTIONAL. The connector stops emitting messages until it
receives the matching response.

```json
{
  "type": "INTERACTION_RESPONSE",
  "request_id": "request-1",
  "status": "success",
  "data": { "code": "123456" }
}
```

The response status is `success`, `cancelled`, or `timeout`. `data` can be
present only for `success`. If the interaction times out, the runtime MUST send
a `timeout` response instead of leaving the connector blocked.

A runtime MUST NOT log or persist response data. It MUST limit credential data
to the pending connector interaction.

### 5.5 `SKIP_RESULT`

```json
{
  "type": "SKIP_RESULT",
  "stream": "items",
  "reason": "scope_not_supported",
  "message": "The source cannot filter these records"
}
```

`stream`, `reason`, and `message` are REQUIRED. The message reports an
intentional omission. It does not change connector state.

`recovery_hint` is OPTIONAL. It is either an action string or an object with a
REQUIRED `action` string and an OPTIONAL boolean `retryable`. Portable v0.1
actions are `retry_by_runtime`, `retry_on_connector_upgrade`,
`refresh_credentials`, `manual_action_required`, `update_selector`,
`upstream_unblock`, `not_retriable`, and `unknown`.

A runtime MUST reject an invalid portable recovery hint. It MUST NOT infer a
connector-requested action from free-form `message`, diagnostics, or an error
code.

### 5.6 `DETAIL_GAP` and `DETAIL_COVERAGE`

`DETAIL_GAP` records a retryable failure for one detail record.

```json
{
  "type": "DETAIL_GAP",
  "reference_only": true,
  "status": "pending",
  "stream": "item_details",
  "parent_stream": "items",
  "record_key": "item-1",
  "reason": "temporary_unavailable",
  "retryable": true,
  "detail_locator": { "kind": "item", "id": "item-1" }
}
```

`reference_only: true`, `status: "pending"`, `stream`, `record_key`, `reason`,
`retryable: true`, and `detail_locator` are REQUIRED. `record_key` is a string
or number. `detail_locator.kind` is REQUIRED. It MUST contain no secret.
Portable reasons are `rate_limited`,
`retry_exhausted`, `temporary_unavailable`, and `upstream_pressure`.
`parent_stream` is REQUIRED when the detail stream has more than one declared
parent. It MAY be omitted when the manifest gives the stream exactly one
parent.

`DETAIL_COVERAGE` reports the complete key accounting for one detail stream and
one checkpoint-parent boundary.

```json
{
  "type": "DETAIL_COVERAGE",
  "reference_only": true,
  "stream": "item_details",
  "state_stream": "items",
  "required_keys": ["item-1"],
  "hydrated_keys": [],
  "gap_keys": ["item-1"]
}
```

`reference_only: true`, `stream`, `state_stream`, `required_keys`, and
`hydrated_keys` are REQUIRED. `gap_keys` is OPTIONAL. Each key is a string or
number. Each key array MUST contain no duplicate. Every hydrated or gap key
MUST also be a required key. A gap key counts as accounted only when the runtime
observed a matching `DETAIL_GAP` for the same stream, key, and parent boundary.

A `parent_streams` stream emits at most one final coverage message for each
declared parent boundary evaluated in a run. It emits the message after the
last related `RECORD` or `DETAIL_GAP`. A runtime MUST reject coverage for an
undeclared parent. It MUST reject any `DETAIL_COVERAGE` emitted for a
`state_stream` child.

A missing coverage report or an unaccounted required key makes that parent
checkpoint ineligible to commit. Runtime-specific `considered`, `covered`, and
`optional_skip_keys` members do not establish portable v0.1 coverage.

### 5.7 `STREAM_EVIDENCE`

`STREAM_EVIDENCE` reports independently measured outcomes for a stream that
declares `state_stream`. It reports the enumeration of the child stream. It
never gates a checkpoint commit.

```json
{
  "type": "STREAM_EVIDENCE",
  "reference_only": true,
  "stream": "item_bodies",
  "considered": 10,
  "outcomes": {
    "emitted": 8,
    "unchanged": 1,
    "gapped": 1,
    "unaccounted": 0
  }
}
```

`reference_only: true`, `stream`, `considered`, and all four outcome counts are
REQUIRED. Each count MUST be a non-negative integer no greater than
`9007199254740991`. The outcomes are disjoint and their sum MUST equal
`considered`.

A connector MUST measure `considered` at the enumeration site of the child stream
site. It MUST NOT derive the value only from emitted and gapped messages. It
MUST withhold the message when it did not enumerate that stream. A connector
MAY emit at most one `STREAM_EVIDENCE` per stream per run.

A runtime MUST reject an invalid count partition, a duplicate message, an
out-of-scope stream, or a stream that does not declare `state_stream`. The
runtime can compare `emitted` and `gapped` with messages it observed. It cannot
independently verify `unchanged`, a withheld message, or how the connector
derived `considered`. Those values remain connector assertions and MUST NOT be
used to widen scope or commit a checkpoint.

### 5.8 `DONE` and checkpoint commit

```json
{ "type": "DONE", "status": "succeeded", "records_emitted": 42 }
```

`DONE` is the final connector message. `DONE.status` has three values:
`succeeded`, `failed`, and `cancelled`. `records_emitted` is a REQUIRED
non-negative integer.
A failed message includes `error` with a REQUIRED non-empty `message` and
boolean `retryable`. It can also include a stable snake-case `code` and a
`recovery_hint` as defined in Section 5.5.

A successful connector emits successful `DONE` and exits 0. A failed connector
emits failed `DONE` where possible and exits non-zero. A runtime MUST fail the
run if the process exits without valid `DONE` or emits a message after `DONE`.
It MUST also fail a terminal status that conflicts with the process exit code.

A failed run certifies a stream-scoped failure only when both facts are true:

1. `DONE.error.code` is `stream_collection_failed`.
2. The runtime observed an in-scope `SKIP_RESULT` with
   `reason: "stream_collection_failed"` for each failed data stream.

On a certified stream-scoped failure, a runtime MAY commit staged state for an
unaffected checkpoint stream with complete detail coverage. It resolves the
checkpoint parents of all failed streams from the manifest. It adds each parent
with missing or incomplete coverage and withholds that full set. The overall
run remains failed.

If one eligible state write fails during a multi-checkpoint commit, the runtime
MUST fail the run. It MUST make the failing checkpoint and every checkpoint
already committed observable.

### 5.9 `PROGRESS`

```json
{
  "type": "PROGRESS",
  "stream": "items",
  "message": "Collected 50 items",
  "count": 50,
  "total": 100
}
```

`message` is REQUIRED. `stream`, `count`, and `total` are OPTIONAL. `PROGRESS`
does not change connector state and does not prove collection coverage.

## 6. Conformance

### 6.1 Connector conformance

A conforming connector:

1. Declares a valid v0.1 manifest.
2. Reads one valid `START` before it emits a message.
3. Emits only valid JSON Lines messages defined by this profile or by a
   negotiated extension.
4. Emits records only within `START.scope` and validates each record against
   its declared stream schema.
5. Emits final `DONE` where possible and emits nothing after it.
6. Emits `STATE` only after the records covered by that state.
7. Stores no secret in state, diagnostics, or detail locators.
8. Waits for a matching response after `INTERACTION`.
9. Declares every optional protocol capability it can emit.
10. Produces the checkpoint and detail evidence required by its declared
    strategies.

### 6.2 Runtime conformance

A conforming runtime:

1. Validates the manifest and matches bindings and protocol capabilities before
   spawn.
2. Sends one first `START` with a non-empty, resolved scope.
3. Enforces that scope again before durable write.
4. Treats connector messages and state as untrusted input.
5. Handles one pending interaction, limits its secret data, and returns an
   error response on timeout.
6. Stages and commits state only under Section 5.3 and Section 5.8.
7. Validates checkpoint dependencies, coverage, and gaps. If it advertises
   `STREAM_EVIDENCE`, it also validates that message as defined in Section 5.7.
8. Terminates a connector on a protocol violation.
9. Does not report a cancelled, abandoned, malformed, or incomplete run as
   successful.

Connector conformance and runtime conformance are separate claims. An artifact
registry entry or successful package installation does not establish either
claim.

## 7. Runtime-specific extensions

This profile does not define `ASSISTANCE`, `ASSISTANCE_STATUS`,
`DETAIL_GAPS_PAGE_REQUEST`, `DETAIL_GAPS_PAGE_RESPONSE`,
`DETAIL_GAP_ATTEMPTED`, or `DETAIL_GAP_RECOVERED`. It also does not define
`START.detail_gaps`, `START.recovery_only`, or `START.streamsToBackfill`.
It does not define `CANCEL`, `RECORD_ERROR`, or a versioned `STATE` schema.

A runtime MAY define these features in a separately versioned extension. A
connector MUST NOT require one without explicit capability or package-version
coordination. None is required for v0.1 conformance.

## 8. Profile versioning

The Collection Profile version is independent of connector package versions,
connector versions, and runtime package versions. The manifest
`protocol_version` identifies the profile version that the manifest implements.

Profile versions use `MAJOR.MINOR.PATCH`:

- A patch version clarifies text or fixes an error without changing a valid
  manifest or wire exchange.
- A minor version can add optional, capability-gated fields or messages. It
  MUST preserve valid exchanges from earlier minor versions in the same major
  version.
- A major version can make incompatible manifest or wire changes.

A runtime MUST NOT infer compatibility from an unknown version. It MUST either
support that exact version or apply an explicit compatibility rule that it
advertises. A new optional message that an older fail-closed runtime would
reject requires capability negotiation and a runtime-first rollout.
