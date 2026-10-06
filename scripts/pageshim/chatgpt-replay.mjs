// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

export const CHATGPT_LIST_PAGE_SIZE = 30;
const toEpochSeconds = (value) => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	const millis = Date.parse(value);
	return Number.isFinite(millis) ? millis / 1000 : null;
};

const providerListItem = (record) => ({
	id: record.id,
	title: record.title ?? null,
	create_time: toEpochSeconds(record.create_time),
	update_time: toEpochSeconds(record.update_time),
	is_archived: record.is_archived ?? null,
	is_starred: record.is_starred ?? null,
	workspace_id: record.workspace_id ?? null,
	current_node: record.current_node ?? null,
	gizmo_id: record.gizmo_id ?? null,
	message_count_on_current_branch:
		record.message_count_on_current_branch ?? null,
});

const providerNode = (record) => ({
	id: record.id,
	parent: record.parent_id ?? null,
	children: Array.isArray(record.children_ids) ? record.children_ids : [],
	message: {
		id: record.id,
		author: { role: record.role ?? null },
		content: {
			content_type: record.content_type ?? "text",
			parts: record.content == null ? [] : [record.content],
		},
		create_time: toEpochSeconds(record.create_time),
		metadata: {
			model_slug: record.model_slug ?? null,
			finish_details: record.finish_reason
				? { type: record.finish_reason }
				: null,
			citations: Array.isArray(record.citations) ? record.citations : [],
			tool_calls: Array.isArray(record.tool_calls) ? record.tool_calls : [],
			attachments: (record.attachment_ids ?? []).map((id) => ({ id })),
		},
	},
});

/**
 * Build provider-shaped API responses from retained PDPP records. The source
 * export is already filtered by the desktop connector, so hidden/system/tool
 * nodes and dropped malformed leaves cannot be reconstructed.
 */
export function projectChatGptExport(content, { pageSize = CHATGPT_LIST_PAGE_SIZE } = {}) {
	const conversations = content?.["chatgpt.conversations"]?.conversations;
	const messages = content?.["chatgpt.messages"]?.messages;
	if (!Array.isArray(conversations) || !Array.isArray(messages)) {
		throw new Error("ChatGPT export is missing conversation or message records");
	}
	const items = conversations
		.map(providerListItem)
		.sort((a, b) => (b.update_time ?? 0) - (a.update_time ?? 0));
	const nodesByConversation = new Map();
	for (const message of messages) {
		if (!message || typeof message.conversation_id !== "string") continue;
		let mapping = nodesByConversation.get(message.conversation_id);
		if (!mapping) {
			mapping = {};
			nodesByConversation.set(message.conversation_id, mapping);
		}
		if (typeof message.id === "string") mapping[message.id] = providerNode(message);
	}
	const conversationsById = new Map(items.map((item) => [item.id, item]));
	return {
		stats: { conversations: items.length, messages: messages.length },
		listPage(cursor) {
			const start = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
			const page = items.slice(start, start + pageSize);
			const next = start + pageSize;
			return {
				items: page,
				next_cursor: next < items.length ? next : null,
				has_more: next < items.length,
			};
		},
		detail(id) {
			const item = conversationsById.get(id);
			if (!item) return null;
			return {
				...item,
				mapping: nodesByConversation.get(id) ?? {},
			};
		},
		batch(ids) {
			return Array.isArray(ids)
				? ids.map((id) => this.detail(id)).filter(Boolean)
				: [];
		},
	};
}

/**
 * Read and project a retained export in place. The path is required: retained
 * exports hold personal data and never live in the repository.
 */
export function readChatGptExport(path) {
	if (!path) throw new Error("readChatGptExport needs an explicit export path");
	let document;
	try {
		document = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("Could not read the configured ChatGPT replay export");
	}
	return projectChatGptExport(document?.content);
}

/** Synthetic PDPP-shaped records for projectChatGptExport. No personal data. */
export function syntheticChatGptExport({ conversations, messagesPerConversation }) {
	const epoch = Date.parse("2026-01-01T00:00:00.000Z");
	const conversationRecords = [];
	const messageRecords = [];
	for (let c = 0; c < conversations; c++) {
		const id = `conv-${c}`;
		const updated = new Date(epoch + (conversations - c) * 60_000).toISOString();
		const lastId = `${id}-msg-${messagesPerConversation - 1}`;
		conversationRecords.push({
			id,
			title: `Synthetic conversation ${c}`,
			create_time: updated,
			update_time: updated,
			current_node: lastId,
			message_count_on_current_branch: messagesPerConversation,
		});
		for (let m = 0; m < messagesPerConversation; m++) {
			messageRecords.push({
				id: `${id}-msg-${m}`,
				conversation_id: id,
				parent_id: m === 0 ? null : `${id}-msg-${m - 1}`,
				children_ids: m + 1 < messagesPerConversation ? [`${id}-msg-${m + 1}`] : [],
				role: m % 2 === 0 ? "user" : "assistant",
				content: `synthetic message ${c}.${m}`,
				content_type: "text",
				create_time: updated,
				on_current_branch: true,
			});
		}
	}
	return {
		"chatgpt.conversations": { conversations: conversationRecords },
		"chatgpt.messages": { messages: messageRecords },
	};
}
