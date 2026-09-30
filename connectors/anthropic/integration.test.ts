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
import { after, test } from "node:test";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import type { Page } from "playwright";

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
const { validateRecord } = await import("./schemas.ts");
const { makeEmitRecord } = await import(
	"../../packages/polyfill-connectors/src/connector-runtime.ts"
);
const { makeRecordingEmit } = await import(
	"../../packages/polyfill-connectors/src/test-harness.ts"
);
type BrowserCollectContext =
	import("../../packages/polyfill-connectors/src/connector-runtime.ts").BrowserCollectContext;

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
	state?: Record<string, unknown>;
	fetchStub: FetchStub;
}): {
	page: FakePage;
	ctx: BrowserCollectContext;
	emitted: ReturnType<typeof makeRecordingEmit>["emitted"];
	events: ReturnType<typeof makeRecordingEmit>["events"];
	protocolMessages: EmittedMessage[];
} {
	const harness = makeRecordingEmit(validateRecord);
	const page = new FakePage(overrides.fetchStub);
	const scopeStreams = overrides.streams.map((name) => ({
		name,
		...(overrides.since ? { time_range: { since: overrides.since } } : {}),
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
		timeRangeFieldFor: () => "date",
	});
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

test("collectAnthropic: time window filters conversations with their messages and filters projects and documents", async () => {
	const now = Date.now();
	const since = new Date(now - 30 * 86_400_000).toISOString();
	const recent = new Date(now - 2 * 86_400_000).toISOString();
	const old = new Date(now - 31 * 86_400_000).toISOString();
	const baseMessage = CONVERSATIONS_JSON[0]?.chat_messages[0] ?? {};
	const zipBytes = await buildZipBytes(
		undefined,
		[
			{
				...CONVERSATIONS_JSON[0],
				uuid: "conv-recent",
				updated_at: recent,
				chat_messages: [{ ...baseMessage, uuid: "msg-recent" }],
			},
			{
				...CONVERSATIONS_JSON[0],
				uuid: "conv-old",
				updated_at: old,
				chat_messages: [{ ...baseMessage, uuid: "msg-old" }],
			},
		],
		{
			...PROJECT_JSON,
			updated_at: recent,
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
		project_documents: ["doc-recent"],
	});
});

test("collectAnthropic: excluded oversized source is never spooled; selected oversized source is left out with its messages in a PROGRESS note; no stream is skipped", async () => {
	const hugeConversation = {
		uuid: "conv-huge",
		name: "Excluded source",
		chat_messages: [{ uuid: "msg-huge", text: "x".repeat(33_554_432) }],
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
	// The oversized conversation and its messages are left out; every other
	// record is still imported.
	assert.deepEqual(
		selected.emitted
			.filter((r) => r.stream === "conversations")
			.map((r) => r.data.id),
		["conv-1"],
	);
	assert.ok(
		selected.emitted
			.filter((r) => r.stream === "messages")
			.every((r) => r.data.conversation_id === "conv-1"),
	);
	assert.equal(
		selected.emitted.filter((r) => r.stream === "projects").length,
		1,
	);
	assert.equal(
		selected.protocolMessages.filter((message) => message.type === "BLOB")
			.length,
		2,
	);
	assert.equal(
		readdirSync(blobSpoolDir).filter((file) => !beforeSelected.has(file))
			.length,
		2,
	);
	// An oversized item never reaches the host, so no stream is skipped:
	// a SKIP_RESULT would make Desktop drop all conversations.
	assert.deepEqual(skipsOf(selected.protocolMessages), []);
	const notes = selected.protocolMessages.filter(
		(m) =>
			m.type === "PROGRESS" &&
			/export_items_too_large/.test((m as { message: string }).message),
	) as Array<{ message: string; stream?: string; count?: number }>;
	assert.equal(notes.length, 1);
	assert.equal(notes[0]?.stream, "conversations");
	assert.equal(notes[0]?.count, 1);
	assert.doesNotMatch(notes[0]?.message ?? "", /conv-huge|Excluded source/);
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
		assert.equal(
			protocolMessages.some(
				(message) =>
					message.type === "PROGRESS" &&
					message.message.includes(`metadata: ${scenario.status}`),
			),
			scenario.status !== "valid" || scenario.name === null,
		);
	});
}

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
			timeRangeFieldFor: () => "",
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
					message.message.includes("Resumed export owner is not verified"),
			),
		);
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
		timeRangeFieldFor: () => "",
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
	assert.match(progressText, /data-2026\/conversations\.json/);
	assert.doesNotMatch(progressText, /Test conversation/);
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
	assert.match(progressText, /memories\/memories\.json/);
	assert.doesNotMatch(progressText, /not emitted/);
});

