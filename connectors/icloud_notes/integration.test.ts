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
import { gzipSync } from "node:zlib";
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
	readiness: {
		readyState?: string;
		blocked?: boolean;
		readyStateAfterWait?: string;
		failReadinessEvaluations?: number;
		onReadinessEvaluationPending?: (resolve: () => void) => void;
		onReadinessEvaluationFailure?: () => void;
		onValidate?: () => void;
		reloadReadyState?: string;
		reloadUrl?: string;
		onReload?: () => void;
	} = {},
): Page {
	const streams: Record<string, unknown[]> = { folders: [], notes: [] };
	let currentUrl = "https://www.icloud.com/notes";
	let readyState = readiness.readyState ?? "complete";
	let readinessEvaluationFailures = readiness.failReadinessEvaluations ?? 0;
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
		if (arg === "icloud-notes-location") return Promise.resolve(currentUrl);
		if (arg === undefined) {
			const onReadinessEvaluationPending =
				readiness.onReadinessEvaluationPending;
			if (onReadinessEvaluationPending !== undefined) {
				return new Promise((resolve) => {
					onReadinessEvaluationPending(() =>
						resolve({
							href: currentUrl,
							readyState,
							blocked: readiness.blocked ?? false,
						}),
					);
				});
			}
			if (readinessEvaluationFailures > 0) {
				readinessEvaluationFailures -= 1;
				readiness.onReadinessEvaluationFailure?.();
				return Promise.reject(
					new Error("transient document evaluation failure"),
				);
			}
			return Promise.resolve({
				href: currentUrl,
				readyState,
				blocked: readiness.blocked ?? false,
			});
		}
		if (arg === VALIDATE_URL) {
			readiness.onValidate?.();
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
		waitForLoadState: async () => {
			if (readiness.readyStateAfterWait !== undefined) {
				readyState = readiness.readyStateAfterWait;
			}
		},
		goto: async (url: string) => {
			currentUrl = url;
			readiness.onReload?.();
			if (readiness.reloadReadyState !== undefined) {
				readyState = readiness.reloadReadyState;
			}
			if (readiness.reloadUrl !== undefined) currentUrl = readiness.reloadUrl;
			return null;
		},
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
						message.reason === "inventory_not_proven_complete" &&
						diagnosticField(message, "source_reason") ===
							"icloud_invalid_query_response",
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
				message.reason === "inventory_not_proven_complete" &&
				diagnosticField(message, "source_reason") === "icloud_omitted_rows",
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
				message.reason === "inventory_not_proven_complete" &&
				diagnosticField(message, "source_reason") === "icloud_no_progress",
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
	const progress: { intentional_exclusions?: number }[] = [];
	const ctx = makeCtx(
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
	);
	ctx.progress = async (_message, extra) => {
		if (
			extra &&
			"intentional_exclusions" in extra &&
			typeof extra.intentional_exclusions === "number"
		) {
			progress.push({
				intentional_exclusions: extra.intentional_exclusions,
			});
		}
	};
	await collectAllStreams(ctx);
	assert.equal(harness.emitted.length, 1);
	assert.equal(harness.emitted[0]?.data.id, "note-empty-title");
	assert.equal(harness.emitted[0]?.data.title, "");
	assert.deepEqual(progress.at(-1)?.intentional_exclusions, 1);
});

