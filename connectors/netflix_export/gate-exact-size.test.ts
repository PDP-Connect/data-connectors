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

test("parseCSVFile accepts ordinary CSV with quoted headers", async (t) => {
	const tmpDir = mkdtempSync(join(tmpdir(), "netflix-test-quoted-headers-"));
	t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
	const csvPath = join(tmpDir, "viewing-activity.csv");
	writeFileSync(
		csvPath,
		'"Title","Date"\r\n"An Example, Part 1",2024-01-15\r\n',
	);

	const result = await parseCSVFile(csvPath);
	assert.equal(result.error, undefined);
	assert.deepEqual(result.headers, ["title", "date"]);
	assert.deepEqual(result.rows, [
		{ title: "An Example, Part 1", date: "2024-01-15" },
	]);
});

test("parseCSVFile with file EXACTLY at 50 MiB", async () => {
	const tmpDir = "/tmp/netflix-test-exact";
	mkdirSync(tmpDir, { recursive: true });
	try {
		const csvPath = join(tmpDir, "exact.csv");

		// Create a file that's EXACTLY 50 MiB (header "Title,Date\n" is 11 bytes)
		const FIFTY_MIB = 50 * 1024 * 1024;
		const HEADER = "Title,Date\n";
		const fd = openSync(csvPath, "w");
		writeSync(fd, HEADER);
		writeSync(fd, "a".repeat(FIFTY_MIB - HEADER.length)); // Exactly 50 MiB total
		closeSync(fd);

		const result = await parseCSVFile(csvPath);
		console.log(
			`Result: rows=${result.rows.length}, error=${result.error}, malformed=${result.malformedCount}`,
		);
		assert.equal(
			result.error,
			undefined,
			"File at exact limit should parse OK",
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("parseCSVFile with file 50 MiB + 1 byte", async () => {
	const tmpDir = "/tmp/netflix-test-over-by-one";
	mkdirSync(tmpDir, { recursive: true });
	try {
		const csvPath = join(tmpDir, "over.csv");

		// Create a file that's 50 MiB + 1 (header "Title,Date\n" is 11 bytes)
		const FIFTY_MIB_PLUS_ONE = 50 * 1024 * 1024 + 1;
		const HEADER = "Title,Date\n";
		const fd = openSync(csvPath, "w");
		writeSync(fd, HEADER);
		writeSync(fd, "a".repeat(FIFTY_MIB_PLUS_ONE - HEADER.length)); // 50 MiB + 1
		closeSync(fd);

		const result = await parseCSVFile(csvPath);
		console.log(
			`Result: rows=${result.rows.length}, error=${result.error}, malformed=${result.malformedCount}`,
		);
		assert.ok(result.error, "Should error on 50 MiB + 1 file");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

for (const rowCount of [100_000, 100_001]) {
	test(`parseCSVFile distinguishes a complete row budget from an over-limit prefix (${rowCount})`, async () => {
		const directory = mkdtempSync(join(tmpdir(), "netflix-row-limit-"));
		try {
			const csvPath = join(directory, "rows.csv");
			const repeated = "Sample,2026-02-01\n".repeat(99_999);
			const limitRow = "Boundary,2026-02-02\n";
			const extra = rowCount > 100_000 ? "Omitted,2026-02-03\n" : "";
			writeFileSync(csvPath, "Title,Date\n" + repeated + limitRow + extra);

			const result = await parseCSVFile(csvPath);
			assert.deepEqual(result.headers, ["title", "date"]);
			assert.equal(result.malformedCount, 0);
			assert.equal(result.rows.length, 100_000);
			assert.deepEqual(result.rows.at(-1), {
				title: "Boundary",
				date: "2026-02-02",
			});
			assert.equal(
				result.error,
				extra ? "CSV exceeds maximum rows (100000)" : undefined,
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
