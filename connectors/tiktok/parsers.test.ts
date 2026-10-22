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
import { checkTikTokSession, collectTikTok, type TikTokPage } from "./index.ts";
import {
	buildProfileRecord,
	buildSavedVideoRecord,
	buildUserRecord,
	buildVideoRecord,
	envelopeStatus,
	newTextNotes,
	parseAccount,
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
				return options.watch ?? { client: true, transport: null };
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
		},
	};
}

const noDelay = { delay: async () => {}, random: () => 0 };

const ACCOUNT = fixture("passport-account-info-v2.json");
const SETTINGS = fixture("user-settings.json");
const POSTS = fixture("post-item-list.json");
const LIKED = fixture("favorite-item-list.json");
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

test("review 2 #3: favorite_collections is not a stream and no collection path is requested", async () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as { streams: { name: string; description: string }[] };
	const names = manifest.streams.map((stream) => stream.name);
	assert.equal(names.includes("favorite_collections"), false);
	const favorites = manifest.streams.find(
		(stream) => stream.name === "favorites",
	);
	assert.doesNotMatch(favorites?.description ?? "", /collection/i);
	const { calls, page } = fakePage(standardAnswer);
	const h = harness(
		["profile", "videos", "likes", "favorites", "following", "followers"],
		page,
	);
	await collectTikTok(h.ctx, noDelay);
	assert.equal(
		calls.some((c) => c.path.includes("collection")),
		false,
	);
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
