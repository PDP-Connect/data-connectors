// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the iCloud Notes connector's `collect()` layer.
 *
 * No browser is spun up. A fake `page.evaluate` dispatches on the target
 * URL/body shape to return scripted CloudKit responses — the same
 * same-origin `page.evaluate(fetch(...))` bridge the real connector uses
 * (mirrors `connectors/reddit/integration.test.ts`'s approach). Every
 * emitted record is run through the real zod schema via
 * `makeRecordingEmit(validateRecord)`.
 *
 * Proves: scope filtering (a stream absent from `requested` emits
 * nothing), START->RECORD->STATE ordering, and the fingerprint-cursor
 * no-op behavior across two runs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "patchright";
import type { Page } from "playwright";
import type {
	BrowserCollectContext,
	EnsureSessionArgs,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { collectAllStreams, ensureICloudNotesSession } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const EMITTED_AT = "2026-09-22T12:00:00.000Z";
const VALIDATE_URL = "https://setup.icloud.com/setup/ws/1/validate";
const CK_BASE = "https://p00-ckdatabasews.icloud.com:443";
const DSID = "12345";
const QUERY_URL = `${CK_BASE}/database/1/com.apple.notes/production/private/records/query?dsid=${DSID}`;

function b64(s: string): string {
	return Buffer.from(s, "utf-8").toString("base64");
}

function readableEmptyNoteFields(overrides: Record<string, unknown> = {}) {
	return {
		TitleEncrypted: { value: null },
		SnippetEncrypted: { value: null },
		Folder: { value: null },
		IsPinned: { value: null },
		CreationDate: { value: null },
		ModificationDate: { value: null },
		Attachments: { value: [] },
		TextDataEncrypted: { value: "" },
		...overrides,
	};
}

const VALIDATE_RESPONSE = {
	dsInfo: { dsid: DSID, fullName: "Test User" },
	webservices: { ckdatabasews: { url: CK_BASE } },
};

function folderQueryResponse() {
	return {
		records: [
			{
				recordName: "folder-work",
				recordType: "Folder",
				fields: { TitleEncrypted: { value: b64("Work") } },
			},
		],
	};
}

function noteQueryResponse(overrides: { continuationMarker?: string } = {}) {
	return {
		records: [
			{
				recordName: "note-1",
				recordType: "Note",
				fields: {
					TitleEncrypted: { value: b64("Grocery list") },
					SnippetEncrypted: { value: b64("milk, eggs") },
					Folder: { value: { recordName: "folder-work" } },
					IsPinned: { value: 0 },
					CreationDate: { value: 1_700_000_000_000 },
					ModificationDate: { value: 1_700_000_000_000 },
					Attachments: { value: [] },
					TextDataEncrypted: { value: "" },
				},
			},
		],
		...(overrides.continuationMarker
			? { continuationMarker: overrides.continuationMarker }
			: {}),
	};
}

/** Build a fake Playwright Page whose `evaluate` dispatches on the target
 *  URL embedded in the call args, mirroring how the real connector's
 *  `page.evaluate(fn, { evalUrl, evalBody })` / `page.evaluate(fn, url)`
 *  calls are shaped. `queryResponses` is consumed in order for calls to
 *  QUERY_URL, letting a test script pagination. */
function makeFakePage(
	queryResponses: unknown[],
	onQuery?: () => void,
	readiness: { readyState?: string; blocked?: boolean } = {},
): Page {
	const streams: Record<string, unknown[]> = { folders: [], notes: [] };
	let currentUrl = "https://www.icloud.com/notes";
	for (const candidate of queryResponses) {
		if (
			typeof candidate === "object" &&
			candidate !== null &&
			"stream" in candidate &&
			"response" in candidate
		) {
			const spec = candidate as { stream: string; response: unknown };
			streams[spec.stream]?.push(spec.response);
			continue;
		}
		const possibleResponse =
			typeof candidate === "object" && candidate !== null && "json" in candidate
				? (candidate as { json: unknown }).json
				: candidate;
		const firstRecord =
			typeof possibleResponse === "object" &&
			possibleResponse !== null &&
			"records" in possibleResponse &&
			Array.isArray((possibleResponse as { records?: unknown }).records)
				? (possibleResponse as { records: unknown[] }).records[0]
				: null;
		const recordType =
			typeof firstRecord === "object" &&
			firstRecord !== null &&
			"recordType" in firstRecord
				? (firstRecord as { recordType?: unknown }).recordType
				: null;
		streams[recordType === "Folder" ? "folders" : "notes"]?.push(candidate);
	}
	const queryCallIndex: Record<string, number> = { folders: 0, notes: 0 };
	const evaluate = (_fn: unknown, arg: unknown): Promise<unknown> => {
		if (arg === undefined) {
			return Promise.resolve({
				href: currentUrl,
				readyState: readiness.readyState ?? "complete",
				blocked: readiness.blocked ?? false,
			});
		}
		if (arg === VALIDATE_URL) {
			return Promise.resolve({ status: 200, json: VALIDATE_RESPONSE });
		}
		const { evalUrl } = (arg ?? {}) as { evalUrl?: string };
		if (evalUrl === QUERY_URL) {
			const body = (arg ?? {}) as {
				evalBody?: {
					query?: {
						recordType?: string;
						filterBy?: Array<{
							fieldName?: string;
							fieldValue?: { value?: string; type?: string };
						}>;
						sortBy?: Array<{ fieldName?: string; ascending?: boolean }>;
					};
					zoneID?: { zoneName?: string };
					resultsLimit?: number;
					continuationMarker?: string;
				};
			};
			const evalBody = body.evalBody;
			assert.equal(evalBody?.query?.recordType, "SearchIndexes");
			assert.equal(evalBody?.query?.filterBy?.[0]?.fieldName, "indexName");
			assert.equal(evalBody?.query?.filterBy?.[0]?.fieldValue?.type, "STRING");
			assert.equal(evalBody?.zoneID?.zoneName, "Notes");
			assert.equal(evalBody?.resultsLimit, 200);
			const indexName = evalBody?.query?.filterBy?.[0]?.fieldValue?.value;
			const stream = indexName === "parentless" ? "folders" : "notes";
			assert.equal(indexName, stream === "folders" ? "parentless" : "recents");
			assert.deepEqual(
				evalBody?.query?.sortBy,
				stream === "notes"
					? [{ fieldName: "modTime", ascending: false }]
					: undefined,
			);
			const streamResponses = streams[stream] ?? [];
			const index = queryCallIndex[stream] ?? 0;
			assert.ok(
				index < streamResponses.length,
				`unexpected extra ${stream} request`,
			);
			const response = streamResponses[index];
			const priorResponse = streamResponses[index - 1];
			const priorJson =
				typeof priorResponse === "object" &&
				priorResponse !== null &&
				"json" in priorResponse
					? (priorResponse as { json: unknown }).json
					: priorResponse;
			const expectedMarker =
				typeof priorJson === "object" &&
				priorJson !== null &&
				"continuationMarker" in priorJson
					? (priorJson as { continuationMarker?: unknown }).continuationMarker
					: undefined;
			assert.equal(evalBody?.continuationMarker, expectedMarker);
			queryCallIndex[stream] = index + 1;
			onQuery?.();
			if (
				typeof response === "object" &&
				response !== null &&
				"status" in response &&
				"json" in response
			) {
				return Promise.resolve(response as { status: number; json: unknown });
			}
			return Promise.resolve({ status: 200, json: response });
		}
		return Promise.resolve({ status: 0, json: null });
	};
	return {
		evaluate,
		url: () => currentUrl,
		setUrl: (url: string) => {
			currentUrl = url;
		},
	} as unknown as Page;
}

/** Notes collection always performs a same-run folders projection request. */
function makeNotePage(noteResponses: unknown[], onQuery?: () => void): Page {
	return makeFakePage(
		[
			{ stream: "folders", response: folderQueryResponse() },
			...noteResponses.map((response) =>
				typeof response === "object" &&
				response !== null &&
				"stream" in response
					? response
					: { stream: "notes", response },
			),
		],
		onQuery,
	);
}

function makeCtx(
	page: Page,
	harness: ReturnType<typeof makeRecordingEmit>,
	requestedStreams: string[],
	state: Record<string, unknown> = {},
): BrowserCollectContext {
	const requested = new Map(requestedStreams.map((s) => [s, { name: s }]));
	return {
		assist: async (): Promise<never> => {
			throw new Error("mock assist not implemented");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: EMITTED_AT,
		page,
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested,
		scope: { streams: requestedStreams.map((name) => ({ name })) },
		sendInteraction: async (): Promise<never> => {
			throw new Error("mock sendInteraction not implemented");
		},
		state,
	};
}

function diagnosticField(
	message: { diagnostics?: unknown },
	name: string,
): unknown {
	const diagnostics = message.diagnostics;
	if (typeof diagnostics !== "object" || diagnostics === null) return undefined;
	return (diagnostics as Record<string, unknown>)[name];
}

test("collectAllStreams: only requested streams emit records (scope filtering)", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = makeNotePage([noteQueryResponse()]);
	const ctx = makeCtx(page, harness, ["notes"]);

	await collectAllStreams(ctx);

	assert.ok(
		harness.emitted.every((r) => r.stream === "notes"),
		"folders must not emit when not requested",
	);
	assert.ok(harness.emitted.length > 0, "expected at least one notes record");
});

test("collectAllStreams: requesting only folders emits no notes records", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = makeFakePage([folderQueryResponse()]);
	const ctx = makeCtx(page, harness, ["folders"]);

	await collectAllStreams(ctx);

	assert.ok(
		harness.emitted.every((r) => r.stream === "folders"),
		"notes must not emit when not requested",
	);
	assert.ok(harness.emitted.length > 0, "expected at least one folders record");
});

test("collectAllStreams: RECORD emits before STATE for each requested stream", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = makeFakePage([folderQueryResponse(), noteQueryResponse()]);
	const ctx = makeCtx(page, harness, ["folders", "notes"]);

	await collectAllStreams(ctx);

	const lastRecordIdx = harness.events.reduce(
		(acc, e, i) => (e.kind === "record" ? i : acc),
		-1,
	);
	const lastStateIdx = harness.events.reduce(
		(acc, e, i) =>
			e.kind === "message" && e.message.type === "STATE" ? i : acc,
		-1,
	);
	assert.ok(lastRecordIdx !== -1, "expected at least one RECORD event");
	assert.ok(lastStateIdx !== -1, "expected at least one STATE event");
	assert.ok(lastStateIdx > lastRecordIdx, "a STATE must land after records");
});

