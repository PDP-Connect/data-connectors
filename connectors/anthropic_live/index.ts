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
 *     Incremental on the list's `updated_at`, oldest change first, so the
 *     cursor only moves past conversations whose messages were read.
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
 *     first run on a large account finishes over several runs.
 *
 * Reachability probe: permanently exempt. Every endpoint sits behind the
 * claude.ai login wall and there is no unauthenticated probe target.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { BrowserContext } from "playwright";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import {
	type BrowserCollectContext,
	buildFullScanCoverageMessage,
	type EnsureSessionArgs,
	nowIso,
	type ProbeSessionArgs,
	politeDelay,
	type RecordData,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	buildAccountPlanRecord,
	buildConversationRecord,
	buildMessageRecord,
	buildUsageLimitRecords,
	messageChangedAtMs,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
	RawConversation,
	RawMessage,
	RawOrganization,
	RawSubscriptionDetails,
} from "./types.ts";

const SESSION_COOKIE = /sessionKey|__Secure-next-auth.session-token/;
const CLAUDE_ORIGIN = "https://claude.ai";
const CLAUDE_HOME_URL = `${CLAUDE_ORIGIN}/new`;
export const ANTHROPIC_LIVE_LOGIN_MESSAGE =
	"Sign in to Claude in the secure browser. PDPP continues automatically when Claude confirms the session.";

const CONVERSATIONS_STREAM = "conversations";
const MESSAGES_STREAM = "messages";
const ACCOUNT_PLAN_STREAM = "account_plan";
const USAGE_LIMITS_STREAM = "usage_limits";

const LIST_PAGE_SIZE = 50;
const MAX_LIST_PAGES = 400;
export const MAX_CONVERSATIONS_PER_RUN = 200;
// Read per call so tests can shorten it (the repo's timeout-override
// convention; see connectors/anthropic/index.ts).
const detailDelayMs = () =>
	Number(process.env.PDPP_ANTHROPIC_LIVE_DETAIL_DELAY_MS) || 400;
const DETAIL_QUERY = "tree=True&rendering_mode=messages&render_all_tools=true";

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

/** Same probe as connectors/anthropic: a session cookie, else open sign-in. */
export async function probeAnthropicLiveSession({
	context,
	page,
}: ProbeSessionArgs): Promise<boolean> {
	if (await hasSessionCookie(context)) return true;
	await page.goto(CLAUDE_HOME_URL, { waitUntil: "domcontentloaded" });
	return false;
}

/**
 * Session probe for hosts with no browser context to read the HttpOnly
 * cookie from (PageShim): ask Claude's API from the claude.ai document.
 */
export async function probeAnthropicLiveSessionOnPage(
	page: Page,
): Promise<boolean> {
	if (!(await isOnClaude(page))) {
		await page.goto(CLAUDE_HOME_URL, { waitUntil: "domcontentloaded" });
	}
	const orgs = await apiGet(page, "/api/organizations");
	return orgs.status === 200 && Array.isArray(orgs.json);
}

async function isOnClaude(page: Page): Promise<boolean> {
	try {
		return (await page.evaluate(() => location.origin)) === "https://claude.ai";
	} catch {
		return false;
	}
}

async function hasSessionCookie(context: BrowserContext): Promise<boolean> {
	const cookies = await context.cookies(`${CLAUDE_ORIGIN}/`);
	return cookies.some(
		(cookie) => SESSION_COOKIE.test(cookie.name) && Boolean(cookie.value),
	);
}

