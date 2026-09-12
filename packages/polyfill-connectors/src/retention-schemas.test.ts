// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	assertRetentionRecordSize,
	canonicalJson,
	DEFAULT_RETENTION_POLICY,
	RETENTION_MAX_RECORD_BYTES,
	retentionChunkKey,
	retentionChunkSchema,
	retentionCoverageEntrySchema,
	retentionDigest,
	retentionManifestPageSchema,
	retentionManifestRootSchema,
	retentionObservationSchema,
	retentionPolicySchema,
	retentionReceiptSchema,
	retentionTupleKey,
} from "./retention-schemas.ts";

const digest = "a".repeat(64);
const provenance = {
	format_version: 1,
	classifier_version: "v1",
	connector_id: "codex",
	connector_instance_id: "instance",
	source_device_id: "device",
	source_root_id: "sessions",
	source_file_id: "file",
	generation_id: "generation",
	policy_version: 1,
	policy_sha256: retentionDigest(DEFAULT_RETENTION_POLICY),
};
const root = {
	...provenance,
	capture_id: "capture",
	source_relative_path: { encoding: "utf8", value: "session.jsonl" },
	session_id: null,
	parent_session_id: null,
	identity_basis: "unresolved",
	source_view: "snapshot",
	start_offset: 0,
	end_offset: 0,
	byte_count: 0,
	sha256: createHash("sha256").digest("hex"),
	previous_capture_id: null,
	manifest_pages: [],
	pages_sha256: retentionDigest([]),
};

test("v1 keep-all policy has a frozen canonical encoding and digest", () => {
	assert.deepEqual(
		retentionPolicySchema.parse(DEFAULT_RETENTION_POLICY),
		DEFAULT_RETENTION_POLICY,
	);
	assert.equal(
		canonicalJson(DEFAULT_RETENTION_POLICY),
		'{"default":"keep","format_version":1,"policy_version":1,"rules":{},"unclassified":"keep"}',
	);
	assert.equal(
		retentionDigest(DEFAULT_RETENTION_POLICY),
		"08b990cf1f014f5d20be4a33c720d7d6bfb9463c2f9232298079cdfe58af1fb0",
	);
	assert.equal(
		retentionPolicySchema.safeParse({
			...DEFAULT_RETENTION_POLICY,
			rules: { images: "omit" },
		}).success,
		true,
	);
	for (const override of [
		{ default: "omit" },
		{ strict: true },
		{ rules: { unknown: "omit" } },
		{ rules: { images: { omit_if_bytes_gt: 1 } } },
	]) {
		assert.equal(
			retentionPolicySchema.safeParse({
				...DEFAULT_RETENTION_POLICY,
				...override,
			}).success,
			false,
		);
	}
});

test("v1 root, page, chunk and receipt fixtures round-trip without defaults", () => {
	assert.deepEqual(retentionManifestRootSchema.parse(root), root);
	const page = {
		format_version: 1,
		capture_id: "capture",
		page_index: 0,
		chunk_keys: [],
		coverage_entries: [],
		artifact_links: [],
		class_statistics: [],
		interpretation_entries: [],
	};
	assert.deepEqual(retentionManifestPageSchema.parse(page), page);
	const chunk = {
		...provenance,
		start_offset: 0,
		end_offset: 1,
		byte_count: 1,
		sha256: digest,
		blob_ref: {
			blob_id: `blob_sha256_${digest}`,
			sha256: digest,
			size_bytes: 1,
			mime_type: "application/octet-stream",
		},
	};
	assert.deepEqual(retentionChunkSchema.parse(chunk), chunk);
	const receipt = {
		format_version: 1,
		capture_id: "capture",
		verifier_version: "v1",
		retention_state: "complete_raw",
		projection_state: "incomplete",
		policy_sha256: provenance.policy_sha256,
		result_sha256: digest,
	};
	assert.deepEqual(retentionReceiptSchema.parse(receipt), receipt);
	const observation = {
		format_version: 1,
		capture_id: "capture",
		observed_at: "2026-09-09T00:00:00.000Z",
		source_relative_path: { encoding: "utf8", value: "moved/session.jsonl" },
		identity_certainty: "uncertain",
		identity_basis: "enrollment reconnect unresolved",
		session_id: null,
		parent_session_id: null,
	};
	assert.deepEqual(retentionObservationSchema.parse(observation), observation);
	assert.equal(
		retentionObservationSchema.safeParse({
			...observation,
			observed_at: "yesterday",
		}).success,
		false,
	);

	assert.equal(
		retentionManifestRootSchema.safeParse({
			...root,
			retention_state: "complete_raw",
		}).success,
		false,
	);
	assert.equal(
		retentionChunkSchema.safeParse({ ...chunk, byte_count: 2 }).success,
		false,
	);
	assert.equal(
		retentionManifestRootSchema.safeParse({ ...root, format_version: 2 })
			.success,
		false,
	);
	assert.notEqual(
		retentionChunkKey(retentionChunkSchema.parse(chunk)),
		retentionChunkKey(
			retentionChunkSchema.parse({ ...chunk, source_device_id: "other" }),
		),
	);
});

