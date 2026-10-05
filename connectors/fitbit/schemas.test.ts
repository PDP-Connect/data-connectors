// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests. The one that earns its keep is PARITY: nothing in the
 * toolchain keeps the Zod schemas and the manifest's hand-written JSON Schema
 * in sync, and the JSON Schema is what a reading application integrates
 * against. A field in one and not the other is a promise broken on one side
 * or a leak opened on the other.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { manifestPath } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { RUNTIME_GENERIC_REASON_CODES } from "../../packages/polyfill-connectors/src/reference-implementation-stand-in/runtime/recovery-reason-codes.ts";
import { SKIP_MESSAGE } from "./collect.ts";
import { activityType } from "./parsers.ts";
import {
	type ActivityRecord,
	activitiesSchema,
	DATA_STREAMS,
	type DailySummaryRecord,
	dailySummariesSchema,
	FRESHNESS_VALUES,
	OPTIONAL_READING_FIELDS,
	SCHEMAS,
	type SleepRecord,
	START_TIME_BASES,
	sleepSchema,
	validateRecord,
} from "./schemas.ts";

interface ManifestProperty {
	enum?: string[];
	x_pdpp_role?: string;
	description?: string;
}

interface ManifestStream {
	name: string;
	primary_key: string[];
	schema: {
		properties: Record<string, ManifestProperty>;
		required?: string[];
	};
}

interface Manifest {
	streams: ManifestStream[];
	reason_display_messages: Record<string, string>;
	setup: {
		manual_or_upload: {
			acquisition_methods: { detail: string }[];
			large_file_fallback: string;
		};
	};
}

function manifest(): Manifest {
	return JSON.parse(readFileSync(manifestPath("fitbit"), "utf8"));
}

function stream(name: string): ManifestStream {
	const found = manifest().streams.find((entry) => entry.name === name);
	assert.ok(found, `manifest must declare the ${name} stream`);
	return found;
}

function property(streamName: string, field: string): ManifestProperty {
	const found = stream(streamName).schema.properties[field];
	assert.ok(found, `${streamName} must declare ${field}`);
	return found;
}

function shape(name: string): Readonly<Record<string, z.core.$ZodType>> {
	const schema = SCHEMAS[name];
	assert.ok(schema instanceof z.ZodObject, `${name}: an object schema`);
	return schema.shape;
}

function shapeKeys(name: string): string[] {
	return Object.keys(shape(name)).sort();
}

function reasonMessage(reason: string): string {
	const text = manifest().reason_display_messages[reason];
	assert.ok(text, `${reason} must have owner copy`);
	return text;
}

const EXPORTED_AT = "2026-09-20T08:15:00.000Z";

const ACTIVITY: ActivityRecord = {
	id: "21000000001",
	activity_type: "run",
	start_date: "2026-03-13",
	start_time: "2026-03-13T23:00:00Z",
	start_time_basis: "utc",
	distance_m: 5200,
	elapsed_time_s: 1805,
	freshness: "snapshot",
	exported_at: EXPORTED_AT,
};

const DAILY_SUMMARY: DailySummaryRecord = {
	id: "2026-04-04",
	date: "2026-04-04",
	steps: 150,
	distance_m: 80,
	lightly_active_minutes: 45,
	moderately_active_minutes: 10,
	very_active_minutes: 22,
	resting_heart_rate_bpm: 58.43210987,
	freshness: "snapshot",
	exported_at: EXPORTED_AT,
};

const SLEEP: SleepRecord = {
	id: "31000000001",
	date: "2026-03-14",
	is_main_sleep: true,
	sleep_score: 81,
	asleep_duration_s: 24_120,
	awake_duration_s: 3720,
	deep_sleep_duration_s: 5220,
	light_sleep_duration_s: 14_160,
	rem_sleep_duration_s: 4740,
	freshness: "snapshot",
	exported_at: EXPORTED_AT,
};

