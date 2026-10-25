// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Character.AI connector (browser session).
 *
 * Runs inside the owner's signed-in https://character.ai tab and reads the
 * same JSON API the web app uses, on https://neo.character.ai:
 *   - GET /chats/recent/?include_restricted=true[&next_token=...]  -> `chats`
 *   - GET /turns/<chat_id>/[?next_token=...]                       -> `messages`
 *
 * Auth: neo.character.ai calls carry an `authorization` header. The page
 * holds that API token itself; each in-page request reads it from the page
 * (the Next.js bootstrap `__NEXT_DATA__.props.pageProps.token`, then the
 * legacy `char_token` localStorage entry, then the `HTTP_AUTHORIZATION`
 * cookie) and sends it as `Token <value>`. The token never leaves the page:
 * it is not returned to the connector process, logged, or put in STATE.
 * During collection, no token, a 401, or a JSON 403 fails with
 * `character_ai_auth_failed`.
 *
 * Completeness: the chat list and every chat's turns are walked until the
 * source's own end signal (no next token). Coverage and STATE are written
 * only after the list proved its end; a list that did not keeps the chats it
 * saw and fails both streams retryably with no checkpoint. A chat whose turns
 * are missing (404), never prove their end, cannot be parsed, are still
 * generating, or cannot be stored faithfully gets a DETAIL_GAP for that chat
 * alone and is retried next run (pending gaps on every page the runtime
 * serves, also in a recovery-only run); the stream is not failed for it.
 * Stray control characters are dropped from display text, never the record.
 * A list row whose fields cannot be stored is read from GET /chat/:id/; a
 * chat that cannot be read there either is left out of this run (chats
 * coverage reads partial) and no child is accounted under it.
 * Rate limits, outages, auth failures and bot checks stop the whole run
 * (retryable where the cause is transient); a page that navigates or closes
 * under a request is retried once, then stops the run as
 * `character_ai_interrupted` (retryable).
 *
 * Session: a signed-in page is never moved. A Cloudflare check is handed to
 * the owner in place; a signed-out page goes to the sign-in page (the home
 * page, whose Login dialog offers Google, Apple and email) and is handed
 * over with manualBrowserLogin. Readiness is read without navigation.
 * Session errors are bare codes (`character_ai_auth_failed`,
 * `character_ai_interrupted`).
 *
 * Each run re-reads every listed chat (the list carries no last-activity
 * time to skip unchanged chats safely). `messages` is mutable state keyed by
 * turn id: a re-read replaces a turn whose selected candidate was swiped.
 *
 * Tested surfaces (as of 2026-10-19): factory test account, EN, one-on-one
 * chats only. Known untested: group chats/rooms, accounts with very long chat
 * lists (the list's paging parameter name is inferred, see fetchChats).
 */

import { isMainModule } from "@pdpp/connector-protocol";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type {
	BrowserCollectContext,
	EnsureSessionArgs,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	createConnectorFailure,
	emitDetailCoverage,
	emitDetailGap,
	politeDelay,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	buildChatRecord,
	buildMessageRecord,
	CharacterAiPayloadError,
	type ChatHydration,
	type ChatRow,
	characterNameFromTurns,
	checkTurn,
	latestTime,
	type Page,
	parseChatDetail,
	parseChatsPage,
	parseTurnsPage,
	type WalkResult,
	walkTokenPages,
} from "./parsers.ts";
import {
	type ApiChat,
	type ApiTurn,
	uuidSchema,
	validateRecord,
} from "./schemas.ts";

const HOME = "https://character.ai/";
const ORIGIN = "https://character.ai";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CHAT_LIST_PAGES = 200;
const MAX_TURN_PAGES = 2000;
const PAGE_DELAY_MS = 150;

type PageHandle = BrowserCollectContext["page"];

// ─── In-page API access ──────────────────────────────────────────────────

export interface NeoRequest {
	path: string;
	query: Record<string, string>;
	timeoutMs: number;
}

export interface NeoResponse {
	challenge: boolean;
	json: unknown;
	/** The body was not JSON (an HTML or plain-text page from a JSON endpoint). */
	nonJson: boolean;
	noToken: boolean;
	status: number;
	wrongOrigin: boolean;
}

/**
 * One GET against neo.character.ai, executed inside the character.ai page.
 * The token is read and used inside the page only.
 */
export function neoFetch(
	page: PageHandle,
	request: NeoRequest,
): Promise<NeoResponse> {
	return page.evaluate(async (req: NeoRequest): Promise<NeoResponse> => {
		const empty = {
			challenge: false,
			json: null,
			nonJson: false,
			noToken: false,
			status: 0,
			wrongOrigin: false,
		};
		if (location.origin !== "https://character.ai") {
			return { ...empty, wrongOrigin: true };
		}
		let token: unknown = null;
		try {
			token = JSON.parse(
				document.getElementById("__NEXT_DATA__")?.textContent || "{}",
			)?.props?.pageProps?.token;
		} catch {
			token = null;
		}
		if (typeof token !== "string" || token.length === 0) {
			try {
				token = JSON.parse(localStorage.getItem("char_token") || "{}")?.value;
			} catch {
				token = null;
			}
		}
		if (typeof token !== "string" || token.length === 0) {
			const match = (document.cookie || "").match(
				/(?:^|;\s*)HTTP_AUTHORIZATION=([^;]+)/,
			);
			token = match?.[1]
				? decodeURIComponent(match[1]).replace(/^"|"$/g, "")
				: null;
		}
		if (typeof token !== "string" || token.length === 0) {
			return { ...empty, noToken: true };
		}
		const authorization = /^(?:Token|Bearer) /.test(token)
			? token
			: `Token ${token}`;
		const url = new URL(req.path, "https://neo.character.ai");
		for (const [key, value] of Object.entries(req.query)) {
			url.searchParams.set(key, value);
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), req.timeoutMs);
		const init = {
			headers: { accept: "application/json", authorization },
			signal: controller.signal,
		};
		try {
			let response: Response;
			try {
				response = await fetch(url.toString(), {
					...init,
					credentials: "include",
				});
			} catch (error) {
				if (controller.signal.aborted) {
					throw new Error(`character_ai_timeout after ${req.timeoutMs}ms`);
				}
				// A CORS refusal of credentialed requests surfaces as a TypeError;
				// the API authenticates by header, so retry once without cookies.
				response = await fetch(url.toString(), {
					...init,
					credentials: "omit",
				}).catch((retryError: unknown) => {
					throw new Error(
						`character_ai_network_error: ${String(retryError ?? error)}`,
					);
				});
			}
			const contentType = response.headers.get("content-type") || "";
			const challenge = response.headers.get("cf-mitigated") === "challenge";
			const body = await response.text();
			let json: unknown = null;
			let nonJson = contentType.includes("text/html");
			if (!nonJson) {
				try {
					json = JSON.parse(body);
				} catch {
					nonJson = true;
				}
			}
			return { ...empty, challenge, json, nonJson, status: response.status };
		} finally {
			clearTimeout(timer);
		}
	}, request);
}

