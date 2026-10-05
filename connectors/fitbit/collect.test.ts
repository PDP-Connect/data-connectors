// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the collector, with a hand-built context. They cover what an
 * end-to-end run cannot reach: the time-gate agreement check, which only
 * fires when the runtime's gate disagrees with this connector's reading of
 * the window (never on the current runtime), a device error part-way through
 * a stream, validation before emission, the precedence of reasons over
 * families, and the day taint's per-member bookkeeping.
 *
 * The runtime's own gate comes from `makeEmitRecord`, the function the
 * runtime builds `ctx.isRecordSelected` with, so "agrees with the runtime"
 * is tested against the real thing; a changed gate is that function wrapped.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import {
	type CollectContext,
	type EmittedMessage,
	makeEmitRecord,
	type RecordData,
	type StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { TerminalError } from "../../packages/polyfill-connectors/src/terminal-error.ts";
import {
	canonicalSleepLogs,
	canonicalZip,
	EXPORTED_AT,
	exercise,
} from "./__fixtures__/synthetic-export.ts";
import {
	collectFitbit,
	type DailyFamily,
	dailyTaint,
	type FamilyName,
	fieldsUnavailable,
	reasonFor,
	StreamCollector,
	StreamRead,
	timeRangeField,
} from "./collect.ts";
import { type DayTaint, type MemberTaint, WHOLE_HISTORY } from "./days.ts";
import { type Built, buildExercise, buildSleepLog } from "./parsers.ts";
import type { DailyField } from "./schemas.ts";

const TEMP = mkdtempSync(join(tmpdir(), "pdpp-fitbit-collect-test-"));
const EXPORT_DIR_ENV = process.env.FITBIT_EXPORT_DIR;
const TIME_GATE_CODE = "time_range_semantics_changed";

after(() => {
	rmSync(TEMP, { force: true, recursive: true });
});

afterEach(() => {
	if (EXPORT_DIR_ENV === undefined) {
		delete process.env.FITBIT_EXPORT_DIR;
	} else {
		process.env.FITBIT_EXPORT_DIR = EXPORT_DIR_ENV;
	}
});

type Gate = (stream: string, data: RecordData) => boolean;

interface Fake {
	readonly ctx: CollectContext;
	/** Every message emitted directly: SKIP_RESULT and PROGRESS. */
	readonly messages: EmittedMessage[];
	/** Every record handed to emitRecord. */
	readonly records: { readonly stream: string; readonly data: RecordData }[];
}

/**
 * A context whose `isRecordSelected` is the runtime's own gate for these
 * scopes, or `gate(stream, data, runtime)` when given, to model a runtime
 * whose gate has changed.
 */
function fakeContext(
	scopes: readonly StreamScope[],
	gate?: (stream: string, data: RecordData, runtime: Gate) => boolean,
): Fake {
	const requested = new Map(scopes.map((scope) => [scope.name, scope]));
	const runtime = makeEmitRecord({
		requested,
		emit: () => Promise.resolve(),
		emittedAt: EXPORTED_AT,
		validateRecord: undefined,
		isTombstone: undefined,
		timeRangeFieldFor: timeRangeField,
	});
	const runtimeGate: Gate = (stream, data) => runtime.isSelected(stream, data);
	const messages: EmittedMessage[] = [];
	const records: { stream: string; data: RecordData }[] = [];
	const ctx = {
		requested,
		emit: (message: EmittedMessage) => {
			messages.push(message);
			return Promise.resolve();
		},
		emitRecord: (stream: string, data: RecordData) => {
			records.push({ stream, data });
			return Promise.resolve();
		},
		isRecordSelected: (stream: string, data: RecordData) =>
			gate === undefined
				? runtimeGate(stream, data)
				: gate(stream, data, runtimeGate),
	} as unknown as CollectContext;
	return { ctx, messages, records };
}

/** Rejects with the time-gate terminal failure. */
async function assertTimeGateFailure(run: Promise<unknown>): Promise<void> {
	await assert.rejects(run, (error: unknown) => {
		assert.ok(error instanceof TerminalError, "a TerminalError");
		assert.equal(error.code, TIME_GATE_CODE);
		assert.equal(error.retryable, false);
		return true;
	});
}

/** E1 or another canonical exercise, built. */
function builtExercise(logId = 21_000_000_001): Built {
	return buildExercise(exercise({ logId }), EXPORTED_AT);
}

// ─── The time-gate agreement check ───────────────────────────────────────

test("a runtime that drops an in-window record with no resource filter stops the run", async () => {
	const { ctx, records } = fakeContext([{ name: "activities" }], () => false);
	const collector = new StreamCollector(ctx, "activities");
	await assertTimeGateFailure(collector.take(builtExercise()));
	assert.deepEqual(records, [], "the record is never emitted");
});

test("a record the scope's resources leave out is outside the window, not a changed gate", async () => {
	const { ctx, records } = fakeContext([
		{ name: "activities", resources: ["21000000002"] },
	]);
	const collector = new StreamCollector(ctx, "activities");
	await collector.take(builtExercise(21_000_000_001));
	await collector.take(builtExercise(21_000_000_002));
	assert.deepEqual(
		records.map((r) => r.data.id),
		["21000000002"],
	);
	assert.equal(collector.tally.outsideWindow, 1);
	assert.equal(collector.tally.delivered, 1);
});

test("a runtime that keeps a record outside this connector's window stops the run", async () => {
	const { ctx, records } = fakeContext(
		[{ name: "activities", time_range: { since: "2026-04-01" } }],
		() => true,
	);
	const collector = new StreamCollector(ctx, "activities");
	await assertTimeGateFailure(collector.take(builtExercise()));
	assert.deepEqual(records, []);
});

test("the window agrees with the runtime's gate at both bounds of a UTC start", async () => {
	// E1 starts 2026-03-13T23:00:00Z: inside [03-13, 03-14), outside [03-14, …) and [… , 03-13).
	for (const [range, kept] of [
		[{ since: "2026-03-13", until: "2026-03-14" }, true],
		[{ since: "2026-03-14" }, false],
		[{ until: "2026-03-13T12:00:00Z" }, false],
	] as const) {
		const { ctx, records } = fakeContext([
			{ name: "activities", time_range: range },
		]);
		const collector = new StreamCollector(ctx, "activities");
		await collector.take(builtExercise());
		assert.equal(records.length, kept ? 1 : 0, JSON.stringify(range));
		assert.equal(collector.tally.outsideWindow, kept ? 0 : 1);
	}
});

test("a bound inside a day holds at its instant: the runtime's date rule keeps the start, this connector does not", async () => {
	// E1 starts 2026-03-13T23:00:00Z. The runtime reads each bound by its date.
	for (const [range, kept] of [
		[{ since: "2026-03-13T23:30:00Z" }, false],
		[{ since: "2026-03-13T23:00:00Z" }, true],
		[{ since: "2026-03-13T12:00:00-12:00" }, false],
		[{ until: "2026-03-13T23:00:00Z" }, false],
	] as const) {
		const { ctx, records } = fakeContext([
			{ name: "activities", time_range: range },
		]);
		const collector = new StreamCollector(ctx, "activities");
		await collector.take(builtExercise());
		assert.equal(records.length, kept ? 1 : 0, JSON.stringify(range));
		assert.equal(collector.tally.outsideWindow, kept ? 0 : 1);
	}
});

test("a runtime that compares exact instants agrees with this connector's window", async () => {
	const since = "2026-03-13T23:30:00Z";
	const { ctx, records } = fakeContext(
		[{ name: "activities", time_range: { since } }],
		(_stream, data) => Date.parse(String(data.start_time)) >= Date.parse(since),
	);
	const collector = new StreamCollector(ctx, "activities");
	await collector.take(builtExercise());
	assert.deepEqual(records, []);
	assert.equal(collector.tally.outsideWindow, 1);
});

test("an unreadable row with a readable id is checked against the runtime's gate too", async () => {
	// A sleep log whose date cannot be read: its id goes to the runtime alone.
	const [log] = canonicalSleepLogs();
	assert.ok(log);
	const built = buildSleepLog(
		{ ...log, dateOfSleep: "03/14/26" },
		EXPORTED_AT,
		new Map(),
		true,
	);
	assert.equal(built.kind, "unreadable");
	const agreeing = fakeContext([{ name: "sleep" }]);
	const collector = new StreamCollector(agreeing.ctx, "sleep");
	await collector.take(built);
	assert.equal(collector.tally.unreadable, 1);

	const changed = fakeContext([{ name: "sleep" }], () => false);
	await assertTimeGateFailure(
		new StreamCollector(changed.ctx, "sleep").take(built),
	);
});

test("the check uses the protocol's own resource set: numeric resources match string ids", async () => {
	// A scope may carry ids as JSON numbers; the runtime compares String(id).
	const numeric = [21_000_000_001] as unknown as readonly string[];
	const agreeing = fakeContext([{ name: "activities", resources: numeric }]);
	const collector = new StreamCollector(agreeing.ctx, "activities");
	await collector.take(builtExercise(21_000_000_001));
	await collector.take(builtExercise(21_000_000_002));
	assert.deepEqual(
		agreeing.records.map((r) => r.data.id),
		["21000000001"],
	);
	assert.equal(collector.tally.outsideWindow, 1);

	// The id is in the scope's resources, so a drop means the gate changed.
	const changed = fakeContext(
		[{ name: "activities", resources: numeric }],
		(stream, data, runtime) =>
			data.id !== "21000000001" && runtime(stream, data),
	);
	await assertTimeGateFailure(
		new StreamCollector(changed.ctx, "activities").take(
			builtExercise(21_000_000_001),
		),
	);
});

// ─── Without a runtime gate ──────────────────────────────────────────────

test("with no runtime gate, as in a hand-built context, this connector's window decides a record", async () => {
	const ungated = (scopes: readonly StreamScope[]): Fake => {
		const fake = fakeContext(scopes);
		Reflect.deleteProperty(fake.ctx, "isRecordSelected");
		return fake;
	};
	// E1 starts 2026-03-13T23:00:00Z: inside [03-13, 03-14), outside [03-14, …).
	const inside = ungated([
		{
			name: "activities",
			time_range: { since: "2026-03-13", until: "2026-03-14" },
		},
	]);
	const outside = ungated([
		{ name: "activities", time_range: { since: "2026-03-14" } },
	]);
	const dropped = new StreamCollector(outside.ctx, "activities");
	await new StreamCollector(inside.ctx, "activities").take(builtExercise());
	await dropped.take(builtExercise());
	assert.equal(inside.records.length, 1);
	assert.deepEqual(outside.records, []);
	assert.equal(dropped.tally.outsideWindow, 1);
});

// ─── A device error part-way through a stream ────────────────────────────

const ALL: readonly StreamScope[] = [
	{ name: "activities" },
	{ name: "daily_summaries" },
	{ name: "sleep" },
];

function canonicalImport(): string {
	const dir = mkdtempSync(join(TEMP, "export-"));
	canonicalZip(dir);
	return dir;
}

/** The stream's one `phase=coverage` line, as its key=value pairs. */
function coverageOf(
	fake: Fake,
	stream: string,
): Readonly<Record<string, string>> {
	const head = `Fitbit phase=coverage stream=${stream} `;
	const lines = fake.messages.flatMap((m) =>
		m.type === "PROGRESS" && m.message.startsWith(head) ? [m.message] : [],
	);
	assert.equal(lines.length, 1, `exactly one coverage line for ${stream}`);
	const pairs: Record<string, string> = {};
	for (const pair of (lines[0] ?? "").slice(head.length).split(" ")) {
		const [name = "", value = ""] = pair.split("=");
		pairs[name] = value;
	}
	return pairs;
}

test("a device error part-way through daily_summaries stops the stream, delivers what was read and taints what was not", async () => {
	process.env.FITBIT_EXPORT_DIR = canonicalImport();
	const tmp = mkdtempSync(join(TEMP, "tmp-"));
	const tmpBefore = process.env.TMPDIR;
	process.env.TMPDIR = tmp;
	try {
		// The scratch folder vanishes once the steps files are read, as when a
		// device fails: every later extraction fails with ENOENT.
		const fake = fakeContext(ALL);
		const emit = fake.ctx.emit;
		fake.ctx.emit = (message) => {
			if (
				message.type === "PROGRESS" &&
				message.message.startsWith(
					"Fitbit phase=family stream=daily_summaries family=steps ",
				)
			) {
				for (const name of readdirSync(tmp)) {
					rmSync(join(tmp, name), { force: true, recursive: true });
				}
			}
			return emit(message);
		};
		await collectFitbit(fake.ctx);

		const records = (stream: string): RecordData[] =>
			fake.records.filter((r) => r.stream === stream).map((r) => r.data);
		assert.equal(coverageOf(fake, "activities").reason, "covered_in_full");
		// The steps files were read in full; the distance file the error hit and
		// every file of the families after it were not, so their fields are
		// blank and named on every delivered day.
		assert.deepEqual(
			records("daily_summaries").map((r) => [
				r.date,
				r.steps,
				r.distance_m,
				r.lightly_active_minutes,
				r.moderately_active_minutes,
				r.very_active_minutes,
				r.resting_heart_rate_bpm,
			]),
			[
				["2026-04-03", 7, null, null, null, null, null],
				["2026-04-04", 150, null, null, null, null, null],
				["2026-04-05", 95, null, null, null, null, null],
				["2026-04-06", 60, null, null, null, null, null],
			],
		);
		const daily = coverageOf(fake, "daily_summaries");
		assert.equal(daily.reason, "device_storage_unavailable");
		assert.equal(daily.status, "partial");
		assert.equal(daily.delivered, "4");
		assert.equal(
			daily.fields_unreadable,
			"distance_m,lightly_active_minutes,moderately_active_minutes,resting_heart_rate_bpm,very_active_minutes",
		);
		assert.equal(daily.fields_unavailable, "none");
		const skip = fake.messages.find(
			(m) => m.type === "SKIP_RESULT" && m.stream === "daily_summaries",
		);
		assert.match(JSON.stringify(skip), /"device_code":"ENOENT"/);
		// The walk stopped at the error: the two steps files and the distance
		// file were walked, and no member of a later family.
		const done = (stream: string): string | undefined =>
			fake.messages
				.map((m) => (m.type === "PROGRESS" ? m.message : ""))
				.find((text) => text.startsWith(`Fitbit phase=done stream=${stream} `));
		assert.match(done("daily_summaries") ?? "", / files=3 /);
		// Sleep stops at its score file: the logs are never extracted.
		assert.equal(
			coverageOf(fake, "sleep").reason,
			"device_storage_unavailable",
		);
		assert.equal(coverageOf(fake, "sleep").status, "empty");
		assert.match(done("sleep") ?? "", / files=1 /);
	} finally {
		if (tmpBefore === undefined) {
			delete process.env.TMPDIR;
		} else {
			process.env.TMPDIR = tmpBefore;
		}
	}
});

// ─── Validation before emission ──────────────────────────────────────────

test("a record the schema refuses never reaches emitRecord and is counted, not selected", async () => {
	const built = builtExercise();
	assert.equal(built.kind, "record");
	if (built.kind !== "record") {
		return;
	}
	const extraKey = {
		...built,
		record: { ...built.record, calories: 98_765 },
	} as unknown as Built;
	const idless = {
		...built,
		record: { ...built.record, id: "" },
	} as unknown as Built;
	for (const bad of [extraKey, idless]) {
		const asked: unknown[] = [];
		const { ctx, messages, records } = fakeContext(
			[{ name: "activities" }],
			(stream, data, runtime) => {
				asked.push(data.id);
				return runtime(stream, data);
			},
		);
		const collector = new StreamCollector(ctx, "activities");
		const read = new StreamRead(["exercise"]);
		const family = read.family("exercise");
		await collector.take(bad, family);
		assert.equal(records.length, 0, "never emitted");
		assert.deepEqual(asked, [], "never offered to the runtime's gate");
		assert.deepEqual(messages, [], "no message, so no value, is emitted");
		const { tally } = collector;
		assert.equal(tally.schemaRejected, 1);
		assert.ok(tally.schemaIssues >= 1);
		assert.equal(tally.unreadable, 1);
		assert.equal(family.unplaceable, 1);
		// A family of nothing else has changed shape.
		assert.equal(reasonFor(read, tally), "export_format_changed");

		await collector.take(builtExercise(21_000_000_002), family);
		assert.deepEqual(
			records.map((r) => r.data.id),
			["21000000002"],
		);
		assert.equal(family.readable, 1);
		assert.equal(reasonFor(read, tally), "records_unreadable");
	}
});

// ─── Reasons ─────────────────────────────────────────────────────────────

const NOTHING_DELIVERED = {
	unreadable: 0,
	delivered: 0,
	unreadableFields: new Set<string>(),
};
const DELIVERED = { ...NOTHING_DELIVERED, delivered: 3 };

function dailyRead(): StreamRead {
	return new StreamRead([
		"steps",
		"distance",
		"lightly_active_minutes",
		"moderately_active_minutes",
		"very_active_minutes",
		"resting_heart_rate",
	]);
}

function withWalk(
	read: StreamRead,
	name: FamilyName,
	change: Partial<StreamRead["profile"]["walk"]>,
): void {
	const family = read.family(name);
	family.walk = { ...family.walk, ...change };
}

test("reasonFor: the device beats size, size beats a cut file, a cut file beats a changed layout", () => {
	const device = dailyRead();
	withWalk(device, "steps", { oversizedFiles: 1 });
	withWalk(device, "resting_heart_rate", { deviceError: true });
	assert.equal(reasonFor(device, DELIVERED), "device_storage_unavailable");

	const profileDevice = dailyRead();
	profileDevice.profile.walk = {
		...profileDevice.profile.walk,
		deviceError: true,
	};
	assert.equal(
		reasonFor(profileDevice, DELIVERED),
		"device_storage_unavailable",
	);

	const size = dailyRead();
	withWalk(size, "steps", { interruptedFiles: 1 });
	withWalk(size, "distance", { oversizedFiles: 1 });
	assert.equal(reasonFor(size, DELIVERED), "source_limit_reached");

	const cut = dailyRead();
	withWalk(cut, "steps", { interruptedFiles: 1 });
	cut.family("distance").unplaceable = 2;
	assert.equal(reasonFor(cut, DELIVERED), "collection_interrupted");
});

test("reasonFor: one family whose every row is unreadable is a changed layout beside a readable family", () => {
	const read = dailyRead();
	read.family("steps").readable = 40;
	read.family("resting_heart_rate").valueUnreadable = 8;
	assert.equal(
		reasonFor(read, { ...DELIVERED, unreadable: 2 }),
		"export_format_changed",
	);

	// A family whose only content is shape mismatches, and one of unplaceable rows.
	const shape = new StreamRead(["exercise"]);
	withWalk(shape, "exercise", { shapeMismatch: 1 });
	assert.equal(reasonFor(shape, NOTHING_DELIVERED), "export_format_changed");
	const unplaceable = dailyRead();
	unplaceable.family("steps").readable = 4;
	unplaceable.family("lightly_active_minutes").unplaceable = 1;
	assert.equal(
		reasonFor(unplaceable, { ...DELIVERED, unreadable: 1 }),
		"export_format_changed",
	);

	// A readable row beside the bad ones keeps the layout known.
	const mixed = dailyRead();
	mixed.family("lightly_active_minutes").readable = 1;
	mixed.family("lightly_active_minutes").unplaceable = 1;
	assert.equal(
		reasonFor(mixed, { ...DELIVERED, unreadable: 1 }),
		"records_unreadable",
	);
});

test("reasonFor: a missing Profile.csv is a changed layout; an unusable zone alone is unreadable entries", () => {
	const missing = dailyRead();
	missing.zoneMissing = true;
	missing.zoneUnusable = true;
	assert.equal(reasonFor(missing, DELIVERED), "export_format_changed");

	const unusable = dailyRead();
	unusable.zoneUnusable = true;
	assert.equal(reasonFor(unusable, DELIVERED), "records_unreadable");
});

test("reasonFor: a Google-era counterpart and an unknown score header are changed layouts", () => {
	const googleEra = new StreamRead(["sleep_score", "sleep"]);
	googleEra.googleEra = true;
	assert.equal(
		reasonFor(googleEra, NOTHING_DELIVERED),
		"export_format_changed",
	);

	const header = new StreamRead(["sleep_score", "sleep"]);
	header.family("sleep_score").headerUnknown = true;
	header.family("sleep").readable = 3;
	assert.equal(reasonFor(header, DELIVERED), "export_format_changed");
});

test("reasonFor: unreadable entries beat unreadable values; duplicated members and shape mismatches are unreadable entries", () => {
	const fields = new Set(["steps"]);
	const read = dailyRead();
	read.family("steps").readable = 10;
	assert.equal(
		reasonFor(read, { ...DELIVERED, unreadable: 1, unreadableFields: fields }),
		"records_unreadable",
	);
	assert.equal(
		reasonFor(read, { ...DELIVERED, unreadableFields: fields }),
		"values_unreadable",
	);

	const duplicated = dailyRead();
	duplicated.family("steps").readable = 10;
	duplicated.family("steps").duplicateMembers = 1;
	assert.equal(reasonFor(duplicated, DELIVERED), "records_unreadable");
	const profileCopies = dailyRead();
	profileCopies.profile.duplicateMembers = 1;
	assert.equal(reasonFor(profileCopies, DELIVERED), "records_unreadable");

	const shape = new StreamRead(["exercise"]);
	shape.family("exercise").readable = 3;
	withWalk(shape, "exercise", { shapeMismatch: 1 });
	assert.equal(reasonFor(shape, DELIVERED), "records_unreadable");

	assert.equal(reasonFor(dailyRead(), DELIVERED), "covered_in_full");
	assert.equal(reasonFor(dailyRead(), NOTHING_DELIVERED), "nothing_in_range");
});

// ─── fields_unavailable ──────────────────────────────────────────────────

const SEEN_STEPS_ONLY = { objects: 5, present: new Set(["steps"]) };
const NOT_STEPS = [
	"distance_m",
	"lightly_active_minutes",
	"moderately_active_minutes",
	"very_active_minutes",
	"resting_heart_rate_bpm",
];

test("fields_unavailable: the fields no object carried, also beside a row that could not be placed", () => {
	const read = dailyRead();
	assert.deepEqual(
		fieldsUnavailable("daily_summaries", read, SEEN_STEPS_ONLY),
		NOT_STEPS,
	);
	// A row that could not be placed beside a readable one leaves the stream
	// read in full and its layout known, so the fields are still judged.
	read.family("steps").readable = 1;
	read.family("steps").unplaceable = 1;
	assert.deepEqual(
		fieldsUnavailable("daily_summaries", read, SEEN_STEPS_ONLY),
		NOT_STEPS,
	);
	assert.deepEqual(
		fieldsUnavailable("daily_summaries", dailyRead(), {
			objects: 0,
			present: new Set(),
		}),
		[],
		"nothing read, nothing to judge by",
	);
});

test("fields_unavailable: empty when any part of the stream went unread or its layout changed", () => {
	const cases: readonly (readonly [string, (read: StreamRead) => void])[] = [
		["interrupted", (read) => withWalk(read, "steps", { interruptedFiles: 1 })],
		["oversized", (read) => withWalk(read, "distance", { oversizedFiles: 1 })],
		["device", (read) => withWalk(read, "steps", { deviceError: true })],
		["duplicated", (read) => (read.family("steps").duplicateMembers = 1)],
		["profile copies", (read) => (read.profile.duplicateMembers = 1)],
		[
			"profile cut",
			(read) =>
				(read.profile.walk = { ...read.profile.walk, interruptedFiles: 1 }),
		],
		["shape", (read) => withWalk(read, "steps", { shapeMismatch: 1 })],
		["no zone", (read) => (read.zoneUnusable = true)],
	];
	for (const [label, spoil] of cases) {
		const read = dailyRead();
		spoil(read);
		assert.deepEqual(
			fieldsUnavailable("daily_summaries", read, SEEN_STEPS_ONLY),
			[],
			label,
		);
	}
	const header = new StreamRead(["sleep_score", "sleep"]);
	header.family("sleep_score").headerUnknown = true;
	assert.deepEqual(
		fieldsUnavailable("sleep", header, { objects: 3, present: new Set() }),
		[],
	);
	const googleEra = dailyRead();
	googleEra.googleEra = true;
	assert.deepEqual(
		fieldsUnavailable("daily_summaries", googleEra, SEEN_STEPS_ONLY),
		[],
		"a changed layout names nothing",
	);
	const unplacedOnly = dailyRead();
	unplacedOnly.family("resting_heart_rate").unplaceable = 1;
	assert.deepEqual(
		fieldsUnavailable("daily_summaries", unplacedOnly, SEEN_STEPS_ONLY),
		[],
		"a family none of whose rows could be placed has changed layout",
	);
});

// ─── The day taint, member by member ─────────────────────────────────────

const EXPORT_PLUS_ONE = "2026-09-21";

function member(
	nameDate: string,
	tainted = false,
	days: readonly string[] = [],
): MemberTaint {
	return { nameDate, tainted, days: new Set(days) };
}

/** A daily family's members, all clean unless given, and its duplicated name dates. */
function family(
	members: readonly MemberTaint[],
	duplicated: readonly string[] = [],
): readonly MemberTaint[] {
	return [...members, ...duplicated.map((nameDate) => member(nameDate, true))];
}

/** Every daily family read in full: two steps members, one member of each other family. */
function cleanFamilies(): Map<DailyFamily, readonly MemberTaint[]> {
	return new Map<DailyFamily, readonly MemberTaint[]>([
		["steps", family([member("2026-04-04"), member("2026-04-05")])],
		["distance", family([member("2026-04-04")])],
		["lightly_active_minutes", family([member("2026-04-03")])],
		["moderately_active_minutes", family([member("2026-04-03")])],
		["very_active_minutes", family([member("2026-04-03")])],
		["resting_heart_rate", family([member("2026-04-03")])],
	]);
}

function taintOf(
	taint: ReadonlyMap<DailyField, DayTaint>,
	field: DailyField,
): { days: string[]; spans: DayTaint["spans"] } {
	const found = taint.get(field);
	assert.ok(found, field);
	return { days: [...found.days].sort(), spans: found.spans };
}

const UNTAINTED = { days: [], spans: [] };
const ONE_ROW_FIELDS: readonly (readonly [DailyFamily, DailyField])[] = [
	["lightly_active_minutes", "lightly_active_minutes"],
	["moderately_active_minutes", "moderately_active_minutes"],
	["very_active_minutes", "very_active_minutes"],
	["resting_heart_rate", "resting_heart_rate_bpm"],
];

test("day taint: every family read in full taints nothing", () => {
	const taint = dailyTaint(cleanFamilies(), true, EXPORTED_AT);
	for (const field of [
		"steps",
		"distance_m",
		"lightly_active_minutes",
		"moderately_active_minutes",
		"very_active_minutes",
		"resting_heart_rate_bpm",
	] as const) {
		assert.deepEqual(taintOf(taint, field), UNTAINTED, field);
	}
});

test("day taint: the members a device error in distance left unread taint distance_m and every later family, not steps", () => {
	const families = cleanFamilies();
	families.set(
		"distance",
		family([member("2026-04-04", true), member("2026-05-05", true)]),
	);
	for (const [key] of ONE_ROW_FIELDS) {
		families.set(
			key,
			family([member("2026-04-03", true), member("2026-05-03", true)]),
		);
	}
	const taint = dailyTaint(families, true, EXPORTED_AT);
	assert.deepEqual(taintOf(taint, "steps"), UNTAINTED);
	assert.deepEqual(taintOf(taint, "distance_m"), {
		days: [],
		spans: [
			{ from: "2026-04-03", to: "2026-05-05" },
			{ from: "2026-05-04", to: EXPORT_PLUS_ONE },
		],
	});
	for (const [, field] of ONE_ROW_FIELDS) {
		assert.deepEqual(
			taintOf(taint, field),
			{
				days: [],
				spans: [
					{ from: "2026-04-02", to: "2026-05-03" },
					{ from: "2026-05-02", to: EXPORT_PLUS_ONE },
				],
			},
			field,
		);
	}
});

test("day taint: a duplicated steps member taints steps over its own span only", () => {
	const families = cleanFamilies();
	families.set("steps", family([member("2026-04-04")], ["2026-04-05"]));
	const taint = dailyTaint(families, true, EXPORTED_AT);
	assert.deepEqual(taintOf(taint, "steps"), {
		days: [],
		spans: [{ from: "2026-04-04", to: EXPORT_PLUS_ONE }],
	});
	assert.deepEqual(taintOf(taint, "distance_m"), UNTAINTED);

	// Between two read members, the span ends at the next member's name date.
	families.set(
		"steps",
		family([member("2026-04-04"), member("2026-06-04")], ["2026-05-05"]),
	);
	assert.deepEqual(
		taintOf(dailyTaint(families, true, EXPORTED_AT), "steps").spans,
		[{ from: "2026-05-04", to: "2026-06-04" }],
	);
});

test("day taint: a tainted member taints its own days and span, not the next member's", () => {
	const families = cleanFamilies();
	families.set(
		"lightly_active_minutes",
		family([
			member("2026-04-03", true, ["2026-04-03", "2026-04-04"]),
			member("2026-05-03", false, ["2026-05-03"]),
		]),
	);
	const taint = dailyTaint(families, true, EXPORTED_AT);
	assert.deepEqual(taintOf(taint, "lightly_active_minutes"), {
		days: ["2026-04-03", "2026-04-04"],
		spans: [{ from: "2026-04-02", to: "2026-05-03" }],
	});
	assert.deepEqual(taintOf(taint, "moderately_active_minutes"), UNTAINTED);
});

test("day taint: a tainted steps member taints the days it placed rows on and its span, also with no export date", () => {
	const families = cleanFamilies();
	families.set(
		"steps",
		family([
			member("2026-04-04", true, ["2026-04-03", "2026-04-04"]),
			member("2026-04-05"),
		]),
	);
	assert.deepEqual(taintOf(dailyTaint(families, true, null), "steps"), {
		days: ["2026-04-03", "2026-04-04"],
		spans: [{ from: "2026-04-03", to: "2026-04-05" }],
	});
});

test("day taint: with no usable zone, steps and distance_m are tainted over the whole history when their family has a member", () => {
	const both = dailyTaint(cleanFamilies(), false, EXPORTED_AT);
	assert.equal(both.get("steps"), WHOLE_HISTORY);
	assert.equal(both.get("distance_m"), WHOLE_HISTORY);
	assert.deepEqual(taintOf(both, "lightly_active_minutes"), UNTAINTED);

	const stepsOnly = cleanFamilies();
	stepsOnly.set("distance", family([]));
	const taint = dailyTaint(stepsOnly, false, EXPORTED_AT);
	assert.equal(taint.get("steps"), WHOLE_HISTORY);
	assert.deepEqual(taintOf(taint, "distance_m"), UNTAINTED);

	// A family whose only member is duplicated still has a member.
	const copiesOnly = cleanFamilies();
	copiesOnly.set("distance", family([], ["2026-04-04"]));
	assert.equal(
		dailyTaint(copiesOnly, false, EXPORTED_AT).get("distance_m"),
		WHOLE_HISTORY,
	);
});

test("timeRangeField: a UTC start for activities, the date for the daily streams", () => {
	assert.equal(timeRangeField("activities"), "start_time");
	assert.equal(timeRangeField("daily_summaries"), "date");
	assert.equal(timeRangeField("sleep"), "date");
	assert.throws(() => new StreamRead(["exercise"]).family("sleep"), RangeError);
});
