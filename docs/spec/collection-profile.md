# PDPP Collection Profile v0.1.0

Status: Normative draft. This is the canonical PDPP Collection Profile.

Date: 2026-10-02

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
which validates `runtime_requirements.bindings`, together with
[`schemas/connector-binding-grammar.mjs`](../../schemas/connector-binding-grammar.mjs),
which canonicalizes and validates the constraint grammars of Section 3.3.2
beyond what JSON Schema alone can express.
[`schemas/connector-manifest.schema.test.mjs`](../../schemas/connector-manifest.schema.test.mjs)
checks that the binding, feature, and filesystem input tables in Section 3.3
match the schema, and
that every manifest under `connectors/` validates against it.

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
change their Core meaning.

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

A wildcard matches exactly one additional label, never the bare apex and
never two or more additional labels: `*.chase.com` matches
`secure.chase.com`, but it matches neither `chase.com` itself nor
`a.b.chase.com`. The design note does not fix a wildcard's matching depth;
this profile picks the narrowest reading, the same depth a single-label TLS
certificate wildcard covers, rather than the unbounded depth some other
systems (for example CSP host-source wildcards) allow.
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
that list MUST state its port.

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
| `access` | REQUIRED. `read` is the only v0.1 value. |
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

A `filesystem` declaration without `inputs` remains valid in v0.1. It makes no
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
| `access` | REQUIRED. `write` is the only v0.1 value. |
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
a blob sink. Section 7 lists the `BLOB` message as a runtime-specific
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
requires. A runtime MUST advertise its supported protocol version and
capabilities before placement. It MUST reject a connector with an unsupported
required capability before spawn.

The only portable v0.1 capability is `STREAM_EVIDENCE`. A connector that can emit
`STREAM_EVIDENCE` MUST declare that value. A runtime that does not advertise it
MUST NOT start that connector.

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
- `parent_streams` names one or more other streams. The declaring stream MUST
  use `coverage_strategy: "parent_detail_accounting"`. It emits one
  `DETAIL_COVERAGE` for each parent boundary that it evaluates.

A stream MUST NOT declare both fields. Before spawn, a runtime MUST reject a
manifest with a self-reference, unknown parent, duplicate parent, empty
`parent_streams`, strategy mismatch, or cycle of any length. A valid dependency
graph is acyclic and ends at one or more self-mapped streams.

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

These members are not part of portable v0.1 conformance. A runtime MAY support
them as implementation metadata. Any manifest member that this profile does
not define is also outside portable v0.1. A connector MUST NOT use such a
declaration to grant itself authority, widen collection scope, or bypass owner
approval.

In particular, a connector-authored option kind is only a claim. Runtime or
operator policy decides whether an option changes collection scope. An unknown
option MUST default to the more restrictive collection-scope treatment.

## 4. Run protocol

The runtime and connector exchange one JSON object per line. The runtime writes
to connector standard input. The connector writes to standard output.
Standard error is diagnostic only and MUST NOT contain protocol messages.

Before spawn, the runtime MUST match the bindings, binding features, and
protocol capabilities required by the connector against its advertised support.
A mismatch fails the run before any connector code executes.

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
| `now` | OPTIONAL [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) date-time with a time-zone offset. It is the run's notion of the current time. |

Each scope stream has a REQUIRED `name`. `resources` is an OPTIONAL array of
canonical record-key strings. `fields` is an OPTIONAL array of top-level record
fields. `time_range` is an OPTIONAL object with `since` and `until` timestamps.
A runtime MUST resolve wildcards and view names before `START`. It MUST NOT send
a wildcard stream name or an issuance-time `necessity` value.

A simple canonical record key is its string value. A composite canonical key is
the minified JSON array of its string components in `primary_key` order. For
example, `["user-1","2026-09-02"]` is one canonical key string. Each
`resources` entry uses this form.

`time_range.since` and `time_range.until` MUST be ISO 8601 timestamps. `since`
is inclusive and `until` is exclusive. The connector applies both bounds to
the declared `consent_time_field`. A runtime MUST NOT send `time_range` for a
stream without that field. During a time-bounded run, the connector MUST NOT
emit a record whose consent-time value is absent, null, or not a valid ISO 8601
timestamp.

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
before emission. The runtime MUST add schema-required and ingest-required fields
to a requested `fields` list before it sends `START`. A connector that cannot
apply a constraint MUST emit `SKIP_RESULT` with
`reason: "scope_not_supported"` for that stream or fail the run. It MUST NOT
silently broaden scope.

