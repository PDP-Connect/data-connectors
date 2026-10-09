// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	buildConnectionRecords,
	buildProfileRecord,
	buildServerRecords,
	compareSnowflakes,
	hasVerificationChallenge,
	isGlobalRateLimit,
	parseSearchPage,
	retryAfterMs,
	snowflake,
	snowflakeInstant,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const fixture = (name: string): unknown =>
	JSON.parse(
		readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
	);

const OWNER = "552071489126400001";
const SERVER_A = "797751587635200003";
const SEARCHED = { id: SERVER_A, name: "Synthetic Trail Club" };

function assertValid(stream: string, record: unknown): void {
	const parsed = validateRecord(stream, record as never);
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
}

test("a snowflake is a decimal id, compared as a number and dated by its bits", () => {
	assert.equal(snowflake(OWNER), OWNER);
	assert.equal(snowflake(552_071_489_126_400), null);
	assert.equal(snowflake("@me"), null);
	assert.equal(snowflake(""), null);
	// Length differs, so a string comparison would order these wrongly.
	assert.equal(compareSnowflakes("99999999999999999", OWNER), -1);
	assert.equal(compareSnowflakes(OWNER, "99999999999999999"), 1);
	assert.equal(compareSnowflakes(OWNER, OWNER), 0);
	assert.equal(snowflakeInstant(OWNER), "2019-03-04T10:15:00.000Z");
});

test("the profile record keeps named fields only", () => {
	const record = buildProfileRecord(fixture("user-me.json"));
	assert.deepEqual(record, {
		id: OWNER,
		username: "sample.user",
		global_name: "Sample User",
		discriminator: "0",
		avatar: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
		banner: null,
		accent_color: 5_793_266,
		bio: "Synthetic profile for fixtures.",
		locale: "en-US",
		verified: true,
		premium_type: 0,
		created_at: "2019-03-04T10:15:00.000Z",
	});
	assertValid("profile", record);
	// Contact details and sign-in security settings are not part of the record.
	const text = JSON.stringify(record);
	for (const absent of [
		"+15550100",
		"sample.user@example.com",
		"mfa_enabled",
		"authenticator_types",
		"linked_users",
		"age_verification_status",
	]) {
		assert.equal(text.includes(absent), false, absent);
	}
});

test("a profile with every optional field missing still builds", () => {
	const record = buildProfileRecord({ id: OWNER, username: "sample.user" });
	assert.equal(record?.bio, null);
	assert.equal(record?.verified, null);
	assertValid("profile", record);
});

test("a user object without an id or username is refused", () => {
	assert.equal(buildProfileRecord({ username: "sample.user" }), null);
	assert.equal(buildProfileRecord({ id: OWNER }), null);
	assert.equal(buildProfileRecord({ id: 5, username: "sample.user" }), null);
	assert.equal(buildProfileRecord([]), null);
	assert.equal(buildProfileRecord(null), null);
});

test("server records come from the partial guild list", () => {
	const parsed = buildServerRecords(fixture("guilds.json"));
	assert.ok(parsed.ok);
	assert.equal(parsed.unreadable, 0);
	assert.deepEqual(parsed.records[0], {
		id: SERVER_A,
		name: "Synthetic Trail Club",
		icon: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
		is_owner: false,
		permissions: "140737488355327",
		features: ["COMMUNITY", "NEWS"],
		created_at: "2021-01-10T09:00:00.000Z",
	});
	assert.deepEqual(
		parsed.records.map((record) => record.is_owner),
		[false, true, false],
	);
	for (const record of parsed.records) assertValid("servers", record);
});

test("a guild without an id is counted, and a non-list is refused", () => {
	const parsed = buildServerRecords([{ name: "No id" }, { id: SERVER_A }]);
	assert.ok(parsed.ok);
	assert.equal(parsed.unreadable, 1);
	assert.deepEqual(parsed.records[0]?.features, []);
	assertValid("servers", parsed.records[0]);
	assert.equal(buildServerRecords({ message: "Unauthorized" }).ok, false);
});

