// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CHANNEL_TYPES,
	ChannelTypeError,
	channelsForRun,
	classifyChannelType,
	narrowsChannelTypes,
	parseChannelTypes,
	restrictRecordToChannels,
	selectChannelIdsByType,
} from "./channel-types.ts";

const reasonOf = (action: () => unknown): string | undefined => {
	try {
		action();
	} catch (error) {
		return error instanceof ChannelTypeError ? error.reason : "other";
	}
	return undefined;
};

test("the default option value leaves every type in and is not a narrowing", () => {
	const selected = parseChannelTypes([...CHANNEL_TYPES]);
	assert.equal(selected.size, 4);
	assert.equal(narrowsChannelTypes(selected), false);
});

test("a narrowed value is read case- and space-insensitively", () => {
	const selected = parseChannelTypes([" Public ", "IM", ""]);
	assert.deepEqual([...selected].sort(), ["im", "public"]);
	assert.equal(narrowsChannelTypes(selected), true);
});

test("an empty value or an unknown type is refused, not guessed", () => {
	assert.equal(
		reasonOf(() => parseChannelTypes([])),
		"invalid_types",
	);
	assert.equal(
		reasonOf(() => parseChannelTypes([" ", ""])),
		"invalid_types",
	);
	assert.equal(
		reasonOf(() => parseChannelTypes(["public", "bogus"])),
		"invalid_types",
	);
	assert.equal(
		reasonOf(() => parseChannelTypes(["public_channel"])),
		"invalid_types",
	);
});

for (const [label, entry, expected] of [
	["a public channel", { is_channel: true }, "public"],
	[
		"a private channel flagged is_private",
		{ is_channel: true, is_private: true },
		"private",
	],
	[
		"a private channel flagged is_group",
		{ is_group: true, is_private: true },
		"private",
	],
	["a direct message", { is_im: true, is_private: true }, "im"],
	[
		"a group direct message",
		{ is_mpim: true, is_group: true, is_private: true },
		"mpim",
	],
] as const) {
	test(`classifyChannelType reads ${label} as ${expected}`, () => {
		assert.equal(classifyChannelType(entry), expected);
	});
}

for (const [label, entry] of [
	["no flag at all", {}],
	["flags that are false", { is_channel: false, is_im: false }],
	[
		"a direct message that is also a channel",
		{ is_im: true, is_channel: true },
	],
	[
		"a group message that is also a channel",
		{ is_mpim: true, is_channel: true },
	],
	[
		"a channel that is both kinds of direct message",
		{ is_im: true, is_mpim: true },
	],
	["a flag that is not a boolean", { is_channel: "true" }],
] as const) {
	test(`classifyChannelType refuses ${label}`, () => {
		assert.equal(
			reasonOf(() => classifyChannelType(entry)),
			"ambiguous",
		);
	});
}

const LISTING = [
	{ id: "C0PUBLIC1", is_channel: true },
	{ id: "C0PUBLIC2", is_channel: true, is_private: false },
	{ id: "G0PRIVATE1", is_group: true, is_private: true },
	{ id: "C0PRIVATE2", is_channel: true, is_private: true },
	{ id: "D0DIRECT01", is_im: true, is_private: true },
	{ id: "G0GROUPDM1", is_mpim: true, is_group: true, is_private: true },
];

test("selectChannelIdsByType keeps only the chosen types, sorted", () => {
	assert.deepEqual(
		selectChannelIdsByType(LISTING, parseChannelTypes(["public"])),
		["C0PUBLIC1", "C0PUBLIC2"],
	);
	assert.deepEqual(
		selectChannelIdsByType(LISTING, parseChannelTypes(["private", "im"])),
		["C0PRIVATE2", "D0DIRECT01", "G0PRIVATE1"],
	);
	assert.deepEqual(
		selectChannelIdsByType(LISTING, parseChannelTypes(["mpim"])),
		["G0GROUPDM1"],
	);
});

test("selectChannelIdsByType refuses a listing it cannot read in full", () => {
	const selected = parseChannelTypes(["public"]);
	for (const listing of [
		null,
		"[]",
		{ channels: LISTING },
		[...LISTING, "C0TEXT"],
		[...LISTING, null],
		[...LISTING, { is_channel: true }],
		[...LISTING, { id: "-rf", is_channel: true }],
		[...LISTING, { id: "c0lower", is_channel: true }],
		[...LISTING, { id: 7, is_channel: true }],
	]) {
		assert.equal(
			reasonOf(() => selectChannelIdsByType(listing, selected)),
			"unreadable",
			JSON.stringify(listing).slice(0, 60),
		);
	}
});

test("selectChannelIdsByType refuses one unclassifiable channel instead of skipping it", () => {
	assert.equal(
		reasonOf(() =>
			selectChannelIdsByType(
				[...LISTING, { id: "C0MYSTERY" }],
				parseChannelTypes(["public"]),
			),
		),
		"ambiguous",
	);
	assert.equal(
		reasonOf(() =>
			selectChannelIdsByType(
				[
					{ id: "C0TWICE01", is_channel: true },
					{ id: "C0TWICE01", is_im: true },
				],
				parseChannelTypes(["public"]),
			),
		),
		"ambiguous",
	);
});