function manifestFetchStub(
	parts: Array<{ category: string; token: string }>,
): FetchStub {
	const manifest = {
		version: "1.0",
		total_files: parts.length,
		data_files: parts.map((p, i) => ({
			batch_index: 0,
			category: p.category,
			part: i,
			filename: `${p.category}-00${i}.zip`,
			export_url: `https://claude.ai/export/org-1/download/${p.token}`,
		})),
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
		]),
	});
	serveDownloads(page, new Map([["tok-c", zip]]));

	await collectAnthropic(ctx);

	assert.equal(emitted.length, 0);
	assert.equal(skipsOf(protocolMessages).length, 0);
	const final = statesOf(protocolMessages).findLast(
		(m) => m.stream === "conversations",
	);
	assert.ok("synced_at" in (final?.cursor as Record<string, unknown>));
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
		]),
	});
	serveDownloads(
		page,
		new Map([
			["tok-c", convZip],
			["tok-p", projZip],
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
	assert.match(progressText, /entry-49\.json/);
	assert.doesNotMatch(progressText, /entry-50\.json/);
	assert.match(progressText, /30 more/);
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
		],
	},
]) {
	test(`collectAnthropic: manifest with ${scenario.label} skips conversations and messages, no synced_at`, async () => {
		const { emitted, protocolMessages } = await runManifest(scenario.parts);

		const skips = skipsOf(protocolMessages);
		assert.deepEqual(skips.map((s) => s.stream).sort(), [
			"conversations",
			"messages",
		]);
		assert.ok(skips.every((s) => s.reason === "export_conversations_missing"));
		assertNoSyncedAt(protocolMessages, ["conversations", "messages"]);
		assert.equal(emitted.filter((r) => r.stream === "conversations").length, 0);
		assert.equal(emitted.filter((r) => r.stream === "projects").length, 1);
		const conversationsState = statesOf(protocolMessages).findLast(
			(m) => m.stream === "conversations",
		);
		assert.ok(
			"last_export_requested_at" in
				(conversationsState?.cursor as Record<string, unknown>),
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
	]);

	const skips = skipsOf(protocolMessages);
	assert.deepEqual(skips.map((s) => s.stream).sort(), [
		"conversations",
		"messages",
	]);
	assert.ok(skips.every((s) => s.reason === "export_items_unparseable"));
	assertNoSyncedAt(protocolMessages, ["conversations", "messages"]);
	assert.equal(emitted.filter((r) => r.stream === "conversations").length, 1);
	const progressText = protocolMessages
		.filter((m) => m.type === "PROGRESS")
		.map((m) => (m as { message: string }).message)
		.join("\n");
	assert.match(progressText, /1 conversations item\(s\)/);
	assert.doesNotMatch(progressText, new RegExp(secret));
});

test("collectAnthropic: manifest conversation without chat_messages is imported like the nonce path", async () => {
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
	]);

	assert.equal(skipsOf(protocolMessages).length, 0);
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
		{ conversations: { export_retry_not_before: notBefore } },
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
	assert.match(progressText, /memories \(1 entry\)/);
	assert.match(progressText, /design_chats \(1 entry\)/);
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
