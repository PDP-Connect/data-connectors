// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	retentionChunkKey,
	retentionChunkSchema,
	retentionDigest,
} from "./retention-schemas.ts";
import { verifyRetentionCapture } from "./retention-verifier.ts";

function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function fixture(source = Buffer.from([0, 255, 13, 10, 10, 123, 34])) {
	const policy = {
		format_version: 1,
		policy_version: 1,
		default: "keep",
		rules: {},
		unclassified: "keep",
	};
	const identity = {
		format_version: 1,
		classifier_version: "v1",
		connector_id: "codex",
		connector_instance_id: "instance",
		source_device_id: "device",
		source_root_id: "root",
		source_file_id: "file",
		generation_id: "generation",
		policy_version: 1,
		policy_sha256: retentionDigest(policy),
	};
	const chunks = new Map<string, unknown>();
	const blobs = new Map<string, Uint8Array>();
	const coverage =
		source.length === 0
			? []
			: [source.subarray(0, 3), source.subarray(3)].map((bytes, index) => {
					const start = index === 0 ? 0 : 3;
					const span = {
						start_offset: start,
						end_offset: start + bytes.length,
						byte_count: bytes.length,
						sha256: hash(bytes),
					};

					const blobId = `blob_sha256_${span.sha256}`;
					const chunk = retentionChunkSchema.parse({
						...identity,
						...span,
						blob_ref: {
							blob_id: blobId,
							sha256: span.sha256,
							size_bytes: bytes.length,
							mime_type: "application/octet-stream",
						},
					});
					const key = retentionChunkKey(chunk);
					chunks.set(key, chunk);
					blobs.set(blobId, bytes);
					return { kind: "retained", ...span, chunk_key: key };
				});
	const page = {
		format_version: 1,
		capture_id: "capture",
		page_index: 0,
		chunk_keys: [...chunks.keys()],
		coverage_entries: coverage,
		artifact_links: [],
		class_statistics: [],
		interpretation_entries: [
			{ start_offset: 0, end_offset: source.length, outcome: "malformed" },
		],
	};
	const references = [{ key: "page-0", sha256: retentionDigest(page) }];
	const root = {
		...identity,
		capture_id: "capture",
		start_offset: 0,
		end_offset: source.length,
		byte_count: source.length,
		sha256: hash(source),
		session_id: null,
		parent_session_id: null,
		identity_basis: "provisional",
		source_relative_path: { encoding: "utf8", value: "sessions/test.jsonl" },
		source_view: "snapshot",
		previous_capture_id: null,
		manifest_pages: references,
		pages_sha256: retentionDigest(references),
	};
	return {
		root,
		policy,
		page,
		chunks,
		blobs,
		pages: new Map<string, unknown>([["page-0", page]]),
		sourceBytes: source,
	};
}

function chunkKey(input: ReturnType<typeof fixture>, index: number): string {
	const key = input.page.chunk_keys[index];
	assert.ok(key);
	return key;
}

function replacePage(input: ReturnType<typeof fixture>, page: unknown): void {
	input.pages.set("page-0", page);
	input.root.manifest_pages = [
		{ key: "page-0", sha256: retentionDigest(page) },
	];
	input.root.pages_sha256 = retentionDigest(input.root.manifest_pages);
}

/** Builds a `complete_with_exclusions` capture: the second span is omitted under an
 * owner policy, so the whole-source `source_digest_mismatch` backstop is disabled and
 * chunk-level blob integrity is the only thing standing between corrupt bytes and
 * acceptance. */