test("collectAllStreams: no records fail schema validation for well-formed CloudKit data", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = makeFakePage([folderQueryResponse(), noteQueryResponse()]);
	const ctx = makeCtx(page, harness, ["folders", "notes"]);

	await collectAllStreams(ctx);

	assert.equal(
		harness.skipped.length,
		0,
		`expected no SKIP_RESULTs, got ${JSON.stringify(harness.skipped)}`,
	);
});

test("collectAllStreams: two runs, second run's fingerprint cursor suppresses an unchanged note", async () => {
	const firstHarness = makeRecordingEmit(validateRecord);
	const firstPage = makeNotePage([noteQueryResponse()]);
	const firstCtx = makeCtx(firstPage, firstHarness, ["notes"]);
	await collectAllStreams(firstCtx);

	const firstState = firstHarness.protocolMessages.find(
		(m) => m.type === "STATE" && m.stream === "notes",
	);
	assert.ok(firstState && firstState.type === "STATE");
	assert.equal(firstHarness.emitted.length, 1, "first run emits the note");

	const secondHarness = makeRecordingEmit(validateRecord);
	const secondPage = makeNotePage([noteQueryResponse()]);
	const secondCtx = makeCtx(secondPage, secondHarness, ["notes"], {
		notes: firstState.cursor,
	});
	await collectAllStreams(secondCtx);

	assert.equal(
		secondHarness.emitted.length,
		0,
		"second run must not re-emit an unchanged note (fingerprint no-op gate)",
	);
});

