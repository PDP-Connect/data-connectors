#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Gmail Connector (v0.1.0)
 *
 * Uses IMAP + Google app-specific password. Iterates [Gmail]/All Mail so
 * messages with multiple labels aren't multi-counted. Derives label
 * membership from X-GM-LABELS per message.
 *
 * Auth:
 *   GOOGLE_APP_PASSWORD_PDPP or GMAIL_APP_PASSWORD — app password
 *   GMAIL_ADDRESS or GMAIL_USER                    — the account's email;
 *                                                    if missing, emits
 *                                                    INTERACTION kind=credentials.
 *
 * Streams: messages, threads, labels, attachments.
 *
 * State shape:
 *   {
 *     all_mail: { uidvalidity: N, uidnext: N, highest_modseq: N }
 *   }
 *
 * Rate budget: keep to one concurrent connection; fetch in windows of 200.
 */

import {
	createInterface,
	type Interface as ReadlineInterface,
} from "node:readline";
import {
	isMainModule,
	requireCredentialsOrAsk,
	resourceSet,
	stringifyForJsonl,
} from "@pdpp/connector-protocol";
import {
	type FetchMessageObject,
	type FetchQueryObject,
	ImapFlow,
	type ListResponse,
	type MailboxObject,
} from "imapflow";
import {
	type ConnectorDiagnosticFields,
	connectorDiagnostic,
} from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import { flushAndExitAfterRuntimeAck } from "../../packages/polyfill-connectors/src/connector-exit.ts";
import {
	buildDetailCoverageMessage,
	buildDetailGap,
	buildFullScanCoverageMessage,
	type DetailCoverageMessage,
	type DetailGapMessage,
	type DetailGapStartEntry,
	describeUnexpectedFailure,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type FingerprintCursor,
	openFingerprintCursor,
} from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import type { ReferenceBlobUploadFn } from "../../packages/polyfill-connectors/src/reference-blob-uploader.ts";
import {
	makeReferenceBlobUploader as makeSharedReferenceBlobUploader,
	ReferenceBlobUploadFailure,
	runtimeBlobUploadAvailable as sharedRuntimeBlobUploadAvailable,
} from "../../packages/polyfill-connectors/src/reference-blob-uploader.ts";
import { isImapTransientError } from "./imap-error-classification.ts";
import {
	type BodyPartSelection,
	bigintToCursor,
	bigintToNumber,
	buildMessageBodyRecord,
	buildMessageRecord,
	buildThreadRecord,
	canonicalBodyBlobCandidates,
	canonicalLabelName,
	decodeBodyPart,
	decodeBodystructureForAttachments,
	envelopeParticipants,
	isGmailSystemLabel,
	isInTimeRange,
	labelParentName,
	makeSnippet,
	SNIPPET_MAX_CHARS,
	sanitizeForJsonl,
	selectBodyParts,
	toFlagsArray,
	toLabelsArray,
	updateThreadAggregate,
} from "./parsers.ts";
import {
	GmailProgressLedger,
	LEDGER_STREAMS,
	type LedgerCommit,
	type LedgerStream,
	loosestSince,
	MAX_RETRY_DEBT,
	type TimeBand,
	type UidOutcome,
} from "./progress-ledger.ts";
import {
	GMAIL_MESSAGE_ID_RE,
	PART_INDEX_RE,
	validateRecord,
} from "./schemas.ts";
import type {
	AllMailCursor,
	AttachmentAllMailCursor,
	AttachmentHydrationStatus,
	AttachmentRecord,
	BlobRef,
	EmittedMessage,
	InteractionMessage,
	InteractionResponse,
	MessagesBackfillCursor,
	PriorAttachmentsState,
	PriorMessagesState,
	PriorThreadsState,
	ProgressMessage,
	StartMessage,
	StreamRequest,
	ThreadAggregate,
} from "./types.ts";

// ─── Module-scoped regexes (Biome useTopLevelRegex) ─────────────────────

const EMAIL_AT_RE = /@/;
// Splits an address into [local-part, domain] for progress redaction. Only the
// last `@` is treated as the domain delimiter so quoted local-parts that embed
// an `@` still redact (the domain is whatever follows the final `@`).
const EMAIL_SPLIT_RE = /^(.*)@([^@]+)$/;

// ─── Constants ──────────────────────────────────────────────────────────

const FETCH_HEADER_BATCH_PROGRESS = 1000;
const SNIPPET_FETCH_MAX_BYTES = 4096;
const ERROR_MSG_TAIL = 400;
const DEFAULT_CRED_TIMEOUT_S = 1800;
const DEFAULT_GMAIL_CONNECTOR_ID = "https://registry.pdpp.dev/connectors/gmail";
const HYDRATION_ERROR_MAX_CHARS = 240;
const DEFAULT_ATTACHMENT_MIME_TYPE = "application/octet-stream";
// The blob endpoint's own media-type grammar (`rs-blobs-upload`'s
// `MEDIA_TYPE_PATTERN`): a bare `type/subtype`, no wildcard, no empty half.
// Mirrored here so a value that endpoint would reject with a 400 is replaced
// BEFORE the request rather than after — see `normalizeAttachmentMimeType`.
const VALID_MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const BLOB_UPLOAD_ENV_ERROR =
	"blob upload unavailable: PDPP_RS_URL and PDPP_OWNER_TOKEN must be provided by the runtime";
// Conservative default chosen to align with Gmail's per-message attachment
// cap (25 MiB). Operators can raise/lower with PDPP_GMAIL_MAX_ATTACHMENT_BYTES;
// the value is enforced both before download (when source size is known) and
// while streaming bytes (defense against under-reported sizes).
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES_ENV = "PDPP_GMAIL_MAX_ATTACHMENT_BYTES";
const POSITIVE_INTEGER_PATTERN = /^\d+$/;
// Live-incident floor (gmail-attachment-convergence-0809): sustained Gmail
// IMAP attachment-transfer throughput measured at ~4.65 KB/s across four
// different attachment sizes over a 2-hour window (general HTTPS from the
// same host hit 22 MB/s; TLS handshake to imap.gmail.com was instant), so the
// bottleneck is IMAP-side, not this codebase's network path. 90s of true
// silence is generous headroom above the inter-chunk gaps a merely-slow (not
// wedged) transfer at that floor rate produces, while still bounding a truly
// stuck FETCH to a fraction of the run's cadence window.
export const DEFAULT_ATTACHMENT_STALL_TIMEOUT_MS = 90_000;
const ATTACHMENT_STALL_TIMEOUT_MS_ENV =
	"PDPP_GMAIL_ATTACHMENT_STALL_TIMEOUT_MS";

// ─── imapflow interface augmentation ────────────────────────────────────

/**
 * imapflow's published FetchQueryObject omits Gmail's X-GM-MSGID selector
 * (`emailId`) even though the implementation supports it. Extending here
 * rather than casting preserves type-checking on every other field.
 */
interface ExtendedFetchQuery extends FetchQueryObject {
	emailId?: boolean;
}

// ─── Stdin / stdout plumbing ────────────────────────────────────────────

// Readline interface for stdin. Initialized inside the isMainModule guard
// at the bottom of the file so importing index.ts from tests doesn't
// open stdin and keep the Node event loop alive.
let rl: ReadlineInterface | null = null;

function getReadline(): ReadlineInterface {
	if (!rl) {
		rl = createInterface({ input: process.stdin, terminal: false });
	}
	return rl;
}

// Track in-flight writes so back-pressured, partial stdout writes can't
// produce interleaved or truncated JSONL lines on the runtime side. Bodies
// on the `message_bodies` stream can exceed 200 KB each, which is well
// above the default pipe buffer (~64 KB on Linux). A blocking write alone
// isn't enough: Node returns `false` from write() without sending any
// bytes on a full pipe, and the caller must wait for 'drain' before the
// next write.
//
// Gmail uses `sanitizeForJsonl` (parsers.ts) to scrub lone surrogates and
// control chars out of body text before encoding. The JSONL encoding
// itself — BigInt coercion + U+2028/U+2029 escaping — lives in
// `stringifyForJsonl`.
// DONE is terminal on the wire, and nothing below this line may write after
// it. The runtime's `handleMsg` latches the first DONE of any status and
// throws `Connector emitted <TYPE> after DONE` on the next message, failing
// the whole run as a protocol violation.
//
// Enforcing that here rather than at each terminal path is deliberate: the
// terminal paths do not stop this process. `flushAndExit` only registers
// listeners and returns (see `connector-exit.ts` — it waits for the runtime
// to close stdin, up to 30 minutes), so after `fail()` or a rejection
// handler emits DONE, the interrupted work is still on the stack. An
// in-flight `for await` over an IMAP FETCH keeps iterating and keeps calling
// `emitRecord`, and each of those writes lands after the DONE.
//
// That is what production hit: gmail runs failed `connector_protocol_violation
// "Connector emitted RECORD after DONE"` while reporting more records emitted
// than the runtime ever flushed — the surplus was written into a channel that
// had already closed. Making every terminal path unwind perfectly would be a
// standing obligation on code that mostly cannot see it coming; making the
// write refuse is a property of the channel.
//
// Suppressed messages go to stderr, so a swallowed record is diagnosable
// rather than silent. Emitting them would fail the run outright, which is
// strictly worse: the records ingested before DONE are durable and the run's
// own terminal status is already decided.
let doneEmitted = false;

function emit(msg: EmittedMessage): Promise<void> {
	if (doneEmitted) {
		process.stderr.write(`[gmail] suppressed ${String(msg.type)} after DONE\n`);
		return Promise.resolve();
	}
	if (msg.type === "DONE") {
		doneEmitted = true;
	}
	const line = stringifyForJsonl(sanitizeForJsonl(msg));
	const ok = process.stdout.write(line);
	if (ok) {
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		process.stdout.once("drain", () => {
			resolve();
		});
	});
}

/** Test-only reset of the terminal latch; the real process never reuses it. */
export function __resetDoneLatchForTests(): void {
	doneEmitted = false;
}

/** Test-only handle on the real stdout emitter, so the latch is exercised
 *  through the same function every production path writes through. */
export function gmailEmitForTests(msg: EmittedMessage): Promise<void> {
	return emit(msg);
}

function flushAndExit(code: number): void {
	flushAndExitAfterRuntimeAck(code);
}

function fail(m: string, retryable = false): void {
	emit({
		type: "DONE",
		status: "failed",
		records_emitted: 0,
		error: { message: m, retryable },
	}).catch((): undefined => undefined);
	flushAndExit(1);
}

const nowIso = (): string => new Date().toISOString();

let interactionCounter = 0;
function nextInteractionId(): string {
	interactionCounter += 1;
	return `int_${Date.now()}_${interactionCounter}`;
}

// Block on stdin until we receive INTERACTION_RESPONSE matching request_id.
async function sendInteractionAndWait(
	msg: InteractionMessage,
): Promise<InteractionResponse> {
	await emit(msg);
	const reqId = msg.request_id;
	const reader = getReadline();
	return new Promise<InteractionResponse>((resolve, reject) => {
		const onLine = (line: string): void => {
			try {
				const parsed = JSON.parse(line) as InteractionResponse;
				if (
					parsed.type === "INTERACTION_RESPONSE" &&
					parsed.request_id === reqId
				) {
					reader.off("line", onLine);
					resolve(parsed);
				}
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		};
		reader.on("line", onLine);
	});
}

// Clock-dependent ISO conversion — lives here because the fallback reaches
// for wall-clock time. Pure-date conversion is inlined in parsers.ts tests.
function internalDateToIso(date: Date | string | undefined): string {
	if (!date) {
		return nowIso();
	}
	return new Date(date).toISOString();
}

// ─── Startup: credentials + scope ───────────────────────────────────────

/** Progress cadence for the body pass — emit a PROGRESS message every N
 *  processed rows. Exported so the extraction preserves observable
 *  behavior; tests rely on the boundary. */
export const FETCH_MSG_PROGRESS = 500;

export type EmitRecordFn = (
	stream: string,
	data: Record<string, unknown>,
	keyField?: "id" | "name",
) => Promise<boolean> | Promise<void>;

export type ProgressEmitter = (msg: ProgressMessage) => Promise<void>;

/**
 * Bodies resolved for one message.
 *
 * `fetchFailed` is the load-bearing field. All three body fields are null in
 * TWO very different situations, and before this discriminator existed the
 * caller could not tell them apart:
 *
 *   1. The message genuinely has no body part in scope (or scope did not ask).
 *      Nothing was lost; `body_source: "empty"` is the honest record.
 *   2. The IMAP body fetch THREW. The body exists on the server, we just did
 *      not get it. Emitting `body_source: "empty"` here is a lie, and because
 *      the walk advances the UID cursor past the message either way, the real
 *      body lands behind the cursor and is never refetched.
 *
 * `fetchFailed: true` marks case 2 so `processMessage` can emit a durable,
 * retryable DETAIL_GAP for that message. `failureClass` carries the bounded,
 * non-secret reason (never raw error text — see `bodyFetchFailureClass`) so a
 * gap that keeps failing records WHY instead of accruing attempts against a
 * permanently-null `last_error_json`.
 */
export interface FetchedBodies {
	bodyHtmlFull: string | null;
	bodyTextFull: string | null;
	/** Bounded failure category; present only when `fetchFailed` is true. */
	failureClass?: string;
	/** True only when the body fetch threw — NOT when the message is simply empty. */
	fetchFailed?: boolean;
	snippet: string | null;
}

/**
 * Injected body fetcher. Production wires this to an IMAP round-trip;
 * tests wire it to a pure function that returns canned bodies (or a
 * rejected promise to simulate fetch failure — the helper turns that
 * into all-nulls plus `fetchFailed: true` internally).
 */
export type FetchBodiesFn = (
	msg: FetchMessageObject,
	selection: BodyPartSelection,
	wantBodies: boolean,
	wantMessages: boolean,
) => Promise<FetchedBodies>;

export interface AttachmentDownload {
	content: AsyncIterable<Buffer | Uint8Array | string>;
	expectedSize: number | null;
	mimeType: string;
}

export type FetchAttachmentFn = (
	msg: FetchMessageObject,
	attachment: AttachmentRecord,
) => Promise<AttachmentDownload>;

export type UploadAttachmentBlobFn = (args: {
	content: AsyncIterable<Buffer | Uint8Array | string>;
	connectorId: string;
	jsonPath?: string;
	mimeType: string;
	recordKey: string;
	stream: "attachments" | "message_bodies";
}) => Promise<BlobRef>;

export type UploadBodyBlobFn = ReferenceBlobUploadFn;

type AttachmentHydrationFailureStage =
	| "blob_upload_http_4xx"
	| "blob_upload_http_5xx"
	| "blob_upload_integrity_failed"
	| "blob_upload_invalid_response"
	| "blob_upload_transport_failed"
	| "imap_download_failed";

/** Aggregate-safe taxonomy retained only until recovery telemetry settles. */
interface AttachmentHydrationFailure {
	readonly stage: AttachmentHydrationFailureStage;
}

/**
 * A `failed` hydration's stage, if known, else the same `unclassified_failed`
 * bucket already used by `attachment_hydration_failure_outcome` telemetry.
 * This is the ONLY hydration-failure detail that ever reaches a DETAIL_GAP:
 * a bounded category, never `AttachmentRecord.hydration_error` (raw IMAP/blob
 * text that can embed hostnames, tokens, or URLs — see
 * `buildAttachmentDetailGap`'s doc comment on why that string never crosses).
 */
function attachmentHydrationFailureClass(
	failure: AttachmentHydrationFailure | null,
): string {
	return failure?.stage ?? "unclassified_failed";
}

export interface AttachmentHydrationResult {
	readonly failure: AttachmentHydrationFailure | null;
	readonly record: AttachmentRecord;
}

/**
 * Resolves to an honest per-attachment outcome for every ordinary failure
 * mode (download error, too-large, upload error) — callers do not need a
 * try/catch for those. The one exception: a stall-timeout (see
 * `AttachmentStallTimeoutError`) REJECTS instead, because by the time it
 * fires the shared IMAP connection has already been closed and every later
 * command in the run would fail too; that must end the run, not be
 * swallowed into one attachment's coverage row.
 */
export type HydrateAttachmentFn = (
	msg: FetchMessageObject,
	attachment: AttachmentRecord,
) => Promise<AttachmentHydrationResult>;

export interface AttachmentBackfillSummary {
	failed: number;
	hydrated: number;
	remaining_historical_gaps: number;
	too_large: number;
	unavailable_skipped: number;
}

export function createAttachmentBackfillSummary(): AttachmentBackfillSummary {
	return {
		failed: 0,
		hydrated: 0,
		remaining_historical_gaps: 0,
		too_large: 0,
		unavailable_skipped: 0,
	};
}

export function addAttachmentBackfillRecordToSummary(
	summary: AttachmentBackfillSummary,
	data: Record<string, unknown>,
): void {
	switch (data.hydration_status) {
		case "hydrated":
			summary.hydrated += 1;
			break;
		case "too_large":
			summary.too_large += 1;
			summary.remaining_historical_gaps += 1;
			break;
		case "failed":
			summary.failed += 1;
			summary.remaining_historical_gaps += 1;
			break;
		case "deferred":
			summary.unavailable_skipped += 1;
			summary.remaining_historical_gaps += 1;
			break;
		default:
			summary.unavailable_skipped += 1;
			summary.remaining_historical_gaps += 1;
			break;
	}
}

/** Technical detail for the run log; PROGRESS carries only owner text. */
function gmailDiagnostic(
	event: string,
	fields?: ConnectorDiagnosticFields,
): void {
	connectorDiagnostic("gmail", event, fields);
}

function attachmentBackfillProgressMessage(
	summary: AttachmentBackfillSummary,
): string {
	return `Downloaded ${summary.hydrated} ${summary.hydrated === 1 ? "attachment" : "attachments"} (${summary.too_large} too large, ${summary.failed} failed)`;
}

export function formatAttachmentBackfillSummary(
	summary: AttachmentBackfillSummary,
): string {
	return [
		`hydrated=${summary.hydrated}`,
		`too_large=${summary.too_large}`,
		`failed=${summary.failed}`,
		`unavailable_skipped=${summary.unavailable_skipped}`,
		`remaining_historical_gaps=${summary.remaining_historical_gaps}`,
	].join(" ");
}

/**
 * Per-run honest coverage accounting for the `attachments` detail stream.
 *
 * Every attachment decoded from a message's BODYSTRUCTURE during the run is
 * a key we attempted to hydrate, so it lands in `requiredKeys` (the
 * denominator). Each attempt lands in exactly one outcome by `hydration_status`:
 *   - `hydrated` → `hydratedKeys` (the numerator: blob bytes committed).
 *   - `failed`   → `gapKeys` (a retryable detail gap to re-attempt next run).
 *   - `too_large` or `deferred` → unaccounted (required denominator only).
 */
/** A failed attachment hydration, paired with why it failed (bounded, non-secret). */
export interface FailedAttachmentRecord {
	readonly failureClass: string;
	readonly record: AttachmentRecord;
}

export interface AttachmentDetailCoverage {
	/**
	 * Failed attachment records, retained so the run can emit one matching
	 * DETAIL_GAP per `gapKeys` entry. The host commit-gate credits a missing
	 * required key only when it is hydrated, optional-skipped, or backed by a
	 * durable pending DETAIL_GAP — `gap_keys` alone do not satisfy it. Each
	 * record's `id` is exactly the value that landed in `gapKeys`, keeping the
	 * gap's `record_key` and the coverage key a single source of truth.
	 *
	 * `failureClass` is the bounded, non-secret classification (see
	 * `attachmentHydrationFailureClass`) — the only hydration-failure detail
	 * that reaches the emitted DETAIL_GAP. Without it, a gap that keeps
	 * failing on every retry never records why: `attempt_count` climbs but
	 * `last_error_json` stays null forever (the 2026-08 Gmail 5-row defect).
	 */
	failedRecords: FailedAttachmentRecord[];
	/**
	 * True while any required key was rejected without an emitted retry
	 * locator and no later attempt in this run accounted for it. Such a key
	 * holds both cursors. Derived from `unlocatedKeys`.
	 */
	localEmitRejected: boolean;
	unlocatedKeys: string[];
	gapKeys: string[];
	hydratedKeys: string[];
	requiredKeys: string[];
}

/**
 * Whether every required key has an outcome the host can credit: hydrated,
 * or backed by a DETAIL_GAP this run. An accepted too_large or deferred key,
 * or a rejection with no retry locator, has neither, so a claim carrying it
 * would block the checkpoint on every run.
 */
export function attachmentCoverageFullyCredited(
	coverage: AttachmentDetailCoverage,
): boolean {
	const credited = new Set([...coverage.hydratedKeys, ...coverage.gapKeys]);
	return coverage.requiredKeys.every((key) => credited.has(key));
}

/**
 * The one settlement rule for attachment records, on every path (walk,
 * served recovery, recovery-only): only a hydrated part writes a record.
 * A part may already be stored hydrated (a sibling's retry, a lowered size
 * cap, or the replay of a run that failed after its records landed), and a
 * whole-record upsert of a failed, too_large or deferred attempt would
 * replace its blob reference. An unsuccessful attempt leaves an obligation
 * instead: a retry DETAIL_GAP, or retry debt.
 */
function writesAttachmentRecord(record: AttachmentRecord): boolean {
	return record.hydration_status === "hydrated";
}

/** Fresh, empty accumulator for one attachments detail pass. */
export function makeAttachmentDetailCoverage(): AttachmentDetailCoverage {
	return {
		failedRecords: [],
		gapKeys: [],
		hydratedKeys: [],
		localEmitRejected: false,
		requiredKeys: [],
		unlocatedKeys: [],
	};
}

/**
 * One attachment key's outcome in this run, ranked by how well it is
 * accounted. A key reached twice (a message re-observed across pages, the walk
 * and served recovery) keeps its best outcome, so the outcome sets never
 * overlap (the runtime rejects that) and a later attempt can only help:
 *
 *   unlocated (rejected, no retry locator)  < unaccounted (too_large/deferred)
 *     < gap / failed (durable retry locator)  < hydrated
 *
 * `unlocated` is below `unaccounted` because an accepted too_large/deferred
 * record landed and loses nothing, while a rejection without a locator leaves
 * an obligation nobody will retry.
 */
type AttachmentKeyOutcome =
	| "unlocated"
	| "unaccounted"
	| "gap"
	| "failed"
	| "hydrated";

const ATTACHMENT_OUTCOME_RANK: Record<AttachmentKeyOutcome, number> = {
	unlocated: 0,
	unaccounted: 1,
	gap: 2,
	failed: 2,
	hydrated: 3,
};

function attachmentKeyOutcome(
	coverage: AttachmentDetailCoverage,
	key: string,
): AttachmentKeyOutcome | null {
	if (!coverage.requiredKeys.includes(key)) return null;
	if (coverage.hydratedKeys.includes(key)) return "hydrated";
	if (coverage.failedRecords.some((f) => f.record.id === key)) return "failed";
	if (coverage.gapKeys.includes(key)) return "gap";
	if (coverage.unlocatedKeys.includes(key)) return "unlocated";
	return "unaccounted";
}

function clearAttachmentKeyOutcome(
	coverage: AttachmentDetailCoverage,
	key: string,
): void {
	coverage.hydratedKeys = coverage.hydratedKeys.filter((k) => k !== key);
	coverage.gapKeys = coverage.gapKeys.filter((k) => k !== key);
	coverage.failedRecords = coverage.failedRecords.filter(
		(f) => f.record.id !== key,
	);
	coverage.unlocatedKeys = coverage.unlocatedKeys.filter((k) => k !== key);
}

/**
 * Record one attempted attachment hydration into the coverage accumulator by
 * its terminal `hydration_status`. A `deferred` status (never hydrated this
 * run) is still a considered key but has no terminal outcome bucket, so it
 * counts only toward the denominator. Pure: mutates the passed accumulator.
 * The single owner of every attachment credit decision (see
 * `AttachmentKeyOutcome`).
 *
 * `failure` is the same `AttachmentHydrationFailure | null` the hydrator
 * already computes for aggregate telemetry — passed through here so a
 * `failed` outcome's DETAIL_GAP can carry a bounded, non-secret `error.class`
 * instead of recording an attempt with no evidence of why it failed.
 */
export function recordAttachmentCoverage(
	coverage: AttachmentDetailCoverage,
	record: AttachmentRecord,
	failure: AttachmentHydrationFailure | null = null,
	locallyEmitted = true,
	/** A rejected emission whose retry DETAIL_GAP was written this run. */
	retryLocatorEmitted = false,
): void {
	const outcome = attachmentOutcomeOf(
		record,
		locallyEmitted,
		retryLocatorEmitted,
	);
	const prior = attachmentKeyOutcome(coverage, record.id);
	if (prior === null) {
		coverage.requiredKeys.push(record.id);
	} else if (
		ATTACHMENT_OUTCOME_RANK[outcome] > ATTACHMENT_OUTCOME_RANK[prior]
	) {
		clearAttachmentKeyOutcome(coverage, record.id);
	} else {
		return;
	}
	switch (outcome) {
		case "hydrated":
			coverage.hydratedKeys.push(record.id);
			break;
		case "gap":
			// The rejected emission already wrote its own retry DETAIL_GAP.
			coverage.gapKeys.push(record.id);
			break;
		case "failed":
			coverage.gapKeys.push(record.id);
			// Retain the record so a matching DETAIL_GAP is emitted for this key.
			// `gap_keys` on DETAIL_COVERAGE are not enough on their own: the host
			// commit-gate requires a durable pending DETAIL_GAP to credit the key.
			coverage.failedRecords.push({
				failureClass: attachmentHydrationFailureClass(failure),
				record,
			});
			break;
		case "unlocated":
			// Rejected with no retry locator: the obligation stays uncredited and
			// holds the cursors that could pass it.
			coverage.unlocatedKeys.push(record.id);
			break;
		case "unaccounted":
			// too_large is a deployment cap (may change); deferred is not attempted
			// this run. Neither justifies a permanent skip or a gap claim, so the
			// key stays required with no outcome.
			break;
	}
	coverage.localEmitRejected = coverage.unlocatedKeys.length > 0;
}

function attachmentOutcomeOf(
	record: AttachmentRecord,
	locallyEmitted: boolean,
	retryLocatorEmitted: boolean,
): AttachmentKeyOutcome {
	if (!locallyEmitted) return retryLocatorEmitted ? "gap" : "unlocated";
	switch (record.hydration_status) {
		case "hydrated":
			return "hydrated";
		case "failed":
			return "failed";
		case "too_large":
		case "deferred":
			return "unaccounted";
		default: {
			const unhandledStatus: never = record.hydration_status;
			throw new Error(
				`Unhandled attachment hydration status: ${unhandledStatus}`,
			);
		}
	}
}

/**
 * Build the per-run attachments DETAIL_COVERAGE after the detail lane settles.
 * The list cursor that anchors this detail pass lives on `messages`, so that is
 * the `state_stream`.
 * Reference-only: this reuses DETAIL_COVERAGE without promoting it to portable
 * protocol.
 *
 * Extracted from `emitAttachmentDetailCoverage` so the zero-attachment case is
 * testable without capturing process stdout.
 */
export function buildAttachmentDetailCoverageMessage(
	coverage: AttachmentDetailCoverage,
): DetailCoverageMessage {
	return buildDetailCoverageMessage({
		stream: "attachments",
		stateStream: "messages",
		requiredKeys: coverage.requiredKeys,
		hydratedKeys: coverage.hydratedKeys,
		gapKeys: coverage.gapKeys,
		considered: coverage.requiredKeys.length,
		covered: coverage.hydratedKeys.length,
	});
}

/**
 * Emit the per-run attachments DETAIL_COVERAGE after the detail lane settles —
 * but only when the run established a boundary that can support the claim.
 *
 * `attachments` has no enumeration of its own: an attachment is found only by
 * decoding the BODYSTRUCTURE of a message the run fetched. On an ordinary run
 * that slice is a change feed (new mail plus deltas), not an inventory, and a
 * quiet run would report a self-consistent `0/0` that reads as "proven
 * complete". So the claim needs the attachments stream's OWN completed walk in
 * `GmailProgressLedger` (`attachmentsInventoryComplete`), never another
 * stream's completion stamp. Until then the stream stays honestly `unknown`.
 *
 * Extracted from `runAllMailPasses` to keep that orchestrator under the
 * cognitive-complexity ceiling (authoring guide §"Rules the tooling enforces").
 */
async function emitAttachmentDetailCoverage(
	coverage: AttachmentDetailCoverage | undefined,
	boundaryEstablished: boolean,
): Promise<void> {
	if (!coverage) {
		return;
	}
	if (!boundaryEstablished) {
		// Deliberately not a SKIP_RESULT: nothing was skipped by policy. The run
		// simply has no denominator worth reporting, and says so by staying quiet.
		gmailDiagnostic("attachment_coverage_withheld", {
			reason:
				"attachment history walk incomplete or an attachment is still owed; counts describe this run, not the mailbox",
		});
		await emit({
			type: "PROGRESS",
			stream: "attachments",
			message:
				"Attachment totals will be reported after your full mailbox history has been read",
		});
		return;
	}
	await emit(buildAttachmentDetailCoverageMessage(coverage));
}

/**
 * Build the recoverable DETAIL_GAP for one failed attachment hydration.
 *
 * Every attachment that lands in `DETAIL_COVERAGE.gap_keys` (hydration_status
 * `failed`) needs a matching durable DETAIL_GAP: the host commit-gate credits a
 * missing required key only when it is hydrated, optional-skipped, or backed by
 * a pending DETAIL_GAP — `gap_keys` on their own are not enough, so without this
 * a successful run that failed even one attachment aborts at commit and the
 * messages cursor never advances, re-fetching the same window every run.
 *
 * `record_key` is the attachment `id` (`<X-GM-MSGID>:<part_index>`), the exact
 * value already in `gap_keys`, so the gate matches one-to-one. `reason` is
 * `temporary_unavailable` (retryable): the `failed` bucket mixes transient
 * download/network/parse errors with no exhaustion signal, mirroring Amazon's
 * order-detail gap; retrying next run is the honest, non-destructive default.
 *
 * Reference-only and bounded: only opaque message and part identifiers cross
 * (X-GM-MSGID, the BODYSTRUCTURE part index, and the attachment id), plus —
 * when `failureClass` is supplied — a bounded, non-secret failure category
 * (e.g. `imap_download_failed`, `blob_upload_http_5xx`, `unclassified_failed`;
 * see `attachmentHydrationFailureClass`). No filename, content, blob bytes,
 * raw error text, tokens, cookies, URLs, request bodies, or payload snippets
 * are ever carried — `AttachmentRecord.hydration_error` (which CAN embed
 * that raw text) never crosses this boundary, by construction: only the
 * caller-supplied category string can reach `error.class`.
 *
 * Without a failure class, a repeatedly-retried gap accrues `attempt_count`
 * on every run but never records why it keeps failing — `last_error_json`
 * stays null forever, which is indistinguishable from "never attempted" and
 * blocks the stream from ever proving its remaining gaps are impossible
 * (2026-08 Gmail: 5 `attachments` gaps reached terminal status with 37-117
 * attempts and a permanently-null `last_error_json`).
 */
export function buildAttachmentDetailGap(
	attachment: Pick<AttachmentRecord, "id" | "message_id" | "part_index">,
	failureClass?: string,
): DetailGapMessage {
	return buildDetailGap({
		stream: "attachments",
		parentStream: "messages",
		recordKey: attachment.id,
		reason: "temporary_unavailable",
		locator: {
			kind: "gmail.attachment_detail",
			message_id: attachment.message_id,
			part_index: attachment.part_index,
			attachment_id: attachment.id,
		},
		...(failureClass ? { error: { class: failureClass } } : {}),
	});
}

/**
 * Build the recoverable DETAIL_GAP for one message whose body fetch THREW.
 *
 * Why this exists: `message_bodies` has a `body_source: "empty"` enum value,
 * and before this gap a failed fetch and a genuinely bodyless message produced
 * the identical record. The messages walk then advanced the UID cursor to live
 * `uidnext` either way, so the real body sat behind the cursor and was never
 * refetched — while the stream read complete to the owner. A schema-valid
 * record is not the same as an honest one.
 *
 * `record_key` is the X-GM-MSGID, the `message_bodies` primary key, so a later
 * run can refetch exactly this body. The locator carries the IMAP `uid` too,
 * but only as a hint: a UID is meaningful only inside one UIDVALIDITY epoch,
 * whereas X-GM-MSGID is stable across epochs. The message id is therefore the
 * authoritative half, and the UID merely saves a lookup when the epoch has not
 * rolled — which is why the gap stays valid even if it does.
 *
 * `reason` is `temporary_unavailable` (retryable): a thrown BODY[...] fetch
 * mixes transient network/IMAP faults with no exhaustion signal, exactly like
 * the attachments gap above, so retrying next run is the honest default.
 *
 * Bounded and reference-only: only opaque identifiers plus the connector-chosen
 * failure class cross. No body bytes, subject, sender, filename, raw error
 * text, tokens, or URLs.
 */
export function buildMessageBodyDetailGap(params: {
	failureClass?: string | undefined;
	gmMsgid: string;
	uid: number | undefined;
}): DetailGapMessage {
	const { gmMsgid, uid, failureClass } = params;
	return buildDetailGap({
		stream: "message_bodies",
		parentStream: "messages",
		recordKey: gmMsgid,
		reason: "temporary_unavailable",
		locator: {
			kind: "gmail.message_body_detail",
			message_id: gmMsgid,
			...(typeof uid === "number" ? { uid } : {}),
		},
		...(failureClass ? { error: { class: failureClass } } : {}),
	});
}

/**
 * Recoverable `DETAIL_GAP` for `runDeltaPass`'s skip-on-failed-snippet-refetch
 * case (see that function's doc comment). Unlike `buildMessageBodyDetailGap`,
 * this gap is on `messages` itself, not a child detail stream — the delta
 * pass skipped emitting the `messages` RECORD, not a separate detail record,
 * so there is no `parent_stream` to name and no separate stream's own
 * DETAIL_COVERAGE to desync: `messages`' considered/covered counts are
 * computed solely from the forward/historical walk (see `runAllMailPasses`),
 * which already counted this message as covered in an earlier run.
 *
 * `reason` is `temporary_unavailable` for the same reason as the
 * `message_bodies` gap: a thrown bounded-snippet fetch mixes transient
 * network/IMAP faults with no exhaustion signal.
 */
export function buildMessageDeltaSnippetDetailGap(params: {
	failureClass?: string | undefined;
	gmMsgid: string;
}): DetailGapMessage {
	const { gmMsgid, failureClass } = params;
	return buildDetailGap({
		stream: "messages",
		recordKey: gmMsgid,
		reason: "temporary_unavailable",
		locator: {
			kind: "gmail.message_delta_snippet_detail",
			message_id: gmMsgid,
		},
		...(failureClass ? { error: { class: failureClass } } : {}),
	});
}

function normalizeAttachmentRecoveryKey(
	recordKey: string | number | null | undefined,
): string | null {
	if (recordKey == null) {
		return null;
	}
	const key = String(recordKey).trim();
	return key.length > 0 ? key : null;
}

function attachmentDetailGapMatches(
	gap: DetailGapStartEntry,
	attachment: AttachmentRecord,
	normalizedAttachmentKey: string,
): boolean {
	if (gap.stream !== "attachments" || gap.status !== "pending") {
		return false;
	}
	if (
		normalizeAttachmentRecoveryKey(gap.record_key) !== normalizedAttachmentKey
	) {
		return false;
	}
	const locator = gap.detail_locator;
	if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
		return true;
	}
	const typedLocator = locator as Record<string, unknown>;
	if (typedLocator.kind !== "gmail.attachment_detail") {
		return false;
	}
	if (
		typedLocator.attachment_id != null &&
		typedLocator.attachment_id !== attachment.id
	) {
		return false;
	}
	if (
		typedLocator.message_id != null &&
		typedLocator.message_id !== attachment.message_id
	) {
		return false;
	}
	if (
		typedLocator.part_index != null &&
		typedLocator.part_index !== attachment.part_index
	) {
		return false;
	}
	return true;
}