test("collectAllStreams: unknown recordType withholds both streams and preserves seeded state", async () => {
	const previous = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(
			makeFakePage([
				{ stream: "folders", response: folderQueryResponse() },
				{ stream: "notes", response: noteQueryResponse() },
			]),
			previous,
			["folders", "notes"],
		),
	);
	const seed = Object.fromEntries(
		previous.protocolMessages
			.filter((message) => message.type === "STATE")
			.map((message) => [message.stream, message.cursor]),
	);
	assert.deepEqual(Object.keys(seed).sort(), ["folders", "notes"]);

	const harness = makeRecordingEmit(validateRecord);
	const ctx = makeCtx(
		makeFakePage([
			{
				stream: "folders",
				response: {
					records: [
						{
							recordName: "folder-unknown-type",
							recordType: "",
							fields: { TitleEncrypted: { value: b64("Work") } },
						},
					],
				},
			},
			{
				stream: "notes",
				response: {
					records: [
						{
							recordName: "note-missing-type",
							fields: readableEmptyNoteFields({
								TitleEncrypted: { value: b64("Unknown type") },
							}),
						},
					],
				},
			},
		]),
		harness,
		["folders", "notes"],
		seed,
	);
	await collectAllStreams(ctx);

	assert.equal(harness.emitted.length, 0);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
		"an unavailable record discriminator must veto both stream checkpoints",
	);
	assert.deepEqual(ctx.state, seed, "prior cursors must remain untouched");
	for (const [stream, reason, shape] of [
		["folders", "malformed_record_type", { type: "string", length: 0 }],
		["notes", "missing_record_type", { type: "missing" }],
	] as const) {
		const skip = harness.protocolMessages.find(
			(message) => message.type === "SKIP_RESULT" && message.stream === stream,
		);
		assert.ok(
			skip && skip.type === "SKIP_RESULT",
			`${stream} must be withheld`,
		);
		assert.equal(skip.reason, "inventory_not_proven_complete");
		// The same unreadable discriminator fails every retry of this revision.
		assert.deepEqual(skip.recovery_hint, {
			action: "not_retriable",
			retryable: false,
		});
		assert.equal(diagnosticField(skip, "source_reason"), "icloud_omitted_rows");
		assert.deepEqual(diagnosticField(skip, "omitted_row_diagnostics"), [
			{
				row_index: 0,
				record_id:
					stream === "folders" ? "folder-unknown-type" : "note-missing-type",
				field_count: 1,
				field_omissions: [{ field: "recordType", reason, source_shape: shape }],
				row_reason: "unavailable_fields",
			},
		]);
	}
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
							TextDataEncrypted: {
								value: gzipSync(Buffer.from([0x00, 0xff, 0xfe])).toString(
									"base64",
								),
							},
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
						reason: "body_protobuf_malformed",
						source_shape: { type: "string", length: 32 },
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

test("collectAllStreams: malformed Deleted controls withhold rows and preserve seeded state", async () => {
	const previous = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(makeNotePage([noteQueryResponse()]), previous, ["notes"]),
	);
	const previousState = previous.protocolMessages.find(
		(message) => message.type === "STATE" && message.stream === "notes",
	);
	assert.ok(previousState && previousState.type === "STATE");
	const seed = { notes: previousState.cursor };

	const harness = makeRecordingEmit(validateRecord);
	const malformedNotes = {
		records: [
			{
				recordName: "note-deleted-wrapper-malformed",
				recordType: "Note",
				fields: readableEmptyNoteFields({
					TitleEncrypted: { value: b64("Wrapper malformed") },
					Deleted: {},
				}),
			},
			{
				recordName: "note-deleted-value-malformed",
				recordType: "Note",
				fields: readableEmptyNoteFields({
					TitleEncrypted: { value: b64("Value malformed") },
					Deleted: { value: "bad" },
				}),
			},
		],
	};
	const ctx = makeCtx(makeNotePage([malformedNotes]), harness, ["notes"], seed);
	await collectAllStreams(ctx);

	assert.equal(
		harness.emitted.length,
		0,
		"malformed control rows must not emit",
	);
	assert.equal(
		harness.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "notes",
		),
		false,
		"an unavailable deletion status must veto notes STATE",
	);
	assert.deepEqual(ctx.state, seed, "the prior cursor must remain untouched");
	const skip = harness.protocolMessages.find(
		(message) => message.type === "SKIP_RESULT" && message.stream === "notes",
	);
	assert.ok(skip && skip.type === "SKIP_RESULT");
	assert.equal(skip.reason, "inventory_not_proven_complete");
	// The same malformed control fails every retry of this revision.
	assert.deepEqual(skip.recovery_hint, {
		action: "not_retriable",
		retryable: false,
	});
	assert.equal(diagnosticField(skip, "source_reason"), "icloud_omitted_rows");
	assert.deepEqual(diagnosticField(skip, "omitted_row_diagnostics"), [
		{
			row_index: 0,
			record_id: "note-deleted-wrapper-malformed",
			field_count: 1,
			field_omissions: [
				{
					field: "deleted",
					reason: "malformed_field_wrapper",
					source_shape: { type: "object", keys: [] },
				},
			],
			row_reason: "unavailable_fields",
		},
		{
			row_index: 1,
			record_id: "note-deleted-value-malformed",
			field_count: 1,
			field_omissions: [
				{
					field: "deleted",
					reason: "expected_deleted_flag",
					source_shape: { type: "string", length: 3 },
				},
			],
			row_reason: "unavailable_fields",
		},
	]);
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
				message.reason === "inventory_not_proven_complete" &&
				diagnosticField(message, "source_reason") === "icloud_omitted_rows",
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
				[{ readyState: "loading" }, /icloud_readiness_exhausted/],
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

