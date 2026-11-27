// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { collectSlackBrowser } from "./collector.ts";
import {
	DEFAULT_OPTIONS,
	FIXTURE_NOW,
	FIXTURE_NOW_SECONDS,
	fakeApi,
	fixture,
	harness,
	TEAM,
} from "./test-support.ts";
import { SlackApiError } from "./web-api.ts";

const CHANNEL = "C0123456789";
const PAGES = [undefined, "page-2", "page-3", "page-4"];
const TIMES = [
	"1790450000.000101",
	"1788000000.000102",
	"1770000000.000103",
	"1700000001.000104",
];
const IDS = TIMES.map((ts) => `${CHANNEL}:${ts}`);
const channelList = fixture("users.conversations") as {
	channels: Array<{ id: string }>;
};
const history = fixture(`conversations.history-${CHANNEL}-p1`) as {
	messages: Array<{ type: string; user: string; team: string }>;
};

async function journey(
	state: Record<string, unknown> = {},
	stopOnThird = false,
) {
	const h = harness(["messages"], { state });
	const api = fakeApi(({ method, params }) => {
		if (method === "users.conversations") {
			return {
				ok: true,
				channels: channelList.channels.filter(
					(channel) => channel.id === CHANNEL,
				),
			};
		}
		if (method !== "conversations.history") return undefined;
		assert.equal(params.channel, CHANNEL);
		assert.equal(
			params.oldest,
			undefined,
			"no lookback floor on a full-history walk",
		);
		assert.equal(params.latest, undefined);
		const page = PAGES.indexOf(params.cursor);
		assert.ok(page >= 0, "unexpected page cursor");
		if (stopOnThird && page === 2) {
			return new SlackApiError(method, "ratelimited", true, 429);
		}
		const template = history.messages[0];
		assert.ok(template);
		const next = PAGES[page + 1];
		return {
			ok: true,
			messages: [
				{
					type: template.type,
					user: template.user,
					team: template.team,
					text: `Synthetic history page ${page + 1}`,
					ts: TIMES[page],
				},
			],
			has_more: next !== undefined,
			response_metadata: { next_cursor: next ?? "" },
		};
	});
	await collectSlackBrowser(
		h.ctx,
		{ api, concurrency: 1, now: () => FIXTURE_NOW },
		[TEAM],
		{ ...DEFAULT_OPTIONS, lookbackDays: 0 },
	);
	return {
		h,
		pages: api.calls
			.filter((call) => call.method === "conversations.history")
			.map((call) => call.params.cursor),
		ids: h.of("messages").map((message) => message.id),
		coverage: h.coverage().find((entry) => entry.stream === "messages"),
	};
}

function assertComplete(run: Awaited<ReturnType<typeof journey>>) {
	assert.deepEqual(run.pages, PAGES);
	assert.deepEqual(run.ids, IDS);
	assert.deepEqual(run.h.state("messages"), {
		channel_last_ts: { [CHANNEL]: TIMES[0] },
		floor_ts: 0,
		format: 1,
		replies_checked_ts: FIXTURE_NOW_SECONDS,
	});
	assert.equal(run.coverage?.considered, 1);
	assert.equal(run.coverage?.covered, 1);
	assert.deepEqual(run.coverage?.hydrated_keys, [CHANNEL]);
	assert.deepEqual(run.h.skips(), []);
	assert.deepEqual(run.h.gaps(), []);
}

test("Slack history emits each ID across four pages and checkpoints only the complete channel", async () => {
	assertComplete(await journey());
});

test("Slack history retries an interrupted channel to its tail without advancing its watermark on failure", async () => {
	const stopped = await journey({}, true);
	assert.deepEqual(stopped.pages, PAGES.slice(0, 3));
	assert.deepEqual(stopped.ids, IDS.slice(0, 2));
	assert.equal(stopped.coverage?.considered, 1);
	assert.equal(stopped.coverage?.covered, 0);
	assert.deepEqual(stopped.coverage?.gap_keys, [CHANNEL]);
	assert.deepEqual(
		stopped.h.gaps().map((gap) => gap.record_key),
		[CHANNEL],
	);

	const cursor = stopped.h.state("messages");
	assert.ok(cursor);
	assert.deepEqual(cursor.channel_last_ts, {});
	assert.equal(cursor.floor_ts, 0);

	// The pin persists no intra-channel page token, so the safe retry
	// replays the prefix. Compare unique IDs across the two runs.
	const resumed = await journey({ messages: cursor });
	assertComplete(resumed);
	assert.deepEqual([...new Set([...stopped.ids, ...resumed.ids])], IDS);
});
