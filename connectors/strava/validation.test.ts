// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	closeSync,
	mkdtempSync,
	openSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	validateStravaAccountExportArtifact,
	validateStravaAccountExportArtifactFromFile,
} from "./validation.ts";

const HEADER =
	"Activity ID,Activity Date,Activity Name,Activity Type,Activity Description," +
	"Elapsed Time,Distance,Max Heart Rate,Relative Effort,Activity Gear,Filename," +
	"Athlete Weight,Bike Weight,Elapsed Time,Moving Time,Distance," +
	"Average Heart Rate,Elevation Gain,Calories";

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
	const centralDir = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06_05_4b_50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDir.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...localParts, centralDir, end]);
}

const CSV = `${HEADER}\n${ROW_RUN}\n${ROW_RIDE}\n`;

test("validateStravaAccountExportArtifact confirms format, repeated headers, count, and date range", () => {
	const result = validateStravaAccountExportArtifact(CSV, {
		fileName: "activities.csv",
	});

	assert.equal(result.status, "valid");
	assert.equal(result.detected_format, "strava_account_export_csv");
	assert.equal(result.estimated_records, 2);
	assert.deepEqual(result.date_range, {
		end: "2024-06-01T06:00:00Z",
		start: "2024-05-20T13:05:32",
	});
	assert.deepEqual(result.repeated_headers?.distance, [6, 15]);
	assert.deepEqual(result.repeated_headers?.elapsed_time, [5, 13]);
	assert.ok(result.detected_headers?.includes("Activity ID"));
	assert.match(result.file_sha256, /^[0-9a-f]{64}$/);
});

test("validateStravaAccountExportArtifact validates the archive ZIP shape and duplicate hash", () => {
	const zip = makeStoredZip([
		{ name: "activities.csv", data: Buffer.from(CSV, "utf8") },
		{ name: "profile.csv", data: Buffer.from("private data", "utf8") },
	]);
	const first = validateStravaAccountExportArtifact(zip, {
		fileName: "strava-export.zip",
	});
	const duplicate = validateStravaAccountExportArtifact(zip, {
		existingFileHashes: [first.file_sha256],
		fileName: "strava-export.zip",
	});

	assert.equal(first.status, "valid");
	assert.equal(first.detected_format, "strava_account_export_zip");
	assert.equal(first.estimated_records, 2);
	assert.equal(duplicate.status, "duplicate");
});

test("validateStravaAccountExportArtifactFromFile streams a ZIP entry", async () => {
	const zip = makeStoredZip([
		{ name: "strava/activities.csv", data: Buffer.from(CSV, "utf8") },
	]);
	const dir = mkdtempSync(join(tmpdir(), "pdpp-strava-validation-"));
	const filePath = join(dir, "strava-export.zip");
	writeFileSync(filePath, zip);
	const fd = openSync(filePath, "r");
	try {
		const result = await validateStravaAccountExportArtifactFromFile(
			fd,
			filePath,
			statSync(filePath).size,
			{
				fileName: "strava-export.zip",
				fileSha256: createHash("sha256").update(zip).digest("hex"),
			},
		);
		assert.equal(result.status, "valid");
		assert.equal(result.detected_format, "strava_account_export_zip");
		assert.equal(result.estimated_records, 2);
	} finally {
		closeSync(fd);
		rmSync(dir, { force: true, recursive: true });
	}
});

test("validateStravaAccountExportArtifact reports empty, unsupported, and too-large uploads", () => {
	const empty = validateStravaAccountExportArtifact(HEADER, {
		fileName: "activities.csv",
	});
	assert.equal(empty.status, "empty");

	const unsupported = validateStravaAccountExportArtifact("Title,Date\n", {
		fileName: "activities.csv",
	});
	assert.equal(unsupported.status, "unsupported");

	const tooLarge = validateStravaAccountExportArtifact(CSV, {
		fileName: "activities.csv",
		maxFileBytes: 1,
	});
	assert.equal(tooLarge.status, "too_large");
});
