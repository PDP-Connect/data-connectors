// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `makeRecordingEmit` — the shared test harness every
 * connector integration test uses to fake emit/emitRecord.
 *
 * Three modes matter:
 *   1. Pass-through (no validator) — records land in `.emitted` verbatim.
 *   2. Validating — passing records land in `.emitted`; failing records
 *      land in `.skipped` (same semantics as the runtime's RECORD path).
 *   3. Protocol side-channel — `.emit()` captures every non-RECORD
 *      EmittedMessage (PROGRESS, STATE, SKIP_RESULT, INTERACTION) so
 *      tests can assert on the full protocol, not just records.
 *
 * If this file regresses, every integration test downstream is fibbing.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertUserFacingProgress } from "./connector-diagnostic.ts";
import { packageRoot as PACKAGE_ROOT } from "./connector-paths.ts";
import {
	type EmittedMessage,
	politeDelay,
	type ValidateRecord,
} from "./connector-runtime.ts";
import {
	makeRecordingEmit,
	runConnectorProtocolSubprocess,
	skipPoliteDelays,
} from "./test-harness.ts";

const fixturePath = (name: string): string =>
	join(PACKAGE_ROOT, "src", "test-fixtures", name);

// ─── Pass-through mode ───────────────────────────────────────────────────

test("makeRecordingEmit: pass-through mode — records land in .emitted verbatim", async () => {
	const h = makeRecordingEmit();
	await h.emitRecord("orders", { id: "ord-1", total: 42 });
	await h.emitRecord("orders", { id: "ord-2", total: 99 });

	assert.equal(h.emitted.length, 2);
	assert.deepEqual(h.emitted[0], {
		stream: "orders",
		data: { id: "ord-1", total: 42 },
	});
	assert.deepEqual(h.emitted[1], {
		stream: "orders",
		data: { id: "ord-2", total: 99 },
	});
	assert.equal(h.skipped.length, 0, "pass-through mode never skips");
});

// ─── Validating mode ─────────────────────────────────────────────────────

/** A tiny validator: the `orders` stream requires a positive-integer `id`. */
const validateHasId: ValidateRecord = (_stream, data) => {
	if (typeof data.id === "string" && data.id.length > 0) {
		return { ok: true, data };
	}
	return {
		ok: false,
		issues: [{ path: "id", message: "id must be a non-empty string" }],
	};
};

test("makeRecordingEmit: validating mode — passing records land in .emitted", async () => {
	const h = makeRecordingEmit(validateHasId);
	await h.emitRecord("orders", { id: "ord-1" });
	await h.emitRecord("orders", { id: "ord-2" });

	assert.equal(h.emitted.length, 2);
	assert.equal(h.skipped.length, 0);
	assert.deepEqual(
		h.emitted.map((e) => e.data.id),
		["ord-1", "ord-2"],
	);
});

test("makeRecordingEmit: validating mode — failing records land in .skipped with issues", async () => {
	const h = makeRecordingEmit(validateHasId);
	await h.emitRecord("orders", { id: "" });
	await h.emitRecord("orders", { id: 42 });

	assert.equal(h.emitted.length, 0, "neither record passes shape-check");
	assert.equal(h.skipped.length, 2);
	assert.equal(h.skipped[0]?.stream, "orders");
	assert.deepEqual(h.skipped[0]?.issues, [
		{ path: "id", message: "id must be a non-empty string" },
	]);
});

test("makeRecordingEmit: validating mode — mixed pass + fail are partitioned correctly", async () => {
	const h = makeRecordingEmit(validateHasId);
	await h.emitRecord("orders", { id: "ord-1" });
	await h.emitRecord("orders", { id: "" });
	await h.emitRecord("orders", { id: "ord-3" });

	assert.equal(h.emitted.length, 2, "two good records");
	assert.equal(h.skipped.length, 1, "one bad record");
	assert.deepEqual(
		h.emitted.map((e) => e.data.id),
		["ord-1", "ord-3"],
	);
});

// ─── Protocol side-channel ───────────────────────────────────────────────

