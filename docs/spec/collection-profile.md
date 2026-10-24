# PDPP Collection Profile v0.3.0

Status: Normative draft. This is the canonical PDPP Collection Profile.

Date: 2026-10-22

## 1. Scope

The Collection Profile defines a connector manifest and a JSON Lines protocol
between a connector and a connector runtime. A connector is a bounded program
that reads data from a source and emits records. A connector runtime selects a
connector, supplies its collection scope and prior state, and processes its
messages.

This document is the canonical Collection Profile. It is normative for
connectors and connector runtimes in the PDPP ecosystem, in this repository and
elsewhere. Its machine-readable half is
[`schemas/connector-manifest.schema.json`](../../schemas/connector-manifest.schema.json),
which validates `runtime_requirements.bindings` and the `coverage_stores`
declaration rule of Section 7.1.1, together with
[`schemas/connector-binding-grammar.mjs`](../../schemas/connector-binding-grammar.mjs),
which canonicalizes and validates the constraint grammars of Section 3.3.2
beyond what JSON Schema alone can express.
[`schemas/connector-manifest.schema.test.mjs`](../../schemas/connector-manifest.schema.test.mjs)
checks that the binding, feature, and filesystem input tables in Section 3.3
match the schema, and
that every manifest under `connectors/` validates against it.
[`schemas/observation.schema.json`](../../schemas/observation.schema.json)
validates the `OBSERVATION` message of Section 5.10 and the
`diagnostic_descriptors` member of Section 3.8.
[`schemas/observation.schema.test.mjs`](../../schemas/observation.schema.test.mjs)
checks that the fact table in Section 5.10.1 matches that schema.

`PDP-Connect/pdpp` publishes `spec-collection-profile.md`, marked
`Status: Informative`. That copy defines no conformance requirement. Where it
differs from this document, for example in binding names, `DONE.status`, or
`coverage_strategy` values, this document governs.

This profile does not standardize a source platform API, process sandbox,
package format, artifact registry, or resource-server ingest transport. The
retired legacy `*-playwright` artifacts used a different manifest, page API,
and runner. They do not implement this profile.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and
**OPTIONAL** in this document are to be interpreted as described in
[BCP 14](https://www.rfc-editor.org/info/bcp14),
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119), and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they
appear in all capitals.

This document is normative except where a section is marked non-normative.
Version 0.3.0 is a breaking revision of 0.2.0, as a 0.x minor version may be.
A runtime MUST apply the rules of 0.3.0 only to a manifest that declares
`protocol_version` `"0.3.0"`. It MUST NOT apply them to a manifest that
declares `"0.1.0"` or `"0.2.0"`, and it MUST NOT apply the rules of those
versions to a manifest that declares `"0.3.0"`. Version 0.3.0 is not a claim
that existing connectors, runtimes or linked machine-readable schemas implement
it. Strict accounting requires implementation and conformance work before
accepting this version. It includes the 0.2.0 diagnosis requirements in full.

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
  "protocol_version": "0.3.0",
  "connector_key": "example",
  "version": "0.3.0",
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
| `protocol_version` | REQUIRED. It MUST be `"0.3.0"` for this profile version. |
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
| `coverage_stores` | OPTIONAL. Valid only with the `RUN_COVERAGE_V1` declaration of Section 7.1.1. |

An `append_only` stream contains immutable events. A connector adds records and
MUST NOT update or delete an existing record. Repeating the same key is an
idempotent retry. A `mutable_state` stream contains the current state of an
entity. A connector can update or delete that state by primary key.

`primary_key` names the data fields that uniquely identify a record in its
stream. For a composite key, declaration order is significant. A declared
`cursor_field` defines stable ordering by `(cursor_field, primary_key)`.
`consent_time_field` names the field used for `time_range` filtering.

The manifest can contain Core declaration fields such as `description`,
`display`, `selection`, `views`, `relationships`, and `query`. A connector
runtime MAY preserve them for a resource server, but this profile does not
change their Core meaning. Relationships used for strict detail accounting
are an exception to optional preservation: the manifest MUST declare them
and the runtime MUST validate and retain them under Section 5.2.

### 3.3 Bindings

`runtime_requirements.bindings` maps a binding name to a binding declaration.
Each declaration is an object with a REQUIRED `required` boolean. Before spawn,
a runtime MUST provide every binding whose declaration has `required: true`. It
MAY omit a binding with `required: false`.

The binding registry is:

| Binding | Meaning |
| --- | --- |
| `browser` | A runtime-managed browser surface. |
| `desktop_session` | The owner's active, logged-in desktop session and its operating-system facilities, such as the session keyring. |
| `filesystem` | Access to local files. Section 3.3.5 defines declared inputs. |
| `network` | Outbound network access. |

Unqualified binding names are reserved for this registry. A runtime MUST
reject an unqualified name that is not in the registry, whether the binding is
required or optional. An extension binding uses a namespaced name of the form
`<domain>/<name>`, where `<domain>` is a DNS name that the extension author
controls, for example `example.com/scanner`. A runtime MUST fail the run
before spawn when it does not support a required extension binding. It MAY
ignore an optional extension binding that it does not support.

The informative pdpp copy of this profile listed four names that are not in
this registry. No manifest in this repository uses them. That copy defined no
conformance requirement, so there was no earlier normative registry to
version, and dropping these names does not change the profile version. A
manifest that uses one of them migrates as follows:

| Removed name | Replacement |
| --- | --- |
| `browser_automation` | `browser`, with the `features` the connector needs (Section 3.3.8). |
| `browser_profile` | None. A persistent browser profile is a runtime concern under `browser`. A connector that truly needs its own profile declares a namespaced extension binding. |
| `interactive` | `capabilities.human_interaction` (Section 3.4). |
| `loopback_listen` | A namespaced extension binding. |

A runtime already fails, before spawn, a run whose required binding it cannot
satisfy, so an unmigrated manifest fails closed rather than running without the
binding it asked for.

`local_device` is not a binding. It names a runtime mode in which the runtime
runs on the owner's own device. A connector that reads local files declares
`filesystem`. A connector that needs the owner's logged-in session declares
`desktop_session`.

A binding declaration can contain binding-specific fields. A connector MUST
ignore declaration fields it does not understand. A runtime MUST fail a missing
required binding before it starts the connector.

The four bindings above are initial resource families, not a ceiling. A new core binding is admitted into the registry when it needs its own enforcement, availability, consent, or revocation that no existing binding provides. A namespaced extension binding is promoted into the registry against those same criteria.

A declared constraint, such as `filesystem.inputs`, is not an access limit unless a runtime enforces it. A runtime or tool MUST NOT present a recorded-only declaration to the owner as a limit on what the connector can access.

#### 3.3.1 Binding instances

A binding declaration names one binding instance. `runtime_requirements.bindings`
maps an instance key to its declaration, and the runtime resolves each
instance into its own restricted handle before spawn.

An instance key is either a registry or namespaced binding name, used as
shorthand for one instance of that kind, or a free-form author-local name.

A registry name (`browser`, `desktop_session`, `filesystem`, `network`) or a
namespaced extension name, used as an instance key, is shorthand for one
instance of that kind with an unspecified interface version. A shorthand
declaration MUST NOT contain a `kind` member; the key already names the kind.
Every manifest written before this section used only shorthand keys, and
keeps its meaning unchanged.

A free-form instance key MUST match `^[a-z][a-z0-9_]*$` and MUST NOT equal a
registry name. Its declaration MUST contain a `kind` member naming a registry
or namespaced binding name. The kind, not the key, selects which features and
constraints the instance can declare: an instance keyed `chase_site` with
`"kind": "browser"` uses the same feature and constraint shape as the
`browser` shorthand.

Every instance key in a manifest MUST be unique. A manifest's JSON text MUST
NOT repeat an object key anywhere, including an instance key. A JSON parser
that silently keeps only the last value for a repeated key hides an author or
generator mistake, and two conforming readers could disagree about which
value won.

An instance's `interface` member states its interface version, for example
`browser@1`. It is OPTIONAL. Its absence means an unspecified interface
version, which is what every shorthand instance meant before this section. A
stated interface version MUST have the form `<kind>@<version>`, where
`<kind>` is the instance's kind and `<version>` is a positive integer with no
leading zero.

This revision defines no behavioral difference between interface versions of
one kind. `browser@1`, `network@1`, `filesystem@1`, and `desktop_session@1`
are the only versions in use. A later profile revision can define a kind's
next version, alongside the compatibility rule a runtime that supports only
the earlier version follows.

#### 3.3.2 Constraint grammars

A `browser`, `network`, `filesystem`, or `desktop_session` instance declares
its typed constraints, if any, in a `constraints` object. An instance that
declares no `constraints` makes no claim about which destinations, paths, or
secret items it reaches; Section 3.3.13 states how a runtime and an
owner-facing tool MUST treat that absence.

`browser` and an HTTP(S) `network` host share one grammar for a web origin or
host: `[scheme://]host[:port]`. `host` is a DNS name, an IPv4 address, or a
bracketed IPv6 address. The value carries no path, query, fragment, or
userinfo. `host` is either the exact host or one leading `*.` wildcard label
followed by at least one more label; a wildcard MUST NOT apply to an IP
literal.

A wildcard matches one or more leftmost labels prepended to its apex, at any
depth, and never the bare apex itself: `*.chase.com` matches
`secure.chase.com` and `a.b.chase.com`, but not `chase.com`. This follows
the CSP host-source convention, the same reduction the confidence pass behind
this grammar found across every surveyed wildcard syntax (Section 3.3.2's
evidence base). An author who also needs the bare apex reachable lists it as
its own separate entry; the wildcard does not imply it. The single leading
`*.` label in the grammar above is this profile's wildcard SYNTAX; it does
not bound the MATCHING depth, which real traffic needs: a live capture for
this profile loaded `b.thumbs.redditmedia.com`, two labels under
`redditmedia.com`, which `*.redditmedia.com` must cover.
`schemas/connector-binding-grammar.mjs#hostMatchesWildcardApex` is the
reference implementation.

A manifest MUST state a web origin or host in its canonical form: lowercase;
the host converted to ASCII by the Unicode IDNA/UTS46 algorithm; the scheme's
default port (80 for `http`, 443 for `https`) dropped if stated; an IPv6
address written in its normalized, compressed, lowercase, bracketed form; and
a single trailing dot, if present, removed. A manifest MUST NOT state a host
as an IPv4-looking label, such as a decimal, octal, or hexadecimal number,
unless it is already the exact dotted-quad address. A runtime or validator
MUST reject a non-canonical IPv4-looking label rather than reinterpret it as
an address, because DNS resolvers and runtimes disagree about which address a
non-canonical form names. A publish-time linter MUST reject a web origin or
host that is not already in this canonical form, so two readers of the same
manifest never need to normalize it differently.

An omitted scheme matches every scheme the constraint's context allows
(Section 3.3.3, 3.3.4). An omitted port matches only the matching scheme's own
default port; it does not mean "any port", unlike a CSP host-source value with
no port. An explicit port matches exactly that port.

A wildcard host names an unlisted number of subdomains, so a runtime MUST
re-check a redirect's destination at every hop against the same constraint
list it checked for the original request, for both `navigate` and `connect`;
it MUST NOT treat only the first hop of a redirect chain as checked. A
publish-time linter MUST reject a wildcard whose apex is a public suffix by
checking the apex against the full Public Suffix List, including its private
section; a manifest schema validator is not required to carry that list,
because the list changes independently of this profile. The private section
matters in practice: a site's essential assets often come from a per-customer
subdomain of shared hosting, for example a CDN distribution host under
`cloudfront.net` or an object-storage bucket host under
`s3.amazonaws.com`. A wildcard one label above that subdomain, such as
`*.cloudfront.net` or `*.s3.amazonaws.com`, would grant every other AWS
customer's content on that host, not just the one site the connector targets.
The PSL lists both domains in its private section for exactly this reason,
and a publish-time lint against the full list catches this case; an author
who needs one of these hosts lists the exact per-customer host instead of a
wildcard.

A destination that resolves to a private or link-local address is denied
unless the instance declares it, judged on the address the connector or
browser actually connects to, not on the literal host text. Section 3.3.13
requires a `rationale` member on an instance that declares this exception,
alongside any other exceptional grant.

A `network` instance can name a destination through a manifest setup field
instead of a literal, because some destinations are only known at install
time (a self-hosted base URL, a CardDAV origin, a Jellyfin server):
`{"setup_field": "<field name>"}`. This is a typed reference, not string
interpolation into a constraint string. A runtime MUST resolve a
`setup_field` reference to one concrete value before the owner approves the
grant, and MUST show the owner that concrete value, not the field name.
`{"setup_field": "...", "allow_private": true}` admits a private or
link-local resolution of that one field without the instance otherwise being
treated as reaching every private address.

The owner's approval of a `setup_field` grant binds to the concrete canonical
value the runtime resolved and showed at approval time, not to the field
itself. A later change to that setup field, for example the owner editing a
self-hosted base URL, invalidates the existing grant for that destination; a
runtime MUST NOT carry an approval forward onto a new resolved value without
the owner approving the new value. This mirrors how a manifest constraint
itself is a fixed value the owner approves once, not a live reference the
runtime can silently re-point.

Provisional: a response-derived host (a signed export URL's host, a partition
host a validation response names) is not yet part of this grammar. The design
intends a bounded, policy-approved grant tied to the response that named the
host, never automatic trust in a URL a connector happens to receive. Exact
member names are not decided; a manifest MUST NOT claim conformance for a
member that implements this before it is specified.

