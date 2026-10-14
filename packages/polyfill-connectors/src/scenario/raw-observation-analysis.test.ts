// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	analyzeRawObservations,
	type RawObservationRecord,
	type RawObservationRun,
	type RawObservationStreamMetadata,
} from "./raw-observation-analysis.ts";

const metadata: RawObservationStreamMetadata[] = [
	{
		name: "items",
		primaryKey: ["id"],
		safeFieldPaths: ["id", "clock", "business", "nested", "nested.value"],
		excludedFields: ["clock"],
	},
];

function record(
	identity: unknown,
	data: unknown,
	stream = "items",
): RawObservationRecord {
	return { data, identity, stream };
}

function run(
	runNumber: number,
	records: readonly RawObservationRecord[],
	scopeKey = "items",
): RawObservationRun {
	return { records, run: runNumber, scopeKey };
}

test("raw excluded and nested declared differences stay separate from projected changes", () => {
	const summary = analyzeRawObservations(
		[
			run(1, [
				record("id-1", { id: "id-1", clock: "before", nested: { value: 1 } }),
			]),
			run(2, [
				record("id-1", { id: "id-1", clock: "after", nested: { value: 2 } }),
			]),
		],
		metadata,
	);

	assert.equal(summary.streams[0]?.status, "differences-observed");
	assert.deepEqual(summary.streams[0]?.rawChangedFields, [
		{ field: "clock", identities: 1 },
		{ field: "nested.value", identities: 1 },
	]);
	assert.deepEqual(summary.streams[0]?.projectedChangedFields, [
		{ field: "nested.value", identities: 1 },
	]);

	const declaredMetadata = metadata[0];
	assert.ok(declaredMetadata);
	const nestedExclusion = analyzeRawObservations(
		[
			run(1, [record("id-1", { id: "id-1", nested: { value: 1 } })]),
			run(2, [record("id-1", { id: "id-1", nested: { value: 2 } })]),
		],
		[
			{
				...declaredMetadata,
				excludedFields: ["nested.value"],
			},
		],
	);
	assert.deepEqual(nestedExclusion.streams[0]?.projectedChangedFields, [
		{ field: "nested.value", identities: 1 },
	]);
});

test("object key order is semantic-neutral while array order and missing-vs-null remain visible", () => {
	const identical = analyzeRawObservations(
		[
			run(1, [record("same", { id: "same", business: { a: 1, b: 2 } })]),
			run(2, [record("same", { business: { b: 2, a: 1 }, id: "same" })]),
		],
		metadata,
	);
	assert.equal(
		identical.streams[0]?.status,
		"no-differences-observed-in-this-capture",
	);

	const changed = analyzeRawObservations(
		[
			run(1, [record("same", { id: "same", business: [1, 2] })]),
			run(2, [record("same", { id: "same", business: [2, 1] })]),
		],
		metadata,
	);
	assert.deepEqual(changed.streams[0]?.rawChangedFields, [
		{ field: "business", identities: 1 },
	]);

	const missingVsNull = analyzeRawObservations(
		[
			run(1, [record("same", { id: "same" })]),
			run(2, [record("same", { id: "same", business: null })]),
		],
		metadata,
	);
	assert.deepEqual(missingVsNull.streams[0]?.rawChangedFields, [
		{ field: "business", identities: 1 },
	]);
});

test("typed identities, stream names, scopes, and same-run repeats remain isolated", () => {
	const summary = analyzeRawObservations(
		[
			run(1, [
				record(1, { id: "number", business: "one" }),
				record(1, { id: "duplicate", business: "ignored" }),
				record("1", { id: "string", business: "two" }),
				record(
					"other-stream",
					{ id: "other", business: "left" },
					"private-stream-name",
				),
			]),
			run(2, [
				record(1, { id: "number", business: "one" }),
				record(1, { id: "duplicate-run-two", business: "changed" }),
				record("1", { id: "string", business: "two" }),
				record(
					"other-stream",
					{ id: "other", business: "right" },
					"private-stream-name",
				),
			]),
		],
		metadata,
	);

	const itemSummary = summary.streams.find((entry) => entry.stream === "items");
	const unknownSummary = summary.streams.find(
		(entry) => entry.stream === "(undeclared stream)",
	);
	assert.equal(itemSummary?.comparedIdentities, 2);
	assert.equal(itemSummary?.status, "no-differences-observed-in-this-capture");
	assert.equal(unknownSummary?.status, "differences-observed");
	assert.equal(JSON.stringify(summary).includes("private-stream-name"), false);

	const differentScope = analyzeRawObservations(
		[
			run(1, [record("scoped", { id: "scoped", business: "left" })]),
			run(
				2,
				[record("scoped", { id: "scoped", business: "right" })],
				"different-selection",
			),
		],
		metadata,
	);
	assert.equal(
		differentScope.streams[0]?.status,
		"insufficient-repeat-observations",
	);
	assert.ok(
		differentScope.limitations.some((line) =>
			line.includes("scope or selection context"),
		),
	);
});