/** One valid record per stream, shaped as the builders emit it. */
const SAMPLES: Readonly<
	Record<(typeof DATA_STREAMS)[number], Record<string, unknown>>
> = {
	activities: ACTIVITY,
	daily_summaries: DAILY_SUMMARY,
	sleep: SLEEP,
};

// ── Parity ───────────────────────────────────────────────────────────────────

test("the manifest's streams are the data streams, each with a Zod schema", () => {
	assert.deepEqual(
		manifest().streams.map((entry) => entry.name),
		[...DATA_STREAMS],
	);
	assert.deepEqual(Object.keys(SCHEMAS).sort(), [...DATA_STREAMS].sort());
});

test("no coverage_diagnostics stream is declared or given a schema: run health is reported in PROGRESS", () => {
	const names = [
		...manifest().streams.map((entry) => entry.name),
		...Object.keys(SCHEMAS),
	];
	assert.ok(
		!names.includes("coverage_diagnostics"),
		"neither the manifest nor SCHEMAS may declare coverage_diagnostics",
	);
	assert.deepEqual(
		names.filter((name) => /coverage|diagnostic|receipt/i.test(name)),
		[],
		"no stream under another name may carry run health either",
	);
});

for (const name of DATA_STREAMS) {
	test(`${name}: Zod and the manifest declare the same fields, and the manifest requires all of them`, () => {
		const declared = stream(name).schema;
		assert.deepEqual(
			Object.keys(declared.properties).sort(),
			shapeKeys(name),
			"a field in one and not the other is either an unkept promise or an unannounced leak",
		);
		// Every key is on every record, null when absent, so a reader validating
		// against the JSON Schema must not accept a record the connector refuses.
		assert.deepEqual([...(declared.required ?? [])].sort(), shapeKeys(name));
	});
}

test("every stream is keyed by a field named id", () => {
	// The runtime silently drops a record without a literal `id` and still
	// reports success, so a stream keyed by anything else would emit nothing.
	for (const name of DATA_STREAMS) {
		assert.deepEqual(stream(name).primary_key, ["id"], `${name}: primary key`);
		assert.ok(shapeKeys(name).includes("id"), `${name}: id field`);
	}
});

test("the manifest's enums are the Zod enums, which are the exported constants", () => {
	assert.deepEqual(
		[...(property("activities", "start_time_basis").enum ?? [])].sort(),
		[...START_TIME_BASES].sort(),
	);
	assert.deepEqual(
		[...activitiesSchema.shape.start_time_basis.options].sort(),
		[...START_TIME_BASES].sort(),
	);
	for (const name of DATA_STREAMS) {
		assert.deepEqual(
			[...(property(name, "freshness").enum ?? [])].sort(),
			[...FRESHNESS_VALUES].sort(),
			`${name}: manifest freshness enum`,
		);
		const zod = shape(name).freshness;
		assert.ok(zod instanceof z.ZodEnum, `${name}: Zod freshness is an enum`);
		assert.deepEqual(
			[...zod.options].sort(),
			[...FRESHNESS_VALUES].sort(),
			`${name}: Zod freshness enum`,
		);
	}
});

test("every SKIP_RESULT reason has owner copy, and nothing else does", () => {
	// Only a SKIP_RESULT carries a reason to the owner; the three outcomes
	// that skip nothing appear only in the coverage line, which has no copy.
	assert.deepEqual(
		Object.keys(manifest().reason_display_messages).sort(),
		Object.keys(SKIP_MESSAGE).sort(),
	);
});

test("no SKIP_RESULT reason collides with a runtime generic reason code", () => {
	// A collision would let the runtime's generic copy stand in for this
	// connector's own next-action sentence.
	for (const reason of Object.keys(SKIP_MESSAGE)) {
		assert.ok(
			!RUNTIME_GENERIC_REASON_CODES.has(reason),
			`${reason} is a runtime generic reason code`,
		);
	}
});

