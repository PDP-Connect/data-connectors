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
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import {
	assertUserFacingProgress,
	setConnectorDiagnosticSink,
} from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";

// Module-level poll/download timeouts in index.ts are env-overridable so
// this file's "never becomes ready" test runs in milliseconds instead of
// the real ~10-minute production budget. Must be set BEFORE importing
// index.ts, since those constants are read once at module load.
process.env.PDPP_ANTHROPIC_MAX_POLL_WAIT_MS = "50";
process.env.PDPP_ANTHROPIC_POLL_INTERVAL_MS = "10";
process.env.PDPP_ANTHROPIC_DOWNLOAD_TIMEOUT_MS = "50";
const blobSpoolDir = mkdtempSync(join(tmpdir(), "anthropic-blob-test-"));
process.env.PDPP_BLOB_SPOOL_DIR = blobSpoolDir;
after(() => {
	rmSync(blobSpoolDir, { recursive: true, force: true });
	delete process.env.PDPP_BLOB_SPOOL_DIR;
});

const { collectAnthropic } = await import("./index.ts");
const { BufferMeter } = await import("./oversize-conversation.ts");
const { validateRecord } = await import("./schemas.ts");
const { decodeEscapedText } = await import("./safe-escape.ts");
const { consentTimeFieldResolver, makeEmitRecord } = await import(
	"../../packages/polyfill-connectors/src/connector-runtime.ts"
);
const { makeRecordingEmit, skipPoliteDelays } = await import(
	"../../packages/polyfill-connectors/src/test-harness.ts"
);
// Pacing pauses are anti-bot courtesy that these tests do not assert on, so
// they fire on the next tick instead of sleeping.
after(skipPoliteDelays());
type BrowserCollectContext =
	import("../../packages/polyfill-connectors/src/connector-runtime.ts").BrowserCollectContext;
type AnthropicTestOverrides = {
	maxBufferedObjectUnits?: number;
	maxBlobBytes?: number;
	inlineTextMaxUnits?: number;
	initialDelayMs?: number;
};

// ─── Fake page: runs evaluate() callbacks locally against a fetch stub ────

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

class FakePage extends EventEmitter {
	private fetchStub: FetchStub;
	menuSpans: string[] = [];
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
		const priorDocument = Object.getOwnPropertyDescriptor(
			globalThis,
			"document",
		);
		const spans = this.menuSpans.map((textContent) => ({ textContent }));
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: {
				querySelector: () =>
					spans.length
						? {
								querySelector: () => spans[0],
								querySelectorAll: () => spans,
							}
						: null,
			},
		});
		// biome-ignore lint/suspicious/noExplicitAny: test-only global patch
		(globalThis as any).fetch = this.fetchStub;
		try {
			return await fn(arg as A);
		} finally {
			globalThis.fetch = realFetch;
			if (priorDocument)
				Object.defineProperty(globalThis, "document", priorDocument);
			else Reflect.deleteProperty(globalThis, "document");
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
	resources?: Record<string, string[]>;
	since?: string;
	until?: string;
	/** Streams that get since/until; default every stream. */
	timeRangeStreams?: string[];
	state?: Record<string, unknown>;
	testOverrides?: AnthropicTestOverrides;
	fetchStub: FetchStub;
}): {
	page: FakePage;
	ctx: BrowserCollectContext & { testOverrides: AnthropicTestOverrides };
	emitted: ReturnType<typeof makeRecordingEmit>["emitted"];
	events: ReturnType<typeof makeRecordingEmit>["events"];
	protocolMessages: EmittedMessage[];
} {
	const harness = makeRecordingEmit(validateRecord);
	const page = new FakePage(overrides.fetchStub);
	const scopeStreams = overrides.streams.map((name) => ({
		name,
		...((overrides.since || overrides.until) &&
		(overrides.timeRangeStreams ?? overrides.streams).includes(name)
			? {
					time_range: {
						...(overrides.since ? { since: overrides.since } : {}),
						...(overrides.until ? { until: overrides.until } : {}),
					},
				}
			: {}),
		...(overrides.resources?.[name]
			? { resources: overrides.resources[name] }
			: {}),
	}));
	const requested = new Map(
		scopeStreams.map((stream) => [stream.name, stream]),
	);
	const selector = makeEmitRecord({
		requested,
		emit: harness.emit,
		emittedAt: "2026-01-01T00:00:00.000Z",
		validateRecord,
		isTombstone: undefined,
		timeRangeFieldFor: consentTimeFieldResolver("anthropic"),
	});
	const ctx: BrowserCollectContext & {
		testOverrides: AnthropicTestOverrides;
	} = {
		assist: () => {
			throw new Error("assist not expected in this test");
		},
		capture: null,
		completeAssistance: () => Promise.resolve(),
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		isRecordSelected: selector.isSelected,
		emittedAt: "2026-01-01T00:00:00.000Z",
		progress: (message: string, extra: object = {}): Promise<void> => {
			harness.emit({ type: "PROGRESS", message, ...extra });
			return Promise.resolve();
		},
		requestDetailGapPage: () => Promise.resolve([]),
		requested,
		scope: { streams: scopeStreams },
		sendInteraction: () => {
			throw new Error("sendInteraction not expected in this test");
		},
		state: overrides.state ?? {},
		context: {} as BrowserCollectContext["context"],
		page: page as unknown as Page,
		testOverrides: {
			initialDelayMs: 0,
			...overrides.testOverrides,
		},
	};
	return {
		ctx,
		emitted: harness.emitted,
		events: harness.events,
		page,
		protocolMessages: harness.protocolMessages,
	};
}

const ORG_RESPONSE = [
	{
		uuid: "org-1",
		// A personal organization is named after its owner.
		name: "Fictional Owner's Organization",
		capabilities: ["chat", "claude_pro"],
		created_at: "2025-03-01T12:00:00.123456Z",
	},
	{ uuid: "org-2", capabilities: ["api"] },
];

/** Nine million characters: under the inline text cap, so four of them make a
 * conversation envelope over the 32 MiB host blob cap without any message
 * being oversize. */
const ENVELOPE_PAD = "x".repeat(9_000_000);

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