type NeoFailureKind =
	| "auth"
	| "challenge"
	| "rate_limited"
	| "unavailable"
	| "not_found";

export class NeoRequestError extends Error {
	readonly kind: NeoFailureKind;
	readonly status: number;
	constructor(kind: NeoFailureKind, status: number, message: string) {
		super(message);
		this.name = "NeoRequestError";
		this.kind = kind;
		this.status = status;
	}
}

function classifyFailure(
	path: string,
	response: NeoResponse,
): NeoRequestError | null {
	let route = path;
	if (path.startsWith("/turns/")) {
		route = "/turns/:chat_id/";
	} else if (path.startsWith("/chat/")) {
		route = "/chat/:chat_id/";
	}
	if (response.wrongOrigin) {
		return new NeoRequestError(
			"auth",
			0,
			"character_ai_auth_failed: the browser tab is not on character.ai",
		);
	}
	if (response.noToken) {
		return new NeoRequestError(
			"auth",
			0,
			"character_ai_auth_failed: no Character.AI API token in the page (signed out?)",
		);
	}
	const { status } = response;
	// A 401 is the session, whatever its body (an expired session can answer
	// with an empty, text or HTML page); only an explicit challenge outranks it.
	if (status === 401 && !response.challenge) {
		return new NeoRequestError(
			"auth",
			status,
			`character_ai_auth_failed: HTTP 401 on ${route}`,
		);
	}
	// These endpoints only ever answer JSON; any other body (an HTML or text
	// page, whatever its status) is a bot check or interstitial, not an outage.
	if (response.challenge || response.nonJson) {
		return new NeoRequestError(
			"challenge",
			status,
			`character_ai_challenge: non-JSON answer (HTTP ${status}) on ${route}`,
		);
	}
	if (status === 401 || status === 403) {
		return new NeoRequestError(
			"auth",
			status,
			`character_ai_auth_failed: HTTP ${status} on ${route}`,
		);
	}
	if (status === 429) {
		return new NeoRequestError(
			"rate_limited",
			status,
			`character_ai_api_429 on ${route}`,
		);
	}
	if (status === 404) {
		return new NeoRequestError(
			"not_found",
			status,
			`character_ai_api_404 on ${route}`,
		);
	}
	if (status < 200 || status >= 300) {
		return new NeoRequestError(
			"unavailable",
			status,
			`character_ai_api_${status} on ${route}`,
		);
	}
	return null;
}

/**
 * A page.evaluate that failed because the tab moved or closed under it (a
 * redirect still settling after sign-in, a reload, a closed window): the
 * request never reached Character.AI. It is retried once in place, then the
 * run stops retryably as `character_ai_interrupted`.
 */
export function isPageInterruption(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /Execution context was destroyed|context or browser has been closed|Target (?:page, context or browser )?(?:has been )?closed|has been closed|frame was detached/i.test(
		message,
	);
}

/** Pause before re-sending a request the page dropped by navigating or closing. */
export const INTERRUPTION_RETRY_MS = 1000;

