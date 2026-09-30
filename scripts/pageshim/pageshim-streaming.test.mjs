// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildPageshim } from "./build.mjs";
import { runHarness } from "./harness.mjs";
import { ResultStreamHarness } from "./result-stream-harness.mjs";

const root = join(process.cwd(), ".scratch", "pageshim-streaming-test");
const entryPoint = new URL(
	"./test-fixtures/streaming-runtime.ts",
	import.meta.url,
).pathname;
after(() => rm(root, { recursive: true, force: true }));

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

const assertCleanRun = (run) =>
	assert.deepEqual(
		run.stubHits,
		[],
		"runtime used no missing shim members or Node stubs",
	);

async function buildSyntheticBundle(
	recordCount,
	streamResults,
	swallowEmitErrors = false,
	surrogateEdge = false,
	serializeError = false,
	partialResult = false,
	negativeHeapControl = false,
	evaluateResultMiB = 0,
	recordTextUnits = 100_000,
	bridgeCallTimeoutMs = 30_000,
) {
	await mkdir(root, { recursive: true });
	const outfile = join(root, `stream-${recordCount}-${streamResults}.js`);
	await buildPageshim({
		connector: "strava_browser",
		entryPoint,
		outfile,
		minify: true,
		streamResults,
		bridgeCallTimeoutMs,
		extraDefines: {
			PAGESHIM_SYNTHETIC_RECORD_COUNT: String(recordCount),
			PAGESHIM_SWALLOW_EMIT_ERRORS: String(swallowEmitErrors),
			PAGESHIM_SURROGATE_EDGE: String(surrogateEdge),
			PAGESHIM_SERIALIZE_ERROR: String(serializeError),
			PAGESHIM_PARTIAL_RESULT: String(partialResult),
			PAGESHIM_NEGATIVE_HEAP_CONTROL: String(negativeHeapControl),
			PAGESHIM_EVALUATE_RESULT_MIB: String(evaluateResultMiB),
			PAGESHIM_SYNTHETIC_RECORD_TEXT_UNITS: String(recordTextUnits),
		},
	});
	return outfile;
}

function sha256File(path) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const input = createReadStream(path);
		input.on("data", (chunk) => hash.update(chunk));
		input.on("error", reject);
		input.on("end", () => resolve(hash.digest("hex")));
	});
}

