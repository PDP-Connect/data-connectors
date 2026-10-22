// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the Gmail connector's `collect()` emit path —
 * specifically the per-message orchestration in `processMessage` and the
 * loop driver `emitMessagesPass`.
 *
 * These tests DON'T talk to IMAP. They build a fake `PerMessageDeps`
 * that:
 *   - records every (stream, data) pair pushed through emitRecord,
 *   - injects a pure fetchBodies() that returns canned bodies (or
 *     rejects to simulate a real-world fetch failure),
 *   - freezes nowIso() so timestamp fallbacks are deterministic,
 *   - captures PROGRESS emits (none expected at N<FETCH_MSG_PROGRESS).
 *
 * Imports directly from ./index.ts — `main().catch(...)` is guarded by
 * `isMainModule(import.meta.url)` so it only fires when index.ts is the
 * process entry point, not when a test imports it.
 *
 * Why bother: parsers.test.ts proves record *shapes*. Integration tests
 * on the emit path prove the invariants downstream consumers observe:
 *   - stream-scope filters (wantMessages / wantBodies / attachments)
 *     suppress only their own stream and don't break siblings,
 *   - body-fetch failure still emits the envelope record (never silently
 *     drops the message) AND leaves a retryable DETAIL_GAP so the body is
 *     refetchable, while a genuinely empty body stays body_source="empty"
 *     with no gap,
 *   - emit order within a message is body → envelope → attachments,
 *   - missing X-GM-MSGID is skipped silently without emitting anything,
 *   - per-message errors inside emitMessagesPass don't halt the loop.
 * Regressing any of these is a real data-loss bug.
 */

import assert from "node:assert/strict";
import { resourceSet } from "@pdpp/connector-protocol";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { mock, test } from "node:test";
import type {
	FetchMessageObject,
	ImapFlow,
	ListResponse,
	MessageEnvelopeObject,
	MessageStructureObject,
} from "imapflow";
import {
	assertUserFacingProgress,
	setConnectorDiagnosticSink,
} from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import { manifestPath } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import type {
	DetailGapMessage,
	DetailGapStartEntry,
	EmittedMessage,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { buildFullScanCoverageMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	ReferenceBlobUploadFailure,
	runtimeBlobUploadAvailable,
} from "../../packages/polyfill-connectors/src/reference-blob-uploader.ts";
import {
	type EmittedRecord,
	makeRecordingEmit,
	type RecordedEvent,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	__resetDoneLatchForTests,
	ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES,
	ATTACHMENT_BACKFILL_PAGE_MAX_BYTES,
	ATTACHMENT_BACKFILL_PAGE_MIN_BYTES,
	ATTACHMENT_BACKFILL_UNKNOWN_SIZE_FALLBACK_BYTES,
	ATTACHMENT_RECOVERY_PAGE_DEFAULT_BYTES,
	type AttachmentDetailCoverage,
	type AttachmentHydrationResult,
	AttachmentStallTimeoutError,
	type AttachmentTransferProgress,
	attachmentBackfillPageByteBudget,
	attachmentOutsideResourceScope,
	buildAttachmentDetailCoverageMessage,
	formatAttachmentBackfillSummary,
	createAttachmentBackfillSummary,
	addAttachmentBackfillRecordToSummary,
	buildAttachmentDetailGap,
	buildAttachmentTransferProgressMessage,
	collectMetadata,
	DEFAULT_ATTACHMENT_PROGRESS_MIN_BYTES,
	DEFAULT_ATTACHMENT_PROGRESS_MIN_INTERVAL_MS,
	DEFAULT_ATTACHMENT_STALL_TIMEOUT_MS,
	DEFAULT_MAX_ATTACHMENT_BYTES,
	emitMessagesPass,
	type FetchBodiesFn,
	type FetchedBodies,
	fetchAttachmentPart,
	gmailEmitForTests,
	type HydrateAttachmentFn,
	isoToImapDate,
	makeAttachmentDetailCoverage,
	makeEmitRecord as makeGmailEmitRecord,
	makeAttachmentHydrator,
	parseDeltaHoldbackRuns,
	type PerMessageDeps,
	processMessage,
	recordAttachmentCoverage,
	recoverServedAttachmentGaps,
	redactEmailForProgress,
	resolveAttachmentBackfillPageByteBudget,
	resolveAttachmentProgressMinBytes,
	resolveAttachmentProgressMinIntervalMs,
	resolveAttachmentRecoveryPageByteBudget,
	resolveAttachmentStallTimeoutMs,
	resolveDeltaCursorAdvance,
	resolveGmailAddressFromEnv,
	resolveGmailPasswordFromEnv,
	resolveMaxAttachmentBytes,
	runAllMailPasses,
	runDeltaPass,
	trimAttachmentBackfillPageToByteBudget,
	type UploadBodyBlobFn,
	validateAttachmentHydrationPreflight,
} from "./index.ts";
import type {
	AttachmentRecord,
	ProgressMessage,
	StreamRequest,
} from "./types.ts";

interface RecordingHarness {
	deps: PerMessageDeps;
	emit: ReturnType<typeof makeRecordingEmit>["emit"];
	emitted: EmittedRecord[];
	events: RecordedEvent[];
	progress: ProgressMessage[];
	protocolMessages: ReturnType<typeof makeRecordingEmit>["protocolMessages"];
}

const FROZEN_NOW = "2026-04-22T12:00:00.000Z";

function makeRequested(streams: readonly string[]): Map<string, StreamRequest> {
	return new Map(streams.map((name) => [name, { name }]));
}

function hydratedResult(record: AttachmentRecord): AttachmentHydrationResult {
	return { failure: null, record };
}

function failedResult(record: AttachmentRecord): AttachmentHydrationResult {
	return { failure: { stage: "blob_upload_transport_failed" }, record };
}

/** Default fake body fetch: returns plausible non-null bodies so records
 *  with wantBodies/wantMessages show real content. Override per-test via
 *  the `fetchBodies` option. */
const defaultFetchBodies: FetchBodiesFn = (): Promise<FetchedBodies> =>
	Promise.resolve({
		bodyHtmlFull: "<p>hi</p>",
		bodyTextFull: "hi",
		snippet: "hi",
	});

interface HarnessOverrides {
	attachmentCoverage?: AttachmentDetailCoverage;
	detailGaps?: readonly DetailGapStartEntry[];
	fetchBodies?: FetchBodiesFn;
	hydrateAttachment?: HydrateAttachmentFn;
	nowIso?: () => string;
	requested?: Map<string, StreamRequest>;
	timeRange?: { since?: string; until?: string };
	uploadBodyBlob?: UploadBodyBlobFn;
	wantBodies?: boolean;
	wantMessages?: boolean;
}

function makeHarness(overrides: HarnessOverrides = {}): RecordingHarness {
	// gmail has no validateRecord (no schemas.ts). pass-through mirrors
	// runtime behaviour for this connector; shape-checking kicks in the
	// moment a schema is threaded into runConnector.
	const harness = makeRecordingEmit();
	const progress: ProgressMessage[] = [];
	const requested =
		overrides.requested ?? makeRequested(["messages", "attachments"]);
	const deps: PerMessageDeps = {
		...(overrides.attachmentCoverage
			? { attachmentCoverage: overrides.attachmentCoverage }
			: {}),
		...(overrides.detailGaps ? { detailGaps: overrides.detailGaps } : {}),
		emitProgress: (m: ProgressMessage): Promise<void> => {
			progress.push(m);
			return Promise.resolve();
		},
		emitProtocol: harness.emit,
		emitRecord: async (stream, data, _keyField) => {
			await harness.emitRecord(stream, data);
			return true;
		},
		fetchBodies: overrides.fetchBodies ?? defaultFetchBodies,
		hydrateAttachment:
			overrides.hydrateAttachment ??
			((_, attachment) => Promise.resolve(hydratedResult(attachment))),
		recoveredAttachmentGapIds: new Set<string>(),
		nowIso: overrides.nowIso ?? ((): string => FROZEN_NOW),
		...(overrides.uploadBodyBlob
			? { uploadBodyBlob: overrides.uploadBodyBlob }
			: {}),
		requested,
		timeRange: overrides.timeRange,
		wantBodies: overrides.wantBodies ?? false,
		wantMessages: overrides.wantMessages ?? true,
	};
	return {
		emit: harness.emit,
		deps,
		emitted: harness.emitted,
		events: harness.events,
		progress,
		protocolMessages: harness.protocolMessages,
	};
}

function makeAttachmentMsg(): FetchMessageObject {
	const bodyStructure: MessageStructureObject = {
		childNodes: [
			{
				type: "text/plain",
				encoding: "7bit",
				parameters: { charset: "utf-8" },
			},
			{
				type: "application/pdf",
				disposition: "attachment",
				dispositionParameters: { filename: "invoice.pdf" },
				encoding: "base64",
				size: 21,
			},
		],
		type: "multipart/mixed",
	};
	return makeMsg({
		bodyStructure,
	});
}

function makeServedRecoveryMsg(
	overrides: {
		attachments?: readonly number[];
		emailId?: string;
		threadId?: string;
		uid?: number;
	} = {},
): FetchMessageObject {
	const attachmentSizes = overrides.attachments ?? [2 * 1024 * 1024, 16];
	const bodyStructure: MessageStructureObject = {
		childNodes: attachmentSizes.map((size, index) => ({
			type: "application/pdf",
			disposition: "attachment",
			dispositionParameters: { filename: `attachment-${index + 1}.pdf` },
			encoding: "base64",
			size,
		})),
		type: "multipart/mixed",
	};
	return makeMsg({
		bodyStructure,
		emailId: overrides.emailId ?? "gmmsgid-recovery",
		threadId: overrides.threadId ?? "gmthrid-recovery",
		uid: overrides.uid ?? 321,
	});
}

function makeServedRecoveryGap(args: {
	gapId: string;
	messageId: string;
	partIndex: number;
	attachmentId?: string;
	leaseId?: string;
}): DetailGapStartEntry {
	const attachmentId =
		args.attachmentId ?? `${args.messageId}:${args.partIndex}`;
	return {
		gap_id: args.gapId,
		...(args.leaseId ? { lease_id: args.leaseId } : {}),
		reference_only: true,
		status: "pending",
		stream: "attachments",
		record_key: attachmentId,
		detail_locator: {
			kind: "gmail.attachment_detail",
			attachment_id: attachmentId,
			message_id: args.messageId,
			part_index: String(args.partIndex),
		},
	};
}

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function makeAllMailMailbox(): ListResponse {
	return {
		delimiter: "/",
		flags: new Set(["\\All"]),
		listed: true,
		name: "All Mail",
		path: "[Gmail]/All Mail",
		pathAsListed: "[Gmail]/All Mail",
		parent: ["[Gmail]"],
		parentPath: "[Gmail]",
		specialUse: "\\All",
		subscribed: true,
	};
}

function blobRefBlobId(record: EmittedRecord | undefined): string | null {
	const blobRef = record?.data.blob_ref;
	if (blobRef && typeof blobRef === "object" && !Array.isArray(blobRef)) {
		const blobId = (blobRef as Record<string, unknown>).blob_id;
		return typeof blobId === "string" ? blobId : null;
	}
	return null;
}

/** Minimal-but-complete FetchMessageObject. imapflow only requires seq+uid;
 *  everything else is optional but we populate realistic defaults so the
 *  record builders have something to work with. */
function makeMsg(
	overrides: Partial<FetchMessageObject> = {},
): FetchMessageObject {
	const envelope: MessageEnvelopeObject = {
		date: new Date("2026-04-20T10:00:00.000Z"),
		subject: "Test subject",
		from: [{ name: "Alice", address: "alice@example.com" }],
		to: [{ name: "Bob", address: "bob@example.com" }],
		cc: [],
		bcc: [],
		messageId: "<msg-abc@example.com>",
	};
	return {
		seq: 1,
		uid: 100,
		emailId: "gmmsgid-1111",
		threadId: "gmthrid-2222",
		flags: new Set<string>(["\\Seen"]),
		labels: new Set<string>(["\\Inbox"]),
		envelope,
		internalDate: new Date("2026-04-20T10:00:05.000Z"),
		size: 1024,
		// The requested header fields; an empty block is a known value.
		headers: Buffer.from(""),
		// Gmail returns BODYSTRUCTURE whenever it is requested. This default is
		// an affirmatively bodyless message; without any structure the parts
		// are unknown and processMessage writes nothing (see processMessage).
		bodyStructure: { type: "multipart/mixed", childNodes: [] },
		...overrides,
	};
}

// ─── Invariant: parent-before-child (body → envelope → attachments) ──────

test("attachment backfill summary counts non-secret hydration outcomes", () => {
	const summary = createAttachmentBackfillSummary();
	addAttachmentBackfillRecordToSummary(summary, {
		hydration_status: "hydrated",
	});
	addAttachmentBackfillRecordToSummary(summary, {
		hydration_status: "too_large",
		hydration_error: "size only",
	});
	addAttachmentBackfillRecordToSummary(summary, {
		hydration_status: "failed",
		hydration_error: "download failed",
	});
	addAttachmentBackfillRecordToSummary(summary, {
		hydration_status: "deferred",
	});

	assert.deepEqual(summary, {
		failed: 1,
		hydrated: 1,
		remaining_historical_gaps: 3,
		too_large: 1,
		unavailable_skipped: 1,
	});
	assert.equal(
		formatAttachmentBackfillSummary(summary),
		"hydrated=1 too_large=1 failed=1 unavailable_skipped=1 remaining_historical_gaps=3",
	);
});

test("processMessage: emits message_bodies BEFORE messages record for the same message", async () => {
	const { deps, emitted } = makeHarness({
		requested: makeRequested(["messages", "message_bodies"]),
		wantBodies: true,
		wantMessages: true,
	});
	await processMessage(deps, makeMsg());

	const bodyIdx = emitted.findIndex((r) => r.stream === "message_bodies");
	const messageIdx = emitted.findIndex((r) => r.stream === "messages");
	assert.notEqual(bodyIdx, -1, "expected a message_bodies record");
	assert.notEqual(messageIdx, -1, "expected a messages record");
	assert.ok(
		bodyIdx < messageIdx,
		"message_bodies must precede messages in emit order",
	);
});

// ─── Invariant: stream-scope filters cleanly ─────────────────────────────

test("processMessage: wantMessages=false suppresses messages but still emits message_bodies + attachments", async () => {
	const { deps, emitted } = makeHarness({
		requested: makeRequested(["message_bodies", "attachments"]),
		wantBodies: true,
		wantMessages: false,
	});
	// msg with no attachments → only message_bodies should emit. Skip attachments.
	await processMessage(deps, makeMsg());
	assert.equal(
		emitted.filter((r) => r.stream === "messages").length,
		0,
		"no messages record when wantMessages=false",
	);
	assert.ok(
		emitted.some((r) => r.stream === "message_bodies"),
		"message_bodies still flows",
	);
});

test("processMessage: hydrates requested attachments with blob_ref, hash, MIME type, and stable id", async () => {
	const bytes = Buffer.from("pdf attachment bytes");
	const expectedSha = createHash("sha256").update(bytes).digest("hex");
	const uploadCalls: Array<{ recordKey: string; sha256: string }> = [];
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
				expectedSize: bytes.length,
				mimeType: "application/pdf",
			}),
		uploadBlob: async ({ content, recordKey, mimeType }) => {
			const chunks: Buffer[] = [];
			for await (const chunk of content) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const uploaded = Buffer.concat(chunks);
			const sha256 = createHash("sha256").update(uploaded).digest("hex");
			uploadCalls.push({ recordKey, sha256 });
			return {
				blob_id: `blob_sha256_${sha256}`,
				mime_type: mimeType,
				sha256,
				size_bytes: uploaded.byteLength,
			};
		},
	});
	const { deps, emitted } = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await processMessage(deps, makeAttachmentMsg());

	const attachment = emitted.find((record) => record.stream === "attachments");
	assert.ok(attachment, "expected hydrated attachment record");
	assert.equal(attachment.data.id, "gmmsgid-1111:2");
	assert.equal(attachment.data.content_sha256, expectedSha);
	assert.equal(attachment.data.content_type, "application/pdf");
	assert.equal(attachment.data.size_bytes, bytes.length);
	assert.equal(attachment.data.hydration_status, "hydrated");
	assert.equal(attachment.data.hydration_error, null);
	assert.deepEqual(attachment.data.blob_ref, {
		blob_id: `blob_sha256_${expectedSha}`,
		mime_type: "application/pdf",
		sha256: expectedSha,
		size_bytes: bytes.length,
	});
	assert.deepEqual(uploadCalls, [
		{ recordKey: "gmmsgid-1111:2", sha256: expectedSha },
	]);
});

test("processMessage: emits DETAIL_GAP_RECOVERED only after the matching attachment record lands", async () => {
	const bytes = Buffer.from("recoverable attachment");
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: Readable.from([bytes]),
				expectedSize: bytes.length,
				mimeType: "application/pdf",
			}),
		uploadBlob: async ({ content, mimeType }) => {
			const chunks: Buffer[] = [];
			for await (const chunk of content) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const uploaded = Buffer.concat(chunks);
			const sha256 = createHash("sha256").update(uploaded).digest("hex");
			return {
				blob_id: `blob_sha256_${sha256}`,
				mime_type: mimeType,
				sha256,
				size_bytes: uploaded.byteLength,
			};
		},
	});
	const matchingGap: DetailGapStartEntry = {
		gap_id: "gap-match",
		reference_only: true,
		status: "pending",
		stream: "attachments",
		record_key: "gmmsgid-1111:2",
		detail_locator: {
			kind: "gmail.attachment_detail",
			attachment_id: "gmmsgid-1111:2",
			message_id: "gmmsgid-1111",
			part_index: "2",
		},
	};
	const nearMissGap: DetailGapStartEntry = {
		gap_id: "gap-near-miss",
		reference_only: true,
		status: "pending",
		stream: "attachments",
		record_key: "gmmsgid-1111:2",
		detail_locator: {
			kind: "gmail.attachment_detail",
			attachment_id: "gmmsgid-1111:2",
			message_id: "gmmsgid-1111",
			part_index: "9",
		},
	};
	const harness = makeHarness({
		detailGaps: [matchingGap, nearMissGap],
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await processMessage(harness.deps, makeAttachmentMsg());

	const attachmentIdx = harness.events.findIndex(
		(event) => event.kind === "record" && event.stream === "attachments",
	);
	const recoveryIdx = harness.events.findIndex(
		(event) =>
			event.kind === "message" && event.message.type === "DETAIL_GAP_RECOVERED",
	);
	assert.ok(attachmentIdx !== -1, "expected attachment record to emit");
	assert.ok(recoveryIdx !== -1, "expected DETAIL_GAP_RECOVERED protocol emit");
	assert.ok(
		attachmentIdx < recoveryIdx,
		"recovery ack must land after the attachment record",
	);
	const emittedRecovery = harness.protocolMessages.filter(
		(msg) => msg.type === "DETAIL_GAP_RECOVERED",
	);
	assert.deepEqual(
		emittedRecovery.map((msg) => (msg as { gap_id?: string }).gap_id),
		["gap-match"],
		"only the exact matching gap should recover",
	);
	assert.equal(emittedRecovery.length, 1);
});

test("processMessage: a served gap whose attachment fails hydration AGAIN is never acknowledged as recovered", async () => {
	// The commit-gate credits a required key against a durable gap whose status
	// is `pending` OR `recovered` (reference-implementation/runtime/index.js
	// assertDetailCoverageSatisfiedBeforeCommit), and the store's same-run
	// stickiness rule keeps a `recovered` row recovered when the re-upserted
	// DETAIL_GAP shares the same run id. So if a re-failed attachment were
	// wrongly acknowledged as recovered, the run would still commit and the
	// durable gap would never surface as retryable again — a silent,
	// undetectable data loss on exactly the population this fix targets (a
	// served gap that fails again). This pins the guard against that.
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () => Promise.reject(new Error("download failed again")),
		uploadBlob: () =>
			Promise.reject(new Error("should not upload when download fails")),
	});
	const servedGap: DetailGapStartEntry = {
		gap_id: "gap-refail",
		reference_only: true,
		status: "pending",
		stream: "attachments",
		record_key: "gmmsgid-1111:2",
		detail_locator: {
			kind: "gmail.attachment_detail",
			attachment_id: "gmmsgid-1111:2",
			message_id: "gmmsgid-1111",
			part_index: "2",
		},
	};
	const attachmentCoverage = makeAttachmentDetailCoverage();
	const harness = makeHarness({
		attachmentCoverage,
		detailGaps: [servedGap],
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await processMessage(harness.deps, makeAttachmentMsg());

	// A failed hydration writes no record (a stored copy may be hydrated);
	// the failure is held by its retry gap instead.
	assert.equal(
		harness.emitted.some((record) => record.stream === "attachments"),
		false,
		"a failed hydration must not overwrite the part's stored record",
	);
	assert.equal(
		attachmentCoverage.failedRecords[0]?.record.hydration_status,
		"failed",
		"hydration must have actually failed for this probe to be valid",
	);

	const emittedRecovery = harness.protocolMessages.filter(
		(msg) => msg.type === "DETAIL_GAP_RECOVERED",
	);
	assert.deepEqual(
		emittedRecovery,
		[],
		"a re-failed served gap must NOT emit DETAIL_GAP_RECOVERED",
	);

	// A `failed` hydration lands in `gapKeys`/`failedRecords`, which is exactly
	// what `emitAttachmentDetailGaps` (the end-of-pass emitter) turns into one
	// DETAIL_GAP per failed record — the ordinary requeue path that keeps the
	// durable gap pending and retryable next run, instead of it being silently
	// abandoned as `recovered`.
	assert.deepEqual(
		attachmentCoverage.gapKeys,
		["gmmsgid-1111:2"],
		"the re-failed attachment must be a retryable gap key",
	);
	assert.deepEqual(
		attachmentCoverage.failedRecords.map((r) => r.record.id),
		["gmmsgid-1111:2"],
		"the re-failed attachment must be retained so a fresh DETAIL_GAP is emitted for it",
	);
});

test("processMessage: a failed hydration writes no record and keeps a bounded retry gap", async () => {
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.reject(new Error(`download failed ${"x".repeat(400)}`)),
		uploadBlob: () =>
			Promise.reject(new Error("should not upload when download fails")),
	});
	const coverage = makeAttachmentDetailCoverage();
	const { deps, emitted } = makeHarness({
		attachmentCoverage: coverage,
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await processMessage(deps, makeAttachmentMsg());

	// The part may already be stored hydrated (a sibling's retry, or the replay
	// of a failed run). A record with no blob would destroy that copy.
	assert.equal(
		emitted.some((record) => record.stream === "attachments"),
		false,
	);
	assert.deepEqual(coverage.gapKeys, ["gmmsgid-1111:2"]);
	const failed = coverage.failedRecords[0];
	assert.ok(failed);
	assert.equal(failed.record.blob_ref, null);
	assert.equal(failed.record.content_sha256, null);
	assert.ok(String(failed.record.hydration_error).length <= 240);
	const gap = buildAttachmentDetailGap(failed.record, failed.failureClass);
	assert.equal(gap.record_key, "gmmsgid-1111:2");
	assert.ok(
		String(gap.last_error?.class).length <= 64,
		"only a bounded class crosses",
	);
});

test("processMessage: rerun hydration preserves attachment identity and idempotent blob identity", async () => {
	const bytes = Buffer.from("same bytes");
	const expectedSha = createHash("sha256").update(bytes).digest("hex");
	let uploadCount = 0;
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: Readable.from([bytes]),
				expectedSize: bytes.length,
				mimeType: "application/pdf",
			}),
		uploadBlob: async ({ content, mimeType }) => {
			for await (const _chunk of content) {
				// Drain the stream; the fake upload service dedupes by hash.
			}
			uploadCount += 1;
			return {
				blob_id: `blob_sha256_${expectedSha}`,
				mime_type: mimeType,
				sha256: expectedSha,
				size_bytes: bytes.length,
			};
		},
	});
	const first = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});
	const second = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await processMessage(first.deps, makeAttachmentMsg());
	await processMessage(second.deps, makeAttachmentMsg());

	const firstAttachment = first.emitted.find(
		(record) => record.stream === "attachments",
	);
	const secondAttachment = second.emitted.find(
		(record) => record.stream === "attachments",
	);
	assert.ok(firstAttachment);
	assert.ok(secondAttachment);
	assert.equal(firstAttachment.data.id, secondAttachment.data.id);
	assert.equal(blobRefBlobId(firstAttachment), blobRefBlobId(secondAttachment));
	assert.equal(
		uploadCount,
		2,
		"reruns may re-upload, but blob identity remains content-addressed and stable",
	);
});

test("processMessage: repeated backfill preserves record id, content hash, blob id, and binding tuple", async () => {
	const bytes = Buffer.from("historical invoice bytes");
	const expectedSha = createHash("sha256").update(bytes).digest("hex");
	const bindings = new Set<string>();
	const storedPayloads = new Map<string, Buffer>();
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: Readable.from([bytes]),
				expectedSize: bytes.length,
				mimeType: "application/pdf",
			}),
		uploadBlob: async ({
			connectorId,
			content,
			mimeType,
			recordKey,
			stream,
		}) => {
			const chunks: Buffer[] = [];
			for await (const chunk of content) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const uploaded = Buffer.concat(chunks);
			const sha256 = createHash("sha256").update(uploaded).digest("hex");
			const blobId = `blob_sha256_${sha256}`;
			if (!storedPayloads.has(blobId)) {
				storedPayloads.set(blobId, uploaded);
			}
			bindings.add(`${blobId}|${connectorId}|${stream}|${recordKey}`);
			return {
				blob_id: blobId,
				mime_type: mimeType,
				sha256,
				size_bytes: uploaded.byteLength,
			};
		},
	});
	const first = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});
	const second = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await processMessage(first.deps, makeAttachmentMsg());
	await processMessage(second.deps, makeAttachmentMsg());

	const firstAttachment = first.emitted.find(
		(record) => record.stream === "attachments",
	);
	const secondAttachment = second.emitted.find(
		(record) => record.stream === "attachments",
	);
	assert.ok(firstAttachment);
	assert.ok(secondAttachment);
	assert.equal(firstAttachment.data.id, "gmmsgid-1111:2");
	assert.equal(secondAttachment.data.id, firstAttachment.data.id);
	assert.equal(firstAttachment.data.content_sha256, expectedSha);
	assert.equal(secondAttachment.data.content_sha256, expectedSha);
	assert.equal(blobRefBlobId(firstAttachment), `blob_sha256_${expectedSha}`);
	assert.equal(blobRefBlobId(secondAttachment), blobRefBlobId(firstAttachment));
	assert.equal(
		storedPayloads.size,
		1,
		"content-addressed store keeps one payload for repeated bytes",
	);
	assert.deepEqual(
		bindings,
		new Set([
			`blob_sha256_${expectedSha}|https://registry.pdpp.dev/connectors/gmail|attachments|gmmsgid-1111:2`,
		]),
	);
});

test("processMessage: refuses hydration when source-reported size exceeds the bounded cap (declared size)", async () => {
	const fetchAttachment = mock.fn(() =>
		Promise.reject(
			new Error("fetch should be skipped when size_bytes > maxBytes"),
		),
	);
	const uploadBlob = mock.fn(() =>
		Promise.reject(
			new Error("upload should be skipped when size_bytes > maxBytes"),
		),
	);
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment,
		maxBytes: 1024,
		uploadBlob,
	});
	const oversize: MessageStructureObject = {
		childNodes: [
			{
				type: "application/pdf",
				disposition: "attachment",
				dispositionParameters: { filename: "huge.pdf" },
				encoding: "base64",
				size: 5000,
			},
		],
		type: "multipart/mixed",
	};
	const { deps, emitted } = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});
	const outcome = await processMessage(
		deps,
		makeMsg({ bodyStructure: oversize }),
	);

	// Only a hydrated part writes a record; an over-cap part stays owed.
	assert.equal(
		emitted.some((record) => record.stream === "attachments"),
		false,
	);
	assert.deepEqual(outcome.attachments, {
		kind: "failed",
		failure: "attachment_unhydrated",
	});
	assert.equal(
		fetchAttachment.mock.callCount(),
		0,
		"must not download when declared size exceeds cap",
	);
	assert.equal(
		uploadBlob.mock.callCount(),
		0,
		"must not upload when declared size exceeds cap",
	);
});

test("processMessage: refuses hydration when streamed bytes overshoot the cap (under-reported size)", async () => {
	const oversizedBytes = Buffer.alloc(2048, 0x41);
	const uploadBlob = mock.fn(
		({ content }: { content: AsyncIterable<Buffer | Uint8Array | string> }) => {
			return (async () => {
				let bytes = 0;
				// Drain the upstream stream — guard should error before we collect everything.
				for await (const chunk of content) {
					bytes += Buffer.isBuffer(chunk)
						? chunk.byteLength
						: Buffer.from(chunk).byteLength;
				}
				return {
					blob_id: "blob_unused",
					mime_type: "application/octet-stream",
					sha256: "0".repeat(64),
					size_bytes: bytes,
				};
			})();
		},
	);
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				// Source under-reports the size: declared 100 bytes but actually 2048.
				content: Readable.from([
					oversizedBytes.subarray(0, 700),
					oversizedBytes.subarray(700),
				]),
				expectedSize: 100,
				mimeType: "application/octet-stream",
			}),
		maxBytes: 1024,
		uploadBlob,
	});

	const { deps, emitted } = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});
	const outcome = await processMessage(deps, makeAttachmentMsg());

	// Only a hydrated part writes a record; an over-cap part stays owed.
	assert.equal(
		emitted.some((record) => record.stream === "attachments"),
		false,
	);
	assert.deepEqual(outcome.attachments, {
		kind: "failed",
		failure: "attachment_unhydrated",
	});
	assert.equal(
		uploadBlob.mock.callCount(),
		1,
		"upload was attempted but the streaming cap fired mid-flight",
	);
});

test("resolveMaxAttachmentBytes: env override is honored only when positive integer; otherwise falls back to default", () => {
	assert.equal(resolveMaxAttachmentBytes({}), DEFAULT_MAX_ATTACHMENT_BYTES);
	assert.equal(
		resolveMaxAttachmentBytes({ PDPP_GMAIL_MAX_ATTACHMENT_BYTES: "1048576" }),
		1_048_576,
	);
	assert.equal(
		resolveMaxAttachmentBytes({ PDPP_GMAIL_MAX_ATTACHMENT_BYTES: "0" }),
		DEFAULT_MAX_ATTACHMENT_BYTES,
		"non-positive override is ignored",
	);
	assert.equal(
		resolveMaxAttachmentBytes({ PDPP_GMAIL_MAX_ATTACHMENT_BYTES: "abc" }),
		DEFAULT_MAX_ATTACHMENT_BYTES,
		"unparseable override is ignored",
	);
	assert.equal(
		resolveMaxAttachmentBytes({ PDPP_GMAIL_MAX_ATTACHMENT_BYTES: "123abc" }),
		DEFAULT_MAX_ATTACHMENT_BYTES,
		"partially numeric override is ignored",
	);
});

