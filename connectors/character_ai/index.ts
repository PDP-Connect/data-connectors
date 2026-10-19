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
 * No token, a 401, or a JSON 403 fails with `character_ai_auth_failed`.
 *
 * Completeness: the chat list and every chat's turns are walked until the
 * source's own end signal (no next token). A chat whose turns are missing
 * (404), never prove their end, are still generating, or cannot be stored
 * faithfully gets a DETAIL_GAP and is retried next run; the unreadable cases
 * also fail the `messages` stream. Rate limits, outages, auth failures and
 * bot checks fail the whole run (retryable where the cause is transient).
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
	emitDetailCoverage,
	emitDetailGap,
	politeDelay,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	buildChatRecord,
	buildMessageRecord,
	type ChatHydration,
	characterNameFromTurns,
	checkTurn,
	latestTime,
	type Page,
	parseChatDetail,
	parseChatsPage,
	parseTurnsPage,
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

async function neoGetJson(
	page: PageHandle,
	path: string,
	query: Record<string, string>,
): Promise<unknown> {
	const response = await neoFetch(page, {
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

/** Reads the tab's origin from inside the page (the mobile PageShim host has no page.url()). */
async function onCharacterAi(page: PageHandle): Promise<boolean> {
	try {
		return (await page.evaluate(() => location.origin)) === ORIGIN;
	} catch {
		return false;
	}
}

export async function probeCharacterAiSession(
	page: PageHandle,
): Promise<boolean> {
	if (!(await onCharacterAi(page))) {
		return false;
	}
	try {
		const response = await neoFetch(page, {
			path: "/user/",
			query: {},
			timeoutMs: REQUEST_TIMEOUT_MS,
		});
		return classifyFailure("/user/", response) === null;
	} catch {
		return false;
	}
}

async function hasCharacterAiSession(page: PageHandle): Promise<boolean> {
	if (!(await onCharacterAi(page))) {
		await page.goto(HOME, { waitUntil: "domcontentloaded" });
	}
	return probeCharacterAiSession(page);
}

export async function ensureCharacterAiSession(
	args: EnsureSessionArgs,
): Promise<void> {
	const { assist, capture, completeAssistance, page, sendInteraction } = args;
	if (await hasCharacterAiSession(page)) {
		return;
	}
	const ready = await manualBrowserLogin({
		assist,
		capture,
		completeAssistance,
		isProbeSuccessful: (ok) => ok === true,
		message:
			"Sign in to Character.AI in the secure browser, then continue. PDPP will verify the session before collecting.",
		page,
		probe: () => hasCharacterAiSession(page),
		readinessProbe: probeCharacterAiSession,
		readinessProbeOnHandoffPage: true,
		sendInteraction,
		timeoutSeconds: 30 * 60,
	});
	if (!ready) {
		throw new Error("character_ai_auth_failed: sign-in was not completed");
	}
}

// ─── Collection ──────────────────────────────────────────────────────────

/**
 * The chat list. Its first page is requested exactly as the web app does;
 * later pages pass the response's `meta.next_token` back as `next_token`
 * (the observed account fit on one page, so that parameter name is inferred).
 */
async function fetchChats(page: PageHandle): Promise<ApiChat[]> {
	const walk = await walkTokenPages<ApiChat>({
		fetchPage: async (token): Promise<Page<ApiChat>> => {
			const query: Record<string, string> = { include_restricted: "true" };
			if (token) {
				query.next_token = token;
				await politeDelay(PAGE_DELAY_MS);
			}
			return parseChatsPage(await neoGetJson(page, "/chats/recent/", query));
		},
		keyOf: (chat) => chat.chat_id,
		maxPages: MAX_CHAT_LIST_PAGES,
	});
	if (!walk.complete) {
		throw new Error(`character_ai_list_incomplete: chat list ${walk.reason}`);
	}
	return walk.items;
}

type GapReason = "temporary_unavailable" | "retry_exhausted";

type TurnsOutcome =
	| { ok: true; turns: ApiTurn[] }
	| {
			ok: false;
			reason: GapReason;
			status?: number;
			message: string;
			unreadable: boolean;
	  };

function gapOutcome(
	reason: GapReason,
	message: string,
	unreadable: boolean,
): Extract<TurnsOutcome, { ok: false }> {
	return { ok: false, reason, message, unreadable };
}

/**
 * Every turn of a chat, read to the list's end. Only per-chat conditions
 * become a failed outcome (gap): the turns answer 404 or the turn list
 * never proved its end. Rate limits, outages, auth and bot checks throw and
 * fail the run, so it is retried as a whole. Whether each turn can be stored
 * as a message is a separate question (storableTurns), asked only when
 * messages are emitted: a complete walk always hydrates the chat record.
 */
async function fetchTurns(
	page: PageHandle,
	chatId: string,
): Promise<TurnsOutcome> {
	let walk: Awaited<ReturnType<typeof walkTokenPages<ApiTurn>>>;
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
			return {
				ok: false,
				reason: "temporary_unavailable",
				status: 404,
				message: error.message,
				unreadable: false,
			};
		}
		throw error;
	}
	if (!walk.complete) {
		return gapOutcome("retry_exhausted", `turn list ${walk.reason}`, true);
	}
	return { ok: true, turns: walk.items };
}

/**
 * The messages-side check, before any message of a chat is emitted: every
 * turn needs a final, PDPP-safe selected candidate. Returns the gap outcome
 * for the first turn that fails, or null when all can be stored.
 */
function unstorableTurns(
	turns: ApiTurn[],
): Extract<TurnsOutcome, { ok: false }> | null {
	for (const turn of turns) {
		const checked = checkTurn(turn);
		if (!checked.ok) {
			return checked.kind === "generating"
				? gapOutcome(
						"temporary_unavailable",
						`a turn is still generating: ${checked.detail}`,
						false,
					)
				: gapOutcome(
						"retry_exhausted",
						`a turn cannot be stored: ${checked.detail}`,
						true,
					);
		}
	}
	return null;
}

/** GET /chat/:chat_id/ for a chat the list did not return; null when it answers 404. */
async function fetchChatDetail(
	page: PageHandle,
	chatId: string,
): Promise<ApiChat | null> {
	try {
		return parseChatDetail(await neoGetJson(page, `/chat/${chatId}/`, {}));
	} catch (error) {
		if (error instanceof NeoRequestError && error.kind === "not_found") {
			return null;
		}
		throw error;
	}
}

interface PendingGap {
	gapId: string;
	leaseId?: string;
}

/** Pending `messages` gaps from START, by chat id (absent detail_gaps = none). */
function pendingGapsByChat(
	ctx: BrowserCollectContext,
): Map<string, PendingGap[]> {
	const byChat = new Map<string, PendingGap[]>();
	for (const gap of ctx.detailGaps ?? []) {
		const fromLocator = gap.detail_locator?.chat_id;
		const chatId =
			typeof fromLocator === "string" ? fromLocator : gap.record_key;
		if (
			gap.stream !== "messages" ||
			typeof chatId !== "string" ||
			!uuidSchema.safeParse(chatId).success
		) {
			continue;
		}
		const list = byChat.get(chatId) ?? [];
		list.push({
			gapId: gap.gap_id,
			...(gap.lease_id ? { leaseId: gap.lease_id } : {}),
		});
		byChat.set(chatId, list);
	}
	return byChat;
}

interface MessagesTally {
	gapKeys: string[];
	hydratedKeys: string[];
	turnsEmitted: number;
	unreadable: number;
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

async function recordGap(
	ctx: BrowserCollectContext,
	chatId: string,
	outcome: Extract<TurnsOutcome, { ok: false }>,
	tally: MessagesTally,
): Promise<void> {
	await emitDetailGap(ctx, {
		stream: "messages",
		parentStream: "chats",
		recordKey: chatId,
		reason: outcome.reason,
		locator: { kind: "character_ai.chat_turns", chat_id: chatId },
		error: {
			class: outcome.reason,
			...(outcome.status === undefined ? {} : { httpStatus: outcome.status }),
			message: outcome.message,
		},
	});
	tally.gapKeys.push(chatId);
	if (outcome.unreadable) {
		tally.unreadable += 1;
	}
	connectorDiagnostic("character_ai", "chat_turns_gap", {
		reason: outcome.reason,
		detail: outcome.message,
	});
}

/** Close each pending gap for a chat whose parent was emitted and whose turns were fully read and emitted. */
async function recoverGaps(
	ctx: BrowserCollectContext,
	chatId: string,
	pending: Map<string, PendingGap[]>,
) {
	for (const gap of pending.get(chatId) ?? []) {
		await ctx.emit({
			type: "DETAIL_GAP_RECOVERED",
			reference_only: true,
			gap_id: gap.gapId,
			stream: "messages",
			record_key: chatId,
			...(gap.leaseId ? { lease_id: gap.leaseId } : {}),
		});
	}
}

interface RunDeps {
	pending: Map<string, PendingGap[]>;
	tally: MessagesTally;
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
	if (!deps.wantMessages) {
		return outcome.ok ? outcome.turns : null;
	}
	const failure = outcome.ok ? unstorableTurns(outcome.turns) : outcome;
	if (failure) {
		await recordGap(ctx, chat.chat_id, failure, deps.tally);
		return outcome.ok ? outcome.turns : null;
	}
	if (outcome.ok) {
		await emitTurns(ctx, outcome.turns, deps.tally);
		await recoverGaps(ctx, chat.chat_id, deps.pending);
		deps.tally.hydratedKeys.push(chat.chat_id);
		return outcome.turns;
	}
	return null;
}

/**
 * A pending gap for a chat the list did not return this run: its parent is
 * read from GET /chat/:id/ and emitted before any child. A 404 there keeps
 * the gap open.
 */
async function processUnlistedChat(
	ctx: BrowserCollectContext,
	chatId: string,
	deps: RunDeps,
): Promise<void> {
	const chat = await fetchChatDetail(ctx.page, chatId);
	if (chat === null) {
		// A 404 proves nothing was read: the pending gap stays open (re-emitted)
		// and the messages stream fails, so no checkpoint treats it as recovered.
		await recordGap(
			ctx,
			chatId,
			gapOutcome(
				"temporary_unavailable",
				"character_ai_api_404 on /chat/:chat_id/: the chat could not be read",
				true,
			),
			deps.tally,
		);
		return;
	}
	await processChat(ctx, chat, deps);
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
	});
	if (tally.unreadable > 0) {
		await ctx.reportStreamFailure?.(
			"messages",
			`Character.AI: ${tally.unreadable} chat(s) could not be read completely (unproven end of the turn list or a turn that cannot be stored); they will be retried next run.`,
			{ retryable: true },
		);
	} else if (
		listed > 0 &&
		tally.hydratedKeys.length > 0 &&
		tally.turnsEmitted === 0
	) {
		await ctx.reportStreamFailure?.(
			"messages",
			`Character.AI listed ${listed} chat(s) but returned no turns for any of them.`,
			{ retryable: true },
		);
	}
}

