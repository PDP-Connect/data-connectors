#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP TikTok connector (v0.1.0).
 *
 * Exports the signed-in owner's own TikTok data from the www.tiktok.com web
 * app: their profile, the videos they posted, the videos they liked, the
 * videos they saved to Favorites (and their favorite collections), and the
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
 *   GET /passport/account/info/v2/      -> the owner's id, secUid, handle
 *   GET /api/user/settings/             -> profile.private_account
 *   GET /api/post/item_list/            -> videos (and profile counts)
 *   GET /api/favorite/item_list/        -> likes
 *   GET /api/user/collect/item_list/    -> favorites
 *   GET /api/user/collection_list/      -> favorite_collections
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
 * Tested surfaces (as of 2026-10-22): response shapes recorded by the factory
 * on one English-language test account with 8 videos, 1 following, no
 * collections. This code has run only against the synthetic fixtures. Known
 * untested: the transport signing in a live page, the scene numbers of
 * /api/user/list/ (21 following, 67 followers, from TikTok's web app), a
 * non-empty collection list, private liked lists, long lists, other locales.
 *
 * Reachability probe: exempt. Collection needs a signed-in browser session.
 *
 * Streams: profile, videos, likes, favorites, favorite_collections,
 * following, followers.
 *
 * CHANGES
 *   v0.1.0 (2026-10-22): first version.
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
	type Account,
	buildCollectionRecord,
	buildProfileRecord,
	buildSavedVideoRecord,
	buildUserRecord,
	buildVideoRecord,
	envelopeStatus,
	type Item,
	newTextNotes,
	parseAccount,
	parseCollectionPage,
	parseItemPage,
	parseSettings,
	parseUserPage,
	type TextNotes,
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
const CLIENT_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
/** Ids kept per incremental list: a later run stops at the first of them. */
const HEAD_IDS = 20;
/** /api/user/list/ scene numbers used by TikTok's web app. */
const FOLLOWING_SCENE = "21";
const FOLLOWERS_SCENE = "67";

const PROFILE = "profile";
const VIDEOS = "videos";
const LIKES = "likes";
const FAVORITES = "favorites";
const FAVORITE_COLLECTIONS = "favorite_collections";
const FOLLOWING = "following";
const FOLLOWERS = "followers";
const STREAMS = [
	VIDEOS,
	PROFILE,
	LIKES,
	FAVORITES,
	FAVORITE_COLLECTIONS,
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
	| "no_client"
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
	"no_client",
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
	no_client: "tiktok_client_request_not_seen",
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
		const result = (await evaluateInPage(
			page,
			apiGetExpression(path, params, REQUEST_TIMEOUT_MS),
		)) as PageApiResult | null;
		if (result === null || typeof result !== "object") {
			throw new TikTokStop("interrupted", `the page did not answer ${path}`);
		}
		switch (result.kind) {
			case "response":
				break;
			case "no_client":
				throw new TikTokStop(
					"no_client",
					"the TikTok web app has not made a request of its own to copy client parameters from",
				);
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
		if (result.status === 429) {
			throw new TikTokStop("rate_limited", `${path} answered 429`);
		}
		if (result.status >= 500) {
			throw new TikTokStop("server_error", `${path} answered ${result.status}`);
		}
		if (result.status === 403 || result.html) {
			throw new TikTokStop(
				"challenge",
				`${path} answered ${result.status} with a page instead of data`,
			);
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
			throw new TikTokStop("unreadable", `${path} answered without JSON`);
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
 * Make sure the page is the TikTok web app and the reader holds client
 * parameters from a request the app made itself. Opens the profile page when
 * it does not: the app then makes its own profile requests.
 */
async function prepareReader(
	page: TikTokPage,
	delay: (ms: number) => Promise<void>,
): Promise<boolean> {
	const first = await watch(page);
	if (first?.client === true) return true;
	await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded" });
	for (let waited = 0; waited < CLIENT_WAIT_MS; waited += POLL_INTERVAL_MS) {
		await delay(POLL_INTERVAL_MS);
		const status = await watch(page);
		if (status?.client === true) return true;
	}
	return false;
}

/** The signed-in account, read from the unsigned passport endpoint. */
async function readAccount(page: TikTokPage): Promise<Account | null> {
	const result = (await evaluateInPage(
		page,
		apiGetExpression("/passport/account/info/v2/", {}, REQUEST_TIMEOUT_MS),
	)) as PageApiResult | null;
	if (result?.kind !== "response" || result.status !== 200) return null;
	return parseAccount(result.json);
}

/**
 * Whether the page holds a signed-in TikTok session. It does not navigate:
 * safe to repeat while the owner signs in.
 */
export async function probeTikTokSession(page: TikTokPage): Promise<boolean> {
	const status = await watch(page);
	if (!status || status.wrongPage || status.client !== true) return false;
	return (await readAccount(page)) !== null;
}

/** The session check that may navigate: used where no one is signing in. */
async function hasTikTokSession(page: TikTokPage): Promise<boolean> {
	if (await probeTikTokSession(page)) return true;
	if (!(await prepareReader(page, realDelay))) return false;
	return probeTikTokSession(page);
}

export async function ensureTikTokSession(
	args: EnsureSessionArgs,
): Promise<void> {
	const { assist, capture, completeAssistance, page, sendInteraction } = args;
	if (await hasTikTokSession(page)) return;
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
		probe: () => hasTikTokSession(page),
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
	/** Items handed to `onItem` (new this run). */
	read: number;
	/** The walk reached the first id a previous run already holds. */
	reachedKnown: boolean;
	total: number | null;
	unreadable: number;
}

/**
 * Walk one item list (post, favorite, collect) from the newest page until
 * TikTok says `hasMore: false`, or until the first id in `stopAt`. Any other
 * ending throws: a repeated cursor, a page that adds nothing while hasMore is
 * true, a missing cursor or the page cap.
 */
async function walkItemList(
	api: Api,
	path: AllowedPath,
	secUid: string,
	maxPages: number,
	stopAt: ReadonlySet<string>,
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
			if (stopAt.has(item.id)) {
				return { read, reachedKnown: true, total, unreadable };
			}
			await onItem(item);
			read += 1;
		}
		if (!page.hasMore) {
			return { read, reachedKnown: false, total, unreadable };
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
	onUser: (record: RecordData) => Promise<void>,
	notes: TextNotes,
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
			await onUser(buildUserRecord(user, notes));
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

/** The stored head ids of an incremental list, or none. */
function headIds(value: unknown): string[] {
	if (value === null || typeof value !== "object") return [];
	const ids = (value as { head_ids?: unknown }).head_ids;
	if (!Array.isArray(ids)) return [];
	return ids
		.filter(
			(id): id is string => typeof id === "string" && /^[0-9]{1,30}$/.test(id),
		)
		.slice(0, HEAD_IDS);
}

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
	const fullRefresh = ctx.collectionMode === "full_refresh";
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
		await stopRun(
			new TikTokStop(
				"no_client",
				"the TikTok web app did not make a request of its own in time",
			),
		);
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

	let ownFirstItem: Item | null = null;
	let ownFirstItemRead = false;

	const run: Record<Stream, () => Promise<void>> = {
		[VIDEOS]: async () => {
			let newest: string | null = null;
			const walk = await walkItemList(
				api,
				"/api/post/item_list/",
				secUid,
				maxPages,
				new Set(),
				async (item) => {
					if (!ownFirstItemRead) {
						ownFirstItem = item;
						ownFirstItemRead = true;
					}
					const record = buildVideoRecord(item, notes);
					if (newest === null || String(record.created_at) > newest) {
						newest = String(record.created_at);
					}
					await ctx.emitRecord(VIDEOS, record);
				},
			);
			ownFirstItemRead = true;
			assertComplete(VIDEOS, walk, false);
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
			if (!ownFirstItemRead) {
				// The counts live on the owner's own video; read one page.
				const page = parseItemPage(
					await api.get("/api/post/item_list/", {
						secUid: secUid,
						count: ITEM_PAGE_SIZE,
						cursor: "0",
						coverFormat: "2",
					}),
				);
				if (!page) {
					throw new TikTokStop(
						"unreadable",
						"/api/post/item_list/ answered a page this connector does not recognise",
					);
				}
				ownFirstItem = page.items[0] ?? null;
				ownFirstItemRead = true;
			}
			await ctx.emitRecord(
				PROFILE,
				buildProfileRecord(
					account,
					settings.privateAccount,
					ownFirstItem,
					notes,
				),
			);
			await ctx.emit({
				type: "STATE",
				stream: PROFILE,
				cursor: { id: account.id },
			});
		},
		[LIKES]: () => walkSaved(LIKES, "/api/favorite/item_list/"),
		[FAVORITES]: () => walkSaved(FAVORITES, "/api/user/collect/item_list/"),
		[FAVORITE_COLLECTIONS]: async () => {
			const seenCursors = new Set<string>();
			const seenIds = new Set<string>();
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
						secUid: secUid,
						count: ITEM_PAGE_SIZE,
						cursor,
					}),
				);
				if (!page) {
					throw new TikTokStop(
						"unreadable",
						"/api/user/collection_list/ answered a page this connector does not recognise",
					);
				}
				let added = 0;
				for (const collection of page.collections) {
					if (seenIds.has(collection.collectionId)) continue;
					seenIds.add(collection.collectionId);
					added += 1;
					await ctx.emitRecord(
						FAVORITE_COLLECTIONS,
						buildCollectionRecord(collection, notes),
					);
				}
				if (!page.hasMore) {
					// hasMore: false is the end signal. A total without a list
					// counts collections TikTok does not list here, so it is
					// noted, not held against the walk.
					if (!page.listed && page.total !== null && page.total > 0) {
						connectorDiagnostic("tiktok", "collections_total_unlisted", {
							total: page.total,
						});
					}
					assertComplete(
						FAVORITE_COLLECTIONS,
						{
							read: seenIds.size,
							total: page.listed ? page.total : null,
							unreadable: page.unreadable,
						},
						false,
					);
					break;
				}
				if (page.unreadable > 0) {
					throw new TikTokStop(
						"unreadable",
						`${page.unreadable} favorite collections did not match the expected shape`,
					);
				}
				const next = page.cursor;
				if (added === 0 || next === null || seenCursors.has(next)) {
					throw new TikTokStop(
						"incomplete",
						"/api/user/collection_list/ said it had more but gave no new page",
					);
				}
				cursor = next;
			}
			await ctx.emit({
				type: "STATE",
				stream: FAVORITE_COLLECTIONS,
				cursor: { count: seenIds.size },
			});
		},
		[FOLLOWING]: () => walkUsers(FOLLOWING, FOLLOWING_SCENE),
		[FOLLOWERS]: () => walkUsers(FOLLOWERS, FOLLOWERS_SCENE),
	};

	async function walkSaved(
		stream: typeof LIKES | typeof FAVORITES,
		path: AllowedPath,
	): Promise<void> {
		const prior = fullRefresh ? [] : headIds(ctx.state[stream]);
		const fresh: string[] = [];
		const walk = await walkItemList(
			api,
			path,
			secUid,
			maxPages,
			new Set(prior),
			async (item) => {
				if (fresh.length < HEAD_IDS) fresh.push(item.id);
				await ctx.emitRecord(stream, buildSavedVideoRecord(item, notes));
			},
		);
		assertComplete(stream, walk, walk.reachedKnown);
		// The newest ids first: this run's new ones, then the stored head the
		// walk stopped at (only when it stopped there).
		const head = [...fresh, ...(walk.reachedKnown ? prior : [])].slice(
			0,
			HEAD_IDS,
		);
		await ctx.emit({ type: "STATE", stream, cursor: { head_ids: head } });
	}

	async function walkUsers(
		stream: typeof FOLLOWING | typeof FOLLOWERS,
		scene: string,
	): Promise<void> {
		const walk = await walkUserList(
			api,
			secUid,
			scene,
			maxPages,
			(record) => ctx.emitRecord(stream, record),
			notes,
		);
		assertComplete(stream, walk, false);
		await ctx.emit({ type: "STATE", stream, cursor: { count: walk.read } });
	}

	for (const stream of requested) {
		await ctx.emit({
			type: "PROGRESS",
			stream,
			message: `Reading your TikTok ${stream.replace("_", " ")}`,
		});
		const replacedBefore = notes.replaced;
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
		if (notes.replaced > replacedBefore) {
			// Unsafe text is stored as null; say so rather than drop it quietly.
			const replaced = notes.replaced - replacedBefore;
			connectorDiagnostic("tiktok", "text_replaced", { stream, replaced });
			await ctx.emit({
				type: "PROGRESS",
				stream,
				message: `${replaced} text ${replaced === 1 ? "field was" : "fields were"} not safe text and ${replaced === 1 ? "was" : "were"} stored as empty`,
			});
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
		probeSession: ({ page }) => hasTikTokSession(page),
		probeSessionIsAuthoritative: true,
		collect: (ctx: BrowserCollectContext) => collectTikTok(ctx),
	});
}