function findRecoveredAttachmentDetailGaps(
	detailGaps: readonly DetailGapStartEntry[] | undefined,
	attachment: AttachmentRecord,
	recoveredGapIds: ReadonlySet<string>,
): DetailGapStartEntry[] {
	const normalizedAttachmentKey = normalizeAttachmentRecoveryKey(attachment.id);
	if (
		!(normalizedAttachmentKey && Array.isArray(detailGaps)) ||
		detailGaps.length === 0
	) {
		return [];
	}
	const matches: DetailGapStartEntry[] = [];
	for (const gap of detailGaps) {
		if (!gap || recoveredGapIds.has(gap.gap_id)) {
			continue;
		}
		if (attachmentDetailGapMatches(gap, attachment, normalizedAttachmentKey)) {
			matches.push(gap);
		}
	}
	return matches;
}

/** Only a known resource mismatch is an exclusion; missing identity remains debt. */
export function attachmentOutsideResourceScope(
	requested: ReadonlyMap<string, StreamRequest> | undefined,
	attachment: AttachmentRecord,
): boolean {
	if (typeof attachment.id !== "string" || attachment.id.trim().length === 0) {
		return false;
	}
	const scope = requested?.get("attachments");
	if (!scope) return false;
	// Same resourceSet/String(id) semantics as Gmail's actual emitter.
	const resources = resourceSet(scope);
	return resources !== null && !resources.has(String(attachment.id));
}

/** Retain retry identity independently of the rejected record's schema. */
async function emitRejectedAttachmentGap(
	message: FetchMessageObject,
	identity: Pick<AttachmentRecord, "id" | "message_id" | "part_index">,
	emitProtocol: PerMessageDeps["emitProtocol"],
): Promise<boolean> {
	if (
		typeof identity.message_id !== "string" ||
		!GMAIL_MESSAGE_ID_RE.test(identity.message_id) ||
		identity.message_id !== message.emailId ||
		typeof identity.part_index !== "string" ||
		!PART_INDEX_RE.test(identity.part_index) ||
		identity.id !== `${identity.message_id}:${identity.part_index}`
	)
		return false;
	try {
		await emitProtocol(
			buildAttachmentDetailGap(identity, "attachment_record_rejected"),
		);
		return true;
	} catch {
		// A failed protocol write leaves no durable retry obligation.
		return false;
	}
}

/**
 * Emit this message's attachment records. Returns the reason an attachment
 * is still owed, or null when every one has a creditable outcome: hydrated,
 * or a DETAIL_GAP. An accepted too_large or deferred record has neither, and
 * a rejected emission without a retry locator has neither; both stay owed as
 * retry debt so no later run can claim the inventory complete over them.
 */
async function emitAttachmentRecords(
	deps: PerMessageDeps,
	msg: FetchMessageObject,
	attachments: readonly AttachmentRecord[],
): Promise<string | null> {
	if (!deps.requested.has("attachments") || attachments.length === 0) {
		return null;
	}
	let owed: string | null = null;
	const recoveredAttachmentGapIds =
		deps.recoveredAttachmentGapIds ?? new Set<string>();
	for (const a of attachments) {
		if (attachmentOutsideResourceScope(deps.requested, a)) continue;
		// Capture identity before hydration or validation can alter the record.
		const identity = {
			id: a.id,
			message_id: a.message_id,
			part_index: a.part_index,
		};
		const hydration = await deps.hydrateAttachment(msg, a);
		const hydrated = hydration.record;
		if (!writesAttachmentRecord(hydrated)) {
			// Only a hydrated part writes a record (see writesAttachmentRecord).
			// A failed part is held by its retry DETAIL_GAP, emitted with the
			// run's gaps; a too_large or deferred part stays owed as debt.
			if (deps.attachmentCoverage) {
				recordAttachmentCoverage(
					deps.attachmentCoverage,
					hydrated,
					hydration.failure,
				);
			}
			if (hydrated.hydration_status !== "failed") {
				owed ??= "attachment_unhydrated";
			}
			continue;
		}
		let emitted: Awaited<ReturnType<EmitRecordFn>> = false;
		let emitFailure: { error: unknown } | undefined;
		let gapEmitted = false;
		try {
			emitted = await deps.emitRecord("attachments", { ...hydrated });
		} catch (error) {
			emitFailure = { error };
		} finally {
			gapEmitted =
				emitted === false &&
				(await emitRejectedAttachmentGap(msg, identity, deps.emitProtocol));
			if (emitted === false && !gapEmitted) owed = "attachment_emit_rejected";
			if (deps.attachmentCoverage) {
				recordAttachmentCoverage(
					deps.attachmentCoverage,
					emitted === false ? { ...a, ...identity } : hydrated,
					hydration.failure,
					emitted !== false,
					gapEmitted,
				);
			}
		}
		// A durable gap makes this rejection safe to continue past, including
		// the remaining parts of this message. Otherwise preserve the failure.
		if (emitFailure && !gapEmitted) throw emitFailure.error;
		// Only `hydrated` may acknowledge a served gap as recovered. Unaccounted
		// statuses (too_large, deferred) have no durable DETAIL_GAP, so there is
		// nothing to recover.
		if (!emitted || hydrated.hydration_status !== "hydrated") {
			continue;
		}
		const recoveredGaps = findRecoveredAttachmentDetailGaps(
			deps.detailGaps,
			hydrated,
			recoveredAttachmentGapIds,
		);
		for (const gap of recoveredGaps) {
			recoveredAttachmentGapIds.add(gap.gap_id);
			await deps.emitProtocol({
				type: "DETAIL_GAP_RECOVERED",
				reference_only: true,
				gap_id: gap.gap_id,
				record_key: hydrated.id,
				stream: "attachments",
			});
		}
	}
	return owed;
}

/**
 * Emit one DETAIL_GAP per failed attachment retained during the run, mirroring
 * `emitAttachmentDetailCoverage`. Emitted right after the coverage report and
 * before the messages STATE commits, so the gate sees every gap as durable when
 * it credits required keys. No-ops when nothing failed.
 */
async function emitAttachmentDetailGaps(
	coverage: AttachmentDetailCoverage | undefined,
): Promise<void> {
	if (!coverage) {
		return;
	}
	for (const failed of coverage.failedRecords) {
		await emit(buildAttachmentDetailGap(failed.record, failed.failureClass));
	}
}

export interface PerMessageDeps {
	/**
	 * Optional accumulator for the `attachments` detail-coverage report. When
	 * present, `processMessage` records every attachment it attempts to hydrate
	 * so the pass driver can emit one honest DETAIL_COVERAGE after the lane
	 * settles. Absent for passes that have no attachments denominator.
	 */
	attachmentCoverage?: AttachmentDetailCoverage;
	detailGaps?: readonly DetailGapStartEntry[] | undefined;
	emitProgress: ProgressEmitter;
	emitProtocol: (msg: EmittedMessage) => Promise<void>;
	emitRecord: EmitRecordFn;
	/** False once the shared IMAP connection can no longer run commands. */
	connectionUsable?: () => boolean;
	fetchBodies: FetchBodiesFn;
	hydrateAttachment: HydrateAttachmentFn;
	nowIso: () => string;
	recoveredAttachmentGapIds?: Set<string>;
	requested: Map<string, StreamRequest>;
	timeRange: { since?: string; until?: string } | undefined;
	uploadBodyBlob?: UploadBodyBlobFn;
	wantBodies: boolean;
	wantMessages: boolean;
}

function perMessageInternalDateToIso(
	date: Date | string | undefined,
	nowIsoFn: () => string,
): string {
	if (!date) {
		return nowIsoFn();
	}
	return new Date(date).toISOString();
}

/**
 * Emit the `message_bodies` record for one message, and — when the body was NOT
 * actually captured — the durable gap that keeps it refetchable.
 *
 * Two distinct ways the body is not captured, both of which previously left an
 * advancing UID cursor and no trace at all:
 *
 *   - the fetch THREW (`bodies.fetchFailed`). The record emitted just above
 *     says `body_source: "empty"`, which is byte-identical to the record for a
 *     message that genuinely has no body. Schema-valid, and a lie.
 *   - `emitRecord` returned false — the record was schema-rejected (a
 *     SKIP_RESULT went out instead) or carried no key, so nothing landed.
 *
 * Either way the body stays retryable behind a pending DETAIL_GAP. A genuinely
 * empty body that emits cleanly gets NO gap: an empty message is not broken,
 * and marking every one of them would drown the real losses.
 *
 * Honoring `emitRecord === false` is possible here only because Gmail owns its
 * `makeEmitRecord`, which returns `Promise<boolean>`. The shared runtime's
 * `emitRecord` is `Promise<void>` and gives a caller nothing to branch on.
 */
async function emitMessageBody(
	deps: Pick<PerMessageDeps, "emitProtocol" | "emitRecord" | "uploadBodyBlob">,
	params: {
		bodies: FetchedBodies;
		gmMsgid: string;
		receivedAt: string;
		selection: ReturnType<typeof selectBodyParts>;
		uid: number | undefined;
	},
): Promise<void> {
	const { bodies, gmMsgid, receivedAt, selection, uid } = params;
	const { bodyHtmlFull, bodyTextFull, fetchFailed, failureClass } = bodies;
	const bodyBlobCandidates = canonicalBodyBlobCandidates({
		bodyHtmlFull,
		bodyTextFull,
	});
	if (bodyBlobCandidates.length > 0 && !deps.uploadBodyBlob) {
		throw new Error("canonical Gmail body requires blob upload");
	}
	for (const candidate of bodyBlobCandidates) {
		await deps.uploadBodyBlob?.({
			content: [candidate.content],
			connectorId: process.env.PDPP_CONNECTOR_ID || DEFAULT_GMAIL_CONNECTOR_ID,
			jsonPath: candidate.jsonPath,
			mimeType: candidate.mimeType,
			recordKey: gmMsgid,
			stream: "message_bodies",
		});
	}
	const bodyEmitted = await deps.emitRecord(
		"message_bodies",
		buildMessageBodyRecord({
			bodyHtmlFull,
			bodyTextFull,
			gmMsgid,
			htmlCharset: selection.htmlCharset,
			receivedAt,
			textCharset: selection.plainCharset,
		}),
	);
	if (!(fetchFailed || bodyEmitted === false)) {
		return;
	}
	await deps.emitProtocol(
		buildMessageBodyDetailGap({
			gmMsgid,
			uid,
			failureClass: fetchFailed
				? failureClass
				: "message_bodies_record_rejected",
		}),
	);
}

/**
 * What one message produced for each stream it was asked to collect. The
 * progress ledger reads only this; it never infers outcomes from protocol.
 */
type MessageStream = "messages" | "message_bodies" | "attachments";
export type MessageOutcome = Partial<Record<MessageStream, UidOutcome>>;

type FetchItem =
	| "internalDate"
	| "envelope"
	| "bodyStructure"
	| "threadId"
	| "flags"
	| "labels"
	| "size"
	| "headers";

/**
 * The FETCH items each stream's record is built from. This is the one
 * provider-evidence rule every lane (walk, catch-up, debt retry, delta and
 * thread rebuild) applies before it writes: an item the server did not
 * return is an unavailable read, never an empty value. The stream writes
 * nothing, because a whole-record upsert built from a stand-in would replace
 * the stored row, and the UID stays owed.
 */
const REQUIRED_FETCH_ITEMS: Record<LedgerStream, readonly FetchItem[]> = {
	messages: [
		"internalDate",
		"envelope",
		"bodyStructure",
		"threadId",
		"flags",
		"labels",
		"size",
		"headers",
	],
	message_bodies: ["internalDate", "bodyStructure"],
	attachments: ["internalDate", "bodyStructure"],
	threads: [
		"internalDate",
		"envelope",
		"bodyStructure",
		"threadId",
		"flags",
		"labels",
	],
};

function fetchItemAvailable(msg: FetchMessageObject, item: FetchItem): boolean {
	switch (item) {
		case "internalDate":
			return (
				msg.internalDate !== undefined &&
				msg.internalDate !== null &&
				!Number.isNaN(new Date(msg.internalDate).getTime())
			);
		case "envelope":
			return typeof msg.envelope === "object" && msg.envelope !== null;
		case "bodyStructure":
			return (
				typeof msg.bodyStructure === "object" && msg.bodyStructure !== null
			);
		case "threadId":
			return String(msg.threadId ?? "") !== "";
		// An empty set or an empty header block is a known value.
		case "flags":
			return msg.flags instanceof Set;
		case "labels":
			return msg.labels instanceof Set;
		case "size":
			return typeof msg.size === "number" && Number.isFinite(msg.size);
		case "headers":
			return msg.headers instanceof Uint8Array;
	}
}

/**
 * True when `stream`'s requested resources exclude this message. This needs
 * no FETCH item beyond the message key, so it is decided before any item
 * is required. An attachment key is `<message key>:<part>`.
 */
function resourcesExcludeMessage(
	requested: ReadonlyMap<string, StreamRequest>,
	stream: MessageStream,
	messageKey: string,
): boolean {
	const scope = requested.get(stream);
	const resources = scope ? resourceSet(scope) : null;
	if (resources === null) return false;
	if (stream !== "attachments") return !resources.has(messageKey);
	const prefix = `${messageKey}:`;
	return ![...resources].some((key) => key.startsWith(prefix));
}

