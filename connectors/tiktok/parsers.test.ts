// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import type { Page } from "playwright";
import { setConnectorDiagnosticSink } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type {
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { establishSession } from "../../packages/polyfill-connectors/src/session-establish.ts";
import { TerminalError } from "../../packages/polyfill-connectors/src/terminal-error.ts";
import {
	CLIENT_NOT_SEEN,
	checkTikTokSession,
	collectTikTok,
	ensureTikTokSession,
	fetchApi,
	LOGIN_URL,
	PROFILE_URL,
	readSessionState,
	signInReadiness,
	TIKTOK_RETRYABLE_PATTERN,
	type TikTokCollectContext,
	type TikTokPage,
} from "./index.ts";
import { WATCH_EXPRESSION } from "./page-script.ts";
import {
	buildCollectionRecord,
	buildProfileRecord,
	buildSavedVideoRecord,
	buildUserRecord,
	buildVideoRecord,
	envelopeStatus,
	newTextNotes,
	parseAccount,
	parseCollectionPage,
	parseItemPage,
	parseSettings,
	parseUserPage,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

type Json = Record<string, unknown>;

const fixture = (name: string): Json =>
	JSON.parse(
		readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"),
	) as Json;

function assertValid(stream: string, record: RecordData): void {
	const parsed = validateRecord(stream, record);
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
}

// ─── parsers ─────────────────────────────────────────────────────────────

test("the account endpoint gives the owner's id and secUid; a signed-out answer gives none", () => {
	const account = parseAccount(fixture("passport-account-info-v2.json"));
	assert.ok(account);
	assert.equal(account.id, "100007");
	assert.match(account.secUid, /^Synthetic sec_user_id/);
	assert.equal(account.createTime, 1781564161);
	assert.equal(
		parseAccount({
			data: { error_code: 1, description: "Please log in" },
			message: "error",
		}),
		null,
	);
});

test("settings give private_account; a page without settings is not ok", () => {
	assert.deepEqual(parseSettings(fixture("user-settings.json")), {
		ok: true,
		privateAccount: false,
	});
	assert.deepEqual(parseSettings({ statusCode: 0 }), { ok: false });
	assert.equal(envelopeStatus(fixture("user-settings.json")), 0);
	assert.equal(envelopeStatus({ statusCode: 10201 }), 10201);
});

test("an own-videos page becomes video records with V2 counts and privacy", () => {
	const page = parseItemPage(fixture("post-item-list.json"));
	assert.ok(page);
	assert.equal(page.hasMore, false);
	assert.equal(page.cursor, "1781564559000");
	assert.equal(page.items.length, 3);
	assert.equal(page.unreadable, 0);
	const [first] = page.items;
	assert.ok(first);
	const record = buildVideoRecord(first, newTextNotes());
	assert.equal(record.id, "100019");
	assert.equal(record.created_at, "2026-06-20T23:33:58.000Z");
	assert.equal(record.duration_seconds, 52);
	assert.equal(record.privacy, "public");
	assert.equal(record.play_count, 100030);
	assert.equal(record.repost_count, 100031);
	assert.equal(record.save_count, 100027);
	assertValid("videos", record);
});

test("a private or friends-only video says so", () => {
	const page = parseItemPage(fixture("post-item-list.json"));
	assert.ok(page);
	const [first] = page.items;
	assert.ok(first);
	const notes = newTextNotes();
	assert.equal(
		buildVideoRecord({ ...first, privateItem: true }, notes).privacy,
		"private",
	);
	assert.equal(
		buildVideoRecord({ ...first, forFriend: true }, notes).privacy,
		"friends",
	);
});

test("an empty list answers without itemList and still ends", () => {
	const page = parseItemPage(fixture("empty-item-list.json"));
	assert.ok(page);
	assert.equal(page.hasMore, false);
	assert.deepEqual(page.items, []);
	assert.equal(page.total, 0);
});

test("a page without hasMore is unreadable, and a bad item is counted, not emitted", () => {
	assert.equal(parseItemPage({ itemList: [] }), null);
	const page = parseItemPage({
		hasMore: false,
		itemList: [{ id: "not-a-number", createTime: 1 }],
	});
	assert.ok(page);
	assert.equal(page.items.length, 0);
	assert.equal(page.unreadable, 1);
});

test("liked videos keep the author and caption, not the stats", () => {
	const page = parseItemPage(fixture("favorite-item-list.json"));
	assert.ok(page);
	const [first] = page.items;
	assert.ok(first);
	const record = buildSavedVideoRecord(first, newTextNotes());
	assert.equal(record.id, "300001");
	assert.equal(record.author_id, "200001");
	assert.equal(record.author_unique_id, "synthetic_creator_0");
	assert.equal("play_count" in record, false);
	assertValid("likes", record);
	assertValid("favorites", record);
});

test("the user list gives accounts, its cursor and its truncation flag", () => {
	const page = parseUserPage(fixture("user-list.json"));
	assert.ok(page);
	assert.equal(page.hasMore, false);
	assert.equal(page.isTruncated, false);
	assert.equal(page.minCursor, 1783816615);
	assert.equal(page.total, 1);
	const [user] = page.users;
	assert.ok(user);
	const record = buildUserRecord(user, newTextNotes());
	assert.equal(record.id, "100013");
	assert.equal(record.unique_id, "synthetic.follow");
	assertValid("following", record);
	assertValid("followers", record);
});

test("the profile takes counts and handle from the owner's own video", () => {
	const account = parseAccount(fixture("passport-account-info-v2.json"));
	const page = parseItemPage(fixture("post-item-list.json"));
	assert.ok(account && page);
	const record = buildProfileRecord(
		account,
		false,
		page.items[0] ?? null,
		newTextNotes(),
	);
	assert.equal(record.id, "100007");
	assert.equal(record.unique_id, "synthetic_owner");
	assert.equal(record.follower_count, 100011);
	assert.equal(record.video_count, 100016);
	assert.equal(record.private_account, false);
	assert.equal(record.created_at, "2026-06-15T22:56:01.000Z");
	assertValid("profile", record);

	const bare = buildProfileRecord(account, null, null, newTextNotes());
	assert.equal(bare.unique_id, "Synthetic username 8 lorem");
	assert.equal(bare.follower_count, null);
	assertValid("profile", bare);
});

test("unsafe text is stored as null and counted", () => {
	const page = parseItemPage(fixture("post-item-list.json"));
	assert.ok(page);
	const [first] = page.items;
	assert.ok(first);
	const notes = newTextNotes();
	const record = buildVideoRecord({ ...first, desc: "bad\u0000text" }, notes);
	assert.equal(record.caption, null);
	assert.equal(notes.replaced, 1);
});

// ─── collection against a fake page ──────────────────────────────────────

interface Call {
	params: Record<string, string>;
	path: string;
}

type Answer = Json | { kind: string; [key: string]: unknown };

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

interface FakeOptions {
	/** What the page's reader reports: client params held, or off the site. */
	watch?: Json;
	/** The in-page request never completes (as under a strict HAR replay). */
	pageFails?: boolean;
}

function fakePage(
	answer: (call: Call, index: number) => Answer,
	options: FakeOptions = {},
): {
	calls: Call[];
	gotos: string[];
	page: TikTokPage;
} {
	const calls: Call[] = [];
	const gotos: string[] = [];
	const page: TikTokPage = {
		evaluate: async (script: string) => {
			const match = GET_CALL.exec(script);
			if (!match?.[1] || !match[2])
				return (
					options.watch ?? {
						client: true,
						transport: null,
						copied: { "/api/collection/item_list/": true },
					}
				);
			const call: Call = {
				path: JSON.parse(match[1]) as string,
				params: JSON.parse(match[2]) as Record<string, string>,
			};
			if (options.pageFails)
				return { kind: "network_error", transport: "fetch" };
			calls.push(call);
			return answer(call, calls.length - 1);
		},
		goto: async (url: string) => {
			gotos.push(url);
			return null;
		},
	};
	return { calls, gotos, page };
}

function harness(
	streams: string[],
	page: TikTokPage,
	state: Record<string, unknown> = {},
	recovery: {
		detailGaps?: NonNullable<TikTokCollectContext["detailGaps"]>;
		recoveryOnly?: boolean;
	} = {},
) {
	const messages: EmittedMessage[] = [];
	const records: { stream: string; data: RecordData }[] = [];
	const failures: { stream: string; message: string; retryable: boolean }[] =
		[];
	const requested = new Map<string, StreamScope>(
		streams.map((name) => [name, { name } as StreamScope]),
	);
	return {
		messages,
		records,
		failures,
		ctx: {
			collectionMode: "incremental" as const,
			emit: async (message: EmittedMessage) => {
				messages.push(message);
			},
			emitRecord: async (stream: string, data: RecordData) => {
				const valid = validateRecord(stream, data);
				assert.equal(valid.ok, true, JSON.stringify(valid));
				records.push({ stream, data });
				messages.push({ type: "RECORD", stream, data } as EmittedMessage);
			},
			reportStreamFailure: async (
				stream: string,
				message: string,
				options?: { retryable?: boolean },
			) => {
				failures.push({
					stream,
					message,
					retryable: options?.retryable === true,
				});
			},
			page,
			requested,
			state,
			...recovery,
		},
	};
}

const noDelay = { delay: async () => {}, random: () => 0 };

const ACCOUNT = fixture("passport-account-info-v2.json");
const SETTINGS = fixture("user-settings.json");
const POSTS = fixture("post-item-list.json");
const LIKED = fixture("favorite-item-list.json");
const COLLECTIONS = fixture("collection-list.json");
const COLLECTION_ITEMS = fixture("collection-item-list.json");
const USERS = fixture("user-list.json");
const COLLECT = fixture("collect-item-list.json");

function standardAnswer(call: Call): Answer {
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

const ALL = [
	"profile",
	"videos",
	"likes",
	"favorites",
	"following",
	"followers",
];

test("a full run reads every stream from its own path and checkpoints each after its records", async () => {
	const { calls, page } = fakePage(standardAnswer);
	const h = harness(ALL, page);
	await collectTikTok(h.ctx, noDelay);

	assert.deepEqual(h.failures, []);
	assert.deepEqual(
		calls.map((call) => call.path),
		[
			"/passport/account/info/v2/",
			"/api/post/item_list/",
			"/api/user/settings/",
			"/api/favorite/item_list/",
			"/api/user/collect/item_list/",
			"/api/user/list/",
			"/api/user/list/",
		],
	);
	const owner = parseAccount(ACCOUNT);
	assert.ok(owner);
	assert.equal(calls[1]?.params.secUid, owner.secUid);
	assert.equal(calls[1]?.params.cursor, "0");
	assert.equal(calls[5]?.params.scene, "21");
	assert.equal(calls[6]?.params.scene, "67");

	const count = (stream: string) =>
		h.records.filter((record) => record.stream === stream).length;
	assert.equal(count("videos"), 3);
	assert.equal(count("profile"), 1);
	assert.equal(count("likes"), 3);
	assert.equal(count("favorites"), 0);
	assert.equal(count("following"), 1);
	assert.equal(count("followers"), 1);

	// STATE comes after every record of its stream, once.
	for (const stream of ALL) {
		const states = h.messages
			.map((message, index) => ({ message, index }))
			.filter(
				({ message }) => message.type === "STATE" && message.stream === stream,
			);
		assert.equal(states.length, 1, stream);
		const lastRecord = h.messages.findLastIndex(
			(message) => message.type === "RECORD" && message.stream === stream,
		);
		assert.ok((states[0]?.index ?? -1) > lastRecord, stream);
	}
	const likesState = h.messages.find(
		(message) => message.type === "STATE" && message.stream === "likes",
	);
	assert.deepEqual(
		likesState && "cursor" in likesState ? likesState.cursor : null,
		{ count: 3 },
	);
	// No secret-looking value is kept in STATE.
	assert.doesNotMatch(
		JSON.stringify(h.messages.filter((m) => m.type === "STATE")),
		/msToken|X-Bogus|X-Gnarly|device_id|verifyFp/,
	);
});

test("a list pages on TikTok's cursor until hasMore is false", async () => {
	const firstPage = { ...POSTS, hasMore: true, cursor: "1781830907000" };
	const secondPage = {
		...POSTS,
		hasMore: false,
		itemList: (POSTS.itemList as Json[]).map((item, index) => ({
			...item,
			id: String(400001 + index),
		})),
	};
	const { calls, page } = fakePage((call) => {
		if (call.path !== "/api/post/item_list/") return standardAnswer(call);
		return ok(call.params.cursor === "0" ? firstPage : secondPage);
	});
	const h = harness(["videos"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(
		calls
			.filter((c) => c.path === "/api/post/item_list/")
			.map((c) => c.params.cursor),
		["0", "1781830907000"],
	);
	assert.equal(h.records.length, 6);
});

test("a repeated cursor fails the stream and writes no STATE", async () => {
	const looping = { ...POSTS, hasMore: true, cursor: "0" };
	const { page } = fakePage((call) =>
		call.path === "/api/post/item_list/" ? ok(looping) : standardAnswer(call),
	);
	const h = harness(["videos"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.equal(h.failures.length, 1);
	assert.match(h.failures[0]?.message ?? "", /^tiktok_list_incomplete/);
	assert.equal(
		h.messages.some((m) => m.type === "STATE"),
		false,
	);
});

test("an unsigned empty answer stops every stream without STATE", async () => {
	const { page } = fakePage((call) =>
		call.path === "/passport/account/info/v2/"
			? ok(ACCOUNT)
			: { ...ok(null), empty: true, signed: false },
	);
	const h = harness(["videos", "likes"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["videos", "likes"],
	);
	assert.match(h.failures[0]?.message ?? "", /^tiktok_request_unsigned/);
	assert.equal(
		h.messages.some((m) => m.type === "STATE"),
		false,
	);
});

test("a bot-check page stops the run as a challenge, not a retryable error", async () => {
	const { page } = fakePage((call) =>
		call.path === "/passport/account/info/v2/"
			? ok(ACCOUNT)
			: { ...ok(null), status: 403, html: true },
	);
	const h = harness(["videos"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.match(h.failures[0]?.message ?? "", /^tiktok_bot_check/);
});

test("review 1 #5: a 503 HTML page, a cf-mitigated header and a non-JSON body are challenges", async () => {
	const answers = [
		{ ...ok(null), status: 503, html: true },
		{ ...ok({ statusCode: 0 }), challengeHeader: true },
		{ ...ok(null), empty: false, json: null },
	];
	for (const answer of answers) {
		const { calls, page } = fakePage((call) =>
			call.path === "/passport/account/info/v2/" ? ok(ACCOUNT) : answer,
		);
		const h = harness(["videos", "likes"], page);
		await collectTikTok(h.ctx, noDelay);
		assert.deepEqual(
			h.failures.map((f) => [f.stream, f.retryable]),
			[
				["videos", false],
				["likes", false],
			],
			JSON.stringify(answer),
		);
		assert.match(h.failures[0]?.message ?? "", /^tiktok_bot_check/);
		// The run stops: no request after the challenge.
		assert.equal(calls.length, 2);
	}
});

test("a signed-out session throws the auth class", async () => {
	const { page } = fakePage(() =>
		ok({ data: { error_code: 1, description: "log in" }, message: "error" }),
	);
	const h = harness(["videos"], page);
	await assert.rejects(
		collectTikTok(h.ctx, noDelay),
		/^Error: tiktok_auth_failed/,
	);
});

test("review 1 #1: a known id is not an end; likes walk to hasMore:false before STATE", async () => {
	const [i1, i2, i3] = LIKED.itemList as Json[];
	const page1 = {
		...LIKED,
		hasMore: true,
		cursor: "1781900000000",
		itemList: [
			{ ...i1, id: "21" },
			{ ...i2, id: "20" },
			{ ...i3, id: "22" },
		],
	};
	const page2 = {
		...LIKED,
		hasMore: false,
		cursor: "1781800000000",
		itemList: [{ ...i1, id: "23" }],
	};
	const { calls, page } = fakePage((call) =>
		call.path === "/api/favorite/item_list/"
			? ok(call.params.cursor === "0" ? page1 : page2)
			: standardAnswer(call),
	);
	// An old cursor shape from an earlier version must not shorten the walk.
	const h = harness(["likes"], page, { likes: { head_ids: ["20"] } });
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(
		h.records.map((r) => r.data.id),
		["21", "20", "22", "23"],
	);
	assert.deepEqual(
		calls
			.filter((c) => c.path === "/api/favorite/item_list/")
			.map((c) => c.params.cursor),
		["0", "1781900000000"],
	);
	const last = h.messages.at(-1);
	assert.equal(last?.type, "STATE");
	assert.deepEqual(last && "cursor" in last ? last.cursor : null, { count: 4 });
});

test("review 1 #1: likes that end without hasMore:false write no STATE", async () => {
	const looping = { ...LIKED, hasMore: true, cursor: "0" };
	const { page } = fakePage((call) =>
		call.path === "/api/favorite/item_list/"
			? ok(looping)
			: standardAnswer(call),
	);
	const h = harness(["likes"], page, { likes: { head_ids: ["300002"] } });
	await collectTikTok(h.ctx, noDelay);
	assert.match(h.failures[0]?.message ?? "", /^tiktok_list_incomplete/);
	assert.equal(
		h.messages.some((m) => m.type === "STATE"),
		false,
	);
});

test("review 1 #2: a profile-only run does not take an empty page that claims more as zero counts", async () => {
	const { page } = fakePage((call) =>
		call.path === "/api/post/item_list/"
			? ok({ ...POSTS, hasMore: true, total: 31, itemList: [], cursor: "next" })
			: standardAnswer(call),
	);
	const h = harness(["profile"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.equal(h.records.length, 0);
	assert.match(h.failures[0]?.message ?? "", /^tiktok_list_incomplete/);
	assert.equal(
		h.messages.some((m) => m.type === "STATE"),
		false,
	);
});

test("review 1 #2: unreadable own videos or a positive total with none listed fail the profile", async () => {
	for (const answer of [
		{ ...POSTS, hasMore: false, itemList: [{ id: "not-a-number" }] },
		{ ...POSTS, hasMore: false, total: 5, itemList: [] },
	]) {
		const { page } = fakePage((call) =>
			call.path === "/api/post/item_list/" ? ok(answer) : standardAnswer(call),
		);
		const h = harness(["profile"], page);
		await collectTikTok(h.ctx, noDelay);
		assert.equal(h.records.length, 0, JSON.stringify(answer));
		assert.equal(h.failures.length, 1);
		assert.equal(
			h.messages.some((m) => m.type === "STATE"),
			false,
		);
	}
	// A list TikTok proves empty still gives a profile with null counts.
	const { page } = fakePage((call) =>
		call.path === "/api/post/item_list/"
			? ok({ ...POSTS, hasMore: false, total: 0, itemList: [] })
			: standardAnswer(call),
	);
	const h = harness(["profile"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.equal(h.records[0]?.data.follower_count, null);
});

test("review 1 #4: a present caption that is not safe text fails the stream before STATE", async () => {
	const [first, ...rest] = POSTS.itemList as Json[];
	const answer = {
		...POSTS,
		itemList: [{ ...first, desc: "bad\u0000text" }, ...rest],
	};
	const { page } = fakePage((call) =>
		call.path === "/api/post/item_list/" ? ok(answer) : standardAnswer(call),
	);
	const h = harness(["videos"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.equal(
		h.records.some((r) => r.data.id === first?.id),
		false,
		"the unsafe record is not saved with a null caption",
	);
	assert.match(
		h.failures[0]?.message ?? "",
		/^tiktok_source_unreadable: 1 videos entry carries text/,
	);
	assert.equal(
		h.messages.some((m) => m.type === "STATE"),
		false,
	);
});

test("a truncated follower list fails rather than reports complete", async () => {
	const { page } = fakePage((call) =>
		call.path === "/api/user/list/"
			? ok({ ...USERS, isTruncated: true })
			: standardAnswer(call),
	);
	const h = harness(["followers"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.equal(h.records.length, 1);
	assert.match(h.failures[0]?.message ?? "", /cut this list short/);
	assert.equal(
		h.messages.some((m) => m.type === "STATE"),
		false,
	);
});

test("a list that counts items but returns none fails", async () => {
	const { page } = fakePage((call) =>
		call.path === "/api/user/collect/item_list/"
			? ok({ ...COLLECT, total: 4 })
			: standardAnswer(call),
	);
	const h = harness(["favorites"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.match(h.failures[0]?.message ?? "", /counted 4 favorites/);
});

test("a non-zero status code fails only that stream", async () => {
	const { page } = fakePage((call) =>
		call.path === "/api/favorite/item_list/"
			? ok({ statusCode: 10201, status_msg: "" })
			: standardAnswer(call),
	);
	const h = harness(["likes", "following"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["likes"],
	);
	assert.equal(h.records.filter((r) => r.stream === "following").length, 1);
});

test("live shape: an empty Favorites list (no itemList key) ends on hasMore:false", async () => {
	const { page } = fakePage(standardAnswer);
	const h = harness(["favorites"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.equal(h.records.length, 0);
	const state = h.messages.find((m) => m.type === "STATE");
	assert.deepEqual(state && "cursor" in state ? state.cursor : null, {
		count: 0,
	});
});

const asRecord = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null
		? Object.fromEntries(Object.entries(value))
		: {};

const COLLECTION_A = "7400000000000000001";
const COLLECTION_B = "7400000000000000002";
const BOTH = ["favorite_collections", "collection_items"];

const typeIndex = (
	h: { messages: EmittedMessage[] },
	type: string,
	stream?: string,
) =>
	h.messages.findIndex(
		(m) =>
			m.type === type &&
			(stream === undefined || ("stream" in m && m.stream === stream)),
	);

test("live shape: collection_list entries carry string totals and become collection records", () => {
	const page = parseCollectionPage(COLLECTIONS);
	assert.ok(page);
	assert.equal(page.listed, true);
	assert.equal(page.collections.length, 2);
	const [first] = page.collections;
	assert.ok(first);
	const record = buildCollectionRecord(first, newTextNotes());
	assert.deepEqual(record, {
		id: COLLECTION_A,
		name: "Synthetic recipes",
		item_count: 2,
	});
	assertValid("favorite_collections", record);
	assert.equal("cover" in record, false);
});

test("review 3: collections and their videos: parent first, every collection hydrated, coverage before the checkpoints", async () => {
	const { calls, page } = fakePage(standardAnswer);
	const h = harness(BOTH, page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	const parents = h.records.filter((r) => r.stream === "favorite_collections");
	const children = h.records.filter((r) => r.stream === "collection_items");
	assert.deepEqual(
		parents.map((r) => r.data.id),
		[COLLECTION_A, COLLECTION_B],
	);
	assert.deepEqual(
		children.map((r) => r.data.id),
		[
			`${COLLECTION_A}:300001`,
			`${COLLECTION_A}:300002`,
			`${COLLECTION_B}:300001`,
			`${COLLECTION_B}:300002`,
		],
	);
	assert.equal(children[0]?.data.collection_id, COLLECTION_A);
	assert.equal(children[0]?.data.video_id, "300001");
	const itemCalls = calls.filter(
		(c) => c.path === "/api/collection/item_list/",
	);
	assert.deepEqual(
		itemCalls.map((c) => [c.params.collectionId, c.params.cursor]),
		[
			[COLLECTION_A, "0"],
			[COLLECTION_B, "0"],
		],
	);
	assert.equal(
		"sourceType" in (itemCalls[0]?.params ?? {}),
		false,
		"copied in the page, never set by the connector",
	);
	const lastParent = h.messages.findLastIndex(
		(m) => m.type === "RECORD" && m.stream === "favorite_collections",
	);
	const firstChild = typeIndex(h, "RECORD", "collection_items");
	const coverage = typeIndex(h, "DETAIL_COVERAGE", "collection_items");
	assert.ok(lastParent < firstChild);
	assert.ok(coverage > h.messages.findLastIndex((m) => m.type === "RECORD"));
	assert.ok(typeIndex(h, "STATE", "favorite_collections") > coverage);
	assert.ok(typeIndex(h, "STATE", "collection_items") > coverage);
	const message = asRecord(h.messages[coverage]);
	assert.deepEqual(message.required_keys, [COLLECTION_A, COLLECTION_B]);
	assert.deepEqual(message.hydrated_keys, [COLLECTION_A, COLLECTION_B]);
	assert.equal(message.state_stream, "favorite_collections");
});

test("review 3: a collection's videos page to hasMore:false; a repeated cursor is a gap for that collection only", async () => {
	const page1 = { ...COLLECTION_ITEMS, hasMore: true, cursor: "c1" };
	const page2 = {
		...COLLECTION_ITEMS,
		hasMore: false,
		itemList: [{ ...(COLLECTION_ITEMS.itemList as Json[])[0], id: "300009" }],
	};
	const looping = { ...COLLECTION_ITEMS, hasMore: true, cursor: "0" };
	const { calls, page } = fakePage((call) => {
		if (call.path !== "/api/collection/item_list/") return standardAnswer(call);
		if (call.params.collectionId === COLLECTION_B) return ok(looping);
		return ok(call.params.cursor === "0" ? page1 : page2);
	});
	const h = harness(BOTH, page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(
		calls
			.filter((c) => c.params.collectionId === COLLECTION_A)
			.map((c) => c.params.cursor),
		// A multi-page list is read twice and kept once both reads agree.
		["0", "c1", "0", "c1"],
	);
	assert.deepEqual(
		h.records
			.filter((r) => r.stream === "collection_items")
			.map((r) => r.data.video_id),
		// Nothing of the gapped collection is emitted.
		["300001", "300002", "300009"],
	);
	const gap = asRecord(h.messages.find((m) => m.type === "DETAIL_GAP"));
	assert.equal(gap.record_key, COLLECTION_B);
	assert.equal(gap.parent_stream, "favorite_collections");
	const coverage = asRecord(
		h.messages.find((m) => m.type === "DETAIL_COVERAGE"),
	);
	assert.deepEqual(coverage.hydrated_keys, [COLLECTION_A]);
	assert.deepEqual(coverage.gap_keys, [COLLECTION_B]);
	assert.ok(typeIndex(h, "DETAIL_GAP") < typeIndex(h, "DETAIL_COVERAGE"));
});

test("review 3: without the app's own sourceType the connector opens the collection page once and never guesses", async () => {
	const { calls, gotos, page } = fakePage(standardAnswer, {
		watch: {
			client: true,
			transport: null,
			copied: { "/api/collection/item_list/": false },
		},
	});
	const h = harness(BOTH, page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(gotos, [
		`https://www.tiktok.com/@synthetic_owner/collection/Synthetic%20recipes-${COLLECTION_A}`,
	]);
	assert.equal(
		calls.some((c) => c.path === "/api/collection/item_list/"),
		false,
	);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["collection_items"],
	);
	assert.match(h.failures[0]?.message ?? "", /^tiktok_app_value_not_seen/);
	assert.equal(
		h.records.filter((r) => r.stream === "collection_items").length,
		0,
	);
	assert.equal(typeIndex(h, "DETAIL_COVERAGE"), -1);
	assert.ok(typeIndex(h, "STATE", "favorite_collections") >= 0);
});

test("review 3: a challenge inside a collection stops the run with no coverage and no parent checkpoint", async () => {
	const { page } = fakePage((call) =>
		call.path === "/api/collection/item_list/"
			? { ...ok(null), status: 403, html: true }
			: standardAnswer(call),
	);
	const h = harness(BOTH, page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		BOTH,
	);
	assert.equal(typeIndex(h, "DETAIL_COVERAGE"), -1);
	assert.equal(
		h.messages.some((m) => m.type === "STATE"),
		false,
	);
});

test("review 3: a recovery-only run retries just the gapped collection", async () => {
	const { calls, page } = fakePage(standardAnswer);
	const h = harness(
		BOTH,
		page,
		{},
		{
			recoveryOnly: true,
			detailGaps: [
				{
					gap_id: "g1",
					status: "pending",
					stream: "collection_items",
					parent_stream: "favorite_collections",
					record_key: COLLECTION_B,
					detail_locator: {
						kind: "tiktok.collection",
						collection_id: COLLECTION_B,
						name: "Synthetic travel",
						user_name: "synthetic_owner",
					},
				},
			],
		},
	);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(
		calls.map((c) => [c.path, c.params.collectionId ?? null]),
		[
			["/passport/account/info/v2/", null],
			["/api/user/collection_list/", null],
			["/api/collection/item_list/", COLLECTION_B],
		],
	);
	const coverage = asRecord(
		h.messages.find((m) => m.type === "DETAIL_COVERAGE"),
	);
	assert.deepEqual(coverage.required_keys, [COLLECTION_B]);
	assert.deepEqual(coverage.hydrated_keys, [COLLECTION_B]);
	// review 4 #1: the recovered collection's parent comes before its videos.
	assert.deepEqual(
		h.records.map((r) => [r.stream, r.data.id]),
		[
			["favorite_collections", COLLECTION_B],
			["collection_items", `${COLLECTION_B}:300001`],
			["collection_items", `${COLLECTION_B}:300002`],
		],
	);
	// review 4 #3: the retried gap is acknowledged.
	const recovered = asRecord(
		h.messages.find((m) => m.type === "DETAIL_GAP_RECOVERED"),
	);
	assert.equal(recovered.gap_id, "g1");
	assert.equal(recovered.record_key, COLLECTION_B);
});

test("live shape (before any collection): total 1 without a list key reads as no collections", async () => {
	const { page } = fakePage((call) =>
		call.path === "/api/user/collection_list/"
			? ok({ ...COLLECTIONS, collectionList: undefined, total: 1 })
			: standardAnswer(call),
	);
	const h = harness(BOTH, page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.equal(h.records.length, 0);
	const coverage = asRecord(
		h.messages.find((m) => m.type === "DETAIL_COVERAGE"),
	);
	assert.deepEqual(coverage.required_keys, []);
});

test("review 2 #5: a plain-text 503 (or any non-JSON body) is a challenge, not a retryable server error", async () => {
	for (const status of [503, 500, 200, 429]) {
		const { calls, page } = fakePage((call) =>
			call.path === "/passport/account/info/v2/"
				? ok(ACCOUNT)
				: { ...ok(null), status, html: false, empty: false, json: null },
		);
		const h = harness(["videos", "likes"], page);
		await collectTikTok(h.ctx, noDelay);
		assert.deepEqual(
			h.failures.map((f) => [f.stream, f.retryable]),
			[
				["videos", false],
				["likes", false],
			],
			String(status),
		);
		assert.match(h.failures[0]?.message ?? "", /^tiktok_bot_check/);
		assert.equal(calls.length, 2);
	}
	// An empty 503 stays a retryable server error.
	const { page } = fakePage((call) =>
		call.path === "/passport/account/info/v2/"
			? ok(ACCOUNT)
			: { ...ok(null), status: 503, empty: true },
	);
	const h = harness(["videos"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(
		h.failures.map((f) => f.retryable),
		[true],
	);
	assert.match(h.failures[0]?.message ?? "", /^tiktok_server_error/);
});

test("review 2 #2: the profile follows the cursor past videos without the owner's counts", async () => {
	const [first, second, third] = POSTS.itemList as Json[];
	const stranger = {
		...(first as Json),
		author: { id: "999", uniqueId: "someone_else" },
	};
	const noStats = {
		...(second as Json),
		authorStats: undefined,
		authorStatsV2: undefined,
	};
	const page1 = {
		...POSTS,
		hasMore: true,
		cursor: "next",
		itemList: [stranger, noStats],
	};
	const page2 = { ...POSTS, hasMore: false, cursor: "end", itemList: [third] };
	const { calls, page } = fakePage((call) =>
		call.path === "/api/post/item_list/"
			? ok(call.params.cursor === "0" ? page1 : page2)
			: standardAnswer(call),
	);
	const h = harness(["profile"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(
		calls
			.filter((c) => c.path === "/api/post/item_list/")
			.map((c) => c.params.cursor),
		["0", "next"],
	);
	const thirdStats = (third as { authorStatsV2: { followerCount: string } })
		.authorStatsV2;
	assert.equal(
		h.records[0]?.data.follower_count,
		Number(thirdStats.followerCount),
	);
	assert.equal(h.records[0]?.data.unique_id, "synthetic_owner");
});

test("review 2 #2: listed videos none of which carry the owner's counts fail the profile", async () => {
	const [first] = POSTS.itemList as Json[];
	const stranger = { ...(first as Json), author: { id: "999" } };
	for (const streams of [["profile"], ["videos", "profile"]]) {
		const { page } = fakePage((call) =>
			call.path === "/api/post/item_list/"
				? ok({ ...POSTS, hasMore: false, itemList: [stranger] })
				: standardAnswer(call),
		);
		const h = harness(streams, page);
		await collectTikTok(h.ctx, noDelay);
		assert.equal(
			h.records.some((r) => r.stream === "profile"),
			false,
			streams.join(),
		);
		assert.deepEqual(
			h.failures.map((f) => f.stream),
			["profile"],
		);
		assert.match(h.failures[0]?.message ?? "", /carried the profile counts/);
	}
});

test("the session probe waits for the page's first request instead of reading it as signed out", async () => {
	const { calls, gotos, page } = fakePage(standardAnswer);
	let watches = 0;
	const slowPage: TikTokPage = {
		...page,
		evaluate: async (script, arg, options, isolated) => {
			if (!GET_CALL.test(script)) {
				watches += 1;
				return { client: watches > 3, transport: null };
			}
			return page.evaluate(script, arg, options, isolated);
		},
	};
	assert.equal(await checkTikTokSession(slowPage, noDelay.delay), "signed_in");
	assert.ok(watches > 3);
	assert.deepEqual(gotos, []);
	assert.deepEqual(
		calls.map((c) => c.path),
		["/passport/account/info/v2/"],
	);
});

// ─── live run 2026-10-22 (favorites 7 items, collections) ────────────────

test("live keys: items without challenges, textExtra, poi, stickersOnItem or diversificationId, with imagePost null, are read", async () => {
	const base = (LIKED.itemList as Json[])[0] as Json;
	const rich = {
		...base,
		challenges: [{ id: "1", title: "synthetic" }],
		textExtra: [{ hashtagName: "synthetic", start: 0, end: 10, type: 1 }],
		poi: { id: "1" },
		stickersOnItem: [{ stickerType: 4 }],
		diversificationId: 10045,
		imagePost: null,
	};
	const bare = Object.fromEntries(
		Object.entries({ ...base, imagePost: null }).filter(
			([key]) => key !== "diversificationId",
		),
	);
	const items = [
		...Array.from({ length: 6 }, (_, i) => ({
			...rich,
			id: String(310001 + i),
		})),
		{ ...bare, id: "310007" },
	];
	const { page } = fakePage((call) =>
		call.path === "/api/user/collect/item_list/"
			? ok({ ...COLLECT, total: 7, itemList: items })
			: standardAnswer(call),
	);
	const h = harness(["favorites"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.equal(h.records.length, 7);
});

test("live run: a context field in another type is dropped to null, not the whole favorite", async () => {
	const base = (LIKED.itemList as Json[])[0] as Json;
	const odd = {
		...base,
		id: "310008",
		author: { ...(base.author as Json), id: "" },
		stats: { ...(base.stats as Json), playCount: 1.5 },
	};
	const parsed = parseItemPage({ ...COLLECT, itemList: [odd] });
	assert.ok(parsed);
	assert.equal(parsed.unreadable, 0);
	assert.deepEqual(parsed.dropped, ["author.id", "stats.playCount"]);
	const [item] = parsed.items;
	assert.ok(item);
	const record = buildSavedVideoRecord(item, newTextNotes());
	assert.equal(record.author_id, null);
	assert.equal(record.author_unique_id, "synthetic_creator_0");
	assertValid("favorites", record);
});

test("live run: an item whose id, time or caption is unreadable still fails, naming the fields", async () => {
	const base = (LIKED.itemList as Json[])[0] as Json;
	const { page } = fakePage((call) =>
		call.path === "/api/user/collect/item_list/"
			? ok({ ...COLLECT, itemList: [{ ...base, desc: 42 }] })
			: standardAnswer(call),
	);
	const h = harness(["favorites"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.match(
		h.failures[0]?.message ?? "",
		/^tiktok_source_unreadable: 1 favorites entry did not match the recorded shape \(fields: desc\)/,
	);
});

test("count above listed: a collection counting five videos that lists two on a confirmed walk is hydrated", async () => {
	const { calls, page } = fakePage((call) =>
		call.path === "/api/user/collection_list/"
			? ok({
					...COLLECTIONS,
					collectionList: (COLLECTIONS.collectionList as Json[]).map((c) => ({
						...c,
						total: "5",
					})),
				})
			: standardAnswer(call),
	);
	const h = harness(BOTH, page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.equal(
		h.records.filter((r) => r.stream === "collection_items").length,
		4,
	);
	// Each short single-page list is read a second time to confirm it.
	assert.equal(
		calls.filter((c) => c.path === "/api/collection/item_list/").length,
		4,
	);
	assert.equal(typeIndex(h, "DETAIL_GAP"), -1);
	const coverage = asRecord(
		h.messages.find((m) => m.type === "DETAIL_COVERAGE"),
	);
	assert.deepEqual(coverage.hydrated_keys, [COLLECTION_A, COLLECTION_B]);
	assert.deepEqual(coverage.gap_keys ?? [], []);
	assert.ok(
		typeIndex(h, "STATE", "collection_items") > typeIndex(h, "DETAIL_COVERAGE"),
	);
	const state = asRecord(
		h.messages.find(
			(m) => m.type === "STATE" && m.stream === "collection_items",
		),
	);
	assert.deepEqual(state.cursor, { collections: 2, items: 4 });
});

// ─── TikTok counts more than its list returns ────────────────────────────

/**
 * The owner's live shape, synthetic values: TikTok counts 3 collections (the
 * count also holds one its list never returns), lists 2 on one page with
 * hasMore:false, and the 2 hold 3 videos.
 */
function countedThreeListedTwo(
	collectionPage: (call: Call) => Json = () => ({}),
) {
	const [a, b] = collectionRows();
	const [first, second] = itemRows();
	return fakePage((call) => {
		if (call.path === "/api/user/collection_list/")
			return ok({
				...COLLECTIONS,
				total: 3,
				collectionList: [
					{ ...a, total: "2" },
					{ ...b, total: "1" },
				],
				hasMore: false,
				...collectionPage(call),
			});
		if (call.path === "/api/collection/item_list/")
			return ok({
				...COLLECTION_ITEMS,
				itemList:
					call.params.collectionId === COLLECTION_A
						? [first, second]
						: [{ ...first, id: "7500000000000000099" }],
				hasMore: false,
			});
		return standardAnswer(call);
	});
}

test("count above listed: 3 counted, 2 listed and hasMore:false completes both streams and reads their videos", async () => {
	const lines: string[] = [];
	setConnectorDiagnosticSink((line) => lines.push(line));
	try {
		const { calls, page } = countedThreeListedTwo();
		const h = harness(BOTH, page);
		await collectTikTok(h.ctx, noDelay);
		assert.deepEqual(h.failures, []);
		assert.deepEqual(
			h.records
				.filter((r) => r.stream === "favorite_collections")
				.map((r) => r.data.id),
			[COLLECTION_A, COLLECTION_B],
		);
		assert.equal(
			h.records.filter((r) => r.stream === "collection_items").length,
			3,
		);
		// The short list is read twice and must hold the same ids both times.
		assert.equal(
			calls.filter((c) => c.path === "/api/user/collection_list/").length,
			2,
		);
		const coverage = asRecord(
			h.messages.find((m) => m.type === "DETAIL_COVERAGE"),
		);
		assert.deepEqual(coverage.hydrated_keys, [COLLECTION_A, COLLECTION_B]);
		assert.deepEqual(coverage.gap_keys ?? [], []);
		assert.equal(typeIndex(h, "DETAIL_GAP"), -1);
		const parentState = asRecord(
			h.messages.find(
				(m) => m.type === "STATE" && m.stream === "favorite_collections",
			),
		);
		assert.deepEqual(parentState.cursor, { count: 2 });
		const childState = asRecord(
			h.messages.find(
				(m) => m.type === "STATE" && m.stream === "collection_items",
			),
		);
		assert.deepEqual(childState.cursor, { collections: 2, items: 3 });
		assert.ok(
			typeIndex(h, "STATE", "collection_items") >
				typeIndex(h, "DETAIL_COVERAGE"),
		);
		// The mismatch is a diagnostic with counts only, never names or ids.
		const diagnostic = lines.filter((l) => l.includes("count_above_listed"));
		assert.deepEqual(diagnostic, [
			'[tiktok-diagnostic] count_above_listed {"stream":"favorite_collections","counted":3,"read":2}',
		]);
	} finally {
		setConnectorDiagnosticSink(undefined);
	}
});

test("count above listed: a walk that stops without hasMore:false still fails both streams", async () => {
	const { calls, page } = countedThreeListedTwo(() => ({
		hasMore: true,
		cursor: "0",
	}));
	const h = harness(BOTH, page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		BOTH,
	);
	for (const failure of h.failures)
		assert.match(failure.message, /^tiktok_list_incomplete: /);
	assert.equal(typeIndex(h, "STATE"), -1);
	assert.equal(typeIndex(h, "DETAIL_COVERAGE"), -1);
	assert.equal(h.records.length, 0);
	assert.equal(
		calls.some((c) => c.path === "/api/collection/item_list/"),
		false,
	);
});

test("count above listed: a short list that reads differently every time still fails", async () => {
	let read = 0;
	const { page } = countedThreeListedTwo(() => {
		read += 1;
		return {
			collectionList: [
				{ ...collectionRows()[0], collectionId: `74000000000000009${read}` },
			],
		};
	});
	const h = harness(BOTH, page);
	await collectTikTok(h.ctx, noDelay);
	assert.match(h.failures[0]?.message ?? "", /changed on every read/);
	assert.equal(typeIndex(h, "STATE"), -1);
	assert.equal(typeIndex(h, "DETAIL_COVERAGE"), -1);
});

// ─── review round 4 ──────────────────────────────────────────────────────

const pendingGap = (gapId: string, collectionId: string, leaseId?: string) => ({
	gap_id: gapId,
	status: "pending" as const,
	stream: "collection_items",
	parent_stream: "favorite_collections",
	record_key: collectionId,
	...(leaseId ? { lease_id: leaseId } : {}),
	detail_locator: {
		kind: "tiktok.collection",
		collection_id: collectionId,
		name: "Synthetic",
		user_name: "synthetic_owner",
	},
});

test("count above listed: a collections list that repeats a row is not complete, even when the rows are fewer than counted", async () => {
	const [a] = collectionRows();
	const { page } = fakePage((call) =>
		call.path === "/api/user/collection_list/"
			? ok({
					...COLLECTIONS,
					total: 5,
					collectionList: [a, a],
					hasMore: false,
				})
			: standardAnswer(call),
	);
	const h = harness(BOTH, page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		BOTH,
	);
	for (const failure of h.failures)
		assert.match(failure.message, /^tiktok_list_incomplete: /);
	assert.equal(typeIndex(h, "STATE", "favorite_collections"), -1);
	assert.equal(typeIndex(h, "STATE", "collection_items"), -1);
	assert.equal(typeIndex(h, "DETAIL_COVERAGE"), -1);
});

test("count above listed: a collection's videos that repeat a row keep its gap open, even when the rows are fewer than counted", async () => {
	const [first] = itemRows();
	const { page } = fakePage((call) => {
		if (call.path === "/api/user/collection_list/")
			return ok({
				...COLLECTIONS,
				total: 1,
				collectionList: [{ ...collectionRows()[0], total: "5" }],
				hasMore: false,
			});
		if (call.path === "/api/collection/item_list/")
			return ok({
				...COLLECTION_ITEMS,
				total: 5,
				itemList: [first, first],
				hasMore: false,
			});
		return standardAnswer(call);
	});
	const h = harness(
		BOTH,
		page,
		{},
		{ detailGaps: [pendingGap("gA", COLLECTION_A)] },
	);
	await collectTikTok(h.ctx, noDelay);
	assert.equal(typeIndex(h, "DETAIL_GAP_RECOVERED"), -1);
	const gap = asRecord(h.messages.find((m) => m.type === "DETAIL_GAP"));
	assert.equal(gap.record_key, COLLECTION_A);
	const coverage = asRecord(
		h.messages.find((m) => m.type === "DETAIL_COVERAGE"),
	);
	assert.deepEqual(coverage.hydrated_keys, []);
	assert.deepEqual(coverage.gap_keys, [COLLECTION_A]);
	// The collection's checkpoint does not count it as read.
	const state = asRecord(
		h.messages.find(
			(m) => m.type === "STATE" && m.stream === "collection_items",
		),
	);
	assert.deepEqual(state.cursor, { collections: 0, items: 0 });
});

test("review 4 #1: collection_items without favorite_collections emits no child and fails visibly", async () => {
	for (const recoveryOnly of [false, true]) {
		const { calls, page } = fakePage(standardAnswer);
		const h = harness(
			["collection_items"],
			page,
			{},
			{
				recoveryOnly,
				detailGaps: [pendingGap("g1", COLLECTION_A)],
			},
		);
		await collectTikTok(h.ctx, noDelay);
		assert.equal(h.records.length, 0, String(recoveryOnly));
		assert.equal(typeIndex(h, "DETAIL_COVERAGE"), -1);
		assert.equal(
			h.messages.some((m) => m.type === "STATE"),
			false,
		);
		assert.deepEqual(
			h.failures.map((f) => f.stream),
			["collection_items"],
		);
		assert.match(
			h.failures[0]?.message ?? "",
			/^tiktok_parent_stream_required/,
		);
		assert.equal(
			calls.some((c) => c.path.includes("collection")),
			false,
		);
	}
});

test("review 4 #2: an unsafe collection name stops both streams before any child or coverage", async () => {
	const { calls, page } = fakePage((call) =>
		call.path === "/api/user/collection_list/"
			? ok({
					...COLLECTIONS,
					collectionList: (COLLECTIONS.collectionList as Json[]).map((c, i) =>
						i === 1 ? { ...c, name: "bad\u0000name" } : c,
					),
				})
			: standardAnswer(call),
	);
	const h = harness(BOTH, page);
	await collectTikTok(h.ctx, noDelay);
	assert.equal(h.records.length, 0);
	assert.equal(typeIndex(h, "DETAIL_COVERAGE"), -1);
	assert.equal(
		h.messages.some((m) => m.type === "STATE"),
		false,
	);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		BOTH,
	);
	assert.equal(
		calls.some((c) => c.path === "/api/collection/item_list/"),
		false,
	);
});

test("review 4 #3: an ordinary run acknowledges recovered gaps, re-gaps failing ones and settles deleted ones", async () => {
	const looping = { ...COLLECTION_ITEMS, hasMore: true, cursor: "0" };
	const { page } = fakePage((call) =>
		call.path === "/api/collection/item_list/" &&
		call.params.collectionId === COLLECTION_B
			? ok(looping)
			: standardAnswer(call),
	);
	const h = harness(
		BOTH,
		page,
		{},
		{
			detailGaps: [
				pendingGap("gA", COLLECTION_A, "lease-a"),
				pendingGap("gB", COLLECTION_B),
				pendingGap("gGone", "7400000000000000099"),
			],
		},
	);
	await collectTikTok(h.ctx, noDelay);
	const recovered = h.messages
		.filter((m) => m.type === "DETAIL_GAP_RECOVERED")
		.map((m) => asRecord(m));
	assert.deepEqual(
		recovered.map((m) => [m.gap_id, m.record_key, m.lease_id ?? null]),
		[
			["gA", COLLECTION_A, "lease-a"],
			["gGone", "7400000000000000099", null],
		],
	);
	const gaps = h.messages
		.filter((m) => m.type === "DETAIL_GAP")
		.map((m) => asRecord(m));
	assert.deepEqual(
		gaps.map((g) => g.record_key),
		[COLLECTION_B],
	);
	const coverageAt = typeIndex(h, "DETAIL_COVERAGE");
	assert.ok(typeIndex(h, "DETAIL_GAP_RECOVERED") < coverageAt);
	const lastRecordA = h.messages.findLastIndex(
		(m) =>
			m.type === "RECORD" &&
			"data" in m &&
			asRecord(m.data).collection_id === COLLECTION_A,
	);
	assert.ok(lastRecordA < typeIndex(h, "DETAIL_GAP_RECOVERED"));
});

test("review 4 #4: a multi-page collection list is re-read until two reads agree", async () => {
	const [first, second] = COLLECTIONS.collectionList as Json[];
	const third = {
		...(first as Json),
		collectionId: "7400000000000000003",
		name: "Synthetic third",
	};
	// Read 1: the offset page repeats `first` (the list moved) and misses `third`.
	// Reads 2 and 3: the settled list.
	const answers: Record<string, Json[]> = {
		"1:0": [first as Json, second as Json],
		"1:2": [second as Json],
		"2:0": [third, first as Json],
		"2:2": [second as Json],
		"3:0": [third, first as Json],
		"3:2": [second as Json],
	};
	let read = 0;
	const { calls, page } = fakePage((call) => {
		if (call.path !== "/api/user/collection_list/") return standardAnswer(call);
		if (call.params.cursor === "0") read += 1;
		const list = answers[`${read}:${call.params.cursor}`] ?? [];
		const more = call.params.cursor === "0";
		return ok({
			...COLLECTIONS,
			collectionList: list,
			hasMore: more,
			cursor: more ? "2" : "3",
		});
	});
	const h = harness(["favorite_collections"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.equal(
		calls.filter((c) => c.path === "/api/user/collection_list/").length,
		6,
	);
	assert.deepEqual(
		h.records.map((r) => r.data.id).sort(),
		[COLLECTION_A, COLLECTION_B, "7400000000000000003"].sort(),
	);
});

test("review 4 #4: a list that never reads the same twice fails without STATE", async () => {
	const [first] = COLLECTIONS.collectionList as Json[];
	let read = 0;
	const { page } = fakePage((call) => {
		if (call.path !== "/api/user/collection_list/") return standardAnswer(call);
		if (call.params.cursor === "0") read += 1;
		const more = call.params.cursor === "0";
		const entry = {
			...(first as Json),
			collectionId: `74000000000000001${read}${more ? 0 : 1}`,
		};
		return ok({
			...COLLECTIONS,
			collectionList: [entry],
			hasMore: more,
			cursor: more ? "1" : "2",
		});
	});
	const h = harness(["favorite_collections"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.match(h.failures[0]?.message ?? "", /changed on every read/);
	assert.equal(
		h.messages.some((m) => m.type === "STATE"),
		false,
	);
	assert.equal(h.records.length, 0);
});

// ─── reported totals are not replaced by terminal-page evidence ──────────

const collectionRows = () => {
	assert.ok(Array.isArray(COLLECTIONS.collectionList));
	return COLLECTIONS.collectionList.map(asRecord);
};

const itemRows = () => {
	assert.ok(Array.isArray(COLLECTION_ITEMS.itemList));
	return COLLECTION_ITEMS.itemList.map(asRecord);
};

test("completeness: withheld and duplicate child rows cannot satisfy parent or item totals", async () => {
	for (const source of ["parent", "items"]) {
		for (const listed of [[], [itemRows()[0], itemRows()[0]]]) {
			const { page } = fakePage((call) => {
				if (call.path === "/api/user/collection_list/")
					return ok({
						...COLLECTIONS,
						total: 1,
						collectionList: [
							{
								...collectionRows()[0],
								total: source === "parent" ? "2" : undefined,
							},
						],
					});
				if (call.path === "/api/collection/item_list/")
					return ok({
						...COLLECTION_ITEMS,
						total: source === "items" ? 2 : undefined,
						itemList: listed,
					});
				return standardAnswer(call);
			});
			const h = harness(
				BOTH,
				page,
				{},
				{ detailGaps: [pendingGap("gA", COLLECTION_A)] },
			);
			await collectTikTok(h.ctx, noDelay);
			assert.deepEqual(h.failures, []);
			assert.equal(
				h.records.filter((r) => r.stream === "collection_items").length,
				listed.length === 0 ? 0 : 1,
			);
			assert.equal(typeIndex(h, "DETAIL_GAP_RECOVERED"), -1);
			const gap = asRecord(h.messages.find((m) => m.type === "DETAIL_GAP"));
			assert.equal(gap.record_key, COLLECTION_A);
			assert.equal(gap.reason, "temporary_unavailable");
			const coverage = asRecord(
				h.messages.find((m) => m.type === "DETAIL_COVERAGE"),
			);
			assert.deepEqual(coverage.hydrated_keys, []);
			assert.deepEqual(coverage.gap_keys, [COLLECTION_A]);
			assert.ok(
				typeIndex(h, "STATE", "collection_items") >
					typeIndex(h, "DETAIL_COVERAGE"),
			);
		}
	}
});

test("completeness: a pending child gap recovers once its videos are read to a confirmed end, even below TikTok's count", async () => {
	for (const recoveryOnly of [false, true]) {
		const pending = [pendingGap("gA", COLLECTION_A, "lease-a")];
		for (const count of [2, 5]) {
			const { page } = fakePage((call) => {
				if (call.path === "/api/user/collection_list/")
					return ok({
						...COLLECTIONS,
						total: 1,
						collectionList: [{ ...collectionRows()[0], total: "5" }],
					});
				if (call.path === "/api/collection/item_list/")
					return ok({
						...COLLECTION_ITEMS,
						total: 5,
						itemList: Array.from({ length: count }, (_, i) => ({
							...itemRows()[0],
							id: String(310001 + i),
						})),
					});
				return standardAnswer(call);
			});
			const h = harness(BOTH, page, {}, { recoveryOnly, detailGaps: pending });
			await collectTikTok(h.ctx, noDelay);
			assert.deepEqual(h.failures, []);
			assert.equal(
				h.records.filter((r) => r.stream === "collection_items").length,
				count,
			);
			const coverage = asRecord(
				h.messages.find((m) => m.type === "DETAIL_COVERAGE"),
			);
			assert.deepEqual(coverage.hydrated_keys, [COLLECTION_A]);
			assert.deepEqual(coverage.gap_keys ?? [], []);
			const recovered = h.messages
				.filter((m) => m.type === "DETAIL_GAP_RECOVERED")
				.map(asRecord);
			assert.deepEqual(
				recovered.map((m) => [m.gap_id, m.record_key, m.lease_id]),
				[["gA", COLLECTION_A, "lease-a"]],
			);
			assert.equal(typeIndex(h, "DETAIL_GAP"), -1);
			const state = asRecord(
				h.messages.find(
					(m) => m.type === "STATE" && m.stream === "collection_items",
				),
			);
			assert.deepEqual(state.cursor, { collections: 1, items: count });
			assert.ok(
				typeIndex(h, "STATE", "collection_items") >
					typeIndex(h, "DETAIL_COVERAGE"),
			);
			const child = h.messages.find(
				(m) =>
					m.type === "RECORD" &&
					"stream" in m &&
					m.stream === "collection_items",
			);
			assert.ok(child && "data" in child);
			const parentId = asRecord(child.data).collection_id;
			const parentAt = h.messages.findIndex(
				(m) =>
					m.type === "RECORD" &&
					"stream" in m &&
					m.stream === "favorite_collections" &&
					"data" in m &&
					asRecord(m.data).id === parentId,
			);
			assert.ok(parentAt >= 0, "the first child's parent is emitted");
			assert.ok(parentAt < h.messages.indexOf(child));
		}
	}
});

test("completeness: short or duplicate terminal follower inventories retain records without STATE", async () => {
	assert.ok(Array.isArray(USERS.userList));
	const user = asRecord(USERS.userList[0]);
	for (const userList of [[user], [user, user]]) {
		const { page } = fakePage((call) =>
			call.path === "/api/user/list/"
				? ok({ ...USERS, total: 2, userList })
				: standardAnswer(call),
		);
		const h = harness(["followers"], page);
		await collectTikTok(h.ctx, noDelay);
		assert.equal(h.records.length, 1);
		assert.match(h.failures[0]?.message ?? "", /counted 2 followers/);
		assert.equal(typeIndex(h, "STATE"), -1);
	}
});

test("completeness: a short collection inventory never settles missing pending B as deleted", async () => {
	for (const recoveryOnly of [false, true]) {
		for (const duplicate of [false, true]) {
			const a = collectionRows()[0];
			const { calls, page } = fakePage((call) =>
				call.path === "/api/user/collection_list/"
					? ok({
							...COLLECTIONS,
							total: 2,
							collectionList: duplicate ? [a, a] : [a],
						})
					: standardAnswer(call),
			);
			const h = harness(
				BOTH,
				page,
				{},
				{ recoveryOnly, detailGaps: [pendingGap("gB", COLLECTION_B)] },
			);
			await collectTikTok(h.ctx, noDelay);
			// B is never settled as deleted: with one listed of two counted, it
			// may be the one TikTok counts but does not list.
			assert.equal(typeIndex(h, "DETAIL_GAP_RECOVERED"), -1);
			if (duplicate) {
				// A repeat stood in for an entry: still incomplete.
				assert.match(
					h.failures[0]?.message ?? "",
					/^tiktok_list_incomplete: TikTok counted 2 favorite_collections/,
				);
				assert.equal(typeIndex(h, "DETAIL_COVERAGE"), -1);
				assert.equal(typeIndex(h, "STATE"), -1);
				assert.equal(
					calls.some((c) => c.path === "/api/collection/item_list/"),
					false,
				);
			} else {
				// A confirmed walk that lists fewer than counted is complete.
				assert.deepEqual(h.failures, []);
				assert.ok(typeIndex(h, "DETAIL_COVERAGE") >= 0);
				assert.ok(typeIndex(h, "STATE", "collection_items") >= 0);
				if (!recoveryOnly)
					assert.ok(typeIndex(h, "STATE", "favorite_collections") >= 0);
			}
			if (!recoveryOnly)
				assert.deepEqual(
					h.records
						.filter((r) => r.stream === "favorite_collections")
						.map((r) => r.data.id),
					[COLLECTION_A],
				);
		}
	}
});

test("completeness: an earlier reported total survives a terminal page without or with a lower total", async () => {
	for (const terminalTotal of [undefined, 1]) {
		for (const stream of [
			"followers",
			"favorite_collections",
			"collection_items",
		]) {
			const { page } = fakePage((call) => {
				if (stream === "followers" && call.path === "/api/user/list/")
					return ok({
						...USERS,
						total: call.params.minCursor === "0" ? 2 : terminalTotal,
						hasMore: call.params.minCursor === "0",
						minCursor: 1,
					});
				if (call.path === "/api/user/collection_list/")
					return ok({
						...COLLECTIONS,
						total:
							stream === "favorite_collections"
								? call.params.cursor === "0"
									? 2
									: terminalTotal
								: 1,
						collectionList: [{ ...collectionRows()[0], total: undefined }],
						hasMore:
							stream === "favorite_collections" && call.params.cursor === "0",
						cursor: "1",
					});
				if (call.path === "/api/collection/item_list/")
					return ok({
						...COLLECTION_ITEMS,
						itemList: [itemRows()[0]],
						total: call.params.cursor === "0" ? 2 : terminalTotal,
						hasMore: call.params.cursor === "0",
						cursor: "1",
					});
				return standardAnswer(call);
			});
			const h = harness(stream === "collection_items" ? BOTH : [stream], page);
			await collectTikTok(h.ctx, noDelay);
			if (stream === "collection_items") {
				const coverage = asRecord(
					h.messages.find((m) => m.type === "DETAIL_COVERAGE"),
				);
				assert.deepEqual(coverage.hydrated_keys, []);
				assert.deepEqual(coverage.gap_keys, [COLLECTION_A]);
				assert.equal(
					h.records.filter((r) => r.stream === "collection_items").length,
					1,
				);
			} else {
				assert.match(h.failures[0]?.message ?? "", /counted 2/);
				assert.equal(typeIndex(h, "STATE"), -1);
			}
		}
	}
});

test("completeness: complete counts and explicit empty inventories still checkpoint and settle gaps", async () => {
	for (const empty of [false, true]) {
		const { page } = fakePage((call) => {
			if (call.path === "/api/user/collection_list/")
				return ok({
					...COLLECTIONS,
					total: empty ? 0 : 1,
					collectionList: empty ? [] : [{ ...collectionRows()[0], total: "0" }],
				});
			if (call.path === "/api/collection/item_list/")
				return ok({ ...COLLECTION_ITEMS, total: 0, itemList: [] });
			if (call.path === "/api/user/list/")
				return ok({
					...USERS,
					total: empty ? 0 : 1,
					userList: empty ? [] : USERS.userList,
				});
			return standardAnswer(call);
		});
		const h = harness(
			[...BOTH, "followers"],
			page,
			{},
			{ detailGaps: [pendingGap("gA", COLLECTION_A)] },
		);
		await collectTikTok(h.ctx, noDelay);
		assert.deepEqual(h.failures, []);
		assert.equal(typeIndex(h, "DETAIL_GAP"), -1);
		const recovered = h.messages
			.filter((m) => m.type === "DETAIL_GAP_RECOVERED")
			.map(asRecord);
		assert.deepEqual(
			recovered.map((m) => m.gap_id),
			["gA"],
		);
		const coverage = asRecord(
			h.messages.find((m) => m.type === "DETAIL_COVERAGE"),
		);
		assert.deepEqual(coverage.required_keys, empty ? [] : [COLLECTION_A]);
		assert.deepEqual(coverage.hydrated_keys, empty ? [] : [COLLECTION_A]);
		assert.deepEqual(coverage.gap_keys ?? [], []);
		for (const stream of [...BOTH, "followers"])
			assert.ok(typeIndex(h, "STATE", stream) >= 0);
	}
});

test("completeness: a missing collection array cannot erase positive inventory or pending gaps", async () => {
	for (const recoveryOnly of [false, true]) {
		for (const total of [1, 2]) {
			const { page } = fakePage((call) =>
				call.path === "/api/user/collection_list/"
					? ok({ ...COLLECTIONS, total, collectionList: undefined })
					: standardAnswer(call),
			);
			const h = harness(
				BOTH,
				page,
				{},
				{ recoveryOnly, detailGaps: [pendingGap("gB", COLLECTION_B)] },
			);
			await collectTikTok(h.ctx, noDelay);
			assert.match(h.failures[0]?.message ?? "", /favorite_collections/);
			assert.equal(typeIndex(h, "DETAIL_GAP_RECOVERED"), -1);
			assert.equal(typeIndex(h, "DETAIL_COVERAGE"), -1);
			assert.equal(typeIndex(h, "STATE"), -1);
		}
	}
	const { page } = fakePage((call) =>
		call.path === "/api/user/collection_list/"
			? ok({ ...COLLECTIONS, total: 2, collectionList: undefined })
			: standardAnswer(call),
	);
	const h = harness(BOTH, page);
	await collectTikTok(h.ctx, noDelay);
	assert.match(h.failures[0]?.message ?? "", /counted 2 favorite_collections/);
	assert.equal(typeIndex(h, "STATE"), -1);
});

// Execute the installed page reader unchanged; only browser/network I/O is fake.
interface WireCall {
	path: string;
	transport: "fetch" | "xhr";
	url: URL;
}

interface WireAnswer {
	body: string;
	signed: boolean;
	status?: number;
}

function installedReader(answer: (call: WireCall) => WireAnswer) {
	const calls: WireCall[] = [];
	const gotos: string[] = [];
	const origin = "https://www.tiktok.com";
	const location = { origin };
	const respond = (transport: WireCall["transport"], input: string) => {
		const url = new URL(input, origin);
		assert.equal(url.origin, origin);
		assert.equal(url.searchParams.get("aid"), "1988");
		assert.equal(url.searchParams.get("device_id"), "12345");
		for (const key of ["msToken", "X-Bogus", "X-Gnarly"])
			assert.equal(url.searchParams.has(key), false);
		const call = { path: url.pathname, transport, url };
		calls.push(call);
		const result = answer(call);
		const responseUrl = new URL(url);
		if (result.signed) responseUrl.searchParams.set("X-Bogus", "synthetic");
		return { ...result, url: responseUrl.href, status: result.status ?? 200 };
	};
	class FakeXHR {
		withCredentials = false;
		timeout = 0;
		status = 0;
		responseText = "";
		responseURL = "";
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		ontimeout: (() => void) | null = null;
		private url = "";
		open(method: string, url: string, async: boolean) {
			assert.equal(method, "GET");
			assert.equal(async, true);
			this.url = url;
		}
		getResponseHeader(name: string) {
			return name === "content-type" ? "application/json" : null;
		}
		send() {
			assert.equal(this.withCredentials, true);
			const result = respond("xhr", this.url);
			this.status = result.status;
			this.responseText = result.body;
			this.responseURL = result.url;
			this.onload?.();
		}
	}
	const context = createContext({
		AbortController,
		URL,
		URLSearchParams,
		clearTimeout,
		setTimeout,
		location,
		performance: {
			getEntriesByType: () => [
				{
					name: `${origin}/api/post/item_list/?aid=1988&device_id=12345&app_name=tiktok_web&msToken=discarded&X-Bogus=discarded`,
				},
			],
		},
		XMLHttpRequest: FakeXHR,
		fetch: async (
			url: string,
			options: { method: string; credentials: string },
		) => {
			assert.equal(options.method, "GET");
			assert.equal(options.credentials, "include");
			const result = respond("fetch", url);
			return {
				status: result.status,
				url: result.url,
				headers: {
					get: (name: string) =>
						name === "content-type" ? "application/json" : null,
				},
				text: async () => result.body,
			};
		},
	});
	const page: TikTokPage = {
		evaluate: async (script) => {
			const result: unknown = runInContext(script, context);
			return await result;
		},
		goto: async (url) => {
			gotos.push(url);
		},
	};
	return { calls, gotos, location, page };
}

const ACCOUNT_PATH = "/passport/account/info/v2/";
const wireJson = (json: unknown, signed: boolean): WireAnswer => ({
	body: JSON.stringify(json),
	signed,
});

async function readerTransport(page: TikTokPage): Promise<unknown> {
	const status = await page.evaluate(
		WATCH_EXPRESSION,
		undefined,
		undefined,
		false,
	);
	assert.ok(
		status !== null && typeof status === "object" && "transport" in status,
	);
	return status.transport;
}

test("read boundary: unsigned account JSON does not prevent signed XHR fallback", async () => {
	const { calls, page } = installedReader((call) => {
		if (call.path === ACCOUNT_PATH) return wireJson(ACCOUNT, false);
		if (call.transport === "fetch") return { body: "", signed: false };
		return wireJson(SETTINGS, true);
	});
	assert.equal(await readSessionState(page, noDelay.delay), "signed_in");
	const accountTransport = await readerTransport(page);
	for (let i = 0; i < 2; i += 1) {
		const result = await fetchApi(page, "/api/user/settings/", {});
		assert.equal(result?.kind, "response");
		if (result?.kind !== "response") assert.fail("missing protected response");
		assert.equal(result.signed, true);
		assert.equal(result.transport, "xhr");
		assert.equal(result.empty, false);
	}
	assert.equal(accountTransport, null);
	assert.equal(await readerTransport(page), "xhr");
	assert.deepEqual(
		calls.map(({ path, transport }) => [path, transport]),
		[
			[ACCOUNT_PATH, "fetch"],
			["/api/user/settings/", "fetch"],
			["/api/user/settings/", "xhr"],
			["/api/user/settings/", "xhr"],
		],
	);
});

test("read boundary: arbitrary or error JSON cannot confirm protected signing", async () => {
	for (const json of [
		{},
		{ message: "error", data: { error_code: 500 } },
		{ statusCode: 0, settings: { privateAccount: false } },
	]) {
		let first = true;
		const { calls, page } = installedReader((call) => {
			if (first) {
				first = false;
				return wireJson(json, false);
			}
			return call.transport === "fetch"
				? { body: "", signed: false }
				: wireJson(SETTINGS, true);
		});
		await fetchApi(page, "/api/user/settings/", {});
		const unconfirmed = await readerTransport(page);
		const result = await fetchApi(page, "/api/user/settings/", {});
		assert.equal(result?.kind === "response" && result.signed, true);
		assert.equal(unconfirmed, null);
		assert.deepEqual(
			calls.map((call) => call.transport),
			["fetch", "fetch", "xhr"],
		);
	}
});

test("read boundary: healthy signed fetch is reused without duplicate successful reads", async () => {
	const { calls, page } = installedReader((call) =>
		wireJson(
			call.path === ACCOUNT_PATH ? ACCOUNT : SETTINGS,
			call.path !== ACCOUNT_PATH,
		),
	);
	assert.equal(await readSessionState(page, noDelay.delay), "signed_in");
	for (let i = 0; i < 2; i += 1) {
		const result = await fetchApi(page, "/api/user/settings/", {});
		assert.equal(result?.kind === "response" && result.signed, true);
	}
	assert.equal(await readerTransport(page), "fetch");
	assert.deepEqual(
		calls.map((call) => call.transport),
		["fetch", "fetch", "fetch"],
	);
});

test("read boundary: the installed reader retains origin, path and caller-key restrictions", async () => {
	const { calls, location, page } = installedReader(() =>
		wireJson(SETTINGS, true),
	);
	await page.evaluate(WATCH_EXPRESSION, undefined, undefined, false);
	const invoke = async (path: string, params: Json) => {
		const result = await page.evaluate(
			`globalThis[Symbol.for("pdpp.tiktok.reader")].get(${JSON.stringify(path)}, ${JSON.stringify(params)}, 100)`,
			undefined,
			undefined,
			false,
		);
		assert.ok(
			result !== null && typeof result === "object" && "kind" in result,
		);
		return result.kind;
	};
	assert.equal(await invoke("/api/like/", {}), "refused");
	assert.equal(
		await invoke("/api/user/settings/", { msToken: "synthetic" }),
		"refused",
	);
	assert.equal(
		await invoke("/api/user/settings/", { secUid: "invalid space" }),
		"refused",
	);
	location.origin = "https://example.test";
	assert.equal(await invoke("/api/user/settings/", {}), "wrong_origin");
	assert.deepEqual(calls, []);
});

test("read boundary: optional null profile fields do not invalidate a verified owner", async () => {
	const json = {
		data: {
			user_id_str: "100007",
			sec_user_id: "synthetic_sec_uid",
			username: null,
			screen_name: null,
			description: null,
			avatar_url: null,
			user_create_time: null,
		},
	};
	const account = parseAccount(json);
	assert.ok(account);
	assert.equal(account.id, "100007");
	assert.equal(account.secUid, "synthetic_sec_uid");
	const record = buildProfileRecord(account, null, null, newTextNotes());
	assertValid("profile", record);
	for (const key of [
		"unique_id",
		"nickname",
		"bio",
		"avatar_url",
		"created_at",
	])
		assert.equal(record[key], null);
	const { page, gotos } = fakePage(() => ok(json));
	assert.equal(await checkTikTokSession(page, noDelay.delay), "signed_in");
	assert.deepEqual(gotos, []);
});

test("read boundary: malformed and temporary HTTP 200 account objects remain unknown", async () => {
	for (const json of [
		{},
		[],
		{ data: null },
		{ data: { user_id_str: "100007" } },
		{ data: { user_id_str: "not-an-id", sec_user_id: "synthetic" } },
		{ data: { user_id_str: "100007", sec_user_id: "" } },
		{
			message: "error",
			data: { error_code: 500, description: "Try again later" },
		},
		{
			message: "error",
			data: { error_code: 1, description: "Temporary error" },
		},
		{ message: "error", data: { description: "Please log in" } },
	]) {
		const { page, gotos } = fakePage(() => ok(json));
		assert.equal(
			await checkTikTokSession(page, noDelay.delay),
			"unknown",
			JSON.stringify(json),
		);
		assert.deepEqual(gotos, []);
	}
});

test("read boundary: only positive unauthenticated evidence reports signed out", async () => {
	for (const answer of [
		{ ...ok(null), status: 401, empty: true },
		ok({
			message: "error",
			data: { error_code: 1, description: "Please log in" },
		}),
		ok({ message: "error", data: { error_code: 1, description: "log in" } }),
	]) {
		const { page, gotos } = fakePage(() => answer);
		assert.equal(await checkTikTokSession(page, noDelay.delay), "signed_out");
		assert.deepEqual(gotos, []);
	}
});

test("read boundary: temporary account failure can recover without a login", async () => {
	const { page, gotos, calls } = fakePage((_call, index) =>
		ok(index === 0 ? { message: "error", data: { error_code: 500 } } : ACCOUNT),
	);
	assert.equal(await checkTikTokSession(page, noDelay.delay), "signed_in");
	assert.equal(calls.length, 2);
	assert.deepEqual(gotos, []);
});

test("read boundary: account challenge and server failures are not sign-out evidence", async () => {
	for (const answer of [
		{ ...ok({}), status: 503 },
		{ ...ok({}), html: true },
		{ ...ok({}), challengeHeader: true },
		{ ...ok(null), empty: true },
		{ ...ok({}), status: 401, challengeHeader: true },
	]) {
		const { page, gotos } = fakePage(() => answer);
		assert.equal(await checkTikTokSession(page, noDelay.delay), "unknown");
		assert.deepEqual(gotos, []);
	}
});

test("read boundary: collection uses the installed reader and checkpoints after signed XHR", async () => {
	const statesAtXhr: number[] = [];
	const { calls, page } = installedReader((call) => {
		if (call.path === ACCOUNT_PATH) {
			return wireJson(
				{
					data: { user_id_str: "100007", sec_user_id: "synthetic_sec_uid" },
				},
				false,
			);
		}
		assert.equal(call.path, "/api/user/collect/item_list/");
		assert.equal(call.url.searchParams.get("secUid"), "synthetic_sec_uid");
		if (call.transport === "fetch") return { body: "", signed: false };
		// Count checkpoints as the signed XHR is answered: none may exist yet.
		statesAtXhr.push(h.messages.filter((m) => m.type === "STATE").length);
		return wireJson({ statusCode: 0, hasMore: false }, true);
	});
	const h = harness(["favorites"], page);
	await collectTikTok(h.ctx, noDelay);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(h.records, []);
	assert.deepEqual(statesAtXhr, [0]);
	assert.equal(h.messages.filter((m) => m.type === "STATE").length, 1);
	assert.equal(h.messages.find((m) => m.type === "STATE")?.stream, "favorites");
	const state = h.messages.find((m) => m.type === "STATE");
	assert.deepEqual(state && "cursor" in state ? state.cursor : null, {
		count: 0,
	});
	assert.deepEqual(
		calls.map((call) => call.transport),
		["fetch", "fetch", "xhr"],
	);
});

// ─── sign-in handoff (2026-10-24) ────────────────────────────────────────

/** A cookie jar answering, per read, the sign-in cookie names it holds. */
function cookieJar(names: (read: number) => string[]) {
	let reads = 0;
	return {
		cookies: async (url?: string | string[]) => {
			assert.equal(url, "https://www.tiktok.com/");
			const held = names(reads);
			reads += 1;
			// Values are synthetic: the connector looks at names and expiry only.
			return held.map((name) => ({ name, value: "synthetic", expires: 1 }));
		},
		reads: () => reads,
	};
}

function handoffArgs(page: TikTokPage, context: unknown = {}) {
	const assists: string[] = [];
	const completions: string[] = [];
	return {
		assists,
		completions,
		args: {
			context,
			assist: async (req: { message: string }) => {
				assists.push(req.message);
				return "tiktok_handoff";
			},
			capture: null,
			checkpoint: async () => {},
			completeAssistance: async (_id: string, status: string) => {
				completions.push(status);
			},
			page: page as unknown as Page,
			sendInteraction: async () => {
				throw new Error("unexpected manual action fallback");
			},
		} as unknown as Parameters<typeof ensureTikTokSession>[0],
	};
}

const SIGNED_OUT = {
	message: "error",
	data: { error_code: 1, description: "Please log in" },
};

test("signin handoff: a signed-out answer opens the sign-in page and waits for the person", async () => {
	// The account endpoint answers signed out until the person signs in.
	const { calls, gotos, page } = fakePage((_call, index) =>
		index < 1 ? ok(SIGNED_OUT) : ok(ACCOUNT),
	);
	const h = handoffArgs(page);
	await ensureTikTokSession(h.args, noDelay.delay);
	// Signed in by hand: collection starts from the profile page.
	assert.deepEqual(gotos, [LOGIN_URL, PROFILE_URL]);
	assert.equal(h.assists.length, 1);
	assert.match(h.assists[0] ?? "", /Sign in to TikTok/);
	assert.deepEqual(h.completions, ["resolved"]);
	assert.ok(calls.every((c) => c.path === "/passport/account/info/v2/"));
});

test("signin handoff: with no cookie baseline, an existing sign-in cookie is not taken as a new sign-in", async () => {
	// The jar could not be read when the handoff began (before = null); later
	// reads see a session cookie that may be left from an old session.
	const jar = cookieJar(() => ["sessionid"]);
	const { page } = fakePage(() => ok({ message: "error", data: { name: "session_expired" } }));
	const readiness = signInReadiness(jar, null, noDelay.delay);
	assert.equal(await readiness.probe(page), false);
	assert.equal(readiness.byCookie(), false);
	assert.equal(jar.reads(), 0);
	// With a baseline that lacks the cookie, the same cookie is a new sign-in.
	const fresh = signInReadiness(jar, new Map(), noDelay.delay);
	assert.equal(await fresh.probe(page), true);
	assert.equal(fresh.byCookie(), true);
});

test("signin handoff: a fresh profile whose app never made a request gets the sign-in page after the one profile-page open", async () => {
	// No client parameters anywhere, so the reader sends nothing (no_client).
	const { calls, gotos, page } = fakePage(() => ({ kind: "no_client" }), {
		watch: { client: false, transport: null },
	});
	const jar = cookieJar((read) => (read === 0 ? [] : ["sessionid"]));
	const h = handoffArgs(page, jar);
	await ensureTikTokSession(h.args, noDelay.delay);
	assert.deepEqual(gotos, [PROFILE_URL, LOGIN_URL, PROFILE_URL]);
	assert.equal(h.assists.length, 1);
	assert.deepEqual(h.completions, ["resolved"]);
	// The check, its re-read after the profile page, and the check after the
	// sign-in cookie; none left the page.
	assert.equal(calls.length, 3);
});

test("signin handoff: repeated 503s on a signed-in page are retried in place, then stop retryably with no sign-in page and no handoff", async () => {
	for (const answer of [
		{ ...ok({}), status: 503 },
		{ ...ok(null), empty: true },
		ok({}),
		ok({ message: "error", data: { error_code: 500 } }),
	]) {
		const { calls, gotos, page } = fakePage(() => answer);
		const h = handoffArgs(page);
		await assert.rejects(
			ensureTikTokSession(h.args, noDelay.delay),
			(error: Error) => error.message === "tiktok_interrupted",
			JSON.stringify(answer),
		);
		assert.deepEqual(gotos, [], JSON.stringify(answer));
		assert.deepEqual(h.assists, []);
		// The check and its in-place re-read, then two bounded retries.
		assert.equal(calls.length, 4);
	}
});

test("signin handoff: a temporary failure that recovers continues without the sign-in page", async () => {
	const { gotos, page } = fakePage((_call, index) =>
		index < 3 ? { ...ok({}), status: 503 } : ok(ACCOUNT),
	);
	const h = handoffArgs(page);
	await ensureTikTokSession(h.args, noDelay.delay);
	assert.deepEqual(gotos, []);
	assert.deepEqual(h.assists, []);
});

test("signin handoff: a bot check on a signed-in page is handed to the person in place, never to the sign-in page", async () => {
	for (const challenge of [
		{ ...ok({}), challengeHeader: true },
		{ ...ok({}), html: true, status: 503 },
		{ ...ok({}), status: 403 },
	]) {
		// The check and its re-read meet the bot check; once the person clears
		// it the account endpoint answers again.
		const { gotos, page } = fakePage((_call, index) =>
			index < 2 ? challenge : ok(ACCOUNT),
		);
		const h = handoffArgs(page);
		await ensureTikTokSession(h.args, noDelay.delay);
		assert.deepEqual(gotos, [], JSON.stringify(challenge));
		assert.equal(h.assists.length, 1);
		assert.match(h.assists[0] ?? "", /check/);
		assert.deepEqual(h.completions, ["resolved"]);
	}
});

test("signin handoff: a signed-in session is never moved to the sign-in page", async () => {
	const { gotos, page } = fakePage(standardAnswer);
	const h = handoffArgs(page);
	await ensureTikTokSession(h.args);
	assert.deepEqual(gotos, []);
	assert.deepEqual(h.assists, []);
});

/** ensureTikTokSession run through the runtime's own establishSession. */
async function establishTikTok(page: TikTokPage, context: unknown = {}) {
	const assists: string[] = [];
	try {
		await establishSession(
			{
				ensureSession: (args) => ensureTikTokSession(args, noDelay.delay),
				probeSession: async ({ page: probed }) =>
					(await checkTikTokSession(probed, noDelay.delay)) === "signed_in",
				probeSessionIsAuthoritative: true,
			},
			{
				assist: async (req) => {
					assists.push(req.message);
					return "tiktok_handoff";
				},
				capture: null,
				checkpoint: async () => {},
				completeAssistance: async () => {},
				context: context as never,
				name: "tiktok",
				page: page as never,
				progress: async () => {},
				retryablePattern: TIKTOK_RETRYABLE_PATTERN,
				sendInteraction: async () => {
					throw new Error("unexpected manual action fallback");
				},
			},
		);
	} catch (error) {
		return { assists, error };
	}
	return { assists, error: null };
}

test("session errors: a check that keeps failing reaches the runtime as tiktok_interrupted, retryable", async () => {
	const { gotos, page } = fakePage(() => ({ ...ok({}), status: 503 }));
	const { assists, error } = await establishTikTok(page);
	assert.ok(error instanceof TerminalError, String(error));
	assert.equal(error.code, "tiktok_interrupted");
	assert.equal(error.retryable, true);
	assert.deepEqual(gotos, []);
	assert.deepEqual(assists, []);
});

test("session errors: a sign-in cookie on a session the account still calls signed out reaches the runtime as tiktok_auth_failed, not retryable", async () => {
	const { gotos, page } = fakePage(() => ok(SIGNED_OUT));
	const jar = cookieJar((read) => (read === 0 ? [] : ["sessionid"]));
	const { assists, error } = await establishTikTok(page, jar);
	assert.ok(error instanceof TerminalError, String(error));
	assert.equal(error.code, "tiktok_auth_failed");
	assert.equal(error.retryable, false);
	assert.deepEqual(gotos, [LOGIN_URL, PROFILE_URL]);
	assert.equal(assists.length, 1);
});

// ─── client parameters per page (2026-10-24) ─────────────────────────────

// The installed page reader runs unchanged, one fresh context per document
// (a navigation or TikTok's own redirect starts a new page with an empty
// reader). Only the page's resource entries and the network are fake.
interface PageSpec {
	/** Whether the page's app makes a request the reader copies from. */
	appRequest: boolean;
	/** Reader evaluations before that request shows up (it is in flight). */
	readyAfter?: number;
}

const WIRE_ACCOUNT = {
	...ACCOUNT,
	data: {
		...(ACCOUNT.data as Json),
		sec_user_id: "MS4wLjABAAAASyntheticSecUidOnlyForTheReaderTest",
	},
};

function documentPages(
	start: { url: string } & PageSpec,
	pageAt: (url: string) => PageSpec,
	options: { signedOutChecks?: number } = {},
) {
	const origin = "https://www.tiktok.com";
	const calls: string[] = [];
	const gotos: string[] = [];
	let signedOutChecks = options.signedOutChecks ?? 0;
	let replaceWhen: ((path: string) => boolean) | null = null;
	let replacement: PageSpec | null = null;
	/** TikTok's own redirect, landing before the next page evaluation. */
	let pending: PageSpec | null = null;
	const open = (spec: PageSpec) => {
		const doc = { evals: 0, context: createContext({}) };
		doc.context = createContext({
			AbortController,
			URL,
			URLSearchParams,
			clearTimeout,
			setTimeout,
			location: { origin },
			performance: {
				getEntriesByType: () => [
					// Not an /api/ request: the reader never copies from it.
					{ name: `${origin}/passport/web/account/info/?aid=1988` },
					...(spec.appRequest && doc.evals > (spec.readyAfter ?? 0)
						? [
								{
									name: `${origin}/api/post/item_list/?aid=1988&device_id=12345&app_name=tiktok_web&msToken=discarded&X-Bogus=discarded`,
								},
							]
						: []),
				],
			},
			fetch: async (input: string) => {
				const url = new URL(input, origin);
				// Only a request carrying the copied client fields leaves.
				assert.equal(url.searchParams.get("aid"), "1988");
				assert.equal(url.searchParams.get("device_id"), "12345");
				calls.push(url.pathname);
				const json =
					url.pathname === ACCOUNT_PATH
						? WIRE_ACCOUNT
						: (
								standardAnswer({
									path: url.pathname,
									params: Object.fromEntries(url.searchParams),
								}) as { json?: unknown }
							).json;
				if (replaceWhen?.(url.pathname)) {
					replaceWhen = null;
					pending = replacement;
				}
				url.searchParams.set("X-Bogus", "synthetic");
				return {
					status: 200,
					url: url.href,
					headers: {
						get: (name: string) =>
							name === "content-type" ? "application/json" : null,
					},
					text: async () => JSON.stringify(json),
				};
			},
		});
		return doc;
	};
	let current = open(start);
	const page: TikTokPage = {
		evaluate: async (script) => {
			if (pending) {
				current = open(pending);
				pending = null;
			}
			current.evals += 1;
			if (
				signedOutChecks > 0 &&
				script.includes(`session.get(${JSON.stringify(ACCOUNT_PATH)}`)
			) {
				signedOutChecks -= 1;
				return ok(SIGNED_OUT);
			}
			const result: unknown = runInContext(script, current.context);
			return await result;
		},
		goto: async (url) => {
			gotos.push(url);
			// Our navigation supersedes a redirect TikTok had not made yet.
			pending = null;
			current = open(pageAt(url));
		},
	};
	return {
		calls,
		gotos,
		page,
		/** After the response to `path`, TikTok replaces the page. */
		replaceAfter: (when: (path: string) => boolean, spec: PageSpec) => {
			replaceWhen = when;
			replacement = spec;
		},
	};
}

const FULL_RUN_PATHS = [
	ACCOUNT_PATH,
	"/api/post/item_list/",
	"/api/user/settings/",
	"/api/favorite/item_list/",
	"/api/user/collect/item_list/",
	"/api/user/list/",
	"/api/user/list/",
];

const onlyProfileHasClient = (url: string): PageSpec => ({
	appRequest: url === PROFILE_URL,
});

test("client params: signed in on a page with no app request, the session check moves to the profile page and collection reads every stream", async () => {
	const d = documentPages(
		{ url: "https://www.tiktok.com/foryou", appRequest: false },
		onlyProfileHasClient,
	);
	const h = handoffArgs(d.page);
	await ensureTikTokSession(h.args, noDelay.delay);
	assert.deepEqual(d.gotos, [PROFILE_URL]);
	assert.deepEqual(h.assists, []);
	const run = harness(ALL, d.page);
	await collectTikTok(run.ctx, noDelay);
	assert.deepEqual(run.failures, []);
	assert.deepEqual(d.calls, [ACCOUNT_PATH, ...FULL_RUN_PATHS]);
	assert.equal(run.records.filter((r) => r.stream === "videos").length, 3);
	assert.deepEqual(d.gotos, [PROFILE_URL]);
});

test("client params: collection on a page with no app request opens the profile page once, then collects", async () => {
	const d = documentPages(
		{ url: "https://www.tiktok.com/foryou", appRequest: false },
		onlyProfileHasClient,
	);
	const run = harness(ALL, d.page);
	await collectTikTok(run.ctx, noDelay);
	assert.deepEqual(d.gotos, [PROFILE_URL]);
	assert.deepEqual(run.failures, []);
	assert.deepEqual(d.calls, FULL_RUN_PATHS);
});

test("client params: after a hand sign-in the page moves to the profile page before collection", async () => {
	// Not signed in at first; the person signs in on the sign-in page, whose
	// readiness probe answers, then TikTok carries them to a page that makes
	// no request the reader copies from.
	const d = documentPages(
		{ url: "https://www.tiktok.com/foryou", appRequest: true },
		(url) => ({ appRequest: url === LOGIN_URL || url === PROFILE_URL }),
		{ signedOutChecks: 1 },
	);
	d.replaceAfter((path) => path === ACCOUNT_PATH, { appRequest: false });
	const h = handoffArgs(d.page);
	await ensureTikTokSession(h.args, noDelay.delay);
	assert.equal(h.assists.length, 1);
	assert.deepEqual(h.completions, ["resolved"]);
	assert.deepEqual(d.gotos, [LOGIN_URL, PROFILE_URL]);
	const run = harness(ALL, d.page);
	await collectTikTok(run.ctx, noDelay);
	assert.deepEqual(run.failures, []);
	assert.deepEqual(d.calls, [ACCOUNT_PATH, ...FULL_RUN_PATHS]);
});

test("client params: a sign-in that lands on a page with no app request is ready from TikTok's sign-in cookie, then collection runs", async () => {
	// Signed out at first. The sign-in page, and where TikTok sends the person
	// after it, make no request the reader copies from, so the account
	// endpoint cannot answer there; the new sign-in cookie says it is done.
	const d = documentPages(
		{ url: "https://www.tiktok.com/foryou", appRequest: true },
		(url) => ({ appRequest: url === PROFILE_URL }),
		{ signedOutChecks: 1 },
	);
	const jar = cookieJar((read) => (read === 0 ? [] : ["sid_tt", "sessionid"]));
	const h = handoffArgs(d.page, jar);
	await ensureTikTokSession(h.args, noDelay.delay);
	assert.equal(h.assists.length, 1);
	assert.deepEqual(h.completions, ["resolved"]);
	assert.deepEqual(d.gotos, [LOGIN_URL, PROFILE_URL]);
	assert.equal(jar.reads(), 2);
	// Ready on the cookie: one account check from the profile page.
	assert.deepEqual(d.calls, [ACCOUNT_PATH]);
	const run = harness(ALL, d.page);
	await collectTikTok(run.ctx, noDelay);
	assert.deepEqual(run.failures, []);
	assert.deepEqual(d.calls, [ACCOUNT_PATH, ...FULL_RUN_PATHS]);
	assert.equal(run.records.filter((r) => r.stream === "videos").length, 3);
});

test("client params: TikTok replacing the page mid-run is waited out in place, and the request is sent once on the new page", async () => {
	// The live failure: the account read succeeds, then the page is replaced
	// and the next request finds a reader with no client parameters.
	const d = documentPages(
		{ url: PROFILE_URL, appRequest: true },
		onlyProfileHasClient,
	);
	d.replaceAfter((path) => path === ACCOUNT_PATH, {
		appRequest: true,
		readyAfter: 3,
	});
	const run = harness(ALL, d.page);
	await collectTikTok(run.ctx, noDelay);
	assert.deepEqual(run.failures, []);
	assert.deepEqual(d.gotos, []);
	assert.deepEqual(d.calls, FULL_RUN_PATHS);
	assert.equal(run.records.filter((r) => r.stream === "videos").length, 3);
});

test("client params: still none after the profile page, the run stops early with client_params_not_seen and sends nothing", async () => {
	const d = documentPages(
		{ url: "https://www.tiktok.com/foryou", appRequest: false },
		() => ({ appRequest: false }),
	);
	const run = harness(ALL, d.page);
	await collectTikTok(run.ctx, noDelay);
	assert.deepEqual(d.gotos, [PROFILE_URL]);
	assert.deepEqual(d.calls, []);
	assert.deepEqual(run.failures.map((f) => f.stream).sort(), [...ALL].sort());
	for (const failure of run.failures) {
		assert.equal(failure.message, `tiktok_interrupted: ${CLIENT_NOT_SEEN}`);
		assert.equal(failure.retryable, true);
	}
});
