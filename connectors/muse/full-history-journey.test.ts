// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	ACTIVITY_LIMIT,
	collectMuseWith,
	type MuseCtx,
	type MuseGateway,
	MuseRpcError,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

type Json = Record<string, unknown>;
const stream = "activities";

// Same activity fixture, before-cursor pagination, and fake gateway seam as index.test.ts.
function activitySource() {
	const fixture = JSON.parse(
		readFileSync(
			new URL("./__fixtures__/activity.json", import.meta.url),
			"utf8",
		),
	) as Json;
	const day = (fixture.days as Json[])[0] ?? {};
	const template = ((day.activities as Json[]) ?? [])[0] ?? {};
	const all = Array.from({ length: ACTIVITY_LIMIT * 3 + 5 }, (_, i) => ({
		...template,
		message_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
		timestamp: new Date(Date.UTC(2026, 0, 31, 12) - i * 60_000)
			.toISOString()
			.replace(".000Z", "Z"),
	}));
	return {
		ids: all.map((activity) => activity.message_id),
		page: (params: Json) => {
			const before =
				typeof params.before === "string"
					? Date.parse(params.before)
					: Infinity;
			const page = all
				.filter((activity) => Date.parse(activity.timestamp) < before)
				.slice(0, Number(params.limit));
			return {
				days: page.length
					? [{ ...day, count: page.length, activities: page }]
					: [],
			};
		},
	};
}

async function run(
	source: ReturnType<typeof activitySource>,
	state: Record<string, unknown> = {},
	failPage?: number,
) {
	const records: RecordData[] = [];
	const emitted: EmittedMessage[] = [];
	const failures: Array<{ stream: string; retryable: boolean | undefined }> =
		[];
	const calls: Json[] = [];
	let exhausted = false;
	const gateway: MuseGateway = {
		async call(method, params) {
			assert.equal(method, "activity.list");
			calls.push(params);
			assert.ok(
				calls.length <= source.ids.length + 2,
				"walk failed to terminate",
			);
			if (calls.length === failPage)
				throw new MuseRpcError(
					"unavailable",
					"muse_rpc_failed: activity.list unavailable",
				);
			const reply = source.page(params);
			if (reply.days.length === 0) exhausted = true;
			return structuredClone(reply);
		},
	};
	const ctx: MuseCtx = {
		collectionMode: "incremental",
		detailGaps: [],
		requested: new Map<string, StreamScope>([[stream, { name: stream }]]),
		state,
		emit: async (message) => {
			emitted.push(message);
		},
		emitRecord: async (name, data) => {
			assert.equal(name, stream);
			assert.equal(validateRecord(name, data).ok, true);
			records.push(data);
		},
		progress: async () => undefined,
		reportStreamFailure: async (name, _message, options) => {
			failures.push({ stream: name, retryable: options?.retryable });
		},
	};
	await collectMuseWith(ctx, gateway);
	const states = emitted.flatMap((message) =>
		message.type === "STATE" && message.stream === stream
			? [message.cursor]
			: [],
	);
	return {
		records,
		states,
		failures,
		calls,
		exhausted,
		coverage: emitted.filter((message) => message.type === "DETAIL_COVERAGE"),
	};
}

test("Muse activity full history reaches the end and emits each unique ID once", async () => {
	const source = activitySource();
	const full = await run(source);
	assert.deepEqual(full.failures, []);
	assert.ok(full.calls.length >= 5);
	assert.equal(full.exhausted, true);
	assert.deepEqual(
		full.records.map((record) => record.message_id),
		source.ids,
	);
	assert.equal(
		new Set(full.records.map((record) => record.id)).size,
		source.ids.length,
	);
	assert.deepEqual(full.states, [
		{ version: 2, newest_timestamp: "2026-01-31T12:00:00.000Z" },
	]);
	// Activity currently emits STATE, not a DETAIL_COVERAGE message.
	assert.deepEqual(full.coverage, []);
});

test("Muse activity page-3 interruption does not advance STATE and a fresh retry reaches the end", async () => {
	const source = activitySource(),
		full = await run(source);
	const interrupted = await run(source, {}, 3);
	assert.deepEqual(interrupted.failures, [{ stream, retryable: true }]);
	assert.equal(interrupted.calls.length, 3);
	assert.equal(interrupted.exhausted, false);
	assert.deepEqual(interrupted.coverage, []);
	assert.deepEqual(interrupted.states, []);
	assert.ok(
		interrupted.records.length > 0 &&
			interrupted.records.length < source.ids.length,
	);

	const last = interrupted.states.at(-1);
	const retried = await run(
		source,
		last === undefined ? {} : { [stream]: last },
	);
	assert.equal(
		retried.calls[0]?.before,
		null,
		"the pinned connector restarts at the head",
	);
	assert.equal(retried.exhausted, true);
	assert.deepEqual(retried.failures, []);
	const merged = new Map(
		[...interrupted.records, ...retried.records].map((record) => [
			String(record.id),
			record.message_id,
		]),
	);
	assert.deepEqual([...merged.values()], source.ids);
	assert.deepEqual(retried.states.at(-1), full.states.at(-1));
});
