// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Anthropic/Claude connector's pure parsers, and an
 * end-to-end read of the SYNTHETIC export fixture
 * (__fixtures__/synthetic/synthetic-export.zip) through the real ZIP reader
 * (bounded-zip-archive.ts). See __fixtures__/synthetic/README.md: this
 * fixture is hand-authored, clearly synthetic, and does NOT satisfy the
 * cut-anthropic proof gate's real-fixture requirement. Real-fixture proof
 * is PENDING (no real export has landed yet).
 */

import assert from "node:assert/strict";
import { closeSync, openSync, statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	readZipEntriesFromFile,
	type ZipReadPolicy,
	zipBasename,
} from "../../packages/polyfill-connectors/src/bounded-zip-archive.ts";
import {
	classifyManifestPartEntries,
	flattenMessageText,
	parseClassifiedExport,
	parseConversation,
	parseExport,
	parseMessage,
	parseProject,
	parseProjectDocument,
	resolveExportedProfile,
} from "./parsers.ts";

const SYNTHETIC_ZIP_PATH = fileURLToPath(
	new URL("./__fixtures__/synthetic/synthetic-export.zip", import.meta.url),
);

const ZIP_POLICY: ZipReadPolicy = {
	maxEntries: 1000,
	maxEntryUncompressedBytes: 50 * 1024 * 1024,
	maxTotalUncompressedBytes: 200 * 1024 * 1024,
};

test("manifest classification exposes only users.json from light_metadata", () => {
	const classified = classifyManifestPartEntries("light_metadata", [
		{ name: "users.json", json: { users: [{ full_name: "Synthetic Name" }] } },
		{ name: "login_history.json", json: [{ private: "ignored" }] },
	]);
	assert.deepEqual(classified.userProfiles, [
		{ users: [{ full_name: "Synthetic Name" }] },
	]);
	assert.deepEqual(classified.outOfScopeEntryNames, ["login_history.json"]);
	assert.deepEqual(
		resolveExportedProfile(classified.userProfiles, null, true),
		{
			fullName: null,
			nameSource: "none",
			metadataStatus: "valid",
		},
	);
});

test("profile metadata distinguishes absent, malformed, and ambiguous rosters", () => {
	assert.equal(resolveExportedProfile([], null, true).metadataStatus, "absent");
	assert.equal(
		resolveExportedProfile([{ id: "synthetic-id" }], null, true).metadataStatus,
		"malformed",
	);
	assert.deepEqual(
		resolveExportedProfile(
			[[{ full_name: "Other" }, { full_name: "Owner" }]],
			null,
			true,
		),
		{
			fullName: null,
			nameSource: "none",
			metadataStatus: "ambiguous",
		},
	);
	assert.deepEqual(
		resolveExportedProfile(
			[[{ full_name: "Other" }, { full_name: "Owner" }]],
			"Owner",
			true,
		),
		{
			fullName: null,
			nameSource: "none",
			metadataStatus: "ambiguous",
		},
	);
	assert.deepEqual(
		resolveExportedProfile([[{ full_name: "Other" }]], "Owner", true),
		{ fullName: null, nameSource: "none", metadataStatus: "mismatch" },
	);
	assert.deepEqual(resolveExportedProfile([], "Current User", false), {
		fullName: null,
		nameSource: "none",
		metadataStatus: "absent",
	});
	assert.deepEqual(
		resolveExportedProfile(
			[[{ full_name: "Export Owner" }]],
			"Export Owner",
			false,
		),
		{ fullName: null, nameSource: "none", metadataStatus: "valid" },
	);
});

// ─── flattenMessageText ─────────────────────────────────────────────────

test("flattenMessageText: prefers text field over content blocks", () => {
	assert.equal(
		flattenMessageText({ text: "hi", content: [{ text: "x" }] }),
		"hi",
	);
});

test("flattenMessageText: joins multiple text content blocks with newline", () => {
	assert.equal(
		flattenMessageText({
			content: [
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			],
		}),
		"a\nb",
	);
});

test("flattenMessageText: genuinely empty text is preserved as empty, not fabricated", () => {
	assert.equal(
		flattenMessageText({ content: [{ type: "text", text: "" }] }),
		"",
	);
});

