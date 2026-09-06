// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const names = [
	"parseOrdersListDom: local real fixture parses ≥5 orders with ids + dates",
	"parseOrderDetailDom: local real fixtures yield items and grand_total",
	"parseDashboardAccountsDom: local real capture parses ≥1 account",
	"parseStatementsListDom: local real capture parses ≥1 statement row",
	"parseCurrentActivityDom: local real capture — dashboard-accounts.html parses ≥1 MDS row",
	"parseModernCheckingEra: local statement text parses ≥1 txn (smoke)",
];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "accounting-runner-"));
	const cwd = join(root, "packages/polyfill-connectors");
	mkdirSync(join(cwd, "scripts"), { recursive: true });
	mkdirSync(join(root, "scripts/test-accounting"), { recursive: true });
	for (const name of ["receipt.ts", "node-reporter.ts"])
		cpSync(
			join(sourceRoot, "scripts/test-accounting", name),
			join(root, "scripts/test-accounting", name),
		);
	for (const name of ["run-tests.mjs", "test-diagnostics-reporter.mjs"])
		cpSync(
			join(sourceRoot, "packages/polyfill-connectors/scripts", name),
			join(cwd, "scripts", name),
		);
	symlinkSync(
		join(sourceRoot, "node_modules"),
		join(root, "node_modules"),
		"dir",
	);
	const paths = [
		"bin/a.test.ts",
		"connectors/example/b.test.ts",
		"scripts/related-tests/c.test.ts",
		"scripts/d.test.mjs",
		"src/e.test.ts",
	];
	for (const path of paths) {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(
			join(cwd, path),
			`import test from 'node:test'; test(${JSON.stringify(path)},()=>{});\n`,
		);
	}
	writeFileSync(
		join(cwd, paths[0]),
		`import test from 'node:test';\n${names.map((name) => `test(${JSON.stringify(name)},{skip:true},()=>{});`).join("\n")}\ntest('real assertion',()=>{});\n`,
	);
	const files = paths
		.map((path) => `packages/polyfill-connectors/${path}`)
		.sort();
	const issued = {
		schema: "pdpp.test-run-authority/v1",
		run_id: "fixture-run",
		nonce: "fixture-nonce",
		suite: "polyfill-connectors",
		profile: "default",
		cwd: "packages/polyfill-connectors",
		files,
	};
	writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
	const authority = join(root, "issued.json");
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const run = (value = issued, normal = false) => {
		writeFileSync(authority, JSON.stringify(value));
		return spawnSync(
			process.execPath,
			[
				"scripts/run-tests.mjs",
				...(normal ? [] : ["--accounting-authority", authority]),
			],
			{ cwd, env, encoding: "utf8", timeout: 20000 },
		);
	};
	return { root, cwd, paths, issued, authority, run };
}
function result(stdout) {
	const lines = stdout
		.split("\n")
		.filter((line) => line.startsWith("PDPP_TEST_ACCOUNTING_RESULT "));
	assert.equal(lines.length, 1);
	return JSON.parse(lines[0].slice("PDPP_TEST_ACCOUNTING_RESULT ".length));
}

