// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { packageRoot as PACKAGE_ROOT } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import {
	CATEGORY_RECORD,
	HEART_RATE_RECORD,
	NO_START_DATE_RECORD,
	NON_NUMERIC_VALUE_RECORD,
	STEP_COUNT_RECORD,
	UNKNOWN_TYPE_RECORD,
} from "./__fixtures__/record-step-count.ts";
import {
	BAD_DATE_WORKOUT,
	RUN_WORKOUT,
	WALK_WORKOUT_MIN,
} from "./__fixtures__/workout-run.ts";
import {
	buildHealthRecord,
	buildWorkoutEvent,
	buildWorkoutRecord,
	buildWorkoutStatistics,
	hashId,
	healthTypeShort,
	isoDate,
	MAX_NAMED_PER_TALLY,
	MAX_TALLIED_NAME_LENGTH,
	newElementGaps,
	newGapCounts,
	nextTag,
	normaliseDevice,
	noteField,
	parseAttrs,
	sniffLeadingAttrs,
	tallyUnconvertibleUnit,
	tallyUnrecognizedType,
	utcOffsetMinutes,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { AppleHealthAttrs, AppleHealthElement } from "./types.ts";

// Test-only helper: wraps raw attrs the way index.ts's streaming scanner
// would, so table-driven fixture tests can call buildHealthRecord/
// buildWorkoutRecord exactly as production does (element + children, not
// bare attrs).
function el(
	tag: "Record" | "Workout",
	attrs: AppleHealthAttrs,
	overrides: Partial<AppleHealthElement> = {},
): AppleHealthElement {
	return {
		tag,
		attrs,
		metadata: [],
		pending: newElementGaps(),
		unreadable: false,
		workoutEvents: [],
		workoutStatistics: [],
		activityStatistics: [],
		statisticsIncomplete: false,
		...overrides,
	};
}

// ─── parseAttrs ─────────────────────────────────────────────────────────

test('parseAttrs: extracts key="value" pairs', () => {
	const attrs = parseAttrs('type="HKStep" value="42" sourceName="iPhone"');
	assert.deepEqual(attrs, {
		type: "HKStep",
		value: "42",
		sourceName: "iPhone",
	});
});

test("parseAttrs: empty string → empty object", () => {
	assert.deepEqual(parseAttrs(""), {});
});

test("parseAttrs: handles attributes with spaces in value", () => {
	const attrs = parseAttrs('sourceName="Apple Watch" unit="count/min"');
	assert.ok(attrs);
	assert.equal(attrs.sourceName, "Apple Watch");
	assert.equal(attrs.unit, "count/min");
});

// A real Apple Watch export XML-escapes `<`/`>`/`&` in attribute values
// (e.g. a device string embedding a Swift description, or a URL with `&`
// between query params). A prior version returned the escaped text
// unchanged — this dropped no characters and threw no error, so it was
// invisible to every test that only fed pre-escaped literal strings like
// "Apple Watch" straight through. Live-proof against real Withings/Apple
// export files caught it.
test("parseAttrs: decodes XML entities in attribute values (real device-string / URL shape)", () => {
	const attrs = parseAttrs(
		'device="&lt;&lt;HKDevice: 0x1&gt;, name:Apple Watch&gt;" link="a?x=1&amp;y=2" quote="&quot;hi&quot;" apos="&apos;lo&apos;" code="&#65;&#x42;"',
	);
	assert.ok(attrs);
	assert.equal(attrs.device, "<<HKDevice: 0x1>, name:Apple Watch>");
	assert.equal(attrs.link, "a?x=1&y=2");
	assert.equal(attrs.quote, '"hi"');
	assert.equal(attrs.apos, "'lo'");
	assert.equal(attrs.code, "AB");
});

test("parseAttrs: a reference to no XML character makes the element unreadable, not a throw", () => {
	// String.fromCodePoint throws above U+10FFFF; a throw from the scanner
	// would end the run after a partial emit with no receipt.
	for (const ref of [
		"&#x110000;",
		"&#1114112;",
		"&#0;",
		"&#xD800;",
		"&#99999999999999999999;",
	]) {
		assert.equal(
			parseAttrs(
				`type="HKQuantityTypeIdentifierStepCount" device="a ${ref} b"`,
			),
			null,
			ref,
		);
	}
	// The edges of the XML character range still decode.
	assert.deepEqual(parseAttrs('a="&#x9;&#x10FFFF;&#xFFFD;"'), {
		a: "\t\u{10FFFF}\uFFFD",
	});
});

// ─── nextTag (against real serialized XML, not just parsed attrs) ───────
//
// The fixtures above feed already-parsed AppleHealthAttrs objects straight to
// buildHealthRecord/buildWorkoutRecord, which never proves that the tag
// scanner matches those attributes as XML text. An attribute span of `[^/>]+`
// would fail to match, and so silently drop, any Record whose attribute value
// holds a literal `/`, such as `unit="count/min"` on every HeartRate record.
// These tests scan real XML strings end to end so that no such pattern
// passes unnoticed.

function scanTags(xml: string): string[] {
	const out: string[] = [];
	for (let tag = nextTag(xml, 0); tag !== null; tag = nextTag(xml, tag.end)) {
		out.push(tag.open ?? `/${tag.close}`);
	}
	return out;
}

test("nextTag: matches a Record whose unit attribute contains a slash (count/min)", () => {
	const xml =
		'<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" startDate="2024-06-05 13:45:22 -0700" endDate="2024-06-05 13:45:23 -0700" value="72"/>';
	assert.deepEqual(scanTags(xml), ["Record"]);
});

test("nextTag: matches a Record whose unit contains a slash and middle-dot (mL/min·kg, VO2max)", () => {
	const xml =
		'<Record type="HKQuantityTypeIdentifierVO2Max" sourceName="Apple Watch" unit="mL/min·kg" startDate="2024-06-05 13:45:22 -0700" endDate="2024-06-05 13:45:22 -0700" value="45.2"/>';
	assert.deepEqual(scanTags(xml), ["Record"]);
});

test("nextTag: walks a non-self-closing Workout with MetadataEntry/WorkoutEvent/WorkoutStatistics children in order", () => {
	const xml =
		'<Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Apple Watch" startDate="2024-06-05 06:30:00 -0700" endDate="2024-06-05 07:02:30 -0700">' +
		'<MetadataEntry key="HKAverageMETs" value="9.75 kcal/hr·kg"/>' +
		'<WorkoutEvent type="HKWorkoutEventTypePause" date="2024-06-05 06:40:00 -0700"/>' +
		'<WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="142" unit="count/min"/>' +
		"</Workout>";
	assert.deepEqual(scanTags(xml), [
		"Workout",
		"MetadataEntry",
		"WorkoutEvent",
		"WorkoutStatistics",
		"/Workout",
	]);
});

test("nextTag: WorkoutStatistics is not shadowed by the shorter Workout alternative", () => {
	const xml =
		'<WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="120" unit="count/min"/>';
	assert.deepEqual(scanTags(xml), ["WorkoutStatistics"]);
});

test("nextTag: a tag with more attributes than one step reads is read whole", () => {
	// Attributes are matched 64 at a time; the ones past the first step must
	// still belong to the tag, in order, up to its own end.
	const padding = Array.from({ length: 70 }, (_, i) => ` k${i}='${i}'`).join(
		"",
	);
	const xml = `<Record type="HKQuantityTypeIdentifierStepCount"${padding} value="7"/><Record value="8"/>`;
	const first = nextTag(xml, 0);
	assert.ok(first);
	assert.equal(first.open, "Record");
	assert.equal(first.selfClosing, true);
	const attrs = parseAttrs(first.attrs);
	assert.equal(attrs?.value, "7");
	assert.equal(attrs?.k69, "69");
	assert.equal(nextTag(xml, first.end)?.attrs, ' value="8"');
});

test("nextTag: reads single-quoted values and a close tag with whitespace before its '>', both legal XML", () => {
	const xml =
		"<Record type='HKQuantityTypeIdentifierStepCount' note='a \"b\" > c' value='7'>" +
		"<MetadataEntry key='HKWasUserEntered' value='1'/></Record >" +
		'<Workout startDate="2024-06-05 06:30:00 -0700"></Workout\n>';
	assert.deepEqual(scanTags(xml), [
		"Record",
		"MetadataEntry",
		"/Record",
		"Workout",
		"/Workout",
	]);
	const attrs = parseAttrs(nextTag(xml, 0)?.attrs ?? null);
	assert.deepEqual(attrs, {
		type: "HKQuantityTypeIdentifierStepCount",
		note: 'a "b" > c',
		value: "7",
	});
});

test("nextTag, parseAttrs and sniffLeadingAttrs read whitespace around an attribute's '=', legal XML", () => {
	const padding = Array.from({ length: 70 }, (_, i) => ` k${i} = '${i}'`).join(
		"",
	);
	const xml = `<Record type = "HKQuantityTypeIdentifierStepCount"${padding} value\n=\t"7"/><Record value ="8"/>`;
	const first = nextTag(xml, 0);
	assert.ok(first);
	assert.equal(first.open, "Record");
	assert.equal(first.selfClosing, true);
	const attrs = parseAttrs(first.attrs);
	assert.equal(attrs?.type, "HKQuantityTypeIdentifierStepCount");
	assert.equal(attrs?.k69, "69");
	assert.equal(attrs?.value, "7");
	assert.deepEqual(parseAttrs(nextTag(xml, first.end)?.attrs ?? null), {
		value: "8",
	});
	assert.deepEqual(
		sniffLeadingAttrs(
			`<Record type = 'HKQuantityTypeIdentifierStepCount' startDate =\n"2024-06-05 08:00:00 -0500" blob="unfinished`,
		),
		{
			startDate: "2024-06-05 08:00:00 -0500",
			type: "HKQuantityTypeIdentifierStepCount",
		},
	);
});

test("sniffLeadingAttrs: reads attributes pair by pair, in either quote style, never from inside a value", () => {
	assert.deepEqual(
		sniffLeadingAttrs(
			`<Record note=' startDate="1999-01-01 00:00:00 +0000" type="HKCategoryTypeIdentifierSexualActivity"' type='HKQuantityTypeIdentifierStepCount' startDate='2024-06-05 08:00:00 -0500' blob="unfinished`,
		),
		{
			startDate: "2024-06-05 08:00:00 -0500",
			type: "HKQuantityTypeIdentifierStepCount",
		},
	);
});

// ─── healthTypeShort ────────────────────────────────────────────────────

test("healthTypeShort: strips HKQuantityTypeIdentifier prefix", () => {
	assert.equal(
		healthTypeShort("HKQuantityTypeIdentifierStepCount"),
		"StepCount",
	);
});

test("healthTypeShort: strips HKCategoryTypeIdentifier prefix", () => {
	assert.equal(
		healthTypeShort("HKCategoryTypeIdentifierSleepAnalysis"),
		"SleepAnalysis",
	);
});

test("healthTypeShort: strips HKDataType prefix", () => {
	assert.equal(
		healthTypeShort("HKDataTypeSleepDurationGoal"),
		"SleepDurationGoal",
	);
});

test("healthTypeShort: undefined → null", () => {
	assert.equal(healthTypeShort(undefined), null);
});

test("healthTypeShort: unknown prefix passes through", () => {
	assert.equal(healthTypeShort("CustomType"), "CustomType");
});

// ─── isoDate ────────────────────────────────────────────────────────────

test("isoDate: parses Apple Health timestamp with offset", () => {
	// '2024-06-05 13:45:22 -0700' → 2024-06-05T20:45:22.000Z
	assert.equal(
		isoDate("2024-06-05 13:45:22 -0700"),
		"2024-06-05T20:45:22.000Z",
	);
});

test("isoDate: undefined → null", () => {
	assert.equal(isoDate(undefined), null);
});

test("isoDate: garbage string → null", () => {
	assert.equal(isoDate("not-a-date"), null);
});

/**
 * Provenance a real run reads from the export's own <ExportDate>. Pinned to a
 * fixed instant so a test asserting it cannot pass by accident.
 */
const PROVENANCE = { exported_at: "2026-09-01T17:00:00.000Z" };

// ─── hashId ─────────────────────────────────────────────────────────────

test("hashId: deterministic 24-char hex output", () => {
	const id = hashId("a|b|c");
	assert.match(id, /^[0-9a-f]{24}$/);
	assert.equal(id, hashId("a|b|c"));
});

test("hashId: differs for different inputs", () => {
	assert.notEqual(hashId("a"), hashId("b"));
});

test("hashId: an id is the first 24 hex characters of the input's SHA-256", () => {
	// Ids are what a reader upserts on, so how the string is built may change
	// but its value may not: every id an earlier import delivered must come
	// back identical.
	for (const input of ["a|b|c", "", '["StepCount",null,"count"]']) {
		assert.equal(
			hashId(input),
			createHash("sha256").update(input).digest("hex").slice(0, 24),
		);
	}
});

// ─── buildHealthRecord ──────────────────────────────────────────────────

test("buildHealthRecord: step count → fully populated record", () => {
	const rec = buildHealthRecord(
		el("Record", STEP_COUNT_RECORD),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(rec, "expected a record");
	assert.equal(rec.type, "StepCount");
	// source_name and source_version are deliberately absent from the emitted
	// shape; the dedicated privacy test below is what enforces that.
	assert.match(rec.device ?? "", /iPhone16,2/);
	assert.equal(rec.creation_date, "2024-06-05T20:45:22.000Z");
	assert.equal(rec.unit, "count");
	assert.equal(rec.value, 42);
	assert.equal(rec.value_raw, null);
	assert.equal(rec.start_date, "2024-06-05T20:45:22.000Z");
	assert.equal(rec.end_date, "2024-06-05T20:50:10.000Z");
	assert.match(rec.id, /^[0-9a-f]{24}$/);
});

test("buildHealthRecord: heart rate carries numeric value (unit contains a slash)", () => {
	const rec = buildHealthRecord(
		el("Record", HEART_RATE_RECORD),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(rec);
	assert.equal(rec.type, "HeartRate");
	assert.equal(rec.value, 72);
	assert.equal(rec.unit, "count/min");
});

test("buildHealthRecord: category record stores string in value_raw, null in value", () => {
	const rec = buildHealthRecord(
		el("Record", CATEGORY_RECORD),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(rec);
	assert.equal(rec.type, "SleepAnalysis");
	assert.equal(rec.value, null);
	assert.equal(rec.value_raw, "HKCategoryValueSleepAnalysisAsleepCore");
});

test("buildHealthRecord: non-numeric value record → value_raw route", () => {
	const rec = buildHealthRecord(
		el("Record", NON_NUMERIC_VALUE_RECORD),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(rec);
	assert.equal(rec.value, null);
	assert.equal(rec.value_raw, "HKCategoryValueSleepAnalysisAsleepCore");
});

test("buildHealthRecord: a blank value is absent, not a reading of zero", () => {
	for (const blank of ["", "  "]) {
		const record = el("Record", { ...STEP_COUNT_RECORD, value: blank });
		const rec = buildHealthRecord(record, newGapCounts(), PROVENANCE);
		assert.ok(rec);
		assert.equal(rec.value, null, `value="${blank}" must not publish 0`);
		assert.equal(rec.value_raw, null);
		assert.deepEqual(record.pending.fields, ["value"]);
		assert.deepEqual(record.pending.units, []);
	}
});

test("buildWorkoutRecord: a blank total is absent, not zero", () => {
	const w = buildWorkoutRecord(
		el("Workout", { ...RUN_WORKOUT, totalDistance: " " }),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(w);
	assert.equal(w.total_distance_km, null);
});

test("buildHealthRecord: missing startDate → null (skip), tallied as a gap not silently dropped", () => {
	const gaps = newGapCounts();
	assert.equal(
		buildHealthRecord(el("Record", NO_START_DATE_RECORD), gaps, PROVENANCE),
		null,
	);
	assert.equal(gaps.recordsMissingStartDate, 1);
});

test("buildHealthRecord: same key fields → same id (dedup stability)", () => {
	const a = buildHealthRecord(
		el("Record", STEP_COUNT_RECORD),
		newGapCounts(),
		PROVENANCE,
	);
	const b = buildHealthRecord(
		el("Record", STEP_COUNT_RECORD),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(a && b);
	assert.equal(a.id, b.id);
});

test("buildHealthRecord: HKWasUserEntered becomes a typed boolean, other metadata is dropped", () => {
	const rec = buildHealthRecord(
		el("Record", STEP_COUNT_RECORD, {
			metadata: [{ key: "HKWasUserEntered", value: "1" }],
		}),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(rec);
	assert.equal(
		rec.was_user_entered,
		true,
		"HKWasUserEntered=1 must surface as a typed boolean",
	);
});

test("buildHealthRecord: absent HKWasUserEntered is null, never defaulted to false", () => {
	const rec = buildHealthRecord(
		el("Record", STEP_COUNT_RECORD),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(rec);
	assert.equal(
		rec.was_user_entered,
		null,
		"no HKWasUserEntered entry means unknown, not false",
	);
});

test("buildHealthRecord: an unrecognized type is still a record, and building tallies nothing", () => {
	// The type is tallied only once the record is delivered (index.ts), so a
	// record outside the window or not asked for is never named.
	const gaps = newGapCounts();
	const rec = buildHealthRecord(
		el("Record", UNKNOWN_TYPE_RECORD),
		gaps,
		PROVENANCE,
	);
	assert.ok(rec, "an unrecognized type is still a record, not dropped");
	assert.equal(gaps.unrecognizedRecordTypes.size, 0);
});

test("tallyUnrecognizedType: a known prefix does not make an unlisted type recognized", () => {
	// Recognized means listed in the area table, not merely shaped like a
	// HealthKit identifier: a new quantity type is still one no area claims.
	const gaps = newGapCounts();
	for (const type of [
		"HKQuantityTypeIdentifierSomethingNew",
		"HKQuantityTypeIdentifierStepCount",
	]) {
		tallyUnrecognizedType(type, gaps);
	}
	assert.deepEqual(
		[...gaps.unrecognizedRecordTypes],
		[["HKQuantityTypeIdentifierSomethingNew", 1]],
	);
});

test("tallyUnrecognizedType: names a bounded number of types and counts the rest together", () => {
	const gaps = newGapCounts();
	for (let i = 0; i < MAX_NAMED_PER_TALLY + 5; i += 1) {
		tallyUnrecognizedType(`HKQuantityTypeIdentifierInvented${i}`, gaps);
		tallyUnrecognizedType(`HKQuantityTypeIdentifierInvented${i}`, gaps);
	}
	assert.equal(gaps.unrecognizedRecordTypes.size, MAX_NAMED_PER_TALLY);
	assert.equal(
		gaps.unrecognizedRecordTypes.get("HKQuantityTypeIdentifierInvented0"),
		2,
	);
	assert.equal(gaps.unrecognizedRecordsUnnamed, 10);
});

test("tallyUnconvertibleUnit: names a bounded number of units, each cut short, and counts the rest together", () => {
	const gaps = newGapCounts();
	for (let i = 0; i < MAX_NAMED_PER_TALLY + 5; i += 1) {
		tallyUnconvertibleUnit(`${i}-${"u".repeat(1_000_000)}`, gaps);
		tallyUnconvertibleUnit(`${i}-${"u".repeat(1_000_000)}`, gaps);
	}
	assert.equal(gaps.unrecognizedUnits.size, MAX_NAMED_PER_TALLY);
	assert.equal(gaps.unrecognizedUnitsUnnamed, 10);
	for (const [unit, count] of gaps.unrecognizedUnits) {
		assert.equal(unit.length, MAX_TALLIED_NAME_LENGTH);
		assert.equal(count, 2);
	}
});

test("noteField: names a field once, however many children fail the same way", () => {
	const pending = newElementGaps();
	for (let i = 0; i < 10_000; i += 1) {
		noteField(pending, "was_user_entered");
	}
	noteField(pending, "value");
	assert.deepEqual(pending.fields, ["was_user_entered", "value"]);
});

const PARSERS_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"parsers.ts",
);

/**
 * Cuts values from 16 MiB strings, as the scanner cuts attribute values from
 * its buffer: a 16 MiB unit, and a short type. Hands sixteen of them to each
 * thing that keeps such a value past its element or its chunk, then prints
 * the memory in use after a full collection. Each holder gets values of its own, so what
 * one does to a string cannot mask what another keeps. A large string may
 * live outside the V8 heap, so external memory is counted too.
 */
const HELD_STRINGS_SCRIPT = `
import { buildWorkoutEvent, buildWorkoutStatistics, detachedAttrs, newElementGaps, newGapCounts, tallyUnconvertibleUnit, tallyUnrecognizedType, wasUserEnteredEntry } from ${JSON.stringify(PARSERS_PATH)};
const gaps = newGapCounts();
const held = [];
const holders = [
	(unit) => tallyUnconvertibleUnit(unit, gaps),
	(unit, type) => tallyUnrecognizedType(type, gaps),
	(unit, type) => held.push(buildWorkoutStatistics({ sum: "1", type, unit })),
	(unit) => {
		const pending = newElementGaps();
		buildWorkoutEvent({ duration: "1", durationUnit: unit }, pending);
		held.push(pending);
	},
	(unit, type) => held.push(buildWorkoutEvent({ type }, newElementGaps())),
	(unit, type) => held.push(detachedAttrs({ type })),
	(unit, type) => held.push(wasUserEnteredEntry(type)),
];
for (const hold of holders) {
	for (let i = 0; i < 16; i += 1) {
		const buffer = \` unit="\${i}-\${"u".repeat(16 * 1024 * 1024)}" type="HKQuantityTypeIdentifierInvented\${i}"\`;
		const [, unit, type] = / unit="([^"]*)" type="([^"]*)"$/.exec(buffer);
		hold(unit, type);
	}
}
globalThis.gc();
const { external, heapUsed } = process.memoryUsage();
process.stdout.write(String(heapUsed + external));
`;

test("values kept past their element or chunk hold no part of the scan buffer they were cut from", () => {
	// A substring can be a view of the string it was cut from, so a tally
	// name, a statistic's unit, a marker's type, the kept metadata value or an
	// attribute of an element held open would keep a 16 MiB buffer alive: 256
	// MiB for these sixteen, and a workout keeps 500 markers. A value kept
	// whole would cost as much by itself.
	const dir = mkdtempSync(join(tmpdir(), "pdpp-apple-health-held-"));
	try {
		const script = join(dir, "held-strings.mjs");
		writeFileSync(script, HELD_STRINGS_SCRIPT);
		const child = spawnSync(
			process.execPath,
			["--expose-gc", "--import", "tsx", script],
			{ cwd: PACKAGE_ROOT, encoding: "utf8" },
		);
		assert.equal(child.status, 0, child.stderr);
		const held = Number(child.stdout);
		assert.ok(held < 96 * 1024 * 1024, `${held} bytes held`);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
});

test("buildWorkoutStatistics: a type or unit longer than the schema allows still fails the schema", () => {
	const workout = (unit: string) =>
		validateRecord("workouts", {
			...buildWorkoutRecord(
				el("Workout", RUN_WORKOUT, {
					workoutStatistics: [
						buildWorkoutStatistics({
							sum: "1",
							type: "HKQuantityTypeIdentifierActiveEnergyBurned",
							unit,
						}),
					],
				}),
				newGapCounts(),
				PROVENANCE,
			),
		}).ok;
	assert.equal(workout("u".repeat(100)), true);
	assert.equal(workout("u".repeat(101)), false);
	assert.equal(workout("u".repeat(1_000_000)), false);
});

// ─── buildWorkoutRecord ─────────────────────────────────────────────────

test("buildWorkoutRecord: populated run workout", () => {
	const w = buildWorkoutRecord(
		el("Workout", RUN_WORKOUT),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(w);
	assert.equal(w.workout_activity_type, "Running");
	assert.equal(w.duration_minutes, 32.5);
	assert.equal(w.total_distance_km, 5.2);
	assert.equal(w.total_energy_burned_kcal, 345);
	// source_name and source_version are deliberately absent here too.
	assert.equal(w.start_date, "2024-06-05T13:30:00.000Z");
});

test("buildWorkoutRecord: minimal walk workout leaves numeric fields null", () => {
	const w = buildWorkoutRecord(
		el("Workout", WALK_WORKOUT_MIN),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(w);
	assert.equal(w.workout_activity_type, "Walking");
	assert.equal(w.duration_minutes, null);
	assert.equal(w.total_distance_km, null);
	assert.equal(w.total_energy_burned_kcal, null);
});

test("buildWorkoutRecord: unparseable start date → null (skip), tallied as a gap", () => {
	const gaps = newGapCounts();
	assert.equal(
		buildWorkoutRecord(el("Workout", BAD_DATE_WORKOUT), gaps, PROVENANCE),
		null,
	);
	assert.equal(gaps.workoutsMissingStartDate, 1);
});

test("buildWorkoutRecord: nested WorkoutEvent children become an events array", () => {
	const w = buildWorkoutRecord(
		el("Workout", RUN_WORKOUT, {
			workoutEvents: [
				buildWorkoutEvent(
					{
						type: "HKWorkoutEventTypePause",
						date: "2024-06-05 13:40:00 -0700",
					},
					newElementGaps(),
				),
			],
		}),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(w);
	assert.equal(w.events?.length, 1);
	assert.equal(w.events?.[0]?.type, "Pause");
	assert.equal(w.events?.[0]?.date, "2024-06-05T20:40:00.000Z");
});

test("buildWorkoutStatistics: keeps the typed quantity and drops everything else", () => {
	const stat = buildWorkoutStatistics({
		type: "HKQuantityTypeIdentifierHeartRate",
		average: "142",
		unit: "count/min",
		// A third-party writer adding its own attribute. Apple's format does not
		// stop this, so the bounding is what stops it reaching a reader.
		notes: "felt rough, argument with Ada beforehand",
	});
	assert.equal(stat.type, "HeartRate");
	assert.equal(stat.unit, "count/min");
	assert.equal(stat.average, 142, "numeric attributes are typed, not strings");
	assert.equal(stat.sum, null);
	assert.ok(
		!Object.hasOwn(stat, "notes"),
		"an unrecognised attribute must be dropped, not forwarded",
	);
	assert.ok(!JSON.stringify(stat).includes("Ada"));
});

test("buildWorkoutRecord: bounded WorkoutStatistics children pass through", () => {
	const stat = {
		type: "HeartRate",
		unit: "count/min",
		sum: null,
		average: 142,
		minimum: null,
		maximum: null,
	};
	const w = buildWorkoutRecord(
		el("Workout", RUN_WORKOUT, { workoutStatistics: [stat] }),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(w);
	assert.deepEqual(w.statistics, [stat]);
});

test("buildWorkoutRecord: no nested children → events/statistics/metadata are null, not empty arrays", () => {
	const w = buildWorkoutRecord(
		el("Workout", RUN_WORKOUT),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(w);
	assert.equal(w.events, null);
	assert.equal(w.statistics, null);
	assert.equal(w.exported_at, PROVENANCE.exported_at);
});

// ─── buildWorkoutEvent ──────────────────────────────────────────────────

test("buildWorkoutEvent: strips HKWorkoutEventType prefix and converts duration from its stated unit", () => {
	const ev = buildWorkoutEvent(
		{
			type: "HKWorkoutEventTypeSegment",
			date: "2024-06-05 13:40:00 -0700",
			duration: "7.5",
			durationUnit: "min",
		},
		newElementGaps(),
	);
	assert.equal(ev.type, "Segment");
	assert.equal(ev.date, "2024-06-05T20:40:00.000Z");
	assert.equal(ev.duration_minutes, 7.5);
});

test("buildWorkoutEvent: a duration in seconds is converted, not published as minutes", () => {
	// A 90-second pause published under a field named duration_minutes would
	// be wrong by a factor of sixty.
	const ev = buildWorkoutEvent(
		{
			type: "HKWorkoutEventTypePause",
			date: "2024-06-05 13:40:00 -0700",
			duration: "90",
			durationUnit: "sec",
		},
		newElementGaps(),
	);
	assert.equal(ev.duration_minutes, 1.5);
});

test("buildWorkoutEvent: an unstated duration unit is not assumed", () => {
	const pending = newElementGaps();
	const ev = buildWorkoutEvent(
		{
			type: "HKWorkoutEventTypeSegment",
			date: "2024-06-05 13:40:00 -0700",
			duration: "7.5",
		},
		pending,
	);
	assert.equal(
		ev.duration_minutes,
		null,
		"without a stated unit the figure is not interpretable and must be absent",
	);
	assert.deepEqual(pending.units, [{ field: "events", unit: "(absent)" }]);
});

// ─── Privacy: enforced by absence from the emitted shape ────────────────

/** The published device of `raw`, and the fields its reading left unavailable. */
function deviceOf(raw: string | undefined): [string | null, string[]] {
	const pending = newElementGaps();
	return [normaliseDevice(raw, pending).published, pending.fields];
}

test("normaliseDevice: keeps the hardware fields and drops the address, name and identifiers", () => {
	assert.deepEqual(
		deviceOf(
			"<<HKDevice: 0x283c2b570>, name:Ada's Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, firmware:1.1, software:9.0, localIdentifier:LOCAL-77, UDIDeviceIdentifier:UDI-88>",
		),
		[
			"manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, firmware:1.1, software:9.0",
			[],
		],
	);
});

test("normaliseDevice: publishes its fields in one order, whatever order the export used", () => {
	assert.deepEqual(
		deviceOf(
			"<<HKDevice: 0x1>, software:2.0, model:Body Scale, manufacturer:Withings>",
		),
		["manufacturer:Withings, model:Body Scale, software:2.0", []],
	);
});

test("normaliseDevice: a key that is never published may repeat", () => {
	// A name holding ", name:" makes that key appear twice. Nothing published
	// depends on it, so the hardware fields are still read.
	assert.deepEqual(
		deviceOf(
			"<<HKDevice: 0x1>, name:Ada, name:Watch, manufacturer:Apple Inc., model:Watch, localIdentifier:A, localIdentifier:B>",
		),
		["manufacturer:Apple Inc., model:Watch", []],
	);
});

test("normaliseDevice: publishes nothing it cannot read unambiguously, and names device as unavailable", () => {
	// A name containing ", model:" beside a real model makes the key appear
	// twice; which is the model cannot be told, so nothing is published.
	assert.deepEqual(
		deviceOf(
			"<<HKDevice: 0x1>, name:Ada, model:Evil, manufacturer:Apple Inc., model:Watch>",
		),
		[null, ["device"]],
	);
	assert.deepEqual(deviceOf("Ada's Garmin"), [null, ["device"]]);
	// Only the whole form is read: the description closes with its own `>`
	// and holds nothing after it, or what follows could pass as a value.
	for (const partial of [
		"<<HKDevice: 0x1>, manufacturer:Apple Inc.>trailing text",
		"<<HKDevice: 0x1>, manufacturer:Apple Inc.",
		"<<HKDevice: somewhere>, manufacturer:Apple Inc.>",
	]) {
		assert.deepEqual(deviceOf(partial), [null, ["device"]], partial);
	}
	// Nothing to publish is not a failure to read.
	assert.deepEqual(deviceOf("<<HKDevice: 0x1>, name:iPhone>"), [null, []]);
	assert.deepEqual(deviceOf("<<HKDevice: 0x1>>"), [null, []]);
	assert.deepEqual(deviceOf(""), [null, []]);
	assert.deepEqual(deviceOf(undefined), [null, []]);
});

test("buildHealthRecord: never emits device or application names", () => {
	const rec = buildHealthRecord(
		el("Record", STEP_COUNT_RECORD, {
			metadata: [
				{ key: "HKWasUserEntered", value: "1" },
				// A third-party writer putting free text into metadata. Apple allows
				// this, so the connector must not forward it.
				{ key: "HKExternalUUID", value: "note from Ada's training plan" },
			],
		}),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(rec);
	const asJson = JSON.stringify(rec);
	// The fixture's sourceName is "iPhone" and sourceVersion "17.5".
	assert.ok(
		!Object.hasOwn(rec, "source_name"),
		"source_name must not be an emitted property",
	);
	assert.ok(
		!Object.hasOwn(rec, "source_version"),
		"source_version must not be an emitted property",
	);
	assert.ok(
		!Object.hasOwn(rec, "metadata"),
		"the free-form metadata bag must not be an emitted property",
	);
	assert.ok(
		!asJson.includes("Ada"),
		"third-party metadata text must never reach an emitted record",
	);
});

test("buildWorkoutRecord: never emits device or application names", () => {
	const w = buildWorkoutRecord(
		el("Workout", RUN_WORKOUT),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(w);
	assert.ok(!Object.hasOwn(w, "source_name"));
	assert.ok(!Object.hasOwn(w, "source_version"));
	assert.ok(!Object.hasOwn(w, "metadata"));
});

// ─── Identity: the hash must separate records that differ only in end ───

test("buildHealthRecord: two records differing only in endDate get different ids", () => {
	// Consecutive sleep stages share a start second at the boundary and differ
	// only in where they end. A hash without endDate would collapse them into
	// one record and silently lose the second.
	const base = {
		type: "HKCategoryTypeIdentifierSleepAnalysis",
		sourceName: "Apple Watch",
		startDate: "2024-06-05 23:00:00 +0100",
		value: "HKCategoryValueSleepAnalysisAsleepCore",
	};
	const first = buildHealthRecord(
		el("Record", { ...base, endDate: "2024-06-05 23:30:00 +0100" }),
		newGapCounts(),
		PROVENANCE,
	);
	const second = buildHealthRecord(
		el("Record", { ...base, endDate: "2024-06-06 01:15:00 +0100" }),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(first && second);
	assert.notEqual(
		first.id,
		second.id,
		"same type, source, start and value but different end must be two records",
	);
});

test("a device's firmware and software are published, and are not part of an id", () => {
	// An export that states a device's current versions, rather than those it
	// ran when it recorded, would otherwise re-id every reading after an update.
	const device = (model: string, software: string): string =>
		`<<HKDevice: 0x1>, manufacturer:Apple Inc., model:${model}, hardware:Watch6,2, firmware:${software}, software:${software}>`;
	const record = (d: string) =>
		buildHealthRecord(
			el("Record", { ...STEP_COUNT_RECORD, device: d }),
			newGapCounts(),
			PROVENANCE,
		);
	const workout = (d: string) =>
		buildWorkoutRecord(
			el("Workout", { ...RUN_WORKOUT, device: d }),
			newGapCounts(),
			PROVENANCE,
		);
	for (const build of [record, workout]) {
		const before = build(device("Watch", "9.0"));
		const after = build(device("Watch", "10.1"));
		const other = build(device("iPhone", "10.1"));
		assert.ok(before && after && other);
		assert.match(String(before.device), /software:9\.0$/);
		assert.match(String(after.device), /software:10\.1$/);
		assert.equal(before.id, after.id);
		assert.notEqual(after.id, other.id, "the model is part of identity");
	}
});

test("a device description that is absent or cannot be read takes no part in an id", () => {
	// Such readings are compared without a device, so two otherwise identical
	// ones share an id; the manifest says so.
	const ids = [
		undefined,
		"Ada's Garmin",
		"<<HKDevice: 0x1>, model:A, model:B>",
		"<<HKDevice: 0x1>, name:iPhone>",
	].map((device) => {
		const rec = buildHealthRecord(
			el("Record", { ...STEP_COUNT_RECORD, device }),
			newGapCounts(),
			PROVENANCE,
		);
		assert.equal(rec?.device, null, String(device));
		return rec?.id;
	});
	assert.equal(new Set(ids).size, 1, ids.join(" "));
});

test("buildWorkoutRecord: two workouts differing only in duration get different ids", () => {
	const base = {
		workoutActivityType: "HKWorkoutActivityTypeSwimming",
		sourceName: "Apple Watch",
		startDate: "2024-06-05 07:00:00 +0100",
		durationUnit: "min",
	};
	const a = buildWorkoutRecord(
		el("Workout", { ...base, duration: "20" }),
		newGapCounts(),
		PROVENANCE,
	);
	const b = buildWorkoutRecord(
		el("Workout", { ...base, duration: "35" }),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(a && b);
	assert.notEqual(a.id, b.id);
});

// ─── Units: read from the export, never assumed ─────────────────────────

test("buildWorkoutRecord: an imperial export is converted, not mislabelled", () => {
	// Published verbatim into a field named total_distance_km, totalDistance
	// would read a 5 mile run as 5 km.
	const w = buildWorkoutRecord(
		el("Workout", {
			workoutActivityType: "HKWorkoutActivityTypeRunning",
			startDate: "2024-06-05 07:00:00 -0500",
			duration: "60",
			durationUnit: "min",
			totalDistance: "5",
			totalDistanceUnit: "mi",
			totalEnergyBurned: "500",
			totalEnergyBurnedUnit: "Cal",
		}),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(w);
	assert.ok(
		w.total_distance_km !== null &&
			Math.abs(w.total_distance_km - 8.04672) < 1e-6,
		`5 mi must convert to 8.04672 km, got ${String(w.total_distance_km)}`,
	);
	assert.equal(w.total_energy_burned_kcal, 500, "Cal is a kilocalorie");
	assert.equal(w.duration_minutes, 60);
});

test("buildWorkoutRecord: seconds duration converts to minutes", () => {
	const w = buildWorkoutRecord(
		el("Workout", {
			workoutActivityType: "HKWorkoutActivityTypeRunning",
			startDate: "2024-06-05 07:00:00 +0000",
			duration: "90",
			durationUnit: "sec",
		}),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(w);
	assert.equal(w.duration_minutes, 1.5);
});

test("buildWorkoutRecord: an unknown unit yields null and a tally, never a guess", () => {
	const workout = el("Workout", {
		workoutActivityType: "HKWorkoutActivityTypeRunning",
		startDate: "2024-06-05 07:00:00 +0000",
		totalDistance: "5",
		totalDistanceUnit: "furlongs",
	});
	const w = buildWorkoutRecord(workout, newGapCounts(), PROVENANCE);
	assert.ok(w, "the workout still arrives; only the one quantity is withheld");
	assert.equal(
		w.total_distance_km,
		null,
		"a value that cannot be converted must be absent, not plausibly wrong",
	);
	assert.deepEqual(workout.pending.units, [
		{ field: "total_distance_km", unit: "furlongs" },
	]);
});

test("buildWorkoutRecord: an absent unit is not assumed", () => {
	const workout = el("Workout", {
		workoutActivityType: "HKWorkoutActivityTypeRunning",
		startDate: "2024-06-05 07:00:00 +0000",
		totalDistance: "5",
	});
	const w = buildWorkoutRecord(workout, newGapCounts(), PROVENANCE);
	assert.ok(w);
	assert.equal(w.total_distance_km, null);
	assert.deepEqual(workout.pending.units, [
		{ field: "total_distance_km", unit: "(absent)" },
	]);
});

test("buildWorkoutRecord: a total or duration that is not a number is named, not taken as absent", () => {
	// Left null without naming the field, the receipt would present a figure
	// the export stated but could not be read as one it never stated.
	const workout = el("Workout", {
		workoutActivityType: "HKWorkoutActivityTypeRunning",
		startDate: "2024-06-05 07:00:00 +0000",
		duration: "1e400",
		durationUnit: "min",
		totalDistance: "unknown",
		totalDistanceUnit: "km",
		totalEnergyBurned: "Infinity",
		totalEnergyBurnedUnit: "kcal",
	});
	const w = buildWorkoutRecord(workout, newGapCounts(), PROVENANCE);
	assert.ok(w);
	assert.deepEqual(
		[w.duration_minutes, w.total_distance_km, w.total_energy_burned_kcal],
		[null, null, null],
	);
	assert.deepEqual(workout.pending.fields.sort(), [
		"duration_minutes",
		"total_distance_km",
		"total_energy_burned_kcal",
	]);
});

// ─── Local time and provenance ──────────────────────────────────────────

// ─── Workout totals ─────────────────────────────────────────────────────

/** A WorkoutStatistics child as the scanner builds it. */
function statistic(type: string, sum?: string, unit?: string) {
	return buildWorkoutStatistics({
		sum,
		type: `HKQuantityTypeIdentifier${type}`,
		unit,
	});
}

/** A workout as an export from iOS 16 or later states it: no total attributes. */
const STATISTICS_WORKOUT: AppleHealthAttrs = {
	workoutActivityType: "HKWorkoutActivityTypeRunning",
	duration: "60",
	durationUnit: "min",
	startDate: "2025-06-05 07:00:00 +0100",
	endDate: "2025-06-05 08:00:00 +0100",
};

/** Build a STATISTICS_WORKOUT with these children, and what it left unavailable. */
function totalsOf(overrides: Partial<AppleHealthElement>) {
	const element = el("Workout", STATISTICS_WORKOUT, overrides);
	const w = buildWorkoutRecord(element, newGapCounts(), PROVENANCE);
	assert.ok(w);
	return {
		distance: w.total_distance_km,
		energy: w.total_energy_burned_kcal,
		fields: element.pending.fields,
		units: element.pending.units,
	};
}

test("buildWorkoutRecord: with no total attributes, the totals are the workout's own statistics, and its activities' are not added", () => {
	const totals = totalsOf({
		workoutStatistics: [
			statistic("ActiveEnergyBurned", "500", "kcal"),
			statistic("BasalEnergyBurned", "90", "kcal"),
			statistic("DistanceWalkingRunning", "8", "km"),
			statistic("HeartRate", undefined, "count/min"),
		],
		activityStatistics: [
			statistic("ActiveEnergyBurned", "495", "kcal"),
			statistic("DistanceWalkingRunning", "7.9", "km"),
		],
	});
	assert.equal(totals.energy, 500, "active energy only, never basal");
	assert.equal(totals.distance, 8);
	assert.deepEqual([totals.fields, totals.units], [[], []]);
});

test("buildWorkoutRecord: distances of several kinds add up, each converted from its own unit", () => {
	// A swim, a ride and a run in one workout, partly imperial.
	const totals = totalsOf({
		workoutStatistics: [
			statistic("DistanceSwimming", "1500", "yd"),
			statistic("DistanceCycling", "20", "mi"),
			statistic("DistanceWalkingRunning", "5", "km"),
			statistic("ActiveEnergyBurned", "900", "Cal"),
		],
	});
	assert.ok(
		Math.abs((totals.distance ?? 0) - (1500 * 0.0009144 + 20 * 1.609344 + 5)) <
			1e-9,
		String(totals.distance),
	);
	assert.equal(totals.energy, 900);
});

test("buildWorkoutRecord: totals that exist only inside the workout's activities are summed across them", () => {
	const totals = totalsOf({
		workoutStatistics: [statistic("HeartRate", undefined, "count/min")],
		activityStatistics: [
			statistic("ActiveEnergyBurned", "200", "kcal"),
			statistic("DistanceWalkingRunning", "3", "km"),
			statistic("ActiveEnergyBurned", "150", "kcal"),
			statistic("DistanceWalkingRunning", "2.5", "km"),
		],
	});
	assert.equal(totals.energy, 350);
	assert.equal(totals.distance, 5.5);
});

test("buildWorkoutRecord: the activities' sum is used where the workout's own statistics miss a type they have", () => {
	// The workout states only its ride; its activities state the swim and run
	// as well. Taking the workout's own would publish a third of the distance.
	const totals = totalsOf({
		workoutStatistics: [
			statistic("DistanceCycling", "20", "km"),
			statistic("ActiveEnergyBurned", "500", "kcal"),
		],
		activityStatistics: [
			statistic("DistanceSwimming", "1500", "m"),
			statistic("DistanceCycling", "20", "km"),
			statistic("DistanceWalkingRunning", "5", "km"),
			statistic("ActiveEnergyBurned", "200", "kcal"),
			statistic("ActiveEnergyBurned", "300", "kcal"),
		],
	});
	assert.equal(totals.distance, 26.5);
	assert.equal(totals.energy, 500, "the workout's own has every type");
	assert.deepEqual(totals.fields, []);
});

test("buildWorkoutRecord: no total where neither level has every type the other has, nor where a lost statistic may be one", () => {
	const disjoint = totalsOf({
		workoutStatistics: [
			statistic("DistanceCycling", "20", "km"),
			statistic("DistanceSwimming", "1", "km"),
		],
		activityStatistics: [
			statistic("DistanceCycling", "20", "km"),
			statistic("DistanceWalkingRunning", "5", "km"),
		],
	});
	assert.equal(disjoint.distance, null);
	assert.deepEqual(disjoint.fields, ["total_distance_km"]);
	const lost = totalsOf({
		workoutStatistics: [statistic("DistanceCycling", "20", "km")],
		activityStatistics: [statistic("DistanceCycling", "20", "km")],
		statisticsIncomplete: true,
	});
	assert.equal(lost.distance, null);
	assert.ok(lost.fields.includes("total_distance_km"));
});

test("buildWorkoutRecord: no total is derived from a statistic whose unit or sum cannot be confirmed", () => {
	const unknownUnit = totalsOf({
		workoutStatistics: [
			statistic("DistanceSwimming", "100", "m"),
			statistic("DistanceCycling", "10", "furlong"),
		],
	});
	assert.equal(unknownUnit.distance, null, "never a partial sum");
	assert.deepEqual(unknownUnit.units, [
		{ field: "total_distance_km", unit: "furlong" },
	]);
	const absentUnit = totalsOf({
		workoutStatistics: [statistic("ActiveEnergyBurned", "300")],
	});
	assert.equal(absentUnit.energy, null);
	assert.deepEqual(absentUnit.units, [
		{ field: "total_energy_burned_kcal", unit: "(absent)" },
	]);
	const noSum = totalsOf({
		workoutStatistics: [statistic("DistanceWalkingRunning", undefined, "km")],
	});
	assert.equal(noSum.distance, null);
	assert.deepEqual(noSum.fields, ["total_distance_km"]);
});

test("buildWorkoutRecord: no total is derived from statistics that were not all kept", () => {
	const cut = el("Workout", STATISTICS_WORKOUT, {
		workoutStatistics: [statistic("HeartRate", undefined, "count/min")],
		activityStatistics: [statistic("DistanceWalkingRunning", "5", "km")],
	});
	cut.pending.statisticsTruncated = 1;
	// A lost statistic of the workout's own may have been its distance, so
	// the activities' are not summed in its place.
	assert.equal(
		buildWorkoutRecord(cut, newGapCounts(), PROVENANCE)?.total_distance_km,
		null,
	);
	assert.ok(cut.pending.fields.includes("total_distance_km"));
	const incomplete = totalsOf({
		activityStatistics: [statistic("DistanceWalkingRunning", "5", "km")],
		statisticsIncomplete: true,
	});
	assert.equal(incomplete.distance, null);
	assert.deepEqual(incomplete.fields, [
		"total_energy_burned_kcal",
		"total_distance_km",
	]);
});

test("buildWorkoutRecord: the workout's own total attribute is used where the export states one", () => {
	const w = buildWorkoutRecord(
		el("Workout", RUN_WORKOUT, {
			workoutStatistics: [
				statistic("DistanceWalkingRunning", "8", "km"),
				statistic("ActiveEnergyBurned", "500", "kcal"),
			],
		}),
		newGapCounts(),
		PROVENANCE,
	);
	assert.equal(w?.total_distance_km, 5.2);
	assert.equal(w?.total_energy_burned_kcal, 345);
});

test("utcOffsetMinutes: keeps the wall clock the owner lived in", () => {
	assert.equal(utcOffsetMinutes("2024-06-05 23:00:00 +1100"), 660);
	assert.equal(utcOffsetMinutes("2024-06-05 23:00:00 -0500"), -300);
	assert.equal(utcOffsetMinutes("2024-06-05 23:00:00 +0530"), 330);
	assert.equal(
		utcOffsetMinutes("2024-06-05 23:00:00"),
		null,
		"no stated offset must be null rather than assumed UTC",
	);
});

test("an offset beyond 18 hours is published as null and named, and the record is kept", () => {
	// The schema bounds the offset, so publishing it would cost the whole
	// record; no time zone is that far from UTC, and the reading is still good.
	const start = (offset: string) => `2024-06-05 08:00:00 ${offset}`;
	const record = el("Record", {
		type: "HKQuantityTypeIdentifierStepCount",
		startDate: start("+1900"),
		value: "42",
		unit: "count",
	});
	const workout = el("Workout", {
		workoutActivityType: "HKWorkoutActivityTypeRunning",
		startDate: start("-1830"),
	});
	const built = [
		["other", buildHealthRecord(record, newGapCounts(), PROVENANCE)],
		["workouts", buildWorkoutRecord(workout, newGapCounts(), PROVENANCE)],
	] as const;
	for (const [stream, rec] of built) {
		assert.ok(rec, stream);
		assert.equal(rec.start_utc_offset_minutes, null, stream);
		assert.ok(validateRecord(stream, { ...rec }).ok, stream);
	}
	for (const pending of [record.pending, workout.pending]) {
		assert.deepEqual(pending.fields, ["start_utc_offset_minutes"]);
	}
	const edge = buildHealthRecord(
		el("Record", {
			type: "HKQuantityTypeIdentifierStepCount",
			startDate: start("-1800"),
		}),
		newGapCounts(),
		PROVENANCE,
	);
	assert.equal(edge?.start_utc_offset_minutes, -1080);
});

test("buildHealthRecord: carries the export date and the local offset", () => {
	const rec = buildHealthRecord(
		el("Record", {
			type: "HKQuantityTypeIdentifierStepCount",
			startDate: "2024-06-05 23:45:22 +1100",
			value: "42",
			unit: "count",
		}),
		newGapCounts(),
		PROVENANCE,
	);
	assert.ok(rec);
	assert.equal(rec.exported_at, "2026-09-01T17:00:00.000Z");
	assert.equal(rec.freshness, "snapshot");
	assert.equal(rec.start_utc_offset_minutes, 660);
	// The instant is preserved exactly; only the rendering changes.
	assert.equal(rec.start_date, "2024-06-05T12:45:22.000Z");
});