test("makeRecordingEmit: emit() side-channel captures PROGRESS / STATE / SKIP_RESULT / INTERACTION", async () => {
	const h = makeRecordingEmit();
	const progress: EmittedMessage = { type: "PROGRESS", message: "working" };
	const state: EmittedMessage = {
		type: "STATE",
		stream: "orders",
		cursor: { last: "ord-1" },
	};
	const skip: EmittedMessage = {
		type: "SKIP_RESULT",
		stream: "orders",
		reason: "http_error",
		message: "404",
	};
	const interaction: EmittedMessage = {
		type: "INTERACTION",
		request_id: "int_1",
		kind: "otp",
		message: "enter code",
	};

	await h.emit(progress);
	await h.emit(state);
	await h.emit(skip);
	await h.emit(interaction);

	assert.equal(h.protocolMessages.length, 4);
	assert.equal(h.protocolMessages[0], progress);
	assert.equal(h.protocolMessages[1], state);
	assert.equal(h.protocolMessages[2], skip);
	assert.equal(h.protocolMessages[3], interaction);
});

test("makeRecordingEmit: emit() + emitRecord() populate separate buffers (no cross-talk)", async () => {
	const h = makeRecordingEmit();
	await h.emitRecord("orders", { id: "ord-1" });
	await h.emit({ type: "PROGRESS", message: "hello" });
	await h.emitRecord("orders", { id: "ord-2" });

	assert.equal(h.emitted.length, 2, "records go to .emitted only");
	assert.equal(
		h.protocolMessages.length,
		1,
		"protocol messages go to .protocolMessages only",
	);
});

// ─── Unified events trace ────────────────────────────────────────────────

test("makeRecordingEmit: .events captures emit + emitRecord in call order", async () => {
	const h = makeRecordingEmit();
	await h.emitRecord("orders", { id: "ord-1" });
	await h.emit({ type: "PROGRESS", message: "halfway" });
	await h.emitRecord("orders", { id: "ord-2" });
	await h.emit({ type: "STATE", stream: "orders", cursor: { n: 2 } });

	assert.equal(h.events.length, 4);
	assert.equal(h.events[0]?.kind, "record");
	assert.equal(h.events[1]?.kind, "message");
	assert.equal(h.events[2]?.kind, "record");
	assert.equal(h.events[3]?.kind, "message");
	const [, , , ev3] = h.events;
	if (ev3?.kind === "message" && ev3.message.type === "STATE") {
		assert.equal(ev3.message.stream, "orders");
	} else {
		assert.fail("expected last event to be a STATE message");
	}
});

test("makeRecordingEmit: .events proves STATE lands AFTER last record (cross-kind ordering)", async () => {
	// This is the shape of assertion the chatgpt cursor proof now uses.
	// If an orchestration helper accidentally advances STATE between
	// records, this assertion fails — which the old split-array design
	// couldn't see.
	const h = makeRecordingEmit();
	await h.emitRecord("orders", { id: "ord-1" });
	await h.emitRecord("orders", { id: "ord-2" });
	await h.emit({ type: "STATE", stream: "orders", cursor: { n: 2 } });

	const lastRecordIdx = h.events.findLastIndex((e) => e.kind === "record");
	const stateIdx = h.events.findIndex(
		(e) =>
			e.kind === "message" &&
			e.message.type === "STATE" &&
			e.message.stream === "orders",
	);
	assert.notEqual(lastRecordIdx, -1);
	assert.notEqual(stateIdx, -1);
	assert.ok(
		stateIdx > lastRecordIdx,
		"STATE must land strictly after the last record",
	);
});

test("makeRecordingEmit: .events records validation failures with kind='record-skipped'", async () => {
	const validateRecord: ValidateRecord = (_stream, data) => {
		if (!data.id) {
			return { ok: false, issues: [{ path: "id", message: "required" }] };
		}
		return { ok: true, data };
	};
	const h = makeRecordingEmit(validateRecord);
	await h.emitRecord("orders", { id: "ok" });
	await h.emitRecord("orders", { total: 10 }); // missing id → skipped

	assert.equal(h.events.length, 2);
	assert.equal(h.events[0]?.kind, "record");
	assert.equal(h.events[1]?.kind, "record-skipped");
});

// ─── Subprocess protocol harness ────────────────────────────────────────