async function recoverOnly(
	ctx: BrowserCollectContext,
	deps: RunDeps,
): Promise<void> {
	const keys = [...deps.pending.keys()];
	for (const chatId of keys) {
		await processUnlistedChat(ctx, chatId, deps);
	}
	// Coverage is reported even for an empty recovery pass: it is the run's
	// evidence that there was nothing pending to read.
	await finishMessages(ctx, keys, deps.tally, 0);
}

export async function collectCharacterAi(
	ctx: BrowserCollectContext,
): Promise<void> {
	const wantChats = ctx.requested.has("chats");
	if (!wantChats) {
		// Every message hangs off a chat record that must precede it in the run;
		// without the parent stream in scope no child can be emitted honestly.
		if (ctx.requested.has("messages")) {
			await ctx.reportStreamFailure?.(
				"messages",
				"Character.AI messages need the chats stream in scope: each chat record is emitted before its messages.",
				{ retryable: false },
			);
		}
		return;
	}
	const wantMessages = ctx.requested.has("messages");
	if (!(await onCharacterAi(ctx.page))) {
		await ctx.page.goto(HOME, { waitUntil: "domcontentloaded" });
	}
	const deps: RunDeps = {
		pending: wantMessages ? pendingGapsByChat(ctx) : new Map(),
		tally: { gapKeys: [], hydratedKeys: [], turnsEmitted: 0, unreadable: 0 },
		wantMessages,
	};
	if (ctx.recoveryOnly === true) {
		if (wantMessages) {
			await recoverOnly(ctx, deps);
		}
		return;
	}

	await ctx.progress("Reading the Character.AI chat list", { stream: "chats" });
	const chats = await fetchChats(ctx.page);
	const listedIds = new Set(chats.map((chat) => chat.chat_id));
	const unlisted = [...deps.pending.keys()].filter(
		(chatId) => !listedIds.has(chatId),
	);
	const latest: Array<string | null> = [];
	let index = 0;
	for (const chat of chats) {
		index += 1;
		await ctx.progress(
			`Reading Character.AI chat ${index} of ${chats.length}`,
			{ stream: "messages" },
		);
		const turns = await processChat(ctx, chat, deps);
		if (turns) {
			latest.push(hydrationOf(turns).lastInteractionTime);
		}
	}
	for (const chatId of unlisted) {
		await processUnlistedChat(ctx, chatId, deps);
	}
	if (wantMessages) {
		await finishMessages(
			ctx,
			[...chats.map((chat) => chat.chat_id), ...unlisted],
			deps.tally,
			chats.length,
		);
	}
	await ctx.emit({
		type: "STATE",
		stream: "chats",
		cursor: {
			last_interaction_time: latestTime(latest),
			chat_count: chats.length,
		},
	});
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "character_ai",
		validateRecord,
		retryablePattern:
			/character_ai_api_(?:429|5\d\d)|character_ai_timeout|character_ai_network_error|fetch failed/i,
		browser: { profileName: "character_ai" },
		ensureSession: ensureCharacterAiSession,
		probeSession: ({ page }) => hasCharacterAiSession(page),
		probeSessionIsAuthoritative: true,
		collect: collectCharacterAi,
	});
}
