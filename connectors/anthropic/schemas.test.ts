// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Anthropic/Claude connector.
 *
 * These fixtures are shaped to the capability map's binding field mapping
 * (docs/migration/connector-cutover/capability-map.json, `anthropic` source)
 * and the connector's MANIFEST stream contract (manifests/anthropic.json).
 * Parser-derived proof against the real export shape is separate — see
 * parsers.test.ts, which runs against the synthetic fixture ZIP
 * (__fixtures__/synthetic/synthetic-export.zip). Real-fixture proof is
 * PENDING (no real export has landed yet); see the cut-anthropic report.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	conversationsSchema,
	messagesSchema,
	projectDocumentsSchema,
	projectsSchema,
	validateRecord,
} from "./schemas.ts";

const CONVERSATION_RECORD = {
	id: "9f8e7d6c-1234-4abc-9def-0123456789ab",
	title: "Debugging the connector gate",
	create_time: "2024-05-01T10:00:00.000Z",
	update_time: "2024-05-02T14:30:00.000Z",
	project_id: "11112222-3333-4444-5555-666677778888",
	model: "claude-3-5-sonnet",
	message_count: 12,
	is_starred: false,
};

const MESSAGE_RECORD = {
	id: "msg_01ABCdefGHIjklMNOpqr",
	conversation_id: "9f8e7d6c-1234-4abc-9def-0123456789ab",
	role: "assistant",
	parent_id: "msg_prior0000000000000000",
	content: "Here's how the build-time gate works...",
	model: "claude-3-5-sonnet",
	create_time: "2024-05-02T14:30:00.000Z",
	update_time: "2024-05-02T14:30:00.000Z",
	attachments: [],
};

const PROJECT_RECORD = {
	id: "11112222-3333-4444-5555-666677778888",
	name: "PDPP connectors",
	description: "All connector work for the reference implementation.",
	create_time: "2024-04-01T09:00:00.000Z",
	update_time: "2024-05-02T14:30:00.000Z",
	is_archived: false,
	prompt_template: "You are a helpful assistant for connector work.",
};

const PROJECT_DOCUMENT_RECORD = {
	id: "d1111111-2222-4333-8444-555566667777",
	project_id: "11112222-3333-4444-5555-666677778888",
	filename: "notes.md",
	content: "Project knowledge document body.",
	create_time: "2024-04-01T09:00:00.000Z",
	update_time: "2024-04-01T09:00:00.000Z",
};

test("conversations schema accepts a contract-shaped record", () => {
	const result = conversationsSchema.safeParse(CONVERSATION_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("conversations schema accepts a minimal record (only id, rest null)", () => {
	const result = conversationsSchema.safeParse({
		id: "9f8e7d6c-1234-4abc-9def-0123456789ab",
		title: null,
		create_time: null,
		update_time: null,
		project_id: null,
		model: null,
		message_count: null,
		is_starred: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("messages schema accepts a contract-shaped record", () => {
	const result = messagesSchema.safeParse(MESSAGE_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("projects schema accepts a contract-shaped record", () => {
	const result = projectsSchema.safeParse(PROJECT_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("messages schema rejects a missing conversation_id (manifest-required field)", () => {
	const { conversation_id: _omit, ...withoutConv } = MESSAGE_RECORD;
	assert.equal(messagesSchema.safeParse(withoutConv).success, false);
});

test("conversations schema rejects a negative message_count", () => {
	assert.equal(
		conversationsSchema.safeParse({ ...CONVERSATION_RECORD, message_count: -1 })
			.success,
		false,
	);
});

test("projects schema rejects a missing name (manifest-required field)", () => {
	const { name: _omit, ...withoutName } = PROJECT_RECORD;
	assert.equal(projectsSchema.safeParse(withoutName).success, false);
});

test("project_documents schema accepts a contract-shaped record", () => {
	const result = projectDocumentsSchema.safeParse(PROJECT_DOCUMENT_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("project_documents schema rejects a missing project_id (manifest-required field)", () => {
	const { project_id: _omit, ...withoutProjectId } = PROJECT_DOCUMENT_RECORD;
	assert.equal(
		projectDocumentsSchema.safeParse(withoutProjectId).success,
		false,
	);
});

test("validateRecord routes all four streams and passes unknown streams through", () => {
	assert.equal(validateRecord("conversations", CONVERSATION_RECORD).ok, true);
	assert.equal(validateRecord("messages", MESSAGE_RECORD).ok, true);
	assert.equal(validateRecord("projects", PROJECT_RECORD).ok, true);
	assert.equal(
		validateRecord("project_documents", PROJECT_DOCUMENT_RECORD).ok,
		true,
	);
	assert.equal(validateRecord("unknown_stream", { x: 1 }).ok, true);
});
