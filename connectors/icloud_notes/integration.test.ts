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
function makeFakePage(queryResponses: unknown[]): Page {
	let queryCallIndex = 0;
	const evaluate = (
		_fn: unknown,
		arg: unknown,
	): Promise<{ status: number; json: unknown }> => {
		if (arg === VALIDATE_URL) {
			return Promise.resolve({ status: 200, json: VALIDATE_RESPONSE });
		}
		const { evalUrl } = (arg ?? {}) as { evalUrl?: string };
		if (evalUrl === QUERY_URL) {
			const response = queryResponses[queryCallIndex] ?? { records: [] };
			queryCallIndex += 1;
			return Promise.resolve({ status: 200, json: response });
		}
		return Promise.resolve({ status: 0, json: null });
	};
	return { evaluate } as unknown as Page;
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

test("collectAllStreams: only requested streams emit records (scope filtering)", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = makeFakePage([noteQueryResponse()]);
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
	const firstPage = makeFakePage([noteQueryResponse()]);
	const firstCtx = makeCtx(firstPage, firstHarness, ["notes"]);
	await collectAllStreams(firstCtx);

	const firstState = firstHarness.protocolMessages.find(
		(m) => m.type === "STATE" && m.stream === "notes",
	);
	assert.ok(firstState && firstState.type === "STATE");
	assert.equal(firstHarness.emitted.length, 1, "first run emits the note");

	const secondHarness = makeRecordingEmit(validateRecord);
	const secondPage = makeFakePage([noteQueryResponse()]);
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
	const firstPage = makeFakePage([noteQueryResponse()]);
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
	const secondPage = makeFakePage([changedResponse]);
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
	const page = makeFakePage([
		noteQueryResponse({ continuationMarker: "page-2" }),
		{
			records: [
				{
					recordName: "note-2",
					recordType: "Note",
					fields: {
						TitleEncrypted: { value: b64("Second note") },
					},
				},
			],
		},
	]);
	const ctx = makeCtx(page, harness, ["notes"]);

	await collectAllStreams(ctx);

	const ids = harness.emitted.map((r) => r.data.id);
	assert.deepEqual(new Set(ids), new Set(["note-1", "note-2"]));
});

test("collectAllStreams: throws when the CloudKit config cannot be resolved (auth not live)", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = {
		evaluate: (): Promise<{ status: number; json: unknown }> =>
			Promise.resolve({ status: 401, json: null }),
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
		assert.ok(validateCalls >= 3);
		assert.equal(context.pages().length, 1);
		await context.close();
	} finally {
		await browser.close();
	}
});
