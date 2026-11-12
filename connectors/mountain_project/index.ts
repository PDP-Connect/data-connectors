#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Mountain Project connector (v0.1.0).
 *
 * Browser-session connector for mountainproject.com, the rock-climbing route
 * database. The owner signs in in the connector's own browser (email and
 * password, onX, Facebook or Apple); nothing here handles a credential.
 *
 * Collection runs inside the signed-in www.mountainproject.com page with
 * same-origin fetches, three requests per run:
 *
 * - `GET /user/<id>` (301 to `/user/<id>/<slug>`): the owner's profile page.
 *   `<id>` is `window.ap.config.userId`, which every page declares together
 *   with `isLoggedIn`.
 * - `GET /user/<id>/<slug>/tick-export`: the site's own "Export CSV" of every
 *   tick (date, route, grade, notes, URL, pitches, location, stars, style,
 *   lead style, route type, the owner's grade, length, grade code).
 * - `GET /user/<id>/<slug>/todo-export`: the same for the to-do list.
 *
 * Each export is the whole list in one response, so there is no pagination
 * and every run re-reads every tick and saved route (`full_inventory`). The
 * route fields come with each row, so no route page is fetched. The export
 * has no tick id: a tick is keyed `<route_id>:<date>:<n>` (see
 * buildTickRecords). The profile's "View All N" tick count and "All N" to-do
 * count are checked against the export: an export shorter than the count is
 * not claimed complete.
 *
 * Because every run re-derives every record, each stream keeps a per-record
 * fingerprint in its STATE cursor (`fingerprints`, see fingerprint-cursor.ts)
 * and only re-emits a record whose content changed; ids the export no longer
 * lists are dropped from the cursor once the list is proven whole.
 *
 * Streams: profile, ticks, saved_routes.
 *
 * Reachability probe: exempt. Every request needs the owner's signed-in
 * session (browser automation behind a login wall).
 *
 * Tested surfaces (as of 2026-11-11):
 * - A project-owned test account (public profile) was seeded with 5 ticks
 *   (Lead/Redpoint with a multi-line note, the same route the same day again
 *   as Lead/Fell/Hung, TR, Follow on an older date, a boulder Send) and 3
 *   to-dos. Its tick and to-do exports, fetched from the signed-in browser,
 *   are committed as `__fixtures__/canary-*.csv`; the parsers read 5 ticks
 *   and 3 saved routes from them, every record validates, and the counts
 *   match the profile's own "View All 5" and "All 3".
 * - The export endpoints answer `text/csv; charset=UTF-8`, ignore the slug in
 *   the path, and `/user/<id>` answers 301 to `/user/<id>/<slug>`; the profile
 *   page parses as the fixture does (name, member-since, both counts; no
 *   avatar and no location on an account that set none).
 * - The mobile PageShim gate (scripts/pageshim/pageshim.test.mjs) passes
 *   against scripts/pageshim/fixtures/mountain_project.mjs, which serves the
 *   same real exports; the probe there is probeMountainProjectSession, which
 *   never navigates, because the host polls it while the owner signs in.
 * Known untested: a full connector run through the browser handoff
 * (ensureSession then collect) on a real account, private ticks (whether the
 * owner's export includes ticks marked private), accounts with no ticks (an
 * empty export is taken as an empty list), and non-US display settings.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	type BrowserCollectContext,
	buildFullScanCoverageMessage,
	createConnectorFailure,
	type EnsureSessionArgs,
	nowIso,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import {
	buildSavedRouteRecords,
	buildTickRecords,
	ORIGIN,
	parseExportTable,
	parseProfilePage,
	parseSessionConfig,
	type SessionConfig,
	sessionFromConfig,
	TICK_COLUMNS,
	TODO_COLUMNS,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ProfileRecord } from "./types.ts";

export const HOME_URL = `${ORIGIN}/`;
export const SIGN_IN_URL = `${ORIGIN}/auth/login`;
const PROFILE = "profile";
const TICKS = "ticks";
const SAVED_ROUTES = "saved_routes";
const FETCH_TIMEOUT_MS = 60_000;
export const REQUEST_DELAY_MS = 1000;
const SIGN_IN_TIMEOUT_SECONDS = 30 * 60;

export const AUTH_FAILED = "mountain_project_auth_failed";
export const INTERRUPTED = "mountain_project_interrupted";
const RATE_LIMITED = "mountain_project_rate_limited";
const SERVER_ERROR = "mountain_project_server_error";
const NETWORK_ERROR = "mountain_project_network_error";
const INVALID_PAYLOAD = "mountain_project_invalid_payload";

const SIGN_IN_MESSAGE =
	"Sign in to Mountain Project in the secure browser (email, onX, Facebook or Apple), then continue. Collection starts once the session is verified.";

type PageHandle = Pick<Page, "evaluate" | "goto" | "url">;

/** What an in-page fetch returns. It never throws in the page. */
export type MpResponse =
	| { kind: "wrong_origin"; origin: string }
	| { kind: "network_error"; message: string }
	| {
			kind: "response";
			status: number;
			url: string;
			contentType: string;
			body: string;
	  };

type Failure = {
	code: string;
	message: string;
	retryable: boolean;
	/** The session is gone; the run stops. */
	fatal: boolean;
};

type Outcome =
	| { ok: true; body: string; url: string }
	| { ok: false; failure: Failure };

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

// ─── Session ────────────────────────────────────────────────────────────

type SessionState =
	| { kind: "signed_in"; userId: string }
	| { kind: "signed_out" }
	| { kind: "off_origin" }
	| { kind: "unknown" };

/** Read `window.ap.config` from the current page without navigating. */
export async function readSessionState(
	page: PageHandle,
): Promise<SessionState> {
	let shell: { origin: string; config: unknown } | null;
	try {
		shell = await page.evaluate(
			(args: { op: "session" }) => {
				void args;
				const ap = (globalThis as { ap?: { config?: unknown } }).ap;
				const config = ap?.config;
				return {
					origin: location.origin,
					config:
						config && typeof config === "object"
							? {
									isLoggedIn: (config as { isLoggedIn?: unknown }).isLoggedIn,
									userId: (config as { userId?: unknown }).userId,
								}
							: null,
				};
			},
			{ op: "session" as const },
		);
	} catch {
		return { kind: "unknown" };
	}
	if (!shell) return { kind: "unknown" };
	if (shell.origin !== ORIGIN) return { kind: "off_origin" };
	const session = sessionFromConfig(shell.config);
	return stateFromSession(session);
}

function stateFromSession(session: SessionConfig | null): SessionState {
	if (session === null) return { kind: "unknown" };
	if (!session.loggedIn) return { kind: "signed_out" };
	return session.userId === null
		? { kind: "unknown" }
		: { kind: "signed_in", userId: session.userId };
}

/** Never navigates: the readiness check while the owner signs in. */
export async function probeMountainProjectSession(
	page: PageHandle,
): Promise<boolean> {
	return (await readSessionState(page)).kind === "signed_in";
}

/** Same probe, landing the page on mountainproject.com first if needed. */
export async function hasMountainProjectSession(
	page: PageHandle,
): Promise<boolean> {
	if ((await readSessionState(page)).kind === "off_origin") {
		try {
			await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
		} catch {
			return false;
		}
	}
	return probeMountainProjectSession(page);
}

export async function ensureMountainProjectSession(
	args: EnsureSessionArgs,
): Promise<void> {
	const { assist, capture, completeAssistance, page, sendInteraction } = args;
	let state = await readSessionState(page);
	if (state.kind === "off_origin" || state.kind === "unknown") {
		try {
			await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
		} catch {
			connectorDiagnostic("mountain_project", "session_home_unreachable", {});
			throw new Error(INTERRUPTED);
		}
		state = await readSessionState(page);
	}
	if (state.kind === "signed_in") return;
	if (state.kind !== "signed_out") {
		connectorDiagnostic("mountain_project", "session_check_no_answer", {
			state: state.kind,
		});
		throw new Error(INTERRUPTED);
	}
	try {
		await page.goto(SIGN_IN_URL, { waitUntil: "domcontentloaded" });
	} catch {
		connectorDiagnostic("mountain_project", "sign_in_page_unreachable", {});
		throw new Error(INTERRUPTED);
	}
	let ready: boolean;
	try {
		ready = await manualBrowserLogin({
			assist,
			capture,
			completeAssistance,
			isProbeSuccessful: (ok) => ok === true,
			message: SIGN_IN_MESSAGE,
			page,
			probe: () => probeMountainProjectSession(page),
			readinessProbe: probeMountainProjectSession,
			readinessProbeOnHandoffPage: true,
			reason: "login",
			sendInteraction,
			timeoutSeconds: SIGN_IN_TIMEOUT_SECONDS,
		});
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { code?: unknown }).code)
				: null;
		connectorDiagnostic("mountain_project", "sign_in_handoff_failed", { code });
		throw new Error(
			code === "browser_handoff_readiness_timed_out"
				? AUTH_FAILED
				: INTERRUPTED,
		);
	}
	if (!ready) {
		throw new Error(AUTH_FAILED);
	}
}