test("required root and chunk keys cannot be dropped or padded with unknown keys", () => {
	const chunk = {
		...provenance,
		start_offset: 0,
		end_offset: 1,
		byte_count: 1,
		sha256: digest,
		blob_ref: {
			blob_id: `blob_sha256_${digest}`,
			sha256: digest,
			size_bytes: 1,
			mime_type: "application/octet-stream",
		},
	};
	assert.equal(retentionChunkSchema.safeParse(chunk).success, true);
	assert.equal(retentionManifestRootSchema.safeParse(root).success, true);

	// Presence is load-bearing: an absent key must never be treated as "unconstrained".
	for (const key of ["blob_id", "sha256", "size_bytes", "mime_type"]) {
		const { [key]: _dropped, ...blob_ref } = chunk.blob_ref as Record<
			string,
			unknown
		>;
		assert.equal(
			retentionChunkSchema.safeParse({ ...chunk, blob_ref }).success,
			false,
			`chunk blob_ref must require ${key}`,
		);
	}
	for (const key of [
		"start_offset",
		"end_offset",
		"byte_count",
		"sha256",
		"blob_ref",
	]) {
		const { [key]: _dropped, ...rest } = chunk as Record<string, unknown>;
		assert.equal(
			retentionChunkSchema.safeParse(rest).success,
			false,
			`chunk must require ${key}`,
		);
	}
	for (const key of [
		"session_id",
		"parent_session_id",
		"identity_basis",
		"capture_id",
		"source_relative_path",
		"source_view",
		"start_offset",
		"end_offset",
		"byte_count",
		"sha256",
		"previous_capture_id",
		"manifest_pages",
		"pages_sha256",
	]) {
		const { [key]: _dropped, ...rest } = root as Record<string, unknown>;
		assert.equal(
			retentionManifestRootSchema.safeParse(rest).success,
			false,
			`root must require ${key}`,
		);
	}

	// Strictness is load-bearing: unknown keys change a record's digest, so they must
	// never ride along silently inside an identity-bearing structure.
	assert.equal(
		retentionChunkSchema.safeParse({ ...chunk, smuggled: "x" }).success,
		false,
		"chunk must reject unknown keys",
	);
	assert.equal(
		retentionChunkSchema.safeParse({
			...chunk,
			blob_ref: { ...chunk.blob_ref, smuggled: "x" },
		}).success,
		false,
		"chunk blob_ref must reject unknown keys",
	);
	assert.equal(
		retentionManifestRootSchema.safeParse({ ...root, smuggled: "x" }).success,
		false,
		"root must reject unknown keys",
	);
	assert.equal(
		retentionManifestRootSchema.safeParse({
			...root,
			source_relative_path: { ...root.source_relative_path, smuggled: "x" },
		}).success,
		false,
		"root source_relative_path must reject unknown keys",
	);
	assert.equal(
		retentionManifestRootSchema.safeParse({
			...root,
			manifest_pages: [{ key: "page-0", sha256: digest, smuggled: "x" }],
		}).success,
		false,
		"root manifest_pages entries must reject unknown keys",
	);
	assert.equal(
		retentionPolicySchema.safeParse({
			...DEFAULT_RETENTION_POLICY,
			smuggled: "x",
		}).success,
		false,
		"policy must reject unknown keys",
	);
	assert.equal(
		retentionObservationSchema.safeParse({
			format_version: 1,
			capture_id: "capture",
			observed_at: "2026-09-09T00:00:00.000Z",
			source_relative_path: { encoding: "utf8", value: "session.jsonl" },
			identity_certainty: "uncertain",
			identity_basis: "unresolved",
			session_id: null,
			parent_session_id: null,
			smuggled: "x",
		}).success,
		false,
		"observation must reject unknown keys",
	);
});

