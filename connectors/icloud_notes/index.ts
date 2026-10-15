#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP iCloud Notes Connector (manifest v0.1.24)
 *
 * Greenfield PDPP Collection Profile connector, ported from the legacy CG
 * script `connectors/apple/icloud-notes-playwright.js` (read-only prior
 * art; not built from it). Collects via a logged-in browser session against
 * Apple's own CloudKit web service — the same backend the icloud.com Notes
 * web app itself calls.
 *
 * Streams:
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
 * CloudKit query surface: same-origin `page.evaluate(fetch(...))` calls
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
 * Folder projection: `folder_id` remains the CloudKit recordName foreign
 * key. `folder_name` carries the legacy display name, resolved from the
 * folders stream fetched as a notes projection dependency. A note row is
 * uncovered when a referenced folder does not resolve to a readable name.
 *
 * KNOWN LIMITATION: note body text (`text_content`) comes from a
 * byte-heuristic decode of `TextDataEncrypted`
 * (`parsers.ts#extractNoteText`), ported verbatim from the legacy script.
 * It is not a real Apple Notes protobuf parse — see that function's doc
 * comment for what it can and cannot recover.
 *
 * Synthetic query and parser fixtures cover collection behavior. A live
 * account run is separate and only occurs when a signed-in profile exists.
 *
 * CHANGES
 *   v0.1.24 (2026-10-15) — account for each mapped field's readability and
 *     accept collection from an open Notes subroute.
 *   v0.1.23 (2026-10-15) — validate CloudKit query pages, salvage valid
 *     prefixes on partial failure, drain both streams with continuation
 *     guards, and include same-run folder names in notes projection.
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
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import {
	isDeletedNote,
	readFolderRecord,
	readNoteRecord,
	resolveCloudKitRecordId,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
	CloudKitFetchResult,
	CloudKitRecord,
	CloudKitValidateResponse,
} from "./types.ts";

const VALIDATE_URL = "https://setup.icloud.com/setup/ws/1/validate";
const RESULTS_LIMIT = 200;

interface ProgressExtra {
	item_count?: number;
	page_index?: number;
	phase?: string;
	stream?: string;
	total_seen?: number;
}

export const ICLOUD_NOTES_RETRYABLE_PATTERN =
	/ECONN|ETIMEDOUT|fetch failed|icloud_rate_limited/i;

type StreamName = "folders" | "notes";
type FieldOmission = { field: string; reason: string };

