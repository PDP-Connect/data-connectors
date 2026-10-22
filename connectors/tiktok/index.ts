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
 * app's requests. No signature, token or cookie is read by this code, logged
 * or kept in STATE: the page reports only whether a request left signed.
 *
 * The in-page request is the only transport: an unsigned request from the
 * owner's session would be a bot signal, so a request the page cannot make or
 * that does not complete stops the run as tiktok_interrupted (retryable).
 *
 * Session check. Signed in is decided from the account endpoint the
 * collection itself starts with, in the page as it is. The check opens the
 * profile page only when the page is not on www.tiktok.com, and opens the
 * sign-in page only when TikTok answered and named no account; a check that
 * got no answer fails the run instead of navigating.
 *
 *   GET /passport/account/info/v2/      -> the owner's id, secUid, handle
 *   GET /api/user/settings/             -> profile.private_account
 *   GET /api/post/item_list/            -> videos (and profile counts)
 *   GET /api/favorite/item_list/        -> likes
 *   GET /api/user/collect/item_list/    -> favorites
 *   GET /api/user/list/ (scene 21 / 67) -> following / followers
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
 * Not collected either: Favorites collections. The web app lists them, but
 * no call that lists a collection's videos was observed, so membership could
 * not be read without guessing an endpoint; favorites is the flat list.
 *
 * Tested surfaces (as of 2026-10-22): a live run in the owner's signed-in
 * Chrome on one small English-language account (profile 1, videos 8, likes
 * 10, favorites 4, following 1, followers 1). Known untested: long lists,
 * private liked lists, incremental second runs, other locales.
 *
 * Reachability probe: exempt. Collection needs a signed-in browser session.
 *
 * Streams: profile, videos, likes, favorites, following, followers.
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
 */