test("runConnectorProtocolSubprocess: non-browser fixture completes START to DONE over stdio", async () => {
	const result = await runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: fixturePath("protocol-subprocess-non-browser.ts"),
		start: { type: "START", scope: { streams: [{ name: "items" }] } },
	});

	assert.equal(result.code, 0);
	// The skip count goes to the run log; the owner sees plain text.
	assert.equal(
		result.stderr.trim(),
		'[runtime-diagnostic] shape_check_skipped {"records":1}',
	);

	const types = result.messages.map((m) => m.type);
	assert.deepEqual(types, [
		"PROGRESS",
		"RECORD",
		"SKIP_RESULT",
		"STATE",
		"PROGRESS",
		"DONE",
	]);
	const summary = result.messages.at(-2);
	assert.equal(summary?.type, "PROGRESS");
	if (summary?.type === "PROGRESS") {
		assert.equal(summary.message, "Skipped 1 item that could not be read");
	}
	assertUserFacingProgress(result.messages);

	const record = result.messages.find(
		(m): m is Extract<EmittedMessage, { type: "RECORD" }> =>
			m.type === "RECORD",
	);
	assert.ok(record);
	assert.equal(record.stream, "items");
	assert.equal(record.key, "item-1");

	const skip = result.messages.find(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT",
	);
	assert.ok(skip, "invalid fixture row should become a runtime SKIP_RESULT");
	assert.equal(skip.reason, "shape_check_failed");

	const done = result.messages.at(-1);
	assert.equal(done?.type, "DONE");
	if (done?.type === "DONE") {
		assert.equal(done.status, "succeeded");
		assert.equal(done.records_emitted, 1);
	}
});

test("runConnectorProtocolSubprocess: browser-shaped no-browser fixture completes without launching Playwright", async () => {
	const result = await runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: fixturePath("protocol-subprocess-browser-shaped.ts"),
		start: {
			type: "START",
			scope: { streams: [{ name: "orders" }, { name: "order_details" }] },
		},
	});

	assert.equal(result.code, 0);
	assert.equal(result.messages.at(-1)?.type, "DONE");
	assert.ok(
		result.messages.some(
			(m) => m.type === "SKIP_RESULT" && m.stream === "order_details",
		),
		"browser-shaped fixture should report the deferred detail path without live browser work",
	);
	assert.ok(
		result.messages.some((m) => m.type === "RECORD" && m.stream === "orders"),
		"browser-shaped fixture should still emit the parent list record",
	);
});

test("runConnectorProtocolSubprocess: rejects a child that exits without terminal DONE", async () => {
	await assert.rejects(
		() =>
			runConnectorProtocolSubprocess({
				cwd: PACKAGE_ROOT,
				entrypoint: fixturePath("protocol-subprocess-bad-no-done.ts"),
				start: { type: "START", scope: { streams: [{ name: "items" }] } },
			}),
		/exited without DONE/,
	);
});