test("collectAllStreams: a note whose content changed between runs re-emits", async () => {
	const firstHarness = makeRecordingEmit(validateRecord);
	const firstPage = makeNotePage([noteQueryResponse()]);
	const firstCtx = makeCtx(firstPage, firstHarness, ["notes"]);
	await collectAllStreams(firstCtx);
	const firstState = firstHarness.protocolMessages.find(
		(m) => m.type === "STATE" && m.stream === "notes",
	);
	assert.ok(firstState && firstState.type === "STATE");

	const changedResponse = noteQueryResponse();
	(
		changedResponse.records[0] as { fields: Record<string, unknown> }
	).fields.TitleEncrypted = { value: b64("Updated title") };

	const secondHarness = makeRecordingEmit(validateRecord);
	const secondPage = makeNotePage([changedResponse]);
	const secondCtx = makeCtx(secondPage, secondHarness, ["notes"], {
		notes: firstState.cursor,
	});
	await collectAllStreams(secondCtx);

	assert.equal(
		secondHarness.emitted.length,
		1,
		"a genuinely changed note must re-emit",
	);
	assert.equal(secondHarness.emitted[0]?.data.title, "Updated title");
});

test("collectAllStreams: paginates notes via continuationMarker", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = makeNotePage([
		noteQueryResponse({ continuationMarker: "page-2" }),
		{
			records: [
				{
					recordName: "note-2",
					recordType: "Note",
					fields: readableEmptyNoteFields({
						TitleEncrypted: { value: b64("Second note") },
					}),
				},
			],
		},
	]);
	const ctx = makeCtx(page, harness, ["notes"]);

	await collectAllStreams(ctx);

	const ids = harness.emitted.map((r) => r.data.id);
	assert.deepEqual(new Set(ids), new Set(["note-1", "note-2"]));
});