test("resolveAttachmentStallTimeoutMs: env override is honored only when positive integer; otherwise falls back to default", () => {
	assert.equal(
		resolveAttachmentStallTimeoutMs({}),
		DEFAULT_ATTACHMENT_STALL_TIMEOUT_MS,
	);
	assert.equal(
		resolveAttachmentStallTimeoutMs({
			PDPP_GMAIL_ATTACHMENT_STALL_TIMEOUT_MS: "5000",
		}),
		5000,
	);
	assert.equal(
		resolveAttachmentStallTimeoutMs({
			PDPP_GMAIL_ATTACHMENT_STALL_TIMEOUT_MS: "0",
		}),
		DEFAULT_ATTACHMENT_STALL_TIMEOUT_MS,
		"non-positive override is ignored",
	);
	assert.equal(
		resolveAttachmentStallTimeoutMs({
			PDPP_GMAIL_ATTACHMENT_STALL_TIMEOUT_MS: "abc",
		}),
		DEFAULT_ATTACHMENT_STALL_TIMEOUT_MS,
		"unparseable override is ignored",
	);
});

/** An async-iterable content source under full test control: yields
 *  `chunks` one at a time, each after `delayMs` (0 = immediate), then either
 *  ends cleanly or hangs forever past the last chunk depending on `hang`. */
function scriptedContent(
	chunks: Buffer[],
	delayMs: number,
	hang: boolean,
): AsyncIterable<Buffer> {
	const queue = [...chunks];
	return {
		[Symbol.asyncIterator]() {
			return {
				next: async () => {
					const value = queue.shift();
					if (value === undefined) {
						if (hang) {
							return new Promise<never>(() => {
								// Intentionally never settles — simulates a stalled IMAP FETCH.
							});
						}
						return { done: true, value: undefined };
					}
					if (delayMs > 0) {
						await new Promise((resolve) => setTimeout(resolve, delayMs));
					}
					return { done: false, value };
				},
			};
		},
	};
}

/**
 * Root-cause coverage for gmail-attachment-convergence-0809: a live run
 * observed attachment transfers sustaining a real, non-zero, but extremely
 * slow rate (~4.65 KB/s, confirmed against imap.gmail.com — see the incident
 * report) that made single attachments take 300-1000+ seconds. Before this
 * fix, `makeAttachmentHydrator` had no bound on transfer silence at all: a
 * source iterable that simply never resolves its next chunk (the wedge case,
 * distinct from "slow but delivering") would hang `uploadBlob` — and the
 * whole connector run — forever. These tests pin the FAIL-BEFORE/PASS-AFTER
 * behavior directly against `processMessage`, the same entry point production
 * uses, not a hand-rolled call into the hydrator's internals.
 */
test("processMessage: a transfer that goes fully silent is bounded by the stall timeout, not left to hang forever", async () => {
	let stallDetected = false;
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: scriptedContent([Buffer.from("first chunk")], 0, true),
				expectedSize: null,
				mimeType: "application/pdf",
			}),
		onStall: () => {
			stallDetected = true;
		},
		stallTimeoutMs: 20,
		uploadBlob: async ({ content }) => {
			for await (const _chunk of content) {
				// Drain until the stall guard throws.
			}
			throw new Error(
				"uploadBlob must not observe a clean end-of-stream on a stalled source",
			);
		},
	});
	const { deps } = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await assert.rejects(
		processMessage(deps, makeAttachmentMsg()),
		AttachmentStallTimeoutError,
		"a stalled transfer must reject with AttachmentStallTimeoutError, not hang or resolve — this must propagate out of processMessage, not be swallowed into a per-attachment 'failed' record, because onStall has already closed the shared IMAP connection and every later command in the run would fail too",
	);
	assert.equal(
		stallDetected,
		true,
		"onStall must fire so the caller can close the poisoned IMAP connection",
	);
});

test("processMessage: a slow-but-steadily-progressing transfer is NOT mistaken for a stall", async () => {
	// Two chunks, each delivered well under the stall budget apart. A
	// total-duration cap would kill this; the stall budget must not, because
	// real Gmail IMAP transfers can legitimately take minutes while still
	// making steady progress (see the incident's measured ~4.65 KB/s floor).
	const chunks = [Buffer.from("slow "), Buffer.from("progress")];
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: scriptedContent(chunks, 15, false),
				expectedSize: null,
				mimeType: "application/pdf",
			}),
		onStall: () => {
			throw new Error(
				"onStall must not fire for a transfer that is only slow, never silent",
			);
		},
		stallTimeoutMs: 500,
		uploadBlob: async ({ content, mimeType }) => {
			const buffered: Buffer[] = [];
			for await (const chunk of content) {
				buffered.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const uploaded = Buffer.concat(buffered);
			const sha256 = createHash("sha256").update(uploaded).digest("hex");
			return {
				blob_id: `blob_sha256_${sha256}`,
				mime_type: mimeType,
				sha256,
				size_bytes: uploaded.byteLength,
			};
		},
	});
	const { deps, emitted } = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await processMessage(deps, makeAttachmentMsg());

	const attachment = emitted.find((record) => record.stream === "attachments");
	assert.ok(attachment, "expected hydrated attachment record");
	assert.equal(
		attachment.data.hydration_status,
		"hydrated",
		"slow-but-live progress must complete normally",
	);
});

test("makeAttachmentHydrator: stall-timeout error message carries only counts, no attachment identity or content", () => {
	const error = new AttachmentStallTimeoutError(90_000, 12_345);
	assert.match(
		error.message,
		/timeout/i,
		"message must match RETRYABLE_ERROR_RE so the run is retried, not abandoned",
	);
	assert.match(error.message, /90000/);
	assert.match(error.message, /12345/);
	assert.doesNotMatch(error.message, /gmmsgid|@|subject|filename/i);
});

/**
 * REVISE coverage for gmail-attachment-convergence-0809: existing
 * FETCH_MSG_PROGRESS (every 500 MESSAGES) says nothing while a single
 * attachment streams for 10-17 minutes. These tests pin the in-transfer
 * progress signal added on top of the stall-timeout fix: bounded/redacted
 * content, cadence throttling so it can't flood the event stream, a
 * coherent start-adjacent/complete pair, and — critically — that none of
 * this can perturb backpressure, stall timing, or error propagation.
 *
 * A controllable `now()` (an injected epoch-ms clock, not real wall time)
 * drives the cadence gate deterministically without sleeping in tests.
 */
function makeControllableClock(startMs: number): {
	advance: (ms: number) => void;
	now: () => number;
} {
	let current = startMs;
	return {
		advance: (ms: number) => {
			current += ms;
		},
		now: () => current,
	};
}

/** Like `scriptedContent`, but advances a controllable clock by
 *  `msPerChunk` before yielding each chunk — for driving the progress
 *  cadence gate deterministically without real sleeps. */
function clockedContent(
	chunks: Buffer[],
	msPerChunk: number,
	advance: (ms: number) => void,
): AsyncIterable<Buffer> {
	const queue = [...chunks];
	return {
		[Symbol.asyncIterator]() {
			return {
				next: () => {
					const value = queue.shift();
					if (value === undefined) {
						return Promise.resolve({ done: true, value: undefined });
					}
					advance(msPerChunk);
					return Promise.resolve({ done: false, value });
				},
			};
		},
	};
}

test("makeAttachmentHydrator: a long steadily-progressing transfer emits cadence-gated progress with a coherent complete signal", async () => {
	const clock = makeControllableClock(1_000_000);
	const observed: AttachmentTransferProgress[] = [];
	// 10 chunks of 100KB each = 1MB total. Clock advances 5s per chunk (50s
	// total) — well past the 15s default interval — and each chunk exceeds the
	// default 256KB min-bytes threshold cumulatively, so several mid-transfer
	// observations should fire in addition to the final `complete` one.
	const chunkBytes = 100 * 1024;
	const chunks = Array.from({ length: 10 }, () => Buffer.alloc(chunkBytes, 1));
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: clockedContent(chunks, 5000, clock.advance),
				expectedSize: chunks.length * chunkBytes,
				mimeType: "application/pdf",
			}),
		onTransferProgress: (progress) => {
			observed.push(progress);
		},
		progressNow: clock.now,
		uploadBlob: async ({ content, mimeType }) => {
			const buffered: Buffer[] = [];
			for await (const chunk of content) {
				buffered.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const uploaded = Buffer.concat(buffered);
			const sha256 = createHash("sha256").update(uploaded).digest("hex");
			return {
				blob_id: `blob_sha256_${sha256}`,
				mime_type: mimeType,
				sha256,
				size_bytes: uploaded.byteLength,
			};
		},
	});
	const { deps, emitted } = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await processMessage(deps, makeAttachmentMsg());

	const attachment = emitted.find((record) => record.stream === "attachments");
	assert.equal(
		attachment?.data.hydration_status,
		"hydrated",
		"the transfer must still complete normally",
	);
	assert.ok(
		observed.length >= 2,
		"a long transfer must emit at least one mid-transfer observation plus completion",
	);
	const transferring = observed.filter((p) => p.phase === "transferring");
	const complete = observed.filter((p) => p.phase === "complete");
	assert.ok(
		transferring.length >= 1,
		"expected at least one transferring-phase observation",
	);
	assert.equal(
		complete.length,
		1,
		"exactly one complete signal, regardless of how many mid-transfer ones fired",
	);
	assert.equal(
		complete[0]?.bytesTransferred,
		chunks.length * chunkBytes,
		"complete signal reports the full byte count",
	);
	assert.equal(
		complete[0]?.totalBytes,
		chunks.length * chunkBytes,
		"trusted expectedSize is surfaced as totalBytes",
	);
	for (const p of observed) {
		assert.ok(
			p.elapsedMs >= 0,
			"elapsed time must be non-negative and monotonic with the injected clock",
		);
	}
	// Monotonic non-decreasing bytesTransferred and elapsedMs across the series.
	for (let i = 1; i < observed.length; i += 1) {
		const current = observed[i];
		const previous = observed[i - 1];
		assert.ok(current && previous);
		assert.ok(current.bytesTransferred >= previous.bytesTransferred);
		assert.ok(current.elapsedMs >= previous.elapsedMs);
	}
});

test("makeAttachmentHydrator: a short transfer under one cadence window does not spam mid-transfer progress", async () => {
	const clock = makeControllableClock(2_000_000);
	const observed: AttachmentTransferProgress[] = [];
	// Two small chunks, clock barely advances — nowhere near the default 15s /
	// 256KB cadence gate. Only the unconditional `complete` signal should fire.
	const chunks = [Buffer.from("small "), Buffer.from("attachment")];
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: clockedContent(chunks, 10, clock.advance),
				expectedSize: null,
				mimeType: "application/pdf",
			}),
		onTransferProgress: (progress) => {
			observed.push(progress);
		},
		progressNow: clock.now,
		uploadBlob: async ({ content, mimeType }) => {
			const buffered: Buffer[] = [];
			for await (const chunk of content) {
				buffered.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const uploaded = Buffer.concat(buffered);
			const sha256 = createHash("sha256").update(uploaded).digest("hex");
			return {
				blob_id: `blob_sha256_${sha256}`,
				mime_type: mimeType,
				sha256,
				size_bytes: uploaded.byteLength,
			};
		},
	});
	const { deps } = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await processMessage(deps, makeAttachmentMsg());

	assert.equal(
		observed.length,
		1,
		"a fast small transfer must emit exactly one signal: the final complete",
	);
	assert.equal(observed[0]?.phase, "complete");
});

test("makeAttachmentHydrator: totalBytes stays null when no trusted size was ever reported", async () => {
	// Distinct from the cadence test above: this pins that an UNKNOWN size is
	// never guessed or inferred from observed bytes — `makeAttachmentMsg`'s
	// fixture attachment declares a BODYSTRUCTURE size, so that test's
	// totalBytes is legitimately non-null. This test uses an attachment with
	// no declared size at all.
	const clock = makeControllableClock(2_500_000);
	const observed: AttachmentTransferProgress[] = [];
	const chunks = [Buffer.from("unsized")];
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: clockedContent(chunks, 10, clock.advance),
				expectedSize: null,
				mimeType: "application/pdf",
			}),
		onTransferProgress: (progress) => {
			observed.push(progress);
		},
		progressNow: clock.now,
		uploadBlob: async ({ content, mimeType }) => {
			const buffered: Buffer[] = [];
			for await (const chunk of content) {
				buffered.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const uploaded = Buffer.concat(buffered);
			const sha256 = createHash("sha256").update(uploaded).digest("hex");
			return {
				blob_id: `blob_sha256_${sha256}`,
				mime_type: mimeType,
				sha256,
				size_bytes: uploaded.byteLength,
			};
		},
	});
	const attachment: AttachmentRecord = {
		blob_ref: null,
		content_id: null,
		content_sha256: null,
		content_type: null,
		encoding: null,
		filename: null,
		hydration_error: null,
		hydration_status: "deferred",
		id: "gmmsgid-unsized:9",
		is_inline: false,
		message_id: "gmmsgid-unsized",
		message_received_at: FROZEN_NOW,
		part_index: "9",
		size_bytes: null,
	};

	const result = await hydrateAttachment(
		makeMsg({ emailId: "gmmsgid-unsized" }),
		attachment,
	);

	assert.equal(result.record.hydration_status, "hydrated");
	assert.ok(observed.length >= 1);
	for (const progress of observed) {
		assert.equal(
			progress.totalBytes,
			null,
			"no trusted size was ever reported, so totalBytes must stay null, not guessed",
		);
	}
});

test("enforceTransferProgress: payload never carries attachment identity, filename, subject, or content bytes", async () => {
	const clock = makeControllableClock(3_000_000);
	const observed: AttachmentTransferProgress[] = [];
	const secretBytes = Buffer.from(
		"invoice.pdf attachment from alice@example.com re: Q3 budget - CONFIDENTIAL",
	);
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: {
					[Symbol.asyncIterator]() {
						let yielded = false;
						return {
							next: () => {
								if (yielded) {
									return Promise.resolve({ done: true, value: undefined });
								}
								yielded = true;
								clock.advance(20_000);
								return Promise.resolve({ done: false, value: secretBytes });
							},
						};
					},
				},
				expectedSize: secretBytes.byteLength,
				mimeType: "application/pdf",
			}),
		onTransferProgress: (progress) => {
			observed.push(progress);
		},
		progressNow: clock.now,
		uploadBlob: async ({ content, mimeType }) => {
			const buffered: Buffer[] = [];
			for await (const chunk of content) {
				buffered.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const uploaded = Buffer.concat(buffered);
			const sha256 = createHash("sha256").update(uploaded).digest("hex");
			return {
				blob_id: `blob_sha256_${sha256}`,
				mime_type: mimeType,
				sha256,
				size_bytes: uploaded.byteLength,
			};
		},
	});
	const { deps } = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await processMessage(deps, makeAttachmentMsg());

	assert.ok(observed.length >= 1);
	for (const progress of observed) {
		// The shape itself is closed: only these four fields can ever exist.
		assert.deepEqual(Object.keys(progress).sort(), [
			"bytesTransferred",
			"elapsedMs",
			"phase",
			"totalBytes",
		]);
		const rendered = buildAttachmentTransferProgressMessage(progress);
		assert.doesNotMatch(
			rendered,
			/invoice|alice|example\.com|budget|confidential|gmmsgid/i,
		);
		assert.doesNotMatch(rendered, /attachment from|re:/i);
	}
});

test("makeAttachmentHydrator: a stalled transfer still terminates even with progress tracking wired in", async () => {
	// The load-bearing regression: progress tracking is composed OUTSIDE the
	// stall guard, so it must be provably inert with respect to stall
	// detection — this pins that a stall still fires (and still closes the
	// connection) exactly as it did before progress tracking existed.
	const clock = makeControllableClock(4_000_000);
	let stallDetected = false;
	const progressObserved: AttachmentTransferProgress[] = [];
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: scriptedContent([Buffer.from("first chunk")], 0, true),
				expectedSize: null,
				mimeType: "application/pdf",
			}),
		onStall: () => {
			stallDetected = true;
		},
		onTransferProgress: (progress) => {
			progressObserved.push(progress);
		},
		progressNow: clock.now,
		stallTimeoutMs: 20,
		uploadBlob: async ({ content }) => {
			for await (const _chunk of content) {
				// Drain until the stall guard throws.
			}
			throw new Error(
				"uploadBlob must not observe a clean end-of-stream on a stalled source",
			);
		},
	});
	const { deps } = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await assert.rejects(
		processMessage(deps, makeAttachmentMsg()),
		AttachmentStallTimeoutError,
	);
	assert.equal(
		stallDetected,
		true,
		"onStall must still fire — progress tracking must not weaken stall detection",
	);
	// The stalled next() never resolves through to the progress wrapper (it's
	// composed outside the stall guard, so a stalled inner next() never
	// reaches it) — no "complete" signal is fabricated for a transfer that
	// never legitimately finished.
	assert.deepEqual(
		progressObserved,
		[],
		"a stall must not fabricate a coherent completion signal",
	);
});

test("resolveAttachmentProgressMinIntervalMs / resolveAttachmentProgressMinBytes: env overrides honored only when positive integer", () => {
	assert.equal(
		resolveAttachmentProgressMinIntervalMs({}),
		DEFAULT_ATTACHMENT_PROGRESS_MIN_INTERVAL_MS,
	);
	assert.equal(
		resolveAttachmentProgressMinIntervalMs({
			PDPP_GMAIL_ATTACHMENT_PROGRESS_MIN_INTERVAL_MS: "5000",
		}),
		5000,
	);
	assert.equal(
		resolveAttachmentProgressMinIntervalMs({
			PDPP_GMAIL_ATTACHMENT_PROGRESS_MIN_INTERVAL_MS: "0",
		}),
		DEFAULT_ATTACHMENT_PROGRESS_MIN_INTERVAL_MS,
		"non-positive override is ignored, cannot be used to flood the event stream",
	);
	assert.equal(
		resolveAttachmentProgressMinIntervalMs({
			PDPP_GMAIL_ATTACHMENT_PROGRESS_MIN_INTERVAL_MS: "abc",
		}),
		DEFAULT_ATTACHMENT_PROGRESS_MIN_INTERVAL_MS,
	);

	assert.equal(
		resolveAttachmentProgressMinBytes({}),
		DEFAULT_ATTACHMENT_PROGRESS_MIN_BYTES,
	);
	assert.equal(
		resolveAttachmentProgressMinBytes({
			PDPP_GMAIL_ATTACHMENT_PROGRESS_MIN_BYTES: "1024",
		}),
		1024,
	);
	assert.equal(
		resolveAttachmentProgressMinBytes({
			PDPP_GMAIL_ATTACHMENT_PROGRESS_MIN_BYTES: "0",
		}),
		DEFAULT_ATTACHMENT_PROGRESS_MIN_BYTES,
		"non-positive override is ignored, cannot be used to flood the event stream",
	);
});

/** Which recovery phase a PROGRESS message reports, from its owner text. */
function recoveryPhase(message: string): string | undefined {
	if (message.startsWith("Retrying ")) {
		return "hydrating";
	}
	return message.startsWith("Recovered ") ? "settled" : undefined;
}

test("buildAttachmentTransferProgressMessage: renders megabytes, omits the total when untrusted", () => {
	const withTotal = buildAttachmentTransferProgressMessage({
		bytesTransferred: 524_288,
		elapsedMs: 30_000,
		phase: "transferring",
		totalBytes: 4_774_421,
	});
	assert.equal(withTotal, "Downloading attachment (0.5 of 4.6 MB)");

	const withoutTotal = buildAttachmentTransferProgressMessage({
		bytesTransferred: 1_048_576,
		elapsedMs: 500,
		phase: "complete",
		totalBytes: null,
	});
	assert.equal(
		withoutTotal,
		"Downloading attachment (1.0 MB so far)",
		"unknown total must never be guessed or fabricated",
	);
	assertUserFacingProgress(
		[withTotal, withoutTotal].map((message) => ({ type: "PROGRESS", message })),
	);
});

test("runtimeBlobUploadAvailable: requires an RS URL alias and owner token", () => {
	assert.equal(runtimeBlobUploadAvailable({}), false);
	assert.equal(
		runtimeBlobUploadAvailable({ PDPP_RS_URL: "http://rs.local" }),
		false,
	);
	assert.equal(
		runtimeBlobUploadAvailable({ PDPP_OWNER_TOKEN: "token" }),
		false,
	);
	assert.equal(
		runtimeBlobUploadAvailable({
			PDPP_RS_URL: "http://rs.local",
			PDPP_OWNER_TOKEN: "token",
		}),
		true,
	);
	assert.equal(
		runtimeBlobUploadAvailable({
			RS_URL: "http://rs.local",
			PDPP_OWNER_TOKEN: "token",
		}),
		true,
	);
});

test("validateAttachmentHydrationPreflight: fails attachment hydration before mailbox work when prerequisites are missing", () => {
	assert.equal(
		validateAttachmentHydrationPreflight({
			env: {},
			requested: makeRequested(["attachments"]),
		}),
		"Gmail attachment hydration requires GMAIL_ADDRESS or GMAIL_USER",
	);
	assert.equal(
		validateAttachmentHydrationPreflight({
			env: { GMAIL_ADDRESS: "me@example.com" },
			requested: makeRequested(["attachments"]),
		}),
		"Gmail attachment hydration requires GOOGLE_APP_PASSWORD_PDPP or GMAIL_APP_PASSWORD",
	);
	assert.equal(
		validateAttachmentHydrationPreflight({
			env: {
				GMAIL_ADDRESS: "me@example.com",
				GOOGLE_APP_PASSWORD_PDPP: "app-password",
			},
			requested: makeRequested(["attachments"]),
		}),
		"blob upload unavailable: PDPP_RS_URL and PDPP_OWNER_TOKEN must be provided by the runtime",
	);
	assert.equal(
		validateAttachmentHydrationPreflight({
			env: {
				GMAIL_ADDRESS: "me@example.com",
				GOOGLE_APP_PASSWORD_PDPP: "app-password",
				PDPP_OWNER_TOKEN: "owner-token",
				PDPP_RS_URL: "http://127.0.0.1:4000",
			},
			requested: makeRequested(["attachments"]),
		}),
		null,
	);
});

test("validateAttachmentHydrationPreflight: no attachment hydration means no upload requirement", () => {
	// Attachment history is walked whenever attachments are in scope, so there
	// is no separate opt-in backfill that hydrates outside the requested scope.
	assert.equal(
		validateAttachmentHydrationPreflight({
			env: {
				GMAIL_ADDRESS: "me@example.com",
				GOOGLE_APP_PASSWORD_PDPP: "app-password",
			},
			requested: makeRequested(["messages"]),
		}),
		null,
	);
});

test("validateAttachmentHydrationPreflight: pending attachment detail gaps require blob upload config even without explicit backfill", () => {
	assert.equal(
		validateAttachmentHydrationPreflight({
			detailGaps: [
				{
					gap_id: "gap-attachment-1",
					reference_only: true,
					status: "pending",
					stream: "attachments",
				},
			],
			env: {
				GMAIL_ADDRESS: "me@example.com",
				GOOGLE_APP_PASSWORD_PDPP: "app-password",
			},
			requested: makeRequested(["messages"]),
		}),
		"blob upload unavailable: PDPP_RS_URL and PDPP_OWNER_TOKEN must be provided by the runtime",
	);
});

test("Gmail env aliases prefer Docker names while accepting documented names", () => {
	assert.equal(
		resolveGmailPasswordFromEnv({
			GOOGLE_APP_PASSWORD_PDPP: "docker-password",
			GMAIL_APP_PASSWORD: "docs-password",
		}),
		"docker-password",
	);
	assert.equal(
		resolveGmailPasswordFromEnv({ GMAIL_APP_PASSWORD: "docs-password" }),
		"docs-password",
	);
	assert.equal(resolveGmailPasswordFromEnv({}), null);

	assert.equal(
		resolveGmailAddressFromEnv({
			GMAIL_ADDRESS: "docker@example.com",
			GMAIL_USER: "docs@example.com",
		}),
		"docker@example.com",
	);
	assert.equal(
		resolveGmailAddressFromEnv({ GMAIL_USER: "docs@example.com" }),
		"docs@example.com",
	);
	assert.equal(
		resolveGmailAddressFromEnv({ AMAZON_USERNAME: "amazon@example.com" }),
		"amazon@example.com",
	);
	assert.equal(
		resolveGmailAddressFromEnv({ AMAZON_USERNAME: "not-an-email" }),
		null,
	);
});

/**
 * The reopening-band guards.
 *
 * `backfill.target_uid` and `all_mail.forward_uidnext` split ONE UID space, so
 * they must meet: `target_uid + 1 >= forward_uidnext`. The forward watermark
 * climbs on every run that sees new mail; when the ceiling merely copied itself
 * forward the interval between them reopened continuously and grew without
 * bound. Live evidence: a 297-UID band swallowed two days of mail, was repaired
 * to 0, and measured 2 then 3 within minutes as new mail arrived.
 *
 * Each behavior is pinned separately below so a mutation to one guard reddens
 * on its own rather than being masked by a sibling.
 */

test("runAllMailPasses: first historical page is bounded, durable only at page end, and stays partial", async () => {
	const originalWrite = globalThis.process.stdout.write;
	const protocolMessages: Record<string, unknown>[] = [];
	const fetchRanges: string[] = [];
	globalThis.process.stdout.write = ((data: string): boolean => {
		if (typeof data === "string") {
			try {
				protocolMessages.push(JSON.parse(data) as Record<string, unknown>);
			} catch {
				// Ignore non-protocol output.
			}
		}
		return true;
	}) as typeof process.stdout.write;

	try {
		const client: Pick<
			ImapFlow,
			"close" | "download" | "fetch" | "fetchOne" | "mailbox" | "search"
		> = {
			close: mock.fn(),
			download: () => {
				throw new Error("download must not be called without attachments");
			},
			fetchOne: () => {
				throw new Error("fetchOne must not be called without bodies");
			},
			search: mock.fn(async () => []),
			mailbox: {
				delimiter: "/",
				exists: 1200,
				flags: new Set<string>(),
				path: "[Gmail]/All Mail",
				uidNext: 1201,
				uidValidity: 123n,
			},
			async *fetch(range: string) {
				fetchRanges.push(range);
				for (const uid of [1, 2]) {
					yield makeMsg({ uid, emailId: `msg-${uid}` });
				}
			},
		};

		await runAllMailPasses(
			client,
			makeAllMailMailbox(),
			{},
			{
				emitRecord: async () => true,
				emittedAt: FROZEN_NOW,
				requested: makeRequested(["messages", "message_bodies"]),
			},
		);

		assert.deepEqual(fetchRanges, ["1:500"]);
		const state = protocolMessages.find(
			(message) => message.type === "STATE" && message.stream === "messages",
		);
		assert.ok(state, "the successful page emits one messages STATE");
		assert.deepEqual((state.cursor as Record<string, unknown>).backfill, {
			backfilled_through_uid: 500,
			completed_at: null,
			target_uid: 1200,
			uidvalidity: 123,
		});
		assert.equal(
			protocolMessages.some(
				(message) =>
					message.type === "DETAIL_COVERAGE" && message.stream === "messages",
			),
			true,
			"a bounded page proves its own detail coverage even while historical continuation remains",
		);
		assert.equal(
			protocolMessages.find(
				(message) =>
					message.type === "DETAIL_COVERAGE" &&
					message.stream === "message_bodies",
			),
			undefined,
			"message_bodies is declared `state_stream: messages` in the manifest, so it must emit NO DETAIL_COVERAGE — " +
				"the runtime rejects the whole run if it does, and the only counts available here are the parent " +
				"message pass's, which would fabricate covered == considered for bodies never hydrated",
		);
		assert.deepEqual(
			protocolMessages.find(
				(message) =>
					message.type === "SKIP_RESULT" && message.stream === "messages",
			),
			{
				type: "SKIP_RESULT",
				stream: "messages",
				reason: "historical_backfill_pending",
				message:
					"This bounded page completed; more historical work remains and will be retried by the next run.",
				continuation: {
					boundary: "123",
					considered: 2,
					covered: 2,
					owner: "runtime",
					remaining: true,
					slice_start: 1,
					slice_end: 500,
				},
				recovery_hint: { action: "retry_by_runtime", retryable: true },
			},
			"a partial page remains explicitly retryable",
		);
	} finally {
		globalThis.process.stdout.write = originalWrite;
	}
});

/**
 * The manifest — not this test — is the authority on which streams may prove
 * their own coverage. A stream declared with a `state_stream` parent is a
 * static single-parent detail stream: its checkpoint status is projected from
 * that parent's commit outcome, so the runtime rejects the ENTIRE run if such
 * a stream emits DETAIL_COVERAGE (see `validateDetailCoverageAgainstManifest`).
 *
 * This reads the real manifest rather than hard-coding `message_bodies`, so a
 * future stream that gains a `state_stream` parent is covered the day the
 * manifest says so.
 *
 * Regression: a `message_bodies` DETAIL_COVERAGE reporting the PARENT message
 * pass's considered/covered shipped to production and failed every Gmail run
 * with `runtime_error`, driving the scheduler into cooling_off. It was also
 * dishonest on its own terms — it claimed covered == considered for bodies
 * that were never hydrated.
 */
test("runAllMailPasses: no stream the manifest declares with a state_stream parent may emit DETAIL_COVERAGE", async () => {
	const manifest = JSON.parse(
		await readFile(manifestPath("gmail"), "utf8"),
	) as {
		streams?: Array<{ name: string; state_stream?: string }>;
	};
	const stateStreamParented = new Set(
		(manifest.streams || [])
			.filter(
				(stream) =>
					typeof stream.state_stream === "string" &&
					stream.state_stream &&
					stream.state_stream !== stream.name,
			)
			.map((stream) => stream.name),
	);
	assert.ok(
		stateStreamParented.has("message_bodies"),
		"guard precondition: the gmail manifest must still declare message_bodies with a state_stream parent",
	);

	const originalWrite = globalThis.process.stdout.write;
	const protocolMessages: Record<string, unknown>[] = [];
	globalThis.process.stdout.write = ((data: string): boolean => {
		if (typeof data === "string") {
			try {
				protocolMessages.push(JSON.parse(data) as Record<string, unknown>);
			} catch {
				// Ignore non-protocol output.
			}
		}
		return true;
	}) as typeof process.stdout.write;

	try {
		const client: Pick<
			ImapFlow,
			"close" | "download" | "fetch" | "fetchOne" | "mailbox" | "search"
		> = {
			close: mock.fn(),
			download: () => {
				throw new Error("download must not be called without attachments");
			},
			fetchOne: () => {
				throw new Error("fetchOne must not be called without bodies");
			},
			search: mock.fn(async () => []),
			mailbox: {
				delimiter: "/",
				exists: 1200,
				flags: new Set<string>(),
				path: "[Gmail]/All Mail",
				uidNext: 1201,
				uidValidity: 123n,
			},
			// biome-ignore lint/suspicious/useAwait: async generator is required by the ImapFlow fetch shape.
			async *fetch() {
				for (const uid of [1, 2]) {
					yield makeMsg({ uid, emailId: `msg-${uid}` });
				}
			},
		};

		await runAllMailPasses(
			client,
			makeAllMailMailbox(),
			{},
			{
				emitRecord: async () => true,
				emittedAt: FROZEN_NOW,
				requested: makeRequested(["messages", "message_bodies"]),
			},
		);

		const illegal = protocolMessages
			.filter((message) => message.type === "DETAIL_COVERAGE")
			.map((message) => message.stream as string)
			.filter((stream) => stateStreamParented.has(stream));
		assert.deepEqual(
			illegal,
			[],
			"these streams emitted DETAIL_COVERAGE despite a manifest-declared state_stream parent, which fails the " +
				`whole run at runtime: ${illegal.join(", ")}`,
		);
	} finally {
		globalThis.process.stdout.write = originalWrite;
	}
});

