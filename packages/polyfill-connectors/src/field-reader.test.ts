// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	buildRow,
	emitRow,
	enumerated,
	type FieldOmission,
	type FieldPath,
	type FieldRead,
	type FieldValidator,
	fieldValue,
	firstReadable,
	mapField,
	type ReadFieldOptions,
	readField,
	v,
} from "./field-reader.ts";

interface Case {
	readonly expect: FieldRead<unknown> | "unavailable";
	readonly name: string;
	readonly options?: ReadFieldOptions;
	readonly paths: FieldPath | readonly FieldPath[];
	readonly source: unknown;
	readonly validator: FieldValidator<unknown>;
}

const read = <T>(value: T): FieldRead<T> => ({ kind: "read", value });
const EMPTY = { kind: "explicit_empty" } as const;

const CASES: readonly Case[] = [
	// strings: empty strings are values, not absence
	{
		name: "string read",
		source: { a: "x" },
		paths: "a",
		validator: v.string(),
		expect: read("x"),
	},
	{
		name: "empty string is a real value",
		source: { a: "" },
		paths: "a",
		validator: v.string(),
		expect: read(""),
	},
	{
		name: "nonEmpty rejects empty string",
		source: { a: "" },
		paths: "a",
		validator: v.string({ nonEmpty: true }),
		expect: "unavailable",
	},
	{
		name: "number where string expected",
		source: { a: 42 },
		paths: "a",
		validator: v.string(),
		expect: "unavailable",
	},
	{
		name: "explicit null is empty",
		source: { a: null },
		paths: "a",
		validator: v.string(),
		expect: EMPTY,
	},
	{
		name: "absent key is unavailable by default",
		source: {},
		paths: "a",
		validator: v.string(),
		expect: "unavailable",
	},
	{
		name: "absent key is empty only on opt-in",
		source: {},
		paths: "a",
		validator: v.string(),
		options: { absent: "empty" },
		expect: EMPTY,
	},
	{
		name: "opt-in absence does not excuse a malformed value",
		source: { a: 42 },
		paths: "a",
		validator: v.string(),
		options: { absent: "empty" },
		expect: "unavailable",
	},
	// numbers
	{
		name: "zero is a real value",
		source: { n: 0 },
		paths: "n",
		validator: v.number(),
		expect: read(0),
	},
	{
		name: "NaN is malformed",
		source: { n: Number.NaN },
		paths: "n",
		validator: v.number(),
		expect: "unavailable",
	},
	{
		name: "numeric string is not a number",
		source: { n: "3" },
		paths: "n",
		validator: v.number(),
		expect: "unavailable",
	},
	{
		name: "integer option",
		source: { n: 1.5 },
		paths: "n",
		validator: v.number({ integer: true }),
		expect: "unavailable",
	},
	{
		name: "min option",
		source: { n: -1 },
		paths: "n",
		validator: v.number({ min: 0 }),
		expect: "unavailable",
	},
	// booleans: no truthiness
	{
		name: "false is a real value",
		source: { b: false },
		paths: "b",
		validator: v.boolean(),
		expect: read(false),
	},
	{
		name: "string 'false' is not a boolean",
		source: { b: "false" },
		paths: "b",
		validator: v.boolean(),
		expect: "unavailable",
	},
	// dates
	{
		name: "ISO date",
		source: { d: "2026-10-15" },
		paths: "d",
		validator: v.date(),
		expect: read("2026-10-15"),
	},
	{
		name: "ISO date-time with offset",
		source: { d: "2026-10-15T01:02:03Z" },
		paths: "d",
		validator: v.date(),
		expect: read("2026-10-15T01:02:03Z"),
	},
	{
		name: "not a date",
		source: { d: "yesterday" },
		paths: "d",
		validator: v.date(),
		expect: "unavailable",
	},
	{
		name: "day that does not exist",
		source: { d: "2026-02-30" },
		paths: "d",
		validator: v.date(),
		expect: "unavailable",
	},
	{
		name: "impossible date",
		source: { d: "2026-13-45" },
		paths: "d",
		validator: v.date(),
		expect: "unavailable",
	},
	{
		name: "epoch millis to ISO",
		source: { t: 0 },
		paths: "t",
		validator: v.epochMillis(),
		expect: read("1970-01-01T00:00:00.000Z"),
	},
	{
		name: "epoch empty sentinel",
		source: { t: 0 },
		paths: "t",
		validator: v.epochMillis({ emptyAt: [0] }),
		expect: EMPTY,
	},
	{
		name: "epoch as string is malformed",
		source: { t: "1700000000000" },
		paths: "t",
		validator: v.epochMillis(),
		expect: "unavailable",
	},
	// urls
	{
		name: "https URL",
		source: { u: "https://example.com/x" },
		paths: "u",
		validator: v.url(),
		expect: read("https://example.com/x"),
	},
	{
		name: "relative URL is malformed",
		source: { u: "/x" },
		paths: "u",
		validator: v.url(),
		expect: "unavailable",
	},
	{
		name: "javascript URL is malformed",
		source: { u: "javascript:alert(1)" },
		paths: "u",
		validator: v.url(),
		expect: "unavailable",
	},
	// enums
	{
		name: "enum member",
		source: { e: "Playlist" },
		paths: "e",
		validator: v.enumOf(["Playlist", "Folder"]),
		expect: read("Playlist"),
	},
	{
		name: "unknown enum member is malformed",
		source: { e: "Album" },
		paths: "e",
		validator: v.enumOf(["Playlist", "Folder"]),
		expect: "unavailable",
	},
	// arrays: one bad element fails the whole array, nothing is filtered away
	{
		name: "empty array is a real value",
		source: { xs: [] },
		paths: "xs",
		validator: v.arrayOf(v.string()),
		expect: read([]),
	},
	{
		name: "array of strings",
		source: { xs: ["a", ""] },
		paths: "xs",
		validator: v.arrayOf(v.string()),
		expect: read(["a", ""]),
	},
	{
		name: "one bad element",
		source: { xs: ["a", 1] },
		paths: "xs",
		validator: v.arrayOf(v.string()),
		expect: "unavailable",
	},
	{
		name: "null element",
		source: { xs: ["a", null] },
		paths: "xs",
		validator: v.arrayOf(v.string()),
		expect: "unavailable",
	},
	{
		name: "object where array expected",
		source: { xs: {} },
		paths: "xs",
		validator: v.arrayOf(v.string()),
		expect: "unavailable",
	},
	// paths
	{
		name: "nested path",
		source: { a: { b: "x" } },
		paths: ["a", "b"],
		validator: v.string(),
		expect: read("x"),
	},
	{
		name: "index path",
		source: { a: ["x", "y"] },
		paths: ["a", 1],
		validator: v.string(),
		expect: read("y"),
	},
	{
		name: "key with dots is one segment",
		source: { "com.x.Image": "u" },
		paths: ["com.x.Image"],
		validator: v.string(),
		expect: read("u"),
	},
	{
		name: "parent explicitly null is empty",
		source: { a: null },
		paths: ["a", "b"],
		validator: v.string(),
		expect: EMPTY,
	},
	{
		name: "parent of wrong type is malformed",
		source: { a: 42 },
		paths: ["a", "b"],
		validator: v.string(),
		expect: "unavailable",
	},
	{
		name: "index into non-array is malformed",
		source: { a: {} },
		paths: ["a", 0],
		validator: v.string(),
		expect: "unavailable",
	},
	{
		name: "inherited key is absent",
		source: Object.create({ a: "x" }) as object,
		paths: "a",
		validator: v.string(),
		expect: "unavailable",
	},
	// fallbacks
	{
		name: "readable fallback satisfies the field",
		source: { a: 42, b: "x" },
		paths: [["a"], ["b"]],
		validator: v.string(),
		expect: read("x"),
	},
	{
		name: "first readable path wins",
		source: { a: "first", b: "second" },
		paths: [["a"], ["b"]],
		validator: v.string(),
		expect: read("first"),
	},
	{
		name: "malformed with no readable fallback",
		source: { a: 42 },
		paths: [["a"], ["b"]],
		validator: v.string(),
		expect: "unavailable",
	},
	{
		name: "malformed beats empty",
		source: { a: 42, b: null },
		paths: [["a"], ["b"]],
		validator: v.string(),
		expect: "unavailable",
	},
	{
		name: "empty with absent fallback",
		source: { a: null },
		paths: [["a"], ["b"]],
		validator: v.string(),
		expect: EMPTY,
	},
];