test("collectAllStreams: readiness recovers after load and transient document evaluation failures", async () => {
	const loadingHarness = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(
			makeFakePage([folderQueryResponse(), noteQueryResponse()], undefined, {
				readyState: "loading",
				readyStateAfterWait: "complete",
			}),
			loadingHarness,
			["notes"],
		),
	);
	assert.ok(
		loadingHarness.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "notes",
		),
		"a page that finishes loading should proceed to collection",
	);

	let reloads = 0;
	const transientHarness = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(
			makeFakePage([folderQueryResponse(), noteQueryResponse()], undefined, {
				failReadinessEvaluations: 1,
				onReload: () => {
					reloads += 1;
				},
				reloadReadyState: "complete",
			}),
			transientHarness,
			["notes"],
		),
	);
	assert.equal(reloads, 1);
	assert.ok(
		transientHarness.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "notes",
		),
		"a stable Notes page after a transient evaluation failure should collect",
	);
});

test("collectAllStreams: readiness exhaustion and navigation away fail closed", async () => {
	let reloads = 0;
	const loadingHarness = makeRecordingEmit(validateRecord);
	await assert.rejects(
		collectAllStreams(
			makeCtx(
				makeFakePage([folderQueryResponse(), noteQueryResponse()], undefined, {
					readyState: "loading",
					onReload: () => {
						reloads += 1;
					},
				}),
				loadingHarness,
				["notes"],
			),
		),
		/icloud_readiness_exhausted/,
	);
	assert.equal(reloads, 2, "only the configured bounded reloads should run");
	assert.equal(loadingHarness.protocolMessages.length, 0);

	let blockedReloads = 0;
	const blockedHarness = makeRecordingEmit(validateRecord);
	await assert.rejects(
		collectAllStreams(
			makeCtx(
				makeFakePage([folderQueryResponse(), noteQueryResponse()], undefined, {
					blocked: true,
					onReload: () => {
						blockedReloads += 1;
					},
				}),
				blockedHarness,
				["notes"],
			),
		),
		/icloud_page_blocked/,
	);
	assert.equal(
		blockedReloads,
		0,
		"blocked pages must never be reloaded past sign-in",
	);
	assert.equal(blockedHarness.protocolMessages.length, 0);

	const navigationHarness = makeRecordingEmit(validateRecord);
	let navigationReloads = 0;
	const navigationPage = makeFakePage(
		[folderQueryResponse(), noteQueryResponse()],
		undefined,
		{
			failReadinessEvaluations: 1,
			onReadinessEvaluationFailure: () => {
				(navigationPage as Page & { setUrl: (url: string) => void }).setUrl(
					"https://www.icloud.com/mail",
				);
			},
			onReload: () => {
				navigationReloads += 1;
			},
		},
	) as Page & { setUrl: (url: string) => void };
	await assert.rejects(
		collectAllStreams(makeCtx(navigationPage, navigationHarness, ["notes"])),
		/icloud_wrong_page/,
	);
	assert.equal(
		navigationReloads,
		0,
		"recovery must not reload after navigation leaves Notes during evaluation",
	);
	assert.equal(navigationHarness.protocolMessages.length, 0);
});