/**
 * The failure class for the first item `stream` needs that `msg` lacks, or
 * null when the server returned all of them.
 */
export function unavailableFetchItem(
	msg: FetchMessageObject,
	stream: LedgerStream,
): string | null {
	const missing = REQUIRED_FETCH_ITEMS[stream].find(
		(item) => !fetchItemAvailable(msg, item),
	);
	return missing ? `${missing.toLowerCase()}_unavailable` : null;
}

function sameOutcome(
	deps: Pick<PerMessageDeps, "requested" | "wantBodies" | "wantMessages">,
	outcome: UidOutcome,
): MessageOutcome {
	return {
		...(deps.wantMessages ? { messages: outcome } : {}),
		...(deps.wantBodies ? { message_bodies: outcome } : {}),
		...(deps.requested.has("attachments") ? { attachments: outcome } : {}),
	};
}

/** True when the stream's requested resources exclude this record key. */
function outsideResources(
	requested: ReadonlyMap<string, StreamRequest>,
	stream: string,
	key: string,
): boolean {
	const scope = requested.get(stream);
	const resources = scope ? resourceSet(scope) : null;
	return resources !== null && !resources.has(key);
}

/**
 * The one admission rule for a message on a stream: inside the given time
 * range and not excluded by the stream's resources. Every lane (walk,
 * catch-up, debt retry, delta) asks this before any body I/O.
 */
function messageInStreamScope(
	requested: ReadonlyMap<string, StreamRequest>,
	stream: string,
	key: string,
	receivedAt: string,
	range: { since?: string; until?: string } | undefined,
): boolean {
	return (
		requested.has(stream) &&
		isInTimeRange(receivedAt, range) &&
		!outsideResources(requested, stream, key)
	);
}

/**
 * Emit the per-stream records for one Gmail message.
 *
 * Invariants (tested in integration.test.ts):
 *   1. No X-GM-MSGID → terminal for every requested stream: the message
 *      cannot be represented, and retrying cannot change that.
 *   2. time_range filter → out_of_scope.
 *   3. Emit order within a single message: message_bodies → messages →
 *      attachments. The per-message order matters because downstream
 *      consumers rely on bodies being present before the messages row
 *      that references them.
 *   4. wantBodies / wantMessages / requested.has("attachments") each
 *      gate their own stream; disabling one doesn't suppress siblings.
 *   5. A failed body read writes nothing for messages or message_bodies:
 *      both are reported failed and the UID becomes retry debt. Rows for
 *      this message may already be stored (a catch-up, a retry, or the
 *      replay of a page whose run failed after its records landed), and a
 *      whole-record upsert with an empty snippet or body would destroy
 *      them. A genuinely bodyless message emits `body_source: "empty"`.
 *   6. A FETCH item a stream needs that the server did not return (see
 *      `REQUIRED_FETCH_ITEMS`) fails that stream the same way.
 *
 * A thrown error means the message was not fully collected; the caller turns
 * it into retry debt.
 */
export async function processMessage(
	deps: PerMessageDeps,
	msg: FetchMessageObject,
	/** Filled in as each stream settles, so a caller can tell what a throw left. */
	outcome: MessageOutcome = {},
): Promise<MessageOutcome> {
	// Gmail-specific IDs via imapflow: msg.emailId = X-GM-MSGID; msg.threadId = X-GM-THRID.
	const gmMsgid = String(msg.emailId ?? "");
	const gmThrid = String(msg.threadId ?? "");
	if (!gmMsgid) {
		Object.assign(
			outcome,
			sameOutcome(deps, { kind: "terminal", reason: "missing_message_id" }),
		);
		// With no record key the parts cannot be stored. Only an actual
		// BODYSTRUCTURE with no attachment parts proves nothing is lost.
		if (
			deps.requested.has("attachments") &&
			msg.bodyStructure &&
			decodeBodystructureForAttachments(
				msg.bodyStructure,
				"unidentified",
				deps.nowIso(),
			).length === 0
		) {
			outcome.attachments = { kind: "covered" };
		}
		return outcome;
	}

	// Time scope is decided from INTERNALDATE. Without it a stream cannot
	// tell whether this UID is in range, so it stays owed, unless its
	// resources already exclude the message.
	if (!fetchItemAvailable(msg, "internalDate")) {
		const undated = (stream: MessageStream): UidOutcome =>
			resourcesExcludeMessage(deps.requested, stream, gmMsgid)
				? { kind: "out_of_scope" }
				: { kind: "failed", failure: "internaldate_unavailable" };
		if (deps.wantMessages) outcome.messages = undated("messages");
		if (deps.wantBodies) outcome.message_bodies = undated("message_bodies");
		if (deps.requested.has("attachments")) {
			outcome.attachments = undated("attachments");
		}
		return outcome;
	}
	const receivedAt = new Date(msg.internalDate as Date | string).toISOString();
	if (!isInTimeRange(receivedAt, deps.timeRange)) {
		return Object.assign(outcome, sameOutcome(deps, { kind: "out_of_scope" }));
	}
	const env = msg.envelope ?? {};
	const dateHeader = env.date ? new Date(env.date).toISOString() : null;
	const flagsArr = toFlagsArray(msg.flags);
	const labels = toLabelsArray(msg.labels);
	const attachments = decodeBodystructureForAttachments(
		msg.bodyStructure,
		gmMsgid,
		receivedAt,
	);
	const wantBodies =
		deps.wantBodies &&
		messageInStreamScope(
			deps.requested,
			"message_bodies",
			gmMsgid,
			receivedAt,
			deps.timeRange,
		);
	const wantMessages =
		deps.wantMessages &&
		messageInStreamScope(
			deps.requested,
			"messages",
			gmMsgid,
			receivedAt,
			deps.timeRange,
		);

	// A stream whose FETCH items are incomplete reads nothing and writes
	// nothing (see `REQUIRED_FETCH_ITEMS`).
	const bodiesUnavailable = wantBodies
		? unavailableFetchItem(msg, "message_bodies")
		: null;
	const messagesUnavailable = wantMessages
		? unavailableFetchItem(msg, "messages")
		: null;
	const readBodies = wantBodies && bodiesUnavailable === null;
	const readSnippet = wantMessages && messagesUnavailable === null;
	const selection = selectBodyParts(msg.bodyStructure, readBodies);
	const { bodyHtmlFull, bodyTextFull, snippet, fetchFailed, failureClass } =
		readBodies || readSnippet
			? await deps.fetchBodies(msg, selection, readBodies, readSnippet)
			: { bodyHtmlFull: null, bodyTextFull: null, snippet: null };

	// Any lane can reach a message whose rows are already stored: a catch-up,
	// a retry, or the replay of a page whose run failed after its records
	// landed. A failed body read must never overwrite them with empty values,
	// so it writes nothing and the UID stays owed as retry debt.
	const readFailure =
		fetchFailed === true ? (failureClass ?? "body_fetch_failed") : null;
	if (deps.wantBodies && !wantBodies) {
		outcome.message_bodies = { kind: "out_of_scope" };
	}
	const bodiesFailure = bodiesUnavailable ?? readFailure;
	if (wantBodies && bodiesFailure) {
		outcome.message_bodies = { kind: "failed", failure: bodiesFailure };
	} else if (wantBodies) {
		// A body that could not be captured leaves its own DETAIL_GAP, which
		// accounts for it; the ledger only needs to know the UID was handled.
		await emitMessageBody(deps, {
			bodies: {
				bodyHtmlFull,
				bodyTextFull,
				snippet,
				...(fetchFailed ? { fetchFailed } : {}),
				...(failureClass ? { failureClass } : {}),
			},
			gmMsgid,
			receivedAt,
			selection,
			uid: typeof msg.uid === "number" ? msg.uid : undefined,
		});
		outcome.message_bodies = { kind: "covered" };
	}

	if (deps.wantMessages && !wantMessages) {
		outcome.messages = { kind: "out_of_scope" };
	}
	const messagesFailure = messagesUnavailable ?? readFailure;
	if (wantMessages && messagesFailure) {
		outcome.messages = { kind: "failed", failure: messagesFailure };
	} else if (wantMessages) {
		const emitted = await deps.emitRecord(
			"messages",
			buildMessageRecord({
				attachmentsCount: attachments.length,
				dateHeader,
				envelope: env,
				flagsArr,
				gmMsgid,
				gmThrid,
				labels,
				rawHeaders: msg.headers,
				receivedAt,
				sizeBytes: typeof msg.size === "number" ? msg.size : null,
				snippet,
			}),
		);
		// A schema rejection already emitted its SKIP_RESULT. The same input
		// is rejected on every retry, so it is terminal, not debt.
		outcome.messages =
			emitted === false
				? { kind: "terminal", reason: "messages_record_rejected" }
				: { kind: "covered" };
	}

	// Resource exclusion needs no FETCH evidence, so it is decided first.
	const attachmentsExcluded =
		deps.requested.has("attachments") &&
		resourcesExcludeMessage(deps.requested, "attachments", gmMsgid);
	const attachmentsUnavailable =
		deps.requested.has("attachments") && !attachmentsExcluded
			? unavailableFetchItem(msg, "attachments")
			: null;
	if (attachmentsExcluded) {
		outcome.attachments = { kind: "out_of_scope" };
	} else if (attachmentsUnavailable) {
		// No BODYSTRUCTURE is not an empty part list: the parts are unknown,
		// so the UID stays owed and a later run reads it again.
		outcome.attachments = { kind: "failed", failure: attachmentsUnavailable };
	} else if (deps.requested.has("attachments")) {
		const owed = await emitAttachmentRecords(deps, msg, attachments);
		outcome.attachments =
			owed === null ? { kind: "covered" } : { kind: "failed", failure: owed };
	}
	return outcome;
}

/** A bounded, non-secret class for a per-message failure. */
export function messageFailureClass(err: unknown): string {
	if (isImapTransientError(err)) return "transient_transport";
	if (err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(err.name)) {
		return err.name === "Error" ? "message_processing_failed" : err.name;
	}
	return "message_processing_failed";
}

/**
 * Collect one message and turn a thrown error into a retryable outcome.
 *
 * Two failures still end the run, because no later command can succeed:
 * an attachment stall (`onStall` already closed the shared connection) and
 * any failure that left the IMAP connection unusable. Every other failure is
 * this message's alone; it becomes retry debt and the walk moves on.
 */
export async function settleMessage(
	deps: PerMessageDeps,
	msg: FetchMessageObject,
): Promise<MessageOutcome> {
	const outcome: MessageOutcome = {};
	try {
		return await processMessage(deps, msg, outcome);
	} catch (perMsgErr) {
		if (
			perMsgErr instanceof AttachmentStallTimeoutError ||
			deps.connectionUsable?.() === false
		) {
			throw perMsgErr;
		}
		const emsg =
			perMsgErr instanceof Error
				? (perMsgErr.stack ?? perMsgErr.message)
				: String(perMsgErr);
		process.stderr.write(
			`[gmail] per-message error at UID ${String(msg.uid)}: ${emsg}\n`,
		);
		// Streams that settled before the throw keep their outcome, so a retry
		// never re-emits (and possibly degrades) a record that already landed.
		return {
			...sameOutcome(deps, {
				kind: "failed",
				failure: messageFailureClass(perMsgErr),
			}),
			...outcome,
		};
	}
}

/**
 * Phase B driver: iterate metas, emit records, report progress every
 * FETCH_MSG_PROGRESS rows. Per-message failures become retryable outcomes
 * (see `settleMessage`), so one bad message does not halt the pass.
 */
export async function emitMessagesPass(
	deps: PerMessageDeps,
	metas: readonly FetchMessageObject[],
	onOutcome?: (msg: FetchMessageObject, outcome: MessageOutcome) => void,
): Promise<{ considered: number; covered: number }> {
	let considered = 0;
	let covered = 0;
	for (const msg of metas) {
		const outcome = await settleMessage(deps, msg);
		onOutcome?.(msg, outcome);
		const kinds = Object.values(outcome).map((o) => o.kind);
		if (kinds.length === 0 || kinds.every((k) => k === "out_of_scope")) {
			continue;
		}
		considered += 1;
		if (kinds.every((k) => k === "covered" || k === "out_of_scope")) {
			covered += 1;
		}
		if (covered > 0 && covered % FETCH_MSG_PROGRESS === 0) {
			await deps.emitProgress({
				type: "PROGRESS",
				stream: "messages",
				message: `Fetched ${covered} messages`,
				count: covered,
				total: metas.length,
			});
		}
	}
	return { considered, covered };
}

/**
 * Disclose the mailbox-wide inventory total against this run's walk boundary.
 *
 * Gmail's `messages` DETAIL_COVERAGE is deliberately PER-PAGE: the runtime's
 * `isHealthyBoundedContinuation` admits a bounded page only when
 * `considered === covered` on same-page facts, so the page denominator must
 * stay the page. Overwriting it with the mailbox-wide `EXISTS` would make every
 * run of a 140k-message mailbox read `partial` forever and would break the
 * continuation contract outright — a wrong denominator, not a better one.
 *
 * The honest place for the provider total is therefore a SEPARATE fact: the
 * server-declared inventory size, plus how much of the UID space this
 * connector's two cursors have actually claimed. `EXISTS` is validated
 * fail-closed in `validateExistsTotal` before this point, so a missing or
 * malformed total has already thrown and can never reach here as a silent
 * "complete". What this adds is visibility: the number the provider asserts,
 * next to the boundary we have walked to.
 */
async function emitAllMailInventoryDisclosure(
	emitFn: (msg: EmittedMessage) => Promise<void>,
	session: AllMailSession,
	position: { through: number; complete: boolean },
): Promise<void> {
	const backfilledThroughUid = position.through;
	const forwardFloorUid = Math.max(0, (session.uidnext ?? 1) - 1);
	gmailDiagnostic("all_mail_historical_walk", {
		exists_total: session.existsTotal,
		...(session.priorExistsTotal !== undefined &&
		session.priorExistsTotal !== session.existsTotal
			? { prior_exists_total: session.priorExistsTotal }
			: {}),
		backfilled_through_uid: backfilledThroughUid,
		forward_floor_uid: forwardFloorUid,
	});
	await emitFn({
		type: "PROGRESS",
		stream: "messages",
		message: `Your mailbox has ${session.existsTotal} messages`,
		all_mail_inventory: {
			all_mail_exists: session.existsTotal,
			backfilled_through_uid: backfilledThroughUid,
			forward_floor_uid: forwardFloorUid,
			historical_backfill_complete: position.complete,
			uidvalidity: session.uidvalidityNum,
		},
	});
}

async function emitHistoricalContinuationSkip(
	emitFn: (msg: EmittedMessage) => Promise<void>,
	stream: string,
	continuation: {
		boundary: string;
		covered: number;
		considered: number;
		slice_start: number;
		slice_end: number;
	},
): Promise<void> {
	await emitFn({
		type: "SKIP_RESULT",
		stream,
		reason: "historical_backfill_pending",
		message:
			"This bounded page completed; more historical work remains and will be retried by the next run.",
		continuation: { ...continuation, owner: "runtime", remaining: true },
		recovery_hint: { action: "retry_by_runtime", retryable: true },
	});
}

/** Read one START line from stdin, or reject if malformed. */
function readStartMessage(reader: ReadlineInterface): Promise<StartMessage> {
	return new Promise<StartMessage>((resolve, reject) => {
		reader.once("line", (line: string) => {
			try {
				resolve(JSON.parse(line) as StartMessage);
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	});
}

/** Resolve the Gmail app password from env or via INTERACTION kind=credentials. */
export function resolveGmailPasswordFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	return env.GOOGLE_APP_PASSWORD_PDPP || env.GMAIL_APP_PASSWORD || null;
}

async function resolvePassword(): Promise<string | null> {
	const envPassword = resolveGmailPasswordFromEnv();
	if (envPassword) {
		return envPassword;
	}
	try {
		const creds = await requireCredentialsOrAsk({
			required: [["GOOGLE_APP_PASSWORD_PDPP", "GMAIL_APP_PASSWORD"]],
			connectorName: "Gmail",
			sendInteraction: (req) => {
				const wrapped: InteractionMessage = {
					type: "INTERACTION",
					request_id: req.request_id ?? nextInteractionId(),
					kind: req.kind,
					message: req.message,
					...(req.schema === undefined ? {} : { schema: req.schema }),
					...(req.timeout_seconds === undefined
						? {}
						: { timeout_seconds: req.timeout_seconds }),
				};
				return sendInteractionAndWait(wrapped).then((resp) => ({
					type: "INTERACTION_RESPONSE" as const,
					request_id: resp.request_id,
					status: resp.status,
					...(resp.data === undefined
						? {}
						: { data: resp.data as Record<string, string> }),
				}));
			},
		});
		return creds.GOOGLE_APP_PASSWORD_PDPP ?? null;
	} catch (e) {
		fail(e instanceof Error ? e.message : String(e), false);
		return null;
	}
}

/**
 * Resolve the Gmail address from env (GMAIL_ADDRESS, GMAIL_USER, or
 * AMAZON_USERNAME if it looks like an email) or by asking the user via
 * INTERACTION.
 */
export function resolveGmailAddressFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	if (env.GMAIL_ADDRESS) {
		return env.GMAIL_ADDRESS;
	}
	if (env.GMAIL_USER) {
		return env.GMAIL_USER;
	}
	if (env.AMAZON_USERNAME && EMAIL_AT_RE.test(env.AMAZON_USERNAME)) {
		return env.AMAZON_USERNAME;
	}
	return null;
}

/**
 * Mask an email address for an operator/model-visible PROGRESS message.
 *
 * The owner's full Gmail address is a raw PII identifier; emitting it verbatim
 * in a PROGRESS line leaks it to every consumer of the run stream (dashboard,
 * timeline, logs, model). We still want the progress line to confirm *which
 * account/domain* connected, so we keep the domain and the first character of
 * the local-part and mask the rest:
 *
 *   "taylor.rivera@example.com"  ->  "t***@example.com"
 *   "x@example.com"            ->  "***@example.com"
 *
 * If the value does not look like an `local@domain` address (no `@`, or an
 * empty domain), we return a constant placeholder rather than risk echoing an
 * unexpected raw value. The output never contains the full local-part.
 */
export function redactEmailForProgress(address: string): string {
	const match = EMAIL_SPLIT_RE.exec(address);
	const local = match?.[1];
	const domain = match?.[2];
	if (!(local && domain)) {
		return "[redacted-account]";
	}
	const head = local.length > 1 ? local[0] : "";
	return `${head}***@${domain}`;
}

async function resolveAddress(): Promise<string | null> {
	const fromEnv = resolveGmailAddressFromEnv();
	if (fromEnv) {
		return fromEnv;
	}
	const resp = await sendInteractionAndWait({
		type: "INTERACTION",
		request_id: nextInteractionId(),
		kind: "credentials",
		message:
			"Gmail address to sync (the account the app password was generated for)",
		schema: {
			type: "object",
			properties: { email: { type: "string", format: "email" } },
			required: ["email"],
		},
		timeout_seconds: DEFAULT_CRED_TIMEOUT_S,
	});
	if (
		resp.status === "success" &&
		resp.data &&
		typeof resp.data.email === "string"
	) {
		return resp.data.email;
	}
	return null;
}

// ─── Labels stream ──────────────────────────────────────────────────────

/**
 * Parse the prior `labels` STATE cursor's `fingerprints` map. The cursor
 * shape is `state.labels.fingerprints` keyed by label `name`. Legacy
 * cursors (pre-fingerprint: only `{ fetched_at }`) decode to an empty
 * map, so the first post-deploy run rebuilds the map and re-emits every
 * label exactly once.
 */
export function readPriorLabelFingerprints(
	state: Record<string, unknown>,
): Map<string, string> {
	const streamState = (state.labels ?? {}) as Record<string, unknown>;
	const raw = streamState.fingerprints;
	const out = new Map<string, string>();
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return out;
	}
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === "string" && value.length > 0) {
			out.set(id, value);
		}
	}
	return out;
}

/**
 * Emit the IMAP mailbox list as `labels` records, gated through a
 * per-label fingerprint cursor so an unchanged mailbox set does not
 * append a new version of every label on every run.
 *
 * The labels record body is `{ name, canonical_name, is_system,
 * parent_name, message_count }`. `message_count` is hardcoded `null`,
 * and there is no run-clock field in the record (the `fetched_at`
 * lives only in the STATE cursor). So the record's stable-JSON IS the
 * change signal: a label only re-emits when its name/derived flags
 * actually change. No fields are excluded from the fingerprint.
 *
 * Before this gate, `labels` re-emitted every mailbox unconditionally
 * each run, accumulating ~269 versions per label of byte-identical
 * history.
 */
async function emitLabelsStream(
	client: ImapFlow,
	emitRecord: EmitRecordFn,
	state: Record<string, unknown>,
): Promise<void> {
	// `labels` is keyed by `name`, not `id`, and the stored record body has
	// no `id` field. The fingerprint cursor keys on `data.id`, so we pass a
	// keying `id` (the label name) but EXCLUDE it from the fingerprint —
	// leaving the hash computed over exactly the stored record body
	// (`{name, canonical_name, is_system, parent_name, message_count}`).
	// This keeps byte-parity with the compaction script, which fingerprints
	// the stored `record_json` (no `id`) with an empty exclude set.
	const cursor = openFingerprintCursor(state, {
		excludeFromFingerprint: ["id"],
		priorFingerprints: readPriorLabelFingerprints(state),
	});
	const mailboxes: ListResponse[] = await client.list();
	// The full mailbox list is the stream's boundary, measured here before the
	// fingerprint gate below decides what to emit. Every mailbox is either
	// emitted or suppressed as unchanged — none is dropped — so `considered` and
	// `covered` are equal and a steady-state run reads covered rather than a
	// false partial.
	const consideredLabels = mailboxes.length;
	for (const mb of mailboxes) {
		const name = mb.path;
		const record = {
			name,
			canonical_name: canonicalLabelName(name),
			is_system: isGmailSystemLabel(name),
			parent_name: labelParentName(name),
			message_count: null, // we could SELECT each to get EXISTS but not worth it
		};
		// Fingerprint by the label `name` (the record key for this stream).
		if (cursor.shouldEmit({ id: name, ...record })) {
			await emitRecord("labels", record, "name");
		}
	}
	// Drop fingerprints for mailboxes that disappeared so a future
	// re-creation re-emits. `labels` is always a full scan.
	cursor.dropUnseenIds();
	const labelsCursor: Record<string, unknown> = { fetched_at: nowIso() };
	if (cursor.size() > 0) {
		labelsCursor.fingerprints = cursor.toState();
	}
	await emit({
		type: "STATE",
		stream: "labels",
		cursor: labelsCursor,
	});
	await emit(buildFullScanCoverageMessage("labels", consideredLabels));
}

// ─── All Mail resolution + cursor ───────────────────────────────────────

/** Locate the [Gmail]/All Mail mailbox via \All special-use or fallback path. */
async function findAllMailbox(client: ImapFlow): Promise<ListResponse | null> {
	const mailboxes: ListResponse[] = await client.list();
	return (
		mailboxes.find(
			(m) => m.specialUse === "\\All" || m.path === "[Gmail]/All Mail",
		) ?? null
	);
}

interface AllMailSession {
	attachmentBackfill: AttachmentAllMailCursor;
	/**
	 * IMAP `EXISTS` for All Mail: the server's own count of the messages in the
	 * mailbox, taken from the SELECT this run already performed. This is the
	 * only mailbox-wide inventory total Gmail hands us, and it is measured at
	 * the provider boundary — before a single UID is walked and independently
	 * of what any pass emits.
	 */
	existsTotal: number;
	fullResync: boolean;
	highestModseqCursor: number | string | null;
	messagesBackfill: MessagesBackfillCursor;
	/** See `AllMailCursor.delta_holdback_runs`. Always a non-negative integer —
	 *  tolerantly parsed, defaulting to 0 for absent/malformed prior state. */
	priorDeltaHoldbackRuns: number;
	priorExistsTotal: number | undefined;
	priorModseq: number | string | null | undefined;
	priorUidnext: number;
	uidnext: number | undefined;
	uidvalidityNum: number;
}

/**
 * Validate the IMAP `EXISTS` count for All Mail and bind it as the mailbox's
 * inventory total. Fail closed on missing/malformed, mirroring Jellyfin's
 * `validateTotalRecordCount`: a silently absent total that reads as success is
 * precisely the bug this contract exists to prevent.
 *
 * EXISTS is the mailbox's CURRENT inventory count, not a cursor. Owners delete
 * and expunge mail without any UIDVALIDITY change, so a smaller count than the
 * last run is ordinary. Rejecting it blocked every later sync until the
 * mailbox regrew. Progress is owned by UIDs in `GmailProgressLedger`; a
 * removed UID is simply absent from the next FETCH.
 */
