// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCSVFile } from "./parsers.ts";

test("parseCSVFile rejects file exceeding 50 MiB limit", async () => {
	const tmpDir = "/tmp/netflix-test-oversized";
	mkdirSync(tmpDir, { recursive: true });
	try {
		const csvPath = join(tmpDir, "oversized.csv");

		// Create a file that's 50 MiB + 1 byte (header "Title,Date\n" is 11 bytes)
		const FIFTY_MIB = 50 * 1024 * 1024;
		const HEADER = "Title,Date\n";
		const fd = openSync(csvPath, "w");
		writeSync(fd, HEADER);
		writeSync(fd, "a".repeat(FIFTY_MIB - HEADER.length + 1)); // Pad to exceed limit by 1
		closeSync(fd);

		const result = await parseCSVFile(csvPath);
		assert.ok(
			result.error,
			`Should error on oversized file, got: ${JSON.stringify(result)}`,
		);
		assert.ok(
			result.error?.includes("exceeds maximum size"),
			"Error message should mention size limit",
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("parseCSVFile handles a missing synthetic export without inventing rows", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "netflix-missing-csv-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	assert.deepEqual(await parseCSVFile(join(dir, "missing.csv")), {
		headers: [],
		rows: [],
		malformedCount: 0,
	});
});

test("parseCSVFile keeps a complete synthetic row and counts a truncated quoted tail", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "netflix-malformed-csv-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const csvPath = join(dir, "viewing-activity.csv");
	writeFileSync(
		csvPath,
		'Title,Date\nInvented Title,2026-01-15\n"Unterminated title,2026-01-16\n',
	);

	assert.deepEqual(await parseCSVFile(csvPath), {
		headers: ["title", "date"],
		rows: [{ title: "Invented Title", date: "2026-01-15" }],
		malformedCount: 1,
	});
});