for (const c of CASES) {
	test(`readField: ${c.name}`, () => {
		const result = readField(c.source, c.paths, c.validator, c.options);
		if (c.expect === "unavailable") {
			assert.equal(result.kind, "unavailable", JSON.stringify(result));
			assert.ok(result.kind === "unavailable" && result.reason.length > 0);
		} else assert.deepEqual(result, c.expect);
	});
}

test("readField: the unavailable reason names the failing path", () => {
	const result = readField({ a: { b: 42 } }, [["a", "b"], ["c"]], v.string());
	assert.deepEqual(result, {
		kind: "unavailable",
		reason: "a.b: expected string, got number",
	});
});

test("firstReadable: precedence across separately read sources", () => {
	const bad = { kind: "unavailable", reason: "x: bad" } as const;
	assert.deepEqual(firstReadable(EMPTY, read("b")), read("b"));
	assert.deepEqual(firstReadable(bad, read("b")), read("b"));
	assert.deepEqual(firstReadable(bad, EMPTY), bad);
	assert.deepEqual(firstReadable(EMPTY, EMPTY), EMPTY);
});

test("mapField: only read values are transformed", () => {
	const upper = (s: string): FieldRead<string> => read(s.toUpperCase());
	assert.deepEqual(mapField(read("a"), upper), read("A"));
	assert.deepEqual(mapField(EMPTY, upper), EMPTY);
	assert.deepEqual(mapField({ kind: "unavailable", reason: "r" }, upper), {
		kind: "unavailable",
		reason: "r",
	});
});