async function neoFetchSettled(
	page: PageHandle,
	request: NeoRequest,
): Promise<NeoResponse> {
	try {
		return await neoFetch(page, request);
	} catch (error) {
		if (!isPageInterruption(error)) {
			throw error;
		}
	}
	await politeDelay(INTERRUPTION_RETRY_MS);
	try {
		return await neoFetch(page, request);
	} catch (error) {
		if (isPageInterruption(error)) {
			connectorDiagnostic("character_ai", "page_interrupted", {
				route: routeOf(request.path),
			});
			throw new Error(INTERRUPTED);
		}
		throw error;
	}
}

function routeOf(path: string): string {
	if (path.startsWith("/turns/")) {
		return "/turns/:chat_id/";
	}
	if (path.startsWith("/chat/")) {
		return "/chat/:chat_id/";
	}
	return path;
}

async function neoGetJson(
	page: PageHandle,
	path: string,
	query: Record<string, string>,
): Promise<unknown> {
	const response = await neoFetchSettled(page, {
		path,
		query,
		timeoutMs: REQUEST_TIMEOUT_MS,
	});
	const failure = classifyFailure(path, response);
	if (failure) {
		throw failure;
	}
	return response.json;
}

// ─── Session ─────────────────────────────────────────────────────────────

const AUTH_FAILED = "character_ai_auth_failed";
const INTERRUPTED = "character_ai_interrupted";
/** Character.AI signs in from its home page: "Login" opens a dialog there (Google, Apple, email). */
const SIGN_IN_URL = HOME;
const SESSION_TIMEOUT_MS = 15_000;
const SESSION_CHECK_RETRIES = 2;
const SESSION_RETRY_DELAY_MS = 1500;
const SIGN_IN_TIMEOUT_SECONDS = 30 * 60;
const SIGN_IN_MESSAGE =
	"Sign in to Character.AI in the secure browser, then continue. PDPP will verify the session before collecting.";
const CHALLENGE_MESSAGE =
	"Character.AI is showing a human check. Complete it in the secure browser, then continue. PDPP will verify the session before collecting.";

const realDelay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What the current page says about the session, read without moving it:
 *   - `signed_in`: GET neo.character.ai/user/ with the page's token answered;
 *   - `signed_out`: the page holds no API token, or the API answered 401/403;
 *   - `challenge`: a Cloudflare check holds the page or answered the request;
 *   - `off_origin`: the tab is not on character.ai;
 *   - `unknown`: anything else (the page went away, a timeout, a 5xx).
 */
export type CharacterAiSessionState =
	| "signed_in"
	| "signed_out"
	| "challenge"
	| "off_origin"
	| "unknown";

export async function checkCharacterAiSession(
	page: PageHandle,
): Promise<CharacterAiSessionState> {
	let shell: { origin: string; challenge: boolean };
	try {
		shell = await page.evaluate(() => ({
			origin: location.origin,
			challenge:
				(globalThis as { _cf_chl_opt?: unknown })._cf_chl_opt !== undefined ||
				(globalThis as { document?: { title?: unknown } }).document?.title ===
					"Just a moment...",
		}));
	} catch {
		return "unknown";
	}
	if (shell.origin !== ORIGIN) {
		return "off_origin";
	}
	if (shell.challenge) {
		return "challenge";
	}
	let response: NeoResponse;
	try {
		response = await neoFetch(page, {
			path: "/user/",
			query: {},
			timeoutMs: SESSION_TIMEOUT_MS,
		});
	} catch {
		return "unknown";
	}
	if (response.wrongOrigin) {
		return "off_origin";
	}
	const failure = classifyFailure("/user/", response);
	if (failure === null) {
		const body = response.json;
		return typeof body === "object" && body !== null && !Array.isArray(body)
			? "signed_in"
			: "unknown";
	}
	if (failure.kind === "auth") {
		return "signed_out";
	}
	return failure.kind === "challenge" ? "challenge" : "unknown";
}

/**
 * Whether the page's own session is signed in. Never navigates, so it is the
 * readiness check while the owner signs in (possibly on a Google or Apple
 * page) and the PageShim probe.
 */
export async function probeCharacterAiSession(
	page: PageHandle,
): Promise<boolean> {
	return (await checkCharacterAiSession(page)) === "signed_in";
}

/** Same probe, but first lands the run page on character.ai if it is elsewhere. */
export async function hasCharacterAiSession(
	page: PageHandle,
): Promise<boolean> {
	if ((await checkCharacterAiSession(page)) === "off_origin") {
		try {
			await page.goto(HOME, { waitUntil: "domcontentloaded" });
		} catch {
			return false;
		}
	}
	return probeCharacterAiSession(page);
}

function errorCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null) {
		return null;
	}
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string") {
		return code;
	}
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" && /^[a-z][a-z0-9_]*$/.test(message)
		? message
		: null;
}

function currentUrl(page: PageHandle): string | null {
	try {
		return page.url();
	} catch {
		return null;
	}
}

