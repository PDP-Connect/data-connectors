// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Collection Profile semantics: the run's time_range and resources reach
// TikTok's lists where TikTok's own answers prove it safe, failures carry a
// portable recovery hint, collection gaps are retried only when a retry can
// help, and the manifest says what the code does.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	collectTikTok,
	pageBeforeSince,
	type TikTokCollectContext,
	type TikTokPage,
} from "./index.ts";
import { parseItemPage } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

type Json = Record<string, unknown>;

const fixture = (name: string): Json =>
	JSON.parse(
		readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"),
	) as Json;

const ACCOUNT = fixture("passport-account-info-v2.json");
const POSTS = fixture("post-item-list.json");
const LIKED = fixture("favorite-item-list.json");
const COLLECTIONS = fixture("collection-list.json");
const COLLECTION_ITEMS = fixture("collection-item-list.json");
const USERS = fixture("user-list.json");
const COLLECT = fixture("collect-item-list.json");
const SETTINGS = fixture("user-settings.json");

const COLLECTION_A = "7400000000000000001";
const COLLECTION_B = "7400000000000000002";
const BOTH = ["favorite_collections", "collection_items"];

interface Call {
	params: Record<string, string>;
	path: string;
}

const ok = (json: unknown) => ({
	kind: "response",
	status: 200,
	html: false,
	empty: false,
	json,
	signed: true,
	transport: "fetch",
	retryAfterSeconds: null,
});