test("schema primary-key identity preserves number and string types", () => {
	const summary = analyzeRawObservations(
		[
			run(1, [
				{
					data: { id: 1, business: "number" },
					id: "wire-key",
					stream: "items",
				},
			]),
			run(2, [
				{
					data: { id: "1", business: "string" },
					id: "wire-key",
					stream: "items",
				},
			]),
		],
		metadata,
	);
	assert.equal(summary.streams[0]?.comparedIdentities, 0);
	assert.equal(summary.streams[0]?.status, "insufficient-repeat-observations");
});

test("declared compound keys retain every typed component and oversized keys are skipped", () => {
	const compound = analyzeRawObservations(
		[
			run(1, [
				{
					data: { account: 7, item: "1", business: "old" },
					id: "wire",
					stream: "items",
				},
			]),
			run(2, [
				{
					data: { account: 7, item: "1", business: "new" },
					id: "wire",
					stream: "items",
				},
			]),
		],
		[
			{
				name: "items",
				primaryKey: ["account", "item"],
				safeFieldPaths: ["account", "item", "business"],
			},
		],
	);
	assert.equal(compound.streams[0]?.comparedIdentities, 1);
	assert.deepEqual(compound.streams[0]?.rawChangedFields, [
		{ field: "business", identities: 1 },
	]);

	const oversized = analyzeRawObservations(
		[
			run(1, [record("x".repeat(5000), { business: "old" })]),
			run(2, [record("x".repeat(5000), { business: "new" })]),
		],
		[{ name: "items", safeFieldPaths: ["business"] }],
	);
	assert.equal(
		oversized.streams[0]?.status,
		"insufficient-repeat-observations",
	);
	assert.equal(oversized.oversizedIdentityRecords, 2);
	assert.ok(
		oversized.limitations.some((line) => line.includes("serialization limit")),
	);
	assert.equal(JSON.stringify(oversized).includes("x".repeat(100)), false);
});

test("no cross-run pairs and empty streams are explicitly insufficient", () => {
	const summary = analyzeRawObservations(
		[
			run(1, [
				record("same", { id: "same", business: "first" }),
				record("same", { id: "same", business: "duplicate" }),
			]),
		],
		metadata,
	);
	assert.equal(summary.streams[0]?.comparedIdentities, 0);
	assert.equal(summary.streams[0]?.status, "insufficient-repeat-observations");

	const empty = analyzeRawObservations([run(1, []), run(2, [])], metadata);
	assert.equal(empty.streams[0]?.status, "insufficient-repeat-observations");
});

test("identity limit is disclosed and values, identities, and dynamic keys stay private", () => {
	const canaryValue = "PRIVATE_VALUE_CANARY";
	const canaryIdentity = "PRIVATE_ID_CANARY";
	const canaryKey = "dynamic_PRIVATE_KEY_CANARY";
	const summary = analyzeRawObservations(
		[
			run(1, [
				record(canaryIdentity, {
					id: canaryIdentity,
					business: canaryValue,
					[canaryKey]: "old",
				}),
				record("second", { id: "second", business: "value" }),
			]),
			run(2, [
				record(canaryIdentity, {
					id: canaryIdentity,
					business: canaryValue,
					[canaryKey]: "new",
				}),
				record("second", { id: "second", business: "changed" }),
			]),
		],
		metadata,
		1,
	);
	const publicJson = JSON.stringify(summary);
	assert.equal(summary.truncated, true);
	assert.ok(summary.limitations.some((line) => line.includes("limit of 1")));
	assert.equal(summary.streams[0]?.rawUnnamedFieldIdentities, 1);
	assert.equal(summary.streams[0]?.rawChangedFields.length, 0);
	assert.equal(publicJson.includes(canaryValue), false);
	assert.equal(publicJson.includes(canaryIdentity), false);
	assert.equal(publicJson.includes(canaryKey), false);
});