test("runAllMailPasses: scheduled runs advance historical pages while forwarding new mail", async () => {
	const originalWrite = globalThis.process.stdout.write;
	const protocolMessages: Record<string, unknown>[] = [];
	const fetchRanges: string[] = [];
	const emittedRecords: Array<{
		data: Record<string, unknown>;
		stream: string;
	}> = [];
	let uidNext = 1201;
	globalThis.process.stdout.write = ((data: string): boolean => {
		if (typeof data === "string") {
			try {
				protocolMessages.push(JSON.parse(data) as Record<string, unknown>);
			} catch {
				// Ignore non-protocol output.
			}
		}
		return true;
	}) as typeof process.stdout.write;

	try {
		const client: Pick<
			ImapFlow,
			"close" | "download" | "fetch" | "fetchOne" | "mailbox" | "search"
		> = {
			close: mock.fn(),
			download: () => {
				throw new Error("download must not be called without attachments");
			},
			fetchOne: () => {
				throw new Error("fetchOne must not be called without bodies");
			},
			search: mock.fn(async () => []),
			mailbox: {
				delimiter: "/",
				exists: 1200,
				flags: new Set<string>(),
				path: "[Gmail]/All Mail",
				get uidNext() {
					return uidNext;
				},
				uidValidity: 123n,
			},
			async *fetch(range: string) {
				fetchRanges.push(range);
				// Range-respecting: each page yields a UID inside its own range.
				let ids: number[] = [Number(range.split(":")[0])];
				if (range === "1201:1300") {
					ids = [1250];
				}
				for (const uid of ids) {
					yield makeMsg({ uid, emailId: `msg-${uid}` });
				}
			},
		};

		const run = async (state: Record<string, unknown>) => {
			protocolMessages.length = 0;
			fetchRanges.length = 0;
			await runAllMailPasses(client, makeAllMailMailbox(), state, {
				emitRecord: (stream, data) => {
					emittedRecords.push({ data, stream });
					return Promise.resolve(true);
				},
				emittedAt: FROZEN_NOW,
				requested: makeRequested(["messages"]),
			});
			const stateMessage = protocolMessages.find(
				(message) => message.type === "STATE" && message.stream === "messages",
			);
			assert.ok(
				stateMessage,
				"each scheduled run commits a messages state at a page boundary",
			);
			return stateMessage.cursor as Record<string, unknown>;
		};

		const first = await run({});
		assert.deepEqual(fetchRanges, ["1:500"]);
		assert.deepEqual(first.all_mail, {
			// The mailbox's own EXISTS count rides along so the next run in this
			// epoch can prove the inventory did not shrink (see
			// all-mail-inventory.test.ts).
			exists: 1200,
			forward_uidnext: 1201,
			highest_modseq: null,
			// No delta-pass skip this run (first run is a full resync — runDeltaPass
			// is a no-op), so the hold-back streak stays at its zero default.
			delta_holdback_runs: 0,
			uidnext: 501,
			uidvalidity: 123,
		});
		uidNext = 1301;

		const second = await run({ messages: first });
		assert.deepEqual(fetchRanges, ["501:1000", "1201:1300"]);
		assert.equal((second.all_mail as Record<string, unknown>).uidnext, 1001);
		assert.equal(
			(second.all_mail as Record<string, unknown>).forward_uidnext,
			1301,
		);
		assert.ok(
			emittedRecords.some(
				(record) =>
					record.stream === "messages" && record.data.id === "msg-1250",
			),
			"new mail in the forward range is collected while historical backfill is pending",
		);
		const messagesCoverage = protocolMessages.find(
			(message) =>
				message.type === "DETAIL_COVERAGE" && message.stream === "messages",
		);
		assert.deepEqual(
			messagesCoverage && {
				considered: messagesCoverage.considered,
				covered: messagesCoverage.covered,
			},
			{ considered: 2, covered: 2 },
			"the messages DETAIL_COVERAGE must sum BOTH the historical page (msg-1001) and the forward page " +
				"(msg-1250) — reporting only the historical pass's considered/covered undercounts the denominator " +
				"against the raw collected-record total, the same class of defect message_bodies's coverage " +
				"(which does sum both passes) avoids",
		);

		// The continuation must describe the SAME page the DETAIL_COVERAGE fact
		// describes. The runtime's isHealthyBoundedContinuation
		// (reference-implementation/server/continuation-proof.ts) admits a bounded
		// page only when continuation.considered === fact.considered AND
		// continuation.covered === fact.covered. When the coverage fact summed both
		// passes but the continuation reported historical-only counts, the pair
		// desynced by exactly the forward-pass count on every run that carried new
		// mail alongside a pending backfill (observed live: fact 52/52 vs
		// continuation 51/51), the identity check failed, and the stream fell
		// through to retryable_gap instead of deriving complete.
		const messagesSkip = protocolMessages.find(
			(message) =>
				message.type === "SKIP_RESULT" && message.stream === "messages",
		);
		const skipContinuation = messagesSkip?.continuation as
			| Record<string, unknown>
			| undefined;
		assert.equal(
			messagesSkip?.reason,
			"historical_backfill_pending",
			"a page with historical work remaining still emits its bounded continuation",
		);
		assert.deepEqual(
			skipContinuation && {
				considered: skipContinuation.considered,
				covered: skipContinuation.covered,
			},
			{
				considered: messagesCoverage?.considered,
				covered: messagesCoverage?.covered,
			},
			"the historical continuation skip must carry the SAME considered/covered as the messages " +
				"DETAIL_COVERAGE fact — the runtime's isHealthyBoundedContinuation requires that identity, so any " +
				"drift between the two emissions silently degrades a complete stream to a retryable_gap",
		);

		// End-to-end: the runtime predicate itself accepts the synced pair, and
		// would reject the historical-only counts the desynced code emitted.
		const isHealthyBoundedContinuation = (
			fact: { considered: number; covered: number },
			cont: { considered: number; covered: number },
		) =>
			cont.considered === fact.considered &&
			cont.covered === fact.covered &&
			fact.considered === fact.covered;
		assert.equal(
			isHealthyBoundedContinuation(
				{
					considered: messagesCoverage?.considered as number,
					covered: messagesCoverage?.covered as number,
				},
				{
					considered: skipContinuation?.considered as number,
					covered: skipContinuation?.covered as number,
				},
			),
			true,
			"the emitted fact/continuation pair satisfies the runtime's bounded-continuation identity check",
		);
		assert.equal(
			isHealthyBoundedContinuation(
				{ considered: 2, covered: 2 },
				{ considered: 1, covered: 1 },
			),
			false,
			"control: the historical-only counts the regression emitted do NOT satisfy that check",
		);

		// Run 2 raised the forward watermark to 1301, so UIDs 1201..1300 are now
		// below where the forward walk resumes. The historical ceiling must have
		// risen with it (1200 -> 1300) or that interval belongs to neither walk.
		// Before the ceiling tracked the watermark this read "1001:1200", leaving
		// 1201..1300 orphaned — the live 297-UID band in miniature.
		assert.equal(
			(second.backfill as Record<string, unknown>).target_uid,
			1300,
			"the historical ceiling must rise to meet the forward watermark, not stay frozen at 1200",
		);

		// The forward lane already covered 1201..1300, so the history walk stops
		// below it: no UID is walked twice, and there is no new mail to forward.
		const third = await run({ messages: second });
		assert.deepEqual(fetchRanges, ["1001:1200"]);
		assert.equal((third.all_mail as Record<string, unknown>).uidnext, 1301);
		assert.equal(
			typeof (third.backfill as Record<string, unknown>).completed_at,
			"string",
		);
		assert.equal(
			(third.backfill as Record<string, unknown>).backfilled_through_uid,
			1300,
			"the walk closes the whole space up to the forward resume point",
		);
	} finally {
		globalThis.process.stdout.write = originalWrite;
	}
});

/**
 * The band must not reopen after the historical walk has FINISHED.
 *
 * This is the live shape: the backfill reaches its ceiling, `completed_at` is
 * stamped, and then mail keeps arriving. A completed walk that copies its stale
 * ceiling forward leaves every newly-arrived UID above the ceiling and below the
 * forward watermark — belonging to neither walk. That is precisely how the
 * repaired live cursor went from band=0 to band=2 to band=3 within minutes.
 *
 * The end-to-end path is what makes this test necessary: the pure resolver is
 * correct in isolation, but the completed-walk branch in `runAllMailPasses`
 * chooses whether to consult it at all.
 */
test("runAllMailPasses: a completed historical walk reopens for new mail instead of freezing its ceiling", async () => {
	const originalWrite = globalThis.process.stdout.write;
	const protocolMessages: Record<string, unknown>[] = [];
	const fetchRanges: string[] = [];
	let uidNext = 1201;
	globalThis.process.stdout.write = ((data: string): boolean => {
		if (typeof data === "string") {
			try {
				protocolMessages.push(JSON.parse(data) as Record<string, unknown>);
			} catch {
				// Ignore non-protocol output.
			}
		}
		return true;
	}) as typeof process.stdout.write;

	try {
		const client: Pick<
			ImapFlow,
			"close" | "download" | "fetch" | "fetchOne" | "mailbox" | "search"
		> = {
			close: mock.fn(),
			download: () => {
				throw new Error("download must not be called without attachments");
			},
			fetchOne: () => {
				throw new Error("fetchOne must not be called without bodies");
			},
			search: mock.fn(async () => []),
			mailbox: {
				delimiter: "/",
				exists: 1200,
				flags: new Set<string>(),
				path: "[Gmail]/All Mail",
				get uidNext() {
					return uidNext;
				},
				uidValidity: 123n,
			},
			// biome-ignore lint/suspicious/useAwait: async generator is required by the ImapFlow fetch shape.
			async *fetch(range: string) {
				fetchRanges.push(range);
				yield makeMsg({ uid: 1, emailId: "seed" });
			},
		};

		const run = async (state: Record<string, unknown>) => {
			protocolMessages.length = 0;
			fetchRanges.length = 0;
			await runAllMailPasses(client, makeAllMailMailbox(), state, {
				emitRecord: () => Promise.resolve(true),
				emittedAt: FROZEN_NOW,
				requested: makeRequested(["messages"]),
			});
			const stateMessage = protocolMessages.find(
				(message) => message.type === "STATE" && message.stream === "messages",
			);
			assert.ok(stateMessage, "each run commits a messages state");
			return stateMessage.cursor as Record<string, unknown>;
		};

		// Drive the walk all the way to completion against a still mailbox.
		let cursor = await run({});
		for (let i = 0; i < 4; i += 1) {
			cursor = await run({ messages: cursor });
		}
		const settled = cursor.backfill as Record<string, unknown>;
		assert.equal(
			typeof settled.completed_at,
			"string",
			"precondition: the historical walk has finished",
		);
		assert.equal(
			settled.target_uid,
			1200,
			"precondition: the ceiling settled at the mailbox it walked",
		);
		assert.equal(settled.backfilled_through_uid, 1200);

		// Now mail arrives. The forward watermark will move to 1301.
		uidNext = 1301;
		const afterNewMail = await run({ messages: cursor });
		const reopened = afterNewMail.backfill as Record<string, unknown>;
		const allMail = afterNewMail.all_mail as Record<string, unknown>;

		assert.equal(
			allMail.forward_uidnext,
			1301,
			"precondition: the forward watermark climbs with the mailbox",
		);
		// THE INVARIANT: ceiling + 1 >= resume. With a frozen ceiling of 1200 this
		// is 1201 >= 1301 — false — and UIDs 1201..1300 belong to neither walk.
		assert.ok(
			(reopened.target_uid as number) + 1 >=
				(allMail.forward_uidnext as number),
			`the two walks must meet: ceiling ${String(reopened.target_uid)} + 1 must reach ` +
				`forward resume ${String(allMail.forward_uidnext)}, otherwise the band between them is orphaned`,
		);
		assert.equal(
			reopened.target_uid,
			1300,
			"the ceiling reopens to cover the newly-arrived UIDs",
		);
		// The reopened ceiling puts 1201..1300 back in the historical walk's remit,
		// and because that band is smaller than one page the walk consumes it in
		// this same run rather than deferring it. What must never happen is a
		// DECREASE: that would discard walked work and re-fetch it.
		assert.ok(
			(reopened.backfilled_through_uid as number) >=
				(settled.backfilled_through_uid as number),
			`reopening must never rewind progress: ${String(reopened.backfilled_through_uid)} < ` +
				`${String(settled.backfilled_through_uid)} would re-fetch already-walked UIDs`,
		);
		assert.equal(
			reopened.backfilled_through_uid,
			1300,
			"the reopened band is smaller than a page, so this run closes it outright",
		);
		// Having closed the whole reopened band, the walk is complete again — and
		// now genuinely contiguous with the forward watermark.
		assert.equal(
			typeof reopened.completed_at,
			"string",
			"a walk that reached its reopened ceiling is complete",
		);
	} finally {
		globalThis.process.stdout.write = originalWrite;
	}
});

test("parseDeltaHoldbackRuns: tolerates missing/malformed input, otherwise passes a valid non-negative integer through", () => {
	assert.equal(
		parseDeltaHoldbackRuns(undefined),
		0,
		"absent — pre-counter state",
	);
	assert.equal(parseDeltaHoldbackRuns(null), 0);
	assert.equal(parseDeltaHoldbackRuns("2"), 0, "non-number");
	assert.equal(parseDeltaHoldbackRuns(-1), 0, "negative");
	assert.equal(parseDeltaHoldbackRuns(1.5), 0, "fractional");
	assert.equal(parseDeltaHoldbackRuns(Number.NaN), 0);
	assert.equal(parseDeltaHoldbackRuns(Number.POSITIVE_INFINITY), 0);
	assert.equal(parseDeltaHoldbackRuns(0), 0, "a valid zero passes through");
	assert.equal(
		parseDeltaHoldbackRuns(2),
		2,
		"a valid positive integer passes through",
	);
});

test("resolveDeltaCursorAdvance: no skip always advances to the live value and resets the streak to 0, regardless of prior streak", () => {
	assert.deepEqual(
		resolveDeltaCursorAdvance({
			liveHighestModseq: 500,
			priorHoldbackRuns: 0,
			priorModseq: 400,
			skippedAnyMessage: false,
		}),
		{ highestModseq: 500, holdbackRuns: 0 },
	);
	// Proves "no counter growth on clean runs" at the unit level: even a
	// nonzero prior streak resets the instant a run has nothing to skip.
	assert.deepEqual(
		resolveDeltaCursorAdvance({
			liveHighestModseq: 500,
			priorHoldbackRuns: 5,
			priorModseq: 400,
			skippedAnyMessage: false,
		}),
		{ highestModseq: 500, holdbackRuns: 0 },
	);
});

test("resolveDeltaCursorAdvance: a skip holds the prior modseq and climbs the streak", () => {
	assert.deepEqual(
		resolveDeltaCursorAdvance({
			liveHighestModseq: 500,
			priorHoldbackRuns: 0,
			priorModseq: 400,
			skippedAnyMessage: true,
		}),
		{ highestModseq: 400, holdbackRuns: 1 },
		"first held-back run",
	);
	assert.deepEqual(
		resolveDeltaCursorAdvance({
			liveHighestModseq: 500,
			priorHoldbackRuns: 1,
			priorModseq: 400,
			skippedAnyMessage: true,
		}),
		{ highestModseq: 400, holdbackRuns: 2 },
		"second held-back run",
	);
});

test("resolveDeltaCursorAdvance: an unowned change holds the prior modseq however long it lasts", () => {
	// Moving past a change nobody owns loses it for good, so no run count
	// releases the hold; only the ledger taking the change does.
	for (const priorHoldbackRuns of [2, 10]) {
		assert.deepEqual(
			resolveDeltaCursorAdvance({
				liveHighestModseq: 500,
				priorHoldbackRuns,
				priorModseq: 400,
				skippedAnyMessage: true,
			}),
			{ highestModseq: 400, holdbackRuns: priorHoldbackRuns + 1 },
		);
	}
});

/** `[uid, streams]` for each retry-debt entry in a messages STATE cursor. */
function debtOf(cursor: Record<string, unknown>): [number, string[]][] {
	const progress = cursor.progress as {
		debt: { uid: number; streams: string[] }[];
	};
	return progress.debt.map((d) => [d.uid, d.streams]);
}

// ─── Invariant: a skipped delta change has a durable owner ───────────────
//
// REGRESSION EVIDENCE. A change the delta pass sees but cannot apply (failed
// snippet re-fetch, or an incomplete FETCH) falls permanently behind once
// `highest_modseq` moves past it: `changedSince` on the next run only
// re-surfaces a message whose modseq moves AGAIN, which may never happen.
// The change is therefore owed to the progress ledger as `messages` retry
// debt before the cursor advances, and the debt retry writes the whole row.
test("runAllMailPasses: a failed delta snippet re-fetch owes the change as messages debt, and the debt retry lands the full record", async () => {
	const originalWrite = globalThis.process.stdout.write;
	const protocolMessages: Record<string, unknown>[] = [];
	const emitted: Array<{ data: Record<string, unknown>; stream: string }> = [];
	globalThis.process.stdout.write = ((data: string): boolean => {
		if (typeof data === "string") {
			try {
				protocolMessages.push(JSON.parse(data) as Record<string, unknown>);
			} catch {
				// Ignore non-protocol output.
			}
		}
		return true;
	}) as typeof process.stdout.write;

	try {
		let highestModseqLive = 100n;
		let fetchOneOutcome: "fail" | "succeed" = "fail";
		let deltaLabels = new Set<string>(["\\Inbox"]);
		let walkYieldsMessage = false;
		const plainLeaf: MessageStructureObject = {
			type: "text/plain",
			encoding: "7bit",
			parameters: { charset: "utf-8" },
		};

		const client: Pick<
			ImapFlow,
			"close" | "download" | "fetch" | "fetchOne" | "mailbox" | "search"
		> = {
			close: mock.fn(),
			download: () => {
				throw new Error("download must not be called without attachments");
			},
			fetchOne: () => {
				if (fetchOneOutcome === "fail") {
					return Promise.reject(new Error("synthetic transient IMAP error"));
				}
				return Promise.resolve({
					seq: 1,
					uid: 1,
					bodyParts: new Map([["1", Buffer.from("A fresh real snippet")]]),
				});
			},
			search: mock.fn(() => Promise.resolve([])),
			mailbox: {
				delimiter: "/",
				exists: 1,
				flags: new Set<string>(),
				path: "[Gmail]/All Mail",
				uidNext: 2,
				uidValidity: 123n,
				get highestModseq() {
					return highestModseqLive;
				},
			},
			// biome-ignore lint/suspicious/useAwait: async generator is required by the ImapFlow fetch shape.
			async *fetch(
				_range: string,
				_query: unknown,
				options?: { changedSince?: bigint },
			) {
				if (options?.changedSince === undefined && !walkYieldsMessage) {
					// The first walk yields nothing, so the delta pass is this
					// test's only moving part until the debt retry.
					return;
				}
				yield makeMsg({
					uid: 1,
					emailId: "gmmsgid-delta-track",
					envelope: {
						date: new Date("2026-04-20T10:00:00.000Z"),
						subject: "Test subject",
						from: [{ name: "Alice", address: "alice@example.com" }],
						to: [],
						cc: [],
						bcc: [],
						messageId: "<msg-abc@example.com>",
					},
					labels: deltaLabels,
					bodyStructure: plainLeaf,
				});
			},
		};

		const run = async (
			state: Record<string, unknown>,
		): Promise<Record<string, unknown>> => {
			protocolMessages.length = 0;
			await runAllMailPasses(client, makeAllMailMailbox(), state, {
				emitRecord: (stream, data) => {
					emitted.push({ data, stream });
					return Promise.resolve(true);
				},
				emittedAt: FROZEN_NOW,
				requested: makeRequested(["messages"]),
			});
			const stateMessage = protocolMessages.find(
				(message) => message.type === "STATE" && message.stream === "messages",
			);
			assert.ok(stateMessage, "each run commits a messages state");
			return stateMessage.cursor as Record<string, unknown>;
		};

		// Run 1: first run (full resync) — establishes the highest_modseq
		// baseline. `runDeltaPass` does not run on a full resync, so nothing can
		// be skipped and the live value (100) is simply adopted.
		const afterRun1 = await run({});
		assert.equal(
			(afterRun1.all_mail as Record<string, unknown>).highest_modseq,
			100,
			"first run adopts the live highestModseq as the baseline",
		);
		assert.equal(
			(afterRun1.all_mail as Record<string, unknown>).delta_holdback_runs,
			0,
			"no skip on a full resync — the hold-back streak starts at 0",
		);

		// Run 2: mail state advances (live highestModseq 100 -> 150) and the
		// tracked message's snippet re-fetch FAILS. No record for it may emit
		// (see runDeltaPass's own tests). The change is owed as debt, so the
		// cursor can advance to the live value without losing it.
		highestModseqLive = 150n;
		fetchOneOutcome = "fail";
		emitted.length = 0;
		const afterRun2 = await run({ messages: afterRun1 });
		assert.equal(
			emitted.filter((r) => r.stream === "messages").length,
			0,
			"the failed re-fetch emits no messages record this run",
		);
		assert.deepEqual(
			debtOf(afterRun2),
			[[1, ["messages"]]],
			"the skipped change is owed as messages debt",
		);
		assert.equal(
			(afterRun2.all_mail as Record<string, unknown>).highest_modseq,
			150,
			"an owed change does not hold the cursor back",
		);
		assert.equal(
			(afterRun2.all_mail as Record<string, unknown>).delta_holdback_runs,
			0,
		);

		// Run 3: the debt retry reads the message again. This time the read
		// SUCCEEDS and the labels have also changed since run 1: the full
		// record (new labels AND the fresh snippet) lands and the debt settles.
		walkYieldsMessage = true;
		fetchOneOutcome = "succeed";
		deltaLabels = new Set<string>(["\\Inbox", "\\Important"]);
		emitted.length = 0;
		const afterRun3 = await run({ messages: afterRun2 });
		const recovered = emitted.find((r) => r.stream === "messages");
		assert.ok(recovered, "the debt retry emits the full record");
		assert.equal(recovered.data.snippet, "A fresh real snippet");
		assert.deepEqual(recovered.data.labels, ["\\Inbox", "\\Important"]);
		assert.deepEqual(debtOf(afterRun3), [], "the debt settles");
		assert.equal(
			(afterRun3.all_mail as Record<string, unknown>).highest_modseq,
			150,
		);
	} finally {
		globalThis.process.stdout.write = originalWrite;
	}
});

// ─── Invariant: a persistently failing change stays owed ─────────────────
//
// A message that fails its snippet re-fetch EVERY run (malformed MIME, a
// message the server always errors on) must not stall highest_modseq
// forever, and it must not go silent either. Its change stays owed as
// messages debt, and its retryable DETAIL_GAP keeps the miss visible, while
// the cursor advances every run.
test("runAllMailPasses: a persistently failing delta snippet re-fetch stays owed as debt and a gap while the cursor advances", async () => {
	const originalWrite = globalThis.process.stdout.write;
	const protocolMessages: Record<string, unknown>[] = [];
	globalThis.process.stdout.write = ((data: string): boolean => {
		if (typeof data === "string") {
			try {
				protocolMessages.push(JSON.parse(data) as Record<string, unknown>);
			} catch {
				// Ignore non-protocol output.
			}
		}
		return true;
	}) as typeof process.stdout.write;

	try {
		let highestModseqLive = 100n;
		const plainLeaf: MessageStructureObject = {
			type: "text/plain",
			encoding: "7bit",
			parameters: { charset: "utf-8" },
		};

		const client: Pick<
			ImapFlow,
			"close" | "download" | "fetch" | "fetchOne" | "mailbox" | "search"
		> = {
			close: mock.fn(),
			download: () => {
				throw new Error("download must not be called without attachments");
			},
			// ALWAYS fails — the persistently-broken message this test models.
			fetchOne: () =>
				Promise.reject(new Error("synthetic persistent IMAP error")),
			search: mock.fn(() => Promise.resolve([])),
			mailbox: {
				delimiter: "/",
				exists: 1,
				flags: new Set<string>(),
				path: "[Gmail]/All Mail",
				uidNext: 2,
				uidValidity: 123n,
				get highestModseq() {
					return highestModseqLive;
				},
			},
			// biome-ignore lint/suspicious/useAwait: async generator is required by the ImapFlow fetch shape.
			async *fetch() {
				yield makeMsg({
					uid: 1,
					emailId: "gmmsgid-persistent-fail",
					bodyStructure: plainLeaf,
				});
			},
		};

		const run = async (
			state: Record<string, unknown>,
		): Promise<Record<string, unknown>> => {
			protocolMessages.length = 0;
			await runAllMailPasses(client, makeAllMailMailbox(), state, {
				emitRecord: () => Promise.resolve(true),
				emittedAt: FROZEN_NOW,
				requested: makeRequested(["messages"]),
			});
			const stateMessage = protocolMessages.find(
				(message) => message.type === "STATE" && message.stream === "messages",
			);
			assert.ok(stateMessage, "each run commits a messages state");
			return stateMessage.cursor as Record<string, unknown>;
		};
		const gapForThisRun = (): Record<string, unknown> | undefined =>
			protocolMessages.find(
				(m) =>
					m.type === "DETAIL_GAP" &&
					m.stream === "messages" &&
					(m.detail_locator as Record<string, unknown> | undefined)
						?.message_id === "gmmsgid-persistent-fail",
			);

		// Run 1: baseline (full resync — runDeltaPass is a no-op). The walk's
		// own body read fails, so the UID is owed from the start.
		const afterRun1 = await run({});
		assert.equal(
			(afterRun1.all_mail as Record<string, unknown>).highest_modseq,
			100,
		);
		assert.deepEqual(debtOf(afterRun1), [[1, ["messages"]]]);

		// Runs 2 to 4: the message fails again each time. The cursor adopts
		// the live value every run, and the change stays owed and visible.
		highestModseqLive = 999n;
		let state = afterRun1;
		for (const n of [2, 3, 4]) {
			state = await run({ messages: state });
			assert.equal(
				(state.all_mail as Record<string, unknown>).highest_modseq,
				999,
				`run ${n}: the cursor advances`,
			);
			assert.equal(
				(state.all_mail as Record<string, unknown>).delta_holdback_runs,
				0,
			);
			assert.deepEqual(
				debtOf(state),
				[[1, ["messages"]]],
				`run ${n}: the change stays owed`,
			);
			assert.ok(
				gapForThisRun(),
				`run ${n}: a retryable gap is recorded for the failing message`,
			);
		}
	} finally {
		globalThis.process.stdout.write = originalWrite;
	}
});

test("runAllMailPasses: attachments-only scope keeps the bounded message lane and forward lane alive", async () => {
	const originalWrite = globalThis.process.stdout.write;
	const protocolMessages: Record<string, unknown>[] = [];
	const fetchRanges: string[] = [];
	let uidNext = 1201;
	globalThis.process.stdout.write = ((data: string): boolean => {
		if (typeof data === "string") {
			try {
				protocolMessages.push(JSON.parse(data) as Record<string, unknown>);
			} catch {
				// Ignore non-protocol output.
			}
		}
		return true;
	}) as typeof process.stdout.write;

	try {
		const client: Pick<
			ImapFlow,
			"close" | "download" | "fetch" | "fetchOne" | "mailbox" | "search"
		> = {
			close: mock.fn(),
			download: () => {
				throw new Error("download must not be called without attachment parts");
			},
			fetchOne: () => {
				throw new Error("fetchOne must not be called without message bodies");
			},
			search: mock.fn(async () => []),
			mailbox: {
				delimiter: "/",
				exists: 1200,
				flags: new Set<string>(),
				path: "[Gmail]/All Mail",
				get uidNext() {
					return uidNext;
				},
				uidValidity: 123n,
			},
			async *fetch(range: string) {
				fetchRanges.push(range);
				yield makeMsg({
					uid: range === "1201:1300" ? 1250 : 1,
					emailId: "attachment-only-message",
					bodyStructure: { type: "text/plain", part: "1" },
				});
			},
		};

		const run = async (state: Record<string, unknown>) => {
			protocolMessages.length = 0;
			fetchRanges.length = 0;
			await runAllMailPasses(client, makeAllMailMailbox(), state, {
				emitRecord: async () => true,
				emittedAt: FROZEN_NOW,
				requested: makeRequested(["attachments"]),
			});
			const stateMessage = protocolMessages.find(
				(message) => message.type === "STATE" && message.stream === "messages",
			);
			assert.ok(
				stateMessage,
				"attachments-only runs retain the messages-owned UID state",
			);
			return stateMessage.cursor as Record<string, unknown>;
		};

		const first = await run({});
		assert.deepEqual(fetchRanges, ["1:500"]);
		assert.equal((first.all_mail as Record<string, unknown>).uidnext, 501);
		assert.equal(
			(first.all_mail as Record<string, unknown>).forward_uidnext,
			1201,
		);

		uidNext = 1301;
		const second = await run({ messages: first });
		assert.deepEqual(fetchRanges, ["501:1000", "1201:1300"]);
		assert.equal(
			(second.all_mail as Record<string, unknown>).forward_uidnext,
			1301,
		);
	} finally {
		globalThis.process.stdout.write = originalWrite;
	}
});