const GET_CALL = /session\.get\(("[^"]+"), (\{.*?\}), \d+\)/s;

function standardAnswer(call: Call): unknown {
	switch (call.path) {
		case "/passport/account/info/v2/":
			return ok(ACCOUNT);
		case "/api/user/settings/":
			return ok(SETTINGS);
		case "/api/post/item_list/":
			return ok(POSTS);
		case "/api/favorite/item_list/":
			return ok(LIKED);
		case "/api/user/collect/item_list/":
			return ok(COLLECT);
		case "/api/user/list/":
			return ok(USERS);
		case "/api/user/collection_list/":
			return ok(COLLECTIONS);
		case "/api/collection/item_list/":
			return ok(COLLECTION_ITEMS);
		default:
			return { kind: "refused" };
	}
}

function fakePage(
	answer: (call: Call) => unknown,
	watch: (gotos: readonly string[]) => Json = () => ({
		client: true,
		transport: null,
		copied: { "/api/collection/item_list/": true },
	}),
): { calls: Call[]; gotos: string[]; page: TikTokPage } {
	const calls: Call[] = [];
	const gotos: string[] = [];
	const page: TikTokPage = {
		evaluate: async (script: string) => {
			const match = GET_CALL.exec(script);
			if (!match?.[1] || !match[2]) return watch(gotos);
			const call: Call = {
				path: JSON.parse(match[1]) as string,
				params: JSON.parse(match[2]) as Record<string, string>,
			};
			calls.push(call);
			return answer(call);
		},
		goto: async (url: string) => {
			gotos.push(url);
			return null;
		},
	};
	return { calls, gotos, page };
}

interface Failure {
	hint: { action: string; retryable?: boolean } | undefined;
	message: string;
	retryable: boolean;
	stream: string;
}

function harness(
	scopes: (string | StreamScope)[],
	page: TikTokPage,
	extra: Partial<TikTokCollectContext> = {},
) {
	const messages: EmittedMessage[] = [];
	const records: { stream: string; data: RecordData }[] = [];
	const failures: Failure[] = [];
	const requested = new Map<string, StreamScope>(
		scopes.map((scope) =>
			typeof scope === "string"
				? [scope, { name: scope }]
				: [scope.name, scope],
		),
	);
	const ctx: TikTokCollectContext = {
		collectionMode: "incremental",
		emit: async (message: EmittedMessage) => {
			messages.push(message);
		},
		emitRecord: async (stream: string, data: RecordData) => {
			const valid = validateRecord(stream, data);
			assert.equal(valid.ok, true, JSON.stringify(valid));
			records.push({ stream, data });
			messages.push({ type: "RECORD", stream, data } as EmittedMessage);
		},
		reportStreamFailure: async (stream, message, options) => {
			failures.push({
				stream,
				message,
				retryable: options?.retryable === true,
				hint: options?.recoveryHint,
			});
		},
		page,
		requested,
		state: {},
		...extra,
	};
	return { ctx, failures, messages, records };
}

const noDelay = { delay: async () => {}, random: () => 0 };

const asRecord = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null
		? Object.fromEntries(Object.entries(value))
		: {};

const ofType = (h: { messages: EmittedMessage[] }, type: string) =>
	h.messages.filter((m) => m.type === type).map(asRecord);

const stateOf = (h: { messages: EmittedMessage[] }, stream: string) =>
	ofType(h, "STATE").find((m) => m.stream === stream);

const BASE_VIDEO = (POSTS.itemList as Json[])[0] as Json;

/** An own video posted at `seconds` (Unix), optionally pinned. */
const video = (id: string, seconds: number, pinned?: boolean): Json => ({
	...BASE_VIDEO,
	id,
	createTime: seconds,
	...(pinned === undefined ? {} : { isPinnedItem: pinned }),
});

const SINCE = "2026-01-01T00:00:00Z";
const SINCE_S = Date.parse(SINCE) / 1000;
const DAY = 86_400;

/**
 * Three pages of own videos, newest first: page one inside the window (with
 * an old pinned video on top), page two entirely before `since`, page three
 * older still.
 */
const POST_PAGES: Record<string, Json> = {
	"0": {
		...POSTS,
		hasMore: true,
		total: 100,
		cursor: String((SINCE_S + 5 * DAY) * 1000),
		itemList: [
			video("900", SINCE_S - 400 * DAY, true),
			video("901", SINCE_S + 7 * DAY),
			video("902", SINCE_S + 5 * DAY),
		],
	},
	[String((SINCE_S + 5 * DAY) * 1000)]: {
		...POSTS,
		hasMore: true,
		total: 100,
		cursor: String((SINCE_S - 3 * DAY) * 1000),
		itemList: [
			video("903", SINCE_S - 2 * DAY),
			video("904", SINCE_S - 3 * DAY),
		],
	},
	[String((SINCE_S - 3 * DAY) * 1000)]: {
		...POSTS,
		hasMore: false,
		total: 100,
		cursor: String((SINCE_S - 9 * DAY) * 1000),
		itemList: [video("905", SINCE_S - 9 * DAY)],
	},
};

const postPages =
	(pages: Record<string, Json>) =>
	(call: Call): unknown =>
		call.path === "/api/post/item_list/"
			? ok(pages[call.params.cursor ?? ""] ?? { hasMore: false })
			: standardAnswer(call);

const postCursors = (calls: Call[]) =>
	calls
		.filter((c) => c.path === "/api/post/item_list/")
		.map((c) => c.params.cursor);

const ids = (
	h: { records: { stream: string; data: RecordData }[] },
	s: string,
) => h.records.filter((r) => r.stream === s).map((r) => String(r.data.id));

// ─── time_range push-down (videos) ───────────────────────────────────────

test("time_range: videos stop after the first page TikTok proves is wholly before since", async () => {
	const { calls, page } = fakePage(postPages(POST_PAGES));
	const h = harness(
		[{ name: "videos", time_range: { since: SINCE } } as StreamScope],
		page,
	);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	// The third page is never asked for, and TikTok's count of the whole list
	// (100) is not held against a walk the window ended.
	assert.equal(postCursors(calls).length, 2);
	assert.deepEqual(ids(h, "videos"), ["900", "901", "902", "903", "904"]);
	assert.deepEqual(stateOf(h, "videos")?.cursor, { count: 5 });
});

test("time_range: an old pinned video on top neither stops the walk nor breaks the order", async () => {
	const pages = {
		...POST_PAGES,
		// Page one holds only the pinned video and in-window videos: the walk
		// goes on even though the pinned video is older than since.
		"0": {
			...(POST_PAGES["0"] as Json),
			itemList: [
				video("900", SINCE_S - 400 * DAY, true),
				video("901", SINCE_S + 7 * DAY),
			],
		},
	};
	const { calls, page } = fakePage(postPages(pages));
	const h = harness(
		[{ name: "videos", time_range: { since: SINCE } } as StreamScope],
		page,
	);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.equal(postCursors(calls).length, 2);
});

test("time_range: an unmarked old video on top breaks the newest-first proof, so the whole list is read", async () => {
	const pages = {
		...POST_PAGES,
		"0": {
			...(POST_PAGES["0"] as Json),
			itemList: [
				video("900", SINCE_S - 400 * DAY),
				video("901", SINCE_S + 7 * DAY),
				video("902", SINCE_S + 5 * DAY),
			],
		},
	};
	const { calls, page } = fakePage(postPages(pages));
	const h = harness(
		[{ name: "videos", time_range: { since: SINCE } } as StreamScope],
		page,
	);
	await collectTikTok(h.ctx, noDelay);
	assert.equal(postCursors(calls).length, 3);
});

test("time_range: a cursor that is not a posting time proves nothing, so the walk goes on", async () => {
	const second = String((SINCE_S + 5 * DAY) * 1000);
	const pages = {
		...POST_PAGES,
		[second]: { ...(POST_PAGES[second] as Json), cursor: "30" },
		"30": POST_PAGES[String((SINCE_S - 3 * DAY) * 1000)] as Json,
	};
	const { calls, page } = fakePage(postPages(pages));
	const h = harness(
		[{ name: "videos", time_range: { since: SINCE } } as StreamScope],
		page,
	);
	await collectTikTok(h.ctx, noDelay);
	assert.equal(postCursors(calls).length, 3);
});

test("time_range: until alone is not pushed down; the whole list is read", async () => {
	const { calls, page } = fakePage(postPages(POST_PAGES));
	const h = harness(
		[{ name: "videos", time_range: { until: SINCE } } as StreamScope],
		page,
	);
	await collectTikTok(h.ctx, noDelay);
	assert.equal(postCursors(calls).length, 3);
	// Without the early stop, TikTok's count (100) above the 6 read still
	// fails the stream, as before.
	assert.match(h.failures[0]?.message ?? "", /^tiktok_list_incomplete/);
});

test("time_range: narrow then wide: a later run with an earlier since reads the older pages again", async () => {
	const narrow = fakePage(postPages(POST_PAGES));
	const first = harness(
		[{ name: "videos", time_range: { since: SINCE } } as StreamScope],
		narrow.page,
	);
	await collectTikTok(first.ctx, noDelay);
	assert.equal(ids(first, "videos").includes("905"), false);
	// The second run starts from the first run's STATE and an earlier since.
	const state: Record<string, unknown> = {};
	for (const message of ofType(first, "STATE"))
		state[String(message.stream)] = message.cursor;
	const wide = fakePage(postPages(POST_PAGES));
	const second = harness(
		[
			{
				name: "videos",
				time_range: { since: "2025-12-01T00:00:00Z" },
			} as StreamScope,
		],
		wide.page,
		{ state },
	);
	await collectTikTok(second.ctx, noDelay);
	assert.deepEqual(postCursors(wide.calls).length, 3);
	assert.ok(ids(second, "videos").includes("905"));
});

test("time_range: pageBeforeSince needs every unpinned video and the cursor before since", () => {
	const page = (json: Json) => {
		const parsed = parseItemPage(json);
		assert.ok(parsed);
		return parsed;
	};
	const second = POST_PAGES[String((SINCE_S + 5 * DAY) * 1000)] as Json;
	assert.equal(pageBeforeSince(page(second), SINCE), true);
	assert.equal(pageBeforeSince(page(POST_PAGES["0"] as Json), SINCE), false);
	// A cursor later than the page's oldest video is not a posting-time cursor.
	assert.equal(
		pageBeforeSince(
			page({ ...second, cursor: String((SINCE_S + 30 * DAY) * 1000) }),
			SINCE,
		),
		false,
	);
	// A page of pinned videos only proves nothing.
	assert.equal(
		pageBeforeSince(
			page({ ...second, itemList: [video("1", SINCE_S - DAY, true)] }),
			SINCE,
		),
		false,
	);
});

// ─── resources push-down ─────────────────────────────────────────────────

test("resources: a videos walk ends once every requested video was read", async () => {
	const { calls, page } = fakePage(postPages(POST_PAGES));
	const h = harness(
		[{ name: "videos", resources: ["901"] } as StreamScope],
		page,
	);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.equal(postCursors(calls).length, 1);
});

test("resources: a requested video not in the list is looked for to the end", async () => {
	const { calls, page } = fakePage(postPages(POST_PAGES));
	const h = harness(
		[{ name: "videos", resources: ["901", "999"] } as StreamScope],
		page,
	);
	await collectTikTok(h.ctx, noDelay);
	assert.equal(postCursors(calls).length, 3);
});

test("resources: likes and followers end once the requested ids were read", async () => {
	const liked = LIKED.itemList as Json[];
	const likedId = String(liked[0]?.id);
	const likedPages = (call: Call): unknown => {
		if (call.path === "/api/favorite/item_list/")
			return ok({ ...LIKED, hasMore: true, cursor: `c${calls.length}` });
		if (call.path === "/api/user/list/")
			return ok({ ...USERS, hasMore: true, minCursor: calls.length });
		return standardAnswer(call);
	};
	const { calls, page } = fakePage(likedPages);
	const userId = String(
		asRecord(asRecord((USERS.userList as Json[])[0]).user).id,
	);
	const h = harness(
		[
			{ name: "likes", resources: [likedId] } as StreamScope,
			{ name: "followers", resources: [userId] } as StreamScope,
		],
		page,
	);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.equal(
		calls.filter((c) => c.path === "/api/favorite/item_list/").length,
		1,
	);
	assert.equal(calls.filter((c) => c.path === "/api/user/list/").length, 1);
});

test("resources: collection_items reads only the collections its resources name", async () => {
	const { calls, page } = fakePage(standardAnswer);
	const h = harness(
		[
			"favorite_collections",
			{
				name: "collection_items",
				resources: [`${COLLECTION_B}:300001`],
			} as StreamScope,
		],
		page,
	);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(
		calls
			.filter((c) => c.path === "/api/collection/item_list/")
			.map((c) => c.params.collectionId),
		[COLLECTION_B],
	);
	const [coverage] = ofType(h, "DETAIL_COVERAGE");
	assert.deepEqual(coverage?.required_keys, [COLLECTION_B]);
	assert.deepEqual(coverage?.hydrated_keys, [COLLECTION_B]);
});

// ─── likes / favorites count above listed ────────────────────────────────

test("count above listed: likes read to hasMore:false twice with the same ids complete below TikTok's count", async () => {
	const { calls, page } = fakePage((call) =>
		call.path === "/api/favorite/item_list/"
			? ok({ ...LIKED, total: 5 })
			: standardAnswer(call),
	);
	const h = harness(["likes"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.equal(
		calls.filter((c) => c.path === "/api/favorite/item_list/").length,
		2,
	);
	assert.equal(ids(h, "likes").length, 3, "each video emitted once");
	assert.deepEqual(stateOf(h, "likes")?.cursor, { count: 3 });
});

test("count above listed: favorites that read differently every time still fail", async () => {
	const base = (COLLECT.itemList as Json[] | undefined) ?? [];
	const one = (LIKED.itemList as Json[])[0] as Json;
	let reads = 0;
	const { page } = fakePage((call) => {
		if (call.path !== "/api/user/collect/item_list/")
			return standardAnswer(call);
		reads += 1;
		return ok({
			...COLLECT,
			total: 9,
			itemList: [...base, { ...one, id: String(500000 + reads) }],
		});
	});
	const h = harness(["favorites"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.equal(h.failures.length, 1);
	assert.match(h.failures[0]?.message ?? "", /^tiktok_list_incomplete/);
	assert.equal(stateOf(h, "favorites"), undefined);
});

// ─── recovery hints ──────────────────────────────────────────────────────

test("recovery hints: each failure carries the portable action that fits it", async () => {
	const unreadable = fakePage((call) =>
		call.path === "/api/post/item_list/"
			? ok({ unexpected: true })
			: standardAnswer(call),
	);
	const h1 = harness(["videos", "collection_items"], unreadable.page);
	await collectTikTok(h1.ctx, noDelay);
	assert.deepEqual(
		h1.failures.map((f) => [f.stream, f.hint, f.retryable]),
		[
			[
				"videos",
				{ action: "retry_on_connector_upgrade", retryable: false },
				false,
			],
			[
				"collection_items",
				{ action: "manual_action_required", retryable: false },
				false,
			],
		],
	);
	const limited = fakePage((call) =>
		call.path === "/api/post/item_list/"
			? { ...ok({}), status: 429 }
			: standardAnswer(call),
	);
	const h2 = harness(["videos"], limited.page);
	await collectTikTok(h2.ctx, noDelay);
	assert.deepEqual(h2.failures[0]?.hint, {
		action: "retry_by_runtime",
		retryable: true,
	});
	const challenged = fakePage((call) =>
		call.path === "/api/post/item_list/"
			? { ...ok(null), status: 403, html: true }
			: standardAnswer(call),
	);
	const h3 = harness(["videos"], challenged.page);
	await collectTikTok(h3.ctx, noDelay);
	assert.deepEqual(h3.failures[0]?.hint, {
		action: "manual_action_required",
		retryable: false,
	});
});

test("recovery hints: without reportStreamFailure the SKIP_RESULT uses the portable reason", async () => {
	const { page } = fakePage((call) =>
		call.path === "/api/post/item_list/"
			? ok({ unexpected: true })
			: standardAnswer(call),
	);
	const h = harness(["videos"], page, { reportStreamFailure: undefined });
	await collectTikTok(h.ctx, noDelay);
	const [skip] = ofType(h, "SKIP_RESULT");
	assert.equal(skip?.reason, "stream_collection_failed");
	assert.deepEqual(skip?.recovery_hint, {
		action: "retry_on_connector_upgrade",
		retryable: false,
	});
});

// ─── collections ─────────────────────────────────────────────────────────

test("collections: a first collection without an owner name reads with the value another collection's page gave", async () => {
	const list = COLLECTIONS.collectionList as Json[];
	const { calls, gotos, page } = fakePage(
		(call) =>
			call.path === "/api/user/collection_list/"
				? ok({
						...COLLECTIONS,
						collectionList: [{ ...list[0], userName: undefined }, list[1]],
					})
				: standardAnswer(call),
		(opened) => ({
			client: true,
			transport: null,
			copied: { "/api/collection/item_list/": opened.length > 0 },
		}),
	);
	const h = harness(BOTH, page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(gotos, [
		`https://www.tiktok.com/@synthetic_owner/collection/Synthetic%20travel-${COLLECTION_B}`,
	]);
	assert.deepEqual(
		calls
			.filter((c) => c.path === "/api/collection/item_list/")
			.map((c) => c.params.collectionId),
		[COLLECTION_A, COLLECTION_B],
	);
});

test("collections: an unreadable collection fails the stream instead of leaving a gap retried forever", async () => {
	const { page } = fakePage((call) =>
		call.path === "/api/collection/item_list/" &&
		call.params.collectionId === COLLECTION_B
			? ok({ unexpected: true })
			: standardAnswer(call),
	);
	const h = harness(BOTH, page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(ofType(h, "DETAIL_GAP"), []);
	assert.deepEqual(
		h.failures.map((f) => [f.stream, f.hint?.action]),
		[["collection_items", "retry_on_connector_upgrade"]],
	);
	const [coverage] = ofType(h, "DETAIL_COVERAGE");
	assert.deepEqual(coverage?.required_keys, [COLLECTION_A, COLLECTION_B]);
	assert.deepEqual(coverage?.hydrated_keys, [COLLECTION_A]);
	assert.equal(coverage?.gap_keys, undefined);
	assert.equal(stateOf(h, "collection_items"), undefined);
	assert.ok(stateOf(h, "favorite_collections"));
});

const pendingGap = (gapId: string, collectionId: string) => ({
	gap_id: gapId,
	status: "pending" as const,
	stream: "collection_items",
	parent_stream: "favorite_collections",
	record_key: collectionId,
	detail_locator: { kind: "tiktok.collection", collection_id: collectionId },
});

test("gap pages: an ordinary run settles gaps the runtime pages in after START", async () => {
	const { page } = fakePage(standardAnswer);
	const pages = [[pendingGap("g2", COLLECTION_B)], []];
	let asked = 0;
	const h = harness(BOTH, page, {
		detailGaps: [pendingGap("g1", COLLECTION_A)],
		requestDetailGapPage: async () => pages[asked++] ?? [],
	});
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(
		ofType(h, "DETAIL_GAP_RECOVERED").map((m) => m.gap_id),
		["g1", "g2"],
	);
	const coverage = h.messages.findIndex((m) => m.type === "DETAIL_COVERAGE");
	const lastRecovered = h.messages.findLastIndex(
		(m) => m.type === "DETAIL_GAP_RECOVERED",
	);
	assert.ok(lastRecovered < coverage);
});

test("gap pages: a recovery run reads the collections a later page names, parent first", async () => {
	const { calls, page } = fakePage(standardAnswer);
	const pages = [[pendingGap("g2", COLLECTION_B)], []];
	let asked = 0;
	const h = harness(BOTH, page, {
		recoveryOnly: true,
		detailGaps: [pendingGap("g1", COLLECTION_A)],
		requestDetailGapPage: async () => pages[asked++] ?? [],
	});
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(
		calls
			.filter((c) => c.path === "/api/collection/item_list/")
			.map((c) => c.params.collectionId),
		[COLLECTION_A, COLLECTION_B],
	);
	assert.deepEqual(
		h.records.map((r) => [r.stream, r.data.id]),
		[
			["favorite_collections", COLLECTION_A],
			["collection_items", `${COLLECTION_A}:300001`],
			["collection_items", `${COLLECTION_A}:300002`],
			["favorite_collections", COLLECTION_B],
			["collection_items", `${COLLECTION_B}:300001`],
			["collection_items", `${COLLECTION_B}:300002`],
		],
	);
	const [coverage] = ofType(h, "DETAIL_COVERAGE");
	assert.deepEqual(coverage?.required_keys, [COLLECTION_A, COLLECTION_B]);
	assert.deepEqual(
		ofType(h, "DETAIL_GAP_RECOVERED").map((m) => m.gap_id),
		["g1", "g2"],
	);
});

test("gap pages: a recovery run with no gap in START asks the runtime for one page", async () => {
	const { calls, page } = fakePage(standardAnswer);
	const pages = [[pendingGap("g2", COLLECTION_B)], []];
	let asked = 0;
	const h = harness(BOTH, page, {
		recoveryOnly: true,
		detailGaps: [],
		requestDetailGapPage: async () => pages[asked++] ?? [],
	});
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(
		calls
			.filter((c) => c.path === "/api/collection/item_list/")
			.map((c) => c.params.collectionId),
		[COLLECTION_B],
	);
});

// ─── manifest ────────────────────────────────────────────────────────────

test("manifest: likes and favorites are mutable state, and no stream claims a cursor nobody reads", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as {
		streams: {
			consent_time_field?: string;
			cursor_field?: string;
			incremental?: boolean;
			name: string;
			semantics: string;
		}[];
	};
	const byName = new Map(manifest.streams.map((s) => [s.name, s]));
	assert.equal(byName.get("likes")?.semantics, "mutable_state");
	assert.equal(byName.get("favorites")?.semantics, "mutable_state");
	for (const stream of manifest.streams) {
		assert.equal(stream.incremental, false, stream.name);
		assert.equal(stream.cursor_field, undefined, stream.name);
	}
	assert.equal(byName.get("videos")?.consent_time_field, "created_at");
	// Likes and saves carry no time TikTok reports for the owner's action.
	assert.equal(byName.get("likes")?.consent_time_field, undefined);
	assert.equal(byName.get("favorites")?.consent_time_field, undefined);
});

// ─── review 1 ────────────────────────────────────────────────────────────

test("review 1: a page whose pin marker came in another type proves nothing", () => {
	const second = POST_PAGES[String((SINCE_S + 5 * DAY) * 1000)] as Json;
	const parsed = parseItemPage({
		...second,
		itemList: [
			{ ...video("903", SINCE_S - 2 * DAY), isPinnedItem: "yes" },
			video("904", SINCE_S - 3 * DAY),
		],
	});
	assert.ok(parsed);
	assert.ok(parsed.dropped.includes("isPinnedItem"));
	assert.equal(pageBeforeSince(parsed, SINCE), false);
});

test("review 1: a requested collection without an owner name gets the app's value from another listed collection's page", async () => {
	const list = COLLECTIONS.collectionList as Json[];
	const { calls, gotos, page } = fakePage(
		(call) =>
			call.path === "/api/user/collection_list/"
				? ok({
						...COLLECTIONS,
						collectionList: [{ ...list[0], userName: undefined }, list[1]],
					})
				: standardAnswer(call),
		(opened) => ({
			client: true,
			transport: null,
			copied: { "/api/collection/item_list/": opened.length > 0 },
		}),
	);
	const h = harness(
		[
			"favorite_collections",
			{
				name: "collection_items",
				resources: [`${COLLECTION_A}:300001`],
			} as StreamScope,
		],
		page,
	);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.equal(gotos.length, 1);
	assert.deepEqual(
		calls
			.filter((c) => c.path === "/api/collection/item_list/")
			.map((c) => c.params.collectionId),
		[COLLECTION_A],
	);
});

test("review 1: favorite_collections resources limit which collections' videos are read", async () => {
	const { calls, page } = fakePage(standardAnswer);
	const h = harness(
		[
			{
				name: "favorite_collections",
				resources: [COLLECTION_A],
			} as StreamScope,
			"collection_items",
		],
		page,
	);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(
		calls
			.filter((c) => c.path === "/api/collection/item_list/")
			.map((c) => c.params.collectionId),
		[COLLECTION_A],
	);
});

test("review 1: likes that repeat a row are not settled below TikTok's count, however stable", async () => {
	const liked = LIKED.itemList as Json[];
	const { page } = fakePage((call) =>
		call.path === "/api/favorite/item_list/"
			? ok({ ...LIKED, total: 9, itemList: [...liked, liked[0]] })
			: standardAnswer(call),
	);
	const h = harness(["likes"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.equal(h.failures.length, 1);
	assert.match(h.failures[0]?.message ?? "", /^tiktok_list_incomplete/);
	assert.equal(stateOf(h, "likes"), undefined);
});