test("runConnectorProtocolSubprocess: timeout kills the connector's grandchild", {
	skip: process.platform !== "linux",
}, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "connector-subprocess-"));
	const pidFile = join(tempDir, "grandchild.pid");
	const entrypoint = join(tempDir, "leaking-connector.mjs");
	const marker = `connector-grandchild-${randomUUID()}`;
	await writeFile(
		entrypoint,
		[
			'import { spawn } from "node:child_process";',
			'import { writeFileSync } from "node:fs";',
			'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", process.env.GRANDCHILD_MARKER], { stdio: "ignore" });',
			"writeFileSync(process.env.GRANDCHILD_PID_FILE, String(child.pid));",
			"setInterval(() => {}, 1000);",
		].join("\n"),
	);

	let grandchildPid: number | undefined;
	try {
		await assert.rejects(
			() =>
				runConnectorProtocolSubprocess({
					cwd: PACKAGE_ROOT,
					entrypoint,
					env: { GRANDCHILD_MARKER: marker, GRANDCHILD_PID_FILE: pidFile },
					start: {
						type: "START",
						scope: { streams: [{ name: "items" }] },
					},
					timeoutMs: 5000,
				}),
			/connector subprocess timed out after 5000ms/,
		);

		grandchildPid = Number(await readFile(pidFile, "utf8"));
		const deadline = Date.now() + 5000;
		let grandchildExited = false;
		while (Date.now() < deadline) {
			try {
				const stat = await readFile(`/proc/${grandchildPid}/stat`, "utf8");
				const fields = stat
					.slice(stat.lastIndexOf(")") + 1)
					.trim()
					.split(/\s+/u);
				if (fields[0] === "Z") {
					grandchildExited = true;
					break;
				}
				const commandLine = await readFile(
					`/proc/${grandchildPid}/cmdline`,
					"utf8",
				);
				if (!commandLine.includes(marker)) {
					grandchildExited = true;
					break;
				}
				process.kill(grandchildPid, 0);
				await new Promise((resolve) => setTimeout(resolve, 50));
			} catch (error) {
				if (
					["ENOENT", "ESRCH"].includes(
						(error as NodeJS.ErrnoException).code ?? "",
					)
				) {
					grandchildExited = true;
					break;
				}
				throw error;
			}
		}
		assert.ok(
			grandchildExited,
			`connector grandchild ${String(grandchildPid)} survived timeout`,
		);
	} finally {
		if (!grandchildPid) {
			try {
				grandchildPid = Number(await readFile(pidFile, "utf8"));
			} catch {
				// The fixture may have failed before it spawned a grandchild.
			}
		}
		if (grandchildPid && Number.isSafeInteger(grandchildPid)) {
			try {
				const commandLine = await readFile(
					`/proc/${grandchildPid}/cmdline`,
					"utf8",
				);
				if (commandLine.includes(marker)) {
					process.kill(grandchildPid, "SIGKILL");
				}
			} catch {
				// The process may have exited or the PID may have been reused.
			}
		}
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("runConnectorProtocolSubprocess: rejects non-zero child exit even after terminal DONE", async () => {
	await assert.rejects(
		() =>
			runConnectorProtocolSubprocess({
				cwd: PACKAGE_ROOT,
				entrypoint: fixturePath("protocol-subprocess-done-then-fail.ts"),
				start: { type: "START", scope: { streams: [{ name: "items" }] } },
			}),
		/exited non-zero after DONE/,
	);
});

test("runConnectorProtocolSubprocess: failed DONE reports records emitted before a retryable failure", async () => {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: PACKAGE_ROOT,
		entrypoint: fixturePath("protocol-subprocess-fails-after-record.ts"),
		start: { type: "START", scope: { streams: [{ name: "items" }] } },
	});

	assert.equal(result.code, 1);
	const done = result.messages.at(-1);
	assert.equal(done?.type, "DONE");
	if (done?.type !== "DONE") {
		assert.fail("expected terminal DONE");
	}
	assert.equal(done.status, "failed");
	assert.equal(done.records_emitted, 1);
	assert.equal(done.error?.retryable, true);
	assert.match(done.error?.message ?? "", /retry budget exhausted/iu);
});

test("runConnectorProtocolSubprocess: stream failure evidence forces failed DONE without discarding independent output", async () => {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: PACKAGE_ROOT,
		entrypoint: fixturePath("protocol-subprocess-stream-failure.ts"),
		start: {
			scope: { streams: [{ name: "healthy" }, { name: "failed" }] },
			type: "START",
		},
	});

	assert.equal(result.code, 1);
	assert.ok(
		result.messages.some(
			(message) => message.type === "RECORD" && message.stream === "healthy",
		),
		"successful independent stream output must survive a sibling stream failure",
	);
	assert.ok(
		result.messages.some(
			(message) =>
				message.type === "SKIP_RESULT" &&
				message.stream === "failed" &&
				message.reason === "stream_collection_failed",
		),
		"stream failure must be durable protocol evidence",
	);
	assert.ok(
		result.messages.some(
			(message) => message.type === "STATE" && message.stream === "healthy",
		),
		"successful independent stream state must remain observable",
	);
	const done = result.messages.at(-1);
	assert.equal(done?.type, "DONE");
	if (done?.type !== "DONE") {
		assert.fail("expected terminal DONE");
	}
	assert.equal(done.status, "failed");
	assert.equal(done.error?.code, "stream_collection_failed");
	assert.equal(done.error?.retryable, true);
});

/** `emitted_at` is each run's own clock; blank it so two runs of one fixture compare. */
function withoutEmittedAt(
	messages: readonly EmittedMessage[],
): EmittedMessage[] {
	return messages.map((message) => {
		if (message.type !== "RECORD") {
			return message;
		}
		return { ...message, emitted_at: "" };
	});
}

