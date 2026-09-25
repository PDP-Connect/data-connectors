#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP iCloud Notes Connector (v0.1.0)
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
 * folder_id semantics: per the capability map
 * (docs/migration/connector-cutover/capability-map.json), `notes[].folder`
 * maps to `notes.folder_id` — read as a CloudKit recordName (a foreign key
 * into the `folders` stream's `id`), not a resolved display name. This is
 * simpler than the legacy script, which resolved folder names inline for
 * its own single-document envelope. If that mapping is wrong (i.e. the
 * intent was a resolved name), this is a CONTRACT-CHANGE-REQUEST candidate
 * — see the lane report.
 *
 * KNOWN LIMITATION: note body text (`text_content`) comes from a
 * byte-heuristic decode of `TextDataEncrypted`
 * (`parsers.ts#extractNoteText`), ported verbatim from the legacy script.
 * It is not a real Apple Notes protobuf parse — see that function's doc
 * comment for what it can and cannot recover.
 *
 * Tested surfaces: NONE yet. No live-account run has occurred for this
 * connector (no PROFILE READY issued for this lane as of authoring). All
 * of the above — the CloudKit query shapes, the auth flow, the pagination
 * cursor field names — are carried forward from the legacy script's
 * observed behavior, not independently re-verified against a live account.
 *
 * CHANGES
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
import { probeICloudSession } from "../../packages/polyfill-connectors/src/auto-login/icloud.ts";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import type {
	BrowserCollectContext,
	EnsureSessionArgs,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import {
	buildFolderRecord,
	buildNoteRecord,
	isDeletedNote,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
	CloudKitFetchResult,
	CloudKitQueryResponse,
	CloudKitRecord,
	CloudKitValidateResponse,
} from "./types.ts";

const VALIDATE_URL = "https://setup.icloud.com/setup/ws/1/validate";
const RESULTS_LIMIT = 200;
const MAX_PAGES = 200;

interface ProgressExtra {
	item_count?: number;
	page_index?: number;
	phase?: string;
	stream?: string;
	total_seen?: number;
}

export const ICLOUD_NOTES_RETRYABLE_PATTERN =
	/ECONN|ETIMEDOUT|fetch failed|icloud_rate_limited/i;

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
		probe: () => probeICloudSession(page),
		readinessProbe: probeICloudSession,
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
	if (result.status !== 200 || !isRecord(result.json)) {
		return null;
	}
	const data = result.json as CloudKitValidateResponse;
	const dsid = data.dsInfo?.dsid;
	const ckBaseUrl = data.webservices?.ckdatabasews?.url;
	if ((dsid === undefined || dsid === null) && dsid !== 0) {
		return null;
	}
	if (!ckBaseUrl) {
		return null;
	}
	return { dsid: String(dsid), ckBaseUrl };
}

function queryUrl(config: CloudKitConfigLive): string {
	return `${config.ckBaseUrl}/database/1/com.apple.notes/production/private/records/query?dsid=${config.dsid}`;
}

async function cloudKitQuery(
	page: Page,
	url: string,
	body: Record<string, unknown>,
): Promise<CloudKitFetchResult> {
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
}

function classifyStatus(
	status: number,
): "auth_failed" | "rate_limited" | "http_error" | null {
	if (status === 401 || status === 403) {
		return "auth_failed";
	}
	if (status === 429) {
		return "rate_limited";
	}
	if (status !== 200) {
		return "http_error";
	}
	return null;
}

function assertQueryOk(status: number, label: string): void {
	const klass = classifyStatus(status);
	if (klass === "auth_failed") {
		throw new Error(`icloud_auth_failed: ${status} on ${label}`);
	}
	if (klass === "rate_limited") {
		throw new Error(`icloud_rate_limited: 429 on ${label}`);
	}
	if (klass === "http_error") {
		throw new Error(`icloud_http_${status}: ${label}`);
	}
}

// ─── Folders ────────────────────────────────────────────────────────────

/** Query CloudKit's `parentless` search index — the same query the legacy
 *  script used for the folder list. Not paginated in the legacy script and
 *  kept that way here: `resultsLimit: 200` comfortably covers any real
 *  Notes folder tree (Apple's own UI does not support anywhere near 200
 *  folders in practice). */
async function fetchFolderRecords(
	page: Page,
	url: string,
): Promise<CloudKitRecord[]> {
	const result = await cloudKitQuery(page, url, {
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
	});
	assertQueryOk(result.status, "folders query");
	const body = result.json as CloudKitQueryResponse | null;
	const records = body?.records ?? [];
	return records.filter((r) => r.recordType === "Folder");
}

// ─── Notes ──────────────────────────────────────────────────────────────

/** Paginate CloudKit's `recents` search index via `continuationMarker`,
 *  same as the legacy script. Bounded by MAX_PAGES as a safety cap; a run
 *  that hits it emits SKIP_RESULT rather than looping unbounded. */
async function fetchNoteRecords(
	page: Page,
	url: string,
	progress: (message: string, extra?: ProgressExtra) => Promise<void>,
): Promise<{ records: CloudKitRecord[]; truncated: boolean }> {
	const all: CloudKitRecord[] = [];
	let continuationMarker: string | undefined;
	let truncated = false;

	for (let page_ = 0; page_ < MAX_PAGES; page_ += 1) {
		const body: Record<string, unknown> = {
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
			...(continuationMarker ? { continuationMarker } : {}),
		};
		const result = await cloudKitQuery(page, url, body);
		assertQueryOk(result.status, `notes query page ${page_ + 1}`);
		const responseBody = result.json as CloudKitQueryResponse | null;
		const records = responseBody?.records ?? [];
		all.push(...records);
		await progress("Fetched iCloud Notes page", {
			phase: "page",
			page_index: page_ + 1,
			item_count: records.length,
			total_seen: all.length,
		});
		continuationMarker = responseBody?.continuationMarker;
		if (!continuationMarker) {
			return { records: all, truncated: false };
		}
		if (page_ === MAX_PAGES - 1) {
			truncated = true;
		}
	}
	return { records: all, truncated };
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

export async function collectAllStreams(
	ctx: BrowserCollectContext,
): Promise<void> {
	const { emit, emitRecord, page, requested, state } = ctx;
	const progress = widenProgress(ctx.progress);

	const config = await resolveCloudKitConfig(page);
	if (!config) {
		throw new Error("icloud_auth_failed: could not resolve CloudKit config");
	}
	const url = queryUrl(config);

	if (requested.has("folders")) {
		await progress("Fetching iCloud Notes folders");
		const raw = await fetchFolderRecords(page, url);
		const cursor = openFingerprintCursor(state.folders, {
			excludeFromFingerprint: [],
		});
		let covered = 0;
		for (const record of raw) {
			const built = buildFolderRecord(record);
			if (!built) {
				continue;
			}
			if (cursor.shouldEmit(built)) {
				const validation = validateRecord("folders", built);
				if (validation.ok) {
					covered += 1;
				}
				await emitRecord("folders", built);
			}
		}
		cursor.dropUnseenIds();
		await emit({
			type: "STATE",
			stream: "folders",
			cursor: { fingerprints: cursor.toState() },
		});
		await progress("Emitted iCloud Notes folders", {
			phase: "emit",
			item_count: raw.length,
			total_seen: covered,
		});
	}

	if (requested.has("notes")) {
		await progress("Fetching iCloud Notes");
		const { records: raw, truncated } = await fetchNoteRecords(
			page,
			url,
			progress,
		);
		const cursor = openFingerprintCursor(state.notes, {
			// text_content is deterministically re-derived from the same
			// TextDataEncrypted bytes each run — not a run-clock field — so it
			// participates in the fingerprint like every other field.
			excludeFromFingerprint: [],
		});
		let covered = 0;
		for (const record of raw) {
			if (isDeletedNote(record)) {
				continue;
			}
			const built = buildNoteRecord(record);
			if (!built) {
				continue;
			}
			if (cursor.shouldEmit(built)) {
				const validation = validateRecord("notes", built);
				if (validation.ok) {
					covered += 1;
				}
				await emitRecord("notes", built);
			}
		}
		if (!truncated) {
			cursor.dropUnseenIds();
		}
		await emit({
			type: "STATE",
			stream: "notes",
			cursor: { fingerprints: cursor.toState() },
		});
		if (truncated) {
			await emit({
				type: "SKIP_RESULT",
				stream: "notes",
				reason: "older_pages_deferred_page_budget",
				message: `iCloud Notes stopped at the ${MAX_PAGES}-page limit with more pages still listed`,
				diagnostics: { page_limit: MAX_PAGES, total_seen: raw.length },
			});
		}
		await progress("Emitted iCloud Notes", {
			phase: "emit",
			item_count: raw.length,
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