A `network` instance can also name a non-HTTP, non-WebSocket endpoint,
because forcing a protocol such as IMAP into an HTTP-shaped origin would
misstate what the connector reaches: `scheme://host[:port]`, with the same
host canonicalization as above, no wildcard, and the scheme stated explicitly
(for example `imaps://imap.gmail.com`). `http`, `https`, `ws`, and `wss` are
not valid endpoint schemes: the first two use the web-host grammar above, and
the WebSocket schemes are reserved for `browser.connect` (Section 3.3.3), not
for a `network` endpoint. An endpoint's port MAY be omitted only when its
scheme is one of the following, which this profile treats as having one
conventional default port: `imap` (143), `imaps` (993), `pop3` (110),
`pop3s` (995), `smtp` (25), `smtps` (465), `submission` (587), `ldap` (389),
`ldaps` (636), `ftp` (21), `ftps` (990). An endpoint whose scheme is not in
that list MUST state its port. A later revision may admit a host-side
WebSocket endpoint distinct from `browser.connect`, if a connector needs one
that does not go through a page; this revision does not define one.

#### 3.3.3 Browser constraints

A `browser` instance MAY contain `constraints.navigate` and
`constraints.connect`, each a non-empty array of unique web hosts in the
grammar of Section 3.3.2.

```json
"chase_site": {
  "kind": "browser",
  "interface": "browser@1",
  "required": true,
  "features": ["page_navigation", "page_input"],
  "constraints": {
    "navigate": ["https://secure.chase.com", "https://*.chase.com"],
    "connect": ["https://*.chase.com", "https://*.chasecdn.com"]
  }
}
```

`navigate` lists the origins the browser may load as a navigable document:
the top-level page the connector drives, and a frame within it that itself
loads a document, such as an embedded anti-abuse challenge, a consent
dialog, or an identity-provider sign-in page. It does not list a resource the
page merely fetches or renders without navigating to it.

A live capture can show a frame the flow cannot complete without: a CAPTCHA
challenge the site requires before it accepts a login, or a cookie-consent
dialog that blocks interaction until the owner responds to it. These frames
are part of `navigate`, the same as the top-level page, not an optional
extra. An author who knows a flow depends on such a frame lists its origin.
A runtime that does not grant a listed, required frame MUST let the
dependent flow fail visibly; it MUST NOT let the connector silently proceed
past a login or consent step it could not actually complete.

`connect` lists the hosts any request from the page may reach: subresources
(scripts, stylesheets, images, fonts), `fetch` and `XMLHttpRequest`, and a
WebSocket. Because a WebSocket is opened from a document already loaded over
HTTP(S), `connect` accepts the `ws` and `wss` schemes in addition to `http`
and `https`; `navigate` accepts only `http` and `https`, because a navigation
always loads a document. A live capture of a browser connector's traffic
typically needs both forms: for example `wss://ws.example.com` alongside
`https://*.example.com`.

A page's own subresources and third-party scripts reach hosts beyond the
connector's own navigation: a content delivery network under the site's own
domain or a dedicated asset domain, and a provider script a page loads
unconditionally before the owner makes any choice. `connect` lists are
therefore normally wider than `navigate`, and a per-site or per-CDN wildcard
(`*.example.com`, `*.examplecdn.com`) is the expected author form. A
third-party script a page loads unconditionally, without the owner choosing
it, is a `connect` concern: an author who can identify it lists it in
`connect` like any other host, and a runtime MAY block it without failing the
run if it is not listed (for example an analytics or telemetry endpoint the
connector does not need).

A runtime MUST record every blocked `connect` request in the observation data
behind the effective-authority record (Section 3.3.9), whether or not the
block fails the run. A runtime MUST NOT let a blocked request silently change
what the connector collects: if the missing resource would alter the data a
connector emits, the run MUST fail or the omission MUST be surfaced to the
run's result, not absorbed as if the request had never been blocked. Whether
one blocked request is consequential is a judgment the runtime or connector
author makes; the observability requirement is not conditional on that
judgment.

Provisional: a one-run grant for the owner's in-session choice of a sign-in
provider the author cannot enumerate in advance is not yet part of this
grammar. It applies only to the owner's own navigation to that provider (for
example clicking "Sign in with Google" during `manual_action`), never to a
provider script or stylesheet a page loads on its own, which is an ordinary
`connect` entry and needs no such grant. Exact member names are not decided.

#### 3.3.4 Network constraints

A `network` instance MAY contain `constraints.hosts`, a non-empty array of
unique entries. Each entry is a web host or non-HTTP endpoint in the grammar
of Section 3.3.2, or a setup-field reference.

```json
"self_hosted_api": {
  "kind": "network",
  "interface": "network@1",
  "required": true,
  "constraints": { "hosts": [{ "setup_field": "base_url" }] }
}
```

```json
"mailbox": {
  "kind": "network",
  "required": true,
  "constraints": { "hosts": ["imaps://imap.gmail.com"] }
}
```

A `hosts` entry that states an `http` or `https` scheme, or no scheme, uses
the web-host grammar (wildcard allowed). Any other explicit scheme uses the
non-HTTP endpoint grammar (exact host, scheme and, where the scheme has no
listed default, port required).

#### 3.3.5 Filesystem inputs

A `filesystem` declaration MAY contain `inputs`, the list of local paths the
connector reads:

```json
"filesystem": {
  "required": true,
  "inputs": [
    {
      "env_var": "APPLE_HEALTH_EXPORT_DIR",
      "kind": "dir",
      "access": "read",
      "accepted_extensions": [".zip", ".xml"]
    }
  ]
}
```

| Field | Requirement |
| --- | --- |
| `env_var` | REQUIRED. The environment variable through which the runtime passes the path. It MUST match `^[A-Z][A-Z0-9_]*$` and MUST be unique within `inputs`. |
| `kind` | REQUIRED. `file` or `dir`. |
| `access` | REQUIRED. `read` is the only 0.3.0 value. |
| `accepted_extensions` | OPTIONAL non-empty array of unique lowercase extensions, each with a leading dot. It names the file types the connector reads from the input. |

An input object has no other members. `inputs`, when present, is a non-empty
array.

Each input is a slot: the runtime supplies a path through its `env_var`. A
connector can also have an implementation-specific default path that it uses
when the variable is unset, such as a local application's data directory under
the user's home. The default is not part of the input declaration.

Declared inputs serve three purposes. They let a runtime grant least
privilege. They show the owner and the runtime exactly what a connector reads.
They let a replay runtime bind recorded inputs read-only.

When a `filesystem` declaration contains `inputs`:

- A runtime that supplies a path for an input MUST set its `env_var` to a path
  of the declared `kind`.
- A runtime that confines filesystem access, for example with a sandbox or
  container mounts, MUST make only the declared inputs visible to the
  connector. When `access` is `read`, it MUST make the input read-only.
- The connector MUST NOT create, modify, rename, or delete anything under a
  `read` input.
- The runtime SHOULD show the owner each declared input and the path it
  resolves to before the first run.
- The connector MUST NOT read owner data from a local path outside its
  declared inputs. A default path that the connector uses when an input's
  `env_var` is unset counts as that input.

A connector that runs on the owner's device and reads fixed paths under the
user's home directory declares an input for each such path and documents its
default location. The input's `env_var` is the variable that overrides the
default. `runtime_requirements.local_paths` (Section 3.7) can still describe the
default location and readiness checks. A confining runtime that wants the
connector to read the default location supplies it through the `env_var`.

A `filesystem` declaration without `inputs` remains valid in 0.3.0. It makes no
claim about which paths the connector reads, so a runtime cannot narrow the
binding. A runtime SHOULD tell the owner that such a connector has broad file
access.

Connector catalogs do not yet carry `inputs`. The catalog in this repository
projects each binding to `required` and `features`, because installers validate
the catalog against the schema bundled in their release. A runtime reads
declared inputs from the manifest in the signed connector artifact.

`setup.manual_or_upload.import_dir_env_var` is deprecated. A `dir` input
supersedes it. A runtime that implements this revision of the profile and
supports `import_dir_env_var` MUST accept both forms for the remaining 0.x
versions of the profile; only a major version (Section 8) can remove
`import_dir_env_var`. A runtime built before this revision is not required to
read `inputs`. During the transition:

- A new manifest SHOULD declare `inputs` instead of `import_dir_env_var`.
- A manifest that carries both MUST name the same variable in
  `import_dir_env_var` and in the `env_var` of one `dir` input. A runtime
  MUST use `inputs` when both are present.
- A runtime that finds `import_dir_env_var` and no `inputs` SHOULD treat the
  variable as one `dir` input with `access: "read"`.

A filesystem-kind instance's inputs can also be declared at `constraints.inputs`
(Section 3.3.1), in the same shape as the top-level `inputs` member above.
`inputs` at the top level of the declaration is an alias for
`constraints.inputs`: an instance MAY declare either, or both. A runtime MUST
normalize both forms to one list. A manifest that declares both MUST make the
two lists equal as sets of whole input entries: matching `env_var` alone is
not enough, because two entries with the same `env_var` but a different
`kind`, `access`, or `accepted_extensions` describe different inputs. A
runtime MUST reject a manifest whose two declarations disagree on any member
of an entry. The `import_dir_env_var` precedence given above is unchanged: a
runtime resolves it against whichever input list results from this
normalization.

#### 3.3.6 Filesystem outputs and scratch

A `filesystem` instance MAY contain `constraints.outputs`, a non-empty array
of declared output roots:

```json
"chase_statements": {
  "kind": "filesystem",
  "interface": "filesystem@1",
  "required": true,
  "constraints": {
    "outputs": [
      { "slot": "scratch", "access": "write" },
      { "slot": "statements", "access": "write", "durable": true, "overwrite": false, "delete": false }
    ]
  }
}
```

| Field | Requirement |
| --- | --- |
| `slot` | REQUIRED. An author-local name for the output root, matching `^[a-z][a-z0-9_]*$`. |
| `access` | REQUIRED. `write` is the only 0.3.0 value. |
| `overwrite` | OPTIONAL boolean. Whether the connector may overwrite an existing file in this slot. Default false. |
| `delete` | OPTIONAL boolean. Whether the connector may delete a file in this slot. Default false. |
| `durable` | OPTIONAL boolean. Whether this slot persists across runs. Default false. |

`scratch` is a reserved slot name. It names the runtime's ephemeral, per-run,
per-connector output directory. A `scratch` declaration MUST NOT set
`durable: true`: the runtime provides a fresh scratch directory for each run,
private to that run, quota-limited, and removed by the runtime when the run
ends, including after a crash. A connector writes a browser download or an
intermediate archive extraction to scratch before reading it back through a
declared filesystem input or extracting it further, never to an ambient
temporary-directory location it chooses itself.

A non-reserved slot's persistence follows its `durable` member, the same as
`scratch`'s is fixed to false: a non-reserved slot with `durable: true` names
an output root that persists across runs, for example the directory a
connector's downloaded statements persist in, and a non-reserved slot that
omits `durable` or sets it to false is an ephemeral working area the runtime
MAY clean up like scratch. A runtime MUST treat an output root as a tree
separate from every input root and every other output root: a connector MUST
NOT create a link, rename, or otherwise move a file across that boundary.
`overwrite` and `delete` state rights beyond creating and appending to a new
file; a runtime MUST NOT grant either right
to a slot whose declaration omits it.

#### 3.3.7 Desktop session

A `desktop_session` instance MAY contain `constraints.items`, a non-empty
array of exact secret items and the operations brokered on them:

```json
"signal_keyring": {
  "kind": "desktop_session",
  "required": true,
  "rationale": "Signal Desktop's SQLCipher key unwraps only through the session-bound OS keyring.",
  "constraints": {
    "items": [
      { "service": "os_keyring", "selector": "signal-desktop-safestorage", "operations": ["unwrap"] }
    ]
  }
}
```

| Field | Requirement |
| --- | --- |
| `service` | REQUIRED non-empty string. The OS facility brokering the item, for example `os_keyring`. |
| `selector` | REQUIRED non-empty string. An opaque, connector- and OS-specific identifier for the exact secret item. Its meaning is resolved by the runtime's broker, never by the manifest. |
| `operations` | REQUIRED non-empty array of unique values from `read`, `unwrap`. |

A `desktop_session` instance grants exactly the named items and operations
through a runtime broker. It MUST NOT grant direct access to the underlying
secret store, and a runtime MUST NOT present a `desktop_session` grant to the
owner as access to a whole service. Per-item enforcement differs by platform:
macOS keychain access control lists can scope access to one item and one
requesting application; the freedesktop Secret Service on Linux mandates no
access control once a connector can reach the session bus; Windows DPAPI and
Credential Manager scope by user, not by application. A runtime on Linux or
Windows reports a `desktop_session` grant as `recorded` (Section 3.3.10) until
it proves a stronger isolation, for example running the connector with no
session-bus access on Linux, or a proven security-context isolation on
Windows.

#### 3.3.8 Features

A `browser` or `network` declaration MAY contain `features`, an array of
unique host capability names. The target rule is that each name belongs to
exactly one kind, and a declaration uses a name only on its own kind. Two
placements predate this rule and stay valid as named legacy exceptions:

| Feature | Kind | Capability the host provides |
| --- | --- | --- |
| `page_navigation` | `browser` | Navigate the active page to a URL. |
| `page_script_evaluation` | `browser` | Run script in the active page context. |
| `page_content_read` | `browser` | Read rendered page content. |
| `page_condition_wait` | `browser` | Wait until a condition in the active page becomes true. |
| `page_input` | `browser` | Interact with the active page: click and type. |
| `cookie_read` | `browser` | Read the active page's cookie jar. |
| `page_response_observation` | `browser` | Observe page network responses, including response body content. |
| `host_download_capture` | `browser` | Capture content downloaded by the active page. |
| `host_archive_extraction` | `browser` | Extract downloaded archive contents in the host runtime. |
| `host_archive_entry_chunk_read` | `browser` | Read an extracted archive entry in chunks. |
| `host_cookie_jar_request` | `browser` | Make an HTTP request from the host runtime using the active page's cookie jar. |
| `same_origin_page_fetch` | `network` | Fetch same-origin resources from the active page context. |
| `host_http_request` | `network`; legacy also `browser` | Make an HTTP request from the host runtime outside the page context. |

The names describe host capabilities, not the API of one host. A host
publishes the set of features it supports for each binding. A runtime that
provides a binding MUST provide every feature listed in its declaration. If it
cannot, the binding counts as missing. A declaration without `features` makes
no claim about specific capabilities. A host that supports only part of a
binding MUST NOT place a connector whose required declaration for that binding
omits `features`.

