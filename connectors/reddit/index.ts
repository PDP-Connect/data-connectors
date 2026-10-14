#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Reddit Connector (v0.2.0)
 *
 * Reddit's OAuth script-app password grant was retired in 2024, so this
 * connector collects via a logged-in browser session. All fetches happen
 * through `page.evaluate(fetch)` against `old.reddit.com/*.json` — the same
 * JSON the modern apps consume, served to the current session cookie.
 * old.reddit.com has been stable since 2018 and is the polyfill-friendliest
 * surface for personal data collection.
 *
 * Streams:
 *   submitted     /user/{u}/submitted.json   — link + self posts
 *   comments      /user/{u}/comments.json    — comments
 *   saved         /user/{u}/saved.json       — saved posts + comments (owner-only)
 *   upvoted       /user/{u}/upvoted.json     — posts/comments the owner upvoted (owner-only)
 *   downvoted     /user/{u}/downvoted.json   — posts/comments the owner downvoted (owner-only)
 *   hidden        /user/{u}/hidden.json      — posts the owner hid (owner-only)
 *
 * Content vs current metrics: the five listings that carry volatile source
 * counters also have a `<stream>_stats` stream — submitted_stats,
 * comments_stats, upvoted_stats, downvoted_stats, hidden_stats — keyed by the
 * SAME Reddit fullname as the content record. The content streams say what an
 * item is; the stats streams hold the latest score / num_comments /
 * upvote_ratio / gilded the source reported. One listing walk serves both
 * outputs; each output honors its own requested scope, so a score that moves
 * changes only the stats record; the content
 * record stays byte-identical. Nothing here persists a "skip unchanged"
 * fingerprint: every walked record is re-emitted each run and unchanged ones
 * rely on the resource server's identical-record no-op. `saved` carries no
 * counters and has no stats stream.
 *
 * The owner-only streams are the biggest reason to use a logged-in
 * connector over the public API — they capture preference signal
 * (upvoted/downvoted history) no third party can see.
 *
 * Pagination: opaque `after` cursor. Collection walks each requested listing
 * from the beginning on every run, because creation-time cursors cannot prove
 * that the stored content payload has the current schema. Fullnames provide
 * stable identity when an item appears again. A listing is bounded by its end
 * or MAX_PAGES; a capped walk emits deferred evidence and no checkpoint.
 *
 * Rate limit: Reddit's logged-in web JSON allows ~100 req/min before 429.
 * We page at limit=100 and use a conservative 500ms politeDelay between
 * pages.
 *
 * CHANGES
 *   manifest 0.4.0 (2026-10-14) — split volatile metrics out of the content
 *     streams into `<stream>_stats` streams (see above). Breaking for
 *     consumers: score/num_comments/upvote_ratio/gilded and their range
 *     filters moved off submitted/comments/upvoted/downvoted/hidden. Every
 *     requested output now refreshes the currently listed observations on
 *     each run; the connector does not persist a repair-complete marker.
 *   manifest 0.3.13 (2026-10-02) — removed the connector-stamped `fetched_at` from
 *     every record (PDPP spec-core: a producer must not put its own
 *     collection time in `data`; that is the envelope's `emitted_at`).
 *     No field took over `fetched_at`'s manifest `event-time` role:
 *     `created_utc` is the post/comment's own creation time, not the
 *     owner's save/upvote/hide moment, so tagging it `event-time` would
 *     misrepresent what these records are about. submitted/comments/saved/
 *     upvoted/downvoted/hidden already carry `title`/`body` as
 *     `primary-title`/`secondary`, so every stream still has a
 *     presentation-role field.
 *   v0.2.0 (2026-04-24) — extracted parsers.ts / schemas.ts / types.ts;
 *     added zod shape-check; added upvoted/downvoted/hidden streams;
 *     enriched records with domain, *_len, is_top_level, is_post,
 *     over_18, gilded, fetched_at.
 *   v0.1.0 — initial browser-session implementation.
 *
 * FIXTURES
 *   A committed records-stream pilot lives at
 *   fixtures/reddit/scrubbed/pilot-real-shape/records/<stream>.jsonl
 *   (synthetic-but-shape-real, PII-free). pilot-fixture.test.ts replays it
 *   through validateRecord to lock the emitted-record shape against drift.
 *   See docs/reference/connector-authoring-guide.md §9.1.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import {
	ensureRedditJsonOrigin,
	ensureRedditSession,
	isSessionLive,
	REDDIT_JSON_ORIGIN,
} from "../../packages/polyfill-connectors/src/auto-login/reddit.ts";
import {
	type BrowserCollectContext,
	type EmittedMessage,
	type EnsureSessionArgs,
	type NormalizeTerminalError,
	politeDelay,
	type RecordData,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { CaptureSession } from "../../packages/polyfill-connectors/src/fixture-capture.ts";
import { walkPagesWithCeiling } from "../../packages/polyfill-connectors/src/page-ceiling.ts";
import { createRepairBudget } from "../../packages/polyfill-connectors/src/repair-budget.ts";
import { validateRecord } from "./schemas.ts";
import {
	appendNewChildren,
	classifyListingStatus,
	commentRecord,
	commentStatsRecord,
	dedupeByFullname,
	MAX_PAGES,
	nextAfter,
	pagePath,
	type RedditListingOrder,
	savedRecord,
	submittedRecord,
	submittedStatsRecord,
	voteRecord,
	voteStatsRecord,
} from "./parsers.ts";
import type { RedditChild, RedditFetchResult, RedditListing } from "./types.ts";

const USER_AGENT = "pdpp-reddit-connector/0.2 (polyfill; +https://pdpp.dev)";
const PAGE_DELAY_MS = 500;
/**
 * Exported (not just inline in `runConnector`) so a regression test can
 * assert every post-submit throw `src/auto-login/reddit.ts` can produce
 * fails to match this exact pattern — the same object the scheduler
 * classifier actually consults, not a duplicated literal that could drift.
 * Post-submit safety no longer depends on this pattern's vocabulary:
 * `redditEnsureSession` wires `onCredentialSubmit`, so any fault after the
 * password click is forced non-retryable by the runtime regardless of what
 * this matches. The non-collision tests over this pattern remain as
 * defense-in-depth for the literals Reddit throws, and the pattern still
 * fully owns PRE-submit and collect-phase retry classification.
 */
export const REDDIT_RETRYABLE_PATTERN =
	/ECONN|ETIMEDOUT|fetch failed|reddit_rate_limited/i;

const REDDIT_TERMINAL_DIAGNOSTIC_MAX = 240;
const REDDIT_AUTH_FAILURE_RE =
	/\breddit_auth_failed\b|\b(?:401|403)\b|\b(?:unauthorized|forbidden)\b/iu;
const REDDIT_MANUAL_ACTION_RE =
	/(?:^|[^A-Za-z0-9_])(?:reddit_login_manual_incomplete|reddit_login_unexpected_ui|reddit_login_submit_missing|reddit_2fa_cancelled|reddit_login_post_submit_failed|cloudflare|captcha|manual_action)(?:$|[^A-Za-z0-9_])/iu;

function scrubRedditTerminalDiagnostic(message: string): string {
	return message
		.replace(/\/user\/[^/?\s]+/giu, "/user/[redacted]")
		.replace(/https?:\/\/\S+/giu, "[redacted-url]")
		.replace(/([?&](?:after|cursor|id|query)=)[^&\s)"'<>]*/giu, "$1[redacted]")
		.replace(
			/(\b(?:after|cursor|id|query)\b\s*[:=]\s*)["']?[^,;\s}"')]+/giu,
			"$1[redacted]",
		)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, REDDIT_TERMINAL_DIAGNOSTIC_MAX);
}

/**
 * Keep Reddit's browser-session failures actionable without exposing the
 * account name embedded in a listing endpoint. Auth and login challenges are
 * durable owner actions; rate limits remain retryable and must not be turned
 * into a false reconnect request.
 */
export const normalizeRedditTerminalError: NormalizeTerminalError = ({
	message,
	retryable,
}) => {
	const diagnostic = scrubRedditTerminalDiagnostic(message);
	if (REDDIT_AUTH_FAILURE_RE.test(message)) {
		return {
			message: `reddit_preprogress_failure: refresh_credentials: ${diagnostic}`,
			recovery_hint: "refresh_credentials",
			retryable: false,
		};
	}
	if (REDDIT_MANUAL_ACTION_RE.test(message)) {
		return {
			message: `reddit_preprogress_failure: manual_action_required: ${diagnostic}`,
			recovery_hint: "manual_action_required",
			retryable: false,
		};
	}
	return {
		message: `reddit_preprogress_failure: runtime_exception: ${diagnostic}`,
		...(retryable ? {} : { recovery_hint: "retry_on_connector_upgrade" }),
		retryable,
	};
};

interface ProgressExtra {
	cursor_present?: boolean;
	item_count?: number;
	page_index?: number;
	phase?: string;
	rate_limit_pressure?: number;
	stream?: string;
	total_seen?: number;
}

// ─── Fetch through the page (preserves session cookie + anti-bot) ───────

/**
 * Every listing fetch is issued from the page, and Reddit grants NO
 * cross-origin access to its listing JSON — so the page must already be on
 * {@link REDDIT_JSON_ORIGIN} or the browser blocks the request before it
 * reaches the network, surfacing as `TypeError: Failed to fetch` (mapped to
 * `status: 0` below, then to `reddit_http_0`).
 *
 * `ensureSession` normally leaves the page on the right origin, but collect
 * runs after an arbitrary amount of navigation and the reauth path can move it
 * again, so this does not assume — it re-establishes the origin on the first
 * fetch and then no-ops (a URL check, no navigation) for every page after it.
 * This is the same defect that broke the liveness probe in
 * `run_1787164349370`; see `src/auto-login/reddit.ts`'s REDDIT_JSON_ORIGIN.
 */
async function redditFetch(
	page: Page,
	path: string,
): Promise<RedditFetchResult> {
	if (!(await ensureRedditJsonOrigin(page))) {
		// Reported as a transport-shaped failure so the existing retry
		// classification handles it, rather than a bare throw from collect.
		return {
			status: 0,
			json: { error: "reddit_json_origin_unavailable" } as never,
		};
	}
	return (await page.evaluate(
		async ({ origin, path: evalPath, userAgent }) => {
			try {
				const res = await fetch(`${origin}${evalPath}`, {
					credentials: "include",
					headers: {
						accept: "application/json",
						"user-agent": userAgent,
					},
				});
				const { status } = res;
				let json: unknown = null;
				try {
					json = await res.json();
				} catch {
					json = null;
				}
				return { status, json };
			} catch (err) {
				return { status: 0, json: { error: String(err) } };
			}
		},
		{ origin: REDDIT_JSON_ORIGIN, path, userAgent: USER_AGENT },
	)) as RedditFetchResult;
}

function assertListingOk(status: number, endpoint: string): void {
	const klass = classifyListingStatus(status);
	if (klass === "auth_failed") {
		throw new Error(`reddit_auth_failed: ${status} on ${endpoint}`);
	}
	if (klass === "rate_limited") {
		throw new Error(`reddit_rate_limited: 429 on ${endpoint}`);
	}
	if (klass === "http_error") {
		throw new Error(`reddit_http_${status}: ${endpoint}`);
	}
}

type ValidRedditListing = RedditListing & {
	data: {
		after?: string | null;
		children: RedditChild[];
	};
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRedditChild(value: unknown): value is RedditChild {
	return (
		isRecord(value) && typeof value.kind === "string" && isRecord(value.data)
	);
}

function assertListingEnvelope(
	status: number,
	json: RedditListing | null,
	endpoint: string,
): asserts json is ValidRedditListing {
	assertListingOk(status, endpoint);
	if (!(isRecord(json) && isRecord(json.data))) {
		throw new Error(
			`reddit_parse_error: invalid listing envelope on ${endpoint}`,
		);
	}
	const { data } = json;
	if (!Array.isArray(data.children)) {
		throw new Error(
			`reddit_parse_error: invalid listing envelope on ${endpoint}`,
		);
	}
	if (!data.children.every(isRedditChild)) {
		throw new Error(
			`reddit_parse_error: invalid listing child array on ${endpoint}`,
		);
	}
	const { after } = data;
	if (after !== undefined && after !== null && typeof after !== "string") {
		throw new Error(
			`reddit_parse_error: invalid listing cursor on ${endpoint}`,
		);
	}
}

/**
 * Paginate a Reddit listing. Newest-first, opaque `after` cursor. Stops
 * at an empty page, the end cursor, or the page cap. The optional creation
 * cursor is retained for parser-level compatibility; collection passes null
 * so every requested observation is revisited. The fetch function is injected
 * so integration tests can run this against a fake listing server
 * without a browser.
 */
export type RedditListingFetch = (path: string) => Promise<RedditFetchResult>;

export interface RedditPaginationResult {
	children: RedditChild[];
	/** True only when MAX_PAGES stopped a walk that still had an `after` cursor. */
	truncated: boolean;
}

/**
 * Re-run the connector's existing session-establishment flow
 * (`ensureRedditSession`) and report whether the session is live afterward.
 * `ensureRedditSession` already no-ops when the current cookie is live, so
 * calling it speculatively mid-run is safe — it only does login work when
 * the cookie is actually gone or stale.
 */
export type RedditReauthFn = () => Promise<boolean>;

async function fetchListingPage(
	fetchPath: RedditListingFetch,
	path: string,
	onAuthFailed: RedditReauthFn | undefined,
	repairBudget: ReturnType<typeof createRepairBudget>,
): Promise<RedditFetchResult> {
	const result = await fetchPath(path);
	const klass = classifyListingStatus(result.status);
	if (klass !== "auth_failed" || !onAuthFailed) {
		return result;
	}
	// A 401/403 after this run's session was already live at least once
	// (ensureSession succeeded, prior pages in this stream/run succeeded) is
	// far more often a rotated/expired session cookie than a genuinely dead
	// login — re-establish the session ONCE PER RUN and retry this exact
	// request. `repairBudget` is shared across every stream `collectAllStreams`
	// iterates (submitted/comments/saved/upvoted/downvoted/hidden) — without
	// that sharing, a budget scoped to a single `paginate()` call resets for
	// each stream and a session dead at run start drives one automated login
	// per stream instead of one per run. A second 401/403 (session repair
	// failed, or the fresh session still gets rejected, or the budget is
	// already spent) falls through to the real reddit_auth_failed below
	// rather than looping or re-spending.
	if (!repairBudget.tryConsume()) {
		return result;
	}
	const recovered = await onAuthFailed();
	if (!recovered) {
		return result;
	}
	return fetchPath(path);
}

export async function paginate(
	fetchPath: RedditListingFetch,
	endpoint: string,
	sinceEpochUtc: number | null,
	capture: CaptureSession | null,
	delay: (ms: number) => Promise<void> = politeDelay,
	progress?: (message: string, extra?: ProgressExtra) => Promise<void>,
	streamName?: string,
	onAuthFailed?: RedditReauthFn,
	repairBudget: ReturnType<typeof createRepairBudget> = createRepairBudget(),
	order: RedditListingOrder = "created",
): Promise<RedditPaginationResult> {
	const all: RedditChild[] = [];
	let after: string | null = null;
	const streamExtra = streamName ? { stream: streamName } : {};

	const walk = await walkPagesWithCeiling({
		maxPages: MAX_PAGES,
		fetchPage: async (pageNumber) => {
			const pageIndex = pageNumber - 1;
			await progress?.("Fetching Reddit listing page", {
				...streamExtra,
				phase: "fetch",
				page_index: pageIndex,
				total_seen: all.length,
				cursor_present: Boolean(after),
			});
			const path = pagePath(endpoint, after);
			const { status, json } = await fetchListingPage(
				fetchPath,
				path,
				onAuthFailed,
				repairBudget,
			);
			if (status === 429) {
				await progress?.("Reddit listing page rate limited", {
					...streamExtra,
					phase: "rate_limit",
					page_index: pageIndex,
					total_seen: all.length,
					cursor_present: Boolean(after),
					rate_limit_pressure: 1,
				});
			}
			assertListingEnvelope(status, json, endpoint);

			capture?.captureHttp(
				`page-${String(pageIndex).padStart(3, "0")}-${endpoint.replaceAll("/", "_")}`,
				json,
				{
					status,
					path,
					endpoint,
				},
			);

			const { children } = json.data;
			await progress?.("Fetched Reddit listing page", {
				...streamExtra,
				phase: "page",
				page_index: pageNumber,
				item_count: children.length,
				total_seen: all.length + children.length,
				cursor_present: Boolean(nextAfter(json)),
			});
			if (children.length === 0) {
				return false;
			}
			if (appendNewChildren(children, sinceEpochUtc, all, order)) {
				return false;
			}

			after = nextAfter(json);
			if (!after) {
				return false;
			}
			await delay(PAGE_DELAY_MS);
			return true;
		},
	});

	// `action`-ordered listings can repeat an item within one walk when Reddit
	// shifts items between pages. Dedupe those by fullname before emission.
	return {
		// Normal breaks mean the listing ended or supplied no continuation cursor.
		children: order === "action" ? dedupeByFullname(all) : all,
		truncated: walk.truncated,
	};
}

// ─── Stream runner ──────────────────────────────────────────────────────

/** One output (RECORD stream) derived from a provider listing. */
export interface RedditOutputConfig {
	name: string;
	toRecord: (c: RedditChild) => RecordData;
}

/** Declarative description of one provider listing and the outputs derived
 *  from it: the content stream (`name`/`toRecord`) and, when the listing
 *  carries volatile counters, its current-stats stream. Retrieval policy
 *  (endpoint, order, what to walk) belongs to the listing; mapping and scope
 *  belong to each output. Exported so integration
 *  tests can reuse the same table the runtime uses. */
export interface RedditStreamConfig {
	endpoint: string;
	/** Content stream name. */
	name: string;
	/** How Reddit sorts this listing. Drives the pagination stop rule — see
	 *  {@link RedditListingOrder}. Omitted means `created` (authorship
	 *  timeline), the only ordering for which an early stop is sound. */
	order?: RedditListingOrder;
	progressMessage: string;
	/** Current-metrics stream over the same listing, keyed by the same
	 *  fullname. Absent when the listing carries no volatile counters. */
	stats?: RedditOutputConfig;
	toRecord: (c: RedditChild) => RecordData;
}

/** The slice of a runtime `StreamScope` this connector reads. */
export interface RedditOutputScope {
	resources?: readonly string[];
	time_range?: { since?: string; until?: string };
}

export interface CollectStreamArgs {
	capture: CaptureSession | null;
	/** Retained for compatibility with the connector runtime; Reddit always
	 *  reads its current listing in full. */
	collectionMode?: "full_refresh" | "incremental";
	/** Pacing delay between pages. Defaults to politeDelay(500ms). Tests
	 *  inject a no-op so they don't sleep. */
	delay?: (ms: number) => Promise<void>;
	emit: (msg: EmittedMessage) => Promise<void>;
	emitRecord: (stream: string, data: RecordData) => Promise<void>;
	fetchPath: RedditListingFetch;
	/** Re-establish the session once on a mid-stream 401/403. Absent in tests
	 *  that don't exercise the repair path — a 401/403 then fails immediately,
	 *  matching pre-fix behavior. */
	onAuthFailed?: RedditReauthFn;
	progress: (message: string, extra?: ProgressExtra) => Promise<void>;
	/** RUN-scoped budget for `onAuthFailed` spends, shared by the caller across
	 *  every stream in this run. Defaults to a fresh one-shot budget so direct
	 *  callers (tests) that don't pass one keep today's per-call ceiling of 1. */
	repairBudget?: ReturnType<typeof createRepairBudget>;
	/** Streams (content and/or stats) this run was asked for, with their scope.
	 *  Omitted means the content stream alone, unscoped. An output that is not
	 *  here emits nothing: no RECORD, STATE, SKIP_RESULT. */
	requested?: ReadonlyMap<string, RedditOutputScope>;
	state: Record<string, unknown>;
	stream: RedditStreamConfig;
}

interface OutputResult {
	considered: number;
}

interface CollectStreamResult {
	/** Null when that output was not requested. */
	content: OutputResult | null;
	stats: OutputResult | null;
}

/**
 * Emit one output's records. Every walked record is emitted; whether a record
 * is a no-op is the resource server's identical-record check, not a cache kept
 * here. `considered` is measured before runtime scope selection and schema
 * validation; it does not claim that the host accepted or stored each record.
 */
async function emitOutput(
	emitRecord: CollectStreamArgs["emitRecord"],
	output: RedditOutputConfig,
	items: readonly RedditChild[],
): Promise<OutputResult> {
	for (const c of items) {
		await emitRecord(output.name, output.toRecord(c));
	}
	return { considered: items.length };
}

async function emitDeferredPages(
	emit: CollectStreamArgs["emit"],
	stream: string,
	totalSeen: number,
): Promise<void> {
	// Reddit does not expose a total page count. One synthetic considered unit
	// is the honest lower bound for the unread tail: the next page exists, but
	// this run deliberately did not fetch it. The deferred suffix keeps the
	// stream out of `complete` without inventing an item count.
	await emit({
		type: "SKIP_RESULT",
		stream,
		reason: "older_pages_deferred_page_budget",
		message: `Reddit ${stream} stopped at the ${MAX_PAGES}-page limit with more pages still listed`,
		diagnostics: {
			page_limit: MAX_PAGES,
			total_seen: totalSeen,
			unread_pages: 1,
		},
	});
}

export async function collectStream(
	args: CollectStreamArgs,
): Promise<CollectStreamResult> {
	const {
		capture,
		delay,
		emit,
		emitRecord,
		fetchPath,
		onAuthFailed,
		progress,
		repairBudget,
		stream,
	} = args;
	const requested =
		args.requested ?? new Map<string, RedditOutputScope>([[stream.name, {}]]);
	const contentScope = requested.get(stream.name);
	const statsOutput = stream.stats;
	const statsScope = statsOutput ? requested.get(statsOutput.name) : undefined;
	if (!(contentScope || statsScope)) {
		return { content: null, stats: null };
	}
	const order = stream.order ?? "created";
	const progressName = contentScope ? stream.name : (statsOutput?.name ?? "");
	await progress(stream.progressMessage, { stream: progressName });

	// Every requested output walks the full listing. A creation-time cursor cannot
	// prove that stored payloads match the current schema.
	const { children, truncated } = await paginate(
		fetchPath,
		stream.endpoint,
		null,
		capture,
		delay,
		progress,
		progressName,
		onAuthFailed,
		repairBudget,
		order,
	);

	let content: OutputResult | null = null;
	if (contentScope) {
		const items = children;
		content = await emitOutput(emitRecord, stream, items);
		// Counts are offered to runtime selection and validation, before either runs.
		await progress("Offered Reddit stream records", {
			stream: stream.name,
			phase: "emit",
			item_count: items.length,
			total_seen: items.length,
			cursor_present: false,
		});
		if (truncated) {
			await emitDeferredPages(emit, stream.name, items.length);
		}
	}

	let stats: OutputResult | null = null;
	if (statsOutput && statsScope) {
		stats = await emitOutput(emitRecord, statsOutput, children);
		await progress("Offered Reddit stats records", {
			stream: statsOutput.name,
			phase: "emit",
			item_count: children.length,
			total_seen: children.length,
		});
		if (truncated) {
			await emitDeferredPages(emit, statsOutput.name, children.length);
		}
	}

	return { content, stats };
}

/** Build the list of streams this connector can populate, bound to a
 *  particular user path and emit timestamp. Exported for tests. */
export function buildStreamTable(
	userPath: string,
	emittedAt: string,
): RedditStreamConfig[] {
	return [
		{
			name: "submitted",
			endpoint: `${userPath}/submitted.json`,
			progressMessage: "Fetching submissions",
			toRecord: (c) => submittedRecord(c.data, emittedAt),
			stats: {
				name: "submitted_stats",
				toRecord: (c) => submittedStatsRecord(c.data),
			},
		},
		{
			name: "comments",
			endpoint: `${userPath}/comments.json`,
			progressMessage: "Fetching comments",
			toRecord: (c) => commentRecord(c.data, emittedAt),
			stats: {
				name: "comments_stats",
				toRecord: (c) => commentStatsRecord(c.data),
			},
		},
		// The four streams below are ordered by OWNER ACTION time, not by the
		// item's `created_utc` — acting on an old item puts an old `created_utc`
		// at the top of the listing. They must walk the full listing and dedupe;
		// see `RedditListingOrder`.
		{
			name: "saved",
			endpoint: `${userPath}/saved.json`,
			order: "action",
			progressMessage: "Fetching saved items",
			toRecord: (c) => savedRecord(c, emittedAt),
		},
		{
			name: "upvoted",
			endpoint: `${userPath}/upvoted.json`,
			order: "action",
			progressMessage: "Fetching upvoted items",
			toRecord: (c) => voteRecord(c, emittedAt),
			stats: {
				name: "upvoted_stats",
				toRecord: (c) => voteStatsRecord(c),
			},
		},
		{
			name: "downvoted",
			endpoint: `${userPath}/downvoted.json`,
			order: "action",
			progressMessage: "Fetching downvoted items",
			toRecord: (c) => voteRecord(c, emittedAt),
			stats: {
				name: "downvoted_stats",
				toRecord: (c) => voteStatsRecord(c),
			},
		},
		{
			name: "hidden",
			endpoint: `${userPath}/hidden.json`,
			order: "action",
			progressMessage: "Fetching hidden items",
			toRecord: (c) => voteRecord(c, emittedAt),
			stats: {
				name: "hidden_stats",
				toRecord: (c) => voteStatsRecord(c),
			},
		},
	];
}

/** Build a RedditListingFetch bound to a Playwright page. Extracted
 *  so tests can substitute a non-browser fetch.
 *
 *  Exported so `redditFetch`'s origin guard is directly testable: reaching it
 *  only through `collectAllStreams` means every listing/parsing fixture has to
 *  model navigation, which would bury the one behavior under test. */
export function makePageFetch(page: Page): RedditListingFetch {
	return (path) => redditFetch(page, path);
}

// ─── Exported collect for testing ────────────────────────────────────────

/**
 * Build the mid-run reauth hook bound to a live browser context. Delegates
 * to `ensureRedditSession` — the same session-establishment flow already run
 * once at connector start — which no-ops when the cookie is still live, so
 * this is safe to invoke speculatively on a 401/403 rather than only at
 * startup.
 *
 * Gated strictly on `REDDIT_USERNAME`/`REDDIT_PASSWORD` being present in
 * `process.env`, mirroring the Amazon connector's
 * `attemptAutomatedSessionRepair`. Without both, `ensureRedditSession` falls
 * through to `ensureRedditManualSession` — an interactive owner hand-off
 * that can block up to 30 minutes and consume an OTP interaction slot. That
 * path is only safe at run start (`ensureSession`, before any owner-facing
 * timeout budget is in flight); triggering it speculatively mid-collect on a
 * background 401/403 is not. Note this checks `process.env` directly, not
 * `ctx.credentials` — a run whose credentials arrived via the interactive
 * `sendInteraction` prompt (rather than sealed-secret env injection) has a
 * populated `credentials` object but empty `process.env`, and must still be
 * refused here.
 *
 * `ensureRedditSession` never returns without either the session already
 * being probed live or throwing, so a bare "didn't throw" is already backed
 * by a probe internally — but that's an implementation detail of a function
 * this hook doesn't own. Re-probing explicitly with `isSessionLive` here is
 * cheap (one navigation, already-loaded page) and makes the truth this hook
 * reports self-contained rather than borrowed: if `ensureRedditSession`'s
 * internal contract ever changes, this still reports the real session state
 * instead of silently trusting a function that returned without error.
 *
 * Exported (in addition to being wired into `collectAllStreams`) so the
 * env-credential gate is directly unit-testable without needing a
 * Playwright-shaped `context`/`page` that would otherwise mask the gate
 * behind an unrelated thrown error from a stub object.
 */
export function makeReauth(ctx: BrowserCollectContext): RedditReauthFn {
	return async () => {
		if (!(process.env.REDDIT_USERNAME && process.env.REDDIT_PASSWORD)) {
			return false;
		}
		try {
			await ensureRedditSession({
				capture: ctx.capture,
				context: ctx.context,
				page: ctx.page,
				sendInteraction: ctx.sendInteraction,
			});
			return await isSessionLive(ctx.page);
		} catch {
			return false;
		}
	};
}

export async function collectAllStreams(
	ctx: BrowserCollectContext,
	options: { delay?: (ms: number) => Promise<void> } = {},
): Promise<void> {
	const {
		capture,
		collectionMode,
		credentials,
		emit,
		emitRecord,
		emittedAt,
		page,
		progress,
		requested,
		state,
	} = ctx;

	const user = credentials.REDDIT_USERNAME;
	if (!user) {
		throw new Error("reddit_auth_failed: REDDIT_USERNAME missing");
	}
	const userPath = `/user/${encodeURIComponent(user)}`;
	const fetchPath = makePageFetch(page);
	const onAuthFailed = makeReauth(ctx);
	// Shared across every stream below — see the repair-budget note on
	// `fetchListingPage` for why a per-stream budget (created inside
	// `paginate`) undercounts a run's actual credentialed-login exposure.
	const repairBudget = createRepairBudget();

	for (const stream of buildStreamTable(userPath, emittedAt)) {
		await collectStream({
			stream,
			fetchPath,
			state,
			emit,
			emitRecord,
			progress,
			onAuthFailed,
			repairBudget,
			capture,
			requested,
			...(collectionMode ? { collectionMode } : {}),
			...(options.delay ? { delay: options.delay } : {}),
		});
	}
}

// ─── Entry ──────────────────────────────────────────────────────────────

/**
 * The production `ensureSession` hook. Exported (rather than inlined in the
 * `runConnector` config below) so the `onCredentialSubmit` forwarding is
 * itself under test: `src/auto-login/reddit.test.ts` drives the runtime's
 * real `establishSession` through this exact function and proves a
 * post-submit fault comes out non-retryable even when its message matches
 * `REDDIT_RETRYABLE_PATTERN`. An inline closure here would leave the
 * forwarding unreachable by any test (the `isMainModule` guard).
 */
export async function redditEnsureSession({
	assist,
	capture,
	checkpoint,
	completeAssistance,
	context,
	onCredentialSubmit,
	page,
	sendInteraction,
}: EnsureSessionArgs): Promise<void> {
	// Forwarding `checkpoint` is the point of production run_1787109028586's
	// fix: without it the watchdog's no-progress message could only name the
	// runtime's own `session-establish:begin`, so a 120s stall inside the
	// first liveness probe was indistinguishable from a stall anywhere else in
	// session establishment.
	//
	// Forwarding `assist`/`completeAssistance` lets the captcha/blocked-login
	// manual handoffs self-resolve (see `ensureRedditSession`'s
	// `manualHandoffArgs`) instead of always requiring the owner's manual
	// "Continue collection" click.
	await ensureRedditSession({
		assist,
		capture,
		checkpoint,
		completeAssistance,
		context,
		onCredentialSubmit,
		page,
		sendInteraction,
	});
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "reddit",
		validateRecord,
		retryablePattern: REDDIT_RETRYABLE_PATTERN,
		auth: { kind: "env", required: ["REDDIT_USERNAME", "REDDIT_PASSWORD"] },
		browser: { profileName: "reddit" },
		ensureSession: redditEnsureSession,
		async collect(ctx: BrowserCollectContext): Promise<void> {
			await collectAllStreams(ctx);
		},
	});
}
