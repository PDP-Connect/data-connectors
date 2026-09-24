// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for the Apple Health import connector, driven through the
 * real connector protocol as a subprocess.
 *
 * Four cases carry the weight here.
 *
 * A receipt must be emitted when NO records are. "Nothing in range", "no export
 * has been uploaded yet" and "the archive stopped part way" all present as an
 * empty record list and have completely different next actions for the owner,
 * so the diagnostic cannot ride on the records — there would be nowhere for it
 * to live in exactly the case it is most needed. The likeliest of the three is
 * the first run, before anyone has uploaded anything.
 *
 * Each reading reaches the stream of its health area, and no other: a grant of
 * one area must never carry another's readings, and every data stream gets
 * its own receipt.
 *
 * A second import must re-send every record under the same id. No cursor is
 * saved, so nothing an earlier import persisted can exclude a record from a
 * later one; the streams are mutable_state and the id is a hash of published
 * fields, so a repeat is an upsert rather than a duplicate.
 *
 * Nothing that identifies a person may leave the connector. That is asserted
 * against the emitted protocol output rather than against the schema, because
 * the schema states the intent and the protocol output is what a reader
 * actually receives.
 */

import assert from "node:assert/strict";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
	connectorEntrypoint,
	manifestPath,
	packageRoot as PACKAGE_ROOT,
} from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	buildZip,
	centralDirectoryRecord,
	endOfCentralDirectory,
	localFileHeader,
	type ZipFixtureEntry,
} from "./__fixtures__/zip.ts";
import { HEALTH_AREA_STREAMS } from "./areas.ts";
import { MAX_PENDING_TAG_BYTES } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const ENTRYPOINT = connectorEntrypoint("apple_health");
const AREAS: readonly string[] = HEALTH_AREA_STREAMS;
const DATA_STREAMS: readonly string[] = [...HEALTH_AREA_STREAMS, "workouts"];

/**
 * A small export carrying the shapes that matter: a device whose name is a
 * person's, a metadata bag with free text in it, an imperial workout, a
 * workout weather entry, and two sleep stages that share a start second and
 * differ only in where they end.
 */
const EXPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Me HKCharacteristicTypeIdentifierDateOfBirth="1980-04-11" HKCharacteristicTypeIdentifierBloodType="HKBloodTypeAPositive" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Ada's iPhone" sourceVersion="17.5" device="&lt;&lt;HKDevice: 0x283c2b570&gt;, name:Ada's iPhone, manufacturer:Apple Inc., model:iPhone, hardware:iPhone16,2, software:17.5, localIdentifier:LOCALID77, UDIDeviceIdentifier:UDID88&gt;" unit="count" creationDate="2024-06-05 08:00:00 -0500" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120">
  <MetadataEntry key="HKWasUserEntered" value="0"/>
 </Record>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Ada's Apple Watch" unit="count/min" startDate="2024-06-05 08:01:00 -0500" endDate="2024-06-05 08:01:01 -0500" value="72">
  <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="1"/>
  <MetadataEntry key="HKExternalUUID" value="training plan from Dad"/>
 </Record>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Ada's Apple Watch" startDate="2024-06-06 23:00:00 -0500" endDate="2024-06-06 23:40:00 -0500" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Ada's Apple Watch" startDate="2024-06-06 23:00:00 -0500" endDate="2024-06-07 02:10:00 -0500" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Ada's Apple Watch" duration="48.5" durationUnit="min" totalDistance="5.04" totalDistanceUnit="mi" totalEnergyBurned="612" totalEnergyBurnedUnit="Cal" startDate="2024-06-05 06:30:00 -0500" endDate="2024-06-05 07:18:30 -0500">
  <MetadataEntry key="HKWeatherTemperature" value="58.0 degF"/>
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
  <WorkoutEvent type="HKWorkoutEventTypePause" date="2024-06-05 06:40:00 -0500"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="142" unit="count/min"/>
 </Workout>
</HealthData>
`;

async function withImportDir(
	files: Record<string, string>,
	fn: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "apple-health-"));
	try {
		await Promise.all(
			Object.entries(files).map(([name, body]) =>
				writeFile(join(dir, name), body, "utf8"),
			),
		);
		await fn(dir);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
}

interface RunOpts {
	fullRefresh?: boolean;
	/** Sample the connector subprocess's peak RSS at this interval; result.peakRssBytes is then set. */
	peakRssPollIntervalMs?: number;
	/** Restrict every health-area stream to specific record ids, as a host may. */
	resources?: string[];
	state?: Record<string, unknown>;
	/** The streams to request. Defaults to every data stream and the receipts. */
	streams?: readonly string[];
	timeoutMs?: number;
	/**
	 * A time range for every health-area stream, in the protocol's own field
	 * names, `since` and `until`. A test and the connector that both used
	 * other names would agree with each other and both be wrong: a fixture
	 * that shares the code's assumption cannot catch it.
	 */
	timeRange?: { since?: string; until?: string };
	/** A time range per stream, keyed by stream name. Overrides timeRange. */
	ranges?: Record<string, { since?: string; until?: string }>;
	/** A resource list per stream, keyed by stream name. Overrides resources. */
	streamResources?: Record<string, string[]>;
}

function scopeFor(name: string, opts: RunOpts) {
	const area = AREAS.includes(name);
	const timeRange = opts.ranges?.[name] ?? (area ? opts.timeRange : undefined);
	const resources =
		opts.streamResources?.[name] ?? (area ? opts.resources : undefined);
	return {
		name,
		...(timeRange ? { time_range: timeRange } : {}),
		...(resources ? { resources } : {}),
	};
}

async function run(dir: string, opts: RunOpts = {}) {
	const streams = opts.streams ?? [...DATA_STREAMS, "coverage_diagnostics"];
	return await runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: ENTRYPOINT,
		env: {
			APPLE_HEALTH_EXPORT_DIR: dir,
			PDPP_OWNER_TOKEN: "",
			PDPP_RS_URL: "",
			RS_URL: "",
			TZ: "UTC",
		},
		...(opts.peakRssPollIntervalMs === undefined
			? {}
			: { peakRssPollIntervalMs: opts.peakRssPollIntervalMs }),
		...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
		start: {
			...(opts.fullRefresh ? { collection_mode: "full_refresh" } : {}),
			scope: { streams: streams.map((name) => scopeFor(name, opts)) },
			...(opts.state ? { state: opts.state } : {}),
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

/** Every reading, whichever health-area stream carried it. */
function readingsOf(result: { messages?: unknown[] }) {
	return AREAS.flatMap((stream) => recordsOf(result, stream));
}

/** The receipt accounting for one data stream. */
function receiptOf(result: { messages?: unknown[] }, stream: string) {
	return recordsOf(result, "coverage_diagnostics").find(
		(r) => r.stream === stream,
	);
}

/** The fields one data stream's receipt lists as unavailable; none when it has no receipt. */
function unavailableOn(
	result: { messages?: unknown[] },
	stream: string,
): string[] {
	return (receiptOf(result, stream)?.fields_unavailable ?? []) as string[];
}

/** The ids of every reading, whichever stream carried it. */
function readingIdsOf(result: { messages?: unknown[] }): string[] {
	return readingsOf(result)
		.map((r) => r.id as string)
		.sort();
}

function messagesOf(result: { messages?: unknown[] }, type: string) {
	const messages = (result.messages ?? []) as Array<Record<string, unknown>>;
	return messages.filter((m) => m.type === type);
}

function idsOf(result: { messages?: unknown[] }, stream: string): string[] {
	return recordsOf(result, stream)
		.map((r) => r.id as string)
		.sort();
}

/**
 * State as version 0.1.0 of this connector saved it: a start_date cursor per
 * stream. Nothing may be excluded by it.
 */
function staleCursor(lastStartDate: string): Record<string, unknown> {
	return {
		records: { last_start_date: lastStartDate },
		workouts: { last_start_date: lastStartDate },
	};
}

test("a normal export sends each reading to its area's stream, with a receipt for every data stream", async () => {
	await withImportDir({ "export.xml": EXPORT_XML }, async (dir) => {
		const result = await run(dir);
		assert.equal(
			readingsOf(result).length,
			4,
			"four Record elements carry a startDate",
		);
		assert.deepEqual(
			recordsOf(result, "activity").map((r) => r.type),
			["StepCount"],
		);
		assert.deepEqual(
			recordsOf(result, "vital_signs").map((r) => r.type),
			["HeartRate"],
		);
		assert.deepEqual(
			recordsOf(result, "sleep").map((r) => r.type),
			["SleepAnalysis", "SleepAnalysis"],
		);
		assert.equal(recordsOf(result, "workouts").length, 1);

		const receipts = recordsOf(result, "coverage_diagnostics");
		assert.deepEqual(
			receipts.map((r) => r.stream),
			DATA_STREAMS,
			"one receipt per requested data stream, in manifest order",
		);
		const populated = new Set(["activity", "vital_signs", "sleep", "workouts"]);
		for (const r of receipts) {
			assert.deepEqual(
				r.fields_unavailable,
				[],
				`${String(r.stream)}: a clean import leaves nothing out`,
			);
			if (populated.has(String(r.stream))) {
				assert.equal(r.reason, "covered_in_full", String(r.stream));
				assert.equal(r.status, "complete");
			} else {
				assert.equal(r.reason, "nothing_in_range", String(r.stream));
				assert.equal(r.status, "empty");
				assert.equal(r.record_count, 0);
			}
		}
	});
});

test("the export's own ExportDate reaches every record", async () => {
	await withImportDir({ "export.xml": EXPORT_XML }, async (dir) => {
		const result = await run(dir);
		const all = [...readingsOf(result), ...recordsOf(result, "workouts")];
		assert.ok(all.length > 0);
		for (const r of all) {
			// 2026-09-01 12:00:00 -0500 is 17:00Z. A reader must date Apple Health
			// by this, not by when collection ran.
			assert.equal(r.exported_at, "2026-09-01T17:00:00.000Z");
			assert.equal(r.freshness, "snapshot");
		}
	});
});

test("nothing identifying a person leaves the connector", async () => {
	await withImportDir({ "export.xml": EXPORT_XML }, async (dir) => {
		const result = await run(dir);
		const emitted = JSON.stringify([
			...readingsOf(result),
			...recordsOf(result, "workouts"),
			...recordsOf(result, "coverage_diagnostics"),
		]);

		// The fixture's sources carry a person's name, as a device its owner
		// named does.
		assert.ok(
			!emitted.includes("Ada"),
			"a device name carrying a person's name must never be emitted",
		);
		// The device's name and its identifiers.
		for (const identifier of ["LOCALID77", "UDID88", "0x283c2b570"]) {
			assert.ok(!emitted.includes(identifier), `${identifier} must not appear`);
		}
		// Free text a third-party app wrote into metadata.
		assert.ok(
			!emitted.includes("training plan"),
			"third-party metadata text must never be emitted",
		);
		// The <Me> element's characteristics.
		assert.ok(!emitted.includes("1980-04-11"), "date of birth must not appear");
		assert.ok(!emitted.includes("BloodType"), "blood type must not appear");
		assert.ok(
			!emitted.includes("BiologicalSex"),
			"biological sex must not appear",
		);
		// Weather reconstructs location.
		assert.ok(
			!emitted.includes("degF") && !emitted.includes("WeatherTemperature"),
			"a workout's weather block must not be emitted",
		);
	});
});

test("an imperial workout is converted rather than mislabelled", async () => {
	await withImportDir({ "export.xml": EXPORT_XML }, async (dir) => {
		const result = await run(dir);
		const [workout] = recordsOf(result, "workouts");
		assert.ok(workout);
		// 5.04 mi is 8.11 km. Published verbatim, 5.04 would read as kilometres
		// in a field named total_distance_km.
		const km = workout.total_distance_km as number;
		assert.ok(
			Math.abs(km - 8.111) < 0.001,
			`5.04 mi must convert to ~8.111 km, got ${String(km)}`,
		);
		assert.equal(workout.total_energy_burned_kcal, 612);
		assert.equal(workout.duration_minutes, 48.5);
	});
});

test("two sleep stages sharing a start second are two records, not one", async () => {
	await withImportDir({ "export.xml": EXPORT_XML }, async (dir) => {
		const result = await run(dir);
		const sleep = recordsOf(result, "sleep");
		assert.equal(
			sleep.length,
			2,
			"a hash without the end date would collapse these into one",
		);
		assert.notEqual(sleep[0]?.id, sleep[1]?.id);
	});
});

/** A one-record export taken on `day`, so a run shows which file it read. */
function exportTakenOn(day: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="${day} 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="${day} 08:00:00 -0500" endDate="${day} 08:05:00 -0500" value="5"/>
</HealthData>
`;
}

async function writeAged(
	path: string,
	body: string | Buffer,
	ageMs: number,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, body);
	const when = new Date(Date.now() - ageMs);
	await utimes(path, when, when);
}

test("the upload holding the newest export is read, whatever its kind, place or file time", async () => {
	// A flat export.xml left from an earlier import must not shadow a newer
	// export.zip, even one older on disk, as a file moved in with its original
	// time is; and an unzipped export's CDA document beside its Health export
	// is never the export.
	await withImportDir({}, async (dir) => {
		await writeAged(
			join(dir, "export.xml"),
			exportTakenOn("2025-01-01"),
			3_600_000,
		);
		await writeAged(
			join(dir, "mua_1", "export.zip"),
			buildZip([
				{
					name: "apple_health_export/export.xml",
					data: exportTakenOn("2026-09-01"),
				},
			]),
			2 * 86_400_000,
		);
		const zipped = await run(dir);
		assert.deepEqual(
			recordsOf(zipped, "activity").map((r) => r.exported_at),
			["2026-09-01T17:00:00.000Z"],
			"the newer zip must be read, not the older flat file",
		);
	});
	await withImportDir({}, async (dir) => {
		await writeAged(
			join(dir, "apple_health_export", "export.xml"),
			exportTakenOn("2026-09-01"),
			3_600_000,
		);
		await writeAged(
			join(dir, "apple_health_export", "export_cda.xml"),
			'<?xml version="1.0"?>\n<ClinicalDocument xmlns="urn:hl7-org:v3"/>\n',
			60_000,
		);
		const unzipped = await run(dir);
		assert.equal(recordsOf(unzipped, "activity").length, 1);
		assert.equal(receiptOf(unzipped, "activity")?.reason, "covered_in_full");
	});
});

test("an ExportDate in single quotes or spaced around its '=' still dates its export", async () => {
	// Undated, the newer export would rank below every dated one, and the
	// older upload beside it would be read in its place.
	const stated = '<ExportDate value="2026-09-01 12:00:00 -0500"/>';
	const dates = [
		"<ExportDate value='2026-09-01 12:00:00 -0500'/>",
		'<ExportDate value =\n "2026-09-01 12:00:00 -0500"/>',
	];
	await Promise.all(
		dates.map((date) =>
			withImportDir({}, async (dir) => {
				await writeAged(
					join(dir, "old", "export.xml"),
					exportTakenOn("2025-01-01"),
					0,
				);
				await writeAged(
					join(dir, "new", "export.xml"),
					exportTakenOn("2026-09-01").replace(stated, date),
					86_400_000,
				);
				const result = await run(dir);
				assert.deepEqual(
					recordsOf(result, "activity").map((r) => r.exported_at),
					["2026-09-01T17:00:00.000Z"],
					date,
				);
			}),
		),
	);
});