function validateExistsTotal(value: unknown): number {
	if (value === undefined || value === null) {
		throw new Error(
			"gmail_all_mail_exists_missing: SELECT reported no EXISTS for All Mail",
		);
	}
	if (typeof value !== "number") {
		throw new Error("gmail_all_mail_exists_not_number");
	}
	if (!Number.isFinite(value)) {
		throw new Error("gmail_all_mail_exists_not_finite");
	}
	if (!Number.isInteger(value)) {
		throw new Error("gmail_all_mail_exists_not_integer");
	}
	if (value < 0) {
		throw new Error("gmail_all_mail_exists_negative");
	}
	return value;
}

/**
 * Tolerantly parse the prior `all_mail.delta_holdback_runs` counter.
 * Absent (state written before this counter existed), non-number, negative,
 * non-finite, or fractional input all read as 0 — the safe default is "not
 * currently held back," never a crash and never a negative/fractional count.
 */
export function parseDeltaHoldbackRuns(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		!Number.isInteger(value)
	) {
		return 0;
	}
	return value;
}

/**
 * Decide this run's `messages.all_mail.highest_modseq` and
 * `delta_holdback_runs`, given whether `runDeltaPass` left a change behind
 * that the progress ledger could not take as debt. Pure.
 *
 *   - Every change has an owner: advance to the live value; the counter
 *     resets to 0.
 *   - A change has no owner: hold `highest_modseq` at `priorModseq` for as
 *     long as that lasts, so the next run's `changedSince` sees the change
 *     again. There is no run-count limit: moving past an unowned change
 *     loses it for good. The ledger's debt list is full only while the walk
 *     is held too, and it drains as retries settle. The counter counts the
 *     consecutive held runs, for diagnostics only.
 */
export function resolveDeltaCursorAdvance(args: {
	liveHighestModseq: number | string | null;
	priorHoldbackRuns: number;
	priorModseq: number | string | null | undefined;
	skippedAnyMessage: boolean;
}): { highestModseq: number | string | null; holdbackRuns: number } {
	if (!args.skippedAnyMessage) {
		return { highestModseq: args.liveHighestModseq, holdbackRuns: 0 };
	}
	return {
		highestModseq: args.priorModseq ?? null,
		holdbackRuns: args.priorHoldbackRuns + 1,
	};
}

/**
 * Narrow the MailboxObject + prior state into the (UIDVALIDITY, cursor,
 * resync-flag) triple the fetch loop needs. Returns null when UIDVALIDITY
 * is missing (caller should fail).
 */
function deriveAllMailSession(
	mailbox: MailboxObject,
	state: Record<string, unknown>,
): AllMailSession | null {
	const uidvalidityNum = bigintToNumber(mailbox.uidValidity);
	if (uidvalidityNum === null) {
		return null;
	}
	// The RS returns state as { <stream>: <cursor>, ... } where each <cursor>
	// is the object the connector put in the STATE message's .cursor field.
	// This connector emits STATE with stream='messages' and
	// cursor={all_mail:{uidvalidity,uidnext,highest_modseq}}, so the correct
	// read path is state.messages.all_mail — NOT state.all_mail. Prior code
	// read the top level, resolving to undefined on every run and silently
	// forcing full-refresh. Observed 2026-04-21: state persisted correctly
	// but every run did a full 1:* fetch. Also accept the legacy top-level
	// shape in case any historical state was written before this fix.
	const messagesState = (state.messages ?? {}) as PriorMessagesState;
	const attachmentsState = (state.attachments ?? {}) as PriorAttachmentsState;
	const legacyState = state as { all_mail?: AllMailCursor };
	const priorAllMail: AllMailCursor =
		messagesState.all_mail ?? legacyState.all_mail ?? {};
	const priorAttachmentAllMail: AttachmentAllMailCursor =
		attachmentsState.all_mail ?? {};
	const priorMessagesBackfill: MessagesBackfillCursor =
		messagesState.backfill ?? {};
	const priorUidvalidity = priorAllMail.uidvalidity;
	// The prior EXISTS is meaningful only in the SAME UID epoch; it is kept for
	// the inventory disclosure, never as a bound on the current count.
	const priorExistsTotal =
		priorUidvalidity === uidvalidityNum &&
		typeof priorAllMail.exists === "number"
			? priorAllMail.exists
			: undefined;
	const existsTotal = validateExistsTotal(mailbox.exists);
	const attachmentBackfill =
		priorAttachmentAllMail.uidvalidity === uidvalidityNum
			? priorAttachmentAllMail
			: {
					completed_at: null,
					uidvalidity: uidvalidityNum,
				};
	return {
		attachmentBackfill,
		existsTotal,
		priorExistsTotal,
		messagesBackfill:
			priorMessagesBackfill.uidvalidity === uidvalidityNum
				? priorMessagesBackfill
				: {
						uidvalidity: uidvalidityNum,
						backfilled_through_uid: 0,
						completed_at: null,
					},
		fullResync: !priorUidvalidity || priorUidvalidity !== uidvalidityNum,
		highestModseqCursor: bigintToCursor(mailbox.highestModseq),
		priorDeltaHoldbackRuns: parseDeltaHoldbackRuns(
			priorAllMail.delta_holdback_runs,
		),
		priorModseq: priorAllMail.highest_modseq,
		priorUidnext: priorAllMail.forward_uidnext ?? priorAllMail.uidnext ?? 1,
		uidnext: mailbox.uidNext,
		uidvalidityNum,
	};
}

// ─── Phase A: metadata collection ───────────────────────────────────────

/**
 * Parse an ISO 8601 timestamp into IMAP's date format (DD-MMM-YYYY).
 * Returns null if the input is not a valid ISO string.
 *
 * IMAP's SINCE criterion matches messages with an internal date >= the
 * specified date, and IMAP dates are day-granular (no time component).
 * Post-filtering by exact ISO boundary is required to honor the stream's
 * declared time_range.since, which may have time-of-day precision.
 */
export function isoToImapDate(iso: string | undefined): string | null {
	if (!iso || typeof iso !== "string") {
		return null;
	}
	try {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) {
			return null;
		}
		const day = String(d.getUTCDate()).padStart(2, "0");
		const monthNames = [
			"Jan",
			"Feb",
			"Mar",
			"Apr",
			"May",
			"Jun",
			"Jul",
			"Aug",
			"Sep",
			"Oct",
			"Nov",
			"Dec",
		];
		const month = monthNames[d.getUTCMonth()];
		const year = d.getUTCFullYear();
		return `${day}-${month}-${year}`;
	} catch {
		return null;
	}
}

/**
 * Intersect an IMAP UID set with the UIDs a SEARCH returned, as a
 * comma-separated list.
 *
 * - `rangeStr` is a UID set: comma-separated UIDs and `a:b` ranges, where
 *   `b` may be `*` (for example "200:*", or "1:500,701:1200")
 * - `searchUids` are UIDs returned by IMAP search (sorted ascending)
 *
 * Returns only the UIDs that fall within both.
 */
function intersectUidRanges(
	rangeStr: string,
	searchUids: readonly number[],
): string {
	const parts = rangeStr
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const [a, b] = part.split(":");
			const start = Number(a);
			const end =
				b === undefined
					? start
					: b === "*"
						? Number.POSITIVE_INFINITY
						: Number(b);
			return { start, end };
		})
		.filter(({ start, end }) => !(Number.isNaN(start) || Number.isNaN(end)));
	return searchUids
		.filter((uid) => parts.some(({ start, end }) => uid >= start && uid <= end))
		.join(",");
}

/**
 * Thrown when a message's internalDate is missing or unparseable during exact
 * boundary filtering. This prevents the run from emitting records and committing
 * STATE, ensuring no false complete claims are made.
 *
 * The message lacks proof of its position relative to the declared scope, so
 * the entire enumeration must fail rather than silently excluding it or
 * returning a false partial. The runtime's unhandledRejection handler will
 * classify this error and decide retry policy based on its deterministic nature.
 */
class MissingOrInvalidInternalDateError extends Error {
	constructor(uid: number | string, detail: string, options?: ErrorOptions) {
		super(
			`UID ${uid}: cannot verify internalDate for exact boundary filtering: ${detail}`,
			options,
		);
		this.name = "MissingOrInvalidInternalDateError";
	}
}

/**
 * Compare message timestamp against declared boundary using epoch milliseconds.
 * Returns true if message is at or after the boundary, false if before.
 * Throws MissingOrInvalidInternalDateError if internalDate is missing or
 * unparseable, preventing silent inclusion or false coverage claims.
 *
 * Lexical comparison of ISO strings fails when offsets differ; epoch comparison
 * is timezone-safe and handles arbitrary precision correctly.
 */
function isAtOrAfterBoundary(
	messageTimestamp: Date | string | undefined,
	boundaryIso: string,
	uid: number | string,
): boolean {
	// Reject missing internalDate when exact boundary is declared.
	// IMAP does not guarantee internalDate presence; without it, we cannot
	// prove the message is in scope. Throw to prevent silent exclusion and
	// false complete claims; retryability is preserved.
	if (!messageTimestamp) {
		throw new MissingOrInvalidInternalDateError(uid, "missing");
	}

	try {
		const msgTime = new Date(messageTimestamp).getTime();
		const boundaryTime = new Date(boundaryIso).getTime();

		// Reject unparseable timestamps; can't compare without valid epoch values.
		if (Number.isNaN(msgTime)) {
			throw new MissingOrInvalidInternalDateError(
				uid,
				`unparseable: "${messageTimestamp}"`,
			);
		}
		if (Number.isNaN(boundaryTime)) {
			throw new Error(
				`boundary ISO is unparseable: "${boundaryIso}" (internal error)`,
			);
		}

		return msgTime >= boundaryTime;
	} catch (e) {
		if (e instanceof MissingOrInvalidInternalDateError) {
			throw e;
		}
		throw new MissingOrInvalidInternalDateError(
			uid,
			`exception: ${e instanceof Error ? e.message : String(e)}`,
			{
				cause: e,
			},
		);
	}
}

export async function collectMetadata(
	client: Pick<ImapFlow, "fetch" | "search">,
	fetchRange: string,
	sinceDate: string | null = null,
	sinceIso: string | null = null,
): Promise<FetchMessageObject[]> {
	let range = fetchRange;

	// If a since boundary is declared (IMAP date format), constrain via search.
	// Intersect the search result with the existing fetchRange to preserve
	// cursor/resume semantics and avoid re-fetching already-seen UIDs.
	if (sinceDate) {
		const uidsAfterSince = await client.search(
			{ since: sinceDate },
			{ uid: true },
		);
		if (!uidsAfterSince || uidsAfterSince.length === 0) {
			// No messages after the declared date.
			return [];
		}
		// Intersect search result with the existing range (e.g., "200:*" from
		// incremental cursor). This preserves the cursor and prevents duplicate work.
		range = intersectUidRanges(fetchRange, uidsAfterSince);
		if (!range) {
			// No overlap between incremental range and SINCE search.
			return [];
		}
	}

	const metas: FetchMessageObject[] = [];
	for await (const m of client.fetch(range, GMAIL_METADATA_FETCH_QUERY, {
		uid: true,
	})) {
		// IMAP SINCE is day-granular; post-filter on exact ISO boundary to honor
		// the stream's declared time_range.since at the second precision. When an
		// exact boundary is declared, every message MUST have a valid internalDate
		// to prove it's in scope. Throws MissingOrInvalidInternalDateError if unable
		// to verify, preventing STATE commit and preserving retryability.
		if (sinceIso) {
			const isInBoundary = isAtOrAfterBoundary(
				m.internalDate,
				sinceIso,
				m.uid ?? "unknown",
			);
			if (!isInBoundary) {
				// Message before the exact boundary. Skip it; IMAP SINCE (day-granular)
				// included it but exact scope (second-precise) excludes it.
				continue;
			}
		}

		metas.push(m);
		if (metas.length % FETCH_HEADER_BATCH_PROGRESS === 0) {
			await emit({
				type: "PROGRESS",
				stream: "messages",
				message: `Collected ${metas.length} message headers`,
				count: metas.length,
			});
		}
	}
	await emit({
		type: "PROGRESS",
		stream: "messages",
		message: `Collected ${metas.length} message headers`,
		count: metas.length,
		total: metas.length,
	});
	return metas;
}

// ─── Phase B: per-message body fetch + emit ────────────────────────────

type BodyPartRequest =
	| string
	| {
			key: string;
			start?: number;
			maxLength?: number;
	  };

/** Build the bodyParts request list given the selection + scope. */
function buildBodyPartsRequest(
	selection: ReturnType<typeof selectBodyParts>,
	wantBodies: boolean,
): BodyPartRequest[] {
	const parts: BodyPartRequest[] = [];
	if (selection.plainPart) {
		// Full body if we need message_bodies; otherwise bounded for snippet.
		parts.push(
			wantBodies
				? { key: selection.plainPart }
				: {
						key: selection.plainPart,
						start: 0,
						maxLength: SNIPPET_FETCH_MAX_BYTES,
					},
		);
	}
	if (wantBodies && selection.htmlPart) {
		parts.push({ key: selection.htmlPart });
	}
	return parts;
}

/**
 * Decode fetched body buffers into strings + optional snippet per the
 * caller's scope. Never throws; missing buffers resolve to nulls.
 */
function decodeFetchedBodies(
	plainBuf: Buffer | null,
	htmlBuf: Buffer | null,
	selection: ReturnType<typeof selectBodyParts>,
	wantBodies: boolean,
	wantMessages: boolean,
): FetchedBodies {
	let bodyTextFull: string | null = null;
	let bodyHtmlFull: string | null = null;
	let snippet: string | null = null;
	if (plainBuf) {
		if (wantBodies) {
			bodyTextFull = decodeBodyPart(
				plainBuf,
				selection.plainEncoding,
				selection.plainCharset,
			);
		}
		if (wantMessages) {
			snippet = makeSnippet(
				plainBuf,
				selection.plainEncoding,
				selection.plainCharset,
				SNIPPET_MAX_CHARS,
			);
		}
	}
	if (htmlBuf && wantBodies) {
		bodyHtmlFull = decodeBodyPart(
			htmlBuf,
			selection.htmlEncoding,
			selection.htmlCharset,
		);
	}
	return { bodyHtmlFull, bodyTextFull, snippet };
}

/**
 * Bounded, non-secret failure category for a thrown body fetch.
 *
 * Only this connector-chosen category ever reaches the emitted DETAIL_GAP's
 * `error.class`. Raw error text never crosses that boundary: an IMAP error
 * message can embed the failing command, which for a BODY[...] fetch quotes
 * the mailbox and part path. The split mirrors `isImapTransientError`, which
 * the run-level retry classifier already trusts.
 */
export function bodyFetchFailureClass(err: unknown): string {
	return isImapTransientError(err)
		? "imap_body_fetch_transient"
		: "imap_body_fetch_failed";
}

/**
 * Fetch (and decode) the parts we need for one message in a single IMAP
 * round-trip.
 *
 * Still best-effort in the sense that a body failure never blocks the envelope
 * emit — but it no longer renders as an empty message. A thrown fetch resolves
 * to all-nulls PLUS `fetchFailed: true`, which is what lets `processMessage`
 * mark the body retryable instead of writing a schema-valid lie
 * (`body_source: "empty"`) that the advancing UID cursor then makes permanent.
 */
async function fetchBodies(
	client: Pick<ImapFlow, "fetchOne">,
	msg: FetchMessageObject,
	selection: ReturnType<typeof selectBodyParts>,
	wantBodies: boolean,
	wantMessages: boolean,
): Promise<FetchedBodies> {
	const empty: FetchedBodies = {
		bodyHtmlFull: null,
		bodyTextFull: null,
		snippet: null,
	};
	if (!(msg.uid && (wantBodies || (wantMessages && selection.plainPart)))) {
		return empty;
	}
	const parts = buildBodyPartsRequest(selection, wantBodies);
	if (parts.length === 0) {
		return empty;
	}
	try {
		const bodyResp = await client.fetchOne(
			String(msg.uid),
			{ bodyParts: parts },
			{ uid: true },
		);
		// A part we asked for and did not get back is unavailable, not empty.
		// Only a returned Buffer (zero-length included) proves the content.
		const unavailable = (failureClass: string): FetchedBodies => ({
			...empty,
			fetchFailed: true,
			failureClass,
		});
		if (!bodyResp) return unavailable("body_message_unavailable");
		const returned = (key: string): Buffer | undefined => {
			const value = bodyResp.bodyParts?.get(key);
			return Buffer.isBuffer(value) ? value : undefined;
		};
		const plainBuf = selection.plainPart ? returned(selection.plainPart) : null;
		const htmlBuf =
			selection.htmlPart && wantBodies ? returned(selection.htmlPart) : null;
		if (plainBuf === undefined || htmlBuf === undefined) {
			return unavailable("body_part_unavailable");
		}
		return decodeFetchedBodies(
			plainBuf,
			htmlBuf,
			selection,
			wantBodies,
			wantMessages,
		);
	} catch (err) {
		// The envelope still emits — but the caller MUST be able to tell this
		// apart from a genuinely bodyless message, or the body is lost behind the
		// cursor forever.
		return {
			...empty,
			fetchFailed: true,
			failureClass: bodyFetchFailureClass(err),
		};
	}
}

export const DEFAULT_MESSAGES_BACKFILL_WINDOW_UIDS = 500;
const MESSAGES_BACKFILL_WINDOW_UIDS_ENV =
	"PDPP_GMAIL_MESSAGES_BACKFILL_WINDOW_UIDS";

function normalizeMessagesBackfillWindowUids(
	value: number | undefined,
): number {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return value;
	}
	return DEFAULT_MESSAGES_BACKFILL_WINDOW_UIDS;
}

export function resolveMessagesBackfillWindowUids(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = env[MESSAGES_BACKFILL_WINDOW_UIDS_ENV];
	if (!(raw && POSITIVE_INTEGER_PATTERN.test(raw))) {
		return DEFAULT_MESSAGES_BACKFILL_WINDOW_UIDS;
	}
	return normalizeMessagesBackfillWindowUids(Number(raw));
}

// ─── Historical attachment backfill: byte-cost-bounded page sizing ────────
//
// A fixed UID count is a poor unit of completed work for historical
// attachment backfill: two UIDs can differ by orders of magnitude in
// attachment bytes to transfer (see gmail-blob-throughput-rootcause-0715.md
// — a single 4.77 MB attachment observed at ~5.7 KB/s). Mirrors
// reference-implementation/runtime/detail-gap-paging.js's byte-budget-clamp
// and trim-to-budget-with-at-least-one-entry pattern as Gmail-local policy:
// the generic detail-gap-paging module is not modified and gains no Gmail
// knowledge.
//
// Unlike the generic detail-gap page (which has no per-row size hint and so
// needs a learned observed-average), Gmail already knows each UID's
// attachment byte cost up front from BODYSTRUCTURE (fetched pre-download by
// collectMetadata). There is no cross-page learning here: the historical
// backfill emits exactly one page per run (see runAllMailPasses), so an
// EWMA "observed average that adapts across pages" would have nothing to
// adapt across and was removed as dead complexity. A UID whose attachment
// size is unavailable (BODYSTRUCTURE parse gap) falls back to a single
// fixed conservative estimate, not a learned one.
//
// Default sizing: at the live-incident worst-case observed throughput of
// ~5.7 KB/s (gmail-blob-throughput-rootcause-0715.md), a 1 MiB page is
// ~3 minutes of transfer time in the worst case, leaving headroom inside
// the connector's ~15-minute run cadence for the rest of the run's work
// (normal message walk, other streams). The max (4 MiB, ~12 min worst-case)
// stays under one cadence window; the min (256 KiB, <1 min worst-case) is a
// usable floor for an operator who wants faster, smaller pages. No
// wall-clock timer is introduced — the budget bounds completed work, not
// elapsed time.

export const ATTACHMENT_BACKFILL_PAGE_MIN_BYTES = 256 * 1024;
export const ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES = 1024 * 1024;
export const ATTACHMENT_BACKFILL_PAGE_MAX_BYTES = 4 * 1024 * 1024;
// Served recovery is the whole run's bounded work unit: it returns before the
// ordinary forward walk. It can therefore use the established 4 MiB safe
// ceiling without changing the 1 MiB historical-backfill default, which
// reserves time for ordinary sync work in mixed runs.
export const ATTACHMENT_RECOVERY_PAGE_DEFAULT_BYTES =
	ATTACHMENT_BACKFILL_PAGE_MAX_BYTES;
/**
 * Fixed conservative per-UID cost used only when BODYSTRUCTURE reported no
 * usable attachment size. Not learned or updated — a single documented
 * fallback, chosen above the ordinary attachment-metadata overhead so a run
 * of unknown-size UIDs still forms a small, bounded page rather than an
 * unbounded one.
 */
export const ATTACHMENT_BACKFILL_UNKNOWN_SIZE_FALLBACK_BYTES = 256 * 1024;
const ATTACHMENT_BACKFILL_PAGE_BYTES_ENV =
	"PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES";
const ATTACHMENT_RECOVERY_PAGE_BYTES_ENV =
	"PDPP_GMAIL_ATTACHMENT_RECOVERY_PAGE_BYTES";

function boundedPositiveInteger(
	value: number | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
		return fallback;
	}
	return Math.max(min, Math.min(max, Math.floor(value)));
}

export function attachmentBackfillPageByteBudget(
	configuredTargetBytes?: number,
): number {
	return boundedPositiveInteger(
		configuredTargetBytes,
		ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES,
		ATTACHMENT_BACKFILL_PAGE_MIN_BYTES,
		ATTACHMENT_BACKFILL_PAGE_MAX_BYTES,
	);
}

export function resolveAttachmentBackfillPageByteBudget(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const value = env[ATTACHMENT_BACKFILL_PAGE_BYTES_ENV];
	if (!(value && POSITIVE_INTEGER_PATTERN.test(value))) {
		return attachmentBackfillPageByteBudget();
	}
	return attachmentBackfillPageByteBudget(Number(value));
}

function resolveAttachmentPageByteBudgetOverride(
	value: string | undefined,
): number | undefined {
	if (!(value && POSITIVE_INTEGER_PATTERN.test(value))) {
		return;
	}
	const parsed = Number(value);
	return parsed >= ATTACHMENT_BACKFILL_PAGE_MIN_BYTES &&
		parsed <= ATTACHMENT_BACKFILL_PAGE_MAX_BYTES
		? parsed
		: undefined;
}

/**
 * Resolve the served-recovery byte budget without coupling it to ordinary
 * forward backfill. The legacy backfill variable continues to override both
 * lanes until an operator opts into the recovery-specific variable.
 */
export function resolveAttachmentRecoveryPageByteBudget(
	env: NodeJS.ProcessEnv = process.env,
): number {
	return (
		resolveAttachmentPageByteBudgetOverride(
			env[ATTACHMENT_RECOVERY_PAGE_BYTES_ENV],
		) ??
		resolveAttachmentPageByteBudgetOverride(
			env[ATTACHMENT_BACKFILL_PAGE_BYTES_ENV],
		) ??
		ATTACHMENT_RECOVERY_PAGE_DEFAULT_BYTES
	);
}

/** The header fields a `messages` record reads; every lane fetches them. */
const MESSAGE_HEADER_FIELDS = [
	"list-unsubscribe",
	"auto-submitted",
	"references",
] as const;

const GMAIL_METADATA_FETCH_QUERY: ExtendedFetchQuery = {
	uid: true,
	envelope: true,
	internalDate: true,
	flags: true,
	size: true,
	bodyStructure: true,
	headers: [...MESSAGE_HEADER_FIELDS],
	source: false,
	labels: true,
	threadId: true,
	emailId: true,
};

/**
 * One UID's attachment byte cost, for page-size planning. `attachmentBytes`
 * is precomputed by the caller as: 0 for a UID with no attachments (a
 * no-attachment message must not consume the unknown-size fallback, or an
 * ordinary window of plain messages would starve to a handful admitted per
 * page); otherwise the sum of each attachment's known `size_bytes`, with
 * `ATTACHMENT_BACKFILL_UNKNOWN_SIZE_FALLBACK_BYTES` substituted per
 * attachment whose size is unavailable (never dropped, so a mix of known
 * and unknown attachment sizes is not underestimated).
 */
export interface AttachmentBackfillCandidate {
	readonly attachmentBytes: number;
	readonly uid: number;
}
export interface ServedAttachmentRecoverySummary {
	admitted: number;
	admitted_bytes: number;
	attachment_hydration_failure_outcome: AttachmentHydrationFailureOutcome;
	attempted: number;
	hydration_failed: number;
	lookup_miss: number;
	metadata_lookups: number;
	recovered: number;
	run_cap_deferred: number;
	served: number;
}

