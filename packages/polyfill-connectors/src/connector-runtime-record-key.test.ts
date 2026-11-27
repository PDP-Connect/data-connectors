// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage, StreamScope } from "@pdpp/connector-protocol";
import { makeEmitRecord } from "./connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "./test-harness.ts";

const RANKING_KEY_FIELDS = { rankings: ["id", "time_range"] } as const;

function gate(options: {
	recordKeyFields?: Readonly<Record<string, readonly string[]>>;
	resources?: string[];
	isTombstone?: () => boolean;
}) {
	const messages: EmittedMessage[] = [];
	const scope: StreamScope = { name: "rankings" };
	if (options.resources) scope.resources = options.resources;
	const emitRecord = makeEmitRecord({
		requested: new Map([
			["rankings", scope],
			["profile", { name: "profile" }],
		]),
		emit: async (message) => {
			messages.push(message);
		},
		emittedAt: "2026-11-12T00:00:00.000Z",
		validateRecord: undefined,
		isTombstone: options.isTombstone,
		timeRangeFieldFor: () => null,
		recordKeyFields: options.recordKeyFields,
	});
	return { emitRecord, messages };
}

const keyOf = (message: EmittedMessage | undefined): unknown =>
	(message as { key?: unknown } | undefined)?.key;

// A Personal Server rejects a record whose key disagrees with its data's
// primary-key fields (Collection Profile "RECORD"). Keyed by `id` alone, the
// short_term and long_term rows of one artist also collapse into one record.
test("a composite primary key is emitted as the array of its components", async () => {
	const { emitRecord, messages } = gate({
		recordKeyFields: RANKING_KEY_FIELDS,
	});
	await emitRecord.emit("rankings", {
		id: "artist-1",
		time_range: "short_term",
	});
	await emitRecord.emit("rankings", {
		id: "artist-1",
		time_range: "long_term",
	});
	assert.deepEqual(messages.map(keyOf), [
		["artist-1", "short_term"],
		["artist-1", "long_term"],
	]);
	assert.equal(emitRecord.counters.totalEmitted, 2);
});

test("a stream without declared key fields keeps the id key", async () => {
	const { emitRecord, messages } = gate({
		recordKeyFields: RANKING_KEY_FIELDS,
	});
	await emitRecord.emit("profile", { id: 42, name: "x" });
	assert.deepEqual(messages.map(keyOf), ["42"]);
});

test("number and boolean key components are emitted as strings", async () => {
	const { emitRecord, messages } = gate({
		recordKeyFields: { rankings: ["post_id", "ordinal"] },
	});
	await emitRecord.emit("rankings", { id: "liker", post_id: "p1", ordinal: 0 });
	assert.deepEqual(messages.map(keyOf), [["p1", "0"]]);
});

test("a record missing a key component is not emitted", async () => {
	const { emitRecord, messages } = gate({
		recordKeyFields: RANKING_KEY_FIELDS,
	});
	await emitRecord.emit("rankings", { id: "artist-1" });
	await emitRecord.emit("rankings", { id: "artist-1", time_range: null });
	assert.equal(messages.length, 0);
	assert.equal(emitRecord.counters.totalEmitted, 0);
});

test("resources select a composite record by its canonical key", async () => {
	const { emitRecord, messages } = gate({
		recordKeyFields: RANKING_KEY_FIELDS,
		resources: ['["artist-1","long_term"]'],
	});
	await emitRecord.emit("rankings", {
		id: "artist-1",
		time_range: "short_term",
	});
	await emitRecord.emit("rankings", {
		id: "artist-1",
		time_range: "long_term",
	});
	assert.deepEqual(messages.map(keyOf), [["artist-1", "long_term"]]);
});

test("a composite tombstone carries every key field", async () => {
	const { emitRecord, messages } = gate({
		recordKeyFields: RANKING_KEY_FIELDS,
		isTombstone: () => true,
	});
	await emitRecord.emit("rankings", {
		id: "artist-1",
		time_range: "short_term",
		name: "dropped",
	});
	assert.deepEqual(messages, [
		{
			type: "RECORD",
			stream: "rankings",
			key: ["artist-1", "short_term"],
			data: { id: "artist-1", time_range: "short_term" },
			emitted_at: "2026-11-12T00:00:00.000Z",
			op: "delete",
		},
	]);
});

test("empty key fields are refused", () => {
	assert.throws(
		() => gate({ recordKeyFields: { rankings: [] } }),
		/recordKeyFields\.rankings/,
	);
	assert.throws(
		() => gate({ recordKeyFields: { rankings: ["id", ""] } }),
		/recordKeyFields\.rankings/,
	);
});

test("runConnector passes recordKeyFields to the records it emits", async () => {
	const result = await runConnectorProtocolSubprocess({
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		entrypoint: fileURLToPath(
			new URL(
				"./test-fixtures/protocol-subprocess-composite-key.ts",
				import.meta.url,
			),
		),
		start: { type: "START", scope: { streams: [{ name: "rankings" }] } },
	});
	const records = result.messages.filter(
		(message) => message.type === "RECORD",
	);
	assert.deepEqual(records.map(keyOf), [
		["artist-1", "short_term"],
		["artist-1", "long_term"],
	]);
	const done = result.messages.findLast((message) => message.type === "DONE");
	assert.equal(
		(done as { records_emitted?: number } | undefined)?.records_emitted,
		2,
	);
});
