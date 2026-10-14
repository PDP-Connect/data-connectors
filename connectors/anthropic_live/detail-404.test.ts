// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { collectAnthropicLive } from "./index.ts";
import { conv, harness, O, uuid } from "./test-support.ts";

const conversations = () => [conv(1, 1), conv(2, 2), conv(3, 3)];
const detailPath = (id: string) => `${O}/chat_conversations/${id}`;

test("a transient detail 404 stops safely and recovers old messages", async () => {
	const convs = conversations();
	const first = harness(convs, {
		runtime: true,
		route: (url) =>
			url.pathname === detailPath(uuid(2)) ? { status: 404 } : undefined,
	});

	await collectAnthropicLive(first.ctx);

	assert.deepEqual(first.ids("messages"), [uuid(1001), uuid(1002)]);
	assert.equal(first.failures.length, 2);
	assert.ok(first.failures.every((failure) => failure.retryable === true));
	const failedState = first.nextState();
	for (const stream of ["conversations", "messages"]) {
		assert.equal(
			(failedState[stream] as { read_through: { id: string } }).read_through.id,
			uuid(1),
		);
	}
	assert.equal(
		(failedState.messages as { emitted_through: string | null })
			.emitted_through,
		null,
	);

	const second = harness(convs, { runtime: true, state: failedState });
	await collectAnthropicLive(second.ctx);

	assert.deepEqual(
		new Set([...first.ids("messages"), ...second.ids("messages")]),
		new Set([
			uuid(1001),
			uuid(1002),
			uuid(2001),
			uuid(2002),
			uuid(3001),
			uuid(3002),
		]),
	);
	assert.equal(second.failures.length, 0);
	assert.equal(
		(second.nextState().messages as { emitted_through: string | null })
			.emitted_through,
		convs[2]?.updated_at,
	);
});

test("a deleted conversation disappearing from the next list unblocks history", async () => {
	const convs = conversations();
	const first = harness(convs, {
		runtime: true,
		route: (url) =>
			url.pathname === detailPath(uuid(2)) ? { status: 404 } : undefined,
	});

	await collectAnthropicLive(first.ctx);

	assert.deepEqual(first.ids("messages"), [uuid(1001), uuid(1002)]);
	assert.equal(first.failures.length, 2);
	assert.ok(first.failures.every((failure) => failure.retryable === true));
	convs.splice(1, 1);

	const second = harness(convs, { runtime: true, state: first.nextState() });
	await collectAnthropicLive(second.ctx);

	assert.deepEqual(second.ids("messages"), [uuid(3001), uuid(3002)]);
	assert.equal(second.failures.length, 0);
	assert.equal(
		(second.nextState().messages as { read_through: { id: string } })
			.read_through.id,
		uuid(3),
	);
	assert.equal(
		(second.nextState().messages as { emitted_through: string | null })
			.emitted_through,
		convs[1]?.updated_at,
	);
});