function exclusionFixture(): {
	input: ReturnType<typeof fixture>;
	policy: unknown;
	policySha: string;
	retainedBlobId: string;
} {
	const input = fixture();
	const policy = { ...input.policy, rules: { "claude.tool_result": "omit" } };
	const policySha = retentionDigest(policy);
	const [first, second] = input.page.coverage_entries;
	assert.ok(first && second);
	const chunk = input.chunks.get(chunkKey(input, 0));
	assert.ok(chunk && typeof chunk === "object");
	const updatedChunk = retentionChunkSchema.parse({
		...chunk,
		policy_sha256: policySha,
	});
	const updatedKey = retentionChunkKey(updatedChunk);
	input.chunks.set(updatedKey, updatedChunk);
	input.root.policy_sha256 = policySha;
	replacePage(input, {
		...input.page,
		chunk_keys: [updatedKey],
		coverage_entries: [
			{ ...first, chunk_key: updatedKey },
			{
				kind: "omitted",
				start_offset: second.start_offset,
				end_offset: second.end_offset,
				byte_count: second.byte_count,
				sha256: second.sha256,
				artifact_classes: ["claude.tool_result"],
				matched_rule: "claude.tool_result",
				reason: "owner_policy",
				locator: "event:1",
				event_type: "tool_result",
				policy_version: 1,
				policy_sha256: policySha,
				classifier_version: "v1",
			},
		],
	});
	return {
		input,
		policy,
		policySha,
		retainedBlobId: updatedChunk.blob_ref.blob_id,
	};
}

test("raw bytes round-trip independently of malformed interpretation", () => {
	const result = verifyRetentionCapture(fixture());
	assert.deepEqual(result.issues, []);
	assert.equal(result.retention_state, "complete_raw");
	assert.equal(result.accepted, true);
	assert.equal(result.interpretation_gaps, 1);
	assert.equal(result.source_verified, true);
});

test("empty source verifies the SHA-256 of empty bytes", () => {
	const input = fixture(Buffer.alloc(0));
	replacePage(input, { ...input.page, interpretation_entries: [] });
	assert.equal(verifyRetentionCapture(input).retention_state, "complete_raw");
});

test("missing and corrupt readback never pass metadata-only verification", () => {
	for (const corrupt of [false, true]) {
		const input = fixture();
		const blobId = input.blobs.keys().next().value;
		assert.ok(blobId);
		if (corrupt) input.blobs.set(blobId, Buffer.from("bad"));
		else input.blobs.delete(blobId);
		assert.equal(verifyRetentionCapture(input).retention_state, "incomplete");
	}
	const input = fixture();
	input.chunks.delete(chunkKey(input, 0));
	assert.equal(verifyRetentionCapture(input).accepted, false);
});

test("missing pages, changed contents and wrong ordered page digest fail", () => {
	const missing = fixture();
	missing.pages.clear();
	assert.equal(verifyRetentionCapture(missing).accepted, false);
	const changed = fixture();
	changed.pages.set("page-0", { ...changed.page, page_index: 1 });
	assert.equal(verifyRetentionCapture(changed).accepted, false);
	const wrongDigest = fixture();
	wrongDigest.root.pages_sha256 = "0".repeat(64);
	assert.equal(verifyRetentionCapture(wrongDigest).accepted, false);
});

test("gaps, overlaps and reversed chunks fail even with recomputed page hashes", () => {
	for (const start of [2, 4]) {
		const input = fixture();
		const [first, second] = input.page.coverage_entries;
		assert.ok(first && second);
		replacePage(input, {
			...input.page,
			coverage_entries: [
				first,
				{
					...second,
					start_offset: start,
					byte_count: second.end_offset - start,
				},
			],
		});
		assert.equal(verifyRetentionCapture(input).accepted, false);
	}
	const input = fixture();
	replacePage(input, {
		...input.page,
		chunk_keys: [...input.page.chunk_keys].reverse(),
		coverage_entries: [...input.page.coverage_entries].reverse(),
	});
	assert.equal(verifyRetentionCapture(input).accepted, false);
});

test("policy and device identity substitutions fail", () => {
	const input = fixture();
	const chunk = input.chunks.get(chunkKey(input, 0));
	assert.ok(chunk && typeof chunk === "object");
	input.chunks.set(chunkKey(input, 0), {
		...chunk,
		source_device_id: "other-device",
	});
	assert.equal(verifyRetentionCapture(input).accepted, false);
	const changedPolicy = fixture();
	changedPolicy.root.policy_sha256 = "0".repeat(64);
	assert.equal(verifyRetentionCapture(changedPolicy).accepted, false);
});

test("known failures and unknown lengths cannot become zero-byte success", () => {
	for (const unknown of [false, true]) {
		const input = fixture();
		replacePage(input, {
			...input.page,
			chunk_keys: [],
			coverage_entries: [
				{
					kind: "failed",
					start_offset: unknown ? null : 0,
					end_offset: unknown ? null : 7,
					byte_count: unknown ? null : 7,
					sha256: null,
					reason: "read_failed",
				},
			],
		});
		const result = verifyRetentionCapture(input);
		assert.equal(result.accepted, false);
		assert.equal(result.retention_state, "incomplete");
		if (unknown) assert.equal(result.unknown_extent, true);
	}
});