test("flattenMessageText: non-record input returns empty string, does not throw", () => {
	assert.equal(flattenMessageText(null), "");
	assert.equal(flattenMessageText("a string"), "");
	assert.equal(flattenMessageText(undefined), "");
});

// ─── parseMessage ────────────────────────────────────────────────────────

test("parseMessage: maps sender->role, parent_message_uuid->parent_id per capability map", () => {
	const record = parseMessage(
		{
			uuid: "m1",
			sender: "assistant",
			parent_message_uuid: "m0",
			created_at: "2026-01-01T00:01:00.000Z",
			updated_at: "2026-01-01T00:01:05.000Z",
			content: [{ type: "text", text: "hello" }],
			attachments: [{ id: "a1", name: "file.txt" }],
		},
		"conv-1",
	);
	assert.deepEqual(record, {
		id: "m1",
		conversation_id: "conv-1",
		role: "assistant",
		parent_id: "m0",
		content: "hello",
		model: null,
		create_time: "2026-01-01T00:01:00.000Z",
		update_time: "2026-01-01T00:01:05.000Z",
		attachments: [{ id: "a1", name: "file.txt" }],
	});
});

test("parseMessage: a message with no uuid is dropped (never fabricates an id)", () => {
	assert.equal(parseMessage({ sender: "human" }, "conv-1"), null);
});

test("parseMessage: unparseable/absent timestamp is null, never guessed", () => {
	const record = parseMessage(
		{ uuid: "m1", created_at: "not a date" },
		"conv-1",
	);
	assert.equal(record?.create_time, null);
});

// Real-account regression (found by this lane's offline run against Tim's
// actual export, connectors/anthropic/index.ts's offline driver — see
// report): a message body containing a raw control character (observed on
// a real message this lane's driver parsed) previously threw out of
// safeText's throwing `.parse()` and aborted the ENTIRE export (all 481
// conversations, not just the one offending message). content must degrade
// to null instead, matching connectors/chatgpt/parsers.ts's established
// toSafeFullContent convention.
test("parseMessage: a control character in content degrades content to null instead of throwing and aborting the whole export", () => {
	const record = parseMessage(
		{
			uuid: "m1",
			text: "line one\x00line two",
			created_at: "2026-01-01T00:00:00.000Z",
		},
		"conv-1",
	);
	assert.ok(record);
	assert.equal(record.content, null);
	assert.equal(record.id, "m1");
});

// ─── parseConversation ───────────────────────────────────────────────────

test("parseConversation: messages sorted by created_at, stable on out-of-order input", () => {
	const parsed = parseConversation({
		uuid: "c1",
		name: "Trip planning",
		created_at: "2026-01-01T00:00:00.000Z",
		chat_messages: [
			{ uuid: "m2", created_at: "2026-01-01T00:01:00.000Z" },
			{ uuid: "m1", created_at: "2026-01-01T00:00:00.000Z" },
			{ uuid: "m3", created_at: "2026-01-01T00:02:00.000Z" },
		],
	});
	assert.ok(parsed);
	assert.deepEqual(
		parsed.messages.map((m) => m.id),
		["m1", "m2", "m3"],
	);
	assert.equal(parsed.conversation.message_count, 3);
});

test("parseConversation: title falls back to summary when name is absent", () => {
	const parsed = parseConversation({
		uuid: "c1",
		summary: "Fallback title",
		chat_messages: [],
	});
	assert.equal(parsed?.conversation.title, "Fallback title");
});

test("parseConversation: drops href and fetchError (D3 envelope/derived fields), never carries them", () => {
	const parsed = parseConversation({
		uuid: "c1",
		name: "Has cruft",
		href: "/chat/c1",
		fetchError: "some transient error",
		chat_messages: [],
	});
	assert.ok(parsed);
	assert.ok(!("href" in parsed.conversation));
	assert.ok(!("fetchError" in parsed.conversation));
});

test("parseConversation: a conversation with no uuid/id is dropped", () => {
	assert.equal(parseConversation({ name: "no id" }), null);
});

