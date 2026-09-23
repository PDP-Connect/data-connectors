// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixturesDir } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { validateRecord } from "./schemas.ts";

const STREAMS = [
	"profile",
	"body",
	"cycles",
	"recoveries",
	"sleeps",
	"workouts",
] as const;

for (const stream of STREAMS) {
	test(`WHOOP ${stream} pilot fixture satisfies emitted schema`, async () => {
		const path = join(
			fixturesDir("whoop"),
			"scrubbed",
			"pilot-real-shape",
			"records",
			`${stream}.jsonl`,
		);
		const lines = (await readFile(path, "utf8")).trim().split("\n");
		assert.ok(lines.length > 0);
		for (const line of lines) {
			const result = validateRecord(
				stream,
				JSON.parse(line) as Record<string, unknown>,
			);
			if (!result.ok) {
				assert.fail(JSON.stringify(result.issues));
			}
			assert.equal(result.ok, true);
		}
	});
}
