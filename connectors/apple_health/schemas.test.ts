// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Apple Health connector. Parsing lives in parsers.ts;
 * these assert the schema against records shaped exactly as
 * `buildHealthRecord` / `buildWorkoutRecord` produce them — the authoritative
 * emitted shape. Every health-area stream shares the one health-record
 * schema, so each is held to the manifest separately.
 *
 * The parity test at the bottom is the one that matters most. Nothing in the
 * toolchain keeps the Zod schemas and the manifest's published JSON Schema in
 * step, and it is the MANIFEST that a reading application integrates against.
 * A field present in one and absent from the other is a contract that lies,
 * and nothing else would catch it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { z } from "zod";
import { manifestPath } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { HEALTH_AREA_STREAMS } from "./areas.ts";
import {
	coverageDiagnosticsSchema,
	healthRecordSchema,
	MAX_UTC_OFFSET_MINUTES,
	SCHEMAS,
	validateRecord,
	workoutsSchema,
} from "./schemas.ts";

// Shaped exactly as buildHealthRecord(...) returns. A numeric quantity record
// (heart rate): value is a finite float, value_raw is null.
const RECORD_NUMERIC = {
	id: "a1b2c3d4e5f6a7b8c9d0e1f2",
	type: "HeartRate",
	device: null,
	unit: "count/min",
	value: 72.5,
	value_raw: null,
	was_user_entered: null,
	start_date: "2024-06-05T13:00:00.000Z",
	start_utc_offset_minutes: 60,
	end_date: "2024-06-05T13:00:01.000Z",
	creation_date: null,
	freshness: "snapshot",
	exported_at: "2026-09-01T17:00:00.000Z",
};

// A category record (sleep analysis): value is null, value_raw carries the
// non-numeric HK category token.
const RECORD_CATEGORY = {
	id: "b1b2c3d4e5f6a7b8c9d0e1f2",
	type: "SleepAnalysis",
	device: null,
	unit: null,
	value: null,
	value_raw: "HKCategoryValueSleepAnalysisAsleepCore",
	was_user_entered: true,
	start_date: "2024-06-05T03:00:00.000Z",
	start_utc_offset_minutes: null,
	end_date: null,
	creation_date: null,
	freshness: "snapshot",
	exported_at: "2026-09-01T17:00:00.000Z",
};

// Shaped exactly as buildWorkoutRecord(...) returns.
const WORKOUT_RECORD = {
	id: "c1b2c3d4e5f6a7b8c9d0e1f2",
	workout_activity_type: "Running",
	duration_minutes: 32.5,
	total_energy_burned_kcal: 410.2,
	total_distance_km: 5.04,
	device: null,
	events: [
		{ type: "Pause", date: "2024-06-05T06:10:00.000Z", duration_minutes: null },
	],
	statistics: [
		{
			type: "HeartRate",
			unit: "count/min",
			sum: null,
			average: 142,
			minimum: null,
			maximum: null,
		},
	],
	start_date: "2024-06-05T06:00:00.000Z",
	start_utc_offset_minutes: -300,
	end_date: "2024-06-05T06:32:30.000Z",
	freshness: "snapshot",
	exported_at: "2026-09-01T17:00:00.000Z",
};

const COVERAGE_RECORD = {
	id: "d1b2c3d4e5f6a7b8c9d0e1f2",
	stream: "activity",
	status: "complete",
	reason: "covered_in_full",
	record_count: 1204,
	duplicates_discarded: 17,
	records_skipped_unreadable: 0,
	records_type_unrecognized: 0,
	fields_unavailable: ["unit"],
	window_requested_from: null,
	window_requested_to: null,
	window_covered_from: "2019-01-02T04:00:00.000Z",
	window_covered_to: "2026-08-30T21:14:00.000Z",
	freshness: "snapshot",
	exported_at: "2026-09-01T17:00:00.000Z",
};

