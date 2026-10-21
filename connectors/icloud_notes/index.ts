#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP iCloud Notes Connector (manifest v0.1.28)
 *
 * Greenfield PDPP Collection Profile connector, ported from the legacy CG
 * script `connectors/apple/icloud-notes-playwright.js` (read-only prior
 * art; not built from it). Collects via a logged-in browser session against
 * Apple's own CloudKit web service — the same backend the icloud.com Notes
 * web app itself calls.
 *
 * Streams:
 *   profile   — singleton signed-in account, keyed by validate dsInfo.dsid;
 *               optional user_name comes directly from dsInfo.fullName.
 *   notes     — CloudKit `com.apple.notes` private-zone Note records,
 *               queried via the `recents` search index, paginated by
 *               `continuationMarker`.
 *   folders   — CloudKit Folder records, queried via the `parentless`
 *               search index (CloudKit's synthetic "top of the folder
 *               tree" index; matches the legacy script's query).
 *
 * Auth: SESSION-FIRST, NEVER CREDENTIAL-DRIVEN, NO `auth` BLOCK.
 * `src/auto-login/icloud.ts`'s `probeICloudSession` is wired as
 * `runConnector`'s `probeSession` hook — it only checks whether the seeded
 * browser profile already carries a live iCloud session. The runtime's
 * `establishSession` (src/session-establish.ts) owns everything else
 * generically for any `probeSession`-based connector: a live probe
 * proceeds straight to `collect()` with no credential resolution of any
 * kind; a dead probe hands the page to the owner via a `manual_action`
 * INTERACTION and re-probes once. This connector never fills an Apple ID
 * or password field and never drives a 2FA/OTP field — Apple ID sign-in
 * and any two-factor challenge are always owner-mediated, and there is
 * nothing here for a declared `auth` block to do, so none is declared: a
 * missing session is not a missing-credential state, and nothing here ever
 * raises a `credentials` prompt. See that module's header for the full
 * rationale.
 *
 * CloudKit query surface: credentialed cross-origin `page.evaluate(fetch(...))` calls
 * against `${ckBaseUrl}/database/1/com.apple.notes/production/private/
 * records/query?dsid=${dsid}`, exactly as the legacy script did — this is a
 * cookie-authenticated call and must run from the page's own JS context.
 *
 * Cursor strategy: CloudKit's `records/query` surface (as used here) takes
 * no incremental "since" filter — the `recents`/`parentless` search
 * indexes return full result sets each call, paginated only by
 * `continuationMarker` within one run. There is no native incremental
 * cursor to persist. Both streams therefore use `openFingerprintCursor`
 * (docs/connector-authoring-guide.md §6, "re-derive-everything-each-run"
 * pattern): every run re-queries the full set, and the fingerprint gate
 * suppresses re-emitting rows whose content hasn't changed since the last
 * run. `dropUnseenIds()` runs after each full scan so deleted notes/folders
 * don't stay gated forever.
 *
 * Failure recovery: each stream failure carries the recovery hint of its own
 * cause. A transient page, transport or pagination failure asks for a runtime
 * retry. A source row this connector cannot represent (for example invalid
 * UTF-8) fails the same way on every retry of that revision, so its hint is
 * `not_retriable`. The stream still emits no STATE, because STATE on a
 * full-inventory stream claims every row. The next scheduled run reads the
 * source again and checkpoints once the row is readable.
 *
 * Folder projection: `folder_id` remains the CloudKit recordName foreign
 * key. `folder_name` carries the legacy display name, resolved from the
 * folders stream fetched as a notes projection dependency. A note row is
 * uncovered when a referenced folder does not resolve to a readable name.
 *
 * Note body text (`text_content`) is decoded from the recognized Apple Notes
 * protobuf structure by `parsers.ts#decodeNoteBody`. Text inside each field is
 * preserved exactly; separate fields join with a line feed. An undecodable
 * body withholds the row and records its cause; it never becomes empty text.
 *
 * Synthetic query and parser fixtures cover collection behavior. A live
 * account run is separate and only occurs when a signed-in profile exists.
 *
 * CHANGES
 *   v0.1.24 (2026-10-17) — expose the signed-in account's source-stated
 *     name in a singleton profile stream using the existing validate call.
 *   v0.1.23 (2026-10-15) — account for mapped-field readability, accept
 *     open Notes subroutes, add bounded readiness recovery, validate
 *     CloudKit pages, and include same-run folder names in notes projection.
 *   v0.1.1 (2026-09-24) — owner sign-in assistance now uses a
 *     connector-local `ensureSession` with auto-resume once CloudKit validate
 *     proves the iCloud session is live.
 *   v0.1.0 (2026-09-22) — initial PDPP Collection Profile implementation,
 *     switched from a custom `ensureSession` (with its
 *     own manual-handoff wrapper) to the runtime's generic `probeSession`
 *     hook, so credential resolution defers to session establishment
 *     rather than running eagerly before it; live-verified against a real,
 *     already-authenticated browser profile (session-live path only; the
 *     dead-session manual_action handoff has not yet been exercised live).
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import {
	probeICloudSession,
	probeICloudSessionInPlace,
} from "../../packages/polyfill-connectors/src/auto-login/icloud.ts";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import type {
	BrowserCollectContext,
	EnsureSessionArgs,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	createConnectorFailure,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import type { FieldOmission as ParsedFieldOmission } from "./parsers.ts";
import {
	readCloudKitRecordType,
	readDeletedNote,
	readFolderRecord,
	readNoteRecord,
	resolveCloudKitRecordId,
} from "./parsers.ts";
import { profileSchema, validateRecord } from "./schemas.ts";
import type {
	CloudKitFetchResult,
	CloudKitRecord,
	CloudKitValidateResponse,
} from "./types.ts";

const VALIDATE_URL = "https://setup.icloud.com/setup/ws/1/validate";
const RESULTS_LIMIT = 200;
const NOTES_READINESS_ATTEMPTS = 3;
const NOTES_READINESS_BUDGET_MS = 20_000;
const NOTES_READINESS_OPERATION_TIMEOUT_MS = 5_000;
const READINESS_DEADLINE = Symbol("icloud readiness deadline");
const READINESS_OPERATION_TIMEOUT = Symbol(
	"icloud readiness operation timeout",
);
/** Playwright's evaluate has no deadline. Without this bound, one page call
 *  that never settles would hold collection open and report nothing. */
const PAGE_CALL_TIMEOUT_MS = 60_000;

class PageCallTimeout extends Error {}

/** Stop waiting for a page call after PAGE_CALL_TIMEOUT_MS. The call itself is
 *  not cancelled. The caller gets a timeout failure instead of waiting forever:
 *  a timed-out query fails only its stream, and collection continues. */
async function withinPageCallTimeout<T>(
	call: Promise<T>,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			call,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new PageCallTimeout(
								`icloud_page_unresponsive: the ${label} page call did not settle within ${PAGE_CALL_TIMEOUT_MS} ms`,
							),
						),
					PAGE_CALL_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function withinReadinessBudget<T>(
	startOperation: () => Promise<T>,
	deadline: number,
): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw READINESS_DEADLINE;
	const timeoutMs = Math.min(NOTES_READINESS_OPERATION_TIMEOUT_MS, remaining);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const value = await Promise.race([
			startOperation(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							timeoutMs === remaining
								? READINESS_DEADLINE
								: READINESS_OPERATION_TIMEOUT,
						),
					timeoutMs,
				);
			}),
		]);
		if (Date.now() >= deadline) throw READINESS_DEADLINE;
		return value;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