test("collectAllStreams: pending readiness evaluations are bounded and cannot start collection", {
	timeout: 20_000,
}, async () => {
	let validations = 0;
	let queries = 0;
	const finishPendingEvaluations: Array<() => void> = [];
	const harness = makeRecordingEmit(validateRecord);
	await assert.rejects(
		collectAllStreams(
			makeCtx(
				makeFakePage(
					[folderQueryResponse(), noteQueryResponse()],
					() => {
						queries += 1;
					},
					{
						onReadinessEvaluationPending: (resolve) => {
							finishPendingEvaluations.push(resolve);
						},
						onValidate: () => {
							validations += 1;
						},
					},
				),
				harness,
				["notes"],
			),
		),
		/icloud_readiness_exhausted/,
	);
	assert.ok(
		finishPendingEvaluations.length > 0,
		"readiness must start a probe before it can exhaust its budget",
	);
	for (const finish of finishPendingEvaluations) finish();
	assert.equal(validations, 0, "validate must not run after readiness timeout");
	assert.equal(queries, 0, "queries must not run after readiness timeout");
	assert.equal(harness.emitted.length, 0, "no records should be emitted");
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
		"no stream state should be emitted",
	);
});

for (const locationRead of [1, 2, 3, 4]) {
	test(`collectAllStreams: location read ${locationRead} never settling stays within the readiness deadline`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const harness = makeRecordingEmit(validateRecord);
		let reads = 0;
		let validations = 0;
		let reloads = 0;
		const page = makeFakePage([], undefined, {
			readyState: "loading",
			onValidate: () => {
				validations += 1;
			},
			onReload: () => {
				reloads += 1;
			},
		});
		const evaluate = page.evaluate.bind(page);
		page.evaluate = ((_fn: unknown, arg: unknown) => {
			if (arg === "icloud-notes-location" && ++reads >= locationRead) {
				return new Promise(() => {});
			}
			return evaluate(_fn as never, arg);
		}) as Page["evaluate"];
		let settled = false;
		const collection = assert
			.rejects(
				collectAllStreams(makeCtx(page, harness, ["notes"])),
				/icloud_readiness_exhausted/,
			)
			.then(() => {
				settled = true;
			});
		for (let elapsed = 0; elapsed <= 20_000 && !settled; elapsed += 1000) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (elapsed < 20_000) t.mock.timers.tick(1000);
		}
		assert.equal(
			settled,
			true,
			"location reads must not escape the shared 20 s deadline",
		);
		await collection;
		assert.ok(Date.now() <= 20_000);
		assert.ok(reads >= locationRead);
		assert.equal(validations, 0);
		assert.equal(
			reloads,
			0,
			"an unreadable current route must never be reloaded",
		);
		assert.equal(harness.events.length, 0);
	});

	test(`collectAllStreams: location read ${locationRead} destroyed context recovers safely`, async () => {
		const harness = makeRecordingEmit(validateRecord);
		let reads = 0;
		let reloads = 0;
		const page = makeFakePage([folderQueryResponse()], undefined, {
			...(locationRead === 4
				? { readyState: "loading", readyStateAfterWait: "loading" }
				: {}),
			onReload: () => {
				reloads += 1;
			},
			reloadReadyState: "complete",
		});
		const evaluate = page.evaluate.bind(page);
		let probes = 0;
		page.evaluate = ((fn: unknown, arg: unknown) => {
			if (arg === "icloud-notes-location" && ++reads === locationRead) {
				return Promise.reject(
					new Error(
						"Execution context was destroyed, most likely because of a navigation",
					),
				);
			}
			if (arg === undefined && ++probes > 1) {
				return Promise.resolve({
					href: "https://www.icloud.com/notes",
					readyState: "complete",
					blocked: false,
				});
			}
			return evaluate(fn as never, arg);
		}) as Page["evaluate"];
		await collectAllStreams(makeCtx(page, harness, ["folders"]));
		assert.ok(
			reads > locationRead,
			"the transient location failure must retry",
		);
		assert.equal(reloads, locationRead === 4 ? 0 : 1);
		assert.ok(
			harness.protocolMessages.some((message) => message.type === "STATE"),
		);
	});
}