test("parseConversation: maps project_uuid -> project_id and is_starred through", () => {
	const parsed = parseConversation({
		uuid: "c1",
		name: "x",
		project_uuid: "p1",
		is_starred: true,
		chat_messages: [],
	});
	assert.equal(parsed?.conversation.project_id, "p1");
	assert.equal(parsed?.conversation.is_starred, true);
});

// ─── parseProjectDocument / parseProject ────────────────────────────────

test("parseProjectDocument: reads uuid, and candidate filename/content keys", () => {
	const doc = parseProjectDocument(
		{
			uuid: "d1",
			filename: "notes.md",
			content: "body text",
			created_at: "2025-01-01T00:00:00.000Z",
		},
		"p1",
	);
	assert.deepEqual(doc, {
		id: "d1",
		project_id: "p1",
		filename: "notes.md",
		content: "body text",
		create_time: "2025-01-01T00:00:00.000Z",
		update_time: null,
	});
});

test("parseProjectDocument: a doc with no uuid is dropped, never fabricates an id", () => {
	assert.equal(parseProjectDocument({ filename: "x.md" }, "p1"), null);
});

test("parseProject: maps title<-name, is_archived derived from archived_at, prompt_template from detail", () => {
	const parsed = parseProject({
		uuid: "p1",
		name: "Recipes",
		created_at: "2025-05-30T00:00:00.000Z",
		updated_at: "2025-06-01T00:00:00.000Z",
		archived_at: null,
		prompt_template: "Be helpful.",
		docs: [{ uuid: "d1" }],
	});
	assert.ok(parsed);
	assert.equal(parsed.project.name, "Recipes");
	assert.equal(parsed.project.is_archived, false);
	assert.equal(parsed.project.prompt_template, "Be helpful.");
	assert.equal(parsed.documents.length, 1);
	assert.equal(parsed.documents[0]?.project_id, "p1");
});

test("parseProject: archived_at present -> is_archived true", () => {
	const parsed = parseProject({
		uuid: "p1",
		name: "Old",
		archived_at: "2024-06-01T00:00:00.000Z",
		docs: [],
	});
	assert.equal(parsed?.project.is_archived, true);
});

test("parseProject: retains known legacy detail fields and raw docs without IDs", () => {
	const parsed = parseProject({
		uuid: "p1",
		name: "x",
		creator: { uuid: "u1", full_name: "Owner", access_token: "discard" },
		is_private: true,
		is_starter_project: false,
		archived_at: "2024-01-02T03:04:05Z",
		docs: [{ filename: "legacy.md", content: "body", api_key: "discard" }],
	});
	assert.ok(parsed);
	assert.deepEqual(parsed.project.creator, { uuid: "u1", full_name: "Owner" });
	assert.equal(parsed.project.is_private, true);
	assert.equal(parsed.project.is_starter_project, false);
	assert.equal(parsed.project.archived_at, "2024-01-02T03:04:05Z");
	assert.deepEqual(parsed.project.raw_docs, [{ filename: "legacy.md", content: "body" }]);
	assert.equal(parsed.documents.length, 0);
});

test("parseProject: a project with no uuid/id is dropped", () => {
	assert.equal(parseProject({ name: "no id" }), null);
});

// name is required (non-nullable in schemas.ts) unlike the optional text
// fields safeText covers, so a control character can't degrade it to null —
// it must degrade to a safe placeholder instead of throwing and aborting
// the whole export (same class of real-account regression as parseMessage's
// content test above).
test("parseProject: a control character in name degrades to the same 'Untitled project' placeholder used for a missing name, instead of throwing", () => {
	const parsed = parseProject({ uuid: "p1", name: "line one\x00line two" });
	assert.ok(parsed);
	assert.equal(parsed.project.name, "Untitled project");
});

// ─── parseExport (whole-archive) ────────────────────────────────────────

test("parseExport: filters non-array conversations.json and non-project entries defensively", () => {
	const parsed = parseExport(null, [null, { uuid: "p1", name: "x", docs: [] }]);
	assert.deepEqual(parsed.conversations, []);
	assert.equal(parsed.projects.length, 1);
});