test("runConnectorProtocolSubprocess: retainRawStdout false keeps the parsed messages and returns no raw text", async () => {
	const retained = await runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: fixturePath("protocol-subprocess-non-browser.ts"),
		start: { type: "START", scope: { streams: [{ name: "items" }] } },
	});
	const dropped = await runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: fixturePath("protocol-subprocess-non-browser.ts"),
		retainRawStdout: false,
		start: { type: "START", scope: { streams: [{ name: "items" }] } },
	});

	assert.deepEqual(
		withoutEmittedAt(dropped.messages),
		withoutEmittedAt(retained.messages),
	);
	assert.equal(dropped.rawStdout, "");

	const rawLines = retained.rawStdout.split("\n").filter((line) => line !== "");
	assert.deepEqual(
		rawLines.map((line) => JSON.parse(line)),
		retained.messages,
	);
});

test("runConnectorProtocolSubprocess: a multi-byte character split across stdout chunks survives", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "connector-subprocess-utf8-"));
	const entrypoint = join(tempDir, "utf8-connector.mjs");
	// 3-byte characters, 300 KB in one line: pipe chunks (64 KiB) cannot all
	// end on a character boundary, so per-chunk decoding would corrupt some.
	const text = "\u20ac".repeat(100_000);
	await writeFile(
		entrypoint,
		[
			`const text = ${JSON.stringify(text)};`,
			'process.stdout.write(JSON.stringify({ type: "RECORD", stream: "items", data: { id: "1", text } }) + "\\n");',
			'process.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 1 }) + "\\n");',
		].join("\n"),
	);
	try {
		const result = await runConnectorProtocolSubprocess({
			cwd: PACKAGE_ROOT,
			entrypoint,
			start: { type: "START", scope: { streams: [{ name: "items" }] } },
		});
		const record = result.messages.find((m) => m.type === "RECORD") as
			| { data: { text: string } }
			| undefined;
		assert.ok(record, "the RECORD reached messages");
		assert.equal(
			record.data.text.includes("\ufffd"),
			false,
			"no replacement characters",
		);
		assert.equal(record.data.text, text);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("runConnectorProtocolSubprocess: a child that exits before the first RSS tick still has a sampled peak", {
	skip: process.platform !== "linux",
}, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "connector-subprocess-rss-"));
	const entrypoint = join(tempDir, "quick-connector.mjs");
	await writeFile(
		entrypoint,
		'process.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 0 }) + "\\n");\n',
	);
	try {
		const result = await runConnectorProtocolSubprocess({
			cwd: PACKAGE_ROOT,
			entrypoint,
			// Far longer than the child lives, so only the start and output
			// samples can produce a value.
			peakRssPollIntervalMs: 60_000,
			start: { type: "START", scope: { streams: [{ name: "items" }] } },
		});
		assert.notEqual(result.peakRssBytes, null, "expected a sampled peak RSS");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});
// ─── skipPoliteDelays ────────────────────────────────────────────────────

/** Run `body` while recording the delay every `setTimeout` call hands to the
 *  timer underneath whatever `body` installs on top of it. */
async function recordTimerDelays(
	body: () => Promise<void>,
): Promise<(number | undefined)[]> {
	const seen: (number | undefined)[] = [];
	const original = globalThis.setTimeout;
	globalThis.setTimeout = ((
		handler: () => void,
		delay?: number,
		...args: unknown[]
	) => {
		seen.push(delay);
		return original(handler, delay, ...args);
	}) as unknown as typeof setTimeout;
	try {
		await body();
	} finally {
		globalThis.setTimeout = original;
	}
	return seen;
}

test("skipPoliteDelays: a politeDelay pause fires on the next tick and other timers keep their delay", async () => {
	const seen = await recordTimerDelays(async () => {
		const restore = skipPoliteDelays();
		try {
			clearTimeout(setTimeout(() => undefined, 12_345));
			await politeDelay(9_999);
		} finally {
			restore();
		}
	});

	assert.deepEqual(
		seen,
		[12_345, 0],
		"the watchdog-style timer keeps 12345 ms; only the pause armed inside politeDelay becomes 0 ms",
	);
});

test("skipPoliteDelays: the restore function puts the previous timer back", () => {
	const before = globalThis.setTimeout;
	const restore = skipPoliteDelays();
	assert.notEqual(globalThis.setTimeout, before);
	restore();
	assert.equal(globalThis.setTimeout, before);
});