test("an archive this reader cannot open tells the owner to unzip it, if the XML inside is under 8 GB", async () => {
	// One with an entry in the zip64 format, and one whose end record gives
	// its directory's size and offset as zip64 placeholders, which point past
	// that record without the archive being damaged.
	const zip64Entry = buildZip([
		{
			name: "apple_health_export/export.xml",
			data: exportTakenOn("2026-09-01"),
			zip64Sizes: true,
		},
	]);
	const zip64Directory = buildZip([
		{
			name: "apple_health_export/export.xml",
			data: exportTakenOn("2026-09-01"),
		},
	]);
	zip64Directory.writeUInt32LE(0xff_ff_ff_ff, zip64Directory.length - 22 + 12);
	zip64Directory.writeUInt32LE(0xff_ff_ff_ff, zip64Directory.length - 22 + 16);
	await Promise.all(
		[zip64Entry, zip64Directory].map((zip) =>
			withImportDir({}, async (dir) => {
				await writeAged(join(dir, "export.zip"), zip, 0);
				const result = await run(dir);
				const receipts = recordsOf(result, "coverage_diagnostics");
				assert.equal(receipts.length, DATA_STREAMS.length);
				for (const r of receipts) {
					assert.equal(r.reason, "export_extraction_failed");
				}
				const [skip] = messagesOf(result, "SKIP_RESULT");
				assert.equal(skip?.reason, "export_extraction_failed");
				assert.match(
					String(skip?.message),
					/is under 8 GB, unzip it on your computer and upload that XML instead/,
				);
			}),
		),
	);
});

test("a clean export beside a newer .zip refused for its size is imported, and every receipt says so", async () => {
	// The .zip may hold a newer export, so the owner is told. The remedy it is
	// given, uploading the XML inside it, leaves that XML beside it with an
	// older file time, and the notice then stays until the .zip is removed.
	const zip = buildZip([
		{
			name: "apple_health_export/export.xml",
			data: exportTakenOn("2026-09-01"),
			zip64Sizes: true,
		},
	]);
	const cases = [
		{ day: "2025-09-01", path: "export.xml" },
		{ day: "2026-09-01", path: join("apple_health_export", "export.xml") },
	];
	await Promise.all(
		cases.map((c) =>
			withImportDir({}, async (dir) => {
				await writeAged(join(dir, "export.zip"), zip, 0);
				await writeAged(join(dir, c.path), exportTakenOn(c.day), 86_400_000);
				const result = await run(dir);
				assert.deepEqual(
					recordsOf(result, "activity").map((r) => r.exported_at),
					[`${c.day}T17:00:00.000Z`],
					c.path,
				);
				assert.deepEqual(messagesOf(result, "SKIP_RESULT"), []);
				const receipts = recordsOf(result, "coverage_diagnostics");
				assert.equal(receipts.length, DATA_STREAMS.length);
				for (const r of receipts) {
					assert.equal(r.reason, "newer_upload_too_large", String(r.stream));
					assert.equal(
						r.status,
						r.stream === "activity" ? "partial" : "empty",
						String(r.stream),
					);
				}
				const progress = messagesOf(result, "PROGRESS")
					.map((m) => String(m.message))
					.join("\n");
				assert.match(progress, /a newer upload could not be opened: .*zip64/);
			}),
		),
	);
});

test("beside a newer .zip refused for its size, a stream with worse news keeps its own reason", async () => {
	// The notice stands in for covered_in_full and nothing_in_range only:
	// over collection_interrupted, records_unreadable or window_unavailable
	// it would hide what the owner needs to know of the export that was read.
	const zip = buildZip([
		{
			name: "apple_health_export/export.xml",
			data: exportTakenOn("2026-09-01"),
			zip64Sizes: true,
		},
	]);
	const older = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2025-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2025-09-01 08:00:00 -0500" endDate="2025-09-01 08:05:00 -0500" value="5"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="not a date" endDate="2025-09-01 08:05:00 -0500" value="6"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" startDate="2025-09-01 23:00:00 -0500" endDate="2025-09-02 06:00:00 -0500" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2025-09-01 10:00:00 -0500" endDate="2025-09-01 10:00:00 -0500" value="61"/>
</HealthData>
`;
	const cases = [
		{
			xml: older,
			reasons: {
				activity: "records_unreadable",
				sleep: "window_unavailable",
				vital_signs: "newer_upload_too_large",
				mobility: "newer_upload_too_large",
				workouts: "newer_upload_too_large",
			},
		},
		{
			xml: older.slice(0, older.indexOf("</HealthData>")),
			reasons: {
				activity: "collection_interrupted",
				sleep: "collection_interrupted",
				vital_signs: "collection_interrupted",
				mobility: "collection_interrupted",
				workouts: "collection_interrupted",
			},
		},
	];
	await Promise.all(
		cases.map((c) =>
			withImportDir({}, async (dir) => {
				await writeAged(join(dir, "export.zip"), zip, 0);
				await writeAged(join(dir, "export.xml"), c.xml, 86_400_000);
				const result = await run(dir, {
					ranges: { sleep: { since: "2025-01-01T00:00:00.000Z" } },
				});
				assert.equal(readingsOf(result).length, 3);
				for (const [stream, reason] of Object.entries(c.reasons)) {
					assert.equal(receiptOf(result, stream)?.reason, reason, stream);
				}
				const progress = messagesOf(result, "PROGRESS")
					.map((m) => String(m.message))
					.join("\n");
				assert.match(progress, /a newer upload could not be opened: .*zip64/);
			}),
		),
	);
});

test("a newer upload that cannot be read is reported, and nothing older is imported in its place", async () => {
	const zip = buildZip([
		{
			name: "apple_health_export/export.xml",
			data: exportTakenOn("2026-09-01"),
		},
	]);
	// One cut short before its central directory, and one whose end record
	// places the directory past itself, which no archive of any size does,
	// without and with an archive comment after that record.
	const overrun = Buffer.from(zip);
	overrun.writeUInt32LE(64 * 1_048_576, overrun.length - 22 + 12);
	const comment = Buffer.from("written by an archiver that signs its work");
	const commented = Buffer.concat([overrun, comment]);
	commented.writeUInt16LE(comment.length, overrun.length - 22 + 20);
	await Promise.all(
		[zip.subarray(0, zip.length - 30), overrun, commented].map((upload) =>
			withImportDir({}, async (dir) => {
				await writeAged(
					join(dir, "art-old", "export.xml"),
					exportTakenOn("2025-09-01"),
					3_600_000,
				);
				await writeAged(join(dir, "art-new", "export.zip"), upload, 0);
				const result = await run(dir);
				assert.deepEqual(readingsOf(result), []);
				for (const r of recordsOf(result, "coverage_diagnostics")) {
					assert.equal(r.reason, "export_extraction_failed");
				}
				const [skip] = messagesOf(result, "SKIP_RESULT");
				assert.equal(skip?.reason, "export_extraction_failed");
				assert.match(
					String(skip?.message),
					/could not be opened as an archive/,
				);
			}),
		),
	);
});

test("a directory that cannot be listed is named on a progress line", {
	skip: process.getuid?.() === 0 && "root lists a directory whatever its mode",
}, async () => {
	await withImportDir(
		{ "export.xml": exportTakenOn("2026-09-01") },
		async (dir) => {
			await mkdir(join(dir, "locked"));
			await chmod(join(dir, "locked"), 0o000);
			try {
				const result = await run(dir);
				assert.equal(readingsOf(result).length, 1);
				const lines = messagesOf(result, "PROGRESS").map((m) =>
					String(m.message),
				);
				assert.ok(
					lines.some(
						(line) =>
							line.includes("could not be read") &&
							line.includes(join(dir, "locked")),
					),
					lines.join("\n"),
				);
			} finally {
				await chmod(join(dir, "locked"), 0o755);
			}
		},
	);
});

test("an import folder that cannot be read says so, not that nothing was uploaded", {
	skip: process.getuid?.() === 0 && "root lists a directory whatever its mode",
}, async () => {
	await withImportDir(
		{ "export.xml": exportTakenOn("2026-09-01") },
		async (dir) => {
			await chmod(dir, 0o000);
			try {
				const result = await run(dir);
				const [skip] = messagesOf(result, "SKIP_RESULT");
				assert.equal(skip?.reason, "export_extraction_failed");
				assert.match(String(skip?.message), /could not be read/);
				assert.doesNotMatch(String(skip?.message), /uploaded yet/);
				for (const r of recordsOf(result, "coverage_diagnostics")) {
					assert.equal(r.reason, "export_extraction_failed");
				}
			} finally {
				await chmod(dir, 0o755);
			}
		},
	);
});

test("a folder among the uploads that cannot be read is named beside what was found, never as the import folder", {
	skip: process.getuid?.() === 0 && "root lists a directory whatever its mode",
}, async () => {
	// Shaped like a filesystem's lost+found: a folder in the import folder
	// that the connector cannot list, alone or beside an upload that is not
	// an export.
	const cases = [
		{
			files: {},
			reason: "awaiting_upload",
			message:
				/^No Apple Health export was found, and some folders among your uploads could not be read\./,
		},
		{
			files: {
				"export_cda.xml":
					'<?xml version="1.0"?>\n<ClinicalDocument xmlns="urn:hl7-org:v3"/>\n',
			},
			reason: "source_unreadable",
			message:
				/^That file isn't an Apple Health export we can read\..* Some folders among your uploads could not be read\.$/,
		},
	];
	await Promise.all(
		cases.map((c) =>
			withImportDir(c.files, async (dir) => {
				await mkdir(join(dir, "lost+found"));
				await chmod(join(dir, "lost+found"), 0o000);
				try {
					const result = await run(dir);
					const [skip] = messagesOf(result, "SKIP_RESULT");
					assert.equal(skip?.reason, c.reason);
					assert.match(String(skip?.message), c.message);
					assert.doesNotMatch(
						String(skip?.message),
						/folder holding your uploads/,
					);
					for (const r of recordsOf(result, "coverage_diagnostics")) {
						assert.equal(r.reason, c.reason);
					}
				} finally {
					await chmod(join(dir, "lost+found"), 0o755);
				}
			}),
		),
	);
});

test("no export uploaded yet is a waiting state with a receipt, not a silent nothing", async () => {
	// The likeliest first-run state, and the one most likely to be seen by a
	// person. It is also the exit path most likely to have no test.
	await withImportDir({}, async (dir) => {
		const result = await run(dir);
		assert.equal(readingsOf(result).length, 0);
		const receipts = recordsOf(result, "coverage_diagnostics");
		assert.equal(
			receipts.length,
			DATA_STREAMS.length,
			"a receipt must exist precisely when there are no records to carry one",
		);
		for (const r of receipts) {
			assert.equal(r.reason, "awaiting_upload");
			assert.equal(r.status, "empty");
		}
		const skips = messagesOf(result, "SKIP_RESULT");
		assert.equal(
			skips.length,
			1,
			"one skip for the import, not one per stream",
		);
		assert.equal(skips[0]?.reason, "awaiting_upload");
		assert.equal(skips[0]?.stream, "activity", "the first requested stream");

		// The skip names a stream the host asked for.
		const sleepOnly = await run(dir, {
			streams: ["sleep", "coverage_diagnostics"],
		});
		assert.equal(messagesOf(sleepOnly, "SKIP_RESULT")[0]?.stream, "sleep");
		assert.deepEqual(
			recordsOf(sleepOnly, "coverage_diagnostics").map((r) => r.stream),
			["sleep"],
		);
	});
});

test("a second import of the same archive re-sends the same ids, so a repeat is an upsert", async () => {
	await withImportDir({ "export.xml": EXPORT_XML }, async (dir) => {
		const first = await run(dir);
		assert.ok(readingIdsOf(first).length > 0);
		assert.equal(
			messagesOf(first, "STATE").length,
			0,
			"no cursor is saved, so none can exclude a record later",
		);

		// Even a cursor version 0.1.0 saved, dated after every record in the
		// archive, excludes nothing.
		const second = await run(dir, {
			state: staleCursor("2030-01-01T00:00:00.000Z"),
		});
		for (const stream of DATA_STREAMS) {
			assert.deepEqual(
				idsOf(second, stream),
				idsOf(first, stream),
				`${stream}: the same archive re-sends the same ids`,
			);
		}
		assert.equal(readingIdsOf(second).length, 4);
		for (const stream of ["activity", "vital_signs", "sleep", "workouts"]) {
			assert.equal(receiptOf(second, stream)?.reason, "covered_in_full");
		}
	});
});

test("full_refresh and incremental emit the same records", async () => {
	// There is no cursor, so the collection mode changes nothing about what is
	// emitted. An edit in Health reaches a reader either way, as a new record.
	await withImportDir({ "export.xml": EXPORT_XML }, async (dir) => {
		const incremental = await run(dir, {
			state: staleCursor("2024-06-05T13:00:00.000Z"),
		});
		const refreshed = await run(dir, {
			fullRefresh: true,
			state: staleCursor("2024-06-05T13:00:00.000Z"),
		});
		for (const stream of DATA_STREAMS) {
			assert.deepEqual(idsOf(refreshed, stream), idsOf(incremental, stream));
		}
		for (const stream of ["activity", "vital_signs", "sleep", "workouts"]) {
			assert.ok(idsOf(incremental, stream).length > 0, stream);
		}
	});
});

test("a later, larger export delivers late-synced and backfilled records", async () => {
	// A cursor on start_date would drop both: a watch reading synced late sits
	// AT the instant an earlier import already reached, and a backfilled
	// reading sits BEFORE it. Apple exports are not ordered by start date and
	// Health accepts samples dated in the past, so neither is unusual.
	const head = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
`;
	const steps =
		' <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2026-08-30 10:00:00 -0500" endDate="2026-08-30 10:05:00 -0500" value="500"/>\n';
	const first = `${head}${steps}</HealthData>\n`;
	const superset = `${head}${steps} <Record type="HKQuantityTypeIdentifierHeartRate" device="&lt;&lt;HKDevice: 0x2&gt;, name:Apple Watch&gt;" unit="count/min" startDate="2026-08-30 10:00:00 -0500" endDate="2026-08-30 10:00:00 -0500" value="70"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="2026-08-30 09:00:00 -0500" endDate="2026-08-30 09:00:00 -0500" value="80"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2026-08-31 10:00:00 -0500" endDate="2026-08-31 10:05:00 -0500" value="600"/>
</HealthData>
`;
	await withImportDir({ "export.xml": first }, async (dir) => {
		const one = await run(dir);
		assert.equal(readingsOf(one).length, 1);
		await withImportDir({ "export.xml": superset }, async (dir2) => {
			// The instant the first import reached, as a start_date cursor would
			// have saved it.
			const two = await run(dir2, {
				state: staleCursor("2026-08-30T15:00:00.000Z"),
			});
			const types = readingsOf(two)
				.map((r) => `${String(r.type)}@${String(r.start_date)}`)
				.sort();
			assert.deepEqual(types, [
				"BodyMass@2026-08-30T14:00:00.000Z",
				"HeartRate@2026-08-30T15:00:00.000Z",
				"StepCount@2026-08-30T15:00:00.000Z",
				"StepCount@2026-08-31T15:00:00.000Z",
			]);
			assert.ok(
				readingIdsOf(two).includes(readingIdsOf(one)[0] as string),
				"the record both exports share arrives under its original id",
			);
		});
	});
});

test("the requested time range bounds what is emitted and what the receipt counts", async () => {
	await withImportDir({ "export.xml": EXPORT_XML }, async (dir) => {
		// The 5 June records only; the 6 June sleep stages fall outside.
		// `until` is exclusive and both bounds truncate to a date prefix, matching
		// isOutsideTimeRange in connector-runtime.ts.
		const result = await run(dir, {
			timeRange: {
				since: "2024-06-05T00:00:00.000Z",
				until: "2024-06-06T00:00:00.000Z",
			},
		});
		const records = readingsOf(result);
		assert.equal(records.length, 2, "only the 5 June records are in range");
		for (const r of records) {
			assert.ok((r.start_date as string) < "2024-06-06T00:00:00.000Z");
		}
		// Coverage counts what the runtime kept, not what the parser produced.
		assert.equal(receiptOf(result, "activity")?.record_count, 1);
		assert.equal(receiptOf(result, "vital_signs")?.record_count, 1);
		// Both sleep stages fall outside, after the window: the export's sleep
		// does not reach back to it.
		const sleep = receiptOf(result, "sleep");
		assert.equal(sleep?.record_count, 0);
		assert.equal(sleep?.reason, "window_unavailable");
	});
});