test("health-record schema accepts a numeric quantity record (float value)", () => {
	const result = healthRecordSchema.safeParse(RECORD_NUMERIC);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("health-record schema accepts a category record (null value, value_raw token)", () => {
	const result = healthRecordSchema.safeParse(RECORD_CATEGORY);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("health-record schema rejects a non-hex id (id builder regression)", () => {
	assert.equal(
		healthRecordSchema.safeParse({ ...RECORD_NUMERIC, id: "nope" }).success,
		false,
	);
});

test("health-record schema rejects a missing type (manifest-required field)", () => {
	const { type: _omit, ...withoutType } = RECORD_NUMERIC;
	assert.equal(healthRecordSchema.safeParse(withoutType).success, false);
});

test("health-record schema rejects a non-finite value (Number parse leak)", () => {
	assert.equal(
		healthRecordSchema.safeParse({
			...RECORD_NUMERIC,
			value: Number.POSITIVE_INFINITY,
		}).success,
		false,
	);
});

test("health-record schema rejects a non-ISO start_date", () => {
	assert.equal(
		healthRecordSchema.safeParse({
			...RECORD_NUMERIC,
			start_date: "2024-06-05 13:00:00 -0700",
		}).success,
		false,
	);
});

test("health-record schema strips a source_name field", () => {
	// Zod strips keys a schema does not declare, so this fails if a
	// source_name field is added to the schema.
	const parsed = healthRecordSchema.parse({
		...RECORD_NUMERIC,
		source_name: "Ada's Apple Watch",
	});
	assert.ok(
		!Object.hasOwn(parsed, "source_name"),
		"source_name must not survive parsing onto an emitted record",
	);
});

test("workouts schema accepts a representative emitted record", () => {
	const result = workoutsSchema.safeParse(WORKOUT_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("workouts schema accepts an all-null-metrics workout (only id + start)", () => {
	const result = workoutsSchema.safeParse({
		...WORKOUT_RECORD,
		workout_activity_type: null,
		duration_minutes: null,
		total_energy_burned_kcal: null,
		total_distance_km: null,
		start_utc_offset_minutes: null,
		events: null,
		statistics: null,
		end_date: null,
		exported_at: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("workouts schema rejects a negative distance (sign/selector drift)", () => {
	assert.equal(
		workoutsSchema.safeParse({ ...WORKOUT_RECORD, total_distance_km: -1 })
			.success,
		false,
	);
});

test("coverage_diagnostics schema accepts a success receipt", () => {
	const result = coverageDiagnosticsSchema.safeParse(COVERAGE_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("coverage_diagnostics schema requires a reason even on success", () => {
	// A nullable reason invites `if (reason)` as the failure test, which renders
	// "no health data last week" as something going wrong.
	const { reason: _omit, ...withoutReason } = COVERAGE_RECORD;
	assert.equal(
		coverageDiagnosticsSchema.safeParse(withoutReason).success,
		false,
	);
});

test("coverage_diagnostics schema rejects a reason outside the closed set", () => {
	assert.equal(
		coverageDiagnosticsSchema.safeParse({
			...COVERAGE_RECORD,
			reason: "something_went_wrong",
		}).success,
		false,
	);
});

test("validateRecord routes every stream and passes unknown streams through", () => {
	for (const stream of HEALTH_AREA_STREAMS) {
		assert.equal(validateRecord(stream, RECORD_NUMERIC).ok, true, stream);
		assert.equal(
			validateRecord(stream, { ...RECORD_NUMERIC, id: "nope" }).ok,
			false,
			`${stream} must validate against the health-record schema`,
		);
	}
	assert.equal(validateRecord("workouts", WORKOUT_RECORD).ok, true);
	assert.equal(
		validateRecord("coverage_diagnostics", COVERAGE_RECORD).ok,
		true,
	);
	assert.equal(validateRecord("activity_summaries", { id: "x" }).ok, true);
});

test("the schema registry names every health-area stream, workouts and the receipts", () => {
	assert.deepEqual(Object.keys(SCHEMAS), [
		...HEALTH_AREA_STREAMS,
		"workouts",
		"coverage_diagnostics",
	]);
	for (const stream of HEALTH_AREA_STREAMS) {
		assert.equal(SCHEMAS[stream], healthRecordSchema, stream);
	}
});

test("validateRecord reports issues for a drifted workouts record", () => {
	const result = validateRecord("workouts", {
		...WORKOUT_RECORD,
		total_distance_km: -1,
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.ok(result.issues.some((i) => i.path === "total_distance_km"));
	}
});

// ─── Zod ↔ manifest parity ──────────────────────────────────────────────

interface ManifestStream {
	description: string;
	display: { detail: string; label: string };
	name: string;
	required: boolean;
	schema: { properties: Record<string, unknown>; required?: string[] };
}

function manifestStreamList(): ManifestStream[] {
	const path = manifestPath("apple_health");
	return (
		JSON.parse(readFileSync(path, "utf8")) as { streams: ManifestStream[] }
	).streams;
}

function manifestStreams(): Map<string, ManifestStream> {
	return new Map(manifestStreamList().map((s) => [s.name, s]));
}

function zodKeys(schema: z.ZodObject<z.ZodRawShape>): string[] {
	return Object.keys(schema.shape).sort();
}

const PAIRS: ReadonlyArray<[string, z.ZodObject<z.ZodRawShape>]> = [
	...HEALTH_AREA_STREAMS.map((stream): [string, z.ZodObject<z.ZodRawShape>] => [
		stream,
		healthRecordSchema,
	]),
	["workouts", workoutsSchema],
	["coverage_diagnostics", coverageDiagnosticsSchema],
];

test("parity: the manifest declares one optional stream per health area, then workouts and the receipts", () => {
	const streams = manifestStreamList();
	assert.deepEqual(
		streams.map((s) => s.name),
		[...HEALTH_AREA_STREAMS, "workouts", "coverage_diagnostics"],
	);
	for (const stream of streams) {
		assert.equal(stream.required, false, `${stream.name} must be optional`);
	}
});

test("parity: every health-area stream declares the same contract, differing only in name and copy", () => {
	// Thirteen copies of one contract drift one edit at a time. Anything a
	// reader or the gates rely on (schema, roles, keys, selection, consent
	// field, query affordances, coverage) must be identical across them.
	const contractOf = (stream: ManifestStream): string => {
		const {
			name: _name,
			description: _description,
			display: _display,
			...contract
		} = stream;
		return JSON.stringify(contract);
	};
	const streams = manifestStreams();
	const reference = streams.get("activity");
	assert.ok(reference);
	for (const area of HEALTH_AREA_STREAMS) {
		const stream = streams.get(area);
		assert.ok(stream, area);
		assert.equal(contractOf(stream), contractOf(reference), area);
	}
});

test("the owner copy names what reproductive_health carries, and where the reproduction symptoms went", () => {
	const streams = manifestStreams();
	const reproductive = streams.get("reproductive_health");
	const symptoms = streams.get("symptoms");
	assert.ok(reproductive && symptoms);
	const consent = reproductive.display.detail.toLowerCase();
	for (const named of [
		"sexual activity",
		"pregnancy",
		"breast pain",
		"pelvic pain",
		"vaginal dryness",
	]) {
		assert.ok(consent.includes(named), `the consent copy names ${named}`);
	}
	assert.match(reproductive.description, /deliberate deviation/);
	assert.match(symptoms.description, /reproductive_health/);
	assert.match(symptoms.display.detail, /Reproductive health instead/);
});

test("the owner copy and the receipt say which device fields tell records apart, and what cannot be told apart", () => {
	const streams = manifestStreams();
	for (const name of [...HEALTH_AREA_STREAMS, "workouts"]) {
		const consent = streams.get(name)?.display.detail ?? "";
		assert.match(
			consent,
			/two devices with the same maker, model and hardware/,
			name,
		);
		assert.match(
			consent,
			/descriptions are missing or could not be read/,
			name,
		);
	}
	const duplicates = streams.get("coverage_diagnostics")?.schema.properties
		.duplicates_discarded as { description?: string } | undefined;
	for (const stated of [
		/firmware and software are published but not compared/,
		/missing or could not be read is compared as none/,
		/Two devices with the same manufacturer, model and hardware cannot be told apart/,
	]) {
		assert.match(duplicates?.description ?? "", stated);
	}
});

test("the receipt says what 'complete' cannot cover under a resource list", () => {
	const status = manifestStreams().get("coverage_diagnostics")?.schema
		.properties.status as { description?: string } | undefined;
	assert.match(
		status?.description ?? "",
		/a record requested by id that cannot be read is not reported on the receipt/,
	);
	assert.match(status?.description ?? "", /should check that each one arrived/);
});

test("the nothing_in_range copy also holds when a resource list matched nothing", () => {
	// The reason is given as well when the export has data in the period but
	// none of the ids asked for, so the copy cannot speak of the period alone.
	const parsed = JSON.parse(
		readFileSync(manifestPath("apple_health"), "utf8"),
	) as { reason_display_messages: Record<string, string> };
	const copy = parsed.reason_display_messages.nothing_in_range ?? "";
	assert.match(copy, /matching this request/);
	assert.doesNotMatch(copy, /period/);
});

test("every data stream's consent copy names the time-zone offset and the device's firmware, and each area's names hand entry", () => {
	const streams = manifestStreams();
	for (const name of [...HEALTH_AREA_STREAMS, "workouts"]) {
		const consent = streams.get(name)?.display.detail ?? "";
		assert.match(consent, /time-zone offset/, name);
		assert.match(
			consent,
			/which shows when you were in another time zone/,
			name,
		);
		assert.match(consent, /firmware/, name);
		if (name !== "workouts") {
			assert.match(consent, /whether it was typed in by hand/, name);
		}
	}
});

test("the receipts' consent copy says what granting the receipts alone reveals", () => {
	const consent =
		manifestStreams().get("coverage_diagnostics")?.display.detail ?? "";
	for (const named of [
		/how many records arrived/,
		/earliest and latest dates/,
		/could not be read/,
		/does not recognise/,
		/fields left empty/,
		/The receipts alone therefore show/,
		/reproductive-health records, how many, and from when to when/,
	]) {
		assert.match(consent, named);
	}
});

test("the workouts consent copy names heart-rate summaries, where activities' statistics are used, and the identity budget", () => {
	const consent = manifestStreams().get("workouts")?.display.detail ?? "";
	// Workout statistics carry summaries of readings vital_signs would gate.
	assert.match(consent, /average, minimum and maximum heart rate/);
	// The activities' statistics feed the totals, so they do not only repeat
	// what the workout's own cover.
	assert.doesNotMatch(consent, /already cover the whole workout/);
	assert.match(consent, /used only to add up the workout's totals/);
	assert.match(
		consent,
		/the same type, device maker, model and hardware, start and end/,
	);
	assert.match(consent, /100,000 different workouts/);
});

test("the copy says which workout edits replace a workout, and which rows a resource list leaves uncounted", () => {
	const streams = manifestStreams();
	const workouts = streams.get("workouts")?.description ?? "";
	assert.match(
		workouts,
		/An edited workout replaces the one already held, unless the edit changed its type, its device's manufacturer, model or hardware, its start, time-zone offset or end, or its duration/,
	);
	const skipped = streams.get("coverage_diagnostics")?.schema.properties
		.records_skipped_unreadable as { description?: string } | undefined;
	assert.match(
		skipped?.description ?? "",
		/Unreadable rows are not counted when the stream was asked for specific record ids.*a requested row the schema rejected is\./,
	);
});

test("the activity copy lists examples, and the hearing copy names headphones", () => {
	const streams = manifestStreams();
	const activity = streams.get("activity");
	assert.match(activity?.description ?? "", /under Activity, such as steps/);
	assert.match(activity?.display.detail ?? "", /^Readings such as steps/);
	const hearing = streams.get("hearing")?.display.detail ?? "";
	assert.match(hearing, /the sound reduction your headphones applied/);
	assert.doesNotMatch(hearing, /hearing devices/);
});

test("the workout totals say where they come from on a newer export, and when they are null", () => {
	const properties = manifestStreams().get("workouts")?.schema.properties;
	for (const field of ["total_distance_km", "total_energy_burned_kcal"]) {
		const described = (properties?.[field] as { description?: string })
			?.description;
		assert.match(
			described ?? "",
			/iOS 16 and later typically state none/,
			field,
		);
		assert.match(described ?? "", /never both/, field);
		assert.match(
			described ?? "",
			new RegExp(`lists ${field} under fields_unavailable`),
			field,
		);
	}
});

for (const [name, schema] of PAIRS) {
	test(`parity: ${name} Zod shape matches the manifest's published JSON Schema`, () => {
		const stream = manifestStreams().get(name);
		assert.ok(stream, `manifest declares no stream named ${name}`);
		const inManifest = Object.keys(stream.schema.properties).sort();
		const inZod = zodKeys(schema);
		assert.deepEqual(
			inZod,
			inManifest,
			`Zod and the manifest disagree for "${name}". ` +
				`Only in Zod: ${inZod.filter((k) => !inManifest.includes(k)).join(", ") || "none"}. ` +
				`Only in the manifest: ${inManifest.filter((k) => !inZod.includes(k)).join(", ") || "none"}.`,
		);
	});
}

test("parity: every stream's manifest declares the offset bound its schema enforces", () => {
	// A reader validating against the manifest would otherwise accept offsets
	// the connector never publishes, and could not tell a null from one.
	const streams = manifestStreams();
	for (const [name, schema] of PAIRS) {
		const declared = streams.get(name)?.schema.properties
			.start_utc_offset_minutes as
			| { maximum?: number; minimum?: number }
			| undefined;
		if (name === "coverage_diagnostics") {
			assert.equal(declared, undefined);
			continue;
		}
		assert.deepEqual(
			[declared?.minimum, declared?.maximum],
			[-MAX_UTC_OFFSET_MINUTES, MAX_UTC_OFFSET_MINUTES],
			name,
		);
		const sample = name === "workouts" ? WORKOUT_RECORD : RECORD_NUMERIC;
		for (const offset of [-MAX_UTC_OFFSET_MINUTES, MAX_UTC_OFFSET_MINUTES]) {
			assert.ok(
				schema.safeParse({ ...sample, start_utc_offset_minutes: offset })
					.success,
			);
			assert.ok(
				!schema.safeParse({
					...sample,
					start_utc_offset_minutes: offset + Math.sign(offset),
				}).success,
			);
		}
	}
});

test("parity: no stream publishes an identity field", () => {
	// The exclusions are a decision, so they get a test. This fails if any of
	// them is added to the Zod schema or the manifest.
	const forbidden = [
		"source_name",
		"source_version",
		"metadata",
		"email",
		"name",
		"first_name",
		"last_name",
		"birthday",
		"date_of_birth",
		"blood_type",
		"biological_sex",
	];
	const streams = manifestStreams();
	for (const [name, schema] of PAIRS) {
		const manifestProps = Object.keys(
			streams.get(name)?.schema.properties ?? {},
		);
		const zodProps = zodKeys(schema);
		for (const field of forbidden) {
			assert.ok(
				!manifestProps.includes(field),
				`manifest stream "${name}" must not publish "${field}"`,
			);
			assert.ok(
				!zodProps.includes(field),
				`Zod schema "${name}" must not publish "${field}"`,
			);
		}
	}
});

test("parity: every manifest reason has display copy, and none is runtime-reserved", () => {
	const path = manifestPath("apple_health");
	const parsed = JSON.parse(readFileSync(path, "utf8")) as {
		reason_display_messages: Record<string, string>;
		streams: ManifestStream[];
	};
	const coverage = parsed.streams.find(
		(s) => s.name === "coverage_diagnostics",
	);
	assert.ok(coverage);
	const reasons = (coverage.schema.properties.reason as { enum: string[] })
		.enum;
	for (const reason of reasons) {
		assert.ok(
			Object.hasOwn(parsed.reason_display_messages, reason),
			`reason "${reason}" has no owner-facing copy`,
		);
	}
	// Declaring copy for a code the runtime owns fails reason-display-messages.test.ts.
	const runtimeOwned = [
		"rate_limited",
		"upstream_pressure",
		"auth_failure",
		"gone",
		"not_found",
		"permanent_forbidden",
		"quarantined",
		"not_available_in_mode",
		"out_of_scope",
		"user_disabled",
		"retry_exhausted",
		"run_cap_deferred",
		"temporary_unavailable",
	];
	for (const code of runtimeOwned) {
		assert.ok(
			!Object.hasOwn(parsed.reason_display_messages, code),
			`"${code}" is owned by the runtime; a connector must not redeclare its copy`,
		);
	}
});

test("parity: every value the manifest advertises in an enum is accepted by the schema", () => {
	// An enum value the manifest advertises must be one the code can produce,
	// e.g. freshness is only 'snapshot'.
	const samples: Record<string, Record<string, unknown>> = {
		...Object.fromEntries(
			HEALTH_AREA_STREAMS.map((stream) => [stream, RECORD_NUMERIC]),
		),
		workouts: WORKOUT_RECORD,
		coverage_diagnostics: COVERAGE_RECORD,
	};
	const streams = manifestStreams();
	for (const [name, schema] of PAIRS) {
		const stream = streams.get(name);
		assert.ok(stream);
		const sample = samples[name];
		assert.ok(sample, `no sample record for ${name}`);
		for (const [field, spec] of Object.entries(stream.schema.properties)) {
			const values = (spec as { enum?: unknown[] }).enum;
			if (!Array.isArray(values)) {
				continue;
			}
			for (const value of values) {
				const result = schema.safeParse({ ...sample, [field]: value });
				assert.ok(
					result.success,
					`manifest advertises ${name}.${field} = ${JSON.stringify(value)}, ` +
						"but the schema rejects it: " +
						JSON.stringify(result.error?.issues),
				);
			}
		}
	}
});

test("parity: the manifest never requires a field the schema does not declare", () => {
	const streams = manifestStreams();
	for (const [name, schema] of PAIRS) {
		const stream = streams.get(name);
		assert.ok(stream);
		const declared = new Set(zodKeys(schema));
		for (const field of stream.schema.required ?? []) {
			assert.ok(
				declared.has(field),
				`manifest stream "${name}" requires "${field}", which the schema does not declare`,
			);
		}
	}
});

test("parity: a manifest enum that drifts from the schema is caught", () => {
	// Negative control. If this passes, the test above is load-bearing rather
	// than decorative: feeding a value no enum contains must fail.
	const result = coverageDiagnosticsSchema.safeParse({
		...COVERAGE_RECORD,
		freshness: "live",
	});
	assert.equal(
		result.success,
		false,
		'"live" must be rejected; the schema emits only "snapshot"',
	);
});