// ─── Fetch ──────────────────────────────────────────────────────────────

/** Same-origin GET from inside the signed-in page. */
export async function mpFetch(
	page: PageHandle,
	path: string,
): Promise<MpResponse> {
	let result: MpResponse | null;
	try {
		result = await page.evaluate(
			async (args: {
				op: "fetch";
				origin: string;
				path: string;
				timeoutMs: number;
			}) => {
				if (location.origin !== args.origin) {
					return { kind: "wrong_origin" as const, origin: location.origin };
				}
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), args.timeoutMs);
				try {
					const response = await fetch(args.path, {
						credentials: "include",
						redirect: "follow",
						signal: controller.signal,
					});
					return {
						kind: "response" as const,
						status: response.status,
						url: response.url,
						contentType: response.headers.get("content-type") ?? "",
						body: await response.text(),
					};
				} catch (error) {
					return {
						kind: "network_error" as const,
						message: error instanceof Error ? error.message : String(error),
					};
				} finally {
					clearTimeout(timer);
				}
			},
			{
				op: "fetch" as const,
				origin: ORIGIN,
				path,
				timeoutMs: FETCH_TIMEOUT_MS,
			},
		);
	} catch (error) {
		return {
			kind: "network_error",
			message: error instanceof Error ? error.message : String(error),
		};
	}
	return (
		result ?? { kind: "network_error", message: "the page returned no result" }
	);
}