test("a window the export reaches back to is not reported as unavailable", async () => {
	// The export holds records from 2019 and 2024. Asked from 2024, the data
	// reaches back further than that, so the window is covered in full even
	// though the earliest EMITTED record starts months after the window does.
	// Asked from 2015, the data does not reach back, and the receipt says so.
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2019-03-01 08:00:00 -0500" endDate="2019-03-01 08:05:00 -0500" value="1"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="2"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const recent = await run(dir, {
			timeRange: { since: "2024-01-01T00:00:00Z" },
		});
		assert.equal(recordsOf(recent, "activity").length, 1);
		const inside = receiptOf(recent, "activity");
		assert.equal(inside?.reason, "covered_in_full");
		assert.equal(inside?.status, "complete");

		const early = await run(dir, {
			timeRange: { since: "2015-01-01T00:00:00Z" },
		});
		assert.equal(recordsOf(early, "activity").length, 2);
		const before = receiptOf(early, "activity");
		assert.equal(before?.reason, "window_unavailable");
		assert.equal(before?.status, "partial");

		// The runtime truncates the bound to its date, so a window asked from
		// 12:00 on the day the export starts is applied from that day's
		// midnight and the export does reach it: the 08:00 local (13:00 UTC)
		// record on 2019-03-01 is on the window's first day.
		const sameDay = await run(dir, {
			timeRange: { since: "2019-03-01T12:00:00Z" },
		});
		assert.equal(recordsOf(sameDay, "activity").length, 2);
		const onFirstDay = receiptOf(sameDay, "activity");
		assert.equal(onFirstDay?.reason, "covered_in_full");
	});
});

test("a window wholly before the export is reported as unavailable, even beside a newer .zip refused for its size", async () => {
	// Nothing is emitted, but the export is known not to reach back to the
	// window: that, not nothing_in_range, is what the owner needs to know,
	// and it is the stream's own news, which the notice never replaces.
	const zip = buildZip([
		{
			name: "apple_health_export/export.xml",
			data: exportTakenOn("2026-09-01"),
			zip64Sizes: true,
		},
	]);
	await Promise.all(
		[false, true].map((newer) =>
			withImportDir({}, async (dir) => {
				await writeAged(
					join(dir, "export.xml"),
					exportTakenOn("2024-06-05"),
					86_400_000,
				);
				if (newer) {
					await writeAged(join(dir, "export.zip"), zip, 0);
				}
				const result = await run(dir, {
					timeRange: {
						since: "2020-01-01T00:00:00.000Z",
						until: "2022-01-01T00:00:00.000Z",
					},
				});
				const label = newer ? "beside a newer .zip" : "alone";
				assert.deepEqual(readingsOf(result), [], label);
				const activity = receiptOf(result, "activity");
				assert.equal(activity?.reason, "window_unavailable", label);
				assert.equal(activity?.status, "empty", label);
				// A stream with nothing in the export has no start to judge by.
				assert.equal(
					receiptOf(result, "sleep")?.reason,
					newer ? "newer_upload_too_large" : "nothing_in_range",
					label,
				);
			}),
		),
	);
});

test("a date-only window still yields a valid receipt", async () => {
	// The protocol allows a bare date. The receipt's window fields are
	// date-times, and a receipt that fails its own schema is dropped by the
	// runtime, so a bare date passed through would cost the owner the receipt.
	await withImportDir({ "export.xml": EXPORT_XML }, async (dir) => {
		const result = await run(dir, {
			timeRange: { since: "2024-06-05", until: "2024-06-06" },
		});
		assert.equal(readingsOf(result).length, 2);
		const receipt = receiptOf(result, "activity");
		assert.ok(receipt, "the receipt must survive a date-only window");
		assert.equal(receipt.window_requested_from, "2024-06-05T00:00:00.000Z");
		assert.equal(receipt.window_requested_to, "2024-06-06T00:00:00.000Z");
		assert.equal(validateRecord("coverage_diagnostics", receipt).ok, true);
		assert.equal(receipt.record_count, 1);
	});
});

test("a window that ends before the export was taken still yields every receipt", async () => {
	// The receipts describe the import. The export is dated 2026; a window over
	// 2024 applied to the receipts' exported_at would drop all of them.
	const window = {
		since: "2024-01-01T00:00:00.000Z",
		until: "2025-01-01T00:00:00.000Z",
	};
	await withImportDir({ "export.xml": EXPORT_XML }, async (dir) => {
		const result = await run(dir, {
			timeRange: window,
			ranges: { workouts: window, coverage_diagnostics: window },
		});
		assert.equal(readingsOf(result).length, 4);
		assert.equal(recordsOf(result, "workouts").length, 1);
		const receipts = recordsOf(result, "coverage_diagnostics");
		assert.deepEqual(
			receipts.map((r) => r.stream),
			DATA_STREAMS,
			"one receipt per data stream, whatever window the receipts were asked for",
		);
		for (const r of receipts) {
			assert.equal(r.exported_at, "2026-09-01T17:00:00.000Z");
		}
	});
});

test("a receipt describes only the records the reader received", async () => {
	// Two identical unitless readings and a workout whose marker list is cut
	// and whose event has no unit, all in 2019; a unit-bearing reading and a
	// clean workout in 2024. Asked from 2020, the reader receives only the
	// 2024 records, so nothing about the 2019 ones may reach the receipt: no
	// "unit", no "events", and no duplicate.
	const events: string[] = [];
	for (let i = 0; i < 501; i += 1) {
		events.push(
			'  <WorkoutEvent type="HKWorkoutEventTypeSegment" date="2019-03-01 07:10:00 -0500" duration="1"/>',
		);
	}
	const glucose =
		' <Record type="HKQuantityTypeIdentifierBloodGlucose" startDate="2019-03-01 08:00:00 -0500" endDate="2019-03-01 08:00:00 -0500" value="120"/>';
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
${glucose}
${glucose}
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2019-03-01 07:00:00 -0500" endDate="2019-03-01 07:30:00 -0500">
${events.join("\n")}
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="20" durationUnit="min" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:20:00 -0500"/>
</HealthData>
`;
	const window = { since: "2020-01-01T00:00:00.000Z" };
	const receiptsOf = (result: { messages?: unknown[] }) => {
		const lab = receiptOf(result, "lab_results");
		const act = receiptOf(result, "activity");
		const wk = receiptOf(result, "workouts");
		assert.ok(lab && act && wk);
		return {
			lab,
			act,
			wk,
			labFields: lab.fields_unavailable as string[],
			wkFields: wk.fields_unavailable as string[],
		};
	};
	await withImportDir({ "export.xml": xml }, async (dir) => {
		// The control: with no window, every gap is real and is reported.
		const whole = receiptsOf(await run(dir));
		assert.ok(whole.labFields.includes("unit"));
		assert.equal(whole.lab.duplicates_discarded, 1);
		assert.ok(whole.wkFields.includes("events"));

		const windowed = await run(dir, {
			timeRange: window,
			ranges: { workouts: window },
		});
		assert.equal(readingsOf(windowed).length, 1);
		assert.equal(recordsOf(windowed, "workouts").length, 1);
		const inWindow = receiptsOf(windowed);
		assert.ok(
			!inWindow.labFields.includes("unit"),
			"a unitless reading outside the window must not disown unit",
		);
		assert.equal(inWindow.lab.duplicates_discarded, 0);
		assert.ok(
			!inWindow.wkFields.includes("events"),
			"a cut marker list outside the window must not disown events",
		);
		assert.equal(
			inWindow.lab.reason,
			"nothing_in_range",
			"gaps in readings the reader never received leave the receipt clean",
		);

		// The same holds for a resource list: records the host did not ask for
		// are not the reader's, whatever the window.
		const stepId = recordsOf(windowed, "activity")[0]?.id as string;
		const asked = receiptsOf(await run(dir, { resources: [stepId] }));
		assert.equal(asked.act.record_count, 1);
		assert.equal(asked.lab.record_count, 0);
		assert.ok(!asked.labFields.includes("unit"));
		assert.equal(asked.lab.duplicates_discarded, 0);
	});
});

test("a blank value is published as absent and named on the receipt", async () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:00:00 -0500" value=""/>
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="2024-06-06 08:00:00 -0500" endDate="2024-06-06 08:00:00 -0500" value="80"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const values = recordsOf(result, "body_measurements")
			.map((r) => r.value)
			.sort();
		assert.deepEqual(values, [80, null], "a blank value must not become 0");
		const receipt = receiptOf(result, "body_measurements");
		assert.ok(receipt);
		assert.ok((receipt.fields_unavailable as string[]).includes("value"));
		const progress = messagesOf(result, "PROGRESS")
			.map((m) => String(m.message))
			.join("\n");
		assert.match(progress, /empty_values=1/);
	});
});

test("an element carrying an invalid character reference is counted as unreadable, and the run completes", async () => {
	// &#x110000; is past the last Unicode code point. String.fromCodePoint
	// throws on it, which inside the scanner would end the run with no receipt.
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
 <Record type="HKQuantityTypeIdentifierStepCount" device="bad &#x110000; ref" unit="count" startDate="2024-06-04 09:00:00 -0500" endDate="2024-06-04 09:05:00 -0500" value="130">
  <MetadataEntry key="HKWasUserEntered" value="1"/>
 </Record>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 10:00:00 -0500" endDate="2024-06-05 10:05:00 -0500" value="140"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500">
  <WorkoutEvent type="HKWorkoutEventTypePause" date="2024-06-05 07:05:00 -0500" note="&#xD800;"/>
  <WorkoutEvent type="HKWorkoutEventTypeResume" date="2024-06-05 07:06:00 -0500"/>
 </Workout>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const done = messagesOf(result, "DONE")[0];
		assert.equal(done?.status, "succeeded", "the run must complete");
		assert.deepEqual(
			recordsOf(result, "activity")
				.map((r) => r.value)
				.sort(),
			[120, 140],
		);
		const rc = receiptOf(result, "activity");
		const wk = receiptOf(result, "workouts");
		assert.ok(rc && wk);
		assert.equal(rc.reason, "records_unreadable");
		assert.equal(rc.records_skipped_unreadable, 1);
		const [w] = recordsOf(result, "workouts");
		assert.ok(w);
		assert.equal((w.events as unknown[]).length, 1, "only the readable marker");
		assert.ok((wk.fields_unavailable as string[]).includes("events"));
		const progress = messagesOf(result, "PROGRESS")
			.map((m) => String(m.message))
			.join("\n");
		assert.match(progress, /malformed_elements_skipped=2/);

		// Held to the same scope test as any record: outside the window, the
		// undecodable record costs the receipt nothing.
		const later = await run(dir, {
			timeRange: { since: "2024-06-05T00:00:00.000Z" },
		});
		const laterRc = receiptOf(later, "activity");
		assert.equal(recordsOf(later, "activity").length, 2);
		assert.equal(laterRc?.reason, "covered_in_full");
		assert.equal(laterRc?.records_skipped_unreadable, 0);
	});
});

test("the local offset survives so a reader can render the owner's wall clock", async () => {
	await withImportDir({ "export.xml": EXPORT_XML }, async (dir) => {
		const result = await run(dir);
		const [sleep] = recordsOf(result, "sleep");
		assert.ok(sleep);
		// Recorded at 23:00 local on a -0500 offset. The instant is 04:00Z the
		// next day; without the offset a reader would render it as the wrong day.
		assert.equal(sleep.start_date, "2024-06-07T04:00:00.000Z");
		assert.equal(sleep.start_utc_offset_minutes, -300);
	});
});

// ─── Truncation, memory and identity ───────────────────────────────────

/** A truncated archive: cut off mid-Workout, so the document never closes. */
const TRUNCATED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2024-06-05 09:00:00 -0500" endDate="2024-06-05 09:05:00 -0500" value="240"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500">
  <MetadataEntry key="HKIndoorWorkout" value="0"/>`;

test("a truncated archive reports interruption, and a re-import re-sends its readable prefix", async () => {
	// Records are emitted as they are parsed, so the readable prefix reaches the
	// reader before the cut is detected. Re-importing the same file re-sends
	// it under the same ids: an upsert, not a duplicate.
	await withImportDir({ "export.xml": TRUNCATED_XML }, async (dir) => {
		const first = await run(dir);
		assert.equal(
			recordsOf(first, "activity").length,
			2,
			"the readable prefix is emitted before truncation is detected",
		);

		const receipts = recordsOf(first, "coverage_diagnostics");
		assert.ok(
			receipts.some((r) => r.reason === "collection_interrupted"),
			"the owner must be told the archive was cut short",
		);
		assert.equal(messagesOf(first, "STATE").length, 0);

		const second = await run(dir);
		assert.deepEqual(idsOf(second, "activity"), idsOf(first, "activity"));
	});
});

/**
 * A complete document, cut at the three places where no Record or Workout span
 * is open, so an open-element check alone cannot see the cut.
 */
const CUT_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 09:00:00 -0500" endDate="2024-06-05 09:05:00 -0500" value="240"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2024-06-05 10:00:00 -0500" endDate="2024-06-05 10:00:00 -0500" value="61"/>
</HealthData>
`;
const THIRD_RECORD_AT = CUT_SOURCE.indexOf(
	'<Record type="HKQuantityTypeIdentifierHeartRate"',
);
const CUTS: ReadonlyArray<{ label: string; xml: string; emitted: number }> = [
	{
		label: "inside a self-closing Record",
		xml: CUT_SOURCE.slice(0, THIRD_RECORD_AT + 60),
		emitted: 2,
	},
	{
		label: "between elements, at the start of the next tag",
		xml: CUT_SOURCE.slice(0, THIRD_RECORD_AT + 1),
		emitted: 2,
	},
	{
		label: "after the last complete element, before </HealthData>",
		xml: CUT_SOURCE.slice(0, CUT_SOURCE.indexOf("</HealthData>")),
		emitted: 3,
	},
];

for (const cut of CUTS) {
	test(`a file cut ${cut.label} is reported as interrupted on every receipt`, async () => {
		assert.ok(!cut.xml.includes("</HealthData>"));
		await withImportDir({ "export.xml": cut.xml }, async (dir) => {
			const result = await run(dir);
			assert.equal(readingsOf(result).length, cut.emitted);
			const receipts = recordsOf(result, "coverage_diagnostics");
			assert.equal(receipts.length, DATA_STREAMS.length);
			for (const r of receipts) {
				assert.equal(
					r.reason,
					"collection_interrupted",
					`${String(r.stream)} must not claim full coverage of a cut file`,
				);
				assert.notEqual(r.status, "complete");
			}
		});
	});
}

test("a complete archive after a truncated one still delivers tail records dated earlier than the cut", async () => {
	// Apple exports are not ordered by start date. A cursor at the newest record
	// emitted before the cut (09:00 local) would discard the complete archive's
	// tail records dated 06:00 and 08:30, permanently.
	const complete = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2024-06-05 09:00:00 -0500" endDate="2024-06-05 09:05:00 -0500" value="240"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500">
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
 </Workout>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2024-06-05 06:00:00 -0500" endDate="2024-06-05 06:05:00 -0500" value="10"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2024-06-05 08:30:00 -0500" endDate="2024-06-05 08:35:00 -0500" value="55"/>
</HealthData>
`;
	await withImportDir({ "export.xml": TRUNCATED_XML }, async (dir) => {
		const first = await run(dir);
		assert.equal(recordsOf(first, "activity").length, 2);

		// The owner takes a fresh, complete export. Its unread tail includes
		// records dated 06:00 and 08:30, both EARLIER than the 09:00 record the
		// truncated run had already emitted. The state is what an advancing
		// cursor would have saved at 09:00 local.
		await withImportDir({ "export.xml": complete }, async (dir2) => {
			const second = await run(dir2, {
				state: staleCursor("2024-06-05T14:00:00.000Z"),
			});
			const starts = recordsOf(second, "activity").map(
				(r) => r.start_date as string,
			);
			assert.ok(
				starts.includes("2024-06-05T11:00:00.000Z"),
				"the 06:00 local tail record must be delivered",
			);
			assert.ok(
				starts.includes("2024-06-05T13:30:00.000Z"),
				"the 08:30 local tail record must be delivered",
			);
		});
	});
});

