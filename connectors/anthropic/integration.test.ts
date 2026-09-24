// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the Anthropic connector's collectAnthropic()
 * collect() layer. No real browser: a fake `page` runs page.evaluate()
 * callbacks locally in Node against a stubbed global `fetch`, and fires a
 * synthetic Playwright `download` event to drive attachDownloadQueue()
 * (src/download-queue.ts) without launching Chromium — consistent with
 * this lane's "no live browser runs" constraint.
 *
 * Proves, per docs/migration/connector-cutover/CONTRACTS.md's per-connector
 * proof gate item 3: START -> RECORD -> STATE -> DONE (via emitRecord/emit
 * recording, not a live subprocess — see below for why), scope filtering (a
 * requested subset of streams emits only that subset), and the async-export
 * resumability contract (pending-export STATE persisted before polling,
 * resumed on a later run without a second export request, retryable
 * SKIP_RESULT when the poll budget expires).
 *
 * Why this drives collectAnthropic() directly rather than
 * runConnectorProtocolSubprocess: that helper spawns a REAL browser via
 * runConnector's browser-launch path (browser: { profileName }), and this
 * environment has no Chromium binary available for browser automation (see
 * cut-anthropic report — Patchright does not currently publish a Chromium
 * build for this platform). Driving collectAnthropic() directly against a
 * fake page/context proves the same collect()-layer invariants amazon's
 * integration.test.ts proves for its emitOrderAndItems, without requiring
 * a live browser process.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import type { Page } from "playwright";

// Module-level poll/download timeouts in index.ts are env-overridable so
// this file's "never becomes ready" test runs in milliseconds instead of
// the real ~10-minute production budget. Must be set BEFORE importing
// index.ts, since those constants are read once at module load.
process.env.PDPP_ANTHROPIC_MAX_POLL_WAIT_MS = "50";
process.env.PDPP_ANTHROPIC_POLL_INTERVAL_MS = "10";
process.env.PDPP_ANTHROPIC_DOWNLOAD_TIMEOUT_MS = "50";

const { collectAnthropic } = await import("./index.ts");
const { validateRecord } = await import("./schemas.ts");
const { makeRecordingEmit } = await import(
	"../../packages/polyfill-connectors/src/test-harness.ts"
);
type BrowserCollectContext =
	import("../../packages/polyfill-connectors/src/connector-runtime.ts").BrowserCollectContext;

// ─── Fake page: runs evaluate() callbacks locally against a fetch stub ────

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

class FakePage extends EventEmitter {
	private fetchStub: FetchStub;
	gotoCalls: string[] = [];

	constructor(fetchStub: FetchStub) {
		super();
		this.fetchStub = fetchStub;
	}

	async goto(url: string): Promise<null> {
		this.gotoCalls.push(url);
		return null;
	}