function onSignInPage(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.origin === ORIGIN && parsed.pathname.startsWith("/auth/");
	} catch {
		return false;
	}
}

/** Classify one response. Anything not plainly the expected body fails. */
export function classifyResponse(
	response: MpResponse,
	expect: "csv" | "html",
	label: string,
): Outcome {
	if (response.kind === "wrong_origin") {
		return {
			ok: false,
			failure: {
				code: INTERRUPTED,
				message: `The browser left mountainproject.com while reading ${label}.`,
				retryable: true,
				fatal: true,
			},
		};
	}
	if (response.kind === "network_error") {
		return {
			ok: false,
			failure: {
				code: NETWORK_ERROR,
				message: `Mountain Project could not be reached while reading ${label}.`,
				retryable: true,
				fatal: false,
			},
		};
	}
	const isHtml = /html/i.test(response.contentType);
	const signedOutPage =
		isHtml && parseSessionConfig(response.body)?.loggedIn === false;
	if (
		response.status === 401 ||
		response.status === 403 ||
		onSignInPage(response.url) ||
		(expect === "csv" && signedOutPage) ||
		(expect === "html" && response.status === 200 && signedOutPage)
	) {
		return {
			ok: false,
			failure: {
				code: AUTH_FAILED,
				message: `Mountain Project asked for sign-in while reading ${label}.`,
				retryable: false,
				fatal: true,
			},
		};
	}
	if (response.status === 429) {
		return {
			ok: false,
			failure: {
				code: RATE_LIMITED,
				message: `Mountain Project is limiting requests (HTTP 429 on ${label}).`,
				retryable: true,
				fatal: false,
			},
		};
	}
	if (response.status >= 500) {
		return {
			ok: false,
			failure: {
				code: SERVER_ERROR,
				message: `Mountain Project answered ${label} with HTTP ${response.status}.`,
				retryable: true,
				fatal: false,
			},
		};
	}
	const typeOk =
		expect === "csv" ? /text\/csv/i.test(response.contentType) : isHtml;
	if (response.status !== 200 || !typeOk) {
		return {
			ok: false,
			failure: {
				code: INVALID_PAYLOAD,
				message: `Mountain Project answered ${label} with HTTP ${response.status} (${response.contentType || "no content type"}), not the expected ${expect}.`,
				retryable: false,
				fatal: false,
			},
		};
	}
	return { ok: true, body: response.body, url: response.url };
}