test("buildRow: a row is covered only when no field is unavailable", () => {
	const source = { id: "1", title: "", count: 42, when: null };
	const covered = buildRow({
		id: readField(source, "id", v.string({ nonEmpty: true })),
		title: readField(source, "title", v.string()),
		when: readField(source, "when", v.date()),
	});
	assert.deepEqual(covered, {
		covered: true,
		data: { id: "1", title: "", when: null },
	});

	const uncovered = buildRow({
		id: fieldValue("1"),
		title: readField(source, "count", v.string()),
		missing: readField(source, "nope", v.string()),
	});
	assert.equal(uncovered.covered, false);
	assert.deepEqual(uncovered.covered ? [] : uncovered.omissions, [
		{ field: "title", reason: "count: expected string, got number" },
		{ field: "missing", reason: "absent: nope" },
	]);
});

test("emitRow: covered rows emit plainly; uncovered rows carry their omissions to the runtime", async () => {
	const calls: Array<{
		data: Record<string, unknown>;
		omissions?: readonly FieldOmission[];
	}> = [];
	const ctx = {
		emitRecord: (
			_stream: string,
			data: Record<string, unknown>,
			options?: { omissions?: readonly FieldOmission[] },
		) => {
			calls.push({
				data,
				...(options ? { omissions: options.omissions } : {}),
			});
			return Promise.resolve();
		},
	};
	assert.equal(
		await emitRow(ctx, "s", buildRow({ id: fieldValue("1") })),
		true,
	);
	assert.equal(
		await emitRow(
			ctx,
			"s",
			buildRow({ id: fieldValue("2"), x: readField({}, "x", v.string()) }),
		),
		false,
	);
	assert.deepEqual(calls, [
		{ data: { id: "1" } },
		{
			data: { id: "2", x: null },
			omissions: [{ field: "x", reason: "absent: x" }],
		},
	]);
});

