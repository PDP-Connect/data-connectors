// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SYNTHETIC schema-drift lock for claude_code.
 *
 * `registerPilotFixtureTests` (src/pilot-fixture-test-helper.ts) reads
 * `fixtures/<connector>/scrubbed/pilot-real-shape/records/`, which is
 * reserved for reviewed, real-derived captures. This connector's fixture
 * set at that path was labeled `"class": "synthetic"` in its own
 * provenance.json, so it was relocated to `__fixtures__/synthetic/` (the
 * amazon connector's convention) rather than left mislabeling `pilot-real-shape/`
 * as real evidence. See `__fixtures__/synthetic/README.md`.
 *
 * This test reimplements the helper's read-and-replay loop against the new
 * path. `pilot-real-shape/` stays absent until a real, reviewed capture
 * exists — see docs/connector-authoring-guide.md §9.1.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { validateRecord } from "./schemas.ts";

const RECORDS_DIR = join(
	import.meta.dirname,
	"__fixtures__",
	"synthetic",
	"records",
);
const MANIFEST_PATH = join(
	import.meta.dirname,
	"..",
	"..",
	"manifests",
	"claude_code.json",
);

const streamFiles = readdirSync(RECORDS_DIR)
	.filter((f) => f.endsWith(".jsonl"))
	.map((f) => f.replace(/\.jsonl$/, ""))
	.sort((a, b) => a.localeCompare(b));

test("synthetic-fixture/claude_code: fixture inventory matches manifest", () => {
	const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
		streams: Array<{ name: string }>;
	};
	const declaredStreams = manifest.streams
		.map((s) => s.name)
		.sort((a, b) => a.localeCompare(b));
	assert.deepEqual(
		streamFiles,
		declaredStreams,
		"synthetic fixtures must contain exactly one .jsonl file for every manifest stream",
	);
});

for (const stream of streamFiles) {
	const filename = `${stream}.jsonl`;
	const filePath = join(RECORDS_DIR, filename);
	test(`synthetic-fixture/claude_code/${stream}: record shape passes validateRecord`, () => {
		const lines = readFileSync(filePath, "utf8")
			.split("\n")
			.filter((l) => l.trim());
		assert.ok(
			lines.length > 0,
			`${filename} is empty — fixture must have ≥1 record`,
		);
		const failures: Array<{
			id: unknown;
			issues: { path: string; message: string }[];
		}> = [];
		for (const line of lines) {
			const data = JSON.parse(line) as Record<string, unknown>;
			const result = validateRecord(stream, data);
			if (!result.ok) {
				failures.push({ id: data.id ?? null, issues: result.issues });
			}
		}
		if (failures.length > 0) {
			const detail = failures
				.slice(0, 3)
				.map(
					(f) =>
						`  id=${JSON.stringify(f.id)} issues=${f.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
				)
				.join("\n");
			assert.fail(
				`${filename}: ${failures.length}/${lines.length} records failed schema:\n${detail}`,
			);
		}
	});
}
