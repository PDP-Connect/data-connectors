// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { NO_DETAIL_WAITS } from "./__fixtures__/empty-conversation-details.ts";
import { makePagingApi } from "./__fixtures__/paging-conversation-api.ts";
import {
	ChatGptRecoverableRetryExhaustedError,
	runConversationsAndMessagesStreams,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type {
	ChatGptApi,
	ChatGptFetchResult,
	ChatGptNode,
	ConversationListItem,
} from "./types.ts";

// Same list rows, detail documents and recording emit setup as cursor.test.ts.
function makeDetail(convoId: string, messageCount: number): ChatGptFetchResult {
	const mapping: Record<string, ChatGptNode> = {};
	const rootId = `${convoId}-root`;
	const ids: string[] = [];
	for (let i = 0; i < messageCount; i += 1) {
		ids.push(`${convoId}-m${i}`);
	}

	// Root has no `message` (synthetic; extractMessage returns null → skipped).
	mapping[rootId] = {
		id: rootId,
		parent: null,
		children: ids.slice(0, 1),
	};
	for (let i = 0; i < ids.length; i += 1) {
		const id = ids[i];
		if (!id) {
			continue;
		}
		const next = ids[i + 1];
		mapping[id] = {
			id,
			parent: i === 0 ? rootId : (ids[i - 1] ?? rootId),
			children: next ? [next] : [],
			message: {
				id,
				author: { role: i % 2 === 0 ? "user" : "assistant" },
				content: { content_type: "text", parts: [`msg ${i}`] },
				create_time: 1_700_000_000 + i,
				metadata: {},
			},
		};
	}

	return {
		status: 200,
		json: {
			conversation_id: convoId,
			title: `Conversation ${convoId}`,
			current_node: ids.at(-1) ?? rootId,
			create_time: 1_700_000_000,
			update_time: 1_700_001_000,
			mapping,
		},
	};
}

function makeListItem(
	convoId: string,
	updateTimeIso: string,
): ConversationListItem {
	const updateTime = Date.parse(updateTimeIso) / 1000;
	return {
		id: convoId,
		title: `Conversation ${convoId}`,
		create_time: updateTime - 1000,
		update_time: updateTime,
		is_archived: false,
		is_starred: false,
		workspace_id: null,
		current_node: `${convoId}-m1`,
		gizmo_id: null,
	};
}

const history = Array.from({ length: 8 }, (_, index) =>
	makeListItem(
		`fixture-${index}`,
		new Date(Date.UTC(2026, 3, 22, 10, 40 - index)).toISOString(),
	),
);
const expected = history.map(({ id }) => id).sort();
const lastCursor = (messages: readonly EmittedMessage[]) => {
	const state = messages.findLast(
		(message) => message.type === "STATE" && message.stream === "conversations",
	);
	assert.ok(state?.type === "STATE", "conversation STATE emitted");
	return state.cursor as Record<string, unknown>;
};

async function run(state: Record<string, unknown>, failPageThree = false) {
	const fixture = makePagingApi({
		list: () => [],
		detail: (id) => makeDetail(id, 2),
	});
	const offsets: number[] = [];
	const api: ChatGptApi = {
		...fixture,
		async fetch(path, options) {
			if (!path.startsWith("/conversations?"))
				return fixture.fetch(path, options);
			const offset = Number(
				new URLSearchParams(path.split("?")[1]).get("offset"),
			);
			assert.ok(offsets.length < 100, "primary fixture must exhaust");
			offsets.push(offset);
			if (failPageThree && offset === 4) {
				throw new ChatGptRecoverableRetryExhaustedError(
					"fixture retry budget exhausted",
					{
						class: "rate_limited",
						httpStatus: 429,
					},
				);
			}
			return {
				status: 200,
				json: {
					items: history.slice(offset, offset + 2),
					total: history.length,
				},
			};
		},
	};
	const harness = makeRecordingEmit(validateRecord);
	await runConversationsAndMessagesStreams(
		{
			api,
			sleep: () => Promise.resolve(),
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			progress: () => Promise.resolve(),
			requested: new Map([["conversations", { name: "conversations" }]]),
		},
		state,
		{ detailPacing: NO_DETAIL_WAITS },
	);
	return {
		offsets,
		cursor: lastCursor(harness.protocolMessages),
		ids: harness.emitted
			.filter((row) => row.stream === "conversations")
			.map((row) => String(row.data.id)),
		coverage: harness.protocolMessages.find(
			(m) => m.type === "DETAIL_COVERAGE" && m.stream === "conversations",
		),
	};
}

test("ChatGPT conversation history drains four primary pages and a page-three retry converges", async () => {
	const complete = await run({});
	assert.deepEqual(
		complete.offsets,
		[0, 2, 4, 6, 8, 8],
		"primary confirms exhaustion",
	);
	assert.deepEqual([...complete.ids].sort(), expected);
	assert.equal(complete.cursor.backfill, undefined);
	assert.equal(complete.cursor.primary_backfill, undefined);
	assert.ok(complete.coverage?.type === "DETAIL_COVERAGE");
	assert.equal(complete.coverage.considered, expected.length);
	assert.equal(complete.coverage.covered, expected.length);

	const stopped = await run({}, true);
	assert.deepEqual(stopped.offsets.slice(0, 3), [0, 2, 4]);
	assert.ok(
		stopped.offsets.slice(2).every((offset) => offset === 4),
		"retries cannot advance past the failed page",
	);
	assert.equal(stopped.coverage, undefined);
	assert.equal(
		stopped.cursor.last_update_time,
		null,
		"unread rows cannot advance the first-run watermark",
	);
	assert.ok(
		stopped.cursor.primary_backfill,
		"the primary page checkpoint is retained",
	);

	const resumed = await run({ conversations: stopped.cursor });
	assert.ok(
		resumed.offsets.includes(6),
		"reopen reaches the previously unread fourth page",
	);
	assert.deepEqual(
		[...stopped.ids, ...resumed.ids].sort(),
		expected,
		"each ID appears once across both runs",
	);
	assert.deepEqual(resumed.cursor, complete.cursor);
});
