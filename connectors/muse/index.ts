#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Muse (Meta) connector: Meta's personal AI agent, read from the
 * signed-in muse.ai web app.
 *
 * Muse has no usable same-origin JSON API for its data. muse.ai's own
 * `/api/session` only describes the user's cloud VM; chats, memory, tasks and
 * files live on that VM and travel over an encrypted (Noise) WebSocket. The
 * web app talks to it through a request/response "gateway" client that it
 * exposes to React through a context provider. The connector finds that
 * client in the page (walking the React fiber tree for a provider value with
 * a `sendRequest` function and a `gatewayUrl` key, the factory recon's
 * locate script) and calls the same read methods the app calls, so the
 * app's own session does the encryption. Nothing is reverse-engineered on
 * the wire and no credential leaves the page.
 *
 * Read-only by construction: `assertReadOnlyCall` admits only the methods in
 * READ_METHODS, and `fs.raw` only for the five memory files at the workspace
 * root (MEMORY_FILE_NAMES). Every other method (credentials, callbacks,
 * deletes, updates, chat.stream, browser tasks, wallet, egress, sharing) and
 * every other path is refused before the page is touched.
 *
 * Streams and their end signals:
 *   - conversations: sessions.list {} plus {view:"archived"}; each answer is
 *     the whole list (no paging in the observed shape).
 *   - messages: chat.history per chat, child of conversations with
 *     parent_detail_accounting, paged back like the app does (`before_seq` =
 *     the smallest `seq` on the page) until `has_more: false`. A chat whose
 *     walk fails, repeats or stops moving back gets a DETAIL_GAP.
 *   - activities: activity.list {limit, before, capabilities}, newest first;
 *     `before` is the oldest activity's timestamp string as returned. Ends on
 *     a page with no activity, or at the saved watermark.
 *   - goals: goals.list per source; complete only on has_next_page false.
 *   - scheduled_tasks: tasks.list {} (whole list).
 *   - memory_files: fs.list {path:""} then fs.raw for each memory file.
 *   - files: fs.library {preset:"recents"} paged by offset until has_more
 *     false, cross-checked against total.
 *   - connected_apps: connectors.list {surface:"settings"}, connected or
 *     needs-reauth services only.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import { z } from "zod";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	type BrowserCollectContext,
	buildFullScanCoverageMessage,
	createConnectorFailure,
	type EnsureSessionArgs,
	emitDetailCoverage,
	emitDetailGap,
	type ProbeSessionArgs,
	politeDelay,
	type RecordData,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	activityId,
	buildActivityRecord,
	buildConnectedAppRecord,
	buildConversationRecord,
	buildFileRecord,
	buildGoalRecord,
	buildMemoryFileRecord,
	buildMessageRecord,
	buildScheduledTaskRecord,
	cursorKey,
	isConnectedApp,
	isFinalEvent,
	MEMORY_FILE_NAMES,
	type MuseLibraryEntry,
	type MuseSession,
	memoryFileEntries,
	type PageCursor,
	parseActivities,
	parseConnectors,
	parseFsList,
	parseGoals,
	parseHistory,
	parseLibrary,
	parseRawText,
	parseSchedules,
	parseSessionGet,
	parseSessionsPage,
	TextTally,
	uniqueEvents,
	zonedIsoToIso,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const MUSE_ORIGIN = "https://muse.ai";
const MUSE_HOME_URL = `${MUSE_ORIGIN}/`;
export const MUSE_LOGIN_MESSAGE =
	"Sign in to Muse in the secure browser. The import continues automatically once the Muse app has loaded.";

const CONVERSATIONS = "conversations";
const MESSAGES = "messages";
const ACTIVITIES = "activities";
const GOALS = "goals";
const SCHEDULED_TASKS = "scheduled_tasks";
const MEMORY_FILES = "memory_files";
const FILES = "files";
const CONNECTED_APPS = "connected_apps";

/** The app's own page size for chat.history. */
export const HISTORY_LIMIT = 50;
const MAX_HISTORY_PAGES = 2_000;
export const ACTIVITY_LIMIT = 30;
const MAX_ACTIVITY_PAGES = 500;
export const LIBRARY_LIMIT = 48;
const MAX_LIBRARY_PAGES = 500;
/** Complete library walks before a library that keeps changing fails the stream. */
const LIBRARY_WALKS = 3;
/** What the web app sends with activity.list. */
export const ACTIVITY_CAPABILITIES = [
	"ACTIVITY_FEED_GOALS",
	"ACTIVITY_FEED_PEER_CONVERSATIONS",
] as const;
/** The three goals.list calls the app makes. */
const GOAL_VARIANTS: ReadonlyArray<Record<string, string>> = [
	{ source: "user_goal" },
	{ source: "assistant_tracking" },
	{ status: "completed" },
];
const MAX_GOAL_PAGES = 200;
/** sessions.list page size, and pages per view before the walk fails. */
export const SESSIONS_LIMIT = 100;
const MAX_SESSION_PAGES = 1_000;

/** Gateway client lookups before the app counts as not signed in / not loaded. */
const GATEWAY_WAIT_ATTEMPTS = 20;
const GATEWAY_WAIT_MS = 1_500;
const RPC_TIMEOUT_MS = 60_000;
const CURSOR_VERSION = 1;
/** Version 1 held a single update-time watermark; it is not read back. */
const CHATS_CURSOR_VERSION = 2;
const FRACTION_RE = /\.\d+/;

type Page = BrowserCollectContext["page"];

/** What the gateway helpers need from a page: run a script string in it. */
export interface ScriptRunner {
	evaluate(script: string): Promise<unknown>;
}

// ─── The page's gateway client ──────────────────────────────────────────

/** The only gateway methods this connector may call. All are reads. */
export const READ_METHODS: ReadonlySet<string> = new Set([
	"sessions.list",
	"sessions.get",
	"chat.history",
	"activity.list",
	"goals.list",
	"tasks.list",
	"fs.list",
	"fs.raw",
	"fs.library",
	"connectors.list",
]);

/** Refuse anything but a read, and fs.raw of anything but a memory file. */
export function assertReadOnlyCall(
	method: string,
	params: Record<string, unknown>,
): void {
	if (!READ_METHODS.has(method)) {
		throw new Error(`muse_refused_call: ${method} is not a read method`);
	}
	if (method === "fs.raw") {
		const path = params.path;
		if (
			typeof path !== "string" ||
			!(MEMORY_FILE_NAMES as readonly string[]).includes(path)
		) {
			throw new Error("muse_refused_call: fs.raw is limited to memory files");
		}
	}
	if (method === "fs.list" && params.path !== "") {
		throw new Error("muse_refused_call: fs.list is limited to the root");
	}
}