test("collectAllStreams: refuses malformed successful envelopes and does not checkpoint them", async () => {
	for (const stream of ["folders", "notes"] as const) {
		for (const malformed of [
			null,
			{},
			{ error: "temporarilyUnavailable" },
			{ records: null },
			{ records: [], continuationMarker: "" },
		]) {
			const harness = makeRecordingEmit(validateRecord);
			const page = makeFakePage(
				stream === "notes"
					? [
							{ stream: "folders", response: { records: [] } },
							{ stream, response: malformed },
						]
					: [{ stream, response: malformed }],
			);
			await collectAllStreams(makeCtx(page, harness, [stream]));
			assert.equal(harness.emitted.length, 0);
			assert.equal(
				harness.protocolMessages.some(
					(message) => message.type === "STATE" && message.stream === stream,
				),
				false,
				`${stream} malformed envelope ${JSON.stringify(malformed)} must not commit state`,
			);
			assert.ok(
				harness.protocolMessages.some(
					(message) =>
						message.type === "SKIP_RESULT" &&
						message.stream === stream &&
						message.reason === "icloud_invalid_query_response",
				),
				"malformed envelopes must leave a durable stream gap",
			);
		}
	}
});

test("collectAllStreams: a failed folder query leaves notes withheld without a folder projection", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = makeFakePage([
		{
			stream: "folders",
			response: { status: 200, json: { error: "temporarilyUnavailable" } },
		},
		noteQueryResponse(),
	]);
	await collectAllStreams(makeCtx(page, harness, ["folders", "notes"]));
	assert.equal(harness.emitted.length, 0);
	assert.ok(
		harness.protocolMessages.some(
			(message) =>
				message.type === "SKIP_RESULT" && message.stream === "folders",
		),
	);
	assert.ok(
		harness.protocolMessages.some(
			(message) =>
				message.type === "SKIP_RESULT" &&
				message.stream === "notes" &&
				message.reason === "icloud_omitted_rows",
		),
	);
	assert.equal(
		harness.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "notes",
		),
		false,
	);
});

test("collectAllStreams: a later note-page failure salvages its prefix without pruning prior state", async () => {
	const previous = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(makeNotePage([noteQueryResponse()]), previous, ["notes"]),
	);
	const priorState = previous.protocolMessages.find(
		(message) => message.type === "STATE" && message.stream === "notes",
	);
	assert.ok(priorState && priorState.type === "STATE");
	const harness = makeRecordingEmit(validateRecord);
	const prefix = noteQueryResponse({ continuationMarker: "page-2" });
	(
		prefix.records[0] as { fields: Record<string, unknown> }
	).fields.TitleEncrypted = {
		value: b64("Changed prefix row"),
	};
	const failure = { status: 503, json: null };
	await collectAllStreams(
		makeCtx(
			makeNotePage([
				{ stream: "notes", response: prefix },
				{ stream: "notes", response: failure },
			]),
			harness,
			["notes"],
			{ notes: priorState.cursor },
		),
	);
	assert.equal(
		harness.emitted.length,
		1,
		"a valid changed prefix row is salvaged",
	);
	assert.equal(harness.emitted[0]?.data.title, "Changed prefix row");
	assert.equal(
		harness.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "notes",
		),
		false,
		"a partial scan leaves the previous cursor intact instead of pruning unseen IDs",
	);
	assert.ok(
		harness.protocolMessages.some(
			(message) => message.type === "SKIP_RESULT" && message.stream === "notes",
		),
	);
});

test("collectAllStreams: repeated continuation markers stop as a gap", async () => {
	const harness = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(
			makeNotePage([
				noteQueryResponse({ continuationMarker: "same-page" }),
				noteQueryResponse({ continuationMarker: "same-page" }),
			]),
			harness,
			["notes"],
		),
	);
	assert.ok(
		harness.protocolMessages.some(
			(message) =>
				message.type === "SKIP_RESULT" &&
				message.reason === "icloud_no_progress",
		),
	);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
		"a repeated page cannot advance or prune the cursor",
	);
});