test("whole source digest hashes original bytes, not chunk digest strings", () => {
	const input = fixture();
	input.root.sha256 = hash(
		Buffer.from(
			input.page.coverage_entries.map((entry) => entry.sha256).join(""),
		),
	);
	assert.equal(verifyRetentionCapture(input).accepted, false);
});

test("exclusions require the exact accepted policy and cannot reconstruct missing bytes", () => {
	const input = fixture();
	const policy = { ...input.policy, rules: { "claude.tool_result": "omit" } };
	const policySha = retentionDigest(policy);
	const first = input.page.coverage_entries[0];
	const second = input.page.coverage_entries[1];
	assert.ok(first && second);
	const chunk = input.chunks.get(chunkKey(input, 0));
	assert.ok(chunk && typeof chunk === "object");
	const updatedChunk = retentionChunkSchema.parse({
		...chunk,
		policy_sha256: policySha,
	});
	const updatedKey = retentionChunkKey(updatedChunk);
	input.chunks.set(updatedKey, updatedChunk);
	input.root.policy_sha256 = policySha;
	replacePage(input, {
		...input.page,
		chunk_keys: [updatedKey],
		coverage_entries: [
			{ ...first, chunk_key: updatedKey },
			{
				kind: "omitted",
				start_offset: second.start_offset,
				end_offset: second.end_offset,
				byte_count: second.byte_count,
				sha256: second.sha256,
				artifact_classes: ["claude.tool_result"],
				matched_rule: "claude.tool_result",
				reason: "owner_policy",
				locator: "event:1",
				event_type: "tool_result",
				policy_version: 1,
				policy_sha256: policySha,
				classifier_version: "v1",
			},
		],
	});
	const result = verifyRetentionCapture({ ...input, policy });
	assert.deepEqual(result.issues, []);
	assert.equal(result.retention_state, "complete_with_exclusions");
	assert.equal(result.accepted, false);
	assert.equal(result.source_verified, true);
	const { sourceBytes: _source, ...withoutSource } = input;
	const accepted = verifyRetentionCapture({
		...withoutSource,
		policy,
		acceptPolicySha256: policySha,
	});
	assert.equal(accepted.accepted, true);
	assert.equal(accepted.source_verified, false);
	assert.equal(
		verifyRetentionCapture({
			...withoutSource,
			policy,
			acceptPolicySha256: "0".repeat(64),
		}).accepted,
		false,
	);
	const unauthorizedPolicy = {
		...policy,
		rules: { "claude.tool_result": "keep" },
	};
	assert.equal(
		verifyRetentionCapture({ ...input, policy: unauthorizedPolicy }).accepted,
		false,
	);
});

test("ordered pages reconstruct a source, while reordered roots fail even when rehashed", () => {
	const input = fixture();
	const [first, second] = input.page.coverage_entries;
	assert.ok(first && second);
	const page0 = {
		...input.page,
		chunk_keys: [first.chunk_key],
		coverage_entries: [first],
	};
	const page1 = {
		...input.page,
		page_index: 1,
		chunk_keys: [second.chunk_key],
		coverage_entries: [second],
		interpretation_entries: [],
	};
	input.pages.set("page-0", page0);
	input.pages.set("page-1", page1);
	input.root.manifest_pages = [
		{ key: "page-0", sha256: retentionDigest(page0) },
		{ key: "page-1", sha256: retentionDigest(page1) },
	];
	input.root.pages_sha256 = retentionDigest(input.root.manifest_pages);
	assert.equal(verifyRetentionCapture(input).accepted, true);
	input.root.manifest_pages.reverse();
	input.root.pages_sha256 = retentionDigest(input.root.manifest_pages);
	assert.equal(verifyRetentionCapture(input).accepted, false);
});

test("unknown source length cannot claim complete retention", () => {
	const input = fixture();
	const result = verifyRetentionCapture({
		...input,
		root: { ...input.root, end_offset: null, byte_count: null, sha256: null },
	});
	assert.equal(result.retention_state, "incomplete");
	assert.equal(result.unknown_extent, true);
});