/** A read of the user's Muse VM through the page's gateway client. */
export interface MuseGateway {
	call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** The gateway answered with an error, timed out, or was not reachable. */
export class MuseRpcError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/**
 * Finds the app's gateway client and keeps it on `window` for later calls.
 * A plain string (not a function) so the bundler cannot inject helpers such
 * as `__name` that do not exist in the page.
 */
/**
 * Finds the app's gateway client: a React context value with `sendRequest` and `gatewayUrl`. It is
 * looked up fresh on every call (context values are replaced as the connection state changes), and
 * the one whose `isReady` is true wins: the client exists before its encrypted channel is up.
 */
const FIND_GATEWAY_FN = `function __pdppMuseFindGateway() {
  if (!document.body) return null;
  let fiber = null;
  const elements = [document.body, ...document.querySelectorAll("body *")].slice(0, 5000);
  for (const el of elements) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    if (key) { fiber = el[key]; break; }
  }
  if (!fiber) return null;
  let root = fiber;
  while (root.return) root = root.return;
  const stack = [root];
  let visited = 0;
  let first = null;
  while (stack.length && visited < 400000) {
    const node = stack.pop();
    visited++;
    const value = node.memoizedProps && node.memoizedProps.value;
    if (value && typeof value === "object" && typeof value.sendRequest === "function" && "gatewayUrl" in value) {
      if (value.isReady === true) return value;
      if (!first) first = value;
    }
    if (node.child) stack.push(node.child);
    if (node.sibling) stack.push(node.sibling);
  }
  return first;
}`;

/** True once the client is found and its channel is ready; asks the app to connect when it is not. */
export const LOCATE_GATEWAY_SCRIPT = `(() => {
  try {
    ${FIND_GATEWAY_FN}
    const gateway = __pdppMuseFindGateway();
    if (!gateway) return false;
    if (gateway.isReady === true) return true;
    try { if (typeof gateway.ensureLiveConnection === "function") gateway.ensureLiveConnection(); } catch (e) {}
    return false;
  } catch (e) {
    return false;
  }
})()`;

/** Calls one gateway method in the page; resolves to a JSON string envelope. */
export function gatewayCallScript(
	method: string,
	params: Record<string, unknown>,
): string {
	return `(async () => {
  ${FIND_GATEWAY_FN}
  const gateway = __pdppMuseFindGateway();
  if (!gateway || gateway.isReady !== true) {
    return JSON.stringify({ ok: false, code: "not_ready" });
  }
  let timer = null;
  try {
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ${RPC_TIMEOUT_MS});
    });
    let value = await Promise.race([gateway.sendRequest(${JSON.stringify(method)}, ${JSON.stringify(params)}), timeout]);
    if (typeof Blob !== "undefined" && value instanceof Blob) value = { __blob_text: await value.text() };
    return JSON.stringify({ ok: true, value: value === undefined ? null : value });
  } catch (e) {
    const text = String((e && e.message) || e || "error");
    const raw = e && (e.status !== undefined ? e.status : e.statusCode !== undefined ? e.statusCode : e.code);
    const status = Number.isInteger(Number(raw)) ? Number(raw) : 0;
    const code = /timeout|timed out/i.test(text) ? "timeout"
      : /not connected/i.test(text) ? "not_ready"
      : status === 429 || /\\b429\\b|rate.?limit|too many requests/i.test(text) ? "rate_limited"
      : status >= 500 || /\\b5\\d\\d\\b|\\binternal\\b|service unavailable|bad gateway|gateway time-?out/i.test(text) ? "server_error"
      : status === 404 || /\\b404\\b|not found|no such/i.test(text) ? "not_found"
      : "rpc_error";
    return JSON.stringify({ ok: false, code, message: text.slice(0, 120) });
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
})()`;
}

const envelopeSchema = z.object({
	ok: z.boolean(),
	value: z.unknown().optional(),
	code: z.string().optional(),
	message: z.string().optional(),
});
type Envelope = z.infer<typeof envelopeSchema>;

function parseEnvelope(raw: unknown): Envelope {
	let parsed: unknown = null;
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = null;
		}
	}
	const envelope = envelopeSchema.safeParse(parsed);
	if (!envelope.success) {
		throw new MuseRpcError("bad_answer", "muse_rpc_failed: unreadable answer");
	}
	return envelope.data;
}

async function isOnMuse(page: ScriptRunner): Promise<boolean> {
	try {
		return (await page.evaluate("location.origin")) === MUSE_ORIGIN;
	} catch {
		return false;
	}
}

async function locateGateway(page: ScriptRunner): Promise<boolean> {
	try {
		return (await page.evaluate(LOCATE_GATEWAY_SCRIPT)) === true;
	} catch {
		return false;
	}
}

/** Wait for the app to finish loading its gateway client. */
async function waitForGateway(
	page: ScriptRunner,
	attempts = GATEWAY_WAIT_ATTEMPTS,
): Promise<boolean> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (await locateGateway(page)) return true;
		await politeDelay(GATEWAY_WAIT_MS);
	}
	return false;
}

function authFailure(): Error {
	return new Error(
		"muse_auth_failed: the Muse app's gateway client was not found on muse.ai; sign in to Muse and let the app load",
	);
}

/** The production gateway: the page's own client, read-only. */
export function pageGateway(page: ScriptRunner): MuseGateway {
	const once = async (
		method: string,
		params: Record<string, unknown>,
	): Promise<Envelope> =>
		parseEnvelope(await page.evaluate(gatewayCallScript(method, params)));
	return {
		async call(method, params) {
			assertReadOnlyCall(method, params);
			let answer = await once(method, params);
			for (
				let retry = 0;
				retry < 3 && !answer.ok && answer.code === "not_ready";
				retry++
			) {
				// The app replaced or dropped its client (reconnect, navigation).
				if (!(await waitForGateway(page))) throw authFailure();
				answer = await once(method, params);
			}
			if (answer.ok) return answer.value ?? null;
			const code = answer.code ?? "rpc_error";
			const detail = answer.message ? `: ${answer.message}` : "";
			throw new MuseRpcError(
				code,
				`muse_rpc_failed: ${method} ${code === "rpc_error" ? "error" : code}${detail}`,
			);
		},
	};
}

// ─── Session ────────────────────────────────────────────────────────────

/**
 * Runs scripts in the page's MAIN world. The app's React fiber keys are expando properties on its
 * DOM nodes, which an isolated world (patchright's default for evaluate) cannot see, so the
 * gateway client is only reachable from the main world.
 */
export function mainWorld(page: Page): ScriptRunner {
	const target = page as unknown as {
		evaluate(
			expression: string,
			arg: undefined,
			options: undefined,
			isolatedContext: false,
		): Promise<unknown>;
	};
	return {
		evaluate: (script) => target.evaluate(script, undefined, undefined, false),
	};
}

/** Whether this page is muse.ai with the app's gateway client loaded. Never navigates. */
export async function hasMuseSession(page: ScriptRunner): Promise<boolean> {
	return (await isOnMuse(page)) && (await locateGateway(page));
}

const PROBE_ATTEMPTS = 3;
const PROBE_WAIT_MS = 1_000;

/**
 * Session probe for hosts that pass a page (the mobile PageShim host). It
 * never navigates, so repeating it while the owner signs in is safe, and it
 * waits only a few seconds for the app's gateway client.
 */
export async function probeMuseSessionOnPage(page: Page): Promise<boolean> {
	const main = mainWorld(page);
	if (!(await isOnMuse(main))) return false;
	for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
		if (await locateGateway(main)) return true;
		await politeDelay(PROBE_WAIT_MS);
	}
	return false;
}

async function openMuse(page: Page): Promise<void> {
	if (!(await isOnMuse(mainWorld(page)))) {
		await page.goto(MUSE_HOME_URL, { waitUntil: "domcontentloaded" });
	}
}

export async function probeMuseSession({
	page,
}: ProbeSessionArgs): Promise<boolean> {
	await openMuse(page);
	return (
		(await isOnMuse(mainWorld(page))) && (await waitForGateway(mainWorld(page)))
	);
}