test("sampling gives later declared streams a bounded share of the identity budget", () => {
	const streams: RawObservationStreamMetadata[] = [
		{ name: "large", primaryKey: ["id"], safeFieldPaths: ["id", "value"] },
		{ name: "items", primaryKey: ["id"], safeFieldPaths: ["id", "created_at"] },
	];
	const records = (count: number, stream: string, value: string) =>
		Array.from({ length: count }, (_, index) => ({
			data: {
				id: `${stream}-${index}`,
				[stream === "items" ? "created_at" : "value"]: value,
			},
			identity: `${stream}-${index}`,
			stream,
		}));
	const summary = analyzeRawObservations(
		[
			run(1, [...records(300, "large", "same"), ...records(4, "items", "old")]),
			run(2, [...records(300, "large", "same"), ...records(4, "items", "new")]),
		],
		streams,
		4,
	);
	const items = summary.streams.find((entry) => entry.stream === "items");
	assert.equal(items?.status, "differences-observed");
	assert.deepEqual(items?.rawChangedFields, [
		{ field: "created_at", identities: 2 },
	]);
	assert.equal(items?.sampleLimit, 2);
	assert.ok(summary.truncated);
});

test("unknown streams share one bounded generic bucket without exposing their names", () => {
	const unknownRecords = (runNumber: number) =>
		Array.from({ length: 20 }, (_, index) => ({
			data: { value: `${runNumber}-${index}` },
			id: `unknown-${index}`,
			stream: `private_stream_${index}`,
		}));
	const summary = analyzeRawObservations(
		[run(1, unknownRecords(1)), run(2, unknownRecords(2))],
		metadata,
		10,
	);
	const generic = summary.streams.find(
		(entry) => entry.stream === "(undeclared stream)",
	);
	assert.equal(summary.unknownStreamSampleLimit, 2);
	assert.equal(generic?.sampledIdentities, 2);
	assert.equal(generic?.truncated, true);
	assert.equal(summary.streams.length, metadata.length + 1);
	assert.equal(JSON.stringify(summary).includes("private_stream_"), false);
});

test("missing identity records are skipped instead of pairing canonical undefined", () => {
	const summary = analyzeRawObservations(
		[
			run(1, [{ data: { business: "first" }, stream: "items" }]),
			run(2, [{ data: { business: "second" }, stream: "items" }]),
		],
		[{ name: "items", safeFieldPaths: ["business"] }],
	);
	assert.equal(summary.streams[0]?.status, "insufficient-repeat-observations");
	assert.equal(summary.streams[0]?.comparedIdentities, 0);
	assert.ok(
		summary.limitations.some((line) => line.includes("missing identity")),
	);
});

test("typed wire keys keep an array key distinct from a scalar string with the same text", () => {
	const summary = analyzeRawObservations(
		[
			run(1, [
				{
					data: { business: "left" },
					id: '["x"]',
					stream: "items",
					wireKey: ["x"],
				},
			]),
			run(2, [
				{
					data: { business: "right" },
					id: '["x"]',
					stream: "items",
					wireKey: '["x"]',
				},
			]),
		],
		[{ name: "items", safeFieldPaths: ["business"] }],
	);
	assert.equal(summary.streams[0]?.comparedIdentities, 0);
	assert.equal(summary.streams[0]?.status, "insufficient-repeat-observations");

	const sameKey = analyzeRawObservations(
		[
			run(1, [
				{
					data: { business: "left" },
					id: '["x"]',
					stream: "items",
					wireKey: ["x"],
				},
			]),
			run(2, [
				{
					data: { business: "right" },
					id: '["x"]',
					stream: "items",
					wireKey: ["x"],
				},
			]),
		],
		[{ name: "items", safeFieldPaths: ["business"] }],
	);
	assert.equal(sameKey.streams[0]?.comparedIdentities, 1);
	assert.deepEqual(sameKey.streams[0]?.rawChangedFields, [
		{ field: "business", identities: 1 },
	]);
});

test("limitations state the first-observation rule and what raw means without claiming payload bounds", () => {
	const text = analyzeRawObservations([], metadata).limitations.join("\n");
	assert.match(text, /first observation of each identity in a run/i);
	assert.match(text, /wire RECORD\.data before comparison exclusions/);
	assert.match(text, /not the provider's pre-normalization/);
	assert.match(text, /does not bound total payload size/);
});

test("schema paths that were bounded at collection time are disclosed", () => {
	const summary = analyzeRawObservations(
		[],
		[{ name: "items", safeFieldPaths: ["a"], schemaPathsBounded: true }],
	);
	assert.ok(
		summary.limitations.some((line) =>
			line.includes("Schema field metadata was bounded"),
		),
	);
});