test("authority and ordinary modes execute the same five-pattern real children and preserve exact counts", () => {
	const f = fixture();
	try {
		const ordinary = f.run(f.issued, true);
		assert.equal(ordinary.status, 0, ordinary.stderr);
		assert.match(ordinary.stdout, /tests 11/);
		const observed = f.run();
		assert.equal(observed.status, 0, observed.stderr);
		const value = result(observed.stdout);
		assert.deepEqual(value.files, f.issued.files);
		assert.equal(value.run_id, f.issued.run_id);
		assert.equal(value.nonce, f.issued.nonce);
		assert.deepEqual(
			{
				assertions: value.counts.assertions,
				passed: value.counts.passed,
				failed: value.counts.failed,
				skipped: value.counts.skipped,
			},
			{ assertions: 11, passed: 5, failed: 0, skipped: 6 },
		);
		const diagnostics = readFileSync(`${f.authority}.diagnostics.jsonl`, "utf8")
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.equal(diagnostics.filter((row) => row.type === "test").length, 11);
		assert.ok(
			diagnostics
				.filter((row) => row.type === "test")
				.every((row) => row.file?.startsWith("packages/polyfill-connectors/")),
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("zero, omitted, extra, duplicate, reordered selection and wrong profile reject before a child executes", () => {
	const f = fixture();
	try {
		writeFileSync(
			join(f.cwd, f.paths[1]),
			`import {writeFileSync} from 'node:fs';writeFileSync('SPAWNED','yes');`,
		);
		const selections = [
			[],
			f.issued.files.slice(1),
			[...f.issued.files, "extra.test.ts"],
			[...f.issued.files, f.issued.files[0]],
			[...f.issued.files].reverse(),
		];
		for (const files of selections) {
			const observed = f.run({ ...f.issued, files });
			assert.notEqual(observed.status, 0);
			assert.match(observed.stderr, /complete ordered selection/);
		}
		assert.notEqual(f.run({ ...f.issued, profile: "unknown" }).status, 0);
		assert.throws(() => readFileSync(join(f.cwd, "SPAWNED")), /ENOENT/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("the destination-authored consumed/configured join rejects a stale mapping after a real run", () => {
	const f = fixture();
	try {
		const path = join(f.cwd, f.paths[0]);
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace(
				JSON.stringify(names[0]),
				JSON.stringify("renamed fixture (skipped: fixture absent)"),
			),
		);
		const observed = f.run();
		assert.notEqual(observed.status, 0);
		assert.match(observed.stderr, /stale named skip mapping rows/);
		assert.ok(!observed.stdout.includes("PDPP_TEST_ACCOUNTING_RESULT "));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("real assertion failure, loader failure and signal cannot become a successful runner result", () => {
	const f = fixture();
	try {
		for (const source of [
			"import test from 'node:test';test('failure',()=>{throw Error('owning failure')});",
			"import './missing-module.mjs';",
			"process.kill(process.pid,'SIGTERM');",
		]) {
			writeFileSync(join(f.cwd, f.paths[1]), source);
			const observed = f.run();
			assert.notEqual(observed.status, 0);
			const value = result(observed.stdout);
			assert.ok(value.counts.failed > 0);
			assert.ok(value.counts.completed_files <= f.issued.files.length);
		}
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("diagnostics preserve nested sibling names, todo and cancellation from real children", () => {
	const f = fixture();
	try {
		const path = join(f.cwd, f.paths[1]);
		writeFileSync(
			path,
			`import {describe,it,test} from 'node:test';describe('a',{concurrency:true},()=>{it('same',async()=>{await new Promise(r=>setTimeout(r,15))});it.todo('later')});describe('b',()=>{it('same',()=>{});});test('cancelled',{timeout:30},()=>new Promise(()=>{}));`,
		);
		const observed = f.run();
		assert.notEqual(observed.status, 0);
		const rows = readFileSync(`${f.authority}.diagnostics.jsonl`, "utf8")
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.ok(rows.some((row) => row.full_name === "a > same"));
		assert.ok(rows.some((row) => row.full_name === "b > same"));
		assert.ok(rows.some((row) => row.todo === true));
		const summary = rows.findLast(
			(row) => row.event === "summary" && row.file === null,
		);
		assert.equal(summary.counts.todo, 1);
		assert.equal(summary.counts.cancelled, 1);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("missing or malformed accounting reporter output fails closed", () => {
	const f = fixture();
	try {
		const reporter = join(f.root, "scripts/test-accounting/node-reporter.ts");
		writeFileSync(
			reporter,
			"export default async function* reporter(source) { for await (const event of source) {} yield 'PDPP_TEST_ACCOUNTING_EVENT {broken\\n'; }\n",
		);
		const malformed = f.run();
		assert.notEqual(malformed.status, 0);
		assert.match(malformed.stderr, /malformed structured event/);
		assert.ok(!malformed.stdout.includes("PDPP_TEST_ACCOUNTING_RESULT "));
		rmSync(reporter);
		const missing = f.run();
		assert.notEqual(missing.status, 0);
		assert.ok(!missing.stdout.includes("PDPP_TEST_ACCOUNTING_RESULT "));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
