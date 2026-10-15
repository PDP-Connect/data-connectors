#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP anthropic_live Connector: Claude read live from the signed-in
 * claude.ai session.
 *
 * `connectors/anthropic` collects through Claude's official data export,
 * which can be requested once per 24 hours and emails the owner each time.
 * This connector is the second profile for the same source
 * (`sources/claude`), for continuous incremental collection. It requests no
 * export and sends no email. Every read is an in-page `fetch` from the
 * claude.ai document, the web app's own JSON endpoints:
 *
 *   GET /api/organizations                                  org, plan family
 *   GET /api/organizations/{org}/chat_conversations         list, newest first
 *   GET /api/organizations/{org}/chat_conversations/{id}    messages
 *   GET /api/organizations/{org}/subscription_details       plan dates
 *   GET /api/organizations/{org}/usage                      usage limits
 *
 * These are private endpoints with no stability promise. Their shapes (keys
 * and types, no values) were observed against a real signed-in session on
 * 2026-10-08. The connector was run that day against a real free-plan account
 * with one conversation. Attachments, projects, list paging and the per-run
 * cap have not been exercised live.
 *
 * Streams:
 *   - conversations, messages: same field names as connectors/anthropic.
 *     Incremental on the list's `updated_at`, oldest change first. Each
 *     stream keeps its own cursor (ChatCursor) and window, so either can be
 *     requested, widened or added later without skipping its history.
 *   - account_plan: same fields as the chatgpt connector's account_plan.
 *   - usage_limits: the share of each usage limit used and its reset time.
 *
 * Known limits:
 *   - claude.ai records the model on the conversation, not on a message.
 *     `messages.model` is the conversation's model when the message was
 *     collected (`model_source: "conversation"`); see parsers.ts.
 *   - One organization per run: the first with the `chat` capability, the
 *     export connector's rule. An account that also belongs to a Team
 *     organization has that organization's conversations left out.
 *   - A conversation deleted on claude.ai is not retracted. Temporary chats
 *     are not listed by claude.ai and are not collected.
 *   - At most MAX_CONVERSATIONS_PER_RUN conversations are read per run; a
 *     first run on a large account finishes over several runs. A list longer
 *     than MAX_LIST_PAGES pages fails the run instead of skipping its oldest
 *     conversations.
 *   - The list is paged by offset. A list of more than one page is read
 *     again until two reads agree, at most LIST_PASSES reads; then the run
 *     fails, retryable, with no checkpoint (see listConversations). An owner
 *     who changes conversations during every run delays collection.
 *
 * Reachability probe: permanently exempt. Every endpoint sits behind the
 * claude.ai login wall and there is no unauthenticated probe target.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	type BrowserCollectContext,
	buildFullScanCoverageMessage,
	type EnsureSessionArgs,
	nowIso,
	type ProbeSessionArgs,
	politeDelay,
	type RecordData,
	resumeSafeSkip,
	runConnector,
	type StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	isOutsideTimeRange,
	parseIsoInstant,
} from "../../packages/polyfill-connectors/src/time-range.ts";
import {
	buildAccountPlanRecord,
	buildConversationRecord,
	buildMessageRecord,
	buildUsageLimitRecords,
	omissionsOf,
} from "./parsers.ts";
import { INLINE_TEXT_MAX_UNITS } from "./safe-escape.ts";
import { validateRecord } from "./schemas.ts";
import type {
	RawConversation,
	RawMessage,
	RawOrganization,
	RawSubscriptionDetails,
} from "./types.ts";

const CLAUDE_ORIGIN = "https://claude.ai";
const CLAUDE_HOME_URL = `${CLAUDE_ORIGIN}/new`;
const CLAUDE_LOGIN_URL = `${CLAUDE_ORIGIN}/login`;
export const ANTHROPIC_LIVE_LOGIN_MESSAGE =
	"Sign in to Claude in the secure browser. PDPP continues automatically when Claude confirms the session.";

const CONVERSATIONS_STREAM = "conversations";
const MESSAGES_STREAM = "messages";
const ACCOUNT_PLAN_STREAM = "account_plan";
const USAGE_LIMITS_STREAM = "usage_limits";

const LIST_PAGE_SIZE = 50;
const MAX_LIST_PAGES = 400;
/** Reads of the whole list per run before a changing list fails the run. */
const LIST_PASSES = 4;
export const MAX_CONVERSATIONS_PER_RUN = 200;
// Read per call so tests can shorten it (the repo's timeout-override
// convention; see connectors/anthropic/index.ts).
const detailDelayMs = () =>
	Number(process.env.PDPP_ANTHROPIC_LIVE_DETAIL_DELAY_MS) || 400;
const DETAIL_QUERY = "tree=True&rendering_mode=messages&render_all_tools=true";
const TRAILING_ZEROS_RE = /0+$/;