export async function ensureMuseSession({
	assist,
	capture,
	completeAssistance,
	page,
	sendInteraction,
}: Pick<
	EnsureSessionArgs,
	"assist" | "capture" | "completeAssistance" | "page" | "sendInteraction"
>): Promise<void> {
	await openMuse(page);
	if (
		(await isOnMuse(mainWorld(page))) &&
		(await waitForGateway(mainWorld(page)))
	)
		return;
	const ready = await manualBrowserLogin({
		assist,
		...(capture ? { capture } : {}),
		completeAssistance,
		isProbeSuccessful: (isLive: boolean) => isLive,
		message: MUSE_LOGIN_MESSAGE,
		page,
		probe: () => hasMuseSession(mainWorld(page)),
		readinessProbe: (p: Page) => hasMuseSession(mainWorld(p)),
		readinessProbeOnHandoffPage: true,
		sendInteraction,
		timeoutSeconds: 1800,
	});
	if (!ready) throw authFailure();
}

// ─── Collection ─────────────────────────────────────────────────────────

export type MuseCtx = Pick<
	BrowserCollectContext,
	| "collectionMode"
	| "detailGaps"
	| "emit"
	| "emitRecord"
	| "progress"
	| "recoveryOnly"
	| "reportStreamFailure"
	| "requested"
	| "state"
>;

/** A stream could not prove its end; it gets no STATE this run. */
class StreamFailure extends Error {
	readonly retryable: boolean;
	constructor(message: string, retryable = true) {
		super(message);
		this.retryable = retryable;
	}
}

function isAuthError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("muse_auth_failed");
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function failStreams(
	ctx: MuseCtx,
	streams: readonly string[],
	error: unknown,
): Promise<void> {
	if (isAuthError(error)) throw error;
	const retryable = error instanceof StreamFailure ? error.retryable : true;
	for (const stream of streams) {
		connectorDiagnostic("muse", "stream_failed", { stream, retryable });
		await ctx.reportStreamFailure?.(stream, describe(error), { retryable });
	}
}

function unsafeTextCount(tally: TextTally, stream: string): number {
	return tally.byStream.get(stream) ?? 0;
}

/** Text replaced with null cannot be checkpointed as collected; not retryable. */
function unsafeTextFailure(tally: TextTally, stream: string): StreamFailure {
	return new StreamFailure(
		`${unsafeTextCount(tally, stream)} ${stream} text values hold characters that cannot be stored; they were imported as empty and ${stream} is not checkpointed as complete.`,
		false,
	);
}

async function emitBuilt(
	ctx: MuseCtx,
	tally: TextTally,
	stream: string,
	built: { record: RecordData; replaced: number },
): Promise<void> {
	tally.add(stream, built.replaced);
	await ctx.emitRecord(stream, built.record);
}

async function call(
	gateway: MuseGateway,
	method: string,
	params: Record<string, unknown>,
): Promise<unknown> {
	assertReadOnlyCall(method, params);
	return await gateway.call(method, params);
}

/** What a complete read of one chat's messages saw. */
export interface ChatMark {
	updated_at_ms: number;
	transcript_revision: number;
}

/**
 * conversations cursor: for each chat whose messages were read completely,
 * its list update time and its transcript revision at that read. Chat ids
 * and two numbers; no credential. A chat is read again when either value
 * changed or is unknown.
 */
interface ConversationsCursor {
	version: typeof CHATS_CURSOR_VERSION;
	chats: Record<string, ChatMark>;
}

function parseConversationsCursor(value: unknown): ConversationsCursor | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (v.version !== CHATS_CURSOR_VERSION) return null;
	if (typeof v.chats !== "object" || v.chats === null) return null;
	const chats: Record<string, ChatMark> = {};
	for (const [id, mark] of Object.entries(v.chats as Record<string, unknown>)) {
		if (typeof mark !== "object" || mark === null) continue;
		const m = mark as Record<string, unknown>;
		if (
			typeof m.updated_at_ms === "number" &&
			Number.isFinite(m.updated_at_ms) &&
			typeof m.transcript_revision === "number" &&
			Number.isFinite(m.transcript_revision)
		) {
			chats[id] = {
				updated_at_ms: m.updated_at_ms,
				transcript_revision: m.transcript_revision,
			};
		}
	}
	return { version: CHATS_CURSOR_VERSION, chats };
}

interface ListedSession {
	session: MuseSession;
	archivedView: boolean;
}

/**
 * Every chat, active then archived, read page by page as the app does:
 * `{ limit }`, then `{ limit, cursor: <next_cursor> }`, until an answer has
 * no next_cursor. A repeated cursor, a page cap, or has_more with no cursor
 * fails the list; nothing is checkpointed from a list that did not end.
 */
async function listSessions(gateway: MuseGateway): Promise<ListedSession[]> {
	const out: ListedSession[] = [];
	const seen = new Set<string>();
	for (const archivedView of [false, true]) {
		const label = archivedView ? "archived chat list" : "chat list";
		const cursors = new Set<string>();
		let cursor: PageCursor | null = null;
		for (let pageIndex = 0; ; pageIndex++) {
			if (pageIndex >= MAX_SESSION_PAGES) {
				throw new StreamFailure(
					`Muse's ${label} is longer than ${MAX_SESSION_PAGES} pages; nothing was checkpointed.`,
					false,
				);
			}
			const params: Record<string, unknown> = {
				limit: SESSIONS_LIMIT,
				...(archivedView ? { view: "archived" } : {}),
				...(cursor === null ? {} : { cursor }),
			};
			const page = parseSessionsPage(
				await call(gateway, "sessions.list", params),
			);
			if (page === null) {
				throw new StreamFailure(
					`Muse's ${label} came back in a shape the connector cannot read; nothing was checkpointed.`,
				);
			}
			let added = 0;
			for (const session of page.sessions) {
				if (seen.has(session.session_id)) continue;
				seen.add(session.session_id);
				out.push({ session, archivedView });
				added += 1;
			}
			if (page.moreWithoutCursor) {
				throw new StreamFailure(
					`Muse's ${label} says more chats follow but gives no cursor to read them; nothing was checkpointed.`,
				);
			}
			if (page.nextCursor === null) break; // the source's end signal
			// A page that says more follow must add chats: one that adds none
			// (a moving list, a stuck page) cannot prove the list complete.
			if (added === 0) {
				throw new StreamFailure(
					`Muse's ${label} returned a page with no new chats while saying more follow; nothing was checkpointed.`,
				);
			}
			if (cursors.has(cursorKey(page.nextCursor))) {
				throw new StreamFailure(
					`Muse's ${label} repeated a page cursor; nothing was checkpointed.`,
				);
			}
			cursors.add(cursorKey(page.nextCursor));
			cursor = page.nextCursor;
		}
	}
	return out;
}

/**
 * Gateway error codes that concern one chat, not the gateway as a whole.
 * Only "not found" is item-level evidence; every other failure (timeout,
 * rate limit, server error, an unclassified error) stops the chat walk.
 */
const PER_ITEM_RPC_CODES: ReadonlySet<string> = new Set(["not_found"]);

type HistoryOutcome =
	| { kind: "hydrated"; revision: number | null }
	| { kind: "gap"; errorClass: string; message: string };

/**
 * Read one chat's messages and emit them; say whether the chat is complete.
 * Pages back exactly as the app does: `before_seq` is the smallest `seq` on
 * the current page, until the source answers `has_more: false`.
 */
