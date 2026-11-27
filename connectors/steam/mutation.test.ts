// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type {
	EmittedMessage,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { steamCollect } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const STEAM_ID = "76561198012345678";

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
});

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200 });
}

function makeContext(streams: readonly string[]): {
	ctx: Parameters<typeof steamCollect>[0];
	emittedRecords: ReturnType<typeof makeRecordingEmit>["emitted"];
	messages: EmittedMessage[];
	skippedRecords: ReturnType<typeof makeRecordingEmit>["skipped"];
} {
	const harness = makeRecordingEmit(validateRecord);
	const requested = new Map<string, StreamScope>(
		streams.map((name) => [name, { name }]),
	);
	return {
		emittedRecords: harness.emitted,
		messages: harness.protocolMessages,
		skippedRecords: harness.skipped,
		ctx: {
			credentials: { STEAM_API_KEY: "test-key", STEAM_USER_ID: STEAM_ID },
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			progress: () => Promise.resolve(),
			requested,
			state: {},
		},
	};
}

const missingArrayCases = [
	{ body: { response: { game_count: 3 } }, stream: "owned_games" },
	{ body: { friendslist: {} }, stream: "friends" },
] as const;

for (const { body, stream } of missingArrayCases) {
	test(`steam: 200 ${stream} envelope without its list fails before state or coverage`, async () => {
		globalThis.fetch = async () => jsonResponse(body);
		const { ctx, messages } = makeContext([stream]);

		await assert.rejects(() => steamCollect(ctx), /steam_response_malformed/);
		assert.equal(
			messages.some(
				(message) => message.type === "STATE" && message.stream === stream,
			),
			false,
			"an omitted list must not advance its cursor",
		);
		assert.equal(
			messages.some(
				(message) =>
					message.type === "DETAIL_COVERAGE" && message.stream === stream,
			),
			false,
			"an omitted list must not prove an empty boundary",
		);
	});
}

test("steam: recently_played_games with games entirely absent is a well-formed empty answer, not malformed", async () => {
	// GetRecentlyPlayedGames documented shape when the account played nothing
	// in the trailing two-week window: {"response":{"total_count":0}}, no
	// `games` key at all. This must succeed with zero records, not throw
	// steam_response_malformed (regression for 3ccca8000).
	globalThis.fetch = async () => jsonResponse({ response: { total_count: 0 } });
	const { ctx, messages } = makeContext(["recently_played_games"]);

	await steamCollect(ctx);
	assert.equal(
		messages.filter(
			(message) =>
				message.type === "STATE" && message.stream === "recently_played_games",
		).length,
		1,
		"an absent list must still advance its cursor as a real empty snapshot",
	);
	const coverage = messages.find(
		(
			message,
		): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" &&
			message.stream === "recently_played_games",
	);
	assert.ok(coverage);
	assert.equal(coverage.considered, 0);
	assert.equal(coverage.covered, 0);
});

test("steam: recently_played_games with games present but not an array is still malformed", async () => {
	// A present-but-wrong-shaped `games` field is a genuine protocol violation
	// (unlike an absent field), and must still fail before state or coverage.
	globalThis.fetch = async () =>
		jsonResponse({ response: { total_count: 3, games: "not-an-array" } });
	const { ctx, messages } = makeContext(["recently_played_games"]);

	await assert.rejects(() => steamCollect(ctx), /steam_response_malformed/);
	assert.equal(
		messages.some(
			(message) =>
				message.type === "STATE" && message.stream === "recently_played_games",
		),
		false,
		"a malformed list must not advance its cursor",
	);
	assert.equal(
		messages.some(
			(message) =>
				message.type === "DETAIL_COVERAGE" &&
				message.stream === "recently_played_games",
		),
		false,
		"a malformed list must not prove an empty boundary",
	);
});

test("steam: an explicit empty games array remains valid zero proof", async () => {
	globalThis.fetch = async () => jsonResponse({ response: { games: [] } });
	const { ctx, messages } = makeContext(["owned_games"]);

	await steamCollect(ctx);
	assert.equal(
		messages.filter(
			(message) => message.type === "STATE" && message.stream === "owned_games",
		).length,
		1,
	);
	const coverage = messages.find(
		(
			message,
		): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === "owned_games",
	);
	assert.ok(coverage);
	assert.equal(coverage.considered, 0);
	assert.equal(coverage.covered, 0);
});