test("connection records never carry a third-party access token", () => {
	const parsed = buildConnectionRecords(fixture("connections.json"));
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.records[0], {
		id: "github:40000001",
		type: "github",
		account_id: "40000001",
		name: "sample-user",
		verified: true,
		revoked: false,
		visibility: 1,
		friend_sync: false,
		show_activity: true,
		two_way_link: false,
	});
	assert.equal(parsed.records[1]?.id, "spotify:synthetic-spotify-account");
	assert.equal(JSON.stringify(parsed.records).includes("access_token"), false);
	assert.equal(
		JSON.stringify(parsed.records).includes("never-collected"),
		false,
	);
	for (const record of parsed.records) assertValid("connections", record);
	assert.equal(buildConnectionRecords([{ type: "github" }]).ok, true);
	assert.deepEqual(buildConnectionRecords([{ type: "github" }]), {
		ok: true,
		records: [],
		unreadable: 1,
	});
});

test("a search page yields one hit per group and drops the context messages", () => {
	const parsed = parseSearchPage(fixture("search-messages.json"), SEARCHED);
	assert.ok(parsed.ok);
	assert.equal(parsed.total, 3);
	assert.equal(parsed.unreadable, 0);
	assert.deepEqual(
		parsed.hits.map((hit) => [hit.id, hit.authorId]),
		[
			["1551201258700800013", OWNER],
			["1550431687802880011", OWNER],
			["1549472366592000015", "735204448665600002"],
		],
	);
	const text = JSON.stringify(parsed.hits.map((hit) => hit.record));
	assert.equal(text.includes("Synthetic context from someone else"), false);
	assert.equal(text.includes("Synthetic question from someone else"), false);
});

test("a message record keeps the owner's text, times and attachment names", () => {
	const parsed = parseSearchPage(fixture("search-messages.json"), SEARCHED);
	assert.ok(parsed.ok);
	const [plain, reply] = parsed.hits;
	assert.deepEqual(plain?.record, {
		id: "1551201258700800013",
		server_id: SERVER_A,
		server_name: "Synthetic Trail Club",
		channel_id: "797751839293440006",
		content: "Synthetic message about the weekend plan.",
		timestamp: "2026-09-20T12:00:00.000Z",
		edited_timestamp: null,
		type: 0,
		pinned: false,
		reply_to_message_id: null,
		attachments: [],
		embed_count: 1,
	});
	assert.equal(plain?.timestampMs, Date.parse("2026-09-20T12:00:00Z"));
	assert.equal(reply?.record.type, 19);
	assert.equal(reply?.record.edited_timestamp, "2026-09-18T09:05:30.000Z");
	// The replied-to message is someone else's: only its id is kept.
	assert.equal(reply?.record.reply_to_message_id, "1550430932828160010");
	assert.deepEqual(reply?.record.attachments, [
		{
			id: "1550431687802880012",
			filename: "route-notes.txt",
			content_type: "text/plain; charset=utf-8",
			size: 482,
		},
	]);
	// No download link is kept.
	assert.equal(
		JSON.stringify(reply?.record).includes("example.invalid"),
		false,
	);
	for (const hit of parsed.hits) assertValid("messages", hit.record);
});

test("a message with no timestamp is dated by its id", () => {
	const parsed = parseSearchPage(
		{
			total_results: 1,
			messages: [
				[
					{
						id: "1551201258700800013",
						hit: true,
						content: "",
						author: { id: OWNER },
					},
				],
			],
		},
		SEARCHED,
	);
	assert.ok(parsed.ok);
	assert.equal(parsed.hits[0]?.record.timestamp, "2026-09-20T12:00:00.000Z");
	assert.equal(parsed.hits[0]?.record.content, null);
	assert.equal(parsed.hits[0]?.authorId, OWNER);
	assertValid("messages", parsed.hits[0]?.record);
});