interface ProgressExtra {
	intentional_exclusions?: number;
	item_count?: number;
	page_index?: number;
	phase?: string;
	stream?: string;
	total_seen?: number;
}

export const ICLOUD_NOTES_RETRYABLE_PATTERN =
	/ECONN|ETIMEDOUT|fetch failed|icloud_rate_limited|icloud_readiness_exhausted|icloud_page_unresponsive/i;

type StreamName = "folders" | "notes" | "profile";
type FieldOmission = ParsedFieldOmission;
type OmittedRowDiagnostic = {
	row_index: number;
	record_id?: string;
	field_count: number;
	field_omissions: FieldOmission[];
	row_reason?: string;
};

type RecoveryHint =
	| { action: "retry_by_runtime"; retryable: true }
	| { action: "manual_action_required"; retryable: false }
	| { action: "retry_on_connector_upgrade"; retryable: false }
	| { action: "not_retriable"; retryable: false };

/** Why a stream or the run failed. The cause is kept, including a failed
 *  dependency stream, until recoveryHintFor turns it into a recovery hint. */
type FailureCause =
	| { kind: "transient" }
	| { kind: "auth_rejected" }
	| { kind: "unrecognized_response" }
	| { kind: "unrepresentable_rows" }
	| { kind: "dependency"; stream: StreamName; failure: QueryFailure };

interface QueryFailure {
	reason:
		| "icloud_auth_failed"
		| "icloud_http_error"
		| "icloud_invalid_config_response"
		| "icloud_invalid_query_response"
		| "icloud_navigation_changed"
		| "icloud_no_progress"
		| "icloud_omitted_rows"
		| "icloud_page_unresponsive"
		| "icloud_rate_limited"
		| "icloud_readiness_exhausted";
	message: string;
	cause: FailureCause;
	pageCount: number;
	rowsSeen?: number;
	sourceRowsSeen?: number;
	noteRowsSeen?: number;
	deletedNoteRows?: number;
	intentionalExclusions?: number;
	omittedRows?: number;
	fieldOmissions?: FieldOmission[];
	omittedRowDiagnostics?: OmittedRowDiagnostic[];
}

const QUERY_FAILURE_REASON_CODES: Record<
	QueryFailure["reason"],
	QueryFailure["reason"]
> = {
	icloud_auth_failed: "icloud_auth_failed",
	icloud_http_error: "icloud_http_error",
	icloud_invalid_config_response: "icloud_invalid_config_response",
	icloud_invalid_query_response: "icloud_invalid_query_response",
	icloud_navigation_changed: "icloud_navigation_changed",
	icloud_no_progress: "icloud_no_progress",
	icloud_omitted_rows: "icloud_omitted_rows",
	icloud_page_unresponsive: "icloud_page_unresponsive",
	icloud_rate_limited: "icloud_rate_limited",
	icloud_readiness_exhausted: "icloud_readiness_exhausted",
};

interface QueryWalk {
	records: CloudKitRecord[];
	complete: boolean;
	endProof?: {
		requestIdentity: string;
		pageUrl: string;
		ckBaseUrl: string;
		dsid: string;
		stream: StreamName;
	};
	failure?: QueryFailure;
	pageCount: number;
}

export async function ensureICloudNotesSession({
	assist,
	completeAssistance,
	page,
	sendInteraction,
}: EnsureSessionArgs): Promise<void> {
	if (await probeICloudSession(page)) {
		return;
	}
	const live = await manualBrowserLogin({
		assist,
		completeAssistance,
		isProbeSuccessful: (ready) => ready,
		message:
			"Sign in to iCloud Notes. The connector will continue automatically once the session is live.",
		page,
		probe: () => probeICloudSessionInPlace(page),
		readinessProbe: probeICloudSessionInPlace,
		readinessProbeOnHandoffPage: true,
		reason: "login",
		sendInteraction,
		timeoutSeconds: 1800,
	});
	if (!live) {
		throw new Error(
			"icloud_notes_login_manual_incomplete: CloudKit validate did not return a live session after handoff",
		);
	}
}

// ─── CloudKit config + fetch ──────────────────────────────────────────────