/**
 * Make sure the page is signed in before collection. A signed-in page is
 * never moved. A human check is handed to the owner in place. A signed-out
 * page goes to the sign-in page (the home page, whose Login dialog offers
 * Google, Apple and email) and is handed over with manualBrowserLogin.
 * Readiness during either handoff is read without navigation, so a sign-in
 * passing through Google or Apple is never pulled away. Errors are bare
 * codes: the runtime keeps a session error's code only when the whole
 * message is the code.
 */
export async function ensureCharacterAiSession(
	args: EnsureSessionArgs,
	/** Test seam: production uses the real clock. */
	delay: (ms: number) => Promise<void> = realDelay,
): Promise<void> {
	const { assist, capture, completeAssistance, page, sendInteraction } = args;
	let state = await checkCharacterAiSession(page);
	if (state === "off_origin") {
		try {
			await page.goto(HOME, { waitUntil: "domcontentloaded" });
		} catch {
			connectorDiagnostic("character_ai", "session_home_unreachable", {});
			throw new Error(INTERRUPTED);
		}
		state = await checkCharacterAiSession(page);
	}
	for (
		let retry = 0;
		state === "unknown" && retry < SESSION_CHECK_RETRIES;
		retry += 1
	) {
		await delay(SESSION_RETRY_DELAY_MS);
		state = await checkCharacterAiSession(page);
	}
	if (state === "signed_in") {
		return;
	}
	if (state === "unknown" || state === "off_origin") {
		connectorDiagnostic("character_ai", "session_check_no_answer", { state });
		throw new Error(INTERRUPTED);
	}
	if (state === "signed_out" && currentUrl(page) !== SIGN_IN_URL) {
		try {
			await page.goto(SIGN_IN_URL, { waitUntil: "domcontentloaded" });
		} catch {
			connectorDiagnostic("character_ai", "sign_in_page_unreachable", {});
			throw new Error(INTERRUPTED);
		}
	}
	let ready: boolean | undefined;
	try {
		ready = await manualBrowserLogin({
			assist,
			capture,
			completeAssistance,
			isProbeSuccessful: (ok) => ok === true,
			message: state === "challenge" ? CHALLENGE_MESSAGE : SIGN_IN_MESSAGE,
			page,
			// Never navigates, also after the owner says they are done on a host
			// without the streamed handoff.
			probe: () => probeCharacterAiSession(page),
			readinessProbe: probeCharacterAiSession,
			readinessProbeOnHandoffPage: true,
			reason: state === "challenge" ? "captcha" : "login",
			sendInteraction,
			timeoutSeconds: SIGN_IN_TIMEOUT_SECONDS,
		});
	} catch (error) {
		// The handoff's own failures, under this connector's bare codes: the
		// owner not finishing (a timeout, a cancelled sign-in) is a sign-in
		// failure; readiness checks that kept failing (the page went away) are
		// an interruption, retried as a whole.
		const code = errorCode(error);
		if (
			code === "browser_handoff_readiness_timed_out" ||
			code === "browser_sign_in_cancelled"
		) {
			connectorDiagnostic("character_ai", "sign_in_not_completed", { code });
			throw new Error(AUTH_FAILED);
		}
		if (
			code === "browser_handoff_readiness_probe_failed" ||
			isPageInterruption(error)
		) {
			connectorDiagnostic("character_ai", "sign_in_interrupted", { code });
			throw new Error(INTERRUPTED);
		}
		throw error;
	}
	if (!ready) {
		connectorDiagnostic("character_ai", "sign_in_not_completed", { state });
		throw new Error(AUTH_FAILED);
	}
}

/** Put the run page on character.ai; a navigation that fails stops the run retryably. */
async function landOnCharacterAi(page: PageHandle): Promise<void> {
	if (await onCharacterAi(page)) {
		return;
	}
	try {
		await page.goto(HOME, { waitUntil: "domcontentloaded" });
	} catch {
		connectorDiagnostic("character_ai", "home_unreachable", {});
		throw new Error(INTERRUPTED);
	}
}

/** Reads the tab's origin from inside the page (the mobile PageShim host has no page.url()). */
async function onCharacterAi(page: PageHandle): Promise<boolean> {
	try {
		return (await page.evaluate(() => location.origin)) === ORIGIN;
	} catch {
		return false;
	}
}

// ─── Collection ──────────────────────────────────────────────────────────

/**
 * The chat list. Its first page is requested exactly as the web app does;
 * later pages pass the response's `meta.next_token` back as `next_token`
 * (the observed account fit on one page, so that parameter name is inferred).
 * The result says whether the list proved its own end.
 */
function fetchChats(page: PageHandle): Promise<WalkResult<ChatRow>> {
	return walkTokenPages<ChatRow>({
		fetchPage: async (token): Promise<Page<ChatRow>> => {
			const query: Record<string, string> = { include_restricted: "true" };
			if (token) {
				query.next_token = token;
				await politeDelay(PAGE_DELAY_MS);
			}
			return parseChatsPage(await neoGetJson(page, "/chats/recent/", query));
		},
		keyOf: (row) => row.chatId,
		maxPages: MAX_CHAT_LIST_PAGES,
	});
}

