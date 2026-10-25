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
const STREAMS = [
	VIDEOS,
	PROFILE,
	LIKES,
	FAVORITES,
	FAVORITE_COLLECTIONS,
	COLLECTION_ITEMS,
	FOLLOWING,
	FOLLOWERS,
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
	total: number | null;
	unreadable: number;
}

/**
 * Walk one item list (post, favorite, collect) from the newest page until
 * TikTok says `hasMore: false`. That is the only way a walk completes: a
 * known id is not an end (a list can hold new items below one), and any
 * other ending throws: a repeated cursor, a page that adds nothing while
 * hasMore is true, a missing cursor or the page cap.
 */
async function walkItemList(
	api: Api,
	path: AllowedPath,
	base: Params,
	maxPages: number,
	onItem: (item: Item) => Promise<void>,
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
		if (!page.hasMore) {
			return {
				entries,
				read,
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
): Promise<{ read: number; total: number | null; unreadable: number }> {
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
			return { read: seenIds.size, total, unreadable };
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
 * stream. A terminal page does not account for missing entries.
 */
function assertComplete(
	stream: Stream,
	walk: {
		failedFields?: string[];
		read: number;
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
	if (walk.total !== null && walk.read < walk.total) {
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
		if (ctx.reportStreamFailure) {
			await ctx.reportStreamFailure(stream, error.message, { retryable });
		} else {
			await ctx.emit({
				type: "SKIP_RESULT",
				stream,
				reason: STOP_CODES[error.stop],
				message: error.message,
				recovery_hint: { action: "retry_by_runtime", retryable },
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
	 * Make sure the page holds the `sourceType` the web app sends on
	 * /api/collection/item_list/. The connector never guesses it: when this
	 * page has no such request, it opens the collection's own page (where the
	 * app makes that request itself) once, and waits for it. Returns false
	 * when the app still did not send one.
	 */
	let collectionPageOpened = false;
	const ensureCollectionSource = async (
		collection: Collection,
	): Promise<boolean> => {
		const ready = async (): Promise<boolean> => {
			const status = await watch(ctx.page);
			return (
				status?.client === true &&
				status.copied?.["/api/collection/item_list/"] === true
			);
		};
		if (await ready()) return true;
		if (collectionPageOpened || !collection.userName) return false;
		collectionPageOpened = true;
		const slug = `${encodeURIComponent(collection.name)}-${collection.collectionId}`;
		await ctx.page.goto(
			`${TIKTOK_ORIGIN}/@${encodeURIComponent(collection.userName)}/collection/${slug}`,
			{ waitUntil: "domcontentloaded" },
		);
		for (let waited = 0; waited < CLIENT_WAIT_MS; waited += POLL_INTERVAL_MS) {
			await delay(POLL_INTERVAL_MS);
			if (await ready()) return true;
		}
		return false;
	};

	/** Item-level outcomes of one collection's item list: a gap, not a stop. */
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
	for (const gap of ctx.detailGaps ?? []) {
		const id = gap.detail_locator?.collection_id ?? gap.record_key;
		if (gap.stream !== COLLECTION_ITEMS) continue;
		if (typeof id !== "string" || !/^[0-9]{1,30}$/.test(id)) continue;
		pendingGaps.set(id, [...(pendingGaps.get(id) ?? []), gap]);
	}

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
	 * Hydrate each collection in `targets` (their parent records are already
	 * emitted), give every one exactly one outcome (hydrated, which also
	 * acknowledges its pending gaps, or a fresh DETAIL_GAP), acknowledge gaps
	 * of collections no longer in the complete list `listed` (null when TikTok
	 * counted more collections than it listed: an absent one may be among
	 * those, so its gap stays pending), then one
	 * DETAIL_COVERAGE and the child STATE. A run-level stop propagates and
	 * leaves no coverage and no checkpoint.
	 */
	const hydrateAll = async (
		targets: Collection[],
		listed: ReadonlySet<string> | null,
	): Promise<TikTokStop | null> => {
		const hydratedKeys: string[] = [];
		const gapKeys: string[] = [];
		let items = 0;
		for (const collection of targets) {
			if (!(await ensureCollectionSource(collection))) {
				// No child record was emitted yet: the stream fails visibly and
				// writes no coverage; nothing is guessed.
				return new TikTokStop(
					"missing_param",
					"the TikTok web app did not send the sourceType it uses for a collection's videos, so collection contents were not read",
				);
			}
			try {
				items += await hydrateCollection(collection);
				hydratedKeys.push(collection.collectionId);
				await recoverGaps(collection.collectionId);
			} catch (error) {
				if (!(error instanceof TikTokStop) || !ITEM_STOPS.has(error.stop)) {
					throw error;
				}
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
			}
		}
		// A gapped collection the complete list no longer holds was deleted:
		// there is nothing left to read for it.
		for (const id of listed ? [...pendingGaps.keys()] : []) {
			if (!listed?.has(id)) await recoverGaps(id);
		}
		await emitDetailCoverage(ctx, {
			stream: COLLECTION_ITEMS,
			stateStream: FAVORITE_COLLECTIONS,
			requiredKeys: targets.map((collection) => collection.collectionId),
			hydratedKeys,
			gapKeys,
		});
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
	 * videos, and gaps of collections no longer listed are acknowledged.
	 */
	const recoverCollections = async (): Promise<void> => {
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
		const targets = list.filter((collection) =>
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
		const failure = await hydrateAll(
			targets,
			short ? null : new Set(list.map((collection) => collection.collectionId)),
		);
		if (failure) await fail(COLLECTION_ITEMS, failure);
	};

	const run: Record<Stream, () => Promise<void>> = {
		[VIDEOS]: async () => {
			let newest: string | null = null;
			const walk = await walkItemList(
				api,
				"/api/post/item_list/",
				ownList,
				maxPages,
				async (item) => {
					if (ownFirstItem === null && isOwnerItem(item)) ownFirstItem = item;
					const created = secondsToInstant(item.createTime);
					if (newest === null || String(created) > newest) {
						newest = String(created);
					}
					await emitBuilt(VIDEOS, () => buildVideoRecord(item, notes));
				},
			);
			assertComplete(VIDEOS, walk);
			assertSafe(VIDEOS);
			// A proved-empty list, or a usable own video, settles the profile
			// counts; listed videos without the counts leave it to findOwnItem,
			// which fails the profile.
			ownFirstItemRead = ownFirstItem !== null || walk.read === 0;
			await ctx.emit({
				type: "STATE",
				stream: VIDEOS,
				cursor: { newest_created_at: newest, count: walk.read },
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
		// Every run walks the whole list to hasMore:false; the host keeps one
		// record per video id, so videos seen before are not duplicated.
		const walk = await walkItemList(api, path, ownList, maxPages, (item) =>
			emitBuilt(stream, () => buildSavedVideoRecord(item, notes)),
		);
		assertComplete(stream, walk);
		assertSafe(stream);
		await ctx.emit({ type: "STATE", stream, cursor: { count: walk.read } });
	}

	async function walkUsers(
		stream: typeof FOLLOWING | typeof FOLLOWERS,
		scene: string,
	): Promise<void> {
		const walk = await walkUserList(api, secUid, scene, maxPages, (user) =>
			emitBuilt(stream, () => buildUserRecord(user, notes)),
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
