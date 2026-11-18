// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import example from "../../docs/submission-pilot.example.json" with {
	type: "json",
};
import { checkSubmissionBehavior } from "./check.ts";

const source = "A\u0001B\u0092 literal \\u0001";
const url = "https://submission.invalid/items";
const response = (row: { id: string; text: string }, total = 1) => [
	{ url, body: { results: [row], total_count: total } },
];
function contract() {
	return structuredClone(example);
}

// Tiny protocol producer isolates the shared runner's independent assertions.
// Archived real connector proposals separately prove these bugs end to end.
function checkout(mode = "correct") {
	const root = mkdtempSync(join(tmpdir(), "submission-check-"));
	const dir = join(root, "connectors", "example");
	mkdirSync(join(dir, "fixtures"), { recursive: true });
	writeFileSync(join(root, "package.json"), '{"type":"module"}');
	writeFileSync(
		join(dir, "manifest.json"),
		'{"runtime_requirements":{"bindings":{"network":{"required":true}}},"streams":[{"name":"items"}]}',
	);
	const codec = new URL(
		"../../../../connectors/anthropic/safe-escape.ts",
		import.meta.url,
	).href;
	writeFileSync(
		join(dir, "index.ts"),
		`
import { encodePdppSafeText } from ${JSON.stringify(codec)};
const mode = ${JSON.stringify(mode)};
const start = JSON.parse(await new Promise(resolve => process.stdin.once('data', chunk => resolve(String(chunk)))));
if (mode === 'socket') {try { (await import('node:net')).connect(443,'example.invalid'); } catch {}}
if (mode === 'subprocess') {try { (await import('node:child_process')).spawn(process.execPath,['--version']); } catch {}}
const emit = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
const page = await (await fetch(${JSON.stringify(url)})).json();
for (const row of page.results) {
  if (mode === 'refresh' && start.state) continue;
  const data = {...row, text: mode === 'text' ? row.text : encodePdppSafeText(row.text)};
  let op = row.is_deleted && mode !== 'deletions' ? 'delete' : 'upsert';
  const shortfall = page.total_count > page.results.length;
  const controls = row.text.includes(String.fromCharCode(1));
  if ((mode === 'counts-tombstone' && shortfall) || (mode === 'text-delete' && controls)) op = 'delete';
  const key = mode === 'counts-key' && shortfall ? 'wrong-key' : row.id;
  emit({type:'RECORD', stream:'items', key, data, op});
  if (mode === 'delete-undo' && row.is_deleted) emit({type:'RECORD',stream:'items',key:row.id,data,op:'upsert'});
  if (mode === 'text-undo' && controls) emit({type:'RECORD',stream:'items',key:row.id,data,op:'delete'});
}
const complete = mode === 'counts' || page.total_count === page.results.length;
emit({type:'DETAIL_COVERAGE', stream:'items', considered:page.total_count, covered:page.results.length});
if (complete) emit({type:'STATE', stream:'items', cursor:{completed:true}});
emit({type:'DONE',status:'succeeded'});
`,
	);
	const write = (value: unknown) =>
		writeFileSync(
			join(dir, "fixtures/submission-pilot.json"),
			JSON.stringify(value),
		);
	write(contract());
	return {
		root,
		write,
		remove: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("real protocol fixture passes all four shared assertions", () => {
	const fixture = checkout();
	try {
		const result = checkSubmissionBehavior(fixture.root, "example");
		assert.deepEqual(
			result.map((step) => step.verdict),
			["PASS", "PASS", "PASS", "PASS"],
		);
	} finally {
		fixture.remove();
	}
});

for (const name of ["refresh", "deletions", "text", "counts"]) {
	test(`shared assertion rejects the ${name} regression`, () => {
		const fixture = checkout(name);
		try {
			const result = checkSubmissionBehavior(fixture.root, "example");
			assert.equal(
				result.find((step) => step.name === `submission ${name}`)?.verdict,
				"FAIL",
			);
			assert.ok(
				result.some((step) => step.verdict === "PASS"),
				"negative control must reach the intended behavior",
			);
		} finally {
			fixture.remove();
		}
	});
}

test("missing, incomplete and static fixtures never become a pass", () => {
	const fixture = checkout();
	try {
		const input: Record<string, unknown> = contract();
		delete input.counts;
		fixture.write(input);
		assert.ok(
			checkSubmissionBehavior(fixture.root, "example").every(
				(step) => step.verdict === "FAIL",
			),
		);
		rmSync(
			join(fixture.root, "connectors/example/fixtures/submission-pilot.json"),
		);
		assert.ok(
			checkSubmissionBehavior(fixture.root, "example").every(
				(step) => step.verdict === "FAIL",
			),
		);
		assert.ok(
			checkSubmissionBehavior(fixture.root, "example", true).every(
				(step) => step.verdict === "UNKNOWN",
			),
		);
	} finally {
		fixture.remove();
	}
});

test("inapplicability is a visible advisory, never an executable pass", () => {
	const fixture = checkout();
	try {
		fixture.write({
			...contract(),
			counts: {
				not_applicable: {
					reason: "The provider exposes no source inventory total.",
					reference: "https://example.invalid/api-reference",
				},
			},
		});
		const result = checkSubmissionBehavior(fixture.root, "example");
		assert.equal(
			result.find((step) => step.name === "submission counts")?.verdict,
			"ADVISORY",
		);
		assert.match(
			result.find((step) => step.name === "submission counts")?.detail ?? "",
			/no source inventory total/,
		);
	} finally {
		fixture.remove();
	}
});

test("vacuous text and source-count fixtures cannot satisfy the gate", () => {
	const fixture = checkout();
	try {
		const input = contract();
		input.text.values = [
			{ stream: "items", key: "a", field: ["text"], source: "ordinary" },
		];
		input.text.responses = response({ id: "a", text: "ordinary" });
		input.counts.responses = response({ id: "a", text: "retained" });
		fixture.write(input);
		const result = checkSubmissionBehavior(fixture.root, "example");
		assert.equal(
			result.find((step) => step.name === "submission text")?.verdict,
			"FAIL",
		);
		assert.equal(
			result.find((step) => step.name === "submission counts")?.verdict,
			"FAIL",
		);
	} finally {
		fixture.remove();
	}
});

test("unexercised routes and undeclared network attempts fail closed", () => {
	const fixture = checkout();
	try {
		const input = contract();
		input.deletions.responses.push({
			url: "https://submission.invalid/never-visited",
			body: { results: [], total_count: 0 },
		});
		input.text.responses = [
			{
				url: "https://submission.invalid/different-source",
				body: { results: [{ id: "a", text: source }], total_count: 1 },
			},
		];
		fixture.write(input);
		const result = checkSubmissionBehavior(fixture.root, "example");
		assert.equal(
			result.find((step) => step.name === "submission deletions")?.verdict,
			"FAIL",
		);
		assert.equal(
			result.find((step) => step.name === "submission text")?.verdict,
			"FAIL",
		);
	} finally {
		fixture.remove();
	}
});

test("fixture environment cannot override Node loading or owner state", () => {
	const fixture = checkout();
	try {
		fixture.write({
			...contract(),
			environment: { NODE_OPTIONS: "--require=/outside" },
		});
		assert.ok(
			checkSubmissionBehavior(fixture.root, "example").every(
				(step) => step.verdict === "FAIL",
			),
		);
		assert.equal(
			readFileSync(join(fixture.root, "package.json"), "utf8"),
			'{"type":"module"}',
		);
	} finally {
		fixture.remove();
	}
});

for (const mode of ["socket", "subprocess"]) {
	test(`a caught forbidden ${mode} attempt cannot earn a fixture pass`, () => {
		const fixture = checkout(mode);
		try {
			const result = checkSubmissionBehavior(fixture.root, "example");
			assert.ok(result.every((step) => step.verdict === "FAIL"));
			assert.ok(
				result.every((step) => step.detail.includes("socket or subprocess")),
			);
		} finally {
			fixture.remove();
		}
	});
}

for (const [mode, finding] of [
	["counts-tombstone", "submission counts"],
	["counts-key", "submission counts"],
	["delete-undo", "submission deletions"],
	["text-delete", "submission text"],
	["text-undo", "submission text"],
]) {
	test(`review regression rejects ${mode}`, () => {
		const fixture = checkout(mode);
		try {
			const result = checkSubmissionBehavior(fixture.root, "example");
			assert.equal(
				result.find((step) => step.name === finding)?.verdict,
				"FAIL",
			);
			assert.ok(
				result
					.filter((step) => step.name !== finding)
					.every((step) => step.verdict === "PASS"),
			);
		} finally {
			fixture.remove();
		}
	});
}

test("non-API export and browser declarations do not acquire the fixture requirement", () => {
	const fixture = checkout();
	try {
		for (const bindings of [
			{ filesystem: { required: true } },
			{ browser: { required: true }, network: { required: true } },
			{ network: { required: false } },
		]) {
			writeFileSync(
				join(fixture.root, "connectors/example/manifest.json"),
				JSON.stringify({
					runtime_requirements: { bindings },
					streams: [{ name: "items" }],
				}),
			);
			assert.deepEqual(checkSubmissionBehavior(fixture.root, "example"), []);
			assert.deepEqual(
				checkSubmissionBehavior(fixture.root, "example", true),
				[],
			);
		}
	} finally {
		fixture.remove();
	}
});
