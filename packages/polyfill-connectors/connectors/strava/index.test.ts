// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for the Strava export connector, driven through the real
 * connector protocol as a subprocess.
 *
 * The case worth naming: a diagnostic record must be emitted even when NO
 * activities are. "Nothing in range" and "collection interrupted" both present
 * as an empty activity list and have opposite next actions for the owner, so
 * the diagnostic cannot ride on the activity records — there would be nowhere
 * for it to live in exactly the case it is most needed.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "strava", "index.ts");

/** Header in export order, including both repeated columns. */
const HEADER =
	"Activity ID,Activity Date,Activity Name,Activity Type,Activity Description," +
	"Elapsed Time,Distance,Max Heart Rate,Relative Effort,Activity Gear,Filename," +
	"Athlete Weight,Bike Weight,Elapsed Time,Moving Time,Distance," +
	"Average Heart Rate,Elevation Gain,Calories";

/** display Elapsed=48:10, display Distance=5.04 mi; canonical 2890 s, 8111.2 m. */
const ROW_RUN =
	'11385479490,"May 20, 2024, 1:05:32 PM","Parkrun with Dad",Run,"felt great",' +
	'48:10,5.04,178,62,"Brooks Ghost 15",activities/1.fit.gz,' +
	"72.5,,2890,2710,8111.2,152.3,64.2,612";

const ROW_RIDE =
	'11385479491,"2024-06-01T06:00:00Z","Commute",Ride,,' +
	"35:00,9.3,,,,activities/2.fit.gz,,9.1,2100,2000,14967.0,,31.0,";

function makeStoredZip(
	entries: readonly { name: string; data: Buffer }[],
): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04_03_4b_50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(0, 8);
		local.writeUInt32LE(entry.data.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		localParts.push(local, name, entry.data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02_01_4b_50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt32LE(entry.data.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centralParts.push(central, name);
		offset += local.length + name.length + entry.data.length;
	}
	const central = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06_05_4b_50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...localParts, central, end]);
}

async function withImportDir(
	files: Record<string, string | Buffer>,
	body: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "strava-export-"));
	try {
		await Promise.all(
			Object.entries(files).map(([name, content]) =>
				writeFile(join(dir, name), content, "utf8"),
			),
		);
		await body(dir);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
}

async function run(
	dir: string,
	state?: Record<string, unknown>,
	timeRange?: { since?: string; until?: string },
) {
	return await runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: ENTRYPOINT,
		env: {
			PDPP_OWNER_TOKEN: "",
			PDPP_RS_URL: "",
			RS_URL: "",
			STRAVA_EXPORT_DIR: dir,
			TZ: "UTC",
		},
		start: {
			scope: {
				streams: [
					{
						name: "activities",
						...(timeRange ? { time_range: timeRange } : {}),
					},
					{ name: "coverage_diagnostics" },
				],
			},
			...(state ? { state } : {}),
			type: "START",
		},
	});
}

async function runFullRefresh(dir: string, state?: Record<string, unknown>) {
	return await runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: ENTRYPOINT,
		env: {
			PDPP_OWNER_TOKEN: "",
			PDPP_RS_URL: "",
			RS_URL: "",
			STRAVA_EXPORT_DIR: dir,
			TZ: "UTC",
		},
		start: {
			collection_mode: "full_refresh",
			scope: {
				streams: [{ name: "activities" }, { name: "coverage_diagnostics" }],
			},
			...(state ? { state } : {}),
			type: "START",
		},
	});
}

function recordsOf(result: { messages?: unknown[] }, stream: string) {
	const messages = (result.messages ?? []) as Array<Record<string, unknown>>;
	return messages
		.filter((m) => m.type === "RECORD" && m.stream === stream)
		.map((m) => m.data as Record<string, unknown>);
}

function messagesOf(result: { messages?: unknown[] }, type: string) {
	const messages = (result.messages ?? []) as Array<Record<string, unknown>>;
	return messages.filter((m) => m.type === type);
}