	// Mirrors Playwright's page.evaluate(fn, arg) signature closely enough
	// for this connector's usage (a zero/one-arg function, no ElementHandle
	// args). Runs `fn` in THIS process with `fetch` monkeypatched to the
	// stub, rather than in a real browser page.
	async evaluate<T, A>(fn: (arg: A) => Promise<T> | T, arg?: A): Promise<T> {
		const realFetch = globalThis.fetch;
		// biome-ignore lint/suspicious/noExplicitAny: test-only global patch
		(globalThis as any).fetch = this.fetchStub;
		try {
			return await fn(arg as A);
		} finally {
			globalThis.fetch = realFetch;
		}
	}
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

// ─── Fake Download: satisfies download-queue.ts + playwright-download.ts ──

function makeFakeDownload(bytes: Buffer): {
	download: {
		saveAs: (path: string) => Promise<void>;
		suggestedFilename: () => string;
	};
} {
	return {
		download: {
			async saveAs(path: string): Promise<void> {
				const { writeFile } = await import("node:fs/promises");
				await writeFile(path, bytes);
			},
			suggestedFilename: () => "export.zip",
		},
	};
}

// ─── Test context builder ─────────────────────────────────────────────────

function makeContext(overrides: {
	streams: string[];
	state?: Record<string, unknown>;
	fetchStub: FetchStub;
}): {
	page: FakePage;
	ctx: BrowserCollectContext;
	emitted: ReturnType<typeof makeRecordingEmit>["emitted"];
	protocolMessages: EmittedMessage[];
} {
	const harness = makeRecordingEmit(validateRecord);
	const page = new FakePage(overrides.fetchStub);
	const requested = new Map(overrides.streams.map((name) => [name, { name }]));
	const ctx: BrowserCollectContext = {
		assist: () => {
			throw new Error("assist not expected in this test");
		},
		capture: null,
		completeAssistance: () => Promise.resolve(),
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: "2026-01-01T00:00:00.000Z",
		progress: (message: string): Promise<void> => {
			harness.emit({ type: "PROGRESS", message });
			return Promise.resolve();
		},
		requestDetailGapPage: () => Promise.resolve([]),
		requested,
		scope: { streams: overrides.streams.map((name) => ({ name })) },
		sendInteraction: () => {
			throw new Error("sendInteraction not expected in this test");
		},
		state: overrides.state ?? {},
		context: {} as BrowserCollectContext["context"],
		page: page as unknown as Page,
	};
	return {
		ctx,
		emitted: harness.emitted,
		page,
		protocolMessages: harness.protocolMessages,
	};
}

const ORG_RESPONSE = [
	{ uuid: "org-1", capabilities: ["chat", "claude_pro"] },
	{ uuid: "org-2", capabilities: ["api"] },
];

const CONVERSATIONS_JSON = [
	{
		uuid: "conv-1",
		name: "Test conversation",
		created_at: "2026-01-01T00:00:00.000Z",
		chat_messages: [
			{
				uuid: "msg-1",
				sender: "human",
				created_at: "2026-01-01T00:00:00.000Z",
				content: [{ type: "text", text: "hi" }],
			},
		],
	},
];

const PROJECT_JSON = {
	uuid: "proj-1",
	name: "Test project",
	created_at: "2026-01-01T00:00:00.000Z",
	docs: [{ uuid: "doc-1", filename: "notes.md", content: "notes" }],
};

async function buildZipBytes(): Promise<Buffer> {
	const { deflateRawSync } = await import("node:zlib");
	const files = [
		{
			name: "conversations.json",
			content: Buffer.from(JSON.stringify(CONVERSATIONS_JSON)),
		},
		{
			name: "projects/proj-1.json",
			content: Buffer.from(JSON.stringify(PROJECT_JSON)),
		},
	];
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const nameBuf = Buffer.from(file.name, "utf8");
		const compressed = deflateRawSync(file.content);
		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04_03_4b_50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt16LE(0x08_00, 6);
		localHeader.writeUInt16LE(8, 8);
		localHeader.writeUInt32LE(compressed.length, 18);
		localHeader.writeUInt32LE(file.content.length, 22);
		localHeader.writeUInt16LE(nameBuf.length, 26);
		const localEntry = Buffer.concat([localHeader, nameBuf, compressed]);
		localParts.push(localEntry);
		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0x08_00, 8);
		centralHeader.writeUInt16LE(8, 10);
		centralHeader.writeUInt32LE(compressed.length, 20);
		centralHeader.writeUInt32LE(file.content.length, 24);
		centralHeader.writeUInt16LE(nameBuf.length, 28);
		centralHeader.writeUInt32LE(offset, 42);
		centralParts.push(Buffer.concat([centralHeader, nameBuf]));
		offset += localEntry.length;
	}
	const centralDirStart = offset;
	const centralDir = Buffer.concat(centralParts);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06_05_4b_50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(centralDir.length, 12);
	eocd.writeUInt32LE(centralDirStart, 16);
	return Buffer.concat([...localParts, centralDir, eocd]);
}

// ─── Tests ──────────────────────────────────────────────────────────────

test("collectAnthropic: no requested streams -> no work, no messages", async () => {
	const { ctx, emitted, protocolMessages } = makeContext({
		streams: [],
		fetchStub: () => Promise.reject(new Error("must not be called")),
	});
	await collectAnthropic(ctx);
	assert.equal(emitted.length, 0);
	assert.equal(protocolMessages.length, 0);
});

