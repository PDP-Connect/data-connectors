#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP GitHub Connector (v0.2.1)
 *
 * Auth: Personal Access Token via GITHUB_PERSONAL_ACCESS_TOKEN env var.
 * Create at https://github.com/settings/tokens (fine-grained or classic).
 * Minimum scopes: read:user, public_repo (for public), repo (for private),
 *   gist (for gists), read:org (for organizations). `events`, `contributions`,
 *   and `pinned_repositories` need no extra scope beyond `read:user`.
 *
 * Streams: user, user_stats, repositories, starred, issues, pull_requests,
 * gists, events, contributions, pinned_repositories, organizations.
 * Incremental:
 *   - repositories via `since` + updated_at (by pushed_at)
 *   - starred via starred_at
 *   - issues via `since` + updated_at
 *   - pull_requests via updated_at (search ordered desc)
 *   - gists via `since` + updated_at
 *   - events via created_at (emit-side skip; the Events API has no `since`
 *     param). Provider-side 90-day rolling window: history older than that
 *     is genuinely unavailable, not a connector gap.
 *   - contributions via date (daily counts, GraphQL `contributionsCollection`)
 *   - pinned_repositories, organizations: no cursor. Both are small
 *     (pins capped at 6 by GitHub; org membership lists are typically small)
 *     current-state lists, fully re-fetched every run.
 *
 * Rate limit: 5000 req/hr (authenticated). We paginate 100 per page.
 * Rate-limit responses are retried through the shared governor; exhaustion keeps
 * the observed GitHub HTTP status and is surfaced as a retryable DONE failure.
 * `contributions` and `pinned_repositories` use the GraphQL v4 endpoint
 * (`/graphql`) instead of REST; both share the same governor and primary
 * rate-limit bucket as every REST call.
 *
 * `user.achievements` (nullable): no REST or GraphQL field exists for GitHub
 * achievement badges. Ported from legacy
 * `connectors/github/github-playwright.js:309-316`'s DOM scrape of the public
 * profile page (`.js-achievement-card img` / `a[href*="/achievements/"]
 * img`). One bounded, unauthenticated GET of `https://github.com/{login}` per
 * run (`fetchProfileAchievements`), outside the REST governor (different host,
 * no auth). `null` when that fetch fails or returns a non-2xx status; `[]`
 * when the page was read and has zero badges — the two are deliberately
 * distinguished, never conflated.
 *
 * CHANGES
 *   v0.2.1 (2026-09-22) — added `user.achievements` (see above); no other
 *     field on `user`/`repositories`/`starred` changed.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import {
	buildCollectionRateProgress,
	buildPacingStateFields,
	type ConnectorHttpGovernor,
	createConnectorHttpGovernor,
	readPersistedPacingInterval,
} from "../../packages/polyfill-connectors/src/connector-http-governor.ts";
import {
	buildDetailCoverageMessage,
	createConnectorFailure,
	type EmittedMessage,
	nowIso,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import { RetryBudget } from "../../packages/polyfill-connectors/src/provider-budget.ts";
import { githubPacingProfile } from "../../packages/polyfill-connectors/src/provider-profile.ts";
import {
	API_BASE as BASE,
	contributionDayRecord,
	eventRecord,
	flattenContributionDays,
	flattenPinnedRepositories,
	gistRecord,
	isAtOrAfterUntil,
	isBeforeSince,
	issueRecord,
	laterIso,
	organizationRecord,
	parseAchievementsHtml,
	parseNextLink,
	pinnedRepositoryRecord,
	pullRequestRecord,
	repoFullFromUrl,
	repoRecord,
	starredRecord,
	userRecord,
	userStatsRecord,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
	GhFetchOptions,
	GhResult,
	GitHubAchievement,
	GitHubEvent,
	GitHubGist,
	GitHubGraphQlResponse,
	GitHubIssue,
	GitHubOrgMembership,
	GitHubPullDetail,
	GitHubRepo,
	GitHubSearchResponse,
	GitHubStarredEntry,
	GitHubUser,
} from "./types.ts";

const USER_AGENT = "pdpp-connector-github/0.1";

// Single per-run provider send governor + retry layer. The factory yields the
// shared ADAPTIVE rate controller by default: slow-start discovery → AIMD
// accelerate-under-success → ceiling-bounded back-off, all automatic (Phase A
// collection-governor generalization). A run-shared retry budget enables real
// Retry-After retries without multiplying requests across every PR detail.
//
// The run owns this governor so its pacing, retry budget, and injected test
// effects cannot leak across concurrent collections. Warm-start restoration
// still reads the prior run's learned interval from durable state and seeds the
// same single governor before collection begins. The rate is persisted back onto
// the real `user` stream cursor at run end (see `collectUser`).
// §3 ProviderProfile: github declares its own AUDITED pacing ceiling (1000ms ≈
// 60 req/min, ~72% of the 5000/hr primary limit; WI-1b). NOT a borrow of
// ChatGPT's 250ms. See src/provider-profile.ts → githubPacingProfile and
// docs/research/per-connector-rate-profiles-2026-06-13.md for the derivation.

interface GithubHttpGovernorOptions {
	now?: () => number;
	restoredIntervalMs?: number;
	retrySleep?: (ms: number) => void | Promise<void>;
	sleep?: (ms: number) => void | Promise<void>;
}

export function createGithubHttpGovernor(
	options: GithubHttpGovernorOptions = {},
): ConnectorHttpGovernor {
	return createConnectorHttpGovernor({
		baseDelayMs: 60_000,
		maxDelayMs: 15 * 60_000,
		// GitHub's Retry-After/reset values are server-directed waits. The 15-minute
		// cap applies only to our exponential fallback, not an explicit server wait.
		maxRetryAfterMs: Number.POSITIVE_INFINITY,
		name: "github",
		maxAttempts: 4,
		profile: githubPacingProfile(),
		retryBudget: new RetryBudget({
			capacity: 8,
			// Three retry tokens make the four-attempt envelope reachable on a
			// cold request while the shared budget still bounds run-wide retry volume.
			initialTokens: 3,
			refillPerSuccess: 0.25,
		}),
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.retrySleep === undefined
			? {}
			: { retrySleep: options.retrySleep }),
		...(options.sleep === undefined ? {} : { sleep: options.sleep }),
		...(options.restoredIntervalMs === undefined
			? {}
			: { restoredIntervalMs: options.restoredIntervalMs }),
	});
}

const DEFAULT_GITHUB_MAX_LIST_PAGES = 200;
let maxGithubListPages = DEFAULT_GITHUB_MAX_LIST_PAGES;

/** Runtime retry classification, including the governor's exhausted 5xx form. */
export const GITHUB_RETRYABLE_PATTERN =
	/github_malformed_response|rate(?:_| )limit(?:ed)?|ECONN|fetch failed|retryable status \d+/i;

/** Test-only cap injection; production keeps the bounded default. */
export function __setMaxGithubListPages(maxPages: number): void {
	if (!Number.isInteger(maxPages) || maxPages <= 0) {
		throw new Error("github_pagination_invalid_max_pages");
	}
	maxGithubListPages = maxPages;
}

/**
 * Re-seed the run governor warm-started from the prior run's learned rate,
 * read off the `user` stream cursor where the previous run persisted it (see
 * `collectUser`). A stale or absent value cold-starts at the discovery seed.
 */
function restoreGithubPacing(
	state: Record<string, unknown>,
): ConnectorHttpGovernor {
	const userCursor = state.user as Record<string, unknown> | undefined;
	const restoredIntervalMs = readPersistedPacingInterval(userCursor);
	return createGithubHttpGovernor(
		restoredIntervalMs === null ? {} : { restoredIntervalMs },
	);
}

interface ProgressExtra {
	count?: number;
	cursor_present?: boolean;
	item_count?: number;
	page_index?: number;
	phase?: string;
	rate_limit_pressure?: number;
	stream?: string;
	total?: number;
	total_seen?: number;
}

interface GhRawResponse {
	body: string;
	link: string | null;
	rateLimited: boolean;
	retryAfter?: string;
	status: number;
}

function isGithubBadCredentials(
	response: Pick<GhRawResponse, "body" | "status">,
): boolean {
	return (
		response.status === 401 ||
		(response.status === 403 && /\bbad credentials\b/i.test(response.body))
	);
}

function isGithubRateLimited(
	response: Pick<GhRawResponse, "body" | "status">,
	remaining: string | null,
	retryAfter: string | null,
): boolean {
	return (
		response.status === 429 ||
		(response.status === 403 &&
			!isGithubBadCredentials(response) &&
			(remaining === "0" ||
				retryAfter !== null ||
				/\bsecondary rate limit\b/i.test(response.body)))
	);
}

