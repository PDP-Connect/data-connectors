// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { makeEmitRecord } from "./connector-runtime.ts";

const cwd = fileURLToPath(new URL("../../..", import.meta.url));
const entrypoint = fileURLToPath(
	new URL("./__fixtures__/runtime-conformance.ts", import.meta.url),
);
const start = { type: "START", scope: { streams: [{ name: "items" }] } };

// Keep stdin open until DONE, as the host does. Input is driven by observed
// output, so these concurrency regressions need no sleeps or real services.
function run(mode: string, message?: EmittedMessage) {
	return new Promise<{ code: number | null; messages: EmittedMessage[] }>(
		(resolve, reject) => {
			const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
				cwd,
				env: {
					...process.env,
					PDPP_TEST_MODE: mode,
					PDPP_TEST_MESSAGE: JSON.stringify(message),
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			const messages: EmittedMessage[] = [];
			let buffer = "";
			let stderr = "";
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error(`Runtime timed out: ${stderr}`));
			}, 10_000);
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				let end = buffer.indexOf("\n");
				while (end !== -1) {
					const output = JSON.parse(buffer.slice(0, end)) as EmittedMessage;
					buffer = buffer.slice(end + 1);
					messages.push(output);
					if (
						(mode === "resume" || mode === "raw_resume") &&
						output.type === "INTERACTION"
					) {
						child.stdin.write(
							`${JSON.stringify({
								type: "INTERACTION_RESPONSE",
								request_id: output.request_id,
								status: "success",
							})}\n`,
						);
					}
					if (
						(mode === "second_start" && output.type === "PROGRESS") ||
						(mode === "second_start_pending" && output.type === "INTERACTION")
					) {
						child.stdin.end(`${JSON.stringify(start)}\n`);
					}
					if (
						mode === "ignore_closed_interaction" &&
						output.type === "INTERACTION"
					) {
						child.stdin.end();
					}
					if (output.type === "DONE") {
						child.stdin.end(
							mode === "second_start_after_done"
								? `${JSON.stringify(start)}\n`
								: undefined,
						);
					}
					end = buffer.indexOf("\n");
				}
			});
			child.on("error", reject);
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ code, messages });
			});
			if (mode === "second_start_chunk") {
				child.stdin.write(`${JSON.stringify(start)}\n`);
			}
			child.stdin.write(
				`${JSON.stringify(mode === "tombstone" ? { ...start, scope: { streams: [{ name: "labels" }] } } : start)}\n`,
			);
		},
	);
}

const blockedMessages: EmittedMessage[] = [
	{ type: "PROGRESS", message: "Fetching items" },
	{ type: "STATE", stream: "items", cursor: "next" },
	{
		type: "RECORD",
		stream: "items",
		key: "item-1",
		data: { id: "item-1" },
		emitted_at: "2026-10-10T00:00:00Z",
	},
	{
		type: "SKIP_RESULT",
		stream: "items",
		reason: "unavailable",
		message: "Unavailable",
	},
	{ type: "DONE", status: "succeeded", records_emitted: 0 },
	{ type: "DONE", status: "failed", records_emitted: 0 },
	{
		type: "ASSISTANCE_STATUS",
		assistance_request_id: "assist-1",
		status: "resolved",
	},
	{
		type: "INTERACTION",
		request_id: "pending_2",
		kind: "otp",
		message: "Another code",
	},
];
for (const message of blockedMessages) {
	test(`pending INTERACTION blocks ${message.type} before stdout and preserves a connector-side failure`, async () => {
		const result = await run("emit", message);
		assert.equal(result.code, 1);
		assert.deepEqual(
			result.messages.map((m) => m.type),
			["INTERACTION", "DONE"],
		);
		const done = result.messages.at(-1);
		assert.equal(done?.type, "DONE");
		if (done?.type !== "DONE") {
			assert.fail("Expected DONE");
		}
		assert.equal(done.status, "failed");
		assert.match(
			done.error?.message ?? "",
			/Cannot emit .*pending INTERACTION/u,
		);
	});
}
for (const mode of [
	"interaction",
	"detail_page",
	"observation",
	"emit_record",
]) {
	test(`pending INTERACTION blocks the ${mode} helper`, async () => {
		const result = await run(mode);
		assert.equal(result.code, 1);
		assert.deepEqual(
			result.messages.map((m) => m.type),
			["INTERACTION", "DONE"],
		);
		const done = result.messages.at(-1);
		if (done?.type !== "DONE") {
			assert.fail("Expected DONE");
		}
		assert.equal(done.records_emitted, 0);
	});
}