/** A workout carrying a long GPS route: many elements the scanner never matches. */
function routeExport(locations: number): string {
	const points: string[] = [];
	for (let i = 0; i < locations; i += 1) {
		points.push(
			`  <Location date="2024-06-05 06:${String(i % 60).padStart(2, "0")}:00 -0500" latitude="51.5${i}" longitude="-0.12${i}" altitude="12.5" course="180.0" speed="3.1" horizontalAccuracy="4.0" verticalAccuracy="6.0"/>`,
		);
	}
	return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="90" durationUnit="min" totalDistance="40" totalDistanceUnit="km" startDate="2024-06-05 06:00:00 -0500" endDate="2024-06-05 07:30:00 -0500">
  <WorkoutRoute sourceName="Apple Watch" startDate="2024-06-05 06:00:00 -0500" endDate="2024-06-05 07:30:00 -0500">
${points.join("\n")}
  </WorkoutRoute>
 </Workout>
</HealthData>
`;
}

test("a long GPS route parses within the streaming memory bound and emits no coordinate", {
	timeout: 240_000,
}, async () => {
	// The scanner trims its buffer to the last '<'. Without that, a chunk with
	// no matching tag would stay whole in the buffer, and a route is a long run
	// of <Location> elements the scanner never matches, so a long route would
	// accumulate in memory until the workout closed.
	//
	// Checking only that the workout parses and no coordinate is emitted would
	// pass either way, since a scanner that accumulates the route still parses
	// it correctly. So this measures peak RSS on a route large enough that
	// accumulating it as a string breaches the bound.
	const points = 600_000; // ~90 MB of XML; held as a JS string that is ~180 MB
	const xml = routeExport(points);
	assert.ok(xml.length > 80_000_000, `fixture ${xml.length} bytes`);
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir, { peakRssPollIntervalMs: 200 });
		const workouts = recordsOf(result, "workouts");
		assert.equal(workouts.length, 1, "the workout must still parse");
		assert.equal(workouts[0]?.total_distance_km, 40);

		assert.ok(result.peakRssBytes !== null, "expected a sampled peak RSS");
		// Same bound the format-conformance memory test uses. A scanner that
		// holds the route would sit well above it.
		assert.ok(
			(result.peakRssBytes ?? 0) < 300 * 1024 * 1024,
			`peak RSS ${Math.round((result.peakRssBytes ?? 0) / 1024 / 1024)}MB exceeded the streaming bound`,
		);

		const emitted = JSON.stringify([
			...readingsOf(result),
			...workouts,
			...recordsOf(result, "coverage_diagnostics"),
		]);
		assert.ok(
			!emitted.includes("latitude") && !emitted.includes("51.5"),
			"no GPS coordinate may be emitted",
		);
	});
});

test("the receipt does not count records the host did not ask for", async () => {
	// The runtime drops records outside scope.resources inside emitRecord,
	// after the connector has decided whether to count them. Asking for one of
	// the two sleep stages must yield a receipt that says one, not two.
	await withImportDir({ "export.xml": EXPORT_XML }, async (dir) => {
		const all = await run(dir);
		const ids = recordsOf(all, "sleep").map((r) => r.id as string);
		assert.equal(ids.length, 2);

		const one = await run(dir, { resources: [ids[0] as string] });
		assert.equal(readingsOf(one).length, 1);
		assert.equal(
			receiptOf(one, "sleep")?.record_count,
			1,
			"the receipt must count what the runtime kept, not what was parsed",
		);
		assert.equal(receiptOf(one, "activity")?.record_count, 0);
	});
});

test("identity is derived only from fields a reader can already see", async () => {
	// The id is a content hash over published inputs only. With sourceName in
	// the hash but withheld from the record, a reader could hash candidate
	// device names against the published id until one matched. Two records
	// differing ONLY in sourceName must therefore share an id.
	const base =
		'type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"';
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record sourceName="Sam's iPhone" ${base}/>
 <Record sourceName="A Completely Different Name" ${base}/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const records = recordsOf(result, "activity");
		// Same id, so the second is suppressed as an exact duplicate. The point
		// is not the suppression: it is that sourceName cannot be recovered from
		// the id, because it did not contribute to it.
		assert.equal(
			records.length,
			1,
			"records differing only by a withheld field must not have distinct ids",
		);
		assert.equal(receiptOf(result, "activity")?.duplicates_discarded, 1);
	});
});

test("two watches sharing a source name but not a device get distinct ids", async () => {
	// With sourceName out of the hash, the published device is what tells two
	// watches apart, and it must actually do so.
	const base =
		'type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:00:01 -0500" value="72"';
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record device="&lt;&lt;HKDevice: 0x1&gt;, name:Apple Watch, model:Watch7,1&gt;" ${base}/>
 <Record device="&lt;&lt;HKDevice: 0x2&gt;, name:Apple Watch, model:Watch6,2&gt;" ${base}/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const records = recordsOf(result, "vital_signs");
		assert.equal(records.length, 2, "different hardware is two observations");
		assert.notEqual(records[0]?.id, records[1]?.id);
	});
});

test("a workout's duration unit participates in its identity", async () => {
	// Hashing the raw duration without its unit would give duration="1" min
	// and duration="1" h the same id, and one of two real workouts would be
	// dropped.
	const base =
		'workoutActivityType="HKWorkoutActivityTypeRunning" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500" duration="1"';
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Workout durationUnit="min" ${base}/>
 <Workout durationUnit="hr" ${base}/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const workouts = recordsOf(result, "workouts");
		assert.equal(workouts.length, 2);
		const minutes = workouts.map((w) => w.duration_minutes).sort();
		assert.deepEqual(minutes, [1, 60]);
		assert.notEqual(workouts[0]?.id, workouts[1]?.id);
	});
});

// ─── Identity serialisation and oversized elements ─────────────────────

test("a workout keeps its id whichever way an export states its totals", async () => {
	// An older export states a workout's totals as its own attributes, a newer
	// one as statistics, and the figures differ slightly or are missing. In
	// the id, they would give one unchanged workout a new id per export, and a
	// reader would keep a copy of it per representation.
	const workout = (
		totals: string,
		children: string,
	): string => `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min"${totals} startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500">${children}</Workout>
</HealthData>
`;
	const exports = [
		workout(
			' totalDistance="3.1" totalDistanceUnit="mi" totalEnergyBurned="300" totalEnergyBurnedUnit="Cal"',
			"",
		),
		workout(
			"",
			'<WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="4.99" unit="km"/><WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="301" unit="kcal"/>',
		),
		workout("", ""),
	];
	const imported = await Promise.all(
		exports.map(async (xml) => {
			let rows: Array<Record<string, unknown>> = [];
			await withImportDir({ "export.xml": xml }, async (dir) => {
				rows = recordsOf(await run(dir), "workouts");
			});
			return rows;
		}),
	);
	const seen = imported.flat();
	assert.deepEqual(
		seen.map((w) => w.total_energy_burned_kcal),
		[300, 301, null],
	);
	assert.equal(new Set(seen.map((w) => w.id)).size, 1);
});

test("identity is unambiguous when a published string contains a delimiter", async () => {
	// Joined with "|", model "D|E" with unit "U" and model "D" with unit "E|U"
	// would give the same bytes, and so the same id. JSON keeps them apart.
	const base =
		'type="HKQuantityTypeIdentifierStepCount" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"';
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record device="&lt;&lt;HKDevice: 0x1&gt;, model:D|E&gt;" unit="U" ${base}/>
 <Record device="&lt;&lt;HKDevice: 0x1&gt;, model:D&gt;" unit="E|U" ${base}/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const records = recordsOf(result, "activity");
		assert.equal(
			records.length,
			2,
			"different device and unit are two records",
		);
		assert.notEqual(records[0]?.id, records[1]?.id);
	});
});

test("an oversized record is charged to its area's receipt, and the run still completes", async () => {
	// Throwing when one element exceeds the pending ceiling would end the run
	// after a partial emit with no receipt. The format does not forbid a
	// third-party writer putting a huge value in an attribute, so this has to
	// degrade, not abort.
	const huge = "x".repeat(17 * 1024 * 1024);
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:30:00 -0500" endDate="2024-06-05 08:35:00 -0500" value="10" blob="${huge}"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 09:00:00 -0500" endDate="2024-06-05 09:05:00 -0500" value="240"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const done = messagesOf(result, "DONE")[0] as Record<string, unknown>;
		assert.equal(done?.status, "succeeded", "the run must complete, not abort");
		assert.equal(
			recordsOf(result, "activity").length,
			2,
			"records on both sides of the oversized one are delivered",
		);
		assert.equal(recordsOf(result, "workouts").length, 1);
		const rc = receiptOf(result, "activity");
		const wk = receiptOf(result, "workouts");
		assert.ok(rc && wk);
		assert.equal(rc.reason, "records_unreadable");
		assert.equal(rc.status, "partial");
		assert.ok((rc.records_skipped_unreadable as number) >= 1);
		assert.equal(
			wk.reason,
			"covered_in_full",
			"the workouts receipt must not confess to a loss it never had",
		);
	});
});

test("an oversized workout is charged to the workouts receipt, not to an area", async () => {
	// Charging every dropped element to the health records would leave the
	// workouts receipt claiming full coverage while an area receipt confessed
	// to a loss it never had.
	const huge = "x".repeat(17 * 1024 * 1024);
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="60" durationUnit="min" startDate="2024-06-06 07:00:00 -0500" endDate="2024-06-06 08:00:00 -0500" blob="${huge}"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="20" durationUnit="min" startDate="2024-06-07 07:00:00 -0500" endDate="2024-06-07 07:20:00 -0500"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		assert.equal(recordsOf(result, "workouts").length, 2);
		const rc = receiptOf(result, "activity");
		const wk = receiptOf(result, "workouts");
		assert.ok(rc && wk);
		assert.equal(wk.reason, "records_unreadable");
		assert.equal(wk.status, "partial");
		assert.ok((wk.records_skipped_unreadable as number) >= 1);
		assert.equal(rc.reason, "covered_in_full");
		assert.equal(rc.records_skipped_unreadable, 0);
	});
});

test("an oversized metadata entry under a workout costs no receipt anything", async () => {
	// Nothing published is derived from a workout's metadata, so a dropped
	// entry there is a progress-line event, not a coverage event. Both receipts
	// stay honest at covered_in_full.
	const huge = "x".repeat(17 * 1024 * 1024);
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500">
  <MetadataEntry key="ThirdPartyBlob" value="${huge}"/>
  <WorkoutEvent type="HKWorkoutEventTypePause" date="2024-06-05 07:10:00 -0500"/>
 </Workout>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const [w] = recordsOf(result, "workouts");
		assert.ok(w, "the workout survives; only its oversized child is dropped");
		assert.equal(
			(w.events as unknown[]).length,
			1,
			"the marker after it survives too",
		);
		for (const stream of ["activity", "workouts"]) {
			assert.equal(
				receiptOf(result, stream)?.reason,
				"covered_in_full",
				`${stream} lost nothing published`,
			);
		}
		for (const r of recordsOf(result, "coverage_diagnostics")) {
			assert.equal(r.records_skipped_unreadable, 0, String(r.stream));
		}
		const progress = (result.messages as Array<Record<string, unknown>>)
			.filter((m) => m.type === "PROGRESS")
			.map((m) => String(m.message));
		assert.ok(
			progress.some((m) => m.includes("oversized_elements_skipped=other:1")),
			"the drop is still visible on the progress line",
		);
	});
});

test("an oversized marker costs a receipt only when its workout reaches the reader", async () => {
	// A child dropped as oversized is held on its workout and charged with it.
	// When the host asks only for the other workout, the one that lost a
	// marker never reaches the reader, and the receipt must not disown events.
	const huge = "x".repeat(17 * 1024 * 1024);
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500">
  <WorkoutEvent type="HKWorkoutEventTypePause" date="2024-06-05 07:05:00 -0500" note="${huge}"/>
  <WorkoutEvent type="HKWorkoutEventTypeResume" date="2024-06-05 07:06:00 -0500"/>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="20" durationUnit="min" startDate="2024-06-06 07:00:00 -0500" endDate="2024-06-06 07:20:00 -0500"/>
</HealthData>
`;
	const progressOf = (result: { messages?: unknown[] }) =>
		(result.messages as Array<Record<string, unknown>>)
			.filter((m) => m.type === "PROGRESS")
			.map((m) => String(m.message))
			.join("\n");
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const all = await run(dir);
		const workouts = recordsOf(all, "workouts");
		assert.equal(workouts.length, 2);
		const wkAll = recordsOf(all, "coverage_diagnostics").find(
			(r) => r.stream === "workouts",
		);
		assert.ok(wkAll);
		assert.ok((wkAll.fields_unavailable as string[]).includes("events"));
		assert.match(progressOf(all), /workout_events:1/);

		const walk = workouts.find((w) => w.workout_activity_type === "Walking");
		const onlyWalk = await run(dir, {
			streamResources: { workouts: [walk?.id as string] },
		});
		assert.equal(recordsOf(onlyWalk, "workouts").length, 1);
		const wk = recordsOf(onlyWalk, "coverage_diagnostics").find(
			(r) => r.stream === "workouts",
		);
		assert.ok(wk);
		assert.ok(
			!(wk.fields_unavailable as string[]).includes("events"),
			"the workout that lost a marker was not asked for",
		);
		assert.equal(wk.reason, "covered_in_full");
		assert.match(progressOf(onlyWalk), /out_of_scope:1/);
	});
});

test("a WorkoutActivity's children are not attached to the enclosing workout", async () => {
	// iOS 16 and later nest per-activity markers, statistics and metadata
	// inside a WorkoutActivity inside the Workout. The workout carries its own
	// copies; attaching the activity's as well would count each twice. The
	// activity's marker has no duration unit, so attaching it would also
	// disown events on the receipt.
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500">
  <WorkoutEvent type="HKWorkoutEventTypeSegment" date="2024-06-05 07:00:00 -0500" duration="15" durationUnit="min"/>
  <WorkoutActivity uuid="00000000-0000-0000-0000-000000000001" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500" duration="30" durationUnit="min">
   <WorkoutEvent type="HKWorkoutEventTypeSegment" date="2024-06-05 07:00:00 -0500" duration="15"/>
   <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500" sum="300" unit="kcal"/>
   <MetadataEntry key="HKIndoorWorkout" value="0"/>
  </WorkoutActivity>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500" sum="300" unit="kcal"/>
 </Workout>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const [w] = recordsOf(result, "workouts");
		assert.ok(w);
		assert.equal((w.events as unknown[]).length, 1, "the workout's own marker");
		assert.equal(
			(w.statistics as unknown[]).length,
			1,
			"the workout's own statistic",
		);
		const receipt = recordsOf(result, "coverage_diagnostics").find(
			(r) => r.stream === "workouts",
		);
		assert.ok(receipt);
		assert.equal(receipt.reason, "covered_in_full");
		assert.ok(!(receipt.fields_unavailable as string[]).includes("events"));
	});
});