The runtime and durable write path MUST reject or discard an out-of-scope
record. A connector can read broader source-side data when the source cannot
filter precisely, but it MUST restrict what it emits.

Runtime-specific `START` members for backfill and detail-gap recovery are
defined in the
[runtime note](../../packages/polyfill-connectors/docs/collection-profile-runtime.md).
They are not portable v0.1 fields.

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

A connector MUST measure `considered` at the enumeration site of the child
stream. It MUST NOT derive the value only from emitted and gapped messages. It
MUST withhold the message when it did not enumerate that stream. A connector
MAY emit at most one `STREAM_EVIDENCE` per stream per run.

`STREAM_EVIDENCE` is final for that stream in the run. After it emits the
message, a connector MUST NOT emit a `RECORD`, `DETAIL_GAP`, or
`DETAIL_GAP_RECOVERED` for the same stream.

A runtime MUST reject an invalid count partition, a duplicate message, an
out-of-scope stream, a stream that does not declare `state_stream`, or a later
message that reopens the stream. Before it accepts the evidence, the runtime
MUST verify two observable counts:

1. `outcomes.emitted` equals the number of distinct record keys that the
   durable write path accepted for that stream in this run.
2. `outcomes.gapped` equals the number of distinct, unrecovered durable detail
   gaps for that stream in this run.

The second check proves count equality, not gap-key identity, because the
message contains no gap identifiers. The runtime cannot independently verify
`unchanged`, a withheld message, or how the connector derived `considered`.
Those values remain connector assertions and MUST NOT be used to widen scope or
commit a checkpoint.

### 5.8 `DONE` and checkpoint commit

```json
{ "type": "DONE", "status": "succeeded", "records_emitted": 42 }
```

`DONE` is the final connector message. `DONE.status` has two values:
`succeeded` and `failed`. `records_emitted` is a REQUIRED non-negative integer.
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
8. Puts no collection or processing time of its own in record `data`.
9. Waits for a matching response after `INTERACTION`.
10. Declares every optional protocol capability it can emit.
11. Produces the checkpoint and detail evidence required by its declared
    strategies.
12. When it declares filesystem inputs, reads owner data from local paths only
    through those inputs and writes nothing under a `read` input.

### 6.2 Runtime conformance

A conforming runtime:

1. Validates the manifest and matches bindings, binding features, and protocol
   capabilities before spawn.
2. Sends one first `START` with a non-empty, resolved scope.
3. Enforces that scope again before durable write.
4. Treats connector messages and state as untrusted input.
5. Handles one pending interaction, limits its secret data, and returns a
   `timeout` response when the interaction times out.
6. Stages and commits state only under Section 5.3 and Section 5.8.
7. Validates checkpoint dependencies, coverage, and gaps. If it advertises
   `STREAM_EVIDENCE`, it also validates that message as defined in Section 5.7.
8. Terminates a connector on a protocol violation.
9. Does not report a cancelled, abandoned, malformed, or incomplete run as
   successful.
10. If it confines filesystem access, makes only the declared filesystem
    inputs visible, read-only when `access` is `read`. If it supports the
    deprecated `import_dir_env_var`, it follows the transition rules in
    Section 3.3.5.

Connector conformance and runtime conformance are separate claims. An artifact
registry entry or successful package installation does not establish either
claim.

## 7. Runtime-specific extensions

This profile does not define `ASSISTANCE`, `ASSISTANCE_STATUS`,
`DETAIL_GAPS_PAGE_REQUEST`, `DETAIL_GAPS_PAGE_RESPONSE`,
`DETAIL_GAP_ATTEMPTED`, or `DETAIL_GAP_RECOVERED`. It also does not define
`START.detail_gaps`, `START.recovery_only`, or `START.streamsToBackfill`.
It does not define `CANCEL`, `RECORD_ERROR`, or a versioned `STATE` schema.
It does not define the `BLOB` message or the `BLOB` protocol capability, which
the current connector-protocol package defines and the `anthropic` manifest
declares.

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
not gain v0.1 conformance, and a runtime MUST NOT infer support from the member
alone.