type GapReason = "temporary_unavailable" | "retry_exhausted";

interface GapOutcome {
	ok: false;
	reason: GapReason;
	errorClass: string;
	status?: number;
	message: string;
}

type TurnsOutcome = { ok: true; turns: ApiTurn[] } | GapOutcome;

function gapOutcome(
	reason: GapReason,
	errorClass: string,
	message: string,
	status?: number,
): GapOutcome {
	return {
		ok: false,
		reason,
		errorClass,
		message,
		...(status === undefined ? {} : { status }),
	};
}

/**
 * Every turn of a chat, read to the list's end. Per-chat conditions become a
 * gap for that chat only: the turns answer 404, the turn list never proved
 * its end, or a page of turns cannot be read. Rate limits, outages, auth, bot
 * checks and a page that went away throw and stop the run, so it is retried
 * as a whole. Whether each turn can be stored as a message is a separate
 * question (unstorableTurns): a complete walk always hydrates the chat record.
 */
async function fetchTurns(
	page: PageHandle,
	chatId: string,
): Promise<TurnsOutcome> {
	let walk: WalkResult<ApiTurn>;
	try {
		walk = await walkTokenPages<ApiTurn>({
			fetchPage: async (token): Promise<Page<ApiTurn>> => {
				await politeDelay(PAGE_DELAY_MS);
				const query: Record<string, string> = token
					? { next_token: token }
					: {};
				return parseTurnsPage(
					await neoGetJson(page, `/turns/${chatId}/`, query),
					chatId,
				);
			},
			keyOf: (turn) => turn.turn_key.turn_id,
			maxPages: MAX_TURN_PAGES,
		});
	} catch (error) {
		if (error instanceof NeoRequestError && error.kind === "not_found") {
			return gapOutcome(
				"temporary_unavailable",
				"chat_turns_not_found",
				error.message,
				404,
			);
		}
		if (error instanceof CharacterAiPayloadError) {
			return gapOutcome(
				"retry_exhausted",
				"chat_turns_unreadable",
				error.message,
			);
		}
		throw error;
	}
	if (!walk.complete) {
		return gapOutcome(
			"retry_exhausted",
			"chat_turns_unproven_end",
			`turn list ${walk.reason}`,
		);
	}
	return { ok: true, turns: walk.items };
}

/**
 * The messages-side check, before any message of a chat is emitted: every
 * turn needs a final, PDPP-safe selected candidate. Returns the gap outcome
 * for the first turn that fails, or null when all can be stored.
 */
function unstorableTurns(turns: ApiTurn[]): GapOutcome | null {
	for (const turn of turns) {
		const checked = checkTurn(turn);
		if (!checked.ok) {
			return checked.kind === "generating"
				? gapOutcome(
						"temporary_unavailable",
						"turn_still_generating",
						`a turn is still generating: ${checked.detail}`,
					)
				: gapOutcome(
						"retry_exhausted",
						"turn_unstorable",
						`a turn cannot be stored: ${checked.detail}`,
					);
		}
	}
	return null;
}

/** GET /chat/:chat_id/ for a chat the list did not return; a gap outcome when it cannot be read. */
async function fetchChatDetail(
	page: PageHandle,
	chatId: string,
): Promise<{ ok: true; chat: ApiChat } | GapOutcome> {
	try {
		return {
			ok: true,
			chat: parseChatDetail(await neoGetJson(page, `/chat/${chatId}/`, {})),
		};
	} catch (error) {
		if (error instanceof NeoRequestError && error.kind === "not_found") {
			return gapOutcome(
				"temporary_unavailable",
				"chat_not_found",
				error.message,
				404,
			);
		}
		if (error instanceof CharacterAiPayloadError) {
			return gapOutcome("retry_exhausted", "chat_unreadable", error.message);
		}
		throw error;
	}
}

type GapEntry = BrowserCollectContext["detailGaps"][number];

interface PendingGap {
	gapId: string;
	leaseId?: string;
}

/** The pending gaps START carried; a host that does not track gaps leaves the field out. */
function startGaps(ctx: BrowserCollectContext): readonly GapEntry[] {
	const gaps: unknown = (ctx as { detailGaps?: unknown }).detailGaps;
	return Array.isArray(gaps) ? (gaps as GapEntry[]) : [];
}

/** The chat a `messages` gap of this connector is about, or null for any other gap. */
function gapChatId(gap: GapEntry): string | null {
	if (gap.stream !== "messages") {
		return null;
	}
	const fromLocator = (gap.detail_locator as { chat_id?: unknown } | undefined)
		?.chat_id;
	const chatId = typeof fromLocator === "string" ? fromLocator : gap.record_key;
	return typeof chatId === "string" && uuidSchema.safeParse(chatId).success
		? chatId
		: null;
}

function pendingGap(gap: GapEntry): PendingGap {
	const leaseId: unknown = (gap as { lease_id?: unknown }).lease_id;
	return typeof leaseId === "string" && leaseId.length > 0
		? { gapId: gap.gap_id, leaseId }
		: { gapId: gap.gap_id };
}