interface AttachmentHydrationFailureOutcome {
	blob_upload_http_4xx: number;
	blob_upload_http_5xx: number;
	blob_upload_integrity_failed: number;
	blob_upload_invalid_response: number;
	blob_upload_transport_failed: number;
	imap_download_failed: number;
	unclassified_failed: number;
}

function createAttachmentHydrationFailureOutcome(): AttachmentHydrationFailureOutcome {
	return {
		blob_upload_http_4xx: 0,
		blob_upload_http_5xx: 0,
		blob_upload_integrity_failed: 0,
		blob_upload_invalid_response: 0,
		blob_upload_transport_failed: 0,
		imap_download_failed: 0,
		unclassified_failed: 0,
	};
}

type GmailMessageLookupClient = Pick<ImapFlow, "search" | "fetchOne">;
type GmailAttachmentBackfillClient = GmailMessageLookupClient &
	Pick<ImapFlow, "fetch">;

// Bound the served-gap probe lane so START.detail_gaps can never fan out into
// unbounded Gmail metadata work before byte admission has a chance to stop the
// prefix. Same-message gaps reuse a single lookup through the cache.
const SERVED_ATTACHMENT_RECOVERY_METADATA_LOOKUP_LIMIT = 32;

/**
 * Trim a candidate list — MUST already be sorted ascending by UID by the
 * caller; this function trusts array order and does not re-sort, so an
 * out-of-order input silently produces a wrong prefix — to a byte-cost
 * page: keep admitting candidates in order while the running total of
 * attachment bytes stays within budget, but always admit at least one
 * candidate (mirrors `trimDetailGapPageToByteBudget`'s at-least-one-entry
 * rule) so a single oversized attachment cannot block all backfill
 * progress. Returns a PREFIX COUNT, not a UID value or set, so the caller
 * derives the admitted page positionally (`candidates.slice(0, admittedCount)`)
 * rather than by comparing UIDs — immune to UID gaps.
 */
export function trimAttachmentBackfillPageToByteBudget(
	candidates: readonly AttachmentBackfillCandidate[],
	byteBudget: number,
): { admittedCount: number; estimatedBytesTotal: number } {
	let admittedCount = 0;
	let estimatedBytesTotal = 0;
	for (const candidate of candidates) {
		const cost = candidate.attachmentBytes;
		if (admittedCount > 0 && estimatedBytesTotal + cost > byteBudget) {
			break;
		}
		admittedCount += 1;
		estimatedBytesTotal += cost;
		if (estimatedBytesTotal >= byteBudget) {
			break;
		}
	}
	return { admittedCount, estimatedBytesTotal };
}

function servedAttachmentDetailGaps(
	detailGaps: readonly DetailGapStartEntry[] | undefined,
): readonly DetailGapStartEntry[] {
	if (!Array.isArray(detailGaps) || detailGaps.length === 0) {
		return [];
	}
	return detailGaps.filter((gap) => {
		if (gap.stream !== "attachments" || gap.status !== "pending") {
			return false;
		}
		const locator = gap.detail_locator;
		if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
			return false;
		}
		const typedLocator = locator as Record<string, unknown>;
		return (
			typedLocator.kind === "gmail.attachment_detail" &&
			typedLocator.message_id != null &&
			typedLocator.part_index != null
		);
	});
}

function normalizeGmailAttachmentRecoveryLocator(gap: DetailGapStartEntry): {
	attachmentId: string | null;
	messageId: string;
	partIndex: string;
} | null {
	const locator = gap.detail_locator;
	if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
		return null;
	}
	const typedLocator = locator as Record<string, unknown>;
	if (typedLocator.kind !== "gmail.attachment_detail") {
		return null;
	}
	const messageId =
		typedLocator.message_id == null
			? ""
			: String(typedLocator.message_id).trim();
	const partIndex =
		typedLocator.part_index == null
			? ""
			: String(typedLocator.part_index).trim();
	if (!(messageId && partIndex)) {
		return null;
	}
	const attachmentId =
		typedLocator.attachment_id == null
			? null
			: String(typedLocator.attachment_id).trim() || null;
	return { attachmentId, messageId, partIndex };
}

async function fetchGmailMessageByMessageId(
	client: GmailMessageLookupClient,
	messageId: string,
): Promise<FetchMessageObject | null> {
	const uids = await client.search({ emailId: messageId }, { uid: true });
	if (!uids || uids.length === 0) {
		return null;
	}
	const [uid] = uids;
	if (uid == null) {
		return null;
	}
	const message = await client.fetchOne(
		String(uid),
		GMAIL_METADATA_FETCH_QUERY,
		{ uid: true },
	);
	return message || null;
}

function buildServedAttachmentRecoveryProgressMessage(args: {
	admitted: number;
	metadataLookups: number;
	phase: "hydrating" | "settled";
	recovered: number;
}): string {
	return args.phase === "hydrating"
		? `Retrying ${args.admitted} ${args.admitted === 1 ? "attachment" : "attachments"} that failed earlier (${args.recovered} recovered)`
		: `Recovered ${args.recovered} of ${args.admitted} previously failed ${args.admitted === 1 ? "attachment" : "attachments"}`;
}

async function emitServedAttachmentRecoveryProgress(
	emitProtocol: (msg: EmittedMessage) => Promise<void>,
	progress: {
		admitted: number;
		metadataLookups: number;
		phase: "hydrating" | "settled";
		recovered: number;
	},
): Promise<void> {
	gmailDiagnostic("served_attachment_recovery_progress", {
		phase: progress.phase,
		admitted: progress.admitted,
		recovered: progress.recovered,
		metadata_lookups: progress.metadataLookups,
	});
	await emitProtocol({
		type: "PROGRESS",
		stream: "attachments",
		message: buildServedAttachmentRecoveryProgressMessage(progress),
		count:
			progress.phase === "hydrating" ? progress.admitted : progress.recovered,
		total:
			progress.phase === "hydrating"
				? progress.metadataLookups
				: progress.admitted,
	});
}

interface ServedAttachmentRecoveryState {
	admitted: number;
	admittedBytesTotal: number;
	attachmentHydrationFailureOutcome: AttachmentHydrationFailureOutcome;
	attempted: number;
	hydrationFailed: number;
	lookupMiss: number;
	messageCache: Map<string, FetchMessageObject | null>;
	metadataLookups: number;
	recovered: number;
	recoveredAttachmentGapIds: Set<string>;
	runCapDeferred: number;
}

type ServedAttachmentRecoveryLookupResult =
	| FetchMessageObject
	| null
	| "metadata_lookup_limit_reached";
type ServedAttachmentRecoveryStop =
	| "byte_budget"
	| "metadata_lookup_cap"
	| false;

async function loadServedAttachmentRecoveryMessage(
	client: GmailMessageLookupClient,
	messageId: string,
	state: ServedAttachmentRecoveryState,
): Promise<ServedAttachmentRecoveryLookupResult> {
	const cachedMessage = state.messageCache.get(messageId);
	if (cachedMessage !== undefined) {
		return cachedMessage;
	}
	if (
		state.metadataLookups >= SERVED_ATTACHMENT_RECOVERY_METADATA_LOOKUP_LIMIT
	) {
		return "metadata_lookup_limit_reached";
	}
	state.metadataLookups += 1;
	const message = await fetchGmailMessageByMessageId(client, messageId);
	state.messageCache.set(messageId, message);
	return message;
}

async function settleServedAttachmentRecoveryAttempt(
	deps: {
		attachmentCoverage?: AttachmentDetailCoverage;
		detailGaps?: readonly DetailGapStartEntry[] | undefined;
		emitProtocol: (msg: EmittedMessage) => Promise<void>;
		emitRecord: EmitRecordFn;
	},
	state: ServedAttachmentRecoveryState,
	gap: DetailGapStartEntry,
	hydration: AttachmentHydrationResult,
): Promise<void> {
	const hydrated = hydration.record;
	if (!writesAttachmentRecord(hydrated)) {
		// No record over a part that may be stored hydrated: re-defer the served
		// gap under its lease, which accounts for the key in this run.
		let deferred = false;
		try {
			await deps.emitProtocol(
				buildServedAttachmentRecoveryDeferredGap(
					gap,
					hydrated.hydration_status === "failed"
						? attachmentHydrationFailureClass(hydration.failure)
						: "attachment_unhydrated",
				),
			);
			deferred = true;
		} catch {
			// A failed protocol write leaves no durable retry obligation.
		}
		if (deps.attachmentCoverage) {
			recordAttachmentCoverage(
				deps.attachmentCoverage,
				hydrated,
				hydration.failure,
				false,
				deferred,
			);
		}
		if (hydrated.hydration_status === "failed") {
			state.hydrationFailed += 1;
			if (hydration.failure) {
				state.attachmentHydrationFailureOutcome[hydration.failure.stage] += 1;
			} else {
				state.attachmentHydrationFailureOutcome.unclassified_failed += 1;
			}
		}
		await emitServedAttachmentRecoveryProgress(deps.emitProtocol, {
			admitted: state.admitted,
			metadataLookups: state.metadataLookups,
			phase: "settled",
			recovered: state.recovered,
		});
		return;
	}
	let emitted: Awaited<ReturnType<EmitRecordFn>> = false;
	let emitFailure: { error: unknown } | undefined;
	let gapEmitted = false;
	try {
		emitted = await deps.emitRecord("attachments", { ...hydrated });
	} catch (error) {
		emitFailure = { error };
	} finally {
		// The host credits a required key only against a gap it settled in this
		// run. Leaving the served gap untouched would leave this key unaccounted
		// on every run, so a rejected emission re-defers the served gap under
		// its own lease, as a lookup miss does.
		if (emitted === false) {
			try {
				await deps.emitProtocol(
					buildServedAttachmentRecoveryDeferredGap(
						gap,
						"attachment_record_rejected",
					),
				);
				gapEmitted = true;
			} catch {
				// A failed protocol write leaves no durable retry obligation.
			}
		}
		if (deps.attachmentCoverage) {
			recordAttachmentCoverage(
				deps.attachmentCoverage,
				hydrated,
				hydration.failure,
				emitted !== false,
				gapEmitted,
			);
		}
	}
	if (emitFailure && !gapEmitted) throw emitFailure.error;
	if (emitted && hydrated.hydration_status === "hydrated") {
		const recoveredGaps = findRecoveredAttachmentDetailGaps(
			deps.detailGaps,
			hydrated,
			state.recoveredAttachmentGapIds,
		);
		for (const recoveredGap of recoveredGaps) {
			state.recoveredAttachmentGapIds.add(recoveredGap.gap_id);
			await deps.emitProtocol({
				type: "DETAIL_GAP_RECOVERED",
				reference_only: true,
				gap_id: recoveredGap.gap_id,
				...(recoveredGap.lease_id ? { lease_id: recoveredGap.lease_id } : {}),
				record_key: hydrated.id,
				stream: "attachments",
			});
			state.recovered += 1;
		}
	}
	// Emit bounded, non-secret progress as each admitted attempt settles so a
	// long single hydration is visible before the whole recovery lane ends.
	await emitServedAttachmentRecoveryProgress(deps.emitProtocol, {
		admitted: state.admitted,
		metadataLookups: state.metadataLookups,
		phase: "settled",
		recovered: state.recovered,
	});
}

function buildServedAttachmentRecoveryDeferredGap(
	gap: DetailGapStartEntry,
	/** A bounded, non-secret class; never raw error text. */
	errorClass: string,
): EmittedMessage {
	const locator =
		gap.detail_locator &&
		typeof gap.detail_locator === "object" &&
		!Array.isArray(gap.detail_locator)
			? (gap.detail_locator as DetailGapMessage["detail_locator"])
			: { kind: "gmail.attachment_detail" };
	return {
		type: "DETAIL_GAP",
		reference_only: true,
		status: "pending",
		stream: "attachments",
		parent_stream: "messages",
		record_key: gap.record_key ?? gap.gap_id,
		detail_locator: locator,
		reason: "temporary_unavailable",
		retryable: true,
		last_error: { class: errorClass },
		gap_id: gap.gap_id,
		...(gap.lease_id ? { lease_id: gap.lease_id } : {}),
	};
}

async function markServedAttachmentRecoveryAttempt(
	gap: DetailGapStartEntry,
	emitProtocol: (msg: EmittedMessage) => Promise<void>,
): Promise<void> {
	if (!gap.lease_id) {
		return;
	}
	await emitProtocol({
		type: "DETAIL_GAP_ATTEMPTED",
		reference_only: true,
		gap_id: gap.gap_id,
		lease_id: gap.lease_id,
		stream: "attachments",
	});
}

async function processServedAttachmentRecoveryGap(
	client: GmailMessageLookupClient,
	gap: DetailGapStartEntry,
	deps: {
		attachmentCoverage?: AttachmentDetailCoverage;
		detailGaps?: readonly DetailGapStartEntry[] | undefined;
		emitProtocol: (msg: EmittedMessage) => Promise<void>;
		emitRecord: EmitRecordFn;
		hydrateAttachment: HydrateAttachmentFn;
		requested?: ReadonlyMap<string, StreamRequest>;
	},
	state: ServedAttachmentRecoveryState,
	byteBudget: number,
): Promise<ServedAttachmentRecoveryStop> {
	// The walk already handled this key in this run: it recovered the gap, or
	// it attempted the attachment and left its own outcome (a gap for the same
	// key, or ledger debt). A second attempt would re-download the bytes and
	// could re-defer a gap the walk already settled.
	if (
		state.recoveredAttachmentGapIds.has(gap.gap_id) ||
		(typeof gap.record_key === "string" &&
			deps.attachmentCoverage?.requiredKeys.includes(gap.record_key) === true)
	) {
		return false;
	}
	if (state.admitted > 0 && state.admittedBytesTotal >= byteBudget) {
		return "byte_budget";
	}

	const locator = normalizeGmailAttachmentRecoveryLocator(gap);
	if (!locator) {
		return false;
	}

	// A metadata lookup is a real provider attempt even when it finds no
	// matching message/attachment. The host records this explicit outcome; it
	// never infers attempt status from a successful DONE envelope.
	if (
		!state.messageCache.has(locator.messageId) &&
		state.metadataLookups >= SERVED_ATTACHMENT_RECOVERY_METADATA_LOOKUP_LIMIT
	) {
		return "metadata_lookup_cap";
	}
	state.attempted += 1;
	await markServedAttachmentRecoveryAttempt(gap, deps.emitProtocol);
	const loadedMessage = await loadServedAttachmentRecoveryMessage(
		client,
		locator.messageId,
		state,
	);
	if (loadedMessage === "metadata_lookup_limit_reached") {
		return "metadata_lookup_cap";
	}
	if (!loadedMessage) {
		state.lookupMiss += 1;
		await deps.emitProtocol(
			buildServedAttachmentRecoveryDeferredGap(gap, "attachment_lookup_miss"),
		);
		return false;
	}

	const normalizedAttachmentKey = normalizeAttachmentRecoveryKey(
		gap.record_key,
	);
	if (!normalizedAttachmentKey) {
		return false;
	}

	// An incomplete FETCH cannot locate the part or date its record; the gap
	// stays deferred under its lease until the server returns the items.
	const unavailable = unavailableFetchItem(loadedMessage, "attachments");
	if (unavailable) {
		await deps.emitProtocol(
			buildServedAttachmentRecoveryDeferredGap(gap, unavailable),
		);
		return false;
	}
	const messageKey = String(loadedMessage.emailId ?? locator.messageId);
	const receivedAt = new Date(
		loadedMessage.internalDate as Date | string,
	).toISOString();
	const attachments = decodeBodystructureForAttachments(
		loadedMessage.bodyStructure,
		messageKey,
		receivedAt,
	);
	const attachment = attachments.find((candidate) =>
		attachmentDetailGapMatches(gap, candidate, normalizedAttachmentKey),
	);
	if (!attachment) {
		state.lookupMiss += 1;
		await deps.emitProtocol(
			buildServedAttachmentRecoveryDeferredGap(gap, "attachment_lookup_miss"),
		);
		return false;
	}

	if (attachmentOutsideResourceScope(deps.requested, attachment)) return false;

	const attachmentBytes =
		typeof attachment.size_bytes === "number"
			? attachment.size_bytes
			: ATTACHMENT_BACKFILL_UNKNOWN_SIZE_FALLBACK_BYTES;
	if (
		state.admitted > 0 &&
		state.admittedBytesTotal + attachmentBytes > byteBudget
	) {
		await deps.emitProtocol(
			buildServedAttachmentRecoveryDeferredGap(gap, "run_cap_deferred"),
		);
		return "byte_budget";
	}

	state.admitted += 1;
	state.admittedBytesTotal += attachmentBytes;

	await emitServedAttachmentRecoveryProgress(deps.emitProtocol, {
		admitted: state.admitted,
		metadataLookups: state.metadataLookups,
		phase: "hydrating",
		recovered: state.recovered,
	});

	const hydration = await deps.hydrateAttachment(loadedMessage, attachment);
	await settleServedAttachmentRecoveryAttempt(deps, state, gap, hydration);
	return false;
}

export async function recoverServedAttachmentGaps(
	client: GmailMessageLookupClient,
	deps: {
		attachmentCoverage?: AttachmentDetailCoverage;
		detailGaps?: readonly DetailGapStartEntry[] | undefined;
		emitProtocol: (msg: EmittedMessage) => Promise<void>;
		emitRecord: EmitRecordFn;
		hydrateAttachment: HydrateAttachmentFn;
		requested?: ReadonlyMap<string, StreamRequest>;
		recoveredAttachmentGapIds?: Set<string>;
	},
): Promise<ServedAttachmentRecoverySummary> {
	const servedGaps = servedAttachmentDetailGaps(deps.detailGaps);
	if (servedGaps.length === 0) {
		return {
			admitted: 0,
			admitted_bytes: 0,
			attempted: 0,
			attachment_hydration_failure_outcome:
				createAttachmentHydrationFailureOutcome(),
			hydration_failed: 0,
			lookup_miss: 0,
			metadata_lookups: 0,
			recovered: 0,
			run_cap_deferred: 0,
			served: 0,
		};
	}
	const byteBudget = resolveAttachmentRecoveryPageByteBudget();
	const recoveryState: ServedAttachmentRecoveryState = {
		admitted: 0,
		admittedBytesTotal: 0,
		attachmentHydrationFailureOutcome:
			createAttachmentHydrationFailureOutcome(),
		attempted: 0,
		hydrationFailed: 0,
		lookupMiss: 0,
		metadataLookups: 0,
		messageCache: new Map<string, FetchMessageObject | null>(),
		recovered: 0,
		recoveredAttachmentGapIds:
			deps.recoveredAttachmentGapIds ?? new Set<string>(),
		runCapDeferred: 0,
	};
	const recoveryAttemptDeps = {
		...(deps.attachmentCoverage
			? { attachmentCoverage: deps.attachmentCoverage }
			: {}),
		detailGaps: deps.detailGaps,
		emitProtocol: deps.emitProtocol,
		emitRecord: deps.emitRecord,
		hydrateAttachment: deps.hydrateAttachment,
		...(deps.requested ? { requested: deps.requested } : {}),
	};

	for (const [index, gap] of servedGaps.entries()) {
		const stop = await processServedAttachmentRecoveryGap(
			client,
			gap,
			recoveryAttemptDeps,
			recoveryState,
			byteBudget,
		);
		if (stop) {
			if (stop === "byte_budget") {
				recoveryState.runCapDeferred = servedGaps.length - index;
			}
			break;
		}
	}
	return {
		admitted: recoveryState.admitted,
		admitted_bytes: recoveryState.admittedBytesTotal,
		attempted: recoveryState.attempted,
		attachment_hydration_failure_outcome:
			recoveryState.attachmentHydrationFailureOutcome,
		hydration_failed: recoveryState.hydrationFailed,
		lookup_miss: recoveryState.lookupMiss,
		metadata_lookups: recoveryState.metadataLookups,
		recovered: recoveryState.recovered,
		run_cap_deferred: recoveryState.runCapDeferred,
		served: servedGaps.length,
	};
}

async function recoverServedAttachmentGapsIfRequested(
	client: GmailMessageLookupClient,
	deps: {
		attachmentCoverage: AttachmentDetailCoverage | undefined;
		detailGaps: readonly DetailGapStartEntry[] | undefined;
		emitProtocol: (msg: EmittedMessage) => Promise<void>;
		emitRecord: EmitRecordFn;
		hydrateAttachment: HydrateAttachmentFn;
		requested?: ReadonlyMap<string, StreamRequest>;
		recoveredAttachmentGapIds: Set<string>;
	},
): Promise<void> {
	if (servedAttachmentDetailGaps(deps.detailGaps).length === 0) {
		return;
	}
	const recoverySummary = await recoverServedAttachmentGaps(client, {
		...(deps.attachmentCoverage
			? { attachmentCoverage: deps.attachmentCoverage }
			: {}),
		detailGaps: deps.detailGaps,
		emitProtocol: deps.emitProtocol,
		emitRecord: deps.emitRecord,
		hydrateAttachment: deps.hydrateAttachment,
		...(deps.requested ? { requested: deps.requested } : {}),
		recoveredAttachmentGapIds: deps.recoveredAttachmentGapIds,
	});
	const { attachment_hydration_failure_outcome, ...attachmentRecoveryOutcome } =
		recoverySummary;
	gmailDiagnostic("served_attachment_recovery_summary", {
		admitted: recoverySummary.admitted,
		recovered: recoverySummary.recovered,
	});
	await deps.emitProtocol({
		type: "PROGRESS",
		stream: "attachments",
		message: `Recovered ${recoverySummary.recovered} of ${recoverySummary.admitted} previously failed attachments`,
		count: recoverySummary.recovered,
		total: recoverySummary.admitted,
		attachment_recovery_outcome: {
			object: "attachment_recovery_outcome",
			...attachmentRecoveryOutcome,
		},
		attachment_hydration_failure_outcome: {
			object: "attachment_hydration_failure_outcome",
			...attachment_hydration_failure_outcome,
		},
	});
}

/**
 * Plan one historical attachment backfill page from probe metadata: sort
 * ascending by UID (IMAP fetch responses are not guaranteed to arrive in
 * UID order, and the trim/admission logic is a prefix walk that must
 * operate over a UID-ordered sequence — an out-of-order high UID admitted
 * first would let a `uid <= max` derivation cover the entire coarse window,
 * silently defeating the byte budget), compute each UID's cost, trim to the
 * byte budget, and derive the admitted metas + end UID positionally.
 */
function planAttachmentBackfillPage(
	probeMetas: readonly FetchMessageObject[],
	byteBudget: number,
	fallbackEndUid: number,
): { backfillMetas: FetchMessageObject[]; backfillWindowEndUid: number } {
	const sortedMetas = probeMetas.slice().sort((a, b) => a.uid - b.uid);
	const candidates: AttachmentBackfillCandidate[] = sortedMetas.map((meta) => ({
		uid: meta.uid,
		attachmentBytes: attachmentBackfillCandidateCost(meta),
	}));
	const { admittedCount } = trimAttachmentBackfillPageToByteBudget(
		candidates,
		byteBudget,
	);
	const backfillMetas = sortedMetas.slice(0, admittedCount);
	const lastAdmittedMeta = backfillMetas.at(-1);
	return {
		backfillMetas,
		backfillWindowEndUid: lastAdmittedMeta
			? lastAdmittedMeta.uid
			: fallbackEndUid,
	};
}

/**
 * A UID with zero attachments costs nothing — it must not consume the
 * unknown-size fallback (that would starve ordinary no-attachment messages
 * down to a handful per page). A UID with one or more attachments sums each
 * attachment's known size, substituting the fixed fallback per attachment
 * whose size is unavailable, so a mix of known and unknown sizes is not
 * underestimated by silently dropping the unknown ones.
 */
function attachmentBackfillCandidateCost(meta: FetchMessageObject): number {
	const attachments = decodeBodystructureForAttachments(
		meta.bodyStructure,
		String(meta.emailId ?? meta.uid),
		perMessageInternalDateToIso(meta.internalDate, nowIso),
	);
	return attachments.reduce(
		(sum, a) =>
			sum +
			(typeof a.size_bytes === "number"
				? a.size_bytes
				: ATTACHMENT_BACKFILL_UNKNOWN_SIZE_FALLBACK_BYTES),
		0,
	);
}

function boundedHydrationError(err: unknown): string {
	// Attachment downloads go over IMAP too, so the same generic
	// "Command failed" applies here — keep the server's reason, then bound it.
	const raw = describeUnexpectedFailure(err);
	return raw.slice(0, HYDRATION_ERROR_MAX_CHARS);
}