interface CloudKitConfigLive {
	ckBaseUrl: string;
	dsid: string;
	userName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Re-derive the CloudKit config from the already-authenticated page
 *  session. `ensureSession` establishes the session but returns void (the
 *  runtime's `EnsureSessionArgs` contract), so collect() re-probes the same
 *  validate endpoint once, cheaply, against the now-live cookie. */
type ConfigResolution =
	| { kind: "live"; config: CloudKitConfigLive }
	| { kind: "failed"; failure: QueryFailure };

function configFailure(
	failure: Pick<QueryFailure, "cause" | "reason">,
	detail: string,
): ConfigResolution {
	return {
		kind: "failed",
		failure: {
			...failure,
			message: `${failure.reason}: could not resolve the CloudKit config (${detail})`,
			pageCount: 0,
		},
	};
}

async function resolveCloudKitConfig(page: Page): Promise<ConfigResolution> {
	let timedOut = false;
	const result = (await withinPageCallTimeout(
		page.evaluate(async (url) => {
			try {
				const res = await fetch(url, {
					method: "POST",
					credentials: "include",
				});
				const status = res.status;
				let json: unknown = null;
				try {
					json = await res.json();
				} catch {
					json = null;
				}
				return { status, json };
			} catch (err) {
				return { status: 0, json: { error: String(err) } };
			}
		}, VALIDATE_URL),
		"validate",
	).catch((error: unknown) => {
		timedOut = error instanceof PageCallTimeout;
		return { status: 0, json: null };
	})) as CloudKitFetchResult;
	if (timedOut) {
		return configFailure(
			{ reason: "icloud_page_unresponsive", cause: { kind: "transient" } },
			`the validate page call did not settle within ${PAGE_CALL_TIMEOUT_MS} ms`,
		);
	}
	const invalid = (): ConfigResolution =>
		configFailure(
			statusFailure(200, "icloud_invalid_config_response"),
			"HTTP 200 with an unrecognized body",
		);
	if (result.status !== 200) {
		return configFailure(
			statusFailure(result.status, "icloud_invalid_config_response"),
			`HTTP ${result.status || "network error"}`,
		);
	}
	if (!isRecord(result.json) || Object.hasOwn(result.json, "error")) {
		return invalid();
	}
	const data = result.json as CloudKitValidateResponse;
	const dsid = data.dsInfo?.dsid;
	const ckBaseUrl = data.webservices?.ckdatabasews?.url;
	// Never coerce a malformed account identity into a singleton key.
	if (
		typeof dsid !== "string" &&
		!(typeof dsid === "number" && Number.isSafeInteger(dsid) && dsid >= 0)
	) {
		return invalid();
	}
	const accountId = profileSchema.shape.id.safeParse(String(dsid));
	if (!accountId.success) return invalid();
	if (typeof ckBaseUrl !== "string" || ckBaseUrl.length === 0) {
		return invalid();
	}
	// Reuse this response; do not fetch a profile or synthesize an Apple ID
	// fallback. Missing, blank, or unreadable names remain omitted.
	const userName = profileSchema.shape.user_name.safeParse(data.dsInfo?.fullName);
	const config: CloudKitConfigLive = {
		dsid: accountId.data,
		ckBaseUrl,
		...(userName.success && userName.data !== undefined
			? { userName: userName.data }
			: {}),
	};
	return { kind: "live", config };
}

function queryUrl(config: CloudKitConfigLive): string {
	return `${config.ckBaseUrl}/database/1/com.apple.notes/production/private/records/query?dsid=${config.dsid}`;
}

async function readPageUrl(page: Page): Promise<string> {
	return withinPageCallTimeout(
		page.evaluate(() => window.location.href, "icloud-notes-location"),
		"location",
	);
}

/** Observational owner probe for PageShim; never enters credentials. */
export async function probeICloudNotesSession(page: Page): Promise<boolean> {
	const before = await readPageUrl(page);
	if (!isICloudNotesUrl(before)) return false;
	const resolution = await resolveCloudKitConfig(page);
	return (
		resolution.kind === "live" &&
		remainsInICloudNotes(await readPageUrl(page), before)
	);
}

function isICloudNotesUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			(url.hostname === "www.icloud.com" || url.hostname === "icloud.com") &&
			/^\/notes(?:\/|$)/.test(url.pathname)
		);
	} catch {
		return false;
	}
}

function remainsInICloudNotes(current: string, initial: string): boolean {
	if (!isICloudNotesUrl(current) || !isICloudNotesUrl(initial)) return false;
	return new URL(current).origin === new URL(initial).origin;
}

async function cloudKitQuery(
	page: Page,
	url: string,
	body: Record<string, unknown>,
): Promise<CloudKitFetchResult> {
	try {
		return (await withinPageCallTimeout(
			page.evaluate(
				async ({ evalUrl, evalBody }) => {
					try {
						const res = await fetch(evalUrl, {
							method: "POST",
							credentials: "include",
							headers: { "Content-Type": "text/plain" },
							body: JSON.stringify(evalBody),
						});
						const status = res.status;
						let json: unknown = null;
						try {
							json = await res.json();
						} catch {
							json = null;
						}
						return { status, json };
					} catch (err) {
						return { status: 0, json: { error: String(err) } };
					}
				},
				{ evalUrl: url, evalBody: body },
			),
			"CloudKit query",
		)) as CloudKitFetchResult;
	} catch (err) {
		return { status: 0, json: { error: String(err) } };
	}
}

function folderQueryBody(marker?: string): Record<string, unknown> {
	return {
		query: {
			recordType: "SearchIndexes",
			filterBy: [
				{
					comparator: "EQUALS",
					fieldName: "indexName",
					fieldValue: { value: "parentless", type: "STRING" },
				},
			],
		},
		zoneID: { zoneName: "Notes" },
		resultsLimit: RESULTS_LIMIT,
		...(marker === undefined ? {} : { continuationMarker: marker }),
	};
}

function noteQueryBody(marker?: string): Record<string, unknown> {
	return {
		query: {
			recordType: "SearchIndexes",
			filterBy: [
				{
					comparator: "EQUALS",
					fieldName: "indexName",
					fieldValue: { value: "recents", type: "STRING" },
				},
			],
			sortBy: [{ fieldName: "modTime", ascending: false }],
		},
		zoneID: { zoneName: "Notes" },
		resultsLimit: RESULTS_LIMIT,
		...(marker === undefined ? {} : { continuationMarker: marker }),
	};
}