test("skipPoliteDelays: overlapping installs restored first-in, first-out keep the pause skipped until the last restore", async () => {
	const seen = await recordTimerDelays(async () => {
		const original = globalThis.setTimeout;
		const restoreFirst = skipPoliteDelays();
		const restoreSecond = skipPoliteDelays();
		try {
			await politeDelay(1_000);
			restoreFirst();
			await politeDelay(1_000);
			restoreSecond();
			assert.equal(
				globalThis.setTimeout,
				original,
				"the last restore puts the original timer back",
			);
		} finally {
			restoreFirst();
			restoreSecond();
		}
	});

	assert.deepEqual(
		seen,
		[0, 0],
		"the first restore must not disable the second installation",
	);
});

test("skipPoliteDelays: overlapping installs restored last-in, first-out keep the pause skipped until the last restore", async () => {
	const seen = await recordTimerDelays(async () => {
		const original = globalThis.setTimeout;
		const restoreFirst = skipPoliteDelays();
		const restoreSecond = skipPoliteDelays();
		try {
			await politeDelay(1_000);
			restoreSecond();
			await politeDelay(1_000);
			restoreFirst();
			assert.equal(
				globalThis.setTimeout,
				original,
				"the last restore puts the original timer back",
			);
		} finally {
			restoreFirst();
			restoreSecond();
		}
	});

	assert.deepEqual(
		seen,
		[0, 0],
		"the restore of the later installation must leave the earlier one live",
	);
});

test("skipPoliteDelays: a repeated restore releases nothing twice", async () => {
	const seen = await recordTimerDelays(async () => {
		const original = globalThis.setTimeout;
		const restoreFirst = skipPoliteDelays();
		const restoreSecond = skipPoliteDelays();
		try {
			restoreFirst();
			restoreFirst();
			await politeDelay(1_000);
			restoreSecond();
			restoreSecond();
			assert.equal(
				globalThis.setTimeout,
				original,
				"the last restore puts the original timer back",
			);

			// The count stayed at zero rather than going negative, so a new
			// installation still skips the pause.
			const restoreThird = skipPoliteDelays();
			try {
				await politeDelay(1_000);
			} finally {
				restoreThird();
			}
			assert.equal(globalThis.setTimeout, original);
		} finally {
			restoreFirst();
			restoreSecond();
		}
	});

	assert.deepEqual(
		seen,
		[0, 0],
		"a repeated restore must neither release the other installation nor push the count below zero",
	);
});

test("skipPoliteDelays: a timer armed by a helper that politeDelay calls keeps its delay", async () => {
	// The matcher keys on the `politeDelay` frame, so this stand-in carries
	// that name. The stack assertion below shows the frame is really on the
	// stack, so the helper's timer is kept for the right reason.
	let stackAtHelper = "";
	function politeDelay(ms: number): Promise<void> {
		return armedByHelper(ms);
	}
	function armedByHelper(ms: number): Promise<void> {
		stackAtHelper = new Error().stack ?? "";
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
	const seen = await recordTimerDelays(async () => {
		const restore = skipPoliteDelays();
		try {
			await politeDelay(50);
		} finally {
			restore();
		}
	});

	assert.match(stackAtHelper, /^\s+at politeDelay \(/m);
	assert.deepEqual(
		seen,
		[50],
		"a timer armed by a helper that politeDelay calls keeps its 50 ms delay",
	);
});

test("runConnector emits typed DONE coverage only for a START with collection_scope", async () => {
	const entrypoint = fixturePath("protocol-subprocess-run-coverage.ts");
	const cases = [
		{
			start: {
				type: "START",
				collection_scope: "unscoped",
				scope: { streams: [{ name: "items" }] },
			},
			status: "collected",
		},
		{
			start: {
				type: "START",
				collection_scope: "unscoped",
				scope: { streams: [{ name: "items", skip_for_test: true }] },
			},
			status: "partial",
		},
		{
			start: { type: "START", scope: { streams: [{ name: "items" }] } },
			status: null,
		},
	] as const;
	const results = await Promise.all(
		cases.map(({ start }) =>
			runConnectorProtocolSubprocess({
				cwd: PACKAGE_ROOT,
				entrypoint,
				start: start as unknown as Parameters<
					typeof runConnectorProtocolSubprocess
				>[0]["start"],
			}),
		),
	);
	for (const [index, result] of results.entries()) {
		assert.equal(result.code, 0);
		const done = result.messages.at(-1) as Record<string, unknown>;
		const coverage = done.coverage as
			| { streams: { stores: { status: string }[] }[] }
			| undefined;
		assert.equal(
			coverage?.streams[0]?.stores[0]?.status ?? null,
			cases[index]?.status,
		);
	}
});