test("runAllMailPasses: threads use the bounded page instead of starving until message history completes", async () => {
	const originalWrite = globalThis.process.stdout.write;
	const protocolMessages: Record<string, unknown>[] = [];
	const fetchRanges: string[] = [];
	const emittedStreams: string[] = [];
	globalThis.process.stdout.write = ((data: string): boolean => {
		if (typeof data === "string") {
			try {
				protocolMessages.push(JSON.parse(data) as Record<string, unknown>);
			} catch {
				// Ignore non-protocol output.
			}
		}
		return true;
	}) as typeof process.stdout.write;

	try {
		const client: Pick<
			ImapFlow,
			"close" | "download" | "fetch" | "fetchOne" | "mailbox" | "search"
		> = {
			close: mock.fn(),
			download: () => {
				throw new Error("download must not be called without attachments");
			},
			fetchOne: () => {
				throw new Error("fetchOne must not be called without bodies");
			},
			search: mock.fn(async () => []),
			mailbox: {
				delimiter: "/",
				exists: 1200,
				flags: new Set<string>(),
				path: "[Gmail]/All Mail",
				uidNext: 1201,
				uidValidity: 123n,
			},
			async *fetch(range: string) {
				fetchRanges.push(range);
				yield makeMsg({
					uid: 1,
					emailId: "thread-message",
					threadId: "thread-1",
				});
			},
		};

		await runAllMailPasses(
			client,
			makeAllMailMailbox(),
			{},
			{
				emitRecord: (stream) => {
					emittedStreams.push(stream);
					return Promise.resolve(true);
				},
				emittedAt: FROZEN_NOW,
				requested: makeRequested(["threads"]),
			},
		);

		// One bounded metadata page, then one FETCH of the thread's members.
		assert.deepEqual(fetchRanges, ["1:500", "1"]);
		assert.equal(
			fetchRanges.includes("1:*"),
			false,
			"thread work must not reopen a monolithic scan",
		);
		assert.ok(
			emittedStreams.includes("threads"),
			"a bounded page emits thread records immediately",
		);
		assert.ok(
			protocolMessages.some(
				(message) => message.type === "STATE" && message.stream === "threads",
			),
			"thread fingerprints advance at the same bounded page boundary",
		);
		assert.equal(
			protocolMessages.some(
				(message) =>
					message.type === "DETAIL_COVERAGE" && message.stream === "threads",
			),
			true,
			"a bounded thread page proves its own detail coverage even while historical continuation remains",
		);
		assert.deepEqual(
			protocolMessages.find(
				(message) =>
					message.type === "SKIP_RESULT" && message.stream === "threads",
			),
			{
				type: "SKIP_RESULT",
				stream: "threads",
				reason: "historical_backfill_pending",
				message:
					"This bounded page completed; more historical work remains and will be retried by the next run.",
				continuation: {
					boundary: "123",
					considered: 1,
					covered: 1,
					owner: "runtime",
					remaining: true,
					slice_start: 1,
					slice_end: 500,
				},
				recovery_hint: { action: "retry_by_runtime", retryable: true },
			},
			"bounded thread work remains explicitly retryable",
		);
	} finally {
		globalThis.process.stdout.write = originalWrite;
	}
});

test("runAllMailPasses: a poison historical message becomes a terminal skip and advances once", async () => {
	const originalWrite = globalThis.process.stdout.write;
	const protocolMessages: Record<string, unknown>[] = [];
	const fetchRanges: string[] = [];
	globalThis.process.stdout.write = ((data: string): boolean => {
		if (typeof data === "string") {
			try {
				protocolMessages.push(JSON.parse(data) as Record<string, unknown>);
			} catch {
				// Ignore non-protocol output.
			}
		}
		return true;
	}) as typeof process.stdout.write;

	try {
		const client: Pick<
			ImapFlow,
			"close" | "download" | "fetch" | "fetchOne" | "mailbox" | "search"
		> = {
			close: mock.fn(),
			download: () => {
				throw new Error("download must not be called without attachments");
			},
			fetchOne: () => {
				throw new Error("fetchOne must not be called without bodies");
			},
			search: mock.fn(async () => []),
			mailbox: {
				delimiter: "/",
				exists: 1200,
				flags: new Set<string>(),
				path: "[Gmail]/All Mail",
				uidNext: 1201,
				uidValidity: 123n,
			},
			async *fetch(range: string) {
				fetchRanges.push(range);
				yield makeMsg({ uid: 77, emailId: "" });
			},
		};

		await runAllMailPasses(
			client,
			makeAllMailMailbox(),
			{},
			{
				emitRecord: () => Promise.resolve(true),
				emittedAt: FROZEN_NOW,
				requested: makeRequested(["messages"]),
			},
		);

		const skip = protocolMessages.find(
			(message) => message.type === "SKIP_RESULT",
		);
		assert.equal(skip?.reason, "historical_message_unaccounted");
		assert.deepEqual(fetchRanges, ["1:500"]);
		assert.ok(
			protocolMessages.some(
				(message) => message.type === "STATE" && message.stream === "messages",
			),
			"the terminal skip is durable evidence, so the same poison UID cannot replay forever",
		);
	} finally {
		globalThis.process.stdout.write = originalWrite;
	}
});

test("runAllMailPasses: interruption during a historical page withholds its cursor for bounded replay", async () => {
	const originalWrite = globalThis.process.stdout.write;
	const protocolMessages: Record<string, unknown>[] = [];
	const fetchRanges: string[] = [];
	globalThis.process.stdout.write = ((data: string): boolean => {
		if (typeof data === "string") {
			try {
				protocolMessages.push(JSON.parse(data) as Record<string, unknown>);
			} catch {
				// Ignore non-protocol output.
			}
		}
		return true;
	}) as typeof process.stdout.write;

	try {
		const client: Pick<
			ImapFlow,
			"close" | "download" | "fetch" | "fetchOne" | "mailbox" | "search"
		> = {
			close: mock.fn(),
			download: () => {
				throw new Error("download must not be called without attachments");
			},
			fetchOne: () => {
				throw new Error("fetchOne must not be called without bodies");
			},
			search: mock.fn(async () => []),
			mailbox: {
				delimiter: "/",
				exists: 1200,
				flags: new Set<string>(),
				path: "[Gmail]/All Mail",
				uidNext: 1201,
				uidValidity: 123n,
			},
			async *fetch(range: string) {
				fetchRanges.push(range);
				yield makeMsg({ uid: 1, emailId: "msg-1" });
				throw new Error("historical page interrupted");
			},
		};

		await assert.rejects(
			() =>
				runAllMailPasses(
					client,
					makeAllMailMailbox(),
					{},
					{
						emitRecord: async () => true,
						emittedAt: FROZEN_NOW,
						requested: makeRequested(["messages"]),
					},
				),
			/historical page interrupted/,
		);
		assert.deepEqual(fetchRanges, ["1:500"]);
		assert.equal(
			protocolMessages.some(
				(message) => message.type === "STATE" && message.stream === "messages",
			),
			false,
			"an interrupted page cannot emit a durable cursor",
		);
	} finally {
		globalThis.process.stdout.write = originalWrite;
	}
});

test("recoverServedAttachmentGaps: a completed historical cursor still drains a served-gap prefix without scanning the mailbox", async () => {
	const oversizedGap: DetailGapStartEntry = {
		gap_id: "gap-served-oversized",
		reference_only: true,
		status: "pending",
		stream: "attachments",
		record_key: "gmmsgid-recovery:1",
		detail_locator: {
			kind: "gmail.attachment_detail",
			attachment_id: "gmmsgid-recovery:1",
			message_id: "gmmsgid-recovery",
			part_index: "1",
		},
	};
	const admittedGap: DetailGapStartEntry = {
		gap_id: "gap-served-admitted",
		reference_only: true,
		status: "pending",
		stream: "attachments",
		record_key: "gmmsgid-recovery:2",
		detail_locator: {
			kind: "gmail.attachment_detail",
			attachment_id: "gmmsgid-recovery:2",
			message_id: "gmmsgid-recovery",
			part_index: "2",
		},
	};
	const attachmentCoverage = makeAttachmentDetailCoverage();
	const recoveryMessage = makeServedRecoveryMsg({
		attachments: [5 * 1024 * 1024, 16],
	});
	const search = mock.fn((query: { emailId?: string }) => {
		assert.equal(query.emailId, "gmmsgid-recovery");
		return Promise.resolve([recoveryMessage.uid ?? 321]);
	});
	const fetchOne = mock.fn((range: string) => {
		assert.equal(range, "321");
		return Promise.resolve(recoveryMessage);
	});
	const client: Pick<ImapFlow, "search" | "fetchOne"> = { search, fetchOne };
	const hydrateAttachmentMock = mock.fn(
		(_msg: FetchMessageObject, attachment: AttachmentRecord) =>
			Promise.resolve(
				hydratedResult({
					...attachment,
					blob_ref: {
						blob_id: `blob-${attachment.id}`,
						mime_type: attachment.content_type ?? "application/octet-stream",
						sha256: `sha-${attachment.id}`,
						size_bytes: attachment.size_bytes ?? 0,
					},
					content_sha256: `sha-${attachment.id}`,
					content_type: attachment.content_type,
					hydration_error: null,
					hydration_status: "hydrated" as const,
					size_bytes: attachment.size_bytes,
				}),
			),
	);
	const harness = makeHarness({
		attachmentCoverage,
		detailGaps: [oversizedGap, admittedGap],
		hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});
	const recoveredAttachmentGapIds =
		harness.deps.recoveredAttachmentGapIds ?? new Set<string>();

	const summary = await recoverServedAttachmentGaps(client, {
		attachmentCoverage,
		detailGaps: [oversizedGap, admittedGap],
		emitProtocol: harness.deps.emitProtocol,
		emitRecord: harness.deps.emitRecord,
		hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
		recoveredAttachmentGapIds,
	});

	assert.equal(
		search.mock.callCount(),
		1,
		"the recovery pass should search the message only once",
	);
	assert.equal(
		fetchOne.mock.callCount(),
		1,
		"the recovery pass should fetch the message only once",
	);
	assert.equal(
		summary.admitted,
		1,
		"the positional prefix should admit only the oversized first gap",
	);
	assert.equal(summary.recovered, 1, "the admitted gap should recover");
	assert.equal(
		hydrateAttachmentMock.mock.callCount(),
		1,
		"the unadmitted gap must remain untouched",
	);

	const recovered = harness.protocolMessages.filter(
		(msg) => msg.type === "DETAIL_GAP_RECOVERED",
	);
	assert.deepEqual(
		recovered.map((msg) => (msg as { gap_id?: string }).gap_id),
		["gap-served-oversized"],
		"only the admitted served gap should be acknowledged as recovered",
	);

	const coverage = buildAttachmentDetailCoverageMessage(attachmentCoverage);
	assert.equal(
		coverage.considered,
		1,
		"only the admitted gap should count toward considered",
	);
	assert.equal(coverage.covered, 1, "the admitted gap hydrated successfully");
	assert.deepEqual(coverage.required_keys, ["gmmsgid-recovery:1"]);
	assert.equal(
		coverage.gap_keys,
		undefined,
		"no retryable gap should be recorded for the recovered attachment",
	);

	const attachments = harness.emitted.filter(
		(record) => record.stream === "attachments",
	);
	assert.equal(
		attachments.length,
		1,
		"the unadmitted gap must not emit an attachment record",
	);
	assert.equal(attachments[0]?.data.id, "gmmsgid-recovery:1");
});

test("recoverServedAttachmentGaps: an oversized first candidate admits exactly one lookup, fetch, and hydration", async () => {
	const originalBudget = process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES;
	process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES = String(
		ATTACHMENT_BACKFILL_PAGE_MIN_BYTES,
	);
	try {
		const messagesById = new Map<string, FetchMessageObject>();
		const servedGaps = Array.from({ length: 256 }, (_unused, index) => {
			const messageId = `gmmsgid-${String(index).padStart(3, "0")}`;
			const message = makeServedRecoveryMsg({
				attachments: [index === 0 ? 2 * 1024 * 1024 : 16],
				emailId: messageId,
				threadId: `gmthrid-${index}`,
				uid: 1000 + index,
			});
			messagesById.set(messageId, message);
			return makeServedRecoveryGap({
				gapId: `gap-${index}`,
				messageId,
				partIndex: 1,
			});
		});
		const search = mock.fn((query: { emailId?: string }) => {
			const message = query.emailId
				? messagesById.get(query.emailId)
				: undefined;
			return Promise.resolve(message ? [message.uid ?? 0] : []);
		});
		const fetchOne = mock.fn((range: string) => {
			const uid = Number(range);
			const message = [...messagesById.values()].find(
				(candidate) => candidate.uid === uid,
			);
			assert.ok(message, `unexpected uid lookup: ${range}`);
			return Promise.resolve(message);
		});
		const hydrateAttachmentMock = mock.fn(
			(_msg: FetchMessageObject, attachment: AttachmentRecord) =>
				Promise.resolve(
					hydratedResult({
						...attachment,
						blob_ref: {
							blob_id: `blob-${attachment.id}`,
							mime_type: attachment.content_type ?? "application/octet-stream",
							sha256: `sha-${attachment.id}`,
							size_bytes: attachment.size_bytes ?? 0,
						},
						content_sha256: `sha-${attachment.id}`,
						content_type: attachment.content_type,
						hydration_error: null,
						hydration_status: "hydrated" as const,
						size_bytes: attachment.size_bytes,
					}),
				),
		);
		const emitHarness = makeRecordingEmit();
		const emitRecord = async (
			stream: string,
			data: Record<string, unknown>,
		): Promise<boolean> => {
			await emitHarness.emitRecord(stream, data);
			return true;
		};

		const diagnostics: string[] = [];
		setConnectorDiagnosticSink((line) => {
			diagnostics.push(line);
		});
		let summary: Awaited<ReturnType<typeof recoverServedAttachmentGaps>>;
		try {
			summary = await recoverServedAttachmentGaps(
				{ search, fetchOne },
				{
					detailGaps: servedGaps,
					emitProtocol: emitHarness.emit,
					emitRecord,
					hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
				},
			);
		} finally {
			setConnectorDiagnosticSink(undefined);
		}

		assert.equal(
			search.mock.callCount(),
			1,
			"the oversized first admitted candidate should stop the probe lane",
		);
		assert.equal(
			fetchOne.mock.callCount(),
			1,
			"the oversized first admitted candidate should fetch once",
		);
		assert.equal(
			hydrateAttachmentMock.mock.callCount(),
			1,
			"the oversized first admitted candidate should hydrate once",
		);
		assert.equal(summary.admitted, 1);
		assert.equal(summary.recovered, 1);
		const progressMessages = emitHarness.protocolMessages.filter(
			(msg) => msg.type === "PROGRESS",
		);
		assert.equal(
			progressMessages.length,
			2,
			"the run should emit hydrating and settled progress for the admitted attempt",
		);
		assert.match(
			progressMessages[0]?.message ?? "",
			/^Retrying 1 attachment that failed earlier/u,
		);
		assert.match(
			progressMessages[1]?.message ?? "",
			/^Recovered 1 of 1 previously failed attachment$/u,
		);
		assert.ok(
			diagnostics.some(
				(line) =>
					line.startsWith(
						"[gmail-diagnostic] served_attachment_recovery_progress ",
					) &&
					line.includes('"admitted":1') &&
					line.includes('"recovered":1') &&
					line.includes('"metadata_lookups":1'),
			),
			`per-attempt metadata_lookups is on the diagnostic line; got ${JSON.stringify(diagnostics)}`,
		);
		assertUserFacingProgress(progressMessages);
	} finally {
		if (originalBudget === undefined) {
			delete process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES;
		} else {
			process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES = originalBudget;
		}
	}
});

test("recoverServedAttachmentGaps: small candidates stop at budget after one rejected probe", async () => {
	const originalBudget = process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES;
	process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES = String(
		ATTACHMENT_BACKFILL_PAGE_MIN_BYTES,
	);
	try {
		const messagesById = new Map<string, FetchMessageObject>();
		const servedGaps = Array.from({ length: 5 }, (_unused, index) => {
			const messageId = `gmmsgid-small-${index}`;
			const message = makeServedRecoveryMsg({
				attachments: [100_000],
				emailId: messageId,
				threadId: `gmthrid-small-${index}`,
				uid: 2000 + index,
			});
			messagesById.set(messageId, message);
			return makeServedRecoveryGap({
				gapId: `gap-small-${index}`,
				messageId,
				partIndex: 1,
			});
		});
		const search = mock.fn((query: { emailId?: string }) => {
			const message = query.emailId
				? messagesById.get(query.emailId)
				: undefined;
			return Promise.resolve(message ? [message.uid ?? 0] : []);
		});
		const fetchOne = mock.fn((range: string) => {
			const uid = Number(range);
			const message = [...messagesById.values()].find(
				(candidate) => candidate.uid === uid,
			);
			assert.ok(message, `unexpected uid lookup: ${range}`);
			return Promise.resolve(message);
		});
		const hydrateAttachmentMock = mock.fn(
			(_msg: FetchMessageObject, attachment: AttachmentRecord) =>
				Promise.resolve(
					hydratedResult({
						...attachment,
						blob_ref: {
							blob_id: `blob-${attachment.id}`,
							mime_type: attachment.content_type ?? "application/octet-stream",
							sha256: `sha-${attachment.id}`,
							size_bytes: attachment.size_bytes ?? 0,
						},
						content_sha256: `sha-${attachment.id}`,
						content_type: attachment.content_type,
						hydration_error: null,
						hydration_status: "hydrated" as const,
						size_bytes: attachment.size_bytes,
					}),
				),
		);
		const emitHarness = makeRecordingEmit();
		const emitRecord = async (
			stream: string,
			data: Record<string, unknown>,
		): Promise<boolean> => {
			await emitHarness.emitRecord(stream, data);
			return true;
		};

		const summary = await recoverServedAttachmentGaps(
			{ search, fetchOne },
			{
				detailGaps: servedGaps,
				emitProtocol: emitHarness.emit,
				emitRecord,
				hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
			},
		);

		assert.equal(
			search.mock.callCount(),
			3,
			"the first rejected overflow probe is the only extra lookup",
		);
		assert.equal(
			fetchOne.mock.callCount(),
			3,
			"the overflow candidate should still require one fetch before stopping",
		);
		assert.equal(
			hydrateAttachmentMock.mock.callCount(),
			2,
			"only the budgeted prefix should hydrate",
		);
		assert.equal(summary.admitted, 2);
		assert.equal(summary.recovered, 2);
		assert.deepEqual(summary, {
			admitted: 2,
			admitted_bytes: 200_000,
			attempted: 3,
			attachment_hydration_failure_outcome: {
				blob_upload_http_4xx: 0,
				blob_upload_http_5xx: 0,
				blob_upload_integrity_failed: 0,
				blob_upload_invalid_response: 0,
				blob_upload_transport_failed: 0,
				imap_download_failed: 0,
				unclassified_failed: 0,
			},
			hydration_failed: 0,
			lookup_miss: 0,
			metadata_lookups: 3,
			recovered: 2,
			run_cap_deferred: 3,
			served: 5,
		});
		const progressMessages = emitHarness.protocolMessages.filter(
			(msg) => msg.type === "PROGRESS",
		);
		assert.equal(
			progressMessages.length,
			4,
			"each admitted attempt should emit hydrating and settled progress",
		);
		assert.deepEqual(
			progressMessages.map((msg) => recoveryPhase(msg.message)),
			["hydrating", "settled", "hydrating", "settled"],
		);
	} finally {
		if (originalBudget === undefined) {
			delete process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES;
		} else {
			process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES = originalBudget;
		}
	}
});

test("recoverServedAttachmentGaps: default recovery batch admits two live-shape attachments without changing forward-backfill default", async () => {
	const originalBackfillBudget =
		process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES;
	const originalRecoveryBudget =
		process.env.PDPP_GMAIL_ATTACHMENT_RECOVERY_PAGE_BYTES;
	delete process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES;
	delete process.env.PDPP_GMAIL_ATTACHMENT_RECOVERY_PAGE_BYTES;
	try {
		const liveShapeBytes = 1_889_782;
		const messagesById = new Map<string, FetchMessageObject>();
		const servedGaps = Array.from({ length: 3 }, (_unused, index) => {
			const messageId = `gmmsgid-live-shape-${index}`;
			const message = makeServedRecoveryMsg({
				attachments: [liveShapeBytes],
				emailId: messageId,
				threadId: `gmthrid-live-shape-${index}`,
				uid: 6000 + index,
			});
			messagesById.set(messageId, message);
			return makeServedRecoveryGap({
				gapId: `gap-live-shape-${index}`,
				messageId,
				partIndex: 1,
			});
		});
		const search = mock.fn((query: { emailId?: string }) => {
			const message = query.emailId
				? messagesById.get(query.emailId)
				: undefined;
			return Promise.resolve(message ? [message.uid ?? 0] : []);
		});
		const fetchOne = mock.fn((range: string) => {
			const message = [...messagesById.values()].find(
				(candidate) => candidate.uid === Number(range),
			);
			assert.ok(message, `unexpected uid lookup: ${range}`);
			return Promise.resolve(message);
		});
		const hydrateAttachmentMock = mock.fn(
			(_msg: FetchMessageObject, attachment: AttachmentRecord) =>
				Promise.resolve({
					failure: null,
					record: {
						...attachment,
						blob_ref: {
							blob_id: `blob-${attachment.id}`,
							mime_type: attachment.content_type ?? "application/octet-stream",
							sha256: `sha-${attachment.id}`,
							size_bytes: attachment.size_bytes ?? 0,
						},
						content_sha256: `sha-${attachment.id}`,
						content_type: attachment.content_type,
						hydration_error: null,
						hydration_status: "hydrated" as const,
						size_bytes: attachment.size_bytes,
					},
				}),
		);
		const emitHarness = makeRecordingEmit();

		const summary = await recoverServedAttachmentGaps(
			{ search, fetchOne },
			{
				detailGaps: servedGaps,
				emitProtocol: emitHarness.emit,
				emitRecord: async (stream, data) => {
					await emitHarness.emitRecord(stream, data);
					return true;
				},
				hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
			},
		);

		assert.equal(ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES, 1024 * 1024);
		assert.equal(ATTACHMENT_RECOVERY_PAGE_DEFAULT_BYTES, 4 * 1024 * 1024);
		assert.equal(
			search.mock.callCount(),
			3,
			"one overflow probe establishes the truthful deferred suffix",
		);
		assert.equal(
			hydrateAttachmentMock.mock.callCount(),
			2,
			"the default recovery lane admits a bounded two-item batch",
		);
		assert.deepEqual(summary, {
			admitted: 2,
			admitted_bytes: liveShapeBytes * 2,
			attachment_hydration_failure_outcome: {
				blob_upload_http_4xx: 0,
				blob_upload_http_5xx: 0,
				blob_upload_integrity_failed: 0,
				blob_upload_invalid_response: 0,
				blob_upload_transport_failed: 0,
				imap_download_failed: 0,
				unclassified_failed: 0,
			},
			attempted: 3,
			hydration_failed: 0,
			lookup_miss: 0,
			metadata_lookups: 3,
			recovered: 2,
			run_cap_deferred: 1,
			served: 3,
		});
	} finally {
		if (originalBackfillBudget === undefined) {
			delete process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES;
		} else {
			process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES =
				originalBackfillBudget;
		}
		if (originalRecoveryBudget === undefined) {
			delete process.env.PDPP_GMAIL_ATTACHMENT_RECOVERY_PAGE_BYTES;
		} else {
			process.env.PDPP_GMAIL_ATTACHMENT_RECOVERY_PAGE_BYTES =
				originalRecoveryBudget;
		}
	}
});

test("recoverServedAttachmentGaps: emits hydrating progress before a slow hydration resolves, then emits recovery and settled progress after record emission", async () => {
	const message = makeServedRecoveryMsg({
		attachments: [16],
		emailId: "gmmsgid-slow",
		threadId: "gmthrid-slow",
		uid: 5000,
	});
	const search = mock.fn((query: { emailId?: string }) => {
		assert.equal(query.emailId, "gmmsgid-slow");
		return Promise.resolve([message.uid ?? 5000]);
	});
	const fetchOne = mock.fn((range: string) => {
		assert.equal(range, "5000");
		return Promise.resolve(message);
	});
	const hydration = createDeferred<AttachmentHydrationResult>();
	const hydrateAttachmentMock = mock.fn(() => hydration.promise);
	const emitHarness = makeRecordingEmit();
	const emitRecord = async (
		stream: string,
		data: Record<string, unknown>,
	): Promise<boolean> => {
		await emitHarness.emitRecord(stream, data);
		return true;
	};

	const runPromise = recoverServedAttachmentGaps(
		{ search, fetchOne },
		{
			detailGaps: [
				makeServedRecoveryGap({
					gapId: "gap-slow",
					messageId: "gmmsgid-slow",
					partIndex: 1,
				}),
			],
			emitProtocol: emitHarness.emit,
			emitRecord,
			hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
		},
	);

	await new Promise<void>((resolve) => setImmediate(resolve));

	const preResolveProgress = emitHarness.protocolMessages.filter(
		(msg): msg is ProgressMessage => msg.type === "PROGRESS",
	);
	assert.equal(
		preResolveProgress.length,
		1,
		"only the hydrating progress should exist before hydration resolves",
	);
	assert.match(
		preResolveProgress[0]?.message ?? "",
		/^Retrying 1 attachment that failed earlier/u,
	);
	assert.equal(
		emitHarness.protocolMessages.some(
			(msg) => msg.type === "DETAIL_GAP_RECOVERED",
		),
		false,
		"no recovery claim should emit before hydration and record emission complete",
	);
	assert.equal(
		emitHarness.protocolMessages.some(
			(msg) => msg.type === "PROGRESS" && msg.message.startsWith("Recovered "),
		),
		false,
		"no settled progress should emit before hydration and record emission complete",
	);
	assert.equal(
		emitHarness.events.some(
			(event) => event.kind === "record" && event.stream === "attachments",
		),
		false,
		"the attachment record must not emit before the hydration promise resolves",
	);

	hydration.resolve(
		hydratedResult({
			blob_ref: {
				blob_id: "blob-gmmsgid-slow:1",
				mime_type: "application/pdf",
				sha256: "sha-gmmsgid-slow:1",
				size_bytes: 16,
			},
			content_id: null,
			content_sha256: "sha-gmmsgid-slow:1",
			content_type: "application/pdf",
			encoding: "base64",
			filename: "attachment-1.pdf",
			hydration_error: null,
			hydration_status: "hydrated",
			id: "gmmsgid-slow:1",
			is_inline: false,
			message_id: "gmmsgid-slow",
			message_received_at: FROZEN_NOW,
			part_index: "1",
			size_bytes: 16,
		}),
	);

	const summary = await runPromise;

	assert.equal(search.mock.callCount(), 1);
	assert.equal(fetchOne.mock.callCount(), 1);
	assert.equal(summary.admitted, 1);
	assert.equal(summary.recovered, 1);

	const progressMessages = emitHarness.protocolMessages.filter(
		(msg) => msg.type === "PROGRESS",
	);
	assert.equal(
		progressMessages.length,
		2,
		"hydrating and settled progress should both emit once the run completes",
	);
	assert.match(
		progressMessages[0]?.message ?? "",
		/^Retrying 1 attachment that failed earlier/u,
	);
	assert.match(
		progressMessages[1]?.message ?? "",
		/^Recovered 1 of 1 previously failed attachment/u,
	);
	const eventLabel = (event: RecordedEvent): string => {
		if (event.kind === "message") {
			if (event.message.type === "PROGRESS") {
				return `progress:${recoveryPhase(event.message.message)}`;
			}
			if (event.message.type === "DETAIL_GAP_RECOVERED") {
				return "recovered";
			}
			return "other";
		}
		if (event.kind === "record") {
			return `record:${event.stream}`;
		}
		return "other";
	};
	assert.deepEqual(emitHarness.events.map(eventLabel), [
		"progress:hydrating",
		"record:attachments",
		"recovered",
		"progress:settled",
	]);
});

test("recoverServedAttachmentGaps: 33 distinct lookup misses cap out at 32 unique metadata calls", async () => {
	const servedGaps = Array.from({ length: 33 }, (_unused, index) =>
		makeServedRecoveryGap({
			gapId: `gap-miss-${index}`,
			messageId: `gmmsgid-miss-${index}`,
			partIndex: 1,
			leaseId: `lease-miss-${index}`,
		}),
	);
	const search = mock.fn(() => Promise.resolve([] as number[]));
	const fetchOne = mock.fn(() =>
		Promise.reject(new Error("fetchOne should not run for a miss")),
	);
	const emitHarness = makeRecordingEmit();
	const emitRecord = async (
		stream: string,
		data: Record<string, unknown>,
	): Promise<boolean> => {
		await emitHarness.emitRecord(stream, data);
		return true;
	};

	const summary = await recoverServedAttachmentGaps(
		{ search, fetchOne },
		{
			detailGaps: servedGaps,
			emitProtocol: emitHarness.emit,
			emitRecord,
			hydrateAttachment: mock.fn(
				(_msg: FetchMessageObject, attachment: AttachmentRecord) =>
					Promise.resolve(
						failedResult({
							...attachment,
							blob_ref: null,
							content_sha256: null,
							content_type: attachment.content_type,
							hydration_error: "unexpected",
							hydration_status: "failed" as const,
							size_bytes: attachment.size_bytes,
						}),
					),
			) as HydrateAttachmentFn,
		},
	);

	assert.equal(
		search.mock.callCount(),
		32,
		"the lookup cap should stop the 33rd unique Gmail metadata lookup",
	);
	assert.equal(
		fetchOne.mock.callCount(),
		0,
		"misses never fetch a message body",
	);
	assert.equal(summary.admitted, 0);
	assert.equal(summary.recovered, 0);
	assert.deepEqual(summary, {
		admitted: 0,
		admitted_bytes: 0,
		attempted: 32,
		attachment_hydration_failure_outcome: {
			blob_upload_http_4xx: 0,
			blob_upload_http_5xx: 0,
			blob_upload_integrity_failed: 0,
			blob_upload_invalid_response: 0,
			blob_upload_transport_failed: 0,
			imap_download_failed: 0,
			unclassified_failed: 0,
		},
		hydration_failed: 0,
		lookup_miss: 32,
		metadata_lookups: 32,
		recovered: 0,
		run_cap_deferred: 0,
		served: 33,
	});
	const attempts = emitHarness.protocolMessages.filter(
		(msg) => msg.type === "DETAIL_GAP_ATTEMPTED",
	);
	const deferred = emitHarness.protocolMessages.filter(
		(msg) => msg.type === "DETAIL_GAP",
	);
	assert.equal(
		attempts.length,
		32,
		"each real metadata lookup is explicitly accounted as an attempt",
	);
	assert.equal(
		deferred.length,
		32,
		"each lookup miss explicitly re-defers instead of ending silently",
	);
	assert.equal(
		deferred.every((msg) => msg.last_error?.class === "attachment_lookup_miss"),
		true,
	);
	assert.equal(
		emitHarness.protocolMessages.some((msg) => msg.type === "PROGRESS"),
		false,
	);
});