type Page = BrowserCollectContext["page"];

interface ApiResult {
	status: number;
	json: unknown;
}

class AuthError extends Error {
	constructor(status: number) {
		super(`anthropic_live_auth_failed: http ${status}`);
	}
}

/**
 * Whether Claude's API accepts this page's session. Read-only and never
 * navigates, so it is safe to repeat on the page the owner is signing in on.
 * A session cookie is not proof: a revoked or expired cookie stays in the
 * profile, and only the API says whether it still works.
 */
export async function hasClaudeSession(page: Page): Promise<boolean> {
	return (await readSession(page)) === "live";
}

/** "live", or the HTTP status that says it is not (0: no answer). */
async function readSession(page: Page): Promise<"live" | number> {
	try {
		if (!(await isOnClaude(page))) return 0;
		const orgs = await apiGet(page, "/api/organizations");
		return orgs.status === 200 && Array.isArray(orgs.json)
			? "live"
			: orgs.status;
	} catch {
		return 0;
	}
}

/**
 * Session check that may navigate: opens claude.ai first when the page is on
 * another origin. Used where no one is signing in, and by PageShim hosts.
 */
async function readSessionOnPage(page: Page): Promise<"live" | number> {
	if (!(await isOnClaude(page))) {
		await page.goto(CLAUDE_HOME_URL, { waitUntil: "domcontentloaded" });
	}
	return await readSession(page);
}

export async function probeAnthropicLiveSessionOnPage(
	page: Page,
): Promise<boolean> {
	return (await readSessionOnPage(page)) === "live";
}

export async function probeAnthropicLiveSession({
	page,
}: ProbeSessionArgs): Promise<boolean> {
	return await probeAnthropicLiveSessionOnPage(page);
}

async function isOnClaude(page: Page): Promise<boolean> {
	try {
		return (await page.evaluate(() => location.origin)) === CLAUDE_ORIGIN;
	} catch {
		return false;
	}
}

/**
 * Hand sign-in to the owner on the runtime-owned page. The readiness check
 * only asks Claude's API from that page; it never navigates away from the
 * sign-in form the owner is using.
 */
export async function ensureAnthropicLiveSession({
	assist,
	capture,
	completeAssistance,
	page,
	sendInteraction,
}: Pick<
	EnsureSessionArgs,
	"assist" | "capture" | "completeAssistance" | "page" | "sendInteraction"
>): Promise<void> {
	const session = await readSessionOnPage(page);
	if (session === "live") return;
	// Claude failing, not refusing: signing in again would not help. The
	// message matches the runtime's retryable pattern.
	if (session === 429 || session >= 500) {
		throw new Error(`anthropic_live_organizations_failed: http ${session}`);
	}
	await page.goto(CLAUDE_LOGIN_URL, { waitUntil: "domcontentloaded" });
	const ready = await manualBrowserLogin({
		assist,
		...(capture ? { capture } : {}),
		completeAssistance,
		isProbeSuccessful: (isLive: boolean) => isLive,
		message: ANTHROPIC_LIVE_LOGIN_MESSAGE,
		page,
		probe: () => probeAnthropicLiveSessionOnPage(page),
		readinessProbe: hasClaudeSession,
		readinessProbeOnHandoffPage: true,
		sendInteraction,
		timeoutSeconds: 1800,
	});
	if (!ready) throw new Error("anthropic_live_session_required");
}

/**
 * GET a claude.ai API path from the claude.ai document. Status 0 is a
 * network error or timeout. 401 and 403 are returned, not thrown: a caller
 * decides whether that means "signed out" or "not available on this plan".
 */
