// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Page } from "playwright";
import type {
	BrowserCollectContext,
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectOuraBrowser } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const STREAM = "readiness";
const ACCESS = { accessToken: "synthetic", account: "account-a" };
const START = "2015-01-01";
const UNTIL = "2015-01-05";
const replay = JSON.parse(
	readFileSync(
		new URL("./fixtures/api-v2-replay.json", import.meta.url),
		"utf8",
	),
) as {
	daily_readiness: Array<Record<string, unknown>>;
};
const IDS = [1, 2, 3, 4].map(
	(n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
);
const PAGE_SEQUENCE = [null, "page-2", "page-3", "page-4"];
// The connector keeps the last two calendar days (counted from today) open for
// re-reading because Oura revises recent days, so refresh_from is that day and
// not the start of this fixed 2015 window.
const MUTABLE_OVERLAP_DAYS = 2;
function terminalCursor() {
	return {
		account: ACCESS.account,
		api_v2: true,
		next_day: UNTIL,
		refresh_from: new Date(Date.now() - MUTABLE_OVERLAP_DAYS * 86_400_000)
			.toISOString()
			.slice(0, 10),
		requested_since: null,
	};
}

async function walk(state: Record<string, unknown> = {}, stopOnThird = false) {
	const calls: Array<string | null> = [];
	const ids: unknown[] = [];
	const messages: EmittedMessage[] = [];
	const page = Object.assign(Object.create(null) as Page, {
		context: () => ({
			request: {
				get: async (raw: string) => {
					const url = new URL(raw);
					assert.equal(url.pathname.split("/").at(-1), "daily_readiness");
					assert.equal(url.searchParams.get("start_date"), START);
					assert.equal(url.searchParams.get("end_date"), UNTIL);
					const pageToken = url.searchParams.get("next_token");
					calls.push(pageToken);
					const index = PAGE_SEQUENCE.indexOf(pageToken);
					assert.ok(index >= 0, "unexpected page token");
					const status = stopOnThird && index === 2 ? 429 : 200;
					const day = `2015-01-0${index + 1}`;
					const answer = {
						data: [
							{
								...replay.daily_readiness[0],
								id: IDS[index],
								day,
								timestamp: `${day}T08:15:00+00:00`,
							},
						],
						next_token: PAGE_SEQUENCE[index + 1] ?? null,
					};
					return {
						ok: () => status === 200,
						status: () => status,
						json: async () => answer,
						dispose: async () => {},
					};
				},
			},
		}),
	});
	const ctx = Object.assign(Object.create(null) as BrowserCollectContext, {
		page,
		requested: new Map([
			[
				STREAM,
				{
					name: STREAM,
					time_range: { until: `${UNTIL}T00:00:00Z` },
				} as StreamScope,
			],
		]),
		state,
		emit: async (message: EmittedMessage) => {
			messages.push(message);
		},
		emitRecord: async (stream: string, data: RecordData) => {
			assert.equal(stream, STREAM);
			assert.equal(validateRecord(stream, data).ok, true, JSON.stringify(data));
			ids.push(data.id);
		},
		progress: async () => {},
	});
	await collectOuraBrowser(ctx, ACCESS);
	const cursors = messages.flatMap((message) =>
		message.type === "STATE" ? [message.cursor] : [],
	);
	return { calls, ids, messages, cursors };
}

test("Oura readiness walks every page in a default-start history window and commits only terminal state", async () => {
	const complete = await walk();
	assert.deepEqual(complete.calls, PAGE_SEQUENCE);
	assert.deepEqual(complete.ids, IDS);
	assert.deepEqual(complete.cursors, [terminalCursor()]);
	assert.equal(
		complete.messages.some((message) => message.type === "SKIP_RESULT"),
		false,
	);
});

test("Oura readiness retries a partially read window without advancing the watermark", async () => {
	const stopped = await walk({}, true);
	assert.deepEqual(stopped.calls, PAGE_SEQUENCE.slice(0, 3));
	assert.deepEqual(stopped.ids, IDS.slice(0, 2));
	assert.deepEqual(stopped.cursors, []);
	const skip = stopped.messages.find(
		(message) => message.type === "SKIP_RESULT",
	);
	assert.equal(skip?.reason, "upstream_pressure");
	assert.deepEqual(skip?.recovery_hint, {
		action: "retry_by_runtime",
		retryable: true,
	});

	const cursor = stopped.cursors.at(-1);
	const resumed = await walk(cursor ? { [STREAM]: cursor } : {});
	assert.deepEqual(resumed.calls, PAGE_SEQUENCE);
	assert.deepEqual(resumed.ids, IDS);
	assert.deepEqual([...new Set([...stopped.ids, ...resumed.ids])], IDS);
	assert.deepEqual(resumed.cursors, [terminalCursor()]);
	assert.equal(
		resumed.messages.some((message) => message.type === "SKIP_RESULT"),
		false,
	);
});
