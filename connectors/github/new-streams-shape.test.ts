// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SYNTHETIC shape lock for `pinned_repositories` and `organizations` — two
 * of the streams added to close the github.profile parity gap recorded in
 * docs/migration/connector-cutover/capability-map.json.
 *
 * These do NOT live under fixtures/github/scrubbed/pilot-real-shape/: that
 * directory is reserved for reviewed real-derived captures, and (as of
 * 2026-09-22) no live account run has produced one for these two streams
 * yet. Putting synthetic rows there would mislabel evidence. `events` and
 * `contributions` used to be covered here too, but a 2026-09-22 live run
 * (Tim's own account) produced real captures for both — their scrubbed
 * fixtures now live under fixtures/github/scrubbed/pilot-real-shape/records/
 * and registerPilotFixtureTests covers them directly (see
 * pilot-fixture.test.ts).
 *
 * Once a live run captures and scrubs real records for pinned_repositories
 * or organizations, promote it into
 * fixtures/github/scrubbed/pilot-real-shape/records/<stream>.jsonl, remove
 * that stream from this file's list and from the exemptStreams entry in
 * pilot-fixture.test.ts, and delete its synthetic fixture.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateRecord } from "./schemas.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, "__fixtures__", "synthetic");

function readJsonlRecords(filename: string): Record<string, unknown>[] {
	return readFileSync(join(SYNTHETIC_DIR, filename), "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

for (const stream of ["pinned_repositories", "organizations"] as const) {
	test(`synthetic/github/${stream}: shape-only record shape passes validateRecord`, () => {
		const records = readJsonlRecords(`${stream}.jsonl`);
		assert.ok(records.length > 0, `${stream}.jsonl must have ≥1 record`);
		for (const record of records) {
			const result = validateRecord(stream, record);
			assert.ok(
				result.ok,
				`${stream} record ${JSON.stringify(record.id)} failed schema: ${
					result.ok
						? ""
						: result.issues.map((i) => `${i.path}: ${i.message}`).join("; ")
				}`,
			);
		}
	});
}
