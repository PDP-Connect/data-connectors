// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Strava connector.
 *
 * Two jobs. First, assert the Zod schemas against records shaped exactly as
 * parsers.ts emits them. Second — and this is the one that earns its keep —
 * assert PARITY between the Zod schemas and the hand-written JSON Schema in
 * manifests/strava.json. Nothing in the toolchain keeps those two in sync, and
 * the JSON Schema is the published contract a reading application integrates
 * against, so a field that exists in one and not the other is a promise broken
 * on one side or a leak opened on the other.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { manifestPath } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import {
	activitiesSchema,
} from "./schemas.ts";

const MANIFEST_PATH = manifestPath("strava");

interface ManifestStream {
	name: string;
	schema: {
		properties: Record<string, { enum?: string[]; x_pdpp_role?: string }>;
		required?: string[];
	};
}

function manifest(): {
	streams: ManifestStream[];
	reason_display_messages: Record<string, string>;
} {
	return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

function stream(name: string): ManifestStream {
	const found = manifest().streams.find((entry) => entry.name === name);
	assert.ok(found, `manifest must declare the ${name} stream`);
	return found;
}

const ACTIVITY = {
	id: "11385479490",
	activity_type: "Run",
	start_date: "2024-05-20",
	start_date_local: null,
	start_time: "2024-05-20T13:05:32Z",
	start_time_basis: "utc" as const,
	distance_m: 8123.4,
	moving_time_s: 2710,
	elapsed_time_s: 2890,
	total_elevation_gain_m: 64.2,
	average_heartrate: 152.3,
	max_heartrate: 178,
	calories_kcal: 612,
	gear: "Brooks Ghost 15",
	freshness: "snapshot" as const,
	exported_at: "2026-09-12T09:14:00.000Z",
};



test("activities schema accepts a representative record", () => {
	const result = activitiesSchema.safeParse(ACTIVITY);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("activities schema accepts an activity with every optional reading absent", () => {
	const result = activitiesSchema.safeParse({
		...ACTIVITY,
		activity_type: null,
		distance_m: null,
		moving_time_s: null,
		elapsed_time_s: null,
		total_elevation_gain_m: null,
		average_heartrate: null,
		max_heartrate: null,
		calories_kcal: null,
		gear: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("activities schema accepts start_time_basis unknown", () => {
	assert.ok(
		activitiesSchema.safeParse({ ...ACTIVITY, start_time_basis: "unknown" })
			.success,
	);
});

test("activities schema rejects an invented start_time_basis", () => {
	assert.equal(
		activitiesSchema.safeParse({ ...ACTIVITY, start_time_basis: "utc-ish" })
			.success,
		false,
	);
});

test("activities schema rejects a non-numeric id", () => {
	assert.equal(
		activitiesSchema.safeParse({ ...ACTIVITY, id: "act_1138" }).success,
		false,
	);
});

test("exported_at is present-and-nullable, never merely optional", () => {
	// Null is legal: the archive carried no determinable date.
	assert.ok(
		activitiesSchema.safeParse({ ...ACTIVITY, exported_at: null }).success,
	);
	// Absent is NOT legal: a reader must be able to tell "this profile does not
	// report export dates" from "this reading has no export date".
	const { exported_at: _omitted, ...withoutKey } = ACTIVITY;
	assert.equal(activitiesSchema.safeParse(withoutKey).success, false);
});

// ── Manifest parity ──────────────────────────────────────────────────────────

for (const [streamName, zodSchema] of [["activities", activitiesSchema]] as const) {
	test(`${streamName}: Zod and the published JSON Schema declare the same fields`, () => {
		const manifestFields = Object.keys(
			stream(streamName).schema.properties,
		).sort();
		const zodFields = Object.keys(zodSchema.shape).sort();
		assert.deepEqual(
			zodFields,
			manifestFields,
			"a field in one and not the other is either an unkept promise or an unannounced leak",
		);
	});
}

test("the published schema carries no location or identity field, by any spelling", () => {
	const forbidden = [
		"start_latlng",
		"end_latlng",
		"map_polyline",
		"polyline",
		"sunrise_time",
		"sunset_time",
		"weather_temperature",
		"humidity",
		"name",
		"activity_name",
		"description",
		"private_note",
		"athlete_weight",
		"bike_weight",
		"athlete_id",
		"email",
		"filename",
	];
	for (const streamName of ["activities"]) {
		const fields = Object.keys(stream(streamName).schema.properties);
		for (const field of forbidden) {
			assert.ok(
				!fields.includes(field),
				`${streamName} must not publish ${field} — location and identity are excluded at the schema so they cannot be requested by mistake`,
			);
		}
	}
});





test("each stream marks exactly one primary-title field", () => {
	for (const streamName of ["activities"]) {
		const roles = Object.values(stream(streamName).schema.properties)
			.map((property) => property.x_pdpp_role)
			.filter((role) => role === "primary-title");
		assert.equal(
			roles.length,
			1,
			`${streamName} must mark exactly one primary-title`,
		);
	}
});