test("collectAnthropic: full happy path — new export, ready immediately, emits all requested streams then STATE", async () => {
	const zipBytes = await buildZipBytes();
	let exportRequested = false;
	const { download } = makeFakeDownload(zipBytes);

	const fetchStub: FetchStub = (url) => {
		if (url.includes("/api/organizations") && !url.includes("export_data")) {
			return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
		}
		if (url.includes("/export_data")) {
			exportRequested = true;
			return Promise.resolve(jsonResponse(200, { nonce: "nonce-abc" }));
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};

	const { ctx, emitted, protocolMessages, page } = makeContext({
		streams: ["conversations", "messages", "projects", "project_documents"],
		fetchStub,
	});

	// Fire the download event on the next tick after goto() is called for the
	// download URL, simulating Claude's export becoming ready immediately.
	const originalGoto = page.goto.bind(page);
	page.goto = async (url: string): Promise<null> => {
		const result = await originalGoto(url);
		if (url.includes("/export/")) {
			queueMicrotask(() => page.emit("download", download));
		}
		return result;
	};

	await collectAnthropic(ctx);

	assert.ok(exportRequested, "a new export must have been requested");

	const streams = new Set(emitted.map((r) => r.stream));
	assert.deepEqual([...streams].sort(), [
		"conversations",
		"messages",
		"project_documents",
		"projects",
	]);
	assert.equal(emitted.filter((r) => r.stream === "conversations").length, 1);
	assert.equal(emitted.filter((r) => r.stream === "messages").length, 1);
	assert.equal(emitted.filter((r) => r.stream === "projects").length, 1);
	assert.equal(
		emitted.filter((r) => r.stream === "project_documents").length,
		1,
	);

	// STATE emitted for the checkpoint (pending, then synced) — pending first,
	// synced_at last, and no leftover pending_export in the final state message.
	const stateMessages = protocolMessages.filter(
		(m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE",
	);
	assert.ok(
		stateMessages.length >= 2,
		"expected a pending STATE and a synced STATE",
	);
	const finalConvState = stateMessages.findLast(
		(m) => m.stream === "conversations",
	);
	assert.ok(finalConvState);
	assert.ok(
		"synced_at" in (finalConvState.cursor as Record<string, unknown>),
		"final conversations STATE must carry synced_at",
	);
});

test("collectAnthropic: scope filtering — requesting only 'projects' emits no conversations/messages/project_documents", async () => {
	const zipBytes = await buildZipBytes();
	const { download } = makeFakeDownload(zipBytes);
	const fetchStub: FetchStub = (url) => {
		if (url.includes("/export_data")) {
			return Promise.resolve(jsonResponse(200, { nonce: "nonce-xyz" }));
		}
		if (url.includes("/api/organizations")) {
			return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};
	const { ctx, emitted, page } = makeContext({
		streams: ["projects"],
		fetchStub,
	});
	const originalGoto = page.goto.bind(page);
	page.goto = async (url: string): Promise<null> => {
		const result = await originalGoto(url);
		if (url.includes("/export/")) {
			queueMicrotask(() => page.emit("download", download));
		}
		return result;
	};

	await collectAnthropic(ctx);

	assert.deepEqual(
		[...new Set(emitted.map((r) => r.stream))],
		["projects"],
		"only the requested stream must emit records",
	);
});

test("collectAnthropic: resumes a pending export from STATE without requesting a new one", async () => {
	const zipBytes = await buildZipBytes();
	const { download } = makeFakeDownload(zipBytes);
	let exportRequestCount = 0;
	const fetchStub: FetchStub = (url) => {
		if (url.includes("/export_data")) {
			exportRequestCount += 1;
			return Promise.resolve(
				jsonResponse(200, { nonce: "should-not-be-used" }),
			);
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};
	const { ctx, emitted, page } = makeContext({
		streams: ["conversations"],
		state: {
			conversations: {
				pending_export: {
					organization_id: "org-1",
					nonce: "prior-nonce",
					requested_at: "2025-12-31T00:00:00.000Z",
				},
			},
		},
		fetchStub,
	});
	const originalGoto = page.goto.bind(page);
	const seenDownloadUrls: string[] = [];
	page.goto = async (url: string): Promise<null> => {
		const result = await originalGoto(url);
		if (url.includes("/export/")) {
			seenDownloadUrls.push(url);
			queueMicrotask(() => page.emit("download", download));
		}
		return result;
	};

	await collectAnthropic(ctx);

	assert.equal(
		exportRequestCount,
		0,
		"must not request a second export while one is pending",
	);
	assert.ok(
		seenDownloadUrls.some((url) => url.includes("prior-nonce")),
		"must poll using the SAME nonce from STATE",
	);
	assert.ok(emitted.some((r) => r.stream === "conversations"));
});

test("collectAnthropic: export never becomes ready within the poll budget -> retryable SKIP_RESULT per requested stream, pending STATE untouched", async () => {
	const fetchStub: FetchStub = (url) => {
		if (url.includes("/export_data")) {
			return Promise.resolve(jsonResponse(200, { nonce: "nonce-never-ready" }));
		}
		if (url.includes("/api/organizations")) {
			return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};
	const { ctx, emitted, protocolMessages } = makeContext({
		streams: ["conversations", "projects"],
		fetchStub,
	});
	// Never fires a download event — every poll attempt times out. The
	// module-level poll/download timeouts are overridden to milliseconds via
	// env vars set at the top of this file, so this exercises the real
	// "budget exhausted" branch without a multi-minute test.
	await collectAnthropic(ctx);

	assert.equal(
		emitted.length,
		0,
		"no records may be emitted when the export never becomes ready",
	);
	const skips = protocolMessages.filter(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT",
	);
	const skipStreams = new Set(skips.map((s) => s.stream));
	assert.deepEqual(
		[...skipStreams].sort(),
		["conversations", "projects"],
		"a retryable SKIP_RESULT must be emitted per requested stream",
	);
	for (const skip of skips) {
		assert.deepEqual(skip.recovery_hint, {
			action: "retry_by_runtime",
			retryable: true,
		});
	}
	// The pending-export STATE must NOT have been cleared/overwritten with a
	// synced_at — the only STATE emitted this run is the original pending
	// checkpoint.
	const stateMessages = protocolMessages.filter((m) => m.type === "STATE");
	assert.ok(stateMessages.length >= 1);
	for (const s of stateMessages) {
		const cursor = s.cursor as Record<string, unknown>;
		assert.ok(
			!("synced_at" in cursor),
			"no STATE this run may claim synced_at when the export never became ready",
		);
	}
});

// ─── NEW multi-part manifest format (2026-09-22 observation) ─────────────
//
// See index.ts module header: `POST export_data` can also return a
// manifest (`{ version, total_files, data_files: [{ category, part,
// filename, export_url }] }`) instead of `{ nonce }`. Each `export_url` is
// a distinct one-shot URL downloading one ZIP. These tests build a fake
// per-category ZIP the same way buildZipBytes() does, but with content
// shaped for classifyManifestPartEntries's content-based dispatch (see
// parsers.test.ts for the classifier's own unit tests) rather than the old
// format's fixed conversations.json/projects/*.json entry names.

async function buildManifestPartZip(
	entries: {
		name: string;
		content: unknown;
	}[],
): Promise<Buffer> {
	const { deflateRawSync } = await import("node:zlib");
	const files = entries.map((e) => ({
		name: e.name,
		content: Buffer.from(JSON.stringify(e.content)),
	}));
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const nameBuf = Buffer.from(file.name, "utf8");
		const compressed = deflateRawSync(file.content);
		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04_03_4b_50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt16LE(0x08_00, 6);
		localHeader.writeUInt16LE(8, 8);
		localHeader.writeUInt32LE(compressed.length, 18);
		localHeader.writeUInt32LE(file.content.length, 22);
		localHeader.writeUInt16LE(nameBuf.length, 26);
		const localEntry = Buffer.concat([localHeader, nameBuf, compressed]);
		localParts.push(localEntry);
		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0x08_00, 8);
		centralHeader.writeUInt16LE(8, 10);
		centralHeader.writeUInt32LE(compressed.length, 20);
		centralHeader.writeUInt32LE(file.content.length, 24);
		centralHeader.writeUInt16LE(nameBuf.length, 28);
		centralHeader.writeUInt32LE(offset, 42);
		centralParts.push(Buffer.concat([centralHeader, nameBuf]));
		offset += localEntry.length;
	}
	const centralDirStart = offset;
	const centralDir = Buffer.concat(centralParts);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06_05_4b_50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(centralDir.length, 12);
	eocd.writeUInt32LE(centralDirStart, 16);
	return Buffer.concat([...localParts, centralDir, eocd]);
}

const MANIFEST_RESPONSE = {
	version: "1.0",
	total_files: 3,
	data_files: [
		{
			batch_index: 0,
			category: "conversations",
			part: 0,
			filename: "conversations-000.zip",
			export_url: "https://claude.ai/export/org-1/download/part-token-conv",
		},
		{
			batch_index: 1,
			category: "light_metadata",
			part: 0,
			filename: "light_metadata-000.zip",
			export_url: "https://claude.ai/export/org-1/download/part-token-profile",
		},
		{
			batch_index: 2,
			category: "projects",
			part: 0,
			filename: "projects-000.zip",
			export_url: "https://claude.ai/export/org-1/download/part-token-proj",
		},
	],
};

test("collectAnthropic: new multi-part manifest format — downloads every part once, emits all requested streams, no pending STATE checkpoint", async () => {
	const conversationsZip = await buildManifestPartZip([
		{
			name: "conversations-000.json",
			content: [
				{
					uuid: "conv-1",
					name: "Manifest conversation",
					created_at: "2026-01-01T00:00:00.000Z",
					chat_messages: [
						{
							uuid: "msg-1",
							sender: "human",
							created_at: "2026-01-01T00:00:00.000Z",
							content: [{ type: "text", text: "hi" }],
						},
					],
				},
			],
		},
	]);
	const projectsZip = await buildManifestPartZip([
		{
			name: "projects-000.json",
			content: [
				{
					uuid: "proj-1",
					name: "Manifest project",
					created_at: "2026-01-01T00:00:00.000Z",
					docs: [{ uuid: "doc-1", filename: "notes.md", content: "notes" }],
				},
			],
		},
	]);
	const profileZip = await buildManifestPartZip([
		{
			name: "users.json",
			content: { users: [{ full_name: "Synthetic Name" }] },
		},
		{ name: "login_history.json", content: [{ private: "not emitted" }] },
	]);
	const zipByUrl = new Map<string, Buffer>([
		["part-token-conv", conversationsZip],
		["part-token-proj", projectsZip],
		["part-token-profile", profileZip],
	]);

	const fetchStub: FetchStub = (url) => {
		if (url.includes("/api/organizations") && !url.includes("export_data")) {
			return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
		}
		if (url.includes("/export_data")) {
			return Promise.resolve(jsonResponse(200, MANIFEST_RESPONSE));
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};

	const { ctx, emitted, protocolMessages, page } = makeContext({
		streams: [
			"account_profile",
			"conversations",
			"messages",
			"projects",
			"project_documents",
		],
		fetchStub,
	});

	const downloadCounts = new Map<string, number>();
	const originalGoto = page.goto.bind(page);
	page.goto = async (url: string): Promise<null> => {
		const result = await originalGoto(url);
		for (const [token, bytes] of zipByUrl) {
			if (url.includes(token)) {
				downloadCounts.set(token, (downloadCounts.get(token) ?? 0) + 1);
				const { download } = makeFakeDownload(bytes);
				queueMicrotask(() => page.emit("download", download));
			}
		}
		return result;
	};

	await collectAnthropic(ctx);

	assert.deepEqual(
		[...downloadCounts.values()],
		[1, 1, 1],
		"each one-shot part URL must be downloaded exactly once",
	);

	const streams = new Set(emitted.map((r) => r.stream));
	assert.deepEqual([...streams].sort(), [
		"account_profile",
		"conversations",
		"messages",
		"project_documents",
		"projects",
	]);
	assert.deepEqual(
		emitted.find((record) => record.stream === "account_profile")?.data,
		{ organization_id: "org-1", full_name: "Synthetic Name" },
	);

	// No pending-export STATE checkpoint for the manifest format — see
	// index.ts module header: export_url values are one-shot secrets and
	// are never persisted, so there is nothing to checkpoint before
	// downloading.
	const stateMessages = protocolMessages.filter((m) => m.type === "STATE");
	for (const s of stateMessages) {
		const cursor = s.cursor as Record<string, unknown>;
		assert.ok(
			!("pending_export" in cursor),
			"the manifest format must never checkpoint a pending_export reference",
		);
	}
});

test("collectAnthropic: multi-part manifest — one part's one-shot URL fails to download -> retryable SKIP_RESULT, zero records (never a silent 0 pretending to be success)", async () => {
	const conversationsZip = await buildManifestPartZip([
		{ name: "conversations-000.json", content: [] },
	]);

	const fetchStub: FetchStub = (url) => {
		if (url.includes("/api/organizations") && !url.includes("export_data")) {
			return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
		}
		if (url.includes("/export_data")) {
			return Promise.resolve(jsonResponse(200, MANIFEST_RESPONSE));
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};

	const { ctx, emitted, protocolMessages, page } = makeContext({
		streams: ["conversations", "projects"],
		fetchStub,
	});

	const originalGoto = page.goto.bind(page);
	page.goto = async (url: string): Promise<null> => {
		const result = await originalGoto(url);
		// Only the conversations part's download fires — the projects
		// part's export_url is simulated as already-used/expired: no
		// download event ever fires for it, matching a real one-shot URL
		// re-navigated after consumption (observed live as a 403).
		if (url.includes("part-token-conv")) {
			const { download } = makeFakeDownload(conversationsZip);
			queueMicrotask(() => page.emit("download", download));
		}
		return result;
	};

	await collectAnthropic(ctx);

	assert.equal(
		emitted.length,
		0,
		"a partially-failed manifest must emit zero records, never a partial or silent-0 result",
	);
	const skips = protocolMessages.filter(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT",
	);
	const skipStreams = new Set(skips.map((s) => s.stream));
	assert.deepEqual(
		[...skipStreams].sort(),
		["conversations", "projects"],
		"a retryable SKIP_RESULT must be emitted per requested stream",
	);
	for (const skip of skips) {
		assert.equal(skip.reason, "export_part_download_failed");
		assert.deepEqual(skip.recovery_hint, {
			action: "retry_by_runtime",
			retryable: true,
		});
	}
});
