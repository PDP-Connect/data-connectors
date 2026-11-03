// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { buildPageshim } from "./build.mjs";
import { runHarness } from "./harness.mjs";

test("chunk remainder attribution and per-conversation timing stay bounded", {
	timeout: 120000,
}, async () => {
	await mkdir(".scratch", { recursive: true });
	const dir = await mkdtemp(join(process.cwd(), ".scratch", "timing-bounds-"));
	try {
		const bundle = join(dir, "bundle.js");
		await buildPageshim({
			connector: "chatgpt",
			entryPoint: new URL("./test-fixtures/timing-bounds.ts", import.meta.url)
				.pathname,
			outfile: bundle,
		});
		const fixtures = {
			hosts: /^https:\/\/chatgpt\.test\//,
			resolve: () => ({
				status: 200,
				contentType: "text/html",
				body: "<html></html>",
			}),
			setLoggedIn: () => {},
			loginUrl: "https://chatgpt.test/login",
			homeUrl: "https://chatgpt.test/",
		};
		const run = await runHarness({
			bundle,
			fixtures,
			scopes: ["chatgpt.messages"],
			resultStreaming: true,
			resultSpoolDirectory: join(dir, "spool"),
			fixtureReady: true,
		});
		assert.deepEqual(run.ret, { ok: true });
		assert.deepEqual(run.streamDone.errors, []);
		const records = JSON.parse(
			await readFile(run.streamScopeFiles["chatgpt.messages"], "utf8"),
		).records;
		assert.equal(records.length, 120);
		const logs = run.log.filter((x) => x.includes("[chatgpt-timing]"));
		assert.equal(logs.length, 81);
		const calls = (line) =>
			/bridgeCalls=(.*?) bridgeBytes=/.exec(line)[1].split("|").filter(Boolean);
		for (const line of logs.slice(0, 80)) {
			assert.ok(
				calls(line).filter((x) => x.startsWith("setData(result:chunk)"))
					.length <= 2,
				"a completed conversation remained in later chunk attribution",
			);
		}
		assert.ok(
			logs.every((line) => calls(line).length <= 32),
			"stored diagnostic strings exceed the cap",
		);
		assert.match(logs.at(-1), /bridgeCallsOmitted=[1-9]\d*/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
