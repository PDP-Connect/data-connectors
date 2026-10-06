// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildPageshim } from "./build.mjs";
import {
	projectChatGptExport,
	syntheticChatGptExport,
} from "./chatgpt-replay.mjs";
import { createChatGptReplayFixtures } from "./fixtures/chatgpt-replay.mjs";
import { runHarness } from "./harness.mjs";

const out = join(process.cwd(), ".scratch", "pageshim-chatgpt-replay-test");
mkdirSync(out, { recursive: true });

test("reverse-projects retained ChatGPT records into list pages and details", () => {
	const projected = projectChatGptExport({
		"chatgpt.conversations": {
			conversations: [
				{
					id: "conv-a",
					title: "safe synthetic title",
					create_time: "2025-01-01T00:00:00.000Z",
					update_time: "2025-01-01T00:01:00.000Z",
					current_node: "msg-b",
					message_count_on_current_branch: 2,
				},
			],
		},
		"chatgpt.messages": {
			messages: [
				{
					id: "msg-a",
					conversation_id: "conv-a",
					parent_id: null,
					children_ids: ["msg-b"],
					role: "user",
					content: "safe synthetic message",
					content_type: "text",
					create_time: "2025-01-01T00:00:00.000Z",
					on_current_branch: true,
				},
				{
					id: "msg-b",
					conversation_id: "conv-a",
					parent_id: "msg-a",
					children_ids: [],
					role: "assistant",
					content: "safe synthetic reply",
					content_type: "text",
					create_time: "2025-01-01T00:01:00.000Z",
					on_current_branch: true,
				},
			],
		},
	});

	assert.deepEqual(projected.listPage(0).items[0], {
		id: "conv-a",
		title: "safe synthetic title",
		create_time: 1735689600,
		update_time: 1735689660,
		is_archived: null,
		is_starred: null,
		workspace_id: null,
		current_node: "msg-b",
		gizmo_id: null,
		message_count_on_current_branch: 2,
	});
	assert.deepEqual(projected.detail("conv-a").mapping, {
		"msg-a": {
			id: "msg-a",
			parent: null,
			children: ["msg-b"],
			message: {
				id: "msg-a",
				author: { role: "user" },
				content: { content_type: "text", parts: ["safe synthetic message"] },
				create_time: 1735689600,
				metadata: {
					model_slug: null,
					finish_details: null,
					citations: [],
					tool_calls: [],
					attachments: [],
				},
			},
		},
		"msg-b": {
			id: "msg-b",
			parent: "msg-a",
			children: [],
			message: {
				id: "msg-b",
				author: { role: "assistant" },
				content: { content_type: "text", parts: ["safe synthetic reply"] },
				create_time: 1735689660,
				metadata: {
					model_slug: null,
					finish_details: null,
					citations: [],
					tool_calls: [],
					attachments: [],
				},
			},
		},
	});
	assert.equal(projected.stats.conversations, 1);
	assert.equal(projected.stats.messages, 2);
});

// Bridge budget for a full-size run of the real ChatGPT PageShim bundle.
// Before #340 this shape cost one `setData` per record and per comma and one
// `setProgress` per conversation: 8,409 `setData` and 630 `setProgress` calls
// here (about 135,000 `setData` calls on a real 2,042 conversation account),
// against 20 and 55 now. The ceilings sit well above today's counts and far
// below the old ones, so ordinary change passes and a per-record bridge call
// fails.
test("chatgpt: a 600-conversation replay keeps bridge calls bounded", {
	timeout: 300_000,
}, async () => {
	const conversations = 600;
	const messagesPerConversation = 6;
	const projected = projectChatGptExport(
		syntheticChatGptExport({ conversations, messagesPerConversation }),
	);
	const fixtures = createChatGptReplayFixtures(projected);
	const built = await buildPageshim({
		connector: "chatgpt",
		outfile: join(out, "chatgpt-replay.js"),
	});
	const run = await runHarness({
		bundle: built.outfile,
		fixtures,
		scopes: ["chatgpt.conversations", "chatgpt.messages"],
		resultStreaming: true,
		env: {
			PDPP_CHATGPT_PACING_INITIAL_INTERVAL_MS: "0",
			PDPP_CHATGPT_PACING_MIN_INTERVAL_MS: "0",
		},
	});
	assert.deepEqual(run.ret, { ok: true }, run.log.slice(-20).join("\n"));
	assert.equal(run.streamResult.completed, true);
	assert.equal(
		run.streamDone.exportSummary.details.conversations,
		conversations,
	);
	assert.equal(
		run.streamDone.exportSummary.details.messages,
		conversations * messagesPerConversation,
	);
	// Detail reads go through the batch endpoint, 10 IDs at a time.
	assert.ok(fixtures.requests.batch >= conversations / 10);
	assert.equal(fixtures.requests.detail, 0);
	assert.ok(
		run.streamResult.messageCount < 100,
		`result stream messages: ${run.streamResult.messageCount}`,
	);
	assert.ok(
		(run.calls.setData ?? 0) < 150,
		`setData calls: ${run.calls.setData}`,
	);
	assert.ok(
		(run.calls.setProgress ?? 0) < conversations / 5,
		`setProgress calls: ${run.calls.setProgress}`,
	);
	assert.ok(run.maxBridgePayloadUnits <= 256 * 1024);
});