A feature states the functionality a connector requires, not the maximum
authority a handle happens to carry. A browser handle that provides
`page_script_evaluation`, for example, could in principle let a connector do
anything a withheld feature would have allowed, because script evaluation is
general-purpose; declaring only `page_script_evaluation` is not itself a
claim that the connector is limited to the narrower operations other feature
names describe. A runtime or display tool MUST claim an independent limit
for one feature only where the handle actually proves that limit (Section
3.3.10 governs whether such a limit can be called `enforced`), never by
inference from which feature names a declaration omits.

A feature belongs to one kind's interface. A connector's actual operation can
still depend on a different kind entirely; that dependency is a separate,
explicit declaration, not an implicit property of the feature name. For
example, a browser download the connector keeps needs a filesystem write
authority: the manifest declares a `filesystem` instance with a
`constraints.outputs` slot (Section 3.3.6) alongside the `browser` instance
that declares `host_download_capture`, rather than treating the download
feature as if it already carried its own write permission.

`host_cookie_jar_request` names a host-side HTTP request that carries the
active browser page's cookies (for example Playwright's page-bound request
API). It belongs to `browser`, not `network`, because it depends on a live
browser cookie jar; a connector that also needs independent host-side network
access declares a separate `network` instance for that.

Two placements are named legacy exceptions to the one-kind target, and a
validator MUST continue to accept them: `host_http_request` is valid on
`browser` as well as `network`, because it already shipped on `browser` in
existing connectors before this rule existed; `same_origin_page_fetch` is
valid only on `network` today even though it names a page-context operation,
for the same historical reason. Neither placement is performed or reversed by
this revision. A future minor version is expected to resolve both together,
coordinated with every host that selects features today (a mobile host's
selector keys on the current names), through a versioned alias and a
migration path, not a silent reinterpretation of an existing feature name. A
manifest that uses either placement today remains conforming before, during,
and after that future change.

#### 3.3.9 Negotiation and the effective-authority record

Before spawn, a runtime negotiates every binding instance the manifest
declares and produces an effective-authority record. The record states what
the runtime actually resolved, not what the manifest asked for; owner display
and replay read the record, never the manifest, because only the record can
say what a run actually had.

For each instance, the record states a lifecycle outcome:

| Outcome | Meaning |
| --- | --- |
| `granted` | The runtime resolved the instance to a handle. |
| `unsupported` | The runtime does not implement this kind or interface version. |
| `denied` | Policy declined to grant the instance. |
| `unavailable` | The runtime would support the instance, but a required resource is not available in this environment. |
| `revoked` | A grant that was active is no longer active. |
| `optional_not_granted` | The instance was not required, and the runtime did not grant it. |

For each binding and each channel within it (for example `browser.navigate`,
`browser.connect`, `network.hosts`, a `filesystem` input or output slot, a
`desktop_session` item), the record states a coverage outcome from Section
3.3.10: `enforced`, `recorded`, or `not_observable`. A binding can mix
coverage outcomes across its own channels (as `systemd-analyze security`
reports partial coverage per directive); the record states each channel
separately rather than one verdict for the whole binding.

The record also carries, for an instance that was granted: the requested and
the effective constraint values (so a narrower grant than what was declared is
visible); the mechanism and version that provided the grant; any policy
exception applied (for example an owner-approved exceptional grant, Section
3.3.13); and remaining ambient access the handle did not eliminate, when the
runtime can state it. A runtime MUST emit the record before the connector's
first possible egress, so nothing the runtime cannot yet vouch for has already
left. The record is bound to the run and to the policy identity that approved
it; it does not describe a connector in the abstract.

Lifecycle, coverage, and observation are three separate facts the record
keeps apart. The record also carries, per channel, the observation data the
runtime collected: the actual destinations, frames, paths, or items the
connector reached or attempted, independent of that channel's declared
coverage outcome. Coverage states what the runtime could vouch for;
observation states what the runtime actually saw. A runtime MUST include
observation data for every channel it can observe, including one whose
coverage outcome is `recorded` or `not_observable`. Logging a blocked
request (Section 3.3.3) is one instance of observation; it does not by
itself satisfy this requirement for every other channel.

Before spawn, a runtime MUST fail placement when a required instance's
lifecycle outcome is not `granted`. For a granted required instance, a
runtime MUST ALSO fail placement, per channel, when that channel's coverage
outcome is not `enforced`, unless explicit policy authorizes that specific
channel's weaker coverage. This check is per channel, not per instance: an
instance with some channels `enforced` and others `recorded` or
`not_observable` MUST NOT be placed on the strength of its enforced channels
alone, and a runtime MUST NOT treat one channel's authorized exception as
covering a different, unauthorized channel in the same binding. Revocation
MUST close every handle and connection the revoked instance backed; a
runtime MUST NOT leave a connection open after the grant that authorized it
is revoked.

Provisional: this section states the lifecycle, coverage, and content this
record MUST carry. The exact member names of the record are not decided.

#### 3.3.10 What `enforced` means

A coverage outcome of `enforced` for one channel is an attestation about that
channel alone. It is never a claim about a whole binding, and it is never a
claim about a runtime in general.

A runtime MAY attest `enforced` for a channel only when all of the following
hold for that channel, for the connector's whole process tree (the connector,
its browser if any, and every helper process, Section 3.3.11):

- An OS-level forced egress boundary routes every outbound connection,
  including DNS resolution, through the runtime's own proxy or equivalent
  control. A direct socket or a UDP packet that bypasses that boundary is
  denied, not merely unobserved.
- The connector's and every helper's environment and inherited file
  descriptors are sealed to what their binding declarations and Section
  3.3.11 allow.
- For a `browser` channel, a browser-side guard additionally covers
  navigation, every frame, every popup, and every redirect hop, DevTools
  stays inside the runtime and is never exposed to the connector, the browser
  loads no extension, and the runtime uses one browser profile per connector
  per binding instance.

A destination the proxy enforces and an origin the browser guard enforces are
distinct coverage facts; a runtime states them separately rather than
collapsing them into one claim for the binding. Traffic inside a TLS tunnel
the runtime already allowed is coverage of reach to the tunnel's endpoint, not
of the origin reached inside it; a runtime MUST NOT attest `enforced` for an
inner origin it cannot see.

Until a runtime meets the conditions above for a given channel, that channel's
coverage outcome MUST be `recorded` (the runtime observed what happened,
without blocking what it did not allow) or `not_observable` (the runtime
neither blocked nor observed it). A runtime or any owner-facing tool MUST NOT
present a `recorded` or `not_observable` channel to the owner as a limit on
what the connector could do; Section 3.3.13 requires the opposite: that every
non-`enforced` channel stays visible to the owner as such.

This profile does not itself claim that any runtime meets the conditions
above today. Declaring a `browser`, `network`, `filesystem`, or
`desktop_session` constraint in a manifest under this section is a statement
of intended reach. It becomes an enforced limit only when a specific runtime,
for a specific channel, proves the conditions above and reports `enforced`
for a run.

#### 3.3.11 Helpers

A connector can run a helper process (for example an archive exporter or a
native client library) through `runtime_requirements.external_tools`. A
helper process MUST run inside the same OS confinement as the connector that
launched it; a runtime MUST NOT let a helper reach a destination, path, or
secret item the connector's own bindings do not cover. A helper's
inter-process communication and file descriptors are restricted to what its
task needs, not inherited wholesale from the runtime or the connector. A
helper MUST receive only the environment variables the manifest declares for
it; a runtime MUST NOT pass its own or the connector's full environment to a
helper process.

#### 3.3.12 Blob sink

A runtime SHOULD provide connectors a blob sink for uploading collected
binary content, instead of a bearer credential in the connector's
environment. A blob sink is bound to one run and one owner; it accepts bytes
or a verified regular-file handle, never a caller-supplied path or
destination string; it is upload-only; it is quota-limited; and the runtime
MAY revoke it before a run ends. A connector that uploads through a blob sink
holds no credential that outlives the sink or that would let it reach a
destination the sink does not front.

This profile does not yet define the wire mechanism a connector uses to reach
a blob sink. Section 7.2 lists the `BLOB` message as a runtime-specific
extension outside this profile; a blob sink is the authority model that
message, or a successor to it, is expected to use once it is specified here.

#### 3.3.13 Risk and display

A connector's declared bindings, constraints, and features set a minimum risk
classification, derived from the operation performed, any sensitive resource
reached, the breadth of what is declared, and the coverage outcomes Section
3.3.9 and 3.3.10 define. Deployment policy MAY raise that classification; it
MUST NOT lower it below what the declaration implies. Publisher review of a
connector's code, an owner's approval of a grant, and the runtime's
containment of a running connector are three separate decisions; none
substitutes for another.

An owner-facing display of a connector's access MUST show: its effective
reach (what Section 3.3.9's record says was actually granted, not what the
manifest requested); the consequential actions available through that reach;
the stated purpose; and, for every binding and channel, whether its coverage
outcome is `enforced`, `recorded`, or `not_observable`. It MUST show every
`recorded` or `not_observable` channel, not only the `enforced` ones; omitting
a non-`enforced` channel from display would let the owner believe the
connector is more contained than it is. Breadth comes first in this display:
an owner evaluates how much a connector can reach before the detail of what
it does with that reach.

An instance that declares a `kind` but no `constraints` (Section 3.3.2) makes
no claim about which destinations, paths, or secret items it requests; its
absence of `constraints` states undeclared REQUESTED reach, up to that kind's
full reach, not a floor on what the runtime must actually grant. Deployment
policy MAY still narrow what it actually grants for such an instance, the
same way Section 3.3.9's record can show an effective grant narrower than
what a declared constraint requested; narrowing an undeclared request is not
a contradiction of the request, because the request itself never bounded the
runtime's discretion below the kind's full reach. An owner-facing display
MUST show the instance's actual effective and remaining ambient authority
(Section 3.3.9), not the bare fact that `constraints` is absent, and this
applies equally to a shorthand instance (Section 3.3.1) and to a named
instance with an explicit `kind`. A display MUST NOT present undeclared
reach as a limited grant, and MUST NOT omit the binding from display because
it declares no `constraints`. Declaring no `constraints` is the status quo
for every manifest in this repository today, so undeclared reach is not
itself one of this section's exceptional grants and does not by itself
require a `rationale`.

An instance that declares one of this profile's exceptional grants -- a local
or development server exception to the private-destination denial (Section
3.3.2), or access to a named sensitive resource such as a `desktop_session`
item -- MUST carry a `rationale` member stating why the grant is needed. A
`rationale` is a statement for review and display, not a capability; a
runtime MUST NOT widen a grant because a `rationale` is present, and MUST NOT
accept a `rationale` as a substitute for the grant actually meeting its
declared constraint.

### 3.4 Human interaction and protocol capabilities

`capabilities.human_interaction` is an OPTIONAL array. Its values are
`credentials`, `otp`, and `manual_action`. A connector MUST NOT emit an
`INTERACTION.kind` that the manifest does not declare.

`protocol_capabilities` declares optional wire features that the connector
requires. A runtime MUST advertise its supported protocol versions and
capabilities before placement. It MUST reject a connector with an unsupported
required capability before spawn, except for `RUN_COVERAGE_V1` when the runtime
implements the elective exception in Section 7.1.

DETAIL_GAP, DETAIL_COVERAGE and OBSERVATION are mandatory
runtime features of 0.3.0, including Sections 5.10 through 5.13 and the
recovery-hint gate. A connector need not emit diagnostic facts on every run.
Strict accounting MUST NOT depend on a per-feature capability, advisory flag,
START capability list, message-content opt-in, or connector-side fold.
PERMANENT_DETAIL_GAP is not a separate capability. Unrelated optional
extensions and binding requirements retain their placement negotiation;
they MUST NOT weaken mandatory accounting or diagnosis. STREAM_EVIDENCE remains
an OPTIONAL wire capability: a connector that can emit it MUST declare
`STREAM_EVIDENCE` in `protocol_capabilities`, and a runtime that supports it
MUST apply Section 5.7. Its absence does not disable strict accounting.

`RUN_COVERAGE_V1` (Section 7.1) is an elective optional extension. A connector
that uses it MUST declare `RUN_COVERAGE_V1` in `protocol_capabilities`. A runtime
that implements its elective exception MAY start a connector without supporting
that extension only as Section 7.1 permits and only if all other placement
requirements pass. This exception MUST NOT weaken mandatory 0.3.0 accounting or
diagnosis.

### 3.5 Coverage and freshness strategies

`coverage_strategy` is a closed set:

| `coverage_strategy` | Meaning |
| --- | --- |
| `checkpoint_window` | A cursor and its evidence account for the completed incremental window. |
| `full_inventory` | A run accounts for the full current source inventory. |
| `parent_detail_accounting` | A parent checkpoint depends on detail-record accounting. |
| `snapshot_import_receipt` | A source snapshot receipt bounds a completed import. |
| `singleton_presence` | A run checks one stable singleton record. |

`freshness_strategy` is also a closed set:

| `freshness_strategy` | Meaning |
| --- | --- |
| `device_heartbeat` | Device contact establishes the latest observation time. |
| `manual_as_of` | A manual run supplies the observation time. |
| `not_trackable` | The source provides no useful freshness signal. |
| `scheduled_window` | A scheduled collection window establishes freshness. |
| `source_reported_as_of` | The source supplies an explicit observation time. |

A manifest validator MUST reject any value outside these sets. A strategy is a
claim about the evidence shape. It does not prove that a run produced the
required evidence.

### 3.6 Checkpoint dependencies

A stream is its own checkpoint parent unless it declares one of these fields:

- `state_stream` names one other stream. The declaring stream MUST use
  `coverage_strategy: "checkpoint_window"`. The stream inherits the checkpoint
  outcome of that parent and MUST NOT emit `DETAIL_COVERAGE` for itself.
  Its known-parent gaps use the self-contained binding and durable admission
  in Section 5.6.2, not a child coverage message or STREAM_EVIDENCE.