async function hydrateChat(
	ctx: MuseCtx,
	gateway: MuseGateway,
	tally: TextTally,
	sessionId: string,
): Promise<HistoryOutcome> {
	const seen = new Set<string>();
	let cursor: number | null = null;
	// Set when an event was left out; the chat is then a gap, never hydrated.
	let notFinal = 0;
	let unsafe = 0;
	let revision: number | null = null;
	let revisionMoved = false;
	let revisionUnseen = false;
	const finish = (): HistoryOutcome =>
		notFinal > 0
			? {
					kind: "gap",
					errorClass: "muse_history_not_final",
					message: "a message was still being generated",
				}
			: unsafe > 0
				? {
						kind: "gap",
						errorClass: "muse_history_unsafe_text",
						message: "a message body is not storable text",
					}
				: revisionMoved
					? {
							kind: "gap",
							errorClass: "muse_history_changed",
							message: "the chat changed while it was read",
						}
					: { kind: "hydrated", revision };
	for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex++) {
		const params: Record<string, unknown> = {
			limit: HISTORY_LIMIT,
			session_id: sessionId,
		};
		if (cursor !== null) params.before_seq = cursor;
		let raw: unknown;
		try {
			raw = await call(gateway, "chat.history", params);
		} catch (error) {
			// Only a failure about this chat is a per-chat gap; a timeout, rate
			// limit or outage stops the walk for a runtime retry.
			if (
				!(error instanceof MuseRpcError) ||
				!PER_ITEM_RPC_CODES.has(error.code)
			)
				throw error;
			return {
				kind: "gap",
				errorClass: `muse_history_${error.code}`,
				message: "chat.history failed for this chat",
			};
		}
		const page = parseHistory(raw);
		if (page === null) {
			return {
				kind: "gap",
				errorClass: "muse_history_unreadable",
				message: "chat.history came back in an unreadable shape",
			};
		}
		// Compare known revisions only: a continuation page that omits it says
		// nothing about a change (a final probe below checks the chat then).
		if (pageIndex === 0) revision = page.transcriptRevision;
		else if (page.transcriptRevision === null) revisionUnseen = true;
		else if (revision !== null && page.transcriptRevision !== revision)
			revisionMoved = true;
		const fresh = uniqueEvents(page.events).filter(
			(e) => !seen.has(e.message_id),
		);
		for (const event of fresh) {
			seen.add(event.message_id);
			if (!isFinalEvent(event)) {
				notFinal += 1;
				continue;
			}
			const built = buildMessageRecord(event, sessionId);
			if (built.replaced > 0) {
				unsafe += 1;
				continue;
			}
			await emitBuilt(ctx, tally, MESSAGES, built);
		}
		if (!page.hasMore) {
			// the source's end signal. When a continuation page did not report
			// the revision, one more first-page read confirms the chat did not
			// change while it was walked.
			if (revisionUnseen && revision !== null) {
				// Proven unchanged only when the final read reports the same
				// known revision; an unknown one is not proof.
				let latest: number | null;
				try {
					latest = await readRevision(gateway, sessionId);
				} catch (error) {
					if (
						!(error instanceof MuseRpcError) ||
						!PER_ITEM_RPC_CODES.has(error.code)
					)
						throw error;
					latest = Number.NaN; // the chat went away: not unchanged
				}
				if (latest !== revision) revisionMoved = true;
			}
			return finish();
		}
		if (fresh.length === 0) {
			return {
				kind: "gap",
				errorClass: "muse_history_page_repeated",
				message: "chat.history returned no new messages while has_more",
			};
		}
		let smallest: number | null = null;
		for (const e of page.events) {
			if (typeof e.seq !== "number" || !Number.isFinite(e.seq)) {
				return {
					kind: "gap",
					errorClass: "muse_history_no_seq",
					message: "chat.history event without seq; cannot page back",
				};
			}
			if (smallest === null || e.seq < smallest) smallest = e.seq;
		}
		if (smallest === null || (cursor !== null && smallest >= cursor)) {
			return {
				kind: "gap",
				errorClass: "muse_history_cursor_stuck",
				message: "chat.history paging cursor did not move back",
			};
		}
		cursor = smallest;
	}
	return {
		kind: "gap",
		errorClass: "muse_history_page_cap",
		message: `chat history is longer than ${MAX_HISTORY_PAGES} pages`,
	};
}

/** Whether chat.history also says the chat does not exist. */
async function chatGone(
	gateway: MuseGateway,
	sessionId: string,
): Promise<boolean> {
	try {
		await call(gateway, "chat.history", { limit: 1, session_id: sessionId });
		return false;
	} catch (error) {
		if (error instanceof MuseRpcError && error.code === "not_found")
			return true;
		throw error;
	}
}

/** The chat's current transcript revision from a one-message read; null when unknown. */
async function readRevision(
	gateway: MuseGateway,
	sessionId: string,
): Promise<number | null> {
	const raw = await call(gateway, "chat.history", {
		limit: 1,
		session_id: sessionId,
	});
	return parseHistory(raw)?.transcriptRevision ?? null;
}

/** Whether a chat's parent record was emitted, and so whether its messages may follow. */
type ParentOutcome =
	| { kind: "emitted" }
	/** The chat no longer exists. */
	| { kind: "gone" }
	/** No honest parent record could be emitted: the chat stays a gap. */
	| { kind: "blocked"; errorClass: string; message: string };

/** DETAIL_GAP_RECOVERED for each gap an earlier run left for this chat. */
async function resolvePendingGaps(
	ctx: MuseCtx,
	pending: ReadonlyMap<string, readonly PendingGap[]>,
	sessionId: string,
): Promise<void> {
	for (const gap of pending.get(sessionId) ?? []) {
		await ctx.emit({
			type: "DETAIL_GAP_RECOVERED",
			reference_only: true,
			gap_id: gap.gapId,
			...(gap.leaseId ? { lease_id: gap.leaseId } : {}),
			stream: MESSAGES,
			record_key: sessionId,
		});
	}
}

/** A message gap the host carried over from an earlier run. */
interface PendingGap {
	gapId: string;
	leaseId?: string;
}

/** Message gaps the host carried over from earlier runs, by chat id. */
function pendingMessageGaps(ctx: MuseCtx): Map<string, PendingGap[]> {
	const byChat = new Map<string, PendingGap[]>();
	for (const gap of ctx.detailGaps ?? []) {
		if (gap.stream !== MESSAGES) continue;
		const raw = gap.record_key;
		const key =
			typeof raw === "string"
				? raw
				: typeof raw === "number"
					? String(raw)
					: "";
		if (key === "") continue;
		const list = byChat.get(key) ?? [];
		list.push({
			gapId: gap.gap_id,
			...(gap.lease_id ? { leaseId: gap.lease_id } : {}),
		});
		byChat.set(key, list);
	}
	return byChat;
}

/**
 * Read the given chats' messages, emit a DETAIL_GAP for each one that could
 * not be read completely, then the one DETAIL_COVERAGE for the
 * conversations boundary. Returns the chats read completely.
 */
