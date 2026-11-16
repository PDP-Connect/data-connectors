// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
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

test("adding highlights after syncing books starts from the beginning", async () => {
	const ctx = fixtureContext({
		books: { updated_after: "2026-11-05T00:00:00.000Z" },
	});
	const windows: (string | null)[] = [];
	await collectReadwise(ctx, async (_token, _cursor, updatedAfter) => {
		windows.push(updatedAfter);
		return { nextPageCursor: null, results: [] };
	});
	assert.deepEqual(windows, [null]);
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