// ─── Declared absence semantics (sparse sources) ────────────────────────

test("readField: absence fails closed unless the field declares what absence means", () => {
	const sparse = { recordName: "note-1", fields: { Title: { value: "t" } } };
	assert.equal(
		readField(sparse, ["fields", "IsPinned", "value"], v.boolean()).kind,
		"unavailable",
	);
	// CloudKit omits a field that holds its default; IsPinned defaults to false.
	assert.deepEqual(
		readField(sparse, ["fields", "IsPinned", "value"], v.boolean(), {
			absent: { default: false },
		}),
		{ kind: "read", value: false },
	);
});

test("readField: a declared default never excuses a present-but-malformed value", () => {
	for (const pinned of [{ value: "false" }, { value: {} }, 42])
		assert.equal(
			readField(
				{ fields: { IsPinned: pinned } },
				["fields", "IsPinned", "value"],
				v.boolean(),
				{
					absent: { default: false },
				},
			).kind,
			"unavailable",
			JSON.stringify(pinned),
		);
});

test("readField: a declared default must itself pass the validator", () => {
	assert.throws(
		() => readField({}, "n", v.number({ min: 0 }), { absent: { default: -1 } }),
		/declared default/,
	);
});

test("buildRow: a row whose sparse optional fields are absent emits their declared defaults and stays covered", () => {
	const note = {
		recordName: "note-1",
		fields: { Title: { value: "Groceries" } },
	};
	const row = buildRow({
		id: readField(note, "recordName", v.string({ nonEmpty: true })),
		title: readField(note, ["fields", "Title", "value"], v.string()),
		is_pinned: readField(note, ["fields", "IsPinned", "value"], v.boolean(), {
			absent: { default: false },
		}),
		has_attachments: readField(
			note,
			["fields", "Attachments", "value"],
			v.arrayOf(v.object()),
			{ absent: { default: [] } },
		),
	});
	assert.deepEqual(row, {
		covered: true,
		data: {
			id: "note-1",
			title: "Groceries",
			is_pinned: false,
			has_attachments: [],
		},
	});
	const undeclared = buildRow({
		id: readField(note, "recordName", v.string({ nonEmpty: true })),
		is_pinned: readField(note, ["fields", "IsPinned", "value"], v.boolean()),
	});
	assert.equal(
		undeclared.covered,
		false,
		"without a declaration the row fails closed",
	);
});

// ─── enumerated: an array alone is never a full inventory ───────────────