test("a hit without a usable author id is unreadable, not a silent skip", () => {
	for (const author of [
		undefined,
		null,
		{},
		{ id: "bad" },
		{ id: 5 },
		{ id: null },
		"sample.user",
	]) {
		const message: Record<string, unknown> = {
			content: "Synthetic message.",
			hit: true,
			id: "1551201258700800013",
			timestamp: "2026-09-20T12:00:00.000Z",
		};
		if (author !== undefined) message.author = author;
		const parsed = parseSearchPage(
			{ total_results: 1, messages: [[message]] },
			SEARCHED,
		);
		assert.ok(parsed.ok);
		assert.equal(parsed.hits.length, 0, JSON.stringify(author));
		assert.equal(parsed.unreadable, 1, JSON.stringify(author));
		assert.deepEqual(parsed.unreadablePositions, [0], JSON.stringify(author));
	}
	// A well-formed author id that differs is a readable hit the caller can
	// identify as someone else's and drop with proof.
	const other = parseSearchPage(
		{
			total_results: 1,
			messages: [
				[
					{
						author: { id: "735204448665600002" },
						hit: true,
						id: "1551201258700800013",
					},
				],
			],
		},
		SEARCHED,
	);
	assert.ok(other.ok);
	assert.equal(other.unreadable, 0);
	assert.equal(other.hits[0]?.authorId, "735204448665600002");
});

test("a group with two marked hits is unreadable", () => {
	const owner = { author: { id: OWNER }, hit: true, id: "1551201258700800013" };
	const other = {
		author: { id: "735204448665600002" },
		hit: true,
		id: "1550431687802880011",
	};
	// Picking either marked hit would be a guess, so the group is unreadable.
	const ambiguous = parseSearchPage(
		{ total_results: 1, messages: [[other, owner]] },
		SEARCHED,
	);
	assert.ok(ambiguous.ok);
	assert.equal(ambiguous.hits.length, 0);
	assert.equal(ambiguous.unreadable, 1);

	// One marked hit with an unmarked context message still reads.
	const clear = parseSearchPage(
		{
			total_results: 1,
			messages: [[{ ...other, hit: false }, owner]],
		},
		SEARCHED,
	);
	assert.ok(clear.ok);
	assert.equal(clear.unreadable, 0);
	assert.equal(clear.hits[0]?.id, owner.id);
});

test("a search answer of another shape is refused", () => {
	assert.equal(
		parseSearchPage(fixture("search-empty.json"), SEARCHED).ok,
		true,
	);
	assert.equal(
		parseSearchPage(fixture("search-index-not-ready.json"), SEARCHED).ok,
		false,
	);
	assert.equal(parseSearchPage({ messages: [] }, SEARCHED).ok, false);
	assert.equal(parseSearchPage(null, SEARCHED).ok, false);
	const parsed = parseSearchPage(
		{ total_results: 2, messages: [[{ hit: true }], "x"] },
		SEARCHED,
	);
	assert.deepEqual(parsed, {
		ok: true,
		groups: 2,
		hits: [],
		total: 2,
		unreadable: 2,
		unreadablePositions: [0, 1],
	});
});

test("captcha and account-check payloads are recognised", () => {
	assert.equal(
		hasVerificationChallenge(fixture("captcha-required.json")),
		true,
	);
	assert.equal(
		hasVerificationChallenge({ message: "Verify your account", code: 40_002 }),
		true,
	);
	assert.equal(hasVerificationChallenge(fixture("missing-access.json")), false);
	assert.equal(hasVerificationChallenge(fixture("user-me.json")), false);
	assert.equal(hasVerificationChallenge(null), false);
});

test("the wait a response asks for comes from its body, then its header", () => {
	assert.equal(retryAfterMs(fixture("rate-limited.json"), null), 1500);
	assert.equal(retryAfterMs(fixture("search-index-not-ready.json"), 9), 2000);
	assert.equal(retryAfterMs(null, 3), 3000);
	assert.equal(retryAfterMs("<html>", null), null);
	assert.equal(retryAfterMs({ retry_after: -1 }, null), null);
	assert.equal(isGlobalRateLimit(fixture("rate-limited.json")), false);
	assert.equal(isGlobalRateLimit({ retry_after: 1, global: true }), true);
});
