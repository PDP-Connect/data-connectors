// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { runHarness } from "./harness.mjs";

const root = join(process.cwd(), ".scratch", "pageshim-cleanup-test");
after(() => rm(root, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fixtureFor = (setLoggedIn = () => {}) => ({
	hosts: /^https:\/\/chatgpt\.test\//,
	resolve: () => ({
		status: 200,
		contentType: "text/html",
		body: "<html></html>",
	}),
	setLoggedIn,
	loginUrl: "https://chatgpt.test/login",
	homeUrl: "https://chatgpt.test/",
});

// A hand-written bundle: the harness runs the last top-level async IIFE.
async function writeBundle(name, body) {
	await mkdir(root, { recursive: true });
	const file = join(root, `${name}.js`);
	await writeFile(file, `(async () => {\n${body}\n})()\n`);
	return file;
}

// Navigating the runner page destroys its execution context, so the
// harness's runner.evaluate rejects instead of returning a result.
const evaluateFailureBundle = () =>
	writeBundle(
		"evaluate-failure",
		'location.href = "about:blank"; await new Promise(() => {});',
	);

test("a run that ends before loginAfterMs never signs in afterwards", async () => {
	const bundle = await evaluateFailureBundle();
	const calls = [];
	const fixtures = fixtureFor((value) => calls.push(value));
	await runHarness({
		bundle,
		fixtures,
		scopes: ["chatgpt.conversations"],
		loginAfterMs: 600,
	}).catch(() => {});
	const callsAtReturn = calls.length;
	await sleep(1000);
	assert.deepEqual(calls.slice(callsAtReturn), [], "late setLoggedIn call");
	assert.ok(!calls.includes(true), `setLoggedIn calls: ${calls}`);
});

test("a failed evaluation leaves no unhandled rejection from the heap sampler", async () => {
	const bundle = await evaluateFailureBundle();
	const unhandled = [];
	const listener = (reason) => unhandled.push(String(reason));
	process.on("unhandledRejection", listener);
	try {
		await runHarness({
			bundle,
			fixtures: fixtureFor(),
			scopes: ["chatgpt.conversations"],
			sampleHeap: true,
		}).catch(() => {});
		await sleep(300);
	} finally {
		process.off("unhandledRejection", listener);
	}
	assert.deepEqual(unhandled, []);
});

test("heap sampling is opt-in and reports undefined when off", async () => {
	const bundle = await writeBundle("noop", "");
	const off = await runHarness({
		bundle,
		fixtures: fixtureFor(),
		scopes: ["chatgpt.conversations"],
	});
	assert.equal(off.ret.ok, true);
	assert.equal(off.maxHeapBytes, undefined);
});

test("requests outside the fixture hosts are blocked and logged", async () => {
	let hits = 0;
	const server = createServer((_request, response) => {
		hits++;
		response.end("hit");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	// A navigation, since Chromium blocks page subrequests to loopback itself.
	try {
		const bundle = await writeBundle(
			"outside-request",
			`await page.goto("http://127.0.0.1:${port}/secret?token=abc");`,
		);
		const run = await runHarness({
			bundle,
			fixtures: fixtureFor(),
			scopes: ["chatgpt.conversations"],
		});
		assert.equal(run.ret.ok, true, run.log.join("\n"));
		assert.equal(hits, 0, "the outside server was reached");
		const blocked = run.log.filter((line) =>
			line.startsWith("[harness] blocked"),
		);
		assert.deepEqual(blocked, [
			`[harness] blocked request to http://127.0.0.1:${port}`,
		]);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});