test("recoverServedAttachmentGaps: an unclassified plain blob failure remains retryable without changing the run", async () => {
	const message = makeServedRecoveryMsg({
		attachments: [16],
		emailId: "gmmsgid-hydration-failure",
		uid: 6000,
	});
	const attachmentCoverage = makeAttachmentDetailCoverage();
	const emitHarness = makeRecordingEmit();
	let failedAttachment: AttachmentRecord | undefined;
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: Readable.from([Buffer.from("attachment")]),
				expectedSize: 16,
				mimeType: "application/pdf",
			}),
		uploadBlob: () =>
			Promise.reject(new Error("private unclassified blob failure")),
	});
	const summary = await recoverServedAttachmentGaps(
		{
			search: mock.fn(() => Promise.resolve([message.uid ?? 6000])),
			fetchOne: mock.fn(() => Promise.resolve(message)),
		},
		{
			attachmentCoverage,
			detailGaps: [
				makeServedRecoveryGap({
					gapId: "gap-hydration-failure",
					messageId: "gmmsgid-hydration-failure",
					partIndex: 1,
				}),
			],
			emitProtocol: emitHarness.emit,
			emitRecord: async (stream, data) => {
				await emitHarness.emitRecord(stream, data);
				return true;
			},
			hydrateAttachment: async (loadedMessage, attachment) => {
				const result = await hydrateAttachment(loadedMessage, attachment);
				failedAttachment = result.record;
				return result;
			},
		},
	);

	assert.deepEqual(summary, {
		admitted: 1,
		admitted_bytes: 16,
		attempted: 1,
		attachment_hydration_failure_outcome: {
			blob_upload_http_4xx: 0,
			blob_upload_http_5xx: 0,
			blob_upload_integrity_failed: 0,
			blob_upload_invalid_response: 0,
			blob_upload_transport_failed: 0,
			imap_download_failed: 0,
			unclassified_failed: 1,
		},
		hydration_failed: 1,
		lookup_miss: 0,
		metadata_lookups: 1,
		recovered: 0,
		run_cap_deferred: 0,
		served: 1,
	});
	assert.equal(
		emitHarness.protocolMessages.some(
			(msg) => msg.type === "DETAIL_GAP_RECOVERED",
		),
		false,
		"a failed hydration must not acknowledge the served gap as recovered",
	);
	assert.ok(failedAttachment, "hydration ran and failed");
	assert.equal(failedAttachment.hydration_status, "failed");
	// A failed served attempt writes no record (the part may be stored
	// hydrated). It re-defers the served gap under its lease, and the
	// re-deferral records WHY as a bounded class: the 2026-08 Gmail incident
	// left 5 gaps terminal after 37-117 retries with no recorded cause.
	assert.deepEqual(attachmentCoverage.gapKeys, [failedAttachment.id]);
	assert.deepEqual(attachmentCoverage.failedRecords, []);
	const redeferral = emitHarness.protocolMessages.find(
		(msg) =>
			msg.type === "DETAIL_GAP" && msg.record_key === failedAttachment?.id,
	);
	assert.ok(redeferral?.type === "DETAIL_GAP");
	assert.deepEqual(redeferral.last_error, { class: "unclassified_failed" });
	assert.equal(redeferral.retryable, true);
	assert.equal(
		JSON.stringify(summary).includes("private unclassified blob failure"),
		false,
	);
});

test("recoverServedAttachmentGaps: boundary-derived stages account for every failed hydration exactly once", async () => {
	const message = makeServedRecoveryMsg({
		attachments: [16, 16, 16, 16, 16, 16],
		emailId: "gmmsgid-stage-outcome",
		uid: 6010,
	});
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: (_msg, attachment) => {
			if (attachment.part_index === "1") {
				throw new Error("private IMAP download failure");
			}
			return Promise.resolve({
				content: Readable.from([Buffer.from("attachment")]),
				expectedSize: 16,
				mimeType: "application/pdf",
			});
		},
		uploadBlob: ({ recordKey }) => {
			const kindByPart: Record<string, ReferenceBlobUploadFailure["kind"]> = {
				"2": "transport",
				"3": "http_4xx",
				"4": "http_5xx",
				"5": "invalid_response",
				"6": "integrity_mismatch",
			};
			const part = recordKey.split(":").at(-1) ?? "";
			throw new ReferenceBlobUploadFailure(
				kindByPart[part] ?? "transport",
				"private blob failure",
			);
		},
	});
	const emitHarness = makeRecordingEmit();
	const summary = await recoverServedAttachmentGaps(
		{
			search: mock.fn(() => Promise.resolve([message.uid ?? 6010])),
			fetchOne: mock.fn(() => Promise.resolve(message)),
		},
		{
			detailGaps: [1, 2, 3, 4, 5, 6].map((partIndex) =>
				makeServedRecoveryGap({
					gapId: `gap-stage-${partIndex}`,
					messageId: "gmmsgid-stage-outcome",
					partIndex,
				}),
			),
			emitProtocol: emitHarness.emit,
			emitRecord: async (stream, data) => {
				await emitHarness.emitRecord(stream, data);
				return true;
			},
			hydrateAttachment,
		},
	);

	assert.equal(summary.hydration_failed, 6);
	assert.deepEqual(summary.attachment_hydration_failure_outcome, {
		blob_upload_http_4xx: 1,
		blob_upload_http_5xx: 1,
		blob_upload_integrity_failed: 1,
		blob_upload_invalid_response: 1,
		blob_upload_transport_failed: 1,
		imap_download_failed: 1,
		unclassified_failed: 0,
	});
	assert.equal(
		Object.values(summary.attachment_hydration_failure_outcome).reduce(
			(total, count) => total + count,
			0,
		),
		summary.hydration_failed,
		"each failed hydration increments exactly one aggregate stage",
	);
	assert.equal(
		emitHarness.protocolMessages.some(
			(msg) => msg.type === "DETAIL_GAP_RECOVERED",
		),
		false,
		"stage telemetry does not acknowledge a failed hydration as recovered",
	);
	assert.equal(
		JSON.stringify(summary.attachment_hydration_failure_outcome).includes(
			"private",
		),
		false,
		"the aggregate stage evidence contains no source or blob error content",
	);
});

test("recoverServedAttachmentGaps: same-message served gaps reuse one lookup", async () => {
	const message = makeServedRecoveryMsg({
		attachments: [16, 24],
		emailId: "gmmsgid-cache",
		threadId: "gmthrid-cache",
		uid: 4000,
	});
	const search = mock.fn((query: { emailId?: string }) => {
		if (query.emailId !== "gmmsgid-cache") {
			return Promise.resolve([]);
		}
		return Promise.resolve([message.uid ?? 4000]);
	});
	const fetchOne = mock.fn((range: string) => {
		assert.equal(range, "4000");
		return Promise.resolve(message);
	});
	const hydrateAttachmentMock = mock.fn(
		(_msg: FetchMessageObject, attachment: AttachmentRecord) =>
			Promise.resolve(
				hydratedResult({
					...attachment,
					blob_ref: {
						blob_id: `blob-${attachment.id}`,
						mime_type: attachment.content_type ?? "application/octet-stream",
						sha256: `sha-${attachment.id}`,
						size_bytes: attachment.size_bytes ?? 0,
					},
					content_sha256: `sha-${attachment.id}`,
					content_type: attachment.content_type,
					hydration_error: null,
					hydration_status: "hydrated" as const,
					size_bytes: attachment.size_bytes,
				}),
			),
	);
	const emitHarness = makeRecordingEmit();
	const emitRecord = async (
		stream: string,
		data: Record<string, unknown>,
	): Promise<boolean> => {
		await emitHarness.emitRecord(stream, data);
		return true;
	};

	const summary = await recoverServedAttachmentGaps(
		{ search, fetchOne },
		{
			detailGaps: [
				makeServedRecoveryGap({
					gapId: "gap-cache-1",
					messageId: "gmmsgid-cache",
					partIndex: 1,
				}),
				makeServedRecoveryGap({
					gapId: "gap-cache-2",
					messageId: "gmmsgid-cache",
					partIndex: 2,
				}),
			],
			emitProtocol: emitHarness.emit,
			emitRecord,
			hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
		},
	);

	assert.equal(
		search.mock.callCount(),
		1,
		"same-message gaps should reuse the cached Gmail metadata lookup",
	);
	assert.equal(
		fetchOne.mock.callCount(),
		1,
		"same-message gaps should fetch the message only once",
	);
	assert.equal(
		hydrateAttachmentMock.mock.callCount(),
		2,
		"both same-message gaps should be attempted",
	);
	assert.equal(summary.admitted, 2);
	assert.equal(summary.recovered, 2);
	assert.equal(
		emitHarness.protocolMessages.filter((msg) => msg.type === "PROGRESS")
			.length,
		4,
	);
	assert.deepEqual(
		emitHarness.protocolMessages
			.filter((msg): msg is ProgressMessage => msg.type === "PROGRESS")
			.map((msg) => recoveryPhase(msg.message)),
		["hydrating", "settled", "hydrating", "settled"],
	);
});

// openspec/changes/fix-recovery-run-lifecycle: the historical attachment
// backfill's actual unit of completed work is a byte-cost-bounded page, not
// the coarse selectAttachmentBackfillFetchRange UID ceiling above. Mirrors
// reference-implementation/runtime/detail-gap-paging.js's
// byte-budget/EWMA/trim-to-budget pattern as Gmail-local policy.

test("attachmentBackfillPageByteBudget: clamps to the configured min/max range", () => {
	assert.equal(
		attachmentBackfillPageByteBudget(),
		ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES,
	);
	// Below the minimum falls back to the default, mirroring
	// detail-gap-paging.js's boundedPositiveInteger (below-min is treated as
	// an invalid override, not clamped up).
	assert.equal(
		attachmentBackfillPageByteBudget(1),
		ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES,
	);
	assert.equal(
		attachmentBackfillPageByteBudget(ATTACHMENT_BACKFILL_PAGE_MIN_BYTES),
		ATTACHMENT_BACKFILL_PAGE_MIN_BYTES,
	);
	assert.equal(
		attachmentBackfillPageByteBudget(1024 * 1024 * 1024),
		ATTACHMENT_BACKFILL_PAGE_MAX_BYTES,
	);
	assert.equal(
		attachmentBackfillPageByteBudget(2 * 1024 * 1024),
		2 * 1024 * 1024,
	);
});

test("resolveAttachmentBackfillPageByteBudget: env override must be a positive integer", () => {
	assert.equal(
		resolveAttachmentBackfillPageByteBudget({}),
		ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES,
	);
	assert.equal(
		resolveAttachmentBackfillPageByteBudget({
			PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES: String(4 * 1024 * 1024),
		}),
		4 * 1024 * 1024,
	);
	assert.equal(
		resolveAttachmentBackfillPageByteBudget({
			PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES: "0",
		}),
		ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES,
	);
	assert.equal(
		resolveAttachmentBackfillPageByteBudget({
			PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES: "not-a-number",
		}),
		ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES,
	);
});

test("resolveAttachmentRecoveryPageByteBudget: uses a recovery-specific override while preserving the legacy override", () => {
	assert.equal(
		resolveAttachmentRecoveryPageByteBudget({}),
		ATTACHMENT_RECOVERY_PAGE_DEFAULT_BYTES,
	);
	assert.equal(
		resolveAttachmentRecoveryPageByteBudget({
			PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES: String(2 * 1024 * 1024),
		}),
		2 * 1024 * 1024,
		"existing operator configuration continues to constrain served recovery",
	);
	assert.equal(
		resolveAttachmentRecoveryPageByteBudget({
			PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES: String(2 * 1024 * 1024),
			PDPP_GMAIL_ATTACHMENT_RECOVERY_PAGE_BYTES: String(3 * 1024 * 1024),
		}),
		3 * 1024 * 1024,
		"the recovery-specific override takes precedence without altering backfill",
	);
	assert.equal(
		resolveAttachmentRecoveryPageByteBudget({
			PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES: String(2 * 1024 * 1024),
			PDPP_GMAIL_ATTACHMENT_RECOVERY_PAGE_BYTES: "invalid",
		}),
		2 * 1024 * 1024,
		"an invalid new override does not discard a valid legacy safety setting",
	);
	for (const invalidRecoveryBudget of ["0", "262143"]) {
		assert.equal(
			resolveAttachmentRecoveryPageByteBudget({
				PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES: String(
					ATTACHMENT_BACKFILL_PAGE_MIN_BYTES,
				),
				PDPP_GMAIL_ATTACHMENT_RECOVERY_PAGE_BYTES: invalidRecoveryBudget,
			}),
			ATTACHMENT_BACKFILL_PAGE_MIN_BYTES,
			`numeric out-of-range recovery override ${invalidRecoveryBudget} does not weaken the legacy safety setting`,
		);
	}
});

test("trimAttachmentBackfillPageToByteBudget: a page is sized by cumulative byte cost, not a fixed UID count", () => {
	const budget = 1_000_000;
	const candidates = [
		{ uid: 1, attachmentBytes: 400_000 },
		{ uid: 2, attachmentBytes: 400_000 },
		{ uid: 3, attachmentBytes: 400_000 }, // would push cumulative to 1.2M, over budget
		{ uid: 4, attachmentBytes: 100 },
	];
	const { admittedCount, estimatedBytesTotal } =
		trimAttachmentBackfillPageToByteBudget(candidates, budget);
	assert.equal(
		admittedCount,
		2,
		"the page stops once the next entry would exceed budget",
	);
	assert.equal(estimatedBytesTotal, 800_000);
});

test("trimAttachmentBackfillPageToByteBudget: a single oversized attachment still forms a complete page", () => {
	const budget = 100_000;
	const candidates = [
		{ uid: 1, attachmentBytes: 5_000_000 }, // alone exceeds budget
		{ uid: 2, attachmentBytes: 100 },
	];
	const { admittedCount } = trimAttachmentBackfillPageToByteBudget(
		candidates,
		budget,
	);
	assert.equal(
		admittedCount,
		1,
		"at-least-one-entry admission: an oversized attachment doesn't block all progress",
	);
});

test("trimAttachmentBackfillPageToByteBudget: a zero-attachment UID costs nothing and does not consume budget", () => {
	// The live bug this guards: mapping "no attachments" to the unknown-size
	// fallback would starve an ordinary no-attachment window down to ~4
	// admitted messages per 1 MiB page. A zero-attachment UID must cost 0.
	const budget = 300_000;
	const candidates = [
		{ uid: 1, attachmentBytes: 0 },
		{ uid: 2, attachmentBytes: 0 },
		{ uid: 3, attachmentBytes: 0 },
		{ uid: 4, attachmentBytes: 0 },
		{ uid: 5, attachmentBytes: 0 },
	];
	const { admittedCount, estimatedBytesTotal } =
		trimAttachmentBackfillPageToByteBudget(candidates, budget);
	assert.equal(
		admittedCount,
		5,
		"every zero-cost UID is admitted regardless of the budget",
	);
	assert.equal(estimatedBytesTotal, 0);
});

test("trimAttachmentBackfillPageToByteBudget: mixed known/unknown attachment sizes charge the fallback per unknown attachment, not per UID", () => {
	// Mirrors how the call site computes attachmentBytes: sum each
	// attachment's known size_bytes, substituting the fixed fallback for
	// each attachment whose size is unavailable — never dropping the
	// unknown ones (which would underestimate the UID's true cost).
	const known = 500_000;
	const mixedUidCost =
		known + ATTACHMENT_BACKFILL_UNKNOWN_SIZE_FALLBACK_BYTES * 2; // 2 attachments unknown
	const budget = mixedUidCost + 10; // just enough for the one mixed UID
	const candidates = [
		{ uid: 1, attachmentBytes: mixedUidCost },
		{ uid: 2, attachmentBytes: 100 },
	];
	const { admittedCount, estimatedBytesTotal } =
		trimAttachmentBackfillPageToByteBudget(candidates, budget);
	assert.equal(admittedCount, 1);
	assert.equal(estimatedBytesTotal, mixedUidCost);
});

test("trimAttachmentBackfillPageToByteBudget: an empty candidate list admits nothing", () => {
	const { admittedCount, estimatedBytesTotal } =
		trimAttachmentBackfillPageToByteBudget([], 1_000_000);
	assert.equal(admittedCount, 0);
	assert.equal(estimatedBytesTotal, 0);
});

test("trimAttachmentBackfillPageToByteBudget: caller must sort ascending by UID — an out-of-order high-cost candidate first still trims by position, proving the caller-side sort is load-bearing", () => {
	// This function trusts array order; it does not re-sort. Feeding it an
	// out-of-order list here (as if the caller forgot to sort) demonstrates
	// why the call site sorts probeMetas ascending by UID before trimming:
	// trimming an unsorted list still only returns a POSITIONAL prefix count,
	// so a caller that derives the admitted page via `uid <= someMax` on
	// unsorted input — rather than `slice(0, admittedCount)` on sorted
	// input — could wrongly include a high UID admitted early by an
	// unsorted trim. The fix is call-site sorting, not a trim-level UID
	// filter; this test pins the trim's positional-only contract so a
	// future edit can't silently reintroduce a UID-comparison shortcut.
	const budget = 100;
	const outOfOrderCandidates = [
		{ uid: 500, attachmentBytes: 40 }, // a high UID first
		{ uid: 1, attachmentBytes: 40 },
		{ uid: 2, attachmentBytes: 40 }, // pushes cumulative to 120, over budget
	];
	const { admittedCount } = trimAttachmentBackfillPageToByteBudget(
		outOfOrderCandidates,
		budget,
	);
	assert.equal(
		admittedCount,
		2,
		"trims by array position, not by UID value — sorting is the caller's responsibility",
	);
});

test("processMessage: attachment bytes are not inlined into message_bodies", async () => {
	const attachmentBytes = Buffer.from("secret attachment payload");
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: Readable.from([attachmentBytes]),
				expectedSize: attachmentBytes.length,
				mimeType: "application/octet-stream",
			}),
		uploadBlob: async ({ content, mimeType }) => {
			const chunks: Buffer[] = [];
			for await (const chunk of content) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const sha256 = createHash("sha256")
				.update(Buffer.concat(chunks))
				.digest("hex");
			return {
				blob_id: `blob_sha256_${sha256}`,
				mime_type: mimeType,
				sha256,
				size_bytes: attachmentBytes.length,
			};
		},
	});
	const { deps, emitted } = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["message_bodies", "attachments"]),
		wantBodies: true,
		wantMessages: false,
	});

	await processMessage(deps, makeAttachmentMsg());

	const body = emitted.find((record) => record.stream === "message_bodies");
	const attachment = emitted.find((record) => record.stream === "attachments");
	assert.ok(body);
	assert.ok(attachment);
	assert.equal(
		JSON.stringify(body.data).includes("secret attachment payload"),
		false,
	);
	assert.equal(
		JSON.stringify(attachment.data).includes("secret attachment payload"),
		false,
	);
});

test("processMessage: control-rich body bytes upload with field bindings and canonical nulls", async () => {
	const bodyText = "plain\u0000body";
	const bodyHtml = "<p>html\u0007body</p>";
	const uploads: Array<{
		bytes: Buffer;
		jsonPath?: string;
		mimeType: string;
		stream: string;
	}> = [];
	const uploadBodyBlob: UploadBodyBlobFn = async (args) => {
		const chunks: Buffer[] = [];
		for await (const chunk of args.content) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		uploads.push({
			bytes: Buffer.concat(chunks),
			...(args.jsonPath ? { jsonPath: args.jsonPath } : {}),
			mimeType: args.mimeType,
			stream: args.stream,
		});
		return {
			blob_id: `blob-${uploads.length}`,
			mime_type: args.mimeType,
			sha256: "unused",
			size_bytes: chunks.reduce((n, chunk) => n + chunk.length, 0),
		};
	};
	const { deps, emitted } = makeHarness({
		requested: makeRequested(["message_bodies"]),
		uploadBodyBlob,
		fetchBodies: async () => ({
			bodyHtmlFull: bodyHtml,
			bodyTextFull: bodyText,
			snippet: "plain body",
		}),
		wantBodies: true,
		wantMessages: false,
	});

	await processMessage(deps, makeMsg());

	const body = emitted.find((record) => record.stream === "message_bodies");
	assert.ok(body);
	assert.equal(body.data.body_text, null);
	assert.equal(body.data.body_html, null);
	assert.deepEqual(
		uploads.map((upload) => upload.jsonPath),
		["/body_text", "/body_html"],
	);
	assert.deepEqual(
		uploads.map((upload) => upload.bytes),
		[Buffer.from(bodyText), Buffer.from(bodyHtml)],
	);
	assert.deepEqual(
		uploads.map((upload) => upload.stream),
		["message_bodies", "message_bodies"],
	);
});

test("processMessage: wantBodies=false suppresses message_bodies but still emits the messages record", async () => {
	const { deps, emitted } = makeHarness({
		wantBodies: false,
		wantMessages: true,
	});
	await processMessage(deps, makeMsg());
	assert.equal(
		emitted.filter((r) => r.stream === "message_bodies").length,
		0,
		"no message_bodies record when wantBodies=false",
	);
	assert.equal(
		emitted.filter((r) => r.stream === "messages").length,
		1,
		"messages record still emits",
	);
});

// ─── Invariant: all-streams-disabled emits nothing ───────────────────────

test("processMessage: all streams disabled → nothing emitted and no stream owes an outcome", async () => {
	const { deps, emitted } = makeHarness({
		requested: makeRequested([]), // no 'attachments' requested
		wantBodies: false,
		wantMessages: false,
	});
	const processed = await processMessage(deps, makeMsg());
	assert.equal(emitted.length, 0, "no records emitted when all streams off");
	assert.deepEqual(processed, {});
});

// ─── Invariant: early-filter skip (missing X-GM-MSGID) ───────────────────

test("processMessage: missing X-GM-MSGID is terminal and emits nothing", async () => {
	const { deps, emitted } = makeHarness({ wantMessages: true });
	// Build a message without emailId (we omit rather than set undefined to
	// satisfy exactOptionalPropertyTypes).
	const { emailId: _emailId, ...rest } = makeMsg();
	const processed = await processMessage(deps, rest);
	// The BODYSTRUCTURE shows no attachment parts, so attachments owe nothing.
	// (Without a structure they would be terminal; see progress-regression.)
	assert.deepEqual(processed, {
		messages: { kind: "terminal", reason: "missing_message_id" },
		attachments: { kind: "covered" },
	});
	assert.equal(emitted.length, 0);
});

// ─── Invariant: time_range filter skips out-of-window messages ───────────

test("processMessage: receivedAt outside time_range → out_of_scope, emits nothing", async () => {
	const { deps, emitted } = makeHarness({
		timeRange: { since: "2030-01-01T00:00:00.000Z" }, // in the future
		wantMessages: true,
	});
	const processed = await processMessage(deps, makeMsg());
	assert.deepEqual(processed, {
		messages: { kind: "out_of_scope" },
		attachments: { kind: "out_of_scope" },
	});
	assert.equal(emitted.length, 0);
});

// ─── Invariant: body-fetch failure → still emit envelope record ──────────

test("processMessage: fetchBodies that resolves all-nulls still emits messages with snippet=null", async () => {
	const nullFetcher: FetchBodiesFn = (): Promise<FetchedBodies> =>
		Promise.resolve({ bodyHtmlFull: null, bodyTextFull: null, snippet: null });
	const { deps, emitted } = makeHarness({
		fetchBodies: nullFetcher,
		wantMessages: true,
	});
	await processMessage(deps, makeMsg());
	const msgRecord = emitted.find((r) => r.stream === "messages");
	assert.ok(
		msgRecord,
		"envelope record must emit even when body fetch returned nothing",
	);
	assert.equal(
		msgRecord.data.snippet,
		null,
		"snippet falls back to null, not undefined",
	);
});

/**
 * Narrow the recorded protocol stream to the single `message_bodies` DETAIL_GAP,
 * or null. `protocolMessages` is the whole `EmittedMessage` union, so the tests
 * below cannot read gap-only fields off it without this.
 */
function findMessageBodyGap(
	protocolMessages: readonly EmittedMessage[],
): DetailGapMessage | null {
	const gaps = protocolMessages.filter(
		(m): m is DetailGapMessage =>
			m.type === "DETAIL_GAP" && m.stream === "message_bodies",
	);
	return gaps[0] ?? null;
}

// This test previously pinned the LOSSY outcome as correct: a body fetch that
// THREW emitted `body_source: "empty"` and nothing else, which is byte-identical
// to the record for a message that genuinely has no body. Because the messages
// walk advances the UID cursor to live `uidnext` either way, the real body ended
// up behind the cursor and was NEVER refetched — while the stream read complete
// to the owner. Owner decision (2026-08-23): keep emitting the envelope, but mark
// the failed body as a retryable DETAIL_GAP so it stays refetchable and the
// stream does not read complete. The cursor may still advance, because the gap is
// durable and a later run refetches exactly that body.
test("processMessage: body-fetch FAILURE writes no body or message row and reports both owed", async () => {
	const failedFetcher: FetchBodiesFn = (): Promise<FetchedBodies> =>
		Promise.resolve({
			bodyHtmlFull: null,
			bodyTextFull: null,
			snippet: null,
			fetchFailed: true,
			failureClass: "imap_body_fetch_transient",
		});
	const { deps, emitted, protocolMessages } = makeHarness({
		fetchBodies: failedFetcher,
		requested: makeRequested(["messages", "message_bodies"]),
		wantBodies: true,
		wantMessages: true,
	});
	const outcome = await processMessage(deps, makeMsg());
	// Rows for this message may already be stored (a retry, a catch-up, or the
	// replay of a failed run), and a whole-record upsert with empty content
	// would destroy them. The failure becomes retry debt with its class.
	assert.equal(
		emitted.some((r) => r.stream === "message_bodies"),
		false,
	);
	assert.equal(
		emitted.some((r) => r.stream === "messages"),
		false,
	);
	assert.equal(findMessageBodyGap(protocolMessages) ?? null, null);
	assert.deepEqual(outcome.message_bodies, {
		kind: "failed",
		failure: "imap_body_fetch_transient",
	});
	assert.deepEqual(outcome.messages, {
		kind: "failed",
		failure: "imap_body_fetch_transient",
	});
});

// The case that must NOT regress: a message that genuinely has no body in scope
// is not broken, and must not be made to look broken. It keeps `body_source:
// "empty"` and emits NO gap.
test("processMessage: genuinely empty body emits body_source='empty' and NO gap", async () => {
	const nullFetcher: FetchBodiesFn = (): Promise<FetchedBodies> =>
		Promise.resolve({ bodyHtmlFull: null, bodyTextFull: null, snippet: null });
	const { deps, emitted, protocolMessages } = makeHarness({
		fetchBodies: nullFetcher,
		requested: makeRequested(["messages", "message_bodies"]),
		wantBodies: true,
		wantMessages: true,
	});
	await processMessage(deps, makeMsg());
	const bodyRecord = emitted.find((r) => r.stream === "message_bodies");
	assert.ok(bodyRecord);
	assert.equal(
		bodyRecord.data.body_source,
		"empty",
		"body_source marks a genuinely empty body",
	);
	assert.equal(bodyRecord.data.body_text, null);
	assert.equal(bodyRecord.data.body_html, null);
	assert.equal(
		findMessageBodyGap(protocolMessages),
		null,
		"an empty message is not a gap — do not make every empty message look broken",
	);
});

// ─── Invariant: a failed body fetch must not blank a collected snippet ─────
//
// REGRESSION EVIDENCE (live sample on Tim's instance): ~15,401 `messages`
// versions identical to the version before them, and messages alternating
// between a snippet and `null` as consecutive runs disagreed about whether
// the body fetch succeeded — 2,482 of 2,485 sampled regressed keys later
// recovered when a subsequent run refetched the body, confirming this is
// churn + a temporary data regression (readers briefly see no snippet), not
// permanent loss. `records` upserts replace `record_json` wholesale, so a
// `null` written here replaces a real value until the next lucky run.
//
// The forward/historical walk (`processMessage`) visits a given UID exactly
// ONCE, ever — there is no prior `messages` record for a brand-new message
// to protect, so a failed fetch there emitting `snippet: null` is an honest
// "unknown yet", not a loss. The destructive-overwrite case can only happen
// in `runDeltaPass`, which re-visits an ALREADY-stored message to apply a
// flag/label change. That is why the fix lives entirely in `runDeltaPass`:
// skip the emit (so the stored record, snippet included, survives
// untouched) and record a retryable DETAIL_GAP, with no snippet content
// carried through STATE.

/** Narrow a captured JSONL protocol stream (see the stdout-capture pattern
 *  used throughout this file, e.g. `runAllMailPasses: first historical
 *  page...`) to a `messages`-stream DETAIL_GAP, or null. `runDeltaPass`
 *  emits protocol messages (PROGRESS, DETAIL_GAP) through the module-level
 *  `emit`, which writes real JSONL to `process.stdout` — there is no
 *  `emitProtocol` dependency to inject, so capturing stdout is the only way
 *  to observe them from a test. */
function findMessagesStreamGap(
	protocolMessages: readonly Record<string, unknown>[],
): DetailGapMessage | null {
	const gap = protocolMessages.find(
		(m) => m.type === "DETAIL_GAP" && m.stream === "messages",
	);
	return gap ? (gap as unknown as DetailGapMessage) : null;
}

test("runDeltaPass: body-fetch failure skips the messages record (stored snippet survives) and records a retryable DETAIL_GAP", async () => {
	const delta = makeMsg({
		uid: 102,
		emailId: "gmmsgid-delta-fail",
		flags: new Set(["\\Seen"]),
	});
	// biome-ignore lint/suspicious/useAwait: stands in for ImapFlow.fetch's async-iterable-returning signature.
	const fetch = mock.fn(async function* () {
		yield delta;
	});
	const fetchBodies = mock.fn(() =>
		Promise.resolve({
			bodyHtmlFull: null,
			bodyTextFull: null,
			snippet: null,
			fetchFailed: true,
			failureClass: "imap_body_fetch_transient",
		}),
	);
	const emitted: Array<{ data: Record<string, unknown>; stream: string }> = [];
	const emitRecord = (
		stream: string,
		data: Record<string, unknown>,
	): Promise<void> => {
		emitted.push({ data, stream });
		return Promise.resolve();
	};

	const originalWrite = globalThis.process.stdout.write;
	const protocolMessages: Record<string, unknown>[] = [];
	globalThis.process.stdout.write = ((data: string): boolean => {
		if (typeof data === "string") {
			try {
				protocolMessages.push(JSON.parse(data) as Record<string, unknown>);
			} catch {
				// Ignore non-protocol output.
			}
		}
		return true;
	}) as typeof process.stdout.write;

	let result: { skippedAnyMessage: boolean };
	try {
		result = await runDeltaPass(
			{ fetch } as unknown as Pick<ImapFlow, "fetch">,
			{ fullResync: false, priorModseq: 1n } as unknown as Parameters<
				typeof runDeltaPass
			>[1],
			makeRequested(["messages"]),
			emitRecord,
			"2026-08-20T00:00:00.000Z",
			fetchBodies as unknown as Parameters<typeof runDeltaPass>[5],
		);
	} finally {
		globalThis.process.stdout.write = originalWrite;
	}

	assert.equal(
		emitted.filter((r) => r.stream === "messages").length,
		0,
		"no record is emitted — emitting ANY record (even with snippet:null) would replace the stored row wholesale",
	);
	assert.equal(
		result.skippedAnyMessage,
		true,
		"the caller must be told to hold highest_modseq back for this message",
	);
	const gap = findMessagesStreamGap(protocolMessages);
	assert.ok(gap, "a failed re-fetch must leave a retryable gap, not silence");
	assert.equal(gap.record_key, "gmmsgid-delta-fail");
	assert.equal(gap.status, "pending");
	assert.equal(gap.retryable, true);
	assert.equal(gap.reference_only, true);
	assert.equal(
		gap.parent_stream,
		undefined,
		"messages is the parent stream itself, not a child detail stream",
	);
	const locator = gap.detail_locator as Record<string, unknown>;
	assert.equal(locator.kind, "gmail.message_delta_snippet_detail");
	assert.equal(locator.message_id, "gmmsgid-delta-fail");
	assert.equal(gap.last_error?.class, "imap_body_fetch_transient");
});