test("collectAllStreams: location failure followed by navigation away vetoes recovery reload", async () => {
	const harness = makeRecordingEmit(validateRecord);
	let reloads = 0;
	const page = makeFakePage([], undefined, {
		onReload: () => {
			reloads += 1;
		},
	}) as Page & { setUrl: (url: string) => void };
	const evaluate = page.evaluate.bind(page);
	let reads = 0;
	page.evaluate = ((fn: unknown, arg: unknown) => {
		if (arg === "icloud-notes-location" && ++reads === 2) {
			page.setUrl("https://www.icloud.com/mail");
			return Promise.reject(new Error("Execution context was destroyed"));
		}
		return evaluate(fn as never, arg);
	}) as Page["evaluate"];
	await assert.rejects(
		collectAllStreams(makeCtx(page, harness, ["notes"])),
		/icloud_wrong_page/,
	);
	assert.equal(reloads, 0);
	assert.equal(harness.events.length, 0);
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
				message.reason === "inventory_not_proven_complete" &&
				diagnosticField(message, "source_reason") ===
					"icloud_navigation_changed",
		),
	);
});

test("collectAllStreams: throws when the CloudKit config cannot be resolved (auth not live)", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = {
		evaluate: (_fn: unknown, arg: unknown): Promise<unknown> =>
			Promise.resolve(
				arg === "icloud-notes-location"
					? "https://www.icloud.com/notes"
					: arg === undefined
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

test("collectAllStreams: an empty stream selection makes no page request", async () => {
	let pageCalls = 0;
	const page = {
		evaluate: () => {
			pageCalls += 1;
			return Promise.resolve(null);
		},
		url: () => {
			pageCalls += 1;
			return "https://www.icloud.com/notes";
		},
	} as unknown as Page;
	const harness = makeRecordingEmit(validateRecord);
	await collectAllStreams(makeCtx(page, harness, []));
	assert.equal(pageCalls, 0);
	assert.deepEqual(harness.protocolMessages, []);
	assert.deepEqual(harness.emitted, []);
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
		const cloudKitQueries: string[] = [];
		await context.route("https://p00-ckdatabasews.icloud.com/**", (route) => {
			const request = route.request();
			const hasSession = Boolean(
				request.headers().cookie?.includes("icloud-fixture-session=live"),
			);
			const indexName = (
				JSON.parse(request.postData() ?? "{}") as {
					query?: { filterBy?: { fieldValue?: { value?: string } }[] };
				}
			).query?.filterBy?.[0]?.fieldValue?.value;
			cloudKitQueries.push(`${indexName}:${hasSession ? "session" : "none"}`);
			return route.fulfill({
				status: hasSession ? 200 : 401,
				headers: {
					"access-control-allow-credentials": "true",
					"access-control-allow-origin": "https://www.icloud.com",
				},
				contentType: "application/json",
				body: JSON.stringify(
					indexName === "parentless"
						? folderQueryResponse()
						: noteQueryResponse(),
				),
			});
		});
		const validateCallsBeforeCollection = validateCalls;
		const harness = makeRecordingEmit(validateRecord);
		await collectAllStreams(makeCtx(page, harness, ["notes"]));
		assert.ok(
			validateCalls > validateCallsBeforeCollection,
			"collection resolves CloudKit from the authenticated page",
		);
		assert.deepEqual(
			cloudKitQueries,
			["parentless:session", "recents:session"],
			"both CloudKit queries carry the session cookie set during sign-in",
		);
		assert.deepEqual(
			harness.emitted.map((record) => ({
				stream: record.stream,
				id: record.data.id,
				folder_name: record.data.folder_name,
			})),
			[{ stream: "notes", id: "note-1", folder_name: "Work" }],
		);
		assert.ok(
			harness.protocolMessages.some(
				(message) => message.type === "STATE" && message.stream === "notes",
			),
			"the collected notes stream checkpoints",
		);
		assert.equal(context.pages().length, 1);
		await context.close();
	} finally {
		await browser.close();
	}
});

test("collectAllStreams: invalid UTF-8 in a title, snippet or folder name withholds the row and the checkpoint until a repaired retry re-emits it", async () => {
	// "/w==" is valid base64 for the one byte 0xFF, which is not UTF-8.
	const INVALID_UTF8 = "/w==";
	const note = (fields: Record<string, unknown>) => ({
		records: [
			{
				recordName: "note-text",
				recordType: "Note",
				fields: readableEmptyNoteFields(fields),
			},
		],
	});
	const folder = (title: string) => ({
		records: [
			{
				recordName: "folder-text",
				recordType: "Folder",
				fields: { TitleEncrypted: { value: title } },
			},
		],
	});
	const notesPage = (response: unknown) => makeNotePage([response]);
	const foldersPage = (response: unknown) =>
		makeFakePage([{ stream: "folders", response }]);
	const cases = [
		{
			stream: "notes",
			field: "title",
			page: notesPage,
			seed: noteQueryResponse(),
			broken: note({ TitleEncrypted: { value: INVALID_UTF8 } }),
			repaired: note({ TitleEncrypted: { value: b64("Repaired title") } }),
			emitted: { id: "note-text", value: "Repaired title" },
		},
		{
			stream: "notes",
			field: "snippet",
			page: notesPage,
			seed: noteQueryResponse(),
			broken: note({ SnippetEncrypted: { value: INVALID_UTF8 } }),
			repaired: note({ SnippetEncrypted: { value: b64("Repaired snippet") } }),
			emitted: { id: "note-text", value: "Repaired snippet" },
		},
		{
			stream: "folders",
			field: "name",
			page: foldersPage,
			seed: folderQueryResponse(),
			broken: folder(INVALID_UTF8),
			repaired: folder(b64("Repaired folder")),
			emitted: { id: "folder-text", value: "Repaired folder" },
		},
	];
	const stateOf = (harness: ReturnType<typeof makeRecordingEmit>, stream: string) =>
		harness.protocolMessages.find(
			(message) => message.type === "STATE" && message.stream === stream,
		);
	await Promise.all(
		cases.map(async ({ stream, field, page, seed, broken, repaired, emitted }) => {
			const previous = makeRecordingEmit(validateRecord);
			await collectAllStreams(makeCtx(page(seed), previous, [stream]));
			const previousState = stateOf(previous, stream);
			assert.ok(previousState && previousState.type === "STATE", field);
			const seeded = { [stream]: previousState.cursor };

			const failed = makeRecordingEmit(validateRecord);
			const failedCtx = makeCtx(page(broken), failed, [stream], seeded);
			await collectAllStreams(failedCtx);
			assert.equal(failed.emitted.length, 0, `${field}: no row`);
			assert.equal(stateOf(failed, stream), undefined, `${field}: no checkpoint`);
			assert.deepEqual(failedCtx.state, seeded, `${field}: prior cursor kept`);
			const skip = failed.protocolMessages.find(
				(message) => message.type === "SKIP_RESULT" && message.stream === stream,
			);
			assert.ok(skip && skip.type === "SKIP_RESULT", field);
			assert.deepEqual(
				(
					diagnosticField(skip, "field_omissions") as {
						field: string;
						reason: string;
					}[]
				).map((omission) => ({ field: omission.field, reason: omission.reason })),
				[{ field, reason: "invalid_utf8_text" }],
			);

			const retry = makeRecordingEmit(validateRecord);
			await collectAllStreams(makeCtx(page(repaired), retry, [stream], seeded));
			assert.deepEqual(
				retry.emitted.map((record) => ({
					id: record.data.id,
					value: record.data[field],
				})),
				[emitted],
			);
			assert.ok(stateOf(retry, stream), `${field}: repaired retry checkpoints`);
		}),
	);
});

test("collectAllStreams: an undecodable body withholds the row and the checkpoint until a repaired retry re-emits it", async () => {
	const noteWithBody = (decompressedBody: Buffer) => ({
		records: [
			{
				recordName: "note-body-only",
				recordType: "Note",
				fields: readableEmptyNoteFields({
					TitleEncrypted: { value: b64("Body under repair") },
					TextDataEncrypted: {
						value: gzipSync(decompressedBody).toString("base64"),
					},
				}),
			},
		],
	});
	// note_body 2 -> note_document 3 -> rich_text { text as varint, empty metadata }
	const wrongWireType = Buffer.from([
		0x12, 0x06, 0x1a, 0x04, 0x10, 0x01, 0x1a, 0x00,
	]);
	// Same note: a short run after a long one, in a readable structure.
	// Values stay under 128 bytes, so each length is one varint byte.
	const field = (fieldNumber: number, value: Buffer) => {
		assert.ok(value.length < 0x80);
		return Buffer.concat([
			Buffer.from([(fieldNumber << 3) | 2, value.length]),
			value,
		]);
	};
	const repaired = field(
		2,
		field(
			3,
			Buffer.concat([
				field(2, Buffer.from("First paragraph")),
				field(2, Buffer.from("hi")),
			]),
		),
	);

	const previous = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(makeNotePage([noteQueryResponse()]), previous, ["notes"]),
	);
	const previousState = previous.protocolMessages.find(
		(message) => message.type === "STATE" && message.stream === "notes",
	);
	assert.ok(previousState && previousState.type === "STATE");
	const seed = { notes: previousState.cursor };

	const broken = makeRecordingEmit(validateRecord);
	const brokenCtx = makeCtx(
		makeNotePage([noteWithBody(wrongWireType)]),
		broken,
		["notes"],
		seed,
	);
	await collectAllStreams(brokenCtx);
	assert.equal(broken.emitted.length, 0, "an undecodable body emits no row");
	assert.equal(
		broken.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "notes",
		),
		false,
		"an undecodable body vetoes the notes checkpoint",
	);
	assert.deepEqual(brokenCtx.state, seed, "the prior cursor stays untouched");
	const skip = broken.protocolMessages.find(
		(message) => message.type === "SKIP_RESULT" && message.stream === "notes",
	);
	assert.ok(skip && skip.type === "SKIP_RESULT");
	assert.deepEqual(
		(
			diagnosticField(skip, "field_omissions") as {
				field: string;
				reason: string;
			}[]
		).map(({ field, reason }) => ({ field, reason })),
		[{ field: "text_content", reason: "body_text_wrong_wire_type" }],
	);

	const retry = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(makeNotePage([noteWithBody(repaired)]), retry, ["notes"], seed),
	);
	assert.deepEqual(
		retry.emitted.map((record) => ({
			id: record.data.id,
			text_content: record.data.text_content,
		})),
		[{ id: "note-body-only", text_content: "First paragraph\nhi" }],
	);
	assert.ok(
		retry.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "notes",
		),
		"a decodable body lets the notes checkpoint advance",
	);
});