function githubRetryAfter(
	status: number,
	remaining: string | null,
	retryAfter: string | null,
	reset: string | null,
): string | undefined {
	if (retryAfter !== null) {
		return retryAfter;
	}
	// x-ratelimit-reset is authoritative only when the quota signal says the
	// primary bucket is empty. A secondary 403 with no Retry-After must use the
	// exponential fallback instead of waiting for an unrelated reset timestamp.
	if (status !== 429 && remaining !== "0") {
		return undefined;
	}
	if (reset === null || reset.trim() === "") {
		return undefined;
	}
	const resetSeconds = Number(reset);
	if (!Number.isFinite(resetSeconds)) {
		return undefined;
	}
	return String(Math.max(0, Math.ceil(resetSeconds - Date.now() / 1000)));
}

async function gh<T>(
	ctx: StreamCtx,
	path: string,
	{ accept = "application/vnd.github+json" }: GhFetchOptions = {},
	extra?: ProgressExtra,
): Promise<GhResult<T>> {
	let raw: GhRawResponse;
	let lastResponse: GhRawResponse | undefined;
	try {
		const r = await ctx.httpGovernor.request<GhRawResponse, GhRawResponse>(
			async (): Promise<GhRawResponse> => {
				const res = await fetch(`${BASE}${path}`, {
					headers: {
						Authorization: `Bearer ${ctx.token}`,
						Accept: accept,
						"X-GitHub-Api-Version": "2022-11-28",
						"User-Agent": USER_AGENT,
					},
				});
				const response = {
					body: await res.text().catch((): string => ""),
					link: res.headers.get("link"),
					status: res.status,
				};
				const rateLimited = isGithubRateLimited(
					response,
					res.headers.get("x-ratelimit-remaining"),
					res.headers.get("retry-after"),
				);
				const retryAfter = rateLimited
					? githubRetryAfter(
							response.status,
							res.headers.get("x-ratelimit-remaining"),
							res.headers.get("retry-after"),
							res.headers.get("x-ratelimit-reset"),
						)
					: undefined;
				lastResponse = {
					...response,
					rateLimited,
					...(retryAfter === undefined ? {} : { retryAfter }),
				};
				return lastResponse;
			},
			(resp) => ({
				// Map GitHub's 403-quota-exhausted onto 429 so the governor's
				// Retry-After honor and `github_rate_limited` terminal apply uniformly.
				status: resp.rateLimited ? 429 : resp.status,
				...(resp.retryAfter === undefined
					? {}
					: { headers: { "retry-after": resp.retryAfter } }),
				value: resp,
			}),
			{
				onRetry: async ({ delayMs, status }) => {
					if (status === 429) {
						await ctx.progress(
							`Rate limited by GitHub, retrying in ${String(Math.ceil(delayMs / 1000))}s`,
							{
								...extra,
								phase: "rate_limit",
								rate_limit_pressure: 1,
							},
						);
					}
				},
			},
		);
		raw = r.value;
	} catch (error) {
		if (error instanceof Error && error.message === "github_rate_limited") {
			throw new Error(
				`github_http_${String(lastResponse?.status ?? 429)}: GitHub rate limit exhausted after bounded retries`,
				{ cause: error },
			);
		}
		throw error;
	}
	if (isGithubBadCredentials(raw)) {
		throw new Error("github_auth_failed");
	}
	if (raw.status < 200 || raw.status >= 300) {
		throw new Error(
			`github_http_${String(raw.status)}: ${raw.body.slice(0, 200)}`,
		);
	}
	const data = JSON.parse(raw.body) as T;
	const nextUrl = parseNextLink(raw.link);
	return { data, nextUrl };
}

const GITHUB_WEB_ORIGIN = "https://github.com";

/**
 * Achievement badges have no REST or GraphQL field (confirmed: GitHub's API
 * surfaces nothing under this name). Legacy
 * `connectors/github/github-playwright.js:309-316` scraped them from the
 * public profile page DOM instead. This is one bounded, unauthenticated GET
 * of `https://github.com/{login}` per run (the public profile page needs no
 * token) followed by the pure `parseAchievementsHtml`. Returns `null` (not
 * `[]`) on a non-2xx response or a request failure — distinguishes "the page
 * was not read" from "the page was read and has zero badges" per the
 * nullable-enrichment contract on `userSchema.achievements`.
 */
async function fetchProfileAchievements(
	login: string,
): Promise<GitHubAchievement[] | null> {
	let res: Response;
	try {
		res = await fetch(`${GITHUB_WEB_ORIGIN}/${encodeURIComponent(login)}`, {
			headers: { "User-Agent": USER_AGENT },
		});
	} catch {
		return null;
	}
	if (!res.ok) {
		return null;
	}
	const html = await res.text();
	return parseAchievementsHtml(html);
}

const GRAPHQL_BASE = "https://api.github.com/graphql";

/**
 * GitHub GraphQL v4 request. Shares the same governor (pacing, retry budget,
 * rate-limit classification) as the REST `gh()` helper — GraphQL requests
 * count against the same primary rate limit bucket, so they must not bypass
 * the governor that paces REST calls. `errors` in a 200 response is a
 * GraphQL-level failure (e.g. a bad query) and is surfaced distinctly from a
 * transport-level HTTP failure.
 */