// ─── Collect ────────────────────────────────────────────────────────────

/**
 * The part of the collect context this connector uses, structural so tests
 * can hand-build it.
 */
export interface MountainProjectCollectContext {
	emit: BrowserCollectContext["emit"];
	emitRecord: BrowserCollectContext["emitRecord"];
	isRecordSelected?: BrowserCollectContext["isRecordSelected"];
	page: PageHandle;
	reportStreamFailure?: BrowserCollectContext["reportStreamFailure"];
	requested: BrowserCollectContext["requested"];
	/** Prior STATE cursors by stream; absent on a first run. */
	state?: BrowserCollectContext["state"];
}

export interface MountainProjectCollectOptions {
	requestDelayMs?: number;
}

async function failStream(
	ctx: MountainProjectCollectContext,
	stream: string,
	failure: Failure,
): Promise<void> {
	const recoveryHint = failure.retryable
		? { action: "retry_by_runtime", retryable: true }
		: { action: "retry_on_connector_upgrade", retryable: false };
	connectorDiagnostic("mountain_project", "stream_failed", {
		stream,
		code: failure.code,
	});
	if (ctx.reportStreamFailure) {
		await ctx.reportStreamFailure(stream, failure.message, {
			recoveryHint,
			retryable: failure.retryable,
			diagnostics: { code: failure.code },
		});
		return;
	}
	await ctx.emit({
		type: "SKIP_RESULT",
		stream,
		reason: "stream_collection_failed",
		message: failure.message,
		recovery_hint: recoveryHint,
		diagnostics: { code: failure.code },
	});
}

function stopRun(failure: Failure): Error {
	return createConnectorFailure(failure.code, failure.message, {
		retryable: failure.retryable,
	});
}

async function landOnMountainProject(page: PageHandle): Promise<void> {
	let onSite = false;
	try {
		onSite =
			(await page.evaluate(
				(args: { op: "origin" }) => {
					void args;
					return location.origin;
				},
				{ op: "origin" as const },
			)) === ORIGIN;
	} catch {
		onSite = false;
	}
	if (onSite) return;
	try {
		await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
	} catch {
		throw createConnectorFailure(
			INTERRUPTED,
			"mountainproject.com could not be opened.",
			{ retryable: true },
		);
	}
}

/**
 * Emit one export's records and, when the list is proven whole, its
 * coverage and STATE. `expectedCount` is the profile's own count, when known.
 *
 * Every run re-derives every record, so a record whose fingerprint matches
 * the prior cursor is not re-emitted. Only records the runtime would accept
 * (valid and inside the selected range) pass through the gate: a record the
 * range excludes is handed to the runtime, which drops it, without being
 * fingerprinted, so it is emitted once the range includes it.
 */