async function apiGet(page: Page, path: string): Promise<ApiResult> {
	return await page.evaluate(async (apiPath) => {
		if (location.origin !== "https://claude.ai") {
			return { status: 0, json: null };
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 60_000);
		try {
			const res = await fetch(apiPath, {
				credentials: "include",
				headers: { accept: "application/json" },
				signal: controller.signal,
			});
			let json: unknown = null;
			try {
				json = await res.json();
			} catch {
				json = null;
			}
			return { status: res.status, json };
		} catch {
			return { status: 0, json: null };
		} finally {
			clearTimeout(timeout);
		}
	}, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetryableStatus(status: number): boolean {
	return status === 0 || status === 429 || status >= 500;
}

/** The export connector's rule: `chat`, then `claude_max`, then the first. */
export function selectChatOrganization(orgs: unknown): RawOrganization | null {
	if (!Array.isArray(orgs)) return null;
	const valid = orgs.filter(
		(org): org is RawOrganization & { uuid: string } =>
			isRecord(org) && typeof org.uuid === "string",
	);
	const has = (org: RawOrganization, capability: string) =>
		Array.isArray(org.capabilities) && org.capabilities.includes(capability);
	return (
		valid.find((org) => has(org, "chat")) ??
		valid.find((org) => has(org, "claude_max")) ??
		valid[0] ??
		null
	);
}

type Ctx = Pick<
	BrowserCollectContext,
	| "collectionMode"
	| "emit"
	| "emitRecord"
	| "page"
	| "progress"
	| "reportStreamFailure"
	| "requested"
	| "state"
>;

async function skip(
	ctx: Ctx,
	stream: string,
	reason: string,
	message: string,
	retryable: boolean,
): Promise<void> {
	await ctx.emit({
		type: "SKIP_RESULT",
		stream,
		reason,
		message,
		recovery_hint: retryable
			? { action: "retry_by_runtime", retryable: true }
			: { action: "not_retriable", retryable: false },
	});
}

/**
 * Emit at most one account_plan record. An unreadable subscription_details
 * on a retryable status emits nothing, so a transient failure never
 * overwrites the last real plan dates with nulls. 403/404 there means the
 * organization has no readable subscription (free plan, or a Team member
 * without billing access): the record is emitted with null dates.
 */
export async function runAccountPlanStream(
	ctx: Ctx,
	org: RawOrganization,
	orgPath: string,
): Promise<void> {
	await ctx.progress("Fetching account plan", { stream: ACCOUNT_PLAN_STREAM });
	const res = await apiGet(ctx.page, `${orgPath}/subscription_details`);
	if (res.status === 401) throw new AuthError(res.status);
	const unavailable = res.status === 403 || res.status === 404;
	if (res.status !== 200 && !unavailable) {
		await skip(
			ctx,
			ACCOUNT_PLAN_STREAM,
			"http_error",
			`subscription_details http ${res.status}`,
			isRetryableStatus(res.status),
		);
		return;
	}
	if (res.status === 200 && !isRecord(res.json)) {
		await skip(
			ctx,
			ACCOUNT_PLAN_STREAM,
			"parse_error",
			"subscription_details http 200 with no readable body",
			true,
		);
		return;
	}
	const record = buildAccountPlanRecord(
		org,
		unavailable ? null : (res.json as RawSubscriptionDetails),
	);
	if (!(record && validateRecord(ACCOUNT_PLAN_STREAM, record).ok)) {
		await skip(
			ctx,
			ACCOUNT_PLAN_STREAM,
			"parse_error",
			"organization has no readable plan",
			true,
		);
		return;
	}
	// Stable synthetic id and no run-clock field: an unchanged plan is not
	// re-emitted. The last emitted record is kept in STATE (it holds no
	// secret) because the fingerprint cursor needs node:crypto, which the
	// PageShim host does not provide.
	const prior = ctx.state[ACCOUNT_PLAN_STREAM] as
		| { emitted?: unknown }
		| undefined;
	const serialized = JSON.stringify(record);
	if (prior?.emitted !== serialized) {
		await ctx.emitRecord(ACCOUNT_PLAN_STREAM, record);
	}
	await ctx.emit({
		type: "STATE",
		stream: ACCOUNT_PLAN_STREAM,
		cursor: { fetched_at: nowIso(), emitted: serialized },
	});
	await ctx.emit(buildFullScanCoverageMessage(ACCOUNT_PLAN_STREAM, 1));
}

/** Emit one usage_limits record per limit claude.ai reports. */
export async function runUsageLimitsStream(
	ctx: Ctx,
	orgPath: string,
): Promise<void> {
	await ctx.progress("Fetching usage limits", { stream: USAGE_LIMITS_STREAM });
	const res = await apiGet(ctx.page, `${orgPath}/usage`);
	if (res.status === 401) throw new AuthError(res.status);
	if (res.status === 403 || res.status === 404) {
		await skip(
			ctx,
			USAGE_LIMITS_STREAM,
			"not_available",
			`usage http ${res.status}`,
			false,
		);
		return;
	}
	if (res.status !== 200) {
		await skip(
			ctx,
			USAGE_LIMITS_STREAM,
			"http_error",
			`usage http ${res.status}`,
			isRetryableStatus(res.status),
		);
		return;
	}
	const records = buildUsageLimitRecords(res.json);
	if (
		records === null ||
		records.some((record) => !validateRecord(USAGE_LIMITS_STREAM, record).ok)
	) {
		await skip(
			ctx,
			USAGE_LIMITS_STREAM,
			"parse_error",
			"usage http 200 with no readable limits",
			true,
		);
		return;
	}
	for (const record of records) {
		await ctx.emitRecord(USAGE_LIMITS_STREAM, record);
	}
	await ctx.emit({
		type: "STATE",
		stream: USAGE_LIMITS_STREAM,
		cursor: { fetched_at: nowIso() },
	});
	await ctx.emit(
		buildFullScanCoverageMessage(USAGE_LIMITS_STREAM, records.length),
	);
}

/**
 * A conversation's place in the list order: its update time with every
 * fractional digit claude.ai reports, then its id to order equal times.
 */
interface ListKey {
	update_time: string;
	id: string;
}

interface ListedConversation extends ListKey {
	raw: RawConversation;
}

/**
 * Order two RFC 3339 instants exactly. Date.parse keeps milliseconds only;
 * claude.ai reports microseconds. Callers pass values already parsed once.
 */
function compareInstants(left: string, right: string): number {
	const a = parseIsoInstant(left);
	const b = parseIsoInstant(right);
	if (a === null || b === null) {
		throw new Error("anthropic_live_unparsed_instant");
	}
	if (a.second !== b.second) return a.second - b.second;
	// With trailing zeros removed, decimal fractions order as strings.
	const fa = a.fraction.replace(TRAILING_ZEROS_RE, "");
	const fb = b.fraction.replace(TRAILING_ZEROS_RE, "");
	return fa < fb ? -1 : fa > fb ? 1 : 0;
}

function compareKeys(left: ListKey, right: ListKey): number {
	const byTime = compareInstants(left.update_time, right.update_time);
	if (byTime !== 0) return byTime;
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** A whole second before `instant`: earlier than it at any precision. */
function secondBefore(instant: string): string {
	const parsed = parseIsoInstant(instant);
	if (parsed === null) throw new Error("anthropic_live_unparsed_instant");
	return new Date(parsed.second - 1000).toISOString();
}

function isInstant(value: unknown): value is string {
	return parseIsoInstant(value) !== null;
}

/** The parts of a stream's START scope that decide what a cursor covers. */
interface ChatScope {
	since: string | null;
	until: string | null;
	resources: string[] | null;
	fields: string[] | null;
}

function chatScopeOf(scope: StreamScope | undefined): ChatScope {
	const strings = (value: unknown): string[] | null =>
		Array.isArray(value)
			? value.filter((v): v is string => typeof v === "string").sort()
			: null;
	return {
		since: scope?.time_range?.since ?? null,
		until: scope?.time_range?.until ?? null,
		resources: strings(scope?.resources),
		fields: strings(scope?.fields),
	};
}

/**
 * Whether records collected under `prior` include every record `current`
 * selects, apart from `until`, which resumeFrom handles by rewinding.
 */
function covers(prior: ChatScope, current: ChatScope): boolean {
	const subset = (had: string[] | null, wants: string[] | null) =>
		had === null || wants?.every((v) => had.includes(v)) === true;
	return (
		(prior.since === null ||
			(current.since !== null &&
				compareInstants(current.since, prior.since) >= 0)) &&
		subset(prior.resources, current.resources) &&
		subset(prior.fields, current.fields)
	);
}

/**
 * STATE of `conversations` and of `messages`, one per stream. Version 3:
 * version 2 cursors came from a list read that did not check for changes
 * between pages, so they can sit past a conversation that was never read.
 *
 * - read_through: every conversation listed at or before this key was read
 *   at that version, under `scope`, in `organization_id`.
 * - emitted_through (messages only): every in-scope message whose latest
 *   create/update time is at or before this instant was emitted. It moves
 *   only when a run reads every changed conversation, because a conversation
 *   left unread past read_through can hold messages older than it.
 *
 * Holds no record content and no credential.
 */
interface ChatCursor {
	version: 3;
	organization_id: string;
	scope: ChatScope;
	read_through: ListKey | null;
	emitted_through?: string | null;
}

function parseCursor(value: unknown): ChatCursor | null {
	if (!isRecord(value) || value.version !== 3) return null;
	const { organization_id: org, scope, read_through: through } = value;
	const emitted = value.emitted_through ?? null;
	if (typeof org !== "string" || !isRecord(scope)) return null;
	if (
		through !== null &&
		!(
			isRecord(through) &&
			isInstant(through.update_time) &&
			typeof through.id === "string"
		)
	) {
		return null;
	}
	if (emitted !== null && !isInstant(emitted)) return null;
	const bound = (v: unknown) => (v === null ? null : isInstant(v) ? v : false);
	const since = bound(scope.since ?? null);
	const until = bound(scope.until ?? null);
	if (since === false || until === false) return null;
	const isString = (x: unknown): x is string => typeof x === "string";
	const list = (v: unknown) =>
		v === null || v === undefined
			? null
			: Array.isArray(v) && v.every(isString)
				? v.filter(isString)
				: false;
	const resources = list(scope.resources);
	const fields = list(scope.fields);
	if (resources === false || fields === false) return null;
	return {
		version: 3,
		organization_id: org,
		scope: { since, until, resources, fields },
		read_through:
			through === null
				? null
				: { update_time: String(through.update_time), id: String(through.id) },
		emitted_through: emitted,
	};
}

/** One requested chat stream: its window and where this run resumes it. */
interface StreamPlan {
	stream: string;
	scope: ChatScope;
	timeRange: StreamScope["time_range"];
	readThrough: ListKey | null;
	emittedThrough: string | null;
}

/**
 * Where a stream resumes. A full refresh, a 0.1 or version 2 cursor, another
 * organization or a wider selection starts over. A later `until` keeps the
 * cursor but rewinds it to before the old `until`: records at or after it
 * were left out, and only conversations updated since then can hold them.
 */
function planStream(
	ctx: Ctx,
	stream: string,
	organizationId: string,
): StreamPlan {
	const requested = ctx.requested.get(stream);
	const scope = chatScopeOf(requested);
	const plan: StreamPlan = {
		stream,
		scope,
		timeRange: requested?.time_range,
		readThrough: null,
		emittedThrough: null,
	};
	const prior = parseCursor(ctx.state[stream]);
	if (
		ctx.collectionMode === "full_refresh" ||
		prior === null ||
		prior.organization_id !== organizationId ||
		!covers(prior.scope, scope)
	) {
		return plan;
	}
	plan.readThrough = prior.read_through;
	plan.emittedThrough = prior.emitted_through ?? null;
	const priorUntil = prior.scope.until;
	if (
		priorUntil !== null &&
		(scope.until === null || compareInstants(scope.until, priorUntil) > 0)
	) {
		const before = secondBefore(priorUntil);
		if (
			plan.readThrough &&
			compareInstants(plan.readThrough.update_time, before) > 0
		) {
			// "" orders before every id, so all conversations at `before` reread.
			plan.readThrough = { update_time: before, id: "" };
		}
		if (
			plan.emittedThrough &&
			compareInstants(plan.emittedThrough, before) > 0
		) {
			plan.emittedThrough = before;
		}
	}
	return plan;
}

/**
 * Whether `item` can hold a record this stream has not collected: listed
 * after its cursor, and updated at or after its `since` (a record's create
 * time is never later than its conversation's update time).
 */
function needs(plan: StreamPlan, item: ListKey): boolean {
	return (
		(plan.readThrough === null || compareKeys(item, plan.readThrough) > 0) &&
		(plan.scope.since === null ||
			compareInstants(item.update_time, plan.scope.since) >= 0)
	);
}

/** The oldest update time any conversation this stream needs can have. */
function oldestNeeded(plan: StreamPlan): string | null {
	const { readThrough, scope } = plan;
	if (readThrough === null) return scope.since;
	if (scope.since === null) return readThrough.update_time;
	return compareInstants(readThrough.update_time, scope.since) > 0
		? readThrough.update_time
		: scope.since;
}

/** The oldest update time any requested stream needs; null reads it all. */
function listFloor(plans: readonly StreamPlan[]): string | null {
	let floor: string | null = null;
	for (const plan of plans) {
		const oldest = oldestNeeded(plan);
		if (oldest === null) return null;
		if (floor === null || compareInstants(oldest, floor) < 0) floor = oldest;
	}
	return floor;
}

/**
 * Whether the stream's own window admits a record. The runtime applies the
 * same rule; checking first keeps a record at or after `until` from reaching
 * it, which would hold back every STATE of the run.
 */
function inWindow(plan: StreamPlan, record: RecordData): boolean {
	return (
		plan.timeRange === undefined ||
		!isOutsideTimeRange(plan.timeRange, record.create_time)
	);
}

function cursorOf(plan: StreamPlan, organizationId: string): ChatCursor {
	return {
		version: 3,
		organization_id: organizationId,
		scope: plan.scope,
		read_through: plan.readThrough,
		...(plan.stream === MESSAGES_STREAM
			? { emitted_through: plan.emittedThrough }
			: {}),
	};
}

/** A run stops on it with a stream failure and keeps its cursor. */
class ChatCollectionFailure extends Error {
	readonly retryable: boolean;
	constructor(message: string, retryable: boolean) {
		super(message);
		this.retryable = retryable;
	}
}

function listed(raw: unknown): ListedConversation | null {
	if (!isRecord(raw)) return null;
	const { uuid, updated_at: updatedAt } = raw;
	if (typeof uuid !== "string" || !uuid || !isInstant(updatedAt)) return null;
	return { raw, id: uuid, update_time: updatedAt };
}

/** Read one page of the conversation list; every entry must be readable. */
async function listPage(
	ctx: Ctx,
	orgPath: string,
	offset: number,
): Promise<ListedConversation[]> {
	const res = await apiGet(
		ctx.page,
		`${orgPath}/chat_conversations?limit=${LIST_PAGE_SIZE}&offset=${offset}`,
	);
	if (res.status === 401 || res.status === 403) {
		throw new AuthError(res.status);
	}
	if (res.status !== 200 || !Array.isArray(res.json)) {
		throw new Error(`anthropic_live_list_failed: http ${res.status}`);
	}
	const items = res.json.map(listed);
	if (items.some((item) => item === null)) {
		throw new ChatCollectionFailure(
			`Claude's conversation list had an entry without a readable id or update time at offset ${offset}; nothing was checkpointed past it.`,
			true,
		);
	}
	return items as ListedConversation[];
}

interface ListPass {
	items: ListedConversation[];
	pages: number;
}

/**
 * Page the list once (newest change first) until a page reaches a
 * conversation updated before `oldest`, or the end. Running out of pages
 * first is a failure, never a shorter list.
 */
async function listPass(
	ctx: Ctx,
	orgPath: string,
	oldest: string | null,
): Promise<ListPass> {
	const items: ListedConversation[] = [];
	for (let pageIndex = 0; pageIndex < MAX_LIST_PAGES; pageIndex++) {
		const page = await listPage(ctx, orgPath, pageIndex * LIST_PAGE_SIZE);
		items.push(...page);
		const reachedOldest =
			oldest !== null &&
			page.some((item) => compareInstants(item.update_time, oldest) < 0);
		if (page.length < LIST_PAGE_SIZE || reachedOldest) {
			return { items, pages: pageIndex + 1 };
		}
	}
	throw new ChatCollectionFailure(
		`Claude's conversation list is longer than ${MAX_LIST_PAGES * LIST_PAGE_SIZE} entries; older conversations were not read and nothing was checkpointed.`,
		false,
	);
}

/**
 * The id and update time of every listed conversation updated at or after
 * `oldest`. Null when an id is listed twice, or when an entry is newer than
 * the first one: it changed after the first page was read.
 */
function inventory(
	items: readonly ListedConversation[],
	oldest: string | null,
): Set<string> | null {
	const entries = new Set<string>();
	const ids = new Set<string>();
	const first = items[0];
	for (const item of items) {
		if (oldest !== null && compareInstants(item.update_time, oldest) < 0) {
			continue;
		}
		if (ids.has(item.id)) return null;
		if (first && compareInstants(item.update_time, first.update_time) > 0) {
			return null;
		}
		ids.add(item.id);
		entries.add(`${item.id} ${item.update_time}`);
	}
	return entries;
}

function sameInventory(a: Set<string>, b: Set<string>): boolean {
	return a.size === b.size && [...a].every((entry) => b.has(entry));
}

/**
 * The listed conversations a run reads from. The list is paged by offset
 * and can change between pages, and equal update times can come back in any
 * order, so one pass over several pages can miss a conversation. Such a pass
 * is used only when its inventory (see inventory()) is not null and equals
 * the inventory of the next full pass. A single page is one response and is used
 * as it is.
 *
 * Why that is enough. Let A and B be the two passes and t the time A read
 * its last page. B, read after t, lists every entry of A with the same
 * update time. Update times only grow and a deleted conversation does not
 * come back, so at t every entry of A still existed unchanged. A's entries
 * from the pages before its last are distinct, at or after `oldest`, and as
 * many as those pages' positions. At t they must fill exactly those
 * positions: anywhere else ahead of the first older entry, A's last page
 * would list them again. A's last page lists every other position ahead of
 * the first older entry. So A holds every conversation that existed
 * unchanged through A. A conversation updated or added after A read its
 * first page is newer than every entry A may hold, so B lists it, ahead of
 * A's entries, and the inventories differ. The read cursor never passes it.
 *
 * Assumptions: the list is in update-time order (equal times in any order),
 * each page is one consistent response, a change gets an update time later
 * than every one listed before it, and a deleted conversation does not come
 * back with its old update time.
 *
 * At most LIST_PASSES passes per run; a list that keeps changing fails the
 * run, retryable, keeping both cursors.
 */
async function listConversations(
	ctx: Ctx,
	orgPath: string,
	oldest: string | null,
): Promise<ListedConversation[]> {
	let previous: Set<string> | null = null;
	for (let attempt = 0; attempt < LIST_PASSES; attempt++) {
		const pass = await listPass(ctx, orgPath, oldest);
		if (pass.pages === 1) return pass.items;
		const current = inventory(pass.items, oldest);
		if (previous && current && sameInventory(previous, current)) {
			return pass.items;
		}
		previous = current;
	}
	throw new ChatCollectionFailure(
		`Claude's conversation list changed while it was read, in ${LIST_PASSES} reads; nothing was checkpointed and the next run reads it again.`,
		true,
	);
}

interface ParsedMessage {
	raw: RawMessage;
	id: string;
	createdAt: string;
	/** The later of created_at and updated_at. */
	changedAt: string;
}

interface ConversationDetail {
	model: string | null;
	messages: ParsedMessage[];
}

/**
 * The detail's messages, or null when the body is not a conversation with a
 * readable `chat_messages` array of messages with an id and a create time.
 * An empty array is a readable, empty conversation.
 */
function readDetail(
	json: unknown,
	item: ListedConversation,
): ConversationDetail | null {
	if (!isRecord(json) || !Array.isArray(json.chat_messages)) return null;
	const messages: ParsedMessage[] = [];
	for (const raw of json.chat_messages) {
		if (!isRecord(raw)) return null;
		const { uuid, created_at: created, updated_at: updated } = raw;
		if (typeof uuid !== "string" || !uuid || !isInstant(created)) return null;
		if (updated !== undefined && updated !== null && !isInstant(updated)) {
			return null;
		}
		const changedAt =
			isInstant(updated) && compareInstants(updated, created) > 0
				? updated
				: created;
		messages.push({ raw, id: uuid, createdAt: created, changedAt });
	}
	messages.sort(
		(a, b) =>
			compareInstants(a.createdAt, b.createdAt) ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	const model =
		typeof json.model === "string" && json.model
			? json.model
			: typeof item.raw.model === "string" && item.raw.model
				? item.raw.model
				: null;
	return { model, messages };
}

/**
 * conversations + messages, each with its own cursor (see ChatCursor). One
 * list read serves both. Conversations are read oldest change first, at most
 * MAX_CONVERSATIONS_PER_RUN per run, and each stream's cursor moves past a
 * conversation only after it was read. A changed conversation emits only the
 * messages changed after `emitted_through`, so a message keeps the model it
 * was first collected with unless a selection change makes the run reread it.
 */
export async function runConversationStreams(
	ctx: Ctx,
	organizationId: string,
	orgPath: string,
): Promise<void> {
	const plans = [CONVERSATIONS_STREAM, MESSAGES_STREAM]
		.filter((stream) => ctx.requested.has(stream))
		.map((stream) => planStream(ctx, stream, organizationId));
	const conversations = plans.find((p) => p.stream === CONVERSATIONS_STREAM);
	const messages = plans.find((p) => p.stream === MESSAGES_STREAM);
	const saveState = async () => {
		for (const plan of plans) {
			await ctx.emit({
				type: "STATE",
				stream: plan.stream,
				cursor: { ...cursorOf(plan, organizationId) },
			});
		}
	};

	await ctx.progress("Listing conversations", {
		stream: plans[0]?.stream ?? CONVERSATIONS_STREAM,
	});
	let changed: ListedConversation[] = [];
	let batch: ListedConversation[] = [];
	// Text fields left absent for passing the inline cap, counted for one
	// aggregate disclosure (no ids, no titles).
	const omitted = {
		conversationFields: 0,
		messageText: 0,
	};
	try {
		const listedItems = await listConversations(ctx, orgPath, listFloor(plans));
		changed = listedItems
			.filter((item) => plans.some((plan) => needs(plan, item)))
			.sort(compareKeys);
		// A full refresh ignores the cursor, so a cap would re-read the same
		// oldest conversations on every run.
		batch =
			ctx.collectionMode === "full_refresh"
				? changed
				: changed.slice(0, MAX_CONVERSATIONS_PER_RUN);

		for (const [index, item] of batch.entries()) {
			let detail: ConversationDetail | null = null;
			if (messages) {
				if (index > 0) await politeDelay(detailDelayMs());
				await ctx.progress(
					`Reading conversation ${index + 1} of ${batch.length}`,
					{ stream: MESSAGES_STREAM },
				);
				const res = await apiGet(
					ctx.page,
					`${orgPath}/chat_conversations/${item.id}?${DETAIL_QUERY}`,
				);
				if (res.status === 401 || res.status === 403) {
					throw new AuthError(res.status);
				}
				// A detail 404 does not prove deletion: it can be temporary. Stop
				// before advancing either stream cursor so the next run relists it.
				if (res.status === 404) {
					throw new ChatCollectionFailure(
						`Claude conversation read failed with http 404 after ${index} of ${batch.length}; the next run relists it.`,
						true,
					);
				}
				if (res.status !== 200) {
					throw new ChatCollectionFailure(
						`Claude conversation read failed with http ${res.status} after ${index} of ${batch.length}; the next run resumes there.`,
						isRetryableStatus(res.status),
					);
				}
				detail = readDetail(res.json, item);
				if (detail === null) {
					throw new ChatCollectionFailure(
						`Claude conversation ${index + 1} of ${batch.length} came back without readable messages; the next run resumes there.`,
						true,
					);
				}
			}
			if (conversations && needs(conversations, item)) {
				const record = buildConversationRecord(
					item.raw,
					detail ? detail.messages.length : null,
				);
				if (record && inWindow(conversations, record)) {
					omitted.conversationFields += omissionsOf(record).exceedsInlineCap;
					await ctx.emitRecord(CONVERSATIONS_STREAM, record);
				}
			}
			if (detail && messages && needs(messages, item)) {
				const { emittedThrough } = messages;
				for (const message of detail.messages) {
					if (
						emittedThrough !== null &&
						compareInstants(message.changedAt, emittedThrough) <= 0
					) {
						continue;
					}
					const record = buildMessageRecord(message.raw, item.id, detail.model);
					if (record && inWindow(messages, record)) {
						omitted.messageText += omissionsOf(record).noBlobStore;
						await ctx.emitRecord(MESSAGES_STREAM, record);
					}
				}
			}
			// Every changed conversation up to this one has now been read.
			for (const plan of plans) {
				if (
					plan.readThrough === null ||
					compareKeys(item, plan.readThrough) > 0
				) {
					plan.readThrough = { update_time: item.update_time, id: item.id };
				}
			}
			await saveState();
		}
	} catch (error) {
		if (!(error instanceof ChatCollectionFailure)) throw error;
		for (const plan of plans) {
			await ctx.reportStreamFailure?.(plan.stream, error.message, {
				retryable: error.retryable,
			});
		}
		return;
	} finally {
		for (const [stream, count, reason, what] of [
			[
				CONVERSATIONS_STREAM,
				omitted.conversationFields,
				"exceeds_inline_cap",
				"had a value too large to store; the record was imported without that value",
			],
			[
				MESSAGES_STREAM,
				omitted.messageText,
				"host_blob_store_unavailable",
				"had text too large for this connector to store; the record was imported without the text",
			],
		] as const) {
			if (count === 0) continue;
			connectorDiagnostic("anthropic_live", "items_too_large", {
				stream,
				count,
				reason,
				max_units: INLINE_TEXT_MAX_UNITS,
			});
			await ctx.progress(
				`${count} ${count === 1 ? "item" : "items"} of ${stream} ${what}`,
				{ stream, count },
			);
		}
	}

	if (changed.length > batch.length) {
		for (const plan of plans) {
			// Resume-safe: `batch` is the oldest-first prefix of `changed`
			// (sorted by compareKeys), so each plan's readThrough stops at or
			// before every deferred conversation, needs() selects them again
			// next run, and emittedThrough is not advanced on this path.
			await ctx.emit(
				resumeSafeSkip(
					{
						type: "SKIP_RESULT",
						stream: plan.stream,
						reason: "anthropic_live_backlog_deferred",
						message: `Read ${batch.length} of ${changed.length} changed conversations; the rest remain for the next run.`,
						recovery_hint: { action: "retry_by_runtime", retryable: true },
					},
					"cursor_at_or_before_loss",
				),
			);
		}
	} else if (messages) {
		// Every changed conversation was read: no message at or before the
		// newest one read is left unemitted.
		messages.emittedThrough =
			messages.readThrough?.update_time ?? messages.emittedThrough;
	}
	await saveState();
}

export async function collectAnthropicLive(ctx: Ctx): Promise<void> {
	const { page, requested } = ctx;
	if (requested.size === 0) return;
	if (!(await isOnClaude(page))) {
		await page.goto(CLAUDE_HOME_URL, {
			waitUntil: "domcontentloaded",
			timeout: 30_000,
		});
	}
	const orgs = await apiGet(page, "/api/organizations");
	if (orgs.status === 401 || orgs.status === 403) {
		throw new AuthError(orgs.status);
	}
	if (orgs.status !== 200) {
		throw new Error(`anthropic_live_organizations_failed: http ${orgs.status}`);
	}
	const org = selectChatOrganization(orgs.json);
	if (!org) {
		for (const stream of requested.keys()) {
			await skip(
				ctx,
				stream,
				"no_chat_organization",
				"No Claude organization with chat access was found.",
				false,
			);
		}
		return;
	}
	const orgPath = `/api/organizations/${String(org.uuid)}`;
	if (requested.has(ACCOUNT_PLAN_STREAM)) {
		await runAccountPlanStream(ctx, org, orgPath);
	}
	if (requested.has(USAGE_LIMITS_STREAM)) {
		await runUsageLimitsStream(ctx, orgPath);
	}
	if (requested.has(CONVERSATIONS_STREAM) || requested.has(MESSAGES_STREAM)) {
		await runConversationStreams(ctx, String(org.uuid), orgPath);
	}
}

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime.
if (isMainModule(import.meta.url)) {
	runConnector({
		name: "anthropic_live",
		browser: { profileName: "anthropic_live" },
		validateRecord,
		retryablePattern:
			/ECONN|fetch failed|anthropic_live_(?:list|organizations)_failed: http (?:0|429|5\d\d)/i,
		ensureSession: ensureAnthropicLiveSession,
		probeSession: probeAnthropicLiveSession,
		probeSessionIsAuthoritative: true,
		collect: collectAnthropicLive,
	});
}