- `parent_streams` names one or more other streams. The declaring stream MUST
  use `coverage_strategy: "parent_detail_accounting"`. It emits one
  `DETAIL_COVERAGE` for each parent boundary that it evaluates.

A stream MUST NOT declare both fields. Before spawn, a runtime MUST reject a
manifest with a self-reference, unknown parent, duplicate parent, empty
`parent_streams`, strategy mismatch, or cycle of any length. A valid dependency
graph is acyclic and ends at one or more self-mapped streams. For each declared
parent-detail boundary, the runtime MUST also reject a missing parent-side
relationship, duplicate relationship names on that parent, an undeclared
related stream, a foreign-key field absent from the related stream's schema,
or a relationship shape unsupported by Section 5.2.
Relationship selection and attribution follow Section 5.2.
Every stream declaring state_stream or parent_streams MUST also declare a
non-empty string transform_epoch in its manifest stream entry. The connector
author MUST change it when schema or transformation changes represented detail.
The runtime uses this declared value, never a guessed epoch, to decide
recovery eligibility before collection and to validate all current-run gap,
coverage and recovery-seal epochs. Unsupported or missing epochs refuse spawn.
A child settles discovered debt only through Section 5.6.6's portable seal;
its parent STATE remains the checkpoint authority.

### 3.7 Implementation metadata

Current artifacts can contain `setup`, `profiles`, `reason_display_messages`,
`options_schema`, `external_docs`, `runtime_requirements.environment_variables`,
`runtime_requirements.local_paths`, and `runtime_requirements.external_tools`.
Capability metadata includes `refresh_policy`, `public_listing`, `proven`,
`browser_surface_kind`, `auth`, `declared_reason_tokens`, and
`record_identity`. Stream metadata includes `required`,
`compaction_fingerprint`, `compaction_class`, `compaction_class_note`,
`cursor_shape`, `availability`, and `coverage_policy`.

`setup.manual_or_upload.import_dir_env_var` is deprecated in favor of
filesystem inputs (Section 3.3.5).

These members are not part of portable 0.3.0 conformance. A runtime MAY support
them as implementation metadata. Any manifest member that this profile does
not define is also outside portable 0.3.0. A connector MUST NOT use such a
declaration to grant itself authority, widen collection scope, or bypass owner
approval.

In particular, a connector-authored option kind is only a claim. Runtime or
operator policy decides whether an option changes collection scope. An unknown
option MUST default to the more restrictive collection-scope treatment.

### 3.8 Diagnostic descriptors

`diagnostic_descriptors` is an OPTIONAL object. It declares the finite set of
step, expectation, and rule ids that the connector's facts (Section 5.10) can
name. The set is reviewed together with the manifest.

```json
{
  "diagnostic_descriptors": {
    "steps": [{ "id": "sign_in" }],
    "expectations": [{ "id": "email_input", "step": "sign_in" }],
    "rules": [{ "id": "password_rejected", "kind": "auth", "step": "sign_in" }]
  }
}
```

| Member | Entry members | Meaning |
| --- | --- | --- |
| `steps` | `id` | A named stage of a run, such as `sign_in`. |
| `expectations` | `id`, `step` | A page element that the connector waits for at that step. A declared expectation is a declared shape, so a failed one supports `expectation_mismatch` without a baseline. |
| `rules` | `id`, `kind`, OPTIONAL `step` | A provider response that a runtime can match. The only `kind` in this version is `auth`: the provider rejected a credential. |

Each id matches `^[a-z][a-z0-9_]{0,63}$` and MUST be unique within its member.
An expectation's `step` MUST name a declared step.

A fact that names a step, expectation, or rule id that the manifest does not
declare is kept and shown to the owner. It MUST NOT support a cause category
or a recovery hint (Section 5.11).

This version does not define the syntax of a rule's match condition
(Section 5.13). A runtime records a match for a declared rule only from its
own observations.

A manifest implementing this document declares `protocol_version` `0.3.0`,
including when it declares `diagnostic_descriptors`.

## 4. Run protocol

The runtime and connector exchange one JSON object per line. The runtime writes
to connector standard input. The connector writes to standard output.
Standard error is diagnostic only and MUST NOT contain protocol messages.

Before spawn, the runtime MUST match the bindings, binding features, and
protocol capabilities required by the connector against its advertised support.
A mismatch fails the run before any connector code executes. Unsupported
profile versions MUST also be refused before spawn (Section 8).

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

Cancellation and supervisor restart are runtime events. They are not
`DONE.status` values. A run that ends for either reason has a failed terminal
outcome and does not commit staged state. A runtime can record a more specific
controller-lifecycle reason outside this wire protocol.

## 5. Messages

### 5.1 `START`

The runtime sends `START` to initialize one run.