function hydrationFailureResult(
	attachment: AttachmentRecord,
	status: Exclude<AttachmentHydrationStatus, "hydrated">,
	err: unknown,
	failure: AttachmentHydrationFailure | null = null,
): AttachmentHydrationResult {
	return {
		failure,
		record: {
			...attachment,
			blob_ref: null,
			content_sha256: null,
			hydration_status: status,
			hydration_error: boundedHydrationError(err),
		},
	};
}

function originalHydrationError(err: unknown): unknown {
	return err instanceof ReferenceBlobUploadFailure && err.cause !== undefined
		? err.cause
		: err;
}

/**
 * The MIME type to upload one attachment under, guaranteed to satisfy the blob
 * endpoint's media-type grammar.
 *
 * The candidates are tried in source-preference order (IMAP `BODYSTRUCTURE`
 * `contentType`, then the record's own `content_type`), and the FIRST VALID one
 * wins — not the first non-empty one. That distinction is the defect this
 * function fixes: the previous `a || b || DEFAULT` chain only fell through on
 * an empty value, so a non-empty but malformed type was passed straight to the
 * upload and rejected with a 400 (`mime_type must be a valid media type`).
 *
 * The real instance was `image/*`: IMAP servers may report a wildcard subtype
 * for a part whose concrete type the server declines to narrow. It is
 * non-empty, so it survived the `||` chain; `*` is outside the endpoint's
 * grammar, so every attempt failed identically. Because a 4xx is not
 * retry-convergent, the item burned its whole no-progress budget and was
 * quarantined `terminal` — which, on a REQUIRED stream with no durable
 * impossibility proof, renders the whole source as "Missing data" forever. The
 * bytes were always fetchable; only the label on them was malformed.
 *
 * Falling back to `application/octet-stream` is the honest answer for a type
 * the source would not state precisely: it claims nothing beyond "opaque
 * bytes", which is exactly what a wildcard conveyed. A parameterized type
 * (`text/plain; charset=utf-8`) stays valid — the endpoint strips parameters
 * itself, so it is passed through unchanged rather than downgraded.
 */
export function normalizeAttachmentMimeType(
	...candidates: readonly (string | null | undefined)[]
): string {
	for (const candidate of candidates) {
		if (typeof candidate !== "string") {
			continue;
		}
		// Match the endpoint's own normalization before testing: it compares the
		// pre-`;` half, trimmed and lowercased. Testing the raw string instead
		// would reject a valid parameterized type this function must preserve.
		const mediaType = (candidate.split(";")[0] ?? "").trim().toLowerCase();
		if (mediaType && VALID_MEDIA_TYPE_PATTERN.test(mediaType)) {
			return candidate;
		}
	}
	return DEFAULT_ATTACHMENT_MIME_TYPE;
}

function hydrationFailureForBlobUpload(
	err: unknown,
): AttachmentHydrationFailure | null {
	if (!(err instanceof ReferenceBlobUploadFailure)) {
		return null;
	}
	switch (err.kind) {
		case "http_4xx":
			return { stage: "blob_upload_http_4xx" };
		case "http_5xx":
			return { stage: "blob_upload_http_5xx" };
		case "invalid_response":
			return { stage: "blob_upload_invalid_response" };
		case "integrity_mismatch":
			return { stage: "blob_upload_integrity_failed" };
		case "source_content_failed":
			return { stage: "imap_download_failed" };
		case "transport":
			return { stage: "blob_upload_transport_failed" };
		default:
			return null;
	}
}

/**
 * Resolve the per-attachment max byte cap from env, falling back to the
 * conservative default. Non-positive or non-numeric overrides are ignored
 * so a misconfigured env var can never silently disable the cap.
 */
export function resolveMaxAttachmentBytes(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = env[MAX_ATTACHMENT_BYTES_ENV];
	if (!raw) {
		return DEFAULT_MAX_ATTACHMENT_BYTES;
	}
	if (!POSITIVE_INTEGER_PATTERN.test(raw)) {
		return DEFAULT_MAX_ATTACHMENT_BYTES;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_MAX_ATTACHMENT_BYTES;
	}
	return parsed;
}

class AttachmentTooLargeError extends Error {
	constructor(observedBytes: number, maxBytes: number) {
		super(`attachment exceeds max size: ${observedBytes} > ${maxBytes} bytes`);
		this.name = "AttachmentTooLargeError";
	}
}

/**
 * Raised when an attachment transfer goes silent (no chunk received) for
 * longer than the stall budget. The message deliberately contains "timeout"
 * so `isImapTransientError` (and `handleMainRejection`'s classification) marks
 * the resulting run failure retryable without a second keyword list to keep
 * in sync.
 */
export class AttachmentStallTimeoutError extends Error {
	constructor(stallMs: number, observedBytes: number) {
		super(
			`attachment transfer stalled: no data for ${stallMs}ms after ${observedBytes} bytes (timeout)`,
		);
		this.name = "AttachmentStallTimeoutError";
	}
}

/**
 * Wrap an AsyncIterable so that consumed bytes are tallied and the stream
 * aborts with `AttachmentTooLargeError` the moment it exceeds the cap.
 * Used as a defense-in-depth guard against attachments whose source size
 * is missing or under-reported.
 */
function enforceMaxBytes(
	content: AsyncIterable<Buffer | Uint8Array | string>,
	maxBytes: number,
): AsyncIterable<Buffer | Uint8Array | string> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<Buffer | Uint8Array | string> {
			const inner = content[Symbol.asyncIterator]();
			let observed = 0;
			return {
				async next() {
					const step = await inner.next();
					if (step.done) {
						return step;
					}
					const chunk = step.value;
					const chunkSize =
						typeof chunk === "string"
							? Buffer.byteLength(chunk)
							: (chunk as Buffer | Uint8Array).byteLength;
					observed += chunkSize;
					if (observed > maxBytes) {
						if (typeof inner.return === "function") {
							await inner.return();
						}
						throw new AttachmentTooLargeError(observed, maxBytes);
					}
					return step;
				},
				return(value): Promise<IteratorResult<Buffer | Uint8Array | string>> {
					if (typeof inner.return === "function") {
						return inner.return(value);
					}
					return Promise.resolve({ done: true, value });
				},
			};
		},
	};
}

/**
 * Wrap an AsyncIterable so that SILENCE (no chunk delivered) longer than
 * `stallMs` aborts the transfer, instead of a fixed total-duration cap.
 *
 * A total-duration timeout is wrong here: legitimate large attachments over
 * a slow-but-live IMAP transfer (observed live at ~4.65 KB/s — see
 * gmail-attachment-convergence-0809 root-cause notes) can honestly take many
 * minutes while still making steady progress. A stall budget only fires when
 * that progress actually STOPS, which is the real distinguishing signal
 * between "slow" and "wedged" (mirrors the test-accounting authority runner's
 * stall-vs-total-runtime distinction).
 *
 * `onStall` MUST leave the source iterable unusable afterward (e.g. by
 * force-closing the underlying IMAP connection) — imapflow has no per-command
 * cancel; the only way to unblock an abandoned in-flight FETCH is to close
 * the whole connection (see `fetchAttachmentPart`). This wrapper does not
 * call `inner.return()` on stall for that reason: the source is expected to
 * already be dead by the time `onStall` returns.
 */
function enforceStallTimeout(
	content: AsyncIterable<Buffer | Uint8Array | string>,
	stallMs: number,
	onStall: () => void,
): AsyncIterable<Buffer | Uint8Array | string> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<Buffer | Uint8Array | string> {
			const inner = content[Symbol.asyncIterator]();
			let observed = 0;
			return {
				async next() {
					let timer: ReturnType<typeof setTimeout> | undefined;
					const stalled = new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							onStall();
							reject(new AttachmentStallTimeoutError(stallMs, observed));
						}, stallMs);
					});
					try {
						const step = await Promise.race([inner.next(), stalled]);
						if (!step.done) {
							const chunk = step.value;
							observed +=
								typeof chunk === "string"
									? Buffer.byteLength(chunk)
									: (chunk as Buffer | Uint8Array).byteLength;
						}
						return step;
					} finally {
						clearTimeout(timer);
					}
				},
				return(value): Promise<IteratorResult<Buffer | Uint8Array | string>> {
					if (typeof inner.return === "function") {
						return inner.return(value);
					}
					return Promise.resolve({ done: true, value });
				},
			};
		},
	};
}

/**
 * Resolve the attachment stall budget from env, falling back to the
 * conservative default. Non-positive or non-numeric overrides are ignored so
 * a misconfigured env var can never silently disable the guard.
 */
export function resolveAttachmentStallTimeoutMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = env[ATTACHMENT_STALL_TIMEOUT_MS_ENV];
	if (!(raw && POSITIVE_INTEGER_PATTERN.test(raw))) {
		return DEFAULT_ATTACHMENT_STALL_TIMEOUT_MS;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_ATTACHMENT_STALL_TIMEOUT_MS;
}

/** One in-transfer progress observation, bounded and pre-redacted at the
 *  source: no attachment id, filename, subject, sender, or content ever
 *  reaches this shape. `totalBytes` is present only when the source already
 *  reported a trusted expected size (BODYSTRUCTURE / IMAP FETCH metadata) —
 *  never inferred or guessed. */
export interface AttachmentTransferProgress {
	bytesTransferred: number;
	elapsedMs: number;
	phase: "transferring" | "complete";
	totalBytes: number | null;
}

/**
 * Resolve the in-transfer progress cadence from env. Both a minimum elapsed
 * time AND a minimum byte delta must be satisfied before a new progress
 * observation fires (see `enforceTransferProgress`) — either alone is
 * ignorable by a pathological source (a firehose of 1-byte chunks would
 * otherwise defeat a bytes-only gate; a single giant chunk every few ms
 * would defeat a time-only gate). Non-positive or non-numeric overrides fall
 * back to the default so a misconfigured env var can never turn the cadence
 * gate into a flood.
 */
const ATTACHMENT_PROGRESS_MIN_INTERVAL_MS_ENV =
	"PDPP_GMAIL_ATTACHMENT_PROGRESS_MIN_INTERVAL_MS";
const ATTACHMENT_PROGRESS_MIN_BYTES_ENV =
	"PDPP_GMAIL_ATTACHMENT_PROGRESS_MIN_BYTES";
export const DEFAULT_ATTACHMENT_PROGRESS_MIN_INTERVAL_MS = 15_000;
export const DEFAULT_ATTACHMENT_PROGRESS_MIN_BYTES = 256 * 1024;

function resolveBoundedEnvInt(
	raw: string | undefined,
	fallback: number,
): number {
	if (!(raw && POSITIVE_INTEGER_PATTERN.test(raw))) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveAttachmentProgressMinIntervalMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	return resolveBoundedEnvInt(
		env[ATTACHMENT_PROGRESS_MIN_INTERVAL_MS_ENV],
		DEFAULT_ATTACHMENT_PROGRESS_MIN_INTERVAL_MS,
	);
}

export function resolveAttachmentProgressMinBytes(
	env: NodeJS.ProcessEnv = process.env,
): number {
	return resolveBoundedEnvInt(
		env[ATTACHMENT_PROGRESS_MIN_BYTES_ENV],
		DEFAULT_ATTACHMENT_PROGRESS_MIN_BYTES,
	);
}

/**
 * Wrap an AsyncIterable so that observed chunk bytes drive a cadence-gated
 * `onProgress` callback — bounded, redacted, and inert with respect to the
 * transfer itself.
 *
 * Composed OUTSIDE `enforceStallTimeout` (see `makeAttachmentHydrator`): this
 * wrapper never participates in stall detection, so nothing it does —
 * including a slow or throwing `onProgress` — can affect stall timing.
 * `onProgress` is fire-and-forget (never awaited inline in the chunk path)
 * and any error it throws is swallowed, so it cannot add latency or turn a
 * successful transfer into a failed one — the one exception is that a
 * REJECTED `onProgress` promise is still observed via `.catch()`, which is
 * enough to prevent an unhandled-rejection crash without blocking the loop.
 *
 * Cadence: an observation fires only once BOTH `minIntervalMs` elapsed AND
 * `minBytes` new bytes arrived since the last one (see
 * `resolveAttachmentProgressMinIntervalMs`/`resolveAttachmentProgressMinBytes`),
 * so a run with many small/fast attachments cannot flood the event stream —
 * most attachments will finish within one cadence window and emit only the
 * `complete` signal, never a mid-transfer one. The `complete` signal always
 * fires exactly once at end-of-stream, bypassing the cadence gate, so every
 * transfer has a coherent start-adjacent/end pair regardless of size.
 */
function enforceTransferProgress(
	content: AsyncIterable<Buffer | Uint8Array | string>,
	args: {
		minBytes: number;
		minIntervalMs: number;
		now: () => number;
		onProgress: (progress: AttachmentTransferProgress) => void;
		totalBytes: number | null;
	},
): AsyncIterable<Buffer | Uint8Array | string> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<Buffer | Uint8Array | string> {
			const inner = content[Symbol.asyncIterator]();
			const startedAt = args.now();
			let observed = 0;
			let lastEmitAt = startedAt;
			let lastEmitBytes = 0;
			const safeEmit = (progress: AttachmentTransferProgress): void => {
				try {
					args.onProgress(progress);
				} catch {
					// A progress observer must never be able to fail the transfer.
				}
			};
			return {
				async next() {
					const step = await inner.next();
					if (step.done) {
						safeEmit({
							bytesTransferred: observed,
							elapsedMs: args.now() - startedAt,
							phase: "complete",
							totalBytes: args.totalBytes,
						});
						return step;
					}
					const chunk = step.value;
					observed +=
						typeof chunk === "string"
							? Buffer.byteLength(chunk)
							: (chunk as Buffer | Uint8Array).byteLength;
					const nowMs = args.now();
					if (
						nowMs - lastEmitAt >= args.minIntervalMs &&
						observed - lastEmitBytes >= args.minBytes
					) {
						lastEmitAt = nowMs;
						lastEmitBytes = observed;
						safeEmit({
							bytesTransferred: observed,
							elapsedMs: nowMs - startedAt,
							phase: "transferring",
							totalBytes: args.totalBytes,
						});
					}
					return step;
				},
				return(value): Promise<IteratorResult<Buffer | Uint8Array | string>> {
					if (typeof inner.return === "function") {
						return inner.return(value);
					}
					return Promise.resolve({ done: true, value });
				},
			};
		},
	};
}

/** Owner-facing PROGRESS text for one in-transfer observation: megabytes
 *  only. Phase, exact byte counters and elapsed time go to the
 *  `attachment_transfer` diagnostic line instead. */
export function buildAttachmentTransferProgressMessage(
	progress: AttachmentTransferProgress,
): string {
	const megabytes = (bytes: number): string =>
		(bytes / (1024 * 1024)).toFixed(1);
	return progress.totalBytes === null
		? `Downloading attachment (${megabytes(progress.bytesTransferred)} MB so far)`
		: `Downloading attachment (${megabytes(progress.bytesTransferred)} of ${megabytes(progress.totalBytes)} MB)`;
}

/** A trusted, already-known expected size only — never inferred or guessed
 *  from observed bytes. Prefers the IMAP download response's own reported
 *  size (freshest), falling back to the BODYSTRUCTURE-derived size already
 *  on the attachment record. */
function trustedAttachmentTotalBytes(
	downloaded: AttachmentDownload,
	attachment: AttachmentRecord,
): number | null {
	if (typeof downloaded.expectedSize === "number") {
		return downloaded.expectedSize;
	}
	if (typeof attachment.size_bytes === "number") {
		return attachment.size_bytes;
	}
	return null;
}

interface AttachmentHydratorArgs {
	connectorId: string;
	fetchAttachment: FetchAttachmentFn;
	maxBytes?: number;
	onStall?: () => void;
	onTransferProgress?: (progress: AttachmentTransferProgress) => void;
	progressMinBytes?: number;
	progressMinIntervalMs?: number;
	progressNow?: () => number;
	stallTimeoutMs?: number;
	uploadBlob: UploadAttachmentBlobFn;
}

interface ResolvedAttachmentHydratorConfig {
	maxBytes: number;
	progressMinBytes: number;
	progressMinIntervalMs: number;
	progressNow: () => number;
	stallTimeoutMs: number;
}

/** Compose the size cap, stall guard, and (optional) progress observer
 *  around a downloaded attachment's content stream, in that fixed order —
 *  see `enforceTransferProgress`'s doc comment for why progress MUST wrap
 *  outside the stall guard, never inside it. Extracted from
 *  `makeAttachmentHydrator` purely to keep that closure's cognitive
 *  complexity under the repo's ceiling; behavior is unchanged. */
function composeAttachmentContentGuards(
	downloaded: AttachmentDownload,
	attachment: AttachmentRecord,
	args: AttachmentHydratorArgs,
	resolved: ResolvedAttachmentHydratorConfig,
): AsyncIterable<Buffer | Uint8Array | string> {
	const sizeGuarded = enforceMaxBytes(downloaded.content, resolved.maxBytes);
	const stallGuarded = args.onStall
		? enforceStallTimeout(sizeGuarded, resolved.stallTimeoutMs, args.onStall)
		: sizeGuarded;
	if (!args.onTransferProgress) {
		return stallGuarded;
	}
	return enforceTransferProgress(stallGuarded, {
		minBytes: resolved.progressMinBytes,
		minIntervalMs: resolved.progressMinIntervalMs,
		now: resolved.progressNow,
		onProgress: args.onTransferProgress,
		totalBytes: trustedAttachmentTotalBytes(downloaded, attachment),
	});
}

/**
 * `onStall`: called at most once if a transfer stalls past `stallTimeoutMs`.
 * MUST make the connection backing `fetchAttachment`'s returned content
 * unusable (imapflow has no per-command cancel — see `fetchAttachmentPart`),
 * so the caller is expected to treat the whole run as ending after this
 * fires. Omitted in tests that don't exercise a real IMAP connection.
 *
 * `onTransferProgress`: cadence-gated in-transfer progress (see
 * `enforceTransferProgress`). Composed OUTSIDE the stall guard: cannot
 * affect stall timing, backpressure, or error propagation. Omitted entirely
 * in tests that don't exercise it — `enforceTransferProgress` is only
 * applied when this is provided, so a caller with no progress sink pays
 * zero extra wrapping.
 */
export function makeAttachmentHydrator(
	args: AttachmentHydratorArgs,
): HydrateAttachmentFn {
	const resolved: ResolvedAttachmentHydratorConfig = {
		maxBytes: args.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
		progressMinBytes:
			args.progressMinBytes ?? DEFAULT_ATTACHMENT_PROGRESS_MIN_BYTES,
		progressMinIntervalMs:
			args.progressMinIntervalMs ?? DEFAULT_ATTACHMENT_PROGRESS_MIN_INTERVAL_MS,
		progressNow: args.progressNow ?? Date.now,
		stallTimeoutMs: args.stallTimeoutMs ?? DEFAULT_ATTACHMENT_STALL_TIMEOUT_MS,
	};
	return async (msg, attachment) => {
		if (
			typeof attachment.size_bytes === "number" &&
			attachment.size_bytes > resolved.maxBytes
		) {
			return hydrationFailureResult(
				attachment,
				"too_large",
				new AttachmentTooLargeError(attachment.size_bytes, resolved.maxBytes),
			);
		}
		let downloaded: AttachmentDownload;
		try {
			downloaded = await args.fetchAttachment(msg, attachment);
		} catch (err) {
			return hydrationFailureResult(attachment, "failed", err, {
				stage: "imap_download_failed",
			});
		}
		if (
			typeof downloaded.expectedSize === "number" &&
			downloaded.expectedSize > resolved.maxBytes
		) {
			return hydrationFailureResult(
				attachment,
				"too_large",
				new AttachmentTooLargeError(downloaded.expectedSize, resolved.maxBytes),
			);
		}
		try {
			const guarded = composeAttachmentContentGuards(
				downloaded,
				attachment,
				args,
				resolved,
			);
			const blobRef = await args.uploadBlob({
				content: guarded,
				connectorId: args.connectorId,
				mimeType: normalizeAttachmentMimeType(
					downloaded.mimeType,
					attachment.content_type,
				),
				recordKey: attachment.id,
				stream: "attachments",
			});
			return {
				failure: null,
				record: {
					...attachment,
					blob_ref: blobRef,
					content_sha256: blobRef.sha256,
					content_type: blobRef.mime_type,
					size_bytes: blobRef.size_bytes,
					hydration_status: "hydrated",
					hydration_error: null,
				},
			};
		} catch (err) {
			const originalError = originalHydrationError(err);
			if (originalError instanceof AttachmentTooLargeError) {
				return hydrationFailureResult(attachment, "too_large", originalError);
			}
			if (originalError instanceof AttachmentTransferIncompleteError) {
				return hydrationFailureResult(attachment, "failed", originalError, {
					stage: "imap_download_failed",
				});
			}
			if (originalError instanceof AttachmentStallTimeoutError) {
				// Re-thrown, not returned as an ordinary `failed` result: `onStall`
				// already closed the shared IMAP connection (imapflow has no
				// per-command cancel), so every later command in this run — the next
				// attachment, the delta pass, anything — would otherwise throw a
				// confusing "connection closed" error instead of the real cause.
				// Propagating here lets the run end cleanly through the normal
				// uncaught-rejection path (`handleMainRejection`), which classifies
				// it retryable and reports one honest reason instead of a cascade.
				throw originalError;
			}
			return hydrationFailureResult(
				attachment,
				"failed",
				err,
				hydrationFailureForBlobUpload(err),
			);
		}
	};
}

interface ImapDownloadMeta {
	contentType?: string;
	expectedSize?: number;
}

interface ImapDownloadResponse {
	content: AsyncIterable<Buffer | Uint8Array | string>;
	meta?: ImapDownloadMeta;
}

/**
 * Download one attachment PART's bytes.
 *
 * `expectedSize` is deliberately taken from BODYSTRUCTURE (`attachment.size_bytes`)
 * and NOT from the download response's `meta.expectedSize`.
 *
 * imapflow populates `meta.expectedSize` from the FETCH `RFC822.SIZE` item
 * (`lib/imap-flow.js`: `meta = { expectedSize: response.size }`, where `size`
 * is requested as the `RFC822.SIZE` atom in `lib/commands/fetch.js`).
 * RFC822.SIZE is the size of the ENTIRE MESSAGE — every part, every MIME
 * header, every boundary — not of the part being downloaded. It is the same
 * number for every part of a multipart message.
 *
 * Feeding a message-scoped size into a per-attachment cap made a message
 * reject ALL of its attachments whenever their SUM crossed the cap, even
 * though no single one came close. Observed live on the owner's mailbox:
 * 68 attachments marked `too_large` across 18 messages, of which only 2 were
 * genuinely over the 25 MiB cap; one 3,080-byte attachment was rejected as
 * "29830196 > 26214400 bytes". Two parts of one message recorded the byte-for-byte
 * identical "observed" size — impossible for real per-part sizes, and the tell
 * that the number was never the part's.
 *
 * That number is not just a wrong skip: `isProvenUnfillableGap`
 * (`server/connector-gap-classification.ts`) parses this exact
 * "exceeds max size: <observed> > <limit>" text as DURABLE PROOF that an item
 * is permanently uncollectable. A message-scoped size therefore manufactured
 * per-item impossibility proofs for items that are collectible, which is the
 * fabricated-evidence failure that predicate exists to refuse.
 *
 * BODYSTRUCTURE's per-part `size` is the only per-part size IMAP gives us
 * before transfer, so it is the only honest pre-flight number. When it is
 * absent we report `null` (unknown) rather than substituting a
 * message-scoped stand-in: `enforceMaxBytes` still counts real bytes
 * mid-stream, so an under-reported or missing size is caught by observation
 * instead of by a guess.
 */
export async function fetchAttachmentPart(
	client: Pick<ImapFlow, "download">,
	msg: FetchMessageObject,
	attachment: AttachmentRecord,
): Promise<AttachmentDownload> {
	if (!msg.uid) {
		throw new Error("attachment download requires IMAP UID");
	}
	const transfer = { incomplete: false };
	const response = (await observePartialFetches(client, transfer).download(
		String(msg.uid),
		attachment.part_index,
		{
			uid: true,
		},
	)) as ImapDownloadResponse;
	return {
		content: response.content
			? failIncompleteTransfer(response.content, transfer)
			: response.content,
		expectedSize: attachment.size_bytes,
		mimeType: normalizeAttachmentMimeType(
			response.meta?.contentType,
			attachment.content_type,
		),
	};
}

/** A part transfer lacks evidence: a requested section came back without bytes. */
export class AttachmentTransferIncompleteError extends Error {
	constructor() {
		super(
			"attachment transfer incomplete: a requested part section came back without bytes",
		);
		this.name = "AttachmentTransferIncompleteError";
	}
}