test("single-quoted values and whitespace around '=' or before a close tag's '>' are read like any other", async () => {
	// All are legal XML, though Apple's serialiser writes none; a tag grammar
	// without them would drop the record, leave it open, or call the file
	// truncated.
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type='HKQuantityTypeIdentifierBodyMass' unit='kg' startDate='2024-06-05 08:00:00 -0500' endDate='2024-06-05 08:00:00 -0500' value='80'>
  <MetadataEntry key='HKWasUserEntered' value='1'/>
 </Record >
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="2024-06-06 08:00:00 -0500" endDate="2024-06-06 08:00:00 -0500" value="81"/>
 <Record type = "HKQuantityTypeIdentifierBodyMass" unit= "kg" startDate ="2024-06-07 08:00:00 -0500" endDate="2024-06-07 08:00:00 -0500" value
  ="82"/>
</HealthData >
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		assert.deepEqual(
			recordsOf(result, "body_measurements").map((r) => [
				r.value,
				r.was_user_entered,
			]),
			[
				[80, true],
				[81, null],
				[82, null],
			],
		);
		assert.equal(
			receiptOf(result, "body_measurements")?.reason,
			"covered_in_full",
		);
	});
});

test("a WorkoutActivity too large to read still keeps its children off the workout", async () => {
	// Dropped as oversized, its open tag is never read, so its close tag
	// alone would otherwise mark where the workout's own children resume.
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500">
  <WorkoutActivity uuid="00000000-0000-0000-0000-000000000001" note="${"x".repeat(17 * 1_048_576)}" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500">
   <WorkoutEvent type="HKWorkoutEventTypeSegment" date="2024-06-05 07:01:00 -0500" duration="1" durationUnit="min"/>
   <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="5" unit="km"/>
  </WorkoutActivity>
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="5" unit="km"/>
 </Workout>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir, { timeoutMs: 120_000 });
		const [w] = recordsOf(result, "workouts");
		assert.ok(w);
		assert.equal(w.events, null, "the activity's marker is not the workout's");
		assert.equal((w.statistics as unknown[]).length, 1);
		assert.equal(w.total_distance_km, 5, "the distance is counted once");
	});
});

test("a self-closing WorkoutActivity too large to read leaves the statistics after it the workout's", async () => {
	// Closed by its own `/>`, it has no children, so what follows it is the
	// workout's again. In the second workout the '/' is the last byte of the
	// 64 KiB read that takes the tag past the ceiling, and the '>' the first
	// of the next.
	const head = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
`;
	const open = (hour: string) =>
		` <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 ${hour}:00:00 -0500" endDate="2024-06-05 ${hour}:30:00 -0500">\n  `;
	const statistics = `
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="5" unit="km"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="300" unit="kcal"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="150" unit="count/min"/>
 </Workout>
`;
	const tagHead =
		'<WorkoutActivity uuid="00000000-0000-0000-0000-000000000001" note="';
	const activity = (tagBytes: number) =>
		`${tagHead}${"x".repeat(tagBytes - tagHead.length - 3)}"/>`;
	const first = `${head}${open("07")}${activity(17 * 1_048_576)}${statistics}${open("09")}`;
	const read = 65_536;
	const at = Buffer.byteLength(first) % read;
	const xml = `${first}${activity(MAX_PENDING_TAG_BYTES + read - at + 1)}${statistics}</HealthData>\n`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir, { timeoutMs: 120_000 });
		const workouts = recordsOf(result, "workouts");
		assert.equal(workouts.length, 2);
		for (const w of workouts) {
			assert.deepEqual(
				(w.statistics as Array<Record<string, unknown>>).map((s) => s.type),
				["DistanceWalkingRunning", "ActiveEnergyBurned", "HeartRate"],
			);
			assert.equal(w.total_distance_km, 5);
			assert.equal(w.total_energy_burned_kcal, 300);
		}
		assert.deepEqual(unavailableOn(result, "workouts"), []);
	});
});

test("text after a WorkoutActivity too large to read keeps the statistics after it the workout's, and its totals unsummed", async () => {
	// Apple writes only whitespace between tags. A '>' in text after the
	// dropped tag could be taken for the tag's end, so its end is unknown: the
	// statistics stay the workout's and the totals are named, not summed. In
	// the second workout nothing but whitespace follows the text's '>'.
	const workout = (hour: string, text: string) =>
		` <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 ${hour}:00:00 -0500" endDate="2024-06-05 ${hour}:30:00 -0500">
  <WorkoutActivity uuid="00000000-0000-0000-0000-000000000001" note="${"x".repeat(17 * 1_048_576)}"/>${text}
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="5" unit="km"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="300" unit="kcal"/>
 </Workout>
`;
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
${workout("07", " 5 > 3 ")}${workout("09", " see >")}</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir, { timeoutMs: 120_000 });
		assert.deepEqual(
			recordsOf(result, "workouts").map((w) => [
				(w.statistics as Array<Record<string, unknown>> | null)?.map(
					(s) => s.type,
				),
				w.total_distance_km,
				w.total_energy_burned_kcal,
			]),
			[
				[["DistanceWalkingRunning", "ActiveEnergyBurned"], null, null],
				[["DistanceWalkingRunning", "ActiveEnergyBurned"], null, null],
			],
		);
		assert.deepEqual(unavailableOn(result, "workouts"), [
			"total_distance_km",
			"total_energy_burned_kcal",
		]);
	});
});

/** A Workout as an export from iOS 16 or later writes one: no total attributes, and `children`. */
function statisticsWorkout(start: string, children: string): string {
	return ` <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="60" durationUnit="min" startDate="2025-06-05 ${start}:00 +0100" endDate="2025-06-05 23:00:00 +0100">
${children}
 </Workout>`;
}

function workoutStatistic(type: string, sum: string, unit: string): string {
	return `<WorkoutStatistics type="HKQuantityTypeIdentifier${type}" startDate="2025-06-05 07:00:00 +0100" endDate="2025-06-05 08:00:00 +0100" sum="${sum}" unit="${unit}"/>`;
}

function activity(uuid: number, children: string): string {
	return `<WorkoutActivity uuid="00000000-0000-0000-0000-00000000000${uuid}" startDate="2025-06-05 07:00:00 +0100" endDate="2025-06-05 08:00:00 +0100">${children}</WorkoutActivity>`;
}

test("a workout from iOS 16 or later takes its totals from its statistics, counting each once", async () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
${statisticsWorkout(
	"07:00",
	[
		activity(
			1,
			workoutStatistic("ActiveEnergyBurned", "495", "kcal") +
				workoutStatistic("DistanceWalkingRunning", "7.9", "km"),
		),
		workoutStatistic("ActiveEnergyBurned", "500", "kcal"),
		workoutStatistic("DistanceWalkingRunning", "8", "km"),
	].join("\n"),
)}
${statisticsWorkout(
	"09:00",
	[
		activity(
			1,
			workoutStatistic("ActiveEnergyBurned", "200", "kcal") +
				workoutStatistic("DistanceWalkingRunning", "3", "km"),
		),
		activity(
			2,
			workoutStatistic("ActiveEnergyBurned", "150", "kcal") +
				workoutStatistic("DistanceWalkingRunning", "2.5", "km"),
		),
	].join("\n"),
)}
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const totals = recordsOf(result, "workouts").map((w) => [
			w.total_energy_burned_kcal,
			w.total_distance_km,
			(w.statistics as unknown[] | null)?.length ?? 0,
		]);
		assert.deepEqual(totals, [
			[500, 8, 2],
			[350, 5.5, 0],
		]);
		assert.deepEqual(receiptOf(result, "workouts")?.fields_unavailable, []);
	});
});

test("an activity statistic that cannot be read stops a total being summed from the activities", async () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
${statisticsWorkout(
	"07:00",
	activity(
		1,
		workoutStatistic("DistanceWalkingRunning", "3", "km") +
			'<WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="2" unit="&#x110000;"/>',
	),
)}
${statisticsWorkout(
	"09:00",
	activity(
		1,
		workoutStatistic("DistanceWalkingRunning", "3", "km") +
			`<WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="2" unit="km" note="${"x".repeat(17 * 1_048_576)}"/>`,
	),
)}
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir, { timeoutMs: 120_000 });
		assert.deepEqual(
			recordsOf(result, "workouts").map((w) => w.total_distance_km),
			[null, null],
		);
		assert.ok(unavailableOn(result, "workouts").includes("total_distance_km"));
	});
});

test("a statistic that states a figure but no type leaves both totals empty, at either level", async () => {
	// It may be the distance or energy a total needs, so a total summed
	// without it could be short. A sum or unit that cannot be read is still
	// stated; one with neither takes nothing from a total.
	const both =
		workoutStatistic("DistanceWalkingRunning", "3", "km") +
		workoutStatistic("ActiveEnergyBurned", "200", "kcal");
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
${statisticsWorkout("07:00", `${both}<WorkoutStatistics sum="2" unit="km"/>`)}
${statisticsWorkout("09:00", activity(1, `${both}<WorkoutStatistics type="" sum="2" unit="km"/>`))}
${statisticsWorkout("11:00", `${both}<WorkoutStatistics average="140"/>`)}
${statisticsWorkout("13:00", `${both}<WorkoutStatistics sum="n/a"/>`)}
${statisticsWorkout("15:00", activity(1, `${both}<WorkoutStatistics type=" " sum="unknown"/>`))}
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		assert.deepEqual(
			recordsOf(result, "workouts").map((w) => [
				w.total_distance_km,
				w.total_energy_burned_kcal,
			]),
			[
				[null, null],
				[null, null],
				[3, 200],
				[null, null],
				[null, null],
			],
		);
		assert.deepEqual(unavailableOn(result, "workouts"), [
			"statistics",
			"total_distance_km",
			"total_energy_burned_kcal",
		]);
	});
});

test("a statistic's figure that is not a number is named, and costs no total; a statistic that cannot be read stops both", async () => {
	const both =
		workoutStatistic("DistanceWalkingRunning", "3", "km") +
		workoutStatistic("ActiveEnergyBurned", "200", "kcal");
	const importOf = async (statistic: string) => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
${statisticsWorkout("07:00", both + statistic)}
</HealthData>
`;
		let result: Awaited<ReturnType<typeof run>> | undefined;
		await withImportDir({ "export.xml": xml }, async (dir) => {
			result = await run(dir);
		});
		assert.ok(result);
		const [w] = recordsOf(result, "workouts");
		assert.ok(w);
		return { w, unavailable: unavailableOn(result, "workouts") };
	};
	const [figure, lost] = await Promise.all([
		importOf(
			'<WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="n/a" minimum="90" unit="count/min"/>',
		),
		importOf(
			'<WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="140" unit="&#x110000;"/>',
		),
	]);
	const heartRate = (figure.w.statistics as Array<Record<string, unknown>>)[2];
	assert.deepEqual([heartRate?.average, heartRate?.minimum], [null, 90]);
	assert.deepEqual(
		[figure.w.total_distance_km, figure.w.total_energy_burned_kcal],
		[3, 200],
	);
	assert.deepEqual(figure.unavailable, ["statistics"]);
	assert.deepEqual(
		[lost.w.total_distance_km, lost.w.total_energy_burned_kcal],
		[null, null],
	);
	assert.deepEqual(lost.unavailable, [
		"statistics",
		"total_distance_km",
		"total_energy_burned_kcal",
	]);
});

test("a workout with more markers than the cap keeps 500 and says so", async () => {
	const events: string[] = [];
	for (let i = 0; i < 501; i += 1) {
		events.push(
			`  <WorkoutEvent type="HKWorkoutEventTypeSegment" date="2024-06-05 07:${String(i % 60).padStart(2, "0")}:00 -0500"/>`,
		);
	}
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500">
${events.join("\n")}
 </Workout>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const [w] = recordsOf(result, "workouts");
		assert.ok(w);
		assert.equal((w.events as unknown[]).length, 500);
		const receipt = recordsOf(result, "coverage_diagnostics").find(
			(r) => r.stream === "workouts",
		);
		assert.ok(receipt);
		const unavailable = receipt.fields_unavailable as string[];
		assert.ok(
			unavailable.includes("events"),
			"a truncated marker list must be declared, not silently sliced",
		);
		assert.ok(
			!unavailable.includes("statistics"),
			"only the list that was actually cut may be named",
		);
		for (const stream of AREAS) {
			const areaReceipt = receiptOf(result, stream);
			assert.ok(areaReceipt);
			assert.ok(
				!(areaReceipt.fields_unavailable as string[]).includes("events"),
				`a workout field must not appear on the ${stream} receipt`,
			);
		}
	});
});

// ─── Identity and receipt precision ────────────────────────────────────

test("a typed-in reading and a sensed reading are two records", async () => {
	// was_user_entered is a real difference in what the record IS, so it is
	// part of identity. Two otherwise identical readings differing only in it
	// must not collapse.
	const base =
		'type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:00:00 -0500" value="80"';
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record ${base}><MetadataEntry key="HKWasUserEntered" value="1"/></Record>
 <Record ${base}><MetadataEntry key="HKWasUserEntered" value="0"/></Record>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const records = recordsOf(result, "body_measurements");
		assert.equal(records.length, 2);
		assert.notEqual(records[0]?.id, records[1]?.id);
	});
});

test("two readings a person created separately are two records", async () => {
	// creation_date is in the identity. Leaving it out would merge two
	// readings the Health app itself shows as two. Identity is the published
	// scalar content.
	const base =
		'type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:00:00 -0500" value="80"';
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record creationDate="2024-06-05 08:06:00 -0500" ${base}/>
 <Record creationDate="2024-06-09 20:00:00 -0500" ${base}/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const records = recordsOf(result, "body_measurements");
		assert.equal(records.length, 2);
		assert.notEqual(records[0]?.id, records[1]?.id);
	});
});

test("an export whose only element is unreadable says unreadable, not empty", async () => {
	// Testing emptiness before unreadability would report an export whose only
	// record was dropped as oversized as "nothing in range". Those are
	// different sentences to the owner.
	const huge = "x".repeat(17 * 1024 * 1024);
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120" blob="${huge}"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		assert.equal(readingsOf(result).length, 0);
		const receipt = receiptOf(result, "activity");
		assert.ok(receipt);
		assert.equal(receipt.reason, "records_unreadable");
		assert.equal(receipt.status, "empty");
	});
});

test("was_user_entered survives any number of unrelated metadata entries", async () => {
	// Metadata accumulated up to a cap would let 500 unrelated entries ahead
	// of HKWasUserEntered silently turn the published field null. Only the one
	// key that is published is kept, so position is irrelevant.
	const junk: string[] = [];
	for (let i = 0; i < 600; i += 1) {
		junk.push(`  <MetadataEntry key="ThirdPartyKey${i}" value="v${i}"/>`);
	}
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:00:00 -0500" value="80">
${junk.join("\n")}
  <MetadataEntry key="HKWasUserEntered" value="1"/>
 </Record>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const [rec] = recordsOf(result, "body_measurements");
		assert.ok(rec);
		assert.equal(rec.was_user_entered, true);
		assert.ok(
			!JSON.stringify(rec).includes("ThirdPartyKey"),
			"no other metadata key may be emitted",
		);
	});
});

test("truncated statistics are named as statistics, on the workouts receipt only", async () => {
	const stats: string[] = [];
	for (let i = 0; i < 501; i += 1) {
		stats.push(
			`  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="${100 + (i % 50)}" unit="count/min"/>`,
		);
	}
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500">
${stats.join("\n")}
 </Workout>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const wk = receiptOf(result, "workouts");
		const rc = receiptOf(result, "activity");
		assert.ok(wk && rc);
		const wkU = wk.fields_unavailable as string[];
		const rcU = rc.fields_unavailable as string[];
		assert.ok(wkU.includes("statistics"), "the cut list is named");
		assert.ok(!wkU.includes("events"), "the list that was not cut is not");
		assert.ok(
			!rcU.includes("statistics") && !rcU.includes("events"),
			"workout fields do not appear on an area receipt",
		);
	});
});

// ─── Per-stream receipts ───────────────────────────────────────────────

test("each stream's receipt reflects that stream, not the run", async () => {
	// One outcome for the run, stamped on every receipt, would tell the owner
	// of an export with one record and no workouts that every workout was
	// imported, beside a workout count of zero.
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const rc = receiptOf(result, "activity");
		const wk = receiptOf(result, "workouts");
		const sl = receiptOf(result, "sleep");
		assert.ok(rc && wk && sl);
		assert.equal(rc.reason, "covered_in_full");
		assert.equal(rc.status, "complete");
		assert.equal(rc.record_count, 1);
		for (const empty of [wk, sl]) {
			assert.equal(empty.reason, "nothing_in_range");
			assert.equal(empty.status, "empty");
			assert.equal(empty.record_count, 0);
		}
	});
});

test("the progress line names a bounded number of unconvertible units and counts the rest", async () => {
	const workouts = Array.from(
		{ length: 25 },
		(_, i) =>
			` <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" totalDistance="5" totalDistanceUnit="furlong-${i}" startDate="2024-06-05 06:${String(i).padStart(2, "0")}:00 -0500" endDate="2024-06-05 07:30:00 -0500"/>`,
	).join("\n");
	await withImportDir(
		{
			"export.xml": EXPORT_XML.replace(
				"</HealthData>",
				`${workouts}\n</HealthData>`,
			),
		},
		async (dir) => {
			const result = await run(dir);
			const summary = messagesOf(result, "PROGRESS")
				.map((m) => String(m.message))
				.find((line) => line.includes("unconvertible_units="));
			assert.ok(summary, "a gap summary names the units");
			assert.equal(summary.match(/furlong-\d+:1/g)?.length, 20);
			assert.match(summary, /unconvertible_quantities_of_unnamed_units=5\b/);
		},
	);
});