test("every stream has at least one role and at most one primary-title", () => {
	for (const name of DATA_STREAMS) {
		const roles = Object.values(stream(name).schema.properties).flatMap(
			(entry) => (entry.x_pdpp_role ? [entry.x_pdpp_role] : []),
		);
		assert.ok(roles.length >= 1, `${name} must mark at least one role`);
		assert.ok(
			roles.filter((role) => role === "primary-title").length <= 1,
			`${name} must mark at most one primary-title`,
		);
	}
});

test("the optional readings are exactly the nullable fields besides exported_at", () => {
	// fields_unavailable is computed from this list, so a nullable reading left
	// off it could never be reported missing, and a required one on it would be
	// reported missing for a field that can never be null.
	for (const name of DATA_STREAMS) {
		const nullable = Object.entries(shape(name))
			.filter(
				([field, schema]) =>
					field !== "exported_at" && z.safeParse(schema, null).success,
			)
			.map(([field]) => field)
			.sort();
		assert.deepEqual([...OPTIONAL_READING_FIELDS[name]].sort(), nullable, name);
	}
});

// ── Copy ─────────────────────────────────────────────────────────────────────

/** Every string in `value`, however deeply nested. */
function stringsIn(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}
	if (typeof value === "object" && value !== null) {
		return Object.values(value).flatMap((entry) => stringsIn(entry));
	}
	return [];
}

test("no reason's copy says everything else imported", () => {
	// Every reason with copy is a skip: records_unreadable can arrive with
	// nothing delivered, or beside values blanked on what was.
	for (const [reason, text] of Object.entries(
		manifest().reason_display_messages,
	)) {
		assert.doesNotMatch(text, /everything else/i, reason);
	}
});

test("no copy says the folder or upload holds no export", () => {
	// Only the newest export in the upload is examined, so copy can say what
	// that one is, never what the whole upload lacks.
	for (const text of [
		...stringsIn(manifest()),
		...Object.values(SKIP_MESSAGE),
	]) {
		assert.doesNotMatch(text, /\bholds no\b/i, text);
	}
});

test("owner copy has Google email a download link, never the ZIP or the export itself", () => {
	for (const text of stringsIn(manifest())) {
		assert.doesNotMatch(
			text,
			/ZIP Google email|Google email(?:s|ed)? (?:you )?(?:the |your |a )?(?:ZIP|export)\b/i,
			text,
		);
	}
});

test("the upload copy names the file type and part size to choose, and the one it refuses", () => {
	const awaiting = reasonMessage("awaiting_upload");
	assert.match(awaiting, /\.zip/);
	assert.match(awaiting, /2 GB/);
	assert.match(reasonMessage("source_unreadable"), /\.tgz/);
});

