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
import { buildAccountPlanRecord as buildLiveAccountPlanRecord } from "../anthropic_live/parsers.ts";
import {
	buildAccountPlanRecord,
	classifyManifestPartEntries,
	createPipelinedJsonEntryReader,
	flattenMessageText,
	omittedFieldCountOf,
	oversizeTextOf,
	parseClassifiedExport,
	parseConversation,
	parseConversationHeader,
	parseExport,
	parseJsonArrayChunks,
	parseMessage,
	parseProject,
	parseProjectDocument,
	type RawOrganization,
	resolveExportedProfile,
} from "./parsers.ts";
import { decodeEscapedText } from "./safe-escape.ts";
import { validateRecord } from "./schemas.ts";

test("parseJsonArrayChunks reads bounded UTF-16 chunks and emits one value at a time", async () => {
	const source = String.raw`[{"text":"a \"quoted\" value","nested":[1,true]},"😀",null]`;
	const calls: Array<[number, number]> = [];
	const values: unknown[] = [];
	await parseJsonArrayChunks(
		async (_name, offset, length) => {
			calls.push([offset, length]);
			return source.slice(offset, offset + Math.min(length, 5));
		},
		{ name: "conversations.json", size: source.length },
		(value) => {
			values.push(value);
		},
		8,
	);
	assert.deepEqual(values, [
		{ text: 'a "quoted" value', nested: [1, true] },
		"😀",
		null,
	]);
	assert.ok(calls.length > 1);
	assert.ok(calls.every(([, length]) => length <= 8));
});

test("pipelined entry reader overlaps calls, preserves order, and restarts after short reads", async () => {
	const source = "0123456789abcdefghijklmnopqrst";
	let active = 0;
	let maxActive = 0;
	const reader = createPipelinedJsonEntryReader(
		async (_name, offset, length) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, offset === 0 ? 4 : 1));
			active--;
			const end = offset === 0 ? offset + length - 1 : offset + length;
			return source.slice(offset, end);
		},
		{ name: "test.json", size: source.length },
		0,
		source.length,
		8,
		3,
	);
	const chunks: string[] = [];
	for (let offset = 0; offset < source.length; ) {
		const text = await reader(
			"test.json",
			offset,
			Math.min(8, source.length - offset),
		);
		chunks.push(text);
		offset += text.length;
	}
	assert.equal(chunks.join(""), source);
	assert.ok(maxActive >= 2, `expected concurrent reads, got ${maxActive}`);
	assert.ok(maxActive <= 3, `reader exceeded its window: ${maxActive}`);
});

test("parseJsonArrayChunks rejects malformed arrays and invalid bounded reads", async () => {
	await assert.rejects(
		parseJsonArrayChunks(
			async () => "[1,]",
			{ name: "bad.json", size: 4 },
			() => {},
		),
		/invalid JSON array/,
	);
	await assert.rejects(
		parseJsonArrayChunks(
			async () => "",
			{ name: "empty.json", size: 1 },
			() => {},
		),
		/invalid bounded read/,
	);
	await Promise.all(
		["{}", "null", "[{}\u00a0]", "[]\u000b"].map((source) =>
			assert.rejects(
				parseJsonArrayChunks(
					async (_name, offset, length) =>
						source.slice(offset, offset + length),
					{ name: "invalid.json", size: source.length },
					() => {},
				),
				(error: unknown) =>
					error instanceof Error &&
					/invalid JSON array/.test(error.message) &&
					(error as Error & { code?: string }).code === "INVALID_JSON_ARRAY",
			),
		),
	);
});

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
test("parseMessage: a control character in content is represented, not dropped", () => {
	const record = parseMessage(
		{
			uuid: "m1",
			text: "line one\x00line two",
			created_at: "2026-01-01T00:00:00.000Z",
		},
		"conv-1",
	);
	assert.ok(record);
	assert.equal(record.content, "line one\\u0000line two");
	assert.equal(decodeEscapedText(record.content ?? ""), "line one\x00line two");
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
	assert.deepEqual(parsed.project.raw_docs, [
		{ filename: "legacy.md", content: "body" },
	]);
	assert.equal(parsed.documents.length, 0);
});