const ENUMERATION_CASES: ReadonlyArray<{
	readonly evidence: Parameters<typeof enumerated>[1];
	readonly expect: "complete" | "incomplete";
	readonly items: readonly unknown[];
	readonly name: string;
}> = [
	// The two counterexamples from the LinkedIn #406 review.
	{
		name: "one item of a total of two is not complete",
		items: ["x"],
		evidence: { kind: "offset", start: 0, count: 1, total: 2 },
		expect: "incomplete",
	},
	{
		name: "an empty page while the source reports one row is not complete",
		items: [],
		evidence: { kind: "offset", start: 0, count: 10, total: 1 },
		expect: "incomplete",
	},
	{
		name: "no evidence at all is not complete",
		items: ["x"],
		evidence: undefined,
		expect: "incomplete",
	},
	{
		name: "offset paging from 0 whose total equals the items is complete",
		items: ["x", "y"],
		evidence: { kind: "offset", start: 0, count: 40, total: 2 },
		expect: "complete",
	},
	{
		name: "a verified empty collection is complete",
		items: [],
		evidence: { kind: "offset", start: 0, total: 0 },
		expect: "complete",
	},
	{
		name: "a walk that does not start at 0 is not complete",
		items: ["x"],
		evidence: { kind: "offset", start: 40, total: 1 },
		expect: "incomplete",
	},
	{
		name: "a reported continuation is not complete",
		items: ["x"],
		evidence: { kind: "offset", start: 0, total: 1, continuation: "/next" },
		expect: "incomplete",
	},
	{
		name: "a total that is not a count is not complete",
		items: ["x"],
		evidence: { kind: "offset", start: 0, total: "1" },
		expect: "incomplete",
	},
	{
		name: "a malformed count is not complete",
		items: ["x"],
		evidence: { kind: "offset", start: 0, count: -1, total: 1 },
		expect: "incomplete",
	},
	{
		name: "a cursor walk from the first page through a contiguous chain to an explicit end is complete",
		items: ["x", "y"],
		evidence: {
			kind: "cursor",
			pages: [
				{ requested_cursor: null, has_more: true, next_cursor: "a" },
				{ requested_cursor: "a", has_more: false, next_cursor: null },
			],
		},
		expect: "complete",
	},
	{
		name: "review core#3: a resumed walk's genuine last page is not a full inventory",
		items: ["x"],
		evidence: {
			kind: "cursor",
			pages: [{ requested_cursor: "c90", has_more: false, next_cursor: null }],
		},
		expect: "incomplete",
	},
	{
		name: "a chain whose request does not follow the previous next cursor is not complete",
		items: ["x", "y"],
		evidence: {
			kind: "cursor",
			pages: [
				{ requested_cursor: null, has_more: true, next_cursor: "a" },
				{ requested_cursor: "b", has_more: false, next_cursor: null },
			],
		},
		expect: "incomplete",
	},
	{
		name: "a page that says it was the last but was followed is not complete",
		items: ["x", "y"],
		evidence: {
			kind: "cursor",
			pages: [
				{ requested_cursor: null, has_more: false, next_cursor: "a" },
				{ requested_cursor: "a", has_more: false, next_cursor: null },
			],
		},
		expect: "incomplete",
	},
	{
		name: "a missing has_more on the last page is not an end",
		items: ["x"],
		evidence: {
			kind: "cursor",
			pages: [
				{ requested_cursor: null, has_more: undefined, next_cursor: null },
			],
		},
		expect: "incomplete",
	},
	{
		name: "has_more false with a next cursor contradicts itself",
		items: ["x"],
		evidence: {
			kind: "cursor",
			pages: [{ requested_cursor: null, has_more: false, next_cursor: "abc" }],
		},
		expect: "incomplete",
	},
	{
		name: "a cursor walk whose total disagrees with the items is not complete",
		items: ["x"],
		evidence: {
			kind: "cursor",
			pages: [{ requested_cursor: null, has_more: false, next_cursor: null }],
			total: 2,
		},
		expect: "incomplete",
	},
	{
		name: "without a first-page chain, a total equal to the items read and an explicit end is complete",
		items: ["x"],
		evidence: {
			kind: "cursor",
			pages: [{ requested_cursor: "c90", has_more: false, next_cursor: null }],
			total: 1,
		},
		expect: "complete",
	},
	{
		name: "no pages at all is not complete",
		items: [],
		evidence: { kind: "cursor", pages: [] },
		expect: "incomplete",
	},
	{
		name: "a declared unpaged container is complete",
		items: ["x"],
		evidence: { kind: "unpaged", basis: "source_returns_whole_collection" },
		expect: "complete",
	},
];

for (const c of ENUMERATION_CASES) {
	test(`enumerated: ${c.name}`, () => {
		const result = enumerated(c.items, c.evidence);
		assert.equal(result.kind, c.expect, JSON.stringify(result));
		assert.deepEqual(result.items, c.items, "the items read are kept");
		if (result.kind === "incomplete") assert.ok(result.reason.length > 0);
	});
}

test("review core#3: last-page metadata alone (the reviewer's trace) is not a full inventory", () => {
	// The pre-repair evidence shape: only the final page's end signal.
	const lastPageOnly = { kind: "cursor", has_more: false, next_cursor: null };
	const result = enumerated(["tail"], lastPageOnly as never);
	assert.equal(result.kind, "incomplete", JSON.stringify(result));
});
