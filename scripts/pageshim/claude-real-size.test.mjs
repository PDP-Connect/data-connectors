// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildPageshim } from "./build.mjs";
import { runHarness } from "./harness.mjs";

const root = join(process.env.HOME, "Downloads", "exports");
const bundle = join(process.cwd(), ".scratch", "anthropic-0.2.14-local.1.js");

test("Claude real export ZIPs stay inside the shell bridge bound", {
	timeout: 300_000,
}, async () => {
	await buildPageshim({
		connector: "anthropic",
		outfile: bundle,
	});
	const fixture = await import("./fixtures/anthropic.mjs");
	const testCase = fixture.pageshimCase;
	const files = [
		"conversations-000.zip",
		"design_chats-000.zip",
		"projects-000.zip",
		"memories-000.zip",
		"light_metadata-000.zip",
	];
	let zipBytes = 0;
	let entries = 0;
	let rawBytes = 0;
	let peakBridgeUnits = 0;
	let chunkCalls = 0;
	for (const name of files) {
		const path = join(root, name);
		const archive = readFileSync(path);
		zipBytes += statSync(path).size;
		fixture.reset({ zip: archive });
		const result = await runHarness({
			bundle,
			fixtures: testCase.fixtures,
			scopes: testCase.scopes,
			resultStreaming: true,
		});
		assert.deepEqual(result.ret, { ok: true });
		assert.ok(result.maxBridgePayloadUnits <= 256 * 1024);
		assert.ok(result.archiveStats);
		entries += result.archiveStats.entries;
		rawBytes += result.archiveStats.rawBytes;
		peakBridgeUnits = Math.max(peakBridgeUnits, result.maxBridgePayloadUnits);
		chunkCalls += result.calls.readZipEntryChunk || 0;
	}
	assert.ok(chunkCalls > 0);
	console.log(
		`[claude-real-size] archives=${files.length} entries=${entries} zipBytes=${zipBytes} rawBytes=${rawBytes} chunkCalls=${chunkCalls} peakBridgeUnits=${peakBridgeUnits}`,
	);
});