async function hydrateChats(
	ctx: MuseCtx,
	gateway: MuseGateway,
	tally: TextTally,
	required: readonly string[],
	pending: ReadonlyMap<string, readonly PendingGap[]> = new Map(),
	beforeChat?: (sessionId: string) => Promise<ParentOutcome>,
): Promise<Map<string, number | null>> {
	const hydrated: string[] = [];
	const revisions = new Map<string, number | null>();
	const gaps: string[] = [];
	const gone = new Set<string>();
	for (const [index, sessionId] of required.entries()) {
		await ctx.progress(`Reading chat ${index + 1} of ${required.length}`, {
			stream: MESSAGES,
		});
		// The chat's parent record, when the caller emits it here.
		const parent: ParentOutcome = beforeChat
			? await beforeChat(sessionId)
			: { kind: "emitted" };
		if (parent.kind === "gone") {
			// The chat no longer exists: nothing is left to read, so its pending
			// gaps are resolved and it is not a required key.
			gone.add(sessionId);
			await resolvePendingGaps(ctx, pending, sessionId);
			continue;
		}
		const outcome: HistoryOutcome =
			parent.kind === "blocked"
				? {
						kind: "gap",
						errorClass: parent.errorClass,
						message: parent.message,
					}
				: await hydrateChat(ctx, gateway, tally, sessionId);
		if (outcome.kind === "hydrated") {
			hydrated.push(sessionId);
			revisions.set(sessionId, outcome.revision);
			// Read completely: resolve the gaps an earlier run left for it.
			await resolvePendingGaps(ctx, pending, sessionId);
			continue;
		}
		await emitDetailGap(ctx, {
			stream: MESSAGES,
			parentStream: CONVERSATIONS,
			recordKey: sessionId,
			reason: "temporary_unavailable",
			locator: { kind: "muse.chat_history", chat_id: sessionId },
			error: { class: outcome.errorClass, message: outcome.message },
		});
		gaps.push(sessionId);
	}
	await emitDetailCoverage(ctx, {
		stream: MESSAGES,
		stateStream: CONVERSATIONS,
		requiredKeys: required.filter((id) => !gone.has(id)),
		hydratedKeys: hydrated,
		gapKeys: gaps,
	});
	if (gaps.length > 0) {
		connectorDiagnostic("muse", "message_gaps", { count: gaps.length });
	}
	return revisions;
}

/**
 * Whether a chat must be read again: no complete read is on record, its
 * list update time differs, or its transcript revision (read with a one-
 * message page) differs or is unknown. Update times are whole seconds, so
 * the revision catches a change within the same second.
 */
async function chatUnchanged(
	gateway: MuseGateway,
	id: string,
	updatedMs: number | null,
	mark: ChatMark | undefined,
): Promise<boolean> {
	if (!mark || updatedMs === null || mark.updated_at_ms !== updatedMs)
		return false;
	let raw: unknown;
	try {
		raw = await call(gateway, "chat.history", { limit: 1, session_id: id });
	} catch (error) {
		// A chat the gateway cannot find is read (and gapped) like a changed
		// one; anything else stops the walk.
		if (error instanceof MuseRpcError && PER_ITEM_RPC_CODES.has(error.code))
			return false;
		throw error;
	}
	const revision = parseHistory(raw)?.transcriptRevision ?? null;
	return revision !== null && revision === mark.transcript_revision;
}

export async function runChatStreams(
	ctx: MuseCtx,
	gateway: MuseGateway,
	tally: TextTally,
): Promise<void> {
	const wantConversations = ctx.requested.has(CONVERSATIONS);
	const wantMessages = ctx.requested.has(MESSAGES);
	if (!(wantConversations || wantMessages)) return;
	const pending = wantMessages
		? pendingMessageGaps(ctx)
		: new Map<string, PendingGap[]>();

	// Parent records come before their children. messages is collected only
	// together with conversations:
	// - Collection Profile 5.1: "A connector MUST emit records only for
	//   streams in scope.streams ... A connector that cannot apply a
	//   constraint MUST emit SKIP_RESULT with reason: "scope_not_supported"
	//   for that stream or fail the run. It MUST NOT silently broaden scope."
	//   A messages-only request cannot get its parent records without
	//   broadening scope, so messages is skipped as scope_not_supported
	//   (the manifest's messages description says it needs conversations).
	// - A normal run emits every conversation record below, before any
	//   message record, gap or coverage.
	// - A recovery-only run fetches each gapped chat with sessions.get and
	//   emits its conversation record right before that chat's messages or
	//   gap. A chat that is gone resolves its gap (DETAIL_GAP_RECOVERED);
	//   one whose parent cannot be emitted honestly stays a gap.
	if (wantMessages && !wantConversations) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream: MESSAGES,
			reason: "scope_not_supported",
			message:
				"Muse messages are collected together with their conversations; request both streams.",
			recovery_hint: { action: "not_retriable", retryable: false },
		});
		return;
	}
	if (ctx.recoveryOnly) {
		if (pending.size === 0) return;
		let unsafeParents = 0;
		const emitParent = async (sessionId: string): Promise<ParentOutcome> => {
			let raw: unknown;
			try {
				raw = await call(gateway, "sessions.get", { id: sessionId });
			} catch (error) {
				if (
					!(error instanceof MuseRpcError) ||
					!PER_ITEM_RPC_CODES.has(error.code)
				)
					throw error;
				// Gone only when its history is gone too.
				return (await chatGone(gateway, sessionId))
					? { kind: "gone" }
					: {
							kind: "blocked",
							errorClass: "muse_parent_not_found",
							message: "sessions.get did not find the chat",
						};
			}
			const session = parseSessionGet(raw);
			if (session === null || session.session_id !== sessionId) {
				throw new StreamFailure(
					"Muse's sessions.get came back in a shape the connector cannot read; nothing was checkpointed.",
				);
			}
			// Without the archived flag the record would have to guess it; the
			// chat waits for a normal run, which knows its list view.
			if (typeof session.archived !== "boolean") {
				return {
					kind: "blocked",
					errorClass: "muse_parent_archived_unknown",
					message: "sessions.get did not say whether the chat is archived",
				};
			}
			const built = buildConversationRecord(session, session.archived);
			if (built.replaced > 0) {
				unsafeParents += 1;
				return {
					kind: "blocked",
					errorClass: "muse_parent_unsafe_text",
					message: "the chat's title or snippet is not storable text",
				};
			}
			await emitBuilt(ctx, tally, CONVERSATIONS, built);
			return { kind: "emitted" };
		};
		try {
			await hydrateChats(
				ctx,
				gateway,
				tally,
				[...pending.keys()],
				pending,
				emitParent,
			);
		} catch (error) {
			await failStreams(ctx, [CONVERSATIONS, MESSAGES], error);
			return;
		}
		if (unsafeParents > 0) {
			await failStreams(
				ctx,
				[CONVERSATIONS],
				new StreamFailure(
					`${unsafeParents} Muse conversation records hold text that cannot be stored; they were not imported and their messages stay pending.`,
					false,
				),
			);
		}
		return;
	}

	await ctx.progress("Listing chats", { stream: CONVERSATIONS });
	let listed: ListedSession[];
	try {
		listed = await listSessions(gateway);
	} catch (error) {
		await failStreams(
			ctx,
			[CONVERSATIONS, MESSAGES].filter((s) => ctx.requested.has(s)),
			error,
		);
		return;
	}

	if (wantConversations) {
		for (const { session, archivedView } of listed) {
			await emitBuilt(
				ctx,
				tally,
				CONVERSATIONS,
				buildConversationRecord(session, archivedView),
			);
		}
	}

	const stored =
		ctx.collectionMode === "full_refresh"
			? null
			: parseConversationsCursor(ctx.state[CONVERSATIONS]);
	const prior = stored?.chats ?? {};
	const listedIds = new Set(listed.map(({ session }) => session.session_id));
	// Marks of chats still listed carry forward; a chat no longer listed drops.
	let nextChats: Record<string, ChatMark> = Object.fromEntries(
		Object.entries(prior).filter(([id]) => listedIds.has(id)),
	);
	if (wantMessages) {
		const chats = listed
			.map(({ session }) => ({
				id: session.session_id,
				updatedMs:
					typeof session.updated_at_ms === "number" &&
					Number.isFinite(session.updated_at_ms)
						? session.updated_at_ms
						: null,
			}))
			.sort((a, b) => (a.updatedMs ?? 0) - (b.updatedMs ?? 0));
		let hydrated: Map<string, number | null>;
		try {
			const changed: string[] = [];
			for (const c of chats) {
				if (!(await chatUnchanged(gateway, c.id, c.updatedMs, prior[c.id])))
					changed.push(c.id);
			}
			const changedIds = new Set(changed);
			// The list was read to its end: a gapped chat that is not in it no
			// longer exists, so its gaps are resolved instead of read again.
			for (const id of pending.keys()) {
				if (!listedIds.has(id)) await resolvePendingGaps(ctx, pending, id);
			}
			// Retry earlier gaps first, then every chat that changed.
			const required = [
				...[...pending.keys()].filter(
					(id) => listedIds.has(id) && !changedIds.has(id),
				),
				...changed,
			];
			hydrated = await hydrateChats(ctx, gateway, tally, required, pending);
			for (const id of changed) {
				const revision = hydrated.get(id);
				const updatedMs = chats.find((c) => c.id === id)?.updatedMs ?? null;
				// Not read completely, or nothing to compare next time: read again.
				if (revision === undefined || revision === null || updatedMs === null) {
					delete nextChats[id];
				} else {
					nextChats[id] = {
						updated_at_ms: updatedMs,
						transcript_revision: revision,
					};
				}
			}
		} catch (error) {
			await failStreams(
				ctx,
				[CONVERSATIONS, MESSAGES].filter((s) => ctx.requested.has(s)),
				error,
			);
			return;
		}
		// A time-ranged run reads only part of each chat: it records no marks.
		if (ctx.requested.get(MESSAGES)?.time_range) {
			nextChats = Object.fromEntries(
				Object.entries(prior).filter(([id]) => listedIds.has(id)),
			);
		}
	}

	if (wantConversations) {
		if (unsafeTextCount(tally, CONVERSATIONS) > 0) {
			await failStreams(
				ctx,
				[CONVERSATIONS],
				unsafeTextFailure(tally, CONVERSATIONS),
			);
			return;
		}
		await ctx.emit(buildFullScanCoverageMessage(CONVERSATIONS, listed.length));
		const cursor: ConversationsCursor = {
			version: CHATS_CURSOR_VERSION,
			chats: nextChats,
		};
		await ctx.emit({
			type: "STATE",
			stream: CONVERSATIONS,
			cursor: { ...cursor },
		});
	}
}

