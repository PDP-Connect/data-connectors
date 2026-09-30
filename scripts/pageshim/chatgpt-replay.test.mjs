// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { projectChatGptExport } from "./chatgpt-replay.mjs";
import {
	DEFAULT_BRIDGE_LATENCY_MS,
	resolveBridgeLatencyMs,
} from "./harness.mjs";

test("bridge latency defaults from phone throughput and is configurable", () => {
	assert.equal(DEFAULT_BRIDGE_LATENCY_MS, 1500);
	assert.equal(resolveBridgeLatencyMs(undefined), 1500);
	assert.equal(resolveBridgeLatencyMs("2400"), 2400);
	assert.equal(resolveBridgeLatencyMs("invalid"), 1500);
});

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