async function buildZipBytes(
	users?: unknown,
	conversations: unknown = CONVERSATIONS_JSON,
	project: unknown = PROJECT_JSON,
): Promise<Buffer> {
	const { deflateRawSync } = await import("node:zlib");
	const files = [
		{
			name: "conversations.json",
			content: Buffer.from(JSON.stringify(conversations)),
		},
		{
			name: "projects/proj-1.json",
			content: Buffer.from(JSON.stringify(project)),
		},
	];
	if (users !== undefined)
		files.push({
			name: "users.json",
			content: Buffer.from(JSON.stringify(users)),
		});
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

/** Diagnostic lines the connector wrote to the run log during one test. */
const diagnostics: string[] = [];
beforeEach(() => {
	diagnostics.length = 0;
	setConnectorDiagnosticSink((line) => {
		diagnostics.push(line);
	});
});
afterEach(() => {
	setConnectorDiagnosticSink(undefined);
});

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

	const { ctx, emitted, events, protocolMessages, page } = makeContext({
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
	for (const stream of ["conversations", "projects"]) {
		const recordIndex = events.findIndex(
			(event) => event.kind === "record" && event.stream === stream,
		);
		assert.ok(recordIndex > 0);
		const record = events[recordIndex];
		const preceding = events[recordIndex - 1];
		assert.equal(preceding?.kind, "message");
		assert.equal(
			preceding?.kind === "message" && preceding.message.type,
			"BLOB",
		);
		if (
			record?.kind !== "record" ||
			preceding?.kind !== "message" ||
			preceding.message.type !== "BLOB"
		)
			continue;
		const event = preceding.message;
		assert.equal(event.stream, stream);
		assert.equal(event.key, record.data.id);
		assert.match(event.file, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
		const bytes = readFileSync(join(blobSpoolDir, event.file));
		assert.equal(bytes.length, event.size_bytes);
		assert.equal(
			createHash("sha256").update(bytes).digest("hex"),
			event.sha256,
		);
		assert.deepEqual(record.data.blob_ref, {
			blob_id: `sha256:${event.sha256}`,
			mime_type: "application/json",
			size_bytes: event.size_bytes,
			sha256: event.sha256,
		});
		const envelope = JSON.parse(bytes.toString("utf8"));
		assert.equal(envelope.format, "anthropic-source-record-v1");
		assert.equal(envelope.stream, stream);
		assert.equal(envelope.record_key, record.data.id);
		assert.deepEqual(
			envelope.payload,
			stream === "conversations" ? CONVERSATIONS_JSON[0] : PROJECT_JSON,
		);
	}

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

test("collectAnthropic: time window filters conversations and messages but retains full project and document inventory", async () => {
	const now = Date.now();
	const since = new Date(now - 30 * 86_400_000).toISOString();
	const until = new Date(now).toISOString();
	const recent = new Date(now - 2 * 86_400_000).toISOString();
	const old = new Date(now - 31 * 86_400_000).toISOString();
	const future = new Date(now + 86_400_000).toISOString();
	const baseMessage = CONVERSATIONS_JSON[0]?.chat_messages[0] ?? {};
	const zipBytes = await buildZipBytes(
		undefined,
		[
			{
				...CONVERSATIONS_JSON[0],
				uuid: "conv-recent",
				created_at: recent,
				updated_at: recent,
				chat_messages: [
					{ ...baseMessage, uuid: "msg-recent", created_at: recent },
				],
			},
			{
				...CONVERSATIONS_JSON[0],
				uuid: "conv-old",
				created_at: old,
				updated_at: old,
				chat_messages: [{ ...baseMessage, uuid: "msg-old", created_at: old }],
			},
		],
		{
			...PROJECT_JSON,
			updated_at: old,
			docs: [
				{
					uuid: "doc-recent",
					filename: "new.md",
					content: "new",
					updated_at: recent,
				},
				{
					uuid: "doc-old",
					filename: "old.md",
					content: "old",
					updated_at: old,
				},
				{
					uuid: "doc-after-until",
					filename: "future.md",
					content: "future",
					updated_at: future,
				},
			],
		},
	);
	const { download } = makeFakeDownload(zipBytes);
	const fetchStub: FetchStub = (url) => {
		if (url.includes("/api/organizations") && !url.includes("export_data"))
			return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
		if (url.includes("/export_data"))
			return Promise.resolve(jsonResponse(200, { nonce: "nonce-window" }));
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};
	const { ctx, emitted, page } = makeContext({
		streams: ["conversations", "messages", "projects", "project_documents"],
		since,
		until,
		// A conversation window: projects and documents are requested unbounded.
		timeRangeStreams: ["conversations", "messages"],
		fetchStub,
	});
	const originalGoto = page.goto.bind(page);
	page.goto = async (url: string): Promise<null> => {
		const result = await originalGoto(url);
		if (url.includes("/export/"))
			queueMicrotask(() => page.emit("download", download));
		return result;
	};
	await collectAnthropic(ctx);
	const idsByStream = Object.fromEntries(
		["conversations", "messages", "projects", "project_documents"].map(
			(stream) => [
				stream,
				emitted
					.filter((record) => record.stream === stream)
					.map((record) => record.data.id),
			],
		),
	);
	assert.deepEqual(idsByStream, {
		conversations: ["conv-recent"],
		messages: ["msg-recent"],
		projects: ["proj-1"],
		project_documents: ["doc-recent", "doc-old", "doc-after-until"],
	});
	assert.ok(
		emitted
			.filter((record) => record.stream === "project_documents")
			.every((record) => record.data.project_id === "proj-1"),
		"retained project documents must keep their project relationship",
	);
});

test("collectAnthropic: excluded oversized source is never spooled; selected oversized source keeps its typed records with no raw blob, an aggregate note and no gap; no stream is skipped", async () => {
	const hugeConversation = {
		uuid: "conv-huge",
		name: "Excluded source",
		chat_messages: [0, 1, 2, 3].map((index) => ({
			uuid: `msg-huge-${index}`,
			text: ENVELOPE_PAD,
		})),
	};
	const zipBytes = await buildZipBytes(undefined, [
		hugeConversation,
		CONVERSATIONS_JSON[0],
	]);
	const run = async (resources: string[], streams: string[]) => {
		const { download } = makeFakeDownload(zipBytes);
		const { ctx, emitted, protocolMessages, page } = makeContext({
			streams,
			resources: { conversations: resources },
			fetchStub: (url) => {
				if (url.includes("/api/organizations") && !url.includes("export_data"))
					return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
				if (url.includes("/export_data"))
					return Promise.resolve(
						jsonResponse(200, { nonce: "nonce-oversize" }),
					);
				return Promise.reject(new Error(`unexpected fetch: ${url}`));
			},
		});
		const originalGoto = page.goto.bind(page);
		page.goto = async (url: string): Promise<null> => {
			const result = await originalGoto(url);
			if (url.includes("/export/"))
				queueMicrotask(() => page.emit("download", download));
			return result;
		};
		return { ctx, emitted, protocolMessages };
	};

	const before = new Set(readdirSync(blobSpoolDir));
	const excluded = await run(["conv-1"], ["conversations"]);
	await collectAnthropic(excluded.ctx);
	assert.deepEqual(
		excluded.emitted.map((record) => record.data.id),
		["conv-1"],
	);
	assert.equal(
		excluded.protocolMessages.filter((message) => message.type === "BLOB")
			.length,
		1,
	);
	assert.equal(
		readdirSync(blobSpoolDir).filter((file) => !before.has(file)).length,
		1,
	);

	const beforeSelected = new Set(readdirSync(blobSpoolDir));
	const selected = await run(
		["conv-huge", "conv-1"],
		["account_profile", "conversations", "messages", "projects"],
	);
	await collectAnthropic(selected.ctx);
	// The oversized conversation keeps its typed record and its messages;
	// only its raw envelope is left out.
	assert.deepEqual(
		selected.emitted
			.filter((r) => r.stream === "conversations")
			.map((r) => r.data.id)
			.sort(),
		["conv-1", "conv-huge"],
	);
	assert.deepEqual(
		selected.emitted
			.filter((r) => r.stream === "messages")
			.map((r) => r.data.conversation_id)
			.sort(),
		["conv-1", "conv-huge", "conv-huge", "conv-huge", "conv-huge"],
	);
	assert.equal(
		selected.emitted.filter((r) => r.stream === "projects").length,
		1,
	);
	// conv-1 and proj-1 get a raw blob. conv-huge's envelope is over the host
	// cap, so it has no blob and its record has no blob_ref.
	const blobs = selected.protocolMessages.filter(
		(message): message is Extract<EmittedMessage, { type: "BLOB" }> =>
			message.type === "BLOB",
	);
	assert.deepEqual(blobs.map((blob) => blob.key).sort(), ["conv-1", "proj-1"]);
	assert.equal(
		readdirSync(blobSpoolDir).filter((file) => !beforeSelected.has(file))
			.length,
		2,
	);
	const hugeRecord = selected.emitted.find(
		(r) => r.stream === "conversations" && r.data.id === "conv-huge",
	);
	assert.ok(hugeRecord);
	assert.equal("blob_ref" in hugeRecord.data, false);
	assert.equal(
		validateRecord("conversations", hugeRecord.data).ok,
		true,
		"a record without blob_ref validates against its own schema",
	);
	assert.deepEqual(gapsOf(selected.protocolMessages), []);
	assert.ok(
		selected.protocolMessages.every(
			(m) => m.type !== "DETAIL_COVERAGE" || !("optional_skip_keys" in m),
		),
	);
	// An oversized item never reaches the host, so no stream is skipped:
	// a SKIP_RESULT would make Desktop drop all conversations.
	assert.deepEqual(skipsOf(selected.protocolMessages), []);
	const notes = selected.protocolMessages.filter(
		(m) =>
			m.type === "PROGRESS" &&
			/too large to keep a raw copy/.test((m as { message: string }).message),
	) as Array<{ message: string; stream?: string; count?: number }>;
	assert.equal(notes.length, 1);
	assert.equal(notes[0]?.stream, "conversations");
	assert.equal(notes[0]?.count, 1);
	assert.equal(
		notes[0]?.message,
		"1 item of conversations in the export was too large to keep a raw copy of; the record was imported without it",
	);
	assert.doesNotMatch(notes[0]?.message ?? "", /conv-huge|Excluded source/);
	assert.ok(
		diagnostics.some(
			(line) =>
				line.startsWith("[anthropic-diagnostic] export_items_too_large ") &&
				line.includes('"stream":"conversations"') &&
				line.includes('"count":1') &&
				line.includes('"reason":"source_envelope_exceeds_host_blob_cap"') &&
				line.includes('"max_bytes":'),
		),
		diagnostics.join("\n"),
	);
	assertUserFacingProgress(selected.protocolMessages);
	const synced = statesOf(selected.protocolMessages)
		.filter((m) => "synced_at" in (m.cursor as Record<string, unknown>))
		.map((m) => m.stream);
	assert.deepEqual(synced, ["conversations", "messages", "projects"]);
});

for (const scenario of [
	{
		label: "users.json alone cannot establish owner",
		users: [{ full_name: "Export Owner" }],
		menu: [],
		name: null,
		status: "valid",
	},
	{
		label: "matching users.json and browser profile",
		users: [{ full_name: "Browser Owner" }],
		menu: ["Browser Owner", "Max"],
		name: "Browser Owner",
		status: "valid",
	},
	{
		label: "absent users.json uses browser name",
		users: undefined,
		menu: ["Browser Owner", "Max"],
		name: "Browser Owner",
		status: "absent",
	},
	{
		label: "malformed users.json uses browser name",
		users: { users: [{ id: "x" }] },
		menu: ["Browser Owner", "Max"],
		name: "Browser Owner",
		status: "malformed",
	},
	{
		label: "mismatched users.json omits browser identity",
		users: [{ full_name: "Export Owner" }],
		menu: ["Current User", "Max"],
		name: null,
		status: "mismatch",
	},
	{
		label: "ambiguous users.json omits browser identity",
		users: [{ full_name: "Export Owner" }, { full_name: "Current User" }],
		menu: ["Current User", "Max"],
		name: null,
		status: "ambiguous",
	},
]) {
	test(`collectAnthropic: old ZIP ${scenario.label}`, async () => {
		const zipBytes = await buildZipBytes(scenario.users);
		const { download } = makeFakeDownload(zipBytes);
		const fetchStub: FetchStub = (url) => {
			if (url.includes("/api/organizations") && !url.includes("export_data"))
				return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
			if (url.includes("/export_data"))
				return Promise.resolve(jsonResponse(200, { nonce: "nonce-abc" }));
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		};
		const { ctx, emitted, protocolMessages, page } = makeContext({
			streams: ["account_profile"],
			fetchStub,
		});
		page.menuSpans = scenario.menu;
		const originalGoto = page.goto.bind(page);
		page.goto = async (url: string): Promise<null> => {
			const result = await originalGoto(url);
			if (url.includes("/export/"))
				queueMicrotask(() => page.emit("download", download));
			return result;
		};
		await collectAnthropic(ctx);
		assert.deepEqual(emitted[0]?.data, {
			id: "org-1",
			organization_id: "org-1",
			full_name: scenario.name,
			plan: scenario.name === null ? null : (scenario.menu[1] ?? null),
			name_source:
				scenario.name === null
					? "none"
					: scenario.menu.length
						? "browser_menu"
						: "users_json",
			metadata_status: scenario.status,
		});
		const expectNote = scenario.status !== "valid" || scenario.name === null;
		const expectedNote =
			scenario.name === null
				? "Could not confirm which Claude account this export belongs to; profile name and plan were left out"
				: "Claude account details for this export could not be fully verified";
		assert.equal(
			protocolMessages.some(
				(message) =>
					message.type === "PROGRESS" && message.message === expectedNote,
			),
			expectNote,
		);
		const profileLine = diagnostics.find((line) =>
			line.startsWith("[anthropic-diagnostic] account_profile_unverified "),
		);
		assert.equal(profileLine !== undefined, expectNote);
		if (profileLine) {
			assert.ok(profileLine.includes(`"metadata_status":"${scenario.status}"`));
			assert.ok(profileLine.includes('"name_source":'));
		}
		assertUserFacingProgress(protocolMessages);
	});
}

const ACCOUNT_PLAN_RECORD = {
	id: "account_plan",
	is_default: true,
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
};

test("collectAnthropic: account_plan carries the organization's plan family and creation time, and no name", async () => {
	const organizationReads = { count: 0 };
	const exportRequests: string[] = [];
	const fetchStub: FetchStub = (url) => {
		if (url.includes("/api/organizations") && !url.includes("export_data")) {
			organizationReads.count += 1;
			return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
		}
		if (url.includes("/export_data")) exportRequests.push(url);
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};
	const { ctx, emitted, protocolMessages, page } = makeContext({
		streams: ["account_plan"],
		fetchStub,
	});
	page.menuSpans = ["Export Owner", "Pro plan"];

	await collectAnthropic(ctx);

	assert.deepEqual(
		emitted.map((record) => [record.stream, record.data]),
		[["account_plan", ACCOUNT_PLAN_RECORD]],
	);
	// One organization read serves the plan, and no export is requested: each
	// request emails the account owner.
	assert.equal(organizationReads.count, 1);
	assert.deepEqual(exportRequests, []);
	// No name reaches any message: not the menu's, not users.json's, not the
	// organization's own name.
	const everything = JSON.stringify([...protocolMessages, ...diagnostics]);
	for (const name of ["Export Owner", "Fictional", "Owner's Organization"])
		assert.equal(everything.includes(name), false, name);
	// The inventory reports coverage but keeps no checkpoint.
	assert.equal(
		protocolMessages.some(
			(message) =>
				message.type === "STATE" && message.stream === "account_plan",
		),
		false,
	);
	assert.equal(
		diagnostics.some((line) => line.includes("account_plan_incomplete")),
		false,
	);
});

test("collectAnthropic: account_plan reports an organization entry without a plan or a creation time as null, with a diagnostic", async () => {
	const fetchStub: FetchStub = (url) => {
		if (url.includes("/api/organizations") && !url.includes("export_data"))
			return Promise.resolve(
				jsonResponse(200, [
					{ uuid: "org-1", capabilities: ["chat"], billing_type: "stripe" },
				]),
			);
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};
	const { ctx, emitted } = makeContext({
		streams: ["account_plan"],
		fetchStub,
	});

	await collectAnthropic(ctx);

	assert.deepEqual(emitted[0]?.data, {
		...ACCOUNT_PLAN_RECORD,
		account_created_at: null,
		plan_type: null,
	});
	assert.match(
		diagnostics.find((line) => line.includes("account_plan_incomplete")) ?? "",
		/"plan_type":"absent".*"account_created_at":"absent"/,
	);
});

test("collectAnthropic: a resumed export whose organization is not in the signed-in account skips account_plan instead of emitting an empty plan, when the run reads the export", async () => {
	const zipBytes = await buildZipBytes();
	const { download } = makeFakeDownload(zipBytes);
	const fetchStub: FetchStub = (url) => {
		if (url.includes("/api/organizations") && !url.includes("export_data"))
			return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};
	const { ctx, emitted, protocolMessages, page } = makeContext({
		streams: ["account_plan", "projects"],
		state: {
			conversations: {
				pending_export: {
					organization_id: "old-org",
					nonce: "old-nonce",
					requested_at: "2025-12-31T00:00:00.000Z",
				},
			},
		},
		fetchStub,
	});
	const originalGoto = page.goto.bind(page);
	page.goto = async (url: string): Promise<null> => {
		const result = await originalGoto(url);
		if (url.includes("/export/"))
			queueMicrotask(() => page.emit("download", download));
		return result;
	};

	await collectAnthropic(ctx);

	assert.equal(
		emitted.some((record) => record.stream === "account_plan"),
		false,
	);
	const skips = skipsOf(protocolMessages);
	assert.deepEqual(
		skips.map((skip) => [skip.stream, skip.reason]),
		[["account_plan", "organization_unavailable"]],
	);
	assert.deepEqual(skips[0]?.recovery_hint, {
		action: "retry_by_runtime",
		retryable: true,
	});
});

test("collectAnthropic: a resumed export finds its own organization's plan in the account's list, when the run reads the export", async () => {
	const zipBytes = await buildZipBytes();
	const { download } = makeFakeDownload(zipBytes);
	const fetchStub: FetchStub = (url) => {
		if (url.includes("/api/organizations") && !url.includes("export_data"))
			return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};
	const { ctx, emitted, page } = makeContext({
		streams: ["account_plan", "projects"],
		state: {
			conversations: {
				pending_export: {
					organization_id: "org-1",
					nonce: "old-nonce",
					requested_at: "2025-12-31T00:00:00.000Z",
				},
			},
		},
		fetchStub,
	});
	const originalGoto = page.goto.bind(page);
	page.goto = async (url: string): Promise<null> => {
		const result = await originalGoto(url);
		if (url.includes("/export/"))
			queueMicrotask(() => page.emit("download", download));
		return result;
	};

	await collectAnthropic(ctx);

	assert.deepEqual(
		emitted.find((record) => record.stream === "account_plan")?.data,
		ACCOUNT_PLAN_RECORD,
	);
});

test("collectAnthropic: a plan-only run reads the plan of the chat organization without touching a pending export", async () => {
	const requests: string[] = [];
	const fetchStub: FetchStub = (url) => {
		requests.push(url);
		if (url.includes("/api/organizations") && !url.includes("export_data"))
			return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};
	const { ctx, emitted, protocolMessages } = makeContext({
		streams: ["account_plan"],
		state: {
			conversations: {
				pending_export: {
					organization_id: "old-org",
					nonce: "old-nonce",
					requested_at: "2025-12-31T00:00:00.000Z",
				},
			},
		},
		fetchStub,
	});

	await collectAnthropic(ctx);

	assert.deepEqual(
		emitted.map((record) => [record.stream, record.data]),
		[["account_plan", ACCOUNT_PLAN_RECORD]],
	);
	assert.equal(
		requests.some((url) => url.includes("/export")),
		false,
	);
	assert.deepEqual(skipsOf(protocolMessages), []);
});

test("collectAnthropic: a plan-only run with no chat organization skips account_plan and requests no export", async () => {
	const requests: string[] = [];
	const fetchStub: FetchStub = (url) => {
		requests.push(url);
		if (url.includes("/api/organizations") && !url.includes("export_data"))
			return Promise.resolve(jsonResponse(200, []));
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};
	const { ctx, emitted, protocolMessages } = makeContext({
		streams: ["account_plan"],
		fetchStub,
	});

	await collectAnthropic(ctx);

	assert.equal(emitted.length, 0);
	const skips = skipsOf(protocolMessages);
	assert.deepEqual(
		skips.map((skip) => [skip.stream, skip.reason]),
		[["account_plan", "no_chat_organization"]],
	);
	assert.equal(
		requests.some((url) => url.includes("/export")),
		false,
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

for (const scenario of [
	{
		label: "different exported owner",
		users: [{ full_name: "Export Owner" }],
		status: "mismatch",
		name: null,
		source: "none",
	},
	{
		label: "matching roster name without verified owner identity",
		users: [{ full_name: "Current User" }],
		status: "valid",
		name: null,
		source: "none",
	},
	{
		label: "missing roster",
		users: undefined,
		status: "absent",
		name: null,
		source: "none",
	},
]) {
	test(`collectAnthropic: resumed account switch with ${scenario.label} emits attributable RECORD`, async () => {
		const zipBytes = await buildZipBytes(scenario.users);
		const { download } = makeFakeDownload(zipBytes);
		let exportRequestCount = 0;
		const fetchStub: FetchStub = (url) => {
			if (url.includes("/export_data")) {
				exportRequestCount += 1;
				return Promise.resolve(jsonResponse(200, { nonce: "wrong-nonce" }));
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		};
		const { ctx, page, protocolMessages } = makeContext({
			streams: ["account_profile"],
			state: {
				conversations: {
					pending_export: {
						organization_id: "old-org",
						nonce: "old-nonce",
						requested_at: "2025-12-31T00:00:00.000Z",
					},
				},
			},
			fetchStub,
		});
		page.menuSpans = ["Current User", "Max"];
		const runtimeEmitter = makeEmitRecord({
			requested: ctx.requested,
			emit: async (message) => {
				protocolMessages.push(message);
			},
			emittedAt: ctx.emittedAt,
			validateRecord,
			isTombstone: undefined,
			timeRangeFieldFor: () => ({ field: "", format: "date-time" }),
		});
		ctx.emitRecord = runtimeEmitter.emit;
		const originalGoto = page.goto.bind(page);
		page.goto = async (url: string): Promise<null> => {
			const result = await originalGoto(url);
			if (url.includes("/export/"))
				queueMicrotask(() => page.emit("download", download));
			return result;
		};

		await collectAnthropic(ctx);

		assert.equal(exportRequestCount, 0);
		assert.ok(
			page.gotoCalls.some((url) =>
				url.includes("/export/old-org/download/old-nonce"),
			),
		);
		const records = protocolMessages.filter(
			(message): message is Extract<EmittedMessage, { type: "RECORD" }> =>
				message.type === "RECORD" && message.stream === "account_profile",
		);
		assert.equal(runtimeEmitter.counters.totalEmitted, 1);
		assert.equal(records[0]?.key, "old-org");
		assert.deepEqual(records[0]?.data, {
			id: "old-org",
			organization_id: "old-org",
			full_name: scenario.name,
			plan: null,
			name_source: scenario.source,
			metadata_status: scenario.status,
		});
		assert.ok(
			protocolMessages.some(
				(message) =>
					message.type === "PROGRESS" &&
					message.message ===
						"The signed-in Claude profile may not belong to this export, so its name and plan were not used",
			),
		);
		const profileLine = diagnostics.find((line) =>
			line.startsWith("[anthropic-diagnostic] account_profile_unverified "),
		);
		assert.match(
			profileLine ?? "",
			/"outcome":"resumed_export_owner_not_verified_browser_name_and_plan_omitted"/,
		);
		assertUserFacingProgress(protocolMessages);
	});
}

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

/** A fixture entry given as exact JSON text, for shapes JSON.stringify cannot
 * write (a repeated key). */
class RawJson {
	text: string;
	constructor(text: string) {
		this.text = text;
	}
}

const entryText = (content: unknown): string =>
	content instanceof RawJson ? content.text : JSON.stringify(content);

async function buildManifestPartZip(
	entries: {
		name: string;
		content: unknown;
	}[],
): Promise<Buffer> {
	const { deflateRawSync } = await import("node:zlib");
	const files = entries.map((e) => ({
		name: e.name,
		content: Buffer.from(entryText(e.content)),
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
			content: {
				users: [{ full_name: "Wrong User" }, { full_name: "Synthetic Name" }],
			},
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

	const { ctx, protocolMessages, page } = makeContext({
		streams: [
			"account_profile",
			"conversations",
			"messages",
			"projects",
			"project_documents",
		],
		fetchStub,
	});
	page.menuSpans = ["Synthetic Name", "Pro"];
	const runtimeEmitter = makeEmitRecord({
		requested: ctx.requested,
		emit: async (message) => {
			protocolMessages.push(message);
		},
		emittedAt: ctx.emittedAt,
		validateRecord,
		isTombstone: undefined,
		timeRangeFieldFor: () => ({ field: "", format: "date-time" }),
	});
	ctx.emitRecord = runtimeEmitter.emit;

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

	const profileRecords = protocolMessages.filter(
		(message): message is Extract<EmittedMessage, { type: "RECORD" }> =>
			message.type === "RECORD" && message.stream === "account_profile",
	);
	assert.equal(
		profileRecords.length,
		1,
		"production emitRecord must emit a profile RECORD",
	);
	assert.equal(runtimeEmitter.counters.totalEmitted, 5);
	assert.equal(profileRecords[0]?.key, "org-1");
	const streams = new Set(
		protocolMessages.filter((m) => m.type === "RECORD").map((m) => m.stream),
	);
	assert.deepEqual([...streams].sort(), [
		"account_profile",
		"conversations",
		"messages",
		"project_documents",
		"projects",
	]);
	for (const stream of ["conversations", "projects"]) {
		const recordIndex = protocolMessages.findIndex(
			(message) => message.type === "RECORD" && message.stream === stream,
		);
		assert.ok(recordIndex > 0);
		const record = protocolMessages[recordIndex];
		const blob = protocolMessages[recordIndex - 1];
		assert.equal(blob?.type, "BLOB");
		if (record?.type === "RECORD" && blob?.type === "BLOB") {
			assert.equal(blob.stream, record.stream);
			assert.equal(blob.key, record.key);
		}
	}
	assert.deepEqual(profileRecords[0]?.data, {
		id: "org-1",
		organization_id: "org-1",
		full_name: null,
		plan: null,
		name_source: "none",
		metadata_status: "ambiguous",
	});

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

// ─── Archive recognition, nonce retention, export rate limit ─────────────

function oldFormatFetchStub(counter: { exportRequests: number }): FetchStub {
	return (url) => {
		if (url.includes("/api/organizations") && !url.includes("export_data")) {
			return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
		}
		if (url.includes("/export_data")) {
			counter.exportRequests += 1;
			return Promise.resolve(jsonResponse(200, { nonce: "nonce-layout" }));
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};
}

function serveDownload(page: FakePage, zipBytes: Buffer): void {
	const originalGoto = page.goto.bind(page);
	page.goto = async (url: string): Promise<null> => {
		const result = await originalGoto(url);
		if (url.includes("/export/")) {
			const { download } = makeFakeDownload(zipBytes);
			queueMicrotask(() => page.emit("download", download));
		}
		return result;
	};
}

const CONTENT_STREAMS = [
	"conversations",
	"messages",
	"projects",
	"project_documents",
];

const ALL_EXPORT_STREAMS = ["account_profile", ...CONTENT_STREAMS];

function statesOf(messages: EmittedMessage[]) {
	return messages.filter(
		(m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE",
	);
}

function skipsOf(messages: EmittedMessage[]) {
	return messages.filter(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT",
	);
}

test("collectAnthropic: ZIP with entries under a top-level folder -> layout_unrecognized skips, no synced_at, entry names in PROGRESS", async () => {
	const zipBytes = await buildManifestPartZip([
		{ name: "data-2026/conversations.json", content: CONVERSATIONS_JSON },
		{ name: "data-2026/projects/proj-1.json", content: PROJECT_JSON },
	]);
	const counter = { exportRequests: 0 };
	const { ctx, emitted, page, protocolMessages } = makeContext({
		streams: ALL_EXPORT_STREAMS,
		fetchStub: oldFormatFetchStub(counter),
	});
	serveDownload(page, zipBytes);

	await collectAnthropic(ctx);

	assert.equal(emitted.length, 0);
	const skips = skipsOf(protocolMessages);
	assert.deepEqual(
		skips.map((s) => s.stream).sort(),
		[...ALL_EXPORT_STREAMS].sort(),
	);
	for (const skip of skips) {
		assert.equal(skip.reason, "export_layout_unrecognized");
		assert.equal(
			(skip.recovery_hint as { retryable?: boolean }).retryable,
			false,
		);
	}
	for (const state of statesOf(protocolMessages)) {
		assert.ok(
			!("synced_at" in (state.cursor as Record<string, unknown>)),
			"an unrecognized archive must not checkpoint synced_at",
		);
	}
	const progressText = protocolMessages
		.filter((m) => m.type === "PROGRESS")
		.map((m) => (m as { message: string }).message)
		.join("\n");
	assert.match(progressText, /did not contain conversations or projects/);
	assert.doesNotMatch(progressText, /data-2026|Test conversation/);
	const layoutLine = diagnostics.find((line) =>
		line.startsWith("[anthropic-diagnostic] export_layout_unrecognized "),
	);
	assert.match(layoutLine ?? "", /data-2026\/conversations\.json/);
	assert.doesNotMatch(diagnostics.join("\n"), /Test conversation/);
	assertUserFacingProgress(protocolMessages);
});

test("collectAnthropic: recognized ZIP with empty conversations.json -> verified empty (synced_at STATE, no skip)", async () => {
	const zipBytes = await buildManifestPartZip([
		{ name: "conversations.json", content: [] },
	]);
	const counter = { exportRequests: 0 };
	const { ctx, emitted, page, protocolMessages } = makeContext({
		streams: ["conversations", "messages"],
		fetchStub: oldFormatFetchStub(counter),
	});
	serveDownload(page, zipBytes);

	await collectAnthropic(ctx);

	assert.equal(emitted.length, 0);
	assert.equal(skipsOf(protocolMessages).length, 0);
	const final = statesOf(protocolMessages).findLast(
		(m) => m.stream === "conversations",
	);
	const cursor = final?.cursor as Record<string, unknown>;
	assert.ok("synced_at" in cursor);
	assert.ok(!("pending_export" in cursor));
	assert.equal(
		(cursor.consumed_export as { nonce: string }).nonce,
		"nonce-layout",
	);
	assert.equal(typeof cursor.last_export_requested_at, "string");
});

test("collectAnthropic: recognized ZIP with data -> records, and unparseable items are reported", async () => {
	const zipBytes = await buildManifestPartZip([
		{
			name: "conversations.json",
			content: [...CONVERSATIONS_JSON, { not: "a conversation" }],
		},
		{ name: "projects/proj-1.json", content: PROJECT_JSON },
		{ name: "projects/proj-bad.json", content: { not: "a project" } },
	]);
	const counter = { exportRequests: 0 };
	const { ctx, emitted, page, protocolMessages } = makeContext({
		streams: CONTENT_STREAMS,
		fetchStub: oldFormatFetchStub(counter),
	});
	serveDownload(page, zipBytes);

	await collectAnthropic(ctx);

	assert.equal(emitted.filter((r) => r.stream === "conversations").length, 1);
	assert.equal(emitted.filter((r) => r.stream === "projects").length, 1);
	const dropped = skipsOf(protocolMessages);
	// A dropped parent also drops its children: messages / project_documents
	// must be skipped, not checkpointed as complete.
	assert.deepEqual(
		dropped.map((s) => s.stream).sort(),
		[...CONTENT_STREAMS].sort(),
	);
	assert.ok(dropped.every((s) => s.reason === "export_items_unparseable"));
	for (const state of statesOf(protocolMessages)) {
		assert.ok(!("synced_at" in (state.cursor as Record<string, unknown>)));
	}
});

test("collectAnthropic: pending nonce is kept across a layout-unrecognized run", async () => {
	const zipBytes = await buildManifestPartZip([
		{ name: "Claude export/conversations.json", content: CONVERSATIONS_JSON },
	]);
	const counter = { exportRequests: 0 };
	const pending = {
		organization_id: "org-1",
		nonce: "kept-nonce",
		requested_at: "2026-01-01T00:00:00.000Z",
	};
	const { ctx, page, protocolMessages } = makeContext({
		streams: ["conversations"],
		state: { conversations: { pending_export: pending } },
		fetchStub: oldFormatFetchStub(counter),
	});
	serveDownload(page, zipBytes);

	await collectAnthropic(ctx);

	assert.equal(counter.exportRequests, 0);
	assert.equal(
		statesOf(protocolMessages).length,
		0,
		"no STATE may replace the pending export",
	);
	assert.equal(
		skipsOf(protocolMessages)[0]?.reason,
		"export_layout_unrecognized",
	);
});

test("collectAnthropic: a run within 24 h of the last export request does not POST export_data", async () => {
	const counter = { exportRequests: 0 };
	const lastRequestedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
	const { ctx, emitted, protocolMessages } = makeContext({
		streams: ["conversations", "projects"],
		state: {
			conversations: {
				synced_at: lastRequestedAt,
				last_export_requested_at: lastRequestedAt,
			},
		},
		fetchStub: oldFormatFetchStub(counter),
	});

	await collectAnthropic(ctx);

	assert.equal(counter.exportRequests, 0);
	assert.equal(emitted.length, 0);
	const skips = skipsOf(protocolMessages);
	assert.deepEqual(skips.map((s) => s.stream).sort(), [
		"conversations",
		"projects",
	]);
	for (const skip of skips) {
		assert.equal(skip.reason, "export_recently_requested");
		assert.equal(
			(skip.recovery_hint as { retryable?: boolean }).retryable,
			true,
		);
	}
	assert.equal(statesOf(protocolMessages).length, 0);
});

test("collectAnthropic: multi-part manifest with no recognized category part -> layout_unrecognized skips, no synced_at", async () => {
	const memoriesZip = await buildManifestPartZip([
		{ name: "memories.json", content: [{ private: "not emitted" }] },
	]);
	const manifest = {
		version: "1.0",
		total_files: 1,
		data_files: [
			{
				batch_index: 0,
				category: "memories",
				part: 0,
				filename: "memories-000.zip",
				export_url: "https://claude.ai/export/org-1/download/part-token-mem",
			},
		],
	};
	const fetchStub: FetchStub = (url) => {
		if (url.includes("/api/organizations") && !url.includes("export_data")) {
			return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
		}
		if (url.includes("/export_data")) {
			return Promise.resolve(jsonResponse(200, manifest));
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};
	const { ctx, emitted, page, protocolMessages } = makeContext({
		streams: ALL_EXPORT_STREAMS,
		state: { conversations: { synced_at: "2026-01-01T00:00:00.000Z" } },
		fetchStub,
	});
	serveDownload(page, memoriesZip);

	await collectAnthropic(ctx);

	assert.equal(emitted.length, 0);
	const skips = skipsOf(protocolMessages);
	assert.deepEqual(
		skips.map((s) => s.stream).sort(),
		[...ALL_EXPORT_STREAMS].sort(),
	);
	assert.ok(skips.every((s) => s.reason === "export_layout_unrecognized"));
	for (const state of statesOf(protocolMessages)) {
		assert.ok(!("synced_at" in (state.cursor as Record<string, unknown>)));
	}
	const progressText = protocolMessages
		.filter((m) => m.type === "PROGRESS")
		.map((m) => (m as { message: string }).message)
		.join("\n");
	assert.match(diagnostics.join("\n"), /memories\/memories\.json/);
	assert.doesNotMatch(progressText, /not emitted|memories\.json/);
});

function manifestFetchStub(
	parts: Array<{ category: string; token: string; part?: number }>,
	totalFiles = parts.length,
): FetchStub {
	// Synthetic default: category-local numbering matches the only scheme
	// accepted for proof. Observed filenames do not prove raw part semantics.
	const seen = new Map<string, number>();
	const manifest = {
		version: "1.0",
		total_files: totalFiles,
		data_files: parts.map((p, i) => {
			const next = seen.get(p.category) ?? 0;
			seen.set(p.category, next + 1);
			const part = p.part ?? next;
			return {
				batch_index: 0,
				category: p.category,
				part,
				filename: `${p.category}-00${i}.zip`,
				export_url: `https://claude.ai/export/org-1/download/${p.token}`,
			};
		}),
	};
	return (url) => {
		if (url.includes("/api/organizations") && !url.includes("export_data")) {
			return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
		}
		if (url.includes("/export_data")) {
			return Promise.resolve(jsonResponse(200, manifest));
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	};
}

function serveDownloads(
	page: FakePage,
	zipsByToken: Map<string, Buffer>,
): void {
	const originalGoto = page.goto.bind(page);
	page.goto = async (url: string): Promise<null> => {
		const result = await originalGoto(url);
		for (const [token, bytes] of zipsByToken) {
			if (url.includes(token)) {
				const { download } = makeFakeDownload(bytes);
				queueMicrotask(() => page.emit("download", download));
			}
		}
		return result;
	};
}

test("collectAnthropic: manifest conversations part with only unknown-shape content -> layout_unrecognized, no synced_at", async () => {
	const zip = await buildManifestPartZip([
		{ name: "conversations.json", content: [{ unknown: "shape" }] },
	]);
	const { ctx, emitted, page, protocolMessages } = makeContext({
		streams: ALL_EXPORT_STREAMS,
		fetchStub: manifestFetchStub([
			{ category: "conversations", token: "tok-c" },
		]),
	});
	serveDownloads(page, new Map([["tok-c", zip]]));

	await collectAnthropic(ctx);

	assert.equal(emitted.length, 0);
	const skips = skipsOf(protocolMessages);
	assert.deepEqual(
		skips.map((s) => s.stream).sort(),
		[...ALL_EXPORT_STREAMS].sort(),
	);
	assert.ok(skips.every((s) => s.reason === "export_layout_unrecognized"));
	for (const state of statesOf(protocolMessages)) {
		assert.ok(!("synced_at" in (state.cursor as Record<string, unknown>)));
	}
});

test("collectAnthropic: manifest with an empty conversations part is a verified empty", async () => {
	const zip = await buildManifestPartZip([
		{ name: "conversations.json", content: [] },
	]);
	const { ctx, emitted, page, protocolMessages } = makeContext({
		streams: ["conversations", "messages"],
		fetchStub: manifestFetchStub([
			{ category: "conversations", token: "tok-c" },
			{ category: "light_metadata", token: "tok-m" },
		]),
	});
	const metadataZip = await buildManifestPartZip([
		{ name: "users.json", content: [{ full_name: "Browser Owner" }] },
	]);
	serveDownloads(
		page,
		new Map([
			["tok-c", zip],
			["tok-m", metadataZip],
		]),
	);

	await collectAnthropic(ctx);

	assert.equal(emitted.length, 0);
	assert.equal(skipsOf(protocolMessages).length, 0);
	const final = statesOf(protocolMessages).findLast(
		(m) => m.stream === "conversations",
	);
	assert.ok(final?.cursor);
	assert.ok("synced_at" in (final.cursor as Record<string, unknown>));
});

test("collectAnthropic: manifest without a projects category skips projects and documents instead of checkpointing them empty", async () => {
	const zip = await buildManifestPartZip([
		{
			name: "conversations.json",
			content: [
				{
					uuid: "conv-1",
					name: "Manifest conversation",
					created_at: "2026-01-01T00:00:00.000Z",
					chat_messages: [],
				},
			],
		},
	]);
	const { ctx, emitted, page, protocolMessages } = makeContext({
		streams: ["conversations", "projects", "project_documents"],
		fetchStub: manifestFetchStub([
			{ category: "conversations", token: "tok-c" },
			{ category: "light_metadata", token: "tok-m" },
		]),
	});
	const metadataZip = await buildManifestPartZip([
		{ name: "users.json", content: [{ full_name: "Browser Owner" }] },
	]);
	serveDownloads(
		page,
		new Map([
			["tok-c", zip],
			["tok-m", metadataZip],
		]),
	);

	await collectAnthropic(ctx);

	assert.deepEqual(
		emitted
			.filter((record) => record.stream === "conversations")
			.map((record) => record.data.id),
		["conv-1"],
	);
	const skips = skipsOf(protocolMessages);
	assert.deepEqual(skips.map((skip) => skip.stream).sort(), [
		"project_documents",
		"projects",
	]);
	assert.ok(skips.every((skip) => skip.reason === "export_projects_missing"));
	assertNoSyncedAt(protocolMessages, ["projects", "project_documents"]);
	assert.ok(
		statesOf(protocolMessages).some(
			(message) =>
				message.stream === "conversations" &&
				"synced_at" in (message.cursor as Record<string, unknown>),
		),
	);
});

test("collectAnthropic: manifest projects part with unknown content skips projects and project_documents only", async () => {
	const convZip = await buildManifestPartZip([
		{ name: "conversations.json", content: CONVERSATIONS_JSON },
	]);
	const projZip = await buildManifestPartZip([
		{ name: "projects/odd.json", content: { unknown: "shape" } },
	]);
	const { ctx, emitted, page, protocolMessages } = makeContext({
		streams: CONTENT_STREAMS,
		fetchStub: manifestFetchStub([
			{ category: "conversations", token: "tok-c" },
			{ category: "projects", token: "tok-p" },
			{ category: "light_metadata", token: "tok-m" },
		]),
	});
	const metadataZip = await buildManifestPartZip([
		{ name: "users.json", content: [{ full_name: "Browser Owner" }] },
	]);
	serveDownloads(
		page,
		new Map([
			["tok-c", convZip],
			["tok-p", projZip],
			["tok-m", metadataZip],
		]),
	);

	await collectAnthropic(ctx);

	assert.equal(emitted.filter((r) => r.stream === "conversations").length, 1);
	const skips = skipsOf(protocolMessages);
	assert.deepEqual(skips.map((s) => s.stream).sort(), [
		"project_documents",
		"projects",
	]);
	assert.ok(skips.every((s) => s.reason === "export_items_unparseable"));
	const projectStates = statesOf(protocolMessages).filter(
		(m) => m.stream === "projects",
	);
	assert.equal(projectStates.length, 0);
});

test("collectAnthropic: layout_unrecognized PROGRESS caps the entry names", async () => {
	const zipBytes = await buildManifestPartZip(
		Array.from({ length: 80 }, (_, i) => ({
			name: `folder/entry-${i}.json`,
			content: [],
		})),
	);
	const counter = { exportRequests: 0 };
	const { ctx, page, protocolMessages } = makeContext({
		streams: ["conversations"],
		fetchStub: oldFormatFetchStub(counter),
	});
	serveDownload(page, zipBytes);

	await collectAnthropic(ctx);

	const progressText = protocolMessages
		.filter((m) => m.type === "PROGRESS")
		.map((m) => (m as { message: string }).message)
		.join("\n");
	assert.doesNotMatch(progressText, /entry-\d+\.json/);
	const layoutLine = diagnostics.find((line) =>
		line.startsWith("[anthropic-diagnostic] export_layout_unrecognized "),
	);
	assert.match(layoutLine ?? "", /entry-49\.json/);
	assert.doesNotMatch(layoutLine ?? "", /entry-50\.json/);
	assert.match(layoutLine ?? "", /"hidden_entry_count":30/);
});

async function runManifest(
	parts: Array<{
		category: string;
		entries: Array<{ name: string; content: unknown }>;
	}>,
	streams: readonly string[] = ALL_EXPORT_STREAMS,
) {
	const tokens = parts.map((p, i) => ({
		category: p.category,
		token: `tok-${i}`,
	}));
	const zipBytes = await Promise.all(
		parts.map((part) => buildManifestPartZip(part.entries)),
	);
	const zips = new Map(zipBytes.map((bytes, i) => [`tok-${i}`, bytes]));
	const context = makeContext({
		streams: [...streams],
		fetchStub: manifestFetchStub(tokens),
	});
	serveDownloads(context.page, zips);
	await collectAnthropic(context.ctx);
	return context;
}

function assertNoSyncedAt(
	messages: EmittedMessage[],
	streams: readonly string[],
): void {
	for (const state of statesOf(messages)) {
		if (streams.includes(state.stream)) {
			assert.ok(
				!("synced_at" in (state.cursor as Record<string, unknown>)),
				`${state.stream} must not get synced_at`,
			);
		}
	}
}

for (const scenario of [
	{
		label: "only a projects part",
		parts: [
			{
				category: "projects",
				entries: [{ name: "projects/p.json", content: PROJECT_JSON }],
			},
			{
				category: "light_metadata",
				entries: [
					{ name: "users.json", content: [{ full_name: "Browser Owner" }] },
				],
			},
		],
	},
	{
		label: "conversations under a renamed category",
		parts: [
			{
				category: "chats",
				entries: [{ name: "conversations.json", content: CONVERSATIONS_JSON }],
			},
			{
				category: "projects",
				entries: [{ name: "projects/p.json", content: PROJECT_JSON }],
			},
			{
				category: "light_metadata",
				entries: [
					{ name: "users.json", content: [{ full_name: "Browser Owner" }] },
				],
			},
		],
	},
]) {
	test(`collectAnthropic: manifest with ${scenario.label} skips conversations and messages, no synced_at`, async () => {
		const { emitted, protocolMessages } = await runManifest(scenario.parts);

		const skips = skipsOf(protocolMessages);
		assert.deepEqual(
			skips.map((s) => s.stream).sort(),
			[
				...(scenario.label === "conversations under a renamed category"
					? ARCHIVE_STREAMS
					: ["conversations", "messages"]),
			].sort(),
		);
		assert.ok(
			skips.every(
				(s) =>
					s.reason ===
					(scenario.label === "conversations under a renamed category"
						? "export_manifest_incomplete"
						: "export_conversations_missing"),
			),
		);
		assertNoSyncedAt(
			protocolMessages,
			scenario.label === "conversations under a renamed category"
				? ARCHIVE_STREAMS
				: ["conversations", "messages"],
		);
		assert.equal(emitted.filter((r) => r.stream === "conversations").length, 0);
		assert.equal(emitted.filter((r) => r.stream === "projects").length, 1);
		const conversationsState = statesOf(protocolMessages).findLast(
			(m) => m.stream === "conversations",
		);
		assert.ok(conversationsState?.cursor);
		assert.ok(
			"last_export_requested_at" in
				(conversationsState.cursor as Record<string, unknown>),
		);
	});
}

test("collectAnthropic: manifest conversations entry with an unparseable item skips conversations and messages, count in PROGRESS", async () => {
	const secret = "private-title-do-not-log";
	const { emitted, protocolMessages } = await runManifest([
		{
			category: "conversations",
			entries: [
				{
					name: "conversations.json",
					content: [...CONVERSATIONS_JSON, { not: "a conversation", secret }],
				},
			],
		},
		{
			category: "light_metadata",
			entries: [
				{ name: "users.json", content: [{ full_name: "Browser Owner" }] },
			],
		},
	]);

	const skips = skipsOf(protocolMessages);
	assert.deepEqual(skips.map((s) => s.stream).sort(), [
		"conversations",
		"messages",
		"project_documents",
		"projects",
	]);
	assert.deepEqual(
		skips.map((skip) => `${skip.stream}:${skip.reason}`).sort(),
		[
			"conversations:export_items_unparseable",
			"messages:export_items_unparseable",
			"project_documents:export_projects_missing",
			"projects:export_projects_missing",
		].sort(),
	);
	assertNoSyncedAt(protocolMessages, [
		"conversations",
		"messages",
		"projects",
		"project_documents",
	]);
	assert.equal(emitted.filter((r) => r.stream === "conversations").length, 1);
	const progressText = protocolMessages
		.filter((m) => m.type === "PROGRESS")
		.map((m) => (m as { message: string }).message)
		.join("\n");
	assert.match(
		progressText,
		/1 item of conversations in the export could not be read and was not imported/,
	);
	assert.doesNotMatch(progressText, new RegExp(secret));
});

test("collectAnthropic: manifest conversation without chat_messages imports its parent but leaves messages incomplete", async () => {
	const { emitted, protocolMessages } = await runManifest([
		{
			category: "conversations",
			entries: [
				{
					name: "conversations.json",
					content: [
						...CONVERSATIONS_JSON,
						{ uuid: "conv-2", name: "No messages key" },
					],
				},
			],
		},
		{
			category: "light_metadata",
			entries: [
				{ name: "users.json", content: [{ full_name: "Browser Owner" }] },
			],
		},
	]);

	const skips = skipsOf(protocolMessages);
	assert.deepEqual(
		skips.map((skip) => `${skip.stream}:${skip.reason}`).sort(),
		[
			"messages:export_conversation_incomplete",
			"project_documents:export_projects_missing",
			"projects:export_projects_missing",
		].sort(),
	);
	const skip = skips.find((entry) => entry.stream === "messages");
	assert.ok(skip);
	assert.equal(skip.reason, "export_conversation_incomplete");
	assert.equal(
		(skip.diagnostics as Record<string, unknown> | undefined)?.conversation_id,
		"conv-2",
	);
	assertNoSyncedAt(protocolMessages, [
		"messages",
		"projects",
		"project_documents",
	]);
	assert.equal(emitted.filter((r) => r.stream === "conversations").length, 2);
});

// ─── export_data refusal: structured status diagnostics ───────────────────

async function runExportRefusal(
	exportResponse: () => Response | Promise<Response>,
	state?: Record<string, unknown>,
): Promise<{
	skip: Extract<EmittedMessage, { type: "SKIP_RESULT" }>;
	states: Extract<EmittedMessage, { type: "STATE" }>[];
	exportPosts: number;
}> {
	let exportPosts = 0;
	const fetchStub: FetchStub = async (url) => {
		if (url.includes("/export_data")) {
			exportPosts += 1;
			return await exportResponse();
		}
		if (url.includes("/api/organizations")) {
			return jsonResponse(200, ORG_RESPONSE);
		}
		throw new Error(`unexpected fetch: ${url}`);
	};
	const { ctx, protocolMessages } = makeContext({
		streams: ["conversations"],
		fetchStub,
		...(state ? { state } : {}),
	});
	await collectAnthropic(ctx);
	const skips = protocolMessages.filter(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT",
	);
	const [skip] = skips;
	assert.ok(skip && skips.length === 1, "exactly one SKIP_RESULT expected");
	return {
		skip,
		states: protocolMessages.filter(
			(m): m is Extract<EmittedMessage, { type: "STATE" }> =>
				m.type === "STATE",
		),
		exportPosts,
	};
}

test("collectAnthropic: export_data 429 with Retry-After -> export_rate_limited with http_status, retry_after and a not-before checkpoint", async () => {
	const before = Date.now();
	const { skip, states } = await runExportRefusal(
		() =>
			new Response("{}", { status: 429, headers: { "retry-after": "3600" } }),
	);
	assert.equal(skip.reason, "export_rate_limited");
	assert.deepEqual(skip.recovery_hint, {
		action: "retry_by_runtime",
		retryable: true,
	});
	const diagnostics = skip.diagnostics as Record<string, unknown>;
	assert.equal(diagnostics.http_status, 429);
	assert.equal(diagnostics.retry_after, 3600);
	const notBefore = Date.parse(diagnostics.retry_not_before as string);
	assert.ok(notBefore >= before + 3_600_000);
	const [state] = states;
	assert.ok(state && states.length === 1);
	assert.equal(
		(state.cursor as Record<string, unknown>).export_retry_not_before,
		diagnostics.retry_not_before,
	);
});

test("collectAnthropic: export_data 429 without Retry-After -> export_rate_limited with a 24 h not-before checkpoint", async () => {
	const before = Date.now();
	const { skip, states } = await runExportRefusal(
		() => new Response("", { status: 429 }),
	);
	assert.equal(skip.reason, "export_rate_limited");
	const diagnostics = skip.diagnostics as Record<string, unknown>;
	assert.equal(diagnostics.http_status, 429);
	assert.equal(diagnostics.retry_after, undefined);
	const notBefore = Date.parse(diagnostics.retry_not_before as string);
	assert.ok(notBefore >= before + 24 * 3_600_000);
	assert.match(skip.message as string, /gave no Retry-After/);
	const [state] = states;
	assert.ok(state && states.length === 1);
	assert.equal(
		(state.cursor as Record<string, unknown>).export_retry_not_before,
		diagnostics.retry_not_before,
	);
});

test("collectAnthropic: a huge Retry-After is clamped to 7 days and does not throw", async () => {
	const before = Date.now();
	const { skip } = await runExportRefusal(
		() =>
			new Response("", {
				status: 429,
				headers: { "retry-after": "99999999999999" },
			}),
	);
	const diagnostics = skip.diagnostics as Record<string, unknown>;
	assert.equal(diagnostics.retry_after, 7 * 24 * 60 * 60);
	const notBefore = Date.parse(diagnostics.retry_not_before as string);
	assert.ok(notBefore >= before + 7 * 24 * 3_600_000);
	assert.ok(notBefore < before + 8 * 24 * 3_600_000);
});

test("collectAnthropic: a 2xx unrecognized export response checkpoints last_export_requested_at, so the next run does not POST", async () => {
	const first = await runExportRefusal(() =>
		jsonResponse(200, { status: "queued" }),
	);
	const [state] = first.states;
	assert.ok(state && first.states.length === 1);
	const cursor = state.cursor as Record<string, unknown>;
	assert.equal(typeof cursor.last_export_requested_at, "string");
	const second = await runExportRefusal(
		() => {
			throw new Error("export_data must not be requested");
		},
		{ conversations: cursor },
	);
	assert.equal(second.exportPosts, 0);
	assert.equal(second.skip.reason, "export_recently_requested");
});

for (const scenario of [
	{ label: "429", response: () => new Response("", { status: 429 }) },
	{ label: "401", response: () => new Response("", { status: 401 }) },
	{ label: "2xx unrecognized", response: () => jsonResponse(200, { a: 1 }) },
	{ label: "no chat organization", response: null },
]) {
	test(`collectAnthropic: ${scenario.label} skips every requested export stream, not only conversations`, async () => {
		const { ctx, emitted, protocolMessages } = makeContext({
			streams: ["account_profile", ...CONTENT_STREAMS],
			fetchStub: async (url) => {
				if (url.includes("/export_data") && scenario.response)
					return scenario.response();
				if (url.includes("/api/organizations"))
					return jsonResponse(200, scenario.response ? ORG_RESPONSE : []);
				throw new Error(`unexpected fetch: ${url}`);
			},
		});
		await collectAnthropic(ctx);
		assert.equal(emitted.length, 0);
		const skips = skipsOf(protocolMessages);
		assert.deepEqual(
			skips.map((m) => m.stream).sort(),
			["account_profile", ...CONTENT_STREAMS].sort(),
		);
		assert.equal(new Set(skips.map((m) => m.reason)).size, 1);
	});
}

test("collectAnthropic: a stored export_retry_not_before in the future blocks POST export_data", async () => {
	const notBefore = new Date(Date.now() + 60_000).toISOString();
	const { skip, exportPosts } = await runExportRefusal(
		() => {
			throw new Error("export_data must not be requested");
		},
		{ conversations: { export_retry_not_before: notBefore } },
	);
	assert.equal(exportPosts, 0);
	assert.equal(skip.reason, "export_rate_limited");
	assert.deepEqual(skip.diagnostics, { retry_not_before: notBefore });
});

test("collectAnthropic: an expired export_retry_not_before does not block POST export_data", async () => {
	const notBefore = new Date(Date.now() - 60_000).toISOString();
	const { exportPosts, skip } = await runExportRefusal(
		() => new Response("", { status: 500 }),
		{
			conversations: { export_retry_not_before: notBefore },
		},
	);
	assert.equal(exportPosts, 1);
	assert.equal(skip.reason, "export_request_failed");
});

for (const status of [401, 403]) {
	test(`collectAnthropic: export_data ${status} -> export_auth_rejected with refresh_credentials`, async () => {
		const { skip } = await runExportRefusal(() => new Response("", { status }));
		assert.equal(skip.reason, "export_auth_rejected");
		assert.deepEqual(skip.recovery_hint, {
			action: "refresh_credentials",
			retryable: false,
		});
		assert.deepEqual(skip.diagnostics, { http_status: status });
	});
}

test("collectAnthropic: export_data 2xx without nonce or data_files -> export_response_unrecognized with key names only", async () => {
	const { skip } = await runExportRefusal(() =>
		jsonResponse(200, { status: "queued", job: { id: "secret-value" } }),
	);
	assert.equal(skip.reason, "export_response_unrecognized");
	assert.deepEqual(skip.recovery_hint, {
		action: "retry_on_connector_upgrade",
		retryable: false,
	});
	assert.deepEqual(skip.diagnostics, {
		http_status: 200,
		body_keys: ["job", "status"],
	});
	assert.ok(!JSON.stringify(skip).includes("secret-value"));
});

test("collectAnthropic: export_data 500 and network error keep export_request_failed with http_status", async () => {
	const server = await runExportRefusal(
		() => new Response("", { status: 500 }),
	);
	assert.equal(server.skip.reason, "export_request_failed");
	assert.deepEqual(server.skip.recovery_hint, {
		action: "retry_by_runtime",
		retryable: true,
	});
	assert.deepEqual(server.skip.diagnostics, { http_status: 500 });
	const network = await runExportRefusal(() => {
		throw new TypeError("fetch failed");
	});
	assert.equal(network.skip.reason, "export_request_failed");
	assert.deepEqual(network.skip.diagnostics, { http_status: 0 });
});

// ─── Split export: nonce download is a manifest (2026-09-22 layout) ──────
//
// __fixtures__/split-export holds a synthetic copy of the real layout: a
// manifest JSON plus one ZIP per category. On a real account the nonce
// download delivered the manifest, not a ZIP.

const SPLIT_EXPORT_DIR = join(import.meta.dirname, "__fixtures__/split-export");

function listFilesRecursive(dir: string, prefix = ""): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? listFilesRecursive(join(dir, entry.name), `${prefix}${entry.name}/`)
			: [`${prefix}${entry.name}`],
	);
}

async function splitExportDownloads(): Promise<{
	manifestBytes: Buffer;
	zipsByToken: Map<string, Buffer>;
}> {
	const manifestBytes = readFileSync(join(SPLIT_EXPORT_DIR, "manifest.json"));
	const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
		data_files: { filename: string; export_url: string }[];
	};
	const parts = await Promise.all(
		manifest.data_files.map(async (part) => {
			const dir = join(SPLIT_EXPORT_DIR, part.filename.replace(/\.zip$/, ""));
			const entries = listFilesRecursive(dir).map((name) => ({
				name,
				content: JSON.parse(readFileSync(join(dir, name), "utf8")),
			}));
			const token = new URL(part.export_url).pathname.split("/").pop() ?? "";
			return [token, await buildManifestPartZip(entries)] as const;
		}),
	);
	const zipsByToken = new Map<string, Buffer>(parts);
	return { manifestBytes, zipsByToken };
}

/** Serve the manifest at the nonce URL and each part at its export_url. */
function serveSplitExport(
	page: FakePage,
	nonce: string,
	downloads: { manifestBytes: Buffer; zipsByToken: Map<string, Buffer> },
	failToken?: string,
): void {
	const originalGoto = page.goto.bind(page);
	page.goto = async (url: string): Promise<null> => {
		const result = await originalGoto(url);
		const token = new URL(url).pathname.split("/").pop() ?? "";
		const bytes =
			token === nonce
				? downloads.manifestBytes
				: token === failToken
					? undefined
					: downloads.zipsByToken.get(token);
		if (bytes) {
			const { download } = makeFakeDownload(bytes);
			queueMicrotask(() => page.emit("download", download));
		}
		return result;
	};
}

function recordCounts(
	emitted: ReturnType<typeof makeRecordingEmit>["emitted"],
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const record of emitted)
		counts[record.stream] = (counts[record.stream] ?? 0) + 1;
	return counts;
}

test("collectAnthropic: nonce download that is a split-export manifest imports every category part", async () => {
	const downloads = await splitExportDownloads();
	const counter = { exportRequests: 0 };
	const { ctx, emitted, page, protocolMessages } = makeContext({
		streams: ["account_profile", ...CONTENT_STREAMS],
		fetchStub: oldFormatFetchStub(counter),
	});
	serveSplitExport(page, "nonce-layout", downloads);

	await collectAnthropic(ctx);

	assert.equal(counter.exportRequests, 1);
	assert.deepEqual(recordCounts(emitted), {
		account_profile: 1,
		conversations: 2,
		messages: 3,
		projects: 2,
		project_documents: 1,
	});
	assert.deepEqual(skipsOf(protocolMessages), []);
	const final = statesOf(protocolMessages).findLast(
		(m) => m.stream === "conversations",
	);
	const cursor = final?.cursor as Record<string, unknown>;
	assert.ok("synced_at" in cursor);
	assert.ok(!("pending_export" in cursor));
	assert.equal(
		(cursor.consumed_export as { nonce: string }).nonce,
		"nonce-layout",
	);
	const progressText = protocolMessages
		.filter((m) => m.type === "PROGRESS")
		.map((m) => (m as { message: string }).message)
		.join("\n");
	assert.doesNotMatch(progressText, /design_chats/);
	assert.match(progressText, /Part of the Claude export is not supported yet/);
	const categoryLine = diagnostics.find((line) =>
		line.startsWith("[anthropic-diagnostic] export_categories_without_stream "),
	);
	assert.match(categoryLine ?? "", /memories \(1 entry\)/);
	assert.match(categoryLine ?? "", /design_chats \(1 entry\)/);
	assertUserFacingProgress(protocolMessages);
});

test("collectAnthropic: split-export manifest returned by POST export_data imports every category part", async () => {
	const downloads = await splitExportDownloads();
	const { ctx, emitted, page, protocolMessages } = makeContext({
		streams: ["account_profile", ...CONTENT_STREAMS],
		fetchStub: (url) => {
			if (url.includes("/api/organizations") && !url.includes("export_data"))
				return Promise.resolve(jsonResponse(200, ORG_RESPONSE));
			if (url.includes("/export_data"))
				return Promise.resolve(
					jsonResponse(
						200,
						JSON.parse(downloads.manifestBytes.toString("utf8")),
					),
				);
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		},
	});
	serveSplitExport(page, "no-nonce", downloads);

	await collectAnthropic(ctx);

	assert.deepEqual(recordCounts(emitted), {
		account_profile: 1,
		conversations: 2,
		messages: 3,
		projects: 2,
		project_documents: 1,
	});
	assert.deepEqual(skipsOf(protocolMessages), []);
});

test("collectAnthropic: a failed part of a nonce manifest keeps the pending nonce", async () => {
	const downloads = await splitExportDownloads();
	const counter = { exportRequests: 0 };
	const pending = {
		organization_id: "org-1",
		nonce: "kept-nonce",
		requested_at: "2026-01-01T00:00:00.000Z",
	};
	const { ctx, emitted, page, protocolMessages } = makeContext({
		streams: ["conversations", "projects"],
		state: { conversations: { pending_export: pending } },
		fetchStub: oldFormatFetchStub(counter),
	});
	serveSplitExport(
		page,
		"kept-nonce",
		downloads,
		"synthetic-part-conversations",
	);

	await collectAnthropic(ctx);

	assert.equal(counter.exportRequests, 0);
	assert.equal(emitted.length, 0);
	assert.equal(statesOf(protocolMessages).length, 0);
	const skips = skipsOf(protocolMessages);
	assert.equal(skips.length, 2);
	for (const skip of skips) {
		assert.equal(skip.reason, "export_part_download_failed");
		assert.match(skip.message as string, /downloads the same export again/);
	}
});

test("collectAnthropic: within 24 h of a consumed export, downloads that export again instead of skipping", async () => {
	const downloads = await splitExportDownloads();
	const counter = { exportRequests: 0 };
	const requestedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
	const consumed = {
		organization_id: "org-1",
		nonce: "consumed-nonce",
		requested_at: requestedAt,
	};
	const { ctx, emitted, page, protocolMessages } = makeContext({
		streams: ["conversations", "projects"],
		state: {
			conversations: {
				consumed_export: consumed,
				last_export_requested_at: requestedAt,
			},
		},
		fetchStub: oldFormatFetchStub(counter),
	});
	serveSplitExport(page, "consumed-nonce", downloads);

	await collectAnthropic(ctx);

	assert.equal(counter.exportRequests, 0, "no new export may be requested");
	assert.equal(recordCounts(emitted).conversations, 2);
	assert.deepEqual(skipsOf(protocolMessages), []);
	const final = statesOf(protocolMessages).findLast(
		(m) => m.stream === "conversations",
	);
	assert.ok(final);
	assert.equal(
		(final.cursor as Record<string, unknown>).last_export_requested_at,
		requestedAt,
		"the request window stays anchored to the original request",
	);
});

test("exportRequestMinIntervalMs: dev override applies only outside a host-supervised run", async () => {
	const { exportRequestMinIntervalMs, DEV_EXPORT_MIN_INTERVAL_ENV } =
		await import("./index.ts");
	const day = 24 * 60 * 60 * 1000;
	assert.equal(exportRequestMinIntervalMs({}), day);
	assert.equal(
		exportRequestMinIntervalMs({ [DEV_EXPORT_MIN_INTERVAL_ENV]: "0" }),
		0,
	);
	assert.equal(
		exportRequestMinIntervalMs({
			[DEV_EXPORT_MIN_INTERVAL_ENV]: "0",
			PDPP_RUN_ID: "run-1",
		}),
		day,
	);
	assert.equal(
		exportRequestMinIntervalMs({ [DEV_EXPORT_MIN_INTERVAL_ENV]: "soon" }),
		day,
	);
	assert.equal(
		exportRequestMinIntervalMs({ [DEV_EXPORT_MIN_INTERVAL_ENV]: "-1" }),
		day,
	);
});

test("collectAnthropic: dev override of the request interval lets a hand-run connector POST again", async () => {
	const counter = { exportRequests: 0 };
	const lastRequestedAt = new Date(Date.now() - 60 * 1000).toISOString();
	const priorRunId = process.env.PDPP_RUN_ID;
	delete process.env.PDPP_RUN_ID;
	process.env.PDPP_ANTHROPIC_DEV_EXPORT_MIN_INTERVAL_MS = "0";
	try {
		const { ctx, page, protocolMessages } = makeContext({
			streams: ["conversations"],
			state: {
				conversations: { last_export_requested_at: lastRequestedAt },
			},
			fetchStub: oldFormatFetchStub(counter),
		});
		serveDownload(page, await buildZipBytes());

		await collectAnthropic(ctx);

		assert.equal(counter.exportRequests, 1);
		assert.deepEqual(skipsOf(protocolMessages), []);
	} finally {
		delete process.env.PDPP_ANTHROPIC_DEV_EXPORT_MIN_INTERVAL_MS;
		if (priorRunId !== undefined) process.env.PDPP_RUN_ID = priorRunId;
	}
});

// ─── Export link checkpoints ──────────────────────────────────────────────
// A spent link (EXPORT_LINK_SPENT) comes only from the PageShim download
// binding; scripts/pageshim/pageshim.test.mjs covers it end to end.

/** Serve `zipBytes` for every export download, except that a download of
 * a nonce in `failures` fails with that nonce's error. */
function serveDownloadsByNonce(
	page: FakePage,
	zipBytes: Buffer,
	failures: Record<string, () => Error>,
): void {
	const originalGoto = page.goto.bind(page);
	page.goto = async (url: string): Promise<null> => {
		const result = await originalGoto(url);
		const nonce = /\/export\/[^/]+\/download\/([^/?#]+)/.exec(url)?.[1];
		if (nonce) {
			const fail = failures[nonce];
			const download = fail
				? {
						saveAs: () => Promise.reject(fail()),
						suggestedFilename: () => "export.zip",
					}
				: makeFakeDownload(zipBytes).download;
			queueMicrotask(() => page.emit("download", download));
		}
		return result;
	};
}

test("collectAnthropic: a read export clears the pending nonce before any record is emitted", async () => {
	const counter = { exportRequests: 0 };
	const { ctx, events, page } = makeContext({
		streams: ["conversations", "messages"],
		fetchStub: oldFormatFetchStub(counter),
	});
	serveDownloadsByNonce(page, await buildZipBytes(), {});

	await collectAnthropic(ctx);

	const firstRecord = events.findIndex((e) => e.kind === "record");
	assert.ok(firstRecord > 0);
	const statesBefore = events
		.slice(0, firstRecord)
		.flatMap((e) =>
			e.kind === "message" &&
			e.message.type === "STATE" &&
			e.message.stream === "conversations"
				? [e.message.cursor as Record<string, unknown>]
				: [],
		);
	assert.equal(statesBefore.length, 2);
	const [requestedState, readState] = statesBefore;
	assert.ok(requestedState && readState);
	assert.equal(
		(requestedState.pending_export as { nonce: string }).nonce,
		"nonce-layout",
		"the request is checkpointed before polling",
	);
	assert.equal(readState.pending_export, undefined);
	assert.equal(
		(readState.consumed_export as { nonce: string }).nonce,
		"nonce-layout",
	);
	assert.equal(readState.synced_at, undefined);
});

test("collectAnthropic: a download failure that is not a spent link keeps the pending nonce", async () => {
	const counter = { exportRequests: 0 };
	const pending = {
		organization_id: "org-1",
		nonce: "kept-nonce",
		requested_at: "2025-12-31T00:00:00.000Z",
	};
	const { ctx, emitted, page, protocolMessages } = makeContext({
		streams: ["conversations"],
		state: { conversations: { pending_export: pending } },
		fetchStub: oldFormatFetchStub(counter),
	});
	serveDownloadsByNonce(page, await buildZipBytes(), {
		"kept-nonce": () => new Error("disk full"),
	});

	await assert.rejects(collectAnthropic(ctx), /disk full/);

	assert.equal(counter.exportRequests, 0);
	assert.equal(emitted.length, 0);
	assert.deepEqual(statesOf(protocolMessages), []);
});

test("collectAnthropic: completion evidence measures explicit empty messages", async () => {
	const { protocolMessages } = await runManifest(
		[
			{
				category: "conversations",
				entries: [
					{
						name: "conversations.json",
						content: [{ uuid: "conv-empty", chat_messages: [] }],
					},
				],
			},
			{
				category: "light_metadata",
				entries: [{ name: "users.json", content: [] }],
			},
		],
		["messages"],
	);
	const proofs = protocolMessages.filter(
		(message) => message.type === "DETAIL_COVERAGE",
	);
	assert.equal(proofs.length, 1);
	assert.deepEqual(proofs[0], {
		type: "DETAIL_COVERAGE",
		stream: "messages",
		state_stream: "messages",
		reference_only: true,
		required_keys: [],
		hydrated_keys: [],
		considered: 0,
		covered: 0,
	});
});

type CoverageEvent = Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> & {
	considered: number;
	covered: number;
};

async function runCompletionExport(
	mode: "buffered" | "streaming" | "manifest",
	conversations: unknown,
	options: {
		scope?: {
			time_range?: { since?: string; until?: string };
			resources?: readonly string[];
			fields?: readonly string[];
		};
		recoveryOnly?: boolean;
		detailGaps?: BrowserCollectContext["detailGaps"];
		unknownEntry?: boolean;
		unknownNonJson?: boolean;
		wrongTotal?: boolean;
		partGap?: boolean;
		unknownPart?: boolean;
		missingPart?: boolean;
		pending?: boolean;
	} = {},
) {
	const entries = [{ name: "conversations.json", content: conversations }];
	if (options.unknownEntry) {
		entries.push({ name: "future.json", content: [] });
	}
	if (options.unknownNonJson) {
		entries.push({ name: "unknown.bin", content: [] });
	}
	const bytes = await buildManifestPartZip(entries);
	const context = makeContext({
		streams: ["conversations", "messages"],
		fetchStub:
			mode === "manifest"
				? manifestFetchStub([
						{ category: "conversations", token: "tok-c" },
						{ category: "light_metadata", token: "tok-u" },
						...(options.unknownPart
							? [{ category: "future", token: "tok-f" }]
							: []),
						...(options.missingPart
							? [{ category: "conversations", token: "tok-m" }]
							: []),
					])
				: oldFormatFetchStub({ exportRequests: 0 }),
	});
	if (options.wrongTotal || options.partGap) {
		const originalEvaluate = context.page.evaluate.bind(context.page);
		context.page.evaluate = async (fn, arg) => {
			const result = await originalEvaluate(fn, arg);
			if (
				typeof result === "object" &&
				result !== null &&
				"manifest" in result
			) {
				const { manifest } = result;
				if (
					typeof manifest === "object" &&
					manifest !== null &&
					"total_files" in manifest &&
					"data_files" in manifest
				) {
					if (options.wrongTotal) {
						manifest.total_files = 3;
					}
					if (options.partGap && Array.isArray(manifest.data_files)) {
						const [part] = manifest.data_files;
						if (typeof part === "object" && part !== null) {
							part.part = 1;
						}
					}
				}
			}
			return result;
		};
	}
	context.ctx.requested.set("messages", {
		name: "messages",
		...options.scope,
		...(options.scope?.resources
			? { resources: [...options.scope.resources] }
			: {}),
		...(options.scope?.fields ? { fields: [...options.scope.fields] } : {}),
	});
	if (options.recoveryOnly !== undefined) {
		context.ctx.recoveryOnly = options.recoveryOnly;
	}
	if (options.detailGaps) {
		context.ctx.detailGaps = options.detailGaps;
	}
	const runtime = makeEmitRecord({
		requested: context.ctx.requested,
		emit: context.ctx.emit,
		emittedAt: context.ctx.emittedAt,
		validateRecord,
		isTombstone: undefined,
		timeRangeFieldFor: consentTimeFieldResolver("anthropic"),
	});
	context.ctx.emitRecord = runtime.emit;
	context.ctx.isRecordSelected = runtime.isSelected;
	if (!options.pending) {
		if (mode === "manifest") {
			serveDownloads(
				context.page,
				new Map([
					["tok-c", bytes],
					["tok-f", bytes],
					[
						"tok-u",
						await buildManifestPartZip([{ name: "users.json", content: [] }]),
					],
				]),
			);
		} else {
			serveDownload(context.page, bytes);
		}
	}
	const texts = new Map(
		entries.map((entry) => [entry.name, JSON.stringify(entry.content)]),
	);
	await collectAnthropic({
		...context.ctx,
		...(mode === "streaming"
			? {
					readZipEntryChunk: (name: string, offset: number, length: number) =>
						Promise.resolve(
							texts.get(name)?.slice(offset, offset + length) ?? "",
						),
					entriesValidated: true,
				}
			: {}),
	});
	const records = context.protocolMessages.filter(
		(message): message is Extract<EmittedMessage, { type: "RECORD" }> =>
			message.type === "RECORD" && message.stream === "messages",
	);
	// Messages evidence only: the conversations stream is also requested here
	// and has its own coverage message, asserted in the full-stream tests.
	const proofs = context.protocolMessages.filter(
		(message): message is CoverageEvent =>
			message.type === "DETAIL_COVERAGE" && message.stream === "messages",
	);
	return { ...context, records, proofs };
}

for (const mode of ["buffered", "streaming", "manifest"] as const) {
	for (const empty of [[], [{ uuid: "conv-empty", chat_messages: [] }]]) {
		test(`collectAnthropic: completion evidence ${mode} recognizes empty boundary ${empty.length}`, async () => {
			const { records, proofs } = await runCompletionExport(mode, empty);
			assert.equal(records.length, 0);
			assert.equal(proofs.length, 1);
			assert.deepEqual(proofs[0], {
				type: "DETAIL_COVERAGE",
				stream: "messages",
				state_stream: "messages",
				reference_only: true,
				required_keys: [],
				hydrated_keys: [],
				considered: 0,
				covered: 0,
			});
		});
	}
	test(`collectAnthropic: completion evidence ${mode} measures delivery after the last message`, async () => {
		const message = CONVERSATIONS_JSON[0]?.chat_messages[0];
		assert.ok(message);
		const { records, proofs, protocolMessages } = await runCompletionExport(
			mode,
			[
				{
					uuid: "conv-1",
					chat_messages: [
						{ ...message, uuid: "second", created_at: "2026-01-02T00:00:00Z" },
						{ ...message, uuid: "first", created_at: "2026-01-01T00:00:00Z" },
					],
				},
			],
		);
		assert.deepEqual(
			records.map((record) => record.key),
			["first", "second"],
		);
		assert.equal(proofs.length, 1);
		assert.equal(proofs[0]?.considered, 2);
		assert.equal(proofs[0]?.covered, 2);
		assert.ok(proofs[0]);
		assert.ok(records[1]);
		assert.ok(
			protocolMessages.indexOf(proofs[0]) >
				protocolMessages.indexOf(records[1]),
		);
	});
	for (const [label, conversations] of [
		["missing child list", [{ uuid: "conv-1" }]],
		["non-array child list", [{ uuid: "conv-1", chat_messages: null }]],
		[
			"malformed child",
			[{ uuid: "conv-1", chat_messages: [null, { text: "no identity" }] }],
		],
		[
			"duplicate message identities",
			[{ uuid: "conv-1", chat_messages: [{ uuid: "same" }, { uuid: "same" }] }],
		],
		[
			"duplicate parent identities",
			[
				{ uuid: "same", chat_messages: [] },
				{ uuid: "same", chat_messages: [] },
			],
		],
		["missing parent identity", [{ chat_messages: [{ uuid: "msg-1" }] }]],
		[
			"runtime schema rejection",
			[
				{
					uuid: "conv-1",
					chat_messages: [{ uuid: "valid-id", sender: "x".repeat(65) }],
				},
			],
		],
	] as const) {
		test(`collectAnthropic: completion evidence ${mode} refuses ${label}`, async () => {
			const { proofs } = await runCompletionExport(mode, conversations);
			assert.equal(proofs.length, 0);
		});
	}
	for (const [label, options] of [
		[
			"since window",
			{ scope: { time_range: { since: "2025-01-01T00:00:00Z" } } },
		],
		[
			"until window",
			{ scope: { time_range: { until: "2027-01-01T00:00:00Z" } } },
		],
		["resource selection", { scope: { resources: ["absent"] } }],
		["field selection", { scope: { fields: ["id"] } }],
		["recovery-only enumeration", { recoveryOnly: true }],
		["pending export", { pending: true }],
	] as const) {
		test(`collectAnthropic: completion evidence ${mode} refuses ${label}`, async () => {
			const { proofs } = await runCompletionExport(
				mode,
				CONVERSATIONS_JSON,
				options,
			);
			assert.equal(proofs.length, 0);
		});
	}
}

for (const [label, options] of [
	["unknown category", { unknownPart: true }],
	["missing manifest download", { missingPart: true }],
	["wrong total files", { wrongTotal: true }],
	["missing declared part index", { partGap: true }],
	["unknown non-JSON entry", { unknownNonJson: true }],
] as const) {
	test(`collectAnthropic: completion evidence manifest refuses ${label}`, async () => {
		const { proofs } = await runCompletionExport(
			"manifest",
			CONVERSATIONS_JSON,
			options,
		);
		assert.equal(proofs.length, 0);
	});
}
for (const mode of ["buffered", "streaming"] as const) {
	test(`collectAnthropic: completion evidence ${mode} refuses unknown archive entry`, async () => {
		const { proofs } = await runCompletionExport(mode, CONVERSATIONS_JSON, {
			unknownEntry: true,
		});
		assert.equal(proofs.length, 0);
	});
	test(`collectAnthropic: completion evidence ${mode} still proves messages beside an oversized parent`, async () => {
		const { proofs, records } = await runCompletionExport(mode, [
			{
				uuid: "huge",
				name: "x".repeat(33_554_432),
				chat_messages: [{ uuid: "child" }],
			},
		]);
		assert.deepEqual(
			records.map((record) => record.data.id),
			["child"],
		);
		assert.equal(proofs.length, 1);
		assert.equal(proofs[0]?.considered, 1);
		assert.equal(proofs[0]?.covered, 1);
	});
}

// Regression cases from independent review; all inputs are synthetic.
for (const mode of ["buffered", "streaming", "manifest"] as const) {
	test(`completion boundary: corrupt second ZIP directory entry ${mode}`, async () => {
		const entries = [
			{ name: "conversations.json", content: [] },
			{
				name: "unrecognized.json",
				content: [{ uuid: "lost", chat_messages: [{ uuid: "lost-message" }] }],
			},
		];
		const bytes = await buildManifestPartZip(entries);
		const directoryOffset = bytes.readUInt32LE(bytes.length - 6);
		const second =
			directoryOffset +
			46 +
			bytes.readUInt16LE(directoryOffset + 28) +
			bytes.readUInt16LE(directoryOffset + 30) +
			bytes.readUInt16LE(directoryOffset + 32);
		assert.equal(bytes.readUInt32LE(second), 0x02_01_4b_50);
		bytes.writeUInt32LE(0, second);
		const context = makeContext({
			streams: ["conversations", "messages"],
			fetchStub:
				mode === "manifest"
					? manifestFetchStub([
							{ category: "conversations", token: "review-part" },
							{ category: "light_metadata", token: "review-meta" },
						])
					: oldFormatFetchStub({ exportRequests: 0 }),
		});
		const runtime = makeEmitRecord({
			requested: context.ctx.requested,
			emit: context.ctx.emit,
			emittedAt: context.ctx.emittedAt,
			validateRecord,
			isTombstone: undefined,
			timeRangeFieldFor: consentTimeFieldResolver("anthropic"),
		});
		context.ctx.emitRecord = runtime.emit;
		context.ctx.isRecordSelected = runtime.isSelected;
		if (mode === "manifest") {
			serveDownloads(
				context.page,
				new Map([
					["review-part", bytes],
					[
						"review-meta",
						await buildManifestPartZip([{ name: "users.json", content: [] }]),
					],
				]),
			);
		} else {
			serveDownload(context.page, bytes);
		}
		await collectAnthropic({
			...context.ctx,
			...(mode === "streaming"
				? {
						readZipEntryChunk: (
							_name: string,
							offset: number,
							length: number,
						) => Promise.resolve("[]".slice(offset, offset + length)),
						entriesValidated: true,
					}
				: {}),
		});
		const proofs = context.protocolMessages.filter(
			(m) => m.type === "DETAIL_COVERAGE",
		);
		assert.equal(
			proofs.length,
			0,
			"Incomplete central directory cannot prove full source boundary",
		);
	});
}
test("completion boundary: malformed child list before manifest classification", async () => {
	const { proofs } = await runCompletionExport("manifest", [
		{ uuid: "known-empty", chat_messages: [] },
		{ uuid: "ambiguous-parent", chat_messages: null, docs: [] },
	]);
	assert.equal(
		proofs.length,
		0,
		"Non-array raw chat_messages must withhold proof even if classified as project",
	);
});

test("completion boundary: project shape in a conversations part cannot hide a missing messages list", async () => {
	const { proofs, protocolMessages } = await runCompletionExport("manifest", [
		{ uuid: "known-empty", chat_messages: [] },
		{ uuid: "actual-project", docs: [] },
	]);
	assert.equal(proofs.length, 0);
	const skip = skipsOf(protocolMessages).find((s) => s.stream === "messages");
	assert.equal(skip?.reason, "export_conversation_incomplete");
	assert.equal(
		(skip?.diagnostics as Record<string, unknown>)?.conversation_id,
		"actual-project",
	);
	assert.equal(
		protocolMessages.some(
			(message) =>
				message.type === "STATE" &&
				message.stream === "messages" &&
				"synced_at" in (message.cursor as Record<string, unknown>),
		),
		false,
	);
});
test("completion control: malformed conversation without competing project shape withholds proof", async () => {
	const { proofs } = await runCompletionExport("manifest", [
		{ uuid: "known-empty", chat_messages: [] },
		{ uuid: "bad-parent", chat_messages: null },
	]);
	assert.equal(proofs.length, 0);
});
for (const mode of ["buffered", "streaming", "manifest"] as const) {
	test(`completion control: intact two-entry ZIP ${mode}`, async () => {
		const entries = [
			{ name: "conversations.json", content: [] },
			{
				name: "unrecognized.json",
				content: [{ uuid: "lost", chat_messages: [{ uuid: "lost-message" }] }],
			},
		];
		const bytes = await buildManifestPartZip(entries);
		const context = makeContext({
			streams: ["conversations", "messages"],
			fetchStub:
				mode === "manifest"
					? manifestFetchStub([
							{ category: "conversations", token: "review-part" },
							{ category: "light_metadata", token: "review-meta" },
						])
					: oldFormatFetchStub({ exportRequests: 0 }),
		});
		const runtime = makeEmitRecord({
			requested: context.ctx.requested,
			emit: context.ctx.emit,
			emittedAt: context.ctx.emittedAt,
			validateRecord,
			isTombstone: undefined,
			timeRangeFieldFor: consentTimeFieldResolver("anthropic"),
		});
		context.ctx.emitRecord = runtime.emit;
		context.ctx.isRecordSelected = runtime.isSelected;
		if (mode === "manifest") {
			serveDownloads(
				context.page,
				new Map([
					["review-part", bytes],
					[
						"review-meta",
						await buildManifestPartZip([{ name: "users.json", content: [] }]),
					],
				]),
			);
		} else {
			serveDownload(context.page, bytes);
		}
		await collectAnthropic({
			...context.ctx,
			...(mode === "streaming"
				? {
						readZipEntryChunk: (
							_name: string,
							offset: number,
							length: number,
						) => Promise.resolve("[]".slice(offset, offset + length)),
						entriesValidated: true,
					}
				: {}),
		});
		// Messages evidence only; conversations has its own coverage message.
		const proofs = context.protocolMessages.filter(
			(m): m is CoverageEvent =>
				m.type === "DETAIL_COVERAGE" && m.stream === "messages",
		);
		assert.equal(proofs.length, mode === "manifest" ? 1 : 0);
		if (mode === "manifest") {
			assert.equal(proofs[0]?.considered, 1);
		}
	});
}

for (const mode of ["buffered", "streaming", "manifest"] as const) {
	for (const [label, options] of [
		["empty resource selector", { scope: { resources: [] } }],
		["empty field selector", { scope: { fields: [] } }],
		["empty time selector", { scope: { time_range: {} } }],
		[
			"supplied detail gap",
			{
				detailGaps: [
					{ gap_id: "pending-gap", stream: "messages", status: "pending" },
				],
			},
		],
	] as const) {
		test(`completion boundary: ${mode} refuses ${label}`, async () => {
			const { proofs } = await runCompletionExport(mode, [], options);
			assert.equal(proofs.length, 0);
		});
	}
}

// ─── Full-stream completion evidence (profile, conversations, projects, documents)

type FullMode = "buffered" | "streaming" | "manifest";
const OWNER_MENU = ["Browser Owner", "Pro plan"];
const FULL_PROJECT = {
	uuid: "proj-1",
	name: "Test project",
	created_at: "2026-01-01T00:00:00.000Z",
	docs: [
		{ uuid: "doc-1", filename: "a.md", content: "a" },
		{ uuid: "doc-2", filename: "b.md", content: "b" },
	],
};

async function runFullCompletion(
	mode: FullMode,
	input: {
		conversations?: unknown;
		projects?: unknown[];
		users?: unknown;
		explicitEmptyProjectsPart?: boolean;
		streams?: string[];
		scope?: Record<string, Record<string, unknown>>;
		testOverrides?: AnthropicTestOverrides;
		recoveryOnly?: boolean;
		detailGaps?: BrowserCollectContext["detailGaps"];
		unknownEntry?: boolean;
		skipUsers?: boolean;
		/** Manifest mode: replace the generated parts with these exact ones. */
		partitions?: Array<{
			category: string;
			part: number;
			entries: Array<{ name: string; content: unknown }>;
		}>;
		/** Manifest mode: override the declared file count to test inventory integrity. */
		manifestTotalFiles?: number;
		/** Awaited before each RECORD reaches the sink; may defer or reject. */
		recordGate?: (
			message: EmittedMessage,
			protocolMessages: readonly EmittedMessage[],
		) => Promise<void>;
	} = {},
) {
	// An explicitly supplied null/undefined is a malformed raw input, not a
	// request for the default fixture.
	const conversations =
		"conversations" in input ? input.conversations : CONVERSATIONS_JSON;
	const projects = input.projects ?? [FULL_PROJECT];
	const users =
		"users" in input ? input.users : [{ full_name: "Browser Owner" }];
	const streams = input.streams ?? [
		"account_profile",
		"conversations",
		"projects",
		"project_documents",
	];
	const flat: Array<{ name: string; content: unknown }> = [
		{ name: "conversations.json", content: conversations },
		...(input.skipUsers ? [] : [{ name: "users.json", content: users }]),
		...projects.map((content, index) => ({
			name: `projects/p${index}.json`,
			content,
		})),
		...(input.unknownEntry ? [{ name: "future.json", content: [] }] : []),
	];
	const generatedParts: Array<{
		category: string;
		part?: number;
		entries: Array<{ name: string; content: unknown }>;
	}> = [
		{
			category: "conversations",
			entries: [{ name: "conversations.json", content: conversations }],
		},
		...(projects.length > 0
			? [
					{
						category: "projects",
						entries: projects.map((content, index) => ({
							name: `projects/p${index}.json`,
							content,
						})),
					},
				]
			: input.explicitEmptyProjectsPart
				? [
						{
							category: "projects",
							entries: [{ name: "projects.json", content: [] }],
						},
					]
				: []),
		...(input.skipUsers
			? []
			: [
					{
						category: "light_metadata",
						entries: [{ name: "users.json", content: users }],
					},
				]),
	];
	const parts = input.partitions ?? generatedParts;
	const tokens = parts.map((part, index) => ({
		category: part.category,
		token: `tok-${index}`,
		...("part" in part && part.part !== undefined ? { part: part.part } : {}),
	}));
	const context = makeContext({
		streams,
		...(input.testOverrides ? { testOverrides: input.testOverrides } : {}),
		fetchStub:
			mode === "manifest"
				? manifestFetchStub(tokens, input.manifestTotalFiles)
				: oldFormatFetchStub({ exportRequests: 0 }),
	});
	context.page.menuSpans = OWNER_MENU;
	for (const [stream, scope] of Object.entries(input.scope ?? {})) {
		context.ctx.requested.set(stream, { name: stream, ...scope });
	}
	if (input.recoveryOnly !== undefined)
		context.ctx.recoveryOnly = input.recoveryOnly;
	if (input.detailGaps) context.ctx.detailGaps = input.detailGaps;
	const gate = input.recordGate;
	const runtime = makeEmitRecord({
		requested: context.ctx.requested,
		emit: gate
			? async (message) => {
					if (message.type === "RECORD")
						await gate(message, context.protocolMessages);
					return context.ctx.emit(message);
				}
			: context.ctx.emit,
		emittedAt: context.ctx.emittedAt,
		validateRecord,
		isTombstone: undefined,
		timeRangeFieldFor: consentTimeFieldResolver("anthropic"),
	});
	context.ctx.emitRecord = runtime.emit;
	context.ctx.isRecordSelected = runtime.isSelected;
	if (mode === "manifest") {
		const zips = await Promise.all(
			parts.map((part) => buildManifestPartZip(part.entries)),
		);
		serveDownloads(
			context.page,
			new Map(zips.map((bytes, index) => [`tok-${index}`, bytes])),
		);
	} else {
		serveDownload(context.page, await buildManifestPartZip(flat));
	}
	const texts = new Map(
		flat.map((entry) => [entry.name, JSON.stringify(entry.content)]),
	);
	await collectAnthropic({
		...context.ctx,
		...(mode === "streaming"
			? {
					readZipEntryChunk: (name: string, offset: number, length: number) =>
						Promise.resolve(
							texts.get(name)?.slice(offset, offset + length) ?? "",
						),
					entriesValidated: true,
				}
			: {}),
	});
	const proofs = context.protocolMessages.filter(
		(
			message,
		): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE",
	);
	const proofFor = (stream: string) =>
		proofs.filter((proof) => proof.stream === stream);
	const recordsOf = (stream: string) =>
		context.protocolMessages.filter(
			(message): message is Extract<EmittedMessage, { type: "RECORD" }> =>
				message.type === "RECORD" && message.stream === stream,
		);
	return { ...context, proofs, proofFor, recordsOf };
}

function assertSelfMapped(
	run: Awaited<ReturnType<typeof runFullCompletion>>,
	stream: string,
	count: number,
) {
	const proofs = run.proofFor(stream);
	assert.equal(proofs.length, 1, `${stream} has exactly one final report`);
	const [proof] = proofs;
	assert.ok(proof);
	assert.equal(proof.considered, count);
	assert.equal(proof.covered, count);
	assert.equal(proof.state_stream, stream);
	assert.equal(run.recordsOf(stream).length, count);
	// The report follows the stream's last record.
	const lastRecord = run.recordsOf(stream).at(-1);
	if (lastRecord)
		assert.ok(
			run.protocolMessages.indexOf(proof) >
				run.protocolMessages.indexOf(lastRecord),
		);
}

for (const mode of ["buffered", "streaming", "manifest"] as const) {
	test(`full completion ${mode}: every stream proves its measured whole boundary`, async () => {
		const run = await runFullCompletion(mode);
		assertSelfMapped(run, "conversations", 1);
		assertSelfMapped(run, "projects", 1);
		assertSelfMapped(run, "project_documents", 2);
		assert.equal(run.proofFor("account_profile").length, 0);
		assert.equal(run.proofs.length, 3);
		// The profile RECORD itself is unchanged by withholding its completion.
		assert.equal(run.recordsOf("account_profile").length, 1);
	});
	test(`full completion ${mode}: explicit empty document lists prove zero documents`, async () => {
		const run = await runFullCompletion(mode, {
			projects: [{ ...FULL_PROJECT, docs: [] }],
		});
		assertSelfMapped(run, "projects", 1);
		assertSelfMapped(run, "project_documents", 0);
	});
	for (const [label, docs] of [
		["missing", undefined],
		["null", null],
		["object", {}],
	] as const) {
		test(`full completion ${mode}: ${label} document list gives no documents proof`, async () => {
			const project: Record<string, unknown> = { ...FULL_PROJECT };
			if (docs === undefined) {
				delete project.docs;
				project.archived_at = null;
			} else project.docs = docs;
			const run = await runFullCompletion(mode, { projects: [project] });
			assert.equal(run.proofFor("project_documents").length, 0);
			assertSelfMapped(run, "projects", 1);
		});
	}
	test(`full completion ${mode}: unknown document child blocks only documents`, async () => {
		const run = await runFullCompletion(mode, {
			projects: [{ ...FULL_PROJECT, docs: [{ uuid: "doc-1" }, { name: "x" }] }],
		});
		assert.equal(run.proofFor("project_documents").length, 0);
		assertSelfMapped(run, "projects", 1);
	});
	test(`full completion ${mode}: duplicate document identities give no documents proof`, async () => {
		const run = await runFullCompletion(mode, {
			projects: [{ ...FULL_PROJECT, docs: [{ uuid: "d" }, { uuid: "d" }] }],
		});
		assert.equal(run.proofFor("project_documents").length, 0);
	});
	test(`full completion ${mode}: duplicate project identities give no project proof`, async () => {
		const run = await runFullCompletion(mode, {
			projects: [FULL_PROJECT, { ...FULL_PROJECT, name: "again" }],
		});
		assert.equal(run.proofFor("projects").length, 0);
		assert.equal(run.proofFor("project_documents").length, 0);
	});
	test(`full completion ${mode}: duplicate conversation identities give no conversation proof`, async () => {
		const run = await runFullCompletion(mode, {
			conversations: [...CONVERSATIONS_JSON, ...CONVERSATIONS_JSON],
		});
		assert.equal(run.proofFor("conversations").length, 0);
	});
	test(`full completion ${mode}: conversation without identity gives no conversation proof`, async () => {
		const run = await runFullCompletion(mode, {
			conversations: [{ name: "no id", chat_messages: [] }],
		});
		assert.equal(run.proofFor("conversations").length, 0);
	});
	test(`full completion ${mode}: project that is also a conversation is ambiguous`, async () => {
		const run = await runFullCompletion(mode, {
			projects: [{ ...FULL_PROJECT, chat_messages: [] }],
		});
		assert.equal(run.proofFor("projects").length, 0);
		assert.equal(run.proofFor("project_documents").length, 0);
	});
	for (const [label, options] of [
		[
			"since window",
			{
				scope: {
					conversations: { time_range: { since: "2025-01-01T00:00:00Z" } },
				},
			},
		],
		[
			"resource selection",
			{ scope: { conversations: { resources: ["absent"] } } },
		],
		["field selection", { scope: { conversations: { fields: ["id"] } } }],
		["recovery-only", { recoveryOnly: true }],
		[
			"pending detail gap",
			{ detailGaps: [{ stream: "conversations", key: "conv-1" }] },
		],
	] as const) {
		test(`full completion ${mode}: ${label} withholds conversation proof`, async () => {
			const run = await runFullCompletion(mode, options as never);
			assert.equal(run.proofFor("conversations").length, 0);
		});
	}
	test(`full completion ${mode}: a restricted projects stream withholds projects and documents`, async () => {
		const run = await runFullCompletion(mode, {
			scope: { projects: { resources: ["absent"] } },
		});
		assert.equal(run.proofFor("projects").length, 0);
		assert.equal(run.proofFor("project_documents").length, 0);
		assertSelfMapped(run, "conversations", 1);
	});
	test(`full completion ${mode}: documents never prove without their parent stream`, async () => {
		const run = await runFullCompletion(mode, {
			streams: ["project_documents"],
		});
		assert.equal(run.proofs.length, 0);
	});
	for (const [label, users] of [
		[
			"ambiguous roster",
			[{ full_name: "Browser Owner" }, { full_name: "Other" }],
		],
		["owner mismatch", [{ full_name: "Someone Else" }]],
		["malformed identity", [{}]],
	] as const) {
		test(`full completion ${mode}: ${label} gives no account_profile proof`, async () => {
			const run = await runFullCompletion(mode, { users });
			assert.equal(run.proofFor("account_profile").length, 0);
		});
	}
	test(`full completion ${mode}: missing users data gives no account_profile proof and no fake empty report`, async () => {
		const run = await runFullCompletion(mode, { skipUsers: true });
		assert.equal(run.proofFor("account_profile").length, 0);
	});
}

for (const mode of ["buffered", "streaming"] as const) {
	test(`full completion ${mode}: an unknown archive entry withholds every proof`, async () => {
		const run = await runFullCompletion(mode, { unknownEntry: true });
		assert.equal(run.proofs.length, 0);
	});
	test(`full completion ${mode}: projects absent without an explicit boundary is not a proven empty`, async () => {
		const run = await runFullCompletion(mode, { projects: [] });
		assert.equal(run.proofFor("projects").length, 0);
		assert.equal(run.proofFor("project_documents").length, 0);
		assertSelfMapped(run, "conversations", 1);
	});
}

test("full completion manifest: an explicit empty projects part proves empty projects and documents", async () => {
	const run = await runFullCompletion("manifest", {
		projects: [],
		explicitEmptyProjectsPart: true,
	});
	assertSelfMapped(run, "projects", 0);
	assertSelfMapped(run, "project_documents", 0);
});

test("full completion manifest: absent projects part is not a proven empty", async () => {
	const run = await runFullCompletion("manifest", { projects: [] });
	assert.equal(run.proofFor("projects").length, 0);
	assert.equal(run.proofFor("project_documents").length, 0);
});

test("full completion: messages evidence keeps its guarantees beside the other streams", async () => {
	const run = await runFullCompletion("manifest", {
		streams: ["conversations", "messages"],
	});
	assertSelfMapped(run, "messages", 1);
	assertSelfMapped(run, "conversations", 1);
	const malformed = await runFullCompletion("manifest", {
		streams: ["conversations", "messages"],
		conversations: [{ uuid: "conv-1", chat_messages: null }],
	});
	assert.equal(malformed.proofFor("messages").length, 0);
	assert.equal(malformed.proofFor("conversations").length, 0);
});

// ─── Review R1/R2 counterexamples: profile identity and partition identity

const ALL_PLUS_MESSAGES = [
	"account_profile",
	"conversations",
	"messages",
	"projects",
	"project_documents",
];
const FINAL_RECORD_COUNTS = {
	conversations: 1,
	messages: 1,
	projects: 1,
	project_documents: 2,
} as const;

for (const mode of ["buffered", "streaming", "manifest"] as const) {
	for (const [label, users] of [
		["a roster with no raw identity", [{ full_name: "Browser Owner" }]],
		[
			"a same-name roster entry for another identity",
			[{ uuid: "someone-else", full_name: "Browser Owner" }],
		],
		[
			"a raw user id that no export field ties to the requested organization",
			[{ uuid: "user-1", full_name: "Browser Owner" }],
		],
		[
			"an explicit null users wrapper beside a top-level name",
			{ users: null, full_name: "Browser Owner" },
		],
		[
			"a non-array users wrapper beside a top-level name",
			{ users: "Browser Owner", full_name: "Browser Owner" },
		],
	] as const) {
		test(`full completion ${mode}: ${label} withholds account_profile completion on every stream`, async () => {
			const run = await runFullCompletion(mode, {
				users,
				streams: ALL_PLUS_MESSAGES,
			});
			assert.equal(run.proofFor("account_profile").length, 0);
			// Old record behavior is preserved: the profile record is still delivered.
			const [record] = run.recordsOf("account_profile");
			assert.equal(record?.data.full_name, "Browser Owner");
			assert.equal(record?.data.metadata_status, "valid");
			// The other streams keep their own measured proofs.
			assertSelfMapped(run, "conversations", 1);
			assertSelfMapped(run, "messages", 1);
			assertSelfMapped(run, "projects", 1);
			assertSelfMapped(run, "project_documents", 2);
			assert.equal(run.proofs.length, 4);
		});
	}
	for (const [label, options] of [
		["null conversations file", { conversations: null }],
		["object conversations file", { conversations: {} }],
		["string conversations file", { conversations: "[]" }],
	] as const) {
		test(`full completion ${mode}: ${label} gives no conversation or message proof`, async () => {
			const run = await runFullCompletion(mode, {
				...options,
				streams: ALL_PLUS_MESSAGES,
			});
			assert.equal(run.proofFor("conversations").length, 0);
			assert.equal(run.proofFor("messages").length, 0);
			assert.equal(run.proofFor("account_profile").length, 0);
		});
	}
	for (const [label, users] of [
		["null users file", null],
		["string users file", "Browser Owner"],
		["numeric users file", 7],
	] as const) {
		test(`full completion ${mode}: ${label} gives no account_profile proof`, async () => {
			const run = await runFullCompletion(mode, {
				users,
				streams: ALL_PLUS_MESSAGES,
			});
			assert.equal(run.proofFor("account_profile").length, 0);
		});
	}
	test(`full completion ${mode}: a null project file gives no projects proof`, async () => {
		const run = await runFullCompletion(mode, {
			projects: [null],
			streams: ALL_PLUS_MESSAGES,
		});
		assert.equal(run.proofFor("projects").length, 0);
		assert.equal(run.proofFor("project_documents").length, 0);
	});

	for (const stream of Object.keys(FINAL_RECORD_COUNTS) as Array<
		keyof typeof FINAL_RECORD_COUNTS
	>) {
		test(`full completion ${mode}: ${stream} proof waits for the final RECORD to be accepted`, async () => {
			let seen = 0;
			let proofsWhenFinalRecordHeld = -1;
			const run = await runFullCompletion(mode, {
				streams: ALL_PLUS_MESSAGES,
				recordGate: async (message, protocolMessages) => {
					if (message.type !== "RECORD" || message.stream !== stream) return;
					seen += 1;
					if (seen !== FINAL_RECORD_COUNTS[stream]) return;
					await new Promise((resolve) => setTimeout(resolve, 5));
					proofsWhenFinalRecordHeld = protocolMessages.filter(
						(m) => m.type === "DETAIL_COVERAGE" && m.stream === stream,
					).length;
				},
			});
			assert.equal(seen, FINAL_RECORD_COUNTS[stream]);
			assert.equal(proofsWhenFinalRecordHeld, 0);
			assertSelfMapped(run, stream, FINAL_RECORD_COUNTS[stream]);
		});
		test(`full completion ${mode}: ${stream} proof is withheld when the final RECORD is rejected`, async () => {
			let seen = 0;
			let observed: readonly EmittedMessage[] = [];
			await assert.rejects(
				runFullCompletion(mode, {
					streams: ALL_PLUS_MESSAGES,
					recordGate: async (message, protocolMessages) => {
						observed = protocolMessages;
						if (message.type !== "RECORD" || message.stream !== stream) return;
						seen += 1;
						if (seen === FINAL_RECORD_COUNTS[stream]) {
							await new Promise((resolve) => setTimeout(resolve, 1));
							throw new Error("sink rejected final record");
						}
					},
				}),
				/sink rejected final record/,
			);
			assert.equal(
				observed.filter(
					(m) => m.type === "DETAIL_COVERAGE" && m.stream === stream,
				).length,
				0,
			);
		});
	}
}

// Manifest partition identity: proof requires category-local parts from 0.
const CONV_ENTRY = [
	{ name: "conversations.json", content: CONVERSATIONS_JSON },
];
const projectEntry = (index: number, project: unknown = FULL_PROJECT) => [
	{ name: `projects/p${index}.json`, content: project },
];
const OWNER_USERS = [
	{ name: "users.json", content: [{ full_name: "Browser Owner" }] },
];
const conversationsPart = (part = 0) => ({
	category: "conversations",
	part,
	entries: CONV_ENTRY,
});

async function runPartitions(
	partitions: Array<{
		category: string;
		part: number;
		entries: Array<{ name: string; content: unknown }>;
	}>,
) {
	return runFullCompletion("manifest", {
		partitions,
		streams: ALL_PLUS_MESSAGES,
	});
}

function assertNoProofs(run: Awaited<ReturnType<typeof runPartitions>>) {
	assert.deepEqual(
		run.proofs.map((proof) => proof.stream),
		[],
	);
}

function assertStreamsSkipped(
	run: Awaited<ReturnType<typeof runPartitions>>,
	streams: string[],
) {
	for (const stream of streams) {
		const skips = skipsOf(run.protocolMessages).filter(
			(skip) => skip.stream === stream,
		);
		assert.equal(skips.length, 1, `${stream} has one SKIP_RESULT`);
		assert.equal(run.proofFor(stream).length, 0, `${stream} has no coverage`);
		assertNoSyncedAt(run.protocolMessages, [stream]);
	}
}

const ARCHIVE_STREAMS = [
	"account_profile",
	"conversations",
	"messages",
	"projects",
	"project_documents",
];

const COMPLETE_PROJECTS_PART = {
	category: "projects",
	part: 0,
	entries: projectEntry(0),
};
const COMPLETE_METADATA_PART = {
	category: "light_metadata",
	part: 0,
	entries: OWNER_USERS,
};

test("manifest partitions: a conversations gap skips conversations and messages while complete projects still prove", async () => {
	const run = await runPartitions([
		conversationsPart(1),
		COMPLETE_PROJECTS_PART,
		COMPLETE_METADATA_PART,
	]);
	assertStreamsSkipped(run, ["conversations", "messages"]);
	assertSelfMapped(run, "projects", 1);
	assertSelfMapped(run, "project_documents", 2);
});

test("manifest inventory count mismatch skips every content stream instead of only withholding coverage", async () => {
	const run = await runFullCompletion("manifest", {
		partitions: [
			conversationsPart(),
			COMPLETE_PROJECTS_PART,
			COMPLETE_METADATA_PART,
		],
		manifestTotalFiles: 4,
		streams: ALL_PLUS_MESSAGES,
	});
	assertStreamsSkipped(run, ARCHIVE_STREAMS);
});

test("manifest partitions: a lone projects part 1 holding [] does not prove empty projects or documents", async () => {
	const run = await runPartitions([
		conversationsPart(),
		{
			category: "projects",
			part: 1,
			entries: [{ name: "projects.json", content: [] }],
		},
		COMPLETE_METADATA_PART,
	]);
	assertStreamsSkipped(run, ["projects", "project_documents"]);
	assertSelfMapped(run, "conversations", 1);
	assertSelfMapped(run, "messages", 1);
});
test("manifest partitions: a missing projects part 0 withholds proofs even beside a valid part 1", async () => {
	const run = await runPartitions([
		conversationsPart(),
		{ category: "projects", part: 1, entries: projectEntry(0) },
		COMPLETE_METADATA_PART,
	]);
	assertStreamsSkipped(run, ["projects", "project_documents"]);
	assertSelfMapped(run, "conversations", 1);
	assertSelfMapped(run, "messages", 1);
});
test("manifest partitions: two distinct projects files both labelled part 0 withhold proofs", async () => {
	const run = await runPartitions([
		conversationsPart(),
		{ category: "projects", part: 0, entries: projectEntry(0) },
		{
			category: "projects",
			part: 0,
			entries: projectEntry(1, {
				uuid: "proj-2",
				name: "Other",
				docs: [{ uuid: "doc-9", filename: "z.md", content: "z" }],
			}),
		},
		COMPLETE_METADATA_PART,
	]);
	assertStreamsSkipped(run, ["projects", "project_documents"]);
	assertSelfMapped(run, "conversations", 1);
	assertSelfMapped(run, "messages", 1);
});
test("manifest partitions: a projects gap (0 and 2) withholds proofs", async () => {
	const run = await runPartitions([
		conversationsPart(),
		{ category: "projects", part: 0, entries: projectEntry(0) },
		{
			category: "projects",
			part: 2,
			entries: projectEntry(1, { uuid: "proj-2", docs: [] }),
		},
		COMPLETE_METADATA_PART,
	]);
	assertStreamsSkipped(run, ["projects", "project_documents"]);
	assertSelfMapped(run, "conversations", 1);
	assertSelfMapped(run, "messages", 1);
});
test("manifest partitions: light_metadata part 1 without part 0 gives no profile or other proof", async () => {
	const run = await runPartitions([
		conversationsPart(),
		{ category: "projects", part: 0, entries: projectEntry(0) },
		{ category: "light_metadata", part: 1, entries: OWNER_USERS },
	]);
	assertStreamsSkipped(run, ARCHIVE_STREAMS);
});
test("manifest partitions: duplicate light_metadata part 0 withholds proofs", async () => {
	const run = await runPartitions([
		conversationsPart(),
		{ category: "projects", part: 0, entries: projectEntry(0) },
		{ category: "light_metadata", part: 0, entries: OWNER_USERS },
		{
			category: "light_metadata",
			part: 0,
			entries: [
				{ name: "users.json", content: [{ full_name: "Browser Owner" }] },
			],
		},
	]);
	assertStreamsSkipped(run, ARCHIVE_STREAMS);
});
test("manifest partitions: duplicate or missing conversations parts still withhold proofs", async () => {
	for (const conversations of [
		[conversationsPart(0), conversationsPart(0)],
		[conversationsPart(1)],
	]) {
		const run = await runPartitions([
			...conversations,
			COMPLETE_PROJECTS_PART,
			COMPLETE_METADATA_PART,
		]);
		assertStreamsSkipped(run, ["conversations", "messages"]);
		assertSelfMapped(run, "projects", 1);
		assertSelfMapped(run, "project_documents", 2);
	}
});
test("manifest partitions: contiguous multi-part projects from 0 keep their proofs", async () => {
	const run = await runPartitions([
		conversationsPart(),
		{ category: "projects", part: 0, entries: projectEntry(0) },
		{
			category: "projects",
			part: 1,
			entries: projectEntry(1, {
				uuid: "proj-2",
				name: "Second",
				docs: [{ uuid: "doc-9", filename: "z.md", content: "z" }],
			}),
		},
		{ category: "light_metadata", part: 0, entries: OWNER_USERS },
	]);
	assertSelfMapped(run, "conversations", 1);
	assertSelfMapped(run, "projects", 2);
	assertSelfMapped(run, "project_documents", 3);
	assertSelfMapped(run, "messages", 1);
});

// A missing category is unknown, and cross-classified records are delivery only.
test("manifest category boundary: absent projects with a cross-classified project cannot prove projects or empty documents", async () => {
	const run = await runPartitions([
		{
			category: "conversations",
			part: 0,
			entries: [
				{
					name: "conversations.json",
					content: [
						{ uuid: "c1", chat_messages: [] },
						{ uuid: "p1", name: "P", docs: [] },
					],
				},
			],
		},
		{ category: "light_metadata", part: 0, entries: OWNER_USERS },
	]);
	assert.equal(run.recordsOf("conversations").length, 1);
	assert.equal(run.recordsOf("projects").length, 1);
	assert.equal(run.recordsOf("project_documents").length, 0);
	assert.equal(run.proofFor("projects").length, 0);
	assert.equal(run.proofFor("project_documents").length, 0);
	assert.equal(run.proofFor("account_profile").length, 0);
	// A project shape in this category still has an omitted conversation list.
	assert.equal(run.proofFor("conversations").length, 0);
	assert.equal(run.proofFor("messages").length, 0);
	assert.equal(run.recordsOf("conversations").length, 1);
	assert.equal(run.recordsOf("messages").length, 0);
	const skip = skipsOf(run.protocolMessages).find(
		(s) => s.stream === "messages",
	);
	assert.equal(skip?.reason, "export_conversation_incomplete");
	assert.equal(
		(skip?.diagnostics as Record<string, unknown>)?.conversation_id,
		"p1",
	);
	assert.equal(
		run.protocolMessages.some(
			(message) =>
				message.type === "STATE" &&
				message.stream === "messages" &&
				"synced_at" in (message.cursor as Record<string, unknown>),
		),
		false,
	);
});

test("manifest category boundary: absent conversations with a cross-classified conversation cannot prove conversations or messages", async () => {
	const run = await runPartitions([
		{
			category: "projects",
			part: 0,
			entries: [
				{
					name: "projects.json",
					content: [FULL_PROJECT, ...CONVERSATIONS_JSON],
				},
			],
		},
		{ category: "light_metadata", part: 0, entries: OWNER_USERS },
	]);
	assert.equal(run.recordsOf("conversations").length, 1);
	assert.equal(run.recordsOf("messages").length, 1);
	assert.equal(run.recordsOf("projects").length, 1);
	assert.equal(run.recordsOf("project_documents").length, 2);
	assert.equal(run.proofFor("conversations").length, 0);
	assert.equal(run.proofFor("messages").length, 0);
	assert.equal(run.proofFor("account_profile").length, 0);
	assertSelfMapped(run, "projects", 1);
	assertSelfMapped(run, "project_documents", 2);
});

test("manifest category boundary: absent light_metadata withholds every proof while records are delivered", async () => {
	const run = await runPartitions([
		conversationsPart(),
		{ category: "projects", part: 0, entries: projectEntry(0) },
	]);
	assert.equal(run.recordsOf("conversations").length, 1);
	assert.equal(run.recordsOf("messages").length, 1);
	assert.equal(run.recordsOf("projects").length, 1);
	assert.equal(run.recordsOf("project_documents").length, 2);
	assertNoProofs(run);
});

test("manifest category boundary: projects found in conversations do not count toward a present projects category", async () => {
	const run = await runPartitions([
		{
			category: "conversations",
			part: 0,
			entries: [
				{
					name: "conversations.json",
					content: [...CONVERSATIONS_JSON, FULL_PROJECT],
				},
			],
		},
		{
			category: "projects",
			part: 0,
			entries: [{ name: "projects.json", content: [] }],
		},
		{ category: "light_metadata", part: 0, entries: OWNER_USERS },
	]);
	assert.equal(run.recordsOf("projects").length, 1);
	assert.equal(run.recordsOf("project_documents").length, 2);
	assert.equal(run.proofFor("projects").length, 0);
	assert.equal(run.proofFor("project_documents").length, 0);
	// A project shape in this category still has an omitted conversation list.
	assert.equal(run.proofFor("conversations").length, 0);
	assert.equal(run.proofFor("messages").length, 0);
	assert.equal(run.recordsOf("conversations").length, 1);
	assert.equal(run.recordsOf("messages").length, 1);
	const skip = skipsOf(run.protocolMessages).find(
		(s) => s.stream === "messages",
	);
	assert.equal(skip?.reason, "export_conversation_incomplete");
	assert.equal(
		(skip?.diagnostics as Record<string, unknown>)?.conversation_id,
		"proj-1",
	);
	assert.equal(
		run.protocolMessages.some(
			(message) =>
				message.type === "STATE" &&
				message.stream === "messages" &&
				"synced_at" in (message.cursor as Record<string, unknown>),
		),
		false,
	);
});

test("manifest category boundary: conversations found in projects do not count toward a present conversations category", async () => {
	const run = await runPartitions([
		{
			category: "conversations",
			part: 0,
			entries: [{ name: "conversations.json", content: [] }],
		},
		{
			category: "projects",
			part: 0,
			entries: [
				{
					name: "projects.json",
					content: [FULL_PROJECT, ...CONVERSATIONS_JSON],
				},
			],
		},
		{ category: "light_metadata", part: 0, entries: OWNER_USERS },
	]);
	assert.equal(run.recordsOf("conversations").length, 1);
	assert.equal(run.recordsOf("messages").length, 1);
	assert.equal(run.proofFor("conversations").length, 0);
	assert.equal(run.proofFor("messages").length, 0);
	assertSelfMapped(run, "projects", 1);
	assertSelfMapped(run, "project_documents", 2);
});

test("manifest category boundary: global part numbering fails closed without an authoritative numbering contract", async () => {
	assertNoProofs(
		await runPartitions([
			conversationsPart(0),
			{ category: "projects", part: 1, entries: projectEntry(0) },
			{ category: "light_metadata", part: 2, entries: OWNER_USERS },
		]),
	);
});

// Known unconsumed categories use the observed, sanitized split-export shapes.
const KNOWN_EXTRA_PARTS = ["memories", "design_chats"].map((category) => ({
	category,
	part: 0,
	entries: listFilesRecursive(join(SPLIT_EXPORT_DIR, `${category}-000`)).map(
		(name) => ({
			name,
			content: JSON.parse(
				readFileSync(join(SPLIT_EXPORT_DIR, `${category}-000`, name), "utf8"),
			),
		}),
	),
}));
const EMPTY_PROJECTS_PART = {
	category: "projects",
	part: 0,
	entries: [{ name: "projects.json", content: [] }],
};
const COMPLETION_BASE_PARTS = [
	conversationsPart(),
	EMPTY_PROJECTS_PART,
	{ category: "light_metadata", part: 0, entries: OWNER_USERS },
];

test("manifest known extras: memories and design_chats coexist with proven empty projects and documents", async () => {
	const run = await runPartitions([
		...COMPLETION_BASE_PARTS,
		...KNOWN_EXTRA_PARTS,
	]);
	assertSelfMapped(run, "conversations", 1);
	assertSelfMapped(run, "messages", 1);
	assertSelfMapped(run, "projects", 0);
	assertSelfMapped(run, "project_documents", 0);
	assert.equal(run.proofFor("account_profile").length, 0);
	assert.equal(run.recordsOf("account_profile").length, 1);
});

test("manifest known extras: an unknown category still withholds every proof", async () => {
	const run = await runPartitions([
		...COMPLETION_BASE_PARTS,
		...KNOWN_EXTRA_PARTS,
		{
			category: "future_category",
			part: 0,
			entries: [{ name: "future.json", content: [] }],
		},
	]);
	assert.equal(run.recordsOf("conversations").length, 1);
	assertNoProofs(run);
});

for (const extra of KNOWN_EXTRA_PARTS) {
	test(`manifest known extras: ${extra.category} alone keeps proofs when the other extra is absent`, async () => {
		const run = await runPartitions([...COMPLETION_BASE_PARTS, extra]);
		assertSelfMapped(run, "conversations", 1);
		assertSelfMapped(run, "projects", 0);
		assertSelfMapped(run, "project_documents", 0);
	});
	test(`manifest known extras: contiguous ${extra.category} parts from zero keep proofs`, async () => {
		const run = await runPartitions([
			...COMPLETION_BASE_PARTS,
			extra,
			{ ...extra, part: 1 },
		]);
		assertSelfMapped(run, "conversations", 1);
		assertSelfMapped(run, "projects", 0);
		assertSelfMapped(run, "project_documents", 0);
	});
	for (const [label, parts] of [
		["missing zero", [1]],
		["gap", [0, 2]],
		["duplicate", [0, 0]],
	] as const) {
		test(`manifest known extras: ${extra.category} ${label} withholds every proof`, async () => {
			const run = await runPartitions([
				...COMPLETION_BASE_PARTS,
				...parts.map((part) => ({ ...extra, part })),
			]);
			assert.equal(run.recordsOf("conversations").length, 1);
			assertNoProofs(run);
		});
	}
	test(`manifest known extras: unreadable ${extra.category} JSON withholds every proof`, async () => {
		const { deflateRawSync } = await import("node:zlib");
		const name = `${extra.category}/invalid.json`;
		const invalidZip = await buildManifestPartZip([{ name, content: null }]);
		// "null" and "nope" have the same compressed and uncompressed lengths.
		// Replace only the entry payload, retaining an intact ZIP directory.
		const invalidJson = deflateRawSync(Buffer.from("nope"));
		assert.equal(
			invalidJson.length,
			deflateRawSync(Buffer.from("null")).length,
		);
		invalidZip.set(invalidJson, 30 + Buffer.byteLength(name));
		const parts = [...COMPLETION_BASE_PARTS, extra];
		const context = makeContext({
			streams: ALL_PLUS_MESSAGES,
			fetchStub: manifestFetchStub(
				parts.map((part, index) => ({
					category: part.category,
					part: part.part,
					token: `invalid-json-${index}`,
				})),
			),
		});
		const zips = await Promise.all(
			COMPLETION_BASE_PARTS.map((part) => buildManifestPartZip(part.entries)),
		);
		const runtime = makeEmitRecord({
			requested: context.ctx.requested,
			emit: context.ctx.emit,
			emittedAt: context.ctx.emittedAt,
			validateRecord,
			isTombstone: undefined,
			timeRangeFieldFor: consentTimeFieldResolver("anthropic"),
		});
		context.ctx.emitRecord = runtime.emit;
		context.ctx.isRecordSelected = runtime.isSelected;
		serveDownloads(
			context.page,
			new Map([
				...zips.map((zip, index): [string, Buffer] => [
					`invalid-json-${index}`,
					zip,
				]),
				[`invalid-json-${zips.length}`, invalidZip],
			]),
		);
		await collectAnthropic(context.ctx);
		assert.equal(
			context.protocolMessages.filter(
				(message) =>
					message.type === "RECORD" && message.stream === "conversations",
			).length,
			1,
		);
		assert.equal(
			context.protocolMessages.filter(
				(message) => message.type === "DETAIL_COVERAGE",
			).length,
			0,
		);
	});
}

const FULL_METADATA_ENTRIES = listFilesRecursive(
	join(SPLIT_EXPORT_DIR, "light_metadata-000"),
).map((name) => ({
	name,
	content: JSON.parse(
		readFileSync(join(SPLIT_EXPORT_DIR, "light_metadata-000", name), "utf8"),
	),
}));
const FULL_FIXTURE_EMPTY_PROJECT_PARTS = [
	{
		category: "conversations",
		part: 0,
		entries: [
			{
				name: "conversations.json",
				content: JSON.parse(
					readFileSync(
						join(SPLIT_EXPORT_DIR, "conversations-000/conversations.json"),
						"utf8",
					),
				),
			},
		],
	},
	EMPTY_PROJECTS_PART,
	{ category: "light_metadata", part: 0, entries: FULL_METADATA_ENTRIES },
	...KNOWN_EXTRA_PARTS,
];

test("manifest known metadata: full fixture shape proves empty projects and documents beside login history", async () => {
	const run = await runPartitions(FULL_FIXTURE_EMPTY_PROJECT_PARTS);
	assertSelfMapped(run, "conversations", 2);
	assertSelfMapped(run, "messages", 3);
	assertSelfMapped(run, "projects", 0);
	assertSelfMapped(run, "project_documents", 0);
	assert.equal(run.proofFor("account_profile").length, 0);
	assert.equal(run.recordsOf("account_profile").length, 1);
	assert.deepEqual(run.recordsOf("account_profile")[0]?.data, {
		id: "org-1",
		organization_id: "org-1",
		full_name: null,
		plan: null,
		name_source: "none",
		metadata_status: "mismatch",
	});
});

test("manifest known metadata: absent login history keeps archive proof", async () => {
	const run = await runPartitions(
		FULL_FIXTURE_EMPTY_PROJECT_PARTS.map((part) => ({
			...part,
			entries:
				part.category === "light_metadata"
					? part.entries.filter((entry) => entry.name !== "login_history.json")
					: part.entries,
		})),
	);
	assertSelfMapped(run, "conversations", 2);
	assertSelfMapped(run, "projects", 0);
	assertSelfMapped(run, "project_documents", 0);
	assert.equal(run.proofFor("account_profile").length, 0);
});

for (const name of ["future_metadata.json", "nested/login_history.json"]) {
	test(`manifest known metadata: unknown ${name} withholds every proof`, async () => {
		const run = await runPartitions(
			FULL_FIXTURE_EMPTY_PROJECT_PARTS.map((part) => ({
				...part,
				entries:
					part.category === "light_metadata"
						? [...part.entries, { name, content: [] }]
						: part.entries,
			})),
		);
		assert.equal(run.recordsOf("conversations").length, 2);
		assertNoProofs(run);
	});
}

for (const mode of ["buffered", "chunks"] as const) {
	test(`manifest known metadata: unreadable login history ${mode} withholds every proof`, async () => {
		const { deflateRawSync } = await import("node:zlib");
		const parts = FULL_FIXTURE_EMPTY_PROJECT_PARTS.map((part) => ({
			...part,
			entries:
				part.category === "light_metadata"
					? [
							{ name: "login_history.json", content: null },
							...part.entries.filter(
								(entry) => entry.name !== "login_history.json",
							),
						]
					: part.entries,
		}));
		const zips = await Promise.all(
			parts.map((part) => buildManifestPartZip(part.entries)),
		);
		const metadataIndex = parts.findIndex(
			(part) => part.category === "light_metadata",
		);
		const metadataZip = zips[metadataIndex];
		assert.ok(metadataZip);
		const invalidJson = deflateRawSync(Buffer.from("nope"));
		assert.equal(
			invalidJson.length,
			deflateRawSync(Buffer.from("null")).length,
		);
		metadataZip.set(invalidJson, 30 + Buffer.byteLength("login_history.json"));
		const context = makeContext({
			streams: ALL_PLUS_MESSAGES,
			fetchStub: manifestFetchStub(
				parts.map((part, index) => ({
					category: part.category,
					part: part.part,
					token: `metadata-${index}`,
				})),
			),
		});
		const runtime = makeEmitRecord({
			requested: context.ctx.requested,
			emit: context.ctx.emit,
			emittedAt: context.ctx.emittedAt,
			validateRecord,
			isTombstone: undefined,
			timeRangeFieldFor: consentTimeFieldResolver("anthropic"),
		});
		context.ctx.emitRecord = runtime.emit;
		context.ctx.isRecordSelected = runtime.isSelected;
		serveDownloads(
			context.page,
			new Map(zips.map((zip, index) => [`metadata-${index}`, zip])),
		);
		const texts = new Map(
			parts.flatMap((part) =>
				part.entries.map(
					(entry) => [entry.name, JSON.stringify(entry.content)] as const,
				),
			),
		);
		texts.set("login_history.json", "nope");
		await collectAnthropic({
			...context.ctx,
			...(mode === "chunks"
				? {
						readZipEntryChunk: (name: string, offset: number, length: number) =>
							Promise.resolve(
								texts.get(name)?.slice(offset, offset + length) ?? "",
							),
					}
				: {}),
		});
		assert.equal(
			context.protocolMessages.filter(
				(message) =>
					message.type === "RECORD" && message.stream === "conversations",
			).length,
			2,
		);
		assert.equal(
			context.protocolMessages.filter(
				(message) => message.type === "DETAIL_COVERAGE",
			).length,
			0,
		);
	});
}

// ─── Collection completeness: large parents and independent projects ─────

const HUGE_TEXT = "x".repeat(33_554_432);

function gapsOf(messages: EmittedMessage[]) {
	return messages.filter(
		(m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> =>
			m.type === "DETAIL_GAP",
	);
}

async function runOldFormat(
	files: { name: string; content: unknown }[],
	options: {
		streams?: string[];
		streaming?: boolean;
		entriesValidated?: boolean;
		since?: string;
		resources?: Record<string, string[]>;
		/** Observes every chunk read from the export entry. */
		onRead?: (
			name: string,
			offset: number,
			length: number,
			text: string,
		) => void;
		bufferMeter?: InstanceType<typeof BufferMeter>;
		testOverrides?: AnthropicTestOverrides;
		/** Wraps the collect call only (not the test's own fixture building). */
		aroundCollect?: <T>(run: () => Promise<T>) => Promise<T>;
	} = {},
) {
	const bytes = await buildManifestPartZip(files);
	const context = makeContext({
		streams: options.streams ?? ALL_EXPORT_STREAMS,
		...(options.since ? { since: options.since } : {}),
		...(options.resources ? { resources: options.resources } : {}),
		...(options.testOverrides ? { testOverrides: options.testOverrides } : {}),
		fetchStub: oldFormatFetchStub({ exportRequests: 0 }),
	});
	serveDownload(context.page, bytes);
	const texts = new Map(
		files.map((file) => [file.name, entryText(file.content)]),
	);
	const around = options.aroundCollect ?? ((run) => run());
	await around(() =>
		collectAnthropic({
			...context.ctx,
			testOverrides: context.ctx.testOverrides,
			...(options.bufferMeter ? { bufferMeter: options.bufferMeter } : {}),
			...(options.streaming
				? {
						readZipEntryChunk: (
							name: string,
							offset: number,
							length: number,
						) => {
							const text =
								texts.get(name)?.slice(offset, offset + length) ?? "";
							options.onRead?.(name, offset, length, text);
							return Promise.resolve(text);
						},
						entriesValidated: options.entriesValidated ?? true,
					}
				: {}),
		}),
	);
	return context;
}

/**
 * Measures the largest string the connector builds while collecting: the
 * longest `Array.prototype.join` result and the longest `JSON.parse` input.
 * A connector that buffers a whole parent shows its size here.
 */
function stringBuildMeter() {
	const peak = { join: 0, parse: 0 };
	const around = async <T>(run: () => Promise<T>): Promise<T> => {
		const realJoin = Array.prototype.join;
		const realParse = JSON.parse;
		Array.prototype.join = function (this: unknown[], separator?: string) {
			const out = realJoin.call(this, separator);
			if (out.length > peak.join) peak.join = out.length;
			return out;
		};
		JSON.parse = ((
			text: string,
			reviver?: Parameters<typeof JSON.parse>[1],
		) => {
			if (typeof text === "string" && text.length > peak.parse)
				peak.parse = text.length;
			return realParse(text, reviver);
		}) as typeof JSON.parse;
		try {
			return await run();
		} finally {
			Array.prototype.join = realJoin;
			JSON.parse = realParse;
		}
	};
	return { peak, around };
}

/** The event right after `blob` is the record that names it. */
function assertBlobPrecedesRecord(
	events: ReturnType<typeof makeContext>["events"],
	blob: { stream: string; key: unknown },
) {
	const at = events.findIndex(
		(event) =>
			event.kind === "message" &&
			event.message.type === "BLOB" &&
			event.message.stream === blob.stream &&
			event.message.key === blob.key,
	);
	const next = events[at + 1];
	assert.ok(
		at >= 0 &&
			next?.kind === "record" &&
			next.stream === blob.stream &&
			(next.data as { id?: unknown }).id === blob.key,
		`${blob.stream}/${String(blob.key)} must be followed by its record`,
	);
}

function coverageOf(messages: EmittedMessage[], stream: string) {
	return messages.filter(
		(m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			m.type === "DETAIL_COVERAGE" && m.stream === stream,
	);
}

for (const streaming of [false, true]) {
	const mode = streaming ? "streaming" : "buffered";
	test(`collectAnthropic: ${mode} conversation with over-cap message text keeps every record, omits only that text, and still proves`, async () => {
		const { emitted, protocolMessages } = await runOldFormat(
			[
				{
					name: "conversations.json",
					content: [
						{
							uuid: "conv-huge",
							name: "Huge",
							created_at: "2026-01-01T00:00:00.000Z",
							chat_messages: [
								{
									uuid: "msg-huge-1",
									sender: "human",
									created_at: "2026-01-01T00:00:00.000Z",
									text: HUGE_TEXT,
								},
								{
									uuid: "msg-huge-2",
									sender: "assistant",
									created_at: "2026-01-01T00:00:01.000Z",
									text: "short reply",
								},
							],
						},
						CONVERSATIONS_JSON[0],
					],
				},
			],
			{
				streams: ["conversations", "messages"],
				streaming,
			},
		);
		assert.deepEqual(
			emitted
				.filter((r) => r.stream === "conversations")
				.map((r) => r.data.id)
				.sort(),
			["conv-1", "conv-huge"],
		);
		const hugeMessages = emitted.filter(
			(r) => r.stream === "messages" && r.data.conversation_id === "conv-huge",
		);
		assert.deepEqual(hugeMessages.map((r) => r.data.id).sort(), [
			"msg-huge-1",
			"msg-huge-2",
		]);
		// The text cannot be a blob (its encoding is over the host cap), so the
		// field is absent: never cut, never replaced.
		const hugeFirst = hugeMessages.find((r) => r.data.id === "msg-huge-1");
		assert.ok(hugeFirst);
		assert.equal("content" in hugeFirst.data, false);
		assert.equal("blob_ref" in hugeFirst.data, false);
		assert.equal(validateRecord("messages", hugeFirst.data).ok, true);
		assert.equal(
			hugeMessages.find((r) => r.data.id === "msg-huge-2")?.data.content,
			"short reply",
		);
		assert.deepEqual(gapsOf(protocolMessages), []);
		assert.deepEqual(skipsOf(protocolMessages), []);
		assert.ok(
			diagnostics.some(
				(line) =>
					line.startsWith("[anthropic-diagnostic] export_items_too_large ") &&
					line.includes('"stream":"messages"') &&
					line.includes('"reason":"content_exceeds_host_blob_cap"') &&
					line.includes('"count":1'),
			),
			diagnostics.join("\n"),
		);
		// Every key is emitted, so every key is accounted: proofs stand.
		const messageCount = emitted.filter((r) => r.stream === "messages").length;
		assert.equal(coverageOf(protocolMessages, "conversations").length, 1);
		assert.equal(coverageOf(protocolMessages, "messages").length, 1);
		assert.equal(
			coverageOf(protocolMessages, "messages")[0]?.considered,
			messageCount,
		);
		assert.equal(
			coverageOf(protocolMessages, "conversations")[0]?.considered,
			2,
		);
	});
}

for (const streaming of [false, true]) {
	const mode = streaming ? "streaming" : "buffered";
	test(`collectAnthropic: ${mode} message and document text over 10M characters is a blob, not a truncation`, async () => {
		// ASCII source characters plus escapes (NUL, a lone surrogate) so the
		// test reader's offsets in UTF-16 units equal the entry's byte size.
		const longText = `${"a".repeat(6_000_000)}\u0000\ud800${"z".repeat(6_000_000)}end`;
		const { emitted, events, protocolMessages } = await runOldFormat(
			[
				{
					name: "conversations.json",
					content: [
						{
							uuid: "conv-long",
							created_at: "2026-01-01T00:00:00.000Z",
							chat_messages: [
								{ uuid: "msg-long", sender: "human", text: longText },
							],
						},
					],
				},
				{
					name: "projects/proj-long.json",
					content: {
						uuid: "proj-long",
						name: "Long",
						docs: [{ uuid: "doc-long", filename: "a.md", content: longText }],
					},
				},
			],
			{ streaming },
		);
		for (const [stream, id] of [
			["messages", "msg-long"],
			["project_documents", "doc-long"],
		] as const) {
			const record = emitted.find((r) => r.stream === stream);
			assert.ok(record, stream);
			assert.equal(record.data.id, id);
			assert.equal(record.data.content, null);
			const blob = protocolMessages.find(
				(m): m is Extract<EmittedMessage, { type: "BLOB" }> =>
					m.type === "BLOB" && m.stream === stream,
			);
			assert.ok(blob, `${stream} blob`);
			assert.equal(blob.key, id);
			const bytes = readFileSync(join(blobSpoolDir, blob.file));
			assert.equal(JSON.parse(bytes.toString("utf8")), longText);
			const ref = record.data.blob_ref as Record<string, unknown>;
			assert.equal(
				ref.sha256,
				createHash("sha256").update(bytes).digest("hex"),
			);
			assert.equal(ref.size_bytes, bytes.length);
			assert.equal(ref.blob_id, `sha256:${ref.sha256}`);
			// The BLOB descriptor is emitted immediately before its record.
			assertBlobPrecedesRecord(events, blob);
		}
		// The project record's raw_docs copy leaves the long text to the
		// document record instead of cutting it.
		const project = emitted.find((r) => r.stream === "projects");
		const rawDocs = project?.data.raw_docs as Array<Record<string, unknown>>;
		assert.equal("content" in (rawDocs[0] ?? {}), false);
		for (const stream of ["messages", "project_documents"])
			assert.equal(coverageOf(protocolMessages, stream).length, 1, stream);
		assert.deepEqual(gapsOf(protocolMessages), []);
	});
}

// ASCII controls only: the test reader slices by UTF-16 unit, so the entry
// size must equal its unit length.
const CONTROL_TEXT = "a\u0000b\u0007c\u001fd\u007fe\ud800g\\u0001h";

for (const streaming of [false, true]) {
	const mode = streaming ? "streaming" : "buffered";
	test(`collectAnthropic: ${mode} control characters are represented in every converted field and decode to the source`, async () => {
		const { emitted, protocolMessages } = await runOldFormat(
			[
				{
					name: "conversations.json",
					content: [
						{
							uuid: "conv-ctl",
							name: CONTROL_TEXT,
							created_at: "2026-01-01T00:00:00.000Z",
							chat_messages: [
								{
									uuid: "msg-ctl",
									sender: "human",
									text: CONTROL_TEXT,
									attachments: [{ file_name: CONTROL_TEXT }],
								},
							],
						},
					],
				},
				{
					name: "projects/proj-ctl.json",
					content: {
						uuid: "proj-ctl",
						name: CONTROL_TEXT,
						description: CONTROL_TEXT,
						prompt_template: CONTROL_TEXT,
						creator: { uuid: "u", full_name: CONTROL_TEXT },
						docs: [
							{
								uuid: "doc-ctl",
								filename: CONTROL_TEXT,
								content: CONTROL_TEXT,
							},
						],
					},
				},
			],
			{ streaming },
		);
		const get = (stream: string, id: string) =>
			emitted.find((r) => r.stream === stream && r.data.id === id)?.data;
		const decode = (value: unknown) => decodeEscapedText(String(value));
		const conversation = get("conversations", "conv-ctl");
		assert.ok(conversation, "the conversation is emitted, not dropped");
		assert.equal(decode(conversation.title), CONTROL_TEXT);
		const message = get("messages", "msg-ctl");
		assert.ok(message, "the message is emitted, not dropped");
		assert.equal(decode(message.content), CONTROL_TEXT);
		assert.ok(
			String(message.content).includes("\\u0000"),
			"the wire text is escaped, not raw",
		);
		assert.equal(
			decode(
				(message.attachments as Array<Record<string, unknown>>)[0]?.file_name,
			),
			CONTROL_TEXT,
		);
		const project = get("projects", "proj-ctl");
		assert.ok(project);
		for (const field of ["name", "description", "prompt_template"])
			assert.equal(decode(project[field]), CONTROL_TEXT, field);
		assert.equal(
			decode((project.creator as { full_name: string }).full_name),
			CONTROL_TEXT,
		);
		const doc = get("project_documents", "doc-ctl");
		assert.ok(doc);
		assert.equal(decode(doc.filename), CONTROL_TEXT);
		assert.equal(decode(doc.content), CONTROL_TEXT);
		// The raw envelope blob still holds the exact source.
		const blob = blobsOf(protocolMessages).find((b) => b.key === "conv-ctl");
		assert.ok(blob);
		assert.equal(
			JSON.parse(readFileSync(join(blobSpoolDir, blob.file), "utf8")).payload
				.name,
			CONTROL_TEXT,
		);
		for (const stream of [
			"conversations",
			"messages",
			"projects",
			"project_documents",
		])
			assert.equal(coverageOf(protocolMessages, stream).length, 1, stream);
	});

	test(`collectAnthropic: ${mode} a field over the inline cap is absent with one aggregate count, nothing is cut, and every stream still proves`, async () => {
		// 3M NULs are 18M escaped units: over the 10M inline cap.
		const nuls = "\u0000".repeat(3_000_000);
		const { emitted, protocolMessages } = await runOldFormat(
			[
				{
					name: "conversations.json",
					content: [
						{
							uuid: "conv-cap",
							name: nuls,
							created_at: "2026-01-01T00:00:00.000Z",
							chat_messages: [{ uuid: "msg-cap", sender: "human", text: "hi" }],
						},
					],
				},
				{
					name: "projects/proj-cap.json",
					content: {
						uuid: "proj-cap",
						name: "Cap",
						description: nuls,
						docs: [{ uuid: "doc-cap", filename: nuls, content: "ok" }],
					},
				},
			],
			{ streaming },
		);
		const conversation = emitted.find((r) => r.stream === "conversations");
		assert.ok(conversation);
		assert.equal("title" in conversation.data, false);
		const project = emitted.find((r) => r.stream === "projects");
		assert.ok(project);
		assert.equal("description" in project.data, false);
		assert.equal(project.data.name, "Cap");
		const doc = emitted.find((r) => r.stream === "project_documents");
		assert.ok(doc);
		assert.equal("filename" in doc.data, false);
		assert.equal(doc.data.content, "ok");
		for (const stream of ["conversations", "projects", "project_documents"]) {
			assert.ok(
				diagnostics.some(
					(line) =>
						line.startsWith("[anthropic-diagnostic] export_items_too_large ") &&
						line.includes(`"stream":"${stream}"`) &&
						line.includes('"reason":"exceeds_inline_cap"') &&
						line.includes('"count":1'),
				),
				`${stream}: ${diagnostics.join("\n")}`,
			);
		}
		assert.deepEqual(gapsOf(protocolMessages), []);
		assert.deepEqual(skipsOf(protocolMessages), []);
		for (const stream of [
			"conversations",
			"messages",
			"projects",
			"project_documents",
		])
			assert.equal(coverageOf(protocolMessages, stream).length, 1, stream);
		assertUserFacingProgress(protocolMessages);
	});

	test(`collectAnthropic: ${mode} text that is small raw but over the cap once escaped is a blob of the RAW text`, async () => {
		// 2.1M NULs: 2.1M raw units, 12.6M escaped.
		const raw = `${"\u0000".repeat(2_100_000)}end`;
		const { emitted, protocolMessages, events } = await runOldFormat(
			[
				{
					name: "conversations.json",
					content: [
						{
							uuid: "conv-raw",
							created_at: "2026-01-01T00:00:00.000Z",
							chat_messages: [{ uuid: "msg-raw", sender: "human", text: raw }],
						},
					],
				},
			],
			{ streams: ["conversations", "messages"], streaming },
		);
		const message = emitted.find((r) => r.stream === "messages");
		assert.ok(message);
		assert.equal(message.data.content, null);
		const blob = blobsOf(protocolMessages).find((b) => b.stream === "messages");
		assert.ok(blob);
		const bytes = readFileSync(join(blobSpoolDir, blob.file), "utf8");
		assert.equal(
			JSON.parse(bytes),
			raw,
			"the blob is the JSON string of the source text",
		);
		assert.equal(bytes, JSON.stringify(raw));
		assertBlobPrecedesRecord(events, blob);
	});
}

for (const streaming of [false, true]) {
	const mode = streaming ? "streaming" : "buffered";
	test(`collectAnthropic: ${mode} oversized project keeps the project and its documents, omits only the raw envelope and text, and still proves`, async () => {
		const { emitted, protocolMessages } = await runOldFormat(
			[
				{ name: "conversations.json", content: CONVERSATIONS_JSON },
				{
					name: "projects/proj-huge.json",
					content: {
						uuid: "proj-huge",
						name: "Huge project",
						created_at: "2026-01-01T00:00:00.000Z",
						docs: [
							{ uuid: "doc-huge", filename: "big.md", content: HUGE_TEXT },
							{ uuid: "doc-small", filename: "small.md", content: "ok" },
						],
					},
				},
			],
			{ streams: ["projects", "project_documents"], streaming },
		);
		const project = emitted.find((r) => r.stream === "projects");
		assert.equal(project?.data.id, "proj-huge");
		assert.equal("blob_ref" in (project?.data ?? {}), false);
		assert.equal(validateRecord("projects", project?.data ?? {}).ok, true);
		assert.deepEqual(
			emitted
				.filter((r) => r.stream === "project_documents")
				.map((r) => r.data.id)
				.sort(),
			["doc-huge", "doc-small"],
		);
		const hugeDoc = emitted.find(
			(r) => r.stream === "project_documents" && r.data.id === "doc-huge",
		);
		assert.equal("content" in (hugeDoc?.data ?? {}), false);
		assert.equal(
			validateRecord("project_documents", hugeDoc?.data ?? {}).ok,
			true,
		);
		assert.deepEqual(gapsOf(protocolMessages), []);
		assert.deepEqual(skipsOf(protocolMessages), []);
		assert.equal(coverageOf(protocolMessages, "projects").length, 1);
		assert.equal(coverageOf(protocolMessages, "project_documents").length, 1);
	});
}

for (const streaming of [false, true]) {
	for (const [label, conversations] of [
		["missing", undefined],
		["not an array", { not: "an array" }],
	] as const) {
		test(`collectAnthropic: ${streaming ? "streaming" : "buffered"} projects are collected when conversations.json is ${label}`, async () => {
			const { emitted, protocolMessages } = await runOldFormat(
				[
					...(conversations === undefined
						? []
						: [{ name: "conversations.json", content: conversations }]),
					{ name: "projects/proj-1.json", content: PROJECT_JSON },
				],
				{ streaming, entriesValidated: false },
			);
			assert.deepEqual(
				emitted.filter((r) => r.stream === "projects").map((r) => r.data.id),
				["proj-1"],
			);
			assert.deepEqual(
				emitted
					.filter((r) => r.stream === "project_documents")
					.map((r) => r.data.id),
				["doc-1"],
			);
			assert.equal(
				emitted.filter((r) => r.stream === "conversations").length,
				0,
			);
			const skips = skipsOf(protocolMessages);
			assert.deepEqual(skips.map((s) => s.stream).sort(), [
				"conversations",
				"messages",
			]);
			assert.ok(
				skips.every((s) => s.reason === "export_conversations_missing"),
			);
			assertNoSyncedAt(protocolMessages, ["conversations", "messages"]);
			const projectState = statesOf(protocolMessages).findLast(
				(m) => m.stream === "projects",
			);
			assert.ok(
				(projectState?.cursor as Record<string, unknown> | undefined)
					?.synced_at,
				"projects checkpoint normally",
			);
		});
	}
}

// ─── Oversized parents: identity anywhere, bounded streaming, real blob ────

const LINE_PAD = "y".repeat(100_000);
const READ_CHUNK_UNITS = 120 * 1024;

/** A conversation whose `chat_messages` comes BEFORE its identity fields.
 * `count` messages of 100,000 characters each; newest first, so ordering has
 * to be restored. */
function messagesFirstParent(
	id: string,
	updatedAt: string,
	count: number,
): Record<string, unknown> {
	return {
		chat_messages: Array.from({ length: count }, (_, index) => ({
			uuid: `${id}-m${String(count - index).padStart(4, "0")}`,
			sender: index % 2 === 0 ? "assistant" : "human",
			created_at: new Date(
				Date.UTC(2026, 0, 20) + (count - index) * 1000,
			).toISOString(),
			text: LINE_PAD,
		})),
		name: "Late identity",
		updated_at: updatedAt,
		created_at: "2026-01-20T00:00:00.000Z",
		uuid: id,
	};
}

function blobsOf(messages: EmittedMessage[]) {
	return messages.filter(
		(m): m is Extract<EmittedMessage, { type: "BLOB" }> => m.type === "BLOB",
	);
}

test("collectAnthropic: a streamed oversized parent whose identity follows its messages is kept; its full envelope is streamed into one real blob and its messages are emitted in order", async () => {
	// Cross the injected 64 Ki unit buffer and verify the complete source blob.
	const parent = messagesFirstParent("late-id", "2026-02-01T00:00:00.000Z", 3);
	const reads: number[] = [];
	const meter = new BufferMeter();
	const { emitted, events, protocolMessages } = await runOldFormat(
		[{ name: "conversations.json", content: [parent, CONVERSATIONS_JSON[0]] }],
		{
			streams: ["conversations", "messages"],
			streaming: true,
			testOverrides: {
				maxBufferedObjectUnits: 64 * 1024,
				maxBlobBytes: 512 * 1024,
			},
			bufferMeter: meter,
			onRead: (_name, _offset, _length, text) => reads.push(text.length),
		},
	);
	assert.deepEqual(
		emitted
			.filter((r) => r.stream === "conversations")
			.map((r) => r.data.id)
			.sort(),
		["conv-1", "late-id"],
	);
	const messageIds = emitted
		.filter(
			(r) => r.stream === "messages" && r.data.conversation_id === "late-id",
		)
		.map((r) => r.data.id);
	assert.equal(messageIds.length, 3);
	assert.deepEqual(messageIds, [...messageIds].sort(), "created_at order");
	const record = emitted.find(
		(r) => r.stream === "conversations" && r.data.id === "late-id",
	);
	assert.equal(record?.data.message_count, 3);
	assert.equal(record?.data.update_time, "2026-02-01T00:00:00.000Z");
	// One real blob holding the whole raw envelope.
	const blob = blobsOf(protocolMessages).find((b) => b.key === "late-id");
	assert.ok(blob);
	const bytes = readFileSync(join(blobSpoolDir, blob.file));
	assert.ok(bytes.length > 256 * 1024 && bytes.length <= 512 * 1024);
	const envelope = JSON.parse(bytes.toString("utf8"));
	assert.equal(envelope.format, "anthropic-source-record-v1");
	assert.equal(envelope.stream, "conversations");
	assert.equal(envelope.record_key, "late-id");
	assert.deepEqual(envelope.payload, parent);
	const ref = record?.data.blob_ref as Record<string, unknown>;
	assert.equal(ref.size_bytes, bytes.length);
	assert.equal(ref.sha256, createHash("sha256").update(bytes).digest("hex"));
	assert.equal(blob.size_bytes, bytes.length);
	assert.equal(blob.sha256, ref.sha256);
	// The BLOB is emitted immediately before its RECORD.
	assertBlobPrecedesRecord(events, blob);
	// Bounded: no read above one chunk, and the reader held about one message,
	// not the 20M-unit parent.
	assert.ok(Math.max(...reads) <= READ_CHUNK_UNITS);
	assert.ok(meter.peakUnits < 1_000_000, `peak ${meter.peakUnits}`);
	assert.deepEqual(gapsOf(protocolMessages), []);
	assert.equal(coverageOf(protocolMessages, "conversations").length, 1);
	assert.equal(coverageOf(protocolMessages, "messages").length, 1);
});

test("collectAnthropic: the streamed path builds no string larger than one message, whatever the parent's size", async () => {
	const run = async (count: number) => {
		const meter = new BufferMeter();
		const strings = stringBuildMeter();
		const reads: number[] = [];
		const { emitted } = await runOldFormat(
			[
				{
					name: "conversations.json",
					content: [
						messagesFirstParent(`p${count}`, "2026-02-01T00:00:00.000Z", count),
					],
				},
			],
			{
				streams: ["conversations", "messages"],
				streaming: true,
				bufferMeter: meter,
				aroundCollect: strings.around,
				onRead: (_n, _o, _l, text) => reads.push(text.length),
			},
		);
		assert.equal(emitted.filter((r) => r.stream === "messages").length, count);
		assert.ok(Math.max(...reads) <= READ_CHUNK_UNITS);
		return { meter: meter.peakUnits, ...strings.peak };
	};
	// 18M units (envelope fits one blob) and 54M units (envelope over the cap).
	const small = await run(180);
	const large = await run(540);
	for (const peak of [small, large]) {
		assert.ok(peak.meter < 1_000_000, `reader peak ${peak.meter}`);
		assert.ok(peak.join < 1_000_000, `largest join ${peak.join}`);
		assert.ok(peak.parse < 1_000_000, `largest JSON.parse ${peak.parse}`);
	}
	assert.ok(
		Math.abs(large.meter - small.meter) <= 64,
		`reader peak ${small.meter} (18M-unit parent) vs ${large.meter} (54M-unit parent)`,
	);
});

for (const streaming of [false, true]) {
	const mode = streaming ? "streaming" : "buffered";
	test(`collectAnthropic: ${mode} conversation with an envelope over the host cap is emitted without blob_ref, discloses one aggregate count, and every stream still proves`, async () => {
		// Cross the injected buffer and blob limits with a small fixture.
		const { emitted, protocolMessages } = await runOldFormat(
			[
				{
					name: "conversations.json",
					content: [
						messagesFirstParent("big-id", "2026-02-01T00:00:00.000Z", 4),
						CONVERSATIONS_JSON[0],
					],
				},
				{ name: "projects/proj-1.json", content: PROJECT_JSON },
			],
			{
				streams: ["conversations", "messages", "projects", "project_documents"],
				streaming,
				testOverrides: {
					maxBufferedObjectUnits: 64 * 1024,
					maxBlobBytes: 256 * 1024,
				},
			},
		);
		const big = emitted.find(
			(r) => r.stream === "conversations" && r.data.id === "big-id",
		);
		assert.ok(big);
		assert.equal("blob_ref" in big.data, false);
		assert.equal(validateRecord("conversations", big.data).ok, true);
		assert.equal(
			emitted.filter(
				(r) => r.stream === "messages" && r.data.conversation_id === "big-id",
			).length,
			4,
		);
		// conv-1 and proj-1 still get their blobs; big-id gets none.
		assert.deepEqual(
			blobsOf(protocolMessages)
				.map((b) => b.key)
				.sort(),
			["conv-1", "proj-1"],
		);
		assert.deepEqual(gapsOf(protocolMessages), []);
		assert.deepEqual(skipsOf(protocolMessages), []);
		assert.ok(
			protocolMessages.every(
				(m) => m.type !== "DETAIL_COVERAGE" || !("optional_skip_keys" in m),
			),
		);
		const note = protocolMessages.filter(
			(m) =>
				m.type === "PROGRESS" &&
				/too large to keep a raw copy/.test((m as { message: string }).message),
		);
		assert.equal(note.length, 1);
		assertUserFacingProgress(protocolMessages);
		assert.ok(
			diagnostics.some(
				(line) =>
					line.startsWith("[anthropic-diagnostic] export_items_too_large ") &&
					line.includes('"stream":"conversations"') &&
					line.includes('"reason":"source_envelope_exceeds_host_blob_cap"') &&
					line.includes('"count":1'),
			),
			diagnostics.join("\n"),
		);
		// Every key is emitted, so every stream proves; the proof is about keys.
		for (const stream of [
			"conversations",
			"messages",
			"projects",
			"project_documents",
		])
			assert.equal(coverageOf(protocolMessages, stream).length, 1, stream);
		assert.equal(
			coverageOf(protocolMessages, "conversations")[0]?.considered,
			2,
		);
		assert.equal(
			coverageOf(protocolMessages, "messages")[0]?.considered,
			emitted.filter((r) => r.stream === "messages").length,
		);
	});

	test(`collectAnthropic: ${mode} project with an envelope over the host cap leaves every other stream, messages included, proven`, async () => {
		const docs = [0, 1, 2, 3].map((index) => ({
			uuid: `big-doc-${index}`,
			filename: `d${index}.md`,
			content: "x".repeat(75_000),
		}));
		const { emitted, protocolMessages } = await runOldFormat(
			[
				{ name: "conversations.json", content: CONVERSATIONS_JSON },
				{
					name: "projects/proj-big.json",
					content: { uuid: "proj-big", name: "Big", docs },
				},
				{ name: "projects/proj-1.json", content: PROJECT_JSON },
			],
			{
				streams: ["conversations", "messages", "projects", "project_documents"],
				streaming,
				testOverrides: {
					maxBufferedObjectUnits: 64 * 1024,
					maxBlobBytes: 256 * 1024,
				},
			},
		);
		const big = emitted.find(
			(r) => r.stream === "projects" && r.data.id === "proj-big",
		);
		assert.ok(big);
		assert.equal("blob_ref" in big.data, false);
		assert.equal(validateRecord("projects", big.data).ok, true);
		assert.deepEqual(
			blobsOf(protocolMessages)
				.map((b) => b.key)
				.sort(),
			["conv-1", "proj-1"],
		);
		assert.deepEqual(gapsOf(protocolMessages), []);
		assert.deepEqual(skipsOf(protocolMessages), []);
		for (const stream of [
			"conversations",
			"messages",
			"projects",
			"project_documents",
		])
			assert.equal(coverageOf(protocolMessages, stream).length, 1, stream);
		assert.equal(coverageOf(protocolMessages, "projects")[0]?.considered, 2);
	});
}

test("collectAnthropic: a time window selects an oversized parent by its late updated_at, and never drops it silently", async () => {
	const files = [
		{
			name: "conversations.json",
			content: [
				messagesFirstParent("inside", "2026-02-01T00:00:00.000Z", 4),
				messagesFirstParent("outside", "2025-01-01T00:00:00.000Z", 4),
			],
		},
	];
	const { emitted } = await runOldFormat(files, {
		streams: ["conversations", "messages"],
		streaming: true,
		since: "2026-01-15T00:00:00.000Z",
		testOverrides: {
			maxBufferedObjectUnits: 64 * 1024,
			maxBlobBytes: 256 * 1024,
		},
	});
	assert.deepEqual(
		emitted.filter((r) => r.stream === "conversations").map((r) => r.data.id),
		["inside"],
	);
	assert.equal(
		emitted.filter(
			(r) => r.stream === "messages" && r.data.conversation_id === "inside",
		).length,
		4,
	);
	assert.equal(
		emitted.filter(
			(r) => r.stream === "messages" && r.data.conversation_id === "outside",
		).length,
		0,
	);
});

test("collectAnthropic: an oversized parent with no identity anywhere is dropped and its streams skipped", async () => {
	const { chat_messages } = messagesFirstParent(
		"x",
		"2026-02-01T00:00:00.000Z",
		2,
	);
	const { emitted, protocolMessages } = await runOldFormat(
		[{ name: "conversations.json", content: [{ chat_messages }] }],
		{
			streams: ["conversations", "messages"],
			streaming: true,
			testOverrides: { maxBufferedObjectUnits: 64 * 1024 },
		},
	);
	assert.equal(emitted.length, 0);
	assert.deepEqual(
		skipsOf(protocolMessages)
			.map((s) => [s.stream, s.reason])
			.sort(),
		[
			["conversations", "export_items_unparseable"],
			["messages", "export_items_unparseable"],
		],
	);
});

test("collectAnthropic: the streamed path takes uuid, updated_at and name from after a large chat_messages in the buffered range too", async () => {
	// Under the 16 Mi limit the object is buffered; same answer.
	const parent = messagesFirstParent(
		"small-late",
		"2026-02-01T00:00:00.000Z",
		3,
	);
	const { emitted } = await runOldFormat(
		[{ name: "conversations.json", content: [parent] }],
		{
			streams: ["conversations", "messages"],
			streaming: true,
			since: "2026-01-15T00:00:00.000Z",
		},
	);
	assert.deepEqual(
		emitted.filter((r) => r.stream === "conversations").map((r) => r.data.id),
		["small-late"],
	);
});

for (const streaming of [false, true]) {
	const mode = streaming ? "streaming" : "buffered";
	test(`collectAnthropic: ${mode} a project whose name is over the inline cap is delivered without name, counted, and proves with its documents`, async () => {
		// 3M NULs are 18M escaped units: over the 10M inline cap.
		const nuls = "\u0000".repeat(3_000_000);
		const { emitted, protocolMessages } = await runOldFormat(
			[
				{ name: "conversations.json", content: CONVERSATIONS_JSON },
				{
					name: "projects/proj-name.json",
					content: {
						uuid: "proj-name",
						name: nuls,
						docs: [{ uuid: "doc-name", filename: "a.md", content: "kept" }],
					},
				},
			],
			{
				streams: ["conversations", "messages", "projects", "project_documents"],
				streaming,
			},
		);
		const project = emitted.find((r) => r.stream === "projects");
		assert.ok(project, "the project is delivered");
		assert.equal(project.data.id, "proj-name");
		assert.equal("name" in project.data, false);
		assert.equal(validateRecord("projects", project.data).ok, true);
		assert.equal(
			emitted.find((r) => r.stream === "project_documents")?.data.content,
			"kept",
		);
		assert.ok(
			diagnostics.some(
				(line) =>
					line.startsWith("[anthropic-diagnostic] export_items_too_large ") &&
					line.includes('"stream":"projects"') &&
					line.includes('"reason":"exceeds_inline_cap"') &&
					line.includes('"count":1'),
			),
			diagnostics.join("\n"),
		);
		assert.deepEqual(gapsOf(protocolMessages), []);
		assert.deepEqual(skipsOf(protocolMessages), []);
		for (const stream of ["projects", "project_documents"])
			assert.equal(coverageOf(protocolMessages, stream).length, 1, stream);
	});

	test(`collectAnthropic: ${mode} an ambiguous parent (conversation with docs, project with chat_messages) withholds the messages proof, whichever parent streams were requested`, async () => {
		const conversation = (extra: Record<string, unknown>) => ({
			uuid: "amb",
			created_at: "2026-01-01T00:00:00.000Z",
			chat_messages: [{ uuid: "m", sender: "human", text: "ok" }],
			...extra,
		});
		for (const streams of [
			["messages"],
			["conversations", "messages"],
			["conversations", "messages", "projects", "project_documents"],
		]) {
			const run = (files: Array<{ name: string; content: unknown }>) =>
				runOldFormat(files, { streams, streaming });
			// Control: the same parent without docs proves messages.
			const clean = await run([
				{ name: "conversations.json", content: [conversation({})] },
			]);
			assert.equal(
				coverageOf(clean.protocolMessages, "messages").length,
				1,
				`${streams.join(",")}: control`,
			);
			const withDocs = await run([
				{ name: "conversations.json", content: [conversation({ docs: [] })] },
			]);
			assert.equal(
				withDocs.emitted.filter((r) => r.stream === "messages").length,
				1,
				"the message is still delivered",
			);
			assert.equal(
				coverageOf(withDocs.protocolMessages, "messages").length,
				0,
				`${streams.join(",")}: conversation with docs`,
			);
			const projectWithMessages = await run([
				{ name: "conversations.json", content: [conversation({})] },
				{
					name: "projects/proj-amb.json",
					content: { uuid: "proj-amb", name: "P", chat_messages: [] },
				},
			]);
			assert.equal(
				coverageOf(projectWithMessages.protocolMessages, "messages").length,
				0,
				`${streams.join(",")}: project with chat_messages`,
			);
		}
	});
}

test("collectAnthropic: an oversized parent whose chat_messages is replaced by a later duplicate key matches the buffered parser", async () => {
	// The first array is about 200 Ki units, so the parent is read incrementally.
	// The later key replaces it. JSON.parse, and so the buffered parser, keeps the last.
	const bigArray = JSON.stringify(
		messagesFirstParent("dup", "2026-02-01T00:00:00.000Z", 2).chat_messages,
	);
	for (const [label, later, messages] of [
		["null", "null", 0],
		["string", '"text"', 0],
		["number", "7", 0],
		["object", '{"uuid":"nested"}', 0],
		["array", '[{"uuid":"kept","sender":"human","text":"hi"}]', 1],
	] as const) {
		const text = `{"chat_messages":${bigArray},"uuid":"dup","updated_at":"2026-02-01T00:00:00.000Z","created_at":"2026-01-20T00:00:00.000Z","chat_messages":${later}}`;
		const { emitted, protocolMessages } = await runOldFormat(
			[{ name: "conversations.json", content: new RawJson(`[${text}]`) }],
			{
				streams: ["conversations", "messages"],
				streaming: true,
				testOverrides: {
					maxBufferedObjectUnits: 64 * 1024,
					maxBlobBytes: 256 * 1024,
				},
			},
		);
		assert.deepEqual(
			emitted.filter((r) => r.stream === "conversations").map((r) => r.data.id),
			["dup"],
			label,
		);
		assert.equal(
			emitted.filter((r) => r.stream === "messages").length,
			messages,
			`${label}: only the last chat_messages counts`,
		);
		assert.equal(
			emitted.find((r) => r.stream === "conversations")?.data.message_count,
			messages,
			label,
		);
		// The buffered parser agrees on the child count.
		const parsed = JSON.parse(text) as { chat_messages: unknown };
		assert.equal(
			Array.isArray(parsed.chat_messages) ? parsed.chat_messages.length : 0,
			messages,
		);
		if (messages === 0)
			assert.equal(
				coverageOf(protocolMessages, "messages").length,
				0,
				`${label}: a non-array chat_messages is not proven`,
			);
	}
});

test("collectAnthropic: a streamed title exactly at the inline cap is kept, one unit over is absent", async () => {
	const cap = 64 * 1024;
	const run = async (length: number) => {
		const parent = messagesFirstParent("edge", "2026-02-01T00:00:00.000Z", 1);
		return runOldFormat(
			[
				{
					name: "conversations.json",
					content: [{ ...parent, name: "A".repeat(length) }],
				},
			],
			{
				streams: ["conversations", "messages"],
				streaming: true,
				testOverrides: {
					maxBufferedObjectUnits: 32 * 1024,
					inlineTextMaxUnits: cap,
				},
			},
		);
	};
	const atCap = await run(cap);
	assert.equal(
		atCap.emitted.find((r) => r.stream === "conversations")?.data.title,
		"A".repeat(cap),
	);
	const over = await run(cap + 1);
	const conversation = over.emitted.find((r) => r.stream === "conversations");
	assert.ok(conversation);
	assert.equal("title" in conversation.data, false);
	assert.ok(
		diagnostics.some(
			(line) =>
				line.includes('"stream":"conversations"') &&
				line.includes('"reason":"exceeds_inline_cap"'),
		),
	);
});

test("collectAnthropic: organization selection prefers chat, then claude_pro, then the first organization", async () => {
	const requestedOrgs: string[] = [];
	const run = async (orgs: unknown[]) => {
		const context = makeContext({
			streams: ["conversations"],
			fetchStub: (url) => {
				if (url.includes("/api/organizations") && !url.includes("export_data"))
					return Promise.resolve(jsonResponse(200, orgs));
				if (url.includes("/export_data")) {
					requestedOrgs.push(
						url.split("/organizations/")[1]?.split("/")[0] ?? "",
					);
					return Promise.resolve(jsonResponse(200, { nonce: "nonce-org" }));
				}
				return Promise.reject(new Error(`unexpected fetch: ${url}`));
			},
		});
		serveDownload(context.page, await buildZipBytes());
		await collectAnthropic(context.ctx);
	};
	await run([
		{ uuid: "org-api", capabilities: ["api"] },
		{ uuid: "org-max", capabilities: ["claude_max"] },
		{ uuid: "org-pro", capabilities: ["claude_pro"] },
	]);
	await run([
		{ uuid: "org-api", capabilities: ["api"] },
		{ uuid: "org-max", capabilities: ["claude_max"] },
	]);
	// A chat-capable organization beats a claude_pro one, whatever the order.
	await run([
		{ uuid: "org-pro", capabilities: ["claude_pro"] },
		{ uuid: "org-chat", capabilities: ["chat", "claude_max"] },
		{ uuid: "org-api", capabilities: ["api"] },
	]);
	await run([
		{ uuid: "org-chat", capabilities: ["chat"] },
		{ uuid: "org-pro", capabilities: ["claude_pro"] },
	]);
	assert.deepEqual(requestedOrgs, [
		"org-pro",
		"org-api",
		"org-chat",
		"org-chat",
	]);
});

for (const mode of [
	"buffered",
	"streaming",
	"oversized",
	"manifest",
] as const) {
	for (const unboundedMessages of [false, true]) {
		test(`scope union ${mode}: June conversations preserve May messages with ${unboundedMessages ? "unbounded" : "January"} messages`, async () => {
			const conversation = (month: string) => ({
				uuid: `conv-${month}`,
				created_at: `2026-${month}-15T00:00:00.000Z`,
				updated_at: `2026-${month}-15T00:00:00.000Z`,
				chat_messages: [
					{
						uuid: `msg-${month}`,
						sender: "human",
						created_at: `2026-${month}-15T00:00:00.000Z`,
						text: "synthetic",
					},
				],
			});
			const run = await runFullCompletion(
				mode === "oversized" ? "streaming" : mode,
				{
					streams: ["conversations", "messages"],
					conversations: [
						conversation("05"),
						conversation("06"),
						conversation("07"),
					],
					projects: [],
					scope: {
						conversations: {
							time_range: {
								since: "2026-06-01T00:00:00Z",
								until: "2026-06-30T23:59:59Z",
							},
						},
						messages: unboundedMessages
							? {}
							: {
									time_range: {
										since: "2026-01-01T00:00:00Z",
										until: "2026-06-30T23:59:59Z",
									},
								},
					},
					...(mode === "oversized"
						? { testOverrides: { maxBufferedObjectUnits: 64 } }
						: {}),
				},
			);
			assert.deepEqual(
				run.recordsOf("messages").map((r) => r.data.id),
				unboundedMessages
					? ["msg-05", "msg-06", "msg-07"]
					: ["msg-05", "msg-06"],
			);
			assert.deepEqual(
				run.recordsOf("conversations").map((r) => r.data.id),
				["conv-06"],
			);
			assert.deepEqual(skipsOf(run.protocolMessages), []);
		});
	}
}

test("oversized omission: malformed envelope names the conversation and skips both requested scopes without synced_at", async () => {
	const raw = `[{"uuid":"broken-envelope","padding":"${"x".repeat(1024)}","chat_messages":[{"uuid":"broken-message","text":}]}]`;
	const { emitted, protocolMessages } = await runOldFormat(
		[{ name: "conversations.json", content: new RawJson(raw) }],
		{
			streams: ["conversations", "messages"],
			streaming: true,
			testOverrides: { maxBufferedObjectUnits: 64 },
		},
	);
	assert.equal(emitted.length, 0);
	for (const stream of ["conversations", "messages"]) {
		const skip = skipsOf(protocolMessages).find((s) => s.stream === stream);
		assert.ok(skip, `${stream} must explicitly report a partial outcome`);
		assert.equal(skip.reason, "export_oversized_conversation_incomplete");
		assert.equal(
			(skip.diagnostics as Record<string, unknown> | undefined)
				?.conversation_id,
			"broken-envelope",
		);
		assert.equal(coverageOf(protocolMessages, stream).length, 0);
		assert.equal(
			protocolMessages.some(
				(m) =>
					m.type === "STATE" &&
					m.stream === stream &&
					"synced_at" in (m.cursor as Record<string, unknown>),
			),
			false,
		);
	}
});

for (const [label, children] of [
	["missing list", undefined],
	["malformed list", null],
	["scalar list", 7],
	["object list", {}],
	["non-object child", [null]],
	["unparseable child", [{ text: "missing identity" }]],
] as const) {
	test(`oversized omission: ${label} names its parent and withholds the messages checkpoint`, async () => {
		const { emitted, protocolMessages } = await runOldFormat(
			[
				{
					name: "conversations.json",
					content: [
						{
							uuid: "partial-parent",
							padding: "x".repeat(1024),
							chat_messages: children,
						},
					],
				},
			],
			{
				streams: ["conversations", "messages"],
				streaming: true,
				testOverrides: { maxBufferedObjectUnits: 64 },
			},
		);
		assert.equal(emitted.filter((r) => r.stream === "conversations").length, 1);
		const skip = skipsOf(protocolMessages).find((s) => s.stream === "messages");
		assert.ok(skip, "an omitted message must explicitly make messages partial");
		assert.equal(skip.reason, "export_oversized_conversation_incomplete");
		assert.equal(
			(skip.diagnostics as Record<string, unknown> | undefined)
				?.conversation_id,
			"partial-parent",
		);
		assert.equal(coverageOf(protocolMessages, "messages").length, 0);
		assert.equal(
			protocolMessages.some(
				(m) =>
					m.type === "STATE" &&
					m.stream === "messages" &&
					"synced_at" in (m.cursor as Record<string, unknown>),
			),
			false,
		);
	});
}

for (const mode of ["buffered", "streaming", "manifest"] as const) {
	for (const [label, children] of [
		["missing list", undefined],
		["malformed list", null],
		["non-object child", [null]],
		["unparseable child", [{ text: "missing identity" }]],
	] as const) {
		test(`normal omission ${mode}: ${label} names its parent and withholds the messages checkpoint`, async () => {
			const run = await runFullCompletion(mode, {
				streams: ["conversations", "messages"],
				conversations: [
					{ uuid: "partial-parent", chat_messages: children },
					{
						uuid: "valid-parent",
						chat_messages: [
							{ uuid: "valid-message", sender: "human", text: "kept" },
						],
					},
				],
				projects: [],
			});
			assert.equal(run.recordsOf("conversations").length, 2);
			assert.deepEqual(
				run.recordsOf("messages").map((record) => record.data.id),
				["valid-message"],
			);
			const skips = skipsOf(run.protocolMessages);
			assert.equal(skips.length, 1);
			const skip = skips[0];
			assert.ok(skip);
			assert.equal(skip.stream, "messages");
			assert.equal(skip.reason, "export_conversation_incomplete");
			assert.equal(
				(skip.diagnostics as Record<string, unknown> | undefined)
					?.conversation_id,
				"partial-parent",
			);
			assert.deepEqual(skip.recovery_hint, {
				action: "retry_on_connector_upgrade",
				retryable: false,
			});
			assert.equal(coverageOf(run.protocolMessages, "messages").length, 0);
			assert.equal(
				run.protocolMessages.some(
					(message) =>
						message.type === "STATE" &&
						message.stream === "messages" &&
						"synced_at" in (message.cursor as Record<string, unknown>),
				),
				false,
			);
		});
	}
	test(`normal omission ${mode}: an empty child list still checkpoints messages`, async () => {
		const run = await runFullCompletion(mode, {
			streams: ["messages"],
			conversations: [{ uuid: "empty-parent", chat_messages: [] }],
			projects: [],
		});
		assert.deepEqual(skipsOf(run.protocolMessages), []);
		assert.equal(
			run.protocolMessages.some(
				(message) =>
					message.type === "STATE" &&
					message.stream === "messages" &&
					"synced_at" in (message.cursor as Record<string, unknown>),
			),
			true,
		);
	});
}

for (const [label, children] of [
	["missing list", undefined],
	["malformed list", null],
	["non-object child", [null]],
	["unparseable child", [{ text: "missing identity" }]],
] as const) {
	test(`manifest omission: ${label} with a project discriminator names its parent`, async () => {
		const run = await runFullCompletion("manifest", {
			streams: ["conversations", "messages"],
			conversations: [
				{
					uuid: "partial-parent",
					name: "Partial",
					chat_messages: children,
					docs: [],
				},
				{
					uuid: "valid-parent",
					chat_messages: [
						{ uuid: "valid-message", sender: "human", text: "kept" },
					],
				},
			],
			projects: [],
		});
		assert.deepEqual(
			run.recordsOf("messages").map((record) => record.data.id),
			["valid-message"],
		);
		assert.ok(
			run
				.recordsOf("conversations")
				.some((record) => record.data.id === "valid-parent"),
		);
		const skips = skipsOf(run.protocolMessages);
		assert.equal(skips.length, 1);
		assert.equal(skips[0]?.stream, "messages");
		assert.equal(skips[0]?.reason, "export_conversation_incomplete");
		assert.equal(
			(skips[0]?.diagnostics as Record<string, unknown>)?.conversation_id,
			"partial-parent",
		);
		for (const stream of ["messages", "conversations"])
			assert.equal(coverageOf(run.protocolMessages, stream).length, 0);
		assert.equal(
			run.protocolMessages.some(
				(message) =>
					message.type === "STATE" &&
					message.stream === "messages" &&
					"synced_at" in (message.cursor as Record<string, unknown>),
			),
			false,
		);
	});
}

for (const partial of [{ uuid: "partial-parent" }, {}]) {
	test(`manifest omission: all-unmatched entry ${"uuid" in partial ? "with identity" : "without identity"} beside a valid entry`, async () => {
		const run = await runFullCompletion("manifest", {
			streams: ["conversations", "messages"],
			partitions: [
				{
					category: "conversations",
					part: 0,
					entries: [
						{ name: "partial.json", content: [partial] },
						{
							name: "valid.json",
							content: [
								{
									uuid: "valid-parent",
									chat_messages: [
										{ uuid: "valid-message", sender: "human", text: "kept" },
									],
								},
							],
						},
					],
				},
				{
					category: "light_metadata",
					part: 0,
					entries: [{ name: "users.json", content: [] }],
				},
			],
		});
		assert.deepEqual(
			run.recordsOf("messages").map((record) => record.data.id),
			["valid-message"],
		);
		assert.deepEqual(
			run.recordsOf("conversations").map((record) => record.data.id),
			["valid-parent"],
		);
		const skips = skipsOf(run.protocolMessages);
		if ("uuid" in partial) {
			const named = skips.filter(
				(skip) =>
					skip.stream === "messages" &&
					skip.reason === "export_conversation_incomplete",
			);
			assert.equal(named.length, 1);
			assert.equal(
				(named[0]?.diagnostics as Record<string, unknown>)?.conversation_id,
				"partial-parent",
			);
		}
		assert.ok(
			skips.some(
				(skip) =>
					skip.stream === ("uuid" in partial ? "conversations" : "messages") &&
					skip.reason === "export_items_unparseable",
			),
		);
		assert.equal(coverageOf(run.protocolMessages, "messages").length, 0);
		assert.equal(
			run.protocolMessages.some(
				(message) =>
					message.type === "STATE" &&
					message.stream === "messages" &&
					"synced_at" in (message.cursor as Record<string, unknown>),
			),
			false,
		);
	});
}

for (const children of [undefined, null]) {
	test(`manifest omission: projects-category ${children === null ? "null" : "missing"} child list stays a project`, async () => {
		const run = await runFullCompletion("manifest", {
			streams: ["conversations", "messages", "projects", "project_documents"],
			projects: [
				{
					uuid: "real-project",
					name: "Project",
					docs: [],
					chat_messages: children,
				},
			],
		});
		assert.deepEqual(
			run.recordsOf("projects").map((record) => record.data.id),
			["real-project"],
		);
		assert.deepEqual(skipsOf(run.protocolMessages), []);
		assert.equal(
			run.protocolMessages.some(
				(message) =>
					message.type === "STATE" &&
					message.stream === "messages" &&
					"synced_at" in (message.cursor as Record<string, unknown>),
			),
			true,
		);
	});
}

for (const mode of [
	"buffered",
	"streaming",
	"oversized",
	"manifest",
] as const) {
	for (const withConversations of [false, true]) {
		for (const [label, parentTimes, children, outside] of [
			[
				"parent upper bound before since",
				{ updated_at: "2026-05-15T00:00:00Z" },
				[{ text: "missing identity" }],
				"before",
			],
			[
				"old child in a current parent",
				{ updated_at: "2026-06-15T00:00:00Z" },
				[{ text: "missing identity", created_at: "2026-05-15T00:00:00Z" }],
				"before",
			],
			[
				"current child in an old parent",
				{ updated_at: "2026-05-15T00:00:00Z" },
				[{ text: "missing identity", created_at: "2026-06-01T00:00:00Z" }],
				null,
			],
			[
				"parent upper bound in window",
				{ updated_at: "2026-06-15T00:00:00Z" },
				[{ text: "missing identity" }],
				null,
			],
			["unknown timestamps", {}, [{ text: "missing identity" }], null],
			[
				"invalid timestamps",
				{ updated_at: "not-a-date", created_at: null },
				[{ text: "missing identity", created_at: "not-a-date" }],
				null,
			],
			[
				"invalid child time with old parent",
				{ updated_at: "2026-05-15T00:00:00Z" },
				[{ text: "missing identity", created_at: "not-a-date" }],
				"before",
			],
			[
				"non-object child in old parent",
				{ updated_at: "2026-05-15T00:00:00Z" },
				[null],
				"before",
			],
			["non-object child with unknown time", {}, [null], null],
			[
				"malformed list in old parent",
				{ updated_at: "2026-05-15T00:00:00Z" },
				null,
				"before",
			],
			["malformed list with unknown time", {}, null, null],
			[
				"unknown child in spanning parent",
				{
					created_at: "2026-05-15T00:00:00Z",
					updated_at: "2026-07-15T00:00:00Z",
				},
				[{ text: "missing identity" }],
				null,
			],
			[
				"non-object child in spanning parent",
				{
					created_at: "2026-05-15T00:00:00Z",
					updated_at: "2026-07-15T00:00:00Z",
				},
				[null],
				null,
			],
			[
				"malformed list in spanning parent",
				{
					created_at: "2026-05-15T00:00:00Z",
					updated_at: "2026-07-15T00:00:00Z",
				},
				null,
				null,
			],
			[
				"unknown child in parent created after until",
				{
					created_at: "2026-07-01T00:00:00Z",
					updated_at: "2026-07-15T00:00:00Z",
				},
				[{ text: "missing identity" }],
				"after",
			],
			[
				"non-object child in parent created after until",
				{
					created_at: "2026-07-01T00:00:00Z",
					updated_at: "2026-07-15T00:00:00Z",
				},
				[null],
				"after",
			],
			[
				"malformed list in parent created after until",
				{
					created_at: "2026-07-01T00:00:00Z",
					updated_at: "2026-07-15T00:00:00Z",
				},
				null,
				"after",
			],
			[
				"missing upper bound with old creation",
				{ created_at: "2026-05-15T00:00:00Z" },
				[{ text: "missing identity" }],
				null,
			],
			[
				"invalid upper bound with old creation",
				{
					created_at: "2026-05-15T00:00:00Z",
					updated_at: "not-a-date",
				},
				[{ text: "missing identity" }],
				null,
			],
			[
				"missing lower bound with late update",
				{ updated_at: "2026-07-15T00:00:00Z" },
				[{ text: "missing identity" }],
				null,
			],
			[
				"invalid lower bound with late update",
				{
					created_at: "not-a-date",
					updated_at: "2026-07-15T00:00:00Z",
				},
				[{ text: "missing identity" }],
				null,
			],
			[
				"parent upper bound touches since",
				{
					created_at: "2026-05-15T00:00:00Z",
					updated_at: "2026-06-01T00:00:00Z",
				},
				[null],
				null,
			],
			[
				"parent lower bound touches until",
				{
					created_at: "2026-06-30T00:00:00Z",
					updated_at: "2026-07-15T00:00:00Z",
				},
				null,
				null,
			],
			[
				"dated child after until in spanning parent",
				{
					created_at: "2026-05-15T00:00:00Z",
					updated_at: "2026-07-15T00:00:00Z",
				},
				[{ text: "missing identity", created_at: "2026-07-01T00:00:00Z" }],
				"after",
			],
			[
				"dated child in window overrides late parent bounds",
				{
					created_at: "2026-07-01T00:00:00Z",
					updated_at: "2026-07-15T00:00:00Z",
				},
				[{ text: "missing identity", created_at: "2026-06-15T00:00:00Z" }],
				null,
			],
			[
				"child updated timestamp after until",
				{
					created_at: "2026-05-15T00:00:00Z",
					updated_at: "2026-06-15T00:00:00Z",
				},
				[
					{
						text: "missing identity",
						created_at: "not-a-date",
						updated_at: "2026-07-01T00:00:00Z",
					},
				],
				"after",
			],
			[
				"child creation takes precedence over update",
				{
					created_at: "2026-07-01T00:00:00Z",
					updated_at: "2026-07-15T00:00:00Z",
				},
				[
					{
						text: "missing identity",
						created_at: "2026-06-30T00:00:00Z",
						updated_at: "2026-07-01T00:00:00Z",
					},
				],
				null,
			],
		] as const) {
			for (const [windowLabel, timeRange] of [
				["since-only", { since: "2026-06-01T00:00:00Z" }],
				[
					"finite",
					{
						since: "2026-06-01T00:00:00Z",
						until: "2026-06-30T00:00:00Z",
					},
				],
				["until-only", { until: "2026-06-30T00:00:00Z" }],
			] as const) {
				const omitted = !(
					(outside === "before" && "since" in timeRange) ||
					(outside === "after" && "until" in timeRange)
				);
				test(`message omission window ${mode} ${windowLabel}: ${label}, ${withConversations ? "with unbounded conversations" : "messages alone"}`, async () => {
					const run = await runFullCompletion(
						mode === "oversized" ? "streaming" : mode,
						{
							streams: withConversations
								? ["conversations", "messages"]
								: ["messages"],
							scope: {
								messages: { time_range: timeRange },
							},
							conversations: [
								{
									uuid: "partial-parent",
									...parentTimes,
									chat_messages: children,
								},
								{
									uuid: "valid-parent",
									updated_at: "2026-06-15T00:00:00Z",
									chat_messages: [
										{
											uuid: "june-message",
											created_at: "2026-06-15T00:00:00Z",
											sender: "human",
											text: "kept",
										},
									],
								},
							],
							projects: [],
							testOverrides: {
								initialDelayMs: 0,
								...(mode === "oversized" ? { maxBufferedObjectUnits: 16 } : {}),
							},
						},
					);
					assert.deepEqual(
						run.recordsOf("messages").map((record) => record.data.id),
						["june-message"],
					);
					const skips = skipsOf(run.protocolMessages).filter(
						(skip) => skip.stream === "messages",
					);
					assert.equal(skips.length, omitted ? 1 : 0);
					if (omitted) {
						assert.equal(
							skips[0]?.reason,
							mode === "oversized"
								? "export_oversized_conversation_incomplete"
								: "export_conversation_incomplete",
						);
						assert.equal(
							(skips[0]?.diagnostics as Record<string, unknown>)
								?.conversation_id,
							"partial-parent",
						);
					}
					assert.equal(
						run.protocolMessages.some(
							(message) =>
								message.type === "STATE" &&
								message.stream === "messages" &&
								"synced_at" in (message.cursor as Record<string, unknown>),
						),
						!omitted,
					);
				});
			}
		}
	}
}

test("conversation omission reasons have vetted display messages", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as { reason_display_messages: Record<string, string> };
	for (const reason of [
		"export_conversation_incomplete",
		"export_oversized_conversation_incomplete",
	]) {
		assert.equal(typeof manifest.reason_display_messages[reason], "string");
		assert.ok(manifest.reason_display_messages[reason]?.trim());
	}
});
