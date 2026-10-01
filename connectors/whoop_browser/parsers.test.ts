// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type Built,
	bootstrapFacts,
	type Cycle,
	cycleElements,
	parseRange,
	readElement,
	recordsFor,
	toInstant,
	toOffset,
} from "./parsers.ts";
import { SCHEMAS, STREAMS, type Stream, validateRecord } from "./schemas.ts";

type Obj = Record<string, unknown>;

const read = (name: string): unknown =>
	JSON.parse(
		readFileSync(new URL(`./${name}`, import.meta.url), "utf8"),
	) as unknown;

// ── Fixture elements, read afresh so each test owns its copy ───────────────
/** 0: scored, with a recovery, a sleep, a nap and a run. 1: no recovery, no sleep. 2: still under way. */
function fixtureElement(index: 0 | 1 | 2): Obj {
	const { records } = read("fixtures/cycles-details.json") as {
		records: Obj[];
	};
	return records[index] as Obj;
}
const scored = (): Obj => fixtureElement(0);
const quiet = (): Obj => fixtureElement(1);
const underWay = (): Obj => fixtureElement(2);

/** `base` with `changes` laid over it; a change to `undefined` removes the key. */
const merged = (base: unknown, changes: Obj): Obj =>
	Object.fromEntries(
		Object.entries({ ...(base as Obj), ...changes }).filter(
			([, value]) => value !== undefined,
		),
	);

type Part = "cycle" | "recovery" | "sleeps" | "workouts";
/** An element with one part changed: its cycle or recovery object, or its first sleep or workout, kept alone. */
function withPart(element: Obj, part: Part, changes: Obj): Obj {
	const current = element[part];
	return {
		...element,
		[part]: Array.isArray(current)
			? [merged(current[0], changes)]
			: merged(current, changes),
	};
}
const PART: Record<Stream, Part> = {
	cycles: "cycle",
	recoveries: "recovery",
	sleeps: "sleeps",
	workouts: "workouts",
};

function cycleOf(element: unknown): Cycle {
	const result = readElement(element);
	if (result.kind !== "cycle") {
		assert.fail(`element unreadable, lost ${JSON.stringify(result.lost)}`);
	}
	return result.cycle;
}
function lostBy(element: unknown): Record<Stream, number> {
	const result = readElement(element);
	if (result.kind !== "unreadable") {
		assert.fail(`element read as cycle ${result.cycle.id}`);
	}
	return result.lost;
}
const builtFor = (stream: Stream, element: unknown): Built[] =>
	recordsFor(stream, cycleOf(element));
const kinds = (list: Built[]): string[] => list.map(({ kind }) => kind);
function recordOf(built: Built | undefined): RecordData {
	if (built?.kind !== "record") {
		assert.fail(`not a record: ${built?.kind}`);
	}
	return built.record;
}
const records = (stream: Stream, element: unknown): RecordData[] =>
	builtFor(stream, element).map(recordOf);
/** What a stream builds from the scored element with its source object changed. */
const builtWith = (stream: Stream, changes: Obj): Built[] =>
	builtFor(stream, withPart(scored(), PART[stream], changes));
/** The one record built that way. */
function recordWith(stream: Stream, changes: Obj): RecordData {
	const list = builtWith(stream, changes);
	assert.equal(list.length, 1, `${stream}: one built`);
	return recordOf(list[0]);
}