test("null session identity is a stated value, not an omitted key", () => {
	// `session_id: null` means "no session established"; a missing key would let a
	// manifest claim nothing at all about identity while still validating.
	for (const key of ["session_id", "parent_session_id", "identity_basis"]) {
		const { [key]: dropped, ...rest } = root as Record<string, unknown>;
		assert.notEqual(
			dropped,
			undefined,
			`${key} must be present in the fixture`,
		);
		const parsedWithKey = retentionManifestRootSchema.safeParse(root);
		assert.equal(parsedWithKey.success, true);
		assert.equal(
			retentionManifestRootSchema.safeParse(rest).success,
			false,
			`root must require ${key} to be stated explicitly`,
		);
		assert.equal(
			retentionManifestRootSchema.safeParse({ ...rest, [key]: undefined })
				.success,
			false,
			`root must reject an undefined ${key}`,
		);
	}
	// The root fixture's identity digest must change when identity fields change,
	// which is only meaningful while those fields are required.
	assert.notEqual(
		retentionDigest(retentionManifestRootSchema.parse(root)),
		retentionDigest(
			retentionManifestRootSchema.parse({ ...root, session_id: "session" }),
		),
	);
});

test("coverage preserves unknown failure extent and rejects reversed or inconsistent spans", () => {
	const failure = {
		kind: "failed",
		start_offset: null,
		end_offset: null,
		byte_count: null,
		sha256: null,
		reason: "source_unavailable_before_capture",
	};
	assert.deepEqual(retentionCoverageEntrySchema.parse(failure), failure);
	const retained = {
		kind: "retained",
		start_offset: 0,
		end_offset: 2,
		byte_count: 2,
		sha256: digest,
		chunk_key: "key",
	};
	assert.equal(retentionCoverageEntrySchema.safeParse(retained).success, true);
	assert.equal(
		retentionCoverageEntrySchema.safeParse({ ...retained, end_offset: 0 })
			.success,
		false,
	);
	assert.equal(
		retentionCoverageEntrySchema.safeParse({ ...retained, byte_count: 1 })
			.success,
		false,
	);
	assert.equal(
		retentionCoverageEntrySchema.safeParse({
			...retained,
			end_offset: Number.MAX_SAFE_INTEGER + 1,
		}).success,
		false,
	);
});

test("canonical JSON rejects silent coercion and preserves object ordering contract", () => {
	assert.equal(canonicalJson({ z: [2, 1], a: "é" }), '{"a":"é","z":[2,1]}');
	assert.equal(
		retentionDigest({ a: 1, b: 2 }),
		retentionDigest({ b: 2, a: 1 }),
	);
	for (const value of [
		undefined,
		NaN,
		Infinity,
		new Date(),
		{ a: undefined },
		[undefined],
	])
		assert.throws(() => canonicalJson(value), TypeError);
});

test("length-prefixed tuple keys distinguish delimiters, empty members and UTF-8", () => {
	assert.notEqual(
		retentionTupleKey(["a:b", "c"]),
		retentionTupleKey(["a", "b:c"]),
	);
	assert.notEqual(retentionTupleKey(["a", ""]), retentionTupleKey(["a"]));
	assert.throws(() => retentionTupleKey(["\ud800"]), TypeError);
	assert.throws(() => retentionTupleKey(["\ud801"]), TypeError);
	assert.equal(
		retentionTupleKey(["é", "a:b", ""]),
		"95c5509d3f757b7585ca4dd57d347ced2423038fdd24b6b1543d9a8d15321204",
	);
});

test("256 KiB limit counts UTF-8 bytes, RECORD fields, timestamp and newline", () => {
	const emittedAt = "2000-01-01T00:00:00.000Z";
	const overhead = Buffer.byteLength(
		`${JSON.stringify({ type: "RECORD", stream: "s", key: "k", data: "", emitted_at: emittedAt })}\n`,
	);
	const exact = "x".repeat(RETENTION_MAX_RECORD_BYTES - overhead);
	assert.doesNotThrow(() => assertRetentionRecordSize("s", "k", exact));
	assert.throws(
		() => assertRetentionRecordSize("s", "k", `${exact}x`),
		RangeError,
	);
	assert.throws(
		() => assertRetentionRecordSize("s", "k", "é".repeat(exact.length)),
		RangeError,
	);
	assert.throws(
		() => assertRetentionRecordSize("s", "longer-key", exact),
		RangeError,
	);
});

test("encoded paths preserve binary bytes and reject malformed base64", () => {
	const binaryPath = {
		encoding: "base64",
		value: Buffer.from([255, 128, 47, 97]).toString("base64"),
	};
	assert.deepEqual(
		retentionManifestRootSchema.parse({
			...root,
			source_relative_path: binaryPath,
		}).source_relative_path,
		binaryPath,
	);
	for (const value of ["!!!", "", "YQ", "YQ==\n", "YR=="]) {
		assert.equal(
			retentionManifestRootSchema.safeParse({
				...root,
				source_relative_path: { encoding: "base64", value },
			}).success,
			false,
		);
	}
	assert.equal(
		retentionManifestRootSchema.safeParse({
			...root,
			source_relative_path: { encoding: "hex", value: "ff" },
		}).success,
		false,
	);
});