async function emitInventory(
	ctx: MountainProjectCollectContext,
	stream: string,
	records: ReadonlyArray<object>,
	details: {
		rows: number;
		unreadable: number;
		duplicates: number;
		expectedCount: number | null;
	},
): Promise<void> {
	const cursor = openFingerprintCursor(ctx.state?.[stream]);
	let considered = 0;
	let invalid = 0;
	let emitted = 0;
	for (const record of records) {
		const data = { ...record } as Record<string, unknown>;
		// Checked here too, so a row the runtime would skip is not counted as covered.
		if (!validateRecord(stream, data).ok) {
			invalid += 1;
			continue;
		}
		if (ctx.isRecordSelected?.(stream, data) ?? true) {
			considered += 1;
			if (!cursor.shouldEmit(data)) continue;
			emitted += 1;
		}
		await ctx.emitRecord(stream, data);
	}
	const unreadable = details.unreadable + invalid;
	const kept = records.length - invalid;
	const short =
		details.expectedCount !== null && details.rows < details.expectedCount;
	await ctx.emit({
		type: "PROGRESS",
		stream,
		count: kept,
		message: `Read ${kept} ${stream === TICKS ? "ticks" : "saved routes"} from the Mountain Project export, ${emitted} new or changed`,
	});
	connectorDiagnostic("mountain_project", "coverage", {
		stream,
		rows: details.rows,
		kept,
		emitted,
		unreadable,
		duplicates: details.duplicates,
		expected_count: details.expectedCount ?? "unknown",
	});
	if (unreadable > 0) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream,
			reason: "records_unreadable",
			message: `${unreadable} ${unreadable === 1 ? "row" : "rows"} of the Mountain Project export had no usable route, date or field values and ${unreadable === 1 ? "was" : "were"} not saved.`,
			diagnostics: { rows: details.rows, unreadable },
		});
		return;
	}
	if (short) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream,
			reason: "export_shorter_than_profile_count",
			message: `The Mountain Project export has ${details.rows} rows but the profile counts ${details.expectedCount}; the list is not claimed complete.`,
			diagnostics: { rows: details.rows, expected: details.expectedCount },
		});
		return;
	}
	await ctx.emit(buildFullScanCoverageMessage(stream, considered));
	// The list is whole: an id it no longer carries is gone from the source.
	cursor.dropUnseenIds();
	await ctx.emit({
		type: "STATE",
		stream,
		cursor: {
			full_scan_at: nowIso(),
			rows: details.rows,
			fingerprints: cursor.toState(),
		},
	});
}