```json
{
  "type": "START",
  "run_id": "run-abc123",
  "now": "2026-09-02T00:00:00Z",
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
  "detail_debts": [],
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
| `detail_baselines` | OPTIONAL array of runtime-issued complete/empty baseline receipts (Section 5.6.3); validity is rechecked at each use. Absence means none. |
| `detail_debts` | REQUIRED array of stored debt descriptors under Section 5.6.6; empty when none can be delivered in this scope. |
| `now` | OPTIONAL [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) date-time with a time-zone offset. It is the run's notion of the current time. |

Each scope stream has a REQUIRED `name`. `resources` is an OPTIONAL array of
canonical record-key strings. `fields` is an OPTIONAL array of top-level record
fields. `time_range` is an OPTIONAL object with `since` and `until` bounds.
A runtime MUST resolve wildcards and view names before `START`. It MUST NOT send
a wildcard stream name or an issuance-time `necessity` value.

A canonical key component is the string representation of its schema-valid
primary-key value: a string retains its value; an integer uses base-10 notation
without a leading plus or redundant leading zeroes. A simple canonical record
key is that component. A composite canonical key is the minified JSON array of
the components in `primary_key` order. For example,
`["user-1","2026-09-02"]` is one canonical key string. Each `resources` entry
uses this form; a numeric primary-key value does not make the wire key numeric.

The connector applies `time_range.since` and `time_range.until` to the
stream's declared `consent_time_field`. `since` is inclusive and `until` is
exclusive. A runtime MUST NOT send `time_range` for a stream without that
field.

The bounds have the type of that field's declared format. `time_range` belongs
to one scope stream, so one run can mix the two types:

| Field schema | Bound type | Comparison |
| --- | --- | --- |
| `format: "date"` | RFC 3339 `full-date` | as calendar dates |
| `format: "date-time"` | RFC 3339 `date-time` with a time-zone offset | as exact instants |

A runtime MUST NOT turn an instant into a date or a date into an instant to
make a bound. It sends a bound that comes from a grant without changing it.
When it chooses a window itself, for example the owner's "last 30 days", it
states the window in the field's type, such as `since: "2026-09-05"` for a
date field. A widened bound collects records outside the window, and a
narrowed bound loses records at the edge of a day. A connector that receives a
bound of the wrong type for the field, or a bound for a field of any other
type, such as an epoch integer or a string with no `format`, MUST emit
`SKIP_RESULT` with `reason: "scope_not_supported"` for that stream.

During a time-bounded run, the connector MUST NOT emit a record whose
consent-time value is absent, null, or not a valid value of the bound type:
a `full-date` for a date field, or a `date-time` with an offset for an instant
field. A `date-time` with no offset is not an instant.

`now` stabilizes the decisions a connector derives from the current time. When
`now` is present, a connector SHOULD use it instead of its own clock to compute
time-based watermarks, cursors, and relative windows such as "the last 30
days". A replay runtime SHOULD send the `now` value recorded for the original
run, so those decisions match the original run. `now` does not make a replay
byte-identical: `emitted_at` is still the time the connector emitted each
message, and other connector behavior can still vary. When `now` is absent, the
connector uses its own clock. A connector that does not read `now` remains
conforming.

The runtime MUST include a descriptor for each required manifest binding. A
connector MUST fail if a required descriptor is missing. It MUST ignore
additional binding descriptors.

A connector MUST emit records only for streams in `scope.streams`. If
`resources`, `fields`, or `time_range` is present, the connector MUST apply it
before emission. Before sending `START`, the runtime MUST normalize a requested
`fields` list to include canonical identity, schema-required fields and
ingest-required fields. For detail upserts, ingest-required fields include the
selected relationship's foreign-key field from Section 5.2, even when it is
not schema-required. This normalization uses only identity and dependency
projection permitted by the valid grant and Core's field-selection semantics;
it grants no additional consent. If the required fields cannot be included
under that authorization, the runtime MUST refuse the unsatisfiable request
before spawn or any collection effects, rather than strip attribution or leave
a checkpoint permanently waiting. A connector that cannot
apply a constraint MUST emit `SKIP_RESULT` with
`reason: "scope_not_supported"` for that stream or fail the run. It MUST NOT
silently broaden scope.

The runtime and durable write path MUST reject or discard an out-of-scope
record. A connector can read broader source-side data when the source cannot
filter precisely, but it MUST restrict what it emits.

Runtime-specific `START` members for backfill and detail-gap recovery are
defined in the
[runtime note](../../packages/polyfill-connectors/docs/collection-profile-runtime.md).
They are not portable 0.3.0 fields.

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

`stream`, `key`, and `emitted_at` are REQUIRED. `stream` names a declared,
in-scope stream. `key` is a non-empty string or a non-empty array of strings.
An array preserves composite-key field order. `emitted_at` is the ISO 8601 time
when the connector emitted the message.

`data` is REQUIRED. For an upsert, it MUST conform to the stream schema. For
each primary-key field, the value in `data` MUST identify the same value as the
corresponding component of `key`. A runtime MUST reject a record when these
identities disagree.

`data` carries values from the source. A connector MUST NOT put its own
collection or processing time in `data`, such as the time it fetched a page,
parsed a file, or ran. `emitted_at` records when the connector emitted the
record. The resource server reports collection timing for each instance through
PDPP Core freshness metadata (`last_success_at`). A time that the source itself
provides, such as a source `updated_at` value or the generation time of an
export file, is a source value and stays in `data`.

`op` is OPTIONAL. Its values are `upsert` and `delete`. Absence means upsert. A
delete identifies a record by `stream` and `key`. As PDPP Core requires, its
`data` MUST contain every primary-key field, matching `key`; other
schema-required fields MAY be absent. A connector MUST NOT delete from an
`append_only` stream.

For strict detail accounting, each parent and detail stream pair MUST have
an unambiguously selected Core relationship declared on the parent stream.
The relationship's `stream` names the related detail stream and its
`foreign_key` names the field ON THAT DETAIL STREAM that references the
declaring parent's primary key. For example, conversations declares
`{"name":"messages","stream":"messages","foreign_key":"conversation_id","cardinality":"has_many"}`;
an upsert to messages is attributed by its `data.conversation_id`, not by
looking for a messages field on conversations.

Strict accounting in this profile supports Core relationships with
cardinality "has_many" and one foreign_key field on each detail record
identifying one declaring parent. The runtime MUST refuse any other
cardinality or attribution shape for a strict boundary before spawn. This
restriction does not redefine other Core relationship forms; they require a
separately specified accounting mapping before this profile can use them.

This profile's `relationship_id` references that existing Core
`relationship.name`, scoped by the declaring parent stream. It does not
introduce a Core relationship `id` field. Names of relationships used for
strict accounting MUST be non-empty and unique within the declaring parent
stream. A coverage boundary MUST select the relationship explicitly when
more than one declaration connects the same parent and detail streams;
otherwise the sole matching declaration is selected. The runtime MUST reject
an absent, unknown or ambiguous relationship before granting any credit.

For an upsert, the runtime MUST evaluate the selected relationship's
`foreign_key` on `RECORD.data` and derive the canonical parent key.
The foreign-key value MUST identify the parent's schema-valid primary-key
value, canonicalized as in Section 5.1. A simple integer foreign key such as
42 therefore matches canonical parent key "42". For a composite parent key,
one Core foreign-key field on the child carries an ordered array of component
values in the parent's `primary_key` order; canonicalization produces the
ordered array of string components. Multiple foreign-key fields or dot-joined
components are not substitutes. The runtime MUST preserve this attribution
field with canonical identity when applying authorized field projection
(Section 5.1). Missing or invalid attribution rejects the effect; an unknown
parent withholds the affected boundary.

`parent_ref` is an OPTIONAL top-level member of a delete `RECORD` only,
alongside `stream`, `key`, `data`, `op` and `emitted_at`. It is an
object with REQUIRED non-empty string `stream` (the declaring parent stream)
and REQUIRED string `key` (the Section 5.1 canonical parent key), and OPTIONAL
non-empty string `relationship_id`. It has no other members. The relationship identifier
is REQUIRED when that parent and detail pair has multiple relationships.
It is accounting metadata, not a member of `data`, and MUST NOT appear on
an upsert.

A delete MUST be attributable to its selected parent relationship through
the retained row or `parent_ref`. These forms MUST agree when both are
available; disagreement rejects the effect. A delete does not require the
foreign-key field in `data` when either form establishes attribution.
If that field is supplied, it MUST agree as well. A delete with an unknown
parent MUST NOT credit any parent and withholds the affected boundary.
For a known-parent rejection, Section 5.6.4 requires matching gap debt before
the key can be accounted.

A connector record carries no instance. Core identifies a stored record by its
instance and canonical key, so the ingest adapter binds each connector record
to one Core instance, the connection the run collected for, before it writes
the record.

### 5.3 `STATE`

```json
{ "type": "STATE", "stream": "items", "cursor": { "cursor": "abc" } }
```

`stream` and `cursor` are REQUIRED. `cursor` is an object or `null`. Its object
members are opaque to the runtime and to the resource server. Only the
connector interprets them on a later run. A cursor MAY hold a wall-clock
watermark, such as the end of the last completed collection window. When
`START.now` is present, the connector SHOULD derive that watermark from it.

The runtime stages `STATE` only after it durably writes all prior records. It
commits staged state only after successful `DONE`, except for the certified
stream-scoped failure in Section 5.8. It MUST apply Section 5.6.3's generation fence and atomic state/receipt rules.
It MUST NOT commit state after
cancellation, supervisor loss, a protocol violation, an invalid exit, or an
uncertified failed `DONE`.
Recovery seals in Section 5.6.6 remain staged until this same eligible
checkpoint transaction; opaque cursor members never substitute for typed
original obligation, epoch or closure. The checkpoint stream is resolved
through Section 3.6 dependencies, including inherited parents.

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

A connector that enumerates a stream but did not observe the end of the
enumeration from the source (Section 6.1, item 14) MUST NOT complete that
stream as empty or as complete. It emits `SKIP_RESULT` with `reason:
"stream_collection_failed"` for the stream, emits no `STATE` that marks the
enumeration finished, and ends with failed `DONE` whose `error.code` is
`stream_collection_failed` (Section 5.8). An unprovable enumeration is a stream
failure, never an empty success.

`recovery_hint` is OPTIONAL. It is either an action string or an object with a
REQUIRED `action` string and an OPTIONAL boolean `retryable`. Portable 0.3.0
actions are `retry_by_runtime`, `retry_on_connector_upgrade`,
`refresh_credentials`, `manual_action_required`, `update_selector`,
`upstream_unblock`, `not_retriable`, and `unknown`.

A runtime MUST reject an invalid portable recovery hint. It MUST NOT infer a
connector-requested action from free-form `message`, diagnostics, or an error
code. A valid hint is the connector's suggestion. Section 5.11 states when a
runtime can present a hint as an instruction or act on it.

### 5.6 Detail obligations, gaps and coverage

Strict accounting is mandatory in 0.3.0 for both dependency forms.
[Runtime implementer guidance](https://github.com/PDP-Connect/data-connect/blob/docs/collection-profile-0.3.0-implementer-note/docs/261024-collection-profile-0.3.0-implementer-note.md)
is non-normative; it describes fencing, storage and worked sequences.

#### 5.6.1 Obligations and closure

For each parent boundary, the connector MUST enumerate `required_keys`
independently under effective scope, never derive them from successful parsing,
emission or gaps, and emit coverage only after parent enumeration closes with
Section 6.1 item 14 evidence; otherwise it emits no coverage and the runtime
withholds the checkpoint. Explicit closure with zero obligated parents is valid.
Keys MUST use Section 5.1 canonical strings, including ordered composite keys,
and select the Section 5.2 parent-declared `has_many` relationship whose foreign
key is on the child. Unknown scope membership is not a proven exclusion.

Each key's original obligation is `{"kind":"inventory"}` (all children within
scope) or `{"kind":"delta","range":...}` (one change interval).
A delta range MUST contain exactly one of `time_range` (inclusive `since`,
exclusive `until`, both in the declared consent-time format, `since < until`)
or `cursor_range` (exclusive `after`, inclusive `through`, both opaque JSON
values in one source cursor domain). Cursor/validator equality is typed JSON
structural equality: object order is ignored, array order and types preserved.
The runtime MUST compare cursor ranges by equality only, never infer ordering,
containment or subranges from opaque endpoints. A shorter successful or empty
fallback MUST NOT replace the original obligation or credit its uncovered parts.

An obligation binding comprises connection, source account, detail stream,
parent stream, selected relationship name, canonical parent key, normalized
effective scope and original obligation. Connection and source account are
separate runtime-owned dimensions fixed for the run, never connector choices.
Debt MUST remain bound to its source account; success under another account
MUST NOT settle, retry or credit it, even with the same key or validator.

#### 5.6.2 Outcomes and durable debt

The connector MUST partition accounted required keys into these disjoint outcomes:

| Outcome | Connector assertion |
| --- | --- |
| `complete_keys` | Child enumeration closed with source evidence; every candidate has an upsert, delete, suppression against a committed baseline or proven scope exclusion; none is unknown. A delta with deletion candidates is complete. |
| `empty_keys` | Child enumeration closed with zero in-scope children for the stated obligation. A zero-child inventory remains empty even with inventory-derived deletes. Empty implies no deletion. |
| `unchanged_keys` | No enumeration or attempted effects; a source validator covering membership, content AND deletion matched a valid committed baseline for this exact obligation. A parent timestamp alone is insufficient. |
| `gap_keys` | Matching DETAIL_GAP debt for the uncovered obligation remains durable. |

An absent required key is unaccounted and MUST withhold its parent checkpoint.
The runtime MUST give every outstanding matching debt binding precedence over
complete, empty or unchanged, including earlier debt with no accepted effects;
only a full-original-obligation seal under Section 5.6.6 can settle it.
A gap MUST NOT mint a baseline or be displayed as complete data, and durable
gap debt alone MUST NOT withhold an otherwise eligible checkpoint.

DETAIL_GAP has REQUIRED `type:"DETAIL_GAP"`, `reference_only:true`,
`status:"pending"`, `stream`, `parent_stream`, canonical parent `record_key`,
`reason`, boolean `retryable`, `detail_locator` and `binding`.
`relationship_id` names the parent-declared relationship and is required when
otherwise ambiguous. `detail_locator` has required `kind` and `obligation`;
kind-specific fields identify missing detail without secrets.
`binding` has exactly `effective_scope` (the resolved Section 5.1 detail target,
including name and applicable resources, fields and time_range), `obligation`
(the original inventory/delta obligation, not just an uncovered suffix) and
`transform_epoch` (a non-empty stable schema/transformation identifier).

Before durable gap admission or credit, the runtime MUST validate the complete
shape, normalize scope by START's policy/field rules and require target equality,
validate original obligation type and authorized bounds, attribute the canonical
parent and selected relationship in this boundary or retained authorized state,
and recheck current grant and placement authority. Provisional staging, message
receipt, later coverage and STREAM_EVIDENCE confer no durable debt or credit.
The runtime MUST reject missing/malformed binding or epoch, unauthorized scope,
unknown parent, unknown reason or any retryable value outside this closed table:

| reason | retryable | Cause |
| --- | --- | --- |
| `rate_limited` | true | Source rate limit. |
| `retry_exhausted` | true | Transport retry budget exhausted. |
| `temporary_unavailable` | true | Transient source/transport failure. |
| `upstream_pressure` | true | Upstream capacity pressure. |
| `connector_transform_failed` | true | Missing identity, invalid date, schema/shape, parser or transformation failure. |
| `source_unrepresentable` | false | Detail the source in its current form cannot represent. |

Every gap lookup, deduplication, count and settlement MUST use the full identity:
(connection, source account, stream, parent_stream, selected relationship name,
canonical record_key, canonical detail_locator), retaining each outstanding
scope/obligation/epoch binding rather than overwriting it on a later observation.
A locator includes its obligation and uses typed structural equality.
For new debt admitted within one boundary, a time-range locator may name exact
uncovered subranges only when the remaining parts were independently closed and
accounted; the runtime MUST check typed bounds, containment and full interval
accounting, preserve every uncovered part, and never replace outstanding debt
with these subranges. A cursor locator MUST equal the original cursor range.

The connector MUST use `connector_transform_failed` for known-parent
transformation failures, never a transport reason or `source_unrepresentable`.
A timeout, unknown field, parser bug, permission/configuration issue or deployment
limit MUST NOT be classified permanent. Permanent gaps remain pending and need
no capability flag; DETAIL_GAP has no `recovery_hint` member.
For transformation or permanent debt the runtime MUST NOT schedule, request or
offer recovery refetch under the same or an unknown epoch; a different current
manifest epoch for that detail stream permits re-evaluation but never clears debt.
Transport debt can recover at the same epoch. Section 5.11's hint gate is separate.
Partial recovery MUST NOT settle original debt or replace it with residual
obligations; 0.3.0 defers residual replacement until a later protocol revision.
Relationship retirement MUST NOT alias debt to a new relationship name.

#### 5.6.3 Baselines and publication

A runtime-owned baseline receipt certifies one committed obligation binding,
validator domain, schema and transform epoch, with non-empty opaque `receipt_id`
and kind `complete` or `empty`. START.detail_baselines may supply `receipt_id`,
`kind`, `stream`, `parent_stream`, `key`, applicable `relationship_id`,
`effective_scope`, `obligation`, `validator_domain`, `transform_epoch` and the
committed `source_validator` when available.
Every receipt-dependent acceptance MUST use the current durable ledger's valid
exact binding, epoch and domain, without an intervening invalidation; a supplied
copy or START-time validity alone is insufficient.
Suppression MUST additionally rely on retained child state certified by that
receipt; outstanding debt or invalidation forbids reuse.
The runtime MUST NOT mint a receipt from legacy state, failed work or gap credit,
or install a failed/gap-covered attempt's validator as a new baseline.

Work from a superseded placement MUST NOT add, clear or rewrite effects, debt,
state, receipts or receipt-dependent credit. This guarantee applies to admission
and sealing, including concurrent external invalidation of a placement's authority.
Effect admission MUST atomically invalidate every receipt and dependent state
whose certified membership it changes, for both old and new parents,
relationships and scopes across obligations in the bound source account.
Scope change, owner deletion, retention GC affecting certified data, schema or
transform change, source-account change and relationship rename MUST invalidate
affected receipts and dependent state before reuse; unknown/different epochs
require recollection rather than resume. Invalidated validators are comparison-only.

Valid effects and validated debt may be admitted durably before checkpoint
sealing and survive a later failure. A rejected admission MUST leave no new
effect, debt or credit from that transaction; valid earlier admissions remain.
New durable debt MUST invalidate incompatible provisional complete, empty or
unchanged credit before commit.
Eligible checkpoint state, new receipts and all proved debt settlements MUST
publish atomically after reconciling the final ledger under current authority;
a failed commit publishes none, never an orphan receipt or a checkpoint
justified by a missing receipt. A committed complete/empty receipt MUST
supersede prior receipts for the same obligation binding atomically, never
receipts for a different binding. Wider invalidation is not supersession.

#### 5.6.4 Final coverage and runtime checks

DETAIL_COVERAGE requires `type:"DETAIL_COVERAGE"`, `reference_only:true`,
`stream`, `state_stream`, `required_keys`, all four outcome arrays,
`obligations`, non-empty stable `validator_domain` and `transform_epoch`.
`relationship_id` is an optional non-empty parent-declared relationship name,
required for ambiguity. `baseline_refs` maps keys to receipt ids whenever prior
state is used; `validators` maps keys to `{domain,value}`, required for unchanged
and permitted for freshly enumerated complete/empty receipts.
Credited gaps MUST agree with coverage's original obligation and binding; coverage
cannot supply or overwrite missing gap metadata.
The connector MUST change `transform_epoch` when schema or transformation changes
represented child state; validator-domain equality includes source account and
semantics, covering membership, content and deletion.
The runtime MUST reject duplicate/overlapping key arrays, foreign outcomes or map
keys, obligations not keyed exactly by required_keys, undeclared parents,
undeclared/ambiguous relationships, invalid domain/epoch/ranges, or coverage on a
state_stream child. `hydrated_keys`, `optional_skip_keys`, `considered` and
`covered` MUST be rejected as legacy coverage members; former skips are classified
per call site as proven out-of-scope (not required), source-unrepresentable
(permanent gap), or recoverable omission (retryable gap).
The connector MUST emit at most one final coverage per evaluated parent boundary,
after related effects and gaps; later related effects or gaps are protocol
violations and cannot reopen or mutate that boundary.
The runtime MUST reconcile each key against this table after proposed atomic
settlement, including every outstanding matching debt binding:

| Outcome | Necessary runtime condition |
| --- | --- |
| complete | No rejected effect or remaining matching debt; at least one durably accepted attributed upsert/delete or a valid complete-kind receipt and closure. An empty-kind receipt cannot justify zero-effect complete; a proven zero-child inventory belongs in empty. |
| empty | No rejected effect, accepted upsert or remaining matching debt; attributed deletes only from a proven zero-child inventory. |
| unchanged | No attempted effects or matching debt; valid complete-kind or empty-kind receipt and matching full-obligation validator. No settlement inferred. |
| gap | All outstanding matching debt bindings represented and durably admitted; no baseline minted. |

Accepted means durable acceptance for this run and parent, not local emission,
accepted siblings or scope exclusions. A known-parent rejected effect MUST
forbid complete, empty and unchanged for that key; without matching admitted debt
it is unaccounted, while an unknown parent withholds the whole affected boundary.
Durable RECORD rejection for schema, key, attribution, authorization or stale
placement is nonfatal and MUST NOT be treated as a protocol violation; malformed
framing, duplicate coverage/seals and post-finality/foreign effects remain fatal
under Section 6.2 item 8.

#### 5.6.5 Connector integrity

The connector MUST register candidates before parsing/transformation independently
of emission, by source account, stream and known parent, retaining a unique
boundary-local identity when unattributable; parse failure cannot remove them.
The connector MUST retain typed dispositions distinguishing upsert, delete,
valid-baseline suppression, proven scope exclusion and unknown/rejected/unavailable
work; exceptions or interruptions cannot advance fingerprints, baselines or
completion, and only the host attests durable acceptance.
The connector MUST distinguish readable, source-explicit empty/absent and
unavailable/malformed values, retaining their source basis locally and emitting
only schema-permitted source emptiness, never fabricated null, zero or empty values.
For a partial selected record or unavailable/malformed required mapped value,
the connector MUST hold back the whole record, never emit a partial complete
upsert or clear retained fields by omission/substitution; authorized scope
projection under Section 5.1 is not a partial read.
A known-parent held candidate MUST retain its original obligation with retryable
DETAIL_GAP debt whose reason follows the cause: transport failure uses the matching
transport reason, while missing/malformed mapped values use connector_transform_failed;
without admitted debt or a known parent the checkpoint is withheld.
The connector MUST require explicit parent and child close events backed by
Section 6.1 item 14 evidence, refusing complete/empty without closure; unknown
candidates and unresolved failures taint the key or withhold an unattributable boundary.
These requirements apply with or without an SDK.

#### 5.6.6 Portable debt discovery and recovery seals

START.detail_debts contains descriptors with exactly the DETAIL_GAP members except
`type` and `reference_only`, preserving the original binding and admitted epoch.
The runtime MUST supply the complete outstanding active descriptor list for the
run's source account whose full original scope/obligation is authorized and whose
normalized effective_scope equals its detail target, or refuse placement if that
list exceeds a runtime bound; excluded debt is retained, never narrowed or truncated.
Discovery is not a retry command or proof that other-scope/account/retired debt is absent.

After fresh enumeration of the full original obligation, DETAIL_GAP_RECOVERED has
exactly these members: `type:"DETAIL_GAP_RECOVERED"`, `reference_only:true`,
non-empty declared `stream` and `parent_stream`, canonical parent `record_key`,
applicable non-empty `relationship_id` (required for ambiguity), exact delivered
`detail_locator` and original `binding` including its OLD epoch, non-empty CURRENT
manifest `transform_epoch`, `outcome:"complete"` or `"empty"`, `closure` containing
exactly `enumeration_closed:true` and `candidates_settled:true`, non-empty stable
`validator_domain`, optional non-empty `baseline_ref` (required for suppression or
zero-effect complete), and optional opaque `source_validator` for the new receipt.
The runtime MUST match each seal to both the delivered descriptor and current
ledger's full identity/original binding in the same source account, require current
epoch equality with manifest and coverage, and validate closure, attribution,
current grant, receipts and all effects/rejections under Section 5.6.4's checks.
A recollection proving several bindings needs a seal for each; narrower scope/range,
unknown parent, accepted sibling or changed epoch alone cannot settle any debt.

A seal stages settlement, remaining debt until commit; state_stream children use
no DETAIL_COVERAGE, while parent_streams seals MUST agree with final coverage's
outcome, obligation, domain and current epoch. Each seal is final for its
stream/parent/relationship/original obligation; duplicate/conflicting seals and
later related effects/gaps are protocol violations. Optional STREAM_EVIDENCE may
follow but never settles debt.
The runtime MUST allow publication only with an otherwise eligible parent STATE
and terminal outcome under Sections 5.3 and 5.8, atomically publishing state,
current-epoch complete/empty receipt and settlement of every matching proved debt
binding; failed admission,
cancellation, superseded placement, failed commit or missing eligible parent STATE
publishes no receipt/state/settlement, while valid earlier effects/debt survive.

The required set, source closure, candidate completeness, exclusions, original
ranges, delta continuity, validator truth, gap causes and epoch-change truth
remain connector assertions; runtime checks MUST NOT be presented as proof of
all source data. No child-set digest, source-completion receipt or host-invented
required set is required.

### 5.7 `STREAM_EVIDENCE`

STREAM_EVIDENCE is OPTIONAL, negotiated through its Section 3.4 capability,
for a stream declaring state_stream; it never authorizes checkpoint commit or
substitutes for mandatory accounting. A supporting runtime MUST apply this
section and refuse a connector requiring an unsupported capability before spawn.

The message has `type:"STREAM_EVIDENCE"`, `reference_only:true`, `stream`,
`considered` and `outcomes` containing `emitted`, `unchanged`, `gapped` and
`unaccounted`. Every count MUST be an integer from 0 through 9007199254740991,
with disjoint outcomes summing to considered.

Counts use three disjoint accounting units within the run's source account:
canonical child record keys; unresolved candidate groups with a full Section
5.6.2 gap identity; and unique boundary-local ephemeral candidates when neither
record nor attributable gap can represent them. Unattributable candidates remain
unaccounted. A group contains only candidates not counted emitted or unchanged;
proved exclusions stay outside this partition.
The connector MUST register candidates before transformation and derive considered
from their enumeration ledger, including unaccounted units, retaining mappings
across repeated observations; it cannot derive considered from emitted messages.
Repeated observations of one established identity count once, including multiple
accepted upserts/deletes on one key; distinct unidentified candidates MUST NOT
be collapsed or assigned invented parents, record keys or gap identities.
Three unparsed children sharing one parent gap count as one gapped unit, while
the candidate ledger retains all three; the connector MUST NOT present this
aggregate as raw source-child cardinality.

The connector MUST withhold evidence without enumeration, emit at most one
message per stream/run, and emit no later RECORD, DETAIL_GAP or
DETAIL_GAP_RECOVERED for that stream.
The runtime MUST reject invalid partitions, duplicates, out-of-scope streams,
streams without state_stream and messages reopening final evidence, and verify that
emitted equals distinct durably accepted upsert/delete keys and gapped equals
distinct represented unrecovered durable gap identities for this run/account.
Each counted gap MUST already have passed Section 5.6.2 admission; the aggregate
cannot make provisional debt durable or perform a recovery settlement.
The counts cannot prove candidate-to-gap mapping, source enumeration, ephemeral
completeness, unchanged, withheld evidence or considered derivation; these
connector assertions MUST NOT widen scope or commit a checkpoint.

### 5.8 `DONE` and checkpoint commit

```json
{ "type": "DONE", "status": "succeeded", "records_emitted": 42 }
```

`DONE` is the final connector message. `DONE.status` has two values:
`succeeded` and `failed`. `records_emitted` is a REQUIRED non-negative integer.
A failed message includes `error` with a REQUIRED non-empty `message` and
boolean `retryable`. It can also include a stable snake-case `code` and a
`recovery_hint` as defined in Section 5.5.

`error.basis` is OPTIONAL. It is an array of `OBSERVATION` ids (Section 5.10)
from the same run that the connector says caused the failure. A connector MUST NOT
cite any id in `basis` that it did not emit as an OBSERVATION in this run. `basis` is a connector claim. It cannot choose the
terminal event and it cannot bring a runtime record into or out of the
diagnosis scope (Section 5.11).

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

#### 5.8.1 Explicit deletes before a later failure

Every delete MUST be explicit; the runtime never infers deletion from absence.
A source-positive deletion signal, such as a tombstone, may be emitted before
closure. A delete derived from absence MUST be based on the original
`kind:"inventory"` obligation for that exact parent and relationship, with
Section 6.1 item 14 evidence that its full child enumeration closed.
A delta MUST NOT infer a delete from absence, including a closed/empty delta;
it requires a source-positive deletion signal.

The runtime MUST refuse invalid, unauthorized or superseded-placement deletes,
retain admitted deletes' Section 5.2 attribution through the retained row or
parent_ref, and atomically invalidate affected old/new receipts and dependent
state under Section 5.6.3. A later failure leaves admitted deletes applied and
receipts invalid. Replay MUST preserve identity, authorization, placement and
idempotence safeguards; it supplies no new completion proof.
Delete admission MUST NOT authorize STATE, a new receipt or settlement for a
failed/withheld boundary; the Section 5.8 stream-scoped exception still permits
independently eligible unaffected checkpoints. Prior admitted debt remains until
an eligible full-obligation settlement commits.
Counts and failed-run diagnostics MUST distinguish local emission from durable
acceptance; rejected deletes cannot justify empty/unchanged, empty inventory
alone never deletes, and Section 5.6's inventory-empty/delta-complete distinction
applies only to an otherwise eligible boundary.

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

`message` is owner-facing text. A runtime MAY show it to the owner verbatim.
It SHOULD be a short plain-language description of the current stage, such as
"Fetching conversations" or "Found 120 orders". It SHOULD NOT carry internal
codes, identifiers, `key=value` counters, file paths, HTTP details, or raw
error text. A connector writes that technical detail to standard error as a
diagnostic (§4), and carries machine-readable counts in `count` and `total`.

A diagnostic MUST NOT contain credentials, tokens, or other secret values.
[PDPP Core](https://github.com/PDP-Connect/pdpp/blob/main/spec-core.md) Section
10 already forbids a runtime to log or persist credential data. A diagnostic
SHOULD contain as little personal data as possible. Diagnostics are for the
owner on the owner's device or deployment. A runtime MUST NOT send them off
that device or deployment, or to a data recipient, without an action by the
owner.

### 5.10 `OBSERVATION`

`OBSERVATION` reports one typed fact about the run: what the connector saw,
not what it concludes. Support is mandatory in 0.3.0 (Section 3.4); no
separate capability declaration enables or disables it.

```json
{
  "type": "OBSERVATION",
  "id": "o1",
  "fact": "element_expectation",
  "step": "sign_in",
  "attrs": { "expectation": "email_input", "states_seen": ["absent", "hidden"], "final": "hidden" },
  "evidence_ref": "trace:step-3"
}
```

| Member | Requirement |
| --- | --- |
| `type`, `id`, `fact`, `attrs` | REQUIRED. `id` is unique within the run. `fact` is a connector fact type from Section 5.10.1. |
| `step` | A declared step id (Section 3.8). REQUIRED for `element_expectation` and `wait_expired`, OPTIONAL otherwise. |
| `evidence_ref` | OPTIONAL. A reference to a local artifact, such as a trace or a saved page. It is never the artifact itself and never a URL. |
| `resolves` | OPTIONAL. The ids of earlier facts from this connector that this fact shows were recovered. |

`attrs` holds only the members that its fact type defines. Their values are
bounded enums, declared ids, booleans, and integers. A fact MUST NOT contain
credentials, tokens, cookies, one-time codes, other secret values, or
provider text. Provider text goes into a local artifact that `evidence_ref`
names.

#### 5.10.1 Facts in this version

| Fact | Source | Attributes | Supports |
| --- | --- | --- | --- |
| `element_expectation` | connector | `expectation` (a declared id), `states_seen`, `final`, OPTIONAL `fallback_used` | `expectation_mismatch` when `final` is not `matched` |
| `wait_expired` | connector | `awaited` (a declared expectation id), `budget_ms` | nothing |
| `provider_message` | connector | `kind`: `auth_failure` or `other`; OPTIONAL `rule` (a declared rule id) | `auth_rejected` when `kind` is `auth_failure` |
| `credential_submission` | runtime | `attempt` (a runtime handle), `account` (the runtime's handle for the connection's provider account, never a provider username or email address), `outcome`: `succeeded`, `rejected`, or `unsettled`; OPTIONAL `rule` (the declared rule under which the runtime settled the attempt) | `auth_rejected` when `outcome` is `rejected` under a declared `auth` rule |
| `rule_match` | runtime | `rule` (a declared rule id), `kind`: `auth`, `handle` (the runtime handle it matched on) | `auth_rejected` for a declared `auth` rule |
| `connector_defect` | runtime | `class`: `protocol_violation` or `hint_unsupported`; for a protocol violation, `reason` (Section 5.10.2) and OPTIONAL `count` for aggregated violations | nothing in this version |

The element states are:

- `matched`: an element that meets the expectation is present;
- `absent`: no element matches the selector;
- `hidden`: an element matches but is not visible;
- `disabled`: an element is visible but not enabled;
- `ambiguous`: more than one element meets an expectation that needs exactly
  one.

`final` is the state at the deadline. `states_seen` lists each state seen
during the wait in order of first sighting, and includes `final`.

When a wait for a declared expectation ends without a match, the connector
SHOULD report `element_expectation` with the states seen and the final state,
and `wait_expired`. Shared connector helpers SHOULD do this, so that every
connector gets it by default. `wait_expired` supports no cause: elapsed time
alone is not evidence of a cause.

#### 5.10.2 Provenance

The transport sets provenance. Every `OBSERVATION` on standard output is a
connector fact, which is a claim. The message has no member that names an
observer. A runtime appends its own records, with source `runtime`, to the run
record, and a connector cannot write them. A runtime record carries a runtime
handle that the runtime assigned when it initiated or observed the action, for
example a submission attempt id.

A runtime records `credential_submission` only for a submission that it
performed itself, with the outcome that it observed itself. Delivering a
credential in `INTERACTION_RESPONSE` is not a runtime-performed submission. A
runtime records `rule_match` only from a response that it observed itself on
the named handle. A connector fact, `DONE.error`, or connector text never
produces either record.

An `OBSERVATION` is a protocol violation in each case below. The runtime MUST
discard the fact and record `connector_defect` with class
`protocol_violation` and the `reason` from this closed set:

| `reason` | Case |
| --- | --- |
| `runtime_fact_type` | The `fact` is a runtime fact type. |
| `invalid` | The message does not match Section 5.10 and its fact type. |
| `duplicate_id` | The `id` repeats an earlier `id` in the run. |
| `oversize` | The serialized message exceeds the runtime's size limit. |
| `count_exceeded` | The run already reached the runtime's count limit (Section 5.10.4). |

A runtime record never contains connector-supplied text. The runtime MAY
aggregate repeated violations with the same `reason` into one record with a
`count`.

A fact that names a step, expectation, or rule id that the manifest does not
declare is not a protocol violation and is not `invalid`. The runtime keeps
it, and it supports nothing (Section 3.8).

After a violation, the runtime MUST continue the run. This is a deliberate
exception to Section 6.2 item 8: `OBSERVATION` carries diagnosis, not data,
so a discarded fact cannot corrupt collected records or state, and stopping
the run would let a connector hide the remaining evidence by sending one bad
fact.

#### 5.10.3 Retirement

A retired fact stays visible to the owner and cannot become a cause.

- A connector fact that a later connector fact names in `resolves` is retired.
  `resolves` cannot name a runtime record.
- A runtime record is retired only by a runtime record of an equivalent retry
  that succeeded. In this version, a `credential_submission` with outcome
  `rejected` or `unsettled` is retired by a later `credential_submission` on
  the same `account` with outcome `succeeded`. The `rule_match` records on
  the retired attempt's handle are retired with it.
- No connector message retires, relocates, or hides a runtime record.

#### 5.10.4 Limits

A runtime MUST bound the number and the serialized size of the `OBSERVATION`
messages that it accepts per run, the rate at which it accepts them, and the
diagnostic storage that it keeps per connector. It MUST accept at least 64
`OBSERVATION` messages per run, each up to 2048 bytes when serialized. A
connector SHOULD stay within those values. A runtime MUST keep capacity for
its own records. Past its limit, it discards further connector facts and marks
the run record truncated. Evidence from a truncated run record MUST NOT
authorize a recovery action or an instruction.

### 5.11 Failure diagnosis and the recovery-hint gate

A runtime derives the cause of a failed run from its run record. The
derivation is deterministic and can run again over stored facts. This section
fixes the predicates, the scope rule, and the order. The owner-facing wording
belongs to tooling.

**Terminal event.** The runtime chooses the terminal event from its own
records, in this order: the latest unretired `credential_submission` with
outcome `rejected` or `unsettled`; else the failed `DONE`; else the process
exit. A connector cannot choose the terminal event.

**Scope.** In this version, the diagnosis scope of the terminal failure is:

1. the runtime records linked to the terminal event through a runtime handle,
   which are the terminal `credential_submission` and the `rule_match` records
   on its `attempt` handle; and
2. the unretired connector facts that `DONE.error.basis` cites.

Only the records of item 1 are action-eligible. Every other unretired fact
stays visible to the owner and cannot become the cause.

**Cause.** The cause is one category and `cause.basis`, the ids of the facts
that support it.

| Category | Supported by an in-scope fact |
| --- | --- |
| `auth_rejected` | a `credential_submission` with outcome `rejected` under a declared `auth` rule; a `rule_match` for a declared `auth` rule; a `provider_message` with kind `auth_failure` |
| `expectation_mismatch` | an `element_expectation` with `final` other than `matched`, for a declared expectation at its declared step |
| `unknown` | nothing |

The cause's basis (`cause.basis`, which is distinct from the connector's
`DONE.error.basis`) MUST cite at least one in-scope fact that meets the
category's predicate. Otherwise the cause is `unknown`. Runtime records outrank connector
facts. `auth_rejected` outranks `expectation_mismatch`, because a login error
page is also a mismatch and the specific signal explains more. Ties break by
record order. The other in-scope findings are listed as contributing.

A cause whose `cause.basis` contains no runtime record is the connector's
account. A
runtime MUST present it as the connector's report, for example "The connector
reports that the provider rejected the sign-in", and it unlocks nothing.
`expectation_mismatch` shows that what the connector saw differed from what
it expected. It does not show that the provider changed, and a runtime MUST
NOT present it as a provider change.

**The recovery-hint gate.** A runtime MUST NOT act on a portable recovery hint
(Section 5.5), or present it to the owner as an instruction, unless the hint's
predicate below holds over the failure's action-eligible facts. Otherwise it
MUST show the hint only as the connector's attributed suggestion, together
with the diagnosis. It also records `connector_defect` with class `hint_unsupported`. Records that the
gate itself makes never satisfy a predicate.

| Hint | Predicate in this version |
| --- | --- |
| `refresh_credentials` | A runtime `credential_submission` with outcome `rejected` under a declared `auth` rule. |
| `not_retriable`, `unknown` | Always holds. |
| `manual_action_required`, `update_selector`, `retry_on_connector_upgrade`, `upstream_unblock`, `retry_by_runtime` | Never holds in this version. Each needs runtime evidence that this version does not define (Section 5.13). |

Because a runtime records `credential_submission` only for a submission that
it performed itself (Section 5.10.2), and runtime-performed submission belongs
to the credential attempt ledger and sealed authentication (Section 5.13), the
`refresh_credentials` predicate effectively never holds in this version. The
owner's sign-in, which is always available (below), covers that case.

`DONE.error.retryable` and the `retryable` member of a hint are connector
claims. A runtime MUST NOT start an automatic retry or resubmission because of
either. It starts one only when the gate allows `retry_by_runtime`, which
never holds in this version.

A `provider_message` with kind `auth_failure` and no runtime record derives
`auth_rejected` as the connector's report. It does not unlock a credential
prompt or any other recovery control. Independently of diagnosis, a runtime
that keeps connections MUST let the owner start a sign-in for a connection at
any time. That sign-in runs on the provider's origin in a runtime-owned
browser or through the runtime's credential store, never in a form that a
connector renders. Credential entry that the runtime renders itself is
conformant when any connector-supplied text in it appears only as attributed,
inert labels.

The connector's own error text (`DONE.error.message`) stays visible to the
owner together with the diagnosis. A runtime MUST NOT hide or replace that
text because it has a diagnosis.

### 5.12 Diagnostic data stays on the device

Facts, run records, and causes are available to the owner locally. A runtime
MUST NOT transmit them off the device, or to any data recipient, except by
the owner's action for one incident, after the owner sees a preview of the
exact payload. A runtime MUST NOT offer a standing opt-in that sends
diagnostic reports automatically. Raw recordings, cookies, credentials, and
saved pages MUST NOT leave the device by this path at all.

A diagnostic report is minimized personal data, not anonymous data. It can
reveal that the owner uses a provider and when a run failed, and a connector
can steer which outcome occurs.

### 5.13 Not in this version

This version defines part of the failure-diagnosis design. This section only
names the remaining parts. It does not define their behavior.

- The credential attempt ledger: at most one unresolved credential attempt
  per account, the attention state, and owner-authorized retries.
- Sealed authentication, which keeps a secret from the connector.
- Runtime re-evaluation of a declared expectation in a runtime-owned browser,
  and the syntax of a declared rule's match condition.
- Two-tier causal eligibility, step boundaries (`step_started`,
  `step_completed`), runtime-assigned operations, and declared step
  prerequisites.
- Network-shape baselines, selector baselines, and `shape_divergence`.
- Canary status in the catalog.
- The other fact types and cause categories of the design, including
  `http_response`, `api_error`, `challenge`, `interaction_unavailable`,
  `network_failure`, `policy_denial`, `interruption`, and `not_observed`;
  the other `provider_message` kinds; registered cause details; runtime
  coverage markers on facts; and `SKIP_RESULT.basis` with per-stream
  derivation.
- Extension fact types named by absolute URIs. In this version an
  `OBSERVATION` with any other `fact` value is invalid.
- The structure of a shared diagnostic report.

## 6. Conformance

### 6.1 Connector conformance

A conforming connector:

1. Declares a valid 0.3.0 manifest.
2. Reads one valid `START` before it emits a message.
3. Emits only valid JSON Lines messages defined by this profile or by a
   negotiated extension.
4. Emits records only within `START.scope` and validates each record against
   its declared stream schema.
5. Emits final `DONE` where possible and emits nothing after it.
6. Emits `STATE` only after the records covered by that state.
7. Stores no secret in state, diagnostics, or detail locators.
8. Puts no collection or processing time of its own in record `data`.
9. Waits for a matching response after `INTERACTION`.
10. Declares every optional protocol capability it can emit.
11. Produces the checkpoint and detail evidence required by its declared
    strategies.
12. When it declares filesystem inputs, reads owner data from local paths only
    through those inputs and writes nothing under a `read` input.
13. Emits OBSERVATION facts only as Section 5.10 defines,
    with no secret and no provider text in them, and cites in
    `DONE.error.basis` only ids that it emitted in the run.
14. Reports an enumerated stream complete, by a `STATE` that marks the
    enumeration finished or by ending the run with no skip for that stream,
    only after it observed the end of the enumeration from the source. A
    `STATE` that records progress before a skip, such as a deferred window, is
    not a completion. Evidence is a last-page signal or a connection with no
    next page, a source total that matches the enumerated count, or the
    source's own empty-state payload or renderer for zero items. A timeout, a
    missing list container, or a next-page control that may not have rendered
    is not evidence. A runtime cannot verify this item, as with
    `STREAM_EVIDENCE.considered` (Section 5.7).
15. Applies Section 5.6.5 directly or through a library: registers candidates
    before parsing, distinguishes readable, explicitly empty and unavailable
    fields, retains typed local dispositions, and requires enumeration closure
    independently of emission. Using no SDK does not waive these requirements.

### 6.2 Runtime conformance

A conforming runtime:

1. Validates the manifest and matches bindings, binding features, and protocol
   capabilities before spawn. It rejects unsupported profile versions and the
   missing, duplicate or invalid parent relationships, related streams and
   foreign-key declarations or unsupported relationship cardinality/shape listed
   in Sections 3.6 and 5.2 before spawn.
2. Sends one first `START` with a non-empty, resolved scope, preserving canonical
   identity and attribution-required foreign keys as ingest-required fields
   under Section 5.1's authorized projection rules. It refuses an unsatisfiable
   field selection before effects; it does not widen consent or strip attribution.
3. Enforces that scope again before durable write.
4. Treats connector messages and state as untrusted input.
5. Handles one pending interaction, limits its secret data, and returns a
   `timeout` response when the interaction times out.
6. Stages and commits state only under Section 5.3 and Section 5.8.
7. Validates checkpoint dependencies, strict coverage, baselines, gap
   source-account bindings, outstanding-debt precedence, old/new membership
   invalidation and generation-fenced admission of every durable mutation
   (Section 5.6), including complete authorized debt discovery and typed
   recovery-seal validation/atomic checkpoint settlement in Section 5.6.6.
   If it supports the optional
   STREAM_EVIDENCE capability, it also validates that message under Section 5.7.
8. Terminates a connector on a protocol violation, except that it continues
   the run after an `OBSERVATION` violation as Section 5.10.2 requires. A RECORD refused at durable admission is a rejected
   effect under Section 5.6.4, not a protocol violation.
9. Does not report a cancelled, abandoned, malformed, or incomplete run as
   successful.
10. If it confines filesystem access, makes only the declared filesystem
    inputs visible, read-only when `access` is `read`. If it supports the
    deprecated `import_dir_env_var`, it follows the transition rules in
    Section 3.3.5.
11. Applies the recovery-hint gate of Section 5.11 before it acts on a hint or
    presents one as an instruction, and keeps the connector's error text
    visible.
12. Transmits diagnostic data only as Section 5.12 allows.

13. Enforces admission and checkpoint rules for disclosed partial-record
    outcomes: matching admitted gap debt or withholding the affected boundary,
    never fabricated completion. Applies explicit deletes under the fixed-
    generation fence, preserves admitted effects through later failure, and
    distinguishes them from eligible state, receipt and debt-settlement
    commits (Sections 5.6.5 and 5.8.1). These checks do not independently prove
    source completeness or detect an undisclosed partial read; connector
    integrity remains a separate conformance obligation.

Connector conformance and runtime conformance are separate claims. An artifact
registry entry or successful package installation does not establish either
claim.

### 6.3 Strict-accounting conformance cases

Implementations claiming 0.3.0 MUST exercise every
[strict-accounting vector](vectors/collection-profile-0.3.0-strict-accounting.json)
through their real enumeration, disposition, admission and commit paths;
constructed coverage bypassing those paths does not count.

## 7. Extensions

### 7.1 Store collection evidence (RUN_COVERAGE_V1)

This extension adds optional terminal store collection evidence, carried as
`DONE.coverage`. It has its own payload version, `coverage.version` 1, and its
own capability, `RUN_COVERAGE_V1`. Neither changes with the profile version.

This extension applies to manifests whose protocol_version is 0.1.0, 0.2.0 or
0.3.0. Using this extension never makes a runtime conformant to a base profile
version it does not fully implement; conformance to the base profile is a
separate claim.

`RUN_COVERAGE_V1` is an elective capability for runtimes that implement the
elective exception in Section 3.4. Such a runtime that does not support
`RUN_COVERAGE_V1` MAY start the connector only if all other placement
requirements pass. It MUST omit `START.run_coverage_version`, and the connector
MUST omit `DONE.coverage`. The extension is negotiated per run, so an exchange
without the request is an ordinary base-profile exchange.

Applicability to base profiles 0.1.0 and 0.2.0 does not imply interoperability
with unchanged readers. Old required-only readers that do not support a declared
`RUN_COVERAGE_V1` reject the connector before `START`. Rollout MUST be
runtime-first: upgrade readers to implement the elective exception before
deploying manifests that declare `RUN_COVERAGE_V1`, as required by Section 8.

#### 7.1.1 Declaration and negotiation

A connector that uses this extension MUST declare `RUN_COVERAGE_V1` in
`protocol_capabilities`. Declaring `coverage_stores` on a stream, or emitting
`DONE.coverage`, is a use of this extension. `coverage_stores` is valid only
with that declaration, and a validator MUST reject `coverage_stores` without it.

A stream MAY declare `coverage_stores`, a non-empty array of unique, opaque,
non-empty string identifiers. An identifier MUST NOT contain a credential or a
device-specific path. Identifiers are scoped to their stream and manifest
revision. The manifest MUST state each store's collection obligation, including
whether the store covers content or metadata inventory only. A runtime MUST NOT
derive positive store coverage for a stream that declares no `coverage_stores`.
A change to a store's obligation MUST change the manifest revision. A manifest
revision is the manifest content that its manifest fingerprint identifies
(Section 7.1.2).

A runtime requests version 1 evidence with `START.run_coverage_version` and
`START.collection_scope`. When `START` omits `run_coverage_version`, a connector
MUST omit `DONE.coverage`. Omission, including by producers that predate the
field, follows Section 7.1.2.

| Field | Requirement |
| --- | --- |
| `run_coverage_version` | OPTIONAL value `1`, requesting terminal store collection evidence (Section 7.1.2). |
| `collection_scope` | REQUIRED non-empty string when version 1 store collection evidence is requested. |

When the runtime requests version 1 evidence, it MUST supply a non-empty
`collection_scope` string. If it emits `DONE.coverage`, the connector MUST echo
that string without modification in `collection_scope`. The runtime MUST bind
the string to the run's normalized effective targets, collection mode, prior
checkpoint boundary, and source-root restrictions (the filesystem inputs
declared under Section 3.3.5). A runtime MUST NOT request evidence for a run
whose effective scope it cannot fully bind into collection_scope. The echoed
string is correlation data and MUST NOT confer authorization. The `scoped` flag
in Section 7.1.2 does not change `START.scope` or the run's authority bindings.

#### 7.1.2 Optional terminal store collection evidence

A failed `DONE` MUST NOT contain `coverage`.

The coverage object MUST contain `version: 1`, `collection_scope`, and a
non-empty `streams` array. Each stream MUST contain a non-empty `stream` name, a
boolean `scoped`, and a non-empty `stores` array. Each store MUST contain a
non-empty `store` identifier and one status. The stream entries MUST equal the
requested stream set, and each stream's stores MUST equal its manifest
inventory, without duplicates or extras. A connector MUST omit the whole object
when a requested stream has no declared inventory.

For each store's declared obligation within the authorized source account and
scope, the connector MUST report the first applicable result below:

| Condition, in precedence order | Status |
| --- | --- |
| Store inaccessible before enumeration begins | `unavailable` |
| Enumeration or candidate classification not closed | `failed` |
| Closed, but an in-scope candidate, required field, supported item or required payload was skipped, deferred, unsupported or left pending | `partial` |
| Otherwise: every candidate has an emitted upsert/delete, unchanged state backed by a valid same-obligation baseline, or a proven scope exclusion | `collected` |

Accepted `collected` means the connector asserted closure and the runtime found
no contradictory accounting; it does not independently verify source
enumeration or source snapshot consistency. Proven empty enumeration can be
`collected`; absence of records or a file-read failure is not proof of
emptiness. Pagination exhaustion alone does not establish initial/backfill
completion. A delta establishes full-obligation collection only with a valid
same-obligation baseline and the complete required change interval. `unknown`
means insufficient usable evidence: it is a projection state, not a wire status
or a severity below `failed`. `scoped: true` asserts that enumeration honored
the requested boundary; `scoped: false` supplies no such assertion and MUST NOT
support positive coverage for that stream. Neither value asserts binding
enforcement under Section 3.3.9.

A positive covers only the obligation within its bound collection_scope.
It MUST NOT be presented as coverage of a wider view.

In this extension, durable admission means that the durable write path accepted
the effect, and outstanding debt means unrecovered durable detail gaps (Section
5.6 of the applicable base profile; Sections 5.6.2 and 5.6.6 under 0.3.0, where
pending seals remain debt until commit).

The runtime MUST reconcile assertions with DETAIL_COVERAGE, durable admission,
outstanding debt and applicable checkpoint outcomes for the same obligations,
and with STREAM_EVIDENCE when negotiated and emitted; lawful absence of that
optional message is not missing accounting. The connector's assertion MUST NOT
override runtime evidence or substitute for required accounting. Known
inaccessibility, incomplete closure or missing required work takes the
corresponding negative result above; insufficient usable evidence yields
`unknown`, without erasing a known negative. Negative runtime accounting that
cannot be attributed to a specific store MUST downgrade every store of that
stream. A rejected in-scope effect, unresolved debt, missing required accounting
or withheld affected checkpoint MUST prevent positive coverage for its
obligation. This downgrade does not change checkpoint eligibility.
`DONE.coverage` MUST NOT authorize STATE advancement, materialization receipts,
debt settlement or absence-derived deletion.

Before accepting positive coverage, the runtime MUST validate version, boundary
echo, stream/store sets, statuses and run bindings. Missing, unsupported or
malformed coverage yields unknown unless a known negative applies; the runtime
MAY fail the exchange instead. Omission of `DONE.coverage` is a new terminal
result, including when evidence was not negotiated or the producer predates it;
it MUST retire earlier positive evidence under Section 7.1.3, whether or not the
run includes `STATE`. A transport acknowledgment is not durable admission. A
later fully validated run for the same obligation may replace a negative; under
0.3.0, debt settlement still requires Sections 5.6.2, 5.6.3 and 5.6.6. For older
versions, debt settlement still follows Section 5.6 of the applicable base
profile. A connection-wide verdict MUST NOT imply coverage for omitted or
uninstrumented streams.

A positive is bound to one release. Its artifact digest is `sha256:` followed by
64 lowercase hexadecimal digits: SHA-256 of the exact distributed release-artifact
bytes from which the executed connector was obtained, not an unpacked or
reserialized representation. Its manifest fingerprint is 64 lowercase
hexadecimal digits: SHA-256 of the UTF-8 RFC 8785 JSON Canonicalization Scheme
(JCS) serialization of the entire manifest. The artifact digest and manifest
fingerprint MUST match a release pair verified by the runtime or server for
that connector. An unregistered digest, or a digest paired with a different
manifest fingerprint, MUST NOT establish positive coverage. A different release
MUST invalidate the positive, with no exception.

#### 7.1.3 Terminal run records and coverage currency

A runtime that implements store collection evidence MUST commit an orderable
terminal run record for every run's final outcome, including failure and omitted
evidence, whether or not evidence was negotiated or the run changed `STATE`.
The record MUST name the run, its sequence and final outcome under Sections 4
and 5.8; successful `DONE` followed by process failure is not a successful run.

Run sequence decides eligibility; commit revision orders observations. The
persisting component MUST apply this state/event table, ordering per connection
and projecting per affected obligation, never using wall-clock timestamps to
decide currency:

| State or event | Required transition |
| --- | --- |
| Run starts | Assign a strictly increasing run sequence before admitting any effect. |
| Coverage-affecting observation, including a relevant run attempt, admitted effect or terminal outcome | Assign a strictly increasing commit revision; unrelated observations do not change coverage or take a coverage revision. |
| Positive terminal result | Publish only after successful `DONE`, exit 0, durable admission of relevant effects and completion of applicable commits. It is current only while no later-committed coverage-affecting observation of a newer-or-equal run exists; earlier-run records remain history. Do not improve coverage while later relevant work is unresolved. |
| Later coverage-affecting observation of a newer-or-equal run | Retire the positive to unknown unless the observation establishes a validated replacement result. Run registration (a run start that admits no effect) does not retire a positive. |
| Exact replay of the same terminal record | Return the stored receipt without changing revision or coverage; reject a conflicting duplicate and write nothing. |
| Missing, unreadable or ambiguous sequence/revision | Project unknown, not positive coverage. |
| Restore that can regress ordering | Reset positives to unknown until a run assigned after the restore commits an eligible current terminal record. |

An in-flight run does not make the earlier run's fact false. That run stays
shown with its as-of: the commit revision and time of its terminal record
(Section 7.1.4).

Disclosed limit: a run that is registered and then crashes before any terminal
record or ingested record leaves the earlier positive standing.

A run whose start registration failed, so it has no run sequence, still counts
as an observed later attempt. Its terminal record or ingested records retire
earlier positives, and it can never itself be eligible.

#### 7.1.4 Coverage facts

Coverage is a fact about one run. It is never a present-tense claim about the
source. A terminal store coverage projection MUST carry the run identifier and
sequence, release artifact digest (explicitly absent if unrecorded), and terminal
record commit revision and time. Owner-facing text MUST identify that run and
commit time, not imply a source snapshot at commit time; a source snapshot time
may be shown only when supported by source evidence and distinguished from
commit time. The runtime MUST retain connection, source-account,
placement-generation, manifest-revision and executable-release bindings and
revalidate them before reusing a positive for a requested view. Metadata-only
inventory coverage MUST NOT be displayed as completeness of underlying content.

A coverage projection derived from DETAIL_COVERAGE or STREAM_EVIDENCE SHOULD
carry the same facts. This profile leaves those projections runtime-specific.

Informative presentation and deployment guidance (non-normative): for example,
"collection of <store> completed in run R; committed at T". Deployment-specific
event exclusions, stricter local verdicts, restore-path disclosure and catalog
migration policy are implementer guidance, not additional protocol requirements.
See the non-normative implementer note and its requirement/test mapping:
https://github.com/PDP-Connect/data-connect/blob/feat/local-run-coverage-verdict/docs/261021-local-device-coverage-evidence.md

#### 7.1.5 Accounting under the base profile

This requirement applies under every base profile version that this extension
lists. A positive (`collected`) also requires that the base profile's own
accounting for that run show no contradiction. Any obligation whose accounting
the runtime cannot evaluate under its base profile yields no positive. A 0.1.0
or 0.2.0 run with legacy detail accounting gets no positive for a stream whose
detail accounting is incomplete or unevaluated. Under 0.1.0 and 0.2.0, a
stream's detail
accounting is incomplete when a required key is unaccounted, and unevaluated
when a checkpoint-parent boundary has no `DETAIL_COVERAGE` report
(Section 5.6 of the applicable base profile).

Base profiles 0.1.0 and 0.2.0 define no same-obligation baseline and no change
interval. A rule in this extension that depends on either applies only where
the base profile defines it. Under 0.1.0 and 0.2.0, a delta run therefore
establishes no
full-obligation collection, and unchanged state supports no positive.

For 0.3.0, same-obligation identity and range refer to Section 5.6.1; baseline
validity and admission invalidation follow Section 5.6.3. The runtime MUST apply
the mandatory accounting and outcome checks of Sections 5.6.2 through 5.6.6,
including portable recovery seals where applicable. `RUN_COVERAGE_V1` and
`DONE.coverage` do not replace those requirements or relax Sections 3.4 and 6.

### 7.2 Runtime-specific extensions

This profile does not define `ASSISTANCE`, `ASSISTANCE_STATUS`,
`DETAIL_GAPS_PAGE_REQUEST`, `DETAIL_GAPS_PAGE_RESPONSE`,
`DETAIL_GAP_ATTEMPTED`. It also does not define
`START.detail_gaps`, `START.recovery_only`, or `START.streamsToBackfill`.
Portable DETAIL_GAP_RECOVERED and START.detail_debts are instead defined by
Section 5.6.6. Legacy extension shapes (including gap_id-only acknowledgments)
are not aliases for this typed seal.
It does not define `CANCEL`, `RECORD_ERROR`, or a versioned `STATE` schema.
It does not define the `BLOB` message or the `BLOB` protocol capability, which
the current connector-protocol package defines and the `anthropic` manifest
declares.

A runtime MAY define these features in a separately versioned extension. A
connector MUST NOT require one without explicit capability or package-version
coordination. None is required for 0.3.0 conformance.

## 8. Profile versioning

The Collection Profile version is independent of connector package versions,
connector versions, and runtime package versions. The manifest
`protocol_version` identifies the profile version that the manifest implements.

Profile versions use `MAJOR.MINOR.PATCH`:

- A patch version clarifies text or fixes an error without changing a valid
  manifest or wire exchange.
- While MAJOR is `0`, a MINOR version MAY make incompatible manifest or wire
  changes. Section 1 applies this to 0.3.0.
- While MAJOR is `1` or higher, a MINOR version can add optional,
  capability-gated fields or messages. It MUST preserve valid exchanges from
  earlier minor versions in the same major version.
- A major version can make incompatible manifest or wire changes.

A runtime MUST NOT infer compatibility from an unknown version. It MUST either
support that exact version or apply an explicit compatibility rule that it
advertises. A new optional message that an older fail-closed runtime would
reject requires capability negotiation and a runtime-first rollout.

Version 0.3.0 is a breaking revision of 0.2.0. It folds in all 0.2.0 content:
OBSERVATION, diagnostic_descriptors, DONE.error.basis, and Sections 5.10
through 5.13. Accepting 0.3.0 requires every mandatory rule, not partial 0.2.0
support. This includes declared detail transform_epoch, START.detail_debts and
the fully typed portable DETAIL_GAP_RECOVERED lifecycle; old gap_id-only
extension acknowledgments cannot be interpreted as such seals.

The complete/empty/unchanged/gap replacement invalidates earlier
hydrated-without-record and optional_skip_keys exchanges. Under MAJOR `0` it
ships in MINOR version 0.3.0. Lenient parsing, advisory flags or connector
folds MUST NOT hide that incompatibility. Unsupported versions MUST be refused
before spawn.

Rollout is runtime-first. During a bounded catalog migration a runtime MAY run
explicitly supported old-profile connectors under old rules in separate
versioned paths. The transition ends when that runtime's own catalog contains
no connector entries with protocol_version below 0.3.0. From that point the
deployment MUST refuse old-profile connectors; this is not a permanent legacy
escape hatch. A new runtime MUST NOT interpret an old connector as 0.3.0.
No baseline receipt may be minted from legacy state: the first strict
run per connection/source-account binding MUST recollect its obligations;
retained legacy debt is not silently settled or aliased across accounts. An old runtime MUST refuse
a new connector unless it implements this whole version. Publishing this
draft changes no current deployment or independent cutover work. Adoption of
this draft is an explicit implementation decision, not a prerequisite for
that independent cutover.

## 9. Provisional source-backed fulfillment

This section is non-normative. It records accepted design work that is not yet
implemented and does not decide the permanent specification home of the feature.

The proposal adds a per-stream `fulfillment.source_backed` object. That object
declares static adapter capability. It does not activate the posture. An owner
selects `source_backed` separately for one stream on one connection. The active
posture determines the effective query capability. It also excludes that stream
from ordinary collection and canonical ingest while leaving retained rows
dormant until the owner deletes them explicitly.

The accepted design gives the provisional capability these constraints:

- The stream has `append_only` semantics, a stable source-native primary key,
  and a `cursor_field` that supports deterministic ordering by
  `(cursor_field, primary_key)` in both directions.
- The adapter supports bounded list pages, exact top-level scalar filters,
  field and view projection, and single-record detail reads. A source that
  cannot provide a bounded unfiltered list is not eligible.
- The stream schema has no `blob_ref` field. Source-backed blob lifecycle is
  deferred.
- `fulfillment.source_backed.query` uses the stream `query` grammar and is a
  subset of the overall stream query surface.
- Connection configuration selects `retained` or `source_backed` per stream.
  The default is `retained`. A manifest never selects connection posture.
- Source-backed responses disclose `live` or `cache` origin and report honest
  freshness. Upstream failure is a structured error, not an empty success.
- The resource server continues to enforce grants locally. It never forwards a
  client access token or owner token to the source.
- A switch to `source_backed` does not delete retained rows. It makes them
  dormant until a separate owner deletion or a later return to `retained`.

The proposal remains pending OD-4. A manifest that contains this member does
not gain 0.3.0 conformance, and a runtime MUST NOT infer support from the member
alone.