export async function ensureAnthropicLiveSession({
	assist,
	capture,
	completeAssistance,
	context,
	page,
	sendInteraction,
}: Pick<
	EnsureSessionArgs,
	| "assist"
	| "capture"
	| "completeAssistance"
	| "context"
	| "page"
	| "sendInteraction"
>): Promise<void> {
	await manualBrowserLogin({
		assist,
		...(capture ? { capture } : {}),
		completeAssistance,
		isProbeSuccessful: (isLive: boolean) => isLive,
		message: ANTHROPIC_LIVE_LOGIN_MESSAGE,
		page,
		probe: () => probeAnthropicLiveSession({ context, page }),
		readinessProbe: () => hasSessionCookie(context),
		readinessProbeOnHandoffPage: true,
		sendInteraction,
		timeoutSeconds: 1800,
	});
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

interface ListedConversation {
	raw: RawConversation;
	id: string;
	updatedAt: string;
	updatedAtMs: number;
}

function listed(raw: unknown): ListedConversation | null {
	if (!isRecord(raw)) return null;
	const { uuid, updated_at: updatedAt } = raw;
	if (typeof uuid !== "string" || typeof updatedAt !== "string") return null;
	const updatedAtMs = Date.parse(updatedAt);
	if (!Number.isFinite(updatedAtMs)) return null;
	return { raw, id: uuid, updatedAt, updatedAtMs };
}

/**
 * Page the conversation list (newest change first) down to `floorMs` and
 * return the conversations changed after it, oldest change first. Throws on
 * any unreadable page: a partial list must not advance the cursor.
 */
async function listChangedConversations(
	ctx: Ctx,
	orgPath: string,
	floorMs: number,
): Promise<ListedConversation[]> {
	const changed: ListedConversation[] = [];
	for (let pageIndex = 0; pageIndex < MAX_LIST_PAGES; pageIndex++) {
		const offset = pageIndex * LIST_PAGE_SIZE;
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
		const items = res.json
			.map(listed)
			.filter((item): item is ListedConversation => item !== null);
		const fresh = items.filter((item) => item.updatedAtMs > floorMs);
		changed.push(...fresh);
		if (
			res.json.length < LIST_PAGE_SIZE ||
			fresh.length < items.length ||
			items.length === 0
		) {
			break;
		}
	}
	// The list can shift between pages while the owner is chatting.
	const unique = new Map(changed.map((item) => [item.id, item]));
	return [...unique.values()].sort((a, b) => a.updatedAtMs - b.updatedAtMs);
}

function messageRecords(
	detail: Record<string, unknown>,
	item: ListedConversation,
	emittedBeforeMs: number,
): { records: RecordData[]; total: number } {
	const raw = Array.isArray(detail.chat_messages)
		? detail.chat_messages.filter(isRecord)
		: [];
	const model =
		typeof detail.model === "string" && detail.model
			? detail.model
			: typeof item.raw.model === "string" && item.raw.model
				? item.raw.model
				: null;
	const records = (raw as RawMessage[])
		.filter((message) => messageChangedAtMs(message) > emittedBeforeMs)
		.sort(
			(a, b) =>
				(Date.parse(String(a.created_at)) || 0) -
				(Date.parse(String(b.created_at)) || 0),
		)
		.map((message) => buildMessageRecord(message, item.id, model))
		.filter((record): record is RecordData => record !== null);
	return { records, total: raw.length };
}

/**
 * conversations + messages. The cursor is `update_time`, the `updated_at` of
 * the last conversation fully read, with the `since` bound it was built under; `messages` checkpoints through it
 * (manifest `state_stream`). On an incremental run only messages newer than
 * the prior cursor are emitted, so a message keeps the model it was first
 * collected with.
 */
export async function runConversationStreams(
	ctx: Ctx,
	orgPath: string,
): Promise<void> {
	const wantsConversations = ctx.requested.has(CONVERSATIONS_STREAM);
	const wantsMessages = ctx.requested.has(MESSAGES_STREAM);
	const streams = [
		...(wantsConversations ? [CONVERSATIONS_STREAM] : []),
		...(wantsMessages ? [MESSAGES_STREAM] : []),
	];
	const since =
		ctx.requested.get(CONVERSATIONS_STREAM)?.time_range?.since ??
		ctx.requested.get(MESSAGES_STREAM)?.time_range?.since ??
		null;
	const sinceMs = since ? Date.parse(since) || 0 : 0;
	const prior = ctx.state[CONVERSATIONS_STREAM] as
		| { update_time?: unknown; since?: unknown }
		| undefined;
	// The cursor only covers history from the window it was built under. A
	// window that now starts earlier (or has no start) is read again from its
	// own start.
	const priorSince = typeof prior?.since === "string" ? prior.since : null;
	const widened =
		priorSince !== null &&
		(since === null || sinceMs < (Date.parse(priorSince) || 0));
	const priorCursor =
		ctx.collectionMode !== "full_refresh" &&
		!widened &&
		typeof prior?.update_time === "string"
			? prior.update_time
			: null;
	const cursorMs = priorCursor ? Date.parse(priorCursor) || 0 : 0;

	await ctx.progress("Listing conversations", {
		stream: wantsConversations ? CONVERSATIONS_STREAM : MESSAGES_STREAM,
	});
	const changed = await listChangedConversations(
		ctx,
		orgPath,
		Math.max(cursorMs, sinceMs),
	);
	// A full refresh ignores the cursor, so a cap would re-read the same
	// oldest conversations on every run.
	const batch =
		ctx.collectionMode === "full_refresh"
			? changed
			: changed.slice(0, MAX_CONVERSATIONS_PER_RUN);
	let cursor = priorCursor;
	let failure: { message: string; retryable: boolean } | null = null;

	for (const [index, item] of batch.entries()) {
		let messageCount: number | null = null;
		let messages: RecordData[] = [];
		if (wantsMessages) {
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
			// Deleted between the list and the detail read: nothing to collect.
			if (res.status === 404) continue;
			if (res.status !== 200 || !isRecord(res.json)) {
				failure = {
					message: `Claude conversation read failed with http ${res.status} after ${index} of ${batch.length}; the next run resumes there.`,
					retryable: res.status === 200 || isRetryableStatus(res.status),
				};
				break;
			}
			const built = messageRecords(res.json, item, cursorMs);
			messageCount = built.total;
			messages = built.records;
		}
		if (wantsConversations) {
			const record = buildConversationRecord(item.raw, messageCount);
			if (record) await ctx.emitRecord(CONVERSATIONS_STREAM, record);
		}
		for (const message of messages) {
			await ctx.emitRecord(MESSAGES_STREAM, message);
		}
		cursor = item.updatedAt;
		await ctx.emit({
			type: "STATE",
			stream: CONVERSATIONS_STREAM,
			cursor: { update_time: cursor, since },
		});
	}

	if (failure) {
		for (const stream of streams) {
			await ctx.reportStreamFailure?.(stream, failure.message, {
				retryable: failure.retryable,
			});
		}
		return;
	}
	if (changed.length > batch.length) {
		for (const stream of streams) {
			await skip(
				ctx,
				stream,
				"anthropic_live_backlog_deferred",
				`Read ${batch.length} of ${changed.length} changed conversations; the rest remain for the next run.`,
				true,
			);
		}
	}
	if (batch.length === 0) {
		await ctx.emit({
			type: "STATE",
			stream: CONVERSATIONS_STREAM,
			cursor: { update_time: cursor, since },
		});
	}
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
		await runConversationStreams(ctx, orgPath);
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
