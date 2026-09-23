// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SYNTHETIC fixture shape lock. `__fixtures__/synthetic/*.jsonl` is
 * hand-authored, shape-real data — NOT a scrubbed real capture. No live
 * DoorDash account has been connected for this lane yet (see
 * connectors/doordash/index.ts header). This test only proves schemas.ts
 * accepts the shapes this connector's parsers are designed to emit; it
 * does not satisfy the proof-gate's real-capture requirement.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateRecord } from "./schemas.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "__fixtures__", "synthetic");

function readJsonl(filename: string): Record<string, unknown>[] {
	return readFileSync(join(FIXTURES_DIR, filename), "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

for (const [stream, filename] of [
	["orders", "orders.jsonl"],
	["order_items", "order_items.jsonl"],
] as const) {
	test(`synthetic-shape/doordash/${stream}: SYNTHETIC record shape passes validateRecord`, () => {
		const rows = readJsonl(filename);
		assert.ok(rows.length > 0, `${filename} is empty`);
		for (const row of rows) {
			const result = validateRecord(stream, row);
			assert.ok(
				result.ok,
				`${filename}: id=${JSON.stringify(row.id)} failed schema: ${
					result.ok
						? ""
						: result.issues.map((i) => `${i.path}: ${i.message}`).join("; ")
				}`,
			);
		}
	});
}
