// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the Strava collection path does not turn a large bare activities.csv
 * into one Buffer or one retained row array. The connector is run as a real
 * subprocess so the test observes the production protocol and child RSS.
 */

import assert from "node:assert/strict";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	connectorEntrypoint,
	packageRoot as PACKAGE_ROOT,
} from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";

const ENTRYPOINT = connectorEntrypoint("strava");
const LARGE_FIXTURE_BASE_DIR =
	process.env.PDPP_TEST_LARGE_FIXTURE_DIR ?? join(homedir(), ".tmp");

const HEADER =
	"Activity ID,Activity Date,Activity Name,Activity Type,Activity Description," +
	"Elapsed Time,Distance,Max Heart Rate,Relative Effort,Activity Gear,Filename," +
	"Athlete Weight,Bike Weight,Elapsed Time,Moving Time,Distance," +
	"Average Heart Rate,Elevation Gain,Calories\n";

function csvCell(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

test("large synthetic activities.csv emits with bounded RSS", async () => {
	const importRoot = join(
		LARGE_FIXTURE_BASE_DIR,
		`pdpp-strava-large-${String(process.pid)}-${String(Date.now())}`,
	);
	const filePath = join(importRoot, "activities.csv");
	const targetBytes = 128 * 1024 * 1024;
	const longName = "Synthetic activity name ".repeat(48);
	mkdirSync(importRoot, { recursive: true });
	const fd = openSync(filePath, "w");
	try {
		writeSync(fd, Buffer.from(HEADER, "utf8"));
		let written = Buffer.byteLength(HEADER, "utf8");
		let rowNumber = 0;
		while (written < targetBytes) {
			const fields = [
				String(1_000_000_000 + rowNumber),
				"2024-06-01T06:00:00Z",
				longName,
				"Run",
				"",
				"2100",
				"9.3",
				"",
				"",
				"",
				"activities/1.fit.gz",
				"",
				"",
				"2100",
				"2000",
				"14967.0",
				"",
				"31.0",
				"",
			];
			const row = `${fields.map(csvCell).join(",")}\n`;
			writeSync(fd, Buffer.from(row, "utf8"));
			written += Buffer.byteLength(row, "utf8");
			rowNumber += 1;
		}
	} finally {
		closeSync(fd);
	}

	try {
		const result = await runConnectorProtocolSubprocess({
			cwd: PACKAGE_ROOT,
			entrypoint: ENTRYPOINT,
			env: {
				PDPP_OWNER_TOKEN: "",
				PDPP_RS_URL: "",
				RS_URL: "",
				STRAVA_EXPORT_DIR: importRoot,
				TZ: "UTC",
			},
			peakRssPollIntervalMs: 25,
			start: {
				scope: {
					streams: [{ name: "activities" }, { name: "coverage_diagnostics" }],
				},
				type: "START",
			},
			timeoutMs: 120_000,
		});

		assert.ok(
			result.peakRssBytes !== null,
			"peakRssBytes must be sampled for this memory proof",
		);
		assert.ok(
			result.peakRssBytes < 450 * 1024 * 1024,
			`expected streaming collection below 450 MiB RSS, got ${String(Math.round(result.peakRssBytes / 1024 / 1024))} MiB`,
		);
		const done = result.messages.at(-1);
		assert.equal(done?.type, "DONE");
		if (done?.type === "DONE") {
			assert.equal(done.status, "succeeded");
		}
		assert.ok(
			result.messages.some(
				(message) =>
					message.type === "RECORD" && message.stream === "activities",
			),
			"the large file must produce activity records",
		);
	} finally {
		rmSync(importRoot, { force: true, recursive: true });
	}
});

test("static guard: the Strava collection path has no whole-file read", () => {
	const source = readFileSync(ENTRYPOINT, "utf8");
	assert.doesNotMatch(
		source,
		/\breadFileSync\b|\bBuffer\.alloc\(size\)/,
		"Strava collection must stream the artifact rather than allocate it by file size",
	);
});