import { isMainModule } from "@pdpp/connector-protocol";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type {
	BrowserCollectContext,
	EnsureSessionArgs,
	RecordData,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type AllowedPath,
	apiGetExpression,
	type PageApiResult,
	TIKTOK_ORIGIN,
	WATCH_EXPRESSION,
} from "./page-script.ts";
import {
	buildProfileRecord,
	buildSavedVideoRecord,
	buildUserRecord,
	buildVideoRecord,
	envelopeStatus,
	type Item,
	newTextNotes,
	parseAccount,
	parseItemPage,
	parseSettings,
	parseUserPage,
	secondsToInstant,
	type User,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

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
/** /api/user/list/ scene numbers used by TikTok's web app. */
const FOLLOWING_SCENE = "21";
const FOLLOWERS_SCENE = "67";

const PROFILE = "profile";
const VIDEOS = "videos";
const LIKES = "likes";
const FAVORITES = "favorites";
const FOLLOWING = "following";
const FOLLOWERS = "followers";
const STREAMS = [
	VIDEOS,
	PROFILE,
	LIKES,
	FAVORITES,
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
		const result = await fetchApi(page, path, params);
		if (result === null) {
			throw new TikTokStop("interrupted", `the page did not answer ${path}`);
		}
		switch (result.kind) {
			case "response":
				break;
			case "refused":
				throw new TikTokStop("unreadable", `the page reader refused ${path}`);
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
	transport?: string | null;
	wrongPage?: boolean;
}

async function watch(page: TikTokPage): Promise<WatchStatus | null> {
	const status = await evaluateInPage(page, WATCH_EXPRESSION);
	return status !== null && typeof status === "object"
		? (status as WatchStatus)
		: null;
}

/**
 * Make sure the page is the TikTok web app, and give the app time to make a
 * request of its own so the reader holds its client parameters. Navigates
 * only when the page is not on www.tiktok.com; a page already there is left
 * where it is. Returns whether client parameters were seen; without them the
 * first in-page request fails the run as tiktok_interrupted.
 */
async function prepareReader(
	page: TikTokPage,
	delay: (ms: number) => Promise<void>,
): Promise<boolean> {
	const first = await watch(page);
	if (first?.client === true) return true;
	if (first === null || first.wrongPage === true) {
		await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded" });
	}
	for (let waited = 0; waited < CLIENT_WAIT_MS; waited += POLL_INTERVAL_MS) {
		await delay(POLL_INTERVAL_MS);
		const status = await watch(page);
		if (status?.client === true) return true;
	}
	return false;
}

export type SessionState = "signed_in" | "signed_out" | "unknown";

/**
 * Whether the account endpoint (the same unsigned request the collection
 * starts with) names a signed-in account. "signed_out" only when TikTok
 * answered and named none; anything that is not an answer is "unknown".
 * It never navigates.
 */
export async function readSessionState(
	page: TikTokPage,
	delay: (ms: number) => Promise<void> = realDelay,
): Promise<SessionState> {
	let status = await watch(page);
	if (!status || status.wrongPage === true) return "unknown";
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
		if (!status || status.wrongPage === true) return "unknown";
	}
	const result = await fetchApi(page, "/passport/account/info/v2/", {});
	if (result?.kind !== "response") return "unknown";
	if (result.status === 401) return "signed_out";
	if (
		result.status !== 200 ||
		result.empty ||
		result.html ||
		result.challengeHeader === true
	)
		return "unknown";
	if (parseAccount(result.json) !== null) return "signed_in";
	return result.json !== null && typeof result.json === "object"
		? "signed_out"
		: "unknown";
}

/**
 * Whether the page holds a signed-in TikTok session. It does not navigate:
 * safe to repeat while the owner signs in.
 */
export async function probeTikTokSession(page: TikTokPage): Promise<boolean> {
	return (await readSessionState(page)) === "signed_in";
}

/**
 * The session check that may navigate, used where no one is signing in. It
 * opens the profile page only when the page is not on www.tiktok.com.
 */
export async function checkTikTokSession(
	page: TikTokPage,
	delay: (ms: number) => Promise<void> = realDelay,
): Promise<SessionState> {
	const first = await readSessionState(page, delay);
	if (first !== "unknown") return first;
	await prepareReader(page, delay);
	return readSessionState(page, delay);
}

export async function ensureTikTokSession(
	args: EnsureSessionArgs,
): Promise<void> {
	const { assist, capture, completeAssistance, page, sendInteraction } = args;
	const state = await checkTikTokSession(page);
	if (state === "signed_in") return;
	if (state === "unknown") {
		// Not proof of a signed-out session: never open the sign-in page on it.
		throw new Error(
			"tiktok_interrupted: TikTok did not answer the sign-in check",
		);
	}
	await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
	const ready = await manualBrowserLogin({
		assist,
		autoProbeIntervalMs: 5000,
		capture,
		completeAssistance,
		isProbeSuccessful: (ok) => ok === true,
		message:
			"Sign in to TikTok in the secure browser, then continue. Collection starts once the session is verified.",
		page,
		probe: async () => (await checkTikTokSession(page)) === "signed_in",
		readinessProbe: probeTikTokSession,
		readinessProbeOnHandoffPage: true,
		sendInteraction,
		timeoutSeconds: 30 * 60,
	});
	if (!ready) {
		throw new Error("tiktok_auth_failed: TikTok sign-in was not completed");
	}
}

// ─── list walks ──────────────────────────────────────────────────────────

interface WalkResult {
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
	secUid: string,
	maxPages: number,
	onItem: (item: Item) => Promise<void>,
): Promise<WalkResult> {
	const seenCursors = new Set<string>();
	const seenIds = new Set<string>();
	let cursor = "0";
	let read = 0;
	let unreadable = 0;
	let total: number | null = null;
	for (let pages = 0; ; pages += 1) {
		if (pages >= maxPages) {
			throw new TikTokStop(
				"incomplete",
				`${path} still had more after ${maxPages} pages`,
			);
		}
		seenCursors.add(cursor);
		const json = await api.get(path, {
			secUid,
			count: ITEM_PAGE_SIZE,
			cursor,
			coverFormat: "2",
		});
		const page = parseItemPage(json);
		if (!page) {
			throw new TikTokStop(
				"unreadable",
				`${path} answered a page this connector does not recognise`,
			);
		}
		total = page.total ?? total;
		unreadable += page.unreadable;
		let added = 0;
		for (const item of page.items) {
			if (seenIds.has(item.id)) continue;
			seenIds.add(item.id);
			added += 1;
			await onItem(item);
			read += 1;
		}
		if (!page.hasMore) {
			return { read, total, unreadable };
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
		total = page.total ?? total;
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
 * entries and a list that read nothing while TikTok counted items both fail
 * the stream.
 */
function assertComplete(
	stream: Stream,
	walk: { read: number; total: number | null; unreadable: number },
	known: boolean,
): void {
	if (walk.unreadable > 0) {
		throw new TikTokStop(
			"unreadable",
			`${walk.unreadable} ${stream} ${walk.unreadable === 1 ? "entry" : "entries"} did not match the recorded shape`,
		);
	}
	if (!known && walk.read === 0 && walk.total !== null && walk.total > 0) {
		throw new TikTokStop(
			"incomplete",
			`TikTok counted ${walk.total} ${stream} but none could be read`,
		);
	}
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
		connectorDiagnostic("tiktok", "client_params_not_seen", {});
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

	const run: Record<Stream, () => Promise<void>> = {
		[VIDEOS]: async () => {
			let newest: string | null = null;
			const walk = await walkItemList(
				api,
				"/api/post/item_list/",
				secUid,
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
			assertComplete(VIDEOS, walk, false);
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
		[FOLLOWING]: () => walkUsers(FOLLOWING, FOLLOWING_SCENE),
		[FOLLOWERS]: () => walkUsers(FOLLOWERS, FOLLOWERS_SCENE),
	};

	async function walkSaved(
		stream: typeof LIKES | typeof FAVORITES,
		path: AllowedPath,
	): Promise<void> {
		// Every run walks the whole list to hasMore:false; the host keeps one
		// record per video id, so videos seen before are not duplicated.
		const walk = await walkItemList(api, path, secUid, maxPages, (item) =>
			emitBuilt(stream, () => buildSavedVideoRecord(item, notes)),
		);
		assertComplete(stream, walk, false);
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
		assertComplete(stream, walk, false);
		assertSafe(stream);
		await ctx.emit({ type: "STATE", stream, cursor: { count: walk.read } });
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
		retryablePattern:
			/tiktok_rate_limited|tiktok_server_error|tiktok_interrupted|tiktok_run_limit_reached/,
		ensureSession: ensureTikTokSession,
		probeSession: async ({ page }) =>
			(await checkTikTokSession(page)) === "signed_in",
		probeSessionIsAuthoritative: true,
		collect: (ctx: BrowserCollectContext) => collectTikTok(ctx),
	});
}
