// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shape-lock test over the SYNTHETIC fixtures in `__fixtures__/synthetic/`
 * (see that directory's README) — NOT a real-derived capture. Locks the
 * connector's emitted-record shape against schema drift until a real,
 * scrubbed, reviewed capture exists under
 * `fixtures/uber/scrubbed/pilot-real-shape/` (see pilot-fixture.test.ts).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateRecord } from "./schemas.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "__fixtures__", "synthetic");

function readJsonlRecords(stream: string): unknown[] {
	const path = join(FIXTURES_DIR, `${stream}.jsonl`);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

for (const stream of ["trips", "receipts"]) {
	test(`synthetic/uber/${stream}: fixture rows pass validateRecord`, () => {
		const rows = readJsonlRecords(stream);
		assert.ok(rows.length > 0, `${stream}.jsonl must not be empty`);
		for (const row of rows) {
			const result = validateRecord(stream, row as Record<string, unknown>);
			assert.ok(
				result.ok,
				`${stream} row failed validateRecord: ${JSON.stringify(result.ok ? null : result.issues)}`,
			);
		}
	});
}