// ─── End-to-end: real ZIP reader against the synthetic fixture ──────────

test("synthetic fixture: readZipEntriesFromFile + parseExport produces every stream honestly", () => {
	const fd = openSync(SYNTHETIC_ZIP_PATH, "r");
	try {
		const fileSize = statSync(SYNTHETIC_ZIP_PATH).size;
		const entries = readZipEntriesFromFile(fd, fileSize, ZIP_POLICY);
		assert.ok(entries.length > 0, "fixture must contain entries");

		const conversationsEntry = entries.find(
			(e) => e.name === "conversations.json",
		);
		assert.ok(conversationsEntry, "fixture must contain conversations.json");
		const conversationsJson = JSON.parse(
			conversationsEntry.data().toString("utf8"),
		);

		const projectEntries = entries.filter((e) =>
			e.name.startsWith("projects/"),
		);
		assert.equal(projectEntries.length, 2, "fixture declares two projects");
		const projectFiles = projectEntries.map((e) =>
			JSON.parse(e.data().toString("utf8")),
		);

		const parsed = parseExport(conversationsJson, projectFiles);

		assert.equal(parsed.conversations.length, 2);
		assert.equal(parsed.messages.length, 2);
		assert.equal(parsed.projects.length, 2);
		assert.equal(parsed.projectDocuments.length, 1);

		const starredConv = parsed.conversations.find((c) => c.is_starred);
		assert.ok(starredConv);
		assert.equal(starredConv.message_count, 2);

		const untitledConv = parsed.conversations.find(
			(c) => c.title === "Untitled fallback conversation",
		);
		assert.ok(
			untitledConv,
			"title falls back to summary through the real ZIP path",
		);

		const archivedProject = parsed.projects.find((p) => p.is_archived);
		assert.ok(archivedProject);
		assert.equal(archivedProject.name, "Archived synthetic project");

		const doc = parsed.projectDocuments[0];
		assert.ok(doc);
		assert.equal(doc.filename, "synthetic-notes.md");
		assert.ok(
			projectEntries.some(
				(e) => zipBasename(e.name) === `${doc.project_id}.json`,
			),
			"the document's project_id must trace back to a real projects/*.json entry name",
		);
	} finally {
		closeSync(fd);
	}
});

// ─── Multi-part manifest classification (SYNTHETIC — 2026 export format) ──
//
// The inner layout of a real multi-part manifest category ZIP has never
// been observed (see index.ts module header and the cut-anthropic-export
// report). These fixtures are hand-authored guesses at plausible shapes,
// clearly labeled synthetic, and do not satisfy any real-fixture proof
// gate — they only prove classifyManifestPartEntries's content-shape
// dispatch logic, not that it matches the real export.

test("classifyManifestPartEntries: a bare array of conversation-shaped objects classifies as conversations", () => {
	const result = classifyManifestPartEntries("conversations", [
		{
			name: "conversations-000.json",
			json: [
				{ uuid: "syn-conv-1", chat_messages: [] },
				{ uuid: "syn-conv-2", chat_messages: [] },
			],
		},
	]);
	assert.equal(result.category, "conversations");
	assert.equal(result.conversations.length, 2);
	assert.equal(result.projects.length, 0);
	assert.deepEqual(result.unclassifiedEntryNames, []);
});

test("classifyManifestPartEntries: a bare array of project-shaped objects classifies as projects", () => {
	const result = classifyManifestPartEntries("projects", [
		{
			name: "projects-000.json",
			json: [
				{ uuid: "syn-proj-1", docs: [] },
				{ uuid: "syn-proj-2", archived_at: null },
			],
		},
	]);
	assert.equal(result.projects.length, 2);
	assert.equal(result.conversations.length, 0);
});

test("classifyManifestPartEntries: a single bare project object (not wrapped in an array) still classifies", () => {
	const result = classifyManifestPartEntries("projects", [
		{ name: "projects-000.json", json: { uuid: "syn-proj-1", docs: [] } },
	]);
	assert.equal(result.projects.length, 1);
});