/** One second after a zoned timestamp, in the same shape (`Z`, whole seconds unless the source had a fraction). */
function oneSecondAfter(raw: string, iso: string): string {
	const shifted = new Date(Date.parse(iso) + 1000).toISOString();
	return FRACTION_RE.test(raw) ? shifted : shifted.replace(".000Z", "Z");
}

/**
 * The `before` for the next activity.list page, or null when the walk cannot
 * go on without skipping activities.
 *
 * The app pages with `before` = the oldest timestamp on the page, which
 * leaves out any activity sharing that time beyond the page. So the
 * connector first asks for everything up to one second after the oldest
 * time: the activities tied at that time come back (already read ones are
 * deduplicated) together with older ones. Only when such a page brings
 * nothing new does it step strictly past that time, as the app does. A page
 * filled entirely by one timestamp cannot prove every tied activity was
 * read, so the walk fails instead.
 */
export function nextActivityCursor(input: {
	oldestRaw: string;
	oldestIso: string;
	freshCount: number;
	tiedFullPage: boolean;
	previous: string | null;
}): string | null {
	if (input.tiedFullPage) return null;
	const inclusive = oneSecondAfter(input.oldestRaw, input.oldestIso);
	if (input.freshCount > 0 && input.previous !== inclusive) return inclusive;
	// Nothing new up to one second after the oldest time: every activity at
	// that time has been read. Step strictly past it, unless already there.
	if (input.previous === input.oldestRaw) return null;
	return input.oldestRaw;
}

/** activities cursor: the newest activity time a complete walk has emitted. */
function priorActivityWatermark(ctx: MuseCtx): string | null {
	if (ctx.collectionMode === "full_refresh") return null;
	const v = ctx.state[ACTIVITIES];
	if (typeof v !== "object" || v === null) return null;
	const c = v as Record<string, unknown>;
	if (c.version !== CURSOR_VERSION) return null;
	return zonedIsoToIso(c.newest_timestamp);
}

export async function runActivities(
	ctx: MuseCtx,
	gateway: MuseGateway,
	tally: TextTally,
): Promise<void> {
	if (!ctx.requested.has(ACTIVITIES)) return;
	const ranged = Boolean(ctx.requested.get(ACTIVITIES)?.time_range);
	const prior = priorActivityWatermark(ctx);
	const stopAt = ranged ? null : prior;
	await ctx.progress("Reading activity", { stream: ACTIVITIES });
	const seen = new Set<string>();
	let newest = prior;
	let before: string | null = null;
	try {
		for (let pageIndex = 0; ; pageIndex++) {
			if (pageIndex >= MAX_ACTIVITY_PAGES) {
				throw new StreamFailure(
					`Muse's activity log is longer than ${MAX_ACTIVITY_PAGES} pages; older activity was not read and nothing was checkpointed.`,
					false,
				);
			}
			const params: Record<string, unknown> = {
				limit: ACTIVITY_LIMIT,
				before,
				capabilities: [...ACTIVITY_CAPABILITIES],
			};
			const items = parseActivities(
				await call(gateway, "activity.list", params),
			);
			if (items === null) {
				throw new StreamFailure(
					"Muse's activity log came back in a shape the connector cannot read; nothing was checkpointed.",
				);
			}
			// The source's end: a page with no days, so no time to page back from.
			if (items.length === 0) break;
			// A page with nothing new is expected after an inclusive request (see
			// nextActivityCursor), which decides whether the walk can go on.
			const fresh = items.filter((a) => !seen.has(activityId(a)));
			for (const a of fresh) {
				seen.add(activityId(a));
				await emitBuilt(ctx, tally, ACTIVITIES, buildActivityRecord(a));
			}
			// The oldest activity across all days of the page.
			let oldestRaw: string | null = null;
			let oldestIso: string | null = null;
			for (const a of items) {
				const iso = zonedIsoToIso(a.timestamp);
				if (iso === null) continue;
				if (newest === null || iso > newest) newest = iso;
				if (oldestIso === null || iso < oldestIso) {
					oldestIso = iso;
					oldestRaw = a.timestamp;
				}
			}
			if (oldestRaw === null || oldestIso === null) break;
			// Reached activity a complete earlier walk already emitted.
			if (stopAt !== null && oldestIso <= stopAt) break;
			const tiedFullPage =
				items.length >= ACTIVITY_LIMIT &&
				items.every((a) => zonedIsoToIso(a.timestamp) === oldestIso);
			const next = nextActivityCursor({
				oldestRaw,
				oldestIso,
				freshCount: fresh.length,
				tiedFullPage,
				previous: before,
			});
			if (next === null) {
				throw new StreamFailure(
					"Muse's activity log has more activities at one time than a page holds, or did not page back; nothing was checkpointed.",
				);
			}
			before = next;
		}
		if (unsafeTextCount(tally, ACTIVITIES) > 0)
			throw unsafeTextFailure(tally, ACTIVITIES);
	} catch (error) {
		await failStreams(ctx, [ACTIVITIES], error);
		return;
	}
	await ctx.emit({
		type: "STATE",
		stream: ACTIVITIES,
		cursor: {
			version: CURSOR_VERSION,
			newest_timestamp: ranged ? prior : newest,
		},
	});
}

