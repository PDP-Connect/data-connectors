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
	isConnectedApp,
	MEMORY_FILE_NAMES,
	type MuseSession,
	memoryFileEntries,
	parseActivities,
	parseConnectors,
	parseFsList,
	parseGoals,
	parseHistory,
	parseLibrary,
	parseRawText,
	parseSchedules,
	parseSessions,
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
/** What the web app sends with activity.list. */
export const ACTIVITY_CAPABILITIES = [
	"ACTIVITY_FEED_GOALS",
	"ACTIVITY_FEED_PEER_CONVERSATIONS",
] as const;
const GOAL_SOURCES = ["user_goal", "assistant_tracking"] as const;

/** Gateway client lookups before the app counts as not signed in / not loaded. */
const GATEWAY_WAIT_ATTEMPTS = 20;
const GATEWAY_WAIT_MS = 1_500;
const RPC_TIMEOUT_MS = 60_000;
const CURSOR_VERSION = 1;

type Page = BrowserCollectContext["page"];

/** What the gateway helpers need from a page: run a script string in it. */
export interface ScriptRunner {
	evaluate(script: string): Promise<unknown>;
}

// ─── The page's gateway client ──────────────────────────────────────────

/** The only gateway methods this connector may call. All are reads. */
export const READ_METHODS: ReadonlySet<string> = new Set([
	"sessions.list",
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
export const LOCATE_GATEWAY_SCRIPT = `(() => {
  try {
    const cached = window.__pdppMuseGateway;
    if (cached && typeof cached.sendRequest === "function") return true;
    if (!document.body) return false;
    let fiber = null;
    const elements = [document.body, ...document.querySelectorAll("body *")].slice(0, 5000);
    for (const el of elements) {
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      if (key) { fiber = el[key]; break; }
    }
    if (!fiber) return false;
    let root = fiber;
    while (root.return) root = root.return;
    const stack = [root];
    let visited = 0;
    while (stack.length && visited < 400000) {
      const node = stack.pop();
      visited++;
      const value = node.memoizedProps && node.memoizedProps.value;
      if (value && typeof value === "object" && typeof value.sendRequest === "function" && "gatewayUrl" in value) {
        window.__pdppMuseGateway = value;
        return true;
      }
      if (node.child) stack.push(node.child);
      if (node.sibling) stack.push(node.sibling);
    }
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
  const gateway = window.__pdppMuseGateway;
  if (!gateway || typeof gateway.sendRequest !== "function") {
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
    return JSON.stringify({ ok: false, code: /timeout/i.test(text) ? "timeout" : "rpc_error", message: text.slice(0, 120) });
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
async function waitForGateway(page: ScriptRunner): Promise<boolean> {
	for (let attempt = 0; attempt < GATEWAY_WAIT_ATTEMPTS; attempt++) {
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
			if (!answer.ok && answer.code === "not_ready") {
				// The app replaced or dropped its client (reconnect, navigation).
				if (!(await waitForGateway(page))) throw authFailure();
				answer = await once(method, params);
			}
			if (answer.ok) return answer.value ?? null;
			const code = answer.code ?? "rpc_error";
			const detail = answer.message ? `: ${answer.message}` : "";
			throw new MuseRpcError(
				code,
				`muse_rpc_failed: ${method} ${code === "timeout" ? "timeout" : "error"}${detail}`,
			);
		},
	};
}

// ─── Session ────────────────────────────────────────────────────────────

/** Whether this page is muse.ai with the app's gateway client loaded. Never navigates. */
export async function hasMuseSession(page: ScriptRunner): Promise<boolean> {
	return (await isOnMuse(page)) && (await locateGateway(page));
}

async function openMuse(page: Page): Promise<void> {
	if (!(await isOnMuse(page))) {
		await page.goto(MUSE_HOME_URL, { waitUntil: "domcontentloaded" });
	}
}

export async function probeMuseSession({
	page,
}: ProbeSessionArgs): Promise<boolean> {
	await openMuse(page);
	return (await isOnMuse(page)) && (await waitForGateway(page));
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
	if ((await isOnMuse(page)) && (await waitForGateway(page))) return;
	const ready = await manualBrowserLogin({
		assist,
		...(capture ? { capture } : {}),
		completeAssistance,
		isProbeSuccessful: (isLive: boolean) => isLive,
		message: MUSE_LOGIN_MESSAGE,
		page,
		probe: () => hasMuseSession(page),
		readinessProbe: hasMuseSession,
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

/** conversations cursor: how far every chat's messages have been read. */
interface ConversationsCursor {
	version: typeof CURSOR_VERSION;
	messages_read_through_ms: number | null;
}

function parseConversationsCursor(value: unknown): ConversationsCursor | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	const through = v.messages_read_through_ms;
	if (v.version !== CURSOR_VERSION) return null;
	if (
		through !== null &&
		(typeof through !== "number" || !Number.isFinite(through))
	)
		return null;
	return { version: CURSOR_VERSION, messages_read_through_ms: through };
}

interface ListedSession {
	session: MuseSession;
	archivedView: boolean;
}

async function listSessions(gateway: MuseGateway): Promise<ListedSession[]> {
	const out: ListedSession[] = [];
	const seen = new Set<string>();
	for (const archivedView of [false, true]) {
		const raw = await call(
			gateway,
			"sessions.list",
			archivedView ? { view: "archived" } : {},
		);
		const sessions = parseSessions(raw);
		if (sessions === null) {
			throw new StreamFailure(
				`Muse's ${archivedView ? "archived " : ""}chat list came back in a shape the connector cannot read; nothing was checkpointed.`,
			);
		}
		for (const session of sessions) {
			if (seen.has(session.session_id)) continue;
			seen.add(session.session_id);
			out.push({ session, archivedView });
		}
	}
	return out;
}