test("arbitrary chunk keys fail even when metadata and bytes match", () => {
	const input = fixture();
	const [first, second] = input.page.coverage_entries;
	assert.ok(first && second);
	input.chunks.set("arbitrary-key", input.chunks.get(first.chunk_key));
	replacePage(input, {
		...input.page,
		chunk_keys: ["arbitrary-key", second.chunk_key],
		coverage_entries: [{ ...first, chunk_key: "arbitrary-key" }, second],
	});
	const result = verifyRetentionCapture(input);
	assert.ok(result.issues.includes("chunk_key_mismatch:arbitrary-key"));
	assert.equal(result.source_verified, false);
});

test("oversize roots and pages fail despite valid digests", () => {
	const rootInput = fixture();
	rootInput.root.source_relative_path.value = "a".repeat(262_144);
	assert.equal(verifyRetentionCapture(rootInput).accepted, false);
	const pageInput = fixture();
	replacePage(pageInput, {
		...pageInput.page,
		interpretation_entries: Array.from({ length: 6000 }, () => ({
			start_offset: 0,
			end_offset: 7,
			outcome: "malformed",
		})),
	});
	const result = verifyRetentionCapture(pageInput);
	assert.ok(result.issues.includes("record_size_exceeded:page-0"));
	assert.equal(result.accepted, false);
});

test("unknown and unclassified spans cannot be omitted through a mixed class label", () => {
	for (const requiredClass of ["unknown", "unclassified"]) {
		const input = fixture();
		const policy = { ...input.policy, rules: { images: "omit" } };
		const policySha = retentionDigest(policy);
		input.root.policy_sha256 = policySha;
		replacePage(input, {
			...input.page,
			chunk_keys: [],
			coverage_entries: [
				{
					kind: "omitted",
					start_offset: 0,
					end_offset: input.root.end_offset,
					byte_count: input.root.byte_count,
					sha256: input.root.sha256,
					artifact_classes: ["images", requiredClass],
					matched_rule: "images",
					reason: "owner_policy",
					locator: "event:1",
					event_type: "image",
					policy_version: 1,
					policy_sha256: policySha,
					classifier_version: "v1",
				},
			],
		});
		const result = verifyRetentionCapture({
			...input,
			policy,
			acceptPolicySha256: policySha,
		});
		assert.equal(result.retention_state, "incomplete");
		assert.equal(result.accepted, false);
	}
});

test("lone surrogate identifiers report incomplete instead of throwing during key hashing", () => {
	const input = fixture();
	const chunk = input.chunks.get(chunkKey(input, 0));
	assert.ok(chunk && typeof chunk === "object");
	input.chunks.set(chunkKey(input, 0), { ...chunk, source_file_id: "\ud800" });
	const result = verifyRetentionCapture(input);
	assert.equal(result.retention_state, "incomplete");
	assert.ok(
		result.issues.includes(`missing_or_invalid_chunk:${chunkKey(input, 0)}`),
	);
	const rootResult = verifyRetentionCapture({
		...input,
		root: { ...input.root, source_file_id: "\ud800" },
	});
	assert.equal(rootResult.retention_state, "incomplete");
	assert.ok(rootResult.issues.includes("invalid_root_or_policy"));
});

test("records carrying smuggled unknown keys never verify", () => {
	// Unknown keys are not inert: they travel inside the durable record and feed the
	// canonical digest, so a verifier that tolerated them would accept a record that
	// is not the one whose key was derived.
	const chunkInput = fixture();
	const key = chunkKey(chunkInput, 0);
	const chunk = chunkInput.chunks.get(key);
	assert.ok(chunk && typeof chunk === "object");
	chunkInput.chunks.set(key, { ...chunk, smuggled: "payload" });
	const chunkResult = verifyRetentionCapture(chunkInput);
	assert.equal(chunkResult.accepted, false);
	assert.ok(
		chunkResult.issues.includes(`missing_or_invalid_chunk:${key}`),
		`expected missing_or_invalid_chunk, got ${JSON.stringify(chunkResult.issues)}`,
	);

	const rootInput = fixture();
	const rootResult = verifyRetentionCapture({
		...rootInput,
		root: { ...rootInput.root, smuggled: "payload" },
	});
	assert.equal(rootResult.accepted, false);
	assert.ok(
		rootResult.issues.includes("invalid_root_or_policy"),
		`expected invalid_root_or_policy, got ${JSON.stringify(rootResult.issues)}`,
	);

	const pageInput = fixture();
	replacePage(pageInput, { ...pageInput.page, smuggled: "payload" });
	const pageResult = verifyRetentionCapture(pageInput);
	assert.equal(pageResult.accepted, false);
	assert.ok(
		pageResult.issues.includes("missing_or_invalid_page:page-0"),
		`expected missing_or_invalid_page, got ${JSON.stringify(pageResult.issues)}`,
	);
});