test("runDeltaPass: a later run whose fetch succeeds emits the full record normally", async () => {
	// Demonstrates recovery with NO shared state between calls — unlike the
	// removed carry-forward cursor, nothing here persists a value across
	// runs; the stored row simply stays whatever it was until a run with a
	// working fetch replaces it with fresh, real data.
	const delta = makeMsg({
		uid: 103,
		emailId: "gmmsgid-delta-recovered",
		flags: new Set(["\\Seen"]),
	});
	// biome-ignore lint/suspicious/useAwait: stands in for ImapFlow.fetch's async-iterable-returning signature.
	const fetch = mock.fn(async function* () {
		yield delta;
	});
	const fetchBodies = mock.fn(() =>
		Promise.resolve({
			bodyHtmlFull: null,
			bodyTextFull: "Hello there",
			snippet: "Hello there",
		}),
	);
	const emitted: Array<{ data: Record<string, unknown>; stream: string }> = [];
	const emitRecord = (
		stream: string,
		data: Record<string, unknown>,
	): Promise<void> => {
		emitted.push({ data, stream });
		return Promise.resolve();
	};

	await runDeltaPass(
		{ fetch } as unknown as Pick<ImapFlow, "fetch">,
		{ fullResync: false, priorModseq: 1n } as unknown as Parameters<
			typeof runDeltaPass
		>[1],
		makeRequested(["messages"]),
		emitRecord,
		"2026-08-20T00:00:00.000Z",
		fetchBodies as unknown as Parameters<typeof runDeltaPass>[5],
	);

	const rec = emitted.find((r) => r.stream === "messages");
	assert.ok(rec, "a working fetch emits the full record");
	assert.equal(rec.data.snippet, "Hello there");
});

test("runDeltaPass: a genuinely bodyless message (fetchFailed false, snippet null) is still emitted with snippet null", async () => {
	const delta = makeMsg({
		uid: 104,
		emailId: "gmmsgid-delta-bodyless",
		flags: new Set(["\\Seen"]),
	});
	// biome-ignore lint/suspicious/useAwait: stands in for ImapFlow.fetch's async-iterable-returning signature.
	const fetch = mock.fn(async function* () {
		yield delta;
	});
	const fetchBodies = mock.fn(() =>
		Promise.resolve({ bodyHtmlFull: null, bodyTextFull: null, snippet: null }),
	);
	const emitted: Array<{ data: Record<string, unknown>; stream: string }> = [];
	const emitRecord = (
		stream: string,
		data: Record<string, unknown>,
	): Promise<void> => {
		emitted.push({ data, stream });
		return Promise.resolve();
	};

	await runDeltaPass(
		{ fetch } as unknown as Pick<ImapFlow, "fetch">,
		{ fullResync: false, priorModseq: 1n } as unknown as Parameters<
			typeof runDeltaPass
		>[1],
		makeRequested(["messages"]),
		emitRecord,
		"2026-08-20T00:00:00.000Z",
		fetchBodies as unknown as Parameters<typeof runDeltaPass>[5],
	);

	const rec = emitted.find((r) => r.stream === "messages");
	assert.ok(
		rec,
		"a genuinely bodyless message still gets a record (fetchFailed is false, not a failure)",
	);
	assert.equal(rec.data.snippet, null);
});

// A schema-REJECTED body record is the sibling loss: `emitRecord` returns false,
// a SKIP_RESULT goes out, nothing lands, and the cursor advances anyway. Gmail's
// own makeEmitRecord returns Promise<boolean>, so processMessage can honor it.
test("processMessage: schema-rejected message_bodies record leaves a retryable DETAIL_GAP", async () => {
	const { deps, protocolMessages } = makeHarness({
		requested: makeRequested(["messages", "message_bodies"]),
		wantBodies: true,
		wantMessages: true,
	});
	const rejectingEmitRecord: typeof deps.emitRecord = (stream, _data) =>
		Promise.resolve(stream !== "message_bodies");
	await processMessage({ ...deps, emitRecord: rejectingEmitRecord }, makeMsg());
	const gap = findMessageBodyGap(protocolMessages);
	assert.ok(
		gap,
		"a rejected body record must not be counted covered and checkpointed away",
	);
	assert.equal(gap.record_key, String(makeMsg().emailId));
	assert.equal(gap.last_error?.class, "message_bodies_record_rejected");
});

// ─── Invariant: timestamp propagation (internalDate → received_at) ───────

test("processMessage: message.internalDate propagates into messages.received_at", async () => {
	const { deps, emitted } = makeHarness({ wantMessages: true });
	const fixed = new Date("2026-04-20T10:00:05.000Z");
	await processMessage(deps, makeMsg({ internalDate: fixed }));
	const msgRecord = emitted.find((r) => r.stream === "messages");
	assert.ok(msgRecord);
	assert.equal(msgRecord.data.received_at, fixed.toISOString());
});

test("processMessage: missing internalDate owes the message instead of using the run clock", async () => {
	const { deps, emitted } = makeHarness({
		nowIso: (): string => "2026-04-22T12:00:00.000Z",
		wantMessages: true,
	});
	const { internalDate: _internalDate, ...rest } = makeMsg();
	const outcome = await processMessage(deps, rest);
	assert.deepEqual(
		emitted.filter((r) => r.stream === "messages"),
		[],
		"no record with an invented received_at",
	);
	assert.deepEqual(outcome.messages, {
		kind: "failed",
		failure: "internaldate_unavailable",
	});
});

// ─── Invariant: emitMessagesPass isolates per-message errors ─────────────

test("emitMessagesPass: one message throwing doesn't halt the rest of the batch", async () => {
	let calls = 0;
	const throwingFetcher: FetchBodiesFn = (): Promise<FetchedBodies> => {
		calls += 1;
		if (calls === 1) {
			return Promise.reject(new Error("synthetic fetch failure"));
		}
		return Promise.resolve({
			bodyHtmlFull: null,
			bodyTextFull: "second msg",
			snippet: "second msg",
		});
	};
	const { deps, emitted } = makeHarness({
		fetchBodies: throwingFetcher,
		wantMessages: true,
	});
	const metas: FetchMessageObject[] = [
		makeMsg({ emailId: "bad-msg", uid: 1 }),
		makeMsg({ emailId: "good-msg", uid: 2 }),
	];
	await emitMessagesPass(deps, metas);

	const msgRecords = emitted.filter((r) => r.stream === "messages");
	assert.equal(
		msgRecords.length,
		1,
		"the second message emits even though the first errored",
	);
	assert.equal(msgRecords[0]?.data.id, "good-msg");
});

test("emitMessagesPass: a stalled attachment transfer propagates instead of being swallowed like an ordinary per-message error, and no later message is attempted", async () => {
	// Distinguishes this from the "one message throwing doesn't halt the rest
	// of the batch" case above: an ordinary per-message error (a bad body
	// fetch, a malformed record) is isolated and the loop continues. A stall
	// timeout is NOT isolated, because `onStall` already closed the shared
	// IMAP connection this loop's next iteration would try to reuse — every
	// later message would fail too, with a confusing "connection closed"
	// error masking the real cause. This pins that the loop stops immediately
	// instead of grinding through the remaining metas against a dead client.
	let attachmentHydrationAttempts = 0;
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () => {
			attachmentHydrationAttempts += 1;
			return Promise.resolve({
				content: scriptedContent([], 0, true),
				expectedSize: null,
				mimeType: "application/pdf",
			});
		},
		onStall: () => undefined,
		stallTimeoutMs: 10,
		uploadBlob: async ({ content }) => {
			for await (const _chunk of content) {
				// no chunks; stall fires while awaiting the first `next()`
			}
			throw new Error("unreachable");
		},
	});
	const { deps } = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});
	const metas: FetchMessageObject[] = [
		makeAttachmentMsg(),
		makeAttachmentMsg(),
	];

	await assert.rejects(
		emitMessagesPass(deps, metas),
		AttachmentStallTimeoutError,
	);
	assert.equal(
		attachmentHydrationAttempts,
		1,
		"the second message's attachment must never be attempted against the poisoned connection",
	);
});

test("emitMessagesPass: progress includes count and total when metadata count is known", async () => {
	const { deps, progress } = makeHarness({ wantMessages: true });
	const metas = Array.from({ length: 500 }, (_, i) =>
		makeMsg({
			emailId: `gmmsgid-${i}`,
			threadId: `gmthrid-${i}`,
			uid: i + 1,
			bodyStructure: { type: "text/plain", part: "1" },
		}),
	);

	await emitMessagesPass(deps, metas);

	assert.equal(progress.length, 1);
	assert.equal(progress[0]?.stream, "messages");
	assert.equal(progress[0]?.count, 500);
	assert.equal(progress[0]?.total, 500);
});

// ─── Historical attachment backfill: pin the per-UID hydration shape ────
//
// When only attachments still owe history, runAllMailPasses walks the
// bounded historical page in attachment-only mode (no messages, no bodies)
// and tallies the AttachmentBackfillSummary from the attachments it
// hydrates. These tests pin that mode without IMAP: a
// "historical" UID below priorUidnext is fed through the same code path
// and we verify hydration, idempotency, and summary accounting.
// Scope note: this asserts per-UID behavior and summary shape. Window
// selection is pinned above; cross-invocation replay of the Gmail-shaped
// cursor is pinned in src/collector-runner.test.ts.

test("backfill mode: historical UID below priorUidnext hydrates attachment bytes in attachment-only mode", async () => {
	const historicalPayload = Buffer.from("ancient invoice bytes");
	const expectedSha = createHash("sha256")
		.update(historicalPayload)
		.digest("hex");
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: Readable.from([historicalPayload]),
				expectedSize: historicalPayload.length,
				mimeType: "application/pdf",
			}),
		uploadBlob: async ({ content, mimeType }) => {
			const chunks: Buffer[] = [];
			for await (const chunk of content) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			return {
				blob_id: `blob_sha256_${expectedSha}`,
				mime_type: mimeType,
				sha256: expectedSha,
				size_bytes: historicalPayload.length,
			};
		},
	});
	const { deps, emitted } = makeHarness({
		hydrateAttachment,
		// Attachment-only backfill mode: matches runAllMailPasses' inner
		// emitMessagesPass call for the historical window.
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	// Wrap emitRecord with summary accounting, like runAllMailPasses does
	// for the historical window. This is what gives the operator-facing
	// PROGRESS payload its hydrated / failed / too_large / unavailable
	// counts.
	const summary = createAttachmentBackfillSummary();
	const originalEmitRecord = deps.emitRecord;
	deps.emitRecord = async (stream, data, _keyField) => {
		await originalEmitRecord(stream, data);
		if (stream === "attachments") {
			addAttachmentBackfillRecordToSummary(summary, data);
		}
	};

	// UID 42 is well below an imagined priorUidnext of 500 — i.e. it is
	// historical and would NOT be revisited by an incremental
	// `priorUidnext:*` pass.
	await emitMessagesPass(deps, [makeAttachmentMsg()]);

	const attachmentRecord = emitted.find((r) => r.stream === "attachments");
	assert.ok(
		attachmentRecord,
		"historical attachment must emit a record under streamsToBackfill",
	);
	assert.equal(attachmentRecord.data.hydration_status, "hydrated");
	assert.equal(attachmentRecord.data.content_sha256, expectedSha);
	assert.equal(blobRefBlobId(attachmentRecord), `blob_sha256_${expectedSha}`);

	// No messages / bodies emitted — backfill is attachment-only.
	assert.equal(
		emitted.filter((r) => r.stream === "messages").length,
		0,
		"backfill mode must not re-emit historical messages records",
	);
	assert.equal(
		emitted.filter((r) => r.stream === "message_bodies").length,
		0,
		"backfill mode must not re-emit historical bodies",
	);

	assert.deepEqual(summary, {
		failed: 0,
		hydrated: 1,
		remaining_historical_gaps: 0,
		too_large: 0,
		unavailable_skipped: 0,
	});
});

test("backfill mode: rerunning the same historical UID is idempotent and the summary stays honest", async () => {
	const payload = Buffer.from("ancient invoice bytes");
	const expectedSha = createHash("sha256").update(payload).digest("hex");
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.resolve({
				content: Readable.from([payload]),
				expectedSize: payload.length,
				mimeType: "application/pdf",
			}),
		uploadBlob: async ({ content, mimeType }) => {
			// Drain to surface upload semantics; content-addressed blob_id
			// is identical across reruns.
			for await (const _ of content) {
				// intentional: only drain
			}
			return {
				blob_id: `blob_sha256_${expectedSha}`,
				mime_type: mimeType,
				sha256: expectedSha,
				size_bytes: payload.length,
			};
		},
	});
	const { deps, emitted } = makeHarness({
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await emitMessagesPass(deps, [makeAttachmentMsg()]);
	await emitMessagesPass(deps, [makeAttachmentMsg()]);

	const attachments = emitted.filter((r) => r.stream === "attachments");
	assert.equal(attachments.length, 2);
	assert.equal(attachments[0]?.data.id, attachments[1]?.data.id);
	assert.equal(
		attachments[0]?.data.content_sha256,
		attachments[1]?.data.content_sha256,
	);
	assert.equal(blobRefBlobId(attachments[0]), blobRefBlobId(attachments[1]));
});

test("backfill mode: a failed historical attachment fetch is kept as a retry gap, not silently dropped", async () => {
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () =>
			Promise.reject(new Error("imap fetch transient failure")),
		uploadBlob: () =>
			Promise.reject(new Error("should not be called when fetch fails")),
	});
	const coverage = makeAttachmentDetailCoverage();
	const { deps, emitted } = makeHarness({
		attachmentCoverage: coverage,
		hydrateAttachment,
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await emitMessagesPass(deps, [makeAttachmentMsg()]);

	// No record is written for the failed part; the failure is a retry gap,
	// which the run emits with its other gaps and counts for the operator.
	assert.equal(
		emitted.some((r) => r.stream === "attachments"),
		false,
	);
	assert.deepEqual(coverage.gapKeys, ["gmmsgid-1111:2"]);
	assert.equal(coverage.failedRecords.length, 1);
});

// ─── redactEmailForProgress ─────────────────────────────────────────────
//
// The "Connected to <address>" PROGRESS message is operator/model-visible.
// Emitting the owner's full Gmail address leaks a raw PII identifier into
// every consumer of the run stream. These tests prove the redaction keeps
// the domain (so the progress line still confirms which account connected)
// while never echoing the full local-part.

test("redactEmailForProgress: masks the local-part but keeps the domain", () => {
	assert.equal(
		redactEmailForProgress("taylor.rivera@example.com"),
		"t***@example.com",
	);
	assert.equal(redactEmailForProgress("alice@example.org"), "a***@example.org");
});

test("redactEmailForProgress: single-character local-part is fully masked", () => {
	// A 1-char local-part would otherwise be wholly revealed by a "keep first
	// char" rule, so it is masked entirely.
	assert.equal(redactEmailForProgress("x@example.com"), "***@example.com");
});

test("redactEmailForProgress: output never contains the full address or local-part", () => {
	for (const address of [
		"the.owner.sample@example.com",
		"first.last+tag@corp.example.co.uk",
		'weird"@"local@host.example', // quoted local-part embedding an @
	]) {
		const redacted = redactEmailForProgress(address);
		assert.ok(
			!redacted.includes(address),
			`redacted output must not contain the full address: ${redacted}`,
		);
		// Multi-char local-parts (the only ones that carry meaningful identity)
		// must never appear verbatim in the redacted output. A 1-char local-part
		// is masked entirely and is excluded here because it can collide with an
		// unrelated character in the kept domain.
		const localPart = address.slice(0, address.lastIndexOf("@"));
		assert.ok(
			!redacted.includes(localPart),
			`redacted output must not contain the full local-part: ${redacted}`,
		);
	}
});

test("redactEmailForProgress: non-address input falls back to a constant placeholder", () => {
	// Defensive: if an unexpected non-email value reaches the progress line we
	// emit a constant rather than risk echoing a raw value.
	assert.equal(redactEmailForProgress("not-an-email"), "[redacted-account]");
	assert.equal(
		redactEmailForProgress("@no-local.example"),
		"[redacted-account]",
	);
	assert.equal(redactEmailForProgress("no-domain@"), "[redacted-account]");
	assert.equal(redactEmailForProgress(""), "[redacted-account]");
});

// ─── Attachments detail-coverage evidence (progress-evidence contract) ───
//
// These pin the honest `considered`/hydrated/gap/skip accounting the Gmail
// connector emits for the `attachments` detail stream. They are the
// regression guard for the progress-evidence wiring: if the connector stops
// recording attempted attachments into the coverage accumulator, or
// misclassifies a hydration outcome, these fail.

/** A single-attachment message keyed `gmmsgid-<n>:1`, for coverage tests. */
function makeSingleAttachmentMsg(emailId: string): FetchMessageObject {
	const bodyStructure: MessageStructureObject = {
		childNodes: [
			{
				type: "application/pdf",
				disposition: "attachment",
				dispositionParameters: { filename: "doc.pdf" },
				encoding: "base64",
				size: 21,
			},
		],
		type: "multipart/mixed",
	};
	return makeMsg({ bodyStructure, emailId });
}

/**
 * A fake hydrator that stamps a chosen terminal `hydration_status` onto every
 * attachment, keyed by the attachment id, so a test can drive each coverage
 * bucket deterministically without exercising the real download/upload path.
 */
function statusStampingHydrator(
	statusById: Record<string, AttachmentRecord["hydration_status"]>,
): HydrateAttachmentFn {
	return (_msg, attachment) => {
		const record = {
			...attachment,
			hydration_status:
				statusById[attachment.id] ?? attachment.hydration_status,
		};
		return Promise.resolve(
			record.hydration_status === "failed"
				? failedResult(record)
				: hydratedResult(record),
		);
	};
}

test("recordAttachmentCoverage: routes each hydration status into the honest bucket", () => {
	const coverage = makeAttachmentDetailCoverage();
	const base: Omit<AttachmentRecord, "id" | "hydration_status"> = {
		blob_ref: null,
		content_id: null,
		content_sha256: null,
		content_type: "application/pdf",
		encoding: "base64",
		filename: "doc.pdf",
		hydration_error: null,
		is_inline: false,
		message_id: "m",
		message_received_at: FROZEN_NOW,
		part_index: "1",
		size_bytes: 10,
	};
	recordAttachmentCoverage(coverage, {
		...base,
		id: "a:1",
		hydration_status: "hydrated",
	});
	recordAttachmentCoverage(coverage, {
		...base,
		id: "b:1",
		hydration_status: "failed",
	});
	recordAttachmentCoverage(coverage, {
		...base,
		id: "c:1",
		hydration_status: "too_large",
	});
	recordAttachmentCoverage(coverage, {
		...base,
		id: "d:1",
		hydration_status: "deferred",
	});

	assert.deepEqual(coverage.requiredKeys, ["a:1", "b:1", "c:1", "d:1"]);
	assert.deepEqual(coverage.hydratedKeys, ["a:1"]);
	assert.deepEqual(coverage.gapKeys, ["b:1"]);
	// too_large and deferred stay required, unaccounted (not in hydrated/gap).
	assert.deepEqual(
		coverage.failedRecords.map((r) => r.record.id),
		["b:1"],
	);
	// No `failure` argument was passed, so the failure class falls back to the
	// same `unclassified_failed` bucket used by the aggregate telemetry.
	assert.deepEqual(
		coverage.failedRecords.map((r) => r.failureClass),
		["unclassified_failed"],
	);
});

test("buildAttachmentDetailCoverageMessage: emits complete zero-attachment coverage", () => {
	const coverage = makeAttachmentDetailCoverage();

	assert.deepEqual(buildAttachmentDetailCoverageMessage(coverage), {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		stream: "attachments",
		state_stream: "messages",
		required_keys: [],
		hydrated_keys: [],
		considered: 0,
		covered: 0,
	});
});

test("buildFullScanCoverageMessage: declares the enumerated boundary as both denominator and numerator", () => {
	// `labels` and `threads` re-enumerate their whole boundary every run and
	// suppress unchanged records, so the boundary size is the honest covered
	// count — a steady-state run that emitted nothing is still fully covered.
	assert.deepEqual(buildFullScanCoverageMessage("labels", 23), {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		stream: "labels",
		state_stream: "labels",
		required_keys: [],
		hydrated_keys: [],
		considered: 23,
		covered: 23,
	});

	// A stream that genuinely enumerated nothing declares a measured zero, which
	// reads as covered — not as an unknown denominator.
	assert.deepEqual(buildFullScanCoverageMessage("threads", 0), {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		stream: "threads",
		state_stream: "threads",
		required_keys: [],
		hydrated_keys: [],
		considered: 0,
		covered: 0,
	});
});

test("buildAttachmentDetailGap: bounded, non-secret gap whose record_key matches the coverage key", () => {
	// A record shaped like the parser produces: id = `<X-GM-MSGID>:<part_index>`.
	const attachment: AttachmentRecord = {
		blob_ref: null,
		content_id: null,
		content_sha256: null,
		content_type: "application/pdf",
		encoding: "base64",
		filename: "invoice.pdf",
		hydration_error:
			"Error: connect ETIMEDOUT 10.0.0.1:993 (https://secret/token=abc)",
		hydration_status: "failed",
		id: "gmmsgid-9999:2",
		is_inline: false,
		message_id: "gmmsgid-9999",
		message_received_at: FROZEN_NOW,
		part_index: "2",
		size_bytes: 4096,
	};

	const gap = buildAttachmentDetailGap(attachment);

	// record_key == the attachment id == the DETAIL_COVERAGE.gap_keys entry, so
	// the host commit-gate credits the missing required key one-to-one.
	assert.equal(gap.record_key, "gmmsgid-9999:2");
	assert.equal(gap.stream, "attachments");
	assert.equal(gap.parent_stream, "messages");
	assert.equal(gap.reason, "temporary_unavailable");
	assert.equal(gap.status, "pending");
	assert.equal(gap.retryable, true);
	assert.equal(gap.reference_only, true);
	// Locator carries only bounded identifiers sufficient for a later retry.
	assert.deepEqual(gap.detail_locator, {
		kind: "gmail.attachment_detail",
		message_id: "gmmsgid-9999",
		part_index: "2",
		attachment_id: "gmmsgid-9999:2",
	});
	// No error block — the raw hydration_error (which here contains a secret-ish
	// URL/token) is NOT carried anywhere on the gap. Defense against leaking
	// tokens, cookies, URLs, request bodies, or payload snippets.
	assert.equal(gap.detail, undefined);
	assert.equal(gap.last_error, undefined);
	const serialized = JSON.stringify(gap);
	assert.ok(
		!serialized.includes("token=abc"),
		"no raw error text crosses the wire",
	);
	assert.ok(
		!serialized.includes("invoice.pdf"),
		"no filename crosses the wire",
	);
	assert.ok(
		!serialized.includes("ETIMEDOUT"),
		"no raw error text crosses the wire",
	);
});

