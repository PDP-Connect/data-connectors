#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Discord browser connector (v0.1.0).
 *
 * Exports the signed-in owner's own Discord data from the discord.com web
 * app: their profile, the servers they are in, their linked accounts, and the
 * messages they themselves wrote in servers.
 *
 * Terms of service and legal basis. Discord's terms forbid automating a user
 * account outside its OAuth2 and bot APIs, and Discord can suspend or
 * terminate an account for it. Discord's OAuth2 scopes cannot read a user's
 * messages, so this data is not reachable through the permitted APIs. The
 * owner runs this connector on their own account, in their own signed-in
 * browser session, to obtain a copy of their own personal data: the right of
 * access and the right to data portability (GDPR Articles 15 and 20), and the
 * right to know (CCPA section 1798.110). It reads nothing that belongs to
 * another person: messages are kept only when the owner is the author. The
 * owner accepts the account risk by running it; README.md states that risk.
 * Discord's own "Request all of my Data" export is the route its terms allow.
 *
 * Collection. Every request is a same-origin GET made from inside the
 * discord.com page; nothing is fetched from the host. The connector does not
 * read the session token. It waits for the Discord client to send one of its
 * own API requests, keeps that request's headers in a closure in the page,
 * and reuses them (see page-script.ts). If the client sends no request in
 * time, the run ends; it never looks for the token elsewhere. There is no
 * credential in this code and no credential form: the owner signs in in the
 * browser, and the connector never types into the page or answers a captcha.
 *
 * Not collected: direct messages, group DMs and the friends list. The page
 * reader refuses every path but the four below, so those endpoints cannot be
 * reached through it. No WebSocket is opened and nothing is written.
 *
 *   GET /users/@me                        -> profile
 *   GET /users/@me/guilds                 -> servers
 *   GET /users/@me/connections            -> connections
 *   GET /guilds/{id}/messages/search      -> messages (author_id = owner)
 *
 * Budget (the constants below): one request at a time with a 3-5 s pause;
 * the newest 90 days of messages; about 1,000 messages and 25 servers per
 * run. A queue in STATE carries the remaining servers to later runs, which
 * then stop each server at the first message already collected.
 *
 * Tested surfaces (as of 2026-10-08): the header capture, the /shop
 * navigation that triggers it, and one 200 answer from each of the four
 * endpoints were checked by hand in a signed-in desktop session, English
 * locale. This code has not itself run against discord.com: its tests use
 * synthetic fixtures. Known untested: the signed-out redirect, 202, 429 and
 * captcha answers, search pages past the first, other locales, and the
 * mobile WebView. README.md keeps the full list.
 *
 * Reachability probe: exempt. Collection needs a signed-in browser session
 * and has no endpoint that answers without one.
 *
 * Streams: profile, servers, connections, messages.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type {
	BrowserCollectContext,
	EnsureSessionArgs,
	RecordData,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	apiGetExpression,
	DISCORD_ORIGIN,
	nudgeExpression,
	type PageApiResult,
	PROBE_EXPRESSION,
	VIEW_EXPRESSION,
	WATCH_EXPRESSION,
} from "./page-script.ts";
import {
	buildConnectionRecords,
	buildProfileRecord,
	buildServerRecords,
	compareSnowflakes,
	hasVerificationChallenge,
	isGlobalRateLimit,
	parseSearchPage,
	retryAfterMs,
	type SearchedServer,
	type SearchHit,
	snowflake,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

export const APP_URL = `${DISCORD_ORIGIN}/channels/@me`;
export const LOGIN_URL = `${DISCORD_ORIGIN}/login`;

/** Messages older than this many days are not collected. */
export const MESSAGE_WINDOW_DAYS = 90;
/** Most messages saved in one run, across all servers. */
export const MAX_MESSAGES_PER_RUN = 1000;
/** Most servers searched in one run; the rest wait in the STATE queue. */
export const MAX_SERVERS_PER_RUN = 25;
/** Hard stop on requests in one run, whatever the other limits allow. */
export const MAX_REQUESTS_PER_RUN = 100;
/** Shortest pause between two requests. */
export const REQUEST_PAUSE_MIN_MS = 3000;
/** Longest pause between two requests; each pause is random in the range. */
export const REQUEST_PAUSE_MAX_MS = 5000;
/** A 429 that asks for a longer wait than this ends the run instead. */
export const RATE_LIMIT_MAX_WAIT_MS = 10_000;
/** A search index that asks for a longer wait than this skips the server. */
export const SEARCH_INDEX_MAX_WAIT_MS = 10_000;
/** This many servers refusing the search in a row ends the run. */
export const MAX_CONSECUTIVE_SERVER_REFUSALS = 3;
/** How long to wait for the Discord client to send a request of its own. */
export const HEADER_CAPTURE_TIMEOUT_MS = 30_000;
/** How long one in-page request may take. Under the PageShim bridge timeout. */
const REQUEST_TIMEOUT_MS = 20_000;
/** Results per search page. Discord fixes it; the walk only relies on it. */
const SEARCH_PAGE_SIZE = 25;
/** Discord refuses a search offset past this. */
const MAX_SEARCH_OFFSET = 9975;
/** How long the app may take to show its signed-in or signed-out view. */
const APP_VIEW_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;
/** Polls before the first in-app navigation, and before the second. */
const PASSIVE_CAPTURE_POLLS = 6;
const AWAY_CAPTURE_POLLS = 24;

const PROFILE = "profile";
const SERVERS = "servers";
const CONNECTIONS = "connections";
const MESSAGES = "messages";
const STREAMS = [PROFILE, SERVERS, CONNECTIONS, MESSAGES] as const;
type Stream = (typeof STREAMS)[number];

/**
 * The part of the collect context this connector uses. Structural, so the
 * desktop runtime and the PageShim runtime both satisfy it.
 */
export interface DiscordCollectContext {
	collectionMode?: BrowserCollectContext["collectionMode"];
	emit: BrowserCollectContext["emit"];
	emitRecord: BrowserCollectContext["emitRecord"];
	page: DiscordPage;
	requested: BrowserCollectContext["requested"];
	state: Record<string, unknown>;
}

type DiscordPage = Pick<Page, "evaluate" | "goto">;

export interface DiscordCollectOptions {
	/**
	 * How to report work a run leaves for the next one without failing: the
	 * message or server limit, and servers whose search was refused or not
	 * ready. "skip_result" (default) emits SKIP_RESULT with a retry hint.
	 * "progress" is for a host that discards a stream's STATE when the stream
	 * has a SKIP_RESULT: there the queue would never advance.
	 */
	deferredWork?: "progress" | "skip_result";
	/** Test seams. Production uses the constants above and the real clock. */
	delay?: (ms: number) => Promise<void>;
	maxMessages?: number;
	maxRequests?: number;
	maxServers?: number;
	now?: () => number;
	random?: () => number;
}

/** Where a server's collected messages end, by message id. */
interface ServerCursor {
	/**
	 * Set while older messages are still to be read: the ids from `before_id`
	 * up to `newest_id` are collected, and the walk continues below
	 * `before_id`, which sat at `offset` in the search listing. It ends at
	 * `until_id` when everything at or below that id was collected earlier.
	 */
	backfill?: { before_id: string; offset: number; until_id?: string };
	/** Newest collected message id; a later run stops there. */
	newest_id: string | null;
}

/** The `messages` cursor. Ids and offsets only. */
interface MessagesState {
	/** Server ids in the order later runs search them. */
	queue?: string[];
	servers?: Record<string, ServerCursor>;
}

/** Why a run stops making requests. */
type RunStop =
	| "collection_interrupted"
	| "headers_unavailable"
	| "rate_limited"
	| "request_limit"
	| "sign_in_required"
	| "source_unreadable"
	| "verification_required";

const realDelay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Evaluate in the page's own JavaScript world. Patchright isolates
 * evaluate() by default, and the reader has to see the same
 * XMLHttpRequest and fetch the Discord client uses. PageShim has one world
 * and ignores the extra arguments. A failed evaluation reads as null.
 */
async function evaluateInPage<T>(
	page: DiscordPage,
	expression: string,
): Promise<T | null> {
	try {
		return await (
			page as unknown as {
				evaluate(
					expression: string,
					arg: undefined,
					options: undefined,
					isolatedContext: false,
				): Promise<T | null>;
			}
		).evaluate(expression, undefined, undefined, false);
	} catch {
		return null;
	}
}

/**
 * Whether the page shows a signed-in Discord app. It only reads the page, so
 * it is safe to repeat while the owner is part way through signing in.
 */
export async function probeDiscordBrowserSession(
	page: DiscordPage,
): Promise<boolean> {
	return (await evaluateInPage<boolean>(page, PROBE_EXPRESSION)) === true;
}

type AppView = "loading" | "signed_in" | "signed_out";

/**
 * Open the app and wait until it shows its signed-in or signed-out view.
 * Signed out, discord.com sends /channels/@me to /login after it loads.
 */
export async function openDiscordApp(
	page: DiscordPage,
	delay: (ms: number) => Promise<void> = realDelay,
): Promise<AppView> {
	await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
	let view: AppView = "loading";
	for (
		let waited = 0;
		waited < APP_VIEW_TIMEOUT_MS && view === "loading";
		waited += POLL_INTERVAL_MS
	) {
		await delay(POLL_INTERVAL_MS);
		view = (await evaluateInPage<AppView>(page, VIEW_EXPRESSION)) ?? "loading";
	}
	return view;
}

/** The session check that may navigate: used where no one is signing in. */
async function hasDiscordSession(page: DiscordPage): Promise<boolean> {
	if (await probeDiscordBrowserSession(page)) return true;
	await openDiscordApp(page);
	return probeDiscordBrowserSession(page);
}

export async function ensureDiscordSession(
	args: EnsureSessionArgs,
): Promise<void> {
	const { assist, capture, completeAssistance, page, sendInteraction } = args;
	if (await hasDiscordSession(page)) {
		return;
	}
	await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
	const ready = await manualBrowserLogin({
		assist,
		capture,
		completeAssistance,
		isProbeSuccessful: (ok) => ok === true,
		message:
			"Sign in to Discord in the secure browser, then continue. PDPP will verify the session before collecting.",
		page,
		probe: () => hasDiscordSession(page),
		readinessProbe: probeDiscordBrowserSession,
		readinessProbeOnHandoffPage: true,
		sendInteraction,
		timeoutSeconds: 30 * 60,
	});
	if (!ready) {
		throw new Error("discord_session_dead");
	}
}

interface CaptureStatus {
	captured?: boolean;
	transport?: string | null;
	version?: string | null;
	wrongPage?: boolean;
}

/**
 * Wait for the Discord client to send an API request of its own, so the page
 * reader holds the client's headers. An idle client sends none, so after a
 * short wait the page makes one in-app navigation away from Friends, then one
 * back. Returns null when no request was seen in time.
 */
async function captureClientHeaders(
	page: DiscordPage,
	delay: (ms: number) => Promise<void>,
): Promise<CaptureStatus | null> {
	const polls = Math.ceil(HEADER_CAPTURE_TIMEOUT_MS / POLL_INTERVAL_MS);
	let away = false;
	for (let poll = 0; poll < polls; poll += 1) {
		const status = await evaluateInPage<CaptureStatus>(page, WATCH_EXPRESSION);
		if (!status || status.wrongPage) return null;
		if (status.captured) {
			// Leave the app where the owner had it.
			if (away) await evaluateInPage(page, nudgeExpression("home"));
			return status;
		}
		if (poll === PASSIVE_CAPTURE_POLLS) {
			away = true;
			await evaluateInPage(page, nudgeExpression("away"));
		} else if (poll === PASSIVE_CAPTURE_POLLS + AWAY_CAPTURE_POLLS) {
			away = false;
			await evaluateInPage(page, nudgeExpression("home"));
		}
		await delay(POLL_INTERVAL_MS);
	}
	return null;
}

type ApiOutcome =
	| { kind: "stop"; stop: RunStop }
	| { kind: "response"; status: number; json: unknown; waitMs: number | null };

/**
 * The one path to the Discord API: one request at a time, a random pause
 * before each but the first, a request limit, and the rules for 401, 429,
 * captcha and server errors. A "stop" outcome ends the run.
 */
function createApi(page: DiscordPage, options: DiscordCollectOptions) {
	const delay = options.delay ?? realDelay;
	const random = options.random ?? Math.random;
	const maxRequests = options.maxRequests ?? MAX_REQUESTS_PER_RUN;
	let requests = 0;
	let rateLimits = 0;
	let extraPauseMs = 0;

	const send = async (path: string): Promise<PageApiResult | null> => {
		if (requests > 0) {
			const jitter = Math.floor(
				random() * (REQUEST_PAUSE_MAX_MS - REQUEST_PAUSE_MIN_MS + 1),
			);
			await delay(REQUEST_PAUSE_MIN_MS + jitter + extraPauseMs);
		}
		extraPauseMs = 0;
		requests += 1;
		return evaluateInPage<PageApiResult>(
			page,
			apiGetExpression(path, REQUEST_TIMEOUT_MS),
		);
	};

	const get = async (path: string): Promise<ApiOutcome> => {
		for (;;) {
			if (requests >= maxRequests) {
				return { kind: "stop", stop: "request_limit" };
			}
			const result = await send(path);
			if (result?.kind !== "response") {
				// The page reloaded, left discord.com, or the request did not finish.
				return { kind: "stop", stop: "collection_interrupted" };
			}
			const { json, status } = result;
			if (hasVerificationChallenge(json)) {
				return { kind: "stop", stop: "verification_required" };
			}
			if (status === 401) {
				return { kind: "stop", stop: "sign_in_required" };
			}
			const waitMs = retryAfterMs(json, result.retryAfterSeconds);
			if (status === 429) {
				rateLimits += 1;
				connectorDiagnostic("discord_browser", "rate_limited", {
					count: rateLimits,
					global: isGlobalRateLimit(json),
					retry_after_ms: waitMs,
				});
				if (
					rateLimits > 1 ||
					waitMs === null ||
					waitMs > RATE_LIMIT_MAX_WAIT_MS ||
					isGlobalRateLimit(json)
				) {
					return { kind: "stop", stop: "rate_limited" };
				}
				extraPauseMs = waitMs;
				continue;
			}
			if (status >= 500) {
				return { kind: "stop", stop: "collection_interrupted" };
			}
			return { kind: "response", status, json, waitMs };
		}
	};

	return {
		get,
		/** Add to the pause before the next request. */
		waitBeforeNext: (ms: number) => {
			extraPauseMs = Math.max(extraPauseMs, ms);
		},
		requests: () => requests,
	};
}

type Api = ReturnType<typeof createApi>;

/** A session endpoint answers 200 or the run stops: a refusal is not routine. */
async function getSessionResource(
	api: Api,
	path: string,
): Promise<{ ok: true; json: unknown } | { ok: false; stop: RunStop }> {
	const outcome = await api.get(path);
	if (outcome.kind === "stop") return { ok: false, stop: outcome.stop };
	if (outcome.status === 403) {
		return { ok: false, stop: "verification_required" };
	}
	if (outcome.status !== 200) return { ok: false, stop: "source_unreadable" };
	return { ok: true, json: outcome.json };
}

type ServerOutcome =
	/** The walk reached the end, the window, or the collected messages. */
	| { kind: "complete"; cursor: ServerCursor }
	/** The run's message limit was reached part way through. */
	| { kind: "limit"; cursor: ServerCursor }
	/** This server could not be searched now; the run goes on. */
	| { kind: "skipped"; cursor: ServerCursor; refused: boolean }
	| { kind: "stop"; cursor: ServerCursor; stop: RunStop };

interface ServerWalk {
	api: Api;
	budget: { messagesLeft: number };
	emitMessage: (record: RecordData) => Promise<void>;
	/** Messages sent before this instant are outside the window. */
	floorMs: number;
	ownerId: string;
	prior: ServerCursor | null;
	server: SearchedServer;
	untilMs: number | null;
}

/**
 * Read the owner's messages in one server, newest first.
 *
 * "head" reads from the top until the newest message already collected.
 * When an earlier run stopped part way (`backfill`), the walk then jumps to
 * where that run stopped and "tail" reads on from there. The jump is by
 * offset, which messages sent or deleted since can shift: the tail starts
 * one position early so the first hit should be the last collected message,
 * and steps back one page once when it is not.
 */
async function searchServer(walk: ServerWalk): Promise<ServerOutcome> {
	const { api, budget, floorMs, ownerId, prior, server, untilMs } = walk;
	const priorNewest = prior?.newest_id ?? null;
	const backfill = prior?.backfill ?? null;
	let mode: "head" | "tail" = "head";
	let offset = 0;
	let fresh = 0;
	let rewound = false;
	let tailStart = 0;
	let newestEmitted: string | null = null;
	let oldestEmitted: string | null = null;
	let pagesRead = 0;

	/** The cursor when the walk stops at listing position `position`. */
	const cut = (position: number): ServerCursor => {
		const newest = newestEmitted ?? priorNewest;
		if (mode === "tail" && backfill) {
			return {
				newest_id: newest,
				backfill: {
					...backfill,
					before_id: oldestEmitted ?? backfill.before_id,
					offset: position,
				},
			};
		}
		if (oldestEmitted === null) {
			return { newest_id: priorNewest, ...(backfill ? { backfill } : {}) };
		}
		return {
			newest_id: newest,
			backfill: {
				before_id: oldestEmitted,
				offset: position,
				// Everything at or below the old newest id is collected, unless an
				// older gap was still open: then the tail reads to the window.
				...(priorNewest !== null && !backfill ? { until_id: priorNewest } : {}),
			},
		};
	};
	const complete = (): ServerOutcome => ({
		kind: "complete",
		cursor: { newest_id: newestEmitted ?? priorNewest },
	});

	for (;;) {
		if (offset > MAX_SEARCH_OFFSET) return complete();
		const query = `author_id=${ownerId}&sort_by=timestamp&sort_order=desc&offset=${offset}`;
		const path = `/guilds/${server.id}/messages/search?${query}`;
		let outcome = await api.get(path);
		if (outcome.kind === "response" && outcome.status === 202) {
			// The search index is being built. Wait once, then leave this server.
			if (
				outcome.waitMs === null ||
				outcome.waitMs > SEARCH_INDEX_MAX_WAIT_MS
			) {
				return { kind: "skipped", cursor: cut(offset), refused: false };
			}
			api.waitBeforeNext(outcome.waitMs);
			outcome = await api.get(path);
		}
		if (outcome.kind === "stop") {
			return { kind: "stop", cursor: cut(offset), stop: outcome.stop };
		}
		if (outcome.status !== 200) {
			return {
				kind: "skipped",
				cursor: cut(offset),
				refused: outcome.status === 403,
			};
		}
		const page = parseSearchPage(outcome.json, server);
		if (!page.ok) {
			return { kind: "stop", cursor: cut(offset), stop: "source_unreadable" };
		}
		pagesRead += 1;
		if (pagesRead === 1 && page.unreadable > 0) {
			connectorDiagnostic("discord_browser", "search_hits_unreadable", {
				count: page.unreadable,
			});
		}

		const first = page.hits[0];
		if (
			mode === "tail" &&
			backfill &&
			!rewound &&
			offset === tailStart &&
			offset > 0 &&
			(!first || compareSnowflakes(first.id, backfill.before_id) < 0)
		) {
			// The last collected message is not where it was: look one page up.
			// More than a page of deletions since the last run leaves a gap.
			rewound = true;
			offset = Math.max(0, offset - SEARCH_PAGE_SIZE);
			continue;
		}

		let jumped = false;
		for (const [index, hit] of page.hits.entries()) {
			if (hit.timestampMs < floorMs) return complete();
			if (mode === "head") {
				if (
					priorNewest !== null &&
					compareSnowflakes(hit.id, priorNewest) <= 0
				) {
					if (!backfill) return complete();
					mode = "tail";
					tailStart = Math.max(0, backfill.offset + fresh - 1);
					offset = tailStart;
					jumped = true;
					break;
				}
				fresh += 1;
			} else if (backfill) {
				if (compareSnowflakes(hit.id, backfill.before_id) >= 0) continue;
				if (
					backfill.until_id !== undefined &&
					compareSnowflakes(hit.id, backfill.until_id) <= 0
				) {
					return complete();
				}
			}
			if (!isOwnMessage(hit, ownerId)) continue;
			if (untilMs !== null && hit.timestampMs >= untilMs) continue;
			if (budget.messagesLeft <= 0) {
				return { kind: "limit", cursor: cut(offset + index) };
			}
			await walk.emitMessage(hit.record);
			budget.messagesLeft -= 1;
			newestEmitted ??= hit.id;
			oldestEmitted = hit.id;
		}
		if (jumped) continue;
		if (
			page.hits.length < SEARCH_PAGE_SIZE ||
			offset + page.hits.length >= page.total
		) {
			return complete();
		}
		offset += SEARCH_PAGE_SIZE;
	}
}

/** Only the owner's own messages are kept. */
function isOwnMessage(hit: SearchHit, ownerId: string): boolean {
	return hit.authorId === ownerId;
}

function readMessagesState(value: unknown): Required<MessagesState> {
	const state = (value ?? {}) as MessagesState;
	const queue = Array.isArray(state.queue)
		? state.queue.filter((id): id is string => snowflake(id) !== null)
		: [];
	const servers: Record<string, ServerCursor> = {};
	if (state.servers && typeof state.servers === "object") {
		for (const [id, cursor] of Object.entries(state.servers)) {
			if (snowflake(id) === null || !cursor || typeof cursor !== "object") {
				continue;
			}
			const newest = snowflake(cursor.newest_id);
			const before = snowflake(cursor.backfill?.before_id);
			const until = snowflake(cursor.backfill?.until_id);
			const offset = cursor.backfill?.offset;
			servers[id] = {
				newest_id: newest,
				...(before !== null &&
				typeof offset === "number" &&
				Number.isSafeInteger(offset) &&
				offset >= 0
					? {
							backfill: {
								before_id: before,
								offset,
								...(until !== null ? { until_id: until } : {}),
							},
						}
					: {}),
			};
		}
	}
	return { queue, servers };
}

async function emitStop(
	ctx: DiscordCollectContext,
	stream: Stream,
	stop: RunStop,
): Promise<void> {
	switch (stop) {
		case "sign_in_required":
			await ctx.emit({
				type: "SKIP_RESULT",
				stream,
				reason: "discord_sign_in_required",
				recovery_hint: { action: "refresh_credentials", retryable: false },
				message: "Discord asked for a new login, so the run stopped.",
			});
			return;
		case "verification_required":
			await ctx.emit({
				type: "SKIP_RESULT",
				stream,
				reason: "discord_verification_required",
				recovery_hint: { action: "manual_action_required", retryable: false },
				message:
					"Discord asked for a captcha or an account check, or refused the request, so the run stopped without retrying.",
			});
			return;
		case "rate_limited":
			await ctx.emit({
				type: "SKIP_RESULT",
				stream,
				reason: "discord_rate_limited",
				recovery_hint: { action: "upstream_unblock", retryable: false },
				message: "Discord asked the run to slow down, so it stopped.",
			});
			return;
		case "headers_unavailable":
			await ctx.emit({
				type: "SKIP_RESULT",
				stream,
				reason: "discord_client_request_not_seen",
				recovery_hint: { action: "unknown", retryable: false },
				message:
					"The Discord app did not send a request of its own in time, so nothing was read.",
			});
			return;
		case "request_limit":
			await ctx.emit({
				type: "SKIP_RESULT",
				stream,
				reason: "discord_run_limit_reached",
				recovery_hint: { action: "retry_by_runtime", retryable: true },
				message:
					"This run reached its request limit. The next run continues from here.",
			});
			return;
		case "source_unreadable":
			await ctx.emit({
				type: "SKIP_RESULT",
				stream,
				reason: "discord_source_unreadable",
				recovery_hint: {
					action: "retry_on_connector_upgrade",
					retryable: false,
				},
				message:
					"Discord answered in a form this connector does not recognise, so nothing more was read.",
			});
			return;
		default:
			await ctx.emit({
				type: "SKIP_RESULT",
				stream,
				reason: "discord_collection_interrupted",
				recovery_hint: { action: "retry_by_runtime", retryable: true },
				message:
					"Discord stopped answering or the page changed part way through.",
			});
	}
}

/** Report work left for a later run that is not a failure of this one. */
async function emitDeferred(
	ctx: DiscordCollectContext,
	options: DiscordCollectOptions,
	kind: "limit" | "servers_skipped",
	message: string,
): Promise<void> {
	if (options.deferredWork === "progress") {
		await ctx.emit({ type: "PROGRESS", stream: MESSAGES, message });
		return;
	}
	if (kind === "limit") {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream: MESSAGES,
			reason: "discord_run_limit_reached",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			message,
		});
		return;
	}
	await ctx.emit({
		type: "SKIP_RESULT",
		stream: MESSAGES,
		reason: "discord_servers_skipped",
		recovery_hint: { action: "retry_by_runtime", retryable: true },
		message,
	});
}