/** Emit a full-inventory stream's STATE and its self-coverage. */
async function closeFullInventory(
	ctx: MuseCtx,
	tally: TextTally,
	stream: string,
	considered: number,
): Promise<void> {
	if (unsafeTextCount(tally, stream) > 0)
		throw unsafeTextFailure(tally, stream);
	await ctx.emit(buildFullScanCoverageMessage(stream, considered));
	await ctx.emit({
		type: "STATE",
		stream,
		cursor: { version: CURSOR_VERSION },
	});
}

export async function runGoals(
	ctx: MuseCtx,
	gateway: MuseGateway,
	tally: TextTally,
): Promise<void> {
	if (!ctx.requested.has(GOALS)) return;
	await ctx.progress("Reading goals", { stream: GOALS });
	try {
		const seen = new Set<string>();
		for (const variant of GOAL_VARIANTS) {
			const label = Object.values(variant).join(" ");
			const cursors = new Set<string>();
			let cursor: PageCursor | null = null;
			for (let pageIndex = 0; ; pageIndex++) {
				if (pageIndex >= MAX_GOAL_PAGES) {
					throw new StreamFailure(
						`Muse's ${label} goals are longer than ${MAX_GOAL_PAGES} pages; nothing was checkpointed.`,
						false,
					);
				}
				const params =
					cursor === null ? { ...variant } : { ...variant, cursor };
				const page = parseGoals(await call(gateway, "goals.list", params));
				if (page === null) {
					throw new StreamFailure(
						`Muse's ${label} goals came back in a shape the connector cannot read; nothing was checkpointed.`,
					);
				}
				let added = 0;
				for (const goal of page.goals) {
					if (seen.has(goal.goal_id)) continue;
					seen.add(goal.goal_id);
					added += 1;
					await emitBuilt(
						ctx,
						tally,
						GOALS,
						buildGoalRecord(goal, variant.source ?? null),
					);
				}
				if (!page.hasNextPage) break; // the source's end signal
				// The next page is asked with `cursor`, the parameter sessions.list
				// uses. An answer that says more goals follow but carries no cursor
				// gives nothing to follow: guessing could re-read page one and claim
				// completeness, so the stream fails visibly instead.
				if (page.nextCursor === null) {
					throw new StreamFailure(
						`Muse reports more ${label} goals than one page holds but gives no cursor for the next page; the goals list is not checkpointed as complete.`,
						false,
					);
				}
				// A page that says more follow must add goals; one that adds none
				// is stuck, even with a new cursor.
				if (added === 0) {
					throw new StreamFailure(
						`Muse's ${label} goals returned a page with no new goals while saying more follow; nothing was checkpointed.`,
					);
				}
				if (cursors.has(cursorKey(page.nextCursor))) {
					throw new StreamFailure(
						`Muse's ${label} goals repeated a page cursor; nothing was checkpointed.`,
					);
				}
				cursors.add(cursorKey(page.nextCursor));
				cursor = page.nextCursor;
			}
		}
		await closeFullInventory(ctx, tally, GOALS, seen.size);
	} catch (error) {
		await failStreams(ctx, [GOALS], error);
	}
}

export async function runScheduledTasks(
	ctx: MuseCtx,
	gateway: MuseGateway,
	tally: TextTally,
): Promise<void> {
	if (!ctx.requested.has(SCHEDULED_TASKS)) return;
	await ctx.progress("Reading scheduled tasks", { stream: SCHEDULED_TASKS });
	try {
		const schedules = parseSchedules(await call(gateway, "tasks.list", {}));
		if (schedules === null) {
			throw new StreamFailure(
				"Muse's scheduled tasks came back in a shape the connector cannot read; nothing was checkpointed.",
			);
		}
		const seen = new Set<string>();
		for (const s of schedules) {
			if (seen.has(s.id)) continue;
			seen.add(s.id);
			await emitBuilt(ctx, tally, SCHEDULED_TASKS, buildScheduledTaskRecord(s));
		}
		await closeFullInventory(ctx, tally, SCHEDULED_TASKS, seen.size);
	} catch (error) {
		await failStreams(ctx, [SCHEDULED_TASKS], error);
	}
}

export async function runMemoryFiles(
	ctx: MuseCtx,
	gateway: MuseGateway,
	tally: TextTally,
): Promise<void> {
	if (!ctx.requested.has(MEMORY_FILES)) return;
	await ctx.progress("Reading the agent's memory files", {
		stream: MEMORY_FILES,
	});
	try {
		const entries = parseFsList(await call(gateway, "fs.list", { path: "" }));
		if (entries === null) {
			throw new StreamFailure(
				"Muse's workspace listing came back in a shape the connector cannot read; nothing was checkpointed.",
			);
		}
		const present = memoryFileEntries(entries);
		let failed = 0;
		for (const entry of present) {
			let text: string | null = null;
			try {
				text = parseRawText(
					await call(gateway, "fs.raw", { path: entry.name }),
				);
			} catch (error) {
				if (isAuthError(error)) throw error;
				text = null;
			}
			if (text === null) {
				failed += 1;
				continue;
			}
			const built = buildMemoryFileRecord(entry, text);
			// The body is the record: an unstorable one is not stored as null.
			if (built.replaced > 0) {
				failed += 1;
				continue;
			}
			await emitBuilt(ctx, tally, MEMORY_FILES, built);
		}
		if (failed > 0) {
			throw new StreamFailure(
				`${failed} of ${present.length} Muse memory files could not be read or are not storable text; the memory files are not checkpointed.`,
			);
		}
		await closeFullInventory(ctx, tally, MEMORY_FILES, present.length);
	} catch (error) {
		await failStreams(ctx, [MEMORY_FILES], error);
	}
}

interface LibraryWalk {
	entries: MuseLibraryEntry[];
	pages: number;
}

/** One complete offset walk of the recents library, to its has_more:false page. */
async function walkLibrary(gateway: MuseGateway): Promise<LibraryWalk> {
	const entries: MuseLibraryEntry[] = [];
	const seen = new Set<string>();
	let total: number | null = null;
	let offset = 0;
	for (let pageIndex = 0; ; pageIndex++) {
		if (pageIndex >= MAX_LIBRARY_PAGES) {
			throw new StreamFailure(
				`Muse's file library is longer than ${MAX_LIBRARY_PAGES} pages; nothing was checkpointed.`,
				false,
			);
		}
		const page = parseLibrary(
			await call(gateway, "fs.library", {
				preset: "recents",
				limit: LIBRARY_LIMIT,
				offset,
			}),
		);
		if (page === null) {
			throw new StreamFailure(
				"Muse's file library came back in a shape the connector cannot read; nothing was checkpointed.",
			);
		}
		total = page.total ?? total;
		const fresh = page.entries.filter((e) => !seen.has(e.path));
		for (const entry of fresh) {
			seen.add(entry.path);
			entries.push(entry);
		}
		if (!page.hasMore) {
			if (total !== null && total !== entries.length) {
				throw new StreamFailure(
					`Muse's file library reported ${total} files but listed ${entries.length}; it changed while it was read, and nothing was checkpointed.`,
				);
			}
			return { entries, pages: pageIndex + 1 };
		}
		if (page.entries.length === 0 || fresh.length === 0) {
			throw new StreamFailure(
				"Muse's file library said it had more files but returned no new ones; nothing was checkpointed.",
			);
		}
		offset += page.entries.length;
	}
}