interface QueryFailure {
	reason: string;
	message: string;
	retryable: boolean;
	pageCount: number;
	omittedRows?: number;
	fieldOmissions?: FieldOmission[];
}

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Re-derive the CloudKit config from the already-authenticated page
 *  session. `ensureSession` establishes the session but returns void (the
 *  runtime's `EnsureSessionArgs` contract), so collect() re-probes the same
 *  validate endpoint once, cheaply, against the now-live cookie. */
async function resolveCloudKitConfig(
	page: Page,
): Promise<CloudKitConfigLive | null> {
	const result = (await page
		.evaluate(async (url) => {
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
		}, VALIDATE_URL)
		.catch(() => ({ status: 0, json: null }))) as CloudKitFetchResult;
	if (
		result.status !== 200 ||
		!isRecord(result.json) ||
		Object.hasOwn(result.json, "error")
	) {
		return null;
	}
	const data = result.json as CloudKitValidateResponse;
	const dsid = data.dsInfo?.dsid;
	const ckBaseUrl = data.webservices?.ckdatabasews?.url;
	if ((dsid === undefined || dsid === null) && dsid !== 0) {
		return null;
	}
	if (typeof ckBaseUrl !== "string" || ckBaseUrl.length === 0) {
		return null;
	}
	return { dsid: String(dsid), ckBaseUrl };
}

function queryUrl(config: CloudKitConfigLive): string {
	return `${config.ckBaseUrl}/database/1/com.apple.notes/production/private/records/query?dsid=${config.dsid}`;
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
		return (await page.evaluate(
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
	if (!isRecord(value) || typeof value.recordType !== "string") return false;
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

function queryFailure(
	status: number,
	stream: StreamName,
	pageCount: number,
): QueryFailure {
	const reason =
		status === 429
			? "icloud_rate_limited"
			: status === 401 || status === 403
				? "icloud_auth_failed"
				: status === 200
					? "icloud_invalid_query_response"
					: `icloud_http_${status}`;
	return {
		reason,
		message: `iCloud Notes ${stream} query did not return a valid page (HTTP ${status || "network error"}); the stream was not checkpointed.`,
		retryable: status === 0 || status === 429 || status >= 500,
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
		if (!remainsInICloudNotes(page.url(), pageUrl)) {
			return {
				records,
				complete: false,
				failure: {
					reason: "icloud_navigation_changed",
					message: `The iCloud Notes page changed during the ${stream} scan; its results were not checkpointed.`,
					retryable: true,
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
		if (!remainsInICloudNotes(page.url(), pageUrl)) {
			return {
				records,
				complete: false,
				failure: {
					reason: "icloud_navigation_changed",
					message: `The iCloud Notes page changed during the ${stream} scan; its results were not checkpointed.`,
					retryable: true,
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
		await progress(`Fetched iCloud Notes ${stream} page`, {
			phase: "page",
			page_index: pageCount,
			item_count: parsed.records.length,
			total_seen: records.length,
		});
		if (parsed.nextMarker !== null && seenMarkers.has(parsed.nextMarker)) {
			return {
				records,
				complete: false,
				failure: {
					reason: "icloud_no_progress",
					message: `iCloud Notes ${stream} pagination repeated a continuation marker; the stream was not checkpointed.`,
					retryable: true,
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
					retryable: false,
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
					retryable: true,
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
		reason: failure.reason,
		message: failure.message,
		recovery_hint: {
			action: failure.retryable ? "retry_by_runtime" : "not_retriable",
			retryable: failure.retryable,
		},
		diagnostics: {
			page_count: failure.pageCount,
			...(failure.omittedRows === undefined
				? {}
				: { omitted_rows: failure.omittedRows }),
			...(failure.fieldOmissions === undefined
				? {}
				: { field_omissions: failure.fieldOmissions }),
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

async function requireNotesPage(page: Page): Promise<string> {
	if (typeof page.waitForLoadState === "function") {
		await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
	}
	let current: URL;
	try {
		current = new URL(page.url());
	} catch {
		throw new Error("icloud_wrong_page: current page URL is unavailable");
	}
	let pageState: { href: string; readyState: string; blocked: boolean };
	try {
		pageState = await page.evaluate(() => {
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
		});
	} catch {
		throw new Error(
			"icloud_page_unloaded: the Notes page is not available for collection",
		);
	}
	if (pageState.readyState !== "complete" || pageState.href !== current.href) {
		throw new Error(
			"icloud_page_unloaded: the Notes page has not finished loading",
		);
	}
	if (pageState.blocked) {
		throw new Error(
			"icloud_page_blocked: sign-in, captcha, or error UI is visible",
		);
	}
	if (!isICloudNotesUrl(current.href)) {
		throw new Error(
			"icloud_wrong_page: collection requires the iCloud Notes route",
		);
	}
	return current.href;
}

function omittedRowsFailure(
	stream: StreamName,
	count: number,
	pageCount: number,
	fieldOmissions: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): QueryFailure {
	return {
		reason: "icloud_omitted_rows",
		message: `iCloud Notes could not fully read or represent ${count} ${stream} row(s); the stream was not checkpointed.`,
		retryable: false,
		pageCount,
		omittedRows: count,
		...(fieldOmissions.size === 0
			? {}
			: {
					fieldOmissions: [...fieldOmissions]
						.flatMap(([field, reasons]) =>
							[...reasons].map((reason) => ({ field, reason })),
						)
						.sort((left, right) =>
							left.field === right.field
								? left.reason.localeCompare(right.reason)
								: left.field.localeCompare(right.field),
						),
				}),
	};
}

function addFieldOmissions(
	target: Map<string, Set<string>>,
	omissions: readonly FieldOmission[],
): void {
	for (const { field, reason } of omissions) {
		const reasons = target.get(field) ?? new Set<string>();
		reasons.add(reason);
		target.set(field, reasons);
	}
}

function withFieldOmissions(
	failure: QueryFailure | undefined,
	stream: StreamName,
	count: number,
	pageCount: number,
	fieldOmissions: ReadonlyMap<string, ReadonlySet<string>>,
): QueryFailure | undefined {
	if (count === 0 && fieldOmissions.size === 0) return failure;
	const rowFailure = omittedRowsFailure(
		stream,
		count,
		pageCount,
		fieldOmissions,
	);
	if (!failure) return rowFailure;
	const mergedFieldOmissions = new Map<string, Set<string>>();
	addFieldOmissions(mergedFieldOmissions, failure.fieldOmissions ?? []);
	for (const [field, reasons] of fieldOmissions) {
		const current = mergedFieldOmissions.get(field) ?? new Set<string>();
		for (const reason of reasons) current.add(reason);
		mergedFieldOmissions.set(field, current);
	}
	const mergedFailure = omittedRowsFailure(
		stream,
		(failure.omittedRows ?? 0) + count,
		pageCount,
		mergedFieldOmissions,
	);
	return {
		...failure,
		omittedRows: (failure.omittedRows ?? 0) + count,
		...(mergedFailure.fieldOmissions === undefined
			? {}
			: { fieldOmissions: mergedFailure.fieldOmissions }),
	};
}

export async function collectAllStreams(
	ctx: BrowserCollectContext,
): Promise<void> {
	const { emit, emitRecord, page, requested, state } = ctx;
	if (!requested.has("notes") && !requested.has("folders")) return;
	const progress = widenProgress(ctx.progress);
	const pageUrl = await requireNotesPage(page);

	const config = await resolveCloudKitConfig(page);
	if (!config) {
		throw new Error("icloud_auth_failed: could not resolve CloudKit config");
	}
	if (!remainsInICloudNotes(page.url(), pageUrl)) {
		throw new Error(
			"icloud_navigation_changed: page changed while resolving CloudKit owner",
		);
	}
	const url = queryUrl(config);
	const needsFolders = requested.has("folders") || requested.has("notes");
	let folderWalk: QueryWalk | null = null;
	let folderScanComplete = false;
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
		const fieldOmissions = new Map<string, Set<string>>();
		for (const record of folderWalk.records) {
			if (record.recordType !== "Folder") continue;
			const result = readFolderRecord(record);
			addFieldOmissions(fieldOmissions, result.unavailableFields);
			const built = result.record;
			if (built === null) {
				omitted += 1;
				continue;
			}
			if (result.unavailableFields.length > 0) {
				omitted += 1;
				unavailableFolderIds.add(built.id);
			}
			if (!validateRecord("folders", built).ok) {
				if (result.unavailableFields.length === 0) omitted += 1;
				continue;
			}
			if (built.name !== null) folderNames.set(built.id, built.name);
		}
		folderScanComplete = hasBoundEndProof(
			folderWalk,
			pageUrl,
			config,
			"folders",
		);

		if (requested.has("folders")) {
			const cursor = openFingerprintCursor(state.folders, {
				excludeFromFingerprint: [],
			});
			let covered = 0;
			for (const record of folderWalk.records) {
				if (record.recordType !== "Folder") continue;
				const result = readFolderRecord(record);
				const built = result.record;
				if (built === null || !validateRecord("folders", built).ok) continue;
				if (cursor.shouldEmit(built)) {
					await emitRecord("folders", built);
				}
				if (result.unavailableFields.length === 0) covered += 1;
			}
			const failure =
				withFieldOmissions(
					folderWalk.failure,
					"folders",
					omitted,
					folderWalk.pageCount,
					fieldOmissions,
				) ??
				(!remainsInICloudNotes(page.url(), pageUrl)
					? {
							reason: "icloud_navigation_changed",
							message:
								"The iCloud Notes page changed before the folders stream could be checkpointed.",
							retryable: true,
							pageCount: folderWalk.pageCount,
						}
					: null);
			if (failure) {
				await emitStreamFailure(emit, "folders", failure);
			} else if (
				hasBoundEndProof(folderWalk, pageUrl, config, "folders") &&
				remainsInICloudNotes(page.url(), pageUrl)
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
		const fieldOmissions = new Map<string, Set<string>>();
		for (const record of walk.records) {
			if (record.recordType !== "Note" || isDeletedNote(record)) continue;
			const result = readNoteRecord(record, folderNames, {
				unavailableFolderIds,
				folderScanComplete,
			});
			addFieldOmissions(fieldOmissions, result.unavailableFields);
			const built = result.record;
			if (built === null || !validateRecord("notes", built).ok) {
				omitted += 1;
				continue;
			}
			if (cursor.shouldEmit(built)) {
				await emitRecord("notes", built);
			}
			if (result.unavailableFields.length === 0) {
				covered += 1;
			} else {
				omitted += 1;
			}
		}
		let failure =
			withFieldOmissions(
				walk.failure,
				"notes",
				omitted,
				walk.pageCount,
				fieldOmissions,
			) ??
			(omitted > 0
				? omittedRowsFailure("notes", omitted, walk.pageCount, fieldOmissions)
				: null);
		if (!failure && !remainsInICloudNotes(page.url(), pageUrl)) {
			failure = {
				reason: "icloud_navigation_changed",
				message:
					"The iCloud Notes page changed before the notes stream could be checkpointed.",
				retryable: true,
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