test("result stream accepts ordered chunks and an identical last-sequence retry", async () => {
	await mkdir(join(process.cwd(), ".scratch"), { recursive: true });
	const directory = await mkdtemp(
		join(process.cwd(), ".scratch/pageshim-stream-"),
	);
	const host = new ResultStreamHarness({
		approvedScopes: ["chatgpt.conversations"],
		directory,
	});
	try {
		await host.setData("result:begin", {
			scope: "chatgpt.conversations",
			traceId: "run-1",
		});
		await host.setData("result:chunk", {
			scope: "chatgpt.conversations",
			sequence: 0,
			text: '[{"text":"hello 😀"}',
			traceId: "run-1",
		});
		await assert.rejects(
			host.setData("result:chunk", {
				scope: "chatgpt.conversations",
				sequence: 0,
				text: "changed retry",
			}),
		);
		await host.setData("result:chunk", {
			scope: "chatgpt.conversations",
			sequence: 0,
			text: '[{"text":"hello 😀"}',
		});
		await host.setData("result:chunk", {
			scope: "chatgpt.conversations",
			sequence: 1,
			text: "]",
		});
		await host.setData("result:scope-done", {
			scope: "chatgpt.conversations",
			chunkCount: 2,
		});
		await host.setData("result:done", { scopeCount: 1 });

		assert.equal(
			await readFile(host.scopeFile("chatgpt.conversations"), "utf8"),
			'[{"text":"hello 😀"}]',
		);
		assert.equal(host.summary().totalCodeUnits, 21);
	} finally {
		await host.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});

test("result stream rejects malformed order, mixed protocols, and split surrogates", async () => {
	await mkdir(join(process.cwd(), ".scratch"), { recursive: true });
	const directory = await mkdtemp(
		join(process.cwd(), ".scratch/pageshim-stream-"),
	);
	const host = new ResultStreamHarness({
		approvedScopes: ["chatgpt.conversations"],
		directory,
	});
	try {
		await host.setData("result:begin", { scope: "chatgpt.conversations" });
		await assert.rejects(
			host.setData("result:chunk", {
				scope: "chatgpt.conversations",
				sequence: 0,
				text: `x${String.fromCharCode(0xd83d)}`,
			}),
		);
		await assert.rejects(
			host.setData("result:chunk", {
				scope: "chatgpt.conversations",
				sequence: 0,
				text: "x".repeat(256 * 1024 + 1),
			}),
		);
		await assert.rejects(
			host.setData("result:chunk", {
				scope: "chatgpt.conversations",
				sequence: 1,
				text: "gap",
			}),
		);
		await assert.rejects(host.setData("result", "{}"));
	} finally {
		await host.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});

test("build-time default keeps the legacy result path for bounded results", {
	timeout: 180_000,
}, async () => {
	const bundle = await buildSyntheticBundle(1, false);
	const run = await runHarness({
		bundle,
		fixtures,
		scopes: ["chatgpt.conversations", "chatgpt.messages"],
	});
	assert.equal(run.ret.ok, true);
	assert.equal(run.streamResult, null);
	assert.equal(run.result["chatgpt.conversations"].records.length, 1);
	assert.equal(run.result["chatgpt.messages"].records.length, 1);
	assertCleanRun(run);
});

test("runtime chunking keeps an astral character intact at the size boundary", {
	timeout: 180_000,
}, async () => {
	const bundle = await buildSyntheticBundle(1, true, false, true);
	const spoolDirectory = join(root, "spool-surrogate-edge");
	try {
		const run = await runHarness({
			bundle,
			fixtures,
			scopes: ["chatgpt.conversations", "chatgpt.messages"],
			resultStreaming: true,
			resultSpoolDirectory: spoolDirectory,
		});
		assert.equal(run.ret.ok, true, run.log.slice(-20).join("\n"));
		assert.ok(run.streamResult.maxChunkUnits <= 256 * 1024);
		const scope = JSON.parse(
			await readFile(run.streamScopeFiles["chatgpt.messages"], "utf8"),
		);
		assert.equal(scope.records[0].text, `${"x".repeat(262_134)}😀z`);
		assertCleanRun(run);
	} finally {
		await rm(spoolDirectory, { recursive: true, force: true });
	}
});

test("a shell that never acknowledges a result call fails with a timeout", {
	timeout: 180_000,
}, async () => {
	const bundle = await buildSyntheticBundle(
		1, true, false, false, false, false, false, 0, 100_000, 50,
	);
	const run = await runHarness({
		bundle,
		fixtures,
		scopes: ["chatgpt.conversations", "chatgpt.messages"],
		resultStreaming: true,
		resultStreamNeverAck: true,
		resultSpoolDirectory: join(root, "spool-never-ack"),
	});
	assert.equal(run.data.error, "PageShim bridge call setData timed out after 50ms");
	assert.ok(run.elapsedMs < 5_000, `run took ${run.elapsedMs}ms`);
	assertCleanRun(run);
});

test("build-time streaming bounds each transfer while spooling a 150 MB result", {
	timeout: 600_000,
}, async () => {
	const recordCount = 1500;
	const bundle = await buildSyntheticBundle(recordCount, true);
	const spoolDirectory = join(root, "spool-150mb");
	try {
		const run = await runHarness({
			bundle,
			fixtures,
			scopes: ["chatgpt.conversations", "chatgpt.messages"],
			resultStreaming: true,
			resultSpoolDirectory: spoolDirectory,
		});
		assert.equal(run.ret.ok, true, run.log.slice(-20).join("\n"));
		assertCleanRun(run);
		assert.equal(run.result, null);
		assert.equal(run.streamResult.mode, "stream");
		assert.equal(run.streamResult.scopeCount, 2);
		assert.equal(run.streamResult.rejectedMessages, 0);
		assert.equal(run.streamResult.completed, true);
		assert.ok(run.streamResult.totalCodeUnits > 150_000_000);
		assert.ok(run.streamResult.maxChunkUnits <= 256 * 1024);
		assert.ok(run.maxHeapBytes < 64 * 1024 * 1024);
		assert.deepEqual(Object.keys(run.streamScopeFiles), [
			"chatgpt.messages",
			"chatgpt.conversations",
		]);

		const record = JSON.stringify({ text: "x".repeat(100_000) });
		const expected = createHash("sha256");
		expected.update('{"records":[');
		for (let i = 0; i < recordCount; i++) {
			if (i > 0) expected.update(",");
			expected.update(record);
		}
		expected.update("]}");
		assert.equal(
			await sha256File(run.streamScopeFiles["chatgpt.messages"]),
			expected.digest("hex"),
		);
		assert.equal(
			await readFile(run.streamScopeFiles["chatgpt.conversations"], "utf8"),
			JSON.stringify({
				records: Array.from({ length: recordCount }, (_, id) => ({ id })),
			}),
		);
	} finally {
		await rm(spoolDirectory, { recursive: true, force: true });
	}
});

test("CDP heap sampling catches a retained allocation above the streaming bound", {
	timeout: 180_000,
}, async () => {
	const bundle = await buildSyntheticBundle(
		2,
		true,
		false,
		false,
		false,
		false,
		true,
	);
	const spoolDirectory = join(root, "spool-heap-control");
	try {
		const run = await runHarness({
			bundle,
			fixtures,
			scopes: ["chatgpt.conversations", "chatgpt.messages"],
			resultStreaming: true,
			resultSpoolDirectory: spoolDirectory,
		});
		assert.ok(
			run.maxHeapBytes > 64 * 1024 * 1024,
			`sampled heap was ${run.maxHeapBytes} bytes`,
		);
	} finally {
		await rm(spoolDirectory, { recursive: true, force: true });
	}
});

test("a 60 MiB single conversation crosses the bridge only in bounded pieces", {
	timeout: 180_000,
}, async () => {
	const bundle = await buildSyntheticBundle(
		0,
		true,
		false,
		false,
		false,
		false,
		false,
		60,
	);
	const spoolDirectory = join(root, "spool-large-evaluate-result");
	try {
		const run = await runHarness({
			bundle,
			fixtures,
			scopes: ["chatgpt.conversations", "chatgpt.messages"],
			resultStreaming: true,
			resultSpoolDirectory: spoolDirectory,
		});
		assert.equal(run.ret.ok, true, run.log.slice(-20).join("\n"));
		assert.equal(run.streamResult.completed, true);
		assert.ok(run.bridgeCallCount > 900);
		assert.ok(run.maxBridgePayloadUnits <= 256 * 1024);
		const conversations = JSON.parse(
			await readFile(run.streamScopeFiles["chatgpt.conversations"], "utf8"),
		);
		assert.deepEqual(conversations.records, [
			{
				id: "synthetic-60mb-conversation",
				messageCharacters: 60 * 1024 * 1024,
			},
		]);
	} finally {
		await rm(spoolDirectory, { recursive: true, force: true });
	}
});

test("an evaluation result above the per-item bound fails with a clear error", {
	timeout: 180_000,
}, async () => {
	const bundle = await buildSyntheticBundle(
		0,
		true,
		false,
		false,
		false,
		false,
		false,
		65,
	);
	const spoolDirectory = join(root, "spool-oversized-evaluate-result");
	try {
		const run = await runHarness({
			bundle,
			fixtures,
			scopes: ["chatgpt.conversations", "chatgpt.messages"],
			resultStreaming: true,
			resultSpoolDirectory: spoolDirectory,
		});
		assert.equal(run.ret.ok, true);
		assert.match(
			run.data.error,
			/PageShim evaluation result .* per-item limit/,
		);
		assert.ok(run.maxBridgePayloadUnits <= 256 * 1024);
		assert.equal(run.streamResult, null);
	} finally {
		await rm(spoolDirectory, { recursive: true, force: true });
	}
});

test("a rejected stream chunk is terminal and is not retried", {
	timeout: 180_000,
}, async () => {
	const bundle = await buildSyntheticBundle(3, true);
	const spoolDirectory = join(root, "spool-terminal-error");
	try {
		const run = await runHarness({
			bundle,
			fixtures,
			scopes: ["chatgpt.conversations", "chatgpt.messages"],
			resultStreaming: true,
			resultSpoolDirectory: spoolDirectory,
			resultStreamFailure: { key: "result:chunk", sequence: 0 },
		});
		assert.equal(run.result, null);
		assert.equal(run.data.error, "simulated result protocol rejection");
		assert.equal(run.streamResult.completed, false);
		assert.equal(run.streamResult.rejectedMessages, 1);
		assert.equal(run.streamResult.messageCount, 2);
		assertCleanRun(run);
	} finally {
		await rm(spoolDirectory, { recursive: true, force: true });
	}
});

test("a collector cannot swallow a rejected chunk and complete a partial scope", {
	timeout: 180_000,
}, async () => {
	const bundle = await buildSyntheticBundle(3, true, true);
	const spoolDirectory = join(root, "spool-swallowed-error");
	try {
		const run = await runHarness({
			bundle,
			fixtures,
			scopes: ["chatgpt.conversations", "chatgpt.messages"],
			resultStreaming: true,
			resultSpoolDirectory: spoolDirectory,
			resultStreamFailure: { key: "result:chunk", sequence: 0 },
		});
		assert.equal(run.data.error, "simulated result protocol rejection");
		assert.equal(run.streamResult.completed, false);
		assert.equal(run.streamResult.rejectedMessages, 1);
		assert.equal(run.streamResult.messageCount, 2);
	} finally {
		await rm(spoolDirectory, { recursive: true, force: true });
	}
});

test("a collector cannot swallow a record serialization error and complete invalid JSON", {
	timeout: 180_000,
}, async () => {
	const bundle = await buildSyntheticBundle(3, true, true, false, true);
	const spoolDirectory = join(root, "spool-serialization-error");
	try {
		const run = await runHarness({
			bundle,
			fixtures,
			scopes: ["chatgpt.conversations", "chatgpt.messages"],
			resultStreaming: true,
			resultSpoolDirectory: spoolDirectory,
		});
		assert.equal(run.data.error, "Do not know how to serialize a BigInt");
		assert.equal(run.streamResult.completed, false);
		assert.ok(run.streamResult.totalCodeUnits > 100_000);
		const partial = await readFile(
			run.streamScopeFiles["chatgpt.messages"],
			"utf8",
		);
		assert.equal(
			partial,
			`{"records":[${JSON.stringify({ text: "x".repeat(100_000) })}`,
		);
		assert.doesNotMatch(partial, /,,/);
		assertCleanRun(run);
	} finally {
		await rm(spoolDirectory, { recursive: true, force: true });
	}
});

test("streamed collection errors set a partial status", {
	timeout: 180_000,
}, async () => {
	const bundle = await buildSyntheticBundle(2, true, false, false, false, true);
	const spoolDirectory = join(root, "spool-partial-result");
	try {
		const run = await runHarness({
			bundle,
			fixtures,
			scopes: ["chatgpt.conversations", "chatgpt.messages"],
			resultStreaming: true,
			resultSpoolDirectory: spoolDirectory,
		});
		assert.equal(run.streamResult.completed, true);
		assert.equal(run.data.status, "Partial: 2 conversations");
	} finally {
		await rm(spoolDirectory, { recursive: true, force: true });
	}
});

test("the browser harness rejects both orders of mixed result protocols", {
	timeout: 180_000,
}, async () => {
	const mixedEntry = new URL(
		"./test-fixtures/protocol-mixed.ts",
		import.meta.url,
	).pathname;
	for (const legacyFirst of [true, false]) {
		const outfile = join(root, `protocol-mixed-${legacyFirst}.js`);
		await buildPageshim({
			connector: "strava_browser",
			entryPoint: mixedEntry,
			outfile,
			streamResults: true,
			extraDefines: { PAGESHIM_LEGACY_FIRST: String(legacyFirst) },
		});
		const run = await runHarness({
			bundle: outfile,
			fixtures,
			scopes: ["chatgpt.conversations"],
			resultStreaming: true,
			resultSpoolDirectory: join(root, `spool-mixed-${legacyFirst}`),
		});
		assert.deepEqual(run.ret, {
			ok: false,
			error: "cannot mix result protocols",
		});
	}
});
