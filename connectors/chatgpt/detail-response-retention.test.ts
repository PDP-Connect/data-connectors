// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A first connect reads thousands of conversation details, some of them
 * megabytes each. The detail pass must let each one go once its records are
 * written; holding every detail until the pass ends ran the phone out of
 * JavaScript heap. This test watches the detail bodies with weak references
 * and forces garbage collection part way through the pass.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
	runMessagesAndConversationsWithDetail,
	type StreamDeps,
} from "./index.ts";
import type { ChatGptApi, ChatGptFetchResult } from "./types.ts";

setFlagsFromString("--expose_gc");
const collectGarbage = runInNewContext("gc") as () => void;

const CONVERSATIONS = 300;
const CHECK_AT = 250;

function detail(id: string): ChatGptFetchResult {
	return {
		status: 200,
		json: {
			id,
			title: "Fixture",
			create_time: 1_700_000_000,
			update_time: 1_700_000_100,
			current_node: "a1",
			mapping: {
				root: { parent: null, children: ["a1"] },
				a1: {
					parent: "root",
					children: [],
					message: {
						author: { role: "user" },
						create_time: 1_700_000_000,
						content: { content_type: "text", parts: ["hello"] },
					},
				},
			},
		},
	};
}

for (const withBatch of [false, true]) {
	test(`the detail pass lets go of each detail once it is written${withBatch ? ", with batch requests" : ""}`, async (t) => {
		const bodies: WeakRef<object>[] = [];
		const read = (id: string): ChatGptFetchResult => {
			const result = detail(id);
			if (result.json) bodies.push(new WeakRef(result.json));
			return result;
		};
		const api: ChatGptApi = {
			auth: () => Promise.reject(new Error("auth unused")),
			fetch: (path) =>
				Promise.resolve(read(path.replace("/conversation/", ""))),
			...(withBatch
				? {
						fetchBatch: (ids: readonly string[]) =>
							Promise.resolve(ids.map((id) => read(id))),
					}
				: {}),
		};
		const deps: StreamDeps = {
			api,
			emit: () => Promise.resolve(),
			emitRecord: () => Promise.resolve(),
			progress: () => Promise.resolve(),
			requested: new Map(
				["conversations", "messages"].map((name) => [name, { name }]),
			),
		};
		let written = 0;
		let aliveAtCheck = -1;
		await runMessagesAndConversationsWithDetail(
			deps,
			Array.from({ length: CONVERSATIONS }, (_, index) => ({
				id: `c-${index}`,
				title: "Fixture",
				create_time: 1_700_000_000,
				update_time: 1_700_000_100,
			})),
			async () => {
				written += 1;
				if (written !== CHECK_AT) return;
				// Weak targets stay alive until the job that touched them ends.
				await new Promise((resolve) => setImmediate(resolve));
				collectGarbage();
				aliveAtCheck = bodies.filter((body) => body.deref()).length;
			},
			{ random: () => 0, sleep: () => undefined },
		);
		assert.equal(written, CONVERSATIONS);
		t.diagnostic(
			`${aliveAtCheck} detail bodies held after ${CHECK_AT} of ${CONVERSATIONS}`,
		);
		// The detail being written, and at most a few batch requests ahead.
		assert.ok(
			aliveAtCheck >= 0 && aliveAtCheck <= 60,
			`${aliveAtCheck} of ${bodies.length} detail bodies still held after ${CHECK_AT} were written`,
		);
	});
}