test("parseProject: identified documents match the retained raw copy and ID-less docs stay raw-only", () => {
	const parsed = parseProject({
		uuid: "p1",
		name: "Project",
		docs: [
			{
				uuid: "d1",
				filename: "notes.md",
				content: "Document body",
				created_at: "2025-01-02T03:04:05Z",
			},
			{ filename: "legacy.md", content: "ID-less body" },
		],
	});
	assert.ok(parsed);
	assert.deepEqual(parsed.project.raw_docs, [
		{
			uuid: "d1",
			filename: "notes.md",
			content: "Document body",
			created_at: "2025-01-02T03:04:05Z",
		},
		{ filename: "legacy.md", content: "ID-less body" },
	]);
	assert.deepEqual(parsed.documents, [
		{
			id: "d1",
			project_id: "p1",
			filename: "notes.md",
			content: "Document body",
			create_time: "2025-01-02T03:04:05Z",
			update_time: null,
		},
	]);
});

test("parseProject: a project with no uuid/id is dropped", () => {
	assert.equal(parseProject({ name: "no id" }), null);
});

// name is required (non-nullable in schemas.ts) unlike the optional text
// fields safeText covers, so a control character can't degrade it to null —
// it must degrade to a safe placeholder instead of throwing and aborting
// the whole export (same class of real-account regression as parseMessage's
// content test above).
test("parseProject: a control character in name is represented; the placeholder is only for a missing name", () => {
	const parsed = parseProject({ uuid: "p1", name: "line one\x00line two" });
	assert.ok(parsed);
	assert.equal(parsed.project.name, "line one\\u0000line two");
	assert.equal(parseProject({ uuid: "p2" })?.project.name, "Untitled project");
});

// ─── parseExport (whole-archive) ────────────────────────────────────────

test("parseExport: filters non-array conversations.json and non-project entries defensively", () => {
	const parsed = parseExport(null, [null, { uuid: "p1", name: "x", docs: [] }]);
	assert.deepEqual(parsed.conversations, []);
	assert.equal(parsed.projects.length, 1);
});