test("processMessage: records an attempted attachment into the coverage accumulator", async () => {
	const coverage = makeAttachmentDetailCoverage();
	const { deps } = makeHarness({
		attachmentCoverage: coverage,
		hydrateAttachment: statusStampingHydrator({ "gmmsgid-1111:2": "hydrated" }),
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await processMessage(deps, makeAttachmentMsg());

	assert.deepEqual(coverage.requiredKeys, ["gmmsgid-1111:2"]);
	assert.deepEqual(coverage.hydratedKeys, ["gmmsgid-1111:2"]);
	assert.deepEqual(coverage.gapKeys, []);
});

test("processMessage: leaves no coverage trace and still emits when no accumulator is wired", async () => {
	// The accumulator is optional: a pass without one (e.g. attachments not in
	// scope) must not throw and must still emit the attachment record.
	const { deps, emitted } = makeHarness({
		hydrateAttachment: statusStampingHydrator({ "gmmsgid-1111:2": "hydrated" }),
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await processMessage(deps, makeAttachmentMsg());

	assert.equal(deps.attachmentCoverage, undefined, "no accumulator wired");
	assert.ok(
		emitted.some((r) => r.stream === "attachments"),
		"attachment record still emits without coverage accounting",
	);
});

test("emitMessagesPass: accumulates honest coverage across hydrated, gap, and unaccounted outcomes", async () => {
	const coverage = makeAttachmentDetailCoverage();
	const { deps, emitted } = makeHarness({
		attachmentCoverage: coverage,
		// ok:1 hydrates, bad:1 fails (gap), big:1 is too_large (unaccounted).
		hydrateAttachment: statusStampingHydrator({
			"ok:1": "hydrated",
			"bad:1": "failed",
			"big:1": "too_large",
		}),
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});

	await emitMessagesPass(deps, [
		makeSingleAttachmentMsg("ok"),
		makeSingleAttachmentMsg("bad"),
		makeSingleAttachmentMsg("big"),
	]);

	assert.deepEqual(coverage.requiredKeys, ["ok:1", "bad:1", "big:1"]);
	assert.deepEqual(coverage.hydratedKeys, ["ok:1"]);
	assert.deepEqual(coverage.gapKeys, ["bad:1"]);
	// too_large stays required, unaccounted. Only the hydrated part writes a
	// record.
	assert.equal(emitted.filter((r) => r.stream === "attachments").length, 1);

	// DETAIL_COVERAGE: covered = hydrated only (no unaccounted keys claimed).
	assert.deepEqual(buildAttachmentDetailCoverageMessage(coverage), {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		stream: "attachments",
		state_stream: "messages",
		required_keys: ["ok:1", "bad:1", "big:1"],
		hydrated_keys: ["ok:1"],
		gap_keys: ["bad:1"],
		considered: 3,
		covered: 1,
	});

	// P0 invariant: every gap_keys entry MUST be backed by a matching durable
	// DETAIL_GAP. `gap_keys` alone do not satisfy the host commit-gate, which
	// credits a missing required key only when it is hydrated, optional-skipped,
	// or backed by a pending DETAIL_GAP with the same record_key. Without this,
	// an otherwise-successful run aborts at commit and re-fetches the same window
	// forever. The failed record is retained on the accumulator; one gap per key.
	assert.deepEqual(
		coverage.failedRecords.map((r) => r.record.id),
		coverage.gapKeys,
		"exactly one retained failed record per gap_keys entry",
	);
	const gaps = coverage.failedRecords.map((r) =>
		buildAttachmentDetailGap(r.record, r.failureClass),
	);
	// The gate matches DETAIL_GAP.record_key against the DETAIL_COVERAGE key.
	assert.deepEqual(
		gaps.map((g) => g.record_key),
		coverage.gapKeys,
	);
	// Exact wire shape of the gap for `bad:1`: bounded, non-secret locator
	// (message + part identifiers only), temporary_unavailable (retryable),
	// pending, reference_only, and a bounded non-secret failure class (no raw
	// hydration_error text — which could echo upstream URLs/tokens — ever
	// crosses; only the category string does).
	assert.deepEqual(gaps[0], {
		type: "DETAIL_GAP",
		stream: "attachments",
		parent_stream: "messages",
		record_key: "bad:1",
		status: "pending",
		reason: "temporary_unavailable",
		detail_locator: {
			kind: "gmail.attachment_detail",
			message_id: "bad",
			part_index: "1",
			attachment_id: "bad:1",
		},
		retryable: true,
		reference_only: true,
		detail: { class: "blob_upload_transport_failed" },
		last_error: { class: "blob_upload_transport_failed" },
	});
	// Defense-in-depth: neither block carries raw hydration_error text (which
	// could echo upstream URLs/tokens) — only the bounded category string.
	assert.deepEqual(gaps[0]?.detail, { class: "blob_upload_transport_failed" });
	assert.deepEqual(gaps[0]?.last_error, {
		class: "blob_upload_transport_failed",
	});
});

// ─── Bounded scope: collection_scope.since mapping to IMAP SINCE ──────────

test("isoToImapDate: converts ISO 8601 timestamp to IMAP DD-MMM-YYYY date", () => {
	assert.equal(isoToImapDate("2026-08-09T22:07:20.000Z"), "09-Aug-2026");
	assert.equal(isoToImapDate("2026-01-01T00:00:00.000Z"), "01-Jan-2026");
	assert.equal(isoToImapDate("2026-12-31T23:59:59.999Z"), "31-Dec-2026");
});

test("isoToImapDate: returns null for undefined, malformed, or unparseable input", () => {
	assert.equal(isoToImapDate(undefined), null);
	assert.equal(isoToImapDate(""), null);
	assert.equal(isoToImapDate("not a date"), null);
	assert.equal(isoToImapDate("2026-13-01"), null);
	assert.equal(isoToImapDate("not-iso-string"), null);
});

test("isoToImapDate: handles edge-case dates (leap year, month boundaries)", () => {
	// Leap year Feb 29
	assert.equal(isoToImapDate("2024-02-29T00:00:00.000Z"), "29-Feb-2024");
	// Non-leap year Feb 28
	assert.equal(isoToImapDate("2025-02-28T00:00:00.000Z"), "28-Feb-2025");
	// Day boundaries
	assert.equal(isoToImapDate("2026-02-01T00:00:00.000Z"), "01-Feb-2026");
	assert.equal(isoToImapDate("2026-02-28T23:59:59.999Z"), "28-Feb-2026");
});

// ─── Bounded scope: collectMetadata with SINCE search + post-filtering ────

test("collectMetadata: cursor + since intersection preserves incremental fetch range", async () => {
	const originalEmit = globalThis.process.stdout.write;
	try {
		globalThis.process.stdout.write = (() => true) as any;

		const search = mock.fn(async () => {
			// SINCE returns UIDs >= date, including older ones from full history
			return [150, 151, 200, 201];
		});

		const fetch = mock.fn(async function* (range: string) {
			// Must intersect with incremental range "200:*", not replace it
			// Expected: "200,201" (only UIDs in both search result AND range 200:*)
			assert.equal(
				range,
				"200,201",
				"must intersect SINCE result with incremental range, not replace",
			);
			for (const uid of [200, 201]) {
				yield makeMsg({
					uid,
					emailId: `msg${uid}`,
					internalDate: new Date("2026-08-09"),
				});
			}
		});

		const client: Pick<ImapFlow, "search" | "fetch"> = {
			search,
			fetch,
		};

		const metas = await collectMetadata(
			client,
			"200:*",
			"09-Aug-2026",
			"2026-08-09T00:00:00Z",
		);

		assert.equal(metas.length, 2, "only UIDs in both ranges should be fetched");
	} finally {
		globalThis.process.stdout.write = originalEmit;
	}
});

test("collectMetadata: same-day pre-boundary records are filtered out (day-granular IMAP, second-precise boundary)", async () => {
	const originalEmit = globalThis.process.stdout.write;
	try {
		globalThis.process.stdout.write = (() => true) as any;

		const search = mock.fn(async () => {
			// IMAP SINCE "09-Aug-2026" includes all day-granular on 2026-08-09
			return [100, 101];
		});

		const fetch = mock.fn(async function* (range: string) {
			if (range === "100,101") {
				// UID 100: 08:00 AM (before 14:00:00 boundary) — should skip
				yield makeMsg({
					uid: 100,
					emailId: "early",
					internalDate: new Date("2026-08-09T08:00:00Z"),
				});
				// UID 101: 14:00 PM (at/after 14:00:00 boundary) — should keep
				yield makeMsg({
					uid: 101,
					emailId: "late",
					internalDate: new Date("2026-08-09T14:00:00Z"),
				});
			}
		});

		const client: Pick<ImapFlow, "search" | "fetch"> = {
			search,
			fetch,
		};

		const metas = await collectMetadata(
			client,
			"100:101",
			"09-Aug-2026",
			"2026-08-09T14:00:00Z",
		);

		assert.equal(
			metas.length,
			1,
			"only message at/after exact boundary should be kept",
		);
		assert.equal(
			metas[0]?.emailId as string,
			"late",
			"late message (at boundary) should be kept",
		);
	} finally {
		globalThis.process.stdout.write = originalEmit;
	}
});

test("collectMetadata: verified empty — IMAP search returns no UIDs", async () => {
	const originalEmit = globalThis.process.stdout.write;
	try {
		globalThis.process.stdout.write = (() => true) as any;

		const search = mock.fn(async () => {
			// No messages in the declared date range
			return [];
		});

		// biome-ignore lint/correctness/useYield: generator never yields by design — it throws immediately to prove the caller never reaches fetch.
		const fetch = mock.fn(async function* () {
			// Should never be called
			throw new Error("fetch must not be called on empty search");
		});

		const client: Pick<ImapFlow, "search" | "fetch"> = {
			search,
			fetch,
		};

		const metas = await collectMetadata(
			client,
			"1:*",
			"09-Aug-2030",
			"2026-08-09T00:00:00Z",
		);

		assert.equal(metas.length, 0, "empty search result returns empty array");
		assert.equal(fetch.mock.callCount(), 0, "fetch not called on empty search");
	} finally {
		globalThis.process.stdout.write = originalEmit;
	}
});

test("collectMetadata: interrupted search (exception) withholdsProof — fetch not called", async () => {
	const originalEmit = globalThis.process.stdout.write;
	try {
		globalThis.process.stdout.write = (() => true) as any;

		const search = mock.fn(async () => {
			throw new Error("IMAP search failed: network timeout");
		});

		// biome-ignore lint/correctness/useYield: generator never yields by design — it throws immediately to prove the caller never reaches fetch.
		const fetch = mock.fn(async function* () {
			// Should never be called
			throw new Error("fetch must not be called if search fails");
		});

		const client: Pick<ImapFlow, "search" | "fetch"> = {
			search,
			fetch,
		};

		try {
			await collectMetadata(
				client,
				"1:*",
				"09-Aug-2026",
				"2026-08-09T00:00:00Z",
			);
			assert.fail("should propagate search exception");
		} catch (e) {
			assert.ok(e instanceof Error);
			assert.match((e as Error).message, /network timeout/);
			assert.equal(
				fetch.mock.callCount(),
				0,
				"fetch not called when search throws",
			);
		}
	} finally {
		globalThis.process.stdout.write = originalEmit;
	}
});

test("collectMetadata: without sinceDate/sinceIso (null), full range unchanged behavior", async () => {
	const originalEmit = globalThis.process.stdout.write;
	try {
		globalThis.process.stdout.write = (() => true) as any;

		const search = mock.fn(async () => {
			throw new Error("search must not be called when sinceDate is null");
		});

		const fetch = mock.fn(async function* (range: string) {
			if (range === "200:*") {
				yield makeMsg({
					uid: 200,
					emailId: "msg200",
					internalDate: new Date("2026-08-08"),
				});
				yield makeMsg({
					uid: 201,
					emailId: "msg201",
					internalDate: new Date("2026-08-09"),
				});
			}
		});

		const client: Pick<ImapFlow, "search" | "fetch"> = {
			search,
			fetch,
		};

		// sinceDate=null, sinceIso=null → no search, no post-filter
		const metas = await collectMetadata(client, "200:*", null, null);

		assert.equal(metas.length, 2, "all messages in range returned");
		assert.equal(
			search.mock.callCount(),
			0,
			"no search when sinceDate is null",
		);
	} finally {
		globalThis.process.stdout.write = originalEmit;
	}
});

test("collectMetadata: offset-equivalence in boundary comparison (epoch milliseconds, not lexical)", async () => {
	const originalEmit = globalThis.process.stdout.write;
	try {
		globalThis.process.stdout.write = (() => true) as any;

		const search = mock.fn(async () => [100, 101]);

		const fetch = mock.fn(async function* (range: string) {
			if (range === "100,101") {
				// Both messages at 2026-08-09T14:00:00 UTC, same instant different representations
				yield makeMsg({
					uid: 100,
					emailId: "utc",
					// 14:00:00 UTC
					internalDate: new Date("2026-08-09T14:00:00Z"),
				});
				yield makeMsg({
					uid: 101,
					emailId: "offset",
					// Same instant as UID 100: 14:00:00 UTC = 10:00:00 EDT (-04:00)
					internalDate: new Date("2026-08-09T10:00:00-04:00"),
				});
			}
		});

		const client: Pick<ImapFlow, "search" | "fetch"> = {
			search,
			fetch,
		};

		// Boundary: 2026-08-09T14:00:00Z (UTC)
		// UID 100: 2026-08-09T14:00:00Z (exact match)
		// UID 101: 2026-08-09T10:00:00-04:00 (same instant via offset)
		// Both should be included; epoch comparison (not lexical) proves equivalence
		const metas = await collectMetadata(
			client,
			"100:101",
			"09-Aug-2026",
			"2026-08-09T14:00:00Z",
		);

		assert.equal(
			metas.length,
			2,
			"both messages at same instant (different offsets) should be included",
		);
		assert.deepEqual(
			metas.map((m) => m.emailId),
			["utc", "offset"],
		);
	} finally {
		globalThis.process.stdout.write = originalEmit;
	}
});

test("collectMetadata: missing internalDate with exact since withholdsProof and stops enumeration", async () => {
	const originalEmit = globalThis.process.stdout.write;
	try {
		globalThis.process.stdout.write = (() => true) as any;

		const search = mock.fn(async () => [100, 101]);

		const fetch = mock.fn(async function* (range: string) {
			if (range === "100,101") {
				// UID 100: has valid internalDate
				yield makeMsg({
					uid: 100,
					emailId: "valid",
					internalDate: new Date("2026-08-10"),
				});
				// UID 101: missing internalDate (IMAP does not guarantee it)
				const msgWithoutDate = makeMsg({ uid: 101, emailId: "missing" });
				const { internalDate: _internalDate, ...rest } = msgWithoutDate;
				yield rest;
			}
		});

		const client: Pick<ImapFlow, "search" | "fetch"> = {
			search,
			fetch,
		};

		// exact sinceIso requires all messages to prove they're in scope.
		// Missing internalDate throws error to prevent STATE commit.
		try {
			await collectMetadata(
				client,
				"100:101",
				"09-Aug-2026",
				"2026-08-10T00:00:00Z",
			);
			assert.fail("should throw on missing internalDate");
		} catch (e) {
			assert.ok(e instanceof Error, "error thrown");
			assert.match(e.message, /UID 101/, "error identifies problematic UID");
			assert.match(
				e.message,
				/missing/,
				"error indicates missing internalDate",
			);
		}
	} finally {
		globalThis.process.stdout.write = originalEmit;
	}
});

test("collectMetadata: unparseable internalDate with exact since withholdsProof", async () => {
	const originalEmit = globalThis.process.stdout.write;
	try {
		globalThis.process.stdout.write = (() => true) as any;

		const search = mock.fn(async () => [100, 101]);

		const fetch = mock.fn(async function* (range: string) {
			if (range === "100,101") {
				// UID 100: valid date
				yield makeMsg({
					uid: 100,
					emailId: "valid",
					internalDate: new Date("2026-08-10"),
				});
				// UID 101: unparseable date string
				yield makeMsg({
					uid: 101,
					emailId: "invalid",
					internalDate: "not-a-date",
				});
			}
		});

		const client: Pick<ImapFlow, "search" | "fetch"> = {
			search,
			fetch,
		};

		try {
			await collectMetadata(
				client,
				"100:101",
				"09-Aug-2026",
				"2026-08-10T00:00:00Z",
			);
			assert.fail("should throw on unparseable internalDate");
		} catch (e) {
			assert.ok(e instanceof Error, "error thrown");
			assert.match(e.message, /UID 101/, "error identifies problematic UID");
			assert.match(
				e.message,
				/unparseable/,
				"error indicates unparseable internalDate",
			);
		}
	} finally {
		globalThis.process.stdout.write = originalEmit;
	}
});

// ─── Evidence: Missing internalDate prevents STATE commit in real orchestration ───

test("runAllMailPasses: missing internalDate under declared since propagates uncaught, no messages STATE emitted", async () => {
	// ORCHESTRATION-LEVEL EVIDENCE: exercises runAllMailPasses itself (not just
	// collectMetadata in isolation) with a fake ImapFlow client whose fetch
	// yields a message missing internalDate under a declared collection_scope.since
	// boundary. Proves the thrown MissingOrInvalidInternalDateError propagates all
	// the way out of orchestration, and that the final messages STATE cursor —
	// emitted only at the very end of runAllMailPasses, after collectMetadata,
	// emitMessagesPass, attachment backfill, and the delta pass — never commits.
	//
	// EVIDENCE DISCRIMINATOR: fails against 7304ce2fe (early return), which
	// would let orchestration proceed past collectMetadata, emit records, and
	// commit the messages STATE cursor despite an unproven boundary. Only the
	// exception-throwing version (9cd5f1c76+) blocks STATE commit here.

	const originalWrite = globalThis.process.stdout.write;
	const emittedLines: Array<{ type: string; stream?: string }> = [];
	globalThis.process.stdout.write = ((data: string): boolean => {
		if (typeof data === "string") {
			try {
				const msg = JSON.parse(data) as { type: string; stream?: string };
				emittedLines.push(
					msg.stream === undefined
						? { type: msg.type }
						: { type: msg.type, stream: msg.stream },
				);
			} catch {
				// Ignore malformed lines
			}
		}
		return true;
	}) as typeof process.stdout.write;

	try {
		const sinceIso = "2026-08-10T00:00:00Z";

		const search = mock.fn(async () => [101]);
		const fetch = mock.fn(async function* (range: string) {
			if (range === "101") {
				const msg = makeMsg({ uid: 101, emailId: "test-no-date" });
				const { internalDate: _internalDate, ...rest } = msg;
				yield rest; // real IMAP message missing internalDate
			}
		});

		const client: Pick<
			ImapFlow,
			"close" | "download" | "fetch" | "fetchOne" | "mailbox" | "search"
		> = {
			close: mock.fn(),
			download: () => {
				throw new Error(
					"download must not be called: no attachments requested",
				);
			},
			fetchOne: () => {
				throw new Error(
					"fetchOne must not be called: missing internalDate throws before the body pass",
				);
			},
			mailbox: {
				delimiter: "/",
				exists: 1,
				flags: new Set<string>(),
				path: "[Gmail]/All Mail",
				uidNext: 200,
				uidValidity: 1n,
			},
			search,
			fetch,
		};

		const allMail: ListResponse = {
			path: "[Gmail]/All Mail",
			delimiter: "/",
			flags: new Set<string>(),
			specialUse: "\\All",
		} as ListResponse;

		const requested = makeRequested(["messages"]);
		requested.set("messages", {
			name: "messages",
			time_range: { since: sinceIso },
		});
		const deps = {
			emitRecord: async () => true,
			emittedAt: FROZEN_NOW,
			requested,
		};

		// No prior state → full resync → fetchRange "1:*", intersected down to
		// "101" by the declared-since search result.
		await assert.rejects(
			() => runAllMailPasses(client, allMail, {}, deps),
			(e: unknown) => e instanceof Error && /UID 101/.test(e.message),
			"runAllMailPasses must propagate the missing-internalDate error uncaught",
		);

		const records = emittedLines.filter((m) => m.type === "RECORD");
		const messagesState = emittedLines.filter(
			(m) => m.type === "STATE" && m.stream === "messages",
		);

		assert.equal(
			records.length,
			0,
			"no RECORD messages emitted before the throw",
		);
		assert.equal(
			messagesState.length,
			0,
			"messages STATE cursor never committed",
		);
	} finally {
		globalThis.process.stdout.write = originalWrite;
	}
});

// ─── Invariant: DONE is terminal on the wire ────────────────────────────────

test("emit: suppresses any message written after DONE", async () => {
	// REGRESSION EVIDENCE. Production gmail runs failed
	// `connector_protocol_violation "Connector emitted RECORD after DONE"`
	// (runs run_1787331290490_1, run_1787332551497_1, run_1787333444049 on
	// 2026-08-21), reporting 82 records emitted against 18 flushed — the
	// surplus was written after the runtime had already latched DONE.
	//
	// The cause is that no terminal path stops the process: `flushAndExit`
	// registers listeners and RETURNS (connector-exit.ts waits for the runtime
	// to close stdin), so interrupted in-flight work keeps emitting. The
	// channel itself therefore has to refuse the write.
	//
	// EVIDENCE DISCRIMINATOR: with the `doneEmitted` latch removed from
	// `emit`, the RECORD below is written to stdout and this test fails on
	// `afterDone.length`.
	__resetDoneLatchForTests();
	const lines: string[] = [];
	const originalWrite = globalThis.process.stdout.write;
	globalThis.process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		lines.push(String(chunk));
		return true;
	}) as typeof globalThis.process.stdout.write;
	try {
		await gmailEmitForTests({ type: "PROGRESS", message: "before" });
		await gmailEmitForTests({
			type: "DONE",
			status: "succeeded",
			records_emitted: 1,
		});
		await gmailEmitForTests({
			type: "RECORD",
			stream: "messages",
			key: "k",
			data: {},
			emitted_at: "2026-08-21T00:00:00.000Z",
		});
		await gmailEmitForTests({
			type: "DONE",
			status: "failed",
			records_emitted: 0,
		});
	} finally {
		globalThis.process.stdout.write = originalWrite;
		__resetDoneLatchForTests();
	}

	const parsed = lines.map(
		(l) => JSON.parse(l) as { status?: string; type: string },
	);
	const doneIndex = parsed.findIndex((m) => m.type === "DONE");
	assert.ok(doneIndex >= 0, "the DONE itself is written");
	const afterDone = parsed.slice(doneIndex + 1);
	assert.deepEqual(
		afterDone,
		[],
		"nothing may be written to stdout after DONE",
	);
	assert.equal(
		parsed.filter((m) => m.type === "DONE").length,
		1,
		"a second DONE is suppressed too",
	);
	assert.equal(
		parsed.filter((m) => m.type === "RECORD").length,
		0,
		"the post-DONE RECORD never reaches the runtime",
	);
});

// ─── Invariant: the delta pass never blanks an already-collected envelope ───

test("runDeltaPass: issues no IMAP command while the delta FETCH iterator is open", async () => {
	// REGRESSION EVIDENCE. imapflow multiplexes one command at a time over a
	// single connection, so a nested command issued mid-iteration hangs the
	// outer iterator — the rule `runAllMailPasses` states at its own Phase A/B
	// boundary. The delta pass called `fetchBodies` (a `fetchOne`) inside its
	// `for await`, which wedged the run after "Fetching flag/label deltas"
	// until a timeout, then tripped the post-DONE guard as the abandoned
	// iterator drained.
	//
	// EVIDENCE DISCRIMINATOR: with the snippet fetch moved back inside the
	// `for await`, `openWhileFetching` records a nested call and this fails.
	const emitted: Array<{ stream: string }> = [];
	let iteratorOpen = false;
	const openWhileFetching: string[] = [];

	// biome-ignore lint/suspicious/useAwait: stands in for ImapFlow.fetch's async-iterable-returning signature.
	const fetch = mock.fn(async function* () {
		iteratorOpen = true;
		try {
			yield makeMsg({ uid: 200, emailId: "gmmsgid-a" });
			yield makeMsg({ uid: 201, emailId: "gmmsgid-b" });
		} finally {
			iteratorOpen = false;
		}
	});

	const fetchBodies = mock.fn(() => {
		if (iteratorOpen) {
			openWhileFetching.push("nested");
		}
		return Promise.resolve({
			bodyHtmlFull: null,
			bodyTextFull: null,
			snippet: "s",
		});
	});

	await runDeltaPass(
		{ fetch } as unknown as Pick<ImapFlow, "fetch">,
		{ fullResync: false, priorModseq: 1n } as unknown as Parameters<
			typeof runDeltaPass
		>[1],
		makeRequested(["messages"]),
		((stream: string): Promise<void> => {
			emitted.push({ stream });
			return Promise.resolve();
		}) as unknown as Parameters<typeof runDeltaPass>[3],
		"2026-08-20T00:00:00.000Z",
		fetchBodies as unknown as Parameters<typeof runDeltaPass>[5],
	);

	assert.deepEqual(
		openWhileFetching,
		[],
		"no body fetch may run while the delta FETCH iterator is open",
	);
	assert.equal(
		emitted.length,
		2,
		"both delta messages still emit after the iterator drains",
	);
});

test("runDeltaPass: emits a WHOLE messages record, never a null-envelope shell", async () => {
	// REGRESSION EVIDENCE. `records` upserts replace `record_json` wholesale, so
	// a delta record carrying null envelope fields overwrites — and destroys —
	// the stored subject/sender/date/size/snippet of a message that had them.
	// Observed live: 2,534 distinct Gmail messages had been hollowed at least
	// once, 981 were hollow at rest, each re-hollowed on every label change.
	//
	// EVIDENCE DISCRIMINATOR: against the pre-fix code (`envelope: false` in the
	// delta query + `buildDeltaMessageRecord`) every assertion below on subject,
	// from_email, date, size_bytes, snippet and received_at fails — that version
	// emitted exactly the null shell this test forbids.
	const emitted: Array<{ data: Record<string, unknown>; stream: string }> = [];
	const emitRecord = (
		stream: string,
		data: Record<string, unknown>,
	): Promise<void> => {
		emitted.push({ data, stream });
		return Promise.resolve();
	};

	const delta = makeMsg({
		uid: 100,
		emailId: "gmmsgid-delta",
		flags: new Set(["\\Seen", "\\Flagged"]),
	});
	// biome-ignore lint/suspicious/useAwait: stands in for ImapFlow.fetch's async-iterable-returning signature.
	const fetch = mock.fn(async function* () {
		yield delta;
	});

	const fetchBodies = mock.fn(() =>
		Promise.resolve({
			bodyHtmlFull: null,
			bodyTextFull: null,
			snippet: "a real snippet",
		}),
	);

	const result = await runDeltaPass(
		{ fetch } as unknown as Pick<ImapFlow, "fetch">,
		{ fullResync: false, priorModseq: 1n } as unknown as Parameters<
			typeof runDeltaPass
		>[1],
		makeRequested(["messages"]),
		emitRecord,
		"2026-08-20T00:00:00.000Z",
		fetchBodies as unknown as Parameters<typeof runDeltaPass>[5],
	);

	// Regression guard: a clean run (nothing skipped) must NOT tell the
	// caller to hold highest_modseq back.
	assert.equal(result.skippedAnyMessage, false);

	const rec = emitted.find((r) => r.stream === "messages");
	assert.ok(rec, "delta pass emits a messages record");
	assert.equal(
		rec.data.subject,
		"Test subject",
		"subject survives a flag delta",
	);
	assert.equal(
		rec.data.from_email,
		"alice@example.com",
		"sender survives a flag delta",
	);
	assert.equal(
		rec.data.date,
		"2026-04-20T10:00:00.000Z",
		"Date header survives a flag delta",
	);
	assert.equal(rec.data.size_bytes, 1024, "size survives a flag delta");
	assert.equal(
		rec.data.snippet,
		"a real snippet",
		"snippet is re-derived, not blanked",
	);
	assert.equal(
		rec.data.received_at,
		"2026-04-20T10:00:05.000Z",
		"received_at keeps the message's own internalDate, not the run clock",
	);
	// The flag change itself must still land — that is the point of the pass.
	assert.equal(rec.data.is_flagged, true, "the flag delta is applied");
});

test("runDeltaPass: skips a message the server returns without an envelope", async () => {
	// Skipping preserves the stored row. Emitting a partial record would blank
	// it, which is the very defect above — so absent an envelope there is no
	// safe record to write, and losing one flag update is the cheaper loss.
	const emitted: Array<{ stream: string }> = [];
	const emitRecord = (stream: string): Promise<void> => {
		emitted.push({ stream });
		return Promise.resolve();
	};
	const { envelope: _envelope, ...noEnvelope } = makeMsg({
		uid: 101,
		emailId: "gmmsgid-no-env",
	});
	// biome-ignore lint/suspicious/useAwait: stands in for ImapFlow.fetch's async-iterable-returning signature.
	const fetch = mock.fn(async function* () {
		yield noEnvelope;
	});
	const fetchBodies = mock.fn(() =>
		Promise.resolve({ bodyHtmlFull: null, bodyTextFull: null, snippet: null }),
	);

	const result = await runDeltaPass(
		{ fetch } as unknown as Pick<ImapFlow, "fetch">,
		{ fullResync: false, priorModseq: 1n } as unknown as Parameters<
			typeof runDeltaPass
		>[1],
		makeRequested(["messages"]),
		emitRecord as unknown as Parameters<typeof runDeltaPass>[3],
		"2026-08-20T00:00:00.000Z",
		fetchBodies as unknown as Parameters<typeof runDeltaPass>[5],
	);

	assert.equal(
		emitted.length,
		0,
		"no record emitted when the envelope is absent",
	);
	// Same defect as the failed-snippet skip: this message's flag/label
	// change is being left uncovered, so the caller must be told to hold
	// highest_modseq back — otherwise `changedSince` never re-examines it.
	assert.equal(
		result.skippedAnyMessage,
		true,
		"the envelope-absent skip must also report a coverage gap to the caller",
	);
});

// ─── Per-part size honesty (RFC822.SIZE is the MESSAGE, not the part) ────────

test("fetchAttachmentPart: reports the PART's BODYSTRUCTURE size, never the message-wide RFC822.SIZE", async () => {
	// imapflow sets `meta.expectedSize` from the FETCH RFC822.SIZE item, which
	// is the size of the WHOLE MESSAGE — identical for every part. Trusting it
	// as a per-attachment size made a message reject all of its attachments
	// whenever their SUM crossed the cap.
	const MESSAGE_WIDE_SIZE = 35_962_168;
	const PART_SIZE = 4_154_730;
	const download = mock.fn(() =>
		Promise.resolve({
			content: Readable.from([Buffer.alloc(8, 0x41)]),
			meta: { contentType: "application/pdf", expectedSize: MESSAGE_WIDE_SIZE },
		}),
	);

	const result = await fetchAttachmentPart(
		{ download } as unknown as Pick<ImapFlow, "download">,
		makeMsg({ uid: 7 }),
		{
			content_type: "application/pdf",
			id: "m:2",
			part_index: "2",
			size_bytes: PART_SIZE,
		} as AttachmentRecord,
	);

	assert.equal(
		result.expectedSize,
		PART_SIZE,
		"expectedSize must be the part's own BODYSTRUCTURE size, not the message's RFC822.SIZE",
	);
	assert.notEqual(
		result.expectedSize,
		MESSAGE_WIDE_SIZE,
		"the message-wide size must never be surfaced as a part size",
	);
});

test("fetchAttachmentPart: reports unknown (null) rather than substituting the message-wide size", async () => {
	// When BODYSTRUCTURE gives no per-part size there is no honest pre-flight
	// number. `enforceMaxBytes` still counts real bytes mid-stream, so the
	// right answer is "unknown", not a message-scoped stand-in.
	const download = mock.fn(() =>
		Promise.resolve({
			content: Readable.from([Buffer.alloc(8, 0x41)]),
			meta: { contentType: "application/pdf", expectedSize: 30_000_000 },
		}),
	);

	const result = await fetchAttachmentPart(
		{ download } as unknown as Pick<ImapFlow, "download">,
		makeMsg({ uid: 7 }),
		{
			content_type: "application/pdf",
			id: "m:2",
			part_index: "2",
			size_bytes: null,
		} as AttachmentRecord,
	);

	assert.equal(result.expectedSize, null, "an unknown part size stays unknown");
});

test("makeAttachmentHydrator: many small attachments summing over the cap all hydrate", async () => {
	// The live defect: one message held 8 attachments of ~4.5 MB each. Every one
	// was marked too_large against the 25 MiB per-attachment cap using the
	// message's 35,962,168-byte total. None was individually close to the cap.
	const MESSAGE_WIDE_SIZE = 35_962_168;
	const PART_SIZE = 4_154_730;
	const payload = Buffer.alloc(64, 0x41);
	const uploadBlob = mock.fn(
		({ content }: { content: AsyncIterable<Buffer | Uint8Array | string> }) =>
			(async () => {
				let bytes = 0;
				for await (const chunk of content) {
					bytes += Buffer.isBuffer(chunk)
						? chunk.byteLength
						: Buffer.from(chunk).byteLength;
				}
				return {
					blob_id: "blob_ok",
					mime_type: "application/pdf",
					sha256: "0".repeat(64),
					size_bytes: bytes,
				};
			})(),
	);
	const hydrate = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		// Mirrors imapflow: meta.expectedSize is the message-wide RFC822.SIZE.
		fetchAttachment: (_msg, attachment) =>
			Promise.resolve({
				content: Readable.from([payload]),
				expectedSize: attachment.size_bytes,
				mimeType: "application/pdf",
			}),
		maxBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
		uploadBlob,
	});

	const result = await hydrate(makeMsg({ uid: 9 }), {
		content_type: "application/pdf",
		id: "m:3",
		part_index: "3",
		size_bytes: PART_SIZE,
	} as AttachmentRecord);

	assert.equal(
		result.record.hydration_status,
		"hydrated",
		"a 4 MB part under a 25 MiB cap must hydrate",
	);
	// Guards the fixture's premise: the message total really is over the cap
	// while the single part really is under it, so this test would fail if the
	// message-wide size were ever reinstated as the per-part size.
	assert.ok(
		MESSAGE_WIDE_SIZE > DEFAULT_MAX_ATTACHMENT_BYTES,
		"the message total is over the cap",
	);
	assert.ok(
		PART_SIZE < DEFAULT_MAX_ATTACHMENT_BYTES,
		"the individual part is under the cap",
	);
});

test("makeAttachmentHydrator: a genuinely oversized part is still refused", async () => {
	// The cap must keep working. This is the one real case on the live mailbox:
	// a single 32,122,600-byte attachment over the 25 MiB cap.
	const uploadBlob = mock.fn(() =>
		Promise.reject(new Error("must not upload")),
	);
	const hydrate = makeAttachmentHydrator({
		connectorId: "https://registry.pdpp.dev/connectors/gmail",
		fetchAttachment: () => Promise.reject(new Error("must not download")),
		maxBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
		uploadBlob,
	});

	const result = await hydrate(makeMsg({ uid: 9 }), {
		content_type: "application/octet-stream",
		id: "m:2",
		part_index: "2",
		size_bytes: 32_122_600,
	} as AttachmentRecord);

	assert.equal(result.record.hydration_status, "too_large");
	assert.match(
		String(result.record.hydration_error),
		/exceeds max size: 32122600 > 26214400 bytes/,
	);
	assert.equal(
		uploadBlob.mock.callCount(),
		0,
		"an over-cap part is refused before any transfer",
	);
});

// ─── Coverage honesty: withhold the claim without a boundary ────────────────

test("processMessage: rejected local attachment emission stays required-only and retries", async () => {
	const coverage = makeAttachmentDetailCoverage();
	const first = makeHarness({
		attachmentCoverage: coverage,
		hydrateAttachment: statusStampingHydrator({ "gmmsgid-1111:2": "hydrated" }),
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});
	let attempts = 0;
	first.deps.emitRecord = async () => {
		attempts += 1;
		return false;
	};
	await processMessage(first.deps, makeAttachmentMsg());
	assert.equal(attempts, 1, "the real message path attempted emission");
	assert.deepEqual(coverage.requiredKeys, ["gmmsgid-1111:2"]);
	assert.deepEqual(
		coverage.hydratedKeys,
		[],
		"a rejected record cannot credit hydration",
	);
	assert.deepEqual(coverage.gapKeys, []);
	assert.equal(buildAttachmentDetailCoverageMessage(coverage).covered, 0);
	assert.equal(
		first.protocolMessages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
		false,
	);

	const retryCoverage = makeAttachmentDetailCoverage();
	const retry = makeHarness({
		attachmentCoverage: retryCoverage,
		hydrateAttachment: statusStampingHydrator({ "gmmsgid-1111:2": "hydrated" }),
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});
	await processMessage(retry.deps, makeAttachmentMsg());
	assert.equal(
		retry.emitted.filter((r) => r.stream === "attachments").length,
		1,
	);
	assert.deepEqual(retryCoverage.hydratedKeys, ["gmmsgid-1111:2"]);
});

test("processMessage: throwing local attachment emission cannot credit hydration", async () => {
	const coverage = makeAttachmentDetailCoverage();
	const { deps } = makeHarness({
		attachmentCoverage: coverage,
		hydrateAttachment: statusStampingHydrator({ "gmmsgid-1111:2": "hydrated" }),
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});
	deps.emitRecord = async () => {
		throw new Error("local emission failed");
	};
	await assert.rejects(
		processMessage(deps, makeAttachmentMsg()),
		/local emission failed/,
	);
	assert.deepEqual(coverage.requiredKeys, ["gmmsgid-1111:2"]);
	assert.deepEqual(coverage.hydratedKeys, []);
});

test("recoverServedAttachmentGaps: rejected emission leaves the served gap unrecovered", async () => {
	const message = makeServedRecoveryMsg({
		attachments: [16],
		emailId: "gmmsgid-credit",
		uid: 6000,
	});
	const coverage = makeAttachmentDetailCoverage();
	const harness = makeRecordingEmit();
	let attempts = 0;
	const summary = await recoverServedAttachmentGaps(
		{
			search: mock.fn(() => Promise.resolve([6000])),
			fetchOne: mock.fn(() => Promise.resolve(message)),
		},
		{
			attachmentCoverage: coverage,
			detailGaps: [
				makeServedRecoveryGap({
					gapId: "gap-credit",
					messageId: "gmmsgid-credit",
					partIndex: 1,
				}),
			],
			emitProtocol: harness.emit,
			emitRecord: async () => {
				attempts += 1;
				return false;
			},
			hydrateAttachment: async (_message, attachment) =>
				hydratedResult({
					...attachment,
					hydration_status: "hydrated",
					hydration_error: null,
				}),
		},
	);
	assert.equal(attempts, 1);
	assert.equal(summary.recovered, 0);
	assert.deepEqual(coverage.requiredKeys, ["gmmsgid-credit:1"]);
	assert.deepEqual(coverage.hydratedKeys, []);
	assert.equal(
		harness.protocolMessages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
		false,
	);
});