test("collectAllStreams: note records keep empty title values and reject non-Note rows", async () => {
	const harness = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(
			makeNotePage([
				{
					stream: "notes",
					response: {
						records: [
							{ recordName: "folder-like", recordType: "Folder", fields: {} },
							{
								recordName: "note-empty-title",
								recordType: "Note",
								fields: readableEmptyNoteFields({
									TitleEncrypted: { value: b64("") },
								}),
							},
						],
					},
				},
			]),
			harness,
			["notes"],
		),
	);
	assert.equal(harness.emitted.length, 1);
	assert.equal(harness.emitted[0]?.data.id, "note-empty-title");
	assert.equal(harness.emitted[0]?.data.title, "");
});

test("collectAllStreams: sparse CloudKit optional fields emit their defaults and cover the row", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = makeNotePage([
		{
			records: [
				{
					recordName: "note-sparse-defaults",
					recordType: "Note",
					fields: {
						TitleEncrypted: { value: b64("Sparse note") },
						TextDataEncrypted: { value: "" },
					},
				},
			],
		},
	]);
	await collectAllStreams(makeCtx(page, harness, ["notes"]));

	assert.deepEqual(harness.emitted, [
		{
			stream: "notes",
			data: {
				id: "note-sparse-defaults",
				title: "Sparse note",
				snippet: null,
				folder_id: null,
				folder_name: null,
				is_pinned: false,
				created_at: null,
				modified_at: null,
				has_attachments: false,
				text_content: null,
			},
		},
	]);
	assert.ok(
		harness.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "notes",
		),
		"a valid sparse row and verified query end must cover notes",
	);
});

test("collectAllStreams: folder query follows its continuation pages", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const folder = (id: string) => ({
		recordName: id,
		recordType: "Folder",
		fields: { TitleEncrypted: { value: null } },
	});
	await collectAllStreams(
		makeCtx(
			makeFakePage([
				{ records: [folder("folder-1")], continuationMarker: "folders-2" },
				{ records: [folder("folder-2")] },
			]),
			harness,
			["folders"],
		),
	);
	assert.deepEqual(
		new Set(harness.emitted.map((record) => record.data.id)),
		new Set(["folder-1", "folder-2"]),
	);
});

test("collectAllStreams: notes collection loads and projects folder names even when folders are not requested", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const folder = {
		records: [
			{
				recordName: "folder-work",
				recordType: "Folder",
				fields: { TitleEncrypted: { value: b64("Work") } },
			},
		],
	};
	await collectAllStreams(
		makeCtx(makeFakePage([folder, noteQueryResponse()]), harness, ["notes"]),
	);
	assert.deepEqual(
		harness.emitted.map((record) => record.stream),
		["notes"],
	);
	assert.equal(harness.emitted[0]?.data.folder_name, "Work");
});