/** Path and modified time of every file: what two walks must agree on. */
function libraryMembership(walk: LibraryWalk): string {
	return walk.entries
		.map((e) => `${e.path}\u0000${e.modified_ms ?? ""}`)
		.sort()
		.join("\u0001");
}

export async function runFiles(
	ctx: MuseCtx,
	gateway: MuseGateway,
	tally: TextTally,
): Promise<void> {
	if (!ctx.requested.has(FILES)) return;
	await ctx.progress("Reading the file library", { stream: FILES });
	try {
		// The library is ordered by recency and paged by offset, so a file
		// changed during a walk can shift the pages under it. A one-page walk
		// is one answer; a longer one counts only when the next complete walk
		// lists the same files.
		let accepted: LibraryWalk | null = null;
		let previous: string | null = null;
		for (let attempt = 0; attempt < LIBRARY_WALKS; attempt++) {
			const walk = await walkLibrary(gateway);
			const membership = libraryMembership(walk);
			if (walk.pages === 1 || membership === previous) {
				accepted = walk;
				break;
			}
			previous = membership;
		}
		if (accepted === null) {
			throw new StreamFailure(
				`Muse's file library changed during each of ${LIBRARY_WALKS} reads; nothing was checkpointed.`,
			);
		}
		let unsafePaths = 0;
		for (const entry of accepted.entries) {
			const built = buildFileRecord(entry);
			if (built === null) {
				unsafePaths += 1;
				continue;
			}
			await emitBuilt(ctx, tally, FILES, built);
		}
		if (unsafePaths > 0) {
			throw new StreamFailure(
				`${unsafePaths} Muse files have a path that is not storable text and were left out; the file list is not checkpointed as complete.`,
				false,
			);
		}
		await closeFullInventory(ctx, tally, FILES, accepted.entries.length);
	} catch (error) {
		await failStreams(ctx, [FILES], error);
	}
}

export async function runConnectedApps(
	ctx: MuseCtx,
	gateway: MuseGateway,
	tally: TextTally,
): Promise<void> {
	if (!ctx.requested.has(CONNECTED_APPS)) return;
	await ctx.progress("Reading connected apps", { stream: CONNECTED_APPS });
	try {
		const connectors = parseConnectors(
			await call(gateway, "connectors.list", { surface: "settings" }),
		);
		if (connectors === null) {
			throw new StreamFailure(
				"Muse's connected apps came back in a shape the connector cannot read; nothing was checkpointed.",
			);
		}
		const seen = new Set<string>();
		for (const c of connectors.filter(isConnectedApp)) {
			if (seen.has(c.id)) continue;
			seen.add(c.id);
			await emitBuilt(ctx, tally, CONNECTED_APPS, buildConnectedAppRecord(c));
		}
		await closeFullInventory(ctx, tally, CONNECTED_APPS, seen.size);
	} catch (error) {
		await failStreams(ctx, [CONNECTED_APPS], error);
	}
}

/** Every requested stream, read through `gateway`. */
export async function collectMuseWith(
	ctx: MuseCtx,
	gateway: MuseGateway,
): Promise<void> {
	const tally = new TextTally();
	try {
		await runChatStreams(ctx, gateway, tally);
		if (ctx.recoveryOnly) return;
		await runActivities(ctx, gateway, tally);
		await runGoals(ctx, gateway, tally);
		await runScheduledTasks(ctx, gateway, tally);
		await runMemoryFiles(ctx, gateway, tally);
		await runFiles(ctx, gateway, tally);
		await runConnectedApps(ctx, gateway, tally);
	} finally {
		for (const [stream, count] of tally.byStream) {
			connectorDiagnostic("muse", "unsafe_text_replaced", { stream, count });
			await ctx.progress(
				`${count} ${count === 1 ? "text value" : "text values"} in ${stream} held characters that cannot be stored and ${count === 1 ? "was" : "were"} imported as empty`,
				{ stream, count },
			);
		}
	}
}

/**
 * Signals that the page is a bot challenge or an interstitial, not the app:
 * Cloudflare's "Just a moment" / "Attention Required" pages, its challenge
 * scripts, Turnstile frames and challenge containers, or a bare 5xx page.
 * The same markers as packages/polyfill-connectors/src/platform-probes.ts,
 * read with one page script so it also runs on the mobile host.
 */
export const CHALLENGE_SCRIPT = `(() => {
  try {
    const signals = [];
    const title = String(document.title || "");
    if (/^just a moment/i.test(title)) signals.push("title_just_a_moment");
    if (/^attention required/i.test(title)) signals.push("title_attention_required");
    if (/^(?:5\\d\\d\\b|service unavailable|bad gateway|gateway time-?out)/i.test(title)) signals.push("title_http_5xx");
    if (document.querySelector('script[src*="challenge-platform"]')) signals.push("challenge_platform_script");
    if (document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]')) signals.push("turnstile_iframe");
    if (document.querySelector("#cf-challenge-running, #challenge-running, #cf-error-details, #challenge-form")) signals.push("cf_challenge_dom");
    return signals;
  } catch (e) {
    return [];
  }
})()`;

async function challengeSignals(page: ScriptRunner): Promise<string[]> {
	try {
		const value = await page.evaluate(CHALLENGE_SCRIPT);
		return Array.isArray(value)
			? value.filter((v): v is string => typeof v === "string")
			: [];
	} catch {
		return [];
	}
}

function challengeFailure(signals: readonly string[]): Error {
	return createConnectorFailure(
		"muse_bot_challenge",
		`muse_bot_challenge: muse.ai served a bot challenge or interstitial instead of the app (signals: ${signals.join(", ")}); complete it in the browser, then run again`,
		{ retryable: false },
	);
}

/**
 * Throws unless the page is muse.ai with the app's gateway client ready. A
 * challenge or interstitial page is reported as such before the missing
 * client is taken to mean the owner is signed out.
 */
export async function museReadiness(
	page: ScriptRunner,
	attempts = GATEWAY_WAIT_ATTEMPTS,
): Promise<void> {
	const early = await challengeSignals(page);
	if (early.length > 0) throw challengeFailure(early);
	if ((await isOnMuse(page)) && (await waitForGateway(page, attempts))) return;
	const late = await challengeSignals(page);
	if (late.length > 0) throw challengeFailure(late);
	throw authFailure();
}

export async function collectMuse(ctx: BrowserCollectContext): Promise<void> {
	if (ctx.requested.size === 0) return;
	await openMuse(ctx.page);
	const main = mainWorld(ctx.page);
	await museReadiness(main);
	await collectMuseWith(ctx, pageGateway(main));
}

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime.
if (isMainModule(import.meta.url)) {
	runConnector({
		name: "muse",
		browser: { profileName: "muse" },
		validateRecord,
		retryablePattern: /muse_rpc_failed|ECONN|fetch failed|net::ERR/i,
		ensureSession: ensureMuseSession,
		probeSession: probeMuseSession,
		probeSessionIsAuthoritative: true,
		collect: collectMuse,
	});
}