async function emitUnreadable(
	ctx: DiscordCollectContext,
	stream: Stream,
	count: number,
): Promise<void> {
	await ctx.emit({
		type: "SKIP_RESULT",
		stream,
		reason: "discord_records_unreadable",
		recovery_hint: { action: "retry_on_connector_upgrade", retryable: false },
		message: `${count} ${count === 1 ? "entry" : "entries"} in Discord's answer had no usable id and ${count === 1 ? "was" : "were"} skipped.`,
	});
}

const plural = (count: number, one: string, many: string): string =>
	`${count} ${count === 1 ? one : many}`;

export async function collectDiscordBrowser(
	ctx: DiscordCollectContext,
	options: DiscordCollectOptions = {},
): Promise<void> {
	const requested = STREAMS.filter((stream) => ctx.requested.has(stream));
	if (requested.length === 0) {
		return;
	}
	const delay = options.delay ?? realDelay;
	const now = (options.now ?? Date.now)();
	const finished = new Set<Stream>();
	const fetchedAt = new Date(now).toISOString();
	const checkpoint = async (stream: Stream): Promise<void> => {
		finished.add(stream);
		await ctx.emit({
			type: "STATE",
			stream,
			cursor: { fetched_at: fetchedAt },
		});
	};
	/** End the run: every requested stream not finished reports why. */
	const stopRun = async (stop: RunStop): Promise<void> => {
		connectorDiagnostic("discord_browser", "run_stopped", { stop });
		for (const stream of requested) {
			if (!finished.has(stream)) await emitStop(ctx, stream, stop);
		}
	};

	if (!(await probeDiscordBrowserSession(ctx.page))) {
		const view = await openDiscordApp(ctx.page, delay);
		if (view === "signed_out") {
			await stopRun("sign_in_required");
			return;
		}
	}
	const capture = await captureClientHeaders(ctx.page, delay);
	if (!capture) {
		await stopRun("headers_unavailable");
		return;
	}
	const api = createApi(ctx.page, options);

	// The owner's id decides which messages are theirs, so it is read first.
	await ctx.emit({
		type: "PROGRESS",
		stream: PROFILE,
		message: "Reading your Discord profile",
	});
	const me = await getSessionResource(api, "/users/@me");
	if (!me.ok) {
		await stopRun(me.stop);
		return;
	}
	const profile = buildProfileRecord(me.json);
	if (!profile) {
		await stopRun("source_unreadable");
		return;
	}
	const ownerId = String(profile.id);
	if (ctx.requested.has(PROFILE)) {
		await ctx.emitRecord(PROFILE, profile);
		await checkpoint(PROFILE);
	}

	let serverIds: string[] = [];
	const serverNames = new Map<string, string | null>();
	if (ctx.requested.has(SERVERS) || ctx.requested.has(MESSAGES)) {
		await ctx.emit({
			type: "PROGRESS",
			stream: SERVERS,
			message: "Reading your Discord servers",
		});
		const guilds = await getSessionResource(api, "/users/@me/guilds");
		if (!guilds.ok) {
			await stopRun(guilds.stop);
			return;
		}
		const servers = buildServerRecords(guilds.json);
		if (!servers.ok) {
			await stopRun("source_unreadable");
			return;
		}
		serverIds = servers.records.map((record) => String(record.id));
		for (const record of servers.records) {
			serverNames.set(
				String(record.id),
				typeof record.name === "string" ? record.name : null,
			);
		}
		if (ctx.requested.has(SERVERS)) {
			for (const record of servers.records) {
				await ctx.emitRecord(SERVERS, record);
			}
			if (servers.unreadable > 0) {
				finished.add(SERVERS);
				await emitUnreadable(ctx, SERVERS, servers.unreadable);
			} else {
				await checkpoint(SERVERS);
			}
		}
	}

	if (ctx.requested.has(CONNECTIONS)) {
		await ctx.emit({
			type: "PROGRESS",
			stream: CONNECTIONS,
			message: "Reading your linked accounts",
		});
		const linked = await getSessionResource(api, "/users/@me/connections");
		if (!linked.ok) {
			await stopRun(linked.stop);
			return;
		}
		const connections = buildConnectionRecords(linked.json);
		if (!connections.ok) {
			await stopRun("source_unreadable");
			return;
		}
		for (const record of connections.records) {
			await ctx.emitRecord(CONNECTIONS, record);
		}
		if (connections.unreadable > 0) {
			finished.add(CONNECTIONS);
			await emitUnreadable(ctx, CONNECTIONS, connections.unreadable);
		} else {
			await checkpoint(CONNECTIONS);
		}
	}

	if (!ctx.requested.has(MESSAGES)) {
		return;
	}

	const fullRefresh = ctx.collectionMode === "full_refresh";
	const stored = readMessagesState(fullRefresh ? null : ctx.state[MESSAGES]);
	const joined = new Set(serverIds);
	const cursors: Record<string, ServerCursor> = {};
	for (const [id, cursor] of Object.entries(stored.servers)) {
		if (joined.has(id)) cursors[id] = cursor;
	}
	// Servers never searched come first, then the stored order.
	const known = stored.queue.filter((id) => joined.has(id));
	const knownSet = new Set(known);
	const queue = [...serverIds.filter((id) => !knownSet.has(id)), ...known];

	const timeRange = ctx.requested.get(MESSAGES)?.time_range;
	const sinceMs = timeRange?.since ? Date.parse(timeRange.since) : Number.NaN;
	const untilParsed = timeRange?.until
		? Date.parse(timeRange.until)
		: Number.NaN;
	const windowFloorMs = now - MESSAGE_WINDOW_DAYS * 86_400_000;
	const floorMs = Number.isNaN(sinceMs)
		? windowFloorMs
		: Math.max(windowFloorMs, sinceMs);
	const budget = { messagesLeft: options.maxMessages ?? MAX_MESSAGES_PER_RUN };
	const maxServers = options.maxServers ?? MAX_SERVERS_PER_RUN;
	const searched: string[] = [];
	let saved = 0;
	let skippedServers = 0;
	let refusals = 0;
	let limitReached = false;
	let stop: RunStop | null = null;

	for (const serverId of queue.slice(0, maxServers)) {
		if (budget.messagesLeft <= 0) {
			limitReached = true;
			break;
		}
		await ctx.emit({
			type: "PROGRESS",
			stream: MESSAGES,
			message: `Searching your messages in server ${searched.length + 1} of ${queue.length}`,
			count: saved,
		});
		const outcome = await searchServer({
			api,
			budget,
			emitMessage: async (record) => {
				await ctx.emitRecord(MESSAGES, record);
				saved += 1;
			},
			floorMs,
			ownerId,
			prior: cursors[serverId] ?? null,
			server: { id: serverId, name: serverNames.get(serverId) ?? null },
			untilMs: Number.isNaN(untilParsed) ? null : untilParsed,
		});
		// A server stopped before anything was read keeps no cursor, so it still
		// counts as waiting.
		if (
			outcome.kind === "complete" ||
			outcome.kind === "skipped" ||
			cursors[serverId] !== undefined ||
			outcome.cursor.backfill !== undefined
		) {
			cursors[serverId] = outcome.cursor;
		}
		if (outcome.kind === "stop") {
			if (outcome.stop === "request_limit") limitReached = true;
			else stop = outcome.stop;
			break;
		}
		if (outcome.kind === "limit") {
			limitReached = true;
			break;
		}
		searched.push(serverId);
		if (outcome.kind === "skipped") {
			skippedServers += 1;
			refusals = outcome.refused ? refusals + 1 : 0;
			if (refusals >= MAX_CONSECUTIVE_SERVER_REFUSALS) {
				stop = "verification_required";
				break;
			}
		} else {
			refusals = 0;
		}
	}

	// Searched servers go to the back; a server stopped part way stays in front.
	const searchedSet = new Set(searched);
	const nextQueue = [
		...queue.filter((id) => !searchedSet.has(id)),
		...searched,
	];
	const waiting = queue.filter(
		(id) => cursors[id] === undefined || cursors[id]?.backfill !== undefined,
	).length;

	if (stop) {
		await stopRun(stop);
	} else {
		if (skippedServers > 0) {
			await emitDeferred(
				ctx,
				options,
				"servers_skipped",
				`${plural(skippedServers, "server", "servers")} could not be searched this time. A later run tries again.`,
			);
		}
		if (limitReached || waiting > 0) {
			await emitDeferred(
				ctx,
				options,
				"limit",
				waiting > 0
					? `This run saved ${plural(saved, "message", "messages")} and reached its limit. ${plural(waiting, "server is", "servers are")} left for the next run.`
					: `This run saved ${plural(saved, "message", "messages")} and reached its limit. The next run continues from here.`,
			);
		}
	}

	connectorDiagnostic("discord_browser", "coverage", {
		stream: MESSAGES,
		status: stop ? "stopped" : waiting > 0 ? "partial" : "complete",
		api_version: capture.version,
		client_transport: capture.transport,
		requests: api.requests(),
		servers_total: queue.length,
		servers_searched: searched.length,
		servers_skipped: skippedServers,
		servers_waiting: waiting,
		messages_saved: saved,
	});
	await ctx.emit({
		type: "PROGRESS",
		stream: MESSAGES,
		count: saved,
		message:
			waiting > 0
				? `Finished this Discord run: ${plural(saved, "message", "messages")} saved, ${plural(waiting, "server", "servers")} still to search`
				: `Finished reading Discord: ${plural(saved, "message", "messages")} saved`,
	});
	await ctx.emit({
		type: "STATE",
		stream: MESSAGES,
		cursor: { queue: nextQueue, servers: cursors },
	});
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "discord_browser",
		validateRecord,
		browser: { profileName: "discord_browser" },
		ensureSession: ensureDiscordSession,
		probeSession: ({ page }) => hasDiscordSession(page),
		probeSessionIsAuthoritative: true,
		collect: (ctx: BrowserCollectContext) => collectDiscordBrowser(ctx),
	});
}