test("collectAllStreams: unreadable mapped fields are reported and veto both stream checkpoints", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = makeFakePage([
		{
			stream: "folders",
			response: {
				records: [
					{
						recordName: "folder-unreadable-title",
						recordType: "Folder",
						fields: { TitleEncrypted: { value: 42 } },
					},
					{
						recordName: "folder-invalid-title-encoding",
						recordType: "Folder",
						fields: { TitleEncrypted: { value: "!!!" } },
					},
				],
			},
		},
		{
			stream: "notes",
			response: {
				records: [
					{
						recordName: "note-unreadable-fields",
						recordType: "Note",
						fields: readableEmptyNoteFields({
							TitleEncrypted: { value: "!!!" },
							SnippetEncrypted: {
								type: 42,
								value: b64("synthetic snippet"),
							},
							Folder: { value: { recordName: "folder-unreadable-title" } },
							IsPinned: { value: {} },
							Attachments: { value: "unreadable" },
							CreationDate: {},
							TextDataEncrypted: { value: 42 },
						}),
					},
					{
						recordName: "note-unreadable-folder-reference",
						recordType: "Note",
						fields: readableEmptyNoteFields({
							Folder: { value: { recordName: 42 } },
						}),
					},
				],
			},
		},
	]);
	await collectAllStreams(makeCtx(page, harness, ["folders", "notes"]));
	assert.equal(
		harness.emitted.length,
		0,
		"rows with any unreadable mapped field must be withheld entirely",
	);

	for (const stream of ["folders", "notes"] as const) {
		assert.equal(
			harness.protocolMessages.some(
				(message) => message.type === "STATE" && message.stream === stream,
			),
			false,
			`${stream} unreadable mapped fields must veto STATE`,
		);
		const skip = harness.protocolMessages.find(
			(message) => message.type === "SKIP_RESULT" && message.stream === stream,
		);
		assert.ok(skip && skip.type === "SKIP_RESULT");
		assert.ok(
			Array.isArray(diagnosticField(skip, "field_omissions")),
			`${stream} must report the omitted field names`,
		);
	}
	const noteSkip = harness.protocolMessages.find(
		(message) => message.type === "SKIP_RESULT" && message.stream === "notes",
	);
	assert.ok(noteSkip && noteSkip.type === "SKIP_RESULT");
	const noteRows = diagnosticField(noteSkip, "omitted_row_diagnostics") as {
		row_index: number;
		field_omissions: { field: string; reason: string; source_shape: unknown }[];
	}[];
	assert.deepEqual(
		noteRows.map((row) => ({
			row_index: row.row_index,
			omissions: row.field_omissions.map(({ field, reason, source_shape }) => ({
				field,
				reason,
				source_shape,
			})),
		})),
		[
			{
				row_index: 0,
				omissions: [
					{
						field: "created_at",
						reason: "malformed_field_wrapper",
						source_shape: { type: "object", keys: [] },
					},
					{
						field: "folder_name",
						reason: "folder_name_unavailable",
						source_shape: { type: "string", length: 23 },
					},
					{
						field: "has_attachments",
						reason: "expected_attachment_list",
						source_shape: { type: "string", length: 10 },
					},
					{
						field: "is_pinned",
						reason: "expected_boolean_flag",
						source_shape: { type: "object", keys: [] },
					},
					{
						field: "snippet",
						reason: "malformed_field_wrapper",
						source_shape: { type: "object", keys: ["type", "value"] },
					},
					{
						field: "text_content",
						reason: "expected_base64_body",
						source_shape: { type: "number" },
					},
					{
						field: "title",
						reason: "invalid_base64_text",
						source_shape: { type: "string", length: 3 },
					},
				],
			},
			{
				row_index: 1,
				omissions: [
					{
						field: "folder_id",
						reason: "malformed_folder_reference",
						source_shape: { type: "object", keys: ["recordName"] },
					},
					{
						field: "folder_name",
						reason: "folder_reference_unavailable",
						source_shape: { type: "object", keys: ["recordName"] },
					},
				],
			},
		],
	);
	assert.deepEqual(
		(diagnosticField(noteSkip, "field_omissions") as { field: string }[])
			.map((omission) => omission.field)
			.filter((field, index, fields) => fields.indexOf(field) === index),
		[
			"created_at",
			"folder_id",
			"folder_name",
			"has_attachments",
			"is_pinned",
			"snippet",
			"text_content",
			"title",
		],
	);
});

test("collectAllStreams: absent required title/body fields withhold the note row", async () => {
	const harness = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(
			makeNotePage([
				{
					records: [
						{
							recordName: "note-missing-title",
							recordType: "Note",
							fields: { Folder: { value: null } },
						},
					],
				},
			]),
			harness,
			["notes"],
		),
	);
	assert.equal(
		harness.emitted.length,
		0,
		"a row with an unavailable mapped field must be withheld entirely",
	);
	assert.equal(
		harness.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "notes",
		),
		false,
	);
	const skip = harness.protocolMessages.find(
		(message) => message.type === "SKIP_RESULT" && message.stream === "notes",
	);
	assert.ok(skip && skip.type === "SKIP_RESULT");
	assert.ok(
		(
			diagnosticField(skip, "field_omissions") as {
				field: string;
				reason: string;
			}[]
		).some(
			(omission) =>
				omission.field === "title" && omission.reason === "missing_field",
		),
	);
	const omittedRows = diagnosticField(skip, "omitted_row_diagnostics") as {
		row_index: number;
		field_omissions: { field: string; reason: string; source_shape: unknown }[];
	}[];
	assert.deepEqual(
		omittedRows.map((row) => ({
			row_index: row.row_index,
			omissions: row.field_omissions.map(({ field, reason, source_shape }) => ({
				field,
				reason,
				source_shape,
			})),
		})),
		[
			{
				row_index: 0,
				omissions: [
					{
						field: "text_content",
						reason: "missing_field",
						source_shape: { type: "missing" },
					},
					{
						field: "title",
						reason: "missing_field",
						source_shape: { type: "missing" },
					},
				],
			},
		],
	);
	assert.equal(diagnosticField(skip, "rows_seen"), 1);
	assert.equal(diagnosticField(skip, "source_rows_seen"), 1);
	assert.equal(diagnosticField(skip, "note_rows_seen"), 1);
	assert.equal(diagnosticField(skip, "deleted_note_rows"), 0);
});