test("source envelopes retain every legacy conversation message and full project detail", () => {
	// Synthetic fixture follows retired claude-export-ingest.cjs normalizeConversation/
	// normalizeProject inputs. The blob is source-shaped; the adapter owns their
	// legacy output mapping. An idless message, string attachment, control-rich
	// body, and unknown project key distinguish it from the keyed PDPP records.
	const rawConversation = {
		uuid: "c1",
		name: "Archive",
		chat_messages: [
			{ uuid: "m2", created_at: "2026-01-02T00:00:00Z", text: "second" },
			{
				created_at: "2026-01-01T00:00:00Z",
				sender: "human",
				text: "first\u0000body",
				attachments: ["file.txt", { name: "image.png" }],
			},
		],
	};
	const rawProject = {
		uuid: "p1",
		name: "Project",
		docs: [{ filename: "notes", content: "raw\u0000notes" }],
		future_provider_field: { nested: [1, "verbatim"] },
	};
	const parsed = parseExport([rawConversation], [rawProject]);
	assert.equal(parsed.conversations[0]?.message_count, 2);
	assert.equal(
		parsed.messages.length,
		1,
		"only native keyed messages enter the messages stream",
	);
	assert.deepEqual(parsed.conversationSources, [
		{
			format: "anthropic-source-record-v1",
			stream: "conversations",
			record_key: "c1",
			payload: rawConversation,
		},
	]);
	assert.deepEqual(parsed.projectSources, [
		{
			format: "anthropic-source-record-v1",
			stream: "projects",
			record_key: "p1",
			payload: rawProject,
		},
	]);
	const restored = JSON.parse(
		JSON.stringify(parsed.conversationSources[0]),
	) as (typeof parsed.conversationSources)[number];
	const restoredConversation = restored.payload as typeof rawConversation;
	const messages = restoredConversation.chat_messages
		.slice()
		.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
		.map((message) => ({
			id: "uuid" in message ? message.uuid : null,
			sender: "sender" in message ? message.sender : null,
			parentId: null,
			createdAt: message.created_at,
			updatedAt: null,
			content: message.text,
			attachments: "attachments" in message ? message.attachments : [],
		}));
	assert.deepEqual(
		{
			id: restoredConversation.uuid,
			title: restoredConversation.name,
			href: `/chat/${restoredConversation.uuid}`,
			createdAt: null,
			updatedAt: null,
			starred: null,
			projectId: null,
			messageCount: messages.length,
			messages,
			fetchError: null,
		},
		{
			id: "c1",
			title: "Archive",
			href: "/chat/c1",
			createdAt: null,
			updatedAt: null,
			starred: null,
			projectId: null,
			messageCount: 2,
			fetchError: null,
			messages: [
				{
					id: null,
					sender: "human",
					parentId: null,
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: null,
					content: "first\u0000body",
					attachments: ["file.txt", { name: "image.png" }],
				},
				{
					id: "m2",
					sender: null,
					parentId: null,
					createdAt: "2026-01-02T00:00:00Z",
					updatedAt: null,
					content: "second",
					attachments: [],
				},
			],
		},
	);
	const restoredProject = JSON.parse(
		JSON.stringify(parsed.projectSources[0]),
	) as (typeof parsed.projectSources)[number];
	assert.deepEqual(
		{
			id: restoredProject.record_key,
			title: restoredProject.payload.name,
			href: `/project/${restoredProject.record_key}`,
			label: `Project, ${String(restoredProject.payload.name)}`,
			createdAt: null,
			updatedAt: null,
			archived: false,
			detail: restoredProject.payload,
		},
		{
			id: "p1",
			title: "Project",
			href: "/project/p1",
			label: "Project, Project",
			createdAt: null,
			updatedAt: null,
			archived: false,
			detail: rawProject,
		},
	);
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

// ─── pdpp-safe-escape-v1: control characters are represented, nothing is cut ──

const CTRL = "a\u0000b\u0007c\u001fd\u007fe\u0085f\ud800g\\u0001h\ttab";
const decoded = (value: unknown) => decodeEscapedText(String(value));

test("every converted conversation and message field round-trips control characters", () => {
	const header = parseConversationHeader({ uuid: "c1", name: CTRL }, 0);
	assert.equal(decoded(header?.title), CTRL);
	const viaSummary = parseConversationHeader(
		{ uuid: "c2", name: "", summary: CTRL },
		0,
	);
	assert.equal(decoded(viaSummary?.title), CTRL);
	const message = parseMessage(
		{
			uuid: "m1",
			text: CTRL,
			attachments: [{ file_name: CTRL, [CTRL]: { nested: [CTRL] }, n: 1 }],
		},
		"c1",
	);
	assert.equal(decoded(message?.content), CTRL);
	const attachment = message?.attachments?.[0] as Record<string, unknown>;
	assert.equal(decoded(attachment.file_name), CTRL);
	const [key] = Object.keys(attachment).filter(
		(k) => k !== "file_name" && k !== "n",
	);
	assert.equal(decoded(key), CTRL);
	assert.deepEqual(
		(attachment[key ?? ""] as { nested: string[] }).nested.map(decoded),
		[CTRL],
	);
	assert.equal(attachment.n, 1);
});

test("every converted project and document field round-trips control characters", () => {
	const parsed = parseProject({
		uuid: "p1",
		name: CTRL,
		description: CTRL,
		prompt_template: CTRL,
		archived_at: CTRL,
		creator: { uuid: "u1", full_name: CTRL },
		docs: [
			{
				uuid: "d1",
				filename: CTRL,
				content: CTRL,
				created_at: CTRL,
				updated_at: CTRL,
			},
		],
	});
	assert.ok(parsed);
	const { project, documents } = parsed;
	for (const value of [
		project.name,
		project.description,
		project.prompt_template,
		project.archived_at,
		project.creator?.full_name,
	])
		assert.equal(decoded(value), CTRL);
	const rawDoc = project.raw_docs[0];
	for (const value of [
		rawDoc?.filename,
		rawDoc?.content,
		rawDoc?.created_at,
		rawDoc?.updated_at,
	])
		assert.equal(decoded(value), CTRL);
	assert.equal(decoded(documents[0]?.filename), CTRL);
	assert.equal(decoded(documents[0]?.content), CTRL);
	for (const [stream, record] of [
		["projects", project],
		["project_documents", documents[0]],
	] as const)
		assert.equal(validateRecord(stream, { ...record }).ok, true, stream);
});

test("no text field is ever truncated to a former schema cap", () => {
	const title = "t".repeat(5000);
	const longName = "n".repeat(3000);
	const long = "l".repeat(70_000);
	const header = parseConversationHeader({ uuid: "c", name: title }, 0);
	assert.equal(header?.title, title);
	const parsed = parseProject({
		uuid: "p",
		name: longName,
		description: long,
		prompt_template: long,
		archived_at: "a".repeat(200),
		creator: { full_name: longName },
		docs: [{ uuid: "d", filename: "f".repeat(2000), content: "c" }],
	});
	assert.ok(parsed);
	assert.equal(parsed.project.name, longName);
	assert.equal(parsed.project.description, long);
	assert.equal(parsed.project.prompt_template, long);
	assert.equal(parsed.project.archived_at, "a".repeat(200));
	assert.equal(parsed.project.creator?.full_name, longName);
	assert.equal(parsed.documents[0]?.filename, "f".repeat(2000));
	assert.equal(parsed.project.raw_docs[0]?.filename, "f".repeat(2000));
	assert.equal(omittedFieldCountOf(parsed.project), 0);
	assert.equal(
		validateRecord("projects", { ...parsed.project }).ok,
		true,
		"the schema accepts the untruncated values",
	);
});

test("a field whose escaped text is over the inline cap is left absent and counted, never cut", () => {
	// 3M NULs are 3M raw units but 18M escaped: over the 10M inline cap.
	const nuls = "\u0000".repeat(3_000_000);
	const header = parseConversationHeader({ uuid: "c", name: nuls }, 0);
	assert.ok(header);
	assert.equal("title" in header, false);
	assert.equal(omittedFieldCountOf(header), 1);
	const parsed = parseProject({
		uuid: "p",
		name: "ok",
		description: nuls,
		prompt_template: "x".repeat(10_000_001),
		docs: [{ uuid: "d", filename: nuls, content: "c" }],
	});
	assert.ok(parsed);
	assert.equal(parsed.project.name, "ok");
	assert.equal("description" in parsed.project, false);
	assert.equal("prompt_template" in parsed.project, false);
	assert.equal(omittedFieldCountOf(parsed.project), 2);
	assert.equal("filename" in (parsed.documents[0] ?? {}), false);
	assert.equal(omittedFieldCountOf(parsed.documents[0] ?? {}), 1);
	assert.equal(validateRecord("conversations", { ...header }).ok, true);
	assert.equal(validateRecord("projects", { ...parsed.project }).ok, true);
});

test("body text whose escaped form is over the inline cap becomes a blob of the RAW text", () => {
	const raw = "\u0000".repeat(2_100_000); // 2.1M raw, 12.6M escaped
	const message = parseMessage({ uuid: "m", text: raw }, "c");
	assert.equal(message?.content, null);
	assert.equal(oversizeTextOf(message ?? {}), raw);
	const doc = parseProjectDocument({ uuid: "d", content: raw }, "p");
	assert.equal(doc?.content, null);
	assert.equal(oversizeTextOf(doc ?? {}), raw);
	// Just under the cap on the escaped form stays inline.
	const under = parseMessage(
		{ uuid: "m2", text: "\u0000".repeat(1_600_000) },
		"c",
	);
	assert.equal(typeof under?.content, "string");
	assert.equal(oversizeTextOf(under ?? {}), null);
});

test("parseConversationHeader: a title or identity field reported over the cap is absent or unparseable, never a prefix", () => {
	const over = (...keys: string[]) => new Set(keys);
	const noName = parseConversationHeader(
		{ uuid: "c", summary: "S" },
		0,
		over("name"),
	);
	assert.equal("title" in (noName ?? {}), false);
	assert.equal(omittedFieldCountOf(noName ?? {}), 1);
	const noSummary = parseConversationHeader({ uuid: "c" }, 0, over("summary"));
	assert.equal("title" in (noSummary ?? {}), false);
	assert.equal(omittedFieldCountOf(noSummary ?? {}), 1);
	assert.equal(parseConversationHeader({ uuid: "c" }, 0, over())?.title, null);
	assert.equal(parseConversationHeader({ id: "i" }, 0, over("uuid")), null);
	assert.equal(parseConversationHeader({ uuid: "c" }, 0, over("id"))?.id, "c");
	assert.equal(parseConversationHeader({}, 0, over("id")), null);
});

const PLAN_ORGS: Array<[string, Record<string, unknown>, string | null]> = [
	["max", { uuid: "o", capabilities: ["chat", "claude_max"] }, "max"],
	["pro", { uuid: "o", capabilities: ["chat", "claude_pro"] }, "pro"],
	[
		"team",
		{ uuid: "o", capabilities: ["raven"], raven_type: "enterprise" },
		"enterprise",
	],
	["raven without a type", { uuid: "o", capabilities: ["raven"] }, "team"],
	["free", { uuid: "o", capabilities: ["chat"], billing_type: null }, "free"],
	[
		"free, billing none",
		{ uuid: "o", capabilities: ["chat"], billing_type: "none" },
		"free",
	],
	[
		"unknown",
		{ uuid: "o", capabilities: ["chat"], billing_type: "stripe" },
		null,
	],
	["no capabilities", { uuid: "o" }, null],
];

for (const [label, org, expected] of PLAN_ORGS) {
	test(`buildAccountPlanRecord: ${label} organization gives plan_type ${expected}, the same value anthropic_live gives`, () => {
		const record = buildAccountPlanRecord(org);
		assert.equal(record?.plan_type, expected);
		assert.equal(
			record?.plan_type,
			buildLiveAccountPlanRecord(org, null)?.plan_type,
		);
		assert.equal(validateRecord("account_plan", record).ok, true);
	});
}

test("buildAccountPlanRecord: carries only the organization id, creation time and plan; every other field is null", () => {
	// The cast stands for the real API entry, which has fields this parser never reads.
	const entry = {
		uuid: "org-1",
		name: "Fictional Owner's Organization",
		capabilities: ["chat", "claude_pro"],
		created_at: "2025-03-01T12:00:00.123456Z",
		billing_type: "stripe",
		rate_limit_tier: "default_claude_ai",
		plan_display_name: "Claude Pro",
		email: "someone@example.invalid",
	} as RawOrganization;
	const record = buildAccountPlanRecord(entry);
	assert.deepEqual(record, {
		id: "org-1",
		account_id: "org-1",
		account_structure: null,
		account_created_at: "2025-03-01T12:00:00.123456Z",
		plan_type: "pro",
		plan_display_name: null,
		subscription_plan: null,
		has_active_subscription: null,
		billing_period: null,
		will_renew: null,
		renews_at: null,
		expires_at: null,
		cancels_at: null,
		scheduled_plan_change: null,
	});
	const live = buildLiveAccountPlanRecord(
		{ uuid: "org-1", created_at: "2025-03-01T12:00:00.123456Z" },
		null,
	);
	assert.equal(record?.account_created_at, live?.account_created_at);
});

test("buildAccountPlanRecord: an entry without an id gives no record; a bad creation time gives null", () => {
	assert.equal(buildAccountPlanRecord({ capabilities: ["claude_pro"] }), null);
	assert.equal(buildAccountPlanRecord({ uuid: "" }), null);
	for (const created_at of ["yesterday", "", 1740830400, null])
		assert.equal(
			buildAccountPlanRecord({ uuid: "o", created_at })?.account_created_at,
			null,
		);
});