test("copy for a reason whose recovery hint follows its cause names both next actions", () => {
	// source_limit_reached asks the owner to act for a part too large or a
	// missing file beside a member too large, and asks for a new import for a
	// member too large alone; export_format_changed does the same for a missing
	// file and for content in another layout. Each copy must be true of every
	// path, and name the missing ZIP wherever the owner's hint can come from one.
	const limit = reasonMessage("source_limit_reached");
	assert.match(limit, /upload every one together/);
	assert.match(limit, /can't always tell if one is missing/);
	assert.match(limit, /request the export again with 2 GB files/);
	assert.match(limit, /otherwise, please report this/);
	const format = reasonMessage("export_format_changed");
	assert.match(format, /ZIP files may be missing/);
	assert.match(format, /Google may have changed the format/);
	assert.match(format, /please report this/);
});

test("copy that a missing ZIP part can reach names that part as a cause", () => {
	// A last part that was not uploaded cannot be detected, so the skip it
	// can produce, and the setup copy, must say it may be the cause.
	assert.match(reasonMessage("export_format_changed"), /may be missing/);
	const upload = manifest().setup.manual_or_upload;
	for (const text of [
		upload.acquisition_methods[0]?.detail ?? "",
		upload.large_file_fallback,
	]) {
		assert.match(text, /can't always tell if (one|the last one) is missing/);
	}
});

test("no copy promises more than the uploaded files for one kind of data", () => {
	for (const text of stringsIn(manifest())) {
		assert.doesNotMatch(text, /not a problem/i, text);
		assert.doesNotMatch(text, /\beverything in the files\b/i, text);
	}
});

test("activity_type's copy says a typed name that matches the list becomes its code", () => {
	// The import cannot tell a name the owner typed from Fitbit's own, so a
	// typed "RUN" is published as run: the copy must not say every typed name
	// is withheld.
	assert.equal(activityType("RUN").value, "run");
	// Only case and extra spaces are ignored: a missing space is no match.
	assert.equal(activityType("  Outdoor   Bike ").value, "outdoor_bike");
	assert.equal(activityType("OutdoorBike").withheld, true);
	const text = property("activities", "activity_type").description ?? "";
	assert.doesNotMatch(text, /such a name is never published/);
	assert.match(
		text,
		/typed name that matches a listed name, ignoring case and extra spaces, becomes that code/,
	);
});

test("every sentence of copy that mentions a typed exercise name says a matching one is kept", () => {
	// A typed "CrossFit" is published as crossfit, so no copy may say that
	// every name the owner typed is left out.
	const mentions = stringsIn(manifest()).filter((text) =>
		/\btyped\b/.test(text),
	);
	assert.equal(
		mentions.length,
		4,
		"help_text, the activities description and detail, and activity_type",
	);
	for (const text of mentions) {
		for (const sentence of text.split(/(?<=\.) /)) {
			if (/\btyped\b/.test(sentence)) {
				assert.match(sentence, /\bmatch(es)?\b/, sentence);
			}
		}
	}
});

// ── Exclusions ───────────────────────────────────────────────────────────────

const FORBIDDEN_FIELDS = [
	"latitude",
	"longitude",
	"timezone",
	"time_zone",
	"utc_offset",
	"start_time_local",
	"local_date",
	"bedtime",
	"wake_time",
	"sleep_start",
	"sleep_end",
	"activity_name",
	"name",
	"title",
	"description",
	"note",
	"device",
	"device_id",
	"serial",
	"source",
	"tcx_link",
	"calories",
	"calories_kcal",
	"floors",
	"sedentary_minutes",
	"heart_rate_zones",
	"efficiency",
	"time_in_bed",
	"last_modified",
	"original_start_time",
	"email",
	"profile_id",
];

/** Any key that looks like location, a local clock, identity, free text or an out-of-scope reading. */
const SUSPECT_FIELD_RE =
	/lat|lon|location|timezone|zone|offset|utc|device|serial|tracker|source|uuid|email|profile|name|title|description|note|altitude|elevation|temperature|calorie|gps|tcx|link|url|start_at|end_at|bed|wake|local|log_type|created|modified|spo2|stress|weight/i;

/** Keys the pattern catches that carry none of that. */
const SUSPECT_BUT_ALLOWED = ["awake_duration_s"];

test("no stream declares a location, local-clock, identity or free-text field", () => {
	const fields = DATA_STREAMS.flatMap((name) => [
		...shapeKeys(name),
		...Object.keys(stream(name).schema.properties),
	]);
	for (const forbidden of FORBIDDEN_FIELDS) {
		assert.ok(!fields.includes(forbidden), `${forbidden} must not be declared`);
	}
	assert.deepEqual(
		[...new Set(fields.filter((field) => SUSPECT_FIELD_RE.test(field)))].sort(),
		[...SUSPECT_BUT_ALLOWED].sort(),
		"a new key matching the pattern must be justified here, or removed",
	);
});

// ── Values ───────────────────────────────────────────────────────────────────

test("a record shaped as the builders emit it validates, on every stream", () => {
	for (const name of DATA_STREAMS) {
		const result = validateRecord(name, SAMPLES[name]);
		assert.ok(result.ok && result.anomalies === undefined, name);
	}
});

test("a record with one undeclared key fails validateRecord, on every stream", () => {
	// The runtime emits the builder's own object, so only strictness stops a
	// stray key from reaching a reader.
	for (const name of DATA_STREAMS) {
		const result = validateRecord(name, { ...SAMPLES[name], name: "x" });
		assert.equal(result.ok, false, name);
	}
});

test("exported_at may be null but never absent, on every stream", () => {
	for (const name of DATA_STREAMS) {
		const { exported_at: _omitted, ...withoutKey } = SAMPLES[name];
		assert.equal(
			validateRecord(name, { ...SAMPLES[name], exported_at: null }).ok,
			true,
			`${name}: null`,
		);
		assert.equal(validateRecord(name, withoutKey).ok, false, `${name}: absent`);
	}
});

test("freshness accepts only live and snapshot", () => {
	for (const value of FRESHNESS_VALUES) {
		assert.ok(sleepSchema.safeParse({ ...SLEEP, freshness: value }).success);
	}
	for (const value of ["cached", "", null]) {
		assert.equal(
			sleepSchema.safeParse({ ...SLEEP, freshness: value }).success,
			false,
			String(value),
		);
	}
});

test("activity_type holds a type code, never a display name or a typed title", () => {
	assert.ok(
		activitiesSchema.safeParse({ ...ACTIVITY, activity_type: null }).success,
	);
	for (const value of ["Run", "Parkrun with Dad", "outdoor-bike", "", "7"]) {
		assert.equal(
			activitiesSchema.safeParse({ ...ACTIVITY, activity_type: value }).success,
			false,
			value,
		);
	}
});

test("start_time is a UTC instant to the second, and nothing else", () => {
	for (const value of [
		"2026-03-13T23:00:00",
		"2026-03-13T23:00:00.000Z",
		"2026-03-14T09:00:00+10:00",
		"+275760-09-13T00:00:00Z",
	]) {
		assert.equal(
			activitiesSchema.safeParse({ ...ACTIVITY, start_time: value }).success,
			false,
			value,
		);
	}
	assert.equal(
		activitiesSchema.safeParse({ ...ACTIVITY, start_time_basis: "local" })
			.success,
		false,
	);
});

test("a log id is a positive integer's digits", () => {
	for (const value of ["0", "-1", "abc", "", "1.5", "01"]) {
		assert.equal(
			activitiesSchema.safeParse({ ...ACTIVITY, id: value }).success,
			false,
			value,
		);
		assert.equal(
			sleepSchema.safeParse({ ...SLEEP, id: value }).success,
			false,
			value,
		);
	}
});

test("steps and active minutes are whole counts, and resting heart rate is positive", () => {
	for (const field of [
		"steps",
		"lightly_active_minutes",
		"moderately_active_minutes",
		"very_active_minutes",
	]) {
		for (const value of [1.5, -1]) {
			assert.equal(
				dailySummariesSchema.safeParse({ ...DAILY_SUMMARY, [field]: value })
					.success,
				false,
				`${field} ${value}`,
			);
		}
	}
	for (const value of [0, -58]) {
		assert.equal(
			dailySummariesSchema.safeParse({
				...DAILY_SUMMARY,
				resting_heart_rate_bpm: value,
			}).success,
			false,
			String(value),
		);
	}
	assert.equal(
		dailySummariesSchema.safeParse({ ...DAILY_SUMMARY, distance_m: -0.01 })
			.success,
		false,
	);
});

test("is_main_sleep is a boolean, and a sleep date is a bare calendar date", () => {
	assert.equal(
		sleepSchema.safeParse({ ...SLEEP, is_main_sleep: "true" }).success,
		false,
	);
	for (const value of ["03/14/26", "2026-03-14T00:00:00Z", "20260314"]) {
		assert.equal(
			sleepSchema.safeParse({ ...SLEEP, date: value }).success,
			false,
			value,
		);
	}
});

test("readings refuse what is not a finite number", () => {
	for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "81"]) {
		assert.equal(
			sleepSchema.safeParse({ ...SLEEP, sleep_score: value }).success,
			false,
			String(value),
		);
	}
});
