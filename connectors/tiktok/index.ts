#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP TikTok connector (v0.1.0).
 *
 * Exports the signed-in owner's own TikTok data from the www.tiktok.com web
 * app: their profile, the videos they posted, the videos they liked, the
 * videos they saved to Favorites, and the
 * accounts they follow and that follow them.
 *
 * Terms of service and legal basis. TikTok's terms do not permit automated
 * access to the service. The owner runs this connector on their own account,
 * in their own signed-in browser session, to obtain a copy of their own
 * personal data: the right of access and the right to data portability
 * (GDPR Articles 15 and 20) and the right to know (CCPA section 1798.110).
 * TikTok's own "Download your data" export is the route its terms allow.
 *
 * Collection. Every request is a same-origin GET made from inside the
 * www.tiktok.com page (page-script.ts). The page reader copies the plain
 * client parameters (aid, app_name, device_id, ...) from a request the web
 * app itself made, then sends its own GET through the page's own fetch, so
 * TikTok's page scripts sign it (msToken, X-Bogus, X-Gnarly) as they sign the
 * app's requests. No signature, token or cookie value is read by this code,
 * logged or kept in STATE: the page reports only whether a request left
 * signed. The sign-in handoff looks only at whether TikTok's sign-in cookies
 * are present and when they expire, never at their values.
 *
 * The in-page request is the only transport: an unsigned request from the
 * owner's session would be a bot signal, so a request the page cannot make or
 * that does not complete stops the run as tiktok_interrupted (retryable).
 *
 * The reader holds the copied client parameters per page: a page TikTok
 * replaces (a redirect or reload) starts with none. A page that makes no
 * qualifying request of its own (the sign-in page, or wherever TikTok lands
 * after it) is moved once to the profile page, whose app reads the person's
 * own videos with the client parameters on the request. Without them nothing
 * is sent: the run stops early as tiktok_interrupted: client_params_not_seen.
 *
 * Session check. Signed in is decided from the account endpoint the
 * collection itself starts with, in the page as it is. The check opens the
 * profile page only when the page is not on www.tiktok.com, or when the page
 * it is on made no request the reader can copy from. A check without an
 * answer keeps its reason. Only an explicit signed-out answer, or a page
 * that still holds no client parameters after that one profile-page open (a
 * browser that never signed in), opens the sign-in page and hands it to the
 * person. A bot check is handed to the person on the page as it is. A
 * temporary or malformed answer is read again a few times in place, then
 * stops the run as tiktok_interrupted, with no navigation and no handoff.
 * Sign-in is ready once TikTok sets its sign-in cookie (or the account
 * endpoint answers signed in); the page then moves to the profile page and
 * collection verifies the account before anything else.
 *
 *   GET /passport/account/info/v2/      -> the owner's id, secUid, handle
 *   GET /api/user/settings/             -> profile.private_account
 *   GET /api/post/item_list/            -> videos (and profile counts)
 *   GET /api/favorite/item_list/        -> likes
 *   GET /api/user/collect/item_list/    -> favorites
 *   GET /api/user/list/ (scene 21 / 67) -> following / followers
 *   GET /api/user/collection_list/      -> favorite_collections
 *   GET /api/collection/item_list/      -> collection_items
 *
 * Every list is paged until TikTok's own `hasMore: false`; a repeated cursor,
 * a page that adds nothing while hasMore is true, or the page cap fails the
 * stream instead of reporting it complete. Nothing that writes (follow, like,
 * post, comment) is reachable: the page reader refuses any other path.
 *
 * Not collected: watch history and search history (the web app exposes
 * neither for the signed-in user in the recorded evidence; both are in
 * TikTok's data export), direct messages (a separate protocol; a later
 * phase), reposts and playlists.
 *
 * Favorites collections: the list (favorite_collections) and, per
 * collection, its videos (collection_items, parent_detail_accounting). The
 * collection item call needs a `sourceType` the app sends; it is copied from
 * the app's own request on the collection's page (opened once when needed),
 * never guessed. A collection whose videos cannot be read is a DETAIL_GAP.
 *
 * Tested surfaces (as of 2026-10-22): a live run in the owner's signed-in
 * Chrome on one small English-language account (profile 1, videos 8, likes
 * 10, favorites 4, following 1, followers 1). Known untested: long lists,
 * private liked lists, incremental second runs, other locales.
 *
 * Reachability probe: exempt. Collection needs a signed-in browser session.
 *
 * Streams: profile, videos, likes, favorites, favorite_collections,
 * collection_items, following, followers.
 *
 * CHANGES
 *   v0.1.0 (2026-10-22): first version.
 *   v0.1.1 (2026-10-22): session check never opens /login without a signed-out
 *     answer; collections end on hasMore and send the app's appId/publicOnly.
 *   v0.1.2 (2026-10-22): likes/favorites walk to hasMore:false every run (no
 *     stop at a known id); profile counts need a usable own video or a proved
 *     empty list; unsafe text fails the stream; challenges classified first.
 *   v0.2.0 (2026-10-22): favorite_collections removed (no evidence of a
 *     collection's item list); the profile walks own videos to one that
 *     carries the owner's counts; any non-JSON body is a challenge.
 *   v0.3.0 (2026-10-22): favorite_collections back from the live list shape,
 *     plus collection_items (each collection's videos, detail coverage).
 *   v0.3.3 (2026-10-24): a session check with no answer (a browser that never
 *     signed in) hands the sign-in page to the person instead of failing.
 *   v0.3.4 (2026-10-24): after a hand sign-in the page moves to the profile
 *     page; a page with no client parameters (none made, or the page was
 *     replaced) gets one wait and at most one profile-page open, then the run
 *     stops early with client_params_not_seen instead of every stream failing
 *     with no_client.
 *   v0.3.5 (2026-10-24): a list read to hasMore:false that then reads the same
 *     ids twice is complete even when TikTok counts more entries than it lists
 *     (the owner's 3 counted Favorites collections, 2 listed): records,
 *     coverage and checkpoints are written and the difference is only a
 *     count_above_listed diagnostic. Collection video lists follow the same
 *     rule. Unconfirmed walks, empty reads and repeats still fail.
 *   v0.3.6 (2026-10-24): a session check without an answer keeps its reason:
 *     only a signed-out answer or a page with no client parameters opens the
 *     sign-in page; a bot check is handed to the person in place; a
 *     temporary or malformed answer is re-read twice, then stops as
 *     tiktok_interrupted with no navigation and no handoff. Sign-in readiness
 *     no longer needs client parameters: a new sign-in cookie (names and
 *     expiry only) is enough, then the profile page opens. A count above the
 *     listed entries is accepted only when no entry was read twice. Session
 *     errors are thrown as bare codes so the runtime keeps them.
 *   v0.3.7 (2026-10-26): Collection Profile semantics. A run limited to a
 *     start date stops the own-videos list once a page proves the rest is
 *     older (newest-first order held, pinned videos aside, a millisecond
 *     cursor before the start); requested resources end a list once all were
 *     read, and collection_items reads only the collections its resources
 *     name. Failures carry portable recovery hints. likes and favorites are
 *     mutable_state and follow the count-above-listed rule; videos declares
 *     no cursor_field (STATE is never read). A collection without an owner
 *     name no longer fails the others; a collection whose answer cannot be
 *     read fails the stream instead of a gap retried forever; pending gaps
 *     beyond START's page are paged in and settled.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type {
	BrowserCollectContext,
	EnsureSessionArgs,
	RecordData,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	emitDetailCoverage,
	emitDetailGap,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	isOutsideTimeRange,
	parseIsoInstant,
} from "../../packages/polyfill-connectors/src/time-range.ts";
import {
	type AllowedPath,
	apiGetExpression,
	type PageApiResult,
	TIKTOK_ORIGIN,
	WATCH_EXPRESSION,
} from "./page-script.ts";
import {
	buildCollectionItemRecord,
	buildCollectionRecord,
	buildProfileRecord,
	buildSavedVideoRecord,
	buildUserRecord,
	buildVideoRecord,
	type Collection,
	collectionItemCount,
	envelopeStatus,
	type Item,
	type ItemPage,
	isSignedOutAccount,
	newTextNotes,
	parseAccount,
	parseCollectionPage,
	parseItemPage,
	parseSettings,
	parseUserPage,
	secondsToInstant,
	type User,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

/** The error classes a fresh run may retry. */
export const TIKTOK_RETRYABLE_PATTERN =
	/tiktok_rate_limited|tiktok_server_error|tiktok_interrupted|tiktok_run_limit_reached/;

export const PROFILE_URL = `${TIKTOK_ORIGIN}/profile`;
export const LOGIN_URL = `${TIKTOK_ORIGIN}/login`;

/** Items per page asked of an item list; TikTok's web app asks for 30-35. */
const ITEM_PAGE_SIZE = "30";
/** Accounts per page asked of /api/user/list/. */
const USER_PAGE_SIZE = "30";
/** Most pages read from one list in one run. Hitting it fails the stream. */
export const MAX_PAGES_PER_LIST = 200;
/** Hard stop on requests in one run, whatever the lists still hold. */
export const MAX_REQUESTS_PER_RUN = 900;
/** Shortest and longest pause between two requests; random in between. */
export const REQUEST_PAUSE_MIN_MS = 1500;
export const REQUEST_PAUSE_MAX_MS = 3000;
/** How long one in-page request may take. */
const REQUEST_TIMEOUT_MS = 20_000;
/** How long the web app may take to make a request of its own. */
const CLIENT_WAIT_MS = 15_000;
const POLL_INTERVAL_MS = 500;
/** How long the session probe waits for the page's own first request. */
const PROBE_CLIENT_WAIT_MS = 10_000;
/**
 * How many times one run may re-acquire client parameters after the page lost
 * them (TikTok replaced the page mid-run). Each time waits, and opens the
 * profile page at most once.
 */
const MAX_CLIENT_RECOVERIES = 2;
/** The stop when the web app made no request the reader can copy from. */
export const CLIENT_NOT_SEEN =
	"client_params_not_seen: TikTok's web app made no request of its own on this page or the profile page, so no request was sent";
/** /api/user/list/ scene numbers used by TikTok's web app. */
const FOLLOWING_SCENE = "21";
const FOLLOWERS_SCENE = "67";

const PROFILE = "profile";
const VIDEOS = "videos";
const LIKES = "likes";
const FAVORITES = "favorites";
const FOLLOWING = "following";
const FOLLOWERS = "followers";
const FAVORITE_COLLECTIONS = "favorite_collections";
const COLLECTION_ITEMS = "collection_items";
/**
 * The order streams run in. likes and favorites come last: they can be the
 * longest lists and may be read twice to settle a count (walkSaved), so the
 * request budget they spend cannot starve the other streams.
 */
const STREAMS = [
	VIDEOS,
	PROFILE,
	FAVORITE_COLLECTIONS,
	COLLECTION_ITEMS,
	FOLLOWING,
	FOLLOWERS,
	LIKES,
	FAVORITES,
] as const;
type Stream = (typeof STREAMS)[number];

const realDelay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The page surface this connector uses. Patchright runs evaluate() in an
 * isolated world by default; the fourth argument opts into the page's main
 * world, where TikTok's own fetch (and its signing) lives. Playwright and the
 * PageShim page take no such argument and already run in the main world.
 */
export interface TikTokPage {
	evaluate(
		script: string,
		arg: undefined,
		options: undefined,
		isolatedContext: false,
	): Promise<unknown>;
	goto(
		url: string,
		options?: { waitUntil?: "domcontentloaded" },
	): Promise<unknown>;
}

/** The part of the collect context this connector uses. */
export interface TikTokCollectContext {
	collectionMode?: BrowserCollectContext["collectionMode"];
	emit: BrowserCollectContext["emit"];
	emitRecord: BrowserCollectContext["emitRecord"];
	page: TikTokPage;
	reportStreamFailure?: BrowserCollectContext["reportStreamFailure"];
	/** Pending detail gaps from earlier runs; absent on hosts that keep none. */
	detailGaps?: BrowserCollectContext["detailGaps"];
	/**
	 * Asks the runtime for the next page of pending detail gaps (START carries
	 * a bounded first page); absent on hosts that page none.
	 */
	requestDetailGapPage?: BrowserCollectContext["requestDetailGapPage"];
	/** When true, only retry `detailGaps`, then return. */
	recoveryOnly?: boolean;
	requested: BrowserCollectContext["requested"];
	state: Record<string, unknown>;
}

export interface TikTokCollectOptions {
	/** Test seams. Production uses the constants above and the real clock. */
	delay?: (ms: number) => Promise<void>;
	maxPages?: number;
	maxRequests?: number;
	random?: () => number;
}

async function evaluateInPage(
	page: TikTokPage,
	script: string,
): Promise<unknown> {
	try {
		return await page.evaluate(script, undefined, undefined, false);
	} catch {
		return null;
	}
}

// ─── failures ────────────────────────────────────────────────────────────

/**
 * Why a request or a list walk stopped. "run" stops end every stream not yet
 * finished; "stream" stops fail only the stream that hit them.
 */
type StopClass =
	| "auth"
	| "challenge"
	| "unsigned"
	| "rate_limited"
	| "server_error"
	| "interrupted"
	| "request_limit"
	| "unreadable"
	| "status_error"
	| "missing_param"
	| "scope"
	| "incomplete";

const RUN_STOPS: ReadonlySet<StopClass> = new Set([
	"auth",
	"challenge",
	"unsigned",
	"rate_limited",
	"server_error",
	"interrupted",
	"request_limit",
]);

const RETRYABLE_STOPS: ReadonlySet<StopClass> = new Set([
	"rate_limited",
	"server_error",
	"interrupted",
	"request_limit",
]);

/** The error class each stop reports, as the message prefix. */
const STOP_CODES: Record<StopClass, string> = {
	auth: "tiktok_auth_failed",
	challenge: "tiktok_bot_check",
	unsigned: "tiktok_request_unsigned",
	rate_limited: "tiktok_rate_limited",
	server_error: "tiktok_server_error",
	interrupted: "tiktok_interrupted",
	request_limit: "tiktok_run_limit_reached",
	unreadable: "tiktok_source_unreadable",
	status_error: "tiktok_api_error",
	missing_param: "tiktok_app_value_not_seen",
	scope: "tiktok_parent_stream_required",
	incomplete: "tiktok_list_incomplete",
};

/**
 * The portable recovery hint (Collection Profile 5.5) each stop suggests. Its
 * `retryable` agrees with RETRYABLE_STOPS, so a hint never says "retry" while
 * the failure says it is not retryable.
 */
export const STOP_HINTS: Record<
	StopClass,
	{ action: string; retryable: boolean }
> = {
	auth: { action: "refresh_credentials", retryable: false },
	// The person clears TikTok's check in their own browser first.
	challenge: { action: "manual_action_required", retryable: false },
	// The page stopped signing as TikTok's own app does: the reader must change.
	unsigned: { action: "retry_on_connector_upgrade", retryable: false },
	rate_limited: { action: "retry_by_runtime", retryable: true },
	server_error: { action: "retry_by_runtime", retryable: true },
	interrupted: { action: "retry_by_runtime", retryable: true },
	request_limit: { action: "retry_by_runtime", retryable: true },
	// An answer this connector does not recognise, or a value TikTok's app no
	// longer sends: a fresh run reads the same; a new connector version must.
	unreadable: { action: "retry_on_connector_upgrade", retryable: false },
	missing_param: { action: "retry_on_connector_upgrade", retryable: false },
	// TikTok refused with its own status code: whether a later run helps is
	// not known.
	status_error: { action: "unknown", retryable: false },
	// The person selects favorite_collections together with collection_items.
	scope: { action: "manual_action_required", retryable: false },
	// The list did not show its end (a repeated cursor, the page cap, fewer
	// entries than counted): not known to clear on a retry.
	incomplete: { action: "unknown", retryable: false },
};

export class TikTokStop extends Error {
	readonly stop: StopClass;
	constructor(stop: StopClass, detail: string) {
		super(`${STOP_CODES[stop]}: ${detail}`);
		this.name = "TikTokStop";
		this.stop = stop;
	}
}

// ─── the one path to the API ─────────────────────────────────────────────

type Params = Record<string, string>;

/** One GET from inside the page, signed by TikTok's own page scripts. */
async function fetchFromPage(
	page: TikTokPage,
	path: AllowedPath,
	params: Params,
): Promise<PageApiResult | null> {
	const result = await evaluateInPage(
		page,
		apiGetExpression(path, params, REQUEST_TIMEOUT_MS),
	);
	return result !== null && typeof result === "object"
		? (result as PageApiResult)
		: null;
}

/**
 * The in-page request is the only transport. TikTok signs each request in the
 * page; an unsigned request sent from a person's session is a bot signal, so
 * a request that cannot be made or does not complete in the page fails the
 * run (tiktok_interrupted, retryable) and is never re-sent another way.
 */
export const fetchApi = fetchFromPage;

function createApi(page: TikTokPage, options: TikTokCollectOptions) {
	const delay = options.delay ?? realDelay;
	const random = options.random ?? Math.random;
	const maxRequests = options.maxRequests ?? MAX_REQUESTS_PER_RUN;
	let requests = 0;
	let recoveries = 0;
	let transport: string | null = null;
	let signed: boolean | null = null;

	const get = async (path: AllowedPath, params: Params): Promise<unknown> => {
		if (requests >= maxRequests) {
			throw new TikTokStop(
				"request_limit",
				`this run reached its limit of ${maxRequests} requests`,
			);
		}
		if (requests > 0) {
			const span = REQUEST_PAUSE_MAX_MS - REQUEST_PAUSE_MIN_MS + 1;
			await delay(REQUEST_PAUSE_MIN_MS + Math.floor(random() * span));
		}
		requests += 1;
		let result = await fetchApi(page, path, params);
		if (result?.kind === "no_client") {
			// The reader checks for client parameters before it sends, so
			// nothing left the page. The page lost them: TikTok replaced it
			// (a redirect or reload after sign-in) and the new page has not
			// made its own request yet. Wait for it, open the profile page at
			// most once, then ask once more; never an unsigned request.
			if (recoveries >= MAX_CLIENT_RECOVERIES) {
				throw new TikTokStop("interrupted", `${path}: ${CLIENT_NOT_SEEN}`);
			}
			recoveries += 1;
			connectorDiagnostic("tiktok", "client_params_lost", {});
			if (!(await prepareReader(page, delay))) {
				throw new TikTokStop("interrupted", `${path}: ${CLIENT_NOT_SEEN}`);
			}
			result = await fetchApi(page, path, params);
		}
		if (result === null) {
			throw new TikTokStop("interrupted", `the page did not answer ${path}`);
		}
		switch (result.kind) {
			case "response":
				break;
			case "refused":
				throw new TikTokStop("unreadable", `the page reader refused ${path}`);
			case "missing_param":
				throw new TikTokStop(
					"missing_param",
					`${path} needs a value the web app sends (sourceType) and the app has not sent it in this page`,
				);
			default:
				throw new TikTokStop(
					"interrupted",
					`${path} did not complete (${result.kind})`,
				);
		}
		transport ??= result.transport;
		if (result.signed) signed = true;
		else signed ??= false;
		if (result.status === 401) {
			throw new TikTokStop("auth", `${path} answered 401`);
		}
		// A bot check comes before every status rule: an HTML page or a
		// cf-mitigated header is a challenge whatever the status (a 503
		// challenge page is not a server error).
		if (result.html || result.challengeHeader === true) {
			throw new TikTokStop(
				"challenge",
				`${path} answered ${result.status} with a challenge instead of data`,
			);
		}
		// Every path here is a JSON endpoint. A body that is not its JSON, at
		// any status (a plain-text 503 included), is the site answering with
		// something else: a challenge, never a retryable server error.
		if (
			!result.empty &&
			(result.json === null || typeof result.json !== "object")
		) {
			throw new TikTokStop(
				"challenge",
				`${path} answered ${result.status} with a body that is not JSON`,
			);
		}
		if (result.status === 429) {
			throw new TikTokStop("rate_limited", `${path} answered 429`);
		}
		if (result.status >= 500) {
			throw new TikTokStop("server_error", `${path} answered ${result.status}`);
		}
		if (result.status === 403) {
			throw new TikTokStop("challenge", `${path} answered 403`);
		}
		if (result.status !== 200) {
			throw new TikTokStop("status_error", `${path} answered ${result.status}`);
		}
		if (result.empty) {
			// TikTok answers a request it will not serve with 200 and no body.
			throw result.signed
				? new TikTokStop(
						"challenge",
						`${path} answered with an empty body to a signed request`,
					)
				: new TikTokStop(
						"unsigned",
						`${path} answered with an empty body; the page did not sign the request`,
					);
		}
		if (result.json === null || typeof result.json !== "object") {
			throw new TikTokStop(
				"challenge",
				`${path} answered ${result.status} with a body that is not JSON`,
			);
		}
		const status = envelopeStatus(result.json);
		if (status !== null && status !== 0) {
			throw new TikTokStop(
				"status_error",
				`${path} answered status code ${status}`,
			);
		}
		return result.json;
	};

	return {
		get,
		requests: () => requests,
		/** Requests this run may still send before its limit. */
		remaining: () => Math.max(0, maxRequests - requests),
		transport: () => transport,
		signed: () => signed,
	};
}

type Api = ReturnType<typeof createApi>;

// ─── session ─────────────────────────────────────────────────────────────

interface WatchStatus {
	client?: boolean;
	/** Per path: whether the app's own request carried the copied keys. */
	copied?: Record<string, boolean>;
	transport?: string | null;
	wrongPage?: boolean;
}

async function watch(page: TikTokPage): Promise<WatchStatus | null> {
	const status = await evaluateInPage(page, WATCH_EXPRESSION);
	return status !== null && typeof status === "object"
		? (status as WatchStatus)
		: null;
}

/** Poll the page until its app has made a request the reader copies from. */
async function waitForClient(
	page: TikTokPage,
	delay: (ms: number) => Promise<void>,
): Promise<boolean> {
	for (let waited = 0; waited < CLIENT_WAIT_MS; waited += POLL_INTERVAL_MS) {
		await delay(POLL_INTERVAL_MS);
		const status = await watch(page);
		if (status?.client === true) return true;
	}
	return false;
}

/**
 * Make sure the page is the TikTok web app and the reader holds its client
 * parameters. A www.tiktok.com page gets the client wait first, in place;
 * a page that is off the site, or made no request the reader can copy from
 * in that wait (the sign-in page, or where TikTok lands after it), is moved
 * once to the profile page, whose app reads the person's own videos with the
 * client parameters on the request, and waited on again. Callers await every
 * in-page request first, so no request of this connector is in flight when it
 * navigates. Returns whether client parameters were seen; without them no
 * request can be sent.
 */
async function prepareReader(
	page: TikTokPage,
	delay: (ms: number) => Promise<void>,
): Promise<boolean> {
	const first = await watch(page);
	if (first?.client === true) return true;
	if (first !== null && first.wrongPage !== true) {
		if (await waitForClient(page, delay)) return true;
	}
	await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded" });
	return waitForClient(page, delay);
}

export type SessionState = "signed_in" | "signed_out" | "unknown";

/**
 * Why a session check has no answer:
 *   no_client  the page holds no client parameters (a fresh profile whose app
 *              never made a request of its own, or a page off the site), so
 *              the account request was never sent;
 *   challenge  TikTok answered with a bot check (an HTML page, a
 *              cf-mitigated header, a 403, or a body that is not JSON);
 *   transient  the request did not complete, or answered 429, 5xx, another
 *              non-200 status or an empty body;
 *   malformed  a 200 JSON answer that names neither an account nor a
 *              signed-out session.
 */
export type UnknownReason =
	| "no_client"
	| "challenge"
	| "transient"
	| "malformed";

export type SessionCheck =
	| { state: "signed_in" | "signed_out" }
	| { state: "unknown"; reason: UnknownReason };

/** Re-reads of the account endpoint after a transient or malformed answer. */
const SESSION_CHECK_RETRIES = 2;
/** Pause before each of those re-reads. */
const SESSION_RETRY_DELAY_MS = 3000;
/**
 * The cookies TikTok sets on sign-in. Only their names and expiry are looked
 * at, never their values.
 */
const SESSION_COOKIES: ReadonlySet<string> = new Set([
	"sessionid",
	"sessionid_ss",
	"sid_tt",
]);

/**
 * The account endpoint (the same request the collection starts with), read
 * in the page as it is, with the reason behind a missing answer. "signed_out"
 * requires an explicit unauthenticated answer. It never navigates.
 */
export async function readSessionCheck(
	page: TikTokPage,
	delay: (ms: number) => Promise<void> = realDelay,
): Promise<SessionCheck> {
	const noClient = { state: "unknown", reason: "no_client" } as const;
	const challenge = { state: "unknown", reason: "challenge" } as const;
	const transient = { state: "unknown", reason: "transient" } as const;
	let status = await watch(page);
	if (!status || status.wrongPage === true) return noClient;
	// A page that just loaded may not have finished its own first request, so
	// the reader holds no client parameters yet. Wait for it (bounded, no
	// navigation) instead of reading "no answer" as a missing session.
	for (
		let waited = 0;
		status?.client !== true && waited < PROBE_CLIENT_WAIT_MS;
		waited += POLL_INTERVAL_MS
	) {
		await delay(POLL_INTERVAL_MS);
		status = await watch(page);
		if (!status || status.wrongPage === true) return noClient;
	}
	const result = await fetchApi(page, "/passport/account/info/v2/", {});
	if (result?.kind === "no_client" || result?.kind === "wrong_origin")
		return noClient;
	if (result?.kind !== "response") return transient;
	// A bot check comes before every status rule, as in the collection.
	if (result.html || result.challengeHeader === true) return challenge;
	if (
		!result.empty &&
		(result.json === null || typeof result.json !== "object")
	)
		return challenge;
	if (result.status === 401) return { state: "signed_out" };
	if (result.status === 403) return challenge;
	if (result.status !== 200 || result.empty) return transient;
	if (parseAccount(result.json) !== null) return { state: "signed_in" };
	return isSignedOutAccount(result.json)
		? { state: "signed_out" }
		: { state: "unknown", reason: "malformed" };
}

/**
 * Whether the account endpoint names a signed-in account (readSessionCheck
 * without the reason). It never navigates.
 */
export async function readSessionState(
	page: TikTokPage,
	delay: (ms: number) => Promise<void> = realDelay,
): Promise<SessionState> {
	return (await readSessionCheck(page, delay)).state;
}

/**
 * Whether the page holds a signed-in TikTok session. It does not navigate:
 * safe to repeat while the owner signs in.
 */
export async function probeTikTokSession(
	page: TikTokPage,
	delay: (ms: number) => Promise<void> = realDelay,
): Promise<boolean> {
	return (await readSessionState(page, delay)) === "signed_in";
}

/**
 * The session check that may navigate, used where no one is signing in. It
 * opens the profile page only when the page is not on www.tiktok.com or made
 * no request the reader can copy from.
 */
export async function checkTikTokSessionDetail(
	page: TikTokPage,
	delay: (ms: number) => Promise<void> = realDelay,
): Promise<SessionCheck> {
	const first = await readSessionCheck(page, delay);
	if (first.state !== "unknown") return first;
	await prepareReader(page, delay);
	return readSessionCheck(page, delay);
}

export async function checkTikTokSession(
	page: TikTokPage,
	delay: (ms: number) => Promise<void> = realDelay,
): Promise<SessionState> {
	return (await checkTikTokSessionDetail(page, delay)).state;
}

/** The part of the browser context the sign-in readiness reads. */
interface CookieJar {
	cookies(
		urls?: string | string[],
	): Promise<readonly { expires?: number; name: string }[]>;
}

/** Sign-in cookies present now, by name, with their expiry. */
async function sessionCookies(
	context: unknown,
): Promise<Map<string, number> | null> {
	const jar = context as Partial<CookieJar> | null | undefined;
	if (typeof jar?.cookies !== "function") return null;
	try {
		const cookies = await jar.cookies(`${TIKTOK_ORIGIN}/`);
		const found = new Map<string, number>();
		for (const cookie of cookies)
			if (SESSION_COOKIES.has(cookie.name))
				found.set(cookie.name, cookie.expires ?? -1);
		return found;
	} catch {
		return null;
	}
}

/**
 * Sign-in readiness that needs no client parameters and never navigates:
 * TikTok set a sign-in cookie that was not there, or not with that expiry,
 * when the handoff began (a stale cookie of a signed-out session does not
 * count). Otherwise the account endpoint answering signed in, when the page
 * holds client parameters.
 */
export function signInReadiness(
	context: unknown,
	before: Map<string, number> | null,
	delay: (ms: number) => Promise<void>,
): { byCookie: () => boolean; probe: (page: TikTokPage) => Promise<boolean> } {
	let byCookie = false;
	return {
		byCookie: () => byCookie,
		probe: async (page) => {
			// Without a baseline (the jar could not be read when the handoff
			// began) a cookie cannot be told apart from one left by an old
			// session, so only the account endpoint can say the person is in.
			const now = before === null ? null : await sessionCookies(context);
			if (now !== null) {
				for (const [name, expires] of now) {
					if (before?.get(name) !== expires) {
						byCookie = true;
						return true;
					}
				}
			}
			return probeTikTokSession(page, delay);
		},
	};
}

const SIGN_IN_MESSAGE =
	"Sign in to TikTok in the secure browser, then continue. Collection starts once the session is verified.";
const CHALLENGE_MESSAGE =
	"TikTok is showing a check in the secure browser. Complete it there, then continue. Collection starts once TikTok answers again.";

export async function ensureTikTokSession(
	args: EnsureSessionArgs,
	/** Test seam: production uses the real clock. */
	delay: (ms: number) => Promise<void> = realDelay,
): Promise<void> {
	const { assist, capture, completeAssistance, page, sendInteraction } = args;
	const context: unknown = args.context;
	// One non-navigating check, then at most one navigation to the web app
	// (checkTikTokSessionDetail). Only a verified signed-in answer skips the
	// handoff; the page is never moved away from a session that answered.
	let check = await checkTikTokSessionDetail(page, delay);
	// A transient or malformed answer is not evidence of anything: re-read a
	// few times in place (no navigation, no handoff), then stop retryably.
	for (
		let retry = 0;
		check.state === "unknown" &&
		(check.reason === "transient" || check.reason === "malformed") &&
		retry < SESSION_CHECK_RETRIES;
		retry += 1
	) {
		await delay(SESSION_RETRY_DELAY_MS);
		check = await readSessionCheck(page, delay);
	}
	if (check.state === "signed_in") return;
	if (
		check.state === "unknown" &&
		(check.reason === "transient" || check.reason === "malformed")
	) {
		// The runtime keeps a thrown session error's code only when the whole
		// message is the code, so the detail goes to a diagnostic.
		connectorDiagnostic("tiktok", "session_check_no_answer", {
			reason: check.reason,
			reads: SESSION_CHECK_RETRIES + 2,
		});
		throw new Error("tiktok_interrupted");
	}
	const handOff = async (
		message: string,
		readiness: (page: TikTokPage) => Promise<boolean>,
	): Promise<void> => {
		const ready = await manualBrowserLogin({
			assist,
			autoProbeIntervalMs: 5000,
			capture,
			completeAssistance,
			isProbeSuccessful: (ok) => ok === true,
			message,
			page,
			probe: () => readiness(page),
			readinessProbe: readiness,
			readinessProbeOnHandoffPage: true,
			sendInteraction,
			timeoutSeconds: 30 * 60,
		});
		if (!ready) {
			connectorDiagnostic("tiktok", "sign_in_not_completed", {});
			throw new Error("tiktok_auth_failed");
		}
	};
	if (check.state === "unknown" && check.reason === "challenge") {
		// A signed-in session behind a bot check: the person clears it on the
		// page as it is. Done once the account endpoint answers signed in.
		await handOff(CHALLENGE_MESSAGE, (p) => probeTikTokSession(p, delay));
		return;
	}
	// Signed out, or a fresh profile whose app never made a request the
	// reader copies from even after the one profile-page open: the sign-in
	// page goes to the person.
	await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
	const before = await sessionCookies(context);
	const readiness = signInReadiness(context, before, delay);
	await handOff(SIGN_IN_MESSAGE, readiness.probe);
	// The person is signed in and nothing of this connector is in flight. The
	// page is the sign-in page or wherever TikTok sent them after it, which
	// may make no request the reader copies from, and TikTok may still replace
	// it. Start collection from the profile page, where collection verifies
	// the account before it reads anything else.
	await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded" });
	if (!readiness.byCookie()) return;
	// Ready on the cookie alone: the account endpoint, now reachable from the
	// profile page, must not answer signed out. Any other answer is left to
	// the collection's own first request.
	const after = await readSessionCheck(page, delay);
	if (after.state === "signed_out") {
		connectorDiagnostic("tiktok", "sign_in_cookie_not_signed_in", {});
		throw new Error("tiktok_auth_failed");
	}
}

// ─── list walks ──────────────────────────────────────────────────────────

interface WalkResult {
	/** Entries the pages returned, repeats included. */
	entries: number;
	/** Pages read to reach hasMore:false. */
	pages: number;
	/** Field paths (never values) that made entries unreadable. */
	failedFields?: string[];
	/** Distinct items handed to `onItem`. */
	read: number;
	/**
	 * True when `stopAfterPage` ended the walk before TikTok's hasMore:false:
	 * the run asked for less than the whole list (a time range or resources),
	 * so TikTok's count of the whole list does not apply.
	 */
	stopped: boolean;
	total: number | null;
	unreadable: number;
}

/**
 * Walk one item list (post, favorite, collect) from the newest page until
 * TikTok says `hasMore: false`. That is the only way a walk completes: a
 * known id is not an end (a list can hold new items below one), and any
 * other ending throws: a repeated cursor, a page that adds nothing while
 * hasMore is true, a missing cursor or the page cap. The one exception is
 * `stopAfterPage`: after a page whose items were all handed on, it may end a
 * walk the run's scope proves needs nothing more (`stopped: true`).
 */
async function walkItemList(
	api: Api,
	path: AllowedPath,
	base: Params,
	maxPages: number,
	onItem: (item: Item) => Promise<void>,
	stopAfterPage?: (page: ItemPage) => boolean,
): Promise<WalkResult> {
	const seenCursors = new Set<string>();
	const seenIds = new Set<string>();
	let cursor = "0";
	let read = 0;
	let entries = 0;
	let unreadable = 0;
	let total: number | null = null;
	const failedFields = new Set<string>();
	for (let pages = 0; ; pages += 1) {
		if (pages >= maxPages) {
			throw new TikTokStop(
				"incomplete",
				`${path} still had more after ${maxPages} pages`,
			);
		}
		seenCursors.add(cursor);
		const json = await api.get(path, {
			...base,
			count: ITEM_PAGE_SIZE,
			cursor,
		});
		const page = parseItemPage(json);
		if (!page) {
			throw new TikTokStop(
				"unreadable",
				`${path} answered a page this connector does not recognise`,
			);
		}
		if (page.total !== null) total = Math.max(total ?? 0, page.total);
		unreadable += page.unreadable;
		if (page.failed.length > 0) {
			connectorDiagnostic("tiktok", "item_unreadable", {
				path,
				fields: page.failed.join(","),
			});
			for (const field of page.failed) failedFields.add(field);
		}
		if (page.dropped.length > 0) {
			// Paths only, never values: which context fields came in another type.
			connectorDiagnostic("tiktok", "item_fields_dropped", {
				path,
				fields: page.dropped.join(","),
			});
		}
		let added = 0;
		entries += page.items.length;
		for (const item of page.items) {
			if (seenIds.has(item.id)) continue;
			seenIds.add(item.id);
			added += 1;
			await onItem(item);
			read += 1;
		}
		if (!page.hasMore || stopAfterPage?.(page) === true) {
			return {
				entries,
				read,
				stopped: page.hasMore,
				total,
				unreadable,
				failedFields: [...failedFields],
				pages: pages + 1,
			};
		}
		if (added === 0 && page.unreadable === 0) {
			throw new TikTokStop(
				"incomplete",
				`${path} said it had more but its page added nothing new`,
			);
		}
		const next = page.cursor;
		if (next === null || next === "" || seenCursors.has(next)) {
			throw new TikTokStop(
				"incomplete",
				`${path} said it had more but gave no new cursor`,
			);
		}
		cursor = next;
	}
}

/** Walk /api/user/list/ for one scene until TikTok says `hasMore: false`. */
async function walkUserList(
	api: Api,
	secUid: string,
	scene: string,
	maxPages: number,
	onUser: (user: User) => Promise<void>,
	stopAfterPage?: () => boolean,
): Promise<{
	read: number;
	stopped: boolean;
	total: number | null;
	unreadable: number;
}> {
	const seenCursors = new Set<number>();
	const seenIds = new Set<string>();
	let minCursor = 0;
	let unreadable = 0;
	let total: number | null = null;
	for (let pages = 0; ; pages += 1) {
		if (pages >= maxPages) {
			throw new TikTokStop(
				"incomplete",
				`/api/user/list/ still had more after ${maxPages} pages`,
			);
		}
		seenCursors.add(minCursor);
		const json = await api.get("/api/user/list/", {
			secUid,
			count: USER_PAGE_SIZE,
			maxCursor: "0",
			minCursor: String(minCursor),
			scene,
		});
		const page = parseUserPage(json);
		if (!page) {
			throw new TikTokStop(
				"unreadable",
				"/api/user/list/ answered a page this connector does not recognise",
			);
		}
		if (page.total !== null) total = Math.max(total ?? 0, page.total);
		unreadable += page.unreadable;
		let added = 0;
		for (const user of page.users) {
			if (seenIds.has(user.id)) continue;
			seenIds.add(user.id);
			added += 1;
			await onUser(user);
		}
		if (!page.hasMore) {
			if (page.isTruncated) {
				throw new TikTokStop(
					"incomplete",
					`TikTok cut this list short after ${seenIds.size} accounts`,
				);
			}
			return { read: seenIds.size, stopped: false, total, unreadable };
		}
		if (stopAfterPage?.() === true) {
			return { read: seenIds.size, stopped: true, total, unreadable };
		}
		if (added === 0 && page.unreadable === 0) {
			throw new TikTokStop(
				"incomplete",
				"/api/user/list/ said it had more but its page added nothing new",
			);
		}
		const next = page.minCursor;
		if (next === null || seenCursors.has(next)) {
			throw new TikTokStop(
				"incomplete",
				"/api/user/list/ said it had more but gave no new cursor",
			);
		}
		minCursor = next;
	}
}

// ─── state ───────────────────────────────────────────────────────────────

// ─── collection ──────────────────────────────────────────────────────────

/**
 * The checks every finished list goes through before its STATE: unreadable
 * entries and fewer distinct entries than TikTok counted both fail the
 * stream. A terminal page does not account for missing entries. A walk the
 * run's scope ended early (`stopped`) read only part of the list on purpose,
 * so TikTok's count of the whole list is not held against it.
 */
function assertComplete(
	stream: Stream,
	walk: {
		failedFields?: string[];
		read: number;
		stopped?: boolean;
		total: number | null;
		unreadable: number;
	},
): void {
	if (walk.unreadable > 0) {
		const fields =
			walk.failedFields && walk.failedFields.length > 0
				? ` (fields: ${walk.failedFields.join(", ")})`
				: "";
		throw new TikTokStop(
			"unreadable",
			`${walk.unreadable} ${stream} ${walk.unreadable === 1 ? "entry" : "entries"} did not match the recorded shape${fields}`,
		);
	}
	if (walk.stopped !== true && walk.total !== null && walk.read < walk.total) {
		throw new TikTokStop(
			"incomplete",
			`TikTok counted ${walk.total} ${stream} but only ${walk.read} distinct entries could be read`,
		);
	}
}

/**
 * A count above the distinct entries read, for a list that ended on TikTok's
 * own hasMore:false and then read the same ids twice in a row (`confirmed`):
 * TikTok's count also holds entries its list never returns (a hidden or
 * removed collection, an unavailable video), so the list is complete and the
 * difference is only a diagnostic, counts only. It is still the incomplete
 * failure when the walk was not confirmed, when nothing was read, or when the
 * pages returned any entry twice (a repeat may stand in for an entry,
 * whatever the count). Returns true when such a difference was accepted.
 */
function settleCount(
	stream: Stream,
	walk: {
		confirmed: boolean;
		entries: number;
		read: number;
		total: number | null;
	},
): boolean {
	if (walk.total === null || walk.read >= walk.total) return false;
	// Only a walk without duplicate rows: a repeated entry may stand in for
	// one TikTok counts but did not return.
	if (walk.confirmed && walk.read > 0 && walk.entries === walk.read) {
		connectorDiagnostic("tiktok", "count_above_listed", {
			stream,
			counted: walk.total,
			read: walk.read,
		});
		return true;
	}
	assertComplete(stream, { read: walk.read, total: walk.total, unreadable: 0 });
	return false;
}

/**
 * Whether a page of the owner's own videos proves that the rest of the list
 * lies before `since`. TikTok lists them newest first, with pinned videos on
 * top whatever their age, and pages on a cursor that is a posting time in
 * milliseconds. The proof needs all of: no unreadable entry on the page, at
 * least one unpinned video, every unpinned video posted before `since`, no
 * pin marker dropped for its type, and a next cursor that is a millisecond
 * time no later than the page's oldest unpinned video and itself before
 * `since`. The caller also requires that
 * every unpinned video read so far came newest first; any doubt reads on.
 */
export function pageBeforeSince(page: ItemPage, since: string): boolean {
	if (page.unreadable > 0) return false;
	// A pin marker TikTok sent in another type was dropped: which videos are
	// pinned is then unknown, so nothing is proved.
	if (page.dropped.includes("isPinnedItem")) return false;
	const listed = page.items.filter((item) => item.isPinnedItem !== true);
	if (listed.length === 0) return false;
	const before = (instant: string): boolean =>
		isOutsideTimeRange({ since }, instant);
	if (!listed.every((item) => before(secondsToInstant(item.createTime))))
		return false;
	const cursor = page.cursor;
	if (cursor === null || !/^[0-9]{13}$/.test(cursor)) return false;
	const cursorMs = Number(cursor);
	const oldest = Math.min(...listed.map((item) => item.createTime));
	return (
		cursorMs <= oldest * 1000 + 999 && before(new Date(cursorMs).toISOString())
	);
}

export async function collectTikTok(
	ctx: TikTokCollectContext,
	options: TikTokCollectOptions = {},
): Promise<void> {
	const requested = STREAMS.filter((stream) => ctx.requested.has(stream));
	if (requested.length === 0) return;
	const delay = options.delay ?? realDelay;
	const maxPages = options.maxPages ?? MAX_PAGES_PER_LIST;
	const notes = newTextNotes();
	const finished = new Set<Stream>();

	const fail = async (stream: Stream, error: TikTokStop): Promise<void> => {
		finished.add(stream);
		const retryable = RETRYABLE_STOPS.has(error.stop);
		const recoveryHint = { ...STOP_HINTS[error.stop], retryable };
		if (ctx.reportStreamFailure) {
			await ctx.reportStreamFailure(stream, error.message, {
				retryable,
				recoveryHint,
			});
		} else {
			await ctx.emit({
				type: "SKIP_RESULT",
				stream,
				reason: "stream_collection_failed",
				message: error.message,
				recovery_hint: recoveryHint,
			});
		}
	};
	/** End the run: every requested stream not finished reports why. */
	const stopRun = async (error: TikTokStop): Promise<void> => {
		connectorDiagnostic("tiktok", "run_stopped", { stop: error.stop });
		for (const stream of requested) {
			if (!finished.has(stream)) await fail(stream, error);
		}
	};

	if (!(await prepareReader(ctx.page, delay))) {
		// Nothing could be signed, so nothing is sent: one clear stop instead
		// of every stream failing on its first request.
		connectorDiagnostic("tiktok", "client_params_not_seen", {});
		await stopRun(new TikTokStop("interrupted", CLIENT_NOT_SEEN));
		return;
	}
	const api = createApi(ctx.page, options);

	const accountJson = await api
		.get("/passport/account/info/v2/", {})
		.catch((error: unknown) => error);
	if (accountJson instanceof TikTokStop) {
		if (accountJson.stop === "auth") throw accountJson;
		await stopRun(accountJson);
		return;
	}
	if (accountJson instanceof Error) throw accountJson;
	const account = parseAccount(accountJson);
	if (!account) {
		throw new Error(
			"tiktok_auth_failed: TikTok's account endpoint returned no signed-in account",
		);
	}
	const secUid = account.secUid;
	/** Base query of the owner's own item lists. */
	const ownList: Params = { secUid, coverFormat: "2" };

	/**
	 * The ids the run asked for in `stream` (its resources), tracked as the
	 * list is read: `done` once every one was read, so the walk can end there.
	 * Null when the run asked for the whole stream. Record ids are TikTok's
	 * own video or account ids, so a list entry and a resource compare as is.
	 */
	const resourceTracker = (
		stream: Stream,
	): { done: () => boolean; see: (id: string) => void } | null => {
		const resources = ctx.requested.get(stream)?.resources;
		if (!Array.isArray(resources) || resources.length === 0) return null;
		const wanted = new Set(resources.map(String));
		const found = new Set<string>();
		return {
			done: () => found.size === wanted.size,
			see: (id) => {
				if (wanted.has(id)) found.add(id);
			},
		};
	};

	/** The run's `since` for `stream`, when it is a valid RFC 3339 instant. */
	const pushableSince = (stream: Stream): string | null => {
		const since = ctx.requested.get(stream)?.time_range?.since;
		return typeof since === "string" && parseIsoInstant(since) !== null
			? since
			: null;
	};

	/** Records withheld per stream because a present text was not safe text. */
	const unsafe = new Map<Stream, number>();
	/**
	 * Build a record and emit it, unless one of its present text values was
	 * not safe text: that record is withheld and counted, and the stream then
	 * fails before its STATE (assertSafe). Null stays for absent values only.
	 */
	const emitBuilt = async (
		stream: Stream,
		build: () => RecordData,
	): Promise<void> => {
		const before = notes.replaced;
		const record = build();
		if (notes.replaced > before) {
			unsafe.set(stream, (unsafe.get(stream) ?? 0) + 1);
			return;
		}
		await ctx.emitRecord(stream, record);
	};
	const assertSafe = (stream: Stream): void => {
		const count = unsafe.get(stream) ?? 0;
		if (count > 0) {
			connectorDiagnostic("tiktok", "unsafe_text", { stream, count });
			throw new TikTokStop(
				"unreadable",
				`${count} ${stream} ${count === 1 ? "entry carries" : "entries carry"} text that is not safe text and ${count === 1 ? "was" : "were"} not saved`,
			);
		}
	};

	let ownFirstItem: Item | null = null;
	let ownFirstItemRead = false;

	/**
	 * Whether an own video carries what the profile needs: the owner as its
	 * author and the author's follower, following, like and video counts.
	 */
	const isOwnerItem = (item: Item): boolean => {
		if (item.author?.id !== account.id) return false;
		const v1 = item.authorStats;
		const v2 = item.authorStatsV2;
		const has = (
			key: "followerCount" | "followingCount" | "heartCount" | "videoCount",
		): boolean => v2?.[key] !== undefined || v1?.[key] !== undefined;
		return (
			has("followerCount") &&
			has("followingCount") &&
			has("heartCount") &&
			has("videoCount")
		);
	};

	/**
	 * Walk the owner's own videos (following TikTok's cursor) to the first one
	 * that carries the owner's counts. Null only when TikTok's own list proves
	 * there are no videos at all (hasMore:false, nothing listed, no positive
	 * total), which the manifest documents as null counts. Everything else
	 * that ends without a usable video fails the profile: an unreadable entry,
	 * listed videos none of which carry the counts, a positive total with
	 * nothing listed, a page that adds nothing, a repeated cursor, the cap.
	 */
	const findOwnItem = async (): Promise<Item | null> => {
		const seenCursors = new Set<string>();
		let cursor = "0";
		let listed = 0;
		for (let pages = 0; pages < maxPages; pages += 1) {
			seenCursors.add(cursor);
			const page = parseItemPage(
				await api.get("/api/post/item_list/", {
					secUid,
					count: ITEM_PAGE_SIZE,
					cursor,
					coverFormat: "2",
				}),
			);
			if (!page) {
				throw new TikTokStop(
					"unreadable",
					"/api/post/item_list/ answered a page this connector does not recognise",
				);
			}
			if (page.unreadable > 0) {
				throw new TikTokStop(
					"unreadable",
					`${page.unreadable} own videos did not match the recorded shape, so the profile counts could not be read`,
				);
			}
			const usable = page.items.find(isOwnerItem);
			if (usable) return usable;
			listed += page.items.length;
			if (!page.hasMore) {
				if (listed > 0) {
					throw new TikTokStop(
						"incomplete",
						`none of the owner's ${listed} listed videos carried the profile counts`,
					);
				}
				if (page.total !== null && page.total > 0) {
					throw new TikTokStop(
						"incomplete",
						`TikTok counted ${page.total} videos but listed none, so the profile counts could not be read`,
					);
				}
				return null;
			}
			const next = page.cursor;
			if (
				page.items.length === 0 ||
				next === null ||
				next === "" ||
				seenCursors.has(next)
			) {
				throw new TikTokStop(
					"incomplete",
					"/api/post/item_list/ said it had more but gave no new video or cursor",
				);
			}
			cursor = next;
		}
		throw new TikTokStop(
			"incomplete",
			`/api/post/item_list/ still had more after ${maxPages} pages and no video carried the profile counts`,
		);
	};

	/**
	 * Whether the page holds the `sourceType` the web app sends on
	 * /api/collection/item_list/ (copied from the app's own request; never
	 * guessed). It never navigates.
	 */
	const collectionSourceReady = async (): Promise<boolean> => {
		const status = await watch(ctx.page);
		return (
			status?.client === true &&
			status.copied?.["/api/collection/item_list/"] === true
		);
	};

	/**
	 * Make sure the page holds that `sourceType` before any collection is
	 * read. The value belongs to the page, not to one collection, so when this
	 * page has no such request the connector opens, once, the page of the first
	 * collection whose owner name is known (a target first, else any listed
	 * collection in `inventory`; the app makes the request itself there) and
	 * waits for it. A collection without an owner name is read with the value
	 * another collection's page gave. Returns false when the app still did not
	 * send one.
	 */
	let collectionPageOpened = false;
	const ensureCollectionSource = async (
		targets: readonly Collection[],
		inventory: readonly Collection[] = targets,
	): Promise<boolean> => {
		if (await collectionSourceReady()) return true;
		const opener =
			targets.find((collection) => collection.userName) ??
			inventory.find((collection) => collection.userName);
		if (collectionPageOpened || !opener?.userName) return false;
		collectionPageOpened = true;
		const slug = `${encodeURIComponent(opener.name)}-${opener.collectionId}`;
		await ctx.page.goto(
			`${TIKTOK_ORIGIN}/@${encodeURIComponent(opener.userName)}/collection/${slug}`,
			{ waitUntil: "domcontentloaded" },
		);
		for (let waited = 0; waited < CLIENT_WAIT_MS; waited += POLL_INTERVAL_MS) {
			await delay(POLL_INTERVAL_MS);
			if (await collectionSourceReady()) return true;
		}
		return false;
	};

	/**
	 * Item-level outcomes of one collection's item list: they end that
	 * collection, not the run. Only `incomplete` (TikTok did not show the end
	 * of the list, or it changed while read) is a DETAIL_GAP a later run may
	 * clear; an answer this connector cannot read, or TikTok's own refusal,
	 * would come back the same, so it fails the stream instead of leaving a
	 * gap that is retried forever.
	 */
	const ITEM_STOPS: ReadonlySet<StopClass> = new Set([
		"unreadable",
		"status_error",
		"incomplete",
	]);

	/** How many full reads a multi-page list gets to come out the same twice. */
	const MAX_STABLE_READS = 3;
	const sameIds = (a: readonly string[], b: readonly string[]): boolean => {
		if (a.length !== b.length) return false;
		const left = [...a].sort();
		const right = [...b].sort();
		return left.every((id, index) => id === right[index]);
	};

	/**
	 * Read one collection's videos to hasMore:false without emitting them. TikTok
	 * pages these lists by offset, so a list that changes while it is read can
	 * repeat one video and skip another: a list that took more than one page is
	 * read again until two consecutive reads hold the same ids, or fails after
	 * MAX_STABLE_READS. A single page is one consistent answer, unless TikTok
	 * counts more videos than it listed: then it too must read the same twice.
	 */
	const readCollectionItems = async (
		collection: Collection,
	): Promise<{
		confirmed: boolean;
		entries: number;
		items: Item[];
		total: number | null;
	}> => {
		let total = collectionItemCount(collection);
		let previous: string[] | null = null;
		for (let attempt = 0; attempt < MAX_STABLE_READS; attempt += 1) {
			const items: Item[] = [];
			const walk = await walkItemList(
				api,
				"/api/collection/item_list/",
				{ collectionId: collection.collectionId },
				maxPages,
				async (item) => {
					items.push(item);
				},
			);
			// Validate shape and stability before retaining partial records. Totals
			// are reconciled after safe records are emitted, before hydration.
			assertComplete(COLLECTION_ITEMS, { ...walk, total: null });
			if (walk.total !== null) total = Math.max(total ?? 0, walk.total);
			const ids = items.map((item) => item.id);
			const short = total !== null && items.length < total;
			const entries = walk.entries;
			if (walk.pages <= 1 && !short)
				return { confirmed: false, entries, items, total };
			if (previous !== null && sameIds(previous, ids))
				return { confirmed: true, entries, items, total };
			previous = ids;
		}
		throw new TikTokStop(
			"incomplete",
			`the videos of collection ${collection.collectionId} changed on every read, so the list could not be read consistently`,
		);
	};

	/**
	 * Read, validate, then emit one collection's videos: nothing is emitted for
	 * a collection whose list is unreadable or carries unsafe text.
	 */
	const hydrateCollection = async (collection: Collection): Promise<number> => {
		const { confirmed, entries, items, total } =
			await readCollectionItems(collection);
		const before = notes.replaced;
		const records = items.map((item) =>
			buildCollectionItemRecord(collection.collectionId, item, notes),
		);
		if (notes.replaced > before) {
			throw new TikTokStop(
				"unreadable",
				`${notes.replaced - before} text values in collection ${collection.collectionId} are not safe text`,
			);
		}
		for (const record of records)
			await ctx.emitRecord(COLLECTION_ITEMS, record);
		// A count above the videos read is accepted only for a confirmed walk
		// (see settleCount); anything else keeps the durable gap.
		settleCount(COLLECTION_ITEMS, {
			confirmed,
			entries,
			read: items.length,
			total,
		});
		return items.length;
	};

	interface CollectionsOutcome {
		childFailure: TikTokStop | null;
		parentFailure: TikTokStop | null;
	}

	/** Pending collection_items gaps from earlier runs, by collection id. */
	type PendingGap = NonNullable<TikTokCollectContext["detailGaps"]>[number];
	const pendingGaps = new Map<string, PendingGap[]>();
	/** Every collection_items gap id seen this run, from START or a page. */
	const seenGapIds = new Set<string>();
	/**
	 * Take the gaps of one page (START's, or one the runtime pages in). Every
	 * gap id on the page counts as seen, whether or not it names a collection
	 * this connector can read, so a page of gaps that do not close still
	 * leads to the next page. Returns how many gap ids were new (paging ends
	 * at a page with none) and the collection ids the new valid gaps name.
	 */
	const addPendingGaps = (
		entries: TikTokCollectContext["detailGaps"],
	): { fresh: string[]; unseen: number } => {
		const fresh: string[] = [];
		let unseen = 0;
		for (const gap of entries ?? []) {
			if (seenGapIds.has(gap.gap_id)) continue;
			seenGapIds.add(gap.gap_id);
			unseen += 1;
			const id = gap.detail_locator?.collection_id ?? gap.record_key;
			if (gap.stream !== COLLECTION_ITEMS) continue;
			if (typeof id !== "string" || !/^[0-9]{1,30}$/.test(id)) continue;
			pendingGaps.set(id, [...(pendingGaps.get(id) ?? []), gap]);
			if (!fresh.includes(id)) fresh.push(id);
		}
		return { fresh, unseen };
	};
	addPendingGaps(ctx.detailGaps);
	/** The next page of pending gaps; empty on a host that pages none. */
	const nextGapPage = async (): Promise<{ fresh: string[]; unseen: number }> =>
		ctx.requestDetailGapPage
			? addPendingGaps(
					await ctx.requestDetailGapPage({ streams: [COLLECTION_ITEMS] }),
				)
			: { fresh: [], unseen: 0 };

	/** Acknowledge every pending gap of one collection that is now settled. */
	const recoverGaps = async (collectionId: string): Promise<void> => {
		for (const gap of pendingGaps.get(collectionId) ?? []) {
			await ctx.emit({
				type: "DETAIL_GAP_RECOVERED",
				stream: COLLECTION_ITEMS,
				gap_id: gap.gap_id,
				record_key: collectionId,
				reference_only: true,
				...(gap.lease_id ? { lease_id: gap.lease_id } : {}),
			});
		}
		pendingGaps.delete(collectionId);
	};

	/**
	 * Collections whose videos the run asked for: all of them, unless a
	 * stream names resources. collection_items record ids are
	 * `<collection id>:<video id>`, so only the collections they name are read
	 * from TikTok. favorite_collections resources name the parents the run
	 * keeps; a collection whose parent record is not kept gets no videos read
	 * (a child is never emitted without its parent).
	 */
	const childTargets = (list: readonly Collection[]): Collection[] => {
		const named = (
			stream: Stream,
			idOf: (resource: string) => string | null,
		) => {
			const resources = ctx.requested.get(stream)?.resources;
			if (!Array.isArray(resources) || resources.length === 0) return null;
			const ids = new Set<string>();
			for (const resource of resources) {
				const id = idOf(String(resource));
				if (id !== null) ids.add(id);
			}
			return ids;
		};
		const children = named(
			COLLECTION_ITEMS,
			(resource) => /^([0-9]{1,30}):[0-9]{1,30}$/.exec(resource)?.[1] ?? null,
		);
		const parents = named(FAVORITE_COLLECTIONS, (resource) => resource);
		return list.filter(
			(collection) =>
				(children === null || children.has(collection.collectionId)) &&
				(parents === null || parents.has(collection.collectionId)),
		);
	};

	/**
	 * Hydrate each collection in `targets` (their parent records are already
	 * emitted), give every one exactly one outcome (hydrated, which also
	 * acknowledges its pending gaps; a fresh DETAIL_GAP when TikTok did not
	 * show the end of its list or the page lost the app's value; or a stream
	 * failure when its answer cannot be read), acknowledge gaps of collections
	 * no longer in the complete list `listed` (null when TikTok counted more
	 * collections than it listed: an absent one may be among those, so its gap
	 * stays pending), page in the pending gaps START did not carry and settle
	 * them the same way (in a recovery run, `extraTarget` names the collections
	 * those pages ask for), then one DETAIL_COVERAGE and the child STATE. A
	 * run-level stop propagates and leaves no coverage and no checkpoint.
	 */
	const hydrateAll = async (
		targets: Collection[],
		inventory: readonly Collection[],
		listed: ReadonlySet<string> | null,
		extraTarget?: (
			collectionId: string,
		) => Promise<Collection | TikTokStop | null>,
	): Promise<TikTokStop | null> => {
		const requiredKeys: string[] = [];
		const hydratedKeys: string[] = [];
		const gapKeys: string[] = [];
		const failures: TikTokStop[] = [];
		let items = 0;
		if (
			targets.length > 0 &&
			!(await ensureCollectionSource(targets, inventory))
		) {
			// No child record was emitted yet: the stream fails visibly and
			// writes no coverage; nothing is guessed.
			return new TikTokStop(
				"missing_param",
				"the TikTok web app did not send the sourceType it uses for a collection's videos, so collection contents were not read",
			);
		}
		const gap = async (collection: Collection, error: TikTokStop) => {
			await emitDetailGap(ctx, {
				stream: COLLECTION_ITEMS,
				parentStream: FAVORITE_COLLECTIONS,
				recordKey: collection.collectionId,
				reason: "temporary_unavailable",
				locator: {
					kind: "tiktok.collection",
					collection_id: collection.collectionId,
					name: collection.name,
					user_name: collection.userName ?? null,
				},
				error: { class: STOP_CODES[error.stop], message: error.message },
			});
			gapKeys.push(collection.collectionId);
		};
		const hydrateOne = async (collection: Collection): Promise<void> => {
			requiredKeys.push(collection.collectionId);
			if (!(await ensureCollectionSource([collection], inventory))) {
				// The page does not hold the app's value for this collection
				// (TikTok replaced the page after it was seen, and the one
				// collection-page open is spent): only this collection is
				// retried later.
				await gap(
					collection,
					new TikTokStop(
						"missing_param",
						"the page no longer held the sourceType the web app sends for a collection's videos",
					),
				);
				return;
			}
			try {
				items += await hydrateCollection(collection);
				hydratedKeys.push(collection.collectionId);
				await recoverGaps(collection.collectionId);
			} catch (error) {
				if (!(error instanceof TikTokStop) || !ITEM_STOPS.has(error.stop)) {
					throw error;
				}
				if (error.stop === "incomplete") await gap(collection, error);
				else failures.push(error);
			}
		};
		for (const collection of targets) await hydrateOne(collection);
		/** Settle the pending gaps of one collection, as far as this run can. */
		const settle = async (id: string): Promise<void> => {
			if (hydratedKeys.includes(id)) {
				await recoverGaps(id);
				return;
			}
			// A gapped collection the complete list no longer holds was
			// deleted: there is nothing left to read for it.
			if (listed && !listed.has(id)) {
				await recoverGaps(id);
				return;
			}
			if (requiredKeys.includes(id) || !extraTarget) return;
			const collection = await extraTarget(id);
			if (collection instanceof TikTokStop) {
				requiredKeys.push(id);
				failures.push(collection);
			} else if (collection) await hydrateOne(collection);
		};
		for (const id of [...pendingGaps.keys()]) await settle(id);
		// START carries a bounded page of gaps; the rest come one page at a
		// time, each settled before the next is asked for.
		for (let page = await nextGapPage(); page.unseen > 0; ) {
			for (const id of page.fresh) await settle(id);
			page = await nextGapPage();
		}
		await emitDetailCoverage(ctx, {
			stream: COLLECTION_ITEMS,
			stateStream: FAVORITE_COLLECTIONS,
			requiredKeys,
			hydratedKeys,
			gapKeys,
		});
		const [first] = failures;
		if (first) {
			// Required but neither hydrated nor gapped: the coverage leaves
			// them unaccounted, and the stream fails without its STATE.
			return failures.length === 1
				? first
				: new TikTokStop(
						first.stop,
						`${failures.length} collections could not be read; the first: ${first.message}`,
					);
		}
		await ctx.emit({
			type: "STATE",
			stream: COLLECTION_ITEMS,
			cursor: { collections: hydratedKeys.length, items },
		});
		return null;
	};

	/** One read of the Favorites collections list to hasMore:false. */
	const listCollectionsOnce = async (): Promise<{
		entries: number;
		list: Collection[];
		pages: number;
		total: number | null;
	}> => {
		const seenCursors = new Set<string>();
		const byId = new Map<string, Collection>();
		let entries = 0;
		let total: number | null = null;
		let cursor = "0";
		for (let pages = 0; ; pages += 1) {
			if (pages >= maxPages) {
				throw new TikTokStop(
					"incomplete",
					`/api/user/collection_list/ still had more after ${maxPages} pages`,
				);
			}
			seenCursors.add(cursor);
			const page = parseCollectionPage(
				await api.get("/api/user/collection_list/", {
					secUid,
					count: ITEM_PAGE_SIZE,
					cursor,
					// The app's own call carries appId (1988, TikTok web's app
					// id) and publicOnly; false asks for private collections too.
					appId: "1988",
					publicOnly: "false",
				}),
			);
			if (!page) {
				throw new TikTokStop(
					"unreadable",
					"/api/user/collection_list/ answered a page this connector does not recognise",
				);
			}
			if (page.unreadable > 0) {
				throw new TikTokStop(
					"unreadable",
					`${page.unreadable} favorite collections did not match the recorded shape`,
				);
			}
			// The documented pre-collection response has no list and total:1.
			// It is not an inventory count, unless pending gaps contradict that
			// never-created state. Never discard a count observed on an earlier page.
			const preCollectionEmpty =
				!page.listed &&
				page.total === 1 &&
				byId.size === 0 &&
				pages === 0 &&
				pendingGaps.size === 0;
			if (!preCollectionEmpty && page.total !== null)
				total = Math.max(total ?? 0, page.total);
			let added = 0;
			entries += page.collections.length;
			for (const collection of page.collections) {
				if (byId.has(collection.collectionId)) continue;
				byId.set(collection.collectionId, collection);
				added += 1;
			}
			if (!page.hasMore) {
				return {
					entries,
					list: [...byId.values()],
					pages: pages + 1,
					total,
				};
			}
			const next = page.cursor;
			if (
				added === 0 ||
				next === null ||
				next === "" ||
				seenCursors.has(next)
			) {
				throw new TikTokStop(
					"incomplete",
					"/api/user/collection_list/ said it had more but gave no new page",
				);
			}
			cursor = next;
		}
	};

	/**
	 * The Favorites collections list, read until two consecutive reads of a
	 * multi-page list hold the same ids (offset paging can repeat one entry
	 * and skip another while the list changes), or failed after
	 * MAX_STABLE_READS. A single page is one consistent answer, unless TikTok
	 * counts more collections than it listed: then it too must read the same
	 * twice. The count is settled by the caller, after the records are saved.
	 */
	const listCollections = async (): Promise<{
		confirmed: boolean;
		entries: number;
		list: Collection[];
		total: number | null;
	}> => {
		let total: number | null = null;
		let previous: string[] | null = null;
		for (let attempt = 0; attempt < MAX_STABLE_READS; attempt += 1) {
			const read = await listCollectionsOnce();
			if (read.total !== null) total = Math.max(total ?? 0, read.total);
			const ids = read.list.map((collection) => collection.collectionId);
			const short = total !== null && ids.length < total;
			let confirmed: boolean | null = null;
			if (read.pages <= 1 && !short) confirmed = false;
			else if (previous !== null && sameIds(previous, ids)) confirmed = true;
			if (confirmed !== null)
				return { confirmed, entries: read.entries, list: read.list, total };
			previous = ids;
		}
		throw new TikTokStop(
			"incomplete",
			"the Favorites collections list changed on every read, so it could not be read consistently",
		);
	};

	/**
	 * Build and validate parent records before any is emitted: an unreadable
	 * parent means no parent record, no child record and no coverage.
	 */
	const buildParents = (
		list: Collection[],
	): { records: RecordData[] } | { failure: TikTokStop } => {
		const before = notes.replaced;
		const records = list.map((collection) =>
			buildCollectionRecord(collection, notes),
		);
		if (notes.replaced > before) {
			return {
				failure: new TikTokStop(
					"unreadable",
					`${notes.replaced - before} favorite_collections names are not safe text, so no collection or its videos were saved`,
				),
			};
		}
		return { records };
	};

	/** collection_items is a detail of favorite_collections: both, or no child. */
	const parentRequired = new TikTokStop(
		"scope",
		"collection_items needs favorite_collections in the same run, so each collection is saved before its videos",
	);

	/**
	 * favorite_collections (parent) and collection_items (child) in one pass:
	 * the list, all parent records validated then emitted, then each
	 * collection's videos, coverage, then the checkpoints. Shared by both
	 * streams; runs once.
	 */
	const runCollections = async (): Promise<CollectionsOutcome> => {
		const parentRequested = ctx.requested.has(FAVORITE_COLLECTIONS);
		const childRequested = ctx.requested.has(COLLECTION_ITEMS);
		if (childRequested && !parentRequested) {
			return { parentFailure: null, childFailure: parentRequired };
		}
		let walk: Awaited<ReturnType<typeof listCollections>>;
		try {
			walk = await listCollections();
		} catch (error) {
			if (error instanceof TikTokStop && !RUN_STOPS.has(error.stop)) {
				return { parentFailure: error, childFailure: error };
			}
			throw error;
		}
		const { list } = walk;
		const parents = buildParents(list);
		if ("failure" in parents) {
			return { parentFailure: parents.failure, childFailure: parents.failure };
		}
		for (const record of parents.records) {
			await ctx.emitRecord(FAVORITE_COLLECTIONS, record);
		}
		let short: boolean;
		try {
			short = settleCount(FAVORITE_COLLECTIONS, {
				...walk,
				read: list.length,
			});
		} catch (error) {
			if (!(error instanceof TikTokStop)) throw error;
			return { parentFailure: error, childFailure: error };
		}
		let childFailure: TikTokStop | null = null;
		if (childRequested) {
			childFailure = await hydrateAll(
				childTargets(list),
				list,
				short
					? null
					: new Set(list.map((collection) => collection.collectionId)),
			);
		}
		await ctx.emit({
			type: "STATE",
			stream: FAVORITE_COLLECTIONS,
			cursor: { count: list.length },
		});
		return { parentFailure: null, childFailure };
	};
	let collectionsRun: Promise<CollectionsOutcome> | null = null;
	const collections = (): Promise<CollectionsOutcome> => {
		collectionsRun ??= runCollections();
		return collectionsRun;
	};

	/**
	 * Recovery-only: retry earlier collection gaps. The complete list is read
	 * so each recovered collection's parent record is emitted before its
	 * videos, and gaps of collections no longer listed are acknowledged. When
	 * START carries none, one page is asked of the runtime first.
	 */
	const recoverCollections = async (): Promise<void> => {
		for (
			let page = { fresh: [] as string[], unseen: 1 };
			pendingGaps.size === 0 && page.unseen > 0;
		)
			page = await nextGapPage();
		if (pendingGaps.size === 0) return;
		if (!ctx.requested.has(FAVORITE_COLLECTIONS)) {
			await fail(COLLECTION_ITEMS, parentRequired);
			return;
		}
		let walk: Awaited<ReturnType<typeof listCollections>>;
		try {
			walk = await listCollections();
		} catch (error) {
			if (error instanceof TikTokStop && !RUN_STOPS.has(error.stop)) {
				await fail(COLLECTION_ITEMS, error);
				return;
			}
			throw error;
		}
		const { list } = walk;
		const targets = childTargets(list).filter((collection) =>
			pendingGaps.has(collection.collectionId),
		);
		const parents = buildParents(targets);
		if ("failure" in parents) {
			await fail(COLLECTION_ITEMS, parents.failure);
			return;
		}
		for (const record of parents.records) {
			await ctx.emitRecord(FAVORITE_COLLECTIONS, record);
		}
		let short: boolean;
		try {
			short = settleCount(FAVORITE_COLLECTIONS, {
				...walk,
				read: list.length,
			});
		} catch (error) {
			if (!(error instanceof TikTokStop)) throw error;
			await fail(COLLECTION_ITEMS, error);
			return;
		}
		const byId = new Map(
			list.map((collection) => [collection.collectionId, collection]),
		);
		/** A collection a later gap page names: its parent record, then it. */
		const extraTarget = async (
			id: string,
		): Promise<Collection | TikTokStop | null> => {
			const collection = byId.get(id);
			if (!collection || childTargets([collection]).length === 0) return null;
			const parent = buildParents([collection]);
			if ("failure" in parent) return parent.failure;
			for (const record of parent.records)
				await ctx.emitRecord(FAVORITE_COLLECTIONS, record);
			return collection;
		};
		const failure = await hydrateAll(
			targets,
			list,
			short ? null : new Set(list.map((collection) => collection.collectionId)),
			extraTarget,
		);
		if (failure) await fail(COLLECTION_ITEMS, failure);
	};

	const run: Record<Stream, () => Promise<void>> = {
		[VIDEOS]: async () => {
			const named = resourceTracker(VIDEOS);
			const since = pushableSince(VIDEOS);
			/** Posting time of the last unpinned video handed on. */
			let previous: number | null = null;
			/** Whether every unpinned video so far came newest first. */
			let newestFirst = true;
			const walk = await walkItemList(
				api,
				"/api/post/item_list/",
				ownList,
				maxPages,
				async (item) => {
					if (ownFirstItem === null && isOwnerItem(item)) ownFirstItem = item;
					named?.see(item.id);
					if (item.isPinnedItem !== true) {
						if (previous !== null && item.createTime > previous)
							newestFirst = false;
						previous = item.createTime;
					}
					await emitBuilt(VIDEOS, () => buildVideoRecord(item, notes));
				},
				(page) =>
					named?.done() === true ||
					(since !== null && newestFirst && pageBeforeSince(page, since)),
			);
			if (walk.stopped)
				connectorDiagnostic("tiktok", "list_stopped_in_scope", {
					stream: VIDEOS,
					pages: walk.pages,
				});
			assertComplete(VIDEOS, walk);
			assertSafe(VIDEOS);
			// A proved-empty list, or a usable own video, settles the profile
			// counts; listed videos without the counts, or a walk the scope
			// ended early without one, leave it to findOwnItem.
			ownFirstItemRead =
				ownFirstItem !== null || (walk.read === 0 && !walk.stopped);
			await ctx.emit({
				type: "STATE",
				stream: VIDEOS,
				cursor: { count: walk.read },
			});
		},
		[PROFILE]: async () => {
			const settings = parseSettings(await api.get("/api/user/settings/", {}));
			if (!settings.ok) {
				throw new TikTokStop(
					"unreadable",
					"/api/user/settings/ answered without a settings object",
				);
			}
			if (!ownFirstItemRead) ownFirstItem = await findOwnItem();
			await emitBuilt(PROFILE, () =>
				buildProfileRecord(
					account,
					settings.privateAccount,
					ownFirstItem,
					notes,
				),
			);
			assertSafe(PROFILE);
			await ctx.emit({
				type: "STATE",
				stream: PROFILE,
				cursor: { id: account.id },
			});
		},
		[LIKES]: () => walkSaved(LIKES, "/api/favorite/item_list/"),
		[FAVORITES]: () => walkSaved(FAVORITES, "/api/user/collect/item_list/"),
		[FAVORITE_COLLECTIONS]: async () => {
			const outcome = await collections();
			if (outcome.parentFailure) throw outcome.parentFailure;
		},
		[COLLECTION_ITEMS]: async () => {
			const outcome = await collections();
			if (outcome.childFailure) throw outcome.childFailure;
		},
		[FOLLOWING]: () => walkUsers(FOLLOWING, FOLLOWING_SCENE),
		[FOLLOWERS]: () => walkUsers(FOLLOWERS, FOLLOWERS_SCENE),
	};

	async function walkSaved(
		stream: typeof LIKES | typeof FAVORITES,
		path: AllowedPath,
	): Promise<void> {
		// Every run walks the whole list to hasMore:false (or until every
		// requested resource was read); the host keeps one record per video
		// id, so videos seen before are not duplicated.
		const named = resourceTracker(stream);
		const emitted = new Set<string>();
		const onItem = async (item: Item): Promise<void> => {
			named?.see(item.id);
			if (emitted.has(item.id)) return;
			emitted.add(item.id);
			await emitBuilt(stream, () => buildSavedVideoRecord(item, notes));
		};
		const readOnce = async (): Promise<{ ids: string[]; walk: WalkResult }> => {
			const ids: string[] = [];
			const walk = await walkItemList(
				api,
				path,
				ownList,
				maxPages,
				async (item) => {
					ids.push(item.id);
					await onItem(item);
				},
				() => named?.done() === true,
			);
			// Unreadable entries fail the stream whatever the count says.
			assertComplete(stream, { ...walk, total: null });
			return { ids, walk };
		};
		let { ids, walk } = await readOnce();
		assertSafe(stream);
		let total = walk.total;
		let confirmed = false;
		// TikTok counts more than it listed (a video its author removed stays
		// in the count): the list is complete only when a walk without repeated
		// rows reads the same ids twice in a row (settleCount). A re-read is
		// sent only while the run's request budget covers it: otherwise only
		// this stream ends incomplete, and no other stream loses its requests.
		for (
			let attempt = 1;
			!walk.stopped &&
			!confirmed &&
			total !== null &&
			walk.read < total &&
			walk.read > 0 &&
			walk.entries === walk.read &&
			attempt < MAX_STABLE_READS;
			attempt += 1
		) {
			if (api.remaining() < walk.pages) {
				connectorDiagnostic("tiktok", "count_reread_skipped", {
					stream,
					pages: walk.pages,
					remaining: api.remaining(),
				});
				break;
			}
			const again = await readOnce();
			assertSafe(stream);
			if (again.walk.total !== null) total = Math.max(total, again.walk.total);
			confirmed = sameIds(ids, again.ids);
			({ ids, walk } = again);
		}
		if (!walk.stopped)
			settleCount(stream, {
				confirmed,
				entries: walk.entries,
				read: walk.read,
				total,
			});
		await ctx.emit({ type: "STATE", stream, cursor: { count: walk.read } });
	}

	async function walkUsers(
		stream: typeof FOLLOWING | typeof FOLLOWERS,
		scene: string,
	): Promise<void> {
		const named = resourceTracker(stream);
		const walk = await walkUserList(
			api,
			secUid,
			scene,
			maxPages,
			(user) => {
				named?.see(user.id);
				return emitBuilt(stream, () => buildUserRecord(user, notes));
			},
			() => named?.done() === true,
		);
		assertComplete(stream, walk);
		assertSafe(stream);
		await ctx.emit({ type: "STATE", stream, cursor: { count: walk.read } });
	}

	if (ctx.recoveryOnly === true) {
		// Only earlier gaps are retried; no list is walked.
		try {
			if (ctx.requested.has(COLLECTION_ITEMS)) await recoverCollections();
		} catch (error) {
			if (!(error instanceof TikTokStop)) throw error;
			await stopRun(error);
			if (error.stop === "auth") throw error;
		}
		return;
	}

	for (const stream of requested) {
		await ctx.emit({
			type: "PROGRESS",
			stream,
			message: `Reading your TikTok ${stream.replace("_", " ")}`,
		});
		try {
			await run[stream]();
			finished.add(stream);
		} catch (error) {
			if (!(error instanceof TikTokStop)) throw error;
			if (RUN_STOPS.has(error.stop)) {
				await stopRun(error);
				if (error.stop === "auth") throw error;
				break;
			}
			await fail(stream, error);
		}
	}

	connectorDiagnostic("tiktok", "run_summary", {
		rq: api.requests(),
		ct: api.transport(),
		sg: api.signed(),
		done: finished.size,
	});
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "tiktok",
		validateRecord,
		browser: { profileName: "tiktok" },
		retryablePattern: TIKTOK_RETRYABLE_PATTERN,
		ensureSession: (args) => ensureTikTokSession(args),
		probeSession: async ({ page }) =>
			(await checkTikTokSession(page)) === "signed_in",
		probeSessionIsAuthoritative: true,
		collect: (ctx: BrowserCollectContext) => collectTikTok(ctx),
	});
}