function validCloudKitRecord(value: unknown): value is CloudKitRecord {
	if (!isRecord(value)) return false;
	if (typeof value.recordName !== "string") return false;
	return value.fields === undefined || isRecord(value.fields);
}

function queryResponse(
	value: unknown,
): { records: unknown[]; nextMarker: string | null } | null {
	if (!isRecord(value) || Object.hasOwn(value, "error")) return null;
	if (!Array.isArray(value.records)) return null;
	if (!Object.hasOwn(value, "continuationMarker")) {
		return { records: value.records, nextMarker: null };
	}
	if (
		typeof value.continuationMarker !== "string" ||
		value.continuationMarker.length === 0
	) {
		return null;
	}
	return { records: value.records, nextMarker: value.continuationMarker };
}

/** The one place a failure cause becomes a recovery hint. A transient page or
 *  transport failure can succeed on retry. An unrepresentable source revision
 *  fails the same way until the source changes, so it asks for no retry. A
 *  dependency failure takes the hint of the dependency's own cause. */
function recoveryHintFor(cause: FailureCause): RecoveryHint {
	switch (cause.kind) {
		case "transient":
			return { action: "retry_by_runtime", retryable: true };
		case "auth_rejected":
			return { action: "manual_action_required", retryable: false };
		case "unrecognized_response":
			return { action: "retry_on_connector_upgrade", retryable: false };
		case "unrepresentable_rows":
			return { action: "not_retriable", retryable: false };
		case "dependency":
			return recoveryHintFor(cause.failure.cause);
	}
}

/** Classify a CloudKit or setup response status. Status 0 is a network
 *  failure; status 200 reaches here only with an unrecognized body. */
function statusFailure(
	status: number,
	invalidReason:
		| "icloud_invalid_config_response"
		| "icloud_invalid_query_response",
): Pick<QueryFailure, "cause" | "reason"> {
	if (status === 429) {
		return { reason: "icloud_rate_limited", cause: { kind: "transient" } };
	}
	if (status === 401 || status === 403) {
		return { reason: "icloud_auth_failed", cause: { kind: "auth_rejected" } };
	}
	if (status === 0 || status >= 500) {
		return { reason: "icloud_http_error", cause: { kind: "transient" } };
	}
	return {
		reason: status === 200 ? invalidReason : "icloud_http_error",
		cause: { kind: "unrecognized_response" },
	};
}

function queryFailure(
	status: number,
	stream: StreamName,
	pageCount: number,
): QueryFailure {
	return {
		...statusFailure(status, "icloud_invalid_query_response"),
		message: `iCloud Notes ${stream} query did not return a valid page (HTTP ${status || "network error"}); the stream was not checkpointed.`,
		pageCount,
	};
}

/** The response is consumed only by the query request that produced it. The
 *  owner page is checked on both sides of every request; continuation and
 *  end evidence cannot cross a navigation or a different CloudKit identity. */
async function walkQueryPages(
	page: Page,
	pageUrl: string,
	config: CloudKitConfigLive,
	url: string,
	stream: StreamName,
	makeBody: (marker?: string) => Record<string, unknown>,
	progress: (message: string, extra?: ProgressExtra) => Promise<void>,
): Promise<QueryWalk> {
	const records: CloudKitRecord[] = [];
	const seenMarkers = new Set<string>();
	const seenIds = new Set<string>();
	let marker: string | undefined;
	let pageCount = 0;
	while (true) {
		if (!remainsInICloudNotes(await readPageUrl(page), pageUrl)) {
			return {
				records,
				complete: false,
				failure: {
					reason: "icloud_navigation_changed",
					message: `The iCloud Notes page changed during the ${stream} scan; its results were not checkpointed.`,
					cause: { kind: "transient" },
					pageCount,
				},
				pageCount,
			};
		}
		const requestBody = makeBody(marker);
		const requestIdentity = JSON.stringify({
			pageUrl,
			ckBaseUrl: config.ckBaseUrl,
			dsid: config.dsid,
			stream,
			page: pageCount + 1,
			marker: marker ?? null,
			requestBody,
		});
		const response = await cloudKitQuery(page, url, requestBody);
		pageCount += 1;
		if (!remainsInICloudNotes(await readPageUrl(page), pageUrl)) {
			return {
				records,
				complete: false,
				failure: {
					reason: "icloud_navigation_changed",
					message: `The iCloud Notes page changed during the ${stream} scan; its results were not checkpointed.`,
					cause: { kind: "transient" },
					pageCount,
				},
				pageCount,
			};
		}
		if (response.status !== 200) {
			return {
				records,
				complete: false,
				failure: queryFailure(response.status, stream, pageCount),
				pageCount,
			};
		}
		const parsed = queryResponse(response.json);
		if (parsed === null) {
			return {
				records,
				complete: false,
				failure: queryFailure(200, stream, pageCount),
				pageCount,
			};
		}
		let pageProgress = 0;
		let malformedRows = 0;
		for (const value of parsed.records) {
			if (!validCloudKitRecord(value)) {
				malformedRows += 1;
				continue;
			}
			const id = resolveCloudKitRecordId(value);
			if (id === null || seenIds.has(id)) {
				malformedRows += 1;
				continue;
			}
			seenIds.add(id);
			pageProgress += 1;
			records.push(value);
		}
		await progress(
			`Fetched iCloud Notes ${stream} page: ${parsed.records.length} source row(s), ${records.length} unique row(s) total`,
			{
				phase: "page",
				page_index: pageCount,
				item_count: parsed.records.length,
				total_seen: records.length,
			},
		);
		if (parsed.nextMarker !== null && seenMarkers.has(parsed.nextMarker)) {
			return {
				records,
				complete: false,
				failure: {
					reason: "icloud_no_progress",
					message: `iCloud Notes ${stream} pagination repeated a continuation marker; the stream was not checkpointed.`,
					cause: { kind: "transient" },
					pageCount,
				},
				pageCount,
			};
		}
		if (malformedRows > 0) {
			return {
				records,
				complete: false,
				failure: {
					reason: "icloud_omitted_rows",
					message: `iCloud Notes returned ${malformedRows} malformed, unidentified, or duplicate ${stream} row(s); the stream was not checkpointed.`,
					cause: { kind: "unrepresentable_rows" },
					pageCount,
					omittedRows: malformedRows,
				},
				pageCount,
			};
		}
		if (parsed.nextMarker === null) {
			return {
				records,
				complete: true,
				endProof: {
					requestIdentity,
					pageUrl,
					ckBaseUrl: config.ckBaseUrl,
					dsid: config.dsid,
					stream,
				},
				pageCount,
			};
		}
		if (pageProgress === 0) {
			return {
				records,
				complete: false,
				failure: {
					reason: "icloud_no_progress",
					message: `iCloud Notes ${stream} pagination returned no new rows while a continuation remained; the stream was not checkpointed.`,
					cause: { kind: "transient" },
					pageCount,
				},
				pageCount,
			};
		}
		seenMarkers.add(parsed.nextMarker);
		marker = parsed.nextMarker;
	}
}

