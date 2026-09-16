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
	validateManualUploadArtifactByKind,
	validateManualUploadArtifactFromFileByKind,
} from "./manual-upload-validation.ts";

const HEADER =
	"Activity ID,Activity Date,Activity Name,Activity Type,Activity Description," +
	"Elapsed Time,Distance,Max Heart Rate,Relative Effort,Activity Gear,Filename," +
	"Athlete Weight,Bike Weight,Elapsed Time,Moving Time,Distance," +
	"Average Heart Rate,Elevation Gain,Calories";
const CSV =
	`${HEADER}\n` +
	'11385479490,"2024-05-20T13:05:32Z",Parkrun,Run,,48:10,5.04,178,62,' +
	'"Brooks Ghost 15",activities/1.fit.gz,72.5,,2890,2710,8111.2,152.3,64.2,612\n';

test("Strava account export is registered in both manual-upload dispatch paths", async () => {
	const buffered = validateManualUploadArtifactByKind(
		"strava_account_export",
		CSV,
		{ fileName: "activities.csv" },
	);
	assert.ok(buffered);
	assert.equal(buffered.status, "valid");
	assert.equal(buffered.detected_format, "strava_account_export_csv");

	const dir = mkdtempSync(join(tmpdir(), "pdpp-strava-dispatch-"));
	const filePath = join(dir, "activities.csv");
	writeFileSync(filePath, CSV, "utf8");
	const fd = openSync(filePath, "r");
	try {
		const fileSha256 = createHash("sha256").update(CSV, "utf8").digest("hex");
		const fileBacked = await validateManualUploadArtifactFromFileByKind(
			"strava_account_export",
			fd,
			statSync(filePath).size,
			{
				fileName: "activities.csv",
				filePath,
				fileSha256,
			},
		);
		assert.ok(fileBacked);
		assert.equal(fileBacked.status, "valid");
		assert.ok("estimated_records" in fileBacked);
		assert.equal(fileBacked.estimated_records, 1);
	} finally {
		closeSync(fd);
		rmSync(dir, { force: true, recursive: true });
	}

	assert.equal(validateManualUploadArtifactByKind("unknown", CSV), null);
});