test("collectAllStreams: notes-only folder projection reports unreadable referenced names", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = makeFakePage([
		{
			stream: "folders",
			response: {
				records: [
					{
						recordName: "folder-projection-unreadable",
						recordType: "Folder",
						fields: { TitleEncrypted: { value: 42 } },
					},
				],
			},
		},
		{
			stream: "notes",
			response: {
				records: [
					{
						recordName: "note-with-unreadable-folder-name",
						recordType: "Note",
						fields: readableEmptyNoteFields({
							Folder: {
								value: { recordName: "folder-projection-unreadable" },
							},
						}),
					},
				],
			},
		},
	]);
	await collectAllStreams(makeCtx(page, harness, ["notes"]));

	assert.equal(
		harness.emitted.length,
		0,
		"an unresolved folder projection makes the whole note row uncovered",
	);
	assert.equal(
		harness.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "notes",
		),
		false,
	);
	const skip = harness.protocolMessages.find(
		(message) => message.type === "SKIP_RESULT" && message.stream === "notes",
	);
	assert.ok(skip && skip.type === "SKIP_RESULT");
	assert.deepEqual(diagnosticField(skip, "field_omissions"), [
		{
			field: "folder_name",
			reason: "folder_name_unavailable",
			source_shape: {
				type: "string",
				length: "folder-projection-unreadable".length,
			},
		},
	]);
});

test("collectAllStreams: drains notes beyond the old 200-page cap", async () => {
	const pages = Array.from({ length: 201 }, (_, index) => ({
		records: [
			{
				recordName: `note-${index}`,
				recordType: "Note",
				fields: readableEmptyNoteFields({
					TitleEncrypted: { value: b64(`Synthetic ${index}`) },
				}),
			},
		],
		...(index < 200 ? { continuationMarker: `page-${index + 1}` } : {}),
	}));
	const harness = makeRecordingEmit(validateRecord);
	await collectAllStreams(makeCtx(makeNotePage(pages), harness, ["notes"]));
	assert.equal(harness.emitted.length, 201);
	assert.equal(harness.skipped.length, 0);
});

test("collectAllStreams: rejected schema rows produce an omission gap and cannot prune state", async () => {
	const prior = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(makeNotePage([noteQueryResponse()]), prior, ["notes"]),
	);
	const priorState = prior.protocolMessages.find(
		(message) => message.type === "STATE" && message.stream === "notes",
	);
	assert.ok(priorState && priorState.type === "STATE");
	const longTitle = "x".repeat(2001);
	const response = {
		records: [
			{
				recordName: "note-oversized",
				recordType: "Note",
				fields: readableEmptyNoteFields({
					TitleEncrypted: { value: b64(longTitle) },
				}),
			},
		],
	};
	const harness = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(makeNotePage([response]), harness, ["notes"], {
			notes: priorState.cursor,
		}),
	);
	assert.equal(harness.emitted.length, 0);
	assert.ok(
		harness.protocolMessages.some(
			(message) =>
				message.type === "SKIP_RESULT" &&
				message.reason === "icloud_omitted_rows",
		),
	);
	assert.equal(
		harness.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "notes",
		),
		false,
		"discarded rows veto the completion checkpoint",
	);
});

test("collectAllStreams: wrong page cannot start a CloudKit scan", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = makeNotePage([noteQueryResponse()]) as Page & {
		setUrl: (url: string) => void;
	};
	page.setUrl("https://www.icloud.com/mail");
	await assert.rejects(
		collectAllStreams(makeCtx(page, harness, ["notes"])),
		/icloud_wrong_page/,
	);
	assert.equal(harness.protocolMessages.length, 0);
});