test("a normal export emits activities in canonical units", async () => {
	await withImportDir(
		{ "activities.csv": `${HEADER}\n${ROW_RUN}\n${ROW_RIDE}\n` },
		async (dir) => {
			const result = await run(dir);
			const activities = recordsOf(result, "activities");
			assert.equal(activities.length, 2);

			const run1 = activities.find((a) => a.id === "11385479490");
			assert.ok(run1);
			// The whole duplicate-header argument, end to end: 8111.2 metres, not 5.04.
			assert.equal(run1.distance_m, 8111.2);
			assert.equal(run1.elapsed_time_s, 2890);
			assert.equal(run1.moving_time_s, 2710);
			assert.equal(run1.calories_kcal, 612);
			assert.equal(run1.gear, "Brooks Ghost 15");
			assert.equal(run1.activity_type, "Run");
			// Strava's own rendering states no zone, so the basis must say so.
			assert.equal(run1.start_time, "2024-05-20T13:05:32");
			assert.equal(run1.start_date, "2024-05-20");
			assert.equal(run1.start_time_basis, "unknown");
			// The ISO row keeps the offset branch covered end to end.
			const ride0 = activities.find((a) => a.id === "11385479491");
			assert.equal(ride0?.start_time_basis, "utc");
			assert.equal(run1.freshness, "snapshot");
			assert.ok("exported_at" in run1);

			// Excluded at the schema, so excluded from the wire.
			for (const forbidden of [
				"name",
				"description",
				"athlete_weight",
				"start_latlng",
				"map_polyline",
			]) {
				assert.ok(!(forbidden in run1), `${forbidden} must not reach a reader`);
			}

			// Absence is not zero: the ride had no heart-rate strap and no calories.
			const ride = activities.find((a) => a.id === "11385479491");
			assert.ok(ride);
			assert.equal(ride.average_heartrate, null);
			assert.equal(ride.calories_kcal, null);
		},
	);
});

test("a ZIP export streams activities.csv through the same collection path", async () => {
	const zip = makeStoredZip([
		{ name: "activities.csv", data: Buffer.from(`${HEADER}\n${ROW_RUN}\n`) },
		{ name: "profile.csv", data: Buffer.from("private data") },
	]);
	await withImportDir({ "strava-export.zip": zip }, async (dir) => {
		const result = await run(dir);
		assert.equal(recordsOf(result, "activities").length, 1);
		assert.equal(recordsOf(result, "activities")[0]?.id, "11385479490");
	});
});

test("a complete import reports covered_in_full with the window it actually read", async () => {
	await withImportDir(
		{ "activities.csv": `${HEADER}\n${ROW_RUN}\n${ROW_RIDE}\n` },
		async (dir) => {
			const diagnostics = recordsOf(await run(dir), "coverage_diagnostics");
			assert.equal(diagnostics.length, 1);
			const [diagnostic] = diagnostics;
			assert.equal(diagnostic?.status, "complete");
			assert.equal(diagnostic?.reason, "covered_in_full");
			assert.equal(diagnostic?.record_count, 2);
			assert.equal(diagnostic?.window_covered_from, "2024-05-20T13:05:32");
			assert.equal(diagnostic?.window_covered_to, "2024-06-01T06:00:00Z");
			assert.equal(diagnostic?.freshness, "snapshot");
		},
	);
});

test("a scoped import reports only the records and window that survived time_range", async () => {
	await withImportDir(
		{ "activities.csv": `${HEADER}\n${ROW_RUN}\n${ROW_RIDE}\n` },
		async (dir) => {
			const result = await run(dir, undefined, {
				since: "2024-06-01T00:00:00Z",
				until: "2024-06-02T00:00:00Z",
			});
			assert.equal(recordsOf(result, "activities").length, 1);
			assert.equal(recordsOf(result, "activities")[0]?.id, "11385479491");

			const [diagnostic] = recordsOf(result, "coverage_diagnostics");
			assert.equal(diagnostic?.record_count, 1);
			assert.equal(diagnostic?.window_requested_from, "2024-06-01T00:00:00Z");
			assert.equal(diagnostic?.window_requested_to, "2024-06-02T00:00:00Z");
			assert.equal(diagnostic?.window_covered_from, "2024-06-01T06:00:00Z");
			assert.equal(diagnostic?.window_covered_to, "2024-06-01T06:00:00Z");
		},
	);
});