// ── The manifest's JSON Schema beside Zod ──────────────────────────────────
interface JsonSchema {
	type?: string | string[];
	format?: string;
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	exclusiveMaximum?: number;
	anyOf?: JsonSchema[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	additionalProperties?: boolean;
}
interface ManifestStream {
	name: string;
	primary_key: string[];
	cursor_field: string;
	consent_time_field: string;
	schema: JsonSchema;
}
const manifest = read("manifest.json") as { streams: ManifestStream[] };
function manifestSchema(stream: Stream): JsonSchema {
	const spec = manifest.streams.find(({ name }) => name === stream);
	assert.ok(spec, `${stream} in manifest`);
	return spec.schema;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const manifestCheck = new Map(
	STREAMS.map(
		(stream) => [stream, ajv.compile(manifestSchema(stream))] as const,
	),
);

/** Whether Zod (cleanly, with no anomaly) and the manifest's JSON Schema each accept a record. */
function verdicts(
	stream: Stream,
	record: RecordData,
): { zod: boolean; manifest: boolean } {
	const check = validateRecord(stream, record);
	const compiled = manifestCheck.get(stream);
	assert.ok(compiled);
	return {
		zod: check.ok && !check.anomalies?.length,
		manifest: compiled(record),
	};
}

const BOUNDS = [
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
] as const;
/** A property's JSON types, format and numeric bounds, read the same way from either side. */
function jsonFacts(schema: JsonSchema | undefined): Obj {
	const parts = schema?.anyOf ?? (schema ? [schema] : []);
	const valued = parts.find(({ type }) => type !== "null") ?? {};
	const bound = (value: number | undefined): number | null =>
		// Zod writes a bare z.int() as the safe-integer range: its domain, not a declared bound.
		value === undefined || Math.abs(value) === Number.MAX_SAFE_INTEGER
			? null
			: value;
	return {
		types: parts
			.flatMap(({ type }) => (type === undefined ? [] : [type].flat()))
			.sort(),
		format: valued.format ?? null,
		...Object.fromEntries(BOUNDS.map((key) => [key, bound(valued[key])])),
	};
}

const A = "2026-09-14T12:40:00.000Z";
const B = "2026-09-15T13:05:00.000Z";

// ── parseRange ─────────────────────────────────────────────────────────────
test("parseRange reads half-open and closed ranges, in either quote style, spaces allowed", () => {
	const both = { lower: A, upper: B };
	assert.deepEqual(parseRange(`['${A}','${B}')`), both);
	assert.deepEqual(parseRange(`['${A}','${B}']`), both);
	assert.deepEqual(parseRange(`('${A}','${B}')`), both);
	assert.deepEqual(parseRange(`["${A}","${B}")`), both);
	assert.deepEqual(parseRange(`['${A}',"${B}")`), both);
	assert.deepEqual(parseRange(` [ '${A}' , '${B}' ) `), both);
	assert.deepEqual(parseRange(`[${A},${B})`), both);
});

test("parseRange: an empty or infinite bound is null, so an open cycle keeps its start", () => {
	assert.deepEqual(parseRange(`['${A}',)`), { lower: A, upper: null });
	assert.deepEqual(parseRange(`['${A}','')`), { lower: A, upper: null });
	assert.deepEqual(parseRange(`[,'${B}')`), { lower: null, upper: B });
	assert.deepEqual(parseRange(`['${A}',infinity)`), { lower: A, upper: null });
	assert.deepEqual(parseRange(`['${A}','Infinity')`), {
		lower: A,
		upper: null,
	});
	assert.deepEqual(parseRange(`[-infinity,'${B}')`), { lower: null, upper: B });
	assert.deepEqual(parseRange("[,)"), { lower: null, upper: null });
});

test("parseRange refuses what is not a range", () => {
	for (const value of [
		null,
		undefined,
		42,
		{},
		[A, B],
		"",
		"empty",
		A,
		`'${A}','${B}'`,
		`['${A}','${B}'`,
		`{'${A}','${B}'}`,
		`['${A}')`,
		`['${A}','${B}','${A}')`,
	]) {
		assert.equal(parseRange(value), null, `${JSON.stringify(value)}`);
	}
});

// ── toInstant ──────────────────────────────────────────────────────────────
test("toInstant writes WHOOP's Z and +0000 instants as RFC 3339 UTC with milliseconds", () => {
	assert.equal(toInstant(A), A);
	assert.equal(toInstant("2026-09-14T12:40:00Z"), A);
	assert.equal(
		toInstant("2026-09-15T13:06:00.000+0000"),
		"2026-09-15T13:06:00.000Z",
	);
	// The owner's next morning is still the previous day in UTC.
	assert.equal(
		toInstant("2026-09-15T08:40:00.000+1000"),
		"2026-09-14T22:40:00.000Z",
	);
	assert.equal(
		toInstant("2026-09-15T08:40:00.000+10:00"),
		"2026-09-14T22:40:00.000Z",
	);
	assert.equal(
		toInstant("2026-09-14T18:10:00.000-0530"),
		"2026-09-14T23:40:00.000Z",
	);
});

test("toInstant refuses a date with no time, and anything else that is not an instant", () => {
	for (const value of [
		null,
		undefined,
		1_789_885_800,
		"",
		"2026-09-14",
		"2026-09-14 12:40:00Z",
		"14/09/2026 12:40",
		"yesterday",
		`${A}junk`,
		"2026-13-14T12:40:00.000Z",
		"2026-09-14T12:40:00.000+10",
		"2026-09-14T12:40:00 GMT",
	]) {
		assert.equal(toInstant(value), null, `${JSON.stringify(value)}`);
	}
});

test("toInstant takes a zone as Z or z, ±HH:MM or ±HHMM, each naming the same instant", () => {
	for (const value of [
		"2026-09-14T12:40:00.000Z",
		"2026-09-14T12:40:00.000z",
		"2026-09-14T12:40:00Z",
		"2026-09-14T12:40:00z",
		"2026-09-14T12:40Z",
		"2026-09-14T12:40:00.000+0000",
		"2026-09-14T12:40:00.000-00:00",
		"2026-09-14T22:40:00.000+1000",
		"2026-09-14T22:40:00.000+10:00",
		"2026-09-14T22:40:00+1000",
		"2026-09-14T22:40+10:00",
		"2026-09-14T07:10:00.000-0530",
		"2026-09-14T07:10:00.000-05:30",
	]) {
		assert.equal(toInstant(value), A, value);
	}
});

test("toInstant refuses an instant with no zone rather than read it in the host's zone", () => {
	assert.equal(toInstant("2026-09-14T12:40:00.000"), null);
	assert.equal(toInstant("2026-09-14T12:40:00"), null);
	assert.equal(toInstant("2026-09-14T12:40"), null);
	// Through a range: a sleep whose bounds carry no zone is unreadable, not moved by the host's offset.
	assert.deepEqual(
		kinds(
			builtWith("sleeps", {
				during: "['2026-09-14T12:40:00.000','2026-09-14T20:55:00.000')",
			}),
		),
		["unreadable"],
	);
});

test("toInstant refuses a day the calendar does not have", () => {
	assert.equal(toInstant("2026-02-30T12:00:00.000Z"), null);
	assert.equal(toInstant("2026-09-31T12:00:00.000Z"), null);
	assert.equal(toInstant("2026-02-29T12:00:00.000Z"), null, "not a leap year");
	assert.equal(
		toInstant("2028-02-29T12:00:00.000Z"),
		"2028-02-29T12:00:00.000Z",
		"a leap day",
	);
	// Through a range: a cycle starting on such a day has no start, so its element is unreadable.
	assert.deepEqual(
		lostBy(
			withPart(scored(), "cycle", {
				during: `['2026-09-31T12:40:00.000Z','${B}')`,
			}),
		),
		{ cycles: 1, recoveries: 1, sleeps: 2, workouts: 1 },
	);
});

// ── toOffset ───────────────────────────────────────────────────────────────
test("toOffset writes ±HHMM, ±HH:MM and Z as ±HH:MM, and anything else as null", () => {
	assert.equal(toOffset("+1000"), "+10:00");
	assert.equal(toOffset("-0530"), "-05:30");
	assert.equal(toOffset("+0000"), "+00:00");
	assert.equal(toOffset("+10:00"), "+10:00");
	assert.equal(toOffset("-03:30"), "-03:30");
	assert.equal(toOffset("Z"), "+00:00");
	for (const value of [
		null,
		undefined,
		600,
		"",
		"z",
		"UTC",
		"+10",
		"+1:00",
		"1000",
		"10:00",
		"AEST",
		"Australia/Sydney",
		" +10:00",
		"+10:00 ",
		"+10:00:00",
	]) {
		assert.equal(toOffset(value), null, `${JSON.stringify(value)}`);
	}
});

// ── bootstrapFacts ─────────────────────────────────────────────────────────
test("bootstrapFacts reads the fixture's user id and account start", () => {
	assert.deepEqual(bootstrapFacts(read("fixtures/bootstrap.json")), {
		userId: "41001",
		createdAt: "2026-08-01T09:30:00.000Z",
	});
});

test("bootstrapFacts takes user.id, account.user_id or profile.user_id, and never account.id", () => {
	const only = { userId: "41001", createdAt: null };
	assert.deepEqual(bootstrapFacts({ user: { id: 41_001 } }), only);
	assert.deepEqual(bootstrapFacts({ account: { user_id: 41_001 } }), only);
	assert.deepEqual(bootstrapFacts({ profile: { user_id: 41_001 } }), only);
	assert.deepEqual(
		bootstrapFacts({
			user: { id: null },
			account: { user_id: 41_001 },
			profile: null,
		}),
		only,
	);
	assert.deepEqual(
		bootstrapFacts({
			user: { id: 41_001 },
			account: { id: 52_001, user_id: 41_001 },
			profile: { user_id: 41_001 },
		}),
		only,
	);
	assert.deepEqual(
		bootstrapFacts({ user: { id: 41_001 }, account: { id: 52_001 } }),
		only,
	);
	assert.equal(bootstrapFacts({ account: { id: 52_001 } }), null);
});

test("bootstrapFacts: ids that disagree, or one that is not a positive integer, are drift", () => {
	for (const json of [
		{ user: { id: 41_001 }, account: { user_id: 41_002 } },
		{ user: { id: 41_001 }, profile: { user_id: 41_002 } },
		{ account: { user_id: 41_001 }, profile: { user_id: 41_002 } },
		{
			user: { id: 41_001 },
			account: { user_id: 41_001 },
			profile: { user_id: 41_002 },
		},
	]) {
		assert.equal(bootstrapFacts(json), null, JSON.stringify(json));
	}
	for (const id of ["41001", 0, -41_001, 41_001.5, 2 ** 53, true, {}]) {
		assert.equal(
			bootstrapFacts({ user: { id } }),
			null,
			`user.id ${JSON.stringify(id)}`,
		);
		assert.equal(
			bootstrapFacts({ user: { id: 41_001 }, account: { user_id: id } }),
			null,
			`account.user_id ${JSON.stringify(id)}`,
		);
	}
});

test("bootstrapFacts: the account's start is account.created_at, else user.created_at, else null", () => {
	const at = (account: Obj, user: Obj): string | null | undefined =>
		bootstrapFacts({
			user: { id: 41_001, ...user },
			account: { user_id: 41_001, ...account },
		})?.createdAt;
	const later = { created_at: "2026-08-02T00:00:00.000Z" };
	assert.equal(
		at({ created_at: "2026-08-01T09:30:00.000+0000" }, later),
		"2026-08-01T09:30:00.000Z",
	);
	assert.equal(at({}, later), "2026-08-02T00:00:00.000Z");
	assert.equal(at({ created_at: null }, later), "2026-08-02T00:00:00.000Z");
	assert.equal(
		at({ created_at: "long ago" }, later),
		"2026-08-02T00:00:00.000Z",
	);
	assert.equal(at({}, {}), null);
	assert.equal(at({ created_at: "2026-08-01" }, {}), null);
});

test("bootstrapFacts: anything but an object holding a user id is null", () => {
	for (const json of [
		null,
		undefined,
		"41001",
		41_001,
		[],
		[{ user: { id: 41_001 } }],
		{},
		{ user: {}, account: {}, profile: {} },
		{ user: "41001" },
	]) {
		assert.equal(bootstrapFacts(json), null, `${JSON.stringify(json)}`);
	}
});

// ── cycleElements ──────────────────────────────────────────────────────────
test("cycleElements takes { records: [...] } or a bare array, and refuses any other envelope", () => {
	const list = [{ cycle: {} }];
	assert.equal(cycleElements({ records: list }), list);
	assert.equal(cycleElements(list), list);
	assert.deepEqual(cycleElements({ records: [] }), []);
	assert.equal(cycleElements(read("fixtures/cycles-details.json"))?.length, 3);
	for (const json of [
		null,
		undefined,
		{},
		{ records: null },
		{ records: {} },
		{ records: "[]" },
		{ data: [] },
		"[]",
		42,
	]) {
		assert.equal(cycleElements(json), null, `${JSON.stringify(json)}`);
	}
});

// ── readElement ────────────────────────────────────────────────────────────
test("readElement gives a cycle its id, start, whether it is open, last update and element", () => {
	const element = scored();
	assert.deepEqual(readElement(element), {
		kind: "cycle",
		cycle: {
			id: "1000000101",
			startAt: A,
			startMs: Date.UTC(2026, 8, 14, 12, 40),
			open: false,
			updatedMs: Date.UTC(2026, 8, 15, 13, 6),
			element,
		},
	});
	assert.equal(cycleOf(element).element, element);
	assert.equal(cycleOf(underWay()).startAt, "2026-09-16T12:50:00.000Z");
	// A closed range written with +1000 bounds starts at the same instant.
	assert.equal(
		cycleOf(
			withPart(scored(), "cycle", {
				during:
					"['2026-09-14T22:40:00.000+1000','2026-09-15T23:05:00.000+1000']",
			}),
		).startAt,
		A,
	);
	for (const updated_at of [undefined, null, "soon"]) {
		assert.equal(
			cycleOf(withPart(scored(), "cycle", { updated_at })).updatedMs,
			Number.NEGATIVE_INFINITY,
		);
	}
});

test("readElement: a cycle is open while its range has no upper bound, and closed once it has one", () => {
	const open = (during: unknown): boolean =>
		cycleOf(withPart(scored(), "cycle", { during })).open;
	assert.equal(cycleOf(underWay()).open, true, "the fixture's cycle under way");
	assert.equal(cycleOf(scored()).open, false, "the fixture's scored cycle");
	assert.equal(cycleOf(quiet()).open, false, "the fixture's quiet cycle");
	for (const during of [
		`['${A}',)`,
		`['${A}','')`,
		`['${A}',infinity)`,
		`['${A}','Infinity']`,
	]) {
		assert.equal(open(during), true, during);
	}
	for (const during of [
		`['${A}','${B}')`,
		`['${A}','${B}']`,
		"['2026-09-14T22:40:00.000+1000','2026-09-15T23:05:00.000+1000')",
	]) {
		assert.equal(open(during), false, during);
	}
});

test("readElement: no cycle, a bad id or an unreadable start makes the element unreadable, with what it held", () => {
	const held = { cycles: 1, recoveries: 1, sleeps: 2, workouts: 1 };
	for (const cycle of [undefined, null, "1000000101", []]) {
		assert.deepEqual(
			lostBy(merged(scored(), { cycle })),
			held,
			`cycle ${JSON.stringify(cycle)}`,
		);
	}
	for (const id of [
		undefined,
		null,
		0,
		-1_000_000_101,
		1_000_000_101.5,
		"1000000101",
		2 ** 53,
	]) {
		assert.deepEqual(
			lostBy(withPart(scored(), "cycle", { id })),
			held,
			`id ${JSON.stringify(id)}`,
		);
	}
	for (const during of [
		undefined,
		null,
		20_260_914,
		"garbage",
		`[,'${B}')`,
		"['2026-09-14','2026-09-15')",
		`['not-a-date','${B}')`,
	]) {
		assert.deepEqual(
			lostBy(withPart(scored(), "cycle", { during })),
			held,
			`during ${JSON.stringify(during)}`,
		);
	}
	const nothingElse = { cycles: 1, recoveries: 0, sleeps: 0, workouts: 0 };
	assert.deepEqual(lostBy(withPart(quiet(), "cycle", { id: 0 })), nothingElse);
	for (const element of [null, undefined, 42, "cycle", [], [scored()]]) {
		assert.deepEqual(
			lostBy(element),
			nothingElse,
			`${JSON.stringify(element)}`,
		);
	}
});

test("readElement counts as lost exactly what the element would have built", () => {
	// Read, the open cycle's pending recovery builds nothing, so dropping it loses nothing.
	assert.deepEqual(builtFor("recoveries", underWay()), []);
	assert.equal(lostBy(withPart(underWay(), "cycle", { id: 0 })).recoveries, 0);
	// Read, a sleeps or recovery value of the wrong type builds one unreadable record; dropped, it should count one.
	assert.deepEqual(
		kinds(builtFor("sleeps", merged(scored(), { sleeps: {} }))),
		["unreadable"],
	);
	assert.equal(lostBy(merged(scored(), { cycle: null, sleeps: {} })).sleeps, 1);
	assert.equal(
		lostBy(merged(scored(), { cycle: null, recovery: "complete" })).recoveries,
		1,
	);
});

test("readElement's lost counts equal recordsFor's output for every recovery and list shape", () => {
	const unscored = {
		recovery_score: null,
		hrv_rmssd: null,
		resting_heart_rate: null,
		spo2: null,
		skin_temp_celsius: null,
	};
	const [sleep] = scored().sleeps as Obj[];
	const [workout] = scored().workouts as Obj[];
	const cases: Array<[string, Obj, Record<Stream, number>]> = [
		["scored", scored(), { cycles: 1, recoveries: 1, sleeps: 2, workouts: 1 }],
		["quiet", quiet(), { cycles: 1, recoveries: 0, sleeps: 0, workouts: 0 }],
		[
			"under way",
			underWay(),
			{ cycles: 1, recoveries: 0, sleeps: 1, workouts: 0 },
		],
	];
	const variant = (
		name: string,
		changes: Obj,
		recoveries: number,
		sleeps: number,
		workouts: number,
	): void => {
		cases.push([
			name,
			merged(scored(), changes),
			{ cycles: 1, recoveries, sleeps, workouts },
		]);
	};
	variant("recovery null", { recovery: null }, 0, 2, 1);
	variant("recovery absent", { recovery: undefined }, 0, 2, 1);
	variant("recovery {}", { recovery: {} }, 0, 2, 1);
	variant("recovery unscored", { recovery: unscored }, 0, 2, 1);
	variant(
		"recovery of WHOOP's 0s",
		{ recovery: { ...unscored, hrv_rmssd: 0, resting_heart_rate: 0 } },
		0,
		2,
		1,
	);
	variant(
		"recovery with one measure",
		{ recovery: { ...unscored, spo2: 96.5 } },
		1,
		2,
		1,
	);
	variant(
		"recovery with a drifted metric",
		{ recovery: { ...unscored, recovery_score: "71" } },
		1,
		2,
		1,
	);
	variant("recovery a string", { recovery: "complete" }, 1, 2, 1);
	variant("recovery a list", { recovery: [] }, 1, 2, 1);
	variant("recovery a number", { recovery: 71 }, 1, 2, 1);
	variant("lists null", { sleeps: null, workouts: null }, 1, 0, 0);
	variant("lists absent", { sleeps: undefined, workouts: undefined }, 1, 0, 0);
	variant("lists empty", { sleeps: [], workouts: [] }, 1, 0, 0);
	variant("lists objects", { sleeps: {}, workouts: {} }, 1, 1, 1);
	variant("lists strings", { sleeps: "[]", workouts: "[]" }, 1, 1, 1);
	variant(
		"lists with bad items",
		{ sleeps: [sleep, null, "x"], workouts: [workout, workout, 7, {}] },
		1,
		3,
		4,
	);
	for (const [name, element, expected] of cases) {
		const built = Object.fromEntries(
			STREAMS.map((stream) => [stream, builtFor(stream, element).length]),
		);
		assert.deepEqual(built, expected, `${name}: built`);
		assert.deepEqual(
			lostBy(withPart(element, "cycle", { id: 0 })),
			expected,
			`${name}: lost`,
		);
	}
});

// ── recordsFor: the fixture's three cycles ─────────────────────────────────
test("the scored cycle builds every stream, each field set from its source and joined by the cycle id", () => {
	const element = scored();
	assert.deepEqual(records("cycles", element), [
		{
			id: "1000000101",
			start_at: A,
			end_at: B,
			day: "2026-09-14",
			timezone_offset: "+10:00",
			strain: 12.4,
			kilojoules: 9876.5,
			average_heart_rate: 64,
			max_heart_rate: 171,
		},
	]);
	// The recovery has no id of its own: it takes the cycle's, and its sleep_id is the first sleep's id.
	assert.deepEqual(records("recoveries", element), [
		{
			id: "1000000101",
			start_at: A,
			sleep_id: "00000000-0000-4000-8000-000000000101",
			recovery_score: 71,
			hrv_rmssd_ms: 61.2,
			resting_heart_rate: 52,
			spo2_percentage: 96.5,
			skin_temp_celsius: 33.9,
		},
	]);
	assert.deepEqual(records("sleeps", element), [
		{
			id: "00000000-0000-4000-8000-000000000101",
			cycle_id: "1000000101",
			start_at: A,
			end_at: "2026-09-14T20:55:00.000Z",
			timezone_offset: "+10:00",
			is_nap: false,
			performance_percentage: 88,
			respiratory_rate: 14.6,
			in_bed_ms: 29_700_000,
			awake_ms: 2_400_000,
			light_ms: 13_800_000,
			slow_wave_ms: 6_300_000,
			rem_ms: 7_200_000,
		},
		{
			id: "00000000-0000-4000-8000-000000000102",
			cycle_id: "1000000101",
			start_at: "2026-09-15T05:10:00.000Z",
			end_at: "2026-09-15T05:40:00.000Z",
			timezone_offset: "+10:00",
			is_nap: true,
			performance_percentage: null,
			respiratory_rate: 15.1,
			in_bed_ms: 1_800_000,
			awake_ms: 300_000,
			light_ms: 1_200_000,
			slow_wave_ms: 300_000,
			rem_ms: 0,
		},
	]);
	assert.deepEqual(records("workouts", element), [
		{
			id: "00000000-0000-4000-8000-000000000201",
			cycle_id: "1000000101",
			start_at: "2026-09-14T22:00:00.000Z",
			end_at: "2026-09-14T22:48:30.000Z",
			timezone_offset: "+10:00",
			sport_id: 0,
			strain: 9.8,
			kilojoules: 2150.25,
			average_heart_rate: 148,
			max_heart_rate: 176,
		},
	]);
});

test("a cycle with no recovery, no sleep and no workouts builds only its cycle", () => {
	const element = quiet();
	assert.deepEqual(records("cycles", element), [
		{
			id: "1000000102",
			start_at: B,
			end_at: "2026-09-16T12:50:00.000Z",
			day: "2026-09-15",
			timezone_offset: "+10:00",
			strain: 6.1,
			kilojoules: 7012,
			average_heart_rate: 61,
			max_heart_rate: 132,
		},
	]);
	for (const stream of ["recoveries", "sleeps", "workouts"] as const) {
		assert.deepEqual(builtFor(stream, element), [], stream);
	}
});

test("the cycle under way: no end and no strain yet, its pending recovery builds nothing, its unscored sleep keeps what it has", () => {
	const element = underWay();
	assert.deepEqual(records("cycles", element), [
		{
			id: "1000000103",
			start_at: "2026-09-16T12:50:00.000Z",
			end_at: null,
			day: "2026-09-16",
			timezone_offset: "+10:00",
			strain: null,
			kilojoules: null,
			average_heart_rate: 58,
			max_heart_rate: 97,
		},
	]);
	assert.deepEqual(builtFor("recoveries", element), []);
	assert.deepEqual(records("sleeps", element), [
		{
			id: "00000000-0000-4000-8000-000000000103",
			cycle_id: "1000000103",
			start_at: "2026-09-16T12:50:00.000Z",
			end_at: "2026-09-16T20:30:00.000Z",
			timezone_offset: "+10:00",
			is_nap: false,
			performance_percentage: null,
			respiratory_rate: null,
			in_bed_ms: 27_600_000,
			awake_ms: null,
			light_ms: null,
			slow_wave_ms: null,
			rem_ms: null,
		},
	]);
	assert.deepEqual(builtFor("workouts", element), []);
});

test("a key WHOOP adds is ignored", () => {
	for (const stream of STREAMS) {
		assert.deepEqual(
			recordWith(stream, { added_in_2027: 1 }),
			recordWith(stream, {}),
			stream,
		);
	}
});

// ── recordsFor: recoveries ─────────────────────────────────────────────────
test("recoveries: HRV seconds become milliseconds to the microsecond, and 0 is no reading", () => {
	const hrv = (hrv_rmssd: unknown): unknown =>
		recordWith("recoveries", { hrv_rmssd }).hrv_rmssd_ms;
	// 0.0612 * 1000 is 61.199999999999996 in floating point.
	assert.equal(hrv(0.0612), 61.2);
	assert.equal(hrv(0.02), 20);
	assert.equal(hrv(0.123_456_7), 123.457);
	assert.equal(hrv(0), null);
	assert.equal(hrv(null), null);
	assert.equal(hrv(undefined), null);
});

test("recoveries: a resting heart rate of 0 is no reading, and a fraction rounds", () => {
	const resting = (resting_heart_rate: unknown): unknown =>
		recordWith("recoveries", { resting_heart_rate }).resting_heart_rate;
	assert.equal(resting(0), null);
	assert.equal(resting(null), null);
	assert.equal(resting(52.4), 52);
	assert.equal(resting(51.5), 52);
});

test("recoveries: none for a null, absent or unscored recovery; one unreadable for one that is not an object", () => {
	assert.deepEqual(
		builtFor("recoveries", merged(scored(), { recovery: null })),
		[],
	);
	assert.deepEqual(
		builtFor("recoveries", merged(scored(), { recovery: undefined })),
		[],
	);
	assert.deepEqual(builtFor("recoveries", underWay()), []);
	const unscored = {
		recovery_score: null,
		hrv_rmssd: null,
		resting_heart_rate: null,
		spo2: null,
		skin_temp_celsius: null,
	};
	// WHOOP's 0s mean no reading, so a recovery holding only them is unscored too.
	assert.deepEqual(
		builtWith("recoveries", {
			...unscored,
			hrv_rmssd: 0,
			resting_heart_rate: 0,
		}),
		[],
	);
	// One measure is enough for a record.
	assert.deepEqual(
		recordWith("recoveries", { ...unscored, recovery_score: 71 }),
		{
			id: "1000000101",
			start_at: A,
			sleep_id: "00000000-0000-4000-8000-000000000101",
			recovery_score: 71,
			hrv_rmssd_ms: null,
			resting_heart_rate: null,
			spo2_percentage: null,
			skin_temp_celsius: null,
		},
	);
	assert.equal(
		recordWith("recoveries", { ...unscored, skin_temp_celsius: 33.9 })
			.skin_temp_celsius,
		33.9,
	);
	for (const recovery of ["complete", 71, true, []]) {
		assert.deepEqual(
			kinds(builtFor("recoveries", merged(scored(), { recovery }))),
			["unreadable"],
			`${JSON.stringify(recovery)}`,
		);
	}
});

test("recoveries: sleep_id is null when absent and stringified when an integer; any other form is unreadable", () => {
	const sleepId = (activity_id: unknown): unknown =>
		recordWith("recoveries", { activity_id }).sleep_id;
	assert.equal(sleepId(undefined), null);
	assert.equal(sleepId(null), null);
	assert.equal(sleepId(123_456), "123456");
	for (const activity_id of ["", "   ", 0, -1, 1.5, true, {}]) {
		assert.deepEqual(
			kinds(builtWith("recoveries", { activity_id })),
			["unreadable"],
			`${JSON.stringify(activity_id)}`,
		);
	}
});

// ── recordsFor: shared rules ───────────────────────────────────────────────
test("an average heart rate above the maximum voids both, on cycles and workouts; 0 is no reading", () => {
	const cycle = (average: unknown, maximum: unknown): unknown[] => {
		const record = recordWith("cycles", {
			day_avg_heart_rate: average,
			day_max_heart_rate: maximum,
		});
		return [record.average_heart_rate, record.max_heart_rate];
	};
	const workout = (average: unknown, maximum: unknown): unknown[] => {
		const record = recordWith("workouts", {
			average_heart_rate: average,
			max_heart_rate: maximum,
		});
		return [record.average_heart_rate, record.max_heart_rate];
	};
	assert.deepEqual(cycle(180, 171), [null, null]);
	assert.deepEqual(workout(180, 176), [null, null]);
	assert.deepEqual(cycle(171, 171), [171, 171]);
	// Compared once rounded.
	assert.deepEqual(cycle(171.4, 171), [171, 171]);
	assert.deepEqual(workout(147.6, 176.2), [148, 176]);
	assert.deepEqual(cycle(0, 171), [null, 171]);
	assert.deepEqual(workout(0, 0), [null, null]);
	assert.deepEqual(cycle(64, null), [64, null]);
	assert.deepEqual(workout(undefined, undefined), [null, null]);
});

test("a metric of the wrong JSON type makes its record unreadable", () => {
	const cases: Array<[Stream, Obj]> = [
		["cycles", { scaled_strain: "12.4" }],
		["cycles", { day_kilojoules: "9876.5" }],
		["cycles", { day_avg_heart_rate: "64" }],
		["cycles", { day_max_heart_rate: true }],
		["recoveries", { recovery_score: "71" }],
		["recoveries", { hrv_rmssd: "0.0612" }],
		["recoveries", { resting_heart_rate: "52" }],
		["recoveries", { spo2: "96.5" }],
		["recoveries", { skin_temp_celsius: {} }],
		["sleeps", { score: "88" }],
		["sleeps", { respiratory_rate: "14.6" }],
		["sleeps", { time_in_bed: "29700000" }],
		["sleeps", { rem_sleep_duration: [7_200_000] }],
		["sleeps", { is_nap: "true" }],
		["sleeps", { is_nap: 1 }],
		["workouts", { score: "9.8" }],
		["workouts", { kilojoules: "2150.25" }],
		["workouts", { average_heart_rate: "148" }],
		["workouts", { max_heart_rate: "176" }],
	];
	for (const [stream, changes] of cases) {
		assert.deepEqual(
			kinds(builtWith(stream, changes)),
			["unreadable"],
			`${stream} ${JSON.stringify(changes)}`,
		);
	}
});

test("start_at is a range's lower bound: an open upper is a null end; no lower, or a bound that is not an instant, is unreadable", () => {
	for (const stream of ["sleeps", "workouts"] as const) {
		const closed = recordWith(stream, {
			during: "['2026-09-14T22:40:00.000+1000','2026-09-15T06:55:00.000+1000']",
		});
		assert.equal(closed.start_at, A, stream);
		assert.equal(closed.end_at, "2026-09-14T20:55:00.000Z", stream);
		const open = recordWith(stream, { during: `['${A}',)` });
		assert.equal(open.start_at, A, stream);
		assert.equal(open.end_at, null, stream);
		for (const during of [
			undefined,
			null,
			"garbage",
			`[,'${B}')`,
			`['${A}','soon')`,
			"['2026-09-14','2026-09-15')",
		]) {
			assert.deepEqual(
				kinds(builtWith(stream, { during })),
				["unreadable"],
				`${stream} ${JSON.stringify(during)}`,
			);
		}
	}
	// A cycle with no readable start never reaches recordsFor (readElement above); one with an unreadable end is unreadable.
	assert.deepEqual(kinds(builtWith("cycles", { during: `['${A}','soon')` })), [
		"unreadable",
	]);
	assert.equal(
		recordWith("cycles", { during: `['${A}',infinity)` }).end_at,
		null,
	);
});

test("a time zone offset in a form not known is null, not unreadable", () => {
	assert.equal(
		recordWith("cycles", { timezone_offset: "AEST" }).timezone_offset,
		null,
	);
	assert.equal(
		recordWith("cycles", { timezone_offset: undefined }).timezone_offset,
		null,
	);
	assert.equal(
		recordWith("cycles", { timezone_offset: "-0530" }).timezone_offset,
		"-05:30",
	);
	assert.equal(
		recordWith("sleeps", { timezone_offset: 36_000 }).timezone_offset,
		null,
	);
	assert.equal(
		recordWith("workouts", { timezone_offset: "Z" }).timezone_offset,
		"+00:00",
	);
});

// ── recordsFor: cycles ─────────────────────────────────────────────────────
test("cycles: day is the days range's lower date; absent or null days is a null day; a lower that is not a date is unreadable", () => {
	assert.equal(
		recordWith("cycles", { days: "['2026-09-16',)" }).day,
		"2026-09-16",
	);
	assert.equal(
		recordWith("cycles", { days: "['2026-09-14','2026-09-14']" }).day,
		"2026-09-14",
	);
	assert.equal(recordWith("cycles", { days: null }).day, null);
	assert.equal(recordWith("cycles", { days: undefined }).day, null);
	for (const days of [
		"[,'2026-09-15')",
		"['2026-09-14T00:00:00.000Z','2026-09-15T00:00:00.000Z')",
		"['14/09/2026','15/09/2026')",
	]) {
		assert.deepEqual(
			kinds(builtWith("cycles", { days })),
			["unreadable"],
			days,
		);
	}
});

test("cycles: a days value that is not a range is unreadable, not a null day", () => {
	for (const days of [
		"2026-09-14",
		"garbage",
		20_260_914,
		["2026-09-14", "2026-09-15"],
	]) {
		assert.deepEqual(
			kinds(builtWith("cycles", { days })),
			["unreadable"],
			`${JSON.stringify(days)}`,
		);
	}
});

// ── recordsFor: sleeps ─────────────────────────────────────────────────────
test("sleeps: a nap is flagged, and an absent or null score or nap flag is null", () => {
	const [, nap] = records("sleeps", scored());
	assert.equal(nap?.is_nap, true);
	assert.equal(nap?.performance_percentage, null);
	assert.equal(
		recordWith("sleeps", { score: null }).performance_percentage,
		null,
	);
	assert.equal(
		recordWith("sleeps", { score: undefined }).performance_percentage,
		null,
	);
	assert.equal(recordWith("sleeps", { is_nap: undefined }).is_nap, null);
	assert.equal(
		recordWith("sleeps", { time_in_bed: 1_800_000.6 }).in_bed_ms,
		1_800_001,
	);
});

// ── recordsFor: workouts ───────────────────────────────────────────────────
test("workouts: sport_id 0 (running) and -1 (generic) are kept; a fraction or a string is unreadable", () => {
	const sport = (sport_id: unknown): unknown =>
		recordWith("workouts", { sport_id }).sport_id;
	assert.equal(sport(0), 0);
	assert.equal(sport(-1), -1);
	assert.equal(sport(71), 71);
	assert.equal(sport(null), null);
	assert.equal(sport(undefined), null);
	for (const sport_id of [1.5, "0", "running", true]) {
		assert.deepEqual(
			kinds(builtWith("workouts", { sport_id })),
			["unreadable"],
			`${JSON.stringify(sport_id)}`,
		);
	}
});

// ── recordsFor: sleeps and workouts ────────────────────────────────────────
test("sleeps and workouts: an integer activity id is stringified; a missing, empty or non-positive one is unreadable", () => {
	assert.equal(recordWith("sleeps", { activity_id: 123_456 }).id, "123456");
	assert.equal(recordWith("workouts", { activity_id: 654_321 }).id, "654321");
	for (const stream of ["sleeps", "workouts"] as const) {
		for (const activity_id of [
			undefined,
			null,
			"",
			"   ",
			0,
			-5,
			1.5,
			2 ** 53,
			{},
		]) {
			assert.deepEqual(
				kinds(builtWith(stream, { activity_id })),
				["unreadable"],
				`${stream} ${JSON.stringify(activity_id)}`,
			);
		}
	}
});

test("sleeps and workouts: absent or null is none, a value that is not a list is one unreadable, a bad item is unreadable in its place", () => {
	for (const stream of ["sleeps", "workouts"] as const) {
		const [first] = scored()[stream] as Obj[];
		const listed = (value: unknown): Built[] =>
			builtFor(stream, merged(scored(), { [stream]: value }));
		assert.deepEqual(listed(undefined), [], stream);
		assert.deepEqual(listed(null), [], stream);
		assert.deepEqual(listed([]), [], stream);
		for (const value of [{}, "[]", 2, true]) {
			assert.deepEqual(
				kinds(listed(value)),
				["unreadable"],
				`${stream} ${JSON.stringify(value)}`,
			);
		}
		assert.deepEqual(kinds(listed([first, null, "sleep", [], first])), [
			"record",
			"unreadable",
			"unreadable",
			"unreadable",
			"record",
		]);
	}
});

// ── Records against Zod and the manifest ───────────────────────────────────
test("every record the fixtures build passes Zod and the manifest schema, and survives JSON unchanged", () => {
	const elements = cycleElements(read("fixtures/cycles-details.json"));
	assert.ok(elements);
	const counts: Record<string, number> = {};
	for (const element of elements) {
		for (const stream of STREAMS) {
			for (const record of records(stream, element)) {
				assert.deepEqual(
					verdicts(stream, record),
					{ zod: true, manifest: true },
					`${stream} ${record.id}`,
				);
				assert.deepEqual(
					JSON.parse(JSON.stringify(record)),
					record,
					`${stream} ${record.id}: plain JSON`,
				);
				counts[stream] = (counts[stream] ?? 0) + 1;
			}
		}
	}
	assert.deepEqual(counts, {
		cycles: 3,
		recoveries: 1,
		sleeps: 3,
		workouts: 1,
	});
});

test("unit guards: a value out of range fails Zod and the manifest alike, and the range's edge passes both", () => {
	const both = (accepted: boolean) => ({ zod: accepted, manifest: accepted });
	const cases: Array<[Stream, Obj, boolean, string]> = [
		[
			"recoveries",
			{ hrv_rmssd: 1.2 },
			false,
			"HRV of 1.2 s: WHOOP switched to milliseconds",
		],
		["recoveries", { hrv_rmssd: 0.9999 }, true, "HRV just under a second"],
		["recoveries", { hrv_rmssd: -0.05 }, false, "negative HRV"],
		["recoveries", { recovery_score: 101 }, false, "recovery over 100"],
		["recoveries", { recovery_score: -1 }, false, "recovery under 0"],
		["recoveries", { recovery_score: 100 }, true, "recovery of 100"],
		["recoveries", { recovery_score: 0 }, true, "recovery of 0"],
		[
			"recoveries",
			{ resting_heart_rate: 301 },
			false,
			"resting heart rate over 300",
		],
		["recoveries", { spo2: 100.5 }, false, "SpO2 over 100"],
		["cycles", { scaled_strain: 22 }, false, "day strain over 21"],
		["cycles", { scaled_strain: 21 }, true, "day strain of 21"],
		["cycles", { scaled_strain: -0.1 }, false, "negative day strain"],
		["cycles", { day_kilojoules: -1 }, false, "negative energy"],
		[
			"cycles",
			{ day_max_heart_rate: 301 },
			false,
			"maximum heart rate over 300",
		],
		["cycles", { day_max_heart_rate: 300 }, true, "maximum heart rate of 300"],
		["workouts", { score: 21.5 }, false, "workout strain over 21"],
		[
			"workouts",
			{ average_heart_rate: 301, max_heart_rate: 310 },
			false,
			"workout heart rates over 300",
		],
		["sleeps", { time_in_bed: 86_400_001 }, false, "more than a day in bed"],
		["sleeps", { time_in_bed: 86_400_000 }, true, "exactly a day in bed"],
		["sleeps", { rem_sleep_duration: -1 }, false, "negative REM"],
		["sleeps", { score: 101 }, false, "sleep performance over 100"],
		["sleeps", { respiratory_rate: 0 }, false, "no breaths"],
		["sleeps", { respiratory_rate: 100 }, false, "a hundred breaths a minute"],
	];
	for (const [stream, changes, accepted, why] of cases) {
		assert.deepEqual(
			verdicts(stream, recordWith(stream, changes)),
			both(accepted),
			why,
		);
	}
	for (const stream of STREAMS) {
		assert.deepEqual(
			verdicts(stream, { ...recordWith(stream, {}), state: "complete" }),
			both(false),
			`${stream}: extra key`,
		);
	}
});

test("Zod also holds what the manifest leaves open: every key present, ids and offsets in form, instants in UTC with milliseconds", () => {
	const cycle = recordWith("cycles", {});
	const zodAccepts = (changes: Obj): boolean =>
		validateRecord("cycles", merged(cycle, changes)).ok;
	assert.equal(zodAccepts({}), true);
	assert.equal(
		zodAccepts({ end_at: undefined }),
		false,
		"a nullable key left out",
	);
	for (const id of ["0", "01", "abc", ""]) {
		assert.equal(zodAccepts({ id }), false, `id ${id}`);
	}
	assert.equal(zodAccepts({ timezone_offset: "+1000" }), false);
	assert.equal(zodAccepts({ start_at: "2026-09-14T12:40:00Z" }), false);
	assert.equal(
		zodAccepts({ start_at: "2026-09-14T22:40:00.000+10:00" }),
		false,
	);
	assert.equal(zodAccepts({ day: "2026-02-30" }), false);
	assert.equal(
		validateRecord(
			"workouts",
			merged(recordWith("workouts", {}), { sport_id: 1.5 }),
		).ok,
		false,
	);
	assert.equal(
		validateRecord("sleeps", merged(recordWith("sleeps", {}), { id: "" })).ok,
		false,
	);
});

// ── Zod beside the manifest ────────────────────────────────────────────────
test("the Zod schemas and the manifest name the same streams, keys, types, bounds and nullability", () => {
	assert.deepEqual(
		manifest.streams.map(({ name }) => name),
		[...STREAMS],
	);
	assert.deepEqual(Object.keys(SCHEMAS), [...STREAMS]);
	for (const stream of STREAMS) {
		const spec = manifestSchema(stream);
		const zod = z.toJSONSchema(SCHEMAS[stream], { io: "input" }) as JsonSchema;
		const keys = Object.keys(spec.properties ?? {}).sort();
		assert.deepEqual(
			Object.keys(zod.properties ?? {}).sort(),
			keys,
			`${stream}: keys`,
		);
		for (const key of keys) {
			assert.deepEqual(
				jsonFacts(zod.properties?.[key]),
				jsonFacts(spec.properties?.[key]),
				`${stream}.${key}: types, format and bounds`,
			);
		}
		// The manifest requires exactly the keys that are never null; Zod requires every key, since every record carries it.
		const neverNull = keys.filter(
			(key) =>
				!(jsonFacts(spec.properties?.[key]).types as string[]).includes("null"),
		);
		assert.deepEqual(
			[...(spec.required ?? [])].sort(),
			neverNull,
			`${stream}: manifest required`,
		);
		assert.deepEqual(
			[...(zod.required ?? [])].sort(),
			keys,
			`${stream}: Zod required`,
		);
		assert.equal(
			spec.additionalProperties,
			false,
			`${stream}: manifest closed`,
		);
		assert.equal(zod.additionalProperties, false, `${stream}: Zod strict`);
	}
});

test("every stream keys on id and is consented and cursored on start_at, which every record carries", () => {
	for (const spec of manifest.streams) {
		assert.deepEqual(spec.primary_key, ["id"], spec.name);
		assert.equal(spec.consent_time_field, "start_at", spec.name);
		assert.equal(spec.cursor_field, "start_at", spec.name);
		assert.ok(spec.schema.required?.includes("start_at"), spec.name);
		assert.ok(spec.schema.required?.includes("id"), spec.name);
	}
});