type HistoryOutcome =
	| { kind: "hydrated" }
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
			if (isAuthError(error)) throw error;
			return {
				kind: "gap",
				errorClass: "muse_history_failed",
				message: "chat.history failed",
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
		const fresh = uniqueEvents(page.events).filter(
			(e) => !seen.has(e.message_id),
		);
		for (const event of fresh) {
			seen.add(event.message_id);
			await emitBuilt(
				ctx,
				tally,
				MESSAGES,
				buildMessageRecord(event, sessionId),
			);
		}
		if (!page.hasMore) return { kind: "hydrated" }; // the source's end signal
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

/** Message gaps the host carried over from earlier runs, by chat id. */
function pendingMessageGaps(ctx: MuseCtx): string[] {
	const keys = new Set<string>();
	for (const gap of ctx.detailGaps ?? []) {
		if (gap.stream !== MESSAGES) continue;
		const key = gap.record_key;
		if (typeof key === "string" && key !== "") keys.add(key);
		else if (typeof key === "number") keys.add(String(key));
	}
	return [...keys];
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
): Promise<Set<string>> {
	const hydrated: string[] = [];
	const gaps: string[] = [];
	for (const [index, sessionId] of required.entries()) {
		await ctx.progress(`Reading chat ${index + 1} of ${required.length}`, {
			stream: MESSAGES,
		});
		const outcome = await hydrateChat(ctx, gateway, tally, sessionId);
		if (outcome.kind === "hydrated") {
			hydrated.push(sessionId);
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
		requiredKeys: required,
		hydratedKeys: hydrated,
		gapKeys: gaps,
	});
	if (gaps.length > 0) {
		connectorDiagnostic("muse", "message_gaps", { count: gaps.length });
	}
	return new Set(hydrated);
}

/**
 * The new messages watermark: the newest update time below which every chat
 * this run had to read was read completely. A chat gapped in an earlier run
 * (already below the old watermark) is tracked by its DETAIL_GAP instead.
 */
export function nextMessagesWatermark(
	prior: number | null,
	required: ReadonlyArray<{ id: string; updatedMs: number | null }>,
	hydrated: ReadonlySet<string>,
): number | null {
	const fresh = required.filter(
		(c) => prior === null || c.updatedMs === null || c.updatedMs > prior,
	);
	// A chat without an update time cannot be placed below any watermark.
	if (fresh.some((c) => c.updatedMs === null && !hydrated.has(c.id))) {
		return prior;
	}
	let limit = Number.POSITIVE_INFINITY;
	for (const c of fresh) {
		if (!hydrated.has(c.id) && c.updatedMs !== null && c.updatedMs < limit)
			limit = c.updatedMs;
	}
	let next = prior;
	for (const c of fresh) {
		if (c.updatedMs === null || !hydrated.has(c.id) || c.updatedMs >= limit)
			continue;
		if (next === null || c.updatedMs > next) next = c.updatedMs;
	}
	return next;
}

export async function runChatStreams(
	ctx: MuseCtx,
	gateway: MuseGateway,
	tally: TextTally,
): Promise<void> {
	const wantConversations = ctx.requested.has(CONVERSATIONS);
	const wantMessages = ctx.requested.has(MESSAGES);
	if (!(wantConversations || wantMessages)) return;
	const pending = wantMessages ? pendingMessageGaps(ctx) : [];

	if (ctx.recoveryOnly) {
		if (pending.length > 0) await hydrateChats(ctx, gateway, tally, pending);
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
	const prior = stored?.messages_read_through_ms ?? null;
	let through = prior;
	if (wantMessages) {
		const chats = listed.map(({ session }) => ({
			id: session.session_id,
			updatedMs:
				typeof session.updated_at_ms === "number" &&
				Number.isFinite(session.updated_at_ms)
					? session.updated_at_ms
					: null,
		}));
		const changed = chats.filter(
			(c) => prior === null || c.updatedMs === null || c.updatedMs > prior,
		);
		changed.sort((a, b) => (a.updatedMs ?? 0) - (b.updatedMs ?? 0));
		const changedIds = new Set(changed.map((c) => c.id));
		// Retry earlier gaps first, then every chat changed since the watermark.
		const required = [
			...pending.filter((id) => !changedIds.has(id)),
			...changed.map((c) => c.id),
		];
		const hydrated = await hydrateChats(ctx, gateway, tally, required);
		// A time-ranged run reads only part of each chat: it moves no watermark.
		through = ctx.requested.get(MESSAGES)?.time_range
			? prior
			: nextMessagesWatermark(prior, changed, hydrated);
	}

	if (wantConversations) {
		await ctx.emit(buildFullScanCoverageMessage(CONVERSATIONS, listed.length));
		const cursor: ConversationsCursor = {
			version: CURSOR_VERSION,
			messages_read_through_ms: through,
		};
		await ctx.emit({
			type: "STATE",
			stream: CONVERSATIONS,
			cursor: { ...cursor },
		});
	}
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
	let beforeIso: string | null = null;
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
			const fresh = items.filter((a) => !seen.has(activityId(a)));
			if (fresh.length === 0) {
				throw new StreamFailure(
					"Muse's activity log returned the same page again; older activity was not read and nothing was checkpointed.",
				);
			}
			for (const a of fresh) {
				seen.add(activityId(a));
				await emitBuilt(ctx, tally, ACTIVITIES, buildActivityRecord(a));
			}
			// The oldest activity across all days of the page; its timestamp
			// string, unchanged, is the next before.
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
			if (beforeIso !== null && oldestIso >= beforeIso) {
				throw new StreamFailure(
					"Muse's activity log did not page back to older activity; nothing was checkpointed.",
				);
			}
			before = oldestRaw;
			beforeIso = oldestIso;
		}
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
	stream: string,
	considered: number,
): Promise<void> {
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
		let incomplete = false;
		for (const source of GOAL_SOURCES) {
			const page = parseGoals(await call(gateway, "goals.list", { source }));
			if (page === null) {
				throw new StreamFailure(
					`Muse's ${source} goals came back in a shape the connector cannot read; nothing was checkpointed.`,
				);
			}
			for (const goal of page.goals) {
				if (seen.has(goal.goal_id)) continue;
				seen.add(goal.goal_id);
				await emitBuilt(ctx, tally, GOALS, buildGoalRecord(goal, source));
			}
			if (page.hasNextPage) incomplete = true;
		}
		if (incomplete) {
			throw new StreamFailure(
				"Muse reports more goals than one page holds, and the connector cannot read the next page; the goals list is not checkpointed as complete.",
				false,
			);
		}
		await closeFullInventory(ctx, GOALS, seen.size);
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
		await closeFullInventory(ctx, SCHEDULED_TASKS, seen.size);
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
			await emitBuilt(
				ctx,
				tally,
				MEMORY_FILES,
				buildMemoryFileRecord(entry, text),
			);
		}
		if (failed > 0) {
			throw new StreamFailure(
				`${failed} of ${present.length} Muse memory files could not be read; the memory files are not checkpointed.`,
			);
		}
		await closeFullInventory(ctx, MEMORY_FILES, present.length);
	} catch (error) {
		await failStreams(ctx, [MEMORY_FILES], error);
	}
}