/** Pending `messages` gaps on one page of gaps, by chat id. */
function pendingGapsByChat(
	gaps: readonly GapEntry[],
): Map<string, PendingGap[]> {
	const byChat = new Map<string, PendingGap[]>();
	for (const gap of gaps) {
		const chatId = gapChatId(gap);
		if (chatId !== null) {
			byChat.set(chatId, [...(byChat.get(chatId) ?? []), pendingGap(gap)]);
		}
	}
	return byChat;
}

/**
 * Hand every pending `messages` gap past `first` to `handle` once: further
 * pages come from the runtime until a page holds no gap not already seen
 * (the runtime answers with the gaps still pending, so recovered ones drop
 * out and one re-emitted this run comes back, already seen).
 */
async function forEachLaterGapPage(
	ctx: BrowserCollectContext,
	seen: Set<string>,
	handle: (fresh: Map<string, PendingGap[]>) => Promise<void>,
): Promise<void> {
	if (typeof ctx.requestDetailGapPage !== "function") {
		return;
	}
	for (;;) {
		const page = await ctx.requestDetailGapPage({ streams: ["messages"] });
		const unseen = page.filter((gap) => !seen.has(gap.gap_id));
		for (const gap of unseen) {
			seen.add(gap.gap_id);
		}
		const fresh = pendingGapsByChat(unseen);
		if (fresh.size === 0) {
			return;
		}
		await handle(fresh);
	}
}

interface MessagesTally {
	gapKeys: string[];
	hydratedKeys: string[];
	turnsEmitted: number;
}

function hydrationOf(turns: ApiTurn[]): ChatHydration {
	return {
		lastInteractionTime: latestTime(turns.map((turn) => turn.create_time)),
		turnCount: turns.length,
	};
}

async function emitTurns(
	ctx: BrowserCollectContext,
	turns: ApiTurn[],
	tally: MessagesTally,
): Promise<void> {
	for (const turn of turns) {
		const checked = checkTurn(turn);
		if (!checked.ok) {
			throw new Error(
				`character_ai_internal: an unchecked turn reached emission (${checked.detail})`,
			);
		}
		await ctx.emitRecord("messages", buildMessageRecord(turn, checked));
		tally.turnsEmitted += 1;
	}
}

/**
 * The chat's messages are not stored this run. Every key in gap_keys gets a
 * DETAIL_GAP in this run, also one already pending: the runtime folds a
 * repeat into the pending gap. Only this chat is affected; the stream is not
 * failed, so one bad chat never holds back the checkpoint.
 */
async function recordGap(
	ctx: BrowserCollectContext,
	chatId: string,
	outcome: GapOutcome,
	tally: MessagesTally,
): Promise<void> {
	await emitDetailGap(ctx, {
		stream: "messages",
		parentStream: "chats",
		recordKey: chatId,
		reason: outcome.reason,
		locator: { kind: "character_ai.chat_turns", chat_id: chatId },
		error: {
			class: outcome.errorClass,
			...(outcome.status === undefined ? {} : { httpStatus: outcome.status }),
			message: outcome.message,
		},
	});
	tally.gapKeys.push(chatId);
	connectorDiagnostic("character_ai", "chat_turns_gap", {
		reason: outcome.reason,
		class: outcome.errorClass,
	});
}

/** Close each pending gap for a chat whose parent was emitted and whose turns were fully read and emitted. */
async function recoverGaps(
	ctx: BrowserCollectContext,
	chatId: string,
	gaps: readonly PendingGap[],
) {
	for (const gap of gaps) {
		await ctx.emit({
			type: "DETAIL_GAP_RECOVERED",
			reference_only: true,
			gap_id: gap.gapId,
			...(gap.leaseId ? { lease_id: gap.leaseId } : {}),
			stream: "messages",
			record_key: chatId,
		});
	}
}

interface RunDeps {
	pending: Map<string, PendingGap[]>;
	tally: MessagesTally;
	/** Chats whose parent could not be read this run; nothing was emitted for them. */
	unread: string[];
	wantMessages: boolean;
}

/**
 * Read one chat's turns, then emit, in order: its chat record (the parent),
 * then its messages and any gap recovery, or its DETAIL_GAP.
 */
async function processChat(
	ctx: BrowserCollectContext,
	chat: ApiChat,
	deps: RunDeps,
): Promise<ApiTurn[] | null> {
	const outcome = await fetchTurns(ctx.page, chat.chat_id);
	const parent =
		outcome.ok && !chat.character_name
			? { ...chat, character_name: characterNameFromTurns(chat, outcome.turns) }
			: chat;
	await ctx.emitRecord(
		"chats",
		buildChatRecord(parent, outcome.ok ? hydrationOf(outcome.turns) : null),
	);
	const turns = outcome.ok ? outcome.turns : null;
	if (!deps.wantMessages) {
		return turns;
	}
	const failure = outcome.ok ? unstorableTurns(outcome.turns) : outcome;
	if (failure) {
		await recordGap(ctx, chat.chat_id, failure, deps.tally);
		return turns;
	}
	await emitTurns(ctx, turns ?? [], deps.tally);
	await recoverGaps(ctx, chat.chat_id, deps.pending.get(chat.chat_id) ?? []);
	deps.tally.hydratedKeys.push(chat.chat_id);
	return turns;
}