test("collectAllStreams: an open note subroute is still the Notes app", async () => {
	const harness = makeRecordingEmit(validateRecord);
	let page: Page & {
		setUrl: (url: string) => void;
	};
	page = makeNotePage([noteQueryResponse()], () => {
		page.setUrl("https://www.icloud.com/notes");
	}) as Page & { setUrl: (url: string) => void };
	page.setUrl("https://www.icloud.com/notes/note/synthetic-note-id");

	await collectAllStreams(makeCtx(page, harness, ["notes"]));

	assert.ok(
		harness.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "notes",
		),
		"the open note route should permit collection after the full query completes",
	);
});

test("collectAllStreams: unloaded and blocked pages veto collection", async () => {
	await Promise.all(
		(
			[
				[{ readyState: "loading" }, /icloud_page_unloaded/],
				[{ blocked: true }, /icloud_page_blocked/],
			] as const
		).map(async ([readiness, reason]) => {
			const harness = makeRecordingEmit(validateRecord);
			await assert.rejects(
				collectAllStreams(
					makeCtx(makeFakePage([], undefined, readiness), harness, ["notes"]),
				),
				reason,
			);
			assert.equal(harness.protocolMessages.length, 0);
		}),
	);
});

test("collectAllStreams: navigation change vetoes a terminal query response", async () => {
	const harness = makeRecordingEmit(validateRecord);
	let page!: Page & { setUrl: (url: string) => void };
	page = makeNotePage([noteQueryResponse()], () => {
		page.setUrl("https://www.icloud.com/mail");
	}) as Page & { setUrl: (url: string) => void };
	await collectAllStreams(makeCtx(page, harness, ["notes"]));
	assert.equal(
		harness.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "notes",
		),
		false,
	);
	assert.ok(
		harness.protocolMessages.some(
			(message) =>
				message.type === "SKIP_RESULT" &&
				message.reason === "icloud_navigation_changed",
		),
	);
});

test("collectAllStreams: throws when the CloudKit config cannot be resolved (auth not live)", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = {
		evaluate: (_fn: unknown, arg: unknown): Promise<unknown> =>
			Promise.resolve(
				arg === undefined
					? {
							href: "https://www.icloud.com/notes",
							readyState: "complete",
							blocked: false,
						}
					: { status: 401, json: null },
			),
		url: () => "https://www.icloud.com/notes",
	} as unknown as Page;
	const ctx = makeCtx(page, harness, ["notes"]);

	await assert.rejects(collectAllStreams(ctx), /icloud_auth_failed/);
});

test("iCloud sign-in keeps one Patchright tab and collection reuses the authenticated page", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const context = await browser.newContext();
		await context.route("https://www.icloud.com/**", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><title>iCloud fixture</title>",
			}),
		);
		let validateCalls = 0;
		await context.route("https://setup.icloud.com/**", (route) => {
			validateCalls += 1;
			const cors = {
				"access-control-allow-credentials": "true",
				"access-control-allow-origin": "https://www.icloud.com",
			};
			const hasSession = Boolean(
				route
					.request()
					.headers()
					.cookie?.includes("icloud-fixture-session=live"),
			);
			return route.fulfill({
				status: hasSession ? 200 : 401,
				headers: cors,
				contentType: "application/json",
				body: JSON.stringify(hasSession ? VALIDATE_RESPONSE : {}),
			});
		});
		let openedPages = 0;
		context.on("page", () => {
			openedPages += 1;
		});
		const page = (await context.newPage()) as unknown as Page;
		openedPages = 0;
		const completions: string[] = [];
		await ensureICloudNotesSession({
			assist: async () => {
				await page.evaluate(() => {
					document.cookie =
						"icloud-fixture-session=live; domain=.icloud.com; path=/; Secure";
				});
				return "icloud_fixture_handoff";
			},
			completeAssistance: async (_id, status) => {
				completions.push(status);
			},
			capture: null,
			checkpoint: async () => undefined,
			context: context as unknown as EnsureSessionArgs["context"],
			credentials: {},
			onCredentialSubmit: () => undefined,
			page,
			progress: async () => undefined,
			sendInteraction: async () => {
				throw new Error("unexpected manual-action fallback");
			},
		});

		assert.deepEqual(completions, ["resolved"]);
		assert.equal(openedPages, 0);
		assert.equal(context.pages().length, 1);
		assert.equal(new URL(page.url()).origin, "https://www.icloud.com");
		const harness = makeRecordingEmit(validateRecord);
		await collectAllStreams(makeCtx(page, harness, []));
		assert.ok(
			validateCalls >= 2,
			"session establishment probes the page; an empty stream selection makes no collection request",
		);
		assert.equal(context.pages().length, 1);
		await context.close();
	} finally {
		await browser.close();
	}
});