test("a unit gap on an event does not disown the workout's totals", async () => {
	// Unit gaps are attributed to the field they hit, so an odd unit on one
	// marker does not report all three totals unavailable.
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" totalDistance="5" totalDistanceUnit="km" totalEnergyBurned="300" totalEnergyBurnedUnit="kcal" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500">
  <WorkoutEvent type="HKWorkoutEventTypePause" date="2024-06-05 07:10:00 -0500" duration="90"/>
 </Workout>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const [w] = recordsOf(result, "workouts");
		assert.ok(w);
		assert.equal(w.total_distance_km, 5);
		assert.equal(w.total_energy_burned_kcal, 300);
		assert.equal(w.duration_minutes, 30);
		const receipt = recordsOf(result, "coverage_diagnostics").find(
			(r) => r.stream === "workouts",
		);
		assert.ok(receipt);
		const unavailable = receipt.fields_unavailable as string[];
		assert.ok(unavailable.includes("events"), "the event's field is named");
		for (const f of [
			"duration_minutes",
			"total_distance_km",
			"total_energy_burned_kcal",
		]) {
			assert.ok(
				!unavailable.includes(f),
				`${f} was fine and must not be disowned`,
			);
		}
	});
});

test("a record that repeats the one kept metadata key keeps only the first", async () => {
	// Keeping only one key reopened an unbounded path for a record that repeats
	// it. First occurrence wins and nothing else is retained.
	const copies: string[] = [];
	for (let i = 0; i < 5000; i += 1) {
		copies.push(
			`  <MetadataEntry key="HKWasUserEntered" value="${i === 0 ? "1" : "0"}"/>`,
		);
	}
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:00:00 -0500" value="80">
${copies.join("\n")}
 </Record>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const [rec] = recordsOf(result, "body_measurements");
		assert.ok(rec);
		assert.equal(rec.was_user_entered, true, "the first occurrence decides");
	});
});

// ─── Oversized elements and scope ──────────────────────────────────────

test("an oversized element outside the requested window does not degrade the receipt", async () => {
	// Ordinary records are range-filtered before receipt accounting. A dropped
	// element must be held to the same test, or a drop dated years outside the
	// window degrades a window that was fully covered.
	const huge = "x".repeat(17 * 1024 * 1024);
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2026-03-01 08:00:00 -0500" endDate="2026-03-01 08:05:00 -0500" value="10" blob="${huge}"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2020-06-05 08:00:00 -0500" endDate="2020-06-05 08:05:00 -0500" value="120"/>
</HealthData>
`;
	// The window ENDS in 2025, so the dropped 2026 record is outside it and
	// the surviving 2020 one is inside. An end bound rather than a start
	// bound, so that "the data does not reach back that far" cannot fire and
	// mask what this test is about.
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir, {
			timeRange: { until: "2025-01-01T00:00:00.000Z" },
		});
		assert.equal(recordsOf(result, "activity").length, 1);
		const rc = receiptOf(result, "activity");
		assert.ok(rc);
		assert.equal(
			rc.reason,
			"covered_in_full",
			"a drop the reader would never have received costs the window nothing",
		);
		assert.equal(rc.status, "complete");
		assert.equal(rc.records_skipped_unreadable, 0);
		const progress = (result.messages as Array<Record<string, unknown>>)
			.filter((m) => m.type === "PROGRESS")
			.map((m) => String(m.message));
		assert.ok(
			progress.some((m) => m.includes("out_of_scope:1")),
			"the drop is still visible on the progress line",
		);
	});
});

test("a stale cursor does not put an oversized element out of scope", async () => {
	// Scope is the requested window and nothing else. A cursor version 0.1.0
	// saved excludes no record, so a drop dated before it is a real loss to
	// this import and is charged.
	const huge = "x".repeat(17 * 1024 * 1024);
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-01 08:00:00 -0500" endDate="2024-06-01 08:05:00 -0500" value="10" blob="${huge}"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir, {
			state: staleCursor("2024-06-03T00:00:00.000Z"),
		});
		assert.equal(recordsOf(result, "activity").length, 1);
		const rc = receiptOf(result, "activity");
		assert.ok(rc);
		assert.equal(rc.reason, "records_unreadable");
		assert.equal(rc.records_skipped_unreadable, 1);
	});
});

test("an oversized element whose start cannot be read stays in scope", async () => {
	// If the giant attribute precedes startDate, the sniff fails. Unknown is
	// treated as in scope: the honest default is to confess a possible loss
	// rather than assume there was none.
	const huge = "x".repeat(17 * 1024 * 1024);
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" blob="${huge}" unit="count" startDate="2020-06-01 08:00:00 -0500" endDate="2020-06-01 08:05:00 -0500" value="10"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2026-06-05 08:00:00 -0500" endDate="2026-06-05 08:05:00 -0500" value="120"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir, {
			timeRange: { since: "2025-01-01T00:00:00.000Z" },
		});
		// The type precedes the giant attribute, so it is read, and the drop is
		// charged to its own area.
		const rc = receiptOf(result, "activity");
		assert.ok(rc);
		assert.equal(rc.reason, "records_unreadable");
		assert.ok((rc.records_skipped_unreadable as number) >= 1);
	});
});

// ─── Start-date sniffing ───────────────────────────────────────────────

test("a fake start date inside an earlier attribute value cannot put a drop out of scope", async () => {
	// XML permits double quotes inside a single-quoted value, so a value can
	// contain the text startDate="2030-...". An unanchored sniff would find that
	// and classify a genuinely in-window record as out of scope, allowing a
	// false covered_in_full. The sniff reads only the leading run of
	// well-formed double-quoted pairs, the scanner's own grammar, so it stops at
	// the single-quoted attribute and the real startDate beyond it is not seen.
	// Not seen means in scope, and the drop is charged. The type is beyond it
	// too, so the drop is charged where a record of unknown type belongs, to
	// other.
	const padding = "x".repeat(17 * 1024 * 1024);
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record note=' startDate="2030-01-01 00:00:00 +0000" ${padding}' type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-01-01 08:00:00 +0000" endDate="2024-01-01 08:01:00 +0000" value="1"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir, {
			timeRange: { until: "2025-01-01T00:00:00.000Z" },
		});
		assert.equal(recordsOf(result, "activity").length, 1);
		const other = receiptOf(result, "other");
		assert.ok(other);
		assert.equal(
			other.reason,
			"records_unreadable",
			"a drop whose true start cannot be read must be charged, not excused",
		);
		assert.ok((other.records_skipped_unreadable as number) >= 1);
		assert.equal(receiptOf(result, "activity")?.reason, "covered_in_full");
	});
});

// ─── One stream per health area ────────────────────────────────────────

/**
 * One reading for each health area, two where a routing rule needs its own
 * witness: pelvic pain, a symptom Apple files under Reproduction, and a type
 * the area table does not list.
 */
const ONE_PER_AREA: ReadonlyArray<{
	stream: string;
	type: string;
	unit?: string;
	value: string;
}> = [
	{
		stream: "activity",
		type: "HKQuantityTypeIdentifierStepCount",
		unit: "count",
		value: "100",
	},
	{
		stream: "body_measurements",
		type: "HKQuantityTypeIdentifierBodyMass",
		unit: "kg",
		value: "80",
	},
	{
		stream: "reproductive_health",
		type: "HKCategoryTypeIdentifierMenstrualFlow",
		value: "HKCategoryValueMenstrualFlowMedium",
	},
	{
		stream: "reproductive_health",
		type: "HKCategoryTypeIdentifierPelvicPain",
		value: "HKCategoryValueSeverityModerate",
	},
	{
		stream: "hearing",
		type: "HKQuantityTypeIdentifierHeadphoneAudioExposure",
		unit: "dBASPL",
		value: "70",
	},
	{
		stream: "vital_signs",
		type: "HKQuantityTypeIdentifierHeartRate",
		unit: "count/min",
		value: "60",
	},
	{
		stream: "lab_results",
		type: "HKQuantityTypeIdentifierBloodGlucose",
		unit: "mg/dL",
		value: "95",
	},
	{
		stream: "sleep",
		type: "HKCategoryTypeIdentifierSleepAnalysis",
		value: "HKCategoryValueSleepAnalysisAsleepREM",
	},
	{
		stream: "mindfulness",
		type: "HKCategoryTypeIdentifierMindfulSession",
		value: "HKCategoryValueNotApplicable",
	},
	{
		stream: "nutrition",
		type: "HKQuantityTypeIdentifierDietaryWater",
		unit: "mL",
		value: "250",
	},
	{
		stream: "alcohol_consumption",
		type: "HKQuantityTypeIdentifierNumberOfAlcoholicBeverages",
		unit: "count",
		value: "1",
	},
	{
		stream: "mobility",
		type: "HKQuantityTypeIdentifierWalkingSpeed",
		unit: "km/hr",
		value: "4.5",
	},
	{
		stream: "symptoms",
		type: "HKCategoryTypeIdentifierHeadache",
		value: "HKCategoryValueSeverityMild",
	},
	{
		stream: "other",
		type: "HKQuantityTypeIdentifierUVExposure",
		unit: "count",
		value: "3",
	},
	{
		stream: "other",
		type: "HKQuantityTypeIdentifierSomethingAppleAddsLater",
		unit: "count",
		value: "1",
	},
];

/** The published `type` of an export identifier. */
function shortType(type: string): string {
	return type.replace(/^HK(Quantity|Category)TypeIdentifier|^HKDataType/, "");
}

/**
 * An export holding ONE_PER_AREA and a workout, every element carrying what an
 * export may carry and no stream may publish: a source named after a
 * person, a source version, free text in metadata, and workout weather.
 */
function areaExport(): string {
	const records = ONE_PER_AREA.map((r, i) => {
		const day = `2024-06-${String(1 + i).padStart(2, "0")}`;
		const unit = r.unit ? ` unit="${r.unit}"` : "";
		return ` <Record type="${r.type}" sourceName="Ada's Apple Watch" sourceVersion="SRCVER77" device="&lt;&lt;HKDevice: 0x1&gt;, name:Ada's Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, localIdentifier:LOCALID77&gt;"${unit} creationDate="${day} 08:00:00 -0500" startDate="${day} 08:00:00 -0500" endDate="${day} 08:05:00 -0500" value="${r.value}">
  <MetadataEntry key="HKExternalUUID" value="note from Ada's coach"/>
  <MetadataEntry key="HKWasUserEntered" value="1"/>
 </Record>`;
	});
	return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Me HKCharacteristicTypeIdentifierDateOfBirth="1980-04-11" HKCharacteristicTypeIdentifierBloodType="HKBloodTypeAPositive" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexFemale"/>
${records.join("\n")}
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Ada's Apple Watch" sourceVersion="SRCVER77" duration="30" durationUnit="min" startDate="2024-06-05 06:30:00 -0500" endDate="2024-06-05 07:00:00 -0500">
  <MetadataEntry key="HKWeatherTemperature" value="58.0 degF"/>
 </Workout>
</HealthData>
`;
}

test("one reading of each area reaches that area's stream and no other", async () => {
	await withImportDir({ "export.xml": areaExport() }, async (dir) => {
		const result = await run(dir);
		for (const stream of AREAS) {
			const expected = ONE_PER_AREA.filter((r) => r.stream === stream)
				.map((r) => shortType(r.type))
				.sort();
			const rows = recordsOf(result, stream);
			assert.deepEqual(
				rows.map((r) => String(r.type)).sort(),
				expected,
				`${stream} carries exactly its own readings`,
			);
			for (const row of rows) {
				assert.equal(validateRecord(stream, row).ok, true, stream);
			}
		}
		assert.equal(recordsOf(result, "workouts").length, 1);

		const receipts = recordsOf(result, "coverage_diagnostics");
		assert.deepEqual(
			receipts.map((r) => r.stream),
			DATA_STREAMS,
		);
		for (const r of receipts) {
			const expected =
				r.stream === "workouts"
					? 1
					: ONE_PER_AREA.filter((x) => x.stream === r.stream).length;
			assert.equal(r.record_count, expected, String(r.stream));
			assert.equal(
				r.records_type_unrecognized,
				r.stream === "other" ? 1 : 0,
				`only the type no area lists is counted (${String(r.stream)})`,
			);
			assert.equal(r.reason, "covered_in_full", String(r.stream));
			assert.equal(r.status, "complete");
			assert.equal(validateRecord("coverage_diagnostics", r).ok, true);
		}
	});
});

test("each area's receipt accounts for that area alone", async () => {
	// A duplicate, a unit gap, a record with no start date and one that cannot
	// be decoded, each in a different area. Every one lands on its own area's
	// receipt and on no other. The undecodable reading is routed by the type
	// sniffed off its raw tag, which precedes the bad reference.
	const step =
		' <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>';
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
${step}
${step}
 <Record type="HKQuantityTypeIdentifierBloodGlucose" startDate="2024-06-05 09:00:00 -0500" endDate="2024-06-05 09:00:00 -0500" value="95"/>
 <Record type="HKCategoryTypeIdentifierNausea" value="HKCategoryValueSeverityMild"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" device="bad &#x110000; ref" unit="count/min" startDate="2024-06-05 10:00:00 -0500" endDate="2024-06-05 10:00:00 -0500" value="61"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" startDate="2024-06-05 23:00:00 -0500" endDate="2024-06-06 06:00:00 -0500" value="HKCategoryValueSleepAnalysisAsleepCore"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const expected: Record<
			string,
			{ count: number; dup: number; skipped: number; reason: string }
		> = {
			activity: { count: 1, dup: 1, skipped: 0, reason: "covered_in_full" },
			lab_results: { count: 1, dup: 0, skipped: 0, reason: "covered_in_full" },
			symptoms: { count: 0, dup: 0, skipped: 1, reason: "records_unreadable" },
			vital_signs: {
				count: 0,
				dup: 0,
				skipped: 1,
				reason: "records_unreadable",
			},
			sleep: { count: 1, dup: 0, skipped: 0, reason: "covered_in_full" },
		};
		for (const stream of DATA_STREAMS) {
			const r = receiptOf(result, stream);
			assert.ok(r, stream);
			const want = expected[stream] ?? {
				count: 0,
				dup: 0,
				skipped: 0,
				reason: "nothing_in_range",
			};
			assert.equal(r.record_count, want.count, `${stream} record_count`);
			assert.equal(r.duplicates_discarded, want.dup, `${stream} duplicates`);
			assert.equal(
				r.records_skipped_unreadable,
				want.skipped,
				`${stream} unreadable`,
			);
			assert.equal(r.reason, want.reason, `${stream} reason`);
			assert.equal(
				(r.fields_unavailable as string[]).includes("unit"),
				stream === "lab_results",
				`only lab_results holds the unitless reading (${stream})`,
			);
		}
	});
});