/**
 * imapflow's `download` reads a part as a series of partial FETCHes, with the
 * part's MIME header in the first one. It ends the stream at the first chunk
 * that carries no bytes, so a NIL chunk past the first one looks like the end
 * of a shorter file; and it picks the transfer decoder from the MIME header,
 * so a NIL header leaves base64 or quoted-printable bytes undecoded. A server
 * that has reached the end of a part returns an empty string instead
 * (RFC 3501 §6.4.5), and an empty header block is also a known value.
 *
 * This view of `client` runs `download` with itself as `this`, so each
 * partial answer passes through `fetchOne` here: any requested section
 * answered without bytes marks the transfer incomplete. Every other member
 * reads and writes the client itself.
 */
function observePartialFetches<T extends object>(
	client: T,
	transfer: { incomplete: boolean },
): T {
	return new Proxy(client, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop, target);
			if (prop === "fetchOne" && typeof value === "function") {
				return async (
					range: unknown,
					query: { bodyParts?: unknown[] } | undefined,
					options: unknown,
				) => {
					const answer = (await value.call(target, range, query, options)) as
						| { bodyParts?: Map<string, unknown>; headers?: unknown }
						| false
						| undefined;
					for (const request of query?.bodyParts ?? []) {
						const key =
							typeof request === "string"
								? request
								: String((request as { key?: unknown } | null)?.key);
						// imapflow files BODY[HEADER] under `headers`, not `bodyParts`.
						const section = !answer
							? undefined
							: key === "header"
								? answer.headers
								: answer.bodyParts?.get(key);
						if (!(section instanceof Uint8Array)) transfer.incomplete = true;
					}
					return answer;
				};
			}
			return typeof value === "function" && prop !== "download"
				? value.bind(target)
				: value;
		},
		set(target, prop, value) {
			return Reflect.set(target, prop, value, target);
		},
	});
}

/** Pass `content` through, then fail if its transfer was incomplete. */
async function* failIncompleteTransfer(
	content: AsyncIterable<Buffer | Uint8Array | string>,
	transfer: { readonly incomplete: boolean },
): AsyncIterable<Buffer | Uint8Array | string> {
	yield* content;
	if (transfer.incomplete) throw new AttachmentTransferIncompleteError();
}

function buildRuntimeBlobUploader(): ReferenceBlobUploadFn {
	const rsUrl = process.env.PDPP_RS_URL || process.env.RS_URL;
	const ownerToken = process.env.PDPP_OWNER_TOKEN;
	if (!(rsUrl && ownerToken)) {
		return () => Promise.reject(new Error(BLOB_UPLOAD_ENV_ERROR));
	}
	return makeSharedReferenceBlobUploader({
		connectorInstanceId: process.env.PDPP_CONNECTOR_INSTANCE_ID || null,
		ownerToken,
		rsUrl,
	});
}

export function validateAttachmentHydrationPreflight(args: {
	env?: NodeJS.ProcessEnv;
	detailGaps?: readonly DetailGapStartEntry[] | undefined;
	requested: Map<string, StreamRequest>;
}): string | null {
	const env = args.env ?? process.env;
	// Attachments in scope, or any pending attachment gap the runtime may
	// serve for recovery. Broader than the served-gap filter on purpose: a
	// missing upload config is better reported before the run than during it.
	const hydrationRequested =
		args.requested.has("attachments") ||
		(args.detailGaps ?? []).some(
			(gap) => gap.stream === "attachments" && gap.status === "pending",
		);
	if (!hydrationRequested) {
		return null;
	}
	if (!resolveGmailAddressFromEnv(env)) {
		return "Gmail attachment hydration requires GMAIL_ADDRESS or GMAIL_USER";
	}
	if (!resolveGmailPasswordFromEnv(env)) {
		return "Gmail attachment hydration requires GOOGLE_APP_PASSWORD_PDPP or GMAIL_APP_PASSWORD";
	}
	if (!sharedRuntimeBlobUploadAvailable(env)) {
		return BLOB_UPLOAD_ENV_ERROR;
	}
	return null;
}

// ─── Delta pass (flag/label changes since priorModseq) ──────────────────

/**
 * Emit flag/label changes for messages modified since `priorModseq`.
 *
 * The envelope is fetched alongside the flags. That is not an optimization —
 * it is what makes the pass safe. PDPP records are whole-document upserts
 * (`records` is keyed `UNIQUE(connector_instance_id, stream, record_key)` and
 * ingest replaces `record_json`), so emitting a partial `messages` record
 * overwrites the stored row rather than merging into it. An envelope-free
 * delta record therefore nulls `subject`, `from_email`, `date`, `size_bytes`,
 * and `snippet` on a message that had them, and sets `received_at` to the run
 * clock — silently destroying already-collected history every time a label or
 * a `\Seen` flag changes.
 *
 * A message whose envelope the server does not return is skipped rather than
 * emitted partially: losing a flag update is recoverable on the next pass,
 * losing the envelope is not.
 *
 * `fetchBodiesFn` is the same seam `processMessage` uses. Called with
 * `wantBodies: false` it fetches at most `SNIPPET_FETCH_MAX_BYTES` of the
 * plain part — enough to rebuild `snippet`, without touching the
 * externally-throttled full-body/attachment path.
 *
 * That re-fetch can itself fail (a transient IMAP error on the bounded
 * read), and UNLIKE a fetch failure in `processMessage`, this message
 * already has a stored `messages` record from an earlier run — emitting
 * ANY record here, including one with `snippet: null`, replaces that row
 * wholesale (same destructive-upsert rule as the envelope-absent case
 * above) and destroys its real snippet. So a thrown re-fetch here SKIPS the
 * emit entirely (`continue`) rather than writing anything: the stored
 * record, snippet included, is left exactly as it was. A durable retryable
 * `messages`-stream DETAIL_GAP (`buildMessageDeltaSnippetDetailGap`) records
 * the miss so it is not silently absent from the coverage story, mirroring
 * the `message_bodies` gap pattern (2026-08-23 owner decision) — though,
 * same as that gap, nothing in this connector currently consumes a served
 * gap of this kind to force a re-fetch.
 *
 * Skipping the RECORD is not enough on its own, though. The cursor moves
 * to the mailbox's CURRENT `highest_modseq`, and `changedSince` on the next
 * run only re-surfaces a message whose modseq changes AGAIN, which may never
 * happen. So every change this pass sees but cannot apply (a thrown snippet
 * re-fetch, or a FETCH missing an item `REQUIRED_FETCH_ITEMS` names) goes to
 * `owe`, which hands it to the progress ledger as `messages` retry debt. The
 * debt retry rewrites the whole row from a fresh FETCH. `skippedAnyMessage`
 * tells the caller a change was left behind; the caller holds the cursor at
 * its prior value while the ledger cannot take the change (its debt list is
 * full); see `resolveDeltaCursorAdvance`.
 *
 * The one skip that does NOT set it is `!requested.has("messages")`: that is
 * not a failure to cover a change, it's "this run was never asked to collect
 * `messages` at all," the same as `processMessage`'s own `wantMessages` gate.
 */
export async function runDeltaPass(
	client: Pick<ImapFlow, "fetch">,
	session: AllMailSession,
	requested: Map<string, StreamRequest>,
	emitRecord: EmitRecordFn,
	receivedAtFallback: string,
	fetchBodiesFn: FetchBodiesFn,
	/**
	 * Hands a change this pass could not apply to its durable owner (the
	 * progress ledger's `messages` debt), so it survives the cursor moving on.
	 */
	owe: (uid: number, failure: string) => void = () => {},
): Promise<{ skippedAnyMessage: boolean }> {
	if (
		session.fullResync ||
		session.priorModseq === undefined ||
		session.priorModseq === null
	) {
		return { skippedAnyMessage: false };
	}
	const { priorModseq } = session;
	const priorModseqBig =
		typeof priorModseq === "bigint" ? priorModseq : BigInt(priorModseq);
	gmailDiagnostic("flag_label_delta_fetch", {
		prior_modseq: String(priorModseq),
	});
	await emit({
		type: "PROGRESS",
		message: "Checking for changed labels and read/unread flags",
	});
	// `envelope`/`internalDate`/`size`/`bodyStructure` ride along with the flags
	// so the emitted record is whole. See this function's doc comment: a partial
	// record is a destructive upsert, not a cheap one. BODYSTRUCTURE is metadata
	// only — it is what `has_attachments` is derived from, and fetching it does
	// not pull attachment or body content.
	const deltaQuery: ExtendedFetchQuery = {
		uid: true,
		flags: true,
		labels: true,
		threadId: true,
		emailId: true,
		envelope: true,
		internalDate: true,
		size: true,
		bodyStructure: true,
		headers: [...MESSAGE_HEADER_FIELDS],
	};
	// Phase A: drain the delta FETCH completely before issuing any other IMAP
	// command. Phase B: fetch snippets and emit.
	//
	// The split is required, not stylistic — it is the same rule the message
	// pass states at its own Phase A/B boundary: imapflow multiplexes one
	// command at a time over a single connection, so a nested command issued
	// while the outer iterator is still open hangs that iterator. Calling
	// `fetchBodiesFn` (a `fetchOne`) inside the `for await` did exactly that.
	//
	// `fetchBodies` swallows its own errors, so the nested call surfaced not as
	// a body-fetch failure but as a wedged connection: the run stopped making
	// progress after "Fetching flag/label deltas", sat until a timeout, and
	// then tripped the runtime's post-DONE guard while the abandoned iterator
	// drained. Draining first keeps the envelope guarantee below intact and
	// costs only the metadata already held in memory.
	// Set whenever a message this pass KNOWS changed (it passed the
	// `changedSince` filter) does not get a record emitted for that change —
	// see this function's doc comment for why the caller must hold
	// `highest_modseq` back when this is true. NOT set by `!requested.has(
	// "messages")`: that message was never examined for a change to apply,
	// so there is nothing to hold the cursor back for.
	let skippedAnyMessage = false;
	const deltaMetas: FetchMessageObject[] = [];
	for await (const msg of client.fetch("1:*", deltaQuery, {
		uid: true,
		changedSince: priorModseqBig,
	})) {
		if (!requested.has("messages")) {
			continue;
		}
		if (!String(msg.emailId ?? "")) {
			continue;
		}
		// A change whose resources exclude it is not this run's to collect.
		if (resourcesExcludeMessage(requested, "messages", String(msg.emailId))) {
			continue;
		}
		// Without INTERNALDATE the change's time scope is unknown: it is owed.
		if (!fetchItemAvailable(msg, "internalDate")) {
			skippedAnyMessage = true;
			owe(msg.uid, "internaldate_unavailable");
			continue;
		}
		// Admission comes before any other failure is classified or any body
		// I/O happens: a change outside the stream's scope is not this run's
		// to collect, and it must not become debt.
		if (
			!messageInStreamScope(
				requested,
				"messages",
				String(msg.emailId),
				new Date(msg.internalDate as Date | string).toISOString(),
				requested.get("messages")?.time_range,
			)
		) {
			continue;
		}
		// An incomplete FETCH (no envelope, or no BODYSTRUCTURE, so the
		// snippet's part is unknown) has no safe whole record to write.
		// Skipping preserves the stored row; emitting would blank fields. The
		// change is owed to a later run.
		const unavailable = unavailableFetchItem(msg, "messages");
		if (unavailable) {
			skippedAnyMessage = true;
			owe(msg.uid, unavailable);
			continue;
		}
		deltaMetas.push(msg);
	}

	for (const msg of deltaMetas) {
		const gmMsgid = String(msg.emailId ?? "");
		const env = msg.envelope;
		if (!env) {
			continue;
		}
		const receivedAt = perMessageInternalDateToIso(
			msg.internalDate,
			() => receivedAtFallback,
		);
		// Bounded snippet-only body read, exactly as the forward pass does for a
		// messages-without-bodies scope. Sequential by necessity: this is one IMAP
		// command at a time on a connection that is not concurrent.
		const { snippet, fetchFailed, failureClass } = await fetchBodiesFn(
			msg,
			selectBodyParts(msg.bodyStructure, false),
			false,
			true,
		);
		if (fetchFailed) {
			// This message already has a stored `messages` record (see this
			// function's doc comment) — emitting nothing is what keeps its real
			// snippet (and every other field) intact. A genuinely bodyless
			// message is NOT this branch: `fetchFailed` is false/absent for it,
			// so it falls through to the normal emit below with `snippet: null`.
			skippedAnyMessage = true;
			owe(msg.uid, failureClass ?? "body_fetch_failed");
			await emit(buildMessageDeltaSnippetDetailGap({ failureClass, gmMsgid }));
			continue;
		}
		await emitRecord(
			"messages",
			buildMessageRecord({
				attachmentsCount: decodeBodystructureForAttachments(
					msg.bodyStructure,
					gmMsgid,
					receivedAt,
				).length,
				dateHeader: env.date ? new Date(env.date).toISOString() : null,
				envelope: env,
				flagsArr: toFlagsArray(msg.flags),
				gmMsgid,
				gmThrid: String(msg.threadId ?? ""),
				labels: toLabelsArray(msg.labels),
				rawHeaders: msg.headers,
				receivedAt,
				sizeBytes: typeof msg.size === "number" ? msg.size : null,
				snippet,
			}),
		);
	}
	return { skippedAnyMessage };
}

// ─── Threads pass ───────────────────────────────────────────────────────

/** X-GM-THRID terms per SEARCH; Gmail evaluates the OR server-side. */
const THREAD_SEARCH_BATCH = 50;
/** Member UIDs per FETCH when rebuilding threads. */
const THREAD_MEMBER_FETCH_BATCH = 500;

const THREAD_MEMBER_QUERY: ExtendedFetchQuery = {
	uid: true,
	threadId: true,
	emailId: true,
	envelope: true,
	flags: true,
	internalDate: true,
	// Needed for per-thread labels + has_attachments aggregation.
	labels: true,
	bodyStructure: true,
};

/**
 * Rebuild each named thread from its complete X-GM-THRID membership and emit
 * the rows whose fingerprint moved.
 *
 * A bounded UID page only says WHICH threads to rebuild. It never supplies a
 * thread's members: a thread that spans pages has a fragment on each one, and
 * a row built from a fragment would replace the whole conversation under the
 * same key. A member expunged between SEARCH and FETCH is simply absent.
 *
 * For the same reason a member whose FETCH items are incomplete (see
 * `REQUIRED_FETCH_ITEMS`) fails its whole thread: the row is not emitted and
 * its fingerprint is not moved. A member that comes back without X-GM-THRID
 * fails every thread whose SEARCH named it.
 *
 * This function only reads: it returns the whole-thread aggregates and each
 * failed thread with its failure class. The caller publishes the aggregates
 * outside its provider-read error handling, so a failed RECORD write fails
 * the run before STATE and never commits a fingerprint for a row that did
 * not land.
 */
export async function rebuildThreads(
	client: Pick<ImapFlow, "fetch" | "search">,
	/** The page messages whose threads to rebuild; each is a known member. */
	seeds: readonly Pick<FetchMessageObject, "uid" | "threadId">[],
): Promise<{ aggregates: ThreadAggregate[]; failed: Map<string, string> }> {
	const failed = new Map<string, string>();
	const ids = [
		...new Set(seeds.map((m) => String(m.threadId ?? "")).filter(Boolean)),
	];
	if (ids.length === 0) return { aggregates: [], failed };
	await emit({
		type: "PROGRESS",
		stream: "threads",
		message: "Deriving threads from All Mail",
	});
	// The seeds are members we already hold; SEARCH adds the members outside
	// this page. A seed is never dropped because SEARCH did not echo it.
	// `namedBy` keeps which threads named each member UID.
	const namedBy = new Map<number, Set<string>>();
	const name = (uid: number, tids: readonly string[]) => {
		const known = namedBy.get(uid) ?? new Set<string>();
		for (const tid of tids) known.add(tid);
		namedBy.set(uid, known);
	};
	for (const m of seeds) {
		if (m.threadId) name(m.uid, [String(m.threadId)]);
	}
	for (let i = 0; i < ids.length; i += THREAD_SEARCH_BATCH) {
		const batch = ids.slice(i, i + THREAD_SEARCH_BATCH);
		const query =
			batch.length === 1
				? { threadId: batch[0] }
				: { or: batch.map((threadId) => ({ threadId })) };
		const uids = await client.search(query, { uid: true });
		for (const uid of uids || []) name(uid, batch);
	}
	const wanted = new Set(ids);
	const aggregates = new Map<string, ThreadAggregate>();
	const sorted = [...namedBy.keys()].sort((a, b) => a - b);
	for (let i = 0; i < sorted.length; i += THREAD_MEMBER_FETCH_BATCH) {
		const range = sorted.slice(i, i + THREAD_MEMBER_FETCH_BATCH).join(",");
		for await (const msg of client.fetch(range, THREAD_MEMBER_QUERY, {
			uid: true,
		})) {
			const tid = String(msg.threadId ?? "");
			const unavailable = unavailableFetchItem(msg, "threads");
			if (!tid) {
				for (const named of namedBy.get(msg.uid) ?? []) {
					failed.set(named, unavailable ?? "threadid_unavailable");
				}
				continue;
			}
			if (!wanted.has(tid)) continue;
			if (unavailable) {
				failed.set(tid, unavailable);
				continue;
			}
			const env = msg.envelope ?? {};
			const rcv = internalDateToIso(msg.internalDate);
			const msgHasAttachments =
				decodeBodystructureForAttachments(
					msg.bodyStructure,
					String(msg.emailId ?? tid),
					rcv,
				).length > 0;
			aggregates.set(
				tid,
				updateThreadAggregate(aggregates.get(tid), {
					flagsArr: toFlagsArray(msg.flags),
					hasAttachments: msgHasAttachments,
					labels: toLabelsArray(msg.labels),
					participants: envelopeParticipants(env),
					receivedAt: rcv,
					subject: env.subject || null,
					threadId: tid,
				}),
			);
		}
	}
	return {
		aggregates: [...aggregates]
			.filter(([tid]) => !failed.has(tid))
			.map(([, agg]) => agg),
		failed,
	};
}

/**
 * Gate every aggregated thread through the shared fingerprint cursor and
 * emit only the records whose semantic shape moved since the prior run.
 * Every aggregate passed in is a whole thread (see `rebuildThreads`). The
 * caller deliberately does not prune stale fingerprints on bounded pages;
 * pruning is only sound after the historical high-water boundary is complete.
 *
 * Exported so the two-pass churn invariant can be exercised without
 * standing up an IMAP fixture.
 */
export async function emitChangedThreads(
	aggregates: Iterable<ThreadAggregate>,
	cursor: FingerprintCursor,
	emitRecord: EmitRecordFn,
): Promise<void> {
	for (const agg of aggregates) {
		const record = buildThreadRecord(agg);
		if (!cursor.shouldEmit(record)) {
			continue;
		}
		await emitRecord("threads", record);
	}
}

/**
 * Parse the prior `threads` STATE cursor's `thread_fingerprints` map.
 * Tolerant of:
 *   - missing/legacy cursors (no fingerprints field)
 *   - malformed entries (non-string values silently dropped)
 *   - state from a different schema (best-effort coercion)
 * The returned map is always safe to read; on legacy input it is empty
 * and the next run re-emits every thread once (the normal one-time
 * cost of the cursor's introduction).
 */
export function readPriorThreadFingerprints(
	state: Record<string, unknown>,
): Map<string, string> {
	const out = new Map<string, string>();
	const streamState = state.threads;
	if (
		!streamState ||
		typeof streamState !== "object" ||
		Array.isArray(streamState)
	) {
		return out;
	}
	const raw = (streamState as PriorThreadsState).thread_fingerprints;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return out;
	}
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === "string" && value.length > 0) {
			out.set(id, value);
		}
	}
	return out;
}

// ─── All Mail orchestration (inside the mailbox lock) ───────────────────

interface AllMailDeps {
	detailGaps?: readonly DetailGapStartEntry[] | undefined;
	emitRecord: EmitRecordFn;
	emittedAt: string;
	recoveryOnly?: boolean;
	requested: Map<string, StreamRequest>;
	/** Test seam; production uploads through the runtime blob endpoint. */
	uploadBodyBlob?: UploadBodyBlobFn;
}

// `mailbox` + `close` on top of the attachment-backfill client's
// `search`/`fetchOne`/`fetch`, plus `download` for attachment part fetches.
// `getMailboxLock` is deliberately excluded: `main()` acquires the lock
// before calling into this function, so this function never needs it.
type GmailAllMailClient = GmailAttachmentBackfillClient &
	Pick<ImapFlow, "close" | "download" | "mailbox"> &
	Partial<Pick<ImapFlow, "usable">>;

/** Ledger streams in a run's scope, in ledger order. */
function requestedLedgerStreams(
	requested: ReadonlyMap<string, StreamRequest>,
): Set<LedgerStream> {
	return new Set(LEDGER_STREAMS.filter((s) => requested.has(s)));
}

/** Open the progress ledger from prior STATE and this run's SELECT. */
function openProgressLedger(
	state: Record<string, unknown>,
	session: AllMailSession,
	uidnext: number,
	requested: ReadonlyMap<string, StreamRequest>,
	timeRanges: Partial<Record<LedgerStream, TimeBand | undefined>>,
): GmailProgressLedger {
	const messagesState = (state.messages ?? {}) as PriorMessagesState & {
		progress?: unknown;
	};
	const attachmentsBackfill = session.attachmentBackfill;
	return new GmailProgressLedger({
		persisted: messagesState.progress,
		legacy: {
			forwardUidnext: session.priorUidnext,
			messagesBackfillThrough: session.messagesBackfill.backfilled_through_uid,
			// Only a same-epoch attachments cursor is attachment evidence.
			attachmentsBackfillThrough:
				attachmentsBackfill.uidvalidity === session.uidvalidityNum
					? attachmentsBackfill.backfilled_through_uid
					: undefined,
		},
		fullResync: session.fullResync,
		uidvalidity: session.uidvalidityNum,
		uidnext,
		requested: requestedLedgerStreams(requested),
		windowUids: resolveMessagesBackfillWindowUids(),
		timeRanges,
	});
}

const DAY_MS = 86_400_000;

/**
 * IMAP SEARCH for a catch-up band. SINCE/BEFORE are day-granular and use the
 * server's day, so the query is widened by a day on each side; processing
 * applies the exact band.
 */
function catchupSearchQuery(owed: TimeBand): {
	since?: string;
	before?: string;
} {
	const shift = (iso: string, days: number) =>
		isoToImapDate(new Date(Date.parse(iso) + days * DAY_MS).toISOString());
	const since = owed.since ? shift(owed.since, -1) : null;
	const before = owed.until ? shift(owed.until, 2) : null;
	return {
		...(since ? { since } : {}),
		...(before ? { before } : {}),
	};
}

/** Fetch one lane's metadata, or nothing when the ledger planned no lane. */
async function collectLaneMetadata(
	client: Pick<ImapFlow, "fetch" | "search">,
	range: string | null,
	sinceDate: string | null,
	sinceIso: string | null,
): Promise<FetchMessageObject[]> {
	return range ? collectMetadata(client, range, sinceDate, sinceIso) : [];
}

/**
 * Drive the threads pass, the message pass, served attachment recovery, the
 * flag/label delta pass, and the final STATE — all inside the mailbox lock.
 * The list-mailbox lookup happens in `main()` before entering here.
 *
 * `GmailProgressLedger` decides every range, cursor, coverage count,
 * continuation and completeness claim. This function only performs the I/O
 * the ledger names and reports one outcome per (UID, stream) back to it.
 */