test("an export with no activities still emits a diagnostic, and it is not failure-shaped", async () => {
	await withImportDir({ "activities.csv": `${HEADER}\n` }, async (dir) => {
		const result = await run(dir);
		assert.equal(recordsOf(result, "activities").length, 0);

		const diagnostics = recordsOf(result, "coverage_diagnostics");
		assert.equal(
			diagnostics.length,
			1,
			"the diagnostic must survive an empty collection",
		);
		assert.equal(diagnostics[0]?.reason, "nothing_in_range");
		assert.equal(diagnostics[0]?.status, "empty");
		assert.equal(diagnostics[0]?.record_count, 0);

		// Nothing in range is an ordinary outcome, not an incident.
		assert.equal(messagesOf(result, "SKIP_RESULT").length, 0);
	});
});

test("unreadable rows are their own outcome, distinct from empty and from truncated", async () => {
	const broken = "not-an-id,,,,,,,,,,,,,,,,,,";
	await withImportDir(
		{ "activities.csv": `${HEADER}\n${ROW_RUN}\n${broken}\n` },
		async (dir) => {
			const result = await run(dir);
			assert.equal(recordsOf(result, "activities").length, 1);

			const [diagnostic] = recordsOf(result, "coverage_diagnostics");
			// NOT collection_interrupted: the file was read to the end, so there is
			// no remainder to come back for and "import it again" is bad advice.
			assert.equal(diagnostic?.reason, "records_unreadable");
			assert.equal(diagnostic?.status, "partial");
			assert.equal(diagnostic?.record_count, 1);

			const skips = messagesOf(result, "SKIP_RESULT");
			assert.equal(skips.length, 1);
			assert.equal(skips[0]?.reason, "records_unreadable");
		},
	);
});

test("a second run resumes from the cursor rather than re-reading everything", async () => {
	await withImportDir(
		{ "activities.csv": `${HEADER}\n${ROW_RUN}\n${ROW_RIDE}\n` },
		async (dir) => {
			const first = await run(dir);
			assert.equal(recordsOf(first, "activities").length, 2);

			const state = messagesOf(first, "STATE").at(-1) as
				| { cursor?: Record<string, unknown> }
				| undefined;
			assert.equal(state?.cursor?.last_start_time, "2024-06-01T06:00:00Z");

			// Same archive, second import: everything is at or before the cursor.
			const second = await run(dir, {
				activities: { last_start_time: "2024-06-01T06:00:00Z" },
			});
			assert.equal(
				recordsOf(second, "activities").length,
				0,
				"an overlapping re-import must collapse, not double-count",
			);
			assert.equal(
				recordsOf(second, "coverage_diagnostics")[0]?.reason,
				"nothing_in_range",
			);
		},
	);
});

test("unreadable rows do NOT stall the cursor — they fail identically next run", async () => {
	const broken = "not-an-id,,,,,,,,,,,,,,,,,,";
	await withImportDir(
		{ "activities.csv": `${HEADER}\n${ROW_RUN}\n${broken}\n` },
		async (dir) => {
			const state = messagesOf(await run(dir), "STATE").at(-1) as
				| { cursor?: Record<string, unknown> }
				| undefined;
			// Holding here would stall for ever: those rows are unreadable on every
			// future import too, so the connector would re-read the whole archive
			// each time and "the second run resumes" would never be true.
			assert.equal(state?.cursor?.last_start_time, "2024-05-20T13:05:32");
		},
	);
});

test("a truncated file DOES hold its cursor, because a remainder exists beyond it", async () => {
	// An unterminated quoted field: the reader cannot know what followed it.
	await withImportDir(
		{ "activities.csv": `${HEADER}\n${ROW_RUN}\n11385479492,"unterminated\n` },
		async (dir) => {
			const result = await run(dir);
			const state = messagesOf(result, "STATE").at(-1) as
				| { cursor?: Record<string, unknown> }
				| undefined;
			assert.equal(state?.cursor?.last_start_time, null);
			assert.equal(
				recordsOf(result, "coverage_diagnostics")[0]?.reason,
				"collection_interrupted",
			);
		},
	);
});