test("fatal error during INTERACTION retains failed DONE error and code (A1)", async () => {
	const result = await run("failure");
	assert.equal(result.code, 1);
	assert.deepEqual(
		result.messages.map((m) => m.type),
		["INTERACTION", "DONE"],
	);
	const done = result.messages.at(-1);
	if (done?.type !== "DONE") {
		assert.fail("Expected DONE");
	}
	assert.equal(done.error?.message, "Connector's original failure");
	assert.equal(done.error?.code, "test_fatal");
});

test("matching INTERACTION_RESPONSE permits collection to resume", async () => {
	const result = await run("resume");
	assert.equal(result.code, 0);
	assert.deepEqual(
		result.messages.map((m) => m.type),
		["INTERACTION", "RECORD", "DONE"],
	);
});

test("matching INTERACTION_RESPONSE unlocks an interaction sent through the raw emitter", async () => {
	const result = await run("raw_resume");
	assert.equal(result.code, 0);
	assert.deepEqual(
		result.messages.map((message) => message.type),
		["INTERACTION", "RECORD", "DONE"],
	);
});

test("second START fails at the connector-side stdio boundary", async () => {
	const result = await run("second_start");
	assert.equal(result.code, 1);
	const done = result.messages.at(-1);
	if (done?.type !== "DONE") {
		assert.fail("Expected DONE");
	}
	assert.equal(done.status, "failed");
	assert.match(done.error?.message ?? "", /second START/u);
});

test("delete tombstones retain declared composite primary keys in order without requiring id", async () => {
	const messages: EmittedMessage[] = [];
	const gate = makeEmitRecord({
		requested: new Map([
			["items", { name: "items", resources: ['["account-1","42"]'] }],
		]),
		emit: async (message) => {
			messages.push(message);
		},
		emittedAt: "2026-10-10T00:00:00Z",
		validateRecord: undefined,
		isTombstone: () => true,
		timeRangeFieldFor: () => null,
		primaryKeyFor: () => ["account", "sequence"],
	});
	await gate.emit("items", {
		account: "account-1",
		sequence: 42,
		deleted: true,
	});
	assert.deepEqual(messages, [
		{
			type: "RECORD",
			stream: "items",
			key: ["account-1", "42"],
			data: { account: "account-1", sequence: 42 },
			emitted_at: "2026-10-10T00:00:00Z",
			op: "delete",
		},
	]);
});

test("runConnector builds a non-id tombstone from the shipped manifest primary key", async () => {
	const result = await run("tombstone");
	assert.equal(result.code, 0);
	const record = result.messages.find((message) => message.type === "RECORD");
	if (record?.type !== "RECORD") {
		assert.fail("Expected delete RECORD");
	}
	assert.equal(record.op, "delete");
	assert.equal(record.key, "INBOX");
	assert.deepEqual(record.data, { name: "INBOX" });
});

test("failed DONE counts a record already queued on stdout before backpressure drains", async () => {
	const result = await run("write_then_failure");
	assert.equal(result.code, 1);
	assert.deepEqual(
		result.messages.map((message) => message.type),
		["RECORD", "DONE"],
	);
	const done = result.messages.at(-1);
	if (done?.type !== "DONE") {
		assert.fail("Expected DONE");
	}
	assert.equal(done.records_emitted, 1);
});

for (const mode of ["second_start_chunk", "second_start_pending"]) {
	test(`second START fails exactly once in ${mode}`, async () => {
		const result = await run(mode);
		assert.equal(result.code, 1);
		const doneMessages = result.messages.filter(
			(message) => message.type === "DONE",
		);
		assert.equal(doneMessages.length, 1);
		assert.equal(doneMessages[0]?.status, "failed");
		assert.equal(doneMessages[0]?.error?.code, "duplicate_start");
	});
}

test("stdin closure cannot unlock a pending interaction when a connector ignores the rejection", async () => {
	const result = await run("ignore_closed_interaction");
	assert.equal(result.code, 1);
	assert.deepEqual(
		result.messages.map((message) => message.type),
		["INTERACTION", "DONE"],
	);
});

test("second START received during the terminal ACK wait fails without a second DONE", async () => {
	const result = await run("second_start_after_done");
	assert.equal(result.code, 1);
	assert.equal(
		result.messages.filter((message) => message.type === "DONE").length,
		1,
	);
});

for (const mode of ["write_then_success", "write_then_stream_failure"]) {
	test(`DONE counts a queued record before backpressure drains in ${mode}`, async () => {
		const result = await run(mode);
		assert.equal(result.code, mode === "write_then_success" ? 0 : 1);
		const done = result.messages.at(-1);
		if (done?.type !== "DONE") {
			assert.fail("Expected DONE");
		}
		assert.equal(done.records_emitted, 1);
		assert.equal(
			result.messages.filter((message) => message.type === "RECORD").length,
			1,
		);
	});
}
