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

test("a frame mutated after emit is sent as it was admitted", async () => {
	const calls: EmittedMessage[] = [];
	const channel = createOutputChannel((message) => {
		calls.push(message);
		return calls.length === 1
			? new Promise<void>((resolve) => setTimeout(resolve, 40))
			: Promise.resolve();
	});
	const first = channel.write({
		type: "PROGRESS",
		message: "first",
	} as EmittedMessage);
	const queued = { type: "PROGRESS", message: "second" } as EmittedMessage;
	const second = channel.write(queued);
	(queued as { type: string }).type = "DONE";
	(queued as { message: string }).message = "changed";
	await Promise.all([first, second]);
	assert.deepEqual(calls[1], { type: "PROGRESS", message: "second" });
});

for (const [label, nested] of [
	["function", () => "ACME-4417"],
	["symbol", Symbol("ACME-4417")],
] as const) {
	test(`a frame with a nested ${label} is refused at admission and never sent`, async () => {
		const sent: EmittedMessage[] = [];
		const channel = createOutputChannel(async (message) => {
			sent.push(message);
		});
		const frame = {
			type: "RECORD",
			stream: "s",
			key: "k",
			data: { inner: { nested } },
		} as unknown as EmittedMessage;
		await assert.rejects(
			channel.write(frame),
			(e: unknown) => !String((e as Error).message).includes("ACME-4417"),
		);
		(frame as unknown as { data: { inner: object } }).data.inner = {
			changed: true,
		};
		await sleep(20);
		assert.equal(sent.length, 0);
		assert.equal(
			channel.flags().writeFailed || channel.flags().unserializable,
			true,
		);
	});
}

for (const [label, make] of [
	["SharedArrayBuffer", () => new SharedArrayBuffer(8)],
	["Uint8Array view", () => new Uint8Array(new SharedArrayBuffer(8))],
	["DataView", () => new DataView(new SharedArrayBuffer(8))],
] as const) {
	test(`a frame holding a shared ${label} is never sent mutated`, async () => {
		const sent: string[] = [];
		const channel = createOutputChannel(async (message) => {
			await sleep(20);
			sent.push(JSON.stringify(message));
		});
		const shared = make();
		const view =
			shared instanceof SharedArrayBuffer
				? new Uint8Array(shared)
				: new Uint8Array(shared.buffer as SharedArrayBuffer);
		const first = channel.write(progress("first"));
		const frame = {
			type: "RECORD",
			stream: "s",
			key: "k",
			data: { shared },
		} as unknown as EmittedMessage;
		const second = channel.write(frame).then(
			() => "sent",
			() => "refused",
		);
		view[0] = 99;
		await first;
		const outcome = await second;
		assert.equal(outcome, "refused");
		assert.equal(sent.length, 1);
	});
}

class Holder {
	value = 1;
}

const sharedMemory = (): object => {
	try {
		return new WebAssembly.Memory({
			initial: 1,
			maximum: 1,
			shared: true,
		});
	} catch {
		return new WebAssembly.Memory({ initial: 1 });
	}
};

for (const [label, make] of [
	[
		"an Error whose cause holds a shared view",
		() =>
			new Error("outer", {
				cause: { view: new Uint8Array(new SharedArrayBuffer(8)) },
			}),
	],
	["a WebAssembly.Memory", sharedMemory],
	["a class instance", () => new Holder()],
	["a RegExp", () => /x/u],
	[
		"a getter property",
		() =>
			Object.defineProperty({}, "g", {
				enumerable: true,
				get: () => 1,
			}),
	],
] as const) {
	test(`a frame holding ${label} is refused at admission and never sent`, async () => {
		const sent: EmittedMessage[] = [];
		const channel = createOutputChannel(async (message) => {
			sent.push(message);
		});
		const frame = {
			type: "RECORD",
			stream: "s",
			key: "k",
			data: { hidden: make() },
		} as unknown as EmittedMessage;
		await assert.rejects(channel.write(frame), (e: unknown) =>
			String((e as Error).message).includes("cannot be serialized"),
		);
		await sleep(10);
		assert.equal(sent.length, 0);
	});
}

test("plain data, dates, arrays and private buffers are admitted as clones", async () => {
	const sent: EmittedMessage[] = [];
	const channel = createOutputChannel(async (message) => {
		sent.push(message);
	});
	const data = {
		s: "x",
		n: 1,
		b: true,
		z: null,
		u: undefined,
		d: new Date(0),
		a: [1, { k: "v" }],
		o: { k: 1 },
		bytes: new Uint8Array([1, 2]),
		view: new DataView(new ArrayBuffer(2)),
		buf: new ArrayBuffer(2),
	};
	const frame = {
		type: "RECORD",
		stream: "s",
		key: "k",
		data,
	} as unknown as EmittedMessage;
	await channel.write(frame);
	assert.equal(sent.length, 1);
	assert.notEqual((sent[0] as unknown as { data: object }).data, data);
	assert.deepEqual(sent[0], frame);
});

test("a null-prototype object is plain data", async () => {
	const sent: EmittedMessage[] = [];
	const channel = createOutputChannel(async (message) => {
		sent.push(message);
	});
	await channel.write({
		type: "RECORD",
		stream: "s",
		key: "k",
		data: Object.assign(Object.create(null), { k: 1 }),
	} as unknown as EmittedMessage);
	assert.equal(sent.length, 1);
});

test("after a refused frame no later frame is written", async () => {
	const sent: EmittedMessage[] = [];
	const channel = createOutputChannel(async (message) => {
		sent.push(message);
	});
	await channel
		.write({
			type: "RECORD",
			stream: "s",
			key: "k",
			data: { bad: 1n },
		} as unknown as EmittedMessage)
		.catch(() => undefined);
	await channel.write(progress("later")).catch(() => undefined);
	assert.equal(sent.length, 0);
});