test("steam: friends stream hydrates persona fields via a single batched GetPlayerSummaries call", async () => {
	const requestedUrls: URL[] = [];
	globalThis.fetch = (input) => {
		const url = new URL(String(input));
		requestedUrls.push(url);
		if (url.pathname.endsWith("/GetFriendList/v0001")) {
			return Promise.resolve(
				jsonResponse({
					friendslist: {
						friends: [
							{
								steamid: "76561198000000001",
								relationship: "friend",
								friend_since: 1_700_000_000,
							},
							{
								steamid: "76561198000000002",
								relationship: "friend",
								friend_since: 1_700_000_001,
							},
							{
								steamid: "76561198000000003",
								relationship: "friend",
								friend_since: 1_700_000_002,
							},
						],
					},
				}),
			);
		}
		if (url.pathname.endsWith("/GetPlayerSummaries/v0002")) {
			return Promise.resolve(
				jsonResponse({
					response: {
						players: [
							{
								steamid: "76561198000000001",
								personaname: "Friend One",
								avatarfull: "https://example.com/one.jpg",
								profileurl:
									"https://steamcommunity.com/profiles/76561198000000001/",
							},
							{
								steamid: "76561198000000002",
								personaname: "Friend Two",
								avatar: "https://example.com/two.jpg",
								profileurl:
									"https://steamcommunity.com/profiles/76561198000000002/",
							},
							// 76561198000000003 omitted: simulates a private/unresolvable profile.
						],
					},
				}),
			);
		}
		throw new Error(`unexpected Steam fixture request: ${url.pathname}`);
	};
	const { ctx, emittedRecords } = makeContext(["friends"]);

	await steamCollect(ctx);

	const summariesRequests = requestedUrls.filter((url) =>
		url.pathname.endsWith("/GetPlayerSummaries/v0002"),
	);
	assert.equal(
		summariesRequests.length,
		1,
		"friend persona hydration must use one batched call, not one per friend",
	);
	assert.equal(
		summariesRequests[0]?.searchParams.get("steamids"),
		"76561198000000001,76561198000000002,76561198000000003",
	);

	const records = emittedRecords.filter(
		(record) => record.stream === "friends",
	);
	assert.equal(records.length, 3);
	const hydrated = records.find(
		(record) => record.data.steamid === "76561198000000001",
	);
	assert.equal(hydrated?.data.persona_name, "Friend One");
	assert.equal(hydrated?.data.avatar_url, "https://example.com/one.jpg");
	assert.equal(
		hydrated?.data.profile_url,
		"https://steamcommunity.com/profiles/76561198000000001/",
	);
	const fallbackAvatar = records.find(
		(record) => record.data.steamid === "76561198000000002",
	);
	assert.equal(fallbackAvatar?.data.avatar_url, "https://example.com/two.jpg");
	const unresolved = records.find(
		(record) => record.data.steamid === "76561198000000003",
	);
	assert.equal(
		unresolved?.data.persona_name,
		null,
		"a friend absent from GetPlayerSummaries gets null persona fields, not a failed run",
	);
	assert.equal(unresolved?.data.avatar_url, null);
	assert.equal(unresolved?.data.profile_url, null);
});

test("steam: friends stream still emits relationship data when persona hydration fails", async () => {
	globalThis.fetch = (input) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/GetFriendList/v0001")) {
			return Promise.resolve(
				jsonResponse({
					friendslist: {
						friends: [
							{
								steamid: "76561198000000001",
								relationship: "friend",
								friend_since: 1_700_000_000,
							},
						],
					},
				}),
			);
		}
		if (url.pathname.endsWith("/GetPlayerSummaries/v0002")) {
			return Promise.resolve(new Response("", { status: 429 }));
		}
		throw new Error(`unexpected Steam fixture request: ${url.pathname}`);
	};
	const { ctx, emittedRecords } = makeContext(["friends"]);

	await steamCollect(ctx);

	const records = emittedRecords.filter(
		(record) => record.stream === "friends",
	);
	assert.equal(
		records.length,
		1,
		"a degraded persona lookup must not drop the friend relationship record",
	);
	assert.equal(records[0]?.data.persona_name, null);
});

test("steam: an invalid player_level fails schema coverage without a green checkpoint", async () => {
	globalThis.fetch = async () =>
		jsonResponse({ response: { player_level: "not-a-number" } });
	const { ctx, messages, skippedRecords } = makeContext(["steam_level"]);

	await steamCollect(ctx);
	assert.equal(
		skippedRecords.some((record) => record.stream === "steam_level"),
		true,
		"the runtime-shaped record must be rejected",
	);
	assert.equal(
		messages.some(
			(message) => message.type === "STATE" && message.stream === "steam_level",
		),
		false,
		"an invalid level must not advance the stream cursor",
	);
	const coverage = messages.find(
		(
			message,
		): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === "steam_level",
	);
	assert.ok(coverage);
	assert.equal(coverage.considered, 1);
	assert.equal(coverage.covered, 0);
});
