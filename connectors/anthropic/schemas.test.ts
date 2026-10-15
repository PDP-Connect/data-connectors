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
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	accountProfileSchema,
	conversationsSchema,
	messagesSchema,
	projectDocumentsSchema,
	projectsSchema,
	validateRecord,
} from "./schemas.ts";

test("account profile schema requires the collector's organization identity", () => {
	assert.equal(
		accountProfileSchema.safeParse({
			id: "synthetic-org-id",
			organization_id: "synthetic-org-id",
			full_name: "Synthetic Name",
			plan: "Pro",
			name_source: "browser_menu",
			metadata_status: "valid",
		}).success,
		true,
	);
	assert.equal(
		accountProfileSchema.safeParse({ full_name: null }).success,
		false,
	);
});

const BLOB_REF = {
	blob_id: `sha256:${"a".repeat(64)}`,
	mime_type: "application/json",
	size_bytes: 123,
	sha256: "a".repeat(64),
};

const CONVERSATION_RECORD = {
	id: "9f8e7d6c-1234-4abc-9def-0123456789ab",
	title: "Debugging the connector gate",
	create_time: "2024-05-01T10:00:00.000Z",
	update_time: "2024-05-02T14:30:00.000Z",
	project_id: "11112222-3333-4444-5555-666677778888",
	model: "claude-3-5-sonnet",
	message_count: 12,
	is_starred: false,
	blob_ref: BLOB_REF,
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
	creator: null,
	is_private: null,
	is_starter_project: null,
	archived_at: null,
	raw_docs: [],
	blob_ref: BLOB_REF,
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
		blob_ref: BLOB_REF,
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

test("projects schema accepts the retained detail fields with a closed shape", () => {
	const result = projectsSchema.safeParse({
		...PROJECT_RECORD,
		creator: { uuid: "synthetic-user", full_name: "Synthetic Owner" },
		is_private: true,
		is_starter_project: false,
		archived_at: "2025-12-01T00:00:00Z",
		raw_docs: [{ filename: "synthetic.md", content: "Synthetic body" }],
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
	assert.equal(
		projectsSchema.safeParse({
			...PROJECT_RECORD,
			creator: { uuid: "synthetic-user", api_key: "secret" },
		}).success,
		false,
	);
	assert.equal(
		projectsSchema.safeParse({
			...PROJECT_RECORD,
			raw_docs: [{ filename: "synthetic.md", access_token: "secret" }],
		}).success,
		false,
	);
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

test("projects schema accepts a record with no name: name is absent only when over the inline cap", () => {
	const { name: _omit, ...withoutName } = PROJECT_RECORD;
	assert.equal(projectsSchema.safeParse(withoutName).success, true);
	assert.equal(validateRecord("projects", withoutName).ok, true);
	// A name that is present is still bounded by the inline cap.
	assert.equal(
		projectsSchema.safeParse({
			...PROJECT_RECORD,
			name: "n".repeat(10_000_001),
		}).success,
		false,
	);
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

test("validateRecord routes all five streams and passes unknown streams through", () => {
	assert.equal(
		validateRecord("account_profile", {
			id: "synthetic-org-id",
			organization_id: "synthetic-org-id",
			full_name: null,
			plan: null,
			name_source: "none",
			metadata_status: "absent",
		}).ok,
		true,
	);
	assert.equal(validateRecord("conversations", CONVERSATION_RECORD).ok, true);
	assert.equal(validateRecord("messages", MESSAGE_RECORD).ok, true);
	assert.equal(validateRecord("projects", PROJECT_RECORD).ok, true);
	assert.equal(
		validateRecord("project_documents", PROJECT_DOCUMENT_RECORD).ok,
		true,
	);
	assert.equal(validateRecord("unknown_stream", { x: 1 }).ok, true);
});

test("conversations and projects validate with the raw-envelope blob_ref absent", () => {
	const { blob_ref: _conversationBlob, ...conversation } = CONVERSATION_RECORD;
	const { blob_ref: _projectBlob, ...project } = PROJECT_RECORD;
	assert.equal(validateRecord("conversations", conversation).ok, true);
	assert.equal(validateRecord("projects", project).ok, true);
});

test("messages and project_documents validate with content absent, and with a blob_ref instead of inline text", () => {
	const { content: _messageContent, ...message } = MESSAGE_RECORD;
	const { content: _documentContent, ...document } = PROJECT_DOCUMENT_RECORD;
	assert.equal(validateRecord("messages", message).ok, true);
	assert.equal(validateRecord("project_documents", document).ok, true);
	assert.equal(
		validateRecord("messages", {
			...message,
			content: null,
			blob_ref: BLOB_REF,
		}).ok,
		true,
	);
	assert.equal(
		validateRecord("project_documents", {
			...document,
			content: null,
			blob_ref: BLOB_REF,
		}).ok,
		true,
	);
});

test("a malformed blob_ref is still rejected", () => {
	assert.equal(
		validateRecord("messages", {
			...MESSAGE_RECORD,
			blob_ref: { ...BLOB_REF, blob_id: "sha256:nope" },
		}).ok,
		false,
	);
});

test("the manifest declares the same blob fields and blob streams as the schemas", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	);
	assert.deepEqual(manifest.capabilities.host_blob_write.streams.sort(), [
		"conversations",
		"messages",
		"project_documents",
		"projects",
	]);
	assert.equal(
		manifest.capabilities.host_blob_write.max_blob_bytes,
		33_554_432,
	);
	const byName = new Map(
		manifest.streams.map(
			(stream: { name: string; schema: Record<string, unknown> }) => [
				stream.name,
				stream.schema as {
					properties: Record<string, unknown>;
					required: string[];
				},
			],
		),
	);
	for (const name of [
		"conversations",
		"messages",
		"projects",
		"project_documents",
	]) {
		const schema = byName.get(name) as {
			properties: Record<string, unknown>;
			required: string[];
		};
		assert.ok(schema.properties.blob_ref, `${name} declares blob_ref`);
		assert.equal(schema.required.includes("blob_ref"), false, name);
		assert.equal(schema.required.includes("content"), false, name);
	}
});

test("the schemas accept pdpp-safe-escape-v1 text and the former caps no longer apply", () => {
	const escaped = "a\\u0000b\\u007Fc\\u005Cu0001";
	assert.equal(
		validateRecord("conversations", {
			...CONVERSATION_RECORD,
			title: `${escaped}${"t".repeat(5000)}`,
		}).ok,
		true,
	);
	assert.equal(
		validateRecord("messages", { ...MESSAGE_RECORD, content: escaped }).ok,
		true,
	);
	assert.equal(
		validateRecord("projects", {
			...PROJECT_RECORD,
			name: "n".repeat(3000),
			description: "d".repeat(70_000),
			prompt_template: "p".repeat(70_000),
		}).ok,
		true,
	);
	assert.equal(
		validateRecord("project_documents", {
			...PROJECT_DOCUMENT_RECORD,
			filename: "f".repeat(2000),
		}).ok,
		true,
	);
	assert.equal(
		validateRecord("account_profile", {
			id: "o",
			organization_id: "o",
			full_name: escaped,
			plan: "p".repeat(3000),
			name_source: "none",
			metadata_status: "absent",
		}).ok,
		true,
	);
	// Unescaped control characters are still not PDPP text.
	assert.equal(
		validateRecord("messages", { ...MESSAGE_RECORD, content: "a\u0000b" }).ok,
		false,
	);
	// The inline cap itself still holds.
	assert.equal(
		validateRecord("conversations", {
			...CONVERSATION_RECORD,
			title: "t".repeat(10_000_001),
		}).ok,
		false,
	);
});

test("the manifest declares pdpp-safe-escape-v1 on exactly the fields the parsers encode", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	);
	const declared: string[] = [];
	const walk = (node: unknown, path: string) => {
		if (typeof node !== "object" || node === null) return;
		if (Array.isArray(node)) {
			for (const [index, item] of node.entries())
				walk(item, `${path}[${index}]`);
			return;
		}
		const record = node as Record<string, unknown>;
		if (record.x_pdpp_text_encoding !== undefined) {
			assert.equal(record.x_pdpp_text_encoding, "pdpp-safe-escape-v1", path);
			declared.push(path);
		}
		for (const [key, value] of Object.entries(record))
			walk(value, `${path}.${key}`);
	};
	for (const stream of manifest.streams) walk(stream.schema, stream.name);
	assert.deepEqual(declared.sort(), [
		"account_profile.properties.full_name",
		"account_profile.properties.plan",
		"conversations.properties.title",
		"messages.properties.attachments",
		"messages.properties.content",
		"project_documents.properties.content",
		"project_documents.properties.filename",
		"projects.properties.archived_at",
		"projects.properties.creator.properties.full_name",
		"projects.properties.description",
		"projects.properties.name",
		"projects.properties.prompt_template",
		"projects.properties.raw_docs.items.properties.content",
		"projects.properties.raw_docs.items.properties.created_at",
		"projects.properties.raw_docs.items.properties.filename",
		"projects.properties.raw_docs.items.properties.updated_at",
		"projects.properties.raw_docs.items.properties.uuid",
	]);
	const byName = new Map(
		manifest.streams.map(
			(stream: {
				name: string;
				schema: { properties: Record<string, unknown> };
			}) => [stream.name, stream.schema.properties],
		),
	);
	const projects = manifest.streams.find(
		(stream: { name: string }) => stream.name === "projects",
	);
	// name is absent only when it is over the inline cap, so it is optional.
	assert.deepEqual(projects.schema.required, ["id"]);
	for (const name of ["messages", "project_documents"]) {
		const blob = (byName.get(name) as Record<string, Record<string, unknown>>)
			.blob_ref;
		assert.equal(blob?.x_pdpp_blob_projects_field, "content", name);
		assert.equal(blob?.x_pdpp_blob_codec, "json-string-v1", name);
	}
	for (const name of ["conversations", "projects"]) {
		const blob = (byName.get(name) as Record<string, Record<string, unknown>>)
			.blob_ref;
		assert.equal(blob?.x_pdpp_blob_projects_field, undefined, name);
	}
});