/**
 * A chat read from GET /chat/:id/ rather than the list (a pending gap for a
 * chat the list did not return, or a list row whose fields cannot be
 * stored): its parent record is emitted before any child. When the detail
 * cannot be read either, nothing is emitted for the chat: no child may be
 * accounted under a parent this run did not emit, so a pending gap stays
 * pending as it was and the chat is left out of coverage. Returns whether
 * the parent was emitted.
 */
async function processChatByDetail(
	ctx: BrowserCollectContext,
	chatId: string,
	deps: RunDeps,
): Promise<boolean> {
	const detail = await fetchChatDetail(ctx.page, chatId);
	if (!detail.ok) {
		deps.unread.push(chatId);
		connectorDiagnostic("character_ai", "chat_detail_unread", {
			class: detail.errorClass,
		});
		return false;
	}
	await processChat(ctx, detail.chat, deps);
	return true;
}

/**
 * Report one stream as failed. A context without the runtime's reporter (a
 * hand-built caller) cannot carry a stream failure, so the run fails instead
 * of finishing as if the stream were complete.
 */
async function failStream(
	ctx: BrowserCollectContext,
	stream: string,
	message: string,
	retryable: boolean,
): Promise<void> {
	connectorDiagnostic("character_ai", "stream_failed", { stream, retryable });
	if (!ctx.reportStreamFailure) {
		throw createConnectorFailure("character_ai_stream_incomplete", message, {
			retryable,
		});
	}
	await ctx.reportStreamFailure(stream, message, { retryable });
}

async function finishMessages(
	ctx: BrowserCollectContext,
	requiredKeys: string[],
	tally: MessagesTally,
	listed: number,
) {
	await emitDetailCoverage(ctx, {
		stream: "messages",
		stateStream: "chats",
		requiredKeys,
		hydratedKeys: tally.hydratedKeys,
		gapKeys: tally.gapKeys,
		considered: requiredKeys.length,
		covered: tally.hydratedKeys.length,
	});
	if (tally.gapKeys.length > 0) {
		await ctx.progress(
			`${String(tally.gapKeys.length)} Character.AI chat(s) could not be read completely; they will be read again next time`,
			{ stream: "messages" },
		);
	}
	if (listed > 0 && tally.hydratedKeys.length > 0 && tally.turnsEmitted === 0) {
		await failStream(
			ctx,
			"messages",
			`Character.AI listed ${listed} chat(s) but returned no turns for any of them.`,
			true,
		);
	}
}

/**
 * A recovery-only run: every pending `messages` gap, on every page of gaps,
 * is re-read from its chat (detail, then turns) without walking the list.
 * Nothing is checkpointed.
 */
async function recoverOnly(
	ctx: BrowserCollectContext,
	deps: RunDeps,
): Promise<void> {
	const first = startGaps(ctx);
	const seen = new Set(first.map((gap) => gap.gap_id));
	const keys: string[] = [];
	const handle = async (fresh: Map<string, PendingGap[]>) => {
		for (const [chatId, gaps] of fresh) {
			if (keys.includes(chatId)) {
				// A further gap for a chat already read this run: closed only if that
				// read was complete; otherwise the chat's re-emitted gap stands.
				if (deps.tally.hydratedKeys.includes(chatId)) {
					await recoverGaps(ctx, chatId, gaps);
				}
				continue;
			}
			keys.push(chatId);
			deps.pending.set(chatId, gaps);
			await processChatByDetail(ctx, chatId, deps);
		}
	};
	await handle(pendingGapsByChat(first));
	await forEachLaterGapPage(ctx, seen, handle);
	// Coverage is reported even for an empty recovery pass: it is the run's
	// evidence that there was nothing pending to read.
	await finishMessages(
		ctx,
		keys.filter((chatId) => !deps.unread.includes(chatId)),
		deps.tally,
		0,
	);
}

