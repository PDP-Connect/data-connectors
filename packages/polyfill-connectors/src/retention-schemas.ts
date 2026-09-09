// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { z } from "zod";

export const RETENTION_FORMAT_VERSION = 1;
export const RETENTION_MAX_RECORD_BYTES = 262_144;
export const RETENTION_MAX_CHUNK_BYTES = 4_194_304;
const id = z
	.string()
	.min(1)
	.refine(
		(value) => Buffer.from(value, "utf8").toString("utf8") === value,
		"Identifier must be well-formed Unicode",
	);
const encodedPath = z.discriminatedUnion("encoding", [
	z.strictObject({ encoding: z.literal("utf8"), value: id }),
	z.strictObject({
		encoding: z.literal("base64"),
		value: id.refine((value) => {
			const decoded = Buffer.from(value, "base64");
			return decoded.length > 0 && decoded.toString("base64") === value;
		}, "Path bytes must use canonical nonempty base64"),
	}),
]);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const version = z.literal(1);
export const retentionArtifactClassSchema = z.enum([
	"claude.tool_result",
	"claude.tool_use.input",
	"images",
	"claude.thinking",
	"codex.reasoning",
	"codex.custom_tool_output",
	"codex.function_output",
	"shell_snapshots",
	"tool_result_sidecars",
	"documents",
	"codex.custom_tool_input",
	"codex.function_arguments",
	"unknown",
	"unclassified",
]);
// Threshold and strict uncertainty policies are deferred.
export const retentionPolicySchema = z.strictObject({
	format_version: version,
	policy_version: z.literal(1),
	default: z.literal("keep"),
	rules: z.partialRecord(
		retentionArtifactClassSchema.exclude(["unknown", "unclassified"]),
		z.enum(["keep", "omit"]),
	),
	unclassified: z.literal("keep"),
});
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
	format_version: 1,
	policy_version: 1,
	default: "keep",
	rules: Object.freeze({}),
	unclassified: "keep",
});
const provenance = {
	format_version: version,
	classifier_version: id,
	connector_id: id,
	connector_instance_id: id,
	// Reuse enrollment device identity only when reconnect stability is established.
	source_device_id: id,
	source_root_id: id,
	source_file_id: id,
	generation_id: id,
	policy_version: z.literal(1),
	policy_sha256: sha256,
};
const span = {
	start_offset: bytes,
	end_offset: bytes,
	byte_count: bytes,
	sha256,
};
function consistentSpan(value: {
	start_offset: number;
	end_offset: number;
	byte_count: number;
}): boolean {
	return (
		value.end_offset > value.start_offset &&
		value.end_offset - value.start_offset === value.byte_count
	);
}
export const retentionChunkSchema = z
	.strictObject({
		...provenance,
		...span,
		byte_count: bytes.positive().max(RETENTION_MAX_CHUNK_BYTES),
		blob_ref: z.strictObject({
			blob_id: id,
			sha256,
			size_bytes: bytes,
			mime_type: id,
		}),
	})
	.refine(consistentSpan, "Chunk range must match its byte count")
	.refine(
		(chunk) =>
			chunk.blob_ref.sha256 === chunk.sha256 &&
			chunk.blob_ref.size_bytes === chunk.byte_count &&
			chunk.blob_ref.blob_id === `blob_sha256_${chunk.sha256}`,
		"Blob reference must match original chunk bytes",
	);
export type RetentionChunk = z.infer<typeof retentionChunkSchema>;
const retainedCoverage = z
	.strictObject({ kind: z.literal("retained"), ...span, chunk_key: id })
	.refine(consistentSpan, "Retained range must match its byte count");
const omittedCoverage = z
	.strictObject({
		kind: z.literal("omitted"),
		...span,
		artifact_classes: z
			.array(retentionArtifactClassSchema.exclude(["unknown", "unclassified"]))
			.min(1),
		matched_rule: retentionArtifactClassSchema.exclude([
			"unknown",
			"unclassified",
		]),
		reason: z.literal("owner_policy"),
		locator: id,
		event_type: id.nullable(),
		policy_version: z.literal(1),
		policy_sha256: sha256,
		classifier_version: id,
	})
	.refine(consistentSpan, "Omission range must match its byte count");
const failedCoverage = z
	.strictObject({
		kind: z.literal("failed"),
		start_offset: bytes.nullable(),
		end_offset: bytes.nullable(),
		byte_count: bytes.nullable(),
		sha256: z.null(),
		reason: id,
	})
	.refine(
		(entry) =>
			entry.start_offset === null ||
			entry.end_offset === null ||
			(entry.end_offset > entry.start_offset &&
				(entry.byte_count === null ||
					entry.byte_count === entry.end_offset - entry.start_offset)),
		"Failure range must match its known byte count",
	);
export const retentionCoverageEntrySchema = z.discriminatedUnion("kind", [
	retainedCoverage,
	omittedCoverage,
	failedCoverage,
]);
export type RetentionCoverageEntry = z.infer<
	typeof retentionCoverageEntrySchema