function hasBoundEndProof(
	walk: QueryWalk,
	pageUrl: string,
	config: CloudKitConfigLive,
	stream: StreamName,
): boolean {
	const proof = walk.endProof;
	return (
		walk.complete &&
		proof !== undefined &&
		proof.requestIdentity.length > 0 &&
		proof.pageUrl === pageUrl &&
		proof.ckBaseUrl === config.ckBaseUrl &&
		proof.dsid === config.dsid &&
		proof.stream === stream
	);
}

async function emitStreamFailure(
	emit: BrowserCollectContext["emit"],
	stream: StreamName,
	failure: QueryFailure,
): Promise<void> {
	await emit({
		type: "SKIP_RESULT",
		stream,
		reason: "inventory_not_proven_complete",
		message: failure.message,
		recovery_hint: recoveryHintFor(failure.cause),
		diagnostics: {
			source_reason: QUERY_FAILURE_REASON_CODES[failure.reason],
			...(failure.cause.kind === "dependency"
				? {
						dependency_stream: failure.cause.stream,
						dependency_reason:
							QUERY_FAILURE_REASON_CODES[failure.cause.failure.reason],
					}
				: {}),
			page_count: failure.pageCount,
			...(failure.rowsSeen === undefined
				? {}
				: { rows_seen: failure.rowsSeen }),
			...(failure.sourceRowsSeen === undefined
				? {}
				: { source_rows_seen: failure.sourceRowsSeen }),
			...(failure.noteRowsSeen === undefined
				? {}
				: { note_rows_seen: failure.noteRowsSeen }),
			...(failure.deletedNoteRows === undefined
				? {}
				: { deleted_note_rows: failure.deletedNoteRows }),
			...(failure.intentionalExclusions === undefined
				? {}
				: { intentional_exclusions: failure.intentionalExclusions }),
			...(failure.omittedRows === undefined
				? {}
				: { omitted_rows: failure.omittedRows }),
			...(failure.fieldOmissions === undefined
				? {}
				: { field_omissions: failure.fieldOmissions }),
			...(failure.omittedRowDiagnostics === undefined
				? {}
				: { omitted_row_diagnostics: failure.omittedRowDiagnostics }),
		},
	});
}

// ─── Collect ────────────────────────────────────────────────────────────

/** Widen `ctx.progress` to accept this connector's own extra fields
 *  (`phase`, `page_index`, etc). Mirrors reddit/index.ts's pattern: the
 *  runtime's real `ProgressExtra` has no index signature, so a connector
 *  that wants richer progress diagnostics threads its calls through a
 *  locally-typed parameter rather than calling `ctx.progress` directly
 *  with fields the runtime type doesn't declare. */
function widenProgress(
	progress: BrowserCollectContext["progress"],
): (message: string, extra?: ProgressExtra) => Promise<void> {
	return progress;
}

class NotesReadinessVeto extends Error {}

