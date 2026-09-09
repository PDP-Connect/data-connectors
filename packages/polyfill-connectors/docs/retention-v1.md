# Retention contract v1

This contract describes a byte archive for Claude Code and Codex session files.
Search projections do not prove retention. PR 1 provides schemas, dormant stream
declarations, a runtime compatibility check, and a verifier for supplied synthetic
records and bytes. It does not capture files, upload blobs, enable streams in
connector profiles, or change collection cursors.

The default policy keeps every class. Explicit class rules may select `keep` or
`omit`; unknown and unclassified bytes stay kept. Byte thresholds and strict
opt-out mode are deferred. Policies are immutable and apply to future captures;
changing a policy does not delete earlier captures.

Package exports are `@pdpp/polyfill-connectors/retention-schemas`,
`@pdpp/polyfill-connectors/retention-runtime`, and
`@pdpp/polyfill-connectors/retention-verifier`. `RETENTION_STREAMS` declares
`raw_chunks`, `retention_manifests`, `retention_manifest_pages`,
`retention_policies`, `retention_observations`, and `retention_receipts`, with
their runtime schemas. These are reusable declarations for later manifest and
grant integration, not enabled streams.

## Identity and immutable content

File provenance includes connector, connector instance, source device, source
root, and source file identity. Session IDs are associations, not deduplication
keys. Unresolved session identity must not delay byte capture.

The local-device exporter already has enrollment `device_id` and
`source_instance_id` fields (`src/local-device-runtime.ts`). Retention's
`source_device_id` records durable source provenance. Reuse the enrollment device
identity when its continuity across reconnects is established and persist that
mapping. Do not infer continuity from a hostname, path, or session UUID. If the
mapping is uncertain, assign a distinct source device and record that uncertainty.
The transport's connector-instance authorization boundary still applies.

Immutable content keys exclude run IDs, observation times, and retries. Keep
observations, relocation history, and later identity associations separate from
the captured content. A root commits ordered page references; pages hold coverage
and interpretation ledgers; chunk records expose a top-level `blob_ref` for
authorized reads. Whole-file SHA-256 hashes original bytes in source order, not
digest strings. Metadata must fit 256 KiB including its RECORD envelope and final
newline. Raw chunks are at most 4,194,304 bytes; smaller partitions are permitted.

Persist a staging `capture_id` before creating pages. The final root record key
is the canonical digest of the completed root, separate from `capture_id`, so
page references do not create a circular hash dependency. Chunk keys use
length-prefixed UTF-8 tuples and include both source root and connector instance
in addition to file, device, generation, policy, classifier, range, and byte
digest. Including the full provenance prevents different roots or instances
from assigning conflicting immutable metadata to the same key. Invalid Unicode
identifiers are rejected rather than replaced during UTF-8 encoding.

Retained, omitted, and failed ranges partition the captured prefix without gaps
or overlaps. Unknown extents are null, never zero. Omission receipts preserve
the source span hash and the exact policy decision, but not excluded payloads.
Successful raw verification is independent of interpretation failures.

## Verification boundary

The synthetic verifier resolves supplied roots, pages, chunk records, and blob
bytes. It checks their hashes and coverage, and derives retention state rather
than trusting a stored completeness label. Exclusions require acceptance of the
exact policy digest. When a frozen source is supplied, it also checks original
span hashes against that source. After excluded bytes are discarded, their
hashes cannot reconstruct the source or prove its whole-file digest again.

This is a per-capture oracle, not proof that discovery found every file or that
server authorization and persistence work. PR 3 must supply actual authorized
blob readback and durable record receipts. PR 7 adds the operator command and
inventory-wide reporting. Full archive-only search parity applies to
`complete_raw`; sparse archives must instead verify omission placeholders.
The interpretation-gap count covers supplied outcomes only. An absent ledger
does not prove projection completeness; checking every expected event remains
part of the later projection and inventory work.

## Rollout and next implementation steps

The reusable stream declarations remain outside the active connector manifests.
The compatibility check requires explicit support for this format, blob upload,
authorized readback, durable receipts, atomic immutable inserts, and a retention
checkpoint. Missing support means `retention_unavailable`. Ordinary runtime
success, stdout drain, or a preview must never satisfy that gate. PR 3 must wire
the check to installed runtime/server capabilities before PRs 4–5 enable streams
in manifests, profiles, and grants.

PR 2 builds a durable raw-byte spool using these schemas and content keys. It
must preserve invalid UTF-8, malformed lines, delimiters, empty files, and final
fragments without parsing. Persist generation identity and staged page encoding
across retries. Reserve space, keep unacknowledged bytes, and test append,
replacement, disk-full, restart, and bounded memory on large generated files.
Live double reads are evidence of a stable prefix, not an atomic snapshot.

PR 3 extends the existing `src/reference-blob-uploader.ts`, already used by media
connectors. Preserve its existing consumers: imessage, gmail, whatsapp, signal,
groupme, apple_photos, and google_takeout. Use byte buffers and prefer
`application/octet-stream`; it is a safe convention, not the only accepted
content type. JSON parsed into an object is unsuitable for the blob operation.
The blob route currently inherits the hosted NDJSON request body ceiling, so
changing that limit also changes blob admission. Keep configurable smaller
chunks and test 413 recovery. Upload, metadata ingest, atomic compare-or-insert,
authorized readback, and checkpoint advancement remain separate obligations.

PR 5 owns the existing Codex filesystem-path defect: both `relativePath` and
`relativeRoot` in `connectors/codex/index.ts` use `shell-snapshots`, whereas the
native directory is `shell_snapshots`. Fix both with a discovery regression test.
The published `connectors/codex/ARCHIVAL-CONTRACT.md` promises one-way relocation,
immutable archives, and no divergent duplicates. Retention deliberately does not
rely on that no-duplicate invariant: exact moves may reuse verified identity,
but divergent copies must both survive. Test such copies as contract violations,
not as normal archiver behavior.

Collection continues unchanged during PRs 1–3, including existing parser failures.
PRs 4–5 may enable retention before parse isolation is fixed: capture runs before
projection, and initial projection coverage may therefore remain incomplete.
Keep that gap explicit and separate from verified byte retention. Backfill must
not trust old projection cursors. Nothing here proves a file deleted before
discovery was preserved; real-server and discovery acceptance tests remain due.