export async function collectCharacterAi(
	ctx: BrowserCollectContext,
): Promise<void> {
	const wantChats = ctx.requested.has("chats");
	if (!wantChats) {
		// Every message hangs off a chat record that must precede it in the run;
		// without the parent stream in scope no child can be emitted honestly.
		if (ctx.requested.has("messages")) {
			await failStream(
				ctx,
				"messages",
				"Character.AI messages need the chats stream in scope: each chat record is emitted before its messages.",
				false,
			);
		}
		return;
	}
	const wantMessages = ctx.requested.has("messages");
	await landOnCharacterAi(ctx.page);
	const firstGaps = wantMessages ? startGaps(ctx) : [];
	const deps: RunDeps = {
		pending: pendingGapsByChat(firstGaps),
		tally: { gapKeys: [], hydratedKeys: [], turnsEmitted: 0 },
		unread: [],
		wantMessages,
	};
	if (ctx.recoveryOnly === true) {
		if (wantMessages) {
			await recoverOnly(ctx, deps);
		}
		return;
	}

	await ctx.progress("Reading the Character.AI chat list", { stream: "chats" });
	const walk = await fetchChats(ctx.page);
	if (!walk.complete) {
		// The chats seen are real and are kept, but none is read in depth and
		// nothing is checkpointed: a later run can prove the list's end.
		for (const row of walk.items) {
			if (row.chat !== null) {
				await ctx.emitRecord("chats", buildChatRecord(row.chat, null));
			}
		}
		connectorDiagnostic("character_ai", "chat_list_unproven", {
			reason: walk.reason,
		});
		const why = `Character.AI's chat list did not prove its end (${walk.reason}), so this run could not confirm it saw every chat. Nothing was checkpointed; the next run reads it again.`;
		for (const stream of ["chats", "messages"] as const) {
			if (ctx.requested.has(stream)) {
				await failStream(ctx, stream, why, true);
			}
		}
		return;
	}
	const rows = walk.items;
	// A list row with no usable chat id is a chat neither stream can account
	// for: both streams fail and neither claims coverage or checkpoints, while
	// every readable chat is still collected.
	const inventoryWhole = walk.unkeyed === 0;
	if (!inventoryWhole) {
		const why = `${String(walk.unkeyed)} row(s) of the Character.AI chat list carry no usable chat id and were skipped; the connector needs an update to read them.`;
		for (const stream of ["chats", "messages"] as const) {
			if (ctx.requested.has(stream)) {
				await failStream(ctx, stream, why, false);
			}
		}
	}

	const listedIds = new Set(rows.map((row) => row.chatId));
	const unlisted = [...deps.pending.keys()].filter(
		(chatId) => !listedIds.has(chatId),
	);
	const latest: Array<string | null> = [];
	let chatRecords = 0;
	let index = 0;
	for (const row of rows) {
		index += 1;
		await ctx.progress(`Reading Character.AI chat ${index} of ${rows.length}`, {
			stream: "messages",
		});
		if (row.chat === null) {
			// This row's fields cannot be stored as a chat record: the chat is
			// read from its own endpoint instead. If that fails too, only this
			// chat is left out (chats coverage reads partial); the rest is not.
			connectorDiagnostic("character_ai", "chat_row_unreadable", {
				detail: row.detail,
			});
			if (await processChatByDetail(ctx, row.chatId, deps)) {
				chatRecords += 1;
			}
			continue;
		}
		const turns = await processChat(ctx, row.chat, deps);
		chatRecords += 1;
		if (turns) {
			latest.push(hydrationOf(turns).lastInteractionTime);
		}
	}
	for (const chatId of unlisted) {
		await processChatByDetail(ctx, chatId, deps);
	}
	// Pending gaps beyond START's first page: a chat read completely this run
	// has its gaps acknowledged, one gapped again this run already re-emitted
	// its gap, and any other chat is read the way an unlisted one is.
	const extra: string[] = [];
	if (wantMessages) {
		await forEachLaterGapPage(
			ctx,
			new Set(firstGaps.map((gap) => gap.gap_id)),
			async (fresh) => {
				for (const [chatId, gaps] of fresh) {
					if (deps.tally.hydratedKeys.includes(chatId)) {
						await recoverGaps(ctx, chatId, gaps);
					} else if (
						!(
							deps.tally.gapKeys.includes(chatId) ||
							deps.unread.includes(chatId) ||
							extra.includes(chatId)
						)
					) {
						extra.push(chatId);
						deps.pending.set(chatId, gaps);
						await processChatByDetail(ctx, chatId, deps);
					}
				}
			},
		);
	}
	if (!inventoryWhole) {
		return;
	}
	await emitDetailCoverage(ctx, {
		stream: "chats",
		stateStream: "chats",
		requiredKeys: [],
		hydratedKeys: [],
		considered: rows.length,
		covered: chatRecords,
	});
	if (chatRecords < rows.length) {
		await ctx.progress(
			`${String(rows.length - chatRecords)} Character.AI chat(s) could not be read from the chat list and were skipped this run`,
			{ stream: "chats" },
		);
	}
	if (wantMessages) {
		await finishMessages(
			ctx,
			[...rows.map((row) => row.chatId), ...unlisted, ...extra].filter(
				(chatId) => !deps.unread.includes(chatId),
			),
			deps.tally,
			rows.length,
		);
	}
	await ctx.emit({
		type: "STATE",
		stream: "chats",
		cursor: {
			last_interaction_time: latestTime(latest),
			chat_count: rows.length,
		},
	});
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "character_ai",
		validateRecord,
		retryablePattern:
			/character_ai_api_(?:408|429|5\d\d)|character_ai_timeout|character_ai_network_error|character_ai_interrupted|fetch failed/i,
		browser: { profileName: "character_ai" },
		ensureSession: ensureCharacterAiSession,
		probeSession: ({ page }) => hasCharacterAiSession(page),
		probeSessionIsAuthoritative: true,
		collect: collectCharacterAi,
	});
}