>;
export const retentionManifestPageSchema = z.strictObject({
	format_version: version,
	capture_id: id,
	page_index: bytes,
	chunk_keys: z.array(id),
	coverage_entries: z.array(retentionCoverageEntrySchema),
	artifact_links: z.array(
		z.strictObject({
			source_file_id: id,
			relation: id,
			session_id: id.nullable(),
		}),
	),
	// Class measures may overlap; coverage entries alone partition source bytes.
	class_statistics: z.array(
		z.strictObject({
			artifact_class: retentionArtifactClassSchema,
			count: bytes,
			byte_count: bytes,
		}),
	),
	interpretation_entries: z.array(
		z
			.strictObject({
				start_offset: bytes,
				end_offset: bytes,
				outcome: z.enum([
					"projected",
					"unsupported",
					"malformed",
					"incomplete_tail",
					"projection_failed",
					"classification_unresolved",
				]),
			})
			.refine(
				(entry) => entry.end_offset > entry.start_offset,
				"Interpretation range must be nonempty",
			),
	),
});
export type RetentionManifestPage = z.infer<typeof retentionManifestPageSchema>;
// Immutable roots do not claim completion. Verification/projection receipts do.
export const retentionManifestRootSchema = z
	.strictObject({
		...provenance,
		capture_id: id,
		source_relative_path: encodedPath,
		session_id: id.nullable(),
		parent_session_id: id.nullable(),
		identity_basis: id,
		source_view: z.enum(["snapshot", "live_read"]),
		start_offset: z.literal(0),
		end_offset: bytes.nullable(),
		byte_count: bytes.nullable(),
		sha256: sha256.nullable(),
		previous_capture_id: id.nullable(),
		manifest_pages: z.array(z.strictObject({ key: id, sha256 })),
		pages_sha256: sha256,
	})
	.refine(
		(root) =>
			root.end_offset === null ||
			root.byte_count === null ||
			root.end_offset === root.byte_count,
		"Capture range must match its known byte count",
	);
export type RetentionManifestRoot = z.infer<typeof retentionManifestRootSchema>;
/** Append-only provenance observation; timestamps never enter chunk identities. */
export const retentionObservationSchema = z.strictObject({
	format_version: version,
	capture_id: id,
	observed_at: z.iso.datetime(),
	source_relative_path: encodedPath,
	identity_certainty: z.enum(["established", "uncertain"]),
	identity_basis: id,
	session_id: id.nullable(),
	parent_session_id: id.nullable(),
});

export const retentionReceiptSchema = z.strictObject({
	format_version: version,
	capture_id: id,
	verifier_version: id,
	retention_state: z.enum([
		"complete_raw",
		"complete_with_exclusions",
		"incomplete",
		"legacy_projection_only",
	]),
	projection_state: z.enum(["complete", "incomplete", "not_attempted"]),
	policy_sha256: sha256,
	result_sha256: sha256,
});
/** V1: UTF-16-sorted object keys, JSON strings/numbers, preserved array order.
 * Reject values that JSON would silently drop or coerce. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value))
		return JSON.stringify(value);
	if (Array.isArray(value))
		return `[${Array.from(value, (item: unknown) => canonicalJson(item)).join(",")}]`;
	if (
		typeof value === "object" &&
		value !== null &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`,
			)
			.join(",")}}`;
	}
	throw new TypeError("Retention canonical JSON requires plain JSON values");
}
export function retentionDigest(value: unknown): string {
	return createHash("sha256")
		.update(canonicalJson(value), "utf8")
		.digest("hex");
}
/** Decimal UTF-8 byte length, colon, bytes per member: no delimiter ambiguity. */
export function retentionTupleKey(parts: readonly string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) {
		if (Buffer.from(part, "utf8").toString("utf8") !== part)
			throw new TypeError("Retention keys require well-formed Unicode");
		hash.update(`${Buffer.byteLength(part, "utf8")}:`, "utf8");
		hash.update(part, "utf8");
	}
	return hash.digest("hex");
}
export function retentionChunkKey(chunk: RetentionChunk): string {
	return retentionTupleKey([
		String(chunk.format_version),
		chunk.classifier_version,
		chunk.connector_id,
		chunk.connector_instance_id,
		chunk.source_device_id,
		chunk.source_root_id,
		chunk.source_file_id,
		chunk.generation_id,
		chunk.policy_sha256,
		String(chunk.start_offset),
		String(chunk.end_offset),
		chunk.sha256,
	]);
}
/** Includes required wire timestamp and terminating JSONL newline. */
export function assertRetentionRecordSize(
	stream: string,
	key: string,
	data: unknown,
	emittedAt = "2000-01-01T00:00:00.000Z",
): void {
	const envelope = JSON.stringify({
		type: "RECORD",
		stream,
		key,
		data,
		emitted_at: emittedAt,
	});
	if (Buffer.byteLength(`${envelope}\n`, "utf8") > RETENTION_MAX_RECORD_BYTES)
		throw new RangeError(
			"Retention RECORD exceeds 256 KiB including its JSONL envelope",
		);
}

/** Final immutable root key is distinct from the durable staging capture_id. */
export function retentionManifestRootKey(root: RetentionManifestRoot): string {
	return retentionDigest(root);
}