test("classifyManifestPartEntries: an unrecognized shape within an in-scope category is reported as unclassified, never silently dropped", () => {
	const result = classifyManifestPartEntries("conversations", [
		{ name: "conversations.json", json: { some_unknown_field: 1 } },
	]);
	assert.equal(result.conversations.length, 0);
	assert.equal(result.projects.length, 0);
	assert.deepEqual(result.unclassifiedEntryNames, ["conversations.json"]);
	assert.deepEqual(result.outOfScopeEntryNames, []);
});

test("classifyManifestPartEntries: a bare array containing only unrecognized items within an in-scope category is fully unclassified", () => {
	const result = classifyManifestPartEntries("projects", [
		{ name: "projects-000.json", json: [{ text: "some unrecognized item" }] },
	]);
	assert.equal(result.conversations.length, 0);
	assert.equal(result.projects.length, 0);
	assert.deepEqual(result.unclassifiedEntryNames, ["projects-000.json"]);
});

test("classifyManifestPartEntries: light_metadata is out-of-scope by category, never entered into content-shape classification", () => {
	const result = classifyManifestPartEntries("light_metadata", [
		{ name: "users.json", json: { some_field: 1 } },
		{ name: "login_history.json", json: [{ some_field: 2 }] },
	]);
	assert.equal(result.conversations.length, 0);
	assert.equal(result.projects.length, 0);
	assert.deepEqual(result.unclassifiedEntryNames, []);
	assert.deepEqual(result.outOfScopeEntryNames, ["login_history.json"]);
	assert.deepEqual(result.userProfiles, [{ some_field: 1 }]);
});

test("classifyManifestPartEntries: memories is out-of-scope by category, even though memory_files[] could coincidentally resemble other shapes", () => {
	const result = classifyManifestPartEntries("memories", [
		{
			name: "memories/syn-account.json",
			json: {
				account_uuid: "syn-account-1",
				conversations_memory: "some synthetic memory text",
				memory_files: [
					{
						path: "/areas/example.md",
						content: "x",
						updated_at: "2026-01-01T00:00:00.000Z",
					},
				],
			},
		},
	]);
	assert.equal(result.conversations.length, 0);
	assert.equal(result.projects.length, 0);
	assert.deepEqual(result.unclassifiedEntryNames, []);
	assert.deepEqual(result.outOfScopeEntryNames, ["memories/syn-account.json"]);
});

test("classifyManifestPartEntries: design_chats is out-of-scope by category (uses messages[]/role, not chat_messages[]/sender, so it would not classify as a conversation anyway, but category gating is the actual guarantee)", () => {
	const result = classifyManifestPartEntries("design_chats", [
		{
			name: "design_chats/syn-chat.json",
			json: {
				uuid: "syn-chat-1",
				title: "Synthetic design chat",
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				project: { uuid: "syn-proj-1", name: "Synthetic Project" },
				messages: [
					{
						uuid: "syn-msg-1",
						role: "human",
						content: "hi",
						created_at: "2026-01-01T00:00:00.000Z",
					},
				],
			},
		},
	]);
	assert.equal(result.conversations.length, 0);
	assert.equal(result.projects.length, 0);
	assert.deepEqual(result.unclassifiedEntryNames, []);
	assert.deepEqual(result.outOfScopeEntryNames, ["design_chats/syn-chat.json"]);
});

test("parseClassifiedExport: pools classified raw items across parts through the same field mapping as parseExport", () => {
	const rawConversations = [
		{
			uuid: "syn-conv-1",
			name: "Synthetic",
			created_at: "2026-01-01T00:00:00.000Z",
			chat_messages: [],
		},
	];
	const rawProjects = [
		{
			uuid: "syn-proj-1",
			name: "Synthetic project",
			docs: [{ uuid: "syn-doc-1", filename: "a.md", content: "body" }],
		},
	];
	const parsed = parseClassifiedExport(rawConversations, rawProjects);
	assert.equal(parsed.conversations.length, 1);
	assert.equal(parsed.conversations[0]?.id, "syn-conv-1");
	assert.equal(parsed.projects.length, 1);
	assert.equal(parsed.projectDocuments.length, 1);
	assert.equal(parsed.projectDocuments[0]?.filename, "a.md");
});