test("a type no area lists arrives on other, and its receipt counts it only when delivered", async () => {
	// UV exposure is a listed type that belongs to other; the two
	// SomethingAppleAddsLater readings are not listed anywhere. Only those
	// count, and only when the reader receives them.
	const later = (day: string, value: number): string =>
		` <Record type="HKQuantityTypeIdentifierSomethingAppleAddsLater" unit="count" startDate="${day} 08:00:00 -0500" endDate="${day} 08:05:00 -0500" value="${value}"/>`;
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
${later("2019-03-01", 1)}
${later("2024-06-05", 2)}
 <Record type="HKQuantityTypeIdentifierUVExposure" unit="count" startDate="2024-06-05 12:00:00 -0500" endDate="2024-06-05 12:05:00 -0500" value="3"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const whole = await run(dir);
		assert.deepEqual(
			recordsOf(whole, "other")
				.map((r) => r.type)
				.sort(),
			["SomethingAppleAddsLater", "SomethingAppleAddsLater", "UVExposure"],
		);
		assert.equal(receiptOf(whole, "other")?.records_type_unrecognized, 2);
		assert.equal(receiptOf(whole, "activity")?.records_type_unrecognized, 0);
		const progress = messagesOf(whole, "PROGRESS")
			.map((m) => String(m.message))
			.join("\n");
		assert.match(
			progress,
			/unrecognized_record_types=HKQuantityTypeIdentifierSomethingAppleAddsLater:2/,
		);

		const windowed = await run(dir, {
			timeRange: { since: "2020-01-01T00:00:00.000Z" },
		});
		assert.equal(receiptOf(windowed, "other")?.records_type_unrecognized, 1);
		// The progress line names only delivered records, as the receipt does.
		assert.match(
			messagesOf(windowed, "PROGRESS")
				.map((m) => String(m.message))
				.join("\n"),
			/unrecognized_record_types=HKQuantityTypeIdentifierSomethingAppleAddsLater:1(?:\s|$)/,
		);

		const uv = recordsOf(whole, "other").find((r) => r.type === "UVExposure");
		const asked = await run(dir, { resources: [String(uv?.id)] });
		assert.equal(recordsOf(asked, "other").length, 1);
		assert.equal(receiptOf(asked, "other")?.records_type_unrecognized, 0);
	});
});

test("duplicate suppression is per stream: the same content on two streams arrives on both", async () => {
	// A type written without its HK prefix is not a listed identifier, so it
	// belongs to other, yet it publishes the same short type as the listed one
	// and so the same id. The area streams share one identity table, so
	// without each stream's tag the second would be dropped as a duplicate of
	// a record on another stream, and other would never receive it.
	const rest =
		'unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"';
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" ${rest}/>
 <Record type="StepCount" ${rest}/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const [onActivity] = recordsOf(result, "activity");
		const [onOther] = recordsOf(result, "other");
		assert.ok(onActivity && onOther, "each stream receives its record");
		assert.equal(onActivity.id, onOther.id);
		assert.equal(receiptOf(result, "activity")?.duplicates_discarded, 0);
		assert.equal(receiptOf(result, "other")?.duplicates_discarded, 0);
	});
});

interface ManifestStreamSchema {
	name: string;
	schema: { properties: Record<string, unknown> };
}

function manifestProperties(stream: string): Set<string> {
	const manifest = JSON.parse(
		readFileSync(manifestPath("apple_health"), "utf8"),
	) as { streams: ManifestStreamSchema[] };
	const declared = manifest.streams.find((s) => s.name === stream);
	assert.ok(declared, `manifest declares ${stream}`);
	return new Set(Object.keys(declared.schema.properties));
}

test("no stream emits a withheld field", async () => {
	// Asserted on every data stream's emitted output, not on the schema: the
	// runtime forwards the object it is given, so a field the schema omits
	// would still reach a reader if the builder put it there.
	await withImportDir({ "export.xml": areaExport() }, async (dir) => {
		const result = await run(dir);
		for (const stream of DATA_STREAMS) {
			const rows = recordsOf(result, stream);
			assert.ok(rows.length > 0, `${stream} emitted nothing to check`);
			const declared = manifestProperties(stream);
			for (const row of rows) {
				for (const key of Object.keys(row)) {
					assert.ok(declared.has(key), `${stream} emitted undeclared ${key}`);
				}
				const text = JSON.stringify(row);
				for (const withheld of [
					"Ada",
					"SRCVER77",
					"coach",
					"HKExternalUUID",
					"WeatherTemperature",
					"degF",
					"1980-04-11",
					"BiologicalSex",
					"LOCALID77",
					"HKDevice",
				]) {
					assert.ok(!text.includes(withheld), `${stream} leaked ${withheld}`);
				}
			}
		}
		const receipts = JSON.stringify(recordsOf(result, "coverage_diagnostics"));
		assert.ok(!receipts.includes("Ada"));
	});
});

test("a run scoped differently on each stream honours every stream's own window and resource list", async () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-06 08:00:00 -0500" endDate="2024-06-06 08:05:00 -0500" value="130"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" startDate="2024-06-05 23:00:00 -0500" endDate="2024-06-06 06:00:00 -0500" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" startDate="2024-06-07 23:00:00 -0500" endDate="2024-06-08 06:00:00 -0500" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2024-06-05 10:00:00 -0500" endDate="2024-06-05 10:00:00 -0500" value="61"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:00:00 -0500" value="80"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 06:30:00 -0500" endDate="2024-06-05 07:00:00 -0500"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const all = await run(dir);
		const [firstStep, secondStep] = recordsOf(all, "activity");
		assert.ok(firstStep && secondStep);

		const scoped = await run(dir, {
			streams: [
				"activity",
				"vital_signs",
				"sleep",
				"workouts",
				"coverage_diagnostics",
			],
			ranges: {
				sleep: { since: "2024-06-07T00:00:00.000Z" },
				vital_signs: { until: "2024-06-01T00:00:00.000Z" },
			},
			streamResources: { activity: [String(secondStep.id)] },
		});

		assert.deepEqual(idsOf(scoped, "activity"), [String(secondStep.id)]);
		const activity = receiptOf(scoped, "activity");
		assert.equal(activity?.record_count, 1);
		assert.equal(activity?.reason, "covered_in_full");

		const sleep = recordsOf(scoped, "sleep");
		assert.deepEqual(
			sleep.map((r) => r.start_date),
			["2024-06-08T04:00:00.000Z"],
		);
		const sleepReceipt = receiptOf(scoped, "sleep");
		assert.equal(sleepReceipt?.record_count, 1);
		assert.equal(
			sleepReceipt?.window_requested_from,
			"2024-06-07T00:00:00.000Z",
		);
		assert.equal(sleepReceipt?.window_covered_from, "2024-06-08T04:00:00.000Z");

		assert.equal(recordsOf(scoped, "vital_signs").length, 0);
		const vital = receiptOf(scoped, "vital_signs");
		assert.equal(vital?.reason, "nothing_in_range");
		assert.equal(vital?.window_requested_to, "2024-06-01T00:00:00.000Z");

		assert.equal(recordsOf(scoped, "workouts").length, 1);
		assert.equal(
			recordsOf(scoped, "body_measurements").length,
			0,
			"a stream the host did not ask for is not emitted",
		);
		assert.deepEqual(
			recordsOf(scoped, "coverage_diagnostics").map((r) => r.stream),
			["activity", "vital_signs", "sleep", "workouts"],
			"a receipt for each requested data stream and no other",
		);
	});
});

// ─── Duplicate suppression at scale ────────────────────────────────────

test("with both identity budgets spent, memory stays within the streaming bound and each stream says when it ran out", {
	timeout: 600_000,
}, async (t) => {
	// The worst case for suppression memory: the budget the area streams
	// share and the budget reserved for workouts, both full at once. Readings
	// on three streams and workouts on either side of the point each budget
	// runs out:
	//   - a body_measurements duplicate before the area budget is spent: caught,
	//     and that stream's count is exact;
	//   - activity spends the rest of the area budget and then some, so it
	//     meets identities it can no longer remember and says so;
	//   - a sleep duplicate after the area budget is spent: not caught, and
	//     sleep says so, though its own volume was two readings;
	//   - a workout duplicate after the area budget is spent: caught, since
	//     workouts draw on their own reserve; later workouts spend that reserve,
	//     and the workouts receipt says so too.
	const AREA_BUDGET = 400_000;
	const WORKOUT_BUDGET = 100_000;
	const parts: string[] = [];
	const bodyMass =
		' <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="2024-01-01 07:00:00 -0500" endDate="2024-01-01 07:00:00 -0500" value="80"/>';
	parts.push(bodyMass, bodyMass);
	for (let i = 0; i < AREA_BUDGET; i += 1) {
		parts.push(
			` <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="${i}"/>`,
		);
	}
	const sleep =
		' <Record type="HKCategoryTypeIdentifierSleepAnalysis" startDate="2024-06-05 23:00:00 -0500" endDate="2024-06-06 06:00:00 -0500" value="HKCategoryValueSleepAnalysisAsleepCore"/>';
	parts.push(sleep, sleep);
	const workout = (minutes: number): string =>
		` <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="${minutes}" durationUnit="min" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500"/>`;
	parts.push(workout(0), workout(0));
	for (let i = 1; i <= WORKOUT_BUDGET; i += 1) {
		parts.push(workout(i));
	}
	const xml =
		`<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n <ExportDate value="2026-09-01 12:00:00 -0500"/>\n` +
		`${parts.join("\n")}\n</HealthData>\n`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir, {
			peakRssPollIntervalMs: 200,
			timeoutMs: 540_000,
		});
		assert.ok(result.peakRssBytes !== null, "expected a sampled peak RSS");
		const peakMb = Math.round((result.peakRssBytes ?? 0) / 1024 / 1024);
		assert.ok(
			(result.peakRssBytes ?? 0) < 300 * 1024 * 1024,
			`peak RSS ${peakMb}MB exceeded the streaming bound`,
		);
		t.diagnostic(`identity budgets spent: peak RSS ${peakMb}MB`);

		const capped = (stream: string): boolean => {
			const receipt = receiptOf(result, stream);
			assert.ok(receipt, stream);
			return (receipt.fields_unavailable as string[]).includes(
				"duplicates_discarded",
			);
		};

		const body = receiptOf(result, "body_measurements");
		assert.equal(body?.record_count, 1);
		assert.equal(body?.duplicates_discarded, 1);
		assert.ok(!capped("body_measurements"), "all its identities fit");

		assert.equal(receiptOf(result, "activity")?.record_count, AREA_BUDGET);
		assert.ok(capped("activity"), "activity outran the area budget");

		const sleepReceipt = receiptOf(result, "sleep");
		assert.equal(recordsOf(result, "sleep").length, 2);
		assert.equal(sleepReceipt?.duplicates_discarded, 0);
		assert.ok(
			capped("sleep"),
			"sleep lost suppression to another stream's volume, and says so",
		);

		const workouts = receiptOf(result, "workouts");
		assert.equal(
			workouts?.duplicates_discarded,
			1,
			"workouts are still suppressed after the area budget is spent",
		);
		assert.equal(workouts?.record_count, WORKOUT_BUDGET + 1);
		assert.ok(capped("workouts"), "the workout reserve ran out too");

		for (const stream of ["vital_signs", "symptoms", "other"]) {
			assert.ok(!capped(stream), `${stream} met no identity it could not keep`);
		}
	});
});

// ─── Archives built to exhaust memory or time ──────────────────────────

const STREAMING_BOUND_BYTES = 300 * 1024 * 1024;

/**
 * Write, a record at a time, a zip holding the export followed by
 * `fillers` directory records of `recordBytes` bytes each, every one naming a
 * `.gpx` file and pointing at the export's data, which is never read through
 * them. The directory is `fillers * recordBytes` bytes plus the export's.
 */
function writeZipWithLargeDirectory(
	path: string,
	xml: string,
	fillers: number,
	recordBytes: number,
): number {
	const data = Buffer.from(xml);
	const compressed = deflateRawSync(data);
	const exportName = Buffer.from("apple_health_export/export.xml");
	const fd = openSync(path, "w");
	let position = 0;
	const write = (bytes: Buffer): void => {
		writeSync(fd, bytes);
		position += bytes.length;
	};
	try {
		const sizes = {
			compressedSize: compressed.length,
			uncompressedSize: data.length,
		};
		write(
			Buffer.concat([
				localFileHeader({ ...sizes, name: exportName }),
				compressed,
			]),
		);
		const directoryStart = position;
		const record = (name: Buffer): void => {
			write(centralDirectoryRecord({ ...sizes, name }));
		};
		record(exportName);
		for (let i = 1; i <= fillers; i += 1) {
			const stem = `apple_health_export/workout-routes/${i}_`;
			record(Buffer.from(`${stem.padEnd(recordBytes - 46 - 4, "r")}.gpx`));
		}
		const directoryBytes = position - directoryStart;
		write(endOfCentralDirectory(fillers + 1, directoryBytes, directoryStart));
		return directoryBytes;
	} finally {
		closeSync(fd);
	}
}

test("an archive whose directory is built to exhaust memory is refused within the streaming bound", {
	timeout: 240_000,
}, async (t) => {
	// 65,534 records of 4,142 bytes each: the most the reader's per-record
	// allowance admits, a 271 MB directory with 268 MB of names. Read whole, it
	// would take the process past a gigabyte and kill it with no receipt.
	await withImportDir({}, async (dir) => {
		const directoryBytes = writeZipWithLargeDirectory(
			join(dir, "export.zip"),
			exportTakenOn("2026-09-01"),
			65_533,
			46 + 4096,
		);
		assert.ok(
			directoryBytes > 270_000_000,
			`directory ${directoryBytes} bytes`,
		);
		const result = await run(dir, { peakRssPollIntervalMs: 20 });
		assert.ok(result.peakRssBytes !== null, "expected a sampled peak RSS");
		const peakMb = Math.round((result.peakRssBytes ?? 0) / 1024 / 1024);
		t.diagnostic(`crafted 271 MB directory: peak RSS ${peakMb}MB`);
		assert.ok(
			(result.peakRssBytes ?? 0) < STREAMING_BOUND_BYTES,
			`peak RSS ${peakMb}MB exceeded the streaming bound`,
		);
		for (const r of recordsOf(result, "coverage_diagnostics")) {
			assert.equal(r.reason, "export_extraction_failed");
		}
		const [skip] = messagesOf(result, "SKIP_RESULT");
		assert.match(
			String(skip?.message),
			/list of files is larger than this reader accepts/,
		);
		assert.match(
			String(skip?.message),
			/is under 8 GB, unzip it on your computer and upload that XML instead/,
		);
		assert.doesNotMatch(String(skip?.message), /4 GB/);
	});
});