test("a channel listed twice under one type is kept once", () => {
	assert.deepEqual(
		selectChannelIdsByType(
			[
				{ id: "C0TWICE01", is_channel: true },
				{ id: "C0TWICE01", is_channel: true },
			],
			parseChannelTypes(["public"]),
		),
		["C0TWICE01"],
	);
});

test("a restriction narrows the type selection and never widens it", () => {
	const typed = ["C0PUBLIC1", "C0PUBLIC2"];
	assert.deepEqual(channelsForRun([], typed), typed, "no restriction at all");
	assert.deepEqual(channelsForRun([["C0PUBLIC2", "D0DIRECT01"]], typed), [
		"C0PUBLIC2",
	]);
	assert.deepEqual(channelsForRun([["D0DIRECT01"]], typed), []);
	assert.deepEqual(channelsForRun([["C0PUBLIC1", "C0PUBLIC1"]], typed), [
		"C0PUBLIC1",
	]);
});

test("two restrictions are intersected, not united", () => {
	const typed = ["C0PUBLIC1", "C0PUBLIC2"];
	assert.deepEqual(
		channelsForRun([["C0PUBLIC1", "C0PUBLIC2"], ["C0PUBLIC1"]], typed),
		["C0PUBLIC1"],
		"a grant naming both and an allowlist naming one leave one",
	);
	assert.deepEqual(
		channelsForRun([["C0PUBLIC1"], ["C0PUBLIC2"]], typed),
		[],
		"disjoint restrictions leave nothing",
	);
});

test("a restriction that is present but empty leaves nothing instead of everything", () => {
	assert.deepEqual(channelsForRun([[]], ["C0PUBLIC1"]), []);
	assert.deepEqual(channelsForRun([["C0PUBLIC1"], []], ["C0PUBLIC1"]), []);
});

const ALLOWED = new Set(["C0PUBLIC1"]);

test("a restricted run drops a record of any channel outside the chosen types", () => {
	const named: Array<[string, string]> = [
		["channels", "id"],
		["channel_stats", "channel_id"],
		["channel_memberships", "channel_id"],
		["messages", "channel_id"],
		["message_attachments", "channel_id"],
		["reactions", "channel_id"],
		["dm_read_states", "channel_id"],
		["canvases", "channel_id"],
		["stars", "channel_id"],
	];
	for (const [stream, key] of named) {
		const inside = { [key]: "C0PUBLIC1", marker: stream };
		assert.equal(
			restrictRecordToChannels(stream, inside, ALLOWED),
			inside,
			stream,
		);
		assert.equal(
			restrictRecordToChannels(stream, { [key]: "D0DIRECT01" }, ALLOWED),
			null,
			stream,
		);
		assert.equal(
			restrictRecordToChannels(stream, { [key]: "C0NOTLISTD" }, ALLOWED),
			null,
			`${stream}: a channel the listing never named`,
		);
	}
});

test("a record that should name a channel but does not is dropped, except for items outside channels", () => {
	for (const stream of [
		"messages",
		"reactions",
		"channel_stats",
		"dm_read_states",
	]) {
		assert.equal(
			restrictRecordToChannels(stream, { id: "x" }, ALLOWED),
			null,
			stream,
		);
		assert.equal(
			restrictRecordToChannels(stream, { channel_id: null }, ALLOWED),
			null,
			stream,
		);
	}
	for (const stream of ["stars", "canvases"]) {
		const standalone = { id: "x", channel_id: null };
		assert.equal(
			restrictRecordToChannels(stream, standalone, ALLOWED),
			standalone,
			stream,
		);
	}
});

test("a user group keeps its record but loses channels outside the chosen types", () => {
	const kept = restrictRecordToChannels(
		"user_groups",
		{ id: "S1", channel_ids: ["C0PUBLIC1", "G0PRIVATE1", 7] },
		ALLOWED,
	);
	assert.deepEqual(kept, { id: "S1", channel_ids: ["C0PUBLIC1"] });
	const none = { id: "S2", channel_ids: null };
	assert.equal(restrictRecordToChannels("user_groups", none, ALLOWED), none);
});

test("streams with no channel pass through untouched", () => {
	for (const stream of ["workspace", "users", "files", "reminders"]) {
		const record = { id: "x", channel_id: "G0PRIVATE1" };
		assert.equal(
			restrictRecordToChannels(stream, record, ALLOWED),
			record,
			stream,
		);
	}
});

for (const key of [
	"is_im",
	"is_mpim",
	"is_private",
	"is_group",
	"is_channel",
]) {
	test(`every present ${key} must be boolean even beside a valid type flag`, () => {
		for (const value of ["true", "false", 1, 0, null, undefined, {}, []]) {
			const entry =
				key === "is_channel"
					? { is_private: true, [key]: value }
					: { is_channel: true, [key]: value };
			assert.equal(
				reasonOf(() => classifyChannelType(entry)),
				"ambiguous",
				key,
			);
		}
	});
}
test("a true private flag does not hide a malformed group flag", () => {
	assert.equal(
		reasonOf(() =>
			classifyChannelType({
				is_channel: true,
				is_private: true,
				is_group: "true",
			}),
		),
		"ambiguous",
	);
});
test("absent and explicitly false optional flags preserve public classification", () => {
	assert.equal(classifyChannelType({ is_channel: true }), "public");
	assert.equal(
		classifyChannelType({
			is_channel: true,
			is_private: false,
			is_group: false,
			is_im: false,
			is_mpim: false,
		}),
		"public",
	);
});