test("an archive missing optional columns says which, rather than serving nulls", async () => {
	const thin = "Activity ID,Activity Date,Activity Type,Elapsed Time,Distance";
	await withImportDir(
		{
			"activities.csv": `${thin}\n11,"May 20, 2024, 1:05:32 PM",Run,2890,8111.2\n`,
		},
		async (dir) => {
			const [diagnostic] = recordsOf(await run(dir), "coverage_diagnostics");
			const unavailable = diagnostic?.fields_unavailable as string[];
			// Calories and gear are the two fields this path exists to deliver.
			assert.ok(unavailable.includes("calories_kcal"));
			assert.ok(unavailable.includes("gear"));
		},
	);
});

test("nothing uploaded yet is awaiting_upload, not a failure report", async () => {
	await withImportDir({}, async (dir) => {
		const diagnostics = recordsOf(await run(dir), "coverage_diagnostics");
		assert.equal(diagnostics.length, 1);
		assert.equal(diagnostics[0]?.status, "empty");
		// Pinning the REASON, not just the status. Asserting only `status` is how
		// this shipped saying "some of your activities didn't arrive — import the
		// file again" about a file the owner had never uploaded.
		assert.equal(diagnostics[0]?.reason, "awaiting_upload");
	});
});

test("an import directory that does not exist still emits a receipt", async () => {
	const dir = join(tmpdir(), "strava-export-does-not-exist-0000");
	const result = await run(dir);
	const diagnostics = recordsOf(result, "coverage_diagnostics");
	assert.equal(
		diagnostics.length,
		1,
		"the branch that used to return silently",
	);
	assert.equal(diagnostics[0]?.reason, "awaiting_upload");
	assert.equal(messagesOf(result, "SKIP_RESULT").length, 1);
});

test("a file that is not a Strava export is source_unreadable, not interrupted", async () => {
	await withImportDir(
		{ "activities.csv": "Title,Date\nSomething,2024-01-01\n" },
		async (dir) => {
			// "Import it again" is the wrong next action: the same file will fail
			// the same way. The owner needs to upload a different file.
			const [diagnostic] = recordsOf(await run(dir), "coverage_diagnostics");
			assert.equal(diagnostic?.reason, "source_unreadable");
		},
	);
});

test("a full refresh ignores the cursor, so edits at source can propagate", async () => {
	await withImportDir(
		{ "activities.csv": `${HEADER}\n${ROW_RUN}\n${ROW_RIDE}\n` },
		async (dir) => {
			const state = { activities: { last_start_time: "2024-06-01T06:00:00Z" } };
			// Incremental: everything is at or before the cursor, so nothing moves.
			assert.equal(recordsOf(await run(dir, state), "activities").length, 0);
			// Full refresh: the owner is asking for the archive re-read whole,
			// which is the only way a renamed or re-typed activity ever reaches a
			// reader — an edit does not move the activity in time.
			const refreshed = await runFullRefresh(dir, state);
			assert.equal(recordsOf(refreshed, "activities").length, 2);
		},
	);
});

test("a file that is not a Strava export says so rather than failing obscurely", async () => {
	await withImportDir(
		{ "activities.csv": "Title,Date\nSomething,2024-01-01\n" },
		async (dir) => {
			const skips = messagesOf(await run(dir), "SKIP_RESULT");
			assert.equal(skips[0]?.reason, "strava_export_columns_unexpected");
		},
	);
});

test("an empty import directory asks for the archive instead of reporting success", async () => {
	await withImportDir({}, async (dir) => {
		const result = await run(dir);
		assert.equal(recordsOf(result, "activities").length, 0);
		const skips = messagesOf(result, "SKIP_RESULT");
		assert.equal(skips[0]?.reason, "strava_export_not_recognised");
	});
});
