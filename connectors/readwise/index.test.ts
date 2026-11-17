// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeEmitRecord } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { createExportReader } from "./api.ts";
import { collectReadwise } from "./index.ts";
import { validateRecord } from "./schemas.ts";

function fixtureContext(state: Record<string, unknown> = {}) {
	const recording = makeRecordingEmit(validateRecord);
	return {
		...recording,
		credentials: { READWISE_ACCESS_TOKEN: "fixture-token" },
		collectionMode: "incremental" as const,
		emittedAt: "2026-11-06T00:00:00.000Z",
		requested: new Map([
			["books", { name: "books" }],
			["highlights", { name: "highlights" }],
		]),
		state,
		progress: async () => {},
	};
}

test("adding highlights backfills history and still emits book deletions", async () => {
	const ctx = fixtureContext({
		books: { updated_after: "2026-11-05T00:00:00.000Z" },
	});
	const emitter = makeEmitRecord({
		requested: ctx.requested,
		emit: ctx.emit,
		emittedAt: ctx.emittedAt,
		validateRecord,
		isTombstone: (_stream, data) => data.is_deleted === true,
		timeRangeFieldFor: () => null,
	});
	const read = createExportReader(async (input) => {
		const { searchParams } = new URL(String(input));
		const includesHistory = !searchParams.has("updatedAfter");
		const includesDeleted = searchParams.get("includeDeleted") === "true";
		return Response.json({
			nextPageCursor: null,
			results: [
				...(includesHistory
					? [
							{
								user_book_id: 11,
								highlights: [{ id: 101, text: "Older highlight" }],
							},
						]
					: []),
				...(includesDeleted
					? [{ user_book_id: 12, is_deleted: true, highlights: [] }]
					: []),
			],
		});
	});
	await collectReadwise(
		{ ...ctx, emitRecord: emitter.emit, isRecordSelected: emitter.isSelected },
		read,
	);
	assert.deepEqual(
		ctx.protocolMessages
			.filter((message) => message.type === "RECORD")
			.map(({ stream, key, op }) => [stream, key, op]),
		[
			["books", "11", undefined],
			["highlights", "101", undefined],
			["books", "12", "delete"],
		],
	);
	assert.deepEqual(
		ctx.protocolMessages
			.filter((message) => message.type === "STATE")
			.map((message) => message.stream),
		["books", "highlights"],
	);
});

test("uses the oldest requested checkpoint and preserves numeric cursor zero", async () => {
	const ctx = fixtureContext({
		books: { updated_after: "2026-11-04T00:00:00.000Z" },
		highlights: { updated_after: "2026-11-05T00:00:00.000Z" },
	});
	const urls: URL[] = [];
	const read = createExportReader(
		async (input) => {
			urls.push(new URL(String(input)));
			return Response.json({
				results: [],
				nextPageCursor: urls.length === 1 ? 0 : null,
			});
		},
		async () => {},
	);
	await collectReadwise(ctx, read);
	assert.equal(urls.length, 2);
	assert.equal(
		urls[0]?.searchParams.get("updatedAfter"),
		"2026-11-04T00:00:00.000Z",
	);
	assert.equal(urls[1]?.searchParams.get("pageCursor"), "0");
	assert.equal(urls[1]?.searchParams.get("includeDeleted"), "true");
});

test("coverage counts records and tombstones the runtime accepted and only checkpoints complete streams", async () => {
	const ctx = fixtureContext();
	const emitter = makeEmitRecord({
		requested: ctx.requested,
		emit: ctx.emit,
		emittedAt: ctx.emittedAt,
		validateRecord,
		isTombstone: (_stream, data) => data.is_deleted === true,
		timeRangeFieldFor: () => null,
	});
	const read = createExportReader(
		async () =>
			Response.json({
				nextPageCursor: null,
				results: [
					{
						user_book_id: 11,
						highlights: [
							{ id: 101, text: "A synthetic highlight." },
							{ id: 102, created_at: "2024-01-01" },
							{ id: 103, is_deleted: true },
						],
					},
				],
			}),
		async () => {},
	);
	await collectReadwise(
		{ ...ctx, emitRecord: emitter.emit, isRecordSelected: emitter.isSelected },
		read,
	);
	assert.deepEqual(
		ctx.protocolMessages
			.filter((message) => message.type === "RECORD")
			.map(({ stream, key, op }) => [stream, key, op]),
		[
			["books", "11", undefined],
			["highlights", "101", undefined],
			["highlights", "103", "delete"],
		],
	);
	assert.deepEqual(
		ctx.protocolMessages
			.filter((message) => message.type === "DETAIL_COVERAGE")
			.map(({ stream, considered, covered }) => [stream, considered, covered]),
		[
			["books", 1, 1],
			["highlights", 3, 2],
		],
	);
	assert.deepEqual(
		ctx.protocolMessages
			.filter((message) => message.type === "STATE")
			.map(({ stream }) => stream),
		["books"],
	);
});

for (const { end, error } of [
	{ end: { nextPageCursor: null }, error: "readwise_invalid_export" },
	{
		end: { nextPageCursor: "again", results: [] },
		error: "readwise_pagination_cycle",
	},
]) {
	test(error + " cannot advance either stream", async () => {
		const ctx = fixtureContext();
		const pages = [{ nextPageCursor: "again", results: [] }, end];
		const read = createExportReader(
			async () => Response.json(pages.shift()),
			async () => {},
		);
		await assert.rejects(collectReadwise(ctx, read), { message: error });
		assert.equal(
			ctx.protocolMessages.some((message) => message.type === "STATE"),
			false,
		);
	});
}
