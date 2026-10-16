// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { selectMutationRanges as select } from "./select.mjs";

const index = "connectors/groupme/index.ts",
	schemas = "connectors/groupme/schemas.ts";
const change = (
	path = index,
	diff = "@@ -2 +2 @@\n-old\n+new\n",
	status = "M",
	extra = {},
) => ({ path, status, diff, ...extra });
const added = (start, count) =>
	"@@ -0,0 +" + start + "," + count + " @@\n" + "+line\n".repeat(count);
test("one-line defaults, addition, replacement and stable file order", () => {
	const result = select([change(schemas, added(1, 3), "A"), change()]);
	assert.deepEqual(result.mutate, [index + ":2-2", schemas + ":1-3"]);
	assert.equal(result.disposition, "selected");
	assert.deepEqual(
		result.files.map((f) => f.path),
		[index, schemas],
	);
});
test("coalesces adjacent/overlapping HEAD ranges and deduplicates ranges", () => {
	const diff =
		added(9, 2) + added(2, 2) + added(4, 1) + added(3, 1) + added(9, 2);
	assert.deepEqual(select([change(index, diff)]).mutate, [
		index + ":2-4",
		index + ":9-10",
	]);
});
test("deletion-only and deleted files never produce HEAD mutation targets", () => {
	const result = select([
		change(index, "@@ -1,2 +0,0 @@\n-a\n-b\n", "D"),
		change(schemas, "@@ -8 +7,0 @@\n-removed\n"),
	]);
	assert.equal(result.disposition, "no-applicable");
	assert.deepEqual(result.mutate, []);
	assert.deepEqual(
		result.files.map((f) => f.disposition),
		["deleted", "deletion-only"],
	);
});
test("empty/no-content-change records are explicit no-applicable", () => {
	assert.deepEqual(select([]), {
		disposition: "no-applicable",
		mutate: [],
		files: [],
	});
	assert.equal(
		select([change(index, "")]).files[0].disposition,
		"no-applicable",
	);
	assert.equal(
		select([change(index, "old mode 100644\nnew mode 100755\n")]).files[0]
			.disposition,
		"no-applicable",
	);
});
test("rename and copy mutate only existing supported HEAD path", () => {
	for (const status of ["R", "C"]) {
		const result = select([
			change(index, added(4, 1), status, { oldPath: "old source/file.ts" }),
		]);
		assert.deepEqual(result.mutate, [index + ":4-4"]);
		assert.equal(result.files[0].oldPath, "old source/file.ts");
	}
	assert.deepEqual(
		select([change("outside/new file.ts", "", "R", { oldPath: index })]).mutate,
		[],
	);
});
test("both rename/copy paths participate in production admission", () => {
	for (const status of ["R", "C"]) {
		for (const [path, oldPath] of [
			[index, "connectors/groupme/unknown.ts"],
			["connectors/groupme/unknown.ts", index],
		]) {
			const result = select([change(path, added(1, 1), status, { oldPath })]);
			assert.equal(result.disposition, "unsupported");
			assert.deepEqual(result.files[0].unsupportedPaths, [
				"connectors/groupme/unknown.ts",
			]);
			assert.deepEqual(result.mutate, []);
		}
	}
});
test("tests, fixtures and helper-only changes make no changed-code proof", () => {
	for (const path of [
		"connectors/groupme/index.test.ts",
		"connectors/groupme/__fixtures__/input.ts",
		"scripts/groupme-mutation/dispatch.mjs",
		"outside/path with spaces.ts",
	]) {
		const result = select([change(path)]);
		assert.equal(result.files[0].disposition, "scoped-out");
		assert.deepEqual(result.mutate, []);
	}
	assert.equal(
		select([change("connectors/groupme/new-production.ts")]).files[0]
			.disposition,
		"unsupported",
	);
});
test("mixed unsupported changes never claim complete supported selection", () => {
	const result = select([change(), change("connectors/groupme/new.ts")]);
	assert.equal(result.disposition, "unsupported");
	assert.deepEqual(result.mutate, [index + ":2-2"]);
});
test("accepts file prelude and no-final-newline markers without using header paths", () => {
	const diff =
		"diff --git a/name with spaces b/name with spaces\nindex abc..def 100644\n--- a/ignored\n+++ b/ignored\n" +
		"@@ -1 +1 @@ function heading\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
	assert.deepEqual(select([change(index, diff)]).mutate, [index + ":1-1"]);
});
test("rejects duplicate/inconsistent records rather than double counting", () => {
	for (const records of [
		[change(), change()],
		[change(index, "", "R", { oldPath: schemas }), change(schemas)],
		[
			change(index, "", "R", { oldPath: "old.ts" }),
			change(schemas, "", "R", { oldPath: "old.ts" }),
		],
	]) {
		assert.throws(() => select(records), /Invalid mutation selection input/);
	}
});
test("valid repeated copy source does not duplicate a HEAD record", () => {
	const result = select([
		change(index, added(1, 1), "C", { oldPath: "outside.ts" }),
		change(schemas, added(1, 1), "C", { oldPath: "outside.ts" }),
	]);
	assert.equal(result.mutate.length, 2);
});
for (const path of [
	"../x.ts",
	"/abs.ts",
	"C:/x.ts",
	"a\\b.ts",
	"a//b.ts",
	"./x",
	"x/../y",
	"x\nz",
	"x\0z",
	"x:*",
	"x[1].ts",
	" x.ts",
	"x.ts ",
]) {
	test("rejects unsafe path " + JSON.stringify(path), () => {
		assert.throws(() => select([change(path)]), /unsafe path/);
		assert.throws(
			() => select([change(index, "", "R", { oldPath: path })]),
			/unsafe path/,
		);
	});
}
test("rejects invalid record fields, statuses and rename/copy metadata", () => {
	for (const record of [
		null,
		[],
		{},
		change(index, "", "X"),
		change(index, "", "R"),
		change(index, "", "C"),
		change(index, "", "M", { oldPath: index }),
		change(index, "", "R", { oldPath: index }),
		{ ...change(), binary: true },
		{ ...change(), diff: null },
	]) {
		assert.throws(() => select([record]), /Invalid mutation selection input/);
	}
	assert.throws(() => select(null), /records must be an array/);
});
for (const diff of [
	"@@ -1 +1 @\n-a\n+b\n",
	"@@ -1 +1 @@\n-a\n",
	"@@ -1 +1 @@\n",
	"@@ -1 +1 @@\n context\n",
	"@@ -1 +1 @@\n-a\n+b\n+extra\n",
	"@@ -1 +0 @@\n-a\n+b\n",
	"@@ -1 +-2 @@\n-a\n+b\n",
	"@@ -1 +9007199254740992 @@\n-a\n+b\n",
	"@@ -1 +9007199254740991,2 @@\n-a\n+b\n+c\n",
	"@@ -0,0 +0,0 @@\n",
	"GIT binary patch\n",
	"junk\n",
	"@@ combined\n",
	"@@ -1 +1 @@\r\n-a\r\n+b\r\n",
	"\\ No newline at end of file\n",
]) {
	test(
		"fails closed on malformed diff " + JSON.stringify(diff.slice(0, 35)),
		() => {
			assert.throws(
				() => select([change(index, diff)]),
				/Invalid mutation selection input/,
			);
		},
	);
}
test("rejects status/hunk contradictions including deleted paths with additions", () => {
	assert.throws(
		() => select([change(index, "@@ -1 +1 @@\n-a\n+b\n", "A")]),
		/status contradicts/,
	);
	assert.throws(
		() => select([change(index, added(1, 1), "D")]),
		/status contradicts/,
	);
});
test("does not mutate caller input", () => {
	const records = [change(schemas), change()];
	const before = JSON.stringify(records);
	select(records);
	assert.equal(JSON.stringify(records), before);
});