export async function collectMountainProject(
	ctx: MountainProjectCollectContext,
	options: MountainProjectCollectOptions = {},
): Promise<void> {
	const wants = (stream: string) => ctx.requested.has(stream);
	if (!(wants(PROFILE) || wants(TICKS) || wants(SAVED_ROUTES))) return;
	const requestDelayMs = options.requestDelayMs ?? REQUEST_DELAY_MS;

	await landOnMountainProject(ctx.page);
	const state = await readSessionState(ctx.page);
	if (state.kind !== "signed_in") {
		throw createConnectorFailure(
			state.kind === "signed_out" ? AUTH_FAILED : INTERRUPTED,
			state.kind === "signed_out"
				? "The Mountain Project session is signed out."
				: "The Mountain Project page did not report who is signed in.",
			{ retryable: state.kind !== "signed_out" },
		);
	}
	const userId = state.userId;

	// Profile: needed for the canonical path and the list counts, emitted
	// only when requested.
	let profile: ProfileRecord | null = null;
	let profileFailure: Failure | null = null;
	const profileOutcome = classifyResponse(
		await mpFetch(ctx.page, `/user/${userId}`),
		"html",
		"the profile page",
	);
	if (profileOutcome.ok) {
		const parsed = parseProfilePage(
			profileOutcome.body,
			profileOutcome.url,
			userId,
		);
		if (parsed.ok) {
			profile = parsed.record;
		} else {
			profileFailure = {
				code: INVALID_PAYLOAD,
				message: parsed.message,
				retryable: false,
				fatal: false,
			};
		}
	} else {
		if (profileOutcome.failure.fatal) throw stopRun(profileOutcome.failure);
		profileFailure = profileOutcome.failure;
	}
	if (wants(PROFILE)) {
		if (profile && validateRecord(PROFILE, { ...profile }).ok) {
			const cursor = openFingerprintCursor(ctx.state?.[PROFILE]);
			const data = { ...profile };
			if (cursor.shouldEmit(data)) await ctx.emitRecord(PROFILE, data);
			await ctx.emit(buildFullScanCoverageMessage(PROFILE, 1));
			await ctx.emit({
				type: "STATE",
				stream: PROFILE,
				cursor: { fetched_at: nowIso(), fingerprints: cursor.toState() },
			});
		} else {
			await failStream(
				ctx,
				PROFILE,
				profileFailure ?? {
					code: INVALID_PAYLOAD,
					message: "The profile page did not match the profile schema.",
					retryable: false,
					fatal: false,
				},
			);
		}
	}

	// The slug in the export path is not checked by the site (verified live
	// 2026-11-11: `/user/<id>/x/tick-export` serves the export); the canonical
	// one is used when the profile was read.
	const basePath = profile
		? new URL(profile.profile_url).pathname
		: `/user/${userId}/profile`;

	if (wants(TICKS)) {
		await delay(requestDelayMs);
		const outcome = classifyResponse(
			await mpFetch(ctx.page, `${basePath}/tick-export`),
			"csv",
			"the tick export",
		);
		if (!outcome.ok) {
			if (outcome.failure.fatal) throw stopRun(outcome.failure);
			await failStream(ctx, TICKS, outcome.failure);
		} else {
			const table = parseExportTable(outcome.body, TICK_COLUMNS);
			if (!table.ok) {
				await failStream(ctx, TICKS, {
					code: INVALID_PAYLOAD,
					message: `Tick export: ${table.message}`,
					retryable: false,
					fatal: false,
				});
			} else {
				const built = buildTickRecords(table.rows);
				await emitInventory(ctx, TICKS, built.records, {
					rows: table.rows.length,
					unreadable: built.unreadable,
					duplicates: 0,
					expectedCount: profile?.tick_count ?? null,
				});
			}
		}
	}

	if (wants(SAVED_ROUTES)) {
		await delay(requestDelayMs);
		const outcome = classifyResponse(
			await mpFetch(ctx.page, `${basePath}/todo-export`),
			"csv",
			"the to-do export",
		);
		if (!outcome.ok) {
			if (outcome.failure.fatal) throw stopRun(outcome.failure);
			await failStream(ctx, SAVED_ROUTES, outcome.failure);
		} else {
			const table = parseExportTable(outcome.body, TODO_COLUMNS);
			if (!table.ok) {
				await failStream(ctx, SAVED_ROUTES, {
					code: INVALID_PAYLOAD,
					message: `To-do export: ${table.message}`,
					retryable: false,
					fatal: false,
				});
			} else {
				const built = buildSavedRouteRecords(table.rows);
				await emitInventory(ctx, SAVED_ROUTES, built.records, {
					rows: table.rows.length,
					unreadable: built.unreadable,
					duplicates: built.duplicates,
					expectedCount: profile?.todo_count ?? null,
				});
			}
		}
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "mountain_project",
		validateRecord,
		retryablePattern:
			/mountain_project_(?:rate_limited|server_error|network_error|interrupted)|fetch failed/i,
		browser: { profileName: "mountain_project" },
		ensureSession: ensureMountainProjectSession,
		probeSession: ({ page }) => hasMountainProjectSession(page),
		probeSessionIsAuthoritative: true,
		collect: (ctx: BrowserCollectContext) => collectMountainProject(ctx),
	});
}
