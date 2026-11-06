// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildPageshim } from "./build.mjs";
import { runHarness } from "./harness.mjs";

const root = join(process.cwd(), ".scratch", "pageshim-record-ops-test");
after(() => rm(root, { recursive: true, force: true }));

const fixtures = {
	hosts: /^https:\/\/chatgpt\.test\//,
	resolve: () => ({ status: 200, contentType: "text/html", body: "<html></html>" }),
	setLoggedIn: () => {},
	loginUrl: "https://chatgpt.test/login",
	homeUrl: "https://chatgpt.test/",
};
const ALL = ["conversations", "memories", "projects", "tags", "notes"];

async function run(scenario, hostCapabilities, initialState = {}) {
	await mkdir(root, { recursive: true });
	const name = `${scenario}-${(hostCapabilities ?? ["none"]).join("+")}-${Object.keys(initialState).length}`;
	const bundle = join(root, `${name}.js`);
	await buildPageshim({
		connector: "chatgpt",
		entryPoint: new URL("./test-fixtures/record-ops-runtime.ts", import.meta.url).pathname,
		outfile: bundle,
		extraDefines: { PAGESHIM_OPS_SCENARIO: JSON.stringify(scenario) },
	});
	const result = await runHarness({
		bundle,
		fixtures,
		scopes: ALL.map((s) => `chatgpt.${s}`),
		initialState,
		resultStreaming: true,
		hostCapabilities,
		resultSpoolDirectory: join(root, `spool-${name}`),
	});
	assert.deepEqual(result.stubHits, [], "runtime used no missing shim members");
	return result;
}

const scopeRecords = async (result, stream) => {
	const file = result.streamScopeFiles[`chatgpt.${stream}`];
	return file === undefined ? undefined : JSON.parse(await readFile(file, "utf8")).records;
};

test("record-ops: a delete goes to delete:<stream> and never into result:*", { timeout: 60_000 }, async () => {
	const result = await run("mixed", ["record-ops"]);
	assert.deepEqual(result.deletes, { conversations: [{ id: "c2" }] });
	assert.deepEqual((await scopeRecords(result, "conversations")).map((r) => r.id), ["c1"]);
});

test("without record-ops: output has no delete:* and no covered, and the delete-shaped row stays a plain record", { timeout: 60_000 }, async () => {
	const result = await run("mixed", undefined);
	assert.deepEqual(result.deletes, {});
	assert.ok(!("covered" in result.streamDone));
	assert.deepEqual((await scopeRecords(result, "conversations")).map((r) => r.id), ["c1", "c2"]);
});

test("record-ops: a host that lists other capabilities only gets today's output", { timeout: 60_000 }, async () => {
	const result = await run("mixed", ["something-else"]);
	assert.deepEqual(result.deletes, {});
	assert.ok(!("covered" in result.streamDone));
});

test("record-ops: result:done.covered excludes skipped, detail-gap and empty streams; includes live and confirmed-empty", { timeout: 60_000 }, async () => {
	const result = await run("mixed", ["record-ops"]);
	assert.deepEqual([...result.streamDone.covered].sort(), ["conversations", "tags"]);
});

test("record-ops: an incremental stream with no new rows is covered; a skipped one is not", { timeout: 60_000 }, async () => {
	const result = await run("mixed", ["record-ops"], {
		"chatgpt.notes": { c: 1 },
		"chatgpt.memories": { c: 1 },
	});
	assert.deepEqual([...result.streamDone.covered].sort(), ["conversations", "notes", "tags"]);
});

test("record-ops: withheld records stay out of result:*, and a windowed stream still covers its kept rows", { timeout: 60_000 }, async () => {
	const result = await run("windowed", ["record-ops"]);
	assert.deepEqual((await scopeRecords(result, "conversations")).map((r) => r.id), ["kept"]);
	assert.deepEqual(result.streamDone.covered, ["conversations"]);
	assert.deepEqual(result.deletes, {});
});
