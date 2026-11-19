// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { EmittedMessage } from "./connector-runtime.ts";
import { createOutputChannel } from "./connector-runtime.ts";

const progress = (message: string): EmittedMessage => ({
	type: "PROGRESS",
	message,
});
const text = (m: EmittedMessage): string =>
	String((m as { message?: unknown }).message);
const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

test("writes run one at a time, in the order they were offered", async () => {
	const log: string[] = [];
	let active = 0;
	let overlap = false;
	const channel = createOutputChannel(async (message) => {
		active += 1;
		if (active > 1) overlap = true;
		await sleep(text(message) === "a" ? 30 : 1);
		log.push(text(message));
		active -= 1;
	});
	await Promise.all([
		channel.offer(progress("a")),
		channel.write(progress("b")),
		channel.offer(progress("c")),
	]);
	assert.deepEqual(log, ["a", "b", "c"]);
	assert.equal(overlap, false);
});

test("after seal nothing reaches the transport, and the attempt is counted late", async () => {
	const calls: string[] = [];
	const channel = createOutputChannel(async (m) => void calls.push(text(m)));
	await channel.offer(progress("before"));
	channel.seal();
	await assert.rejects(channel.offer(progress("a")));
	await assert.rejects(channel.write(progress("b")));
	assert.deepEqual(calls, ["before"]);
	assert.equal(channel.flags().late, true);
});

test("closed admission refuses connector writes but still takes lifecycle writes", async () => {
	const calls: string[] = [];
	const channel = createOutputChannel(async (m) => void calls.push(text(m)));
	channel.closeAdmission();
	await assert.rejects(channel.offer(progress("connector")));
	await channel.write(progress("lifecycle"));
	assert.deepEqual(calls, ["lifecycle"]);
});

test("drain abandons writes queued behind a hung write", async () => {
	const calls: string[] = [];
	const channel = createOutputChannel((m) => {
		calls.push(text(m));
		return text(m) === "hung" ? new Promise<void>(() => {}) : Promise.resolve();
	});
	void channel.write(progress("hung")).catch(() => undefined);
	const queued = channel.write(progress("queued"));
	channel.seal();
	assert.equal(await channel.drain(15), "expired");
	await assert.rejects(queued);
	assert.deepEqual(calls, ["hung"]);
	assert.equal(channel.flags().expired, true);
});

test("DONE is written once", async () => {
	const calls: string[] = [];
	const channel = createOutputChannel(
		async (m) => void calls.push(String(m.type)),
	);
	channel.seal();
	await channel.writeDone({
		type: "DONE",
		status: "succeeded",
		records_emitted: 0,
	});
	await assert.rejects(
		channel.writeDone({ type: "DONE", status: "failed", records_emitted: 0 }),
	);
	assert.deepEqual(calls, ["DONE"]);
});

test("DONE offered through offer or write is refused and counted as a violation", async () => {
	const calls: string[] = [];
	const channel = createOutputChannel(async (m) => void calls.push(m.type));
	const done: EmittedMessage = {
		type: "DONE",
		status: "succeeded",
		records_emitted: 0,
	};
	await assert.rejects(channel.offer(done));
	await assert.rejects(channel.write(done));
	assert.deepEqual(calls, []);
	assert.equal(channel.flags().violation, true);
});

test("a rejected write reaches the caller as fixed text, whatever the frame", async () => {
	const channel = createOutputChannel(async () => {
		throw new Error("frame bytes ACME-4417");
	});
	for (const message of [
		progress("p"),
		{ type: "STATE", stream: "s", cursor: {} } as EmittedMessage,
	]) {
		await assert.rejects(
			channel.write(message),
			(e: unknown) => !String((e as Error).message).includes("ACME-4417"),
		);
	}
	channel.seal();
	await assert.rejects(
		channel.writeDone({
			type: "DONE",
			status: "succeeded",
			records_emitted: 0,
		}),
		(e: unknown) => !String((e as Error).message).includes("ACME-4417"),
	);
});