async function requireNotesPage(page: Page): Promise<string> {
	const deadline = Date.now() + NOTES_READINESS_BUDGET_MS;
	for (let attempt = 0; attempt < NOTES_READINESS_ATTEMPTS; attempt += 1) {
		try {
			const currentHref = await withinReadinessBudget(
				() => readPageUrl(page),
				deadline,
			);
			if (!isICloudNotesUrl(currentHref)) {
				throw new NotesReadinessVeto(
					"icloud_wrong_page: collection requires the iCloud Notes route",
				);
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			// Test membership before reading: the thin facade records missing members.
			if ("waitForLoadState" in page && typeof page.waitForLoadState === "function") {
				try {
					await withinReadinessBudget(
						() => page.waitForLoadState("load", {
							timeout: Math.min(NOTES_READINESS_OPERATION_TIMEOUT_MS, remaining),
						}),
						deadline,
					);
				} catch (error) {
					if (error === READINESS_DEADLINE) break;
				}
			}
			const afterWaitHref = await withinReadinessBudget(
				() => readPageUrl(page),
				deadline,
			);
			if (!isICloudNotesUrl(afterWaitHref)) {
				throw new NotesReadinessVeto(
					"icloud_wrong_page: navigation left the iCloud Notes route during readiness recovery",
				);
			}
			let pageState: {
				href: string;
				readyState: string;
				blocked: boolean;
			} | null = null;
			let probeTimedOut = false;
			try {
				pageState = await withinReadinessBudget(
					() =>
						page.evaluate(() => {
							const blockedNodes = document.querySelectorAll(
								'form[action*="signin" i], input#account_name_text_field, iframe[src*="captcha" i], [data-testid="error-page"]',
							);
							let blocked = false;
							for (let index = 0; index < blockedNodes.length; index += 1) {
								if (blockedNodes[index]?.getClientRects().length) blocked = true;
							}
							return {
								href: window.location.href,
								readyState: document.readyState,
								blocked,
							};
						}),
					deadline,
				);
			} catch (error) {
				if (error === READINESS_DEADLINE) probeTimedOut = true;
				// Navigation can detach the execution context briefly. Recheck route,
				// then reload only while the owner page is still inside Notes.
			}
			if (pageState?.blocked) {
				throw new NotesReadinessVeto(
					"icloud_page_blocked: sign-in, captcha, or error UI is visible",
				);
			}
			if (pageState && !isICloudNotesUrl(pageState.href)) {
				throw new NotesReadinessVeto(
					"icloud_wrong_page: the document navigated away from iCloud Notes",
				);
			}
			const afterProbeHref = await withinReadinessBudget(
				() => readPageUrl(page),
				deadline,
			);
			if (!isICloudNotesUrl(afterProbeHref)) {
				throw new NotesReadinessVeto(
					"icloud_wrong_page: navigation left the iCloud Notes route during readiness recovery",
				);
			}
			if (probeTimedOut || Date.now() >= deadline) break;
			if (
				pageState?.readyState === "complete" &&
				pageState.href === afterWaitHref &&
				Date.now() < deadline
			) {
				return afterWaitHref;
			}
		} catch (error) {
			if (error instanceof NotesReadinessVeto) throw error;
			if (error === READINESS_DEADLINE) break;
			// A location evaluation can lose its execution context just like the
			// document probe. Recheck the route before any recovery navigation.
		}
		if (attempt + 1 >= NOTES_READINESS_ATTEMPTS) break;
		const reloadBudget = deadline - Date.now();
		if (reloadBudget <= 0) break;
		let beforeReloadHref: string;
		try {
			beforeReloadHref = await withinReadinessBudget(
				() => readPageUrl(page),
				deadline,
			);
		} catch (error) {
			if (error === READINESS_DEADLINE) break;
			// Never reload a stale URL when the current route cannot be read.
			continue;
		}
		if (!isICloudNotesUrl(beforeReloadHref)) {
			throw new Error(
				"icloud_wrong_page: navigation left the iCloud Notes route before readiness recovery reload",
			);
		}
		try {
			await withinReadinessBudget(
				() =>
					page.goto(beforeReloadHref, {
						waitUntil: "domcontentloaded",
						timeout: Math.min(
							NOTES_READINESS_OPERATION_TIMEOUT_MS,
							reloadBudget,
						),
					}),
				deadline,
			);
		} catch (error) {
			if (error === READINESS_DEADLINE) break;
		}
	}
	throw new Error(
		"icloud_readiness_exhausted: the Notes page did not become ready within the bounded recovery budget; collection was not started",
	);
}

function omittedRowsFailure(
	stream: StreamName,
	count: number,
	pageCount: number,
	fieldOmissions: readonly FieldOmission[] = [],
	omittedRowDiagnostics: readonly OmittedRowDiagnostic[] = [],
): QueryFailure {
	return {
		reason: "icloud_omitted_rows",
		message: `iCloud Notes could not fully read or represent ${count} ${stream} row(s); the stream was not checkpointed.`,
		cause: { kind: "unrepresentable_rows" },
		pageCount,
		omittedRows: count,
		...(fieldOmissions.length === 0
			? {}
			: { fieldOmissions: fieldOmissions.slice() }),
		...(omittedRowDiagnostics.length === 0
			? {}
			: { omittedRowDiagnostics: omittedRowDiagnostics.slice() }),
	};
}

/** Identify a withheld row by its source record id, so the rejected revision
 *  can be found again; `row_index` alone changes as other rows change. */
function omittedRow(
	record: CloudKitRecord,
	rowIndex: number,
	fieldOmissions: FieldOmission[],
	rowReason?: string,
): OmittedRowDiagnostic {
	const recordId = resolveCloudKitRecordId(record);
	return {
		row_index: rowIndex,
		...(recordId === null ? {} : { record_id: recordId }),
		field_count: fieldOmissions.length,
		field_omissions: fieldOmissions,
		...(rowReason === undefined ? {} : { row_reason: rowReason }),
	};
}

function addFieldOmissions(
	target: FieldOmission[],
	omissions: readonly FieldOmission[],
): void {
	for (const omission of omissions) {
		if (
			!target.some(
				(current) => JSON.stringify(current) === JSON.stringify(omission),
			)
		) {
			target.push(omission);
		}
	}
	target.sort((left, right) =>
		left.field === right.field
			? left.reason.localeCompare(right.reason)
			: left.field.localeCompare(right.field),
	);
}

function withFieldOmissions(
	failure: QueryFailure | undefined,
	stream: StreamName,
	count: number,
	pageCount: number,
	fieldOmissions: readonly FieldOmission[],
	omittedRowDiagnostics: readonly OmittedRowDiagnostic[] = [],
): QueryFailure | undefined {
	if (
		count === 0 &&
		fieldOmissions.length === 0 &&
		omittedRowDiagnostics.length === 0
	)
		return failure;
	const rowFailure = omittedRowsFailure(
		stream,
		count,
		pageCount,
		fieldOmissions,
		omittedRowDiagnostics,
	);
	if (!failure) return rowFailure;
	const mergedFieldOmissions: FieldOmission[] = [];
	addFieldOmissions(mergedFieldOmissions, failure.fieldOmissions ?? []);
	addFieldOmissions(mergedFieldOmissions, fieldOmissions);
	const mergedRowDiagnostics = [
		...(failure.omittedRowDiagnostics ?? []),
		...omittedRowDiagnostics,
	];
	const mergedFailure = omittedRowsFailure(
		stream,
		(failure.omittedRows ?? 0) + count,
		pageCount,
		mergedFieldOmissions,
		mergedRowDiagnostics,
	);
	return {
		...failure,
		omittedRows: (failure.omittedRows ?? 0) + count,
		...(mergedFailure.fieldOmissions === undefined
			? {}
			: { fieldOmissions: mergedFailure.fieldOmissions }),
		...(mergedFailure.omittedRowDiagnostics === undefined
			? {}
			: { omittedRowDiagnostics: mergedFailure.omittedRowDiagnostics }),
	};
}

export async function collectAllStreams(
	ctx: BrowserCollectContext,
): Promise<void> {
	const { emit, emitRecord, page, requested, state } = ctx;
	if (
		!requested.has("notes") &&
		!requested.has("folders") &&
		!requested.has("profile")
	)
		return;
	const progress = widenProgress(ctx.progress);
	const pageUrl = await requireNotesPage(page);

	const resolution = await resolveCloudKitConfig(page);
	if (resolution.kind === "failed") {
		const { failure } = resolution;
		throw createConnectorFailure(failure.reason, failure.message, {
			retryable: recoveryHintFor(failure.cause).retryable,
		});
	}
	const { config } = resolution;
	if (!remainsInICloudNotes(await readPageUrl(page), pageUrl)) {
		throw new Error(
			"icloud_navigation_changed: page changed while resolving CloudKit owner",
		);
	}
	if (requested.has("profile")) {
		const profile = {
			id: config.dsid,
			...(config.userName === undefined ? {} : { user_name: config.userName }),
		};
		const cursor = openFingerprintCursor(state.profile, {
			excludeFromFingerprint: [],
		});
		if (cursor.shouldEmit(profile)) await emitRecord("profile", profile);
		if (remainsInICloudNotes(await readPageUrl(page), pageUrl)) {
			cursor.dropUnseenIds();
			await emit({
				type: "STATE",
				stream: "profile",
				cursor: { fingerprints: cursor.toState() },
			});
		} else {
			await emitStreamFailure(emit, "profile", {
				reason: "icloud_navigation_changed",
				message:
					"The iCloud Notes page changed before the profile could be checkpointed.",
				cause: { kind: "transient" },
				pageCount: 1,
			});
		}
	}
	const url = queryUrl(config);
	const needsFolders = requested.has("folders") || requested.has("notes");
	let folderWalk: QueryWalk | null = null;
	let folderScanComplete = false;
	let folderFailure: QueryFailure | undefined;
	const folderNames = new Map<string, string>();
	const unavailableFolderIds = new Set<string>();

	if (needsFolders) {
		await progress("Fetching iCloud Notes folders");
		folderWalk = await walkQueryPages(
			page,
			pageUrl,
			config,
			url,
			"folders",
			folderQueryBody,
			progress,
		);
		let omitted = 0;
		let folderRowIndex = 0;
		let intentionalExclusions = 0;
		const fieldOmissions: FieldOmission[] = [];
		const omittedRowDiagnostics: OmittedRowDiagnostic[] = [];
		for (const record of folderWalk.records) {
			const recordType = readCloudKitRecordType(record);
			if (recordType.kind === "UNAVAILABLE") {
				const rowIndex = folderRowIndex;
				folderRowIndex += 1;
				const omission: FieldOmission = {
					field: "recordType",
					reason: recordType.reason,
					source_shape: recordType.source_shape,
				};
				fieldOmissions.push(omission);
				omitted += 1;
				omittedRowDiagnostics.push(
					omittedRow(record, rowIndex, [omission], "unavailable_fields"),
				);
				continue;
			}
			if (recordType.value !== "Folder") {
				intentionalExclusions += 1;
				continue;
			}
			const rowIndex = folderRowIndex;
			folderRowIndex += 1;
			const result = readFolderRecord(record);
			addFieldOmissions(fieldOmissions, result.unavailableFields);
			const built = result.record;
			if (built === null) {
				omitted += 1;
				omittedRowDiagnostics.push(
					omittedRow(
						record,
						rowIndex,
						result.unavailableFields,
						"record_identity_unavailable",
					),
				);
				continue;
			}
			if (result.unavailableFields.length > 0) {
				omitted += 1;
				unavailableFolderIds.add(built.id);
				omittedRowDiagnostics.push(
					omittedRow(record, rowIndex, result.unavailableFields),
				);
			}
			if (!validateRecord("folders", built).ok) {
				if (result.unavailableFields.length === 0) {
					omitted += 1;
					omittedRowDiagnostics.push(
						omittedRow(record, rowIndex, [], "record_schema_invalid"),
					);
				}
				continue;
			}
			if (built.name !== null) folderNames.set(built.id, built.name);
		}
		folderScanComplete =
			omitted === 0 && hasBoundEndProof(folderWalk, pageUrl, config, "folders");
		folderFailure = withFieldOmissions(
			folderWalk.failure,
			"folders",
			omitted,
			folderWalk.pageCount,
			fieldOmissions,
			omittedRowDiagnostics,
		);

		if (requested.has("folders")) {
			const cursor = openFingerprintCursor(state.folders, {
				excludeFromFingerprint: [],
			});
			let covered = 0;
			for (const record of folderWalk.records) {
				const recordType = readCloudKitRecordType(record);
				if (recordType.kind === "UNAVAILABLE" || recordType.value !== "Folder")
					continue;
				const result = readFolderRecord(record);
				const built = result.record;
				if (
					built === null ||
					result.unavailableFields.length > 0 ||
					!validateRecord("folders", built).ok
				)
					continue;
				if (cursor.shouldEmit(built)) {
					await emitRecord("folders", built);
				}
				if (result.unavailableFields.length === 0) covered += 1;
			}
			let failure =
				folderFailure ??
				(!remainsInICloudNotes(await readPageUrl(page), pageUrl)
					? {
							reason: "icloud_navigation_changed",
							message:
								"The iCloud Notes page changed before the folders stream could be checkpointed.",
							cause: { kind: "transient" },
							pageCount: folderWalk.pageCount,
						}
					: null);
			if (failure)
				failure = {
					...failure,
					rowsSeen: folderRowIndex,
					intentionalExclusions,
				};
			if (failure) {
				await emitStreamFailure(emit, "folders", failure);
			} else if (
				hasBoundEndProof(folderWalk, pageUrl, config, "folders") &&
				remainsInICloudNotes(await readPageUrl(page), pageUrl)
			) {
				cursor.dropUnseenIds();
				await emit({
					type: "STATE",
					stream: "folders",
					cursor: { fingerprints: cursor.toState() },
				});
			}
			await progress("Emitted iCloud Notes folders", {
				phase: "emit",
				item_count: folderWalk.records.length,
				intentional_exclusions: intentionalExclusions,
				total_seen: covered,
			});
		}
	}

	if (requested.has("notes")) {
		await progress("Fetching iCloud Notes");
		const walk = await walkQueryPages(
			page,
			pageUrl,
			config,
			url,
			"notes",
			noteQueryBody,
			progress,
		);
		const cursor = openFingerprintCursor(state.notes, {
			// text_content is deterministically re-derived from the same
			// TextDataEncrypted bytes each run — not a run-clock field — so it
			// participates in the fingerprint like every other field.
			excludeFromFingerprint: [],
		});
		let covered = 0;
		let omitted = 0;
		let noteRowIndex = 0;
		let noteRowsSeen = 0;
		let deletedNoteRows = 0;
		let intentionalExclusions = 0;
		const fieldOmissions: FieldOmission[] = [];
		const omittedRowDiagnostics: OmittedRowDiagnostic[] = [];
		for (const record of walk.records) {
			const recordType = readCloudKitRecordType(record);
			if (recordType.kind === "UNAVAILABLE") {
				const rowIndex = noteRowIndex;
				noteRowIndex += 1;
				const omission: FieldOmission = {
					field: "recordType",
					reason: recordType.reason,
					source_shape: recordType.source_shape,
				};
				fieldOmissions.push(omission);
				omitted += 1;
				omittedRowDiagnostics.push(
					omittedRow(record, rowIndex, [omission], "unavailable_fields"),
				);
				continue;
			}
			if (recordType.value !== "Note") {
				intentionalExclusions += 1;
				continue;
			}
			noteRowsSeen += 1;
			const deletion = readDeletedNote(record);
			if (deletion.kind !== "UNAVAILABLE" && deletion.value) {
				deletedNoteRows += 1;
				continue;
			}
			const rowIndex = noteRowIndex;
			noteRowIndex += 1;
			if (deletion.kind === "UNAVAILABLE") {
				const omission: FieldOmission = {
					field: "deleted",
					reason: deletion.reason,
					source_shape: deletion.source_shape,
				};
				fieldOmissions.push(omission);
				omitted += 1;
				omittedRowDiagnostics.push(
					omittedRow(record, rowIndex, [omission], "unavailable_fields"),
				);
				continue;
			}
			const result = await readNoteRecord(record, folderNames, {
				unavailableFolderIds,
				folderScanComplete,
			});
			addFieldOmissions(fieldOmissions, result.unavailableFields);
			const built = result.record;
			if (built === null) {
				omitted += 1;
				omittedRowDiagnostics.push(
					omittedRow(
						record,
						rowIndex,
						result.unavailableFields,
						"record_identity_unavailable",
					),
				);
				continue;
			}
			if (result.unavailableFields.length > 0) {
				omitted += 1;
				omittedRowDiagnostics.push(
					omittedRow(
						record,
						rowIndex,
						result.unavailableFields,
						"unavailable_fields",
					),
				);
				continue;
			}
			if (!validateRecord("notes", built).ok) {
				omitted += 1;
				omittedRowDiagnostics.push(
					omittedRow(record, rowIndex, [], "record_schema_invalid"),
				);
				continue;
			}
			if (cursor.shouldEmit(built)) {
				await emitRecord("notes", built);
			}
			covered += 1;
		}
		let failure =
			withFieldOmissions(
				walk.failure,
				"notes",
				omitted,
				walk.pageCount,
				fieldOmissions,
				omittedRowDiagnostics,
			) ??
			(omitted > 0
				? omittedRowsFailure(
						"notes",
						omitted,
						walk.pageCount,
						fieldOmissions,
						omittedRowDiagnostics,
					)
				: null);
		// Notes withheld because the folders inventory failed fail for the
		// folders cause, unless the notes query itself failed. Precedence follows
		// the pipeline: notes query, then folders, then note representation.
		if (
			failure &&
			walk.failure === undefined &&
			folderFailure !== undefined &&
			fieldOmissions.some(
				(omission) =>
					omission.reason === "folder_projection_incomplete" ||
					omission.reason === "folder_name_unavailable",
			)
		) {
			failure = {
				...failure,
				cause: {
					kind: "dependency",
					stream: "folders",
					failure: folderFailure,
				},
			};
		}
		if (failure) {
			failure = {
				...failure,
				rowsSeen: noteRowIndex,
				sourceRowsSeen: walk.records.length,
				noteRowsSeen,
				deletedNoteRows,
				intentionalExclusions,
			};
		}
		if (!failure && !remainsInICloudNotes(await readPageUrl(page), pageUrl)) {
			failure = {
				reason: "icloud_navigation_changed",
				message:
					"The iCloud Notes page changed before the notes stream could be checkpointed.",
				cause: { kind: "transient" },
				pageCount: walk.pageCount,
			};
		}
		if (failure) {
			await emitStreamFailure(emit, "notes", failure);
		} else if (hasBoundEndProof(walk, pageUrl, config, "notes")) {
			cursor.dropUnseenIds();
			await emit({
				type: "STATE",
				stream: "notes",
				cursor: { fingerprints: cursor.toState() },
			});
		}
		await progress("Emitted iCloud Notes", {
			phase: "emit",
			item_count: walk.records.length,
			intentional_exclusions: intentionalExclusions,
			total_seen: covered,
		});
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "icloud_notes",
		validateRecord,
		retryablePattern: ICLOUD_NOTES_RETRYABLE_PATTERN,
		browser: { profileName: "icloud_notes" },
		probeSession: ({ page }) => probeICloudSession(page),
		ensureSession: ensureICloudNotesSession,
		async collect(ctx: BrowserCollectContext): Promise<void> {
			await collectAllStreams(ctx);
		},
	});
}