export async function runAllMailPasses(
	client: GmailAllMailClient,
	allMail: ListResponse,
	state: Record<string, unknown>,
	deps: AllMailDeps,
): Promise<void> {
	const { mailbox } = client;
	if (!mailbox) {
		fail("mailbox not selected after lock");
		return;
	}
	const session = deriveAllMailSession(mailbox, state);
	if (!session) {
		fail("missing UIDVALIDITY on All Mail mailbox");
		return;
	}
	if (session.uidnext === undefined) {
		fail("missing UIDNEXT on All Mail mailbox");
		return;
	}

	// Each stream applies its own time_range. Threads apply none: a thread row
	// is rebuilt from every member.
	const ledgerStreams = [...requestedLedgerStreams(deps.requested)];
	const timeRanges = Object.fromEntries(
		ledgerStreams.map((s) => [
			s,
			s === "threads" ? undefined : deps.requested.get(s)?.time_range,
		]),
	) as Partial<Record<LedgerStream, TimeBand | undefined>>;
	// The metadata pre-filter keeps every UID any requested stream may want:
	// the IMAP-date form of the loosest `since` for the day-granular SEARCH,
	// and the exact ISO for the post-filter. Each stream's own bound is
	// applied per message (`ledger.timeRangeFor`).
	const prefilterSince =
		ledgerStreams.length === 0
			? undefined
			: loosestSince(ledgerStreams.map((s) => timeRanges[s] ?? {}));
	const sinceDate = prefilterSince ? isoToImapDate(prefilterSince) : null;
	const sinceIso = prefilterSince ?? null;
	const servedAttachmentRecoveryRequested =
		servedAttachmentDetailGaps(deps.detailGaps).length > 0;
	const fetchBodiesBound: FetchBodiesFn = (
		msg,
		selection,
		wantBodies,
		wantMessages,
	) => fetchBodies(client, msg, selection, wantBodies, wantMessages);
	const hydrateAttachment = makeAttachmentHydrator({
		connectorId: process.env.PDPP_CONNECTOR_ID || DEFAULT_GMAIL_CONNECTOR_ID,
		fetchAttachment: (msg, attachment) =>
			fetchAttachmentPart(client, msg, attachment),
		maxBytes: resolveMaxAttachmentBytes(),
		// imapflow has no per-command cancel (see `AttachmentStallTimeoutError`
		// doc comment): the only way to unblock a stalled FETCH is to close the
		// whole connection. That's a whole-run failure, not a per-attachment one
		// — but it's a RETRYABLE one (message contains "timeout", matched by
		// `isImapTransientError` in `handleMainRejection`), and every record this
		// run already emitted (labels/threads/prior attachments) is durable, and
		// the messages STATE cursor only commits at the very end of
		// `runAllMailPasses` — so the next run resumes cleanly rather than
		// silently poisoning a completed stream.
		onStall: () => client.close(),
		stallTimeoutMs: resolveAttachmentStallTimeoutMs(),
		// Fire-and-forget by construction (`enforceTransferProgress` calls this
		// synchronously and never awaits it) — a slow or failed PROGRESS emit can
		// never add latency to the transfer or turn it into a failure. `.catch()`
		// only prevents an unhandled-rejection crash; it changes nothing about
		// whether the attachment itself succeeds.
		onTransferProgress: (progress) => {
			gmailDiagnostic("attachment_transfer", {
				phase: progress.phase,
				bytes_transferred: progress.bytesTransferred,
				total_bytes: progress.totalBytes,
				elapsed_ms: progress.elapsedMs,
			});
			emit({
				type: "PROGRESS",
				stream: "attachments",
				message: buildAttachmentTransferProgressMessage(progress),
			}).catch((): undefined => undefined);
		},
		progressMinBytes: resolveAttachmentProgressMinBytes(),
		progressMinIntervalMs: resolveAttachmentProgressMinIntervalMs(),
		uploadBlob: buildRuntimeBlobUploader(),
	});
	// One attachments detail-coverage accumulator for every attachment this run
	// attempts (walk and served recovery), so a single DETAIL_COVERAGE reports
	// considered-vs-hydrated for all of them.
	const wantsAttachments =
		deps.requested.has("attachments") || servedAttachmentRecoveryRequested;
	const attachmentCoverage = wantsAttachments
		? makeAttachmentDetailCoverage()
		: undefined;
	const recoveredAttachmentGapIds = new Set<string>();
	const recoverServed = () =>
		recoverServedAttachmentGapsIfRequested(client, {
			attachmentCoverage,
			detailGaps: deps.detailGaps,
			emitProtocol: emit,
			emitRecord: deps.emitRecord,
			hydrateAttachment,
			requested: deps.requested,
			recoveredAttachmentGapIds,
		});

	if (deps.recoveryOnly === true) {
		if (servedAttachmentRecoveryRequested) {
			await recoverServed();
			// Recovery-only mode touches exactly the served gaps it was handed and
			// returns before the ordinary Gmail walk, so it never establishes a
			// mailbox boundary — its counts describe a retry list, not an inventory.
			// It still emits its DETAIL_GAPs below; only the coverage CLAIM is
			// withheld.
			await emitAttachmentDetailCoverage(attachmentCoverage, false);
			await emitAttachmentDetailGaps(attachmentCoverage);
		}
		return;
	}

	const ledger = openProgressLedger(
		state,
		session,
		session.uidnext,
		deps.requested,
		timeRanges,
	);
	if (ledger.resetReason) {
		gmailDiagnostic("progress_ledger_reset", { reason: ledger.resetReason });
	}
	// Each unfinished stream has its own history page; fetch their union.
	const historicalRanges = ledger.historicalRanges;
	let historicalMetas = await collectLaneMetadata(
		client,
		historicalRanges.length > 0
			? historicalRanges.map((r) => `${r.start}:${r.end}`).join(",")
			: null,
		sinceDate,
		sinceIso,
	);
	// An attachments page that no other stream's page overlaps is sized by
	// attachment bytes, not UIDs; an overlapped page keeps the UID window.
	// Served recovery shares this run's attachment bytes: the page gets half
	// its budget while gaps are served, and still admits at least one UID, so
	// recovery can never starve it.
	const attachmentsPage = ledger.historicalPage("attachments");
	const attachmentsPageAlone =
		attachmentsPage !== null &&
		ledger.historicalStreams.every((stream) => {
			const other = ledger.historicalPage(stream);
			return (
				stream === "attachments" ||
				other === null ||
				other.end < attachmentsPage.start ||
				other.start > attachmentsPage.end
			);
		});
	if (attachmentsPage && attachmentsPageAlone) {
		const inPage = (m: FetchMessageObject) =>
			m.uid >= attachmentsPage.start && m.uid <= attachmentsPage.end;
		const pageMetas = historicalMetas.filter(inPage);
		const budget = resolveAttachmentBackfillPageByteBudget();
		const plan = planAttachmentBackfillPage(
			pageMetas,
			servedAttachmentRecoveryRequested
				? Math.max(1, Math.floor(budget / 2))
				: budget,
			attachmentsPage.end,
		);
		if (plan.backfillMetas.length < pageMetas.length) {
			ledger.limitHistorical("attachments", plan.backfillWindowEndUid);
			historicalMetas = historicalMetas.filter(
				(m) => !inPage(m) || m.uid <= plan.backfillWindowEndUid,
			);
		}
	}
	const forward = ledger.forward;
	const forwardMetas = await collectLaneMetadata(
		client,
		forward ? `${forward.start}:${forward.end}` : null,
		sinceDate,
		sinceIso,
	);
	// A widened time range: find the covered UIDs in each owed band. The
	// plan is final before the first outcome (absent debt) is recorded.
	for (const { key, band } of ledger.catchupSearches) {
		const searched = await client.search(catchupSearchQuery(band), {
			uid: true,
		});
		ledger.planCatchup(key, searched || []);
	}
	const debtUids = ledger.debtUids;
	const debtMetas = await collectLaneMetadata(
		client,
		debtUids.length > 0 ? debtUids.join(",") : null,
		sinceDate,
		sinceIso,
	);
	ledger.recordAbsentDebt(new Set(debtMetas.map((m) => m.uid)));
	const catchupUids = ledger.catchupUids;
	const catchupMetas = await collectLaneMetadata(
		client,
		catchupUids.length > 0 ? catchupUids.join(",") : null,
		null,
		null,
	);
	const byUid = new Map<number, FetchMessageObject>();
	for (const m of [
		...historicalMetas,
		...forwardMetas,
		...debtMetas,
		...catchupMetas,
	]) {
		if (ledger.expect(m.uid).length > 0) byUid.set(m.uid, m);
	}
	const metas = [...byUid.values()].sort((a, b) => a.uid - b.uid);

	const pages = ledger.historicalRanges;
	gmailDiagnostic("message_fetch_range", {
		historical:
			pages.length > 0
				? pages.map((r) => `${r.start}:${r.end}`).join(",")
				: null,
		forward: forward ? `${forward.start}:${forward.end}` : null,
		debt_uids: debtUids.length,
		catchup_uids: catchupUids.length,
		mailbox: allMail.path,
	});
	let fetchProgressMessage = "No new messages to fetch";
	if (pages.length > 0) {
		fetchProgressMessage = "Fetching older messages";
	} else if (forward) {
		fetchProgressMessage = "Fetching new messages";
	}
	await emit({ type: "PROGRESS", message: fetchProgressMessage });
	await emit({
		type: "PROGRESS",
		stream: "messages",
		message: `Collected ${metas.length} headers; beginning body pass`,
	});
	await emitAllMailInventoryDisclosure(emit, session, ledger.position);

	// THREADS first (parent-first convention, Tranche C 2026-04-23), so
	// downstream consumers get the parent record before its messages.
	if (deps.requested.has("threads")) {
		// Per-thread fingerprint cursor via the shared helper. The prior STATE
		// shape (`state.threads.thread_fingerprints`) predates the helper's
		// default `fingerprints` key, so the prior map is decoded by the
		// gmail-local reader and handed in via `priorFingerprints`.
		const threadCursor = openFingerprintCursor(state, {
			priorFingerprints: readPriorThreadFingerprints(state),
		});
		const threadMetas = metas.filter((m) =>
			ledger.expect(m.uid).includes("threads"),
		);
		// Only provider reads become retry debt. Publication runs outside this
		// catch: a RECORD write that throws fails the run before STATE, so the
		// fingerprint `emitChangedThreads` records for it is never committed.
		let threadFailure: string | null = null;
		let failedThreads = new Map<string, string>();
		let aggregates: ThreadAggregate[] = [];
		try {
			({ aggregates, failed: failedThreads } = await rebuildThreads(
				client,
				threadMetas,
			));
		} catch (error) {
			if (client.usable === false) throw error;
			threadFailure = messageFailureClass(error);
		}
		await emitChangedThreads(aggregates, threadCursor, deps.emitRecord);
		for (const m of threadMetas) {
			const failure = !m.threadId
				? "threadid_unavailable"
				: (threadFailure ?? failedThreads.get(String(m.threadId)) ?? null);
			ledger.record(
				m.uid,
				["threads"],
				failure ? { kind: "failed", failure } : { kind: "covered" },
			);
		}
		// The threads STATE carries only the next-run fingerprint map; thread
		// PROGRESS lives in the ledger with every other stream.
		await emit({
			type: "STATE",
			stream: "threads",
			cursor: {
				fetched_at: nowIso(),
				thread_fingerprints: threadCursor.toState(),
			},
		});
	}

	const perMessageDeps: PerMessageDeps = {
		...(attachmentCoverage ? { attachmentCoverage } : {}),
		// The walk recovers a served gap it hydrates, so served recovery below
		// does not download the same part again.
		detailGaps: deps.detailGaps,
		connectionUsable: () => client.usable !== false,
		emitProtocol: emit,
		emitProgress: (m) => emit(m),
		emitRecord: deps.emitRecord,
		fetchBodies: fetchBodiesBound,
		hydrateAttachment,
		recoveredAttachmentGapIds,
		nowIso,
		uploadBodyBlob: deps.uploadBodyBlob ?? buildRuntimeBlobUploader(),
		requested: deps.requested,
		// Set per stream group below from `ledger.timeRangeFor`.
		timeRange: undefined,
		wantBodies: false,
		wantMessages: false,
	};
	// Operator-facing tally of the attachment records this run emitted.
	const attachmentSummary = createAttachmentBackfillSummary();
	const emitRecordWithSummary: EmitRecordFn = async (
		stream,
		data,
		keyField,
	): Promise<boolean> => {
		const emitted = (await deps.emitRecord(stream, data, keyField)) !== false;
		if (stream === "attachments" && emitted) {
			addAttachmentBackfillRecordToSummary(attachmentSummary, data);
		}
		return emitted;
	};
	let processed = 0;
	for (const msg of metas) {
		const streams = ledger
			.expect(msg.uid)
			.filter((s): s is MessageStream => s !== "threads");
		if (streams.length === 0) continue;
		// A catch-up stream applies its owed band; every other stream applies
		// the run's range. One settle per distinct range.
		const groups = new Map<
			string,
			{ range: TimeBand; streams: MessageStream[] }
		>();
		for (const stream of streams) {
			const range = ledger.timeRangeFor(msg.uid, stream);
			const key = JSON.stringify(range);
			const group = groups.get(key) ?? { range, streams: [] };
			group.streams.push(stream);
			groups.set(key, group);
		}
		const outcome: MessageOutcome = {};
		for (const group of groups.values()) {
			Object.assign(
				outcome,
				await settleMessage(
					{
						...perMessageDeps,
						requested: new Map(
							[...deps.requested].filter(
								([name]) =>
									!isLedgerStreamName(name) ||
									(name !== "threads" &&
										group.streams.includes(name as MessageStream)),
							),
						),
						emitRecord: emitRecordWithSummary,
						timeRange: group.range,
						wantBodies: group.streams.includes("message_bodies"),
						wantMessages: group.streams.includes("messages"),
					},
					msg,
				),
			);
		}
		for (const s of streams) {
			ledger.record(
				msg.uid,
				[s],
				outcome[s] ?? { kind: "failed", failure: "outcome_missing" },
			);
		}
		if (
			Object.values(outcome).some(
				(o) => o.kind === "terminal" && o.reason === "missing_message_id",
			)
		) {
			await emitUnrepresentableMessageSkip(msg.uid);
		}
		processed += 1;
		if (processed % FETCH_MSG_PROGRESS === 0) {
			await emit({
				type: "PROGRESS",
				stream: "messages",
				message: `Fetched ${processed} messages`,
				count: processed,
				total: metas.length,
			});
		}
	}
	// `message_bodies` deliberately emits NO DETAIL_COVERAGE. The manifest
	// declares it `state_stream: messages`, i.e. a static single-parent detail
	// stream, and such a stream's checkpoint status is projected from the
	// declared parent's own commit outcome — the runtime rejects the run
	// outright if it emits coverage of its own
	// (`validateDetailCoverageAgainstManifest`).

	if (ledger.historicalStreams.includes("attachments")) {
		// Only hydrated parts write records, so the emit tally sees only those.
		// Failed and unhydrated (too_large, deferred) parts come from coverage.
		const failed = attachmentCoverage?.failedRecords.length ?? 0;
		const unhydrated = attachmentCoverage
			? attachmentCoverage.requiredKeys.length -
				attachmentCoverage.hydratedKeys.length -
				attachmentCoverage.gapKeys.length -
				attachmentCoverage.unlocatedKeys.length
			: 0;
		attachmentSummary.failed += failed;
		attachmentSummary.too_large += unhydrated;
		attachmentSummary.remaining_historical_gaps += failed + unhydrated;
		gmailDiagnostic("attachment_backfill_summary", { ...attachmentSummary });
		await emit({
			type: "PROGRESS",
			stream: "attachments",
			message: attachmentBackfillProgressMessage(attachmentSummary),
			count: attachmentSummary.hydrated,
			total:
				attachmentSummary.hydrated +
				attachmentSummary.too_large +
				attachmentSummary.failed +
				attachmentSummary.unavailable_skipped,
		});
	}

	if (servedAttachmentRecoveryRequested) {
		await recoverServed();
	}

	// Pass 2: detect flag/label changes on already-seen messages (incremental only)
	const { skippedAnyMessage: deltaPassSkippedAnyMessage } = await runDeltaPass(
		client,
		session,
		deps.requested,
		deps.emitRecord,
		deps.emittedAt,
		fetchBodiesBound,
		(uid, failure) => ledger.oweChange(uid, "messages", failure),
	);

	const commit = ledger.commit(nowIso());
	if (commit.unaccounted.length > 0) {
		gmailDiagnostic("progress_debt_full", {
			held_uids: commit.unaccounted.length,
			max_debt: MAX_RETRY_DEBT,
		});
	}

	// Records, then DETAIL_COVERAGE, then STATE — the order the
	// progress-evidence contract expects. The attachments claim is made only
	// when every attachment in All Mail has been enumerated, none is owed, and
	// no key from this run is left without an outcome or a retry locator.
	await emitAttachmentDetailCoverage(
		attachmentCoverage,
		commit.attachmentsInventoryComplete &&
			attachmentCoverage !== undefined &&
			attachmentCoverageFullyCredited(attachmentCoverage),
	);
	// One matching DETAIL_GAP per failed attachment, so the commit-gate can
	// credit each gap_keys entry against a durable pending gap.
	await emitAttachmentDetailGaps(attachmentCoverage);

	await emitPageEvidence(commit, "threads", "threads");
	if (commit.compatStream && commit.compatStream !== "threads") {
		await emitPageEvidence(commit, commit.compatStream, "messages");
	}

	// Advancing to the mailbox's CURRENT highestModseq is only correct when
	// every change since `priorModseq` was applied or is owed by the ledger.
	// A change the ledger could not take (its debt is full) holds the cursor
	// (`resolveDeltaCursorAdvance`).
	const { highestModseq: nextHighestModseq, holdbackRuns: nextHoldbackRuns } =
		resolveDeltaCursorAdvance({
			liveHighestModseq: session.highestModseqCursor ?? null,
			priorHoldbackRuns: session.priorDeltaHoldbackRuns,
			priorModseq: session.priorModseq,
			skippedAnyMessage: deltaPassSkippedAnyMessage && !commit.changesOwed,
		});
	await emit({
		type: "STATE",
		stream: "messages",
		cursor: {
			all_mail: {
				uidvalidity: session.uidvalidityNum,
				uidnext: commit.compat.uidnext,
				forward_uidnext: commit.compat.forward_uidnext,
				highest_modseq: nextHighestModseq,
				delta_holdback_runs: nextHoldbackRuns,
				// The mailbox's current EXISTS: an inventory count, not a cursor.
				exists: session.existsTotal,
			},
			backfill: commit.compat.backfill,
			progress: commit.state,
		},
	});
}

/** Make a terminal, unrepresentable UID visible; it is never retried. */
async function emitUnrepresentableMessageSkip(uid: number): Promise<void> {
	await emit({
		type: "SKIP_RESULT",
		stream: "messages",
		reason: "historical_message_unaccounted",
		message:
			"A Gmail message could not be represented; the UID was recorded as a terminal gap.",
		diagnostics: { uid },
	});
}

function isLedgerStreamName(name: string): name is LedgerStream {
	return (LEDGER_STREAMS as readonly string[]).includes(name);
}

/**
 * Emit one stream's bounded-page evidence: its DETAIL_COVERAGE and, while
 * history remains, the continuation that binds to the same two numbers. The
 * runtime accepts a bounded page only when the continuation's counts are
 * identical to the coverage fact's, so both read one ledger value.
 */
async function emitPageEvidence(
	commit: LedgerCommit,
	ledgerStream: LedgerStream,
	stream: "messages" | "threads",
): Promise<void> {
	const page = commit.historyPage[ledgerStream];
	const counts = commit.coverage[ledgerStream];
	if (!(page && counts)) return;
	await emit(
		buildDetailCoverageMessage({
			considered: counts.considered,
			covered: counts.covered,
			hydratedKeys: [],
			requiredKeys: [],
			stateStream: stream,
			stream,
		}),
	);
	if (commit.continuation[ledgerStream]) {
		await emitHistoricalContinuationSkip(emit, stream, {
			boundary: String(commit.state.uidvalidity),
			considered: counts.considered,
			covered: counts.covered,
			slice_start: page.start,
			slice_end: page.end,
		});
	}
}

// ─── emitRecord factory ─────────────────────────────────────────────────

export function makeEmitRecord(
	resFilters: Map<string, Set<string> | null>,
	emittedAt: string,
	incTotal: () => void,
	write: (msg: EmittedMessage) => Promise<void> = emit,
): EmitRecordFn {
	return async (
		stream: string,
		data: Record<string, unknown>,
		keyField: "id" | "name" = "id",
	): Promise<boolean> => {
		const keyCandidate = data[keyField] ?? data.name;
		if (keyCandidate == null) {
			return false;
		}
		const canonical = String(keyCandidate);
		const resSet = resFilters.get(stream);
		if (resSet && !resSet.has(canonical)) {
			return false;
		}

		// Validate record against schema.
		const validation = validateRecord(stream, data);
		if (!validation.ok) {
			await write({
				type: "SKIP_RESULT",
				stream,
				reason: "schema_validation_failed",
				message: `${stream} ${canonical}: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
				diagnostics: { issues: validation.issues },
			});
			return false;
		}

		await write({
			type: "RECORD",
			stream,
			key: canonical,
			data: validation.data,
			emitted_at: emittedAt,
		});
		incTotal();
		return true;
	};
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const startMsg = await readStartMessage(getReadline());
	if (startMsg.type !== "START") {
		fail("Expected START");
		return;
	}

	const password = await resolvePassword();
	if (!password) {
		// resolvePassword already calls fail() on error path; the early-fail
		// exits the process, so reaching here means the prompt returned null.
		fail("no Gmail app password provided");
		return;
	}

	const address = await resolveAddress();
	if (!address) {
		fail("no Gmail address provided");
		return;
	}

	const requested = new Map<string, StreamRequest>(
		(startMsg.scope?.streams || []).map((s) => [s.name, s]),
	);
	if (!requested.size) {
		fail("START.scope.streams is required");
		return;
	}
	const recoveryOnly = startMsg.recovery_only === true;
	const preflightError = validateAttachmentHydrationPreflight({
		detailGaps: startMsg.detail_gaps,
		requested,
	});
	if (preflightError) {
		fail(preflightError);
		return;
	}

	const resFilters = new Map<string, Set<string> | null>();
	for (const [n, r] of requested) {
		resFilters.set(n, resourceSet(r));
	}

	const state: Record<string, unknown> = startMsg.state ?? {};
	const emittedAt = nowIso();
	let totalEmitted = 0;
	const emitRecord = makeEmitRecord(resFilters, emittedAt, () => {
		totalEmitted += 1;
	});

	const client = new ImapFlow({
		host: "imap.gmail.com",
		port: 993,
		secure: true,
		auth: { user: address, pass: password },
		logger: false,
	});

	await client.connect();

	try {
		await emit({
			type: "PROGRESS",
			message: `Connected to ${redactEmailForProgress(address)}`,
		});

		if (requested.has("labels") && !recoveryOnly) {
			await emitLabelsStream(client, emitRecord, state);
		}

		const allMail = await findAllMailbox(client);
		if (!allMail) {
			fail("could not find [Gmail]/All Mail mailbox; is this a Gmail account?");
			return;
		}

		const lock = await client.getMailboxLock(allMail.path);
		try {
			await runAllMailPasses(client, allMail, state, {
				emitRecord,
				emittedAt,
				detailGaps: startMsg.detail_gaps,
				recoveryOnly,
				requested,
			});
		} finally {
			lock.release();
		}
	} finally {
		await client.logout().catch((): undefined => undefined);
	}

	await emit({
		type: "DONE",
		status: "succeeded",
		records_emitted: totalEmitted,
	});
	flushAndExit(0);
}

// Named (not inline) so its own internal `emit(...).catch(...)` isn't a
// promise chain nested inside another chain's callback.
function handleMainRejection(e: unknown): void {
	// imapflow raises a bare `new Error("Command failed")` for EVERY IMAP NO/BAD
	// response and puts the server's actual explanation on side fields. Reading
	// `.message` alone made a revoked app password, a rate limit, and IMAP being
	// disabled all arrive as the same contentless string. This path emits DONE
	// directly, so it has to do that extraction itself rather than inheriting the
	// runtime's.
	const msg = describeUnexpectedFailure(e);
	const retryable = isImapTransientError(e);
	const trace = e instanceof Error ? (e.stack ?? msg) : msg;
	process.stderr.write(`[gmail] main rejected: ${trace}\n`);
	emit({
		type: "DONE",
		status: "failed",
		records_emitted: 0,
		error: { message: msg, retryable },
	}).catch((): undefined => undefined);
	flushAndExit(1);
}

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime
// (process-level handlers, stdin reader, IMAP connect) and block the
// Node event loop. Only fires when this module IS the process entry
// point (i.e. `tsx connectors/gmail/index.ts`).
if (isMainModule(import.meta.url)) {
	process.on("unhandledRejection", (reason: unknown) => {
		const msg =
			reason instanceof Error
				? (reason.stack ?? reason.message)
				: String(reason);
		process.stderr.write(`[gmail] unhandledRejection: ${msg}\n`);
		const summary = reason instanceof Error ? reason.message : String(reason);
		emit({
			type: "DONE",
			status: "failed",
			records_emitted: 0,
			error: {
				message: `unhandledRejection: ${summary.slice(0, ERROR_MSG_TAIL)}`,
				retryable: false,
			},
		}).catch((): undefined => undefined);
		flushAndExit(1);
	});
	process.on("uncaughtException", (err: Error) => {
		const msg = err.stack ?? err.message;
		process.stderr.write(`[gmail] uncaughtException: ${msg}\n`);
		emit({
			type: "DONE",
			status: "failed",
			records_emitted: 0,
			error: {
				message: `uncaughtException: ${err.message.slice(0, ERROR_MSG_TAIL)}`,
				retryable: false,
			},
		}).catch((): undefined => undefined);
		flushAndExit(1);
	});

	main().catch(handleMainRejection);
}