test("collectAllStreams: a permanently malformed note is not retried as the same revision, never checkpoints false coverage, and emits once repaired", async () => {
	// "/w==" is valid base64 for the one byte 0xFF, which is not UTF-8.
	const INVALID_UTF8 = "/w==";
	const good = (title: string) => ({
		recordName: "note-good",
		recordType: "Note",
		fields: readableEmptyNoteFields({ TitleEncrypted: { value: b64(title) } }),
	});
	const bad = (titleValue: string) => ({
		recordName: "note-bad",
		recordType: "Note",
		fields: readableEmptyNoteFields({ TitleEncrypted: { value: titleValue } }),
	});
	const notesStateOf = (harness: ReturnType<typeof makeRecordingEmit>) =>
		harness.protocolMessages.find(
			(message) => message.type === "STATE" && message.stream === "notes",
		);

	const healthy = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(
			makeNotePage([{ records: [good("Good v0"), bad(b64("Bad v0"))] }]),
			healthy,
			["notes"],
		),
	);
	const healthyState = notesStateOf(healthy);
	assert.ok(healthyState && healthyState.type === "STATE");
	const seed = { notes: healthyState.cursor };

	// The bad note's bytes stay identical on every run. The healthy note
	// changes on every run.
	for (const revision of ["Good v1", "Good v2", "Good v3"]) {
		const run = makeRecordingEmit(validateRecord);
		const ctx = makeCtx(
			makeNotePage([{ records: [good(revision), bad(INVALID_UTF8)] }]),
			run,
			["notes"],
			structuredClone(seed),
		);
		await collectAllStreams(ctx);

		assert.deepEqual(
			run.emitted.map((record) => ({
				id: record.data.id,
				title: record.data.title,
			})),
			[{ id: "note-good", title: revision }],
			`${revision}: the changed healthy note emits; the malformed note does not`,
		);
		assert.ok(
			!JSON.stringify(run.emitted).includes("�"),
			`${revision}: no replacement-character text`,
		);
		assert.equal(
			notesStateOf(run),
			undefined,
			`${revision}: no checkpoint claims complete inventory`,
		);
		assert.deepEqual(ctx.state, seed, `${revision}: prior cursor kept`);
		const skip = run.protocolMessages.find(
			(message) => message.type === "SKIP_RESULT" && message.stream === "notes",
		);
		assert.ok(skip && skip.type === "SKIP_RESULT", revision);
		assert.deepEqual(
			skip.recovery_hint,
			{ action: "not_retriable", retryable: false },
			`${revision}: an unchanged malformed revision is not offered for automatic retry`,
		);
		assert.deepEqual(
			(
				diagnosticField(skip, "omitted_row_diagnostics") as {
					record_id?: string;
					field_omissions: { field: string; reason: string }[];
				}[]
			).map((row) => ({
				record_id: row.record_id,
				fields: row.field_omissions.map(({ field, reason }) => ({
					field,
					reason,
				})),
			})),
			[
				{
					record_id: "note-bad",
					fields: [{ field: "title", reason: "invalid_utf8_text" }],
				},
			],
			`${revision}: the rejected row is identified by its record id`,
		);
	}

	// The source repairs the bad note: both notes emit and the stream
	// checkpoints, after which the next run is a fixed point.
	const repaired = makeRecordingEmit(validateRecord);
	const repairedCtx = makeCtx(
		makeNotePage([{ records: [good("Good v3"), bad(b64("Bad v1"))] }]),
		repaired,
		["notes"],
		seed,
	);
	await collectAllStreams(repairedCtx);
	assert.deepEqual(
		repaired.emitted
			.map((record) => ({ id: record.data.id, title: record.data.title }))
			.sort((left, right) => String(left.id).localeCompare(String(right.id))),
		[
			{ id: "note-bad", title: "Bad v1" },
			{ id: "note-good", title: "Good v3" },
		],
	);
	const repairedState = notesStateOf(repaired);
	assert.ok(repairedState && repairedState.type === "STATE");
	assert.equal(
		repaired.protocolMessages.some((message) => message.type === "SKIP_RESULT"),
		false,
	);

	const steady = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(
			makeNotePage([{ records: [good("Good v3"), bad(b64("Bad v1"))] }]),
			steady,
			["notes"],
			{ notes: repairedState.cursor },
		),
	);
	assert.equal(steady.emitted.length, 0, "converged: nothing re-emits");
	assert.ok(notesStateOf(steady), "converged: the checkpoint holds");
});

test("collectAllStreams: notes withheld by a transient folders failure keep the folders retry hint", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const ctx = makeCtx(
		makeFakePage([
			{ stream: "folders", response: { status: 503, json: null } },
			{ stream: "notes", response: noteQueryResponse() },
		]),
		harness,
		["notes"],
	);
	await collectAllStreams(ctx);

	assert.equal(harness.emitted.length, 0);
	const skip = harness.protocolMessages.find(
		(message) => message.type === "SKIP_RESULT" && message.stream === "notes",
	);
	assert.ok(skip && skip.type === "SKIP_RESULT");
	assert.deepEqual(
		(
			diagnosticField(skip, "field_omissions") as {
				field: string;
				reason: string;
			}[]
		).map(({ field, reason }) => ({ field, reason })),
		[{ field: "folder_name", reason: "folder_projection_incomplete" }],
	);
	assert.deepEqual(
		skip.recovery_hint,
		{ action: "retry_by_runtime", retryable: true },
		"the folders outage is transient, so the notes it withheld stay retryable",
	);
});