export async function runFiles(
	ctx: MuseCtx,
	gateway: MuseGateway,
	tally: TextTally,
): Promise<void> {
	if (!ctx.requested.has(FILES)) return;
	await ctx.progress("Reading the file library", { stream: FILES });
	try {
		const seen = new Set<string>();
		let total: number | null = null;
		let offset = 0;
		let unsafePaths = 0;
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
				const built = buildFileRecord(entry);
				if (built === null) {
					unsafePaths += 1;
					continue;
				}
				await emitBuilt(ctx, tally, FILES, built);
			}
			if (!page.hasMore) break; // the source's end signal
			if (page.entries.length === 0 || fresh.length === 0) {
				throw new StreamFailure(
					"Muse's file library said it had more files but returned no new ones; nothing was checkpointed.",
				);
			}
			offset += page.entries.length;
		}
		if (total !== null && total !== seen.size) {
			throw new StreamFailure(
				`Muse's file library reported ${total} files but listed ${seen.size}; it changed while it was read, and nothing was checkpointed.`,
			);
		}
		if (unsafePaths > 0) {
			throw new StreamFailure(
				`${unsafePaths} Muse files have a path that is not storable text and were left out; the file list is not checkpointed as complete.`,
				false,
			);
		}
		await closeFullInventory(ctx, FILES, seen.size);
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
		await closeFullInventory(ctx, CONNECTED_APPS, seen.size);
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

export async function collectMuse(ctx: BrowserCollectContext): Promise<void> {
	if (ctx.requested.size === 0) return;
	await openMuse(ctx.page);
	if (!(await isOnMuse(ctx.page)) || !(await waitForGateway(ctx.page))) {
		throw authFailure();
	}
	await collectMuseWith(ctx, pageGateway(ctx.page));
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