async function ghGraphQl<T>(
	ctx: StreamCtx,
	query: string,
	variables: Record<string, unknown>,
	extra?: ProgressExtra,
): Promise<T> {
	let raw: GhRawResponse;
	let lastResponse: GhRawResponse | undefined;
	try {
		const r = await ctx.httpGovernor.request<GhRawResponse, GhRawResponse>(
			async (): Promise<GhRawResponse> => {
				const res = await fetch(GRAPHQL_BASE, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${ctx.token}`,
						Accept: "application/vnd.github+json",
						"Content-Type": "application/json",
						"X-GitHub-Api-Version": "2022-11-28",
						"User-Agent": USER_AGENT,
					},
					body: JSON.stringify({ query, variables }),
				});
				const response = {
					body: await res.text().catch((): string => ""),
					link: null,
					status: res.status,
				};
				const rateLimited = isGithubRateLimited(
					response,
					res.headers.get("x-ratelimit-remaining"),
					res.headers.get("retry-after"),
				);
				const retryAfter = rateLimited
					? githubRetryAfter(
							response.status,
							res.headers.get("x-ratelimit-remaining"),
							res.headers.get("retry-after"),
							res.headers.get("x-ratelimit-reset"),
						)
					: undefined;
				lastResponse = {
					...response,
					rateLimited,
					...(retryAfter === undefined ? {} : { retryAfter }),
				};
				return lastResponse;
			},
			(resp) => ({
				status: resp.rateLimited ? 429 : resp.status,
				...(resp.retryAfter === undefined
					? {}
					: { headers: { "retry-after": resp.retryAfter } }),
				value: resp,
			}),
			{
				onRetry: async ({ delayMs, status }) => {
					if (status === 429) {
						await ctx.progress(
							`Rate limited by GitHub, retrying in ${String(Math.ceil(delayMs / 1000))}s`,
							{ ...extra, phase: "rate_limit", rate_limit_pressure: 1 },
						);
					}
				},
			},
		);
		raw = r.value;
	} catch (error) {
		if (error instanceof Error && error.message === "github_rate_limited") {
			throw new Error(
				`github_http_${String(lastResponse?.status ?? 429)}: GitHub rate limit exhausted after bounded retries`,
				{ cause: error },
			);
		}
		throw error;
	}
	if (isGithubBadCredentials(raw)) {
		throw new Error("github_auth_failed");
	}
	if (raw.status < 200 || raw.status >= 300) {
		throw new Error(
			`github_http_${String(raw.status)}: ${raw.body.slice(0, 200)}`,
		);
	}
	const parsed = JSON.parse(raw.body) as GitHubGraphQlResponse;
	if (parsed.errors && parsed.errors.length > 0) {
		throw createConnectorFailure(
			"github_malformed_response",
			`GitHub GraphQL request failed: ${parsed.errors.map((e) => e.message ?? e.type ?? "unknown error").join("; ")}`,
			{ retryable: true },
		);
	}
	return parsed as T;
}

function parseGithubListResponse<T>(data: unknown, stream: string): T[] {
	if (!Array.isArray(data)) {
		throw createConnectorFailure(
			"github_malformed_response",
			`GitHub ${stream} list returned a malformed 200 response; collection is incomplete`,
			{ retryable: true },
		);
	}
	return data as T[];
}

// ─── Stream collectors ──────────────────────────────────────────────────

export interface StreamCtx {
	emit: (
		msg:
			| { type: "STATE"; stream: string; cursor: unknown }
			| Extract<EmittedMessage, { type: "SKIP_RESULT" }>
			| Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }>,
	) => Promise<void>;
	emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>;
	httpGovernor: ConnectorHttpGovernor;
	progress: (message: string, extra?: ProgressExtra) => Promise<void>;
	requested: Map<
		string,
		{ name?: string; time_range?: { since?: string; until?: string } }
	>;
	state: Record<string, unknown>;
	token: string;
	/**
	 * Warm-start carrier: when `collectUser` writes the `user` STATE cursor it
	 * records the cursor object here so `collect` can re-emit it at run end merged
	 * with the FINAL learned pacing interval — persisting the rate the controller
	 * settled on after the whole run, not the early-run rate. Undefined when `user`
	 * was not collected (warm-start simply does not persist this run).
	 */
	userCursor?: Record<string, unknown>;
}

async function failGithubPagination(
	ctx: StreamCtx,
	stream: string,
	kind: "page_cap" | "repeated_next",
	pageIndex: number,
): Promise<never> {
	const repeated = kind === "repeated_next";
	const reason = repeated
		? "github_pagination_repeated_next"
		: "github_pagination_cap_exceeded";
	const message = repeated
		? `GitHub ${stream} pagination returned a repeated next link after ${String(pageIndex)} page(s)`
		: `GitHub ${stream} pagination reached its ${String(maxGithubListPages)}-page safety cap with more pages remaining`;
	await ctx.emit({
		type: "SKIP_RESULT",
		stream,
		reason,
		message,
		diagnostics: repeated
			? { page_count: pageIndex }
			: { page_cap: maxGithubListPages, page_count: pageIndex },
		recovery_hint: { action: "retry_by_runtime", retryable: true },
	});
	throw createConnectorFailure("github_pagination_gap", message, {
		retryable: true,
	});
}

async function guardGithubPagination(
	ctx: StreamCtx,
	stream: string,
	path: string,
	pageIndex: number,
	visitedPaths: Set<string>,
): Promise<void> {
	if (pageIndex >= maxGithubListPages) {
		await failGithubPagination(ctx, stream, "page_cap", pageIndex);
	}
	if (visitedPaths.has(path)) {
		await failGithubPagination(ctx, stream, "repeated_next", pageIndex);
	}
	visitedPaths.add(path);
}

/**
 * Declare a list-stream coverage denominator for the Collection Report
 * (OpenSpec task 4.1). GitHub's list streams have no detail-hydration phase, so
 * this emits a DETAIL_COVERAGE whose `state_stream`/`stream` are the list stream
 * itself with EMPTY `required_keys`/`hydrated_keys` and an explicit `considered`
 * (and, when supplied, `covered`) count. Empty key sets mean the runtime's
 * pre-commit coverage gate has nothing to mark missing (it never blocks the
 * commit), and the only signal carried is the denominator(s) the terminal
 * collection-fact block reads.
 *
 * Honesty contract: `considered` is the number of items the run actually
 * EVALUATED against its boundary from the source (never the raw page size when
 * a page can contain unvisited items past an early stop) — NEVER the count it
 * chose to emit. `covered`, when supplied, is the number of those evaluated
 * items the run accounted for — emitted, or confirmed unchanged/out-of-window by
 * the same per-item comparison that decided not to emit it. It must be measured
 * at the same enumeration site, never aliased to `considered` or `collected`
 * blindly. When every evaluated item was accounted for, the stream reads
 * `complete` for that boundary on a steady-state run too (the honest verdict:
 * nothing evaluated was left unaccounted for); when the run evaluated an item
 * and could not account for it (e.g. a dropped malformed entry), omit it from
 * `covered` so `covered < considered` reads a real `partial`. A stream that
 * cannot know its full inventory for the run (e.g. a search-API cap truncation)
 * MUST NOT call this — it leaves `considered` unknown and relies on its
 * terminal-gap evidence instead.
 *
 * ── Why no provider-reported total is bound here ──────────────────────────
 *
 * GitHub exposes several tempting scalars. Each was measured against this
 * instance's live holdings and REJECTED. Do not bind them:
 *
 *   `public_repos` / `public_gists` (from `/user`, already stored on the
 *   `user_stats` record) measure a strict SUBSET, not this stream's boundary.
 *   Live: `public_repos: 94` against 575 held repositories — of which 355 are
 *   private and 465 belong to orgs, neither of which `public_repos` counts.
 *   `public_gists: 8` matched the 8 public gists exactly while 43 secret gists
 *   sat outside it. Binding either would assert a permanent ~6x false gap.
 *
 *   `Link: rel="last"` yields a PAGE count, so an item total only under the
 *   assumption that every page is full — which the last page never is. It also
 *   cannot survive the deletion semantics below.
 *
 *   `total_count` on `/search/issues` IS authoritative for its query, and is
 *   already consumed for cap-detection (see `PR_SEARCH_RESULT_CAP`). It is not
 *   promoted to the denominator because a search index is eventually
 *   consistent with the REST list this stream walks, so a benign index lag
 *   would read as coverage loss.
 *
 * The deeper constraint applies to ALL of them: PDPP deliberately RETAINS
 * records after the provider deletes them, and GitHub genuinely deletes repos,
 * issues and gists. A provider total therefore describes the surviving account
 * and is legitimately SMALLER than what we hold. Any two-way
 * `provider_total === held_count` check flags successful preservation as a
 * defect. A sound anchor here would have to be the three-way relation
 * `provider_total === live_holdings - known_tombstoned`, and this connector
 * declares no tombstones at all (no `isTombstone`), so the third term is
 * unavailable and the relation cannot be closed.
 *
 * A scalar also cannot distinguish missing from surplus from duplicated. If a
 * real anchor is wanted later, compare the provider's ID SET against the held
 * ID set — GitHub returns stable numeric ids on every one of these streams —
 * and tombstone the upstream-absent ids rather than counting them as loss.
 */
async function declareListConsidered(
	ctx: StreamCtx,
	stream: string,
	considered: number,
	covered?: number,
): Promise<void> {
	if (!Number.isInteger(considered) || considered < 0) {
		return;
	}
	await ctx.emit(
		buildDetailCoverageMessage({
			stream,
			stateStream: stream,
			requiredKeys: [],
			hydratedKeys: [],
			considered,
			...(covered === undefined ? {} : { covered }),
		}),
	);
}

export async function collectUser(ctx: StreamCtx): Promise<void> {
	await ctx.progress("Fetching user profile", { stream: "user" });
	const { data: u } = await gh<GitHubUser>(ctx, "/user");

	if (ctx.requested.has("user")) {
		// Entity record: stable identity fields only. Gate on fingerprint so
		// re-fetches that find no profile changes do not create new entity versions.
		// `achievements` is a bounded, best-effort enrichment fetched separately
		// from `/user` (see fetchProfileAchievements) — merged onto the record
		// without touching userRecord()'s existing fields.
		const achievements = await fetchProfileAchievements(u.login);
		const entityRec = { ...userRecord(u), achievements };
		const userFpCursor = openFingerprintCursor(ctx.state.user, {
			excludeFromFingerprint: [],
		});
		if (userFpCursor.shouldEmit(entityRec)) {
			await ctx.emitRecord("user", entityRec);
		}
		const userCursor: Record<string, unknown> = {
			fetched_at: nowIso(),
			fingerprints: userFpCursor.toState(),
		};
		// Record the cursor so `collect` can re-emit it at run end with the final
		// learned pacing interval merged in (warm-start carrier).
		ctx.userCursor = userCursor;
		await ctx.emit({
			type: "STATE",
			stream: "user",
			cursor: userCursor,
		});
		// `user` is a `singleton_presence` stream (manifest: required): a committed
		// checkpoint with no coverage measurement reads `checkpoint_only`, never
		// `complete` (the contract explicitly rejects laundering a bare checkpoint
		// into proof — see coherence.ts). The `/user` fetch above already proved the
		// one entity this stream owns was reached; declare that boundary explicitly
		// so a steady-state run (fingerprint unchanged, nothing emitted) still reads
		// `complete` rather than `unknown`. Only reached after the fetch above
		// succeeded — never claim presence on a failed fetch.
		await declareListConsidered(ctx, "user", 1, 1);
	}

	// Stats record: sampled metrics keyed by {user_id}:{YYYY-MM-DD}.
	// The append key ensures idempotency within a calendar day.
	if (ctx.requested.has("user_stats")) {
		const observedOn = nowIso().slice(0, 10);
		await ctx.emitRecord("user_stats", userStatsRecord(u, observedOn));
		await ctx.emit({
			type: "STATE",
			stream: "user_stats",
			cursor: { observed_on: observedOn, fetched_at: nowIso() },
		});
		// Same `singleton_presence` honesty requirement as `user` above: the daily
		// sample was successfully derived from the same proven `/user` fetch.
		await declareListConsidered(ctx, "user_stats", 1, 1);
	}
}

interface ReposPageResult {
	/** Items this page the loop actually inspected (walked up to and including
	 *  a stop match). Items after a stop match within the same page are never
	 *  visited, so they must not count toward `considered`. */
	evaluated: number;
	latest: string | null | undefined;
	stop: boolean;
}

async function emitRepositoriesPage(
	ctx: StreamCtx,
	items: GitHubRepo[],
	priorPushed: string | undefined,
	latestIn: string | null | undefined,
): Promise<ReposPageResult> {
	let latest = latestIn;
	let evaluated = 0;
	for (const r of items) {
		evaluated += 1;
		if (priorPushed && r.pushed_at && r.pushed_at <= priorPushed) {
			return { evaluated, latest, stop: true };
		}
		await ctx.emitRecord("repositories", repoRecord(r));
		latest = laterIso(latest, r.pushed_at);
	}
	return { evaluated, latest, stop: false };
}

export async function collectRepositories(ctx: StreamCtx): Promise<void> {
	await ctx.progress("Fetching repositories", {
		stream: "repositories",
		phase: "start",
	});
	let path: string | null =
		"/user/repos?per_page=100&sort=pushed&direction=desc";
	const repoState = ctx.state.repositories as
		| { last_pushed_at?: string }
		| undefined;
	const priorPushed = repoState?.last_pushed_at;
	let latestPushed: string | null | undefined = priorPushed;
	let stop = false;
	let pageIndex = 0;
	let totalSeen = 0;
	const visitedPaths = new Set<string>();
	// Items the loop actually evaluated against the incremental cursor, summed
	// across pages. This is the honest `considered` denominator: it excludes any
	// page tail past an early stop match, which the loop never visits (see
	// `emitRepositoriesPage`). Every evaluated item is either emitted (new) or
	// is itself the stop match confirming the boundary was reached, so
	// `covered === evaluated` — nothing evaluated is ever silently dropped.
	let totalEvaluated = 0;
	while (path && !stop) {
		await guardGithubPagination(
			ctx,
			"repositories",
			path,
			pageIndex,
			visitedPaths,
		);
		const pageExtra = {
			stream: "repositories",
			phase: "fetch",
			page_index: pageIndex,
			total_seen: totalSeen,
			cursor_present: pageIndex > 0,
		};
		await ctx.progress("Fetching GitHub repositories page", pageExtra);
		const page: GhResult<unknown> = await gh<unknown>(ctx, path, {}, pageExtra);
		const items = parseGithubListResponse<GitHubRepo>(
			page.data,
			"repositories",
		);
		totalSeen += items.length;
		await ctx.progress("Fetched GitHub repositories page", {
			stream: "repositories",
			phase: "page",
			page_index: pageIndex,
			item_count: items.length,
			total_seen: totalSeen,
			cursor_present: Boolean(page.nextUrl),
		});
		const result = await emitRepositoriesPage(
			ctx,
			items,
			priorPushed,
			latestPushed,
		);
		latestPushed = result.latest;
		({ stop } = result);
		totalEvaluated += result.evaluated;
		path = page.nextUrl;
		pageIndex += 1;
	}
	// The run evaluated `totalEvaluated` repositories against the incremental
	// cursor within its boundary. Declare that as `considered`; every evaluated
	// item was either emitted (new) or is the stop match confirming the rest of
	// the boundary is unchanged, so `covered` equals the same count. This proves
	// a zero-changed steady-state run `complete` rather than leaving it to the
	// strategy's checkpoint-only fallback.
	await declareListConsidered(
		ctx,
		"repositories",
		totalEvaluated,
		totalEvaluated,
	);
	await ctx.emit({
		type: "STATE",
		stream: "repositories",
		cursor: { last_pushed_at: latestPushed || priorPushed || null },
	});
}

interface StarredPageResult {
	/** Entries whose `repo` was missing, so starredRecord() returned null. */
	dropped: number;
	/** Entries this page the loop actually inspected (walked up to and including
	 *  a stop match). Entries after a stop match within the same page are never
	 *  visited, so they must not count toward `considered`. */
	evaluated: number;
	latest: string | null | undefined;
	stop: boolean;
}

async function emitStarredPage(
	ctx: StreamCtx,
	entries: GitHubStarredEntry[],
	priorStarred: string | undefined,
	latestIn: string | null | undefined,
): Promise<StarredPageResult> {
	let latest = latestIn;
	let dropped = 0;
	let evaluated = 0;
	for (const entry of entries) {
		evaluated += 1;
		const starredAt = entry.starred_at || null;
		if (priorStarred && starredAt && starredAt <= priorStarred) {
			return { dropped, evaluated, latest, stop: true };
		}
		const rec = starredRecord(entry);
		if (!rec) {
			// Entry has no `repo` object (e.g. repo deleted/made private since the
			// star). starredRecord() returns null; we cannot build a record. Count
			// it so a run that silently drops such entries does not look complete.
			dropped += 1;
			continue;
		}
		await ctx.emitRecord("starred", rec);
		latest = laterIso(latest, starredAt);
	}
	return { dropped, evaluated, latest, stop: false };
}

export async function collectStarred(ctx: StreamCtx): Promise<void> {
	await ctx.progress("Fetching starred repositories", {
		stream: "starred",
		phase: "start",
	});
	const starredState = ctx.state.starred as
		| { last_starred_at?: string }
		| undefined;
	const priorStarred = starredState?.last_starred_at;
	let latestStarred: string | null | undefined = priorStarred;
	let path: string | null =
		"/user/starred?per_page=100&sort=created&direction=desc";
	let stop = false;
	let pageIndex = 0;
	let totalSeen = 0;
	let droppedTotal = 0;
	// Entries the loop actually evaluated against the incremental cursor, summed
	// across pages — excludes any page tail past an early stop match (see
	// `emitStarredPage`). The honest `considered` denominator.
	let totalEvaluated = 0;
	const visitedPaths = new Set<string>();
	while (path && !stop) {
		await guardGithubPagination(ctx, "starred", path, pageIndex, visitedPaths);
		// Use star:timestamp media type to get starred_at
		const pageExtra = {
			stream: "starred",
			phase: "fetch",
			page_index: pageIndex,
			total_seen: totalSeen,
			cursor_present: pageIndex > 0,
		};
		await ctx.progress("Fetching GitHub starred page", pageExtra);
		const page: GhResult<unknown> = await gh<unknown>(
			ctx,
			path,
			{
				accept: "application/vnd.github.star+json",
			},
			pageExtra,
		);
		const entries = parseGithubListResponse<GitHubStarredEntry>(
			page.data,
			"starred",
		);
		totalSeen += entries.length;
		await ctx.progress("Fetched GitHub starred page", {
			stream: "starred",
			phase: "page",
			page_index: pageIndex,
			item_count: entries.length,
			total_seen: totalSeen,
			cursor_present: Boolean(page.nextUrl),
		});
		const result = await emitStarredPage(
			ctx,
			entries,
			priorStarred,
			latestStarred,
		);
		latestStarred = result.latest;
		({ stop } = result);
		droppedTotal += result.dropped;
		totalEvaluated += result.evaluated;
		path = page.nextUrl;
		pageIndex += 1;
	}
	// Stream-level skip evidence: a run that silently drops malformed/unavailable
	// starred entries must not look complete. One bounded summary per run (count
	// only — there is nothing to identify; `repo` was absent). No per-item flood.
	if (droppedTotal > 0) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream: "starred",
			reason: "starred_entry_missing_repo",
			message: `dropped ${String(droppedTotal)} starred entr${droppedTotal === 1 ? "y" : "ies"} with no repo object (repo deleted or made private since starring)`,
			diagnostics: { dropped: droppedTotal, total_seen: totalSeen },
		});
	}
	// `totalEvaluated` is every starred entry actually evaluated in this run's
	// boundary, including the ones dropped for a missing `repo`. Declaring it as
	// `considered` makes a run that silently dropped entries read `partial`
	// (covered < considered), never falsely complete. `covered` excludes the
	// dropped entries — they were evaluated but never accounted for — so a
	// steady-state run with zero drops reads `complete`, and a run that drops
	// entries still reads an honest `partial`.
	await declareListConsidered(
		ctx,
		"starred",
		totalEvaluated,
		totalEvaluated - droppedTotal,
	);
	await ctx.emit({
		type: "STATE",
		stream: "starred",
		cursor: { last_starred_at: latestStarred || priorStarred || null },
	});
}

async function emitIssuesPage(
	ctx: StreamCtx,
	items: GitHubIssue[],
	until: string | null,
	latestIn: string | null | undefined,
): Promise<string | null | undefined> {
	let latest = latestIn;
	for (const it of items) {
		if (isAtOrAfterUntil(it.updated_at, until)) {
			continue;
		}
		await ctx.emitRecord("issues", issueRecord(it));
		latest = laterIso(latest, it.updated_at);
	}
	return latest;
}

export async function collectIssues(ctx: StreamCtx): Promise<void> {
	await ctx.progress("Fetching issues", { stream: "issues", phase: "start" });
	const req = ctx.requested.get("issues");
	const issuesState = ctx.state.issues as
		| { last_updated_at?: string }
		| undefined;
	const priorUpdated = issuesState?.last_updated_at;
	// Prefer explicit scope time_range.since over stored cursor (narrower wins).
	const sinceParam = req?.time_range?.since || priorUpdated || null;
	const until = req?.time_range?.until || null;
	let latestUpdated: string | null | undefined = priorUpdated;
	const qs = [
		"filter=all",
		"state=all",
		"per_page=100",
		"sort=updated",
		"direction=desc",
	];
	if (sinceParam) {
		qs.push(`since=${encodeURIComponent(sinceParam)}`);
	}
	let path: string | null = `/issues?${qs.join("&")}`;
	let pageIndex = 0;
	let totalSeen = 0;
	const visitedPaths = new Set<string>();
	while (path) {
		await guardGithubPagination(ctx, "issues", path, pageIndex, visitedPaths);
		const pageExtra = {
			stream: "issues",
			phase: "fetch",
			page_index: pageIndex,
			total_seen: totalSeen,
			cursor_present: pageIndex > 0 || Boolean(sinceParam),
		};
		await ctx.progress("Fetching GitHub issues page", pageExtra);
		const page: GhResult<unknown> = await gh<unknown>(ctx, path, {}, pageExtra);
		const items = parseGithubListResponse<GitHubIssue>(page.data, "issues");
		totalSeen += items.length;
		await ctx.progress("Fetched GitHub issues page", {
			stream: "issues",
			phase: "page",
			page_index: pageIndex,
			item_count: items.length,
			total_seen: totalSeen,
			cursor_present: Boolean(page.nextUrl),
		});
		latestUpdated = await emitIssuesPage(ctx, items, until, latestUpdated);
		path = page.nextUrl;
		pageIndex += 1;
	}
	// `totalSeen` is every issue the run enumerated AND evaluated in its
	// `[since, until]` boundary (every fetched page is walked in full by
	// `emitIssuesPage`, so nothing is left unvisited). `until`-filtered items are
	// considered-but-not-emitted — but the run DID make an accounting decision for
	// every one of them (emit, or correctly exclude as outside the requested
	// window), so `covered` equals the same count. A steady-state run (nothing
	// new since the cursor, no `until`) reads `complete`; a window genuinely
	// capped by pagination truncation would surface via the run's own terminal
	// evidence, not a considered/covered mismatch here.
	await declareListConsidered(ctx, "issues", totalSeen, totalSeen);
	await ctx.emit({
		type: "STATE",
		stream: "issues",
		cursor: { last_updated_at: latestUpdated || priorUpdated || null },
	});
}

// PULL_REQUESTS
// Uses /search/issues?q=type:pr+author:{user}. NOTE: this only returns PRs
// authored by the user. PRs where the user is a reviewer (but not author)
// are NOT included — that requires a separate `reviewer:{user}` query and
// dedup, which we leave for a follow-up. This path is simpler than walking
// every repo's /pulls endpoint and captures the main authoring signal.
//
// Search returns summary records; for per-PR detail (merged_at, commits,
// additions, deletions, changed_files, requested_reviewers) we fetch
// /repos/{owner}/{repo}/pulls/{number}. That's 1 extra request per PR.
//
// SEARCH-API 1000-RESULT CAP. GitHub's search endpoint returns at most ~1000
// results for any single query and silently stops paginating there (no error,
// no `next` link) — see https://docs.github.com/en/rest/search. A user with
// >1000 authored PRs would therefore lose the oldest ones from a single
// `type:pr author:{login}` query. On a *full* resync (no incremental `since`
// bound) we partition the query into per-year `created:` windows so each
// window stays under the cap; `created` is immutable, so every PR falls in
// exactly one window and the union is the complete set. Incremental runs
// (a `since` bound is present) keep the single `updated:>=` query — the set of
// PRs updated since the last cursor is almost never >1000, and a window that
// somehow still exceeds the cap emits a terminal-gap SKIP_RESULT so the run is
// honestly incomplete rather than silently truncated.
const PR_ERROR_BUBBLE_PATTERN =
	/rate(?:_| )limit(?:ed)?|auth_failed|ECONN|fetch failed|retryable status [45]\d\d\b/i;

// A single search window that still reports more than this many total results
// cannot be fully drained (the API stops at ~1000). We treat any window whose
// reported total exceeds this as cap-truncated and surface it as a gap.
const PR_SEARCH_RESULT_CAP = 1000;

function parsePrSearchResponse(data: unknown): {
	items: GitHubIssue[];
	total_count: number;
} {
	if (!data || typeof data !== "object") {
		throw createConnectorFailure(
			"github_malformed_response",
			"GitHub pull-request search returned a malformed 200 response; collection is incomplete",
			{ retryable: true },
		);
	}
	const { items, total_count: totalCount } = data as {
		items?: unknown;
		total_count?: unknown;
	};
	if (!(Array.isArray(items) && Number.isInteger(totalCount))) {
		throw createConnectorFailure(
			"github_malformed_response",
			"GitHub pull-request search returned a malformed 200 response; collection is incomplete",
			{ retryable: true },
		);
	}
	const count = totalCount as number;
	if (count < 0 || count < items.length || (count > 0 && items.length === 0)) {
		throw createConnectorFailure(
			"github_malformed_response",
			"GitHub pull-request search returned a malformed 200 response; collection is incomplete",
			{ retryable: true },
		);
	}
	return { items: items as GitHubIssue[], total_count: count };
}

interface PullDetailResult {
	detail: GitHubPullDetail | null;
	/** True when the detail fetch failed (non-fatally), so the emitted PR record
	 *  is degraded to search-summary fields only (merged_at, commits, diff stats,
	 *  reviewers absent). False when there was simply no detail to fetch. */
	detailFailed: boolean;
}

async function fetchPullDetail(
	ctx: StreamCtx,
	repoFull: string | null,
	number: number | undefined,
): Promise<PullDetailResult> {
	if (!(repoFull && number !== undefined)) {
		return { detail: null, detailFailed: false };
	}
	try {
		const r = await gh<GitHubPullDetail>(
			ctx,
			`/repos/${repoFull}/pulls/${String(number)}`,
		);
		return { detail: r.data, detailFailed: false };
	} catch (e) {
		// Non-fatal: emit what we have from search. Rate-limit errors
		// bubble up from gh() and abort the whole run (retryable).
		const msg = e instanceof Error ? e.message : String(e);
		if (PR_ERROR_BUBBLE_PATTERN.test(msg)) {
			throw e;
		}
		return { detail: null, detailFailed: true };
	}
}

interface PrSearchPathOptions {
	/** Inclusive `created:` window (YYYY-MM-DD..YYYY-MM-DD) for cap partitioning. */
	createdRange?: { from: string; to: string };
	sinceParam?: string | null;
}

function buildPrSearchPath(
	login: string,
	options: PrSearchPathOptions = {},
): string {
	const { sinceParam = null, createdRange } = options;
	const qParts = ["type:pr", `author:${login}`];
	if (sinceParam) {
		// Search API date-precision; strict `since` still applied per-item.
		qParts.push(`updated:>=${sinceParam.slice(0, 10)}`);
	}
	if (createdRange) {
		// Immutable partitioning field: each PR falls in exactly one window, so
		// windows can be drained independently and unioned without dedup.
		qParts.push(`created:${createdRange.from}..${createdRange.to}`);
	}
	const q = encodeURIComponent(qParts.join(" "));
	return `/search/issues?q=${q}&sort=updated&order=desc&per_page=100`;
}

/**
 * Per-year `created:` windows from the current year back to `floorYear`,
 * descending (newest first, matching the single-query `order=desc` shape).
 * `floorYear` is the user's account-creation year — no authored PR predates
 * the account. Exported for unit testing the window math without a network.
 */
export function prCreatedWindows(
	currentYear: number,
	floorYear: number,
): Array<{ from: string; to: string }> {
	const top = Math.max(currentYear, floorYear);
	const bottom = Math.min(currentYear, floorYear);
	const windows: Array<{ from: string; to: string }> = [];
	for (let year = top; year >= bottom; year -= 1) {
		windows.push({
			from: `${String(year)}-01-01`,
			to: `${String(year)}-12-31`,
		});
	}
	return windows;
}

/** Year of an ISO timestamp, or null when absent/unparseable. */
export function isoYear(iso: string | null | undefined): number | null {
	if (!iso) {
		return null;
	}
	const year = Number.parseInt(iso.slice(0, 4), 10);
	return Number.isInteger(year) && year > 0 ? year : null;
}

interface PrPageResult {
	/** PRs emitted with degraded detail because the per-PR detail fetch failed. */
	detailFailed: number;
	/** PR records actually emitted after since/until filters. */
	emitted: number;
	/** Items this page the loop actually inspected (walked up to and including
	 *  a `since` stop match). Items after a stop match within the same page are
	 *  never visited, so they must not count toward `considered`. */
	evaluated: number;
	latest: string | null | undefined;
	stop: boolean;
}

interface PrWindowResult {
	/** True when this window's reported total exceeded the search cap (gap). */
	capTruncated: boolean;
	detailFailed: number;
	emitted: number;
	/** Items across this window's pages the loop actually evaluated (see
	 *  `PrPageResult.evaluated`) — excludes any page tail past a `since` stop. */
	evaluated: number;
	/** Raw search hits seen across this window's pages (before since/until filters). */
	fetched: number;
	latest: string | null | undefined;
	/** Highest reported total_count seen for this window (for gap diagnostics). */
	reportedTotal: number;
}

interface PrItemResult {
	detailFailed: boolean;
	latest: string | null | undefined;
}

async function emitPullRequestItem(
	ctx: StreamCtx,
	it: GitHubIssue,
	latestIn: string | null | undefined,
): Promise<PrItemResult> {
	const repoFull = repoFullFromUrl(it.repository_url);
	// Fetch PR detail for fields not in search summary.
	const { detail, detailFailed } = await fetchPullDetail(
		ctx,
		repoFull,
		it.number,
	);
	// Streaming is intentional: a later fatal detail/page failure retains this
	// already-emitted idempotent record. The collector withholds coverage and
	// STATE until the collection succeeds; a retry re-emits the same stable key
	// and storage upsert makes the replay logical-duplicate free.
	await ctx.emitRecord(
		"pull_requests",
		pullRequestRecord(it, detail, repoFull),
	);
	return { detailFailed, latest: laterIso(latestIn, it.updated_at) };
}

async function emitPullRequestPage(
	ctx: StreamCtx,
	items: GitHubIssue[],
	sinceParam: string | null,
	until: string | null,
	latestIn: string | null | undefined,
): Promise<PrPageResult> {
	let latest = latestIn;
	let detailFailed = 0;
	let emitted = 0;
	let evaluated = 0;
	for (const it of items) {
		evaluated += 1;
		if (isBeforeSince(it.updated_at, sinceParam)) {
			return { detailFailed, emitted, evaluated, latest, stop: true };
		}
		if (isAtOrAfterUntil(it.updated_at, until)) {
			continue;
		}
		const item = await emitPullRequestItem(ctx, it, latest);
		({ latest } = item);
		emitted += 1;
		if (item.detailFailed) {
			detailFailed += 1;
		}
	}
	return { detailFailed, emitted, evaluated, latest, stop: false };
}

/**
 * Drain one search query (a single `since`-bounded query, or one `created:`
 * window) page by page until pagination ends or a per-item `since` cutoff
 * stops it. Detects the search-API cap: if the first page reports a
 * `total_count` above {@link PR_SEARCH_RESULT_CAP}, the window's oldest
 * results are unreachable and the run is honestly incomplete for that window.
 */
async function drainPrSearchWindow(
	ctx: StreamCtx,
	login: string,
	sinceParam: string | null,
	until: string | null,
	createdRange: { from: string; to: string } | undefined,
	latestIn: string | null | undefined,
	pageIndexStart: number,
): Promise<PrWindowResult & { pageIndexEnd: number }> {
	let path: string | null = buildPrSearchPath(login, {
		sinceParam,
		...(createdRange ? { createdRange } : {}),
	});
	let stop = false;
	let pageIndex = pageIndexStart;
	let fetchedCount = 0;
	let detailFailed = 0;
	let emitted = 0;
	let evaluated = 0;
	let reportedTotal = 0;
	let latest = latestIn;
	const visitedPaths = new Set<string>();
	while (path && !stop) {
		await guardGithubPagination(
			ctx,
			"pull_requests",
			path,
			pageIndex,
			visitedPaths,
		);
		const pageExtra = {
			stream: "pull_requests",
			phase: "fetch",
			page_index: pageIndex,
			total_seen: fetchedCount,
			cursor_present:
				pageIndex > pageIndexStart ||
				Boolean(sinceParam) ||
				Boolean(createdRange),
		};
		await ctx.progress("Fetching GitHub pull requests page", pageExtra);
		let page: GhResult<GitHubSearchResponse>;
		try {
			page = await gh<GitHubSearchResponse>(ctx, path, {}, pageExtra);
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw createConnectorFailure(
					"github_malformed_response",
					"GitHub pull-request search returned invalid JSON in a 200 response; collection is incomplete",
					{ retryable: true },
				);
			}
			throw error;
		}
		const search = parsePrSearchResponse(page.data);
		const { items, total_count: totalCount } = search;
		reportedTotal = Math.max(reportedTotal, totalCount);
		const result = await emitPullRequestPage(
			ctx,
			items,
			sinceParam,
			until,
			latest,
		);
		({ latest } = result);
		({ stop } = result);
		detailFailed += result.detailFailed;
		emitted += result.emitted;
		evaluated += result.evaluated;
		fetchedCount += items.length;
		await ctx.progress("Fetched GitHub pull requests page", {
			stream: "pull_requests",
			phase: "page",
			page_index: pageIndex,
			item_count: items.length,
			total_seen: fetchedCount,
			cursor_present: Boolean(page.nextUrl),
			count: Math.min(fetchedCount, totalCount),
			total: totalCount,
		});
		path = page.nextUrl;
		pageIndex += 1;
	}
	return {
		capTruncated: reportedTotal > PR_SEARCH_RESULT_CAP,
		detailFailed,
		emitted,
		evaluated,
		fetched: fetchedCount,
		reportedTotal,
		latest,
		pageIndexEnd: pageIndex,
	};
}

export async function collectPullRequests(ctx: StreamCtx): Promise<void> {
	await ctx.progress("Fetching pull requests", {
		stream: "pull_requests",
		phase: "start",
	});
	const req = ctx.requested.get("pull_requests");
	const prState = ctx.state.pull_requests as
		| { last_updated_at?: string }
		| undefined;
	const priorUpdated = prState?.last_updated_at;
	const sinceParam = req?.time_range?.since || priorUpdated || null;
	const until = req?.time_range?.until || null;
	let latestUpdated: string | null | undefined = priorUpdated;

	// Need the login to build the search query (and created_at to floor the
	// full-resync windowing at the user's account-creation year).
	const { data: me } = await gh<GitHubUser>(ctx, "/user");

	// Full resync (no incremental `since`) is the cap-prone path: partition by
	// immutable `created:` year so each window stays under the search cap.
	// Incremental runs use one `updated:>=` query (rarely >1000 results).
	const windows = resolvePrSearchWindows(sinceParam, me.created_at);

	let detailFailedTotal = 0;
	let emittedCount = 0;
	let fetchedTotal = 0;
	let evaluatedTotal = 0;
	let capTruncatedWindows = 0;
	let maxReportedTotal = 0;
	let pageIndex = 0;
	for (const createdRange of windows) {
		const result = await drainPrSearchWindow(
			ctx,
			me.login,
			sinceParam,
			until,
			createdRange,
			latestUpdated,
			pageIndex,
		);
		latestUpdated = result.latest;
		detailFailedTotal += result.detailFailed;
		emittedCount += result.emitted;
		fetchedTotal += result.fetched;
		evaluatedTotal += result.evaluated;
		maxReportedTotal = Math.max(maxReportedTotal, result.reportedTotal);
		if (result.capTruncated) {
			capTruncatedWindows += 1;
		}
		pageIndex = result.pageIndexEnd;
	}

	// Terminal-gap evidence: a window whose reported total exceeded the search
	// cap could not be fully drained, so the oldest PRs in that window were never
	// emitted. One bounded summary per run (counts only — no PR identifiers). The
	// runtime forwards this to the run's known_gap so the projection is honestly
	// incomplete rather than silently truncated.
	if (capTruncatedWindows > 0) {
		const message =
			`${String(capTruncatedWindows)} search window(s) reported more than ${String(PR_SEARCH_RESULT_CAP)} ` +
			"pull requests; GitHub's search API caps results so the oldest in those windows could not be collected";
		await ctx.emit({
			type: "SKIP_RESULT",
			stream: "pull_requests",
			reason: "pr_search_cap_truncated",
			message,
			diagnostics: {
				cap_truncated_windows: capTruncatedWindows,
				result_cap: PR_SEARCH_RESULT_CAP,
				max_reported_total: maxReportedTotal,
			},
			recovery_hint: { action: "retry_by_runtime", retryable: true },
		});
		throw createConnectorFailure("github_pagination_gap", message, {
			retryable: true,
		});
	}

	// Stream-level evidence that some PR records are degraded: the search summary
	// was emitted but the per-PR detail fetch failed (merged_at, commit/diff
	// stats, reviewers are absent on those records). One bounded summary per run
	// (count only — no repo/PR identifiers). Records are NOT dropped, so this is
	// a coverage-degradation marker, not a terminal skip of the items.
	if (detailFailedTotal > 0) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream: "pull_requests",
			reason: "pr_detail_fetch_failed",
			message: `${String(detailFailedTotal)} of ${String(emittedCount)} pull request record(s) emitted without detail fields (per-PR detail fetch failed)`,
			diagnostics: {
				detail_failed: detailFailedTotal,
				total_emitted: emittedCount,
				total_seen: fetchedTotal,
			},
		});
	}
	// Declare the enumerated inventory as `considered` ONLY when every window
	// drained fully. A cap-truncated window could not see its oldest results, so
	// the run's true denominator is unknowable — leave `considered` unknown and
	// let the `pr_search_cap_truncated` terminal-gap above carry the incompleteness
	// honestly rather than under-reporting a denominator that looks complete.
	// `evaluatedTotal` (not `fetchedTotal`) excludes any page tail past a `since`
	// stop match that the loop never visited (see `emitPullRequestPage`); every
	// evaluated PR was either emitted (possibly detail-degraded, but not dropped)
	// or is the stop match confirming the rest is already known, so `covered`
	// equals the same count.
	if (capTruncatedWindows === 0) {
		await declareListConsidered(
			ctx,
			"pull_requests",
			evaluatedTotal,
			evaluatedTotal,
		);
	}
	await ctx.emit({
		type: "STATE",
		stream: "pull_requests",
		cursor: { last_updated_at: latestUpdated || priorUpdated || null },
	});
}

/**
 * Resolve the search windows to drain. Incremental runs (a `since` bound is
 * present) return a single unwindowed query (`[undefined]`); the updated-since
 * set is rarely over the cap. A full resync returns one `created:` window per
 * year from now back to the account-creation year so each stays under the cap.
 * `now`/`accountCreatedAt` are explicit so the windowing is testable without
 * wall-clock dependence.
 */
export function resolvePrSearchWindows(
	sinceParam: string | null,
	accountCreatedAt: string | null | undefined,
	now: Date = new Date(),
): Array<{ from: string; to: string } | undefined> {
	if (sinceParam) {
		return [undefined];
	}
	const currentYear = now.getUTCFullYear();
	const floorYear = isoYear(accountCreatedAt) ?? currentYear;
	return prCreatedWindows(currentYear, floorYear);
}

async function emitGistsPage(
	ctx: StreamCtx,
	items: GitHubGist[],
	until: string | null,
	latestIn: string | null | undefined,
): Promise<string | null | undefined> {
	let latest = latestIn;
	for (const g of items) {
		if (isAtOrAfterUntil(g.updated_at, until)) {
			continue;
		}
		await ctx.emitRecord("gists", gistRecord(g));
		latest = laterIso(latest, g.updated_at);
	}
	return latest;
}

/**
 * GitHub's Events API is a rolling window: the docs state it returns "the
 * most recent 90 days" of a user's public activity, capped at 300 events /
 * 10 pages of 100 (in practice 3 pages cover the whole window). There is no
 * `since` query param, so incrementality is emit-side: skip any event whose
 * `created_at` is at or before the stored cursor rather than asking the API
 * to filter. History older than 90 days is genuinely unavailable — this is
 * stated honestly in the manifest description, not silently truncated.
 */
const GITHUB_EVENTS_MAX_PAGES = 3;
const GITHUB_EVENTS_PER_PAGE = 100;

function emitEventsPage(
	ctx: StreamCtx,
	items: GitHubEvent[],
	priorCreatedAt: string | undefined,
	latestIn: string | null | undefined,
): {
	droppedMalformed: number;
	emitted: Promise<void>[];
	latest: string | null | undefined;
	stop: boolean;
} {
	let latest = latestIn;
	let droppedMalformed = 0;
	const emitted: Promise<void>[] = [];
	for (const e of items) {
		if (priorCreatedAt && e.created_at && e.created_at <= priorCreatedAt) {
			return { droppedMalformed, emitted, latest, stop: true };
		}
		const rec = eventRecord(e);
		if (!rec) {
			droppedMalformed += 1;
			continue;
		}
		emitted.push(ctx.emitRecord("events", rec));
		latest = laterIso(latest, e.created_at);
	}
	return { droppedMalformed, emitted, latest, stop: false };
}

export async function collectEvents(ctx: StreamCtx): Promise<void> {
	await ctx.progress("Fetching activity events", {
		stream: "events",
		phase: "start",
	});
	const { data: me } = await gh<GitHubUser>(ctx, "/user");
	const eventsState = ctx.state.events as
		| { last_created_at?: string }
		| undefined;
	const priorCreatedAt = eventsState?.last_created_at;
	let latestCreatedAt: string | null | undefined = priorCreatedAt;
	let droppedTotal = 0;
	let totalSeen = 0;
	let stop = false;
	for (
		let pageIndex = 0;
		pageIndex < GITHUB_EVENTS_MAX_PAGES && !stop;
		pageIndex += 1
	) {
		const pageExtra = {
			stream: "events",
			phase: "fetch",
			page_index: pageIndex,
			total_seen: totalSeen,
			cursor_present: pageIndex > 0 || Boolean(priorCreatedAt),
		};
		await ctx.progress("Fetching GitHub events page", pageExtra);
		const { data } = await gh<unknown>(
			ctx,
			`/users/${me.login}/events/public?per_page=${String(GITHUB_EVENTS_PER_PAGE)}&page=${String(pageIndex + 1)}`,
			{},
			pageExtra,
		);
		const items = parseGithubListResponse<GitHubEvent>(data, "events");
		totalSeen += items.length;
		await ctx.progress("Fetched GitHub events page", {
			stream: "events",
			phase: "page",
			page_index: pageIndex,
			item_count: items.length,
			total_seen: totalSeen,
		});
		const result = emitEventsPage(ctx, items, priorCreatedAt, latestCreatedAt);
		await Promise.all(result.emitted);
		latestCreatedAt = result.latest;
		droppedTotal += result.droppedMalformed;
		({ stop } = result);
		if (items.length < GITHUB_EVENTS_PER_PAGE) {
			break;
		}
	}
	if (droppedTotal > 0) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream: "events",
			reason: "github_event_missing_fields",
			message: `dropped ${String(droppedTotal)} event(s) missing required fields (id, type, created_at, or repo name)`,
			diagnostics: { dropped: droppedTotal, total_seen: totalSeen },
		});
	}
	// The provider's own window is the honest boundary here (there is no
	// larger inventory to compare against — everything older than 90 days is
	// unavailable to any caller, not just this connector), so a full,
	// non-early-stopped walk of the window can declare `considered` against
	// what was actually enumerated this run.
	await declareListConsidered(
		ctx,
		"events",
		totalSeen,
		totalSeen - droppedTotal,
	);
	await ctx.emit({
		type: "STATE",
		stream: "events",
		cursor: { last_created_at: latestCreatedAt || priorCreatedAt || null },
	});
}

const CONTRIBUTIONS_QUERY = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}`;

/**
 * GitHub's `contributionsCollection` accepts at most a one-year `from`/`to`
 * window per call. A full resync (no stored cursor) walks back to the
 * account's creation year, one calendar-year window per request, newest
 * first — mirroring `resolvePrSearchWindows`'s per-year partitioning for the
 * same reason (a provider-side window cap, not a search-result cap here, but
 * the same "one window per calendar year" shape applies). An incremental run
 * uses a single window from the stored cursor date to now.
 */
export function resolveContributionWindows(
	sinceDate: string | null,
	accountCreatedAt: string | null | undefined,
	now: Date = new Date(),
): Array<{ from: string; to: string }> {
	if (sinceDate) {
		return [{ from: `${sinceDate}T00:00:00Z`, to: now.toISOString() }];
	}
	const currentYear = now.getUTCFullYear();
	const floorYear = isoYear(accountCreatedAt) ?? currentYear;
	return prCreatedWindows(currentYear, floorYear).map(({ from, to }) => ({
		from: `${from}T00:00:00Z`,
		to: `${to}T23:59:59Z`,
	}));
}

export async function collectContributions(ctx: StreamCtx): Promise<void> {
	await ctx.progress("Fetching contribution history", {
		stream: "contributions",
		phase: "start",
	});
	const req = ctx.requested.get("contributions");
	const contribState = ctx.state.contributions as
		| { last_date?: string }
		| undefined;
	const priorDate = contribState?.last_date;
	const rawSince = req?.time_range?.since;
	const parsedSince = rawSince ? Date.parse(rawSince) : Number.NaN;
	const sinceDate = !Number.isNaN(parsedSince)
		? new Date(parsedSince).toISOString().slice(0, 10)
		: priorDate || null;

	const { data: me } = await gh<GitHubUser>(ctx, "/user");
	const userId = String(me.id);
	const windows = resolveContributionWindows(sinceDate, me.created_at);

	let latestDate: string | null | undefined = priorDate;
	let totalConsidered = 0;
	for (const window of windows) {
		const pageExtra = {
			stream: "contributions",
			phase: "fetch",
			cursor_present: Boolean(sinceDate),
		};
		await ctx.progress("Fetching GitHub contributions window", pageExtra);
		const response = await ghGraphQl<GitHubGraphQlResponse>(
			ctx,
			CONTRIBUTIONS_QUERY,
			{ login: me.login, from: window.from, to: window.to },
			pageExtra,
		);
		const days = flattenContributionDays(
			response.data?.user?.contributionsCollection,
		);
		for (const day of days) {
			if (priorDate && day.date <= priorDate) {
				continue;
			}
			totalConsidered += 1;
			await ctx.emitRecord(
				"contributions",
				contributionDayRecord(userId, day.date, day.count),
			);
			latestDate = laterIso(latestDate, day.date);
		}
	}
	await declareListConsidered(
		ctx,
		"contributions",
		totalConsidered,
		totalConsidered,
	);
	await ctx.emit({
		type: "STATE",
		stream: "contributions",
		cursor: { last_date: latestDate || priorDate || null },
	});
}

const PINNED_ITEMS_QUERY = `
query($login: String!) {
  user(login: $login) {
    pinnedItems(first: 6, types: [REPOSITORY]) {
      nodes {
        ... on Repository {
          id
          name
          nameWithOwner
          description
          url
          stargazerCount
          forkCount
          languages(first: 10) {
            nodes {
              name
            }
          }
        }
      }
    }
  }
}`;

/**
 * pinned_repositories: the user's own curated pin list (GraphQL
 * `user.pinnedItems`). Small (GitHub caps pins at 6) and fully re-fetched
 * each run — there is no upstream cursor for a pin list, and the whole
 * point is to reflect the user's CURRENT curation, not history. Modeled as
 * its own stream, not a nested array on `user`, because each pin has its
 * own identity (a repository) per CONTRACTS D3.
 */
export async function collectPinnedRepositories(ctx: StreamCtx): Promise<void> {
	await ctx.progress("Fetching pinned repositories", {
		stream: "pinned_repositories",
		phase: "start",
	});
	const { data: me } = await gh<GitHubUser>(ctx, "/user");
	const response = await ghGraphQl<GitHubGraphQlResponse>(
		ctx,
		PINNED_ITEMS_QUERY,
		{ login: me.login },
		{ stream: "pinned_repositories", phase: "fetch" },
	);
	const nodes = flattenPinnedRepositories(response.data?.user?.pinnedItems);
	let position = 0;
	let dropped = 0;
	for (const node of nodes) {
		const rec = pinnedRepositoryRecord(node, position);
		if (!rec) {
			dropped += 1;
			continue;
		}
		await ctx.emitRecord("pinned_repositories", rec);
		position += 1;
	}
	if (dropped > 0) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream: "pinned_repositories",
			reason: "github_pinned_item_missing_identity",
			message: `dropped ${String(dropped)} pinned item(s) with no repository identity`,
			diagnostics: { dropped, total_seen: nodes.length },
		});
	}
	await declareListConsidered(
		ctx,
		"pinned_repositories",
		nodes.length,
		nodes.length - dropped,
	);
	await ctx.emit({
		type: "STATE",
		stream: "pinned_repositories",
		cursor: { fetched_at: nowIso() },
	});
}

/**
 * organizations: `GET /user/orgs` membership list (needs the `read:org`
 * scope declared in the manifest's credential help text). Small and fully
 * re-fetched each run — membership is current state, not history.
 */
export async function collectOrganizations(ctx: StreamCtx): Promise<void> {
	await ctx.progress("Fetching organization memberships", {
		stream: "organizations",
		phase: "start",
	});
	let path: string | null = "/user/orgs?per_page=100";
	let pageIndex = 0;
	let totalSeen = 0;
	const visitedPaths = new Set<string>();
	while (path) {
		await guardGithubPagination(
			ctx,
			"organizations",
			path,
			pageIndex,
			visitedPaths,
		);
		const pageExtra = {
			stream: "organizations",
			phase: "fetch",
			page_index: pageIndex,
			total_seen: totalSeen,
		};
		const page: GhResult<unknown> = await gh<unknown>(ctx, path, {}, pageExtra);
		const orgs = parseGithubListResponse<GitHubOrgMembership>(
			page.data,
			"organizations",
		);
		totalSeen += orgs.length;
		for (const org of orgs) {
			await ctx.emitRecord("organizations", organizationRecord(org));
		}
		path = page.nextUrl;
		pageIndex += 1;
	}
	await declareListConsidered(ctx, "organizations", totalSeen, totalSeen);
	await ctx.emit({
		type: "STATE",
		stream: "organizations",
		cursor: { fetched_at: nowIso() },
	});
}

export async function collectGists(ctx: StreamCtx): Promise<void> {
	await ctx.progress("Fetching gists", { stream: "gists", phase: "start" });
	const req = ctx.requested.get("gists");
	const gistState = ctx.state.gists as { last_updated_at?: string } | undefined;
	const priorUpdated = gistState?.last_updated_at;
	const sinceParam = req?.time_range?.since || priorUpdated || null;
	const until = req?.time_range?.until || null;
	let latestUpdated: string | null | undefined = priorUpdated;
	const qs = ["per_page=100"];
	if (sinceParam) {
		qs.push(`since=${encodeURIComponent(sinceParam)}`);
	}
	let path: string | null = `/gists?${qs.join("&")}`;
	let pageIndex = 0;
	let totalSeen = 0;
	const visitedPaths = new Set<string>();
	while (path) {
		await guardGithubPagination(ctx, "gists", path, pageIndex, visitedPaths);
		const pageExtra = {
			stream: "gists",
			phase: "fetch",
			page_index: pageIndex,
			total_seen: totalSeen,
			cursor_present: pageIndex > 0 || Boolean(sinceParam),
		};
		await ctx.progress("Fetching GitHub gists page", pageExtra);
		const page: GhResult<unknown> = await gh<unknown>(ctx, path, {}, pageExtra);
		const items = parseGithubListResponse<GitHubGist>(page.data, "gists");
		totalSeen += items.length;
		await ctx.progress("Fetched GitHub gists page", {
			stream: "gists",
			phase: "page",
			page_index: pageIndex,
			item_count: items.length,
			total_seen: totalSeen,
			cursor_present: Boolean(page.nextUrl),
		});
		latestUpdated = await emitGistsPage(ctx, items, until, latestUpdated);
		path = page.nextUrl;
		pageIndex += 1;
	}
	// Every gist enumerated AND evaluated in the run's boundary (full page walk,
	// nothing left unvisited); `until`-filtered gists were still accounted for
	// (see `collectIssues` for the same reasoning), so `covered` equals the same
	// count.
	await declareListConsidered(ctx, "gists", totalSeen, totalSeen);
	await ctx.emit({
		type: "STATE",
		stream: "gists",
		cursor: { last_updated_at: latestUpdated || priorUpdated || null },
	});
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "github",
		retryablePattern: GITHUB_RETRYABLE_PATTERN,
		validateRecord,
		// GITHUB_TOKEN is the universal GitHub-CI env var; accept it as a fallback.
		auth: {
			kind: "env",
			required: [["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN"]],
		},
		async collect({
			state,
			requested,
			credentials,
			emit,
			emitRecord,
			progress,
		}) {
			const token =
				credentials.GITHUB_PERSONAL_ACCESS_TOKEN || credentials.GITHUB_TOKEN;
			if (!token) {
				throw new Error("github_auth_failed");
			}
			// Warm-start the adaptive rate controller from the prior run's learned
			// interval (line 1 of the seam: restore).
			const httpGovernor = restoreGithubPacing(state);
			const ctx: StreamCtx = {
				token,
				state,
				requested,
				emit,
				emitRecord,
				httpGovernor,
				progress,
			};

			if (requested.has("user") || requested.has("user_stats")) {
				await collectUser(ctx);
			}
			if (requested.has("repositories")) {
				await collectRepositories(ctx);
			}
			if (requested.has("starred")) {
				await collectStarred(ctx);
			}
			if (requested.has("issues")) {
				await collectIssues(ctx);
			}
			if (requested.has("pull_requests")) {
				await collectPullRequests(ctx);
			}
			if (requested.has("gists")) {
				await collectGists(ctx);
			}
			if (requested.has("events")) {
				await collectEvents(ctx);
			}
			if (requested.has("contributions")) {
				await collectContributions(ctx);
			}
			if (requested.has("pinned_repositories")) {
				await collectPinnedRepositories(ctx);
			}
			if (requested.has("organizations")) {
				await collectOrganizations(ctx);
			}

			// Surface the controller's live rate to the operator (legibility) using the
			// shared helper — a connector author never hand-rolls rate observability.
			const collectionRate = buildCollectionRateProgress(httpGovernor);
			if (collectionRate) {
				await emit({
					type: "PROGRESS",
					message: `Collection rate ${collectionRate.effective_rate_per_min}/min (interval ${collectionRate.current_interval_ms}ms; ceiling ${collectionRate.ceiling_rate_per_min}/min)`,
					collection_rate: collectionRate,
				});
			}
			// Persist the FINAL learned interval so the next run warm-starts from it.
			// It rides the already-declared `user` stream cursor (re-emitted here,
			// last-write-wins, merged with the fingerprint cursor collectUser built).
			// Skipped when `user` was not collected — warm-start simply does not
			// persist this run rather than emitting a STATE for an undeclared stream.
			const pacingFields = buildPacingStateFields(httpGovernor);
			if (ctx.userCursor && Object.keys(pacingFields).length > 0) {
				await emit({
					type: "STATE",
					stream: "user",
					cursor: { ...ctx.userCursor, ...pacingFields },
				});
			}
		},
	});
}