test("roots omitting session identity keys never verify", () => {
	for (const key of ["session_id", "parent_session_id", "identity_basis"]) {
		const input = fixture();
		const { [key]: _dropped, ...root } = input.root as Record<string, unknown>;
		const result = verifyRetentionCapture({ ...input, root });
		assert.equal(result.accepted, false, `root without ${key} must not verify`);
		assert.ok(
			result.issues.includes("invalid_root_or_policy"),
			`expected invalid_root_or_policy for missing ${key}, got ${JSON.stringify(result.issues)}`,
		);
	}
});

test("durable readback of an exclusion capture rejects corrupt retained blob bytes", () => {
	const { input, policy, policySha, retainedBlobId } = exclusionFixture();
	const { sourceBytes: _source, ...withoutSource } = input;
	const clean = verifyRetentionCapture({
		...withoutSource,
		policy,
		acceptPolicySha256: policySha,
	});
	assert.deepEqual(clean.issues, []);
	assert.equal(clean.retention_state, "complete_with_exclusions");
	assert.equal(clean.accepted, true);
	assert.ok(clean.omitted_bytes > 0);

	const original = withoutSource.blobs.get(retainedBlobId);
	assert.ok(original);
	const corrupt = Uint8Array.from(original);
	const firstByte = corrupt[0];
	assert.ok(firstByte !== undefined);
	corrupt[0] = firstByte ^ 0xff;
	withoutSource.blobs.set(retainedBlobId, corrupt);
	const flipped = verifyRetentionCapture({
		...withoutSource,
		policy,
		acceptPolicySha256: policySha,
	});
	assert.equal(
		flipped.accepted,
		false,
		"same-length corrupt blob bytes must not be accepted",
	);
	assert.equal(flipped.retention_state, "incomplete");
	assert.ok(
		flipped.issues.some((issue) =>
			issue.startsWith("blob_integrity_mismatch:"),
		),
		`expected blob_integrity_mismatch, got ${JSON.stringify(flipped.issues)}`,
	);

	withoutSource.blobs.set(retainedBlobId, Uint8Array.from([...original, 0]));
	const lengthened = verifyRetentionCapture({
		...withoutSource,
		policy,
		acceptPolicySha256: policySha,
	});
	assert.equal(
		lengthened.accepted,
		false,
		"blob bytes of the wrong length must not be accepted",
	);
	assert.ok(
		lengthened.issues.some((issue) =>
			issue.startsWith("blob_integrity_mismatch:"),
		),
		`expected blob_integrity_mismatch, got ${JSON.stringify(lengthened.issues)}`,
	);
});

test("exclusion captures verified against frozen bytes also reject corrupt blobs", () => {
	const { input, policy, policySha, retainedBlobId } = exclusionFixture();
	const original = input.blobs.get(retainedBlobId);
	assert.ok(original);
	const corrupt = Uint8Array.from(original);
	const firstByte = corrupt[0];
	assert.ok(firstByte !== undefined);
	corrupt[0] = firstByte ^ 0xff;
	input.blobs.set(retainedBlobId, corrupt);
	const result = verifyRetentionCapture({
		...input,
		policy,
		acceptPolicySha256: policySha,
	});
	assert.equal(result.accepted, false);
	assert.equal(result.source_verified, false);
	assert.ok(
		result.issues.some((issue) => issue.startsWith("blob_integrity_mismatch:")),
		`expected blob_integrity_mismatch, got ${JSON.stringify(result.issues)}`,
	);
});