test("an archive whose directory is at the byte ceiling imports within the streaming bound", {
	timeout: 240_000,
}, async (t) => {
	// The largest directory the reader accepts, 65,001 records of about 516
	// bytes each, read and decoded whole: the measured worst case of a
	// directory this connector reads.
	await withImportDir({}, async (dir) => {
		const directoryBytes = writeZipWithLargeDirectory(
			join(dir, "export.zip"),
			exportTakenOn("2026-09-01"),
			65_000,
			516,
		);
		assert.ok(
			directoryBytes > 33_000_000 && directoryBytes <= 32 * 1024 * 1024,
			`directory ${directoryBytes} bytes`,
		);
		const result = await run(dir, { peakRssPollIntervalMs: 20 });
		assert.ok(result.peakRssBytes !== null, "expected a sampled peak RSS");
		const peakMb = Math.round((result.peakRssBytes ?? 0) / 1024 / 1024);
		t.diagnostic(`32 MiB directory: peak RSS ${peakMb}MB`);
		assert.ok(
			(result.peakRssBytes ?? 0) < STREAMING_BOUND_BYTES,
			`peak RSS ${peakMb}MB exceeded the streaming bound`,
		);
		assert.equal(recordsOf(result, "activity").length, 1);
		assert.equal(receiptOf(result, "activity")?.reason, "covered_in_full");
	});
});

test("an archive of many small XML files is judged quickly within the streaming bound", {
	timeout: 240_000,
}, async (t) => {
	// Judging each entry by extracting it whole, with the directory read
	// again for each, would be quadratic: minutes and hundreds of MB on a zip
	// of a megabyte or two. Beside an export in apple_health_export/ the export is
	// found first; with no export, the search stops at the sniff count.
	const decoys: ZipFixtureEntry[] = [];
	for (let i = 0; i < 16_000; i += 1) {
		decoys.push({ name: `a/${i}.xml`, data: "<x/>" });
	}
	const cases = [
		{
			label: "16,000 small XML entries beside the export",
			entries: [
				...decoys,
				{
					name: "apple_health_export/export.xml",
					data: exportTakenOn("2026-09-01"),
				},
			],
			imported: 1,
		},
		{ label: "16,000 small XML entries alone", entries: decoys, imported: 0 },
		{
			label: "65,000 small XML entries alone",
			entries: Array.from({ length: 65_000 }, (_, i) => ({
				name: `a/${i}.xml`,
				data: "<x/>",
			})),
			imported: 0,
		},
	];
	for (const c of cases) {
		await withImportDir({}, async (dir) => {
			await writeFile(join(dir, "export.zip"), buildZip(c.entries));
			const started = Date.now();
			const result = await run(dir, { peakRssPollIntervalMs: 20 });
			const seconds = (Date.now() - started) / 1000;
			assert.ok(result.peakRssBytes !== null, "expected a sampled peak RSS");
			const peakMb = Math.round((result.peakRssBytes ?? 0) / 1024 / 1024);
			t.diagnostic(`${c.label}: peak RSS ${peakMb}MB in ${seconds}s`);
			assert.ok(
				(result.peakRssBytes ?? 0) < STREAMING_BOUND_BYTES,
				`peak RSS ${peakMb}MB exceeded the streaming bound`,
			);
			assert.ok(seconds < 60, `took ${seconds}s`);
			assert.equal(recordsOf(result, "activity").length, c.imported);
			if (c.imported === 0) {
				const [skip] = messagesOf(result, "SKIP_RESULT");
				assert.match(
					String(skip?.message),
					/more XML files than this reader will search/,
				);
			}
		});
	}
});

// ─── Elements built to exhaust memory or time ──────────────────────────

/** Write an export at `path` whose body `write` produces, piece by piece. */
function writeExport(path: string, write: (w: (s: string) => void) => void) {
	const fd = openSync(path, "w");
	try {
		writeSync(
			fd,
			'<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n <ExportDate value="2026-09-01 12:00:00 -0500"/>\n',
		);
		write((s) => {
			writeSync(fd, s);
		});
		writeSync(fd, "</HealthData>\n");
	} finally {
		closeSync(fd);
	}
}

/** A step-count record's open tag on a day of June 2026, without its end. */
const stepCountTag = (day: string, value: number): string =>
	` <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2026-06-${day} 08:00:00 -0500" endDate="2026-06-${day} 08:05:00 -0500" value="${value}"`;

test("a workout whose markers each carry a 15 MiB attribute stays within the streaming bound", {
	timeout: 240_000,
}, async (t) => {
	// Each marker is within the pending ceiling, so each is read, and its type
	// is kept until the workout closes. Kept as a slice of the text it was read
	// from, a type would keep that text alive: twenty-four of them, 360 MiB.
	await withImportDir({}, async (dir) => {
		const pad = "x".repeat(15 * 1024 * 1024);
		writeExport(join(dir, "export.xml"), (w) => {
			w(
				' <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2026-06-05 09:00:00 -0500" endDate="2026-06-05 09:30:00 -0500">\n',
			);
			for (let i = 0; i < 24; i += 1) {
				w(
					`  <WorkoutEvent type="HKWorkoutEventTypeMotionResumed" date="2026-06-05 09:${String(i).padStart(2, "0")}:00 -0500" pad="${pad}"/>\n`,
				);
			}
			w(" </Workout>\n");
		});
		const result = await run(dir, {
			peakRssPollIntervalMs: 50,
			timeoutMs: 180_000,
		});
		const peakMb = Math.round((result.peakRssBytes ?? 0) / 1024 / 1024);
		t.diagnostic(`peak RSS ${peakMb}MB`);
		assert.ok(result.peakRssBytes !== null, "expected a sampled peak RSS");
		assert.ok(
			(result.peakRssBytes ?? 0) < STREAMING_BOUND_BYTES,
			`peak RSS ${peakMb}MB exceeded the streaming bound`,
		);
		const [workout] = recordsOf(result, "workouts");
		assert.equal((workout?.events as unknown[] | undefined)?.length, 24);
		assert.equal(receiptOf(result, "workouts")?.reason, "covered_in_full");
	});
});

test("an element with millions of attributes is read, and the run completes", {
	timeout: 120_000,
}, async () => {
	// Matched as one repeated group, 2.5 million attributes exhaust the regex
	// engine's stack, and the throw would end the run with no receipt.
	await withImportDir({}, async (dir) => {
		writeExport(join(dir, "export.xml"), (w) => {
			w(`${stepCountTag("05", 7)}/>\n`);
			w(stepCountTag("06", 8));
			const attributes = ' a="1"'.repeat(100_000);
			for (let i = 0; i < 25; i += 1) {
				w(attributes);
			}
			w(`/>\n${stepCountTag("07", 9)}/>\n`);
		});
		const result = await run(dir, { timeoutMs: 60_000 });
		assert.equal(messagesOf(result, "DONE")[0]?.status, "succeeded");
		assert.deepEqual(
			recordsOf(result, "activity").map((r) => r.value),
			[7, 8, 9],
		);
		assert.equal(receiptOf(result, "activity")?.reason, "covered_in_full");
	});
});

test("elements that never close cost time in proportion to their length", {
	timeout: 240_000,
}, async (t) => {
	// Six records of 18 MB whose tags never close within the pending ceiling.
	// Scanned whole again with every chunk that arrives, each would cost time
	// growing with the square of its length: most of a minute for these six.
	await withImportDir({}, async (dir) => {
		writeExport(join(dir, "export.xml"), (w) => {
			const attributes = ' k="0123456789abc"'.repeat(100_000);
			for (let e = 0; e < 6; e += 1) {
				w(stepCountTag(`0${e + 1}`, 1));
				for (let i = 0; i < 10; i += 1) {
					w(attributes);
				}
				w("/>\n");
			}
		});
		const started = Date.now();
		const result = await run(dir, { timeoutMs: 180_000 });
		const seconds = (Date.now() - started) / 1000;
		t.diagnostic(`${seconds}s`);
		assert.ok(seconds < 10, `took ${seconds}s`);
		const receipt = receiptOf(result, "activity");
		assert.equal(receipt?.reason, "records_unreadable");
		assert.equal(receipt?.records_skipped_unreadable, 6);
	});
});

// ─── Admission ─────────────────────────────────────────────────────────

test("a record the schema rejects is not remembered, so no copy of it counts as a duplicate", async () => {
	// Two identical readings whose type is longer than the schema allows. The
	// reader receives neither, so the second is not a duplicate of a record
	// it holds: both are unreadable, and neither spends the identity budget
	// the area streams share.
	const tooLong = `HKQuantityTypeIdentifier${"X".repeat(250)}`;
	const rejected = ` <Record type="${tooLong}" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="1"/>`;
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
${rejected}
${rejected}
 <Record type="HKQuantityTypeIdentifierUVExposure" unit="count" startDate="2024-06-05 12:00:00 -0500" endDate="2024-06-05 12:05:00 -0500" value="3"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		const other = receiptOf(result, "other");
		assert.ok(other);
		assert.equal(other.record_count, 1);
		assert.equal(other.records_skipped_unreadable, 2);
		assert.equal(other.duplicates_discarded, 0);
	});
});

test("under a resource list, an element that could not be read costs the receipt nothing", async () => {
	// Without an id it cannot be one of the ids the host asked for. Charged,
	// it would report a loss among records the reader never requested.
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
 <Record type="HKQuantityTypeIdentifierStepCount" device="bad &#x110000; ref" unit="count" startDate="2024-06-05 09:00:00 -0500" endDate="2024-06-05 09:05:00 -0500" value="130"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="140"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2024-06-05 07:00:00 -0500" endDate="2024-06-05 07:30:00 -0500"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="20" durationUnit="min"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const whole = await run(dir);
		assert.equal(receiptOf(whole, "activity")?.records_skipped_unreadable, 2);
		assert.equal(receiptOf(whole, "workouts")?.records_skipped_unreadable, 1);

		const [step] = recordsOf(whole, "activity");
		const [workout] = recordsOf(whole, "workouts");
		const asked = await run(dir, {
			streamResources: {
				activity: [String(step?.id)],
				workouts: [String(workout?.id)],
			},
		});
		for (const stream of ["activity", "workouts"]) {
			const receipt = receiptOf(asked, stream);
			assert.equal(receipt?.record_count, 1, stream);
			assert.equal(receipt?.records_skipped_unreadable, 0, stream);
			assert.equal(receipt?.reason, "covered_in_full", stream);
		}
	});
});

test("the receipt stream honours a resource list like any other stream", async () => {
	// The runtime filters every stream against the ids a host asks for. A
	// receipt's id is stable for the same stream, export, window and reason,
	// so a host can ask for one receipt and receive only that one.
	await withImportDir({ "export.xml": EXPORT_XML }, async (dir) => {
		const all = recordsOf(await run(dir), "coverage_diagnostics");
		assert.equal(all.length, DATA_STREAMS.length);
		const sleep = all.find((r) => r.stream === "sleep");
		assert.ok(sleep);
		const asked = await run(dir, {
			streamResources: { coverage_diagnostics: [String(sleep.id)] },
		});
		assert.deepEqual(recordsOf(asked, "coverage_diagnostics"), [sleep]);
	});
});

test("two exports of one reading that differ only in the device's address and name give it one id", async () => {
	// Apple prints the device object's address in memory, which differs from
	// one export to the next, and the writing app names the device as it
	// likes. Hashing either would give an unchanged reading a new id in each
	// export, and since every import re-sends everything, a reader would hold
	// a copy of the history per export.
	const reading = (
		address: string,
		name: string,
	): string => `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" device="&lt;&lt;HKDevice: ${address}&gt;, name:${name}, manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, software:9.0&gt;" unit="count/min" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:00:01 -0500" value="72"/>
</HealthData>
`;
	const readingOf = async (xml: string) => {
		let row: Record<string, unknown> | undefined;
		await withImportDir({ "export.xml": xml }, async (dir) => {
			[row] = recordsOf(await run(dir), "vital_signs");
		});
		assert.ok(row);
		return row;
	};
	const first = await readingOf(reading("0x283c2b570", "Ada's Apple Watch"));
	const second = await readingOf(reading("0x1c04f2a80", "Apple Watch"));
	assert.equal(first.id, second.id);
	assert.equal(
		first.device,
		"manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, software:9.0",
	);
	assert.deepEqual(first, second);
});

test("two devices described identically are one device: an identical reading from each arrives once", async () => {
	// Telling them apart would take a device identifier, which is withheld.
	// The consent copy and the receipt's duplicates_discarded both say so.
	const reading = (localIdentifier: string, udid: string): string =>
		` <Record type="HKQuantityTypeIdentifierHeartRate" device="&lt;&lt;HKDevice: 0x1&gt;, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, firmware:1.0, software:9.0, localIdentifier:${localIdentifier}, UDIDeviceIdentifier:${udid}&gt;" unit="count/min" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:00:01 -0500" value="72"/>`;
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
${reading("A-1", "UDID-1")}
${reading("B-2", "UDID-2")}
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		assert.equal(recordsOf(result, "vital_signs").length, 1);
		assert.equal(receiptOf(result, "vital_signs")?.duplicates_discarded, 1);
	});
});

test("a device description that cannot be read unambiguously is published as null and named on the receipt", async () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" device="&lt;&lt;HKDevice: 0x1&gt;, name:Ada, model:Evil, manufacturer:Apple Inc., model:Watch&gt;" unit="count" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:05:00 -0500" value="120"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" device="&lt;&lt;HKDevice: 0x2&gt;, name:A, name:B, manufacturer:Apple Inc., model:Watch&gt;" unit="count/min" startDate="2024-06-05 08:01:00 -0500" value="72"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" device="Ada's Garmin" duration="30" durationUnit="min" startDate="2024-06-05 06:30:00 -0500" endDate="2024-06-05 07:00:00 -0500"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		assert.deepEqual(
			recordsOf(result, "activity").map((r) => r.device),
			[null],
		);
		assert.deepEqual(
			recordsOf(result, "workouts").map((r) => r.device),
			[null],
		);
		assert.deepEqual(
			recordsOf(result, "vital_signs").map((r) => r.device),
			["manufacturer:Apple Inc., model:Watch"],
			"a key that is never published may repeat",
		);
		for (const stream of ["activity", "workouts"]) {
			assert.ok(unavailableOn(result, stream).includes("device"), stream);
		}
		assert.ok(!unavailableOn(result, "vital_signs").includes("device"));
	});
});

test("clinical records from healthcare providers reach no stream", async () => {
	// Health keeps records shared by a clinic or hospital as ClinicalRecord
	// elements pointing at FHIR files under clinical-records/. The manifest
	// says lab_results does not include them; nothing else may either.
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-09-01 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierBloodGlucose" unit="mg/dL" startDate="2024-06-05 08:00:00 -0500" endDate="2024-06-05 08:00:00 -0500" value="95"/>
 <ClinicalRecord type="HKClinicalTypeIdentifierLabResultRecord" identifier="obs-1" sourceName="Example Hospital" fhirVersion="4.0.1" receivedDate="2024-06-05 09:00:00 -0500" resourceFilePath="/clinical-records/Observation-1.json"/>
</HealthData>
`;
	await withImportDir({ "export.xml": xml }, async (dir) => {
		const result = await run(dir);
		assert.deepEqual(
			readingsOf(result).map((r) => r.type),
			["BloodGlucose"],
		);
		assert.ok(!JSON.stringify(result.messages).includes("Example Hospital"));
		for (const r of recordsOf(result, "coverage_diagnostics")) {
			assert.equal(r.records_skipped_unreadable, 0, String(r.stream));
		}
	});
});