test("recoverServedAttachmentGaps: a rejected emission re-defers its served gap for this run", async () => {
	const message = makeServedRecoveryMsg({
		attachments: [16],
		emailId: "abc456",
		uid: 6001,
	});
	const coverage = makeAttachmentDetailCoverage();
	const harness = makeRecordingEmit();
	await recoverServedAttachmentGaps(
		{
			search: mock.fn(() => Promise.resolve([6001])),
			fetchOne: mock.fn(() => Promise.resolve(message)),
		},
		{
			attachmentCoverage: coverage,
			detailGaps: [
				makeServedRecoveryGap({
					gapId: "gap-reject",
					leaseId: "lease-reject",
					messageId: "abc456",
					partIndex: 1,
				}),
			],
			emitProtocol: harness.emit,
			emitRecord: async () => false,
			hydrateAttachment: async (_message, attachment) =>
				hydratedResult({
					...attachment,
					hydration_status: "hydrated",
					hydration_error: null,
				}),
		},
	);
	// The host credits a required key only against a gap it settled in this
	// run. An untouched served gap from an earlier run does not count, so
	// without a re-deferral this key blocks the messages checkpoint every run.
	assert.deepEqual(coverage.requiredKeys, ["abc456:1"]);
	assert.deepEqual(coverage.hydratedKeys, []);
	assert.deepEqual(coverage.gapKeys, ["abc456:1"]);
	const gaps = harness.protocolMessages.filter(
		(m) =>
			m.type === "DETAIL_GAP" &&
			m.stream === "attachments" &&
			m.record_key === "abc456:1",
	);
	assert.equal(gaps.length, 1, JSON.stringify(harness.protocolMessages));
	assert.ok(gaps[0]?.type === "DETAIL_GAP");
	assert.equal(gaps[0].gap_id, "gap-reject");
	assert.equal(gaps[0].lease_id, "lease-reject");
	assert.equal(coverage.localEmitRejected, false);
});

function coverageRecord(
	status: AttachmentRecord["hydration_status"],
): AttachmentRecord {
	return {
		blob_ref: null,
		content_id: null,
		content_sha256: null,
		content_type: "application/pdf",
		encoding: null,
		filename: "a.pdf",
		hydration_error: null,
		hydration_status: status,
		id: "abc123:1",
		is_inline: false,
		message_id: "abc123",
		message_received_at: FROZEN_NOW,
		part_index: "1",
		size_bytes: 16,
	};
}

test("recordAttachmentCoverage: a key visited twice keeps one outcome set (walk gap, then served hydration)", () => {
	const coverage = makeAttachmentDetailCoverage();
	recordAttachmentCoverage(
		coverage,
		coverageRecord("deferred"),
		null,
		false,
		true,
	);
	assert.deepEqual(coverage.gapKeys, ["abc123:1"]);
	recordAttachmentCoverage(coverage, coverageRecord("hydrated"));
	// The host rejects a DETAIL_COVERAGE whose outcome sets overlap.
	assert.deepEqual(coverage.requiredKeys, ["abc123:1"]);
	assert.deepEqual(coverage.hydratedKeys, ["abc123:1"]);
	assert.deepEqual(coverage.gapKeys, []);
	assert.deepEqual(
		buildAttachmentDetailCoverageMessage(coverage).gap_keys ?? [],
		[],
	);
});

test("recordAttachmentCoverage: a later rejection cannot downgrade an accepted hydration", () => {
	const coverage = makeAttachmentDetailCoverage();
	recordAttachmentCoverage(coverage, coverageRecord("hydrated"));
	recordAttachmentCoverage(
		coverage,
		coverageRecord("deferred"),
		null,
		false,
		true,
	);
	recordAttachmentCoverage(
		coverage,
		coverageRecord("deferred"),
		null,
		false,
		false,
	);
	assert.deepEqual(coverage.hydratedKeys, ["abc123:1"]);
	assert.deepEqual(coverage.gapKeys, []);
	assert.equal(coverage.localEmitRejected, false);
});

test("recordAttachmentCoverage: a rejection without a locator is cleared by a later accounted attempt", () => {
	const coverage = makeAttachmentDetailCoverage();
	recordAttachmentCoverage(
		coverage,
		coverageRecord("deferred"),
		null,
		false,
		false,
	);
	assert.equal(
		coverage.localEmitRejected,
		true,
		"an unlocated rejection holds the cursors",
	);
	recordAttachmentCoverage(
		coverage,
		coverageRecord("deferred"),
		null,
		false,
		true,
	);
	assert.equal(
		coverage.localEmitRejected,
		false,
		"a same-run retry locator releases the hold",
	);
	assert.deepEqual(coverage.gapKeys, ["abc123:1"]);
	const second = makeAttachmentDetailCoverage();
	recordAttachmentCoverage(
		second,
		coverageRecord("deferred"),
		null,
		false,
		false,
	);
	recordAttachmentCoverage(second, coverageRecord("hydrated"));
	assert.equal(second.localEmitRejected, false);
	assert.deepEqual(second.hydratedKeys, ["abc123:1"]);
});

test("recoverServedAttachmentGaps: a gap the walk already recovered this run is not attempted again", async () => {
	const message = makeServedRecoveryMsg({
		attachments: [16],
		emailId: "abc456",
		uid: 6001,
	});
	const harness = makeRecordingEmit();
	let emits = 0;
	const summary = await recoverServedAttachmentGaps(
		{
			search: mock.fn(() => Promise.resolve([6001])),
			fetchOne: mock.fn(() => Promise.resolve(message)),
		},
		{
			attachmentCoverage: makeAttachmentDetailCoverage(),
			detailGaps: [
				makeServedRecoveryGap({
					gapId: "gap-walked",
					leaseId: "lease-walked",
					messageId: "abc456",
					partIndex: 1,
				}),
			],
			emitProtocol: harness.emit,
			emitRecord: async () => {
				emits += 1;
				return false;
			},
			hydrateAttachment: async (_message, attachment) =>
				hydratedResult({
					...attachment,
					hydration_status: "hydrated",
					hydration_error: null,
				}),
			recoveredAttachmentGapIds: new Set(["gap-walked"]),
		},
	);
	assert.equal(emits, 0, "no second hydration or emission");
	assert.equal(summary.attempted, 0);
	assert.deepEqual(
		harness.protocolMessages.filter(
			(m) => m.type === "DETAIL_GAP" || m.type === "DETAIL_GAP_ATTEMPTED",
		),
		[],
		"a recovered gap is neither re-attempted nor re-deferred under its lease",
	);
});

test("recordAttachmentCoverage: an accepted too_large key is promoted by a later retry locator, not held by a later unlocated rejection", () => {
	const promoted = makeAttachmentDetailCoverage();
	recordAttachmentCoverage(promoted, coverageRecord("too_large"));
	recordAttachmentCoverage(
		promoted,
		coverageRecord("deferred"),
		null,
		false,
		true,
	);
	assert.deepEqual(
		promoted.gapKeys,
		["abc123:1"],
		"a durable locator beats an unaccounted outcome",
	);
	const landed = makeAttachmentDetailCoverage();
	recordAttachmentCoverage(landed, coverageRecord("too_large"));
	recordAttachmentCoverage(
		landed,
		coverageRecord("deferred"),
		null,
		false,
		false,
	);
	assert.equal(
		landed.localEmitRejected,
		false,
		"the accepted record landed, so nothing is lost",
	);
	assert.deepEqual(landed.requiredKeys, ["abc123:1"]);
	assert.deepEqual(landed.gapKeys, []);
});

test("attachment coverage across lanes: a walk hydration survives a rejected served recovery of the same key", async () => {
	const coverage = makeAttachmentDetailCoverage();
	const walk = makeHarness({
		attachmentCoverage: coverage,
		hydrateAttachment: statusStampingHydrator({ "abc456:1": "hydrated" }),
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});
	const message = makeServedRecoveryMsg({
		attachments: [16],
		emailId: "abc456",
		uid: 6001,
	});
	await processMessage(walk.deps, message);
	assert.deepEqual(coverage.hydratedKeys, ["abc456:1"]);
	const served = makeRecordingEmit();
	await recoverServedAttachmentGaps(
		{
			search: mock.fn(() => Promise.resolve([6001])),
			fetchOne: mock.fn(() => Promise.resolve(message)),
		},
		{
			attachmentCoverage: coverage,
			detailGaps: [
				makeServedRecoveryGap({
					gapId: "gap-cross",
					leaseId: "lease-cross",
					messageId: "abc456",
					partIndex: 1,
				}),
			],
			emitProtocol: served.emit,
			emitRecord: async () => false,
			hydrateAttachment: async (_message, attachment) =>
				hydratedResult({
					...attachment,
					hydration_status: "hydrated",
					hydration_error: null,
				}),
		},
	);
	const fact = buildAttachmentDetailCoverageMessage(coverage);
	assert.deepEqual(fact.hydrated_keys, ["abc456:1"]);
	assert.deepEqual(fact.gap_keys ?? [], [], "the outcome sets never overlap");
	assert.equal(coverage.localEmitRejected, false);
});

/** A runtime blob endpoint that accepts every upload and echoes its digest. */
const stubBlobEndpoint = (async (_url: unknown, init?: RequestInit) => {
	const bytes = Buffer.from(
		await new Response(init?.body as BodyInit).arrayBuffer(),
	);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	return new Response(
		JSON.stringify({
			object: "blob",
			blob_id: `blob-${sha256.slice(0, 12)}`,
			mime_type: "application/pdf",
			sha256,
			size_bytes: bytes.byteLength,
		}),
		{ status: 201, headers: { "content-type": "application/json" } },
	);
}) as typeof fetch;

function realResourceEmitter(
	requested: Map<string, StreamRequest>,
	emit: RecordingHarness["emit"],
) {
	const filters = new Map<string, Set<string> | null>();
	for (const [name, scope] of requested) filters.set(name, resourceSet(scope));
	return makeGmailEmitRecord(filters, FROZEN_NOW, () => {}, emit);
}

test("attachment resources: real emitter excludes unselected keys before hydration and coverage", async () => {
	const message = makeServedRecoveryMsg({
		attachments: [16, 16],
		emailId: "abc123",
	});
	const requested = new Map<string, StreamRequest>([
		["attachments", { name: "attachments", resources: ["abc123:1"] }],
	]);
	const coverage = makeAttachmentDetailCoverage();
	const hydrated: string[] = [];
	const hydrate = statusStampingHydrator({
		"abc123:1": "hydrated",
		"abc123:2": "hydrated",
	});
	const harness = makeHarness({
		requested,
		attachmentCoverage: coverage,
		wantMessages: false,
		hydrateAttachment: async (msg, attachment) => {
			hydrated.push(attachment.id);
			return hydrate(msg, attachment);
		},
	});
	harness.deps.emitRecord = realResourceEmitter(requested, harness.emit);
	await processMessage(harness.deps, message);
	assert.deepEqual(coverage.requiredKeys, ["abc123:1"]);
	assert.deepEqual(
		coverage.hydratedKeys,
		["abc123:1"],
		JSON.stringify(harness.protocolMessages),
	);
	assert.deepEqual(hydrated, ["abc123:1"]);
	const result = buildAttachmentDetailCoverageMessage(coverage);
	assert.equal(result.considered, 1);
	assert.equal(
		result.covered,
		1,
		"completed mailbox has no required-only excluded key blocking its checkpoint",
	);
	assert.equal(
		harness.protocolMessages.filter(
			(m) => m.type === "RECORD" && m.stream === "attachments",
		).length,
		1,
	);
});

test("served recovery resources: only selected attachment is hydrated, credited and acknowledged", async () => {
	const message = makeServedRecoveryMsg({
		attachments: [16, 16],
		emailId: "def456",
		uid: 6000,
	});
	const requested = new Map<string, StreamRequest>([
		["attachments", { name: "attachments", resources: ["def456:1"] }],
	]);
	const coverage = makeAttachmentDetailCoverage();
	const harness = makeRecordingEmit();
	const hydrated: string[] = [];
	const hydrate = statusStampingHydrator({
		"def456:1": "hydrated",
		"def456:2": "hydrated",
	});
	const summary = await recoverServedAttachmentGaps(
		{
			search: mock.fn(() => Promise.resolve([6000])),
			fetchOne: mock.fn(() => Promise.resolve(message)),
		},
		{
			requested,
			attachmentCoverage: coverage,
			detailGaps: [1, 2].map((partIndex) =>
				makeServedRecoveryGap({
					gapId: `scope-gap-${partIndex}`,
					messageId: "def456",
					partIndex,
				}),
			),
			emitProtocol: harness.emit,
			emitRecord: realResourceEmitter(requested, harness.emit),
			hydrateAttachment: async (msg, attachment) => {
				hydrated.push(attachment.id);
				return hydrate(msg, attachment);
			},
		},
	);
	assert.deepEqual(coverage.requiredKeys, ["def456:1"]);
	assert.deepEqual(coverage.hydratedKeys, ["def456:1"]);
	assert.deepEqual(hydrated, ["def456:1"]);
	assert.equal(summary.recovered, 1);
	assert.deepEqual(
		harness.protocolMessages
			.filter((m) => m.type === "DETAIL_GAP_RECOVERED")
			.map((m) => m.gap_id),
		["scope-gap-1"],
	);
});

test("selected schema rejection remains required debt with the real resource emitter", async () => {
	const requested = new Map<string, StreamRequest>([
		["attachments", { name: "attachments", resources: ["abcdef:2"] }],
	]);
	const coverage = makeAttachmentDetailCoverage();
	const hydrate = statusStampingHydrator({ "abcdef:2": "hydrated" });
	const harness = makeHarness({
		requested,
		attachmentCoverage: coverage,
		wantMessages: false,
		hydrateAttachment: async (msg, attachment) => {
			const result = await hydrate(msg, attachment);
			return { ...result, record: { ...result.record, size_bytes: -1 } };
		},
	});
	harness.deps.emitRecord = realResourceEmitter(requested, harness.emit);
	await processMessage(harness.deps, {
		...makeAttachmentMsg(),
		emailId: "abcdef",
	});
	assert.deepEqual(coverage.requiredKeys, ["abcdef:2"]);
	assert.deepEqual(coverage.hydratedKeys, []);
	assert.equal(
		harness.protocolMessages.some(
			(m) =>
				m.type === "SKIP_RESULT" && m.reason === "schema_validation_failed",
		),
		true,
	);
});

test("resource exclusion never hides missing identity or a malformed selected candidate", () => {
	const requested = new Map<string, StreamRequest>([
		["attachments", { name: "attachments", resources: ["abcdef:1"] }],
	]);
	for (const id of [undefined, null, "", " ", 123, {}]) {
		assert.equal(
			attachmentOutsideResourceScope(requested, {
				id,
			} as unknown as AttachmentRecord),
			false,
		);
	}
	assert.equal(
		attachmentOutsideResourceScope(requested, {
			id: "abcdef:1",
			size_bytes: -1,
		} as AttachmentRecord),
		false,
	);
	assert.equal(
		attachmentOutsideResourceScope(requested, {
			id: "abcdef:2",
		} as AttachmentRecord),
		true,
	);
});

test("unleased served attachment emits no DETAIL_GAP_ATTEMPTED", async () => {
	const message = makeServedRecoveryMsg({
		attachments: [16],
		emailId: "abc123",
		uid: 321,
	});
	const requested = new Map<string, StreamRequest>([
		["attachments", { name: "attachments", resources: ["abc123:1"] }],
	]);
	const harness = makeRecordingEmit();
	const gap = makeServedRecoveryGap({
		gapId: "unleased-gap",
		messageId: "abc123",
		partIndex: 1,
	});
	delete gap.lease_id;
	assert.equal(gap.lease_id, undefined);
	await recoverServedAttachmentGaps(
		{
			search: async () => [321],
			fetchOne: async () => message,
		},
		{
			requested,
			detailGaps: [gap],
			emitProtocol: harness.emit,
			emitRecord: realResourceEmitter(requested, harness.emit),
			hydrateAttachment: statusStampingHydrator({ "abc123:1": "hydrated" }),
		},
	);
	assert.equal(
		harness.protocolMessages.some((m) => m.type === "DETAIL_GAP_ATTEMPTED"),
		false,
	);
});

test("production attachment caller: a rejection with no retry locator becomes ledger debt, not a held checkpoint", async () => {
	const originalWrite = process.stdout.write;
	const originalFetch = globalThis.fetch;
	const protocol: EmittedMessage[] = [];
	const ranges: string[] = [];
	const message = makeServedRecoveryMsg({
		attachments: [16],
		emailId: "abc123",
		uid: 321,
	});
	const requested = makeRequested(["attachments"]);
	let gapWritesFail = true;
	process.stdout.write = ((data: string): boolean => {
		if (gapWritesFail && data.includes('"attachment_record_rejected"'))
			throw new Error("gap persistence unavailable");
		try {
			const m = JSON.parse(data) as EmittedMessage;
			protocol.push(m);
		} catch {
			/* non-protocol output */
		}
		return true;
	}) as typeof process.stdout.write;
	// Hydration succeeds (a stub blob endpoint and IMAP part), so the record
	// reaches the emitter and its rejection is what this test exercises. A
	// failed hydration writes no record at all.
	globalThis.fetch = stubBlobEndpoint;
	const originalRsUrl = process.env.PDPP_RS_URL;
	const originalOwnerToken = process.env.PDPP_OWNER_TOKEN;
	process.env.PDPP_RS_URL = "http://rs.test";
	process.env.PDPP_OWNER_TOKEN = "test-owner-token";
	try {
		const client = {
			close: mock.fn(),
			download: async () => ({
				meta: { contentType: "application/pdf" },
				content: (async function* () {
					yield Buffer.from("pdf-bytes");
				})(),
			}),
			fetchOne: async () => message,
			search: async () => [321],
			mailbox: {
				delimiter: "/",
				exists: 1200,
				flags: new Set<string>(),
				path: "[Gmail]/All Mail",
				uidNext: 1201,
				uidValidity: 123n,
			},
			fetch: (range: string) => {
				ranges.push(range);
				const [start, end] = range.split(":");
				const includesUid =
					end === undefined
						? range.split(",").includes("321")
						: Number(start) <= 321 && (end === "*" || Number(end) >= 321);
				return (async function* () {
					if (includesUid) yield message;
				})();
			},
		} as unknown as Parameters<typeof runAllMailPasses>[0];
		const run = async (
			state: Record<string, unknown>,
			reject: boolean,
			served = false,
		) => {
			protocol.length = 0;
			const attempted: string[] = [];
			const emitRecord = realResourceEmitter(requested, async (m) => {
				protocol.push(m);
			});
			await runAllMailPasses(client, makeAllMailMailbox(), state, {
				requested,
				...(served
					? {
							detailGaps: [
								makeServedRecoveryGap({
									gapId: "already-durable",
									leaseId: "fixture-lease",
									messageId: "abc123",
									partIndex: 1,
								}),
							],
						}
					: {}),
				emittedAt: FROZEN_NOW,
				emitRecord: async (stream, data, keyField) => {
					attempted.push(String(data.id));
					return (
						(await emitRecord(
							stream,
							reject ? { ...data, size_bytes: -1 } : data,
							keyField,
						)) === true
					);
				},
			});
			return {
				attempted,
				messages: [...protocol],
				state: protocol.find(
					(m) => m.type === "STATE" && m.stream === "messages",
				),
			};
		};
		const first = await run({}, true);
		assert.deepEqual(first.attempted, ["abc123:1"]);
		assert.equal(
			first.messages.some(
				(m) => m.type === "DETAIL_COVERAGE" && m.stream === "attachments",
			),
			false,
		);
		// The gap write failed, so the attachment is owed. The ledger records it
		// as retry debt and the run still commits, instead of holding every
		// cursor and replaying the whole window.
		assert.ok(first.state?.type === "STATE", "the run commits");
		const firstProgress = (
			first.state.cursor as {
				progress: { debt: { uid: number; streams: string[] }[] };
			}
		).progress;
		assert.deepEqual(
			firstProgress.debt.map((d) => [d.uid, d.streams]),
			[[321, ["attachments"]]],
		);
		const retry = await run({ messages: first.state.cursor }, false);
		assert.deepEqual(
			retry.attempted,
			["abc123:1"],
			"the owed attachment is retried on the next run",
		);
		assert.deepEqual(ranges, ["1:500", "501:1000", "321"]);
		assert.ok(retry.state?.type === "STATE");
		assert.deepEqual(
			(retry.state.cursor as { progress: { debt: unknown[] } }).progress.debt,
			[],
			"an accepted emission settles the debt",
		);
		const legacyComplete = {
			messages: {
				all_mail: { uidvalidity: 123, uidnext: 1201, forward_uidnext: 1201 },
				backfill: {
					uidvalidity: 123,
					target_uid: 1200,
					backfilled_through_uid: 1200,
					completed_at: FROZEN_NOW,
				},
			},
		};
		const servedRetry = await run(legacyComplete, true, true);
		assert.deepEqual(servedRetry.attempted, ["abc123:1"]);
		// No gap write was possible, so this run makes no attachments claim and
		// the served gap stays pending in the runtime for the next run.
		assert.ok(servedRetry.state, "a served rejection does not hold the walk");
		assert.equal(
			servedRetry.messages.some(
				(m) => m.type === "DETAIL_COVERAGE" && m.stream === "attachments",
			),
			false,
		);
		assert.equal(
			servedRetry.messages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
			false,
		);
		gapWritesFail = false;
		const servedRedeferred = await run(legacyComplete, true, true);
		assert.ok(servedRedeferred.state);
		// The attachment-only history page now runs beside served recovery, and
		// it reaches UID 321 first. The walk writes the key's retry gap (the
		// same gap identity as the served one), so recovery leaves the key alone
		// this run: one gap, no second attempt.
		const gaps = servedRedeferred.messages.filter(
			(m) => m.type === "DETAIL_GAP",
		);
		assert.equal(gaps.length, 1);
		assert.ok(gaps[0]?.type === "DETAIL_GAP");
		assert.equal(gaps[0].record_key, "abc123:1");
		assert.deepEqual(servedRedeferred.attempted, ["abc123:1"], "one attempt");
	} finally {
		process.stdout.write = originalWrite;
		globalThis.fetch = originalFetch;
		if (originalRsUrl === undefined) delete process.env.PDPP_RS_URL;
		else process.env.PDPP_RS_URL = originalRsUrl;
		if (originalOwnerToken === undefined) delete process.env.PDPP_OWNER_TOKEN;
		else process.env.PDPP_OWNER_TOKEN = originalOwnerToken;
	}
});

test("persistent attachment rejection advances messages checkpoints with durable retry debt", async () => {
	const originalWrite = process.stdout.write;
	const originalFetch = globalThis.fetch;
	const protocol: EmittedMessage[] = [];
	const ranges: string[] = [];
	const message = makeServedRecoveryMsg({
		attachments: [16],
		emailId: "abc123",
		uid: 321,
	});
	const requested = makeRequested(["attachments"]);
	process.stdout.write = ((data: string): boolean => {
		try {
			const m = JSON.parse(data) as EmittedMessage;
			protocol.push(m);
		} catch {
			/* non-protocol output */
		}
		return true;
	}) as typeof process.stdout.write;
	// Hydration succeeds (a stub blob endpoint and IMAP part), so the record
	// reaches the emitter and its rejection is what this test exercises. A
	// failed hydration writes no record at all.
	globalThis.fetch = stubBlobEndpoint;
	const originalRsUrl = process.env.PDPP_RS_URL;
	const originalOwnerToken = process.env.PDPP_OWNER_TOKEN;
	process.env.PDPP_RS_URL = "http://rs.test";
	process.env.PDPP_OWNER_TOKEN = "test-owner-token";
	try {
		const client = {
			close: mock.fn(),
			download: async () => ({
				meta: { contentType: "application/pdf" },
				content: (async function* () {
					yield Buffer.from("pdf-bytes");
				})(),
			}),
			fetchOne: async () => message,
			search: async () => [321],
			mailbox: {
				delimiter: "/",
				exists: 1200,
				flags: new Set<string>(),
				path: "[Gmail]/All Mail",
				uidNext: 1201,
				uidValidity: 123n,
			},
			fetch: (range: string) => {
				ranges.push(range);
				const [start, end] = range.split(":");
				const includesUid =
					Number(start) <= 321 && (end === "*" || Number(end) >= 321);
				return (async function* () {
					if (includesUid) yield message;
					if (Number(start) <= 701 && (end === "*" || Number(end) >= 701))
						yield makeServedRecoveryMsg({
							attachments: [16],
							emailId: "def456",
							uid: 701,
						});
				})();
			},
		} as unknown as Parameters<typeof runAllMailPasses>[0];
		const run = async (
			state: Record<string, unknown>,
			reject: boolean,
			served = false,
		) => {
			protocol.length = 0;
			const attempted: string[] = [];
			const emitRecord = realResourceEmitter(requested, async (m) => {
				protocol.push(m);
			});
			await runAllMailPasses(client, makeAllMailMailbox(), state, {
				requested,
				...(served
					? {
							detailGaps: [
								makeServedRecoveryGap({
									gapId: "already-durable",
									leaseId: "fixture-lease",
									messageId: "abc123",
									partIndex: 1,
								}),
							],
						}
					: {}),
				emittedAt: FROZEN_NOW,
				emitRecord: async (stream, data, keyField) => {
					attempted.push(String(data.id));
					return (
						(await emitRecord(
							stream,
							reject && data.id === "abc123:1"
								? { ...data, size_bytes: -1 }
								: data,
							keyField,
						)) === true
					);
				},
			});
			return {
				attempted,
				messages: [...protocol],
				state: protocol.find(
					(m) => m.type === "STATE" && m.stream === "messages",
				),
			};
		};
		const first = await run({}, true);
		assert.deepEqual(first.attempted, ["abc123:1"]);
		assert.equal(
			first.messages.some(
				(m) => m.type === "DETAIL_COVERAGE" && m.stream === "attachments",
			),
			false,
		);
		const restartState =
			first.state?.type === "STATE" ? { messages: first.state.cursor } : {};
		const retry = await run(restartState, true);
		assert.deepEqual(
			retry.attempted,
			["def456:1"],
			"next page collects healthy later UIDs despite persistent rejection",
		);
		// No new mail arrived, so there is no forward lane on the second run.
		assert.deepEqual(ranges, ["1:500", "501:1000"]);
		assert.ok(first.state?.type === "STATE");
		assert.ok(
			(first.state.cursor as { all_mail: { forward_uidnext: number } }).all_mail
				.forward_uidnext > 321,
		);
		assert.equal(
			retry.messages.some(
				(m) =>
					m.type === "RECORD" &&
					m.stream === "attachments" &&
					m.data.id === "def456:1",
			),
			true,
		);
		const gap = first.messages.find(
			(m) => m.type === "DETAIL_GAP" && m.record_key === "abc123:1",
		);
		assert.ok(
			gap?.type === "DETAIL_GAP" && gap.retryable && gap.status === "pending",
		);
		assert.ok(
			first.messages.indexOf(gap) < first.messages.indexOf(first.state),
		);
		assert.equal(
			first.messages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
			false,
		);
		assert.ok(
			retry.state,
			"accepted local emission allows the messages checkpoint again",
		);
		const servedRetry = await run(
			{
				messages: {
					all_mail: { uidvalidity: 123, uidnext: 1201, forward_uidnext: 1201 },
					backfill: {
						uidvalidity: 123,
						target_uid: 1200,
						backfilled_through_uid: 1200,
						completed_at: FROZEN_NOW,
					},
				},
			},
			true,
			true,
		);
		assert.deepEqual(servedRetry.attempted, ["abc123:1"]);
		assert.ok(
			servedRetry.state,
			"a pending durable gap permits messages progress after rejection",
		);
		assert.equal(
			servedRetry.messages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
			false,
		);
	} finally {
		process.stdout.write = originalWrite;
		globalThis.fetch = originalFetch;
		if (originalRsUrl === undefined) delete process.env.PDPP_RS_URL;
		else process.env.PDPP_RS_URL = originalRsUrl;
		if (originalOwnerToken === undefined) delete process.env.PDPP_OWNER_TOKEN;
		else process.env.PDPP_OWNER_TOKEN = originalOwnerToken;
	}
});

for (const rejection of ["false", "throw"] as const) {
	for (const safeIdentity of [true, false]) {
		test(`attachment rejection retains only safe original identity: ${rejection}, safe=${safeIdentity}`, async () => {
			const coverage = makeAttachmentDetailCoverage();
			const harness = makeHarness({
				attachmentCoverage: coverage,
				requested: makeRequested(["attachments"]),
				wantBodies: false,
				wantMessages: false,
				hydrateAttachment: async (_, attachment) => {
					// Even a hydrator that mutates the input cannot rewrite retry identity.
					Object.assign(attachment, {
						id: "invalid",
						message_id: "invalid",
						part_index: "invalid",
						size_bytes: -1,
						hydration_status: "hydrated",
					});
					return hydratedResult(attachment);
				},
			});
			harness.deps.emitRecord = async () => {
				if (rejection === "throw") throw new Error("rejected");
				return false;
			};
			const message = makeServedRecoveryMsg({
				attachments: [16],
				emailId: safeIdentity ? "abc123" : "unsafe:identity",
			});
			if (rejection === "throw" && !safeIdentity)
				await assert.rejects(processMessage(harness.deps, message), /rejected/);
			else await processMessage(harness.deps, message);
			assert.equal(coverage.localEmitRejected, !safeIdentity);
			assert.deepEqual(coverage.hydratedKeys, []);
			const gaps = harness.protocolMessages.filter(
				(m) => m.type === "DETAIL_GAP",
			);
			assert.equal(gaps.length, safeIdentity ? 1 : 0);
			if (safeIdentity) {
				assert.deepEqual(coverage.requiredKeys, ["abc123:1"]);
				assert.deepEqual(coverage.gapKeys, ["abc123:1"]);
				assert.deepEqual(gaps[0]?.detail_locator, {
					kind: "gmail.attachment_detail",
					message_id: "abc123",
					part_index: "1",
					attachment_id: "abc123:1",
				});
			}
		});
	}
}

test("throwing attachment emission with durable debt still collects every sibling", async () => {
	const coverage = makeAttachmentDetailCoverage();
	const harness = makeHarness({
		attachmentCoverage: coverage,
		hydrateAttachment: statusStampingHydrator({
			"abc123:1": "hydrated",
			"abc123:2": "hydrated",
			"abc123:3": "hydrated",
		}),
		requested: makeRequested(["attachments"]),
		wantBodies: false,
		wantMessages: false,
	});
	const attempted: string[] = [];
	harness.deps.emitRecord = async (_, data) => {
		attempted.push(String(data.id));
		if (data.id === "abc123:1") throw new Error("persistent rejection");
		return true;
	};
	await processMessage(
		harness.deps,
		makeServedRecoveryMsg({ attachments: [16, 16, 16], emailId: "abc123" }),
	);
	assert.deepEqual(attempted, ["abc123:1", "abc123:2", "abc123:3"]);
	assert.deepEqual(coverage.requiredKeys, attempted);
	assert.deepEqual(coverage.gapKeys, ["abc123:1"]);
	assert.deepEqual(coverage.hydratedKeys, ["abc123:2", "abc123:3"]);
	assert.equal(coverage.localEmitRejected, false);
});
