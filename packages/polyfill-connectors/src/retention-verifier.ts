// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
	assertRetentionRecordSize,
	type RetentionCoverageEntry,
	type RetentionManifestRoot,
	retentionChunkKey,
	retentionChunkSchema,
	retentionDigest,
	retentionManifestPageSchema,
	retentionManifestRootKey,
	retentionManifestRootSchema,
	retentionPolicySchema,
} from "./retention-schemas.ts";

export interface RetentionVerificationInput {
	root: unknown;
	policy: unknown;
	pages: ReadonlyMap<string, unknown>;
	chunks: ReadonlyMap<string, unknown>;
	blobs: ReadonlyMap<string, Uint8Array>;
	/** Frozen original bytes, when still available. Never reconstructed from omission hashes. */
	sourceBytes?: Uint8Array;
	acceptPolicySha256?: string;
}

export interface RetentionVerificationReport {
	format_version: 1;
	retention_state: "complete_raw" | "complete_with_exclusions" | "incomplete";
	accepted: boolean;
	expected_bytes: number | null;
	retained_bytes: number;
	omitted_bytes: number;
	failed_bytes: number;
	unknown_extent: boolean;
	source_verified: boolean;
	interpretation_gaps: number;
	issues: string[];
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

const IDENTITY_FIELDS = [
	"format_version",
	"classifier_version",
	"connector_id",
	"connector_instance_id",
	"source_device_id",
	"source_root_id",
	"source_file_id",
	"generation_id",
	"policy_version",
	"policy_sha256",
] as const;

function verifyChunk(
	entry: Extract<RetentionCoverageEntry, { kind: "retained" }>,
	root: RetentionManifestRoot,
	input: RetentionVerificationInput,
	issues: string[],
): Uint8Array | undefined {
	const parsed = retentionChunkSchema.safeParse(
		input.chunks.get(entry.chunk_key),
	);
	if (!parsed.success) {
		issues.push(`missing_or_invalid_chunk:${entry.chunk_key}`);
		return;
	}
	const chunk = parsed.data;
	verifyRecordSize("raw_chunks", entry.chunk_key, chunk, issues);
	if (retentionChunkKey(chunk) !== entry.chunk_key)
		issues.push(`chunk_key_mismatch:${entry.chunk_key}`);
	if (IDENTITY_FIELDS.some((field) => chunk[field] !== root[field])) {
		issues.push(`chunk_identity_mismatch:${entry.chunk_key}`);
	}
	if (
		chunk.start_offset !== entry.start_offset ||
		chunk.end_offset !== entry.end_offset ||
		chunk.byte_count !== entry.byte_count ||
		chunk.sha256 !== entry.sha256
	) {
		issues.push(`chunk_range_mismatch:${entry.chunk_key}`);
	}
	const bytes = input.blobs.get(chunk.blob_ref.blob_id);
	if (!bytes) {
		issues.push(`missing_blob:${entry.chunk_key}`);
		return;
	}
	const digest = sha256(bytes);
	if (
		bytes.byteLength !== entry.byte_count ||
		digest !== entry.sha256 ||
		bytes.byteLength !== chunk.blob_ref.size_bytes ||
		digest !== chunk.blob_ref.sha256
	) {
		issues.push(`blob_integrity_mismatch:${entry.chunk_key}`);
	}
	return bytes;
}

function verifyRecordSize(
	stream: string,
	key: string,
	data: unknown,
	issues: string[],
): void {
	try {
		assertRetentionRecordSize(stream, key, data);
	} catch {
		issues.push(`record_size_exceeded:${key}`);
	}
}

/** Pure synthetic oracle. Callers must supply independently fetched records and blob bytes.
 * This proves the supplied capture, not source discovery, authorization, or durable storage.
 */
export function verifyRetentionCapture(
	input: RetentionVerificationInput,
): RetentionVerificationReport {
	const report: RetentionVerificationReport = {
		format_version: 1,
		retention_state: "incomplete",
		accepted: false,
		expected_bytes: null,
		retained_bytes: 0,
		omitted_bytes: 0,
		failed_bytes: 0,
		unknown_extent: false,
		source_verified: false,
		interpretation_gaps: 0,
		issues: [],
	};
	const { issues } = report;
	const parsedRoot = retentionManifestRootSchema.safeParse(input.root);
	const parsedPolicy = retentionPolicySchema.safeParse(input.policy);
	if (!(parsedRoot.success && parsedPolicy.success)) {
		issues.push("invalid_root_or_policy");
		return report;
	}
	const root = parsedRoot.data;
	const policy = parsedPolicy.data;
	verifyRecordSize(
		"retention_manifests",
		retentionManifestRootKey(root),
		root,
		issues,
	);
	verifyRecordSize("retention_policies", root.policy_sha256, policy, issues);
	report.expected_bytes = root.byte_count;
	if (
		retentionDigest(policy) !== root.policy_sha256 ||
		policy.policy_version !== root.policy_version
	) {
		issues.push("policy_identity_mismatch");
	}
	if (retentionDigest(root.manifest_pages) !== root.pages_sha256) {
		issues.push("pages_digest_mismatch");
	}
	const coverage: RetentionCoverageEntry[] = [];
	const pageKeys = new Set<string>();
	const chunkKeys = new Set<string>();
	for (const [index, reference] of root.manifest_pages.entries()) {
		const parsed = retentionManifestPageSchema.safeParse(
			input.pages.get(reference.key),
		);
		if (!parsed.success) {
			issues.push(`missing_or_invalid_page:${reference.key}`);
			continue;
		}
		const page = parsed.data;
		verifyRecordSize("retention_manifest_pages", reference.key, page, issues);
		if (
			pageKeys.has(reference.key) ||
			page.page_index !== index ||
			page.capture_id !== root.capture_id ||
			retentionDigest(page) !== reference.sha256
		) {
			issues.push(`page_integrity_mismatch:${reference.key}`);
		}
		pageKeys.add(reference.key);
		const retainedKeys = page.coverage_entries
			.filter((entry) => entry.kind === "retained")
			.map((entry) => entry.chunk_key);
		if (retentionDigest(retainedKeys) !== retentionDigest(page.chunk_keys)) {
			issues.push(`page_chunk_order_mismatch:${reference.key}`);
		}
		for (const key of page.chunk_keys) {
			if (chunkKeys.has(key)) issues.push(`duplicate_chunk:${key}`);
			chunkKeys.add(key);
		}
		coverage.push(...page.coverage_entries);
		report.interpretation_gaps += page.interpretation_entries.filter(
			(entry) => entry.outcome !== "projected",
		).length;
	}
	const rawHash = createHash("sha256");
	let offset = 0;
	for (const entry of coverage) {
		if (
			entry.start_offset === null ||
			entry.end_offset === null ||
			entry.byte_count === null
		) {
			report.unknown_extent = true;
			issues.push("unknown_coverage_extent");
			continue;
		}
		if (entry.start_offset !== offset) issues.push("coverage_gap_or_overlap");
		offset = entry.end_offset;
		if (
			input.sourceBytes &&
			entry.sha256 !== null &&
			sha256(
				input.sourceBytes.subarray(entry.start_offset, entry.end_offset),
			) !== entry.sha256
		) {
			issues.push("source_span_mismatch");
		}
		if (entry.kind === "retained") {
			report.retained_bytes += entry.byte_count;
			const bytes = verifyChunk(entry, root, input, issues);
			if (bytes) rawHash.update(bytes);
		} else if (entry.kind === "omitted") {
			report.omitted_bytes += entry.byte_count;
			if (
				entry.policy_sha256 !== root.policy_sha256 ||
				entry.policy_version !== root.policy_version ||
				entry.classifier_version !== root.classifier_version ||
				!entry.artifact_classes.includes(entry.matched_rule) ||
				policy.rules[entry.matched_rule] !== "omit"
			) {
				issues.push("omission_policy_mismatch");
			}
		} else {
			report.failed_bytes += entry.byte_count;
			issues.push("failed_coverage");
		}
	}
	if (
		root.byte_count === null ||
		root.end_offset === null ||
		root.sha256 === null
	) {
		report.unknown_extent = true;
		issues.push("unknown_source_extent");
	} else {
		if (
			offset !== root.end_offset ||
			report.retained_bytes + report.omitted_bytes + report.failed_bytes !==
				root.byte_count
		)
			issues.push("coverage_length_mismatch");
		if (report.omitted_bytes === 0 && rawHash.digest("hex") !== root.sha256)
			issues.push("source_digest_mismatch");
		if (input.sourceBytes) {
			report.source_verified =
				input.sourceBytes.byteLength === root.byte_count &&
				sha256(input.sourceBytes) === root.sha256;
			if (!report.source_verified) issues.push("frozen_source_mismatch");
		} else if (report.omitted_bytes === 0 && issues.length === 0) {
			report.source_verified = true;
		}
	}
	if (issues.length === 0) {
		report.retention_state =
			report.omitted_bytes > 0 ? "complete_with_exclusions" : "complete_raw";
		report.accepted =
			report.retention_state === "complete_raw" ||
			input.acceptPolicySha256 === root.policy_sha256;
	}
	if (issues.length > 0) report.source_verified = false;
	return report;
}
